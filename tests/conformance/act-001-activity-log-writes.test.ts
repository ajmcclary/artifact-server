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
import {ApiClient, signInAdministrator} from "../support/agent-dispatch.js";

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

/** The administrator request bodies this test sends: strings and string lists. */
type AdminRequestBody = Readonly<Record<string, string | readonly string[]>>;

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

    // Access changes record direction; a public-link companion appears only
    // when the artifact moves into or out of public-link access.
    await expectJson(await client.fetch(
      `/api/v1/artifacts/${published.artifact.id}/access${scope(published)}`,
      {
        body: JSON.stringify({
          accessSetting: "public_link",
          expectedCurrentVersionId: published.version.id,
        }),
        idempotencyKey: "act-001-make-public",
        method: "PATCH",
      },
    ), 200, z.object({}).loose());
    await expectJson(await client.fetch(
      `/api/v1/artifacts/${published.artifact.id}/access${scope(published)}`,
      {
        body: JSON.stringify({
          accessSetting: "account_required",
          expectedCurrentVersionId: published.version.id,
        }),
        idempotencyKey: "act-001-make-private",
        method: "PATCH",
      },
    ), 200, z.object({}).loose());
    const accessRows = rowsFor(published.artifact.id).filter((row) =>
      row.action === "change_access" || row.action.startsWith("public_link_")
    );
    expect(accessRows.map((row) => [row.action, row.accessFrom, row.accessTo, row.idempotencyKey]))
      .toEqual([
        ["change_access", "account_required", "public_link", "act-001-make-public"],
        ["public_link_enable", "account_required", "public_link", "act-001-make-public:public_link"],
        ["change_access", "public_link", "account_required", "act-001-make-private"],
        ["public_link_disable", "public_link", "account_required", "act-001-make-private:public_link"],
      ]);

    const publicFromStart = await publish("act-001-public-publish", "public_link");
    expect(rowsFor(publicFromStart.artifact.id).map((row) => [row.action, row.accessFrom, row.accessTo]))
      .toEqual([
        ["publish", null, null],
        ["public_link_enable", null, "public_link"],
      ]);

    // Administration: a human administrator admits, issues, rotates and
    // revokes; the rows carry that administrator and name their subject.
    const cookies = await signInAdministrator(server, installation);
    const administratorId = await sessionPrincipalId(cookies.header);
    const admitted = (await expectJson(
      await adminFetch(cookies, "/api/v1/members", "POST", {displayName: "Dana Okonkwo", email: "dana@example.test"}),
      201,
      z.object({member: z.object({id: z.string()})}),
    )).member;
    const issued = (await expectJson(
      await adminFetch(cookies, "/api/v1/api-keys", "POST", {
        capabilities: ["artifact:read"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        name: "Release key",
      }),
      201,
      z.object({apiKey: z.object({id: z.string()})}),
    )).apiKey;
    const rotated = (await expectJson(
      await adminFetch(cookies, `/api/v1/api-keys/${issued.id}/rotate`, "POST"),
      201,
      z.object({apiKey: z.object({id: z.string()})}),
    )).apiKey;
    await expectJson(await adminFetch(cookies, `/api/v1/api-keys/${rotated.id}/revoke`, "POST"), 200, z.object({}).loose());
    await expectJson(await adminFetch(cookies, `/api/v1/members/${admitted.id}/deactivate`, "POST"), 200, z.object({}).loose());
    const projectId = await client.createProject("Claims workstation", "act-001-claims-project");
    await expectJson(await client.fetch(`/api/v1/projects/${projectId}/archive`, {method: "POST"}), 200, z.object({}).loose());
    await expectJson(await client.fetch(`/api/v1/projects/${projectId}/unarchive`, {method: "POST"}), 200, z.object({}).loose());

    const administration = readRows(
      "WHERE action LIKE 'member\\_%' ESCAPE '\\' OR action LIKE 'key\\_%' ESCAPE '\\' OR action LIKE 'project\\_%' ESCAPE '\\' ORDER BY created_at, rowid",
      [],
    );
    // The local owner admitted themself at sign-in: an "owner" row with no actor.
    expect(administration[0]).toMatchObject({
      action: "member_admit",
      actorName: null,
      principalId: null,
      subjectId: administratorId,
    });
    expect(JSON.parse(administration[0]?.detailJson ?? "null")).toMatchObject({how: "owner"});
    expect(administration.slice(1).map((row) => [row.action, row.subjectId, row.principalId, row.projectId]))
      .toEqual([
        ["member_admit", admitted.id, administratorId, null],
        ["key_issue", issued.id, administratorId, null],
        ["key_rotate", rotated.id, administratorId, null],
        ["key_revoke", rotated.id, administratorId, null],
        ["member_deactivate", admitted.id, administratorId, null],
        ["project_create", projectId, "local-api-token", projectId],
        ["project_archive", projectId, "local-api-token", projectId],
        ["project_unarchive", projectId, "local-api-token", projectId],
      ]);
    expect(JSON.parse(administration[1]?.detailJson ?? "null"))
      .toEqual({how: "manual", role: "member", subjectName: "Dana Okonkwo"});
    expect(JSON.parse(administration[2]?.detailJson ?? "null")).toMatchObject({
      capabilities: ["artifact:read"],
      how: "administrator",
      subjectName: "Release key",
    });
    expect(JSON.parse(administration[6]?.detailJson ?? "null"))
      .toEqual({subjectName: "Claims workstation"});

    // Dispatch: the installation credential registers itself as an agent, so
    // its reply on a held thread is the agent answering.
    const agent = await client.registerAgent({
      connectionKey: "act-001-agent",
      displayName: "site",
      workingDirectory: "/work/site",
    });
    const heldThread = await client.openThread(published, "Check the totals row.", "act-001-held-thread");
    const dispatch = (await expectJson(
      await client.sendDispatch({
        agentId: agent.id,
        idempotencyKey: "act-001-dispatch",
        projectId: published.artifact.projectId,
        threadIds: [heldThread.id],
      }),
      201,
      z.object({dispatch: z.object({id: z.string()}).loose()}).loose(),
    )).dispatch;
    // Two agent replies in order: only the first records the answer.
    const agentReply = async (key: string) => expectJson(
      await client.fetch(`${threadPath(published, heldThread.id)}/replies${scope(published)}`, {
        body: JSON.stringify({body: `Answered (${key}).`}),
        idempotencyKey: key,
        method: "POST",
      }),
      201,
      z.object({}).loose(),
    );
    await agentReply("act-001-agent-reply-1");
    await agentReply("act-001-agent-reply-2");
    const dispatchRows = readRows(
      "WHERE action LIKE 'dispatch\\_%' ESCAPE '\\' ORDER BY created_at, rowid",
      [],
    );
    expect(dispatchRows.map((row) => [row.action, row.subjectId, row.projectId, row.artifactId, row.threadId]))
      .toEqual([
        ["dispatch_create", dispatch.id, published.artifact.projectId, null, null],
        ["dispatch_addressed", dispatch.id, published.artifact.projectId, null, heldThread.id],
      ]);
    expect(JSON.parse(dispatchRows[0]?.detailJson ?? "null"))
      .toEqual({agentId: agent.id, subjectName: "site"});
  });

  test("ACT-001-F: replays and no-op administration write nothing, and a refused action rolls its mutation back", async () => {
    expect.hasAssertions();
    const published = await publish("act-001-f-publish-artifact", "account_required");
    await publish("act-001-f-publish-artifact", "account_required");
    expect(readRows("WHERE idempotency_key LIKE 'act-001-f-publish-artifact%'", [])).toHaveLength(1);

    const cookies = await signInAdministrator(server, installation);
    const issued = (await expectJson(
      await adminFetch(cookies, "/api/v1/api-keys", "POST", {
        capabilities: ["artifact:read"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        name: "Short-lived key",
      }),
      201,
      z.object({apiKey: z.object({id: z.string()})}),
    )).apiKey;
    await expectJson(await adminFetch(cookies, `/api/v1/api-keys/${issued.id}/revoke`, "POST"), 200, z.object({}).loose());
    await expectJson(await adminFetch(cookies, `/api/v1/api-keys/${issued.id}/revoke`, "POST"), 200, z.object({}).loose());
    expect(readRows("WHERE action = 'key_revoke' AND subject_id = ?", [issued.id])).toHaveLength(1);

    const projectId = await client.createProject("Archive twice", "act-001-f-archive-project");
    await expectJson(await client.fetch(`/api/v1/projects/${projectId}/archive`, {method: "POST"}), 200, z.object({}).loose());
    await expectJson(await client.fetch(`/api/v1/projects/${projectId}/archive`, {method: "POST"}), 200, z.object({}).loose());
    expect(readRows("WHERE action = 'project_archive' AND subject_id = ?", [projectId])).toHaveLength(1);

    // A refused action leaves no member and no partial row.
    withWritableDatabase((database) => database.exec(`
      CREATE TRIGGER member_action_outage BEFORE INSERT ON actions
      WHEN NEW.action = 'member_admit'
      BEGIN SELECT RAISE(ABORT, 'the activity log refused the write'); END;
    `));
    const refused = await adminFetch(cookies, "/api/v1/members", "POST", {
      displayName: "Refused Member",
      email: "refused@example.test",
    });
    expect(refused.status).toBeGreaterThanOrEqual(500);
    withWritableDatabase((database) => database.exec("DROP TRIGGER member_action_outage;"));
    const members = (await expectJson(
      await adminFetch(cookies, "/api/v1/members", "GET"),
      200,
      z.object({members: z.array(z.object({email: z.string()}).loose())}),
    )).members;
    expect(members.map((member) => member.email)).not.toContain("refused@example.test");
    const agent = await client.registerAgent({
      connectionKey: "act-001-f-agent",
      displayName: "site",
      workingDirectory: "/work/site",
    });
    const thread = await client.openThread(published, "Replay me.", "act-001-f-thread");
    const sendOnce = () => client.sendDispatch({
      agentId: agent.id,
      idempotencyKey: "act-001-f-dispatch",
      projectId: published.artifact.projectId,
      threadIds: [thread.id],
    });
    await sendOnce();
    await sendOnce();
    expect(readRows("WHERE action = 'dispatch_create'", [])).toHaveLength(1);
    expect(published.artifact.id).toEqual(expect.any(String));
  });

  function withWritableDatabase(operation: (database: DatabaseSync) => void): void {
    const database = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
      {timeout: 5_000},
    );
    try {
      operation(database);
    } finally {
      database.close();
    }
  }

  function adminFetch(
    cookies: {readonly csrf: string; readonly header: string},
    pathname: string,
    method: string,
    body?: AdminRequestBody,
  ): Promise<Response> {
    const headers = new Headers({
      "Content-Type": "application/json",
      Cookie: cookies.header,
      Origin: server.baseUrl,
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": cookies.csrf,
    });
    return fetch(`${server.baseUrl}${pathname}`, body === undefined
      ? {headers, method}
      : {body: JSON.stringify(body), headers, method});
  }

  async function sessionPrincipalId(cookie: string): Promise<string> {
    const response = await fetch(`${server.baseUrl}/api/v1/session`, {headers: {Cookie: cookie}});
    return z.object({principal: z.object({id: z.string()})}).parse(await response.json()).principal.id;
  }

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
