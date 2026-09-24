/**
 * OMP-LIVE 5 — a duplicate lease delivery against a REAL omp process.
 *
 * The fault proxy records the first claim poll that hands the bridge a
 * dispatch and then answers the bridge's next claim poll with a byte copy of
 * that same response — the proxy-level shape of the server handing one lease
 * out twice. The honest, observed behavior this test proves:
 *
 * - the bridge's posture is at-least-once, so the replayed lease is delivered
 *   again: the REAL host tolerates the duplicate admission (a second,
 *   byte-identical follow-up is queued and work continues);
 * - the settlement stays singular: the second `delivered` report is refused
 *   by the real server with 409 `DISPATCH_STATE_CONFLICT`, and the dispatch
 *   reads `delivered` exactly once — never `failed`.
 *
 * Host observation note: omp queues admitted follow-ups without starting a
 * turn at idle (proven in OMP-LIVE 3), so the duplicate admission is observed
 * in the first model turn after the user's own next prompt.
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
  waitForConnectedAgent,
  waitForDispatchState,
} from "../pi-live/support/server-observations.js";

const bridgeExtension = new URL(
  "../../integrations/omp/index.ts",
  import.meta.url,
).pathname;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

describe("live omp bridge duplicate lease delivery", () => {
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

    installation = await createTestInstallation();
    server = await startTestServer(installation);
    proxy = await startBridgeFaultProxy(server.baseUrl);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Live duplicate claim</title>",
      idempotencyKey: "omp-live-duplicate-claim-publish",
      name: "Live duplicate claim report",
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
    // Arm the one-shot replay: the first real dispatch claim is forwarded and
    // recorded, and the claim poll after it gets the duplicate.
    proxy.replayNextClaim();
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
    "OMP-LIVE 5: a replayed claim is tolerated by the host and settles the dispatch exactly once",
    async () => {
      expect.hasAssertions();
      const agent = await waitForConnectedAgent(client);
      const projectId = published.artifact.projectId;

      const thread = await client.openThread(
        published,
        "The summary needs a date stamp.",
        "omp-live-duplicate-claim-thread",
      );
      const created = dispatchCreationSchema.parse(
        await (await client.sendDispatch({
          agentId: agent.id,
          idempotencyKey: "omp-live-duplicate-claim-dispatch",
          projectId,
          threadIds: [thread.id],
        })).json(),
      );
      expect(created.dispatch.state).toBe("queued");

      // The first claim is real: omp admits the bundle and the dispatch
      // settles delivered.
      const delivered = await waitForDispatchState(
        client,
        projectId,
        created.dispatch.id,
        ["delivered"],
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
