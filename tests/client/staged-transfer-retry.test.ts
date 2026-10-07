import {randomBytes, randomUUID} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {Effect, Redacted} from "effect";
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  type FilePublicationCommand,
  type FilePublicationFailure,
  type FilePublicationResult,
  publishPath,
  StagedTransferRetry,
  type StagedTransferRetryPolicy,
} from "../../src/client/file-publication-client.js";
import {fetchLoopbackContent} from "../support/fetch-loopback-content.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  startUploadFaultProxy,
  type UploadFaultProxy,
} from "../support/upload-fault-proxy.js";

type ClientOutcome =
  | {readonly error: FilePublicationFailure; readonly success: false}
  | {readonly result: FilePublicationResult; readonly success: true};

const fastRetry: StagedTransferRetryPolicy = {
  initialDelayMilliseconds: 10,
  maximumAttempts: 4,
  maximumDelayMilliseconds: 40,
};
const droppedTransferCode = /^(?:ECONNRESET|EPIPE|UND_ERR_SOCKET)$/u;
const assignedAddressSchema = z.object({port: z.number().int().positive()});

describe("staged transfer retry", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let fixtureDirectory: string;
  let proxy: UploadFaultProxy;
  let largeFile: Buffer;

  beforeAll(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    fixtureDirectory = await mkdtemp(path.join(tmpdir(), "artifact-server-retry-"));
    // Large enough that a drop lands while the client is still sending.
    largeFile = randomBytes(2 * 1_024 * 1_024);
  });

  afterAll(async () => {
    await server.stop();
    await Promise.all([
      removeTestInstallation(installation),
      rm(fixtureDirectory, {force: true, recursive: true}),
    ]);
  });

  beforeEach(async () => {
    proxy = await startUploadFaultProxy(server.baseUrl);
  });

  afterEach(async () => {
    await proxy.stop();
  });

  test("PUB-022-B: a staged file PUT dropped mid-body is retried and the publication commits exactly one version", async () => {
    const site = await siteFixture("dropped-twice");
    proxy.failFile("icons/library.bin", [{kind: "drop"}, {kind: "drop"}]);

    const outcome = await publish(proxy.origin, site, fastRetry);

    expect(outcome.success).toBe(true);
    if (!outcome.success) return;
    expect(proxy.fileAttempts("icons/library.bin")).toHaveLength(3);
    expect(proxy.fileAttempts("index.html")).toHaveLength(1);
    expect(outcome.result.version.number).toBe(1);
    const served = await fetchLoopbackContent(
      new URL("icons/library.bin", outcome.result.links.version).toString(),
    );
    expect(Buffer.from(await served.arrayBuffer()).equals(largeFile)).toBe(true);
  });

  test("retries the answers a proxy or an interrupted body give, then commits", async () => {
    const site = await siteFixture("transient-answers");
    proxy.failFile("icons/library.bin", [
      {code: "SERVICE_UNAVAILABLE", kind: "status", status: 503},
      {code: "UPLOAD_INTERRUPTED", kind: "status", status: 408},
      {code: "BAD_GATEWAY", kind: "status", status: 502},
    ]);

    const outcome = await publish(proxy.origin, site, fastRetry);

    expect(outcome.success).toBe(true);
    expect(proxy.fileAttempts("icons/library.bin")).toHaveLength(4);
  });

  test("a dropped batch POST is retried with every part reread", async () => {
    const site = path.join(fixtureDirectory, "batch-drop");
    await mkdir(site, {recursive: true});
    await Promise.all([
      writeFile(path.join(site, "index.html"), "<h1>batch</h1>"),
      writeFile(path.join(site, "a.css"), "a { color: red; }"),
      writeFile(path.join(site, "b.js"), "globalThis.b = 1;"),
    ]);
    proxy.failBatches([{kind: "drop"}]);

    const outcome = await publish(proxy.origin, site, fastRetry, "batch");

    expect(outcome.success).toBe(true);
    expect(proxy.batchAttempts()).toHaveLength(2);
  });

  test("the production policy waits about one second before the second attempt", async () => {
    const site = await siteFixture("default-backoff");
    proxy.failFile("icons/library.bin", [{kind: "drop"}]);

    const outcome = await publish(proxy.origin, site);

    expect(outcome.success).toBe(true);
    const [first, second] = proxy.fileAttempts("icons/library.bin");
    if (first === undefined || second === undefined) {
      throw new Error("The dropped file was not retried.");
    }
    // One second, jittered by up to twenty percent, plus the dropped send.
    expect(second - first).toBeGreaterThanOrEqual(750);
    expect(second - first).toBeLessThan(3_000);
  });

  test("PUB-022-F: a digest mismatch is never retried, and exhausted retries name the file, elapsed time, and transport code", async () => {
    const corrupted = await siteFixture("digest-mismatch");
    proxy.failFile("icons/library.bin", [{kind: "corrupt"}]);

    const mismatch = await publish(proxy.origin, corrupted, fastRetry);

    expect(proxy.fileAttempts("icons/library.bin")).toHaveLength(1);
    expect(mismatch).toMatchObject({
      error: {
        _tag: "FilePublicationProtocolError",
        operation: "upload_file",
        serverCode: "INVALID_INPUT",
        status: 422,
        transportCode: null,
      },
      success: false,
    });
    expect(failureMessage(mismatch)).toMatch(
      /^Uploading icons\/library\.bin failed: The uploaded bytes do not match/u,
    );

    await proxy.stop();
    proxy = await startUploadFaultProxy(server.baseUrl);
    const dropped = await siteFixture("always-dropped");
    proxy.failFile("icons/library.bin", Array.from({length: 4}, () => ({kind: "drop" as const})));

    const exhausted = await publish(proxy.origin, dropped, fastRetry);

    expect(proxy.fileAttempts("icons/library.bin")).toHaveLength(4);
    expect(exhausted.success).toBe(false);
    if (exhausted.success || exhausted.error._tag !== "FilePublicationProtocolError") {
      throw new Error("The exhausted upload should fail as a protocol error.");
    }
    expect(exhausted.error).toMatchObject({
      operation: "upload_file",
      serverCode: null,
      status: null,
    });
    expect(exhausted.error.transportCode).toMatch(droppedTransferCode);
    expect(exhausted.error.message).toMatch(
      /^Uploading icons\/library\.bin failed after \d+ s: the connection [a-z ]+ \((?:ECONNRESET|EPIPE|UND_ERR_SOCKET)[^)]*\)\. Gave up after 4 attempts; re-run the same publish to resume\./u,
    );
    expect(exhausted.error.message).not.toContain("/api/v1/uploads");
    expect(exhausted.error.message).not.toContain("could not be reached");

    const unreachable = await publish(
      `http://127.0.0.1:${await closedPort()}`,
      dropped,
      fastRetry,
    );
    expect(failureMessage(unreachable)).toMatch(
      /^Artifact Server could not be reached \(ECONNREFUSED/u,
    );
  });

  async function siteFixture(name: string): Promise<string> {
    const site = path.join(fixtureDirectory, name);
    await mkdir(path.join(site, "icons"), {recursive: true});
    await Promise.all([
      writeFile(path.join(site, "index.html"), `<h1>${name}</h1>`),
      writeFile(path.join(site, "icons", "library.bin"), largeFile),
    ]);
    return site;
  }

  function publish(
    serverOrigin: string,
    inputPath: string,
    retry?: StagedTransferRetryPolicy,
    transport?: "batch",
  ): Promise<ClientOutcome> {
    const apiToken = Redacted.make(installation.apiToken, {label: "test-api-token"});
    const command: FilePublicationCommand = {
      idempotencyKey: randomUUID(),
      inputPath,
      target: {accessSetting: "public_link", kind: "new_artifact", tags: []},
    };
    const published = publishPath(
      transport === undefined
        ? {apiToken, serverOrigin}
        : {apiToken, serverOrigin, transport},
      command,
    ).pipe(
      Effect.match({
        onFailure: (error): ClientOutcome => ({error, success: false}),
        onSuccess: (result): ClientOutcome => ({result, success: true}),
      }),
      Effect.provide(NodeFileSystem.layer),
    );
    return Effect.runPromise(
      retry === undefined
        ? published
        : published.pipe(Effect.provideService(StagedTransferRetry, retry)),
    );
  }
});

function failureMessage(outcome: ClientOutcome): string {
  if (outcome.success) throw new Error("The publication should have failed.");
  return outcome.error.message;
}

function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const {port} = assignedAddressSchema.parse(probe.address());
      probe.close((error) => error === undefined ? resolve(port) : reject(error));
    });
  });
}
