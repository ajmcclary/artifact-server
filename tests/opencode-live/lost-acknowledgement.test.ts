/**
 * OPENCODE-LIVE 5 — a lost `delivered` acknowledgement against a REAL OpenCode
 * process.
 *
 * A loopback fault proxy destroys the bridge's first `delivered` report
 * BEFORE it reaches the server, so the wire-level shape is exactly a lost
 * acknowledgement: OpenCode admitted the bundle, but the server still holds
 * the dispatch `claimed` under its five-minute lease. The suite then advances
 * the server's test clock past the lease (the runtime harness's `clock` seam —
 * waiting out five real minutes would make the live suite impractical) and
 * proves the recovery the protocol promises: the bundle is requeued at lease
 * expiry, redelivered byte-identically, the real host tolerates the duplicate
 * admission, and the dispatch settles `delivered` — never `failed`.
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
  latestUserMessage,
  type ModelTurn,
  type ScriptedModel,
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
import {
  readDispatch,
  waitForConnectedAgent,
  waitForDispatchState,
} from "./support/server-observations.js";

const bridgeExtension = new URL(
  "../../integrations/opencode/index.ts",
  import.meta.url,
).pathname;

const emptyTurn: ModelTurn = {index: 0, messages: []};

/** The server-side claim lease the lost report must outlive. */
const claimLeaseMilliseconds = 5 * 60 * 1_000;
/**
 * Advance past the lease but stay well inside the fifteen-minute
 * agent-unavailable staleness window, so the requeue is a lease expiry and
 * not an agent liveness failure.
 */
const clockAdvanceMilliseconds = claimLeaseMilliseconds + 60_000;

function isTitleGenerationTurn(turn: ModelTurn): boolean {
  return turn.messages.some(
    (message) =>
      message.role === "system" && message.text.includes("title generator"),
  );
}

describe("live OpenCode bridge lost acknowledgement", () => {
  let clock: MutableClock;
  let installation: TestInstallation;
  let server: RunningTestServer;
  let proxy: BridgeFaultProxy;
  let client: ApiClient;
  let published: PublishResponse;
  let environment: OpencodeEnvironment;
  let model: ScriptedModel;
  let opencode: LiveOpencode;

  beforeAll(async () => {
    const cliPath = await resolveOpencodeCli();
    if (cliPath === null) throw new Error("No opencode CLI was found.");

    clock = new MutableClock();
    installation = await createTestInstallation();
    server = await startTestServer(installation, {clock});
    proxy = await startBridgeFaultProxy(server.baseUrl);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Live lost acknowledgement</title>",
      idempotencyKey: "opencode-live-lost-ack-publish",
      name: "Live lost acknowledgement report",
    })).body;

    model = await startScriptedModel(async (turn: ModelTurn) => {
      if (isTitleGenerationTurn(turn)) {
        return {kind: "text", text: "Live lost acknowledgement"};
      }
      // Bundle turns end without tool calls: this test proves redelivery and
      // settlement, and the tool path is covered by the round-trip test.
      return {kind: "text", text: "Handled the bundle."};
    });
    environment = await createOpencodeEnvironment(model.baseUrl, bridgeExtension);
    opencode = await startLiveOpencode(
      {
        agentName: "opencode-live-lost-ack",
        cacheDirectory: environment.cacheDirectory,
        configDirectory: environment.configDirectory,
        dataDirectory: environment.dataDirectory,
        origin: proxy.origin,
        projectDirectory: environment.projectDirectory,
        stateDirectory: environment.stateDirectory,
        token: installation.apiToken,
      },
      "Say hello.",
    );
    // The first delivered report the bridge ever sends dies on the wire.
    proxy.dropNextDeliveredReports(1);
  });

  afterAll(async () => {
    await opencode.stop();
    await model.stop();
    await environment.remove();
    await proxy.stop();
    await server.stop();
    await removeTestInstallation(installation);
  });

  test(
    "OPENCODE-LIVE 5: a lost delivered report requeues at lease expiry, redelivers identically, and settles delivered",
    async () => {
      expect.hasAssertions();
      const agent = await waitForConnectedAgent(client);
      const projectId = published.artifact.projectId;
      // Title generation is turn 1, the initial prompt is turn 2.
      await model.waitForTurns(2);

      const thread = await client.openThread(
        published,
        "The heading should name the quarter.",
        "opencode-live-lost-ack-thread",
      );
      const created = dispatchCreationSchema.parse(
        await (await client.sendDispatch({
          agentId: agent.id,
          idempotencyKey: "opencode-live-lost-ack-dispatch",
          projectId,
          threadIds: [thread.id],
        })).json(),
      );
      expect(created.dispatch.state).toBe("queued");

      // The bridge claims, OpenCode admits the bundle as a follow-up, and the
      // report back dies on the wire.
      await model.waitForTurns(3, 30_000);
      const firstDelivery = latestUserMessage(model.turns()[2] ?? emptyTurn);
      expect(firstDelivery.startsWith("Artifact Server:")).toBe(true);
      expect(firstDelivery).toContain(`(thread ${thread.id})`);
      expect(proxy.droppedDeliveredReports()).toBe(1);

      // The server never saw the report: the dispatch is still claimed.
      const stillClaimed = await readDispatch(client, projectId, created.dispatch.id);
      expect(stillClaimed).toMatchObject({
        deliveredAt: null,
        failedAt: null,
        state: "claimed",
      });

      // The claim lease expires: the server requeues the bundle and the
      // bridge's next poll claims it again.
      clock.advance(clockAdvanceMilliseconds);
      await model.waitForTurns(4, 60_000);
      const redelivery = latestUserMessage(model.turns()[3] ?? emptyTurn);
      // Byte-identical redelivery — the immutable bundle, not a re-render.
      expect(redelivery).toBe(firstDelivery);

      // The second report lands: the dispatch settles delivered, never failed.
      const settled = await waitForDispatchState(
        client,
        projectId,
        created.dispatch.id,
        ["delivered"],
      );
      expect(settled.failedAt).toBeNull();
      expect(settled.failureReason).toBeNull();
      expect(settled.deliveredAt).not.toBeNull();
      // Exactly one report reached the server, and it succeeded.
      expect(proxy.deliveredReportStatuses()).toStrictEqual([200]);
    },
  );
});
