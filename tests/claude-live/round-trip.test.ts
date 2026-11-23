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
 * Claude Code defers MCP tools behind its ToolSearch step. The channel marks
 * `artifact_comments` always-loaded, so CLAUDE-LIVE 1 calls it directly.
 * CLAUDE-LIVE 4 runs the same round trip with the user's `.mcp.json` forcing
 * the server's tools deferred (`alwaysLoad: false`): the model must load the
 * tool through ToolSearch first, as a real model would, and the bundle still
 * closes.
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
  deferredToolName,
  latestUserMessage,
  type ModelTurn,
  type ScriptedModel,
  type ScriptedReply,
  type ScriptedToolUse,
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

/** How the session's `artifact_comments` tool is loaded. */
interface ToolLoadingMode {
  readonly behavior: string;
  readonly id: string;
  readonly key: string;
  /** `.mcp.json` server-level override; null keeps the channel's marker. */
  readonly serverAlwaysLoad: boolean | null;
}

const toolLoadingModes: readonly ToolLoadingMode[] = [
  {
    behavior:
      "a bundle sent to the session arrives as a channel event and is closed through artifact_comments",
    id: "CLAUDE-LIVE 1",
    key: "always-loaded",
    serverAlwaysLoad: null,
  },
  {
    behavior:
      "with the server's tools deferred behind ToolSearch, the model loads artifact_comments first and the bundle still closes",
    id: "CLAUDE-LIVE 4",
    key: "deferred",
    serverAlwaysLoad: false,
  },
];

describe.each(toolLoadingModes)("live Claude Code channel round trip ($key)", (mode) => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;
  let environment: ClaudeEnvironment;
  let model: ScriptedModel;
  let claude: LiveClaude;
  let threadId = "";
  /** Every ToolSearch query the scripted model issued. */
  const searches: string[] = [];

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
    // A call planned while artifact_comments was still deferred: the model
    // loads the tool through ToolSearch, then makes this call next turn.
    let pendingCall: Omit<ScriptedToolUse, "name"> | null = null;
    const commentsCall = (
      turn: ModelTurn,
      input: ScriptedToolUse["input"],
    ): ScriptedReply => {
      const loaded = turn.toolNames.find((name) =>
        name.endsWith("artifact_comments")
      );
      if (loaded !== undefined) {
        return {kind: "toolUse", toolUses: [{input, name: loaded}]};
      }
      if (!turn.toolNames.includes("ToolSearch")) {
        return {kind: "text", text: "artifact_comments is unavailable."};
      }
      // Select the exact name when the deferred-tool list is in context;
      // otherwise search by the bare name the channel's instructions give.
      // (A fresh session whose first message is the channel event carries
      // no deferred-tool list yet on Claude Code 2.1.330.)
      const deferred = deferredToolName(turn, "artifact_comments");
      const query = deferred === null
        ? "artifact_comments"
        : `select:${deferred}`;
      searches.push(query);
      pendingCall = {input};
      return {
        kind: "toolUse",
        toolUses: [{input: {max_results: 1, query}, name: "ToolSearch"}],
      };
    };
    model = await startScriptedAnthropic(async (turn: ModelTurn) => {
      const pending = pendingCall;
      if (
        pending !== null &&
        turn.toolNames.some((name) => name.endsWith("artifact_comments"))
      ) {
        pendingCall = null;
        return commentsCall(turn, pending.input);
      }
      const latest = latestUserMessage(turn);
      if (latest.includes(`Resolved ${threadId}.`)) {
        return {kind: "text", text: "All annotations addressed."};
      }
      if (latest.includes(`Replied to ${threadId}.`)) {
        return commentsCall(turn, {operation: "resolve", threadId});
      }
      // Match the rendered bundle by its thread marker, not the "<channel"
      // tag: Claude Code re-quotes the MCP server's instructions (which name
      // the "<channel" tag) on every user message, so a tag match never
      // stops matching.
      if (latest.includes(`(thread ${threadId})`)) {
        return commentsCall(turn, {
          operation: "get_bundle",
          threadIds: [threadId],
        });
      }
      if (latest.includes("Tighten the opening paragraph.")) {
        // The get_bundle tool result came back with the annotation body.
        return commentsCall(turn, {
          body: "Rewrote the opening paragraph.",
          operation: "reply",
          threadId,
        });
      }
      return {kind: "text", text: "Standing by."};
    });
    environment = await createClaudeEnvironment({
      apiToken: installation.apiToken,
      origin: server.baseUrl,
      serverAlwaysLoad: mode.serverAlwaysLoad,
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
    `${mode.id}: ${mode.behavior}`,
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

      // The loading mode is real: the channel's always-load marker puts the
      // tool in the request, and the server-level override keeps it out.
      const advertised = bundleTurn.toolNames.some((name) =>
        name.endsWith("artifact_comments")
      );
      const deferred = mode.serverAlwaysLoad === false;
      expect(advertised).toBe(!deferred);

      // The close-out plays through the MCP tool: get_bundle's result carries
      // the annotation body, then reply and resolve land on the server, and
      // the dispatch reads addressed. A deferred tool costs one ToolSearch
      // turn first.
      const loadTurns = deferred ? 1 : 0;
      await model.waitForTurns(bundleTurn.index + 3 + loadTurns, 120_000).catch(
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
      // Exactly one ToolSearch load when deferred, none when always loaded.
      expect(searches).toHaveLength(loadTurns);
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
