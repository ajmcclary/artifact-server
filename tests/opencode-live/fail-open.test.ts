/**
 * OPENCODE-LIVE 3 — the bridge fails open against a REAL OpenCode process.
 *
 * With the bridge pointed at an unreachable Artifact Server origin, OpenCode
 * must keep working: the model still answers, the host does not crash, and no
 * agent row appears on the real server. The failure is contained inside the
 * bridge with bounded backoff rather than thrown into the host.
 */

import {afterAll, beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";

import {agentListSchema, ApiClient} from "../support/agent-dispatch.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
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

/** One session row from the `opencode serve` HTTP API. */
const sessionListSchema = z.array(z.object({id: z.string()}).loose());

describe("live OpenCode bridge fail-open", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let environment: OpencodeEnvironment;
  let model: ScriptedModel;
  let opencode: LiveOpencode;

  beforeAll(async () => {
    const cliPath = await resolveOpencodeCli();
    if (cliPath === null) throw new Error("No opencode CLI was found.");

    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);

    model = await startScriptedModel(async (turn: ModelTurn) => {
      if (isTitleGenerationTurn(turn)) {
        return {kind: "text", text: "Live fail-open"};
      }
      return {kind: "text", text: "Host is still working despite the bridge failure."};
    });
    environment = await createOpencodeEnvironment(model.baseUrl, bridgeExtension);

    // Point the bridge at an origin that is guaranteed unreachable, but keep
    // the model endpoint reachable so we can observe the host still thinking.
    opencode = await startLiveOpencode(
      {
        agentName: "opencode-live-fail-open",
        cacheDirectory: environment.cacheDirectory,
        configDirectory: environment.configDirectory,
        dataDirectory: environment.dataDirectory,
        // Nothing is listening on this port in the test.
        origin: "http://127.0.0.1:1",
        projectDirectory: environment.projectDirectory,
        stateDirectory: environment.stateDirectory,
        token: installation.apiToken,
      },
      "Confirm you are operational.",
    );
  });

  afterAll(async () => {
    await opencode.stop();
    await model.stop();
    await environment.remove();
    await server.stop();
    await removeTestInstallation(installation);
  });

  test(
    "OPENCODE-LIVE 3: an unreachable Artifact Server leaves OpenCode working and produces no registration",
    async () => {
      expect.hasAssertions();

      // The host completed a full model round trip with the bridge down:
      // its own serve API returns the session carrying the assistant reply.
      // (The run --attach client exits before the response renders, so the
      // serve API — not terminal text — is the observation boundary.)
      await model.waitForTurns(1, 30_000);
      const replyText = "Host is still working despite the bridge failure.";
      const deadline = Date.now() + 30_000;
      let replyVisible = false;
      while (Date.now() < deadline && !replyVisible) {
        // eslint-disable-next-line no-await-in-loop -- poll the serve API sequentially
        const listResponse = await fetch(`${opencode.serverUrl()}/session`);
        // eslint-disable-next-line no-await-in-loop -- poll the serve API sequentially
        const sessions = sessionListSchema.parse(await listResponse.json());
        const first = sessions[0];
        if (first !== undefined) {
          // eslint-disable-next-line no-await-in-loop -- poll the serve API sequentially
          const messageResponse = await fetch(
            `${opencode.serverUrl()}/session/${first.id}/message`,
          );
          // eslint-disable-next-line no-await-in-loop -- poll the serve API sequentially
          const messages: unknown = await messageResponse.json();
          replyVisible = JSON.stringify(messages).includes(replyText);
        }
        if (!replyVisible) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => {
            setTimeout(resolve, 200);
          });
        }
      }
      expect(replyVisible).toBe(true);

      // Give the bridge's registration/backoff loop a moment to attempt the
      // bogus origin.
      await new Promise((resolve) => {
        setTimeout(resolve, 3_000);
      });

      // The real server must remain untouched: no agent row was created.
      const response = await client.listAgents();
      expect(response.status).toBe(200);
      expect(agentListSchema.parse(await response.json()).items).toHaveLength(0);
    },
  );
});
