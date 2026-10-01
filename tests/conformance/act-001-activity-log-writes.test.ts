import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {ApiClient} from "../support/agent-dispatch.js";

const activityRowSchema = z.object({
  accessFrom: z.string().nullable(),
  accessTo: z.string().nullable(),
  action: z.string(),
  actorKind: z.enum(["human", "service"]).nullable(),
  actorName: z.string().nullable(),
  artifactId: z.string().nullable(),
  authorizedByPrincipalId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  detailJson: z.string().nullable(),
  idempotencyKey: z.string(),
  principalId: z.string().nullable(),
  projectId: z.string().nullable(),
  replyId: z.string().nullable(),
  subjectId: z.string().nullable(),
  threadId: z.string().nullable(),
  versionId: z.string().nullable(),
}).strict();
type ActivityRow = z.infer<typeof activityRowSchema>;

const threadCreationSchema = z.object({
  thread: z.object({id: z.string()}).loose(),
}).loose();
const replyCreationSchema = z.object({
  reply: z.object({id: z.string()}).loose(),
}).loose();

describe("the installation activity log records every mutation", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("ACT-001-B: each mutation appends one action with its kind, actor snapshot, thread, reply, subject and access direction", async () => {
    expect.hasAssertions();
    // Artifact kinds.
    const published = await publish("act-001-publish-artifact", "account_required");
    const afterPublish = rowsFor(published.artifact.id);
    expect(afterPublish).toEqual([
      expect.objectContaining({
        action: "publish",
        actorKind: "service",
        actorName: "Local",
        idempotencyKey: "act-001-publish-artifact",
        principalId: "local-api-token",
        versionId: published.version.id,
      }),
    ]);

    // Comment kinds carry the thread and reply they changed.
    const thread = (await expectJson(
      await client.fetch(versionComments(published), {
        body: JSON.stringify({body: "The legend overlaps the axis.", path: "index.html"}),
        idempotencyKey: "act-001-create-thread",
        method: "POST",
      }),
      201,
      threadCreationSchema,
    )).thread;
    const reply = (await expectJson(
      await client.fetch(`${threadPath(published, thread.id)}/replies${scope(published)}`, {
        body: JSON.stringify({body: "Moved the legend below the chart."}),
        idempotencyKey: "act-001-create-reply",
        method: "POST",
      }),
      201,
      replyCreationSchema,
    )).reply;
    await expectJson(await client.fetch(`${threadPath(published, thread.id)}${scope(published)}`, {
      body: JSON.stringify({state: "resolved"}),
      method: "PATCH",
    }), 200, z.object({}).loose());

    const commentRows = rowsFor(published.artifact.id)
      .filter((row) => row.action.startsWith("comment_"));
    expect(commentRows.map((row) => [row.action, row.threadId, row.replyId])).toEqual([
      ["comment_create", thread.id, null],
      ["comment_reply", thread.id, reply.id],
      ["comment_resolve", thread.id, null],
    ]);
    for (const row of commentRows) {
      expect(row).toMatchObject({actorKind: "service", actorName: "Local"});
    }
  });

  function rowsFor(artifactId: string): ActivityRow[] {
    return readRows("WHERE artifact_id = ? ORDER BY created_at, rowid", [artifactId]);
  }

  function readRows(where: string, values: readonly string[]): ActivityRow[] {
    const database = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
      {readOnly: true, timeout: 5_000},
    );
    try {
      return z.array(activityRowSchema).parse(database.prepare(`
        SELECT access_from AS accessFrom, access_to AS accessTo, action,
          actor_kind AS actorKind, actor_name AS actorName,
          artifact_id AS artifactId,
          authorized_by_principal_id AS authorizedByPrincipalId,
          created_at AS createdAt, detail_json AS detailJson,
          idempotency_key AS idempotencyKey, principal_id AS principalId,
          project_id AS projectId, reply_id AS replyId,
          subject_id AS subjectId, thread_id AS threadId,
          version_id AS versionId
        FROM actions ${where}
      `).all(...values));
    } finally {
      database.close();
    }
  }

  async function publish(
    idempotencyKey: string,
    accessSetting: "account_required" | "public_link",
  ): Promise<PublishResponse> {
    return (await publishNew(server, installation, {
      accessSetting,
      content: "<!doctype html><title>Activity</title><p>chart</p>",
      idempotencyKey,
      name: "Quarterly chart",
    })).body;
  }
});

function scope(published: PublishResponse): string {
  return `?projectId=${published.artifact.projectId}`;
}

function versionComments(published: PublishResponse): string {
  return `/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/comments${scope(published)}`;
}

function threadPath(published: PublishResponse, threadId: string): string {
  return `/api/v1/artifacts/${published.artifact.id}/comments/${threadId}`;
}

async function expectJson<Body>(
  response: Response,
  status: number,
  schema: z.ZodType<Body>,
): Promise<Body> {
  const text = await response.text();
  if (response.status !== status) {
    throw new Error(`Expected ${status}, received ${response.status}: ${text}`);
  }
  return schema.parse(text === "" ? null : JSON.parse(text));
}
