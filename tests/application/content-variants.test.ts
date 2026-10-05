import {createHash, randomBytes} from "node:crypto";
import {mkdtemp, rm, stat, unlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {brotliDecompressSync} from "node:zlib";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  ContentVariants,
  type ContentVariantBuildEvent,
} from "../../src/application/content-variants.js";
import {
  brotliVariantEncoderId,
  ContentVariantConflict,
  maximumVariantSourceBytes,
} from "../../src/core/content-variants.js";
import {SystemClock} from "../../src/core/system.js";
import {nodeBrotliVariantCompressor} from "../../src/http/node-variant-compressor.js";
import {LocalBlobStore} from "../../src/storage/local-blob-store.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteContentVariantIndex} from "../../src/storage/sqlite-content-variant-index.js";

interface StoredSource {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly sha256: string;
  readonly size: number;
}

const compressibleText = new TextEncoder().encode(
  Array.from({length: 20_000}, (_, index) => `window.rows.push({"id":"r${index}","field":"amount"});`).join("\n"),
);

describe("ContentVariants", () => {
  let directory: string;
  let blobRoot: string;
  let blobs: LocalBlobStore;
  let index: SqliteContentVariantIndex;
  let events: ContentVariantBuildEvent[];
  let clock: number;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "content-variants-"));
    blobRoot = path.join(directory, "blobs");
    const databasePath = path.join(directory, "artifact-server.db");
    new SqliteArtifactRepository(databasePath, "installation-a").close();
    blobs = new LocalBlobStore(blobRoot);
    index = new SqliteContentVariantIndex(databasePath, "installation-a", new SystemClock());
    events = [];
    clock = 0;
  });

  afterEach(async () => {
    index.close();
    await rm(directory, {force: true, recursive: true});
  });

  function variants(): ContentVariants {
    return new ContentVariants({
      blobs,
      compressor: nodeBrotliVariantCompressor,
      index,
      log: (event) => events.push(event),
      mode: "manual",
      monotonicNow: () => clock,
    });
  }

  async function store(bytes: Uint8Array, mediaType = "text/javascript"): Promise<StoredSource> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await blobs.put({
      body: new ReadableStream({start: (controller) => {
        controller.enqueue(bytes);
        controller.close();
      }}),
      sha256,
      size: bytes.byteLength,
    });
    return {bytes, mediaType, sha256, size: bytes.byteLength};
  }

  async function readBlob(sha256: string): Promise<Uint8Array> {
    const opened = await blobs.open(sha256);
    return new Uint8Array(await new Response(opened.body).arrayBuffer());
  }

  test("foundation: a scheduled source becomes a stored Brotli blob after a drain", async () => {
    const service = variants();
    const source = await store(compressibleText);
    expect(await service.find(source.sha256)).toBeNull();
    service.schedule(source.sha256, source.size);
    await service.drain();
    clock += 30_001;
    const mapping = await service.find(source.sha256);
    expect(mapping?.encoderId).toBe(brotliVariantEncoderId);
    const variant = await readBlob(mapping?.variantSha256 ?? "");
    expect(variant.byteLength).toBe(mapping?.variantSize);
    expect(new Uint8Array(brotliDecompressSync(variant))).toEqual(compressibleText);
    expect(events.map((event) => event.outcome)).toEqual(["built"]);
  });

  test("foundation: a miss stays cached for 30 seconds unless this process built the variant", async () => {
    const service = variants();
    const source = await store(compressibleText);
    expect(await service.find(source.sha256)).toBeNull();
    // Another process records the mapping; this process still trusts its recent miss.
    const builder = variants();
    expect(await builder.build(source)).toBe("built");
    expect(await service.find(source.sha256)).toBeNull();
    clock += 30_001;
    expect(await service.find(source.sha256)).not.toBeNull();
  });

  test("foundation: an unusable variant is rebuilt even though its mapping exists", async () => {
    const service = variants();
    const source = await store(compressibleText);
    expect(await service.build(source)).toBe("built");
    const mapping = await service.find(source.sha256);
    if (mapping === null) throw new Error("The variant was not recorded.");
    const variantPath = path.join(blobRoot, mapping.variantSha256.slice(0, 2), mapping.variantSha256);
    await unlink(variantPath);
    service.reportUnusable(mapping);
    await service.drain();
    expect((await stat(variantPath)).size).toBe(mapping.variantSize);
  });

  test("foundation: a variant reported unusable while its blob is intact is not recompressed", async () => {
    const service = variants();
    const source = await store(compressibleText);
    expect(await service.build(source)).toBe("built");
    const mapping = await service.find(source.sha256);
    if (mapping === null) throw new Error("The variant was not recorded.");
    // A transient storage error on a hit reports the variant unusable although the blob is fine.
    service.reportUnusable(mapping);
    await service.drain();
    expect(events.map((event) => event.outcome)).toEqual(["built", "skipped"]);
    expect(await service.find(source.sha256)).toEqual(mapping);
  });

  test("foundation: a rebuild that cannot succeed backs off instead of repeating on every report", async () => {
    const service = variants();
    const source = await store(compressibleText);
    expect(await service.build(source)).toBe("built");
    const mapping = await service.find(source.sha256);
    if (mapping === null) throw new Error("The variant was not recorded.");
    // A wrong-size blob cannot be replaced by a create-only put, so the rebuild fails.
    const variantPath = path.join(blobRoot, mapping.variantSha256.slice(0, 2), mapping.variantSha256);
    await writeFile(variantPath, "truncated");
    service.reportUnusable(mapping);
    await service.drain();
    expect(events.map((event) => event.outcome)).toEqual(["built", "failed"]);
    clock += 30_001;
    service.reportUnusable(mapping);
    await service.drain();
    expect(events.map((event) => event.outcome)).toEqual(["built", "failed"]);
    clock += 10 * 60_000;
    service.reportUnusable(mapping);
    await service.drain();
    expect(events.map((event) => event.outcome)).toEqual(["built", "failed", "failed"]);
  });

  test("foundation: the backfill builds each digest once and counts every outcome", async () => {
    const service = variants();
    const compressible = await store(compressibleText);
    const incompressible = await store(new Uint8Array(randomBytes(64 * 1_024)));
    const small = await store(new TextEncoder().encode("tiny"));
    async function* sources() {
      yield compressible;
      yield compressible;
      yield incompressible;
      yield small;
      yield {mediaType: "text/javascript", sha256: "f".repeat(64), size: maximumVariantSourceBytes + 1};
      yield {mediaType: "image/png", sha256: "e".repeat(64), size: 4_096};
    }
    expect(await service.backfill(sources(), 100)).toEqual({
      built: 1,
      examined: 3,
      failed: 0,
      not_beneficial: 1,
      skipped: 0,
      too_large: 1,
    });
    const second = await service.backfill(sources(), 100);
    expect(second.built).toBe(0);
    expect(second.skipped).toBe(1);
  });

  test("CNT-011-F: incompressible and oversized sources store nothing, conflicts are rejected, and a 60 MiB build stays within memory", async () => {
    const service = variants();
    const incompressible = await store(new Uint8Array(randomBytes(256 * 1_024)));
    expect(await service.build(incompressible)).toBe("not_beneficial");
    clock += 30_001;
    expect(await service.find(incompressible.sha256)).toBeNull();

    expect(await service.build({mediaType: "text/javascript", sha256: "f".repeat(64), size: maximumVariantSourceBytes + 1}))
      .toBe("too_large");

    const compressible = await store(compressibleText);
    expect(await service.build(compressible)).toBe("built");
    clock += 30_001;
    const mapping = await service.find(compressible.sha256);
    if (mapping === null) throw new Error("The variant was not recorded.");
    await expect(index.record({...mapping, variantSha256: "c".repeat(64)})).rejects.toBeInstanceOf(ContentVariantConflict);

    const large = await store(new TextEncoder().encode(
      `const payload = "${randomBytes(45 * 1_048_576).toString("base64")}";\n`,
    ));
    const residentBaseline = process.memoryUsage().rss;
    let residentPeak = residentBaseline;
    const sampler = setInterval(() => {
      residentPeak = Math.max(residentPeak, process.memoryUsage().rss);
    }, 25);
    try {
      expect(await service.build(large)).toBe("built");
    } finally {
      clearInterval(sampler);
    }
    expect(residentPeak - residentBaseline).toBeLessThan(256 * 1_048_576);
  }, 180_000);
});
