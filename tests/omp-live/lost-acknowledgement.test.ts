/**
 * OMP-LIVE 4 — a lost `delivered` acknowledgement against a REAL omp process.
 *
 * A loopback fault proxy destroys the bridge's first `delivered` report
 * BEFORE it reaches the server, so the wire-level shape is exactly a lost
 * acknowledgement: omp admitted the bundle, but the server still holds the
 * dispatch `claimed` under its five-minute lease. The suite then advances the
 * server's test clock past the lease (the runtime harness's `clock` seam —
 * waiting out five real minutes would make the live suite impractical) and
 * proves the recovery the protocol promises: the bundle is requeued at lease
 * expiry, redelivered byte-identically, the real host tolerates the duplicate
 * admission, and the dispatch settles `delivered` — never `failed`.
 *
 * Host observation note: omp queues admitted follow-ups without starting a
 * turn at idle (proven in OMP-LIVE 3), so the duplicate admission is observed
 * in the first model turn after the user's own next prompt.
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
  bundleMessages,
  type ModelTurn,
  type ScriptedModel,
  startScriptedModel,
} from "../pi-live/support/scripted-model.js";
import {
  createOmpEnvironment,
  type OmpEnvironment,
  scriptedModel,
  scriptedModelName,
} from "./support/omp-environment.js";
import {type LiveOmp, resolveOmpCli, startLiveOmp} from "./support/live-omp.js";
import {
  readDispatch,
  waitForConnectedAgent,
  waitForDispatchState,
} from "../pi-live/support/server-observations.js";

const bridgeExtension = new URL(
  "../../integrations/omp/index.ts",
  import.meta.url,
).pathname;

/** The server-side claim lease the lost report must outlive. */
const claimLeaseMilliseconds = 5 * 60 * 1_000;
/**
 * Advance past the lease but stay well inside the fifteen-minute
 * agent-unavailable staleness window, so the requeue is a lease expiry and
 * not an agent liveness failure.
 */
const clockAdvanceMilliseconds = claimLeaseMilliseconds + 60_000;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

describe("live omp bridge lost acknowledgement", () => {
  let clock: MutableClock;
  let installation: TestInstallation;
  let server: RunningTestServer;
  let proxy: BridgeFaultProxy;
  let client: ApiClient;
  let published: PublishResponse;
  let environment: OmpEnvironment;
  let model: ScriptedModel;
  let omp: LiveOmp;

  beforeAll(async () => {
    const cliPath = await resolveOmpCli();
    if (cliPath === null) throw new Error("No omp CLI was found.");

    clock = new MutableClock();
    installation = await createTestInstallation();
    server = await startTestServer(installation, {clock});
    proxy = await startBridgeFaultProxy(server.baseUrl);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Live lost acknowledgement</title>",
      idempotencyKey: "omp-live-lost-ack-publish",
      name: "Live lost acknowledgement report",
    })).body;

    model = await startScriptedModel(async (_turn: ModelTurn) => {
      return {kind: "text", text: "Handled the bundle."};
    });
    environment = await createOmpEnvironment(model.baseUrl);
    omp = await startLiveOmp({
      agentDirectory: environment.agentDirectory,
      cliPath,
      extensionPath: bridgeExtension,
      model: scriptedModel,
      modelName: scriptedModelName,
      origin: proxy.origin,
      projectDirectory: environment.projectDirectory,
      token: installation.apiToken,
    });
    // The first delivered report the bridge ever sends dies on the wire.
    proxy.dropNextDeliveredReports(1);
  });

  afterAll(async () => {
    await omp.stop();
    await model.stop();
    await proxy.stop();
    await environment.remove();
    await server.stop();
    await removeTestInstallation(installation);
  });

  test(
    "OMP-LIVE 4: a lost delivered report requeues at lease expiry, redelivers identically, and settles delivered",
    async () => {
      expect.hasAssertions();
      const agent = await waitForConnectedAgent(client);
      const projectId = published.artifact.projectId;

      const thread = await client.openThread(
        published,
        "The heading should name the quarter.",
        "omp-live-lost-ack-thread",
      );
      const created = dispatchCreationSchema.parse(
        await (await client.sendDispatch({
          agentId: agent.id,
          idempotencyKey: "omp-live-lost-ack-dispatch",
          projectId,
          threadIds: [thread.id],
        })).json(),
      );
      expect(created.dispatch.state).toBe("queued");

      // omp admits the bundle as a follow-up; the report back dies on the
      // wire. Wait for the drop, then give the bridge a moment to return to
      // its claim poll.
      const dropDeadline = Date.now() + 30_000;
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
      // bridge's next poll claims it again; the second report lands.
      clock.advance(clockAdvanceMilliseconds);
      const settled = await waitForDispatchState(
        client,
        projectId,
        created.dispatch.id,
        ["delivered"],
        90_000,
      );
      expect(settled.failedAt).toBeNull();
      expect(settled.failureReason).toBeNull();
      expect(settled.deliveredAt).not.toBeNull();
      // Exactly one report reached the server, and it succeeded.
      expect(proxy.deliveredReportStatuses()).toStrictEqual([200]);

      // The host tolerated the duplicate admission: both copies — byte
      // identical — are queued follow-ups. omp drains one queued follow-up
      // per work boundary after the user's own next prompt, so watch the
      // turns that follow the prompt until both copies have drained.
      omp.submit("Please continue.");
      const drainDeadline = Date.now() + 60_000;
      let admitted: readonly string[] = [];
      for (;;) {
        // Turns carry the whole conversation, so only the newest turn's
        // bundle count is the true admission count.
        const newest = model.turns().at(-1);
        admitted = newest === undefined
          ? []
          : bundleMessages(newest).filter((bundle) =>
            bundle.includes(`(thread ${thread.id})`)
          );
        if (admitted.length >= 2) break;
        if (Date.now() > drainDeadline) {
          throw new Error(
            `Only ${admitted.length} bundle copy/copies drained; screen: ${
              omp.output().slice(-400)
            }`,
          );
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(250);
      }
      expect(admitted).toHaveLength(2);
      expect(admitted[1]).toBe(admitted[0]);
    },
  );
});
