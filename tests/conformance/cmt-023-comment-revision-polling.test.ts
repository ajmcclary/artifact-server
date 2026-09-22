import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {ApiClient} from "../support/agent-dispatch.js";

const commentAuthorSchema = z.object({
  authorizedByPrincipalId: z.string().nullable(),
  displayName: z.string(),
  principalId: z.string(),
  principalKind: z.enum(["human", "service"]),
});
const commentThreadSchema = z.object({
  anchor: z.unknown(),
  artifactId: z.string(),
  author: commentAuthorSchema,
  body: z.string(),
  createdAt: z.string(),
  id: z.string(),
  links: z.object({self: z.url(), version: z.url()}),
  path: z.string().nullable(),
  projectId: z.string(),
  replyCount: z.number().int().nonnegative(),
  resolvedAt: z.string().nullable(),
  resolvedBy: commentAuthorSchema.nullable(),
  state: z.enum(["open", "resolved"]),
  updatedAt: z.string(),
  versionId: z.string(),
});
const threadPageSchema = z.object({
  items: z.array(commentThreadSchema),
  nextCursor: z.string().nullable(),
  revision: z.number().int().nonnegative(),
});
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});

describe("comment revision polling", () => {
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

  test("CMT-023-B: listing carries a revision, matching polls short-circuit, and stale polls return the authoritative page", async () => {
    expect.hasAssertions();
    const published = await publishArtifact("cmt-023-behavior");

    const first = await list(published, "");
    expect(first.revision).toBe(0);
    expect(first.items).toHaveLength(0);

    const thread = await openThread(published, "cmt-023-behavior-thread", "First note.");
    const afterCreate = await list(published, "");
    expect(afterCreate.revision).toBe(1);
    expect(afterCreate.items.map((item) => item.id)).toEqual([thread.id]);

    const currentPoll = await list(published, "revision=1");
    expect(currentPoll).toEqual({items: [], nextCursor: null, revision: 1});

    await deleteThread(published, thread.id);
    const afterDelete = await list(published, "");
    expect(afterDelete.revision).toBe(2);
    expect(afterDelete.items).toHaveLength(0);

    const staleAfterDelete = await list(published, "revision=1");
    expect(staleAfterDelete.revision).toBe(2);
    expect(staleAfterDelete.items).toHaveLength(0);

    // A dispatched thread leaves the default filter; cancellation returns it.
    const dispatchedArtifact = await publishArtifact("cmt-023-dispatch");
    const dispatchedThread = await openThread(
      dispatchedArtifact,
      "cmt-023-dispatch-thread",
      "Send me.",
    );
    const agent = await client.registerAgent({
      connectionKey: "cmt-023-dispatch-agent-key",
      displayName: "Dispatch agent",
      workingDirectory: "/tmp/cmt-023",
    });
    const dispatch = await client.sendDispatch({
      agentId: agent.id,
      idempotencyKey: "cmt-023-dispatch-send",
      projectId: dispatchedArtifact.artifact.projectId,
      threadIds: [dispatchedThread.id],
    });
    expect(dispatch.status).toBe(201);

    const afterDispatch = await list(dispatchedArtifact, "");
    expect(afterDispatch.revision).toBe(2);
    expect(afterDispatch.items).toHaveLength(0);

    const dispatchBody = z.object({dispatch: z.object({id: z.string()})})
      .parse(await dispatch.json());
    const canceled = await client.cancelDispatch(
      dispatchBody.dispatch.id,
      dispatchedArtifact.artifact.projectId,
    );
    expect(canceled.status).toBe(200);

    const afterCancel = await list(dispatchedArtifact, "");
    expect(afterCancel.revision).toBe(3);
    expect(afterCancel.items.map((item) => item.id)).toEqual([dispatchedThread.id]);

    const stalePoll = await list(dispatchedArtifact, "revision=2");
    expect(stalePoll.revision).toBe(3);
    expect(stalePoll.items.map((item) => item.id)).toEqual([dispatchedThread.id]);

    // Revisions are isolated per artifact.
    const firstArtifact = await publishArtifact("cmt-023-isolation-one");
    const secondArtifact = await publishArtifact("cmt-023-isolation-two");
    const firstInitial = await list(firstArtifact, "");
    const secondInitial = await list(secondArtifact, "");
    expect(firstInitial.revision).toBe(0);
    expect(secondInitial.revision).toBe(0);

    const threadOnFirst = await openThread(
      firstArtifact,
      "cmt-023-isolation-thread",
      "Only on the first artifact.",
    );
    const firstAfter = await list(firstArtifact, "revision=0");
    expect(firstAfter.revision).toBe(1);
    expect(firstAfter.items.map((item) => item.id)).toEqual([threadOnFirst.id]);

    const secondUnchanged = await list(secondArtifact, "revision=0");
    expect(secondUnchanged).toEqual({items: [], nextCursor: null, revision: 0});
  });

  test("CMT-023-F: negative or non-integer revision values are rejected and an unknown artifact returns not found", async () => {
    expect.hasAssertions();
    const published = await publishArtifact("cmt-023-failure-case");

    const negative = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/comments?projectId=${published.artifact.projectId}&revision=-1`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(negative.status).toBe(422);
    expect(failureSchema.parse(await negative.json()).error.code)
      .toBe("INVALID_INPUT");

    const fractional = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/comments?projectId=${published.artifact.projectId}&revision=1.5`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(fractional.status).toBe(422);
    expect(failureSchema.parse(await fractional.json()).error.code)
      .toBe("INVALID_INPUT");

    const unknown = await fetch(
      `${server.baseUrl}/api/v1/artifacts/art_00000000-0000-4000-8000-000000000000/comments?projectId=${published.artifact.projectId}&revision=0`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(unknown.status).toBe(404);
    expect(failureSchema.parse(await unknown.json()).error.code)
      .toBe("ARTIFACT_NOT_FOUND");
  });

  async function publishArtifact(idempotencyKey: string): Promise<PublishResponse> {
    return (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<p>comment revision polling target</p>",
      idempotencyKey,
      name: "Comment revision polling target",
    })).body;
  }

  async function openThread(
    published: PublishResponse,
    idempotencyKey: string,
    body: string,
  ): Promise<z.infer<typeof commentThreadSchema>> {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}` +
        `/versions/${published.version.id}/comments` +
        `?projectId=${published.artifact.projectId}`,
      {
        body: JSON.stringify({body, path: "index.html"}),
        headers: apiHeaders(installation, idempotencyKey),
        method: "POST",
      },
    );
    expect(response.status).toBe(201);
    return z.object({thread: commentThreadSchema}).parse(await response.json())
      .thread;
  }

  async function deleteThread(published: PublishResponse, threadId: string): Promise<void> {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/comments/${threadId}` +
        `?projectId=${published.artifact.projectId}`,
      {headers: apiHeaders(installation, `cmt-023-delete-${threadId}`), method: "DELETE"},
    );
    expect(response.status).toBe(204);
  }

  async function list(
    published: PublishResponse,
    query: string,
  ): Promise<z.infer<typeof threadPageSchema>> {
    const separator = query === "" ? "" : "&";
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/comments` +
        `?projectId=${published.artifact.projectId}${separator}${query}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    if (response.status !== 200) {
      throw new Error(`Listing comment threads failed with ${response.status}.`);
    }
    return threadPageSchema.parse(await response.json());
  }
});
