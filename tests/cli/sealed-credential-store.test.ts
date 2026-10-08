import {randomBytes} from "node:crypto";
import {chmod, mkdtemp, readdir, readFile, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {Effect, Redacted} from "effect";
import {afterEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {sealedCredentialStore} from "../../src/cli/sealed-credential-store.js";
import {
  type CliCredentialStoreOperations,
  createSystemCredentialStore,
} from "../../src/cli/system-credential-store.js";

/**
 * The key store behind the sealed layer is the CLI's real credential-helper
 * process boundary, backed by a file, so these tests never touch the
 * developer's Keychain. The helper records every argument vector and every
 * secret it is handed, so a test can prove what reached the key store.
 */
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, {force: true, recursive: true})
  ));
});

interface SealedFixture {
  readonly argvLog: string;
  readonly directory: string;
  readonly keys: CliCredentialStoreOperations;
  readonly received: string;
  readonly sealed: CliCredentialStoreOperations;
}

async function sealedFixture(): Promise<SealedFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "artifact-server-sealed-"));
  temporaryDirectories.push(root);
  const helper = path.join(root, "credential-helper.mjs");
  const state = path.join(root, "helper-state.json");
  const argvLog = path.join(root, "argv.log");
  const received = path.join(root, "received.log");
  await writeFile(helper, `#!/usr/bin/env node
import {appendFileSync, existsSync, readFileSync, writeFileSync} from "node:fs";
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const input = JSON.parse(readFileSync(0, "utf8"));
const store = existsSync(${JSON.stringify(state)}) ? JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8")) : {};
const operation = process.argv[2];
if (operation === "write") {
  appendFileSync(${JSON.stringify(received)}, JSON.stringify(input.secret) + "\\n");
  store[input.account] = input.secret;
  writeFileSync(${JSON.stringify(state)}, JSON.stringify(store));
  process.exit(0);
}
if (!(input.account in store)) process.exit(2);
if (operation === "read") { process.stdout.write(store[input.account]); process.exit(0); }
delete store[input.account];
writeFileSync(${JSON.stringify(state)}, JSON.stringify(store));
`, "utf8");
  await chmod(helper, 0o700);
  const keys = createSystemCredentialStore({
    environment: {...process.env, ARTIFACT_SERVER_CREDENTIAL_HELPER: helper},
  });
  const directory = path.join(root, "credentials");
  return {
    argvLog,
    directory,
    keys,
    received,
    sealed: sealedCredentialStore({directory, keys}),
  };
}

function secret(value: string): Redacted.Redacted {
  return Redacted.make(value);
}

async function readSecret(store: CliCredentialStoreOperations, account: string): Promise<string> {
  return Redacted.value(await Effect.runPromise(store.read(account)));
}

async function failureReason(effect: Effect.Effect<unknown, {readonly reason: string}>): Promise<string> {
  return (await Effect.runPromise(Effect.flip(effect))).reason;
}

async function sealedFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith(".sealed"));
}

/** A credential well past every native store's limit: macOS keeps 128 characters, Windows about 1,280. */
const largeCredential = JSON.stringify({kind: "oauth", padding: randomBytes(3_000).toString("hex")});
const account = "0b7f6e2a-5d0c-4f1e-9a51-3c2b1d0e9f8a";
const otherAccount = "8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";

describe("sealed CLI credential store", () => {
  test("a credential far larger than the native limits round-trips while the key store holds only a short key", async () => {
    const fixture = await sealedFixture();
    await Effect.runPromise(fixture.sealed.write(account, secret(largeCredential)));

    expect(await readSecret(fixture.sealed, account)).toBe(largeCredential);

    const handed = (await readFile(fixture.received, "utf8")).trim().split("\n").map((line) => String(JSON.parse(line)));
    expect(handed).toHaveLength(1);
    expect(handed[0]?.length).toBeLessThan(128);
    expect(handed[0]).not.toContain(largeCredential.slice(0, 40));
    expect(await readFile(fixture.argvLog, "utf8")).not.toContain(largeCredential.slice(0, 40));

    const [file] = await sealedFiles(fixture.directory);
    if (file === undefined) throw new Error("No sealed file was written.");
    expect((await stat(fixture.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(fixture.directory, file))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(fixture.directory, file), "utf8")).not.toContain(largeCredential.slice(0, 40));
  });

  test("a tampered, swapped or missing sealed file fails closed", async () => {
    const fixture = await sealedFixture();
    await Effect.runPromise(fixture.sealed.write(account, secret(largeCredential)));
    await Effect.runPromise(fixture.sealed.write(otherAccount, secret("other-account-credential")));
    const files = await sealedFiles(fixture.directory);
    const own = files.find((name) => name.startsWith(account));
    const other = files.find((name) => name.startsWith(otherAccount));
    if (own === undefined || other === undefined) throw new Error("Expected one sealed file per account.");
    const ownPath = path.join(fixture.directory, own);
    const original = await readFile(ownPath, "utf8");

    const document = z.object({ciphertext: z.string()}).loose().parse(JSON.parse(original));
    const flipped = document.ciphertext.startsWith("A") ? `B${document.ciphertext.slice(1)}` : `A${document.ciphertext.slice(1)}`;
    await writeFile(ownPath, JSON.stringify({...document, ciphertext: flipped}), {mode: 0o600});
    expect(await failureReason(fixture.sealed.read(account))).toBe("operation_failed");

    await writeFile(ownPath, await readFile(path.join(fixture.directory, other), "utf8"), {mode: 0o600});
    expect(await failureReason(fixture.sealed.read(account))).toBe("operation_failed");

    await rm(ownPath);
    expect(await failureReason(fixture.sealed.read(account))).toBe("operation_failed");
    expect(await readSecret(fixture.sealed, otherAccount)).toBe("other-account-credential");
  });

  test("rewriting replaces the sealed file and logout removes the key and the file", async () => {
    const fixture = await sealedFixture();
    await Effect.runPromise(fixture.sealed.write(account, secret(largeCredential)));
    await Effect.runPromise(fixture.sealed.write(account, secret("renewed-credential")));

    expect(await readSecret(fixture.sealed, account)).toBe("renewed-credential");
    expect(await sealedFiles(fixture.directory)).toHaveLength(1);

    expect(await Effect.runPromise(fixture.sealed.delete(account))).toBe(true);
    expect(await failureReason(fixture.sealed.read(account))).toBe("credential_missing");
    expect(await failureReason(fixture.keys.read(account))).toBe("credential_missing");
    expect(await sealedFiles(fixture.directory)).toEqual([]);
    expect(await Effect.runPromise(fixture.sealed.delete(account))).toBe(false);
  });

  test("a credential saved before sealing still reads, and the next write seals it", async () => {
    const fixture = await sealedFixture();
    await Effect.runPromise(fixture.keys.write(account, secret("{\"kind\":\"api_key\",\"apiKey\":\"legacy\"}")));

    expect(await readSecret(fixture.sealed, account)).toBe("{\"kind\":\"api_key\",\"apiKey\":\"legacy\"}");

    await Effect.runPromise(fixture.sealed.write(account, secret(largeCredential)));
    expect(await readSecret(fixture.sealed, account)).toBe(largeCredential);
    expect(Redacted.value(await Effect.runPromise(fixture.keys.read(account)))).toMatch(/^sealed-v1:/u);
  });

  test("an account that is not a plain identifier never selects a file path", async () => {
    const fixture = await sealedFixture();
    for (const hostile of ["../escape", "a/b", "", ".", "x".repeat(200)]) {
      // eslint-disable-next-line no-await-in-loop -- each hostile account is checked in turn
      expect(await failureReason(fixture.sealed.write(hostile, secret("value")))).toBe("operation_failed");
    }
    await expect(stat(path.join(path.dirname(fixture.directory), "escape.sealed"))).rejects.toMatchObject({code: "ENOENT"});
    await expect(readFile(fixture.received, "utf8")).rejects.toMatchObject({code: "ENOENT"});
  });
});
