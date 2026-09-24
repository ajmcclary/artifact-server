/**
 * OPENCODE-LIVE 6 — a duplicate lease delivery against a REAL OpenCode
 * process.
 *
 * The fault proxy records the first claim poll that hands the bridge a
 * dispatch and then answers the bridge's next claim poll with a byte copy of
 * that same response — the proxy-level shape of the server handing one lease
 * out twice. The honest, observed behavior this test proves:
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
  createOpencodeEnvironment,
  type OpencodeEnvironment,
} from "./support/opencode-environment.js";
import {
  type LiveOpencode,
  resolveOpencodeCli,
  startLiveOpencode,
} from "./support/live-opencode.js";
import {
  waitForConnectedAgent,
  waitForDispatchState,
} from "./support/server-observations.js";

const bridgeExtension = new URL(
  "../../integrations/opencode/index.ts",
  import.meta.url,
).pathname;

const emptyTurn: ModelTurn = {index: 0, messages: []};

function isTitleGenerationTurn(turn: ModelTurn): boolean {
  return turn.messages.some(
    (message) =>
      message.role === "system" && message.text.includes("title generator"),
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

describe("live OpenCode bridge duplicate lease delivery", () => {
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

    installation = await createTestInstallation();
    server = await startTestServer(installation);
    proxy = await startBridgeFaultProxy(server.baseUrl);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Live duplicate claim</title>",
      idempotencyKey: "opencode-live-duplicate-claim-publish",
      name: "Live duplicate claim report",
    })).body;

    model = await startScriptedModel(async (turn: ModelTurn) => {
      if (isTitleGenerationTurn(turn)) {
        return {kind: "text", text: "Live duplicate claim"};
      }
      return {kind: "text", text: "Handled the bundle."};
    });
    environment = await createOpencodeEnvironment(model.baseUrl, bridgeExtension);
    opencode = await startLiveOpencode(
      {
        agentName: "opencode-live-duplicate-claim",
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
    // Arm the one-shot replay: the first real dispatch claim is forwarded and
    // recorded, and the claim poll after it gets the duplicate.
    proxy.replayNextClaim();
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
    "OPENCODE-LIVE 6: a replayed claim is tolerated by the host and settles the dispatch exactly once",
    async () => {
      expect.hasAssertions();
      const agent = await waitForConnectedAgent(client);
      const projectId = published.artifact.projectId;
      await model.waitForTurns(2);

      const thread = await client.openThread(
        published,
        "The summary needs a date stamp.",
        "opencode-live-duplicate-claim-thread",
      );
      const created = dispatchCreationSchema.parse(
        await (await client.sendDispatch({
          agentId: agent.id,
          idempotencyKey: "opencode-live-duplicate-claim-dispatch",
          projectId,
          threadIds: [thread.id],
        })).json(),
      );
      expect(created.dispatch.state).toBe("queued");

      // The first claim is real: OpenCode admits the bundle and the dispatch
      // settles delivered.
      const delivered = await waitForDispatchState(
        client,
        projectId,
        created.dispatch.id,
        ["delivered"],
      );
      expect(delivered.deliveredAt).not.toBeNull();
      await model.waitForTurns(3, 30_000);
      const firstDelivery = latestUserMessage(model.turns()[2] ?? emptyTurn);
      expect(firstDelivery.startsWith("Artifact Server:")).toBe(true);
      expect(firstDelivery).toContain(`(thread ${thread.id})`);

      // The replayed lease delivers the same bundle again: the host tolerates
      // the duplicate admission and keeps working.
      await model.waitForTurns(4, 60_000);
      expect(proxy.replayedClaims()).toBe(1);
      const duplicateDelivery = latestUserMessage(model.turns()[3] ?? emptyTurn);
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
