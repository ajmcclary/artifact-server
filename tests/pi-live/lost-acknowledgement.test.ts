/**
 * PI-LIVE 4 — a lost `delivered` acknowledgement against a REAL Pi process.
 *
 * A loopback fault proxy destroys the bridge's first `delivered` report BEFORE
 * it reaches the server, so the wire-level shape is exactly a lost
 * acknowledgement: Pi admitted the bundle, but the server still holds the
 * dispatch `claimed` under its five-minute lease. The suite then advances the
 * server's test clock past the lease and proves the recovery the protocol
 * promises: the bundle is requeued at lease expiry, redelivered byte-identically,
 * the real host tolerates the duplicate admission, and the dispatch settles
 * `delivered` — never `failed`.
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
  createPiEnvironment,
  type PiEnvironment,
  scriptedModel,
} from "./support/pi-environment.js";
import {type LivePi, resolvePiCli, startLivePi} from "./support/live-pi.js";
import {
  readDispatch,
  waitForConnectedAgent,
  waitForDispatchState,
} from "./support/server-observations.js";

const bridgeExtension = new URL(
  "../../integrations/pi/index.ts",
  import.meta.url,
).pathname;

const emptyTurn: ModelTurn = {index: 0, messages: []};

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

describe("live Pi bridge lost acknowledgement", () => {
  let clock: MutableClock;
  let installation: TestInstallation;
  let server: RunningTestServer;
  let proxy: BridgeFaultProxy;
  let client: ApiClient;
  let published: PublishResponse;
  let environment: PiEnvironment;
  let model: ScriptedModel;
  let pi: LivePi;

  beforeAll(async () => {
    const cliPath = await resolvePiCli();
    if (cliPath === null) throw new Error("No pi CLI was found.");

    clock = new MutableClock();
    installation = await createTestInstallation();
    server = await startTestServer(installation, {clock});
    proxy = await startBridgeFaultProxy(server.baseUrl);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Live lost acknowledgement</title>",
      idempotencyKey: "pi-live-lost-ack-publish",
      name: "Live lost acknowledgement report",
    })).body;

    model = await startScriptedModel(async () =>
      // Bundle turns end without tool calls: this test proves redelivery and
      // settlement, and the tool path is covered by the round-trip test.
      ({kind: "text", text: "Handled the bundle."})
    );
    environment = await createPiEnvironment(model.baseUrl);
    pi = await startLivePi({
      agentDirectory: environment.agentDirectory,
      cliPath,
      extensionPath: bridgeExtension,
      model: scriptedModel,
      origin: proxy.origin,
      projectDirectory: environment.projectDirectory,
      token: installation.apiToken,
    });
    // The first delivered report the bridge ever sends dies on the wire.
    proxy.dropNextDeliveredReports(1);
  });

  afterAll(async () => {
    await pi.stop();
    await model.stop();
    await environment.remove();
    await proxy.stop();
    await server.stop();
    await removeTestInstallation(installation);
  });

  test(
    "PI-LIVE 4: a lost delivered report requeues at lease expiry, redelivers identically, and settles delivered",
    async () => {
      expect.hasAssertions();
      const agent = await waitForConnectedAgent(client);
      const projectId = published.artifact.projectId;

      // Get an initial exchange out of the way so the dispatch arrives as a
      // follow-up on an idle session.
      pi.submit("Say hello.");
      await model.waitForTurns(1);

      const thread = await client.openThread(
        published,
        "The heading should name the quarter.",
        "pi-live-lost-ack-thread",
      );
      const created = dispatchCreationSchema.parse(
        await (await client.sendDispatch({
          agentId: agent.id,
          idempotencyKey: "pi-live-lost-ack-dispatch",
          projectId,
          threadIds: [thread.id],
        })).json(),
      );
      expect(created.dispatch.state).toBe("queued");

      // The bridge claims, Pi admits the bundle as a follow-up, and the report
      // back dies on the wire.
      await model.waitForTurns(2, 30_000);
      const firstDelivery = latestUserMessage(model.turns()[1] ?? emptyTurn);
      expect(firstDelivery.startsWith("Artifact Server:")).toBe(true);
      expect(firstDelivery).toContain(`(thread ${thread.id})`);
      // Pi's sendUserMessage resolves before the delivered report is sent, so
      // poll until the proxy has recorded the drop.
      const dropDeadline = Date.now() + 10_000;
      while (proxy.droppedDeliveredReports() < 1) {
        if (Date.now() > dropDeadline) break;
        // eslint-disable-next-line no-await-in-loop
        await sleep(100);
      }
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
      await model.waitForTurns(3, 60_000);
      const redelivery = latestUserMessage(model.turns()[2] ?? emptyTurn);
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
