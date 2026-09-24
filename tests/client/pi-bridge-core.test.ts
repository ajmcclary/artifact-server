import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  chooseDisplayName,
  connectionKeyFor,
  type FollowUpDelivery,
  maximumQuotedSelectionCharacters,
  renderBundleMessage,
  resolveBridgeCredentials,
} from "@plannotator/agent-bridge";

import artifactServerBridge, {
  type PiEventHandlers,
  type PiExtensionApi,
  type PiExtensionContextLike,
  type PiToolDefinitionLike,
} from "../../integrations/pi/index.js";
import {
  agentListSchema,
  ApiClient,
  dispatchCreationSchema,
  dispatchEnvelopeSchema,
} from "../support/agent-dispatch.js";
import {publishNew} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const emptyEnvironment = {
  agentDisplayName: undefined,
  agentToken: undefined,
  origin: undefined,
};

async function writeDiscovery(
  home: string,
  origin: string,
  token: string,
): Promise<void> {
  const dataDirectory = path.join(home, ".artifact-server");
  await mkdir(dataDirectory, {recursive: true});
  await writeFile(
    path.join(dataDirectory, "local-service.json"),
    JSON.stringify({
      dataDirectory,
      origin,
      pid: 4242,
      productVersion: "0.0.0",
      schemaVersion: 1,
      startedAt: "2026-08-18T00:00:00.000Z",
    }),
    "utf8",
  );
  await writeFile(
    path.join(dataDirectory, "local-api-token"),
    `${token}\n`,
    "utf8",
  );
}

describe("pi bridge core building blocks", () => {
  const temporaryHomes: string[] = [];

  afterEach(async () => {
    for (const home of temporaryHomes.splice(0)) {
      // eslint-disable-next-line no-await-in-loop
      await rm(home, {force: true, recursive: true});
    }
  });

  async function temporaryHome(): Promise<string> {
    const home = await mkdtemp(path.join(tmpdir(), "pi-bridge-home-"));
    temporaryHomes.push(home);
    return home;
  }

  test("renders the recorded bundle template with note, paths, selections, and instruction", () => {
    const message = renderBundleMessage({
      items: [
        {
          artifactName: "Queue report",
          body: "Line one.\nLine two.",
          path: "index.html",
          quotedSelection: "  the   header  ",
          threadId: "cmt_one",
          versionNumber: 3,
        },
        {
          artifactName: "Queue report",
          body: "Whole-version remark.",
          path: null,
          quotedSelection: null,
          threadId: "cmt_two",
          versionNumber: 3,
        },
      ],
      note: "Please finish today.",
      senderDisplayName: "Ada",
    });
    expect(message).toBe([
      "Artifact Server: Ada sent 2 annotation(s) to address.",
      "Please finish today.",
      "",
      "1. [Queue report · version 3 · index.html] \"the header\"",
      "   Line one.",
      "   Line two.",
      "   (thread cmt_one)",
      "2. [Queue report · version 3]",
      "   Whole-version remark.",
      "   (thread cmt_two)",
      "",
      "When each item is done: use the artifact_comments tool to reply to its thread",
      "with what you did, then resolve it. Do not wait for confirmation.",
    ].join("\n"));
  });

  test("omits the note line when absent and bounds long selections to the cap", () => {
    const message = renderBundleMessage({
      items: [{
        artifactName: "Plan",
        body: "Trim it.",
        path: "plan.html",
        quotedSelection: "x".repeat(2_000),
        threadId: "cmt_long",
        versionNumber: 1,
      }],
      note: null,
      senderDisplayName: "Grace",
    });
    const lines = message.split("\n");
    expect(lines[1]).toBe("");
    const quoteLine = lines[2] ?? "";
    const quoted = quoteLine.slice(
      quoteLine.indexOf("\"") + 1,
      quoteLine.lastIndexOf("\""),
    );
    expect(quoted.length).toBe(maximumQuotedSelectionCharacters);
    expect(quoted.endsWith("…")).toBe(true);
  });

  test("hostile slash-leading fields can never produce a slash-leading message", () => {
    const message = renderBundleMessage({
      items: [{
        artifactName: "/etc",
        body: "/steer\n/compact",
        path: null,
        quotedSelection: "/quote",
        threadId: "cmt_slash",
        versionNumber: 9,
      }],
      note: "/new",
      senderDisplayName: "/resume",
    });
    expect(message.startsWith("Artifact Server: ")).toBe(true);
    expect(message.startsWith("/")).toBe(false);
  });

  test("connection keys are stable sha-256 digests of host and directory", () => {
    const key = connectionKeyFor("machine", "/work/site");
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(connectionKeyFor("machine", "/work/site")).toBe(key);
    expect(connectionKeyFor("machine", "/work/other")).not.toBe(key);
    expect(connectionKeyFor("other", "/work/site")).not.toBe(key);
  });

  test("the display name prefers the override and falls back to the basename", () => {
    expect(chooseDisplayName(
      {...emptyEnvironment, agentDisplayName: "  named  "},
      "/work/site",
    )).toBe("named");
    expect(chooseDisplayName(emptyEnvironment, "/work/site")).toBe("site");
    expect(chooseDisplayName(emptyEnvironment, "/")).toBe("pi");
  });

  test("environment configuration wins over local discovery and normalizes the origin", async () => {
    const home = await temporaryHome();
    await writeDiscovery(
      home,
      "http://127.0.0.1:4100/",
      "local-token-with-sufficient-length",
    );
    const resolved = await resolveBridgeCredentials({
      agentDisplayName: undefined,
      agentToken: "environment-token",
      origin: "https://artifacts.example.test/base/path",
    }, home);
    expect(resolved).toEqual({
      origin: "https://artifacts.example.test",
      token: "environment-token",
    });
  });

  test("local discovery resolves the loopback service record and token", async () => {
    const home = await temporaryHome();
    await writeDiscovery(
      home,
      "http://127.0.0.1:4100/",
      "local-token-with-sufficient-length",
    );
    const resolved = await resolveBridgeCredentials(emptyEnvironment, home);
    expect(resolved).toEqual({
      origin: "http://127.0.0.1:4100",
      token: "local-token-with-sufficient-length",
    });
  });

  test("no configuration, a non-loopback record, or a short token stays dormant", async () => {
    const bare = await temporaryHome();
    expect(await resolveBridgeCredentials(emptyEnvironment, bare)).toBeNull();

    const hostile = await temporaryHome();
    await writeDiscovery(
      hostile,
      "http://attacker.example.test/",
      "local-token-with-sufficient-length",
    );
    expect(await resolveBridgeCredentials(emptyEnvironment, hostile))
      .toBeNull();

    const short = await temporaryHome();
    await writeDiscovery(short, "http://127.0.0.1:4100/", "tiny");
    expect(await resolveBridgeCredentials(emptyEnvironment, short)).toBeNull();
  });
});

const environmentKeys = [
  "ARTIFACT_SERVER_AGENT_NAME",
  "ARTIFACT_SERVER_AGENT_TOKEN",
  "ARTIFACT_SERVER_ORIGIN",
] as const;

class FakePi implements PiExtensionApi {
  readonly messages: Array<{delivery: FollowUpDelivery; text: string}> = [];
  readonly notices: string[] = [];
  refuseNextMessage = false;
  tool: PiToolDefinitionLike | null = null;
  #handlers: Partial<PiEventHandlers> = {};

  on<Event extends keyof PiEventHandlers>(
    event: Event,
    handler: PiEventHandlers[Event],
  ): void {
    this.#handlers[event] = handler;
  }

  registerTool(tool: PiToolDefinitionLike): void {
    this.tool = tool;
  }

  sendUserMessage(text: string, delivery: FollowUpDelivery): void {
    if (this.refuseNextMessage) {
      this.refuseNextMessage = false;
      throw new Error("The host refused the message.");
    }
    this.messages.push({delivery, text});
  }

  async start(ctx: PiExtensionContextLike): Promise<void> {
    const handler = this.#handlers.session_start;
    if (handler === undefined) throw new Error("Missing session_start handler.");
    await handler({reason: "startup"}, ctx);
  }

  beginCompaction(): void {
    this.#handlers.session_before_compact?.();
  }

  endCompaction(): void {
    this.#handlers.session_compact?.();
  }

  async shutdown(): Promise<void> {
    await this.#handlers.session_shutdown?.({reason: "quit"});
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

describe("pi bridge adapter loop", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let savedEnvironment: Partial<
    Record<(typeof environmentKeys)[number], string>
  >;
  let host: FakePi;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    host = new FakePi();
    savedEnvironment = {};
    for (const key of environmentKeys) {
      const value = process.env[key];
      if (value !== undefined) savedEnvironment[key] = value;
    }
    process.env["ARTIFACT_SERVER_AGENT_NAME"] = "pi-loop-under-test";
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

  test("holds delivery while compacting and delivers after compaction ends", async () => {
    expect.hasAssertions();
    const client = new ApiClient(server, installation.apiToken);
    const published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>pi loop</title>",
      idempotencyKey: "pi-loop-publish-key",
      name: "pi loop report",
    })).body;
    const thread = await client.openThread(
      published,
      "Update the heading.",
      "pi-loop-comment-thread",
    );

    artifactServerBridge(host);
    await host.start({
      cwd: "/work/pi-loop-test",
      sessionManager: {getSessionId: () => "pi-loop-session"},
      ui: {notify: (message) => { host.notices.push(message); }},
    });
    const agent = await eventually(async () => {
      const response = await client.listAgents();
      return agentListSchema.parse(await response.json()).items
        .find((item) => item.displayName === "pi-loop-under-test") ?? null;
    });
    expect(agent.kind).toBe("pi");

    host.beginCompaction();
    const sent = await client.sendDispatch({
      agentId: agent.id,
      idempotencyKey: "pi-loop-dispatch",
      projectId: published.artifact.projectId,
      threadIds: [thread.id],
    });
    expect(sent.status).toBe(201);
    const dispatchId = dispatchCreationSchema.parse(await sent.json())
      .dispatch.id;
    const state = async () => {
      const response = await client.getDispatch(
        dispatchId,
        published.artifact.projectId,
      );
      return dispatchEnvelopeSchema.parse(await response.json()).dispatch.state;
    };
    await eventually(async () => (await state()) === "claimed" ? true : null);
    expect(host.messages).toHaveLength(0);

    host.endCompaction();
    await eventually(async () => (await state()) === "delivered" ? true : null);
    expect(host.messages).toHaveLength(1);
    expect(host.messages[0]?.delivery).toEqual({deliverAs: "followUp"});
    expect(host.messages[0]?.text).toContain(thread.id);
  });

  test("a synchronous host throw ends the claim loop without reporting delivery", async () => {
    expect.hasAssertions();
    const client = new ApiClient(server, installation.apiToken);
    const published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>pi refusal</title>",
      idempotencyKey: "pi-refusal-publish",
      name: "pi refusal report",
    })).body;
    const refusedThread = await client.openThread(
      published,
      "Refuse this.",
      "pi-refusal-thread",
    );
    const laterThread = await client.openThread(
      published,
      "This one is never delivered.",
      "pi-later-comment-thread",
    );

    artifactServerBridge(host);
    await host.start({
      cwd: "/work/pi-refusal-test",
      sessionManager: {getSessionId: () => "pi-refusal-session"},
      ui: {notify: (message) => { host.notices.push(message); }},
    });
    const agent = await eventually(async () => {
      const response = await client.listAgents();
      return agentListSchema.parse(await response.json()).items
        .find((item) => item.displayName === "pi-loop-under-test") ?? null;
    });

    // A synchronous throw is the protocol's lost-handle signal: the loop ends
    // dormant instead of reporting `failed`, and the claimed dispatch is left
    // for lease expiry. The host receives no follow-up and no exception.
    host.refuseNextMessage = true;
    const refused = await client.sendDispatch({
      agentId: agent.id,
      idempotencyKey: "pi-refused-dispatch",
      projectId: published.artifact.projectId,
      threadIds: [refusedThread.id],
    });
    const refusedId = dispatchCreationSchema.parse(await refused.json())
      .dispatch.id;
    const refusedDispatch = async () => {
      const response = await client.getDispatch(
        refusedId,
        published.artifact.projectId,
      );
      return dispatchEnvelopeSchema.parse(await response.json()).dispatch;
    };
    await eventually(async () =>
      (await refusedDispatch()).state === "claimed" ? true : null
    );
    expect(host.messages).toHaveLength(0);

    const later = await client.sendDispatch({
      agentId: agent.id,
      idempotencyKey: "pi-later-dispatch",
      projectId: published.artifact.projectId,
      threadIds: [laterThread.id],
    });
    const laterId = dispatchCreationSchema.parse(await later.json()).dispatch.id;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await refusedDispatch()).toMatchObject({
      deliveredAt: null,
      failedAt: null,
    });
    const laterResponse = await client.getDispatch(
      laterId,
      published.artifact.projectId,
    );
    expect(dispatchEnvelopeSchema.parse(await laterResponse.json()).dispatch)
      .toMatchObject({state: "queued"});
    expect(host.messages).toHaveLength(0);
  });
});
