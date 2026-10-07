import {randomBytes} from "node:crypto";
import {chmod, mkdir} from "node:fs/promises";
import {request} from "node:http";
import path from "node:path";

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, test} from "vitest";

import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  commitStagedUpload,
  createStagedUpload,
  type CreateUploadResponse,
  testSiteFile,
  uploadStagedFile,
} from "../support/publishing.js";
import {
  type OtlpLogCollector,
  startOtlpLogCollector,
} from "../support/otlp-log-collector.js";
import {stagedWriteDeadlineMilliseconds} from "../../src/core/publishing-limits.js";
import {
  defaultHttpRequestTimeoutMilliseconds,
  nodeHttpServerTimeouts,
} from "../../src/http/node-http-server.js";
import {
  redactedFailureCause,
  summarizeFailureCause,
} from "../../src/observability/failure-cause-summary.js";

type StreamOutcome =
  | {readonly kind: "closed"; readonly code: string}
  | {readonly kind: "response"; readonly status: number};

describe("staged upload transport", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;
  let collector: OtlpLogCollector;

  beforeAll(async () => {
    collector = await startOtlpLogCollector();
  });

  afterAll(async () => {
    await collector.stop();
  });

  beforeEach(async () => {
    installation = await createTestInstallation();
    collector.reset();
  });

  afterEach(async () => {
    // Stopping the server flushes its exporter before the next reset.
    if (server !== null) await server.stop();
    server = null;
    await chmod(path.join(installation.dataDirectory, "staging"), 0o700)
      .catch(() => undefined);
    await removeTestInstallation(installation);
  });

  test("the production HTTP servers give one staged write its whole deadline before Node cuts the request", () => {
    const timeouts = nodeHttpServerTimeouts();
    expect(defaultHttpRequestTimeoutMilliseconds).toBeGreaterThan(
      stagedWriteDeadlineMilliseconds,
    );
    expect(timeouts.requestTimeout).toBe(defaultHttpRequestTimeoutMilliseconds);
    // Node checks expired requests on this interval, so a cut can land this
    // much later than the request timeout itself.
    expect(timeouts.connectionsCheckingInterval).toBeLessThanOrEqual(30_000);
    // Slow-header protection stays independent of the long body allowance.
    expect(timeouts.headersTimeout).toBeLessThanOrEqual(60_000);
  });

  test("PUB-021-B: a staged file streamed slowly inside the server request deadline verifies and commits", async () => {
    server = await startTestServer(installation, {requestTimeoutMilliseconds: 2_000});
    const file = slowFixture("slow but inside the deadline");
    const upload = await createStagedUpload(
      server,
      installation,
      file.path,
      [file],
      undefined,
      "static",
      "slow-inside-deadline-0000000001",
    );
    const planned = onlyPlannedFile(upload.body);

    const streamed = await streamSlowly(planned.uploadUrl, file.bytes, 5, 100);

    expect(streamed).toEqual({kind: "response", status: 200});
    const committed = await commitStagedUpload(
      installation,
      upload.body,
      "slow-inside-deadline-0000000001",
      {accessSetting: "account_required", kind: "new_artifact", name: "slow"},
    );
    expect(committed.response.status).toBe(201);
  });

  test("PUB-021-F: a body slower than the server request deadline is recorded as an interrupted upload, not a storage failure, and resumes", async () => {
    server = await startTestServer(installation, {
      completedRequestLogSampleRate: 1,
      observability: true,
      requestTimeoutMilliseconds: 1_000,
    });
    const file = slowFixture("slower than the request deadline");
    const key = "slow-past-deadline-000000000001";
    const upload = await createStagedUpload(
      server,
      installation,
      file.path,
      [file],
      undefined,
      "static",
      key,
    );
    const planned = onlyPlannedFile(upload.body);
    const storageToken = storageTokenOf(planned.uploadUrl);

    const streamed = await streamSlowly(planned.uploadUrl, file.bytes, 12, 250);

    expect(streamed).not.toEqual({kind: "response", status: 200});
    await collector.waitFor(["http.request.interrupted", "UploadInterrupted"]);
    const logs = collector.logs();
    expect(logs).toContain("ECONNRESET");
    expect(logs).not.toContain(storageToken);
    expect(logs).not.toContain(installation.apiToken);
    await collector.waitForSpan("UploadInterrupted");
    expect(collector.serialized()).not.toContain(storageToken);
    expect(collector.serialized()).not.toContain(installation.apiToken);
    expect(collector.serialized()).not.toContain("StagingStorageFailure");

    const resumed = await createStagedUpload(
      server,
      installation,
      file.path,
      [file],
      undefined,
      "static",
      key,
    );
    expect(resumed.body.status).toBe("resumed");
    expect(resumed.body.files[0]?.verified).toBe(false);
    const retried = await uploadStagedFile(
      installation,
      onlyPlannedFile(resumed.body),
      file.bytes,
    );
    expect(retried.status).toBe(200);
    const committed = await commitStagedUpload(
      installation,
      resumed.body,
      key,
      {accessSetting: "account_required", kind: "new_artifact", name: "resumed"},
    );
    expect(committed.response.status).toBe(201);
  });

  test("a client that disconnects mid-body leaves its slot unverified and is not reported as a storage failure", async () => {
    server = await startTestServer(installation, {
      completedRequestLogSampleRate: 1,
      observability: true,
    });
    const file = slowFixture("client disconnects mid-body");
    const key = "client-disconnect-0000000000001";
    const upload = await createStagedUpload(
      server,
      installation,
      file.path,
      [file],
      undefined,
      "static",
      key,
    );
    const planned = onlyPlannedFile(upload.body);

    const streamed = await streamThenDisconnect("PUT", planned.uploadUrl, file.bytes);

    expect(streamed.kind).toBe("closed");
    await collector.waitFor(["http.request.interrupted", "UploadInterrupted"]);
    expect(collector.serialized()).not.toContain("StagingStorageFailure");
    const resumed = await createStagedUpload(
      server,
      installation,
      file.path,
      [file],
      undefined,
      "static",
      key,
    );
    expect(resumed.body.files[0]?.verified).toBe(false);
  });

  test("a batch frame cut off by a disconnect is an interrupted upload, not a malformed frame", async () => {
    server = await startTestServer(installation, {
      completedRequestLogSampleRate: 1,
      observability: true,
    });
    const files = [
      testSiteFile("first batch part", undefined, "index.html"),
      testSiteFile("second batch part", undefined, "second.html"),
    ];
    const upload = await createStagedUpload(
      server,
      installation,
      "index.html",
      files,
      undefined,
      "static",
      "batch-disconnect-0000000000001",
    );
    const firstPlanned = upload.body.files[0];
    if (firstPlanned === undefined) throw new Error("The plan has no files.");
    const batchUrl = new URL(
      `/api/v1/uploads/${upload.body.uploadId}/batch`,
      server.baseUrl,
    );
    batchUrl.search = new URL(firstPlanned.uploadUrl).search;
    const frame = batchFrame(upload.body, files);

    const streamed = await streamThenDisconnect(
      "POST",
      batchUrl.toString(),
      frame,
      installation.apiToken,
    );

    expect(streamed.kind).toBe("closed");
    await collector.waitFor(["http.request.interrupted", "UploadInterrupted"]);
    expect(collector.serialized()).not.toContain("UploadedFileMismatch");
  });

  test.skipIf(process.getuid?.() === 0)(
    "a genuine staging provider failure stays a storage failure, and no exported log or span carries its staging path",
    async () => {
      server = await startTestServer(installation, {observability: true});
      const file = slowFixture("provider failure");
      const upload = await createStagedUpload(
        server,
        installation,
        file.path,
        [file],
        undefined,
        "static",
        "provider-failure-000000000000001",
      );
      const planned = onlyPlannedFile(upload.body);
      const storageToken = storageTokenOf(planned.uploadUrl);
      // The upload's own staging directory exists but refuses new files, so
      // the provider error names a path that contains the storage token.
      const uploadDirectory = path.join(
        installation.dataDirectory,
        "staging",
        upload.body.uploadId,
      );
      await mkdir(uploadDirectory, {recursive: true});
      await chmod(uploadDirectory, 0o500);

      const response = await uploadStagedFile(installation, planned, file.bytes);
      await chmod(uploadDirectory, 0o700);

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: {
          code: "INTERNAL_ERROR",
          message: "The server could not complete the request.",
        },
      });
      await collector.waitFor(["http.request.failed", "StagingStorageFailure", "EACCES"]);
      await collector.waitForSpan("StagingStorageFailure");
      const logs = collector.logs();
      expect(logs).toContain("failure_cause");
      // The failed spans still name the failure and the provider's code, so a
      // trace stays diagnosable without the path that works as a write key.
      const spans = collector.spans();
      expect(spans).toContain("EACCES");
      for (const signal of [logs, spans, collector.serialized()]) {
        expect(signal).not.toContain(storageToken);
        expect(signal).not.toContain(upload.body.uploadId);
        expect(signal).not.toContain(installation.dataDirectory);
      }
    },
  );
});

describe("failure cause summaries", () => {
  test("keep error names and codes but drop URLs, quoted values, paths, and opaque identifiers", () => {
    const storageToken = "f9808fe76b2a4ba287dfc82ab2f0514119b3";
    const provider = Object.assign(
      new Error(
        `EACCES: permission denied, open '/srv/data/staging/upl_1/${storageToken}.tmp'`,
      ),
      {code: "EACCES"},
    );
    const transport = Object.assign(
      new Error(
        `request to https://bucket.example.test/staging/${storageToken}?X-Amz-Signature=abc failed for /srv/data/${storageToken}`,
        {cause: provider},
      ),
      {code: "not a code; it has spaces"},
    );

    const summary = summarizeFailureCause(new TypeError("fetch failed", {cause: transport}));

    expect(summary).toBe(
      "TypeError: fetch failed <- Error: request to [url] failed for [path] <- Error EACCES: EACCES: permission denied, open [value]",
    );
    expect(summary).not.toContain(storageToken);
    expect(summarizeFailureCause("a string thrown as a failure")).toBe("non-error value");
    const long = new Error("word ".repeat(2_000), {cause: new Error("word ".repeat(2_000))});
    expect(summarizeFailureCause(long).length).toBeLessThanOrEqual(400);
  });

  test("a redacted cause keeps the summary but carries no path, token, or stack frame for a span to export", () => {
    const storageToken = "f9808fe76b2a4ba287dfc82ab2f0514119b3";
    const provider = Object.assign(
      new Error(`EACCES: permission denied, open '/srv/data/staging/upl_1/${storageToken}.tmp'`),
      {code: "EACCES", path: `/srv/data/staging/upl_1/${storageToken}.tmp`},
    );
    const raw = new TypeError("fetch failed", {
      cause: new Error("level two", {cause: new Error("level three", {cause: provider})}),
    });

    const redacted = redactedFailureCause(raw);

    expect(summarizeFailureCause(redacted)).toBe(summarizeFailureCause(raw));
    expect(redacted.stack).toBe("TypeError: fetch failed");
    // The chain stops at the same depth as the log summary.
    const chain: unknown[] = [];
    for (let level: unknown = redacted; level instanceof Error; level = level.cause) {
      chain.push(level.stack);
    }
    expect(chain).toEqual(["TypeError: fetch failed", "Error: level two", "Error: level three"]);
    const provided = redactedFailureCause(provider);
    expect(provided).toMatchObject({code: "EACCES", name: "Error"});
    expect(provided).not.toHaveProperty("path");
    expect(`${provided.message}\n${provided.stack}`).not.toContain(storageToken);
    expect(provided.stack).not.toContain("/srv/data");
    expect(redactedFailureCause("a string thrown as a failure").message).toBe("non-error value");
  });
});

function slowFixture(label: string): ReturnType<typeof testSiteFile> {
  return testSiteFile(
    `<!doctype html><title>${label}</title><!-- ${randomBytes(48 * 1_024).toString("hex")} -->`,
  );
}

function onlyPlannedFile(
  upload: CreateUploadResponse,
): CreateUploadResponse["files"][number] {
  const planned = upload.files[0];
  if (planned === undefined || upload.files.length !== 1) {
    throw new Error("The upload plan should contain exactly one file.");
  }
  return planned;
}

function storageTokenOf(uploadUrl: string): string {
  const token = new URL(uploadUrl).pathname.split("/").at(-1);
  if (token === undefined || token.length < 16) {
    throw new Error("The upload URL does not carry a storage token.");
  }
  return token;
}

/** Stream a declared-length PUT body in evenly spaced chunks. */
function streamSlowly(
  uploadUrl: string,
  bytes: Uint8Array,
  chunkCount: number,
  intervalMilliseconds: number,
): Promise<StreamOutcome> {
  const target = new URL(uploadUrl);
  const chunkSize = Math.ceil(bytes.byteLength / chunkCount);
  let timer: NodeJS.Timeout | undefined;
  const outcome = new Promise<StreamOutcome>((resolve) => {
    let sent = 0;
    const settle = (settled: StreamOutcome): void => {
      resolve(settled);
    };
    const outgoing = request({
      headers: {"Content-Length": String(bytes.byteLength)},
      hostname: target.hostname,
      method: "PUT",
      path: `${target.pathname}${target.search}`,
      port: target.port,
    }, (incoming) => {
      incoming.resume();
      incoming.on("end", () => settle({kind: "response", status: incoming.statusCode ?? 0}));
      incoming.on("error", (error: NodeJS.ErrnoException) =>
        settle({kind: "closed", code: error.code ?? error.name}));
    });
    outgoing.on("error", (error: NodeJS.ErrnoException) =>
      settle({kind: "closed", code: error.code ?? error.name}));
    outgoing.flushHeaders();
    timer = setInterval(() => {
      if (outgoing.destroyed) {
        clearInterval(timer);
        return;
      }
      const chunk = bytes.subarray(sent, sent + chunkSize);
      sent += chunk.byteLength;
      if (sent >= bytes.byteLength) {
        clearInterval(timer);
        outgoing.end(chunk);
      } else {
        outgoing.write(chunk);
      }
    }, intervalMilliseconds);
  });
  return outcome.finally(() => {
    clearInterval(timer);
  });
}

/** Encode every planned file as one binary batch frame, in plan order. */
function batchFrame(
  upload: CreateUploadResponse,
  files: readonly ReturnType<typeof testSiteFile>[],
): Uint8Array {
  const parts = upload.files.map((planned, orderIndex) => {
    const file = files.find((candidate) => candidate.path === planned.path);
    if (file === undefined) throw new Error(`No fixture for ${planned.path}.`);
    const header = new Uint8Array(12);
    const view = new DataView(header.buffer);
    view.setUint32(0, orderIndex, true);
    view.setFloat64(4, file.bytes.byteLength, true);
    return Buffer.concat([header, file.bytes]);
  });
  return new Uint8Array(Buffer.concat(parts));
}

/** Send half of a declared-length body, then destroy the connection. */
function streamThenDisconnect(
  method: "POST" | "PUT",
  uploadUrl: string,
  bytes: Uint8Array,
  apiToken?: string,
): Promise<StreamOutcome> {
  const target = new URL(uploadUrl);
  const contentLength = String(bytes.byteLength);
  const headers = apiToken === undefined
    ? {"Content-Length": contentLength}
    : {Authorization: `Bearer ${apiToken}`, "Content-Length": contentLength};
  return new Promise((resolve) => {
    const settle = (outcome: StreamOutcome): void => {
      resolve(outcome);
    };
    const outgoing = request({
      headers,
      hostname: target.hostname,
      method,
      path: `${target.pathname}${target.search}`,
      port: target.port,
    }, (incoming) => {
      incoming.resume();
      settle({kind: "response", status: incoming.statusCode ?? 0});
    });
    outgoing.on("error", (error: NodeJS.ErrnoException) =>
      settle({kind: "closed", code: error.code ?? error.name}));
    outgoing.write(bytes.subarray(0, Math.floor(bytes.byteLength / 2)), () => {
      setTimeout(() => {
        outgoing.destroy(new Error("client went away"));
      }, 100);
    });
  });
}
