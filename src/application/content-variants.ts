import {createHash} from "node:crypto";

import {
  brotliVariantEncoderId,
  type ContentVariantCompressor,
  type ContentVariantIndex,
  type ContentVariantMapping,
  isVariantEligible,
  maximumVariantSizeRatio,
  maximumVariantSourceBytes,
  type PublishedContentObserver,
} from "../core/content-variants.js";
import type {ManifestEntry} from "../core/model.js";
import type {BlobStore} from "../core/ports.js";

const maximumQueuedSources = 1_000;
const maximumCachedMappings = 10_000;
const missCacheMilliseconds = 30_000;
/** A forced rebuild that failed is not retried for this long, so a persistent fault cannot loop. */
const rebuildBackoffMilliseconds = 10 * 60_000;

export type ContentVariantBuildOutcome = "built" | "failed" | "not_beneficial" | "skipped" | "too_large";

export interface ContentVariantBuildEvent {
  readonly durationMilliseconds: number;
  readonly error: string | null;
  readonly outcome: ContentVariantBuildOutcome;
  readonly sourceSha256: string;
  readonly sourceSize: number;
  readonly variantSize: number | null;
}

export interface ContentVariantBackfillReport {
  readonly built: number;
  readonly examined: number;
  readonly failed: number;
  readonly not_beneficial: number;
  readonly skipped: number;
  readonly too_large: number;
}

/** The fields of a manifest entry a build needs. */
export interface ContentVariantSource {
  readonly mediaType: string;
  readonly sha256: string;
  readonly size: number;
}

/** What the HTTP delivery path needs from the variant service. */
export interface ContentVariantDelivery {
  find(sourceSha256: string): Promise<ContentVariantMapping | null>;
  /** Reports a failed index lookup, described for the log. */
  reportLookupFailure(message: string): void;
  reportUnusable(mapping: ContentVariantMapping): void;
  schedule(sourceSha256: string, sourceSize: number): void;
}

export interface ContentVariantDependencies {
  readonly blobs: Pick<BlobStore, "inspect" | "open" | "put">;
  readonly compressor: ContentVariantCompressor;
  readonly index: ContentVariantIndex;
  readonly log: (event: ContentVariantBuildEvent) => void;
  /** "manual" builds only on drain() or backfill(); tests use it for determinism. */
  readonly mode: "background" | "manual";
  /** Monotonic milliseconds for the miss cache; defaults to performance.now. */
  readonly monotonicNow?: () => number;
}

interface QueuedSource {
  readonly forceRebuild: boolean;
  readonly size: number;
  /** The mapping reported unusable, checked before any recompression. */
  readonly unusable: ContentVariantMapping | null;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Builds, finds, and backfills stored Brotli variants of eligible content. */
export class ContentVariants implements ContentVariantDelivery, PublishedContentObserver {
  readonly #dependencies: ContentVariantDependencies;
  readonly #mappings = new Map<string, ContentVariantMapping>();
  readonly #misses = new Map<string, number>();
  readonly #notBeneficial = new Set<string>();
  readonly #now: () => number;
  readonly #queue = new Map<string, QueuedSource>();
  readonly #rebuildBackoff = new Map<string, number>();
  #closed = false;
  #running: Promise<void> | null = null;

  constructor(dependencies: ContentVariantDependencies) {
    this.#dependencies = dependencies;
    this.#now = dependencies.monotonicNow ?? (() => performance.now());
  }

  readonly versionPublished = (entries: readonly ManifestEntry[]): void => {
    for (const entry of entries) {
      if (isVariantEligible(entry.mediaType, entry.size)) this.schedule(entry.sha256, entry.size);
    }
  };

  async find(sourceSha256: string): Promise<ContentVariantMapping | null> {
    const cached = this.#mappings.get(sourceSha256);
    if (cached !== undefined) return cached;
    const missUntil = this.#misses.get(sourceSha256);
    if (missUntil !== undefined && missUntil > this.#now()) return null;
    const found = await this.#dependencies.index.find({
      coding: "br",
      encoderId: brotliVariantEncoderId,
      sourceSha256,
    });
    if (found === null) {
      this.#misses.set(sourceSha256, this.#now() + missCacheMilliseconds);
      return null;
    }
    this.#remember(found);
    return found;
  }

  schedule(sourceSha256: string, sourceSize: number): void {
    this.#enqueue(sourceSha256, {forceRebuild: false, size: sourceSize, unusable: null});
  }

  reportUnusable(mapping: ContentVariantMapping): void {
    this.#mappings.delete(mapping.sourceSha256);
    this.#misses.set(mapping.sourceSha256, this.#now() + missCacheMilliseconds);
    const backoffUntil = this.#rebuildBackoff.get(mapping.sourceSha256);
    if (backoffUntil !== undefined && backoffUntil > this.#now()) return;
    this.#enqueue(mapping.sourceSha256, {forceRebuild: true, size: Number.NaN, unusable: mapping});
  }

  reportLookupFailure(message: string): void {
    this.#dependencies.log({
      durationMilliseconds: 0,
      error: message,
      outcome: "failed",
      sourceSha256: "",
      sourceSize: 0,
      variantSize: null,
    });
  }

  /** Runs every queued build to completion. */
  async drain(): Promise<void> {
    if (this.#running !== null) await this.#running;
    await this.#runQueue();
  }

  async build(source: ContentVariantSource): Promise<ContentVariantBuildOutcome> {
    return this.#build(source.sha256, source.size, null);
  }

  async backfill(
    sources: AsyncIterable<ContentVariantSource>,
    limit: number,
  ): Promise<ContentVariantBackfillReport> {
    const counts = {built: 0, examined: 0, failed: 0, not_beneficial: 0, skipped: 0, too_large: 0};
    const seen = new Set<string>();
    for await (const source of sources) {
      if (counts.examined >= limit) break;
      if (!isVariantEligible(source.mediaType, source.size) || seen.has(source.sha256)) continue;
      seen.add(source.sha256);
      counts.examined += 1;
      // eslint-disable-next-line no-await-in-loop -- the backfill builds one variant at a time
      const outcome = await this.#build(source.sha256, source.size, null);
      counts[outcome] += 1;
    }
    return counts;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#queue.clear();
    if (this.#running !== null) await this.#running;
  }

  #remember(mapping: ContentVariantMapping): void {
    this.#misses.delete(mapping.sourceSha256);
    this.#mappings.delete(mapping.sourceSha256);
    this.#mappings.set(mapping.sourceSha256, mapping);
    if (this.#mappings.size > maximumCachedMappings) {
      const oldest = this.#mappings.keys().next().value;
      if (oldest !== undefined) this.#mappings.delete(oldest);
    }
  }

  #enqueue(sourceSha256: string, queued: QueuedSource): void {
    if (this.#closed || this.#notBeneficial.has(sourceSha256)) return;
    const existing = this.#queue.get(sourceSha256);
    if (existing !== undefined && (existing.forceRebuild || !queued.forceRebuild)) return;
    this.#queue.delete(sourceSha256);
    this.#queue.set(sourceSha256, queued);
    if (this.#queue.size > maximumQueuedSources) {
      const oldest = this.#queue.keys().next().value;
      if (oldest !== undefined) this.#queue.delete(oldest);
    }
    if (this.#dependencies.mode === "background" && this.#running === null) {
      this.#running = this.#runQueue().finally(() => {
        this.#running = null;
      });
    }
  }

  async #runQueue(): Promise<void> {
    for (;;) {
      const next = this.#queue.entries().next().value;
      if (next === undefined || this.#closed) return;
      const [sourceSha256, queued] = next;
      this.#queue.delete(sourceSha256);
      // eslint-disable-next-line no-await-in-loop -- one build per process at a time
      const outcome = await this.#build(sourceSha256, queued.size, queued.unusable);
      if (queued.forceRebuild && outcome === "failed") {
        this.#rebuildBackoff.set(sourceSha256, this.#now() + rebuildBackoffMilliseconds);
      }
    }
  }

  async #build(
    sourceSha256: string,
    declaredSize: number,
    unusable: ContentVariantMapping | null,
  ): Promise<ContentVariantBuildOutcome> {
    const started = this.#now();
    const finish = (
      outcome: ContentVariantBuildOutcome,
      variantSize: number | null,
      error: string | null,
    ): ContentVariantBuildOutcome => {
      this.#dependencies.log({
        durationMilliseconds: this.#now() - started,
        error,
        outcome,
        sourceSha256,
        sourceSize: declaredSize,
        variantSize,
      });
      return outcome;
    };
    try {
      const key = {coding: "br", encoderId: brotliVariantEncoderId, sourceSha256} as const;
      if (unusable === null) {
        const existing = await this.#dependencies.index.find(key);
        if (existing !== null) {
          this.#remember(existing);
          return finish("skipped", existing.variantSize, null);
        }
      } else {
        // A transient read error also reports a variant unusable; recompress only if the blob is really bad.
        const stored = await this.#dependencies.blobs.inspect(unusable.variantSha256).catch(() => null);
        if (stored !== null && stored.size === unusable.variantSize) {
          this.#remember(unusable);
          return finish("skipped", stored.size, null);
        }
      }
      if (this.#notBeneficial.has(sourceSha256)) return finish("not_beneficial", null, null);
      if (declaredSize > maximumVariantSourceBytes) return finish("too_large", null, null);
      const source = await this.#dependencies.blobs.open(sourceSha256);
      if (source.size > maximumVariantSourceBytes) {
        await source.body.cancel();
        return finish("too_large", null, null);
      }
      const limit = Math.floor(source.size * maximumVariantSizeRatio);
      const compressed = await this.#dependencies.compressor.compress(source.body, limit);
      if (compressed === null) {
        this.#notBeneficial.add(sourceSha256);
        return finish("not_beneficial", null, null);
      }
      const variantSha256 = createHash("sha256").update(compressed).digest("hex");
      await this.#dependencies.blobs.put({
        body: streamOf(compressed),
        sha256: variantSha256,
        size: compressed.byteLength,
      });
      const mapping: ContentVariantMapping = {...key, variantSha256, variantSize: compressed.byteLength};
      await this.#dependencies.index.record(mapping);
      this.#remember(mapping);
      return finish("built", compressed.byteLength, null);
    } catch (error) {
      return finish("failed", null, error instanceof Error ? error.message : String(error));
    }
  }
}
