import {randomUUID} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {galleryDates, threadActivity, type HistoryVersion} from "../../apps/web/src/review/library/gallery-dates.ts";
import {publishPath, type FilePublicationTarget} from "../../src/client/file-publication-client.js";
import {ApiClient, issueApiKey, signInAdministrator} from "../support/agent-dispatch.js";
import {previewSourceFixture, writePreviewSourceFixture} from "../support/claude-design-fixture.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const libraryItemSchema = z.object({
  activityAt: z.string(),
  createdAt: z.string(),
  description: z.string(),
  kind: z.string(),
  path: z.string(),
  related: z.array(z.object({path: z.string(), title: z.string()})),
  section: z.string(),
  thumbnailPath: z.string().nullable(),
  title: z.string(),
  viewport: z.object({height: z.number(), width: z.number()}),
});
const librarySchema = z.object({
  galleries: z.array(z.object({
    artifactId: z.string(),
    artifactName: z.string(),
    indexTitle: z.string(),
    items: z.array(libraryItemSchema),
    projectId: z.string(),
    projectName: z.string(),
    versionId: z.string(),
  })),
  generatedAt: z.string(),
  truncated: z.boolean(),
  unreadable: z.array(z.string()),
});
const versionListSchema = z.object({versions: z.array(z.object({version: z.object({createdAt: z.string(), id: z.string(), number: z.number()})}))});
const versionDetailSchema = z.object({manifest: z.object({entries: z.array(z.object({path: z.string(), sha256: z.string()}))})});
const threadPageSchema = z.object({
  items: z.array(z.object({createdAt: z.string(), id: z.string(), path: z.string().nullable(), replyCount: z.number(), updatedAt: z.string(), versionId: z.string()})),
  nextCursor: z.string().nullable(),
});
const threadDetailSchema = z.object({replies: z.array(z.object({createdAt: z.string()}))});
const createdThreadSchema = z.object({thread: z.object({id: z.string()})});

/** Mulberry32: deterministic histories per seed. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const named = (name: string): FilePublicationTarget => ({accessSetting: "account_required", kind: "new_artifact", name, tags: []});

describe("server-side Library", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let directory: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    directory = await mkdtemp(path.join(tmpdir(), "library-catalog-"));
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
    await rm(directory, {force: true, recursive: true});
  });

  function publish(inputPath: string, target: FilePublicationTarget, projectId = "prj_default", entryPath?: string) {
    const command = {idempotencyKey: randomUUID(), inputPath, projectId, target};
    return Effect.runPromise(publishPath(
      {apiToken: Redacted.make(installation.apiToken), serverOrigin: server.baseUrl},
      entryPath === undefined ? command : {...command, entryPath},
    ).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(NodeFileSystem.layer)));
  }

  async function readLibrary(client: ApiClient) {
    const response = await client.fetch("/api/v1/library");
    expect(response.status).toBe(200);
    return librarySchema.parse(await response.json());
  }

  test("foundation: one Library request returns every readable gallery with exact versions and dates", async () => {
    const owner = new ApiClient(server, installation.apiToken);
    const claims = path.join(directory, "claims");
    await writePreviewSourceFixture(claims);
    const portal = path.join(directory, "portal");
    await writePreviewSourceFixture(portal);
    await writeFile(path.join(portal, "artifactserver.previews.json"), JSON.stringify({...previewSourceFixture(), title: "Claimant Portal"}));
    const plain = path.join(directory, "plain");
    await mkdir(plain);
    await writeFile(path.join(plain, "index.html"), "<!doctype html><h1>Plain</h1>");
    const portalProject = await owner.createProject("Portal project", "library-catalog-portal-project");
    const claimsPublished = await publish(claims, named("Claims Workspace"));
    const portalPublished = await publish(portal, named("Claimant Portal"), portalProject);
    await publish(plain, named("Plain page"));

    const library = await readLibrary(owner);
    expect(library.unreadable).toEqual([]);
    expect(library.truncated).toBe(false);
    expect(library.galleries.map((gallery) => [gallery.projectName, gallery.artifactName])).toEqual([
      ["Default", "Claims Workspace"],
      ["Portal project", "Claimant Portal"],
    ]);
    const [claimsGallery, portalGallery] = library.galleries;
    expect(claimsGallery?.versionId).toBe(claimsPublished.version.id);
    expect(portalGallery?.versionId).toBe(portalPublished.version.id);
    expect(claimsGallery?.indexTitle).toBe("Claims Workspace");
    const app = claimsGallery?.items.find((item) => item.path === "project/App.dc.html");
    expect(app).toMatchObject({kind: "prototype", thumbnailPath: "project/thumbnails/app.png", title: "Examiner App"});
    expect(Date.parse(app?.createdAt ?? "")).toBeGreaterThan(0);
    expect(app?.activityAt).toBe(app?.createdAt);
  });

  test("foundation: Library dates equal the client reference over random histories", async () => {
    const owner = new ApiClient(server, installation.apiToken);
    for (const seed of [11, 29]) {
      const random = seededRandom(seed);
      const site = path.join(directory, `history-${seed}`);
      const pool = ["p1.html", "p2.html", "p3.html", "p4.html"];
      let previous: {readonly artifact: {readonly id: string}; readonly version: {readonly id: string}} | null = null;
      for (let versionIndex = 0; versionIndex < 5; versionIndex += 1) {
        // eslint-disable-next-line no-await-in-loop -- each version replaces the previous directory
        await rm(site, {force: true, recursive: true});
        // eslint-disable-next-line no-await-in-loop -- the directory is rebuilt per version
        await mkdir(site, {recursive: true});
        const pages = pool.filter((_, index) => index === 0 || random() < 0.7);
        for (const page of pages) {
          const body = random() < 0.5 ? `<!doctype html><h1>${page} stable</h1>` : `<!doctype html><h1>${page} v${versionIndex}</h1>`;
          // eslint-disable-next-line no-await-in-loop -- small fixture writes
          await writeFile(path.join(site, page), body);
        }
        // eslint-disable-next-line no-await-in-loop -- small fixture write
        await writeFile(path.join(site, "artifactserver.previews.json"), JSON.stringify({
          format: "artifact-server.preview-source",
          items: pages.map((page) => ({kind: "prototype", path: page, section: "Pages", title: page})),
          title: `History ${seed}`,
          version: 2,
        }));
        const target: FilePublicationTarget = previous === null
          ? named(`History ${seed}`)
          : {artifactId: previous.artifact.id, expectedCurrentVersionId: previous.version.id, kind: "new_version"};
        // eslint-disable-next-line no-await-in-loop -- versions publish in order
        previous = await publish(site, target);
        if (random() < 0.6) {
          const page = pages[Math.floor(random() * pages.length)] ?? "p1.html";
          // eslint-disable-next-line no-await-in-loop -- comments follow their version
          const created = await owner.fetch(
            `/api/v1/artifacts/${previous.artifact.id}/versions/${previous.version.id}/comments?projectId=prj_default`,
            {body: JSON.stringify({body: `On ${page}.`, path: page}), idempotencyKey: randomUUID(), method: "POST"},
          );
          if (created.status !== 201) throw new Error(`Creating a thread returned ${created.status}.`);
          if (random() < 0.5) {
            // eslint-disable-next-line no-await-in-loop -- the reply needs its thread
            const threadId = createdThreadSchema.parse(await created.json()).thread.id;
            // eslint-disable-next-line no-await-in-loop -- one reply per thread
            const reply = await owner.fetch(
              `/api/v1/artifacts/${previous.artifact.id}/comments/${threadId}/replies?projectId=prj_default`,
              {body: JSON.stringify({body: "Reply."}), idempotencyKey: randomUUID(), method: "POST"},
            );
            if (reply.status !== 201) throw new Error(`Creating a reply returned ${reply.status}.`);
          }
        }
      }
      if (previous === null) throw new Error("Nothing was published.");
      const artifactId = previous.artifact.id;
      // eslint-disable-next-line no-await-in-loop -- the reference reads follow publication
      const listed = versionListSchema.parse(await (await owner.fetch(`/api/v1/artifacts/${artifactId}/versions?projectId=prj_default`)).json());
      const history: HistoryVersion[] = [];
      for (const {version} of listed.versions.toSorted((left, right) => left.version.number - right.version.number)) {
        // eslint-disable-next-line no-await-in-loop -- one manifest per version
        const detail = versionDetailSchema.parse(await (await owner.fetch(`/api/v1/artifacts/${artifactId}/versions/${version.id}?projectId=prj_default`)).json());
        history.push({at: Date.parse(version.createdAt), files: new Map(detail.manifest.entries.map((entry) => [entry.path, entry.sha256])), number: version.number});
      }
      // eslint-disable-next-line no-await-in-loop -- one comment page holds this history
      const threads = threadPageSchema.parse(await (await owner.fetch(`/api/v1/artifacts/${artifactId}/comments?projectId=prj_default&dispatched=include&limit=100`)).json()).items;
      const comments = [];
      for (const thread of threads) {
        // eslint-disable-next-line no-await-in-loop -- exact reply times per thread
        const detail = threadDetailSchema.parse(await (await owner.fetch(`/api/v1/artifacts/${artifactId}/comments/${thread.id}?projectId=prj_default`)).json());
        comments.push(threadActivity(thread, detail.replies.map((reply) => reply.createdAt)));
      }
      // eslint-disable-next-line no-await-in-loop -- the Library read follows the reference
      const gallery = (await readLibrary(owner)).galleries.find((candidate) => candidate.artifactId === artifactId);
      if (gallery === undefined) throw new Error("The gallery is missing from the Library.");
      const latest = history.at(-1);
      const reference = galleryDates(history, gallery.items.map((item) => item.path), comments, latest?.at ?? Number.NaN);
      for (const item of gallery.items) {
        expect({path: item.path, createdAt: Date.parse(item.createdAt), activityAt: Date.parse(item.activityAt)})
          .toEqual({path: item.path, createdAt: reference.get(item.path)?.createdAt, activityAt: reference.get(item.path)?.activityAt});
      }
    }
  }, 120_000);

  test("DSN-006-F: unreadable galleries are named, capability-less callers learn nothing, and anonymous callers are refused", async () => {
    const owner = new ApiClient(server, installation.apiToken);
    const claims = path.join(directory, "claims");
    await writePreviewSourceFixture(claims);
    await publish(claims, named("Claims Workspace"));
    const broken = path.join(directory, "broken");
    await mkdir(path.join(broken, "artifact-server-previews"), {recursive: true});
    await writeFile(path.join(broken, "artifact-server-design.html"), "<!doctype html><h1>Old catalog</h1>");
    await writeFile(path.join(broken, "artifact-server-previews/index.json"), "{nope");
    await publish(broken, named("Broken gallery"), "prj_default", "artifact-server-design.html");

    const library = await readLibrary(owner);
    expect(library.unreadable).toEqual(["Broken gallery"]);
    expect(library.galleries.map((gallery) => gallery.artifactName)).toEqual(["Claims Workspace"]);

    expect((await fetch(`${server.baseUrl}/api/v1/library`)).status).toBe(401);
    const administrator = await signInAdministrator(server, installation);
    const connectOnly = new ApiClient(server, await issueApiKey(server, administrator, ["agent:connect"], "Connect only"));
    const refused = await connectOnly.fetch("/api/v1/library");
    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain("Claims Workspace");
  });
});
