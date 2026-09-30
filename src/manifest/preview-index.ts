import {Schema} from "effect";

import {parseManifestPath} from "./create-manifest.js";

/**
 * Versioned gallery metadata published beside a design catalog. Review reads
 * it as untrusted data from the exact version; it never selects storage.
 */
export const previewIndexPath = "artifact-server-previews/index.json";
export const previewIndexFormat = "artifact-server.preview-index";
/** Reserved directory for the index and typed copies of supplied thumbnails. */
export const previewAssetDirectory = "artifact-server-previews/";
/** Optional producer declaration at the publication root. */
export const previewSourcePath = "artifactserver.previews.json";
export const previewSourceFormat = "artifact-server.preview-source";
export const previewFormatVersion = 1;

export const previewKinds = [
  "prototype",
  "template",
  "component",
  "guideline",
  "documentation",
  "artboard",
] as const;
export type PreviewKind = typeof previewKinds[number];

export const maximumPreviewItems = 2_000;
export const maximumThumbnailBytes = 2 * 1024 * 1024;
export const defaultPreviewViewport = {width: 1280, height: 900} as const;

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
  reportInput: false,
} as const;

// Labels are single-line display text; descriptions may wrap but carry no controls.
const label = (maximum: number) => Schema.String.check(
  Schema.isPattern(/^(?=.*\S)[^\p{Cc}\p{Cf}]+$/u),
  Schema.isMaxLength(maximum),
);
const description = Schema.String.check(
  Schema.isPattern(/^[^\p{Cc}\p{Cf}]*$/u),
  Schema.isMaxLength(1_000),
);
const dimension = Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 4_096}));
const viewportSchema = Schema.Struct({width: dimension, height: dimension});
const referenceSchema = Schema.String.check(Schema.isMaxLength(1_024));

const sourceHeaderSchema = Schema.Struct({
  format: Schema.Literal(previewSourceFormat),
  version: Schema.Int,
});
const sourceItemSchema = Schema.Struct({
  kind: Schema.Literals(previewKinds),
  section: label(120),
  title: label(200),
  description: Schema.optional(description),
  path: referenceSchema,
  viewport: Schema.optional(viewportSchema),
  thumbnail: Schema.optional(referenceSchema),
});
const sourceSchema = Schema.Struct({
  format: Schema.Literal(previewSourceFormat),
  version: Schema.Literal(previewFormatVersion),
  title: label(200),
  description: Schema.optional(description),
  cover: Schema.optional(referenceSchema),
  items: Schema.Array(sourceItemSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maximumPreviewItems),
  ),
});

export type PreviewSource = typeof sourceSchema.Type;
export type PreviewViewport = typeof viewportSchema.Type;

export interface PreviewImage {
  readonly path: string;
  readonly mediaType: "image/jpeg" | "image/png" | "image/webp";
}

export interface PreviewIndexItem {
  readonly kind: PreviewKind;
  readonly section: string;
  readonly title: string;
  readonly description: string;
  readonly path: string;
  readonly viewport: PreviewViewport;
  readonly thumbnail: PreviewImage | null;
}

export interface PreviewIndex {
  readonly format: typeof previewIndexFormat;
  readonly version: typeof previewFormatVersion;
  readonly origin: "producer" | "claude-design-manifest" | "design-cards" | "artboards";
  readonly title: string;
  readonly description: string;
  readonly cover: PreviewImage | null;
  readonly items: readonly PreviewIndexItem[];
}

/** A preview whose optional thumbnail is still an unresolved publication path. */
export interface PreviewDraftItem extends Omit<PreviewIndexItem, "thumbnail"> {
  readonly thumbnail?: string;
}

export interface PreviewDraft extends Omit<PreviewIndex, "cover" | "format" | "items" | "version"> {
  readonly cover?: string;
  readonly items: readonly PreviewDraftItem[];
}

/**
 * Decode a producer declaration and check every reference against the prepared
 * publication. Unknown versions, fields and duplicate previews fail closed.
 */
export function parsePreviewSource(text: string, paths: readonly string[]): PreviewDraft {
  const value: unknown = JSON.parse(text);
  const header = Schema.decodeUnknownSync(sourceHeaderSchema)(value);
  if (header.version !== previewFormatVersion) {
    throw new Error(`Unsupported preview source version ${header.version}; this CLI reads version ${previewFormatVersion}.`);
  }
  const source = Schema.decodeUnknownSync(sourceSchema)(value, strictParseOptions);
  const published = new Set(paths);
  const seen = new Set<string>();
  const items = source.items.map((item): PreviewDraftItem => {
    const itemPath = publishedHtmlPath(item.path, published);
    if (seen.has(itemPath)) throw new Error(`Preview source lists ${JSON.stringify(itemPath)} more than once.`);
    seen.add(itemPath);
    const draft = {
      kind: item.kind,
      section: item.section.trim(),
      title: item.title.trim(),
      description: item.description ?? "",
      path: itemPath,
      viewport: item.viewport ?? defaultPreviewViewport,
    };
    return item.thumbnail === undefined
      ? draft
      : {...draft, thumbnail: publishedPath(item.thumbnail, published)};
  });
  const draft: PreviewDraft = {
    origin: "producer",
    title: source.title.trim(),
    description: source.description ?? "",
    items,
  };
  return source.cover === undefined ? draft : {...draft, cover: publishedPath(source.cover, published)};
}

/** Resolve thumbnail references to image files and produce the canonical index. */
export function createPreviewIndex(
  draft: PreviewDraft,
  resolveImage: (reference: string) => PreviewImage,
): PreviewIndex {
  if (draft.items.length === 0 || draft.items.length > maximumPreviewItems) {
    throw new Error(`A preview index must contain between 1 and ${maximumPreviewItems} previews.`);
  }
  return {
    format: previewIndexFormat,
    version: previewFormatVersion,
    origin: draft.origin,
    title: draft.title,
    description: draft.description,
    cover: draft.cover === undefined ? null : resolveImage(draft.cover),
    items: draft.items.map((item) => ({
      kind: item.kind,
      section: item.section,
      title: item.title,
      description: item.description,
      path: item.path,
      viewport: {width: item.viewport.width, height: item.viewport.height},
      thumbnail: item.thumbnail === undefined ? null : resolveImage(item.thumbnail),
    })),
  };
}

/** Deterministic bytes: stable key order and one trailing newline. */
export function serializePreviewIndex(index: PreviewIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

/** Identify supported raster thumbnails by signature, never by file name. */
export function sniffPreviewImage(bytes: Uint8Array): PreviewImage["mediaType"] | undefined {
  const startsWith = (signature: readonly number[], offset = 0) =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return undefined;
}

export const previewImageExtensions = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
} as const satisfies Record<PreviewImage["mediaType"], string>;

/** Content-addressed location for a typed copy of an extensionless thumbnail. */
export function previewThumbnailCopyPath(sha256: string, mediaType: PreviewImage["mediaType"]): string {
  return `${previewAssetDirectory}thumbnails/${sha256}${previewImageExtensions[mediaType]}`;
}

/** True when a publication path would collide with generated preview assets. */
export function isReservedPreviewPath(candidate: string): boolean {
  return candidate.toLowerCase().startsWith(previewAssetDirectory);
}

function publishedPath(candidate: string, published: ReadonlySet<string>): string {
  // Validate before lookup: normalizing '..' would conceal an escaping reference.
  const relativePath = parseManifestPath(candidate);
  if (!published.has(relativePath)) {
    throw new Error(`Preview source references a file that is not published: ${JSON.stringify(relativePath)}.`);
  }
  if (isReservedPreviewPath(relativePath)) {
    throw new Error("Preview source cannot reference generated preview assets.");
  }
  return relativePath;
}

function publishedHtmlPath(candidate: string, published: ReadonlySet<string>): string {
  const relativePath = publishedPath(candidate, published);
  if (!/\.html?$/iu.test(relativePath)) {
    throw new Error(`Preview ${JSON.stringify(relativePath)} must be a published HTML file.`);
  }
  return relativePath;
}
