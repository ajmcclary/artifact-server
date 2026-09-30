import {describe, expect, it} from "vitest";

import {
  designCatalogPath,
  parsePreviewIndex,
  previewIndexEntry,
  previewIndexPath,
} from "./design-gallery.ts";

const entries = [
  {mediaType: "text/html; charset=utf-8", path: designCatalogPath, size: 10},
  {mediaType: "application/json; charset=utf-8", path: previewIndexPath, size: 10},
  {mediaType: "text/html; charset=utf-8", path: "project/App.dc.html", size: 10},
  {mediaType: "text/html; charset=utf-8", path: "templates/Doc.dc.html", size: 10},
  {mediaType: "image/png", path: "thumbs/app.png", size: 10},
  {mediaType: "text/css; charset=utf-8", path: "styles.css", size: 10},
];
interface ItemOverrides {
  readonly kind?: string;
  readonly path?: string;
  readonly section?: string;
  readonly thumbnail?: {readonly mediaType: string; readonly path: string} | null;
  readonly title?: string;
  readonly viewport?: {readonly height: number; readonly width: number};
}
interface IndexOverrides {
  readonly cover?: {readonly mediaType: string; readonly path: string} | null;
  readonly format?: string;
  readonly items?: readonly ReturnType<typeof item>[];
  readonly unexpected?: boolean;
  readonly version?: number;
}
const item = (overrides: ItemOverrides = {}) => ({
  kind: "prototype",
  section: "Prototypes",
  title: "App",
  description: "Examiner workspace",
  path: "project/App.dc.html",
  viewport: {width: 1440, height: 900},
  thumbnail: {path: "thumbs/app.png", mediaType: "image/png"},
  ...overrides,
});
const index = (overrides: IndexOverrides = {}) => JSON.stringify({
  format: "artifact-server.preview-index",
  version: 1,
  origin: "producer",
  title: "Claims",
  description: "",
  cover: null,
  items: [item(), item({kind: "template", section: "Templates", title: "Doc", path: "templates/Doc.dc.html", thumbnail: null})],
  ...overrides,
});

describe("design gallery preview index", () => {
  it("reads only a generated catalog entry's index, preserving explicit and root entries", () => {
    expect(previewIndexEntry({entryPath: designCatalogPath, entries})?.path).toBe(previewIndexPath);
    expect(previewIndexEntry({entryPath: "project/App.dc.html", entries})).toBeNull();
    expect(previewIndexEntry({entryPath: designCatalogPath, entries: entries.filter((entry) => entry.path !== previewIndexPath)})).toBeNull();
  });

  it("keeps declared kinds and resolves thumbnails to exact-version image entries", () => {
    const parsed = parsePreviewIndex(index(), entries);
    expect(parsed.status).toBe("ready");
    if (parsed.status !== "ready") return;
    expect(parsed.items.map((candidate) => [candidate.kind, candidate.path, candidate.thumbnailPath])).toEqual([
      ["prototype", "project/App.dc.html", "thumbs/app.png"],
      ["template", "templates/Doc.dc.html", null],
    ]);
  });

  it("DSN-004-F: malformed, unsupported, duplicate and escaping indexes fail closed; bad thumbnails become placeholders", () => {
    const invalid = (text: string) => expect(parsePreviewIndex(text, entries).status).toBe("invalid");
    invalid("{");
    invalid(index({version: 2}));
    expect(parsePreviewIndex(index({version: 2}), entries)).toMatchObject({reason: expect.stringMatching(/version 2/u)});
    invalid(index({format: "something-else"}));
    invalid(index({unexpected: true}));
    invalid(index({items: []}));
    invalid(index({items: [item({path: "../outside.html"})]}));
    invalid(index({items: [item({path: "project/Missing.dc.html"})]}));
    invalid(index({items: [item({path: "styles.css"})]}));
    invalid(index({items: [item(), item()]}));
    invalid(index({items: [item({kind: "screenshot"})]}));
    invalid(index({items: [item({title: "<b>‮evil"})]}));
    invalid(index({items: [item({viewport: {width: 0, height: 900}})]}));
    invalid(index({items: [item({thumbnail: {path: "thumbs/app.png", mediaType: "image/svg+xml"}})]}));
    const placeholders = parsePreviewIndex(index({
      cover: {path: "styles.css", mediaType: "image/png"},
      items: [
        item({thumbnail: {path: "thumbs/missing.png", mediaType: "image/png"}}),
        item({path: "templates/Doc.dc.html", thumbnail: {path: "thumbs/app.png", mediaType: "image/jpeg"}}),
      ],
    }), entries);
    expect(placeholders).toMatchObject({status: "ready", coverPath: null});
    expect(placeholders.status === "ready" && placeholders.items.map((candidate) => candidate.thumbnailPath)).toEqual([null, null]);
  });
});
