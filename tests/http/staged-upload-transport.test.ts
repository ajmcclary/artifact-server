import {randomBytes} from "node:crypto";
import {request} from "node:http";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

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
} from "../support/publishing.js";
import {stagedWriteDeadlineMilliseconds} from "../../src/core/publishing-limits.js";
import {
  defaultHttpRequestTimeoutMilliseconds,
  nodeHttpServerTimeouts,
} from "../../src/http/node-http-server.js";

type StreamOutcome =
  | {readonly kind: "closed"; readonly code: string}
  | {readonly kind: "response"; readonly status: number};

describe("staged upload transport", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;

  beforeEach(async () => {
    installation = await createTestInstallation();
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    server = null;
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
