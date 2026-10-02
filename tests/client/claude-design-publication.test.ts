import {randomUUID} from "node:crypto";
import {mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {afterAll, beforeAll, expect, test} from "vitest";

import {prepareFilePublication, publishPath} from "../../src/client/file-publication-client.js";
import {claudeDesignPublication} from "../../src/manifest/claude-design.js";
import {previewIndexPath} from "../../src/manifest/preview-index.js";
import {writeClaudeDesignFixture} from "../support/claude-design-fixture.js";
import {fetchLoopbackContent} from "../support/fetch-loopback-content.js";
import {createTestInstallation, removeTestInstallation, startTestServer, type RunningTestServer, type TestInstallation} from "../support/runtime-harness.js";

let directory: string;
let installation: TestInstallation;
let server: RunningTestServer;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "claude-design-test-"));
  installation = await createTestInstallation();
  server = await startTestServer(installation);
});
afterAll(async () => {
  await server.stop();
  await removeTestInstallation(installation);
  await rm(directory, {recursive: true, force: true});
});

function intent(inputPath: string) {
  return {inputPath, target: {kind: "new_artifact", accessSetting: "public_link", tags: []}} as const;
}

function draft(paths: readonly string[], text: string) {
  return claudeDesignPublication(paths, "_ds_manifest.json", text, "Test");
}

function generatedText(prepared: {readonly publication: {readonly files: readonly {readonly path: string; readonly kind: string; readonly content?: Uint8Array}[]}}, filePath: string): string | undefined {
  const file = prepared.publication.files.find((candidate) => candidate.path === filePath);
  return file?.kind === "generated" && file.content !== undefined ? new TextDecoder().decode(file.content) : undefined;
}

test("DSN-001-B: flat and nested systems publish a preview index, open on their first preview and keep original assets through staged HTTP", async () => {
  await Promise.all([false, true].map(async (nested) => {
    const inputPath = path.join(directory, nested ? "nested" : "flat");
    const root = await writeClaudeDesignFixture(inputPath, nested);
    const original = await readFile(path.join(root, "components/card-button.html"));
    const first = await Effect.runPromise(prepareFilePublication(intent(inputPath)));
    const second = await Effect.runPromise(prepareFilePublication(intent(inputPath)));
    expect(second.operationDigest).toBe(first.operationDigest);
    expect(await readdir(inputPath, {recursive: true})).not.toContain("artifact-server-previews");
    expect(first.publication.files.filter((file) => file.kind === "generated").map((file) => file.path)).toEqual([previewIndexPath]);
    const command = {...intent(inputPath), idempotencyKey: randomUUID()};
    const publish = () => Effect.runPromise(publishPath({serverOrigin: server.baseUrl, apiToken: Redacted.make(installation.apiToken)}, command).pipe(
      Effect.provide(FetchHttpClient.layer), Effect.provide(NodeFileSystem.layer),
    ));
    const result = await publish();
    const prefix = nested ? "project/" : "";
    expect(result.version.entryPath).toBe(`${prefix}components/card-button.html`);
    expect((await publish()).version.id).toBe(result.version.id);
    const entry = await fetchLoopbackContent(result.links.version);
    expect(Buffer.from(await entry.arrayBuffer())).toEqual(original);
    const index = await fetchLoopbackContent(new URL(previewIndexPath, result.links.version).toString());
    expect(await index.json()).toMatchObject({origin: "claude-design-manifest", title: "Example_System"});
    const card = await fetchLoopbackContent(new URL(`${prefix}components/card-button.html`, result.links.version).toString());
    expect(Buffer.from(await card.arrayBuffer())).toEqual(original);
    const font = await fetchLoopbackContent(new URL(`${prefix}font.woff2`, result.links.version).toString());
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(font.headers.get("content-disposition")).not.toContain("attachment");
  }));

  // Projects gain an artboard gallery while existing and explicit entries win.
  const inputPath = path.join(directory, "project");
  await writeClaudeDesignFixture(inputPath);
  await rm(path.join(inputPath, "_ds_manifest.json"));
  const inferred = await Effect.runPromise(prepareFilePublication(intent(inputPath)));
  expect(inferred.publication.entryPath).toBe("templates/Screen.dc.html");
  expect(JSON.parse(generatedText(inferred, previewIndexPath) ?? "null")).toMatchObject({origin: "artboards"});
  await writeFile(path.join(inputPath, "index.html"), "Existing entry");
  const existing = await Effect.runPromise(prepareFilePublication(intent(inputPath)));
  expect(existing.publication.entryPath).toBe("index.html");
  const explicit = await Effect.runPromise(prepareFilePublication({...intent(inputPath), entryPath: "templates/Screen.dc.html"}));
  expect(explicit.publication.entryPath).toBe("templates/Screen.dc.html");
  expect(explicit.publication.files.some((file) => file.kind === "generated")).toBe(false);
});

test("DSN-001-F: invalid metadata, references, symlinks and preview-path collisions fail closed", async () => {
  for (const reference of ["../outside.html", "/outside.html", "https://example.com/card.html", "missing.html", "styles.css", "a%2fb.html", "a\\b.html"]) {
    expect(() => draft(["styles.css"], JSON.stringify({namespace: "Test", cards: [{path: reference, name: "Unsafe"}]}))).toThrow(/.+/u);
  }
  for (const text of ["{", "null", '{"namespace":"Test","cards":"bad"}']) {
    expect(() => draft([], text)).toThrow(/.+/u);
  }
  // Hostile metadata stays inert data in the index; malformed viewports fall back to defaults.
  const hostile = draft(["card.html"], JSON.stringify({namespace: "<script>alert(1)</script>", cards: [{path: "card.html", name: '"><script>alert(2)</script>', viewport: '1" onload=alert(3)'}]}));
  expect(hostile?.title).toBe("<script>alert(1)</script>");
  expect(hostile?.items[0]).toMatchObject({title: '"><script>alert(2)</script>', path: "card.html", viewport: {width: 1100, height: 700}});

  // Filesystem refusals happen during preparation, before an upload exists.
  const empty = path.join(directory, "empty");
  await writeClaudeDesignFixture(empty);
  await writeFile(path.join(empty, "_ds_manifest.json"), '{"namespace":"Test","cards":[]}');
  await expect(Effect.runPromise(prepareFilePublication(intent(empty)))).rejects.toThrow("between 1 and");
  const collision = path.join(directory, "collision");
  await writeClaudeDesignFixture(collision);
  await mkdir(path.join(collision, "artifact-server-previews"));
  await writeFile(path.join(collision, "artifact-server-previews/index.json"), "User index");
  await expect(Effect.runPromise(prepareFilePublication(intent(collision)))).rejects.toThrow("already exists");
  expect(await readFile(path.join(collision, "artifact-server-previews/index.json"), "utf8")).toBe("User index");
  // The retired catalog name is an ordinary file now; it neither collides nor becomes the entry.
  const retired = path.join(directory, "retired-catalog");
  await writeClaudeDesignFixture(retired);
  await writeFile(path.join(retired, "artifact-server-design.html"), "Old catalog");
  const kept = await Effect.runPromise(prepareFilePublication(intent(retired)));
  expect(kept.publication.entryPath).toBe("components/card-button.html");
  expect(kept.publication.files.find((file) => file.path === "artifact-server-design.html")?.kind).toBe("disk");
  const oversized = path.join(directory, "oversized");
  await writeClaudeDesignFixture(oversized);
  await writeFile(path.join(oversized, "_ds_manifest.json"), " ".repeat(4 * 1024 * 1024 + 1));
  await expect(Effect.runPromise(prepareFilePublication(intent(oversized)))).rejects.toThrow("4 MiB");
  const linked = path.join(directory, "linked");
  await writeClaudeDesignFixture(linked);
  await symlink(path.join(collision, "styles.css"), path.join(linked, "linked.css"));
  await expect(Effect.runPromise(prepareFilePublication(intent(linked)))).rejects.toThrow("symbolic links");
});
