/**
 * A loopback HTTP proxy in front of a GCS-compatible endpoint that simulates a
 * lost rewrite (copy) response: the first rewriteTo request is forwarded to the
 * server and its response is consumed, but the client socket is destroyed
 * before the response is returned, so the client sees a transport reset after
 * the server has already settled the copy.
 */

import {
  createServer,
  type IncomingMessage,
  request as httpRequest,
  type Server,
} from "node:http";

import {z} from "zod";

/** The running rewrite fault proxy. */
export interface GcsRewriteFaultProxy {
  /** How many rewrite responses were destroyed or errored after forwarding. */
  readonly destroyedRewriteResponses: number;
  /** Proxy origin to use as a GCS API endpoint. */
  readonly origin: string;
  stop(): Promise<void>;
}

const hopByHopHeaders = new Set([
  "connection",
  "content-encoding",
  "keep-alive",
  "transfer-encoding",
]);

/**
 * Start the proxy in front of one GCS-compatible origin.
 *
 * @param dropCount - How many rewrite responses to fault. Defaults to 1.
 * @param mode - "drop" destroys the response after forwarding so the server
 *   settles the copy but the client sees a reset; "error" answers with a 400
 *   JSON API error so the client sees a non-retryable failure without touching
 *   the upstream.
 */
export async function startGcsRewriteFaultProxy(
  targetOrigin: string,
  dropCount = 1,
  mode: "drop" | "error" = "drop",
): Promise<GcsRewriteFaultProxy> {
  let armed = dropCount;
  let destroyed = 0;
  const targetUrl = new URL(targetOrigin);

  const server: Server = createServer((request, response) => {
    void (async () => {
      const target = request.url ?? "/";
      const isRewrite = request.method === "POST" &&
        target.includes("/rewriteTo/");

      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", resolve);
        request.on("error", reject);
      });

      const forwardHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || hopByHopHeaders.has(name)) continue;
        forwardHeaders[name] = Array.isArray(value) ? value.join(", ") : value;
      }

      const shouldFault = isRewrite && armed > 0;
      if (shouldFault) {
        armed -= 1;
        destroyed += 1;
        if (mode === "error") {
          const errorBody = Buffer.from(JSON.stringify({
            error: {
              code: 400,
              message: "rewrite fault injection",
              errors: [{message: "rewrite fault injection", reason: "badRequest"}],
            },
          }));
          response.writeHead(400, {
            "content-length": String(errorBody.byteLength),
            "content-type": "application/json",
          });
          response.end(errorBody);
          return;
        }
      }

      const upstreamResponse = await new Promise<IncomingMessage>(
        (resolve, reject) => {
          const forwarded = httpRequest({
            headers: forwardHeaders,
            hostname: targetUrl.hostname,
            method: request.method ?? "GET",
            path: target,
            port: targetUrl.port,
          });
          forwarded.on("response", resolve);
          forwarded.on("error", reject);
          forwarded.write(Buffer.concat(chunks));
          forwarded.end();
        },
      );

      if (shouldFault && mode === "drop") {
        upstreamResponse.resume();
        request.socket.destroy();
        return;
      }

      const outgoing: Record<string, string> = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value === undefined || hopByHopHeaders.has(name)) continue;
        outgoing[name] = Array.isArray(value) ? value.join(", ") : value;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, outgoing);
      upstreamResponse.pipe(response);
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
    get destroyedRewriteResponses() {
      return destroyed;
    },
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
