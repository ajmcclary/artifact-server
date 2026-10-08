import {createCipheriv, createDecipheriv, randomBytes} from "node:crypto";
import {chmod, mkdir, readdir, readFile, rename, rm, writeFile} from "node:fs/promises";
import path from "node:path";

import {Effect, Redacted, Schema} from "effect";

import {
  CliCredentialStoreError,
  type CliCredentialStoreOperations,
} from "./cli-credential-store-port.js";

/**
 * Seal CLI credentials of any length behind a short key held by an
 * operating-system store whose items are too small for them. macOS's
 * `security` reads at most 128 characters from stdin, so the Keychain item
 * holds only `sealed-v1:<keyId>:<key>` and the credential lives in a
 * user-only file, encrypted with AES-256-GCM under that key and bound to its
 * account and key ID. The credential never reaches a process argument, and
 * an item saved before sealing still reads as it was.
 */
export interface SealedCredentialStoreOptions {
  /** A user-only directory for the sealed files; it is created 0700. */
  readonly directory: string;
  /** The store that keeps each account's short sealing key. */
  readonly keys: CliCredentialStoreOperations;
}

const keyPrefix = "sealed-v1:";
const accountPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const keyReferenceSchema = Schema.TemplateLiteralParser([
  Schema.Literal(keyPrefix),
  Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u)),
  Schema.Literal(":"),
  Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
]);
const sealedDocumentSchema = Schema.Struct({
  ciphertext: Schema.String,
  iv: Schema.String,
  keyId: Schema.String,
  tag: Schema.String,
  version: Schema.Literal(1),
});
const decodeKeyReference = Schema.decodeUnknownOption(keyReferenceSchema);
const decodeSealedDocument = Schema.decodeUnknownOption(Schema.fromJsonString(sealedDocumentSchema));

export function sealedCredentialStore(
  options: SealedCredentialStoreOptions,
): CliCredentialStoreOperations {
  const fileFor = (account: string, keyId: string) =>
    path.join(options.directory, `${account}.${keyId}.sealed`);

  const read = Effect.fnUntraced(function*(account: string): Effect.fn.Return<
    Redacted.Redacted,
    CliCredentialStoreError
  > {
    yield* requireAccount(account, "read");
    const stored = yield* options.keys.read(account);
    const reference = decodeKeyReference(Redacted.value(stored));
    // An item saved before sealing holds the credential itself.
    if (reference._tag === "None") return stored;
    const [, keyId, , key] = reference.value;
    const sealed = yield* Effect.tryPromise({
      try: () => readFile(fileFor(account, keyId), "utf8"),
      catch: () => sealedFailure("read", "The sealed credential file for this profile is missing or unreadable."),
    });
    return yield* openSealed(sealed, account, keyId, key);
  });

  const write = Effect.fnUntraced(function*(
    account: string,
    secret: Redacted.Redacted,
  ): Effect.fn.Return<void, CliCredentialStoreError> {
    yield* requireAccount(account, "write");
    const previous = yield* options.keys.read(account).pipe(
      Effect.map((stored) => decodeKeyReference(Redacted.value(stored))),
      Effect.catchTag("CliCredentialStoreError", (error) =>
        error.reason === "credential_missing" ? Effect.succeedNone : Effect.fail(error)),
    );
    const keyId = randomBytes(16).toString("hex");
    const key = randomBytes(32).toString("base64url");
    const target = fileFor(account, keyId);
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(options.directory, {mode: 0o700, recursive: true});
        await chmod(options.directory, 0o700);
        const staging = `${target}.${randomBytes(8).toString("hex")}.tmp`;
        await writeFile(staging, seal(Redacted.value(secret), account, keyId, key), {flag: "wx", mode: 0o600});
        await rename(staging, target);
      },
      catch: () => sealedFailure("write", "The sealed credential file could not be written."),
    });
    yield* options.keys.write(account, Redacted.make(`${keyPrefix}${keyId}:${key}`, {
      label: "artifact-server-cli-profile",
    })).pipe(
      Effect.tapError(() => Effect.promise(() => rm(target, {force: true}))),
    );
    // Read back through the key store rather than trusting the write.
    const stored = yield* read(account);
    yield* Redacted.value(stored) === Redacted.value(secret)
      ? Effect.void
      : Effect.fail(sealedFailure("write", "The credential store did not keep the credential it was given."));
    if (previous._tag === "Some" && previous.value[1] !== keyId) {
      yield* Effect.promise(() => rm(fileFor(account, previous.value[1]), {force: true}));
    }
  });

  const remove = Effect.fnUntraced(function*(account: string): Effect.fn.Return<boolean, CliCredentialStoreError> {
    yield* requireAccount(account, "delete");
    const removedKey = yield* options.keys.delete(account);
    const removedFiles = yield* Effect.tryPromise({
      try: async () => {
        const names = await readdir(options.directory).catch(() => []);
        const owned = names.filter((name) => name.startsWith(`${account}.`) && name.endsWith(".sealed"));
        await Promise.all(owned.map((name) => rm(path.join(options.directory, name), {force: true})));
        return owned.length > 0;
      },
      catch: () => sealedFailure("delete", "The sealed credential file could not be removed."),
    });
    return removedKey || removedFiles;
  });

  return {delete: remove, read, write};
}

function requireAccount(
  account: string,
  operation: "delete" | "read" | "write",
): Effect.Effect<void, CliCredentialStoreError> {
  return accountPattern.test(account)
    ? Effect.void
    : Effect.fail(sealedFailure(operation, "The credential account is not a plain identifier."));
}

function associatedData(account: string, keyId: string): Buffer {
  return Buffer.from(`artifactserver-cli-credential/v1\0${account}\0${keyId}`, "utf8");
}

function seal(plaintext: string, account: string, keyId: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64url"), iv);
  cipher.setAAD(associatedData(account, keyId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return JSON.stringify({
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    keyId,
    tag: cipher.getAuthTag().toString("base64url"),
    version: 1,
  });
}

function openSealed(
  sealed: string,
  account: string,
  keyId: string,
  key: string,
): Effect.Effect<Redacted.Redacted, CliCredentialStoreError> {
  return Effect.try({
    try: () => {
      const document = decodeSealedDocument(sealed);
      if (document._tag === "None" || document.value.keyId !== keyId) {
        throw new Error("The sealed credential does not belong to this key.");
      }
      const decipher = createDecipheriv(
        "aes-256-gcm",
        Buffer.from(key, "base64url"),
        Buffer.from(document.value.iv, "base64url"),
      );
      decipher.setAAD(associatedData(account, keyId));
      decipher.setAuthTag(Buffer.from(document.value.tag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(document.value.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      return Redacted.make(plaintext, {label: "artifact-server-cli-profile"});
    },
    catch: () => sealedFailure("read", "The sealed credential for this profile failed verification."),
  });
}

function sealedFailure(
  operation: "delete" | "read" | "write",
  message: string,
): CliCredentialStoreError {
  return new CliCredentialStoreError({message, operation, reason: "operation_failed"});
}
