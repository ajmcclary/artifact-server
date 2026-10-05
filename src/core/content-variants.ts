import type {ManifestEntry} from "./model.js";

/** The only coding stored as a variant; clients without Brotli get identity bytes. */
export type ContentVariantCoding = "br";

/** Brotli quality 9 with a 4 MiB window; a settings change introduces a new id. */
export const brotliVariantEncoderId = "br-q9-w22-v1";

/** Sources larger than this are never compressed into variants. */
export const maximumVariantSourceBytes = 64 * 1_048_576;

/** A variant is kept only when it is at most this share of its source. */
export const maximumVariantSizeRatio = 0.9;

/** Smaller bodies gain too little to justify a coding. */
export const minimumCompressedBodyBytes = 1_024;

const compressibleMediaTypes: ReadonlySet<string> = new Set([
  "application/javascript",
  "application/json",
  "image/svg+xml",
  "text/css",
  "text/html",
  "text/javascript",
]);

export function isCompressibleMediaType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mediaType = contentType.split(";")[0]?.trim().toLocaleLowerCase("en-US");
  return mediaType !== undefined && compressibleMediaTypes.has(mediaType);
}

/** Whether one manifest entry may be served from a compressed variant. */
export function isVariantEligible(mediaType: string, size: number): boolean {
  return size >= minimumCompressedBodyBytes && isCompressibleMediaType(mediaType);
}

/** Identifies one compressed rendering of a stored blob. */
export interface ContentVariantKey {
  readonly coding: ContentVariantCoding;
  readonly encoderId: string;
  readonly sourceSha256: string;
}

/** A stored compressed rendering; the variant itself is an ordinary content-addressed blob. */
export interface ContentVariantMapping extends ContentVariantKey {
  readonly variantSha256: string;
  readonly variantSize: number;
}

/** Finds and records compressed renderings for one installation. */
export interface ContentVariantIndex {
  find(key: ContentVariantKey): Promise<ContentVariantMapping | null>;
  /** Idempotent: an identical mapping is accepted; a different one rejects with ContentVariantConflict. */
  record(mapping: ContentVariantMapping): Promise<void>;
}

/** Compresses a whole source into memory once. */
export interface ContentVariantCompressor {
  /** Resolves with the compressed bytes, or null once the output would exceed the limit. */
  compress(body: ReadableStream<Uint8Array>, outputLimitBytes: number): Promise<Uint8Array | null>;
}

/** Notified after a commit creates a version; must never throw into publication. */
export interface PublishedContentObserver {
  readonly versionPublished: (entries: readonly ManifestEntry[]) => void;
}

/** A different variant is already recorded for the same source, coding, and encoder. */
export class ContentVariantConflict extends Error {
  constructor(key: ContentVariantKey) {
    super(`A different ${key.coding} variant is already recorded for ${key.sourceSha256} (${key.encoderId}).`);
    this.name = "ContentVariantConflict";
  }
}
