/**
 * The Claude Code channel lives exactly as long as its session. A spawned
 * channel process sees stdin end when Claude Code goes away, and must stop
 * claiming, disconnect, and exit rather than keep claiming bundles it can
 * only write into a dead pipe. A second termination signal while the stop
 * is still pending forces the exit.
 */

import {type ChildProcess, spawn} from "node:child_process";
import {once} from "node:events";
import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import type {AddressInfo} from "node:net";
import {resolve} from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {agentListSchema, ApiClient} from "../support/agent-dispatch.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const channelEntry = resolve(repositoryRoot, "integrations/claude-channel/index.ts");

interface ChannelEnvironment {
  readonly name: string;
  readonly origin: string;
  readonly token: string;
}

/** One channel process, spawned directly under node so signals reach it. */
function spawnChannel(environment: ChannelEnvironment): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", channelEntry], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ARTIFACT_SERVER_AGENT_NAME: environment.name,
      ARTIFACT_SERVER_AGENT_TOKEN: environment.token,
      ARTIFACT_SERVER_ORIGIN: environment.origin,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function exitOf(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  const [code] = await once(child, "exit");
  return code === null ? null : Number(code);
}

async function eventually(probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  // eslint-disable-next-line no-await-in-loop -- polling waits for each probe
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error("The awaited condition was not reached in time.");
    // eslint-disable-next-line no-await-in-loop -- polling waits between probes
    await new Promise((settle) => {
      setTimeout(settle, 100);
    });
  }
}

/** Answers registration, then holds every other request open forever. */
class SilentServer {
  readonly requests: string[] = [];
  readonly #held: ServerResponse[] = [];
  readonly #server: Server;

  constructor() {
    this.#server = createServer((request, response) => {
      this.#answer(request, response);
    });
  }

  get origin(): string {
    const address: AddressInfo | string | null = this.#server.address();
    if (address === null || !(address instanceof Object)) {
      throw new Error("The silent server is not listening.");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  async listen(): Promise<void> {
    await new Promise<void>((settle) => {
      this.#server.listen(0, "127.0.0.1", settle);
    });
  }

  async close(): Promise<void> {
    for (const response of this.#held) response.destroy();
    this.#server.closeAllConnections();
    await new Promise<void>((settle) => {
      this.#server.close(() => {
        settle();
      });
    });
  }

  #answer(request: IncomingMessage, response: ServerResponse): void {
    const line = `${request.method ?? ""} ${request.url ?? ""}`;
    this.requests.push(line);
    request.resume();
    if (line === "POST /api/v1/agents") {
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({agent: {id: "agt_silent"}, protocolVersion: 1}));
      return;
    }
    this.#held.push(response);
  }
}

describe("claude channel lifetime", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let children: ChildProcess[];

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    children = [];
  });

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("stdin ending means the session is gone: the channel disconnects and exits", async () => {
    const client = new ApiClient(server, installation.apiToken);
    const child = spawnChannel({
      name: "channel-lifetime",
      origin: server.baseUrl,
      token: installation.apiToken,
    });
    children.push(child);
    let agentId = "";
    await eventually(async () => {
      const listed = agentListSchema.parse(await (await client.listAgents()).json()).items
        .find((item) => item.displayName === "channel-lifetime");
      agentId = listed?.id ?? "";
      return listed !== undefined;
    });

    child.stdin?.end();
    const startedAt = Date.now();
    expect(await exitOf(child)).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    const listed = agentListSchema.parse(await (await client.listAgents()).json()).items;
    expect(listed.some((item) => item.id === agentId)).toBe(false);
  }, 60_000);

  test("a second SIGTERM while the stop is pending forces the exit", async () => {
    const silent = new SilentServer();
    await silent.listen();
    try {
      const child = spawnChannel({
        name: "channel-silent",
        origin: silent.origin,
        token: "silent-server-token-0123456789",
      });
      children.push(child);
      await eventually(() => Promise.resolve(
        silent.requests.some((line) => line.startsWith("POST /api/v1/agents/agt_silent/claims")),
      ));

      const startedAt = Date.now();
      child.kill("SIGTERM");
      // The first stop is now waiting on a disconnect the server never answers.
      await eventually(() => Promise.resolve(
        silent.requests.includes("POST /api/v1/agents/agt_silent/disconnect"),
      ));
      child.kill("SIGTERM");
      expect(await exitOf(child)).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(4_000);
    } finally {
      await silent.close();
    }
  }, 60_000);
});
