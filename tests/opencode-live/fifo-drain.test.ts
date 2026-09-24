/**
 * OPENCODE-LIVE 2 — three bundles sent during one unit of work are all held
 * until the next work boundary and then delivered in order.
 *
 * OpenCode queues follow-up prompts server-side and presents every pending
 * bundle as a separate user message in the conversation at the first work
 * boundary, so the live proof is that all three bundles appear, in send order,
 * and that each dispatch was reported `delivered` before the next one was
 * claimed.
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
import {createWorkGate} from "./support/work-gate.js";
import {
  waitForConnectedAgent,
  waitForDispatchState,
} from "./support/server-observations.js";

const bridgeExtension = new URL(
  "../../integrations/opencode/index.ts",
  import.meta.url,
).pathname;

function isTitleGenerationTurn(turn: ModelTurn): boolean {
  return turn.messages.some(
    (message) =>
      message.role === "system" && message.text.includes("title generator"),
  );
}

describe("live OpenCode bridge FIFO drain", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;
  let environment: OpencodeEnvironment;
  let model: ScriptedModel;
  let opencode: LiveOpencode;
  const work = createWorkGate();

  beforeAll(async () => {
    const cliPath = await resolveOpencodeCli();
    if (cliPath === null) throw new Error("No opencode CLI was found.");

    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Live FIFO</title>",
      idempotencyKey: "opencode-live-fifo-publish",
      name: "Live FIFO report",
    })).body;

    model = await startScriptedModel(async (turn: ModelTurn) => {
      if (isTitleGenerationTurn(turn)) {
        return {kind: "text", text: "Live FIFO"};
      }
      if (turn.index === 2) {
        await work.opened;
        return {kind: "text", text: "Scripted work finished."};
      }
      // The boundary turn ends without tool calls: this test proves drain
      // order, and the tool path is covered by the round-trip test.
      return {kind: "text", text: "Handled the queued bundles."};
    });
    environment = await createOpencodeEnvironment(model.baseUrl, bridgeExtension);
    opencode = await startLiveOpencode(
      {
        agentName: "opencode-live-suite",
        cacheDirectory: environment.cacheDirectory,
        configDirectory: environment.configDirectory,
        dataDirectory: environment.dataDirectory,
        origin: server.baseUrl,
        projectDirectory: environment.projectDirectory,
        stateDirectory: environment.stateDirectory,
        token: installation.apiToken,
      },
      "Do the scripted long task and report when finished.",
    );
  });

  afterAll(async () => {
    work.open();
    await opencode.stop();
    await model.stop();
    await environment.remove();
    await server.stop();
    await removeTestInstallation(installation);
  });

  test(
    "OPENCODE-LIVE 2: three bundles queued during one unit of work are held and delivered in order at the boundary",
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
            `opencode-live-fifo-thread-${label}`,
          ),
        );
      }

      await model.waitForTurns(2);

      // Three separate sends, each one bundle, all while OpenCode is busy.
      const dispatchIds: string[] = [];
      for (const [position, thread] of threads.entries()) {
        const created = dispatchCreationSchema.parse(
          // eslint-disable-next-line no-await-in-loop
          await (await client.sendDispatch({
            agentId: agent.id,
            idempotencyKey: `opencode-live-fifo-dispatch-${position + 1}`,
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
      // Nothing reached the model yet: OpenCode is still inside its first unit
      // of work.
      expect(model.turns()).toHaveLength(2);

      work.open();
      // Title (1) + held work (1) + the boundary turn carrying all bundles.
      await model.waitForTurns(3, 60_000);

      // OpenCode queues follow-ups server-side, so all three bundles appear as
      // separate user messages in the same boundary turn, in send order.
      const boundaryTurn = model.turns()[2];
      expect(boundaryTurn).toBeDefined();
      const bundles = bundleMessages(boundaryTurn ?? {index: 0, messages: []});
      expect(bundles).toHaveLength(3);
      for (const [position, thread] of threads.entries()) {
        expect(bundles[position]).toContain(`(thread ${thread.id})`);
      }

      // Three sends produced three deliveries and nothing else: no bundle was
      // duplicated or merged into another turn.
      await new Promise((resolve) => {
        setTimeout(resolve, 2_000);
      });
      const allBundleMessages = model.turns().flatMap((turn) =>
        bundleMessages(turn)
      );
      expect(allBundleMessages).toHaveLength(3);
    },
  );
});
