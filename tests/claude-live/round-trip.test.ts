/**
 * CLAUDE-LIVE 1 — a bounded round trip against a REAL Claude Code process.
 *
 * A human publishes an artifact, annotates it, and sends the bundle to the
 * Claude session. The channel (a real MCP server process, spawned by Claude
 * Code itself through `.mcp.json` + the development-channel flag) reports
 * `delivered` when the notification is written to the transport. Claude then
 * reads the channel event, works the thread through the
 * `artifact_comments` MCP tool, and the dispatch reads `addressed`.
 *
 * The model is the suite's scripted Anthropic endpoint, so the host is real
 * but no metered provider usage is involved.
 */

import {afterAll, beforeAll, describe, expect, test} from "vitest";

import {realpath} from "node:fs/promises";

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
  startScriptedAnthropic,
} from "./support/scripted-anthropic.js";
import {
  type ClaudeEnvironment,
  createClaudeEnvironment,
} from "./support/claude-environment.js";
import {type LiveClaude, startLiveClaude} from "./support/live-claude.js";
import {
  readThread,
  waitForConnectedAgent,
  waitForDispatchState,
} from "../pi-live/support/server-observations.js";

const emptyTurn: ModelTurn = {index: 0, messages: [], toolNames: []};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

describe("live Claude Code channel round trip", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;
  let environment: ClaudeEnvironment;
  let model: ScriptedModel;
  let claude: LiveClaude;
  let threadId = "";

  beforeAll(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Live round trip</title>",
      idempotencyKey: "claude-live-round-trip-publish",
      name: "Live round trip report",
    })).body;

    // The planner is content-driven on the LATEST message, so extra host-side
    // model calls can never desynchronize it and conversation history never
    // retriggers an earlier step.
    model = await startScriptedAnthropic(async (turn: ModelTurn) => {
      const tool = turn.toolNames.find((name) =>
        name.endsWith("artifact_comments")
      ) ?? "artifact_comments";
      const latest = latestUserMessage(turn);
      if (latest.includes(`Resolved ${threadId}.`)) {
        return {kind: "text", text: "All annotations addressed."};
      }
      if (latest.includes(`Replied to ${threadId}.`)) {
        return {
          kind: "toolUse",
          toolUses: [{
            input: {operation: "resolve", threadId},
            name: tool,
          }],
        };
      }
      // Match the rendered bundle by its thread marker, not the "<channel"
      // tag: Claude Code re-quotes the MCP server's instructions (which name
      // the "<channel" tag) on every user message, so a tag match never
      // stops matching.
      if (latest.includes(`(thread ${threadId})`)) {
        return {
          kind: "toolUse",
          toolUses: [{
            input: {operation: "get_bundle", threadIds: [threadId]},
            name: tool,
          }],
        };
      }
      if (latest.includes("Tighten the opening paragraph.")) {
        // The get_bundle tool result came back with the annotation body.
        return {
          kind: "toolUse",
          toolUses: [{
            input: {
              body: "Rewrote the opening paragraph.",
              operation: "reply",
              threadId,
            },
            name: tool,
          }],
        };
      }
      return {kind: "text", text: "Standing by."};
    });
    environment = await createClaudeEnvironment({
      apiToken: installation.apiToken,
      origin: server.baseUrl,
    });
    claude = await startLiveClaude({
      anthropicBaseUrl: model.baseUrl,
      homeDirectory: environment.homeDirectory,
      projectDirectory: environment.projectDirectory,
    });
  });

  afterAll(async () => {
    await claude.stop();
    await model.stop();
    await environment.remove();
    await server.stop();
    await removeTestInstallation(installation);
  });

  test(
    "CLAUDE-LIVE 1: a bundle sent to the session arrives as a channel event and is closed through artifact_comments",
    async () => {
      expect.hasAssertions();

      // The channel process registered this Claude session by itself.
      const agent = await waitForConnectedAgent(client, 120_000);
      expect(agent.displayName).toBe("claude-live-suite");
      // Claude reports its cwd fully resolved (macOS maps /var to
      // /private/var), unlike the omp host which reports it unresolved.
      expect(agent.workingDirectory).toBe(
        await realpath(environment.projectDirectory),
      );

      const thread = await client.openThread(
        published,
        "Tighten the opening paragraph.",
        "claude-live-round-trip-thread",
      );
      threadId = thread.id;

      // Send the bundle. The channel's evidence tier reports delivered once
      // the notification is written to the transport.
      const created = dispatchCreationSchema.parse(
        await (await client.sendDispatch({
          agentId: agent.id,
          idempotencyKey: "claude-live-round-trip-dispatch",
          note: "This one is on the current version.",
          projectId: published.artifact.projectId,
          threadIds: [thread.id],
        })).json(),
      );
      expect(created.dispatch.state).toBe("queued");
      const delivered = await waitForDispatchState(
        client,
        published.artifact.projectId,
        created.dispatch.id,
        ["delivered"],
      );
      expect(delivered.deliveredAt).not.toBeNull();

      // Claude Code queues channel events while busy and surfaces them to the
      // model; if no turn picks the bundle up promptly, nudge with an
      // ordinary prompt.
      await sleep(5_000);
      if (model.turns().every((turn) => bundleMessages(turn).length === 0)) {
        claude.submit("Please check for new review work.");
      }

      const bundleDeadline = Date.now() + 90_000;
      let bundleTurn = emptyTurn;
      for (;;) {
        const candidate = model.turns().find((turn) =>
          bundleMessages(turn).length > 0
        );
        if (candidate !== undefined) {
          bundleTurn = candidate;
          break;
        }
        if (Date.now() > bundleDeadline) {
          throw new Error(
            `No model turn carried the channel bundle; turns: ${
              model.turns().length
            }; screen: ${claude.screen().slice(-300)}`,
          );
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(500);
      }

      // The bundle message is the channel event with the bridge's rendered
      // content.
      const bundle = latestUserMessage(bundleTurn);
      expect(bundle).toContain("Artifact Server:");
      expect(bundle).toContain(`(thread ${thread.id})`);
      expect(bundleMessages(bundleTurn)).toHaveLength(1);

      // The close-out plays through the MCP tool: get_bundle's result carries
      // the annotation body, then reply and resolve land on the server, and
      // the dispatch reads addressed.
      await model.waitForTurns(bundleTurn.index + 3, 120_000).catch(
        (error) => {
          throw new Error(
            `${String(error)}; screen: ${claude.screen().slice(-400)}`,
          );
        },
      );
      await sleep(2_000);
      const details = await readThread(client, published, thread.id);
      const turnSummary = model.turns().map((turn) =>
        `#${turn.index}: ${
          latestUserMessage(turn).replaceAll(/\s+/gu, " ").slice(0, 160)
        }`
      ).join(" | ");
      expect(details.thread.state, `turns: ${turnSummary}`).toBe("resolved");
      expect(details.replies.map((reply) => reply.body)).toStrictEqual([
        "Rewrote the opening paragraph.",
      ]);
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
