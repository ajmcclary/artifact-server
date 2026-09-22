import {createHash} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {defaultProjectId} from "../../src/core/model.js";
import {createManifest} from "../../src/manifest/create-manifest.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";

const previousSchemaVersion = 14;
const installationId = "comment-revision-installation";
const principalId = "principal-comment-revision";
const projectId = defaultProjectId;

function manifestFixture(name: string) {
  const bytes = new TextEncoder().encode(name);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return createManifest({
    entryPath: "index.html",
    files: [{
      mediaType: "text/html",
      path: "index.html",
      sha256,
      size: bytes.byteLength,
    }],
    routingMode: "static",
  });
}

async function publishFixture(
  repository: SqliteArtifactRepository,
  artifactId: string,
  versionId: string,
  idempotencyKey: string,
) {
  const manifest = manifestFixture(`comment-revision-${artifactId}`);
  const uploadId = `upl_${artifactId}`;
  const storageToken = `tok_${artifactId}`;
  const createdAt = "2026-09-21T00:00:00.000Z";
  await repository.createStagedUpload({
    createdAt,
    expiresAt: "2026-09-21T01:00:00.000Z",
    files: manifest.entries.map((entry) => ({
      entry,
      storageToken,
    })),
    id: uploadId,
    idempotencyKey: `${idempotencyKey}-upload`,
    manifest,
    principalId,
    projectId,
  });
  await repository.markStagedFileUploaded(
    projectId,
    uploadId,
    principalId,
    storageToken,
    createdAt,
  );
  const published = await repository.commitNewArtifact({
    accessSetting: "account_required",
    artifactId,
    authorizedByPrincipalId: null,
    contentToken: `content-${artifactId}`,
    createdAt,
    idempotencyKey,
    inputDigest: manifest.digest,
    manifest,
    name: `Comment revision fixture ${artifactId}`,
    principalId,
    projectId,
    source: {
      kind: "staged_upload",
      principalId,
      projectId,
      uploadId,
    },
    tags: [],
    versionId,
  });
  return published;
}

describe("SQLite comment revision", () => {
  let dataDirectory: string;
  let repository: SqliteArtifactRepository;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(
      path.join(tmpdir(), "artifact-comment-revision-"),
    );
    repository = new SqliteArtifactRepository(
      path.join(dataDirectory, "artifact-server.db"),
    );
  });

  afterEach(async () => {
    repository.close();
    await rm(dataDirectory, {force: true, recursive: true});
  });

  test("a fresh artifact starts at revision 0 and returns it on listing", async () => {
    const artifactId = "art_revision_zero";
    await publishFixture(repository, artifactId, "ver_revision_zero", "idem-revision-zero");

    const page = await repository.listThreads({
      artifactId,
      cursor: null,
      dispatched: "exclude",
      limit: 10,
      projectId,
      since: null,
      state: null,
      versionId: null,
    });
    expect(page.items).toHaveLength(0);
    expect(page.revision).toBe(0);
  });

  test("thread create, update, and delete each bump the revision", async () => {
    const artifactId = "art_thread_lifecycle";
    const versionId = "ver_thread_lifecycle";
    const published = await publishFixture(
      repository,
      artifactId,
      versionId,
      "idem-thread-lifecycle",
    );

    const created = await repository.createThread({
      anchor: null,
      artifactId,
      author: {
        authorizedByPrincipalId: null,
        displayName: "Author",
        principalId,
        principalKind: "human",
      },
      body: "First thread.",
      createdAt: "2026-09-21T00:01:00.000Z",
      id: "thread_lifecycle_1",
      idempotencyKey: "idem-thread-lifecycle-1",
      installationId,
      path: null,
      projectId,
      versionId: published.version.id,
    });
    expect(created.replayed).toBe(false);
    expect((await repository.listThreads({
      artifactId,
      cursor: null,
      dispatched: "exclude",
      limit: 10,
      projectId,
      since: null,
      state: null,
      versionId: null,
    })).revision).toBe(1);

    await repository.updateThread({
      anchor: null,
      artifactId,
      authorizedByPrincipalId: null,
      body: "Updated body.",
      principalId,
      projectId,
      state: null,
      threadId: created.thread.id,
      updatedAt: "2026-09-21T00:02:00.000Z",
    });
    expect((await repository.listThreads({
      artifactId,
      cursor: null,
      dispatched: "exclude",
      limit: 10,
      projectId,
      since: null,
      state: null,
      versionId: null,
    })).revision).toBe(2);

    await repository.deleteThread({
      artifactId,
      authorizedByPrincipalId: null,
      deletedAt: "2026-09-21T00:03:00.000Z",
      principalId,
      projectId,
      threadId: created.thread.id,
    });
    expect((await repository.listThreads({
      artifactId,
      cursor: null,
      dispatched: "exclude",
      limit: 10,
      projectId,
      since: null,
      state: null,
      versionId: null,
    })).revision).toBe(3);
  });

  test("reply create, update, and delete each bump the revision", async () => {
    const artifactId = "art_reply_lifecycle";
    const versionId = "ver_reply_lifecycle";
    const published = await publishFixture(
      repository,
      artifactId,
      versionId,
      "idem-reply-lifecycle",
    );
    const thread = await repository.createThread({
      anchor: null,
      artifactId,
      author: {
        authorizedByPrincipalId: null,
        displayName: "Author",
        principalId,
        principalKind: "human",
      },
      body: "Thread for replies.",
      createdAt: "2026-09-21T00:01:00.000Z",
      id: "thread_reply_lifecycle",
      idempotencyKey: "idem-thread-reply-lifecycle",
      installationId,
      path: null,
      projectId,
      versionId: published.version.id,
    });

    const reply = await repository.createReply({
      artifactId,
      author: {
        authorizedByPrincipalId: null,
        displayName: "Replier",
        principalId,
        principalKind: "human",
      },
      body: "First reply.",
      createdAt: "2026-09-21T00:02:00.000Z",
      id: "reply_lifecycle_1",
      idempotencyKey: "idem-reply-lifecycle-1",
      projectId,
      threadId: thread.thread.id,
    });
    expect((await repository.listThreads({
      artifactId,
      cursor: null,
      dispatched: "exclude",
      limit: 10,
      projectId,
      since: null,
      state: null,
      versionId: null,
    })).revision).toBe(2);

    await repository.updateReply({
      artifactId,
      authorizedByPrincipalId: null,
      body: "Updated reply.",
      principalId,
      projectId,
      replyId: reply.reply.id,
      threadId: thread.thread.id,
      updatedAt: "2026-09-21T00:03:00.000Z",
    });
    expect((await repository.listThreads({
      artifactId,
      cursor: null,
      dispatched: "exclude",
      limit: 10,
      projectId,
      since: null,
      state: null,
      versionId: null,
    })).revision).toBe(3);

    await repository.deleteReply({
      artifactId,
      authorizedByPrincipalId: null,
      deletedAt: "2026-09-21T00:04:00.000Z",
      principalId,
      projectId,
      replyId: reply.reply.id,
      threadId: thread.thread.id,
    });
    expect((await repository.listThreads({
      artifactId,
      cursor: null,
      dispatched: "exclude",
      limit: 10,
      projectId,
      since: null,
      state: null,
      versionId: null,
    })).revision).toBe(4);
  });

  test("clearThreads bumps once when threads are deleted", async () => {
    const artifactId = "art_clear_threads";
    const versionId = "ver_clear_threads";
    const published = await publishFixture(
      repository,
      artifactId,
      versionId,
      "idem-clear-threads",
    );
    await repository.createThread({
      anchor: null,
      artifactId,
      author: {
        authorizedByPrincipalId: null,
        displayName: "Author",
        principalId,
        principalKind: "human",
      },
      body: "Thread A.",
      createdAt: "2026-09-21T00:01:00.000Z",
      id: "thread_clear_a",
      idempotencyKey: "idem-clear-a",
      installationId,
      path: null,
      projectId,
      versionId: published.version.id,
    });
    await repository.createThread({
      anchor: null,
      artifactId,
      author: {
        authorizedByPrincipalId: null,
        displayName: "Author",
        principalId,
        principalKind: "human",
      },
      body: "Thread B.",
      createdAt: "2026-09-21T00:02:00.000Z",
      id: "thread_clear_b",
      idempotencyKey: "idem-clear-b",
      installationId,
      path: null,
      projectId,
      versionId: published.version.id,
    });
    expect((await repository.listThreads({
      artifactId,
      cursor: null,
      dispatched: "exclude",
      limit: 10,
      projectId,
      since: null,
      state: null,
      versionId: null,
    })).revision).toBe(2);

    const cleared = await repository.clearThreads({
      artifactId,
      authorizedByPrincipalId: null,
      clearedAt: "2026-09-21T00:03:00.000Z",
      principalId,
      projectId,
      scope: "all",
      versionId: null,
    });
    expect(cleared.deleted).toBe(2);
    expect((await repository.listThreads({
      artifactId,
      cursor: null,
      dispatched: "exclude",
      limit: 10,
      projectId,
      since: null,
      state: null,
      versionId: null,
    })).revision).toBe(3);

    await repository.createThread({
      anchor: null,
      artifactId,
      author: {
        authorizedByPrincipalId: null,
        displayName: "Author",
        principalId,
        principalKind: "human",
      },
      body: "Thread C.",
      createdAt: "2026-09-21T00:04:00.000Z",
      id: "thread_clear_c",
      idempotencyKey: "idem-clear-c",
      installationId,
      path: null,
      projectId,
      versionId: published.version.id,
    });
    const skippedClear = await repository.clearThreads({
      artifactId,
      authorizedByPrincipalId: null,
      clearedAt: "2026-09-21T00:05:00.000Z",
      principalId,
      projectId,
      scope: "resolved",
      versionId: null,
    });
    expect(skippedClear.deleted).toBe(0);
    expect((await repository.listThreads({
      artifactId,
      cursor: null,
      dispatched: "exclude",
      limit: 10,
      projectId,
      since: null,
      state: null,
      versionId: null,
    })).revision).toBe(4);
  });

  test("dispatch link and unlink each bump the revision", async () => {
    const artifactId = "art_dispatch_revision";
    const versionId = "ver_dispatch_revision";
    const published = await publishFixture(
      repository,
      artifactId,
      versionId,
      "idem-dispatch-revision",
    );
    const thread = await repository.createThread({
      anchor: null,
      artifactId,
      author: {
        authorizedByPrincipalId: null,
        displayName: "Author",
        principalId,
        principalKind: "human",
      },
      body: "Thread to dispatch.",
      createdAt: "2026-09-21T00:01:00.000Z",
      id: "thread_dispatch_revision",
      idempotencyKey: "idem-dispatch-thread",
      installationId,
      path: null,
      projectId,
      versionId: published.version.id,
    });
    expect((await repository.listThreads({
      artifactId,
      cursor: null,
      dispatched: "exclude",
      limit: 10,
      projectId,
      since: null,
      state: null,
      versionId: null,
    })).revision).toBe(1);

    await repository.registerAgent({
      agentSessionId: null,
      capabilities: {beacon: false, evidence: "native"},
      connectionKey: "agent-connection-revision",
      displayName: "Test Agent",
      id: "agent_revision",
      installationId,
      kind: "test-agent",
      principalId,
      registeredAt: "2026-09-21T00:00:00.000Z",
      workingDirectory: "/tmp",
    });

    const dispatch = await repository.createDispatch({
      agentDisplayName: "Test Agent",
      agentId: "agent_revision",
      createdAt: "2026-09-21T00:02:00.000Z",
      id: "dispatch_revision",
      idempotencyKey: "idem-dispatch-create",
      installationId,
      note: null,
      projectId,
      sender: {
        authorizedByPrincipalId: null,
        displayName: "Sender",
        principalId,
        principalKind: "human",
      },
      threadIds: [thread.thread.id],
    });
    expect(dispatch.replayed).toBe(false);
    expect((await repository.listThreads({
      artifactId,
      cursor: null,
      dispatched: "exclude",
      limit: 10,
      projectId,
      since: null,
      state: null,
      versionId: null,
    })).revision).toBe(2);

    await repository.cancelDispatch({
      canceledAt: "2026-09-21T00:03:00.000Z",
      dispatchId: dispatch.dispatch.id,
      installationId,
      projectId,
    });
    expect((await repository.listThreads({
      artifactId,
      cursor: null,
      dispatched: "exclude",
      limit: 10,
      projectId,
      since: null,
      state: null,
      versionId: null,
    })).revision).toBe(3);
  });

  test("a previous-schema database upgrades and starts revision at 0", async () => {
    const databasePath = path.join(dataDirectory, "legacy-artifact-server.db");
    repository.close();

    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          installation_id TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          archived_at TEXT
        ) STRICT;
        INSERT INTO projects (id, installation_id, name, created_at, archived_at)
          VALUES ('${defaultProjectId}', '${installationId}', 'Default', '2026-01-01T00:00:00.000Z', NULL);
        CREATE TABLE artifacts (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          name TEXT NOT NULL,
          search_name TEXT NOT NULL,
          access_setting TEXT NOT NULL CHECK (access_setting IN ('account_required', 'public_link')),
          current_version_id TEXT,
          created_at TEXT NOT NULL,
          deleted_at TEXT
        ) STRICT;
        INSERT INTO artifacts (
          id, project_id, name, search_name, access_setting,
          current_version_id, created_at, deleted_at
        ) VALUES (
          'art_legacy_revision', '${defaultProjectId}', 'Legacy',
          'legacy', 'account_required', NULL,
          '2026-01-01T00:00:00.000Z', NULL
        );
        PRAGMA user_version = ${previousSchemaVersion};
      `);
    } finally {
      legacy.close();
    }

    repository = new SqliteArtifactRepository(databasePath);
    const page = await repository.listThreads({
      artifactId: "art_legacy_revision",
      cursor: null,
      dispatched: "exclude",
      limit: 10,
      projectId,
      since: null,
      state: null,
      versionId: null,
    });
    expect(page.revision).toBe(0);
  });
});
