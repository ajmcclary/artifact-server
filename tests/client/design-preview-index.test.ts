import {randomUUID} from "node:crypto";
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {afterAll, beforeAll, expect, test} from "vitest";
import {z} from "zod";

import {
  prepareFilePublication,
  publishPath,
  type FilePublicationTarget,
} from "../../src/client/file-publication-client.js";
import {previewIndexPath} from "../../src/manifest/preview-index.js";
import {
  fixtureCoverJpeg,
  fixtureThumbnailPng,
  previewSourceFixture,
  writeClaudeDesignFixture,
  writeDesignCardFixture,
  writePreviewSourceFixture,
} from "../support/claude-design-fixture.js";
import {fetchLoopbackContent} from "../support/fetch-loopback-content.js";
import {createTestInstallation, removeTestInstallation, startTestServer, type RunningTestServer, type TestInstallation} from "../support/runtime-harness.js";

let directory: string;
let installation: TestInstallation;
let server: RunningTestServer;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "design-preview-index-test-"));
  installation = await createTestInstallation();
  server = await startTestServer(installation);
});
afterAll(async () => {
  await server.stop();
  await removeTestInstallation(installation);
  await rm(directory, {recursive: true, force: true});
});

const publicArtifact = {kind: "new_artifact", accessSetting: "public_link", tags: []} as const;
function intent(inputPath: string, target: FilePublicationTarget = publicArtifact) {
  return {inputPath, target} as const;
}
function publish(inputPath: string, target: FilePublicationTarget = publicArtifact, idempotencyKey = randomUUID()) {
  return Effect.runPromise(publishPath(
    {serverOrigin: server.baseUrl, apiToken: Redacted.make(installation.apiToken)},
    {...intent(inputPath, target), idempotencyKey},
  ).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(NodeFileSystem.layer)));
}
function prepare(inputPath: string, entryPath?: string) {
  return Effect.runPromise(prepareFilePublication(entryPath === undefined ? intent(inputPath) : {...intent(inputPath), entryPath}));
}
function generated(prepared: Awaited<ReturnType<typeof prepare>>, filePath: string) {
  const file = prepared.publication.files.find((candidate) => candidate.path === filePath);
  return file?.kind === "generated" ? file : undefined;
}
const imageSchema = z.object({path: z.string(), mediaType: z.string()}).strict();
const publishedIndexSchema = z.object({
  format: z.literal("artifact-server.preview-index"),
  version: z.literal(2),
  origin: z.string(),
  title: z.string(),
  description: z.string(),
  cover: imageSchema.nullable(),
  items: z.array(z.object({
    kind: z.string(),
    section: z.string(),
    title: z.string(),
    description: z.string(),
    path: z.string(),
    viewport: z.object({width: z.number(), height: z.number()}).strict(),
    thumbnail: imageSchema.nullable(),
    related: z.array(z.object({title: z.string(), path: z.string()}).strict()),
  }).strict()),
}).strict();
const versionManifestSchema = z.object({manifest: z.object({entries: z.array(z.object({path: z.string()}))})});
type PublishedIndex = z.infer<typeof publishedIndexSchema>;

function indexOf(prepared: Awaited<ReturnType<typeof prepare>>): PublishedIndex | undefined {
  const file = generated(prepared, previewIndexPath);
  return file === undefined ? undefined : publishedIndexSchema.parse(JSON.parse(new TextDecoder().decode(file.content)));
}
async function writeSource(inputPath: string, patch: (source: ReturnType<typeof previewSourceFixture>) => object) {
  await writeFile(path.join(inputPath, "artifactserver.previews.json"), JSON.stringify(patch(previewSourceFixture())));
}

test("DSN-003-B: a producer preview source publishes a versioned index, typed thumbnails and unchanged source bytes", async () => {
  const inputPath = path.join(directory, "producer");
  await writePreviewSourceFixture(inputPath);
  const before = await readdir(inputPath, {recursive: true});
  const first = await prepare(inputPath);
  const replay = await prepare(inputPath);
  expect(replay.operationDigest).toBe(first.operationDigest);
  expect(await readdir(inputPath, {recursive: true})).toEqual(before);
  expect(first.publication.entryPath).toBe("project/App.dc.html");
  expect(first.publication.files.some((file) => file.path === "artifact-server-design.html")).toBe(false);
  const coverCopy = first.publication.files.find((file) => file.path.startsWith("artifact-server-previews/thumbnails/"));
  expect(coverCopy?.path).toMatch(/^artifact-server-previews\/thumbnails\/[a-f0-9]{64}\.jpg$/u);
  expect(indexOf(first)).toEqual({
    format: "artifact-server.preview-index",
    version: 2,
    origin: "producer",
    title: "Claims Workspace",
    description: "Examiner app, portal and starter screens.",
    cover: {path: coverCopy?.path, mediaType: "image/jpeg"},
    items: [
      {kind: "prototype", section: "Prototypes", title: "Examiner App", description: "Claim record with panels.", path: "project/App.dc.html", viewport: {width: 1440, height: 900}, thumbnail: {path: "project/thumbnails/app.png", mediaType: "image/png"}, related: []},
      {kind: "prototype", section: "Portal", title: "Claimant Portal", description: "", path: "project/Portal.dc.html", viewport: {width: 1280, height: 900}, thumbnail: null, related: []},
      {kind: "template", section: "Starter templates", title: "Screen", description: "A complete screen", path: "project/templates/Screen.dc.html", viewport: {width: 1100, height: 900}, thumbnail: null, related: []},
      {kind: "component", section: "Actions", title: "Primary button", description: "An interactive component", path: "project/components/buttons.card.html", viewport: {width: 640, height: 110}, thumbnail: {path: "project/thumbnails/button.webp", mediaType: "image/webp"}, related: [{title: "Button guide", path: "project/components/Button.README.md"}, {title: "Button tokens", path: "project/components/Button.tokens.md"}]},
    ],
  });

  const key = randomUUID();
  const result = await publish(inputPath, publicArtifact, key);
  expect((await publish(inputPath, publicArtifact, key)).version.id).toBe(result.version.id);
  const index = await fetchLoopbackContent(new URL(previewIndexPath, result.links.version));
  expect(index.headers.get("content-type")).toMatch(/^application\/json/u);
  expect(await index.json()).toEqual(indexOf(first));
  const cover = await fetchLoopbackContent(new URL(coverCopy?.path ?? "", result.links.version));
  expect(cover.headers.get("content-type")).toBe("image/jpeg");
  expect(Buffer.from(await cover.arrayBuffer())).toEqual(fixtureCoverJpeg);
  const original = await fetchLoopbackContent(new URL("project/.thumbnail", result.links.version));
  expect(Buffer.from(await original.arrayBuffer())).toEqual(fixtureCoverJpeg);
  const thumbnail = await fetchLoopbackContent(new URL("project/thumbnails/app.png", result.links.version));
  expect(Buffer.from(await thumbnail.arrayBuffer())).toEqual(fixtureThumbnailPng);
  const entry = await (await fetchLoopbackContent(result.links.version)).text();
  expect(entry).toContain("<h1>Examiner app</h1>");
});

test("DSN-003: derived indexes keep declared kinds and never infer templates from .dc.html names", async () => {
  const cardsPath = path.join(directory, "derived-cards");
  await writeDesignCardFixture(cardsPath, true);
  await writeFile(path.join(cardsPath, "project/.thumbnail"), fixtureCoverJpeg);
  const cards = indexOf(await prepare(cardsPath));
  expect(cards?.origin).toBe("design-cards");
  expect(cards?.title).toBe("derived-cards");
  expect(cards?.cover).toMatchObject({mediaType: "image/jpeg"});
  expect(cards?.items.map((item) => [item.kind, item.section, item.path])).toEqual([
    ["component", "Actions", "project/components/buttons.card.html"],
    ["component", "Components", "project/components/plain.card.html"],
    ["artboard", "Artboards", "project/templates/Screen.dc.html"],
  ]);

  const vendorPath = path.join(directory, "derived-vendor");
  await writeClaudeDesignFixture(vendorPath);
  await writeFile(path.join(vendorPath, ".thumbnail"), "<html>not an image</html>");
  const vendor = indexOf(await prepare(vendorPath));
  expect(vendor?.origin).toBe("claude-design-manifest");
  expect(vendor?.cover).toBeNull();
  expect(vendor?.items.map((item) => [item.kind, item.path])).toEqual([
    ["component", "components/card-button.html"],
    ["template", "templates/Screen.dc.html"],
  ]);
});

test("DSN-003: root index.html and explicit entries still bypass galleries; producer sources outrank detection", async () => {
  const inputPath = path.join(directory, "precedence");
  await writePreviewSourceFixture(inputPath);
  await writeFile(path.join(inputPath, "project/_ds_manifest.json"), JSON.stringify({namespace: "Vendor", cards: [{path: "components/buttons.card.html", name: "Vendor card"}]}));
  expect(indexOf(await prepare(inputPath))?.origin).toBe("producer");
  const explicit = await prepare(inputPath, "project/App.dc.html");
  expect(explicit.publication.entryPath).toBe("project/App.dc.html");
  expect(explicit.publication.files.some((file) => file.kind === "generated")).toBe(false);
  await writeFile(path.join(inputPath, "index.html"), "Existing entry");
  const rooted = await prepare(inputPath);
  expect(rooted.publication.entryPath).toBe("index.html");
  expect(rooted.publication.files.some((file) => file.kind === "generated")).toBe(false);
});

test("DSN-003: private and historical versions keep their own exact preview assets", async () => {
  const inputPath = path.join(directory, "history");
  await writeDesignCardFixture(inputPath, true);
  const privateTarget = {kind: "new_artifact", accessSetting: "account_required", tags: []} as const;
  const first = await publish(inputPath, privateTarget);
  const denied = await fetchLoopbackContent(new URL(previewIndexPath, first.links.version));
  expect(denied.status).not.toBe(200);
  expect(await denied.text()).not.toContain("artifact-server.preview-index");

  await writePreviewSourceFixture(inputPath);
  const second = await publish(inputPath, {kind: "new_version", artifactId: first.artifact.id, expectedCurrentVersionId: first.version.id});
  expect(second.version.id).not.toBe(first.version.id);
  const headers = {authorization: `Bearer ${installation.apiToken}`};
  const read = async (versionId: string) => {
    const response = await fetch(new URL(`/api/v1/artifacts/${first.artifact.id}/versions/${versionId}?projectId=${first.artifact.projectId}`, server.baseUrl), {headers});
    expect(response.status).toBe(200);
    return versionManifestSchema.parse(await response.json()).manifest.entries.map((entry) => entry.path);
  };
  const historical = await read(first.version.id);
  expect(historical).toContain(previewIndexPath);
  expect(historical.some((entry) => entry.includes("thumbnails/"))).toBe(false);
  const current = await read(second.version.id);
  expect(current.filter((entry) => entry.startsWith("artifact-server-previews/thumbnails/"))).toHaveLength(1);
});

test("DSN-003-F: malformed, unsafe, duplicate and mistyped preview sources fail before upload", async () => {
  const inputPath = path.join(directory, "hostile");
  await writePreviewSourceFixture(inputPath);
  const source = path.join(inputPath, "artifactserver.previews.json");
  const rejects = async (expected: RegExp) => {
    await expect(prepare(inputPath)).rejects.toThrow(expected);
  };
  await writeFile(source, "{not json");
  await rejects(/Cannot prepare design export/u);
  await writeSource(inputPath, (value) => ({...value, version: 3}));
  await rejects(/Unsupported preview source version 3/u);
  await writeSource(inputPath, (value) => ({...value, version: 1}));
  await rejects(/Related links require preview source version 2/u);
  await writeSource(inputPath, (value) => ({...value, generator: "unexpected"}));
  await rejects(/Cannot prepare design export/u);
  await writeSource(inputPath, (value) => ({...value, items: []}));
  await rejects(/Cannot prepare design export/u);
  interface ItemPatch {
    readonly kind?: string;
    readonly related?: readonly {readonly path: string; readonly title: string}[];
    readonly path?: string;
    readonly thumbnail?: string;
    readonly title?: string;
    readonly viewport?: {readonly height: number; readonly width: number};
  }
  const withItem = (patch: ItemPatch) => writeSource(inputPath, (value) => ({
    ...value,
    items: [{...value.items[0], ...patch}],
  }));
  await withItem({path: "../outside.html"});
  await rejects(/not portable or safe/u);
  await withItem({path: "project/Missing.dc.html"});
  await rejects(/not published/u);
  await withItem({path: "project/styles.css"});
  await rejects(/must be a published HTML file/u);
  await withItem({kind: "screenshot"});
  await rejects(/Cannot prepare design export/u);
  await withItem({title: "Tab\u0009title"});
  await rejects(/Cannot prepare design export/u);
  await withItem({title: "   "});
  await rejects(/Cannot prepare design export/u);
  await withItem({viewport: {width: 5000, height: 900}});
  await rejects(/Cannot prepare design export/u);
  await writeSource(inputPath, (value) => ({...value, items: [value.items[0], {...value.items[1], path: "project/App.dc.html"}]}));
  await rejects(/more than once/u);
  const guide = {title: "Guide", path: "project/components/Button.README.md"};
  await withItem({related: [guide, guide]});
  await rejects(/links "project\/components\/Button.README.md" more than once/u);
  await withItem({related: [{title: "Escape", path: "../secrets.md"}]});
  await rejects(/not portable or safe/u);
  await withItem({related: [{title: "Missing", path: "project/Missing.md"}]});
  await rejects(/not published/u);
  await withItem({related: [{title: "Tab\u0009guide", path: guide.path}]});
  await rejects(/Cannot prepare design export/u);
  await withItem({related: Array.from({length: 25}, () => guide)});
  await rejects(/Cannot prepare design export/u);
  await writeFile(path.join(inputPath, "project/thumbnails/fake.png"), "<svg onload=alert(1)>");
  await withItem({thumbnail: "project/thumbnails/fake.png"});
  await rejects(/PNG, JPEG or WebP/u);
  await writeFile(path.join(inputPath, "project/thumbnails/misnamed.png"), fixtureCoverJpeg);
  await withItem({thumbnail: "project/thumbnails/misnamed.png"});
  await rejects(/PNG, JPEG or WebP/u);
  await writeFile(path.join(inputPath, "project/thumbnails/large.png"), Buffer.concat([fixtureThumbnailPng, Buffer.alloc(2 * 1024 * 1024)]));
  await withItem({thumbnail: "project/thumbnails/large.png"});
  await rejects(/at most 2 MiB/u);
  await writeSource(inputPath, (value) => ({...value, cover: "project/App.dc.html"}));
  await rejects(/PNG, JPEG or WebP/u);

  await writeSource(inputPath, (value) => value);
  await mkdir(path.join(inputPath, "Artifact-Server-Previews"), {recursive: true});
  await writeFile(path.join(inputPath, "Artifact-Server-Previews/index.json"), "{}");
  await rejects(/preview asset directory already exists/u);
  expect(await readFile(path.join(inputPath, "Artifact-Server-Previews/index.json"), "utf8")).toBe("{}");
});
