import {describe, expect, it} from "vitest";

import {libraryItemId, libraryItems, parseLibraryItemId, type LibrarySource} from "./design-library.ts";

const item = (path: string, overrides: Partial<LibrarySource["items"][number]> = {}): LibrarySource["items"][number] => ({
  description: "",
  kind: "prototype",
  path,
  related: [],
  section: "Prototypes",
  thumbnailPath: null,
  title: path,
  viewport: {height: 900, width: 1280},
  ...overrides,
});
const sources: LibrarySource[] = [
  {artifactId: "art_a", artifactName: "workers-compensation", indexTitle: "Workers' Compensation", items: [
    item("project/App.dc.html", {thumbnailPath: "preview-thumbnails/app.webp"}),
  ], versionId: "ver_a2"},
  {artifactId: "art_b", artifactName: "Court of Claims", indexTitle: "Court of Claims", items: [
    item("project/App.dc.html", {related: [{path: "project/App.README.md", title: "App guide"}]}),
  ], versionId: "ver_b1"},
];

describe("design library", () => {
  it("DSN-005: keeps repeated paths distinct per artifact, labels each tile, and pins media to the loaded version", () => {
    const items = libraryItems(sources, (source, path) => `/media/${source.artifactId}/${source.versionId}/${path}`);
    expect(items.map((candidate) => [candidate.id, candidate.context, candidate.section, candidate.thumbnailUrl])).toEqual([
      [libraryItemId("art_a", "project/App.dc.html"), "workers-compensation", "Workers' Compensation · Prototypes", "/media/art_a/ver_a2/preview-thumbnails/app.webp"],
      [libraryItemId("art_b", "project/App.dc.html"), undefined, "Court of Claims · Prototypes", null],
    ]);
    expect(items[1]?.related).toEqual([{id: libraryItemId("art_b", "project/App.README.md"), path: "project/App.README.md", title: "App guide"}]);
  });

  it("DSN-005-F: round-trips item identities and rejects ones that do not name an artifact and a path", () => {
    const id = libraryItemId("art_a", "project/a:b.dc.html");
    expect(parseLibraryItemId(id)).toEqual({artifactId: "art_a", path: "project/a:b.dc.html"});
    for (const hostile of ["", "project/App.dc.html", "\u001fproject/App.dc.html", "art_a\u001f"]) {
      expect(parseLibraryItemId(hostile)).toBeNull();
    }
  });
});
