/**
 * CLAUDE-LIVE 3 — a duplicate lease delivery against a REAL Claude Code
 * process.
 *
 * The fault proxy records the first claim poll that hands the channel a
 * dispatch and then answers the channel's next claim poll with a byte copy of
 * that same response — the proxy-level shape of the server handing one lease
 * out twice. The honest, observed behavior this test proves:
 *
 * - the bridge's posture is at-least-once, so the replayed lease is delivered
 *   again: the REAL host tolerates the duplicate channel event (a second,
 *   byte-identical notification enters the session and work continues);
 * - the settlement stays singular: the second `delivered` report is refused
 *   by the real server with 409 `DISPATCH_STATE_CONFLICT`, and the dispatch
 *   reads `delivered` exactly once — never `failed`.
 *
 * The model is the suite's scripted Anthropic endpoint, so the host is real
 * but no metered provider usage is involved.
 */

import {afterAll, beforeAll, describe, expect, test} from "vitest";

import {
  ApiClient,
  dispatchCreationSchema,
} from "../support/agent-dispatch.js";
import {
  type BridgeFaultProxy,
  startBridgeFaultProxy,
} from "../support/bridge-fault-proxy.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
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
  waitForConnectedAgent,
  waitForDispatchState,
} from "../pi-live/support/server-observations.js";

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** Count the channel bundle events for one thread in one turn. */
function bundleCopies(turns: readonly ModelTurn[], threadId: string): number {
  const last = turns.at(-1);
  if (last === undefined) return 0;
  return last.messages.filter(
    (message) =>
      message.role === "user" && message.text.includes(`(thread ${threadId})`),
  ).length;
}

describe("live Claude Code channel duplicate lease delivery", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let proxy: BridgeFaultProxy;
  let client: ApiClient;
  let published: PublishResponse;
  let environment: ClaudeEnvironment;
  let model: ScriptedModel;
  let claude: LiveClaude;

  beforeAll(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    proxy = await startBridgeFaultProxy(server.baseUrl);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Live duplicate claim</title>",
      idempotencyKey: "claude-live-duplicate-claim-publish",
      name: "Live duplicate claim report",
    })).body;

    // This test proves duplicate tolerance and singular settlement, not tool
    // close-out (that is CLAUDE-LIVE 1), so the model answers text only.
    model = await startScriptedAnthropic(async (_turn: ModelTurn) => {
      return {kind: "text", text: "Standing by."};
    });
    environment = await createClaudeEnvironment({
      apiToken: installation.apiToken,
      origin: proxy.origin,
    });
    claude = await startLiveClaude({
      anthropicBaseUrl: model.baseUrl,
      homeDirectory: environment.homeDirectory,
      projectDirectory: environment.projectDirectory,
    });
    // Arm the one-shot replay: the first real dispatch claim is forwarded and
    // recorded, and the claim poll after it gets the duplicate.
    proxy.replayNextClaim();
  });

  afterAll(async () => {
    await claude.stop();
    await model.stop();
    await environment.remove();
    await proxy.stop();
    await server.stop();
    await removeTestInstallation(installation);
  });

  test(
    "CLAUDE-LIVE 3: a replayed claim is tolerated by the host and settles the dispatch exactly once",
    async () => {
      expect.hasAssertions();
      const agent = await waitForConnectedAgent(client, 120_000);
      const projectId = published.artifact.projectId;

      const thread = await client.openThread(
        published,
        "The summary needs a date stamp.",
        "claude-live-duplicate-claim-thread",
      );
      const created = dispatchCreationSchema.parse(
        await (await client.sendDispatch({
          agentId: agent.id,
          idempotencyKey: "claude-live-duplicate-claim-dispatch",
          projectId,
          threadIds: [thread.id],
        })).json(),
      );
      expect(created.dispatch.state).toBe("queued");

      // The first claim is real: the channel writes the notification and the
      // dispatch settles delivered.
      const delivered = await waitForDispatchState(
        client,
        projectId,
        created.dispatch.id,
        ["delivered"],
        120_000,
      );
      expect(delivered.deliveredAt).not.toBeNull();

      // The replayed lease is delivered again, and its report is refused with
      // a state conflict: settlement stays singular and never fails.
      const conflictDeadline = Date.now() + 60_000;
      while (proxy.deliveredReportStatuses().length < 2) {
        if (Date.now() > conflictDeadline) break;
        // eslint-disable-next-line no-await-in-loop
        await sleep(100);
      }
      expect(proxy.replayedClaims()).toBe(1);
      expect(proxy.deliveredReportStatuses()).toStrictEqual([200, 409]);
      const settled = await waitForDispatchState(
        client,
        projectId,
        created.dispatch.id,
        ["delivered"],
      );
      expect(settled.failedAt).toBeNull();
      expect(settled.failureReason).toBeNull();

      // The host tolerated the duplicate channel event: both byte-identical
      // copies are in the session's conversation. Claude Code may not surface
      // channel events to the model until a turn runs, so nudge if needed.
      await sleep(5_000);
      if (bundleCopies(model.turns(), thread.id) < 2) {
        claude.submit("Please check for new review work.");
      }
      const copiesDeadline = Date.now() + 90_000;
      while (bundleCopies(model.turns(), thread.id) < 2) {
        if (Date.now() > copiesDeadline) {
          throw new Error(
            `The duplicate channel events never both reached the model; ` +
              `screen: ${claude.screen().slice(-300)}`,
          );
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(500);
      }
      expect(bundleCopies(model.turns(), thread.id)).toBe(2);
    },
  );
});
