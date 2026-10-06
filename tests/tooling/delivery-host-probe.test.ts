import {once} from "node:events";
import {createServer, type Server} from "node:http";

import {afterEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {probeHostDatabaseLatency} from "../../project/performance/delivery/host-probe.js";

let server: Server | null = null;

async function serveReadiness(responses: readonly {readonly body: string; readonly status: number}[]): Promise<string> {
  let next = 0;
  server = createServer((request, response) => {
    const reply = responses[Math.min(next, responses.length - 1)];
    next += 1;
    if (request.url !== "/ready" || reply === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(reply.status, {"content-type": "application/json"}).end(reply.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const {port} = z.object({port: z.number().int()}).parse(server.address());
  return `http://127.0.0.1:${port}`;
}

const readiness = (databaseMilliseconds: number) => ({
  body: JSON.stringify({
    components: {database: {latencyMilliseconds: databaseMilliseconds, status: "ready"}},
    lifecycle: "ready",
    status: "ready",
  }),
  status: 200,
});

afterEach(async () => {
  const running = server;
  server = null;
  if (running !== null) await new Promise((resolve) => running.close(resolve));
});

describe("delivery host probe", () => {
  test("foundation: the host probe reports the median database latency the server measured itself", async () => {
    const origin = await serveReadiness([readiness(12.34), readiness(1.2), readiness(48), readiness(3.3), readiness(7.75)]);
    expect(await probeHostDatabaseLatency(origin, 5)).toBe(7.75);
  });

  test("foundation: the host probe ignores readiness replies without a database measurement", async () => {
    const origin = await serveReadiness([
      {body: JSON.stringify({lifecycle: "ready", status: "ready"}), status: 200},
      {body: "not json", status: 200},
      {body: JSON.stringify({components: {database: {latencyMilliseconds: 900, status: "unavailable"}}}), status: 503},
      readiness(4),
    ]);
    expect(await probeHostDatabaseLatency(origin, 4)).toBe(4);
  });

  test("foundation: the host probe reports nothing when the server exposes no database measurement or is unreachable", async () => {
    const origin = await serveReadiness([{body: JSON.stringify({lifecycle: "ready", status: "ready"}), status: 200}]);
    expect(await probeHostDatabaseLatency(origin, 3)).toBeNull();
    expect(await probeHostDatabaseLatency("http://127.0.0.1:9", 2)).toBeNull();
  });
});
