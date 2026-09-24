/**
 * OMP-LIVE 3 — an omp session replacement (`/new`) with a queued dispatch.
 * The bridge must re-register the same connection, and a bundle that was
 * still queued in the mailbox at the moment of the replacement must reach the
 * new session.
 *
 * The claim gate is what makes this deterministic: with claims closed the
 * dispatch is provably still `queued` when `/new` runs, instead of racing the
 * bridge's claim loop.
 *
 * omp emits `session_shutdown` WITHOUT a reason field (upstream Pi emits
 * "quit" | "reload" | "new" | ...), so the omp bridge answers every shutdown
 * with the courtesy disconnect. What a live host actually does around `/new`
 * is observed here: omp 18.2.11 emits no session lifecycle events at all for
 * `/new` (the extension host survives), so the original registration stays
 * connected and the replacement session inherits the pending FIFO through it.
 *
 * HOST DIFFERENCE from the Pi suite: omp 18.2.11 queues terminal input typed
 * while a model turn is in flight instead of executing it as a command, so
 * `/new` cannot be issued mid-work through the PTY (Pi aborts the turn and
 * executes the command). The replacement here is driven from an idle prompt;
 * the queued-dispatch guarantee under test is identical.
 */

import {afterAll, beforeAll, describe, expect, test} from "vitest";

import {ApiClient, dispatchCreationSchema} from "../support/agent-dispatch.js";
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
  startScriptedModel,
} from "../pi-live/support/scripted-model.js";
import {
  type ClaimGateProxy,
  startClaimGateProxy,
} from "../pi-live/support/claim-gate-proxy.js";
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
} from "../pi-live/support/server-observations.js";

const bridgeExtension = new URL(
  "../../integrations/omp/index.ts",
  import.meta.url,
).pathname;

const emptyTurn: ModelTurn = {index: 0, messages: []};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

describe("live omp bridge session replacement", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let proxy: ClaimGateProxy;
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
    proxy = await startClaimGateProxy(server.baseUrl);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Live rebind</title>",
      idempotencyKey: "omp-live-rebind-publish",
      name: "Live rebind report",
    })).body;

    model = await startScriptedModel(async (_turn: ModelTurn) => {
      return {kind: "text", text: "Handled the bundle after the rebind."};
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
    "OMP-LIVE 3: /new re-registers the same connection and the queued bundle reaches the new session",
    async () => {
      expect.hasAssertions();
      const projectId = published.artifact.projectId;
      const before = await waitForConnectedAgent(client);

      const thread = await client.openThread(
        published,
        "Check the figure caption on page two.",
        "omp-live-rebind-thread",
      );

      // With the gate closed the send provably stays in the mailbox: the poll
      // already in flight is cut, and the bridge's next poll is answered here.
      proxy.closeClaims();
      await sleep(1_500);
      const created = dispatchCreationSchema.parse(
        await (await client.sendDispatch({
          agentId: before.id,
          idempotencyKey: "omp-live-rebind-dispatch",
          projectId,
          threadIds: [thread.id],
        })).json(),
      );
      await sleep(2_500);
      expect(
        (await readDispatch(client, projectId, created.dispatch.id)).state,
      ).toBe("queued");

      // Replace the session while that work is still in the mailbox. omp runs
      // slash commands immediately at an idle prompt — no confirmation.
      omp.submit("/new");
      await omp.waitForOutput(/New session started/u);

      // omp 18.2.11 does not re-emit session lifecycle events around `/new`:
      // no session_shutdown (the registration stays connected) and no new
      // session_start (the row's agentSessionId keeps the first session's
      // value). The bridge's original registration therefore persists across
      // the replacement — which is one way to keep the spec's promise that
      // the same agent id and its pending FIFO survive.
      proxy.openClaims();
      // Follow-up citizenship holds at idle too: the accepted bundle never
      // starts a turn by itself, it waits for the next work boundary.
      await sleep(8_000);
      expect(
        (await readDispatch(client, projectId, created.dispatch.id)).state,
      ).toBe("delivered");
      expect(model.turns()).toHaveLength(0);

      // The user's own next prompt opens the boundary the bundle drains at.
      omp.submit("Please continue.");
      await model.waitForTurns(2, 30_000);
      await sleep(2_000);
      const settled = await readDispatch(client, projectId, created.dispatch.id);
      const after = await waitForConnectedAgent(client);
      const turn = model.turns().find((candidate) =>
        latestUserMessage(candidate).startsWith("Artifact Server:")
      ) ?? emptyTurn;

      expect(after.workingDirectory).toBe(before.workingDirectory);
      expect(after.connected).toBe(true);

      // Specification section 8: the connection key is stable, "so restarts and
      // /new//resume reclaim the same agent id and its pending FIFO".
      expect(
        after.id,
        "the registration must keep the id its queued dispatches address",
      ).toBe(before.id);

      // And the bundle that was queued across the replacement must arrive in
      // the new session.
      expect(
        settled.state,
        `the queued bundle must reach the replacement session, not stay ${settled.state}`,
      ).toBe("delivered");
      const latest = latestUserMessage(turn);
      expect(latest.startsWith("Artifact Server:")).toBe(true);
      expect(latest).toContain(`(thread ${thread.id})`);
      expect(bundleMessages(turn)).toHaveLength(1);
    },
  );
});
