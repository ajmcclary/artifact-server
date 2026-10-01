import {createHash} from "node:crypto";
import {mkdtemp, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";

import {unstable_dev, type Unstable_DevWorker} from "wrangler";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {z} from "zod";

const apiToken = "cloudflare-activity-test-api-token-0000001";
const origin = "https://artifacts.example.test";

const publicationSchema = z.object({
  artifact: z.object({id: z.string()}),
  version: z.object({id: z.string()}),
});
const uploadPlanSchema = z.object({
  commitUrl: z.url(),
  files: z.array(z.object({path: z.string(), uploadUrl: z.url()})).length(1),
});
const rowSchema = z.object({
  accessFrom: z.string().nullable(),
  accessTo: z.string().nullable(),
  action: z.string(),
  actorName: z.string().nullable(),
  idempotencyKey: z.string(),
  replyId: z.string().nullable(),
  threadId: z.string().nullable(),
});

let persistPath: string;
let worker: Unstable_DevWorker;

beforeAll(async () => {
  persistPath = await mkdtemp(join(tmpdir(), "artifact-server-cloudflare-activity-"));
  worker = await startWorker(persistPath);
}, 60_000);

afterAll(async () => {
  await worker.stop();
  await rm(persistPath, {force: true, recursive: true});
});

describe("Cloudflare D1 activity-log writes", () => {
  it("records actor snapshots, threads, replies and public-link direction in one batch per mutation", async () => {
    const published = await publishArtifact("activity-publish-0000001", "public_link");
    const artifactUrl = `${origin}/api/v1/artifacts/${published.artifact.id}`;
    const thread = z.object({thread: z.object({id: z.string()}).loose()}).loose().parse(await (await worker.fetch(
      `${artifactUrl}/versions/${published.version.id}/comments`,
      {body: JSON.stringify({body: "Check the legend.", path: "index.html"}), headers: mutationHeaders("activity-thread-00000001"), method: "POST"},
    )).json()).thread;
    const reply = z.object({reply: z.object({id: z.string()}).loose()}).loose().parse(await (await worker.fetch(
      `${artifactUrl}/comments/${thread.id}/replies`,
      {body: JSON.stringify({body: "Moved it."}), headers: mutationHeaders("activity-reply-000000001"), method: "POST"},
    )).json()).reply;
    const madePrivate = await worker.fetch(`${artifactUrl}/access`, {
      body: JSON.stringify({accessSetting: "account_required", expectedCurrentVersionId: published.version.id}),
      headers: mutationHeaders("activity-private-0000001"),
      method: "PATCH",
    });
    expect(madePrivate.status).toBe(200);

    // The installation credential registers itself as an agent, so its reply on
    // the dispatched thread is that agent answering.
    const agent = z.object({agent: z.object({id: z.string()}).loose()}).loose().parse(await (await worker.fetch(
      `${origin}/api/v1/agents`,
      {
        body: JSON.stringify({connectionKey: "activity-agent", displayName: "site", kind: "pi", workingDirectory: "/work/site"}),
        headers: {...bearerHeaders(), "Content-Type": "application/json"},
        method: "POST",
      },
    )).json()).agent;
    const heldThread = z.object({thread: z.object({id: z.string()}).loose()}).loose().parse(await (await worker.fetch(
      `${artifactUrl}/versions/${published.version.id}/comments`,
      {body: JSON.stringify({body: "Check the totals.", path: "index.html"}), headers: mutationHeaders("activity-held-thread-0001"), method: "POST"},
    )).json()).thread;
    const dispatch = z.object({dispatch: z.object({id: z.string(), projectId: z.string()}).loose()}).loose().parse(await (await worker.fetch(
      `${origin}/api/v1/agent-dispatches?projectId=prj_default`,
      {body: JSON.stringify({agentId: agent.id, threadIds: [heldThread.id]}), headers: mutationHeaders("activity-dispatch-0000001"), method: "POST"},
    )).json()).dispatch;
    const agentReply = (key: string) => worker.fetch(`${artifactUrl}/comments/${heldThread.id}/replies`, {
      body: JSON.stringify({body: "Answered."}),
      headers: mutationHeaders(key),
      method: "POST",
    });
    expect((await agentReply("activity-agent-reply-0001")).status).toBe(201);
    expect((await agentReply("activity-agent-reply-0002")).status).toBe(201);
    await worker.stop();

    const database = new DatabaseSync(await findD1DatabaseFile(persistPath), {readOnly: true});
    try {
      const rows = z.array(rowSchema).parse(database.prepare(`
        SELECT access_from AS accessFrom, access_to AS accessTo, action,
          actor_name AS actorName, idempotency_key AS idempotencyKey,
          reply_id AS replyId, thread_id AS threadId
        FROM actions WHERE artifact_id = ? ORDER BY created_at, rowid
      `).all(published.artifact.id));
      expect(rows.map((row) => [row.action, row.accessFrom, row.accessTo, row.threadId, row.replyId])).toEqual([
        ["publish", null, null, null, null],
        ["public_link_enable", null, "public_link", null, null],
        ["comment_create", null, null, thread.id, null],
        ["comment_reply", null, null, thread.id, reply.id],
        ["change_access", "public_link", "account_required", null, null],
        ["public_link_disable", "public_link", "account_required", null, null],
        ["comment_create", null, null, heldThread.id, null],
        ["comment_reply", null, null, heldThread.id, expect.any(String)],
        ["comment_reply", null, null, heldThread.id, expect.any(String)],
      ]);
      expect(new Set(rows.map((row) => row.actorName))).toEqual(new Set(["Local"]));
      const dispatchRows = z.array(z.object({action: z.string(), subjectId: z.string(), threadId: z.string().nullable()}))
        .parse(database.prepare(`
          SELECT action, subject_id AS subjectId, thread_id AS threadId
          FROM actions WHERE action LIKE 'dispatch%' ORDER BY created_at, rowid
        `).all());
      expect(dispatchRows).toEqual([
        {action: "dispatch_create", subjectId: dispatch.id, threadId: null},
        {action: "dispatch_addressed", subjectId: dispatch.id, threadId: heldThread.id},
      ]);
    } finally {
      database.close();
    }
    worker = await startWorker(persistPath);
  }, 120_000);
});

function bearerHeaders() {
  return {Authorization: `Bearer ${apiToken}`};
}

function mutationHeaders(idempotencyKey: string) {
  return {...bearerHeaders(), "Content-Type": "application/json", "Idempotency-Key": idempotencyKey};
}

async function publishArtifact(idempotencyKey: string, accessSetting: "account_required" | "public_link") {
  const bytes = new TextEncoder().encode("<h1>Activity target</h1>");
  const plan = uploadPlanSchema.parse(await (await worker.fetch(`${origin}/api/v1/uploads`, {
    body: JSON.stringify({
      entryPath: "index.html",
      files: [{
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      }],
    }),
    headers: {...bearerHeaders(), "Content-Type": "application/json"},
    method: "POST",
  })).json());
  const file = plan.files[0];
  if (file === undefined) throw new Error("The upload plan is empty.");
  expect((await worker.fetch(file.uploadUrl, {body: bytes, headers: bearerHeaders(), method: "PUT"})).status).toBe(200);
  const committed = await worker.fetch(plan.commitUrl, {
    body: JSON.stringify({target: {accessSetting, kind: "new_artifact", name: "Activity target", tags: []}}),
    headers: mutationHeaders(idempotencyKey),
    method: "POST",
  });
  expect(committed.status).toBe(201);
  return publicationSchema.parse(await committed.json());
}

async function findD1DatabaseFile(directory: string): Promise<string> {
  const entries = await readdir(directory, {recursive: true, withFileTypes: true});
  const found = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite") && entry.parentPath.includes("D1"))
    .map((entry) => join(entry.parentPath, entry.name))
    .find((candidate) => {
      const database = new DatabaseSync(candidate, {readOnly: true});
      try {
        return database.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifact_server_schema'",
        ).get() !== undefined;
      } finally {
        database.close();
      }
    });
  if (found === undefined) throw new Error("The Worker did not persist a local D1 database file.");
  return found;
}

function startWorker(persistenceDirectory: string): Promise<Unstable_DevWorker> {
  return unstable_dev("src/worker.ts", {
    bundle: true,
    compatibilityDate: "2026-08-15",
    compatibilityFlags: ["nodejs_compat"],
    config: "wrangler.test.jsonc",
    experimental: {
      d1Databases: [{
        binding: "ARTIFACT_SERVER_D1_DATABASE",
        database_id: "artifact-server-test-d1",
        database_name: "artifact-server-test-d1",
      }],
      disableDevRegistry: true,
      disableExperimentalWarning: true,
      testScheduled: true,
      watch: false,
    },
    inspect: false,
    local: true,
    logLevel: "error",
    persist: true,
    persistTo: persistenceDirectory,
    r2: [{binding: "ARTIFACT_SERVER_R2_BUCKET", bucket_name: "artifact-server-test-r2"}],
    vars: {
      ARTIFACT_SERVER_API_TOKEN: apiToken,
      ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "administrator@example.test",
      ARTIFACT_SERVER_CONTENT_DOMAIN: "content.example.test",
      ARTIFACT_SERVER_INSTALLATION_ID: "cloudflare-activity-test",
      ARTIFACT_SERVER_OIDC_CLIENT_ID: "cloudflare-activity-test",
      ARTIFACT_SERVER_OIDC_ISSUER: "https://identity.example.test",
      ARTIFACT_SERVER_ORIGIN: origin,
      ARTIFACT_SERVER_QUALIFICATION_MODE: "enabled",
      ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    },
  });
}
