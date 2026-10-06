import {mkdtemp, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {maximumBatchParts, maximumBatchRequestBytes} from "../../src/core/publishing-limits.js";
import {
  commitStagedUpload,
  createStagedUpload,
  type CreateUploadResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

const batchResponseSchema = z.object({
  accepted: z.array(z.object({path: z.string(), status: z.string()}).loose()),
  rejected: z.array(z.object({code: z.string(), path: z.string().nullable()}).loose()),
  truncated: z.boolean(),
  uploadId: z.string(),
}).loose();

interface BatchPart {
  readonly bytes: Uint8Array;
  readonly orderIndex: number;
}

function fixtureFiles(): readonly [
  TestSiteFile,
  TestSiteFile,
  TestSiteFile,
] {
  return [
    {bytes: utf8("index bytes\n"), mediaType: "text/html; charset=utf-8", path: "index.html"},
    {bytes: utf8("alpha\n"), mediaType: "text/plain; charset=utf-8", path: "a.txt"},
    {bytes: utf8("beta\n"), mediaType: "text/plain; charset=utf-8", path: "b.txt"},
  ];
}

describe("staged small-file batches stay an opt-in transport with per-part guards", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let dataRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    dataRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "pub-016-fixture-")),
    );
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
    await rm(dataRoot, {force: true, recursive: true});
  });

  test("PUB-016-B: a bounded batch verifies every part and commits the exact bytes", async () => {
    expect.hasAssertions();
    const files = fixtureFiles();
    const planned = await createStagedUpload(server, installation, "index.html", files);
    const result = await postBatch(planned, files.map((file) => ({
      bytes: file.bytes,
      orderIndex: orderIndexOf(planned, file.path),
    })));
    expect(result.status).toBe(200);
    const body = batchResponseSchema.parse(await result.json());
    expect(body.accepted.map((part) => part.path).toSorted())
      .toEqual(["a.txt", "b.txt", "index.html"]);
    expect(body.rejected).toEqual([]);
    expect(body.truncated).toBe(false);

    const published = await commitStagedUpload(
      installation,
      planned.body,
      "pub-016-behavior-batch",
      {accessSetting: "account_required", kind: "new_artifact", name: "Batch fixture"},
    );
    expect(published.body.version.number).toBe(1);
    await Promise.all(files.map(async (file) => {
      const served = await readVersionFile(
        published.body.artifact.id,
        published.body.version.id,
        file.path,
      );
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(file.bytes);
    }));

    // The frame is only a transport: the same files sent one PUT at a time
    // commit the identical authoritative manifest.
    const perFilePlan = await createStagedUpload(server, installation, "index.html", files);
    const perFileUploads = await uploadEveryStagedFile(installation, perFilePlan.body, files);
    expect(perFileUploads.map((response) => response.status)).toEqual(files.map(() => 200));
    const perFile = await commitStagedUpload(
      installation,
      perFilePlan.body,
      "pub-016-behavior-per-file",
      {accessSetting: "account_required", kind: "new_artifact", name: "Per-file fixture"},
    );
    expect(published.body.version.manifestDigest).toBe(planned.body.manifestDigest);
    expect(published.body.version.manifestDigest).toBe(perFile.body.version.manifestDigest);
  });

  test("PUB-016-F: malformed, duplicate, unknown, oversized, truncated, base64, and size- or hash-mismatched parts never verify a version", async () => {
    expect.hasAssertions();
    const [indexFile, alphaFile, betaFile] = fixtureFiles();
    const operationKey = "pub-016-failure-plan";
    const planned = await createStagedUpload(
      server,
      installation,
      "index.html",
      fixtureFiles(),
      undefined,
      "static",
      operationKey,
    );

    const duplicate = await postBatch(planned, [
      {bytes: alphaFile.bytes, orderIndex: orderIndexOf(planned, alphaFile.path)},
      {bytes: alphaFile.bytes, orderIndex: orderIndexOf(planned, alphaFile.path)},
    ]);
    expect(await codes(duplicate)).toContain("duplicate_part");

    const unknown = await postBatch(planned, [
      {bytes: alphaFile.bytes, orderIndex: 999},
    ]);
    expect(await codes(unknown)).toContain("unknown_part");

    const wrongSize = await postBatch(planned, [
      {bytes: utf8("a size that does not match index.html\n"), orderIndex: orderIndexOf(planned, indexFile.path)},
    ]);
    expect(await codes(wrongSize)).toContain("size_mismatch");

    const empty = await postBatch(planned, []);
    expect(batchResponseSchema.parse(await empty.json()).accepted).toEqual([]);

    // A header whose declared size is not a safe non-negative integer is malformed.
    const malformedHeader = new Uint8Array(12 + betaFile.bytes.byteLength);
    const malformedView = new DataView(malformedHeader.buffer);
    malformedView.setUint32(0, orderIndexOf(planned, betaFile.path), true);
    malformedView.setFloat64(4, Number.NaN, true);
    malformedHeader.set(betaFile.bytes, 12);
    expect(await errorCode(await postBatchRaw(planned, malformedHeader))).toBe("INVALID_INPUT");

    // Same size, different bytes: the authoritative hash refuses the part.
    const hashMismatch = await postBatch(planned, [
      {bytes: utf8("BETA\n"), orderIndex: orderIndexOf(planned, betaFile.path)},
    ]);
    expect(await errorCode(hashMismatch)).toBe("INVALID_INPUT");

    // A frame cut inside a part body reports truncation and verifies nothing.
    const betaFrame = buildFrame([
      {bytes: betaFile.bytes, orderIndex: orderIndexOf(planned, betaFile.path)},
    ]);
    const cutBody = batchResponseSchema.parse(
      await (await postBatchRaw(planned, betaFrame.slice(0, betaFrame.byteLength - 2))).json(),
    );
    expect(cutBody).toMatchObject({accepted: [], truncated: true});
    expect(cutBody.rejected.map((part) => part.code)).toEqual(["truncated"]);

    // A frame cut inside a part header is truncated too, never a clean end.
    const cutHeader = batchResponseSchema.parse(
      await (await postBatchRaw(planned, betaFrame.slice(0, 5))).json(),
    );
    expect(cutHeader).toMatchObject({accepted: [], truncated: true});
    expect(cutHeader.rejected.map((part) => part.code)).toEqual(["truncated"]);

    // Base64 is not a framing: the text of a valid frame, or a JSON envelope of
    // base64 parts, verifies nothing.
    const base64Bodies = [
      {
        body: utf8(Buffer.from(betaFrame).toString("base64")),
        contentType: "text/plain",
      },
      {
        body: utf8(JSON.stringify({parts: [{
          data: Buffer.from(betaFile.bytes).toString("base64"),
          orderIndex: orderIndexOf(planned, betaFile.path),
        }]})),
        contentType: "application/json",
      },
    ];
    const base64Codes = await Promise.all(base64Bodies.map(async ({body, contentType}) =>
      errorCode(await postBatchRaw(planned, body, contentType))
    ));
    expect(base64Codes).toEqual(["INVALID_INPUT", "INVALID_INPUT"]);

    // A frame over the request bound is refused before any part verifies.
    const oversized = await postBatch(planned, [
      {bytes: betaFile.bytes, orderIndex: orderIndexOf(planned, betaFile.path)},
      {bytes: new Uint8Array(maximumBatchRequestBytes), orderIndex: orderIndexOf(planned, indexFile.path)},
    ]);
    expect(await errorCode(oversized)).toBe("INVALID_INPUT");

    const tooMany = await postBatch(planned, Array.from(
      {length: maximumBatchParts + 1},
      () => ({bytes: new Uint8Array(0), orderIndex: 999}),
    ));
    expect(tooMany.status).toBe(422);
    const tooManyBody = z.object({
      error: z.object({code: z.string()}).loose(),
    }).loose().parse(await tooMany.json());
    expect(tooManyBody.error.code).toBe("INVALID_INPUT");

    // Only the first copy of the duplicated part verified; every hostile part
    // above left its slot unverified, so a commit cannot produce a version.
    expect(await verifiedFlags(planned.body, operationKey)).toEqual({
      "a.txt": true,
      "b.txt": false,
      "index.html": false,
    });
    const incomplete = await fetch(planned.body.commitUrl, {
      body: JSON.stringify({target: {
        accessSetting: "account_required",
        kind: "new_artifact",
        name: "incomplete",
      }}),
      headers: apiHeaders(installation, "pub-016-failure-incomplete"),
      method: "POST",
    });
    expect(incomplete.status).toBeGreaterThanOrEqual(400);
    expect(await listedArtifactIds()).toEqual([]);
  });

  test("PUB-017-B: a truncated batch resumes with only the missing parts and commits one version", async () => {
    expect.hasAssertions();
    const [indexFile, alphaFile, betaFile] = fixtureFiles();
    const operationKey = "pub-017-behavior-plan";
    const planned = await createStagedUpload(
      server,
      installation,
      "index.html",
      fixtureFiles(),
      undefined,
      "static",
      operationKey,
    );
    expect(planned.body.status).toBe("created");

    // Frame part 0 complete, then interrupt mid-frame inside part 1's body.
    const full = buildFrame([
      {bytes: indexFile.bytes, orderIndex: orderIndexOf(planned, indexFile.path)},
      {bytes: alphaFile.bytes, orderIndex: orderIndexOf(planned, alphaFile.path)},
    ]);
    const interrupted = await postBatchRaw(planned, full.slice(0, 12 + indexFile.bytes.byteLength + 12 + 2));
    const interruptedBody = batchResponseSchema.parse(await interrupted.json());
    expect(interruptedBody.accepted.map((part) => part.path)).toEqual(["index.html"]);
    expect(interruptedBody.truncated).toBe(true);

    // Retrying with the same operation key resumes the same upload and reports
    // which parts are already verified.
    expect(await verifiedFlags(planned.body, operationKey)).toEqual({
      "a.txt": false,
      "b.txt": false,
      "index.html": true,
    });

    // Resume sends only the parts that were not verified.
    const resume = await postBatch(planned, [
      {bytes: alphaFile.bytes, orderIndex: orderIndexOf(planned, alphaFile.path)},
      {bytes: betaFile.bytes, orderIndex: orderIndexOf(planned, betaFile.path)},
    ]);
    expect(batchResponseSchema.parse(await resume.json()).accepted.map((part) => part.path).toSorted())
      .toEqual(["a.txt", "b.txt"]);
    expect(await verifiedFlags(planned.body, operationKey)).toEqual({
      "a.txt": true,
      "b.txt": true,
      "index.html": true,
    });

    const published = await commitStagedUpload(
      installation,
      planned.body,
      "pub-017-behavior-resume",
      {accessSetting: "account_required", kind: "new_artifact", name: "Batch resume fixture"},
    );
    expect(published.body.version.number).toBe(1);
    const versions = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}/versions`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    const versionList = z.object({versions: z.array(z.unknown())}).parse(await versions.json());
    expect(versionList.versions).toHaveLength(1);
  });

  test("PUB-017-F: a truncated or partially accepted batch never yields a partial version or re-verifies a verified part", async () => {
    expect.hasAssertions();
    const [indexFile, alphaFile, betaFile] = fixtureFiles();
    const operationKey = "pub-017-failure-plan";
    const planned = await createStagedUpload(
      server,
      installation,
      "index.html",
      fixtureFiles(),
      undefined,
      "static",
      operationKey,
    );
    const target = {accessSetting: "account_required", kind: "new_artifact", name: "Partial batch"} as const;

    // Interrupted inside part 1's header: only part 0 verifies, and the frame
    // reports the truncation instead of a clean end.
    const full = buildFrame([
      {bytes: indexFile.bytes, orderIndex: orderIndexOf(planned, indexFile.path)},
      {bytes: alphaFile.bytes, orderIndex: orderIndexOf(planned, alphaFile.path)},
    ]);
    const interrupted = batchResponseSchema.parse(
      await (await postBatchRaw(planned, full.slice(0, 12 + indexFile.bytes.byteLength + 4))).json(),
    );
    expect(interrupted.accepted.map((part) => part.path)).toEqual(["index.html"]);
    expect(interrupted.truncated).toBe(true);

    // A commit over the partially verified upload produces no version at all.
    const partialCommit = await fetch(planned.body.commitUrl, {
      body: JSON.stringify({target}),
      headers: apiHeaders(installation, "pub-017-failure-partial-commit"),
      method: "POST",
    });
    expect(partialCommit.status).toBeGreaterThanOrEqual(400);
    expect(await listedArtifactIds()).toEqual([]);

    // A hostile resume that re-sends the verified part with different bytes of
    // the same size cannot replace what was verified.
    const forged = await postBatch(planned, [
      {bytes: utf8("INDEX BYTES\n"), orderIndex: orderIndexOf(planned, indexFile.path)},
    ]);
    expect(await errorCode(forged)).toBe("INVALID_INPUT");
    expect(await verifiedFlags(planned.body, operationKey)).toEqual({
      "a.txt": false,
      "b.txt": false,
      "index.html": true,
    });

    // Re-sending the verified part twice in one resume frame verifies it at most once.
    const doubled = batchResponseSchema.parse(await (await postBatch(planned, [
      {bytes: indexFile.bytes, orderIndex: orderIndexOf(planned, indexFile.path)},
      {bytes: indexFile.bytes, orderIndex: orderIndexOf(planned, indexFile.path)},
      {bytes: alphaFile.bytes, orderIndex: orderIndexOf(planned, alphaFile.path)},
      {bytes: betaFile.bytes, orderIndex: orderIndexOf(planned, betaFile.path)},
    ])).json());
    expect(doubled.rejected).toEqual([{code: "duplicate_part", path: "index.html"}]);
    expect(doubled.accepted.filter((part) => part.path === "index.html")).toHaveLength(1);

    // The upload now commits exactly one version with the originally verified
    // bytes, and a retried commit replays that version instead of adding one.
    const committed = await commitStagedUpload(installation, planned.body, "pub-017-failure-commit", target);
    expect(committed.response.status).toBe(201);
    const replayed = await commitStagedUpload(installation, planned.body, "pub-017-failure-commit", target);
    expect(replayed.body.version.id).toBe(committed.body.version.id);
    expect(await listedArtifactIds()).toEqual([committed.body.artifact.id]);
    const versions = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${committed.body.artifact.id}/versions`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(z.object({versions: z.array(z.unknown())}).parse(await versions.json()).versions).toHaveLength(1);
    const served = await readVersionFile(committed.body.artifact.id, committed.body.version.id, indexFile.path);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(indexFile.bytes);
  });

  /** Re-issue the upload plan under its operation key and read each part's verified flag. */
  async function verifiedFlags(
    upload: CreateUploadResponse,
    operationKey: string,
  ): Promise<Record<string, boolean>> {
    const resumed = await createStagedUpload(
      server,
      installation,
      "index.html",
      fixtureFiles(),
      undefined,
      "static",
      operationKey,
    );
    expect(resumed.body.status).toBe("resumed");
    expect(resumed.body.uploadId).toBe(upload.uploadId);
    return Object.fromEntries(resumed.body.files.map((file) => [file.path, file.verified]));
  }

  async function listedArtifactIds(): Promise<string[]> {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts?projectId=prj_default`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(response.status).toBe(200);
    return z.object({artifacts: z.array(z.object({artifact: z.object({id: z.string()})}))})
      .parse(await response.json()).artifacts.map(({artifact}) => artifact.id);
  }

  async function codes(response: Response): Promise<string[]> {
    return batchResponseSchema.parse(await response.json()).rejected.map((part) => part.code);
  }

  async function postBatch(
    planned: {body: {uploadId: string; files: readonly {uploadUrl: string}[]}},
    parts: readonly BatchPart[],
  ): Promise<Response> {
    return postBatchRaw(planned, buildFrame(parts));
  }

  async function postBatchRaw(
    planned: {body: {uploadId: string; files: readonly {uploadUrl: string}[]}},
    frame: Uint8Array,
    contentType = "application/octet-stream",
  ): Promise<Response> {
    const fileUploadUrl = planned.body.files[0]?.uploadUrl;
    if (fileUploadUrl === undefined) {
      throw new Error("The upload plan declares no file upload URL.");
    }
    const batchUrl = new URL(`/api/v1/uploads/${planned.body.uploadId}/batch`, server.baseUrl);
    batchUrl.search = new URL(fileUploadUrl).search;
    return fetch(batchUrl, {
      body: copiedArrayBuffer(frame),
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": contentType,
      },
      method: "POST",
    });
  }

  async function readVersionFile(
    artifactId: string,
    versionId: string,
    filePath: string,
  ): Promise<Response> {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}/versions/${versionId}/file?path=${encodeURIComponent(filePath)}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(response.status).toBe(200);
    return response;
  }
});

async function errorCode(response: Response): Promise<string> {
  expect(response.status).toBeGreaterThanOrEqual(400);
  return z.object({error: z.object({code: z.string()}).loose()}).loose()
    .parse(await response.json()).error.code;
}

function copiedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function orderIndexOf(
  planned: {body: {files: readonly {path: string}[]}},
  filePath: string,
): number {
  const index = planned.body.files.findIndex((file) => file.path === filePath);
  if (index < 0) throw new Error(`The upload plan does not declare ${filePath}.`);
  return index;
}

function buildFrame(parts: readonly BatchPart[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + 12 + part.bytes.byteLength, 0);
  const frame = new Uint8Array(total);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.orderIndex, true);
    view.setFloat64(offset + 4, part.bytes.byteLength, true);
    frame.set(part.bytes, offset + 12);
    offset += 12 + part.bytes.byteLength;
  }
  return frame;
}
