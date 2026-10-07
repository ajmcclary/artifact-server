import {createHash} from "node:crypto";

import {describe, expect, test} from "vitest";

import {createVersionDocuments} from "../../src/application/version-documents.js";
import type {ArtifactVersion, ManifestEntry} from "../../src/core/model.js";
import type {OpenedBlob} from "../../src/core/ports.js";

const viewsText = JSON.stringify({
  format: "artifact-server.views",
  version: 1,
  views: [{
    defaultScenarioId: "1",
    label: "Page",
    parameters: [],
    path: "index.html",
    scenarios: [{label: "One", props: {scenario: "1"}, scenarioId: "1"}],
    sourceRef: {path: "src/index.html"},
    viewId: "fixture/page",
  }],
});

function fixture(files: Readonly<Record<string, Uint8Array>>, declaredSizes: Readonly<Record<string, number>> = {}) {
  const blobs = new Map<string, Uint8Array>();
  const entries: ManifestEntry[] = Object.entries(files).map(([path, bytes]) => {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    blobs.set(sha256, bytes);
    return {
      disposition: "inline",
      mediaType: path.endsWith(".json") ? "application/json" : "text/html; charset=utf-8",
      path,
      sha256,
      size: declaredSizes[path] ?? bytes.byteLength,
    };
  });
  let opens = 0;
  let failNext = false;
  const open = (sha256: string): Promise<OpenedBlob> => {
    opens += 1;
    if (failNext) {
      failNext = false;
      return Promise.reject(new Error("blob store unavailable"));
    }
    const stored = blobs.get(sha256);
    if (stored === undefined) return Promise.reject(new Error("missing blob"));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(stored);
        controller.close();
      },
    });
    return Promise.resolve({body, sha256, size: stored.byteLength});
  };
  return {
    failNextOpen: () => {
      failNext = true;
    },
    open,
    opens: () => opens,
    saved: versionWith(entries, "ver_fixture"),
  };
}

function versionWith(entries: readonly ManifestEntry[], id: string): ArtifactVersion {
  return {
    manifest: {digest: "d".repeat(64), entries, entryPath: "index.html", routingMode: "static", serialized: "{}"},
    version: {
      artifactId: "art_fixture",
      contentToken: "token",
      createdAt: "2026-10-06T00:00:00.000Z",
      entryPath: "index.html",
      id,
      manifestDigest: "d".repeat(64),
      number: 1,
      projectId: "prj_default",
      publisherPrincipalId: "member_fixture",
      routingMode: "static",
    },
  };
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("version document reader", () => {
  test("reads, validates and caches a version's views once", async () => {
    const {open, opens, saved} = fixture({"artifactserver.views.json": utf8(viewsText), "index.html": utf8("<p>x</p>")});
    const documents = createVersionDocuments({blobs: {open}});
    const [first, second] = await Promise.all([documents.views(saved), documents.views(saved)]);
    expect(first.status).toBe("valid");
    expect(second).toBe(first);
    expect(await documents.views(saved)).toBe(first);
    expect(opens()).toBe(1);
  });

  test("reports absent views and a not-recorded provenance without opening blobs", async () => {
    const {open, opens, saved} = fixture({"index.html": utf8("<p>x</p>")});
    const documents = createVersionDocuments({blobs: {open}});
    expect(await documents.views(saved)).toEqual({status: "absent"});
    expect(await documents.provenance(saved)).toEqual({status: "not-recorded"});
    expect(opens()).toBe(0);
  });

  test("reports non-UTF-8 bytes as invalid", async () => {
    const latin1 = new Uint8Array([0x7b, 0xe9, 0x7d]);
    const {open, saved} = fixture({"artifactserver.views.json": latin1, "index.html": utf8("<p>x</p>")});
    const outcome = await createVersionDocuments({blobs: {open}}).views(saved);
    expect(outcome).toEqual({diagnostic: "The views document is not UTF-8 text.", status: "invalid"});
  });

  test("reports an oversized document as invalid without opening it", async () => {
    const {open, opens, saved} = fixture(
      {"artifactserver.views.json": utf8(viewsText), "index.html": utf8("<p>x</p>")},
      {"artifactserver.views.json": 1_048_577},
    );
    const outcome = await createVersionDocuments({blobs: {open}}).views(saved);
    expect(outcome).toEqual({diagnostic: "The views document is larger than 1 MiB.", status: "invalid"});
    expect(opens()).toBe(0);
  });

  test("fails on a stored size that differs from the manifest and retries on the next read", async () => {
    const {open, opens, saved} = fixture(
      {"artifactserver.views.json": utf8(viewsText), "index.html": utf8("<p>x</p>")},
      {"artifactserver.views.json": viewsText.length + 1},
    );
    const documents = createVersionDocuments({blobs: {open}});
    await expect(documents.views(saved)).rejects.toThrow(/manifest declares/u);
    await expect(documents.views(saved)).rejects.toThrow(/manifest declares/u);
    expect(opens()).toBe(2);
  });

  test("never caches a storage failure", async () => {
    const {failNextOpen, open, saved} = fixture({"artifactserver.views.json": utf8(viewsText), "index.html": utf8("<p>x</p>")});
    const documents = createVersionDocuments({blobs: {open}});
    failNextOpen();
    await expect(documents.views(saved)).rejects.toThrow("blob store unavailable");
    expect((await documents.views(saved)).status).toBe("valid");
  });

  test("evicts the least recently used outcome past the bound", async () => {
    const {open, opens, saved} = fixture({"artifactserver.views.json": utf8(viewsText), "index.html": utf8("<p>x</p>")});
    const other = versionWith(saved.manifest.entries, "ver_other");
    const documents = createVersionDocuments({blobs: {open}, maximumCachedOutcomes: 1});
    await documents.views(saved);
    await documents.views(other);
    await documents.views(saved);
    expect(opens()).toBe(3);
  });
});
