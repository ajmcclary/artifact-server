import {createHash, randomUUID} from "node:crypto";
import {mkdtemp, readdir, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  apiHeaders,
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  commitStagedUpload,
  createStagedUpload,
  testSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {LocalBlobStore} from "../../src/storage/local-blob-store.js";
import {LocalPromotingBlobStore} from
  "../../src/storage/local-promoting-blob-store.js";
import {LocalStagingStore} from "../../src/storage/local-staging-store.js";

const artifactListSchema = z.object({artifacts: z.array(z.unknown())});

describe("sealed source promotion over the real publication boundary", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("PUB-018-B: a sealed staged file promotes to one shared immutable blob and serves exact bytes", async () => {
    const file = testSiteFile(
      "<!doctype html><title>Sealed promotion</title><h1>Promoted</h1>",
    );
    const firstUpload = await createStagedUpload(
      server,
      installation,
      file.path,
      [file],
    );
    await requireOk(
      await uploadEveryStagedFile(installation, firstUpload.body, [file]),
    );
    const secondUpload = await createStagedUpload(
      server,
      installation,
      file.path,
      [file],
    );
    await requireOk(
      await uploadEveryStagedFile(installation, secondUpload.body, [file]),
    );

    const [first, second] = await Promise.all([
      commitStagedUpload(
        installation,
        firstUpload.body,
        "sealed-promotion-first",
        {
          accessSetting: "public_link",
          kind: "new_artifact",
          name: "Sealed promotion one",
        },
      ),
      commitStagedUpload(
        installation,
        secondUpload.body,
        "sealed-promotion-second",
        {
          accessSetting: "public_link",
          kind: "new_artifact",
          name: "Sealed promotion two",
        },
      ),
    ]);
    expect(first.response.status).toBe(201);
    expect(second.response.status).toBe(201);

    const digest = createHash("sha256").update(file.bytes).digest("hex");
    const blobPath = path.join(
      installation.dataDirectory,
      "blobs",
      digest.slice(0, 2),
      digest,
    );
    const firstSlot = await singleStagedSlot(
      installation.dataDirectory,
      firstUpload.body.uploadId,
    );
    const secondSlot = await singleStagedSlot(
      installation.dataDirectory,
      secondUpload.body.uploadId,
    );

    // Both commits converged on one blob, installed by hard link from the
    // winning sealed staged inode: exactly one retained staged slot shares
    // it, and the loser's promote verified and reused the existing blob.
    const blobStat = await stat(blobPath);
    const slotStats = [await stat(firstSlot), await stat(secondSlot)];
    const linkedSlots = slotStats.filter((slotStat) =>
      slotStat.ino === blobStat.ino && slotStat.dev === blobStat.dev
    );
    expect(linkedSlots).toHaveLength(1);
    expect(blobStat.nlink).toBe(2);
    expect(await countFiles(path.join(installation.dataDirectory, "blobs")))
      .toBe(1);

    const expected = new TextDecoder().decode(file.bytes);
    const firstBody = await fetchVersion(server, first.body.links.version);
    expect(await firstBody.text()).toBe(expected);
    const secondBody = await fetchVersion(server, second.body.links.version);
    expect(await secondBody.text()).toBe(expected);
  });

  test("PUB-018-F: a staged source replaced after verification fails closed without a version or blob", async () => {
    const file = testSiteFile(
      "<!doctype html><title>Sealed promotion hostile</title>",
    );
    const upload = await createStagedUpload(
      server,
      installation,
      file.path,
      [file],
    );
    await requireOk(
      await uploadEveryStagedFile(installation, upload.body, [file]),
    );

    const slot = await singleStagedSlot(
      installation.dataDirectory,
      upload.body.uploadId,
    );
    await writeFile(slot, mutatedCopy(file.bytes));

    const response = await fetch(upload.body.commitUrl, {
      body: JSON.stringify({target: {
        accessSetting: "public_link",
        kind: "new_artifact",
        name: "Replaced staged source",
      }}),
      headers: apiHeaders(installation, "sealed-promotion-replaced-source"),
      method: "POST",
    });
    await response.arrayBuffer();
    expect(response.status).not.toBe(201);

    const digest = createHash("sha256").update(file.bytes).digest("hex");
    await expect(stat(path.join(
      installation.dataDirectory,
      "blobs",
      digest.slice(0, 2),
      digest,
    ))).rejects.toThrow("ENOENT");
    const listed = await fetch(`${server.baseUrl}/api/v1/artifacts`, {
      headers: {Authorization: `Bearer ${installation.apiToken}`},
    });
    expect(artifactListSchema.parse(await listed.json()).artifacts)
      .toHaveLength(0);
  });
});

describe("local sealed promotion store", () => {
  let directory: string;
  let blobs: LocalPromotingBlobStore;
  let staging: LocalStagingStore;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "artifact-promotion-test-"));
    const localBlobs = new LocalBlobStore(path.join(directory, "blobs"));
    staging = new LocalStagingStore(path.join(directory, "staging"));
    blobs = new LocalPromotingBlobStore(localBlobs, staging);
  });

  afterEach(async () => {
    await rm(directory, {force: true, recursive: true});
  });

  test("promotes a sealed staged file by link, retains the slot, and races safely", async () => {
    const bytes = new TextEncoder().encode("promote me without copying");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const source = await stage(bytes, digest);

    const [first, second] = await Promise.all([
      blobs.promote(source),
      blobs.promote(source),
    ]);
    expect(first).toEqual({sha256: digest, size: bytes.byteLength});
    expect(second).toEqual(first);

    const blobPath = path.join(directory, "blobs", digest.slice(0, 2), digest);
    const slotPath = staging.stagedFilePath(source.uploadId, source.storageToken);
    const blobStat = await stat(blobPath);
    const slotStat = await stat(slotPath);
    expect(slotStat.ino).toBe(blobStat.ino);
    expect(blobStat.nlink).toBe(2);

    const stored = await blobs.open(digest);
    await expect(new Response(stored.body).text())
      .resolves.toBe("promote me without copying");
    expect(await countFiles(path.join(directory, "blobs"))).toBe(1);
  });

  test("rejects a size- or digest-mismatched or missing source without installing a blob", async () => {
    const bytes = new TextEncoder().encode("sealed bytes that will be replaced");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const source = await stage(bytes, digest);

    await expect(blobs.promote({...source, size: source.size + 1}))
      .rejects.toThrow("unexpected size");
    await expect(blobs.promote({...source, uploadId: `upl_${randomUUID()}`}))
      .rejects.toThrow("ENOENT");

    await writeFile(
      staging.stagedFilePath(source.uploadId, source.storageToken),
      mutatedCopy(bytes),
    );
    await expect(blobs.promote(source)).rejects.toThrow("fingerprint");

    expect(await countFiles(path.join(directory, "blobs"))).toBe(0);
  });

  async function stage(
    bytes: Uint8Array,
    digest: string,
  ): Promise<{
    sha256: string;
    size: number;
    storageToken: string;
    uploadId: string;
  }> {
    const source = {
      sha256: digest,
      size: bytes.byteLength,
      storageToken: "a".repeat(36),
      uploadId: `upl_${randomUUID()}`,
    };
    await staging.put({
      body: new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      sha256: source.sha256,
      size: source.size,
      storageToken: source.storageToken,
      uploadId: source.uploadId,
    });
    return source;
  }
});

function mutatedCopy(bytes: Uint8Array): Uint8Array {
  const mutated = bytes.slice();
  const last = mutated.byteLength - 1;
  mutated[last] = ((mutated[last] ?? 0) + 1) % 256;
  return mutated;
}

async function singleStagedSlot(
  dataDirectory: string,
  uploadId: string,
): Promise<string> {
  const directory = path.join(dataDirectory, "staging", uploadId);
  const entries = await readdir(directory);
  const slots = entries.filter((entry) => !entry.startsWith("."));
  const slot = slots[0];
  if (slots.length !== 1 || slot === undefined) {
    throw new Error(`Expected one staged slot, found ${slots.length}.`);
  }
  return path.join(directory, slot);
}

async function countFiles(directory: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(directory, {withFileTypes: true});
  } catch (error) {
    const parsed = z.object({code: z.string().optional()}).safeParse(error);
    if (parsed.success && parsed.data.code === "ENOENT") return 0;
    throw error;
  }
  const counts = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory()) {
      return countFiles(path.join(directory, entry.name));
    }
    return entry.isFile() ? 1 : 0;
  }));
  return counts.reduce((total, count) => total + count, 0);
}

async function requireOk(responses: readonly Response[]): Promise<void> {
  const failure = responses.find((response) => !response.ok);
  if (failure !== undefined) {
    throw new Error(`A staged test upload failed with HTTP ${failure.status}.`);
  }
}
