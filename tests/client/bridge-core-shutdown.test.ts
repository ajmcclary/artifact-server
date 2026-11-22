/**
 * A bridge shutdown is bounded even against a server that accepts requests
 * and never answers: the bundle fetch in flight is aborted with the session,
 * and the courtesy disconnect gives up after its own short bound. Hosts await
 * this stop on session shutdown, dispose, and channel exit, so an unbounded
 * stop would freeze the host itself.
 */

import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import type {AddressInfo} from "node:net";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  type BridgeHandle,
  disconnectTimeoutMilliseconds,
  type FollowUpDelivery,
  type HostPort,
  startBridge,
} from "@plannotator/agent-bridge";

class RecordingHostPort implements HostPort {
  readonly messages: {text: string; delivery: FollowUpDelivery}[] = [];

  isCompacting(): boolean {
    return false;
  }

  notify(): void {}

  sendUserMessage(text: string, delivery: FollowUpDelivery): void {
    this.messages.push({delivery, text});
  }
}

/**
 * Registers and hands out one dispatch, then goes silent: every other
 * request (the bundle fetch, the disconnect, later claims) is held open and
 * never answered. Held responses are recorded so the test can see what the
 * bridge attempted.
 */
class SilentServer {
  readonly requests: string[] = [];
  readonly #held: ServerResponse[] = [];
  readonly #server: Server;
  #claims = 0;

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
    await new Promise<void>((resolve) => {
      this.#server.listen(0, "127.0.0.1", resolve);
    });
  }

  async close(): Promise<void> {
    for (const response of this.#held) response.destroy();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }

  #answer(request: IncomingMessage, response: ServerResponse): void {
    const line = `${request.method ?? ""} ${request.url ?? ""}`;
    this.requests.push(line);
    request.resume();
    if (line === "POST /api/v1/agents") {
      this.#json(response, JSON.stringify({agent: {id: "agt_silent"}, protocolVersion: 1}));
      return;
    }
    if (line.startsWith("POST /api/v1/agents/agt_silent/claims") && this.#claims === 0) {
      this.#claims += 1;
      this.#json(response, JSON.stringify({
        dispatch: {
          id: "dsp_silent",
          note: null,
          projectId: "prj_silent",
          sender: {displayName: "Reviewer"},
          threadIds: ["thr_silent"],
        },
      }));
      return;
    }
    this.#held.push(response);
  }

  #json(response: ServerResponse, body: string): void {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(body);
  }
}

async function eventually(probe: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error("The awaited condition was not reached in time.");
    // eslint-disable-next-line no-await-in-loop -- polling waits between probes
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

describe("bounded bridge shutdown", () => {
  let server: SilentServer;
  let bridge: BridgeHandle | null;

  beforeEach(async () => {
    server = new SilentServer();
    await server.listen();
    bridge = null;
  });

  afterEach(async () => {
    await server.close();
  });

  test("stop aborts a bundle fetch the server never answers and bounds the courtesy disconnect", async () => {
    const host = new RecordingHostPort();
    bridge = startBridge({
      agentSessionId: null,
      credentials: {origin: server.origin, token: "silent-server-token-0123456789"},
      displayName: "silent",
      fetchImplementation: fetch,
      host,
      hostname: "silent-host",
      kind: "pi",
      waitSeconds: 1,
      workingDirectory: "/work/silent",
    });
    // The dispatch is claimed and its bundle fetch is now held open.
    await eventually(() => server.requests.some((line) => line.startsWith("GET /api/v1/artifacts?")));

    const startedAt = Date.now();
    await bridge.stop({disconnect: true});
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(disconnectTimeoutMilliseconds + 2_000);
    expect(server.requests).toContain("POST /api/v1/agents/agt_silent/disconnect");
    expect(host.messages).toHaveLength(0);
    expect(server.requests.some((line) => line.includes("/agent-dispatches/"))).toBe(false);
  }, 20_000);

  test("a rebind stop that skips the disconnect returns without waiting on the silent server", async () => {
    const host = new RecordingHostPort();
    bridge = startBridge({
      agentSessionId: null,
      credentials: {origin: server.origin, token: "silent-server-token-0123456789"},
      displayName: "silent",
      fetchImplementation: fetch,
      host,
      hostname: "silent-host",
      kind: "pi",
      waitSeconds: 1,
      workingDirectory: "/work/silent",
    });
    await eventually(() => server.requests.some((line) => line.startsWith("GET /api/v1/artifacts?")));

    const startedAt = Date.now();
    await bridge.stop({disconnect: false});

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(server.requests).not.toContain("POST /api/v1/agents/agt_silent/disconnect");
    expect(host.messages).toHaveLength(0);
  });
});
