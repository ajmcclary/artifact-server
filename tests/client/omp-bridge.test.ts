import {afterEach, beforeEach, describe, expect, test} from "vitest";

import artifactServerBridge, {
  type OmExtensionApi,
  type OmEventHandlers,
} from "../../integrations/omp/index.js";
import {
  agentListSchema,
  ApiClient,
  dispatchCreationSchema,
  dispatchEnvelopeSchema,
} from "../support/agent-dispatch.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew} from "../support/publishing.js";

const environmentKeys = [
  "ARTIFACT_SERVER_AGENT_NAME",
  "ARTIFACT_SERVER_AGENT_TOKEN",
  "ARTIFACT_SERVER_ORIGIN",
] as const;
class ScriptedOmp implements OmExtensionApi {
  readonly messages: Array<{delivery: {deliverAs: "followUp"}; text: string}> = [];
  readonly notices: string[] = [];
  tool: Parameters<OmExtensionApi["registerTool"]>[0] | null = null;
  #handlers: Partial<OmEventHandlers> = {};

  on<Event extends keyof OmEventHandlers>(
    event: Event,
    handler: OmEventHandlers[Event],
  ): void {
    this.#handlers[event] = handler;
  }

  registerTool(tool: Parameters<OmExtensionApi["registerTool"]>[0]): void {
    this.tool = tool;
  }

  sendUserMessage(text: string, delivery: {deliverAs: "followUp"}): void {
    this.messages.push({delivery, text});
  }

  async start(): Promise<void> {
    const handler = this.#handlers.session_start;
    if (handler === undefined) throw new Error("The session start handler is missing.");
    await handler({}, {
      cwd: "/work/omp-adapter-test",
      sessionManager: {getSessionId: () => "omp-session-test"},
      ui: {notify: (message) => { this.notices.push(message); }},
    });
  }

  beginCompaction(): void {
    this.#handlers.session_before_compact?.();
  }

  endCompaction(): void {
    this.#handlers.session_compact?.();
  }

  async shutdown(): Promise<void> {
    await this.#handlers.session_shutdown?.();
  }
}

async function eventually<Value>(
  probe: () => Promise<Value | null>,
): Promise<Value> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("The bridge did not settle.");
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("omp bridge adapter", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let savedEnvironment: Partial<Record<(typeof environmentKeys)[number], string>>;
  let host: ScriptedOmp;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    host = new ScriptedOmp();
    savedEnvironment = {};
    for (const key of environmentKeys) {
      const value = process.env[key];
      if (value !== undefined) savedEnvironment[key] = value;
    }
    process.env["ARTIFACT_SERVER_AGENT_NAME"] = "omp-under-test";
    process.env["ARTIFACT_SERVER_AGENT_TOKEN"] = installation.apiToken;
    process.env["ARTIFACT_SERVER_ORIGIN"] = server.baseUrl;
  });

  afterEach(async () => {
    await host.shutdown();
    for (const key of environmentKeys) {
      const saved = savedEnvironment[key];
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("registers, holds a bundle through compaction, follows up, and closes its thread", async () => {
    const client = new ApiClient(server, installation.apiToken);
    const published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>omp bridge</title>",
      idempotencyKey: "omp-bridge-publish",
      name: "omp report",
    })).body;
    const thread = await client.openThread(
      published,
      "Update the heading.",
      "omp-bridge-thread",
    );

    artifactServerBridge(host);
    await host.start();
    const agent = await eventually(async () => {
      const response = await client.listAgents();
      return agentListSchema.parse(await response.json()).items
        .find((item) => item.displayName === "omp-under-test") ?? null;
    });
    expect(agent.kind).toBe("omp");
    host.beginCompaction();
    const sent = await client.sendDispatch({
      agentId: agent.id,
      idempotencyKey: "omp-bridge-dispatch",
      projectId: published.artifact.projectId,
      threadIds: [thread.id],
    });
    expect(sent.status).toBe(201);
    const dispatchId = dispatchCreationSchema.parse(await sent.json()).dispatch.id;
    const state = async () => {
      const response = await client.getDispatch(dispatchId, published.artifact.projectId);
      return dispatchEnvelopeSchema.parse(await response.json()).dispatch.state;
    };
    await eventually(async () => (await state()) === "claimed" ? true : null);
    expect(host.messages).toHaveLength(0);

    host.endCompaction();
    await eventually(async () => (await state()) === "delivered" ? true : null);
    expect(host.messages).toHaveLength(1);
    expect(host.messages[0]?.delivery).toEqual({deliverAs: "followUp"});
    expect(host.messages[0]?.text).toContain(thread.id);

    const tool = host.tool;
    if (tool === null) throw new Error("The comment tool is missing.");
    await tool.execute("get-bundle", {operation: "get_bundle", threadIds: [thread.id]}, undefined);
    await tool.execute("reply", {
      body: "Updated the heading.",
      operation: "reply",
      threadId: thread.id,
    }, undefined);
    await tool.execute("resolve", {operation: "resolve", threadId: thread.id}, undefined);
    await eventually(async () => (await state()) === "addressed" ? true : null);

    await host.shutdown();
    await eventually(async () => {
      const response = await client.listAgents();
      return agentListSchema.parse(await response.json()).items
        .some((item) => item.id === agent.id) ? null : true;
    });
  });
});
