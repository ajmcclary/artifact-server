/**
 * OPENCODE-LIVE 3 — the bridge fails open against a REAL OpenCode process.
 *
 * With the bridge pointed at an unreachable Artifact Server origin, OpenCode
 * must keep working: the model still answers, the host does not crash, and no
 * agent row appears on the real server. The failure is contained inside the
 * bridge with bounded backoff rather than thrown into the host.
 *
 * OPENCODE-LIVE 4 — the same unreachable origin doubles as the observation
 * point for the backoff contract: the "blackhole" below accepts the bridge's
 * connections, timestamps every registration attempt, and destroys the
 * socket, so the suite can prove the retry spacing starts at one second and
 * never exceeds the thirty-second jittered ceiling.
 */

import {createServer, type Server} from "node:http";

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

/** One bridge request the blackhole observed and destroyed. */
interface BlackholeAttempt {
  readonly at: number;
  readonly method: string;
  readonly path: string;
}

interface BlackholeOrigin {
  attempts(): readonly BlackholeAttempt[];
  readonly origin: string;
  stop(): Promise<void>;
}

/**
 * An "unreachable" origin that is nonetheless observable: it accepts every
 * connection, records the request line with a timestamp, and destroys the
 * socket without answering — the same failure the bridge sees from a dead
 * server, with the retry timing laid bare.
 */
async function startBlackholeOrigin(): Promise<BlackholeOrigin> {
  const attempts: BlackholeAttempt[] = [];
  const server: Server = createServer((request) => {
    attempts.push({
      at: Date.now(),
      method: request.method ?? "GET",
      path: request.url ?? "/",
    });
    request.socket.destroy();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = z.object({port: z.number()}).parse(server.address());
  return {
    attempts: () => attempts,
    origin: `http://127.0.0.1:${address.port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

describe("live OpenCode bridge fail-open", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let blackhole: BlackholeOrigin;
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

    // Point the bridge at the blackhole: unreachable like a dead server, but
    // every retry is timestamped for the backoff assertions. The model
    // endpoint stays reachable so the host keeps thinking.
    blackhole = await startBlackholeOrigin();
    opencode = await startLiveOpencode(
      {
        agentName: "opencode-live-fail-open",
        cacheDirectory: environment.cacheDirectory,
        configDirectory: environment.configDirectory,
        dataDirectory: environment.dataDirectory,
        origin: blackhole.origin,
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
    await blackhole.stop();
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

  test(
    "OPENCODE-LIVE 4: the unreachable-origin retry spacing starts at 1s and never exceeds the 30s jittered ceiling",
    async () => {
      expect.hasAssertions();

      // Registration attempts accumulate from bridge start. Backoff doubles
      // 1s → 2s → 4s → 8s → 16s and then sits on the 30s ceiling, so the
      // eighth attempt lands roughly 90–100s in and proves both the floor and
      // the cap.
      const registrationAttempts = () =>
        blackhole.attempts().filter((attempt) =>
          attempt.method === "POST" && attempt.path.startsWith("/api/v1/agents")
        );
      const deadline = Date.now() + 150_000;
      while (registrationAttempts().length < 8) {
        if (Date.now() > deadline) break;
        // eslint-disable-next-line no-await-in-loop
        await sleep(500);
      }
      const attempts = registrationAttempts();
      expect(attempts.length).toBeGreaterThanOrEqual(8);

      const gaps = attempts.slice(1).map((attempt, index) =>
        attempt.at - (attempts[index]?.at ?? attempt.at)
      );
      // No spin: every retry waits at least the one-second floor (minus timer
      // slop), and none sleeps past the jittered ceiling plus slack.
      for (const gap of gaps) {
        expect(gap).toBeGreaterThanOrEqual(900);
        expect(gap).toBeLessThanOrEqual(31_500);
      }
      // The first retry is the one-second step with up to 25% jitter.
      expect(gaps[0]).toBeDefined();
      expect(gaps[0] ?? 0).toBeLessThanOrEqual(2_100);
      // The ceiling is reached and held: the last two observed gaps are the
      // capped 30s sleeps, not something still growing.
      const penultimate = gaps.at(-2) ?? 0;
      const last = gaps.at(-1) ?? 0;
      expect(penultimate).toBeGreaterThanOrEqual(29_000);
      expect(last).toBeGreaterThanOrEqual(29_000);
      expect(penultimate).toBeLessThanOrEqual(31_500);
      expect(last).toBeLessThanOrEqual(31_500);
    },
    200_000,
  );
});
