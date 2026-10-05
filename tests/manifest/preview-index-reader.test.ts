import {describe, expect, test} from "vitest";

import {parsePreviewIndex} from "../../apps/web/src/review/workspace/preview-index.ts";
import type {ManifestEntry} from "../../src/core/model.js";
import {readPreviewIndex} from "../../src/manifest/preview-index-reader.js";

function entry(path: string, mediaType: string): ManifestEntry {
  return {disposition: "inline", mediaType, path, sha256: "a".repeat(64), size: 10};
}

const entries: readonly ManifestEntry[] = [
  entry("project/App.html", "text/html; charset=utf-8"),
  entry("project/Other.html", "text/html"),
  entry("project/thumb.png", "image/png"),
  entry("project/guide.md", "text/markdown"),
  entry("artifact-server-previews/index.json", "application/json"),
];

const item = {
  description: "",
  kind: "prototype",
  path: "project/App.html",
  section: "Prototypes",
  thumbnail: {mediaType: "image/png", path: "project/thumb.png"},
  title: "App",
  viewport: {height: 900, width: 1440},
};

const cases: readonly {readonly name: string; readonly text: string}[] = [
  {name: "valid version 2", text: JSON.stringify({cover: null, description: "", format: "artifact-server.preview-index", items: [{...item, related: [{path: "project/guide.md", title: "Guide"}, {path: "missing.md", title: "Gone"}]}], origin: "producer", title: "Gallery", version: 2})},
  {name: "valid version 1", text: JSON.stringify({cover: null, description: "", format: "artifact-server.preview-index", items: [item], origin: "producer", title: "Gallery", version: 1})},
  {name: "wrong thumbnail type", text: JSON.stringify({cover: null, description: "", format: "artifact-server.preview-index", items: [{...item, related: [], thumbnail: {mediaType: "image/webp", path: "project/thumb.png"}}], origin: "producer", title: "Gallery", version: 2})},
  {name: "non-HTML page", text: JSON.stringify({cover: null, description: "", format: "artifact-server.preview-index", items: [{...item, path: "project/guide.md", related: []}], origin: "producer", title: "Gallery", version: 2})},
  {name: "duplicate page", text: JSON.stringify({cover: null, description: "", format: "artifact-server.preview-index", items: [{...item, related: []}, {...item, related: []}], origin: "producer", title: "Gallery", version: 2})},
  {name: "unsupported version", text: JSON.stringify({format: "artifact-server.preview-index", version: 3})},
  {name: "not JSON", text: "{nope"},
];

describe("server preview-index reader", () => {
  test.each(cases)("foundation: matches the client parser for $name", ({text}) => {
    const client = parsePreviewIndex(text, entries);
    const server = readPreviewIndex(text, entries);
    expect(server.status === "ready" ? {items: server.items, status: server.status, title: server.title} : {status: server.status})
      .toEqual(client.status === "ready" ? {items: client.items, status: client.status, title: client.title} : {status: client.status});
  });
});
