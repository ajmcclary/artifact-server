import {createHash, randomUUID} from "node:crypto";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {defaultProjectId} from "../../src/core/model.js";
import {createManifest} from "../../src/manifest/create-manifest.js";
import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";

const principalId = "principal-comment-dispatch";
const projectId = defaultProjectId;

function readDatabaseUrl(): string {
  const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  if (databaseUrl === undefined) {
    throw new Error("Run this test through pnpm test:external-storage-runtime.");
  }
  return databaseUrl;
}

function manifestFixture(content: string) {
  const bytes = new TextEncoder().encode(content);
  return createManifest({
    entryPath: "index.html",
    files: [{
      mediaType: "text/html",
      path: "index.html",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    }],
    routingMode: "static",
  });
}

async function prepareUpload(
  repository: PostgresArtifactRepository,
  uploadId: string,
  manifest: ReturnType<typeof manifestFixture>,
): Promise<void> {
  const createdAt = "2026-09-21T00:00:00.000Z";
  const storageToken = `tok_${uploadId}`;
  await repository.createStagedUpload({
    createdAt,
    expiresAt: "2099-12-31T00:00:00.000Z",
    files: manifest.entries.map((entry) => ({entry, storageToken})),
    id: uploadId,
    idempotencyKey: null,
    manifest,
    principalId,
    projectId,
  });
  await repository.markStagedFileUploaded(projectId, uploadId, principalId, storageToken, createdAt);
  const claim = await repository.claimUploadPreparation(uploadId, createdAt, "2099-12-30T00:00:00.000Z");
  if (claim === null) throw new Error("The fixture upload could not be claimed.");
  await repository.recordStagedFileInstalled(uploadId, storageToken, claim.attempts, createdAt);
  await repository.writePreparedManifestEntries(uploadId, claim.attempts, manifest.entries);
  await repository.markUploadPrepared(uploadId, claim.attempts, createdAt);
}

function commitPrepared(
  repository: PostgresArtifactRepository,
  artifactId: string,
  uploadId: string,
  manifest: ReturnType<typeof manifestFixture>,
) {
  return repository.commitNewArtifact({
    accessSetting: "account_required",
    actor: {displayName: "Test publisher", kind: "service"},
    artifactId,
    authorizedByPrincipalId: null,
    contentToken: `content-${artifactId}`,
    createdAt: "2026-09-21T00:00:30.000Z",
    idempotencyKey: `publish-${artifactId}`,
    inputDigest: manifest.digest,
    manifest,
    name: `Fixture ${artifactId}`,
    principalId,
    projectId,
    source: {kind: "staged_upload", principalId, projectId, uploadId},
    tags: [],
    versionId: `ver_${artifactId}`,
  });
}

async function publishFixture(repository: PostgresArtifactRepository, artifactId: string) {
  const manifest = manifestFixture(`<!doctype html><title>${artifactId}</title>`);
  await prepareUpload(repository, `upl_${artifactId}`, manifest);
  return commitPrepared(repository, artifactId, `upl_${artifactId}`, manifest);
}

function createThread(
  repository: PostgresArtifactRepository,
  installationId: string,
  artifactId: string,
  versionId: string,
  threadId: string,
) {
  return repository.createThread({
    anchor: null,
    artifactId,
    author: {
      authorizedByPrincipalId: null,
      displayName: "Author",
      principalId,
      principalKind: "human",
    },
    body: `Thread ${threadId}.`,
    createdAt: "2026-09-21T00:01:00.000Z",
    id: threadId,
    idempotencyKey: `idem-${threadId}`,
    installationId,
    path: null,
    projectId,
    versionId,
  });
}

function registerAgent(
  repository: PostgresArtifactRepository,
  installationId: string,
  agentId: string,
) {
  return repository.registerAgent({
    agentSessionId: null,
    capabilities: {beacon: false, evidence: "native"},
    connectionKey: `connection-${agentId}`,
    displayName: "Test Agent",
    id: agentId,
    installationId,
    kind: "test-agent",
    principalId,
    registeredAt: "2026-09-21T00:00:00.000Z",
    workingDirectory: "/tmp",
  });
}

function sendDispatch(
  repository: PostgresArtifactRepository,
  installationId: string,
  agentId: string,
  dispatchId: string,
  threadIds: readonly string[],
) {
  return repository.createDispatch({
    agentDisplayName: "Test Agent",
    agentId,
    createdAt: "2026-09-21T00:02:00.000Z",
    id: dispatchId,
    idempotencyKey: `idem-${dispatchId}`,
    installationId,
    note: null,
    projectId,
    sender: {
      authorizedByPrincipalId: null,
      displayName: "Sender",
      principalId,
      principalKind: "human",
    },
    threadIds,
  });
}

/** Sessions in the scratch database currently waiting on a lock. */
function lockWaiters(observer: PostgresDatabase): Promise<number> {
  return observer.run(Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{waiting: number}>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    return rows[0]?.waiting ?? 0;
  }));
}

describe("Postgres comment dispatch", () => {
  let scratch: string;
  let scratchUrl: string;
  let maintenance: PostgresDatabase;
  let database: PostgresDatabase;
  let installationId: string;
  let repository: PostgresArtifactRepository;
  const extraDatabases: PostgresDatabase[] = [];

  beforeEach(async () => {
    scratch = `artifact_dispatch_${randomUUID().replaceAll("-", "")}`;
    maintenance = await PostgresDatabase.inspect({url: Redacted.make(readDatabaseUrl())});
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`CREATE DATABASE ${scratch}`);
    }));
    const url = new URL(readDatabaseUrl());
    url.pathname = `/${scratch}`;
    scratchUrl = url.toString();
    database = await PostgresDatabase.open({url: Redacted.make(scratchUrl)}, "apply");
    installationId = `test-dispatch-${randomUUID()}`;
    repository = await PostgresArtifactRepository.open(database, installationId);
  });

  afterEach(async () => {
    await Promise.all(extraDatabases.splice(0).map((extra) => extra.close()));
    await database.close();
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    }));
    await maintenance.close();
  });

  async function connect(): Promise<PostgresDatabase> {
    const extra = await PostgresDatabase.inspect({url: Redacted.make(scratchUrl)});
    extraDatabases.push(extra);
    return extra;
  }

  test("CMT-023 regression: a lazy agent_unavailable failure bumps the Postgres revision and releases the thread", async () => {
    const published = await publishFixture(repository, "art_lazy_failure");
    const thread = await createThread(
      repository,
      installationId,
      "art_lazy_failure",
      published.version.id,
      "thread_lazy_failure",
    );
    await registerAgent(repository, installationId, "agent_lazy_failure");
    const dispatch = await sendDispatch(
      repository,
      installationId,
      "agent_lazy_failure",
      "dispatch_lazy_failure",
      [thread.thread.id],
    );
    const listing = () => repository.listThreads({
      artifactId: "art_lazy_failure",
      cursor: null,
      dispatched: "exclude",
      limit: 10,
      projectId,
      since: null,
      state: null,
      versionId: null,
    });
    const dispatched = await listing();
    expect(dispatched.items).toHaveLength(0);

    // The agent has not polled for longer than the staleness window.
    expect(await repository.findDispatch(
      installationId,
      dispatch.dispatch.id,
      "2026-09-21T01:00:00.000Z",
    )).toMatchObject({failureReason: "agent_unavailable", state: "failed"});
    const released = await listing();
    expect(released.revision).toBe(dispatched.revision + 1);
    expect(released.items.map((item) => item.id)).toEqual([thread.thread.id]);
  });

  test("DSP-003 regression: overlapping bundles sent in opposite orders serialize without a deadlock", async () => {
    const published = await publishFixture(repository, "art_lock_order");
    const first = await createThread(repository, installationId, "art_lock_order", published.version.id, "thread_a");
    const second = await createThread(repository, installationId, "art_lock_order", published.version.id, "thread_b");
    await registerAgent(repository, installationId, "agent_lock_order");
    const replicaOne = await PostgresArtifactRepository.open(await connect(), installationId);
    const replicaTwo = await PostgresArtifactRepository.open(await connect(), installationId);
    const lockHolder = await connect();
    const observer = await connect();

    const release = Promise.withResolvers<void>();
    const locked = Promise.withResolvers<void>();
    const holding = lockHolder.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.withTransaction(Effect.gen(function*() {
        yield* sql.unsafe(
          "SELECT id FROM comment_threads WHERE installation_id = $1 AND id = $2 FOR UPDATE",
          [installationId, first.thread.id],
        );
        locked.resolve();
        yield* Effect.promise(() => release.promise);
      }));
    }));
    await locked.promise;
    const forward = sendDispatch(
      replicaOne,
      installationId,
      "agent_lock_order",
      "dispatch_forward",
      [first.thread.id, second.thread.id],
    );
    await expect.poll(() => lockWaiters(observer), {timeout: 10_000}).toBe(1);
    const reverse = sendDispatch(
      replicaTwo,
      installationId,
      "agent_lock_order",
      "dispatch_reverse",
      [second.thread.id, first.thread.id],
    );
    await expect.poll(() => lockWaiters(observer), {timeout: 10_000}).toBe(2);
    release.resolve();
    await holding;

    const results = await Promise.allSettled([forward, reverse]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    const refused = results[1];
    expect(refused?.status === "rejected" ? refused.reason : null)
      .toMatchObject({_tag: "InvalidDispatch"});
  });

  test("SEC-002 regression: clearing threads ignores another installation's dispatch with the same id", async () => {
    const otherInstallationId = `test-dispatch-other-${randomUUID()}`;
    const other = await PostgresArtifactRepository.open(database, otherInstallationId);
    const published = await publishFixture(repository, "art_clear_isolation");
    const otherPublished = await publishFixture(other, "art_clear_isolation");
    const held = await createThread(
      repository,
      installationId,
      "art_clear_isolation",
      published.version.id,
      "thread_held",
    );
    const otherThread = await createThread(
      other,
      otherInstallationId,
      "art_clear_isolation",
      otherPublished.version.id,
      "thread_other",
    );
    await registerAgent(repository, installationId, "agent_clear");
    await registerAgent(other, otherInstallationId, "agent_clear");
    await sendDispatch(repository, installationId, "agent_clear", "dispatch_shared_id", [held.thread.id]);
    await sendDispatch(other, otherInstallationId, "agent_clear", "dispatch_shared_id", [otherThread.thread.id]);
    await other.cancelDispatch({
      canceledAt: "2026-09-21T00:03:00.000Z",
      dispatchId: "dispatch_shared_id",
      installationId: otherInstallationId,
      projectId,
    });

    const command = {
      actor: {displayName: "Clearer", kind: "human" as const},
      artifactId: "art_clear_isolation",
      authorizedByPrincipalId: null,
      clearedAt: "2026-09-21T00:04:00.000Z",
      principalId,
      projectId,
      scope: "all" as const,
      versionId: null,
    };
    expect(await repository.clearThreads(command)).toEqual({deleted: 0, skippedDispatched: 1});
    expect(await repository.findThread(projectId, "art_clear_isolation", held.thread.id))
      .not.toBeNull();
  });

  test("SEC-002 regression: committing one installation's upload leaves another installation's prepared entries", async () => {
    const otherInstallationId = `test-dispatch-other-${randomUUID()}`;
    const other = await PostgresArtifactRepository.open(database, otherInstallationId);
    const manifest = manifestFixture("<!doctype html><title>shared upload id</title>");
    const otherManifest = manifestFixture("<!doctype html><title>other installation</title>");
    await prepareUpload(repository, "upl_shared_id", manifest);
    await prepareUpload(other, "upl_shared_id", otherManifest);

    await commitPrepared(repository, "art_shared_upload", "upl_shared_id", manifest);
    expect(await repository.countPreparedManifestEntries("upl_shared_id")).toBe(0);
    expect(await other.countPreparedManifestEntries("upl_shared_id")).toBe(1);
    const committed = await commitPrepared(other, "art_shared_upload", "upl_shared_id", otherManifest);
    expect(committed.version.manifestDigest).toBe(otherManifest.digest);
  });
});
