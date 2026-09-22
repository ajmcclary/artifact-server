import {mkdtemp, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  commitStagedUpload,
  createStagedUpload,
  type TestSiteFile,
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
  });

  test("PUB-016-F: malformed, duplicate, invalid, and size-mismatched parts never verify a version", async () => {
    expect.hasAssertions();
    const [indexFile, alphaFile] = fixtureFiles();
    const planned = await createStagedUpload(server, installation, "index.html", fixtureFiles());

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

    const malformed = await postBatch(planned, []);
    expect(batchResponseSchema.parse(await malformed.json()).accepted).toEqual([]);

    // Nothing was verified, so a commit cannot produce a version.
    const incomplete = await fetch(planned.body.commitUrl, {
      body: JSON.stringify({target: {
        accessSetting: "account_required",
        kind: "new_artifact",
        name: "incomplete",
      }}),
      headers: apiHeaders(installation, "pub-016-failure-incomplete"),
      method: "POST",
    });
    expect(incomplete.status).not.toBe(201);
    expect(incomplete.status).not.toBe(200);
  });

  test("PUB-017-B: a truncated batch resumes with only the missing parts and commits one version", async () => {
    expect.hasAssertions();
    const [indexFile, alphaFile, betaFile] = fixtureFiles();
    const planned = await createStagedUpload(server, installation, "index.html", fixtureFiles());

    // Frame part 0 complete, then a truncated tail so only part 0 verifies.
    const full = buildFrame([
      {bytes: indexFile.bytes, orderIndex: orderIndexOf(planned, indexFile.path)},
      {bytes: alphaFile.bytes, orderIndex: orderIndexOf(planned, alphaFile.path)},
    ]);
    const interrupted = await postBatchRaw(planned, full.slice(0, 12 + indexFile.bytes.byteLength + 4));
    const interruptedBody = batchResponseSchema.parse(await interrupted.json());
    expect(interruptedBody.accepted.map((part) => part.path)).toEqual(["index.html"]);

    // Resume sends only the parts that were not verified.
    const resume = await postBatch(planned, [
      {bytes: alphaFile.bytes, orderIndex: orderIndexOf(planned, alphaFile.path)},
      {bytes: betaFile.bytes, orderIndex: orderIndexOf(planned, betaFile.path)},
    ]);
    expect(batchResponseSchema.parse(await resume.json()).accepted.map((part) => part.path).toSorted())
      .toEqual(["a.txt", "b.txt"]);

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
        "Content-Type": "application/octet-stream",
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
