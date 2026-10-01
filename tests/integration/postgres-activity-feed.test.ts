import {createHash, randomUUID} from "node:crypto";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {defaultProjectId} from "../../src/core/model.js";
import type {ActivityQuery, PublicationSource} from "../../src/core/ports.js";
import {createManifest} from "../../src/manifest/create-manifest.js";
import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";

const principalId = "member_activity_pg";
const author = {
  authorizedByPrincipalId: null,
  displayName: "Dana Okonkwo",
  principalId,
  principalKind: "human" as const,
};

function readDatabaseUrl(): string {
  const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  if (databaseUrl === undefined) {
    throw new Error("Run this test through pnpm test:external-storage-runtime.");
  }
  return databaseUrl;
}

function query(overrides: Partial<ActivityQuery> = {}): ActivityQuery {
  return {
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
  repository: PostgresArtifactRepository,
  artifactId: string,
  name: string,
  createdAt: string,
) {
  const uploadId = `upl_${artifactId}`;
  const bytes = new TextEncoder().encode(`<p>${name}</p>`);
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
  await repository.createStagedUpload({
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
    repository.markStagedFileUploaded(
      defaultProjectId,
      uploadId,
      principalId,
      file.storageToken,
      createdAt,
    )
  ));
  const leaseExpiresAt = new Date(Date.parse(createdAt) + 600_000).toISOString();
  await repository.claimUploadPreparation(uploadId, createdAt, leaseExpiresAt);
  await Promise.all(files.map((file) =>
    repository.recordStagedFileInstalled(uploadId, file.storageToken, 1, createdAt)
  ));
  await repository.writePreparedManifestEntries(uploadId, 1, manifest.entries);
  await repository.markUploadPrepared(uploadId, 1, createdAt);
  const source: PublicationSource = {
    kind: "staged_upload",
    principalId,
    projectId: defaultProjectId,
    uploadId,
  };
  return repository.commitNewArtifact({
    accessSetting: "account_required",
    actor: {displayName: "Dana Okonkwo", kind: "human"},
    artifactId,
    authorizedByPrincipalId: null,
    contentToken: `content-${uploadId}`,
    createdAt,
    idempotencyKey: `publish-${uploadId}`,
    inputDigest: `digest-${uploadId}`,
    manifest,
    name,
    principalId,
    projectId: defaultProjectId,
    source,
    tags: [],
    versionId: `ver_${artifactId}`,
  });
}

describe("Postgres activity read model", () => {
  const scratch = `artifact_activity_${randomUUID().replaceAll("-", "")}`;
  let maintenance: PostgresDatabase;
  let database: PostgresDatabase;
  let first: PostgresArtifactRepository;
  let second: PostgresArtifactRepository;
  let firstInstallationId: string;

  beforeEach(async () => {
    maintenance = await PostgresDatabase.inspect({url: Redacted.make(readDatabaseUrl())});
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`CREATE DATABASE ${scratch}`);
    }));
    const scratchUrl = new URL(readDatabaseUrl());
    scratchUrl.pathname = `/${scratch}`;
    database = await PostgresDatabase.open({url: Redacted.make(scratchUrl.toString())}, "apply");
    firstInstallationId = `activity-a-${randomUUID()}`;
    first = await PostgresArtifactRepository.open(database, firstInstallationId);
    second = await PostgresArtifactRepository.open(database, `activity-b-${randomUUID()}`);
  });

  afterEach(async () => {
    await database.close();
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    }));
    await maintenance.close();
  });

  test("ACT-003: Postgres folds threads, pages without duplicates and searches literally", async () => {
    const published = await publishArtifact(first, "art_pg_feed", "Stage bar 100%", "2026-10-01T10:00:00.000Z");
    const thread = await first.createThread({
      anchor: null,
      artifactId: published.artifact.id,
      author,
      body: "Opening note",
      createdAt: "2026-10-01T10:01:00.000Z",
      id: "cmt_pg_thread",
      idempotencyKey: "pg-thread",
      installationId: firstInstallationId,
      path: null,
      projectId: defaultProjectId,
      versionId: published.version.id,
    });
    // Replies are created strictly in order: each one is the thread's newest.
    await ["02", "03", "04"].reduce<Promise<void>>(async (previous, minute, index) => {
      await previous;
      await first.createReply({
        artifactId: published.artifact.id,
        author,
        body: `reply ${index}`,
        createdAt: `2026-10-01T10:${minute}:00.000Z`,
        id: `rpl_pg_${index}`,
        idempotencyKey: `pg-reply-${index}`,
        projectId: defaultProjectId,
        threadId: thread.thread.id,
      });
    }, Promise.resolve());

    const page = await first.listActivity(query({types: ["comments", "versions"]}));
    expect(page.items.map((row) => row.action.action)).toEqual(["comment_reply", "publish"]);
    expect(page.items[0]?.thread?.replyCount).toBe(3);
    expect(page.items[0]?.thread?.replies.map((reply) => reply.body))
      .toEqual(["reply 1", "reply 2"]);
    expect(page.items[0]?.thread?.state).toBe("needs_you");

    const firstPage = await first.listActivity(query({limit: 1, types: ["comments", "versions"]}));
    const secondPage = await first.listActivity(query({
      cursor: firstPage.nextCursor,
      limit: 1,
      types: ["comments", "versions"],
    }));
    expect([...firstPage.items, ...secondPage.items].map((row) => row.action.id))
      .toEqual(page.items.map((row) => row.action.id));

    expect((await first.listActivity(query({search: "100%"}))).items
      .some((row) => row.artifact?.name === "Stage bar 100%")).toBe(true);
    expect((await first.listActivity(query({search: "%"}))).items
      .every((row) => row.artifact?.name === "Stage bar 100%")).toBe(true);

    const summary = await first.summarizeActivity([]);
    expect(summary).toMatchObject({needsYou: 1, openConversations: 1, withAgent: 0});
  });

  test("ACT-003: Postgres never returns another installation's activity", async () => {
    await publishArtifact(first, "art_pg_a", "Installation A artifact", "2026-10-01T10:00:00.000Z");
    await publishArtifact(second, "art_pg_b", "Installation B artifact", "2026-10-01T10:00:00.000Z");

    const firstFeed = await first.listActivity(query({types: ["versions"]}));
    const secondFeed = await second.listActivity(query({types: ["versions"]}));
    expect(firstFeed.items.map((row) => row.artifact?.name)).toEqual(["Installation A artifact"]);
    expect(secondFeed.items.map((row) => row.artifact?.name)).toEqual(["Installation B artifact"]);

    const firstSummary = await first.summarizeActivity([]);
    expect(firstSummary.projects.map((project) => project.artifactCount)).toEqual([1]);
  });
});
