import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  ApiClient,
  issueApiKey,
  MutableClock,
  signInAdministrator,
} from "../support/agent-dispatch.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

export const activitySummarySchema = z.object({
  artifactsInReview: z.number().int().nonnegative(),
  needsYou: z.number().int().nonnegative(),
  openConversations: z.number().int().nonnegative(),
  projects: z.array(z.object({
    artifactCount: z.number().int().nonnegative(),
    id: z.string(),
    lastActivityAt: z.iso.datetime().nullable(),
    unresolved: z.number().int().nonnegative(),
  }).strict()),
  withAgent: z.number().int().nonnegative(),
}).strict();

describe("activity summary", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let clock: MutableClock;
  let reader: ApiClient;

  beforeEach(async () => {
    installation = await createTestInstallation();
    clock = new MutableClock("2026-10-01T12:00:00.000Z");
    server = await startTestServer(installation, {clock});
    reader = new ApiClient(server, installation.apiToken);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("ACT-004-B: summary and segment counts agree with the per-thread rule", async () => {
    expect.hasAssertions();
    const {agent, agentId} = await connectAgent("summary-agent");
    const first = await publish("summary-a", "Stage bar walkthrough");
    const second = await publish("summary-b", "Inspector docking study");
    clock.advance(1_000);
    const held = await reader.openThread(first, "For Codex", "summary-held-thread");
    await reader.openThread(first, "For a person", "summary-open-a-thread");
    await reader.openThread(second, "Also for a person", "summary-open-b-thread");
    const resolved = await reader.openThread(second, "Done already", "summary-resolved");
    expect((await reader.setThreadState(second, resolved.id, "resolved")).status).toBe(200);
    expect((await reader.sendDispatch({
      agentId,
      idempotencyKey: "summary-dispatch",
      projectId: first.artifact.projectId,
      threadIds: [held.id],
    })).status).toBe(201);
    void agent;

    const summary = await readSummary("");
    expect(summary).toMatchObject({
      artifactsInReview: 2,
      needsYou: 2,
      openConversations: 3,
      withAgent: 1,
    });
    const project = summary.projects.find((entry) => entry.id === first.artifact.projectId);
    expect(project).toMatchObject({artifactCount: 2, unresolved: 3});
    expect(project?.lastActivityAt).not.toBeNull();

    const needsYouEntries = (await readFeed(`?segment=needs_you&limit=100`)).length;
    const withAgentThreads = (await readFeed(`?segment=with_agent&type=comments&limit=100`)).length;
    expect(needsYouEntries).toBe(summary.needsYou);
    expect(withAgentThreads).toBe(summary.withAgent);
  });

  test("ACT-004-F: resolved, canceled-dispatch and deleted threads are never counted as waiting", async () => {
    expect.hasAssertions();
    const {agentId} = await connectAgent("summary-cancel-agent");
    const published = await publish("summary-f", "Retention schedule");
    clock.advance(1_000);
    const canceled = await reader.openThread(published, "Dispatched then canceled", "summary-f-cancel");
    const deleted = await reader.openThread(published, "Deleted thread", "summary-f-delete");
    const resolved = await reader.openThread(published, "Resolved thread", "summary-f-resolve");
    const sent = await reader.sendDispatch({
      agentId,
      idempotencyKey: "summary-f-dispatch",
      projectId: published.artifact.projectId,
      threadIds: [canceled.id],
    });
    const dispatchId = z.object({dispatch: z.object({id: z.string()}).loose()}).loose()
      .parse(await sent.json()).dispatch.id;
    expect((await reader.cancelDispatch(dispatchId, published.artifact.projectId)).status)
      .toBe(200);
    expect((await reader.fetch(
      `/api/v1/artifacts/${published.artifact.id}/comments/${deleted.id}` +
        `?projectId=${published.artifact.projectId}`,
      {method: "DELETE"},
    )).status).toBe(204);
    expect((await reader.setThreadState(published, resolved.id, "resolved")).status).toBe(200);

    const summary = await readSummary(`?project=${published.artifact.projectId}`);
    expect(summary).toMatchObject({
      needsYou: 1,
      openConversations: 1,
      withAgent: 0,
    });
    expect(summary.projects.map((project) => project.id))
      .toEqual([published.artifact.projectId]);

    const unknown = await readSummary("?project=prj_does_not_exist");
    expect(unknown).toEqual({
      artifactsInReview: 0,
      needsYou: 0,
      openConversations: 0,
      projects: [],
      withAgent: 0,
    });
  });

  async function connectAgent(key: string): Promise<{agent: ApiClient; agentId: string}> {
    const administrator = await signInAdministrator(server, installation);
    const token = await issueApiKey(server, administrator, ["agent:connect"], key);
    const agent = new ApiClient(server, token);
    const registered = await agent.registerAgent({
      connectionKey: key,
      displayName: "Codex",
      workingDirectory: "/work",
    });
    return {agent, agentId: registered.id};
  }

  async function publish(key: string, name: string): Promise<PublishResponse> {
    return (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: `<p>${name}</p>`,
      idempotencyKey: `${key}-publication`,
      name,
    })).body;
  }

  async function readSummary(query: string) {
    const response = await reader.fetch(`/api/v1/activity/summary${query}`);
    expect(response.status).toBe(200);
    return activitySummarySchema.parse(await response.json());
  }

  async function readFeed(query: string): Promise<readonly unknown[]> {
    const response = await reader.fetch(`/api/v1/activity${query}`);
    expect(response.status).toBe(200);
    return z.object({items: z.array(z.unknown())}).loose()
      .parse(await response.json()).items;
  }
});
