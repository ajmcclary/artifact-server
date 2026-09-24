/**
 * OPENCODE-LIVE 7 — the compaction hold against a REAL OpenCode process.
 *
 * OpenCode 1.18.32 gates the manual compact endpoint in serve mode
 * (`POST /api/session/:id/compact` answers 503 "not available yet" and the
 * legacy `/session/:id/compact` path is the web app's SPA fallback), but its
 * automatic compaction is user-equivalent and deterministic to drive: the
 * scripted model reports an overflowing token count on the initial prompt,
 * which makes the REAL host compact the session — firing the same
 * `experimental.session.compacting` hook and `session.compacted` event a
 * manual compaction would (verified during qualification: both fire in serve
 * mode for an overflow compaction).
 *
 * The scripted model then holds its summarization answer open, which keeps
 * the session inside its compaction window for as long as the test needs
 * while a bundle is sent. The bridge must hold the delivery: the dispatch
 * sits `claimed`, nothing is injected into the compacting session, and only
 * the compaction boundary releases the bundle — which then arrives as one
 * follow-up prompt and settles `delivered`.
 */

import {afterAll, beforeAll, describe, expect, test} from "vitest";

import {
  ApiClient,
  dispatchCreationSchema,
} from "../support/agent-dispatch.js";
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
  readDispatch,
  waitForConnectedAgent,
  waitForDispatchState,
} from "./support/server-observations.js";

const bridgeExtension = new URL(
  "../../integrations/opencode/index.ts",
  import.meta.url,
).pathname;

/** The environment declares a 128k context window; this overflows it. */
const overflowingUsage = {completionTokens: 500, promptTokens: 200_000};

function isTitleGenerationTurn(turn: ModelTurn): boolean {
  return turn.messages.some(
    (message) =>
      message.role === "system" && message.text.includes("title generator"),
  );
}

/** OpenCode's auto-compaction summarization request is unmistakable. */
function isCompactionTurn(turn: ModelTurn): boolean {
  return turn.messages.some(
    (message) =>
      message.role === "system" &&
      message.text.includes("context summarization agent"),
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

describe("live OpenCode bridge compaction hold", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;
  let environment: OpencodeEnvironment;
  let model: ScriptedModel;
  let opencode: LiveOpencode;
  // The summarization answer stays held until the test opens the gate, which
  // stretches the real compaction window exactly as long as needed.
  const compaction = createWorkGate();

  beforeAll(async () => {
    const cliPath = await resolveOpencodeCli();
    if (cliPath === null) throw new Error("No opencode CLI was found.");

    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Live compaction hold</title>",
      idempotencyKey: "opencode-live-compaction-publish",
      name: "Live compaction hold report",
    })).body;

    model = await startScriptedModel(async (turn: ModelTurn) => {
      if (isTitleGenerationTurn(turn)) {
        return {kind: "text", text: "Live compaction hold"};
      }
      if (isCompactionTurn(turn)) {
        // The summarization request: hold the answer so the session stays
        // inside its compaction window while the test sends the bundle.
        await compaction.opened;
        return {kind: "text", text: "Summary of the session so far."};
      }
      if (turn.index === 2) {
        // The initial prompt reports an overflow, so OpenCode compacts the
        // session as soon as this turn completes.
        return {kind: "text", text: "Ready.", usage: overflowingUsage};
      }
      // Later turns (the post-compaction auto-continue, the bundle turn)
      // report nothing, so the context never overflows again.
      return {kind: "text", text: "Handled the bundle."};
    });
    environment = await createOpencodeEnvironment(model.baseUrl, bridgeExtension);
    opencode = await startLiveOpencode(
      {
        agentName: "opencode-live-compaction",
        cacheDirectory: environment.cacheDirectory,
        configDirectory: environment.configDirectory,
        dataDirectory: environment.dataDirectory,
        origin: server.baseUrl,
        projectDirectory: environment.projectDirectory,
        stateDirectory: environment.stateDirectory,
        token: installation.apiToken,
      },
      "Set up the session for a compaction.",
    );
  });

  afterAll(async () => {
    compaction.open();
    await opencode.stop();
    await model.stop();
    await environment.remove();
    await server.stop();
    await removeTestInstallation(installation);
  });

  test(
    "OPENCODE-LIVE 7: a bundle sent mid-compaction is held, then delivered at the compaction boundary",
    async () => {
      expect.hasAssertions();
      const agent = await waitForConnectedAgent(client);
      const projectId = published.artifact.projectId;

      // Turn 1 is title generation, turn 2 is the overflow prompt, and turn 3
      // is the compaction's summarization request, held open by the gate: the
      // session is provably mid-compaction from here on.
      await model.waitForTurns(3, 60_000);
      const summarization = model.turns()[2];
      expect(summarization !== undefined && isCompactionTurn(summarization))
        .toBe(true);

      const thread = await client.openThread(
        published,
        "Mention the compaction window in the notes.",
        "opencode-live-compaction-thread",
      );

      // Send the bundle while the session is mid-compaction.
      const created = dispatchCreationSchema.parse(
        await (await client.sendDispatch({
          agentId: agent.id,
          idempotencyKey: "opencode-live-compaction-dispatch",
          projectId,
          threadIds: [thread.id],
        })).json(),
      );

      // The bridge claims the bundle and then holds: no injection reaches the
      // compacting session.
      await waitForDispatchState(client, projectId, created.dispatch.id, [
        "claimed",
      ]);
      await sleep(3_000);
      const held = await readDispatch(client, projectId, created.dispatch.id);
      expect(held).toMatchObject({deliveredAt: null, state: "claimed"});
      expect(model.turns()).toHaveLength(3);
      expect(model.turns().flatMap((turn) => bundleMessages(turn)))
        .toHaveLength(0);

      // The compaction boundary releases the hold: the bundle lands as one
      // follow-up prompt on the compacted session and settles delivered.
      compaction.open();
      const delivered = await waitForDispatchState(
        client,
        projectId,
        created.dispatch.id,
        ["delivered"],
        90_000,
      );
      expect(delivered.deliveredAt).not.toBeNull();

      const bundleDeadline = Date.now() + 60_000;
      let bundleTurn: ModelTurn | undefined;
      while (bundleTurn === undefined) {
        bundleTurn = model.turns().find((turn) =>
          latestUserMessage(turn).startsWith("Artifact Server:")
        );
        if (bundleTurn === undefined) {
          if (Date.now() > bundleDeadline) {
            throw new Error("No model turn carried the bundle after compaction.");
          }
          // eslint-disable-next-line no-await-in-loop
          await sleep(250);
        }
      }
      expect(bundleMessages(bundleTurn)).toHaveLength(1);
      expect(latestUserMessage(bundleTurn)).toContain(`(thread ${thread.id})`);
    },
  );
});
