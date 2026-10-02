import {Schema} from "effect";

import {parseManifestPath} from "./create-manifest.js";
import type {DesignCard} from "./design-card.js";
import type {PreviewDraft, PreviewKind} from "./preview-index.js";

const cardSchema = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  group: Schema.optional(Schema.String),
  subtitle: Schema.optional(Schema.String),
  viewport: Schema.optional(Schema.String),
});
const templateSchema = Schema.Struct({
  entryPath: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
});
const designSystemSchema = Schema.Struct({
  namespace: Schema.NonEmptyString,
  cards: Schema.Array(cardSchema),
  templates: Schema.optional(Schema.Array(templateSchema)),
});

interface DesignPreview {
  readonly kind: PreviewKind;
  readonly path: string;
  readonly name: string;
  readonly group: string;
  readonly description: string;
  readonly width: number;
  readonly height: number;
}

/** Recognize the two observed export layouts without searching unrelated subtrees. */
export function claudeDesignManifestPath(paths: readonly string[]): string | undefined {
  return ["_ds_manifest.json", "project/_ds_manifest.json"]
    .find((candidate) => paths.includes(candidate));
}

/** Gallery draft for a Claude Design System manifest or bare artboards, using only published paths. */
export function claudeDesignPublication(
  paths: readonly string[],
  manifestPath: string | undefined,
  manifestText: string | undefined,
  title: string,
): PreviewDraft | undefined {
  if (manifestPath !== undefined && manifestText !== undefined) {
    const manifest = Schema.decodeUnknownSync(designSystemSchema)(JSON.parse(manifestText));
    const prefix = manifestPath.slice(0, -"_ds_manifest.json".length);
    const cards = manifest.cards.map((card): DesignPreview => ({
      kind: "component",
      path: previewPath(prefix, card.path, paths),
      name: card.name,
      group: card.group ?? "Components",
      description: card.subtitle ?? "",
      ...viewport(card.viewport),
    }));
    // The vendor manifest declares these as templates, so the kind is authoritative.
    const templates = (manifest.templates ?? []).map((template): DesignPreview => ({
      kind: "template",
      path: previewPath(prefix, template.entryPath, paths),
      name: template.name,
      group: "Templates",
      description: template.description ?? "",
      width: 1280,
      height: 900,
    }));
    return previewDraft("claude-design-manifest", manifest.namespace, [...cards, ...templates]);
  }
  const artboards = artboardPreviews(paths, "Artboards");
  if (artboards.length === 0) return undefined;
  return previewDraft("artboards", title, artboards);
}

function previewPath(prefix: string, candidate: string, paths: readonly string[]): string {
  // Validate before joining: normalizing '..' would conceal an escaping reference.
  const relativePath = parseManifestPath(candidate);
  const result = `${prefix}${relativePath}`;
  if (!/\.html?$/iu.test(result) || !paths.includes(result)) {
    throw new Error("Claude Design preview must reference a published HTML file.");
  }
  return result;
}

/** Gallery draft for annotated cards; unclassified artboards stay artboards. */
export function designCardPublication(
  paths: readonly string[],
  cards: readonly DesignCard[],
  title: string,
): PreviewDraft {
  const previews = cards.map((card): DesignPreview => ({
    kind: "component",
    path: previewPath("", card.path, paths),
    name: card.name,
    group: card.group ?? "Components",
    description: card.subtitle ?? "",
    ...viewport(card.viewport),
  }));
  // A .dc.html name does not establish whether a page is a reusable template.
  return previewDraft("design-cards", title, [...previews, ...artboardPreviews(paths, "Artboards")]);
}

function artboardPreviews(paths: readonly string[], group: string): DesignPreview[] {
  return paths.filter((candidate) => candidate.endsWith(".dc.html"))
    .map((candidate): DesignPreview => ({
      kind: "artboard",
      path: previewPath("", candidate, paths),
      name: candidate.split("/").at(-1)?.slice(0, -".dc.html".length) ?? candidate,
      group,
      description: "",
      width: 1280,
      height: 900,
    }));
}

function previewDraft(origin: PreviewDraft["origin"], title: string, previews: readonly DesignPreview[]): PreviewDraft {
  return {
    origin,
    title,
    description: "",
    items: previews.map((preview) => ({
      kind: preview.kind,
      section: preview.group,
      title: preview.name,
      description: preview.description,
      path: preview.path,
      viewport: {width: preview.width, height: preview.height},
      related: [],
    })),
  };
}

function viewport(value: string | undefined) {
  const match = /^(\d{1,4})x(\d{1,4})$/u.exec(value ?? "");
  return {
    width: Math.min(4096, Math.max(1, Number(match?.[1] ?? 1100))),
    height: Math.min(4096, Math.max(1, Number(match?.[2] ?? 700))),
  };
}
