/**
 * OMP-LIVE 2 — three bundles sent during one unit of work drain one per work
 * boundary, in the order they were sent. The proof is omp's own conversation:
 * each completion request must add exactly one new bundle message, and the
 * order of those messages must be the order of the sends.
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
  createOmpEnvironment,
  type OmpEnvironment,
  scriptedModel,
  scriptedModelName,
} from "./support/omp-environment.js";
import {type LiveOmp, resolveOmpCli, startLiveOmp} from "./support/live-omp.js";
import {createWorkGate} from "../pi-live/support/work-gate.js";
import {
  waitForConnectedAgent,
  waitForDispatchState,
} from "../pi-live/support/server-observations.js";

const bridgeExtension = new URL(
  "../../integrations/omp/index.ts",
  import.meta.url,
).pathname;

const emptyTurn: ModelTurn = {index: 0, messages: []};

describe("live omp bridge FIFO drain", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;
  let environment: OmpEnvironment;
  let model: ScriptedModel;
  let omp: LiveOmp;
  const work = createWorkGate();

  beforeAll(async () => {
    const cliPath = await resolveOmpCli();
    if (cliPath === null) throw new Error("No omp CLI was found.");

    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Live FIFO</title>",
      idempotencyKey: "omp-live-fifo-publish",
      name: "Live FIFO report",
    })).body;

    model = await startScriptedModel(async (turn: ModelTurn) => {
      if (turn.index === 1) {
        await work.opened;
        return {kind: "text", text: "Scripted work finished."};
      }
      // Every bundle turn ends the run without tool calls, so omp's follow-up
      // queue drains the next bundle at the next work boundary.
      return {kind: "text", text: `Handled bundle ${turn.index - 1}.`};
    });
    environment = await createOmpEnvironment(model.baseUrl);
    omp = await startLiveOmp({
      agentDirectory: environment.agentDirectory,
      cliPath,
      extensionPath: bridgeExtension,
      model: scriptedModel,
      modelName: scriptedModelName,
      origin: server.baseUrl,
      projectDirectory: environment.projectDirectory,
      token: installation.apiToken,
    });
  });

  afterAll(async () => {
    work.open();
    await omp.stop();
    await model.stop();
    await environment.remove();
    await server.stop();
    await removeTestInstallation(installation);
  });

  test(
    "OMP-LIVE 2: three bundles queued during one unit of work drain one per boundary, in order",
    async () => {
      expect.hasAssertions();
      const agent = await waitForConnectedAgent(client);
      const projectId = published.artifact.projectId;

      const threads = [];
      for (const label of ["first", "second", "third"]) {
        threads.push(
          // eslint-disable-next-line no-await-in-loop
          await client.openThread(
            published,
            `Annotation ${label}.`,
            `omp-live-fifo-thread-${label}`,
          ),
        );
      }

      omp.submit("Do the scripted long task and report when finished.");
      await model.waitForTurns(1);

      // Three separate sends, each one bundle, all while omp is busy.
      const dispatchIds: string[] = [];
      for (const [position, thread] of threads.entries()) {
        const created = dispatchCreationSchema.parse(
          // eslint-disable-next-line no-await-in-loop
          await (await client.sendDispatch({
            agentId: agent.id,
            idempotencyKey: `omp-live-fifo-dispatch-${position + 1}`,
            projectId,
            threadIds: [thread.id],
          })).json(),
        );
        dispatchIds.push(created.dispatch.id);
        // The one-active-claim rule means the next claim only follows this
        // dispatch's delivery report.
        // eslint-disable-next-line no-await-in-loop
        await waitForDispatchState(client, projectId, created.dispatch.id, [
          "delivered",
        ]);
      }
      expect(dispatchIds).toHaveLength(3);
      // Nothing reached the model yet: omp is still inside its first unit of work.
      expect(model.turns()).toHaveLength(1);

      work.open();
      await model.waitForTurns(4, 60_000);

      // One bundle per boundary, in send order.
      for (const [position, thread] of threads.entries()) {
        const turn = model.turns()[position + 1] ?? emptyTurn;
        expect(bundleMessages(turn)).toHaveLength(position + 1);
        const latest = latestUserMessage(turn);
        expect(latest.startsWith("Artifact Server:")).toBe(true);
        expect(latest).toContain("sent 1 annotation(s) to address");
        expect(latest).toContain(`(thread ${thread.id})`);
      }

      // Three sends produced three deliveries and nothing else: no bundle was
      // duplicated or merged into another turn.
      await new Promise((resolve) => {
        setTimeout(resolve, 2_000);
      });
      expect(model.turns()).toHaveLength(4);
    },
  );
});
