/**
 * CLAUDE-LIVE 2 — a lost `delivered` acknowledgement against a REAL Claude
 * Code process.
 *
 * A loopback fault proxy destroys the channel's first `delivered` report
 * BEFORE it reaches the server, so the wire-level shape is exactly a lost
 * acknowledgement: the channel notification was written (the bundle reached
 * the session's transport), but the server still holds the dispatch `claimed`
 * under its five-minute lease. The suite then advances the server's test
 * clock past the lease (the runtime harness's `clock` seam — waiting out five
 * real minutes would make the live suite impractical) and proves the recovery
 * the protocol promises: the bundle is requeued at lease expiry, redelivered
 * byte-identically, the real host tolerates the duplicate channel event, and
 * the dispatch settles `delivered` — never `failed`.
 *
 * The model is the suite's scripted Anthropic endpoint, so the host is real
 * but no metered provider usage is involved.
 */

import {afterAll, beforeAll, describe, expect, test} from "vitest";

import {
  ApiClient,
  dispatchCreationSchema,
  MutableClock,
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
  readDispatch,
  waitForConnectedAgent,
  waitForDispatchState,
} from "../pi-live/support/server-observations.js";

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** The server-side claim lease the lost report must outlive. */
const claimLeaseMilliseconds = 5 * 60 * 1_000;
/**
 * Advance past the lease but stay well inside the fifteen-minute
 * agent-unavailable staleness window, so the requeue is a lease expiry and
 * not an agent liveness failure.
 */
const clockAdvanceMilliseconds = claimLeaseMilliseconds + 60_000;

/** Count the channel bundle events for one thread in one turn. */
function bundleCopies(turns: readonly ModelTurn[], threadId: string): number {
  const last = turns.at(-1);
  if (last === undefined) return 0;
  return last.messages.filter(
    (message) =>
      message.role === "user" && message.text.includes(`(thread ${threadId})`),
  ).length;
}

describe("live Claude Code channel lost acknowledgement", () => {
  let clock: MutableClock;
  let installation: TestInstallation;
  let server: RunningTestServer;
  let proxy: BridgeFaultProxy;
  let client: ApiClient;
  let published: PublishResponse;
  let environment: ClaudeEnvironment;
  let model: ScriptedModel;
  let claude: LiveClaude;

  beforeAll(async () => {
    clock = new MutableClock();
    installation = await createTestInstallation();
    server = await startTestServer(installation, {clock});
    proxy = await startBridgeFaultProxy(server.baseUrl);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Live lost acknowledgement</title>",
      idempotencyKey: "claude-live-lost-ack-publish",
      name: "Live lost acknowledgement report",
    })).body;

    // This test proves redelivery and settlement, not tool close-out (that is
    // CLAUDE-LIVE 1), so the model simply answers every turn with text.
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
    // The first delivered report the channel ever sends dies on the wire.
    proxy.dropNextDeliveredReports(1);
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
    "CLAUDE-LIVE 2: a lost delivered report requeues at lease expiry, redelivers identically, and settles delivered",
    async () => {
      expect.hasAssertions();
      const agent = await waitForConnectedAgent(client, 120_000);
      const projectId = published.artifact.projectId;

      const thread = await client.openThread(
        published,
        "The heading should name the quarter.",
        "claude-live-lost-ack-thread",
      );
      const created = dispatchCreationSchema.parse(
        await (await client.sendDispatch({
          agentId: agent.id,
          idempotencyKey: "claude-live-lost-ack-dispatch",
          projectId,
          threadIds: [thread.id],
        })).json(),
      );
      expect(created.dispatch.state).toBe("queued");

      // The channel writes the notification; the report back dies on the
      // wire. Wait for the drop, then give the bridge a moment to return to
      // its claim poll.
      const dropDeadline = Date.now() + 60_000;
      while (proxy.droppedDeliveredReports() === 0) {
        if (Date.now() > dropDeadline) {
          throw new Error("The first delivered report was never attempted.");
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(100);
      }
      await sleep(1_000);

      // The server never saw the report: the dispatch is still claimed.
      const stillClaimed = await readDispatch(client, projectId, created.dispatch.id);
      expect(stillClaimed).toMatchObject({
        deliveredAt: null,
        failedAt: null,
        state: "claimed",
      });

      // The claim lease expires: the server requeues the bundle and the
      // channel's next poll claims it again; the second report lands.
      clock.advance(clockAdvanceMilliseconds);
      const settled = await waitForDispatchState(
        client,
        projectId,
        created.dispatch.id,
        ["delivered"],
        120_000,
      );
      expect(settled.failedAt).toBeNull();
      expect(settled.failureReason).toBeNull();
      expect(settled.deliveredAt).not.toBeNull();
      // Exactly one report reached the server, and it succeeded.
      expect(proxy.deliveredReportStatuses()).toStrictEqual([200]);

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
