/**
 * A loopback HTTP proxy in front of the real Artifact Server that injects the
 * two transport faults the live bridge suites need, while forwarding
 * everything else untouched so the bridge still talks to the real server over
 * a real network boundary.
 *
 * Fault one — lost acknowledgement: a `delivered` report whose connection is
 * destroyed BEFORE the request is forwarded. The server never processes it,
 * so the dispatch stays `claimed` until its lease expires; the bridge only
 * sees a failed request, which is the wire-level shape of a lost report. (A
 * response destroyed after forwarding would be no loss at all: the server
 * would already have settled the dispatch.)
 *
 * Fault two — duplicate lease delivery: the first claim poll that returns a
 * dispatch is recorded, and on demand the next claim poll is answered with
 * that recorded response instead of being forwarded — the proxy-level shape
 * of the server handing one lease to the same bridge twice.
 */

import {createServer, type Server} from "node:http";

import {z} from "zod";

/** The running fault-injecting proxy. */
export interface BridgeFaultProxy {
  /** Statuses of the `delivered` reports the proxy forwarded, in order. */
  deliveredReportStatuses(): readonly number[];
  /** How many `delivered` reports were destroyed without forwarding. */
  droppedDeliveredReports(): number;
  /** Destroy the next `count` `delivered` reports before they reach the server. */
  dropNextDeliveredReports(count: number): void;
  readonly origin: string;
  /** How many claim polls were answered with the recorded duplicate. */
  replayedClaims(): number;
  /**
   * Answer the next claim poll with a byte copy of the first recorded
   * dispatch claim. Arming before any dispatch was claimed is safe: the real
   * claim is still forwarded (and recorded), and the poll after it gets the
   * replay.
   */
  replayNextClaim(): void;
  stop(): Promise<void>;
}

const claimRoute = /^\/api\/v1\/agents\/[^/]+\/claims(?:\?|$)/u;
const deliveredReportRoute =
  /^\/api\/v1\/agent-dispatches\/[^/]+\/delivered(?:\?|$)/u;
const hopByHopHeaders = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "transfer-encoding",
]);

interface RecordedClaim {
  readonly body: Buffer;
  readonly headers: Record<string, string>;
  readonly status: number;
}

/** Start the proxy in front of one origin. */
export async function startBridgeFaultProxy(
  targetOrigin: string,
): Promise<BridgeFaultProxy> {
  let dropsArmed = 0;
  let dropped = 0;
  let replayArmed = false;
  let replayed = 0;
  let recordedClaim: RecordedClaim | null = null;
  const deliveredStatuses: number[] = [];

  const server: Server = createServer((request, response) => {
    void (async () => {
      const target = request.url ?? "/";
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", resolve);
        request.on("error", reject);
      });

      const isClaim = request.method === "POST" && claimRoute.test(target);
      const isDeliveredReport = request.method === "POST" &&
        deliveredReportRoute.test(target);

      // Lost acknowledgement: the report dies on the wire, the server never
      // sees it, and the bridge's fetch rejects.
      if (isDeliveredReport && dropsArmed > 0) {
        dropsArmed -= 1;
        dropped += 1;
        request.socket.destroy();
        return;
      }

      // Duplicate lease delivery: replay the recorded claim response.
      if (isClaim && replayArmed && recordedClaim !== null) {
        replayArmed = false;
        replayed += 1;
        response.writeHead(recordedClaim.status, recordedClaim.headers);
        response.end(recordedClaim.body);
        return;
      }

      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || hopByHopHeaders.has(name)) continue;
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      headers.set("host", new URL(targetOrigin).host);
      const method = request.method ?? "GET";
      const forwarded: RequestInit = method === "GET" || method === "HEAD"
        ? {headers, method}
        : {body: Buffer.concat(chunks), headers, method};
      const answer = await fetch(new URL(target, targetOrigin), forwarded);
      const answerBody = Buffer.from(await answer.arrayBuffer());
      const outgoing: Record<string, string> = {};
      answer.headers.forEach((value, name) => {
        if (!hopByHopHeaders.has(name)) outgoing[name] = value;
      });

      if (isDeliveredReport) deliveredStatuses.push(answer.status);
      if (isClaim && answer.status === 200 && recordedClaim === null) {
        recordedClaim = {body: answerBody, headers: outgoing, status: 200};
      }
      response.writeHead(answer.status, outgoing);
      response.end(answerBody);
    })().catch(() => {
      response.writeHead(502);
      response.end();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = z.object({port: z.number()}).parse(server.address());

  return {
    deliveredReportStatuses: () => deliveredStatuses,
    droppedDeliveredReports: () => dropped,
    dropNextDeliveredReports: (count) => {
      dropsArmed += count;
    },
    origin: `http://127.0.0.1:${address.port}`,
    replayedClaims: () => replayed,
    replayNextClaim: () => {
      replayArmed = true;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
