/**
 * PI-LIVE 5 — a duplicate lease delivery against a REAL Pi process.
 *
 * The fault proxy records the first claim poll that hands the bridge a dispatch
 * and then answers the bridge's next claim poll with a byte copy of that same
 * response — the proxy-level shape of the server handing one lease out twice.
 * The honest, observed behavior this test proves:
 *
 * - the bridge's posture is at-least-once, so the replayed lease is delivered
 *   again: the REAL host tolerates the duplicate admission (a second,
 *   byte-identical follow-up enters the conversation and work continues);
 * - the settlement stays singular: the second `delivered` report is refused
 *   by the real server with 409 `DISPATCH_STATE_CONFLICT`, and the dispatch
 *   reads `delivered` exactly once — never `failed`.
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

describe("live Pi bridge duplicate lease delivery", () => {
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

    installation = await createTestInstallation();
    server = await startTestServer(installation);
    proxy = await startBridgeFaultProxy(server.baseUrl);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Live duplicate claim</title>",
      idempotencyKey: "pi-live-duplicate-claim-publish",
      name: "Live duplicate claim report",
    })).body;

    model = await startScriptedModel(async () =>
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
    // Arm the one-shot replay: the first real dispatch claim is forwarded and
    // recorded, and the claim poll after it gets the duplicate.
    proxy.replayNextClaim();
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
    "PI-LIVE 5: a replayed claim is tolerated by the host and settles the dispatch exactly once",
    async () => {
      expect.hasAssertions();
      const agent = await waitForConnectedAgent(client);
      const projectId = published.artifact.projectId;

      pi.submit("Say hello.");
      await model.waitForTurns(1);

      const thread = await client.openThread(
        published,
        "The summary needs a date stamp.",
        "pi-live-duplicate-claim-thread",
      );
      const created = dispatchCreationSchema.parse(
        await (await client.sendDispatch({
          agentId: agent.id,
          idempotencyKey: "pi-live-duplicate-claim-dispatch",
          projectId,
          threadIds: [thread.id],
        })).json(),
      );
      expect(created.dispatch.state).toBe("queued");

      // The first claim is real: Pi admits the bundle and the dispatch settles
      // delivered.
      const delivered = await waitForDispatchState(
        client,
        projectId,
        created.dispatch.id,
        ["delivered"],
      );
      expect(delivered.deliveredAt).not.toBeNull();
      await model.waitForTurns(2, 30_000);
      const firstDelivery = latestUserMessage(model.turns()[1] ?? emptyTurn);
      expect(firstDelivery.startsWith("Artifact Server:")).toBe(true);
      expect(firstDelivery).toContain(`(thread ${thread.id})`);

      // The replayed lease delivers the same bundle again: the host tolerates
      // the duplicate admission and keeps working.
      await model.waitForTurns(3, 60_000);
      expect(proxy.replayedClaims()).toBe(1);
      const duplicateDelivery = latestUserMessage(model.turns()[2] ?? emptyTurn);
      expect(duplicateDelivery).toBe(firstDelivery);

      // Settlement stays singular: the duplicate report is refused with a
      // state conflict, and the dispatch never leaves `delivered`.
      const conflictDeadline = Date.now() + 30_000;
      while (proxy.deliveredReportStatuses().length < 2) {
        if (Date.now() > conflictDeadline) break;
        // eslint-disable-next-line no-await-in-loop
        await sleep(100);
      }
      expect(proxy.deliveredReportStatuses()).toStrictEqual([200, 409]);
      const settled = await waitForDispatchState(
        client,
        projectId,
        created.dispatch.id,
        ["delivered"],
      );
      expect(settled.failedAt).toBeNull();
      expect(settled.failureReason).toBeNull();
    },
  );
});
