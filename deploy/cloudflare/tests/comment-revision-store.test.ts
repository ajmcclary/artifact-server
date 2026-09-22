import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";
import {getPlatformProxy} from "wrangler";

import {defaultProjectId} from "../../../src/core/model.js";
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

const installationId = "d1-comment-revision-installation";
const principalId = "principal-d1-comment-revision";
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
  store: ReturnType<typeof createD1ArtifactRepository>,
  artifactId: string,
  versionId: string,
  idempotencyKey: string,
) {
  const manifest = manifestFixture(`d1-comment-revision-${artifactId}`);
  const uploadId = `upl_d1_${artifactId}`;
  const storageToken = `tok_d1_${artifactId}`;
  const createdAt = "2026-09-21T00:00:00.000Z";
  await store.createStagedUpload({
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
  await store.markStagedFileUploaded(
    projectId,
    uploadId,
    principalId,
    storageToken,
    createdAt,
  );
  return store.commitNewArtifact({
    accessSetting: "account_required",
    artifactId,
    authorizedByPrincipalId: null,
    contentToken: `content-d1-${artifactId}`,
    createdAt,
    idempotencyKey,
    inputDigest: manifest.digest,
    manifest,
    name: `D1 comment revision fixture ${artifactId}`,
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
}

describe("D1 comment revision", () => {
  it("starts at 0 and bumps on thread create, update, and delete", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    try {
      await migrateD1(binding, installationId);
      const store = createD1ArtifactRepository(binding, installationId);
      const artifactId = "art_d1_revision";
      const published = await publishFixture(
        store,
        artifactId,
        "ver_d1_revision",
        "idem-d1-revision",
      );

      const empty = await store.listThreads({
        artifactId,
        cursor: null,
        dispatched: "exclude",
        limit: 10,
        projectId,
        since: null,
        state: null,
        versionId: null,
      });
      expect(empty.revision).toBe(0);

      const thread = await store.createThread({
        anchor: null,
        artifactId,
        author: {
          authorizedByPrincipalId: null,
          displayName: "Author",
          principalId,
          principalKind: "human",
        },
        body: "First D1 thread.",
        createdAt: "2026-09-21T00:01:00.000Z",
        id: "thread_d1_revision",
        idempotencyKey: "idem-d1-thread",
        installationId,
        path: null,
        projectId,
        versionId: published.version.id,
      });
      expect((await store.listThreads({
        artifactId,
        cursor: null,
        dispatched: "exclude",
        limit: 10,
        projectId,
        since: null,
        state: null,
        versionId: null,
      })).revision).toBe(1);

      await store.updateThread({
        anchor: null,
        artifactId,
        authorizedByPrincipalId: null,
        body: "Updated D1 thread.",
        principalId,
        projectId,
        state: null,
        threadId: thread.thread.id,
        updatedAt: "2026-09-21T00:02:00.000Z",
      });
      expect((await store.listThreads({
        artifactId,
        cursor: null,
        dispatched: "exclude",
        limit: 10,
        projectId,
        since: null,
        state: null,
        versionId: null,
      })).revision).toBe(2);

      await store.deleteThread({
        artifactId,
        authorizedByPrincipalId: null,
        deletedAt: "2026-09-21T00:03:00.000Z",
        principalId,
        projectId,
        threadId: thread.thread.id,
      });
      expect((await store.listThreads({
        artifactId,
        cursor: null,
        dispatched: "exclude",
        limit: 10,
        projectId,
        since: null,
        state: null,
        versionId: null,
      })).revision).toBe(3);
    } finally {
      await proxy.dispose();
    }
  });

  it("bumps on reply create, update, and delete", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    try {
      await migrateD1(binding, installationId);
      const store = createD1ArtifactRepository(binding, installationId);
      const artifactId = "art_d1_reply_revision";
      const published = await publishFixture(
        store,
        artifactId,
        "ver_d1_reply_revision",
        "idem-d1-reply-revision",
      );
      const thread = await store.createThread({
        anchor: null,
        artifactId,
        author: {
          authorizedByPrincipalId: null,
          displayName: "Author",
          principalId,
          principalKind: "human",
        },
        body: "D1 thread for replies.",
        createdAt: "2026-09-21T00:01:00.000Z",
        id: "thread_d1_reply_revision",
        idempotencyKey: "idem-d1-reply-thread",
        installationId,
        path: null,
        projectId,
        versionId: published.version.id,
      });

      const reply = await store.createReply({
        artifactId,
        author: {
          authorizedByPrincipalId: null,
          displayName: "Replier",
          principalId,
          principalKind: "human",
        },
        body: "D1 reply.",
        createdAt: "2026-09-21T00:02:00.000Z",
        id: "reply_d1_revision",
        idempotencyKey: "idem-d1-reply",
        projectId,
        threadId: thread.thread.id,
      });
      expect((await store.listThreads({
        artifactId,
        cursor: null,
        dispatched: "exclude",
        limit: 10,
        projectId,
        since: null,
        state: null,
        versionId: null,
      })).revision).toBe(2);

      await store.updateReply({
        artifactId,
        authorizedByPrincipalId: null,
        body: "Updated D1 reply.",
        principalId,
        projectId,
        replyId: reply.reply.id,
        threadId: thread.thread.id,
        updatedAt: "2026-09-21T00:03:00.000Z",
      });
      expect((await store.listThreads({
        artifactId,
        cursor: null,
        dispatched: "exclude",
        limit: 10,
        projectId,
        since: null,
        state: null,
        versionId: null,
      })).revision).toBe(3);

      await store.deleteReply({
        artifactId,
        authorizedByPrincipalId: null,
        deletedAt: "2026-09-21T00:04:00.000Z",
        principalId,
        projectId,
        replyId: reply.reply.id,
        threadId: thread.thread.id,
      });
      expect((await store.listThreads({
        artifactId,
        cursor: null,
        dispatched: "exclude",
        limit: 10,
        projectId,
        since: null,
        state: null,
        versionId: null,
      })).revision).toBe(4);
    } finally {
      await proxy.dispose();
    }
  });

  it("bumps once on clearThreads and on dispatch link/unlink", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    try {
      await migrateD1(binding, installationId);
      const store = createD1ArtifactRepository(binding, installationId);
      const artifactId = "art_d1_clear_dispatch";
      const published = await publishFixture(
        store,
        artifactId,
        "ver_d1_clear_dispatch",
        "idem-d1-clear-dispatch",
      );
      await store.createThread({
        anchor: null,
        artifactId,
        author: {
          authorizedByPrincipalId: null,
          displayName: "Author",
          principalId,
          principalKind: "human",
        },
        body: "D1 thread A.",
        createdAt: "2026-09-21T00:01:00.000Z",
        id: "thread_d1_clear_a",
        idempotencyKey: "idem-d1-clear-a",
        installationId,
        path: null,
        projectId,
        versionId: published.version.id,
      });
      await store.createThread({
        anchor: null,
        artifactId,
        author: {
          authorizedByPrincipalId: null,
          displayName: "Author",
          principalId,
          principalKind: "human",
        },
        body: "D1 thread B.",
        createdAt: "2026-09-21T00:02:00.000Z",
        id: "thread_d1_clear_b",
        idempotencyKey: "idem-d1-clear-b",
        installationId,
        path: null,
        projectId,
        versionId: published.version.id,
      });
      expect((await store.listThreads({
        artifactId,
        cursor: null,
        dispatched: "exclude",
        limit: 10,
        projectId,
        since: null,
        state: null,
        versionId: null,
      })).revision).toBe(2);

      const cleared = await store.clearThreads({
        artifactId,
        authorizedByPrincipalId: null,
        clearedAt: "2026-09-21T00:03:00.000Z",
        principalId,
        projectId,
        scope: "all",
        versionId: null,
      });
      expect(cleared.deleted).toBe(2);
      expect((await store.listThreads({
        artifactId,
        cursor: null,
        dispatched: "exclude",
        limit: 10,
        projectId,
        since: null,
        state: null,
        versionId: null,
      })).revision).toBe(3);

      const thread = await store.createThread({
        anchor: null,
        artifactId,
        author: {
          authorizedByPrincipalId: null,
          displayName: "Author",
          principalId,
          principalKind: "human",
        },
        body: "D1 thread to dispatch.",
        createdAt: "2026-09-21T00:04:00.000Z",
        id: "thread_d1_dispatch",
        idempotencyKey: "idem-d1-dispatch-thread",
        installationId,
        path: null,
        projectId,
        versionId: published.version.id,
      });
      expect((await store.listThreads({
        artifactId,
        cursor: null,
        dispatched: "exclude",
        limit: 10,
        projectId,
        since: null,
        state: null,
        versionId: null,
      })).revision).toBe(4);

      await store.registerAgent({
        agentSessionId: null,
        capabilities: {beacon: false, evidence: "native"},
        connectionKey: "agent-d1-revision",
        displayName: "D1 Agent",
        id: "agent_d1_revision",
        installationId,
        kind: "test-agent",
        principalId,
        registeredAt: "2026-09-21T00:00:00.000Z",
        workingDirectory: "/tmp",
      });

      const dispatch = await store.createDispatch({
        agentDisplayName: "D1 Agent",
        agentId: "agent_d1_revision",
        createdAt: "2026-09-21T00:05:00.000Z",
        id: "dispatch_d1_revision",
        idempotencyKey: "idem-d1-dispatch",
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
      expect((await store.listThreads({
        artifactId,
        cursor: null,
        dispatched: "exclude",
        limit: 10,
        projectId,
        since: null,
        state: null,
        versionId: null,
      })).revision).toBe(5);

      await store.cancelDispatch({
        canceledAt: "2026-09-21T00:06:00.000Z",
        dispatchId: dispatch.dispatch.id,
        installationId,
        projectId,
      });
      expect((await store.listThreads({
        artifactId,
        cursor: null,
        dispatched: "exclude",
        limit: 10,
        projectId,
        since: null,
        state: null,
        versionId: null,
      })).revision).toBe(6);
    } finally {
      await proxy.dispose();
    }
  });
});
