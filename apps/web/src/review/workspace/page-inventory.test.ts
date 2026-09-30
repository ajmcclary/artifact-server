import {describe, expect, it} from "vitest";

import {htmlPages, mediaTypeEssence} from "./page-inventory.ts";

describe("review page inventory", () => {
  it("lists only HTML entries, grouped by folder, with the entry page marked default", () => {
    expect(htmlPages("index.html", [
      {mediaType: "text/html; charset=utf-8", path: "index.html"},
      {mediaType: "text/css", path: "styles/site.css"},
      {mediaType: "TEXT/HTML", path: "docs/guide.html"},
      {mediaType: "image/png", path: "media/preview.png"},
    ])).toEqual([
      {group: "Top level", isDefault: true, name: "index.html", path: "index.html"},
      {group: "docs", isDefault: false, name: "guide.html", path: "docs/guide.html"},
    ]);
  });

  it("reads a media type's essence without parameters or case", () => {
    expect(mediaTypeEssence(" Text/HTML ; charset=utf-8")).toBe("text/html");
    expect(mediaTypeEssence("")).toBe("");
  });
});
