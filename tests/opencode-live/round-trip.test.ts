/**
 * OPENCODE-LIVE 1 — the full round trip against a REAL OpenCode process.
 *
 * A human publishes an artifact, annotates it, and sends the bundle while
 * OpenCode is mid-work. The suite proves, from the server and from OpenCode's
 * own conversation, that the bundle waits for OpenCode's work boundary, arrives
 * as one message, and is closed by the `artifact_comments` tool until the
 * dispatch reads `addressed`.
 */

import {afterAll, beforeAll, describe, expect, test} from "vitest";

import {
  ApiClient,
  dispatchCreationSchema,
} from "../support/agent-dispatch.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  bundleMessages,
  latestUserMessage,
  type ModelTurn,
  type ScriptedModel,
  type ScriptedReply,
  startScriptedModel,
} from "./support/scripted-model.js";
import {
  createOpencodeEnvironment,
  type OpencodeEnvironment,
} from "./support/opencode-environment.js";
import {
  type LiveOpencode,
  resolveOpencodeCli,
  startLiveOpencode,
} from "./support/live-opencode.js";
import {createWorkGate} from "./support/work-gate.js";
import {
  readThread,
  waitForConnectedAgent,
  waitForDispatchState,
} from "./support/server-observations.js";

const emptyTurn: ModelTurn = {index: 0, messages: []};

const bridgeExtension = new URL(
  "../../integrations/opencode/index.ts",
  import.meta.url,
).pathname;

function isTitleGenerationTurn(turn: ModelTurn): boolean {
  return turn.messages.some(
    (message) =>
      message.role === "system" && message.text.includes("title generator"),
  );
}

describe("live OpenCode bridge round trip", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;
  let environment: OpencodeEnvironment;
  let model: ScriptedModel;
  let opencode: LiveOpencode;
  const work = createWorkGate();
  const replies: ScriptedReply[] = [];

  beforeAll(async () => {
    const cliPath = await resolveOpencodeCli();
    if (cliPath === null) throw new Error("No opencode CLI was found.");

    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Live round trip</title>",
      idempotencyKey: "opencode-live-round-trip-publish",
      name: "Live round trip report",
    })).body;

    model = await startScriptedModel(async (turn: ModelTurn) => {
      // OpenCode always makes a small title-generation call before the main
      // prompt. Answer it immediately so the real work boundary is turn 2.
      if (isTitleGenerationTurn(turn)) {
        return {kind: "text", text: "Live round trip"};
      }
      if (turn.index === 2) {
        // The scripted slow work: OpenCode stays inside this unit of work
        // until the test has sent the bundle and watched it reach `delivered`.
        await work.opened;
        return {kind: "text", text: "Scripted work finished."};
      }
      return replies[turn.index - 3] ??
        {kind: "text", text: "Nothing further to do."};
    });
    environment = await createOpencodeEnvironment(model.baseUrl, bridgeExtension);
    opencode = await startLiveOpencode(
      {
        agentName: "opencode-live-suite",
        cacheDirectory: environment.cacheDirectory,
        configDirectory: environment.configDirectory,
        dataDirectory: environment.dataDirectory,
        origin: server.baseUrl,
        projectDirectory: environment.projectDirectory,
        stateDirectory: environment.stateDirectory,
        token: installation.apiToken,
      },
      "Do the scripted long task and report when finished.",
    );
  });

  afterAll(async () => {
    work.open();
    await opencode.stop();
    await model.stop();
    await environment.remove();
    await server.stop();
    await removeTestInstallation(installation);
  });

  test(
    "OPENCODE-LIVE 1: a bundle sent while OpenCode works arrives at the work boundary and is closed through artifact_comments",
    async () => {
      expect.hasAssertions();

      // The live extension registered this OpenCode session by itself.
      const agent = await waitForConnectedAgent(client);
      expect(agent.displayName).toBe("opencode-live-suite");
      expect(agent.workingDirectory).toBe(environment.projectDirectory);

      const first = await client.openThread(
        published,
        "Tighten the opening paragraph.",
        "opencode-live-round-trip-thread-first",
      );
      const second = await client.openThread(
        published,
        "The summary table needs a total row.",
        "opencode-live-round-trip-thread-second",
      );
      replies.push(
        {
          kind: "toolCalls",
          toolCalls: [{
            arguments: {
              operation: "get_bundle",
              threadIds: [first.id, second.id],
            },
            name: "artifact_comments",
          }],
        },
        {
          kind: "toolCalls",
          toolCalls: [{
            arguments: {
              body: "Rewrote the opening paragraph.",
              operation: "reply",
              threadId: first.id,
            },
            name: "artifact_comments",
          }],
        },
        {
          kind: "toolCalls",
          toolCalls: [{
            arguments: {operation: "resolve", threadId: first.id},
            name: "artifact_comments",
          }],
        },
        {
          kind: "toolCalls",
          toolCalls: [{
            arguments: {
              body: "Added the total row to the summary table.",
              operation: "reply",
              threadId: second.id,
            },
            name: "artifact_comments",
          }],
        },
        {
          kind: "toolCalls",
          toolCalls: [{
            arguments: {operation: "resolve", threadId: second.id},
            name: "artifact_comments",
          }],
        },
        {kind: "text", text: "All annotations addressed."},
      );

      // Put OpenCode to work, and wait until the model is holding that turn
      // open. The first request is title generation; the second is real work.
      await model.waitForTurns(2);
      expect(bundleMessages(model.turns()[0] ?? emptyTurn)).toStrictEqual([]);
      expect(bundleMessages(model.turns()[1] ?? emptyTurn)).toStrictEqual([]);

      // Send the bundle while OpenCode is busy.
      const created = dispatchCreationSchema.parse(
        await (await client.sendDispatch({
          agentId: agent.id,
          idempotencyKey: "opencode-live-round-trip-dispatch",
          note: "Both of these are on the current version.",
          projectId: published.artifact.projectId,
          threadIds: [first.id, second.id],
        })).json(),
      );
      expect(created.dispatch.state).toBe("queued");

      // The bridge claims it and injects it as follow-up work, all while
      // OpenCode is still inside the first unit of work.
      const delivered = await waitForDispatchState(
        client,
        published.artifact.projectId,
        created.dispatch.id,
        ["delivered"],
      );
      expect(delivered.deliveredAt).not.toBeNull();
      expect(model.turns()).toHaveLength(2);

      // Releasing the work boundary is what lets OpenCode see the bundle.
      work.open();
      await model.waitForTurns(3, 30_000);
      const boundaryTurn = model.turns()[2];
      expect(boundaryTurn).toBeDefined();
      const bundle = latestUserMessage(boundaryTurn ?? emptyTurn);
      expect(bundle.startsWith("Artifact Server:")).toBe(true);
      expect(bundle).toContain("sent 2 annotation(s) to address");
      expect(bundle).toContain("Both of these are on the current version.");
      expect(bundle).toContain(`(thread ${first.id})`);
      expect(bundle).toContain(`(thread ${second.id})`);
      expect(bundle).toContain("use the artifact_comments tool");
      // One send is one message: the boundary delivered exactly one bundle.
      expect(bundleMessages(boundaryTurn ?? emptyTurn)).toHaveLength(1);

      // The registered tool really reads through the comment API: the
      // get_bundle result OpenCode fed back carries both annotation bodies.
      await model.waitForTurns(4, 30_000);
      const toolResults = (model.turns()[3] ?? emptyTurn).messages
        .filter((message) => message.role === "tool")
        .map((message) => message.text)
        .join("\n");
      expect(toolResults).toContain("Tighten the opening paragraph.");
      expect(toolResults).toContain("The summary table needs a total row.");

      // The agent then works the threads through the registered tool.
      // Title generation is turn 1, the held main prompt is turn 2, and the
      // reply sequence starts at turn 3.
      await model.waitForTurns(replies.length + 2, 60_000);
      const firstDetails = await readThread(client, published, first.id);
      const secondDetails = await readThread(client, published, second.id);
      expect(firstDetails.thread.state).toBe("resolved");
      expect(secondDetails.thread.state).toBe("resolved");
      expect(firstDetails.replies.map((reply) => reply.body)).toStrictEqual([
        "Rewrote the opening paragraph.",
      ]);
      expect(secondDetails.replies.map((reply) => reply.body)).toStrictEqual([
        "Added the total row to the summary table.",
      ]);

      // Every thread resolved, so the dispatch reads addressed.
      const addressed = await waitForDispatchState(
        client,
        published.artifact.projectId,
        created.dispatch.id,
        ["addressed"],
      );
      expect(addressed.addressedAt).not.toBeNull();
    },
  );
});
