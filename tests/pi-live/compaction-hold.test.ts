/**
 * PI-LIVE 6 — the compaction hold against a REAL Pi process.
 *
 * Pi 0.84.4 exposes a user-triggerable `/compact` slash command, so this
 * behavior is exercisable live: the suite submits `/compact` at an idle prompt,
 * holds the scripted model's summarization answer open (which keeps the session
 * inside its compaction window for as long as the test needs), and sends a
 * bundle mid-compaction. Pi refuses to compact a session under its
 * `compaction.keepRecentTokens` floor (default 20000), so the first exchange is
 * padded with a large numbered transcript. The bridge tracks the window through
 * the `session_before_compact` / `session_compact` extension events and must
 * hold the delivery: the dispatch sits `claimed`, nothing is injected into the
 * compacting session, and only the compaction boundary releases the bundle —
 * which then arrives as follow-up work and settles `delivered`.
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
import {createWorkGate} from "./support/work-gate.js";
import {
  readDispatch,
  waitForConnectedAgent,
  waitForDispatchState,
} from "./support/server-observations.js";

const bridgeExtension = new URL(
  "../../integrations/pi/index.ts",
  import.meta.url,
).pathname;

/**
 * Pi refuses `/compact` with "Nothing to compact (session too small)" unless
 * the branch holds more than `compaction.keepRecentTokens` (default 20000)
 * tokens, so the first exchange must be large. The prose is numbered rather
 * than repeated because token estimators can treat exact character cycles
 * differently.
 */
const longTranscript = `${Array.from({length: 3000}, (_, index) =>
  `Finding ${index}: reviewer noted concern ${index % 7} in module ${
    index % 13
  } of the draft.`
).join("\n")}\nEnd of the long transcript.`;

/**
 * Pi's compaction may issue two summarization calls: a turn-prefix summary
 * when the most recent turn is too large to keep in full, followed by the
 * main conversation summary. Holding the first one that arrives keeps the
 * session inside its compaction window.
 */
function isSummarizationTurn(turn: ModelTurn): boolean {
  return turn.messages.some((message) =>
    message.text.includes(
      "This is the PREFIX of a turn that was too large to keep.",
    ) ||
    message.text.includes(
      "The messages above are a conversation to summarize.",
    )
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

describe("live Pi bridge compaction hold", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;
  let environment: PiEnvironment;
  let model: ScriptedModel;
  let pi: LivePi;
  // Armed while the test holds the summarization answer open: the compaction
  // request is the model turn that arrives after arming.
  const compaction = createWorkGate();
  let compactionArmed = false;
  let compactionSeen = false;

  beforeAll(async () => {
    const cliPath = await resolvePiCli();
    if (cliPath === null) throw new Error("No pi CLI was found.");

    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Live compaction hold</title>",
      idempotencyKey: "pi-live-compaction-publish",
      name: "Live compaction hold report",
    })).body;

    model = await startScriptedModel(async (turn: ModelTurn) => {
      if (isSummarizationTurn(turn)) {
        if (compactionArmed && !compactionSeen) {
          // The first summarization request: hold the answer so the session
          // stays inside its compaction window while the test sends the
          // bundle. Later chunks of the same compaction answer at once.
          compactionSeen = true;
          await compaction.opened;
        }
        return {kind: "text", text: "Summary of the session so far."};
      }
      if (turn.index === 1) {
        // Big enough that `/compact` has more than keepRecentTokens to work
        // with; otherwise Pi refuses with "session too small".
        return {kind: "text", text: longTranscript};
      }
      return {kind: "text", text: "Handled the bundle."};
    });
    environment = await createPiEnvironment(model.baseUrl);
    pi = await startLivePi({
      agentDirectory: environment.agentDirectory,
      cliPath,
      extensionPath: bridgeExtension,
      model: scriptedModel,
      origin: server.baseUrl,
      projectDirectory: environment.projectDirectory,
      token: installation.apiToken,
    });
  });

  afterAll(async () => {
    compaction.open();
    await pi.stop();
    await model.stop();
    await environment.remove();
    await server.stop();
    await removeTestInstallation(installation);
  });

  test(
    "PI-LIVE 6: a bundle sent mid-compaction is held, then delivered at the compaction boundary",
    async () => {
      expect.hasAssertions();
      const agent = await waitForConnectedAgent(client);
      const projectId = published.artifact.projectId;

      // Put one ordinary — but large — exchange on the session so `/compact`
      // has more than keepRecentTokens to summarize, and let it finish so the
      // command runs at an idle prompt.
      pi.submit("Produce a long numbered transcript.");
      await model.waitForTurns(1, 30_000);
      await pi.waitForOutput(/End of the long transcript\./u, 30_000);
      await sleep(2_000);

      const thread = await client.openThread(
        published,
        "Mention the compaction window in the notes.",
        "pi-live-compaction-thread",
      );

      // Start a real compaction on the real session and hold its
      // summarization answer open.
      compactionArmed = true;
      pi.submit("/compact");
      try {
        await model.waitForTurns(2, 45_000);
      } catch {
        throw new Error(
          `The summarization turn never arrived (the scripted model saw ${
            model.turns().length
          } turn(s)); screen: ${pi.output().slice(-600)}`,
        );
      }

      // Send the bundle while the session is provably mid-compaction.
      const created = dispatchCreationSchema.parse(
        await (await client.sendDispatch({
          agentId: agent.id,
          idempotencyKey: "pi-live-compaction-dispatch",
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
      expect(model.turns()).toHaveLength(2);
      expect(model.turns().flatMap((turn) => bundleMessages(turn)))
        .toHaveLength(0);

      // The compaction boundary releases the hold: the bundle settles
      // delivered, and the user's next prompt shows it entered the session.
      compaction.open();
      const delivered = await waitForDispatchState(
        client,
        projectId,
        created.dispatch.id,
        ["delivered"],
        90_000,
      );
      expect(delivered.deliveredAt).not.toBeNull();

      pi.submit("Please continue.");
      const bundleDeadline = Date.now() + 60_000;
      let bundleTurn: ModelTurn | undefined;
      while (bundleTurn === undefined) {
        bundleTurn = model.turns().find((turn) =>
          bundleMessages(turn).length > 0
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
      expect(bundleMessages(bundleTurn)[0]).toContain(`(thread ${thread.id})`);
    },
  );
});
