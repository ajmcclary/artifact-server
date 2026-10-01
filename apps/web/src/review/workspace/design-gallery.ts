import {z} from "zod";

import {mediaTypeEssence} from "./page-inventory.ts";

/** The generated catalog entry and the index a design publication carries beside it. */
export const designCatalogPath = "artifact-server-design.html";
export const previewIndexPath = "artifact-server-previews/index.json";
/** Generated indexes are small; anything larger is not one this Review reads. */
export const maximumPreviewIndexBytes = 1024 * 1024;

// The producer emits the first six; Review also reads the office kinds after artboard.
const previewKinds = [
  "prototype",
  "template",
  "component",
  "guideline",
  "documentation",
  "artboard",
  "document",
  "spreadsheet",
  "presentation",
] as const;
const imageTypes = ["image/jpeg", "image/png", "image/webp"] as const;
const label = (maximum: number) => z.string().max(maximum).regex(/^(?=.*\S)[^\p{Cc}\p{Cf}]+$/u);
const description = z.string().max(1_000).regex(/^[^\p{Cc}\p{Cf}]*$/u);
const dimension = z.number().int().min(1).max(4_096);
const imageSchema = z.object({path: z.string().min(1).max(1_024), mediaType: z.enum(imageTypes)}).strict();
const itemFields = {
  kind: z.enum(previewKinds),
  section: label(120),
  title: label(200),
  description,
  path: z.string().min(1).max(1_024),
  viewport: z.object({width: dimension, height: dimension}).strict(),
  thumbnail: imageSchema.nullable(),
};
const linkSchema = z.object({title: label(200), path: z.string().min(1).max(1_024)}).strict();
const indexFields = {
  format: z.literal("artifact-server.preview-index"),
  origin: z.enum(["producer", "claude-design-manifest", "design-cards", "artboards"]),
  title: label(200),
  description,
  cover: imageSchema.nullable(),
};
// Version 2 adds related links; version 1 indexes remain readable as published.
const indexSchema = z.discriminatedUnion("version", [
  z.object({...indexFields, version: z.literal(1), items: z.array(z.object(itemFields).strict()).min(1).max(2_000)}).strict(),
  z.object({
    ...indexFields,
    version: z.literal(2),
    items: z.array(z.object({...itemFields, related: z.array(linkSchema).max(24)}).strict()).min(1).max(2_000),
  }).strict(),
]);
const headerSchema = z.object({format: z.literal("artifact-server.preview-index"), version: z.number()});

export type GalleryKind = typeof previewKinds[number];


export interface GalleryIndexItem {
  readonly kind: GalleryKind;
  readonly section: string;
  readonly title: string;
  readonly description: string;
  readonly path: string;
  readonly viewport: {readonly width: number; readonly height: number};
  /** An exact-version image path, or null when the index names none or it is unusable. */
  readonly thumbnailPath: string | null;
  /** Related documents that exist in this exact version; unusable links are dropped. */
  readonly related: readonly {readonly title: string; readonly path: string}[];
}

export type PreviewIndexResult =
  | {
    readonly status: "ready";
    readonly title: string;
    readonly description: string;
    readonly coverPath: string | null;
    readonly items: readonly GalleryIndexItem[];
  }
  | {readonly status: "invalid"; readonly reason: string};

interface ManifestEntry {
  readonly mediaType: string;
  readonly path: string;
  readonly size: number;
}

/**
 * The index entry Review may read, or null. A gallery replaces only the generated
 * catalog entry: root index.html and explicit entries keep their own first page.
 */
export function previewIndexEntry(manifest: {
  readonly entryPath: string;
  readonly entries: readonly ManifestEntry[];
}): ManifestEntry | null {
  if (manifest.entryPath !== designCatalogPath) return null;
  return manifest.entries.find((entry) => entry.path === previewIndexPath) ?? null;
}

/**
 * Parse an exact version's index as untrusted data. Every preview must name an HTML
 * entry of that same manifest; thumbnails must name an image entry of the declared
 * type or they fall back to placeholders. Anything else rejects the whole index.
 */
export function parsePreviewIndex(
  text: string,
  entries: readonly ManifestEntry[],
): PreviewIndexResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {status: "invalid", reason: "The preview index is not valid JSON."};
  }
  const header = headerSchema.safeParse(value);
  if (header.success && header.data.version !== 1 && header.data.version !== 2) {
    return {status: "invalid", reason: `Preview index version ${header.data.version} is not supported by this Review.`};
  }
  const parsed = indexSchema.safeParse(value);
  if (!parsed.success) {
    return {status: "invalid", reason: `The preview index does not match format version ${header.success ? header.data.version : 2}.`};
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const image = (candidate: z.infer<typeof imageSchema> | null): string | null => {
    const entry = candidate === null ? undefined : byPath.get(candidate.path);
    return entry !== undefined && candidate !== null && mediaTypeEssence(entry.mediaType) === candidate.mediaType
      ? entry.path
      : null;
  };
  const seen = new Set<string>();
  const items: GalleryIndexItem[] = [];
  for (const item of parsed.data.items) {
    const entry = byPath.get(item.path);
    if (entry === undefined || mediaTypeEssence(entry.mediaType) !== "text/html") {
      return {status: "invalid", reason: "The preview index names a page that is not an HTML file of this version."};
    }
    if (seen.has(item.path)) return {status: "invalid", reason: "The preview index lists a page more than once."};
    seen.add(item.path);
    items.push({
      kind: item.kind,
      section: item.section,
      title: item.title,
      description: item.description,
      path: item.path,
      viewport: item.viewport,
      thumbnailPath: image(item.thumbnail),
      related: "related" in item ? usableLinks(item.related, byPath) : [],
    });
  }
  return {
    status: "ready",
    title: parsed.data.title,
    description: parsed.data.description,
    coverPath: image(parsed.data.cover),
    items,
  };
}

function usableLinks(
  links: readonly {readonly title: string; readonly path: string}[],
  byPath: ReadonlyMap<string, ManifestEntry>,
): {readonly title: string; readonly path: string}[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    if (!byPath.has(link.path) || seen.has(link.path)) return false;
    seen.add(link.path);
    return true;
  });
}

/** Host-owned gallery state, kept per exact version so a return restores it. */
export interface GalleryViewState {
  readonly focusPath: string | null;
  readonly kind: "all" | GalleryKind;
  readonly query: string;
  readonly scrollTop: number;
  readonly view: "grid" | "list";
}

export const initialGalleryViewState: GalleryViewState = {
  focusPath: null,
  kind: "all",
  query: "",
  scrollTop: 0,
  view: "grid",
};
