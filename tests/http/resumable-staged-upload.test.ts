import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

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
  testSiteFile,
  uploadEveryStagedFile,
  uploadStagedFile,
} from "../support/publishing.js";
import type {Clock} from "../../src/core/ports.js";

const errorSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).loose(),
}).loose();

const committedUploadSchema = z.object({
  artifact: z.object({id: z.string()}).loose(),
  links: z.object({
    artifact: z.url(),
    review: z.url(),
    version: z.url(),
  }).strict(),
  replayed: z.boolean(),
  status: z.literal("committed"),
  version: z.object({id: z.string(), number: z.number().int().positive()}).loose(),
}).loose();

class MutableTestClock implements Clock {
  #now: Date;

  constructor(start: Date) {
    this.#now = new Date(start);
  }

  now(): Date {
    return new Date(this.#now);
  }

  set(value: Date): void {
    this.#now = new Date(value);
  }

  advance(milliseconds: number): void {
    this.#now = new Date(this.#now.getTime() + milliseconds);
  }
}

describe("resumable staged uploads over HTTP", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;
  let clock: MutableTestClock;

  beforeEach(async () => {
    installation = await createTestInstallation();
    clock = new MutableTestClock(new Date("2026-09-21T00:00:00.000Z"));
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    server = null;
    await removeTestInstallation(installation);
  });

  test("a fresh key-bound upload returns created", async () => {
    server = await startTestServer(installation, {clock});
    const file = testSiteFile("fresh key-bound upload");
    const created = await createStagedUpload(
      server,
      installation,
      file.path,
      [file],
      undefined,
      "static",
      "fresh-key-bound-upload-0001",
    );
    expect(created.response.status).toBe(201);
    expect(created.body.status).toBe("created");
    expect(created.body.files[0]?.verified).toBe(false);
    expect(created.body.manifestDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("repeating a key before commit returns the same resumed plan", async () => {
    server = await startTestServer(installation, {clock});
    const file = testSiteFile("resumed upload");
    const key = "resumed-upload-key-0000000001";
    const first = await createStagedUpload(
      server,
      installation,
      file.path,
      [file],
      undefined,
      "static",
      key,
    );
    expect(first.body.status).toBe("created");

    const second = await createStagedUpload(
      server,
      installation,
      file.path,
      [file],
      undefined,
      "static",
      key,
    );
    expect(second.response.status).toBe(201);
    expect(second.body.status).toBe("resumed");
    expect(second.body.uploadId).toBe(first.body.uploadId);
    expect(second.body.files[0]?.verified).toBe(false);
  });

  test("repeating a key after commit returns the committed publication", async () => {
    server = await startTestServer(installation, {clock});
    const file = testSiteFile("committed replay upload");
    const key = "committed-replay-key-000000001";
    const upload = await createStagedUpload(
      server,
      installation,
      file.path,
      [file],
      undefined,
      "static",
      key,
    );
    await uploadEveryStagedFile(installation, upload.body, [file]);
    const committed = await commitStagedUpload(
      installation,
      upload.body,
      key,
      {
        accessSetting: "account_required",
        kind: "new_artifact",
        name: "Committed replay artifact",
      },
    );
    expect(committed.response.status).toBe(201);

    const replay = await fetch(`${server.baseUrl}/api/v1/uploads`, {
      body: JSON.stringify({
        entryPath: file.path,
        files: [{
          mediaType: file.mediaType,
          path: file.path,
          sha256: file.sha256,
          size: file.size,
        }],
        routingMode: "static",
      }),
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      method: "POST",
    });
    expect(replay.status).toBe(200);
    const body = committedUploadSchema.parse(await replay.json());
    expect(body.status).toBe("committed");
    expect(body.replayed).toBe(true);
    expect(body.version.id).toBe(committed.body.version.id);
  });

  test("PUB-015-B: an interrupted publication resumes without re-verifying staged files", async () => {
    server = await startTestServer(installation, {clock});
    const entry = testSiteFile("resume entry", "text/html; charset=utf-8", "index.html");
    const asset = testSiteFile("resume asset bytes", "text/plain", "asset.txt");
    const key = "resume-interrupted-key-0001";
    const first = await createStagedUpload(
      server,
      installation,
      "index.html",
      [entry, asset],
      undefined,
      "static",
      key,
    );
    expect(first.body.status).toBe("created");

    // The client stages one file and crashes before the other.
    const assetPlan = first.body.files.find((file) => file.path === "asset.txt");
    if (assetPlan === undefined) throw new Error("The plan lost asset.txt.");
    const staged = await uploadStagedFile(installation, assetPlan, asset.bytes);
    expect(staged.status).toBe(200);

    const resumed = await createStagedUpload(
      server,
      installation,
      "index.html",
      [entry, asset],
      undefined,
      "static",
      key,
    );
    expect(resumed.response.status).toBe(201);
    expect(resumed.body.status).toBe("resumed");
    expect(resumed.body.uploadId).toBe(first.body.uploadId);
    const verifiedByPath = new Map(
      resumed.body.files.map((file) => [file.path, file.verified]),
    );
    expect(verifiedByPath.get("asset.txt")).toBe(true);
    expect(verifiedByPath.get("index.html")).toBe(false);

    // Only the pending file is sent before the commit.
    const entryPlan = resumed.body.files.find((file) => file.path === "index.html");
    if (entryPlan === undefined) throw new Error("The resumed plan lost index.html.");
    const stagedEntry = await uploadStagedFile(installation, entryPlan, entry.bytes);
    expect(stagedEntry.status).toBe(200);
    const committed = await commitStagedUpload(
      installation,
      resumed.body,
      key,
      {
        accessSetting: "account_required",
        kind: "new_artifact",
        name: "Resumed interrupted artifact",
      },
    );
    expect(committed.response.status).toBe(201);
    expect(committed.body.version.number).toBe(1);
  });

  test("PUB-015-F: reusing an operation key with changed input conflicts without a new upload", async () => {
    server = await startTestServer(installation, {clock});
    const firstFile = testSiteFile("first manifest");
    const secondFile = testSiteFile("different manifest");
    const key = "digest-mismatch-key-00000001";
    const first = await createStagedUpload(
      server,
      installation,
      firstFile.path,
      [firstFile],
      undefined,
      "static",
      key,
    );
    expect(first.response.status).toBe(201);

    const second = await fetch(`${server.baseUrl}/api/v1/uploads`, {
      body: JSON.stringify({
        entryPath: secondFile.path,
        files: [{
          mediaType: secondFile.mediaType,
          path: secondFile.path,
          sha256: secondFile.sha256,
          size: secondFile.size,
        }],
        routingMode: "static",
      }),
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      method: "POST",
    });
    expect(second.status).toBe(409);
    const body = errorSchema.parse(await second.json());
    expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");

    // The conflict created nothing: the original manifest still resumes the
    // original upload.
    const third = await createStagedUpload(
      server,
      installation,
      firstFile.path,
      [firstFile],
      undefined,
      "static",
      key,
    );
    expect(third.body.status).toBe("resumed");
    expect(third.body.uploadId).toBe(first.body.uploadId);
  });

  test("reusing a key after expiry recreates a fresh upload", async () => {
    server = await startTestServer(installation, {clock});
    const file = testSiteFile("expired recreate upload");
    const key = "expired-recreate-key-0000001";
    const first = await createStagedUpload(
      server,
      installation,
      file.path,
      [file],
      undefined,
      "static",
      key,
    );
    expect(first.response.status).toBe(201);

    clock.advance(2 * 60 * 60 * 1_000);
    const second = await createStagedUpload(
      server,
      installation,
      file.path,
      [file],
      undefined,
      "static",
      key,
    );
    expect(second.response.status).toBe(201);
    expect(second.body.status).toBe("created");
    expect(second.body.uploadId).not.toBe(first.body.uploadId);
  });

  test("an invalid idempotency key is rejected", async () => {
    server = await startTestServer(installation, {clock});
    const file = testSiteFile("invalid key upload");
    const response = await fetch(`${server.baseUrl}/api/v1/uploads`, {
      body: JSON.stringify({
        entryPath: file.path,
        files: [{
          mediaType: file.mediaType,
          path: file.path,
          sha256: file.sha256,
          size: file.size,
        }],
        routingMode: "static",
      }),
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "short",
      },
      method: "POST",
    });
    expect(response.status).toBe(422);
    const body = errorSchema.parse(await response.json());
    expect(body.error.code).toBe("INVALID_INPUT");
  });
});
