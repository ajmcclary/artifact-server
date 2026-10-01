import {describe, expect, it} from "vitest";

import {
  galleryDates,
  historyWindow,
  libraryItemId,
  libraryItems,
  parseLibraryItemId,
  threadActivity,
  type HistoryVersion,
  type LibrarySource,
} from "./design-library.ts";

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
  {artifactId: "art_a", artifactName: "workers-compensation", dates: new Map([["project/App.dc.html", {activityAt: 300, createdAt: 100}]]),
    indexTitle: "Workers' Compensation", items: [
      item("project/App.dc.html", {thumbnailPath: "preview-thumbnails/app.webp"}),
    ], projectId: "prj_comp", projectName: "Compensation", versionId: "ver_a2"},
  {artifactId: "art_b", artifactName: "Court of Claims", dates: new Map(), indexTitle: "Court of Claims", items: [
    item("project/App.dc.html", {kind: "document", related: [{path: "project/App.README.md", title: "App guide"}]}),
  ], projectId: "prj_claims", projectName: "Claims", versionId: "ver_b1"},
];

const at = (minute: number) => Date.UTC(2026, 8, 1, 9, minute);
const version = (number: number, files: Record<string, string>): HistoryVersion => ({at: at(number), files: new Map(Object.entries(files)), number});

describe("design library items", () => {
  it("DSN-005: keeps repeated paths distinct per artifact, names project and gallery, and pins media to the loaded version", () => {
    const items = libraryItems(sources, (source, path) => `/media/${source.artifactId}/${source.versionId}/${path}`);
    expect(items.map((candidate) => [candidate.id, candidate.project, candidate.gallery, candidate.kind, candidate.thumbnailUrl])).toEqual([
      [libraryItemId("art_a", "project/App.dc.html"), "Compensation", "Workers' Compensation", "prototype", "/media/art_a/ver_a2/preview-thumbnails/app.webp"],
      [libraryItemId("art_b", "project/App.dc.html"), "Claims", "Court of Claims", "document", null],
    ]);
    expect([items[0]?.createdAt, items[0]?.activityAt]).toEqual([100, 300]);
    // A page its source could not date stays undated rather than borrowing a time.
    expect(Number.isNaN(items[1]?.createdAt)).toBe(true);
  });

  it("DSN-005-F: round-trips item identities and rejects ones that do not name an artifact and a path", () => {
    const id = libraryItemId("art_a", "project/a:b.dc.html");
    expect(parseLibraryItemId(id)).toEqual({artifactId: "art_a", path: "project/a:b.dc.html"});
    for (const hostile of ["", "project/App.dc.html", "\u001fproject/App.dc.html", "art_a\u001f"]) {
      expect(parseLibraryItemId(hostile)).toBeNull();
    }
  });
});

describe("design library dates", () => {
  it("DSN-005: a page is created by the first version whose manifest lists it", () => {
    const dates = galleryDates([
      version(1, {"a.html": "1"}),
      version(2, {"a.html": "1", "b.html": "1"}),
      version(3, {"a.html": "1", "b.html": "1"}),
    ], ["a.html", "b.html"], [], at(9));
    expect(dates.get("a.html")?.createdAt).toBe(at(1));
    expect(dates.get("b.html")?.createdAt).toBe(at(2));
  });

  it("DSN-005: last activity follows the last digest change and ignores versions that leave the page unchanged", () => {
    // Out-of-order input reads in version order.
    const dates = galleryDates([
      version(4, {"a.html": "2", "b.html": "1"}),
      version(1, {"a.html": "1", "b.html": "1"}),
      version(2, {"a.html": "2", "b.html": "1"}),
      version(3, {"a.html": "2", "b.html": "1"}),
    ], ["a.html", "b.html"], [], at(9));
    expect(dates.get("a.html")).toEqual({activityAt: at(2), createdAt: at(1)});
    expect(dates.get("b.html")).toEqual({activityAt: at(1), createdAt: at(1)});
  });

  it("DSN-005: a comment or reply newer than the last change becomes the page's last activity", () => {
    const history = [version(1, {"a.html": "1", "b.html": "1"}), version(2, {"a.html": "2", "b.html": "1"})];
    const dates = galleryDates(history, ["a.html", "b.html"], [
      {at: at(1) + 30_000, path: "a.html"}, // older than a.html's change
      {at: at(5), path: "b.html"},
      {at: at(7), path: null}, // a whole-version comment belongs to no page
      {at: Number.NaN, path: "b.html"},
    ], at(9));
    expect(dates.get("a.html")?.activityAt).toBe(at(2));
    expect(dates.get("b.html")).toEqual({activityAt: at(5), createdAt: at(1)});
  });

  it("DSN-005: a page removed and re-added keeps its first creation and counts the re-add as a change", () => {
    const dates = galleryDates([
      version(1, {"a.html": "1"}),
      version(2, {}),
      version(3, {"a.html": "1"}),
      version(4, {"a.html": "1"}),
    ], ["a.html"], [], at(9));
    expect(dates.get("a.html")).toEqual({activityAt: at(3), createdAt: at(1)});
  });

  it("DSN-005: a page no read version lists falls back to the current version's time", () => {
    expect(galleryDates([version(1, {})], ["a.html"], [{at: at(8), path: "a.html"}], at(9)).get("a.html"))
      .toEqual({activityAt: at(9), createdAt: at(9)});
    expect(galleryDates([], ["a.html"], [], at(9)).get("a.html")).toEqual({activityAt: at(9), createdAt: at(9)});
  });

  it("DSN-005: a bounded history keeps the first and newest versions and dates gap changes no earlier than they could be", () => {
    const versions = Array.from({length: 10}, (_, index) => index + 1);
    expect(historyWindow(versions, 4)).toEqual([1, 8, 9, 10]);
    expect(historyWindow(versions, 10)).toEqual(versions);
    expect(historyWindow([], 4)).toEqual([]);
    // b.html first appeared at version 3 and a.html last changed at version 5, both inside
    // the skipped gap, so each is attributed to the first kept version after it.
    const full = versions.map((number): HistoryVersion => {
      const files = new Map([["a.html", number >= 5 ? "2" : "1"]]);
      if (number >= 3) files.set("b.html", "1");
      return {at: at(number), files, number};
    });
    const dates = galleryDates(historyWindow(full, 4), ["a.html", "b.html"], [], at(10));
    expect(dates.get("a.html")).toEqual({activityAt: at(8), createdAt: at(1)});
    expect(dates.get("b.html")).toEqual({activityAt: at(8), createdAt: at(8)});
  });

  it("DSN-005: a thread counts its newest reply, and unread replies fall back to the thread's updatedAt", () => {
    const thread = {createdAt: new Date(at(1)).toISOString(), path: "a.html", replyCount: 2, updatedAt: new Date(at(6)).toISOString()};
    expect(threadActivity(thread, [new Date(at(3)).toISOString(), new Date(at(4)).toISOString()])).toEqual({at: at(4), path: "a.html"});
    expect(threadActivity(thread, null)).toEqual({at: at(6), path: "a.html"});
    // An edit or resolution moves updatedAt but is not a comment, so a thread without replies keeps its creation.
    expect(threadActivity({...thread, replyCount: 0}, null)).toEqual({at: at(1), path: "a.html"});
  });
});
