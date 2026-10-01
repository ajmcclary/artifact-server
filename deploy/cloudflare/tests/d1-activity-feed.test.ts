import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";
import {getPlatformProxy} from "wrangler";

import {defaultProjectId} from "../../../src/core/model.js";
import type {ActivityQuery, PublicationSource} from "../../../src/core/ports.js";
import {createManifest} from "../../../src/manifest/create-manifest.js";
import {createD1ArtifactRepository} from "../src/d1-artifact-repository.js";
import {migrateD1} from "../src/d1-migrations.js";

const openLocalD1 = () => getPlatformProxy<{
  ARTIFACT_SERVER_D1_DATABASE: D1Database;
}>({
  configPath: fileURLToPath(new URL("../wrangler.git-store.test.jsonc", import.meta.url)),
  envFiles: [],
  persist: false,
  remoteBindings: false,
});

const principalId = "member_activity_d1";
const author = {
  authorizedByPrincipalId: null,
  displayName: "Dana Okonkwo",
  principalId,
  principalKind: "human" as const,
};

function query(overrides: Partial<ActivityQuery> = {}): ActivityQuery {
  return {
    actorIds: [],
    cursor: null,
    includeAdministration: false,
    limit: 30,
    projectIds: [],
    search: null,
    segment: "all",
    types: [],
    ...overrides,
  };
}

async function publishArtifact(
  store: ReturnType<typeof createD1ArtifactRepository>,
  artifactId: string,
  createdAt: string,
) {
  const uploadId = `upl_${artifactId}`;
  const bytes = new TextEncoder().encode(`<p>${artifactId}</p>`);
  const manifest = createManifest({
    entryPath: "index.html",
    files: [{
      mediaType: "text/html",
      path: "index.html",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    }],
    routingMode: "static",
  });
  const files = manifest.entries.map((entry) => ({
    entry,
    storageToken: `token-${uploadId}-${entry.sha256}`,
  }));
  await store.createStagedUpload({
    createdAt,
    expiresAt: "2099-12-31T00:00:00.000Z",
    files,
    id: uploadId,
    idempotencyKey: null,
    manifest,
    principalId,
    projectId: defaultProjectId,
  });
  await Promise.all(files.map((file) =>
    store.markStagedFileUploaded(defaultProjectId, uploadId, principalId, file.storageToken, createdAt)
  ));
  await store.claimUploadPreparation(
    uploadId,
    createdAt,
    new Date(Date.parse(createdAt) + 600_000).toISOString(),
  );
  await Promise.all(files.map((file) =>
    store.recordStagedFileInstalled(uploadId, file.storageToken, 1, createdAt)
  ));
  await store.writePreparedManifestEntries(uploadId, 1, manifest.entries);
  await store.markUploadPrepared(uploadId, 1, createdAt);
  const source: PublicationSource = {
    kind: "staged_upload",
    principalId,
    projectId: defaultProjectId,
    uploadId,
  };
  return store.commitNewArtifact({
    accessSetting: "account_required",
    actor: {displayName: "Dana Okonkwo", kind: "human"},
    artifactId,
    authorizedByPrincipalId: null,
    contentToken: `content-${uploadId}`,
    createdAt,
    idempotencyKey: `publish-${uploadId}`,
    inputDigest: `digest-${uploadId}`,
    manifest,
    name: `D1 ${artifactId}`,
    principalId,
    projectId: defaultProjectId,
    source,
    tags: [],
    versionId: `ver_${artifactId}`,
  });
}

const rosa = {...author, displayName: "Rosa Santoro", principalId: "member_activity_d1_rosa"};

describe("D1 activity read model", () => {
  it("ACT-008: D1 narrows to people and counts entries per person, for the filters and in all", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-activity-people";
    try {
      await migrateD1(binding, installationId);
      const store = createD1ArtifactRepository(binding, installationId);
      const published = await publishArtifact(store, "art_d1_people", "2026-10-01T10:00:00.000Z");
      const thread = await store.createThread({
        anchor: null, artifactId: published.artifact.id, author, body: "Dana opens", createdAt: "2026-10-01T10:01:00.000Z",
        id: "cmt_d1_people", idempotencyKey: "d1-people-thread", installationId, path: null,
        projectId: defaultProjectId, versionId: published.version.id,
      });
      await store.createReply({
        artifactId: published.artifact.id, author: rosa, body: "Rosa answers", createdAt: "2026-10-01T10:02:00.000Z",
        id: "rpl_d1_people", idempotencyKey: "d1-people-reply", projectId: defaultProjectId, threadId: thread.thread.id,
      });

      // The conversation belongs to whoever spoke last.
      expect((await store.listActivity(query({actorIds: [rosa.principalId]}))).items.map((row) => row.action.action))
        .toEqual(["comment_reply"]);
      expect((await store.listActivity(query({actorIds: [principalId], types: ["versions", "comments"]}))).items
        .map((row) => row.action.action)).toEqual(["publish"]);
      const {cursor: _cursor, limit: _limit, ...filters} = query({actorIds: [rosa.principalId]});
      const counted = await store.countActivity(filters);
      expect(counted.matching).toBe(1);
      expect(counted.people.map((person) => [person.displayName, person.entryCount, person.principalId])).toEqual(
        expect.arrayContaining([["Rosa Santoro", 1, rosa.principalId], ["Dana Okonkwo", 1, principalId]]),
      );
      expect(counted.total).toBe((await store.listActivity(query({limit: 100}))).items.length);
    } finally {
      await proxy.dispose();
    }
  });

  it("ACT-003: D1 folds threads, filters by project and counts waiting conversations", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-activity-feed";
    try {
      await migrateD1(binding, installationId);
      const store = createD1ArtifactRepository(binding, installationId);
      const published = await publishArtifact(store, "art_d1_feed", "2026-10-01T10:00:00.000Z");
      const thread = await store.createThread({
        anchor: null,
        artifactId: published.artifact.id,
        author,
        body: "Opening note",
        createdAt: "2026-10-01T10:01:00.000Z",
        id: "cmt_d1_thread",
        idempotencyKey: "d1-thread",
        installationId,
        path: null,
        projectId: defaultProjectId,
        versionId: published.version.id,
      });
      // Replies are created strictly in order: each one is the thread's newest.
      await ["02", "03", "04"].reduce<Promise<void>>(async (previous, minute, index) => {
        await previous;
        await store.createReply({
          artifactId: published.artifact.id,
          author,
          body: `reply ${index}`,
          createdAt: `2026-10-01T10:${minute}:00.000Z`,
          id: `rpl_d1_${index}`,
          idempotencyKey: `d1-reply-${index}`,
          projectId: defaultProjectId,
          threadId: thread.thread.id,
        });
      }, Promise.resolve());

      const page = await store.listActivity(query({types: ["comments", "versions"]}));
      expect(page.items.map((row) => row.action.action)).toEqual(["comment_reply", "publish"]);
      expect(page.items[0]?.thread?.replies.map((reply) => reply.body))
        .toEqual(["reply 1", "reply 2"]);

      const scoped = await store.listActivity(query({projectIds: ["prj_absent"]}));
      expect(scoped.items).toEqual([]);

      const summary = await store.summarizeActivity([]);
      expect(summary).toMatchObject({needsYou: 1, openConversations: 1, withAgent: 0});
    } finally {
      await proxy.dispose();
    }
  });
});
