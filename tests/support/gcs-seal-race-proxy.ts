/**
 * A loopback HTTP proxy in front of a GCS-compatible endpoint that simulates a
 * staged slot replaced between the seal's metadata read and the sealed copy:
 * the first object-metadata GET for the staging key is forwarded normally, and
 * once its response has reached the client the proxy runs the replacement
 * callback. A following rewrite request is held until the replacement has
 * settled, so the client copies only after the staged bytes changed.
 */

import {
  createServer,
  type IncomingMessage,
  request as httpRequest,
  type Server,
} from "node:http";

import {z} from "zod";

/** The running seal-race proxy. */
export interface GcsSealRaceProxy {
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
 * Start the proxy in front of one GCS-compatible origin. The callback runs
 * once, after the first metadata read of `sourceKey` is answered and before
 * the next rewrite is forwarded.
 */
export async function startGcsSealRaceProxy(
  targetOrigin: string,
  sourceKey: string,
  onSealed: () => Promise<void>,
): Promise<GcsSealRaceProxy> {
  let fired = false;
  let pendingReplacement: Promise<void> | null = null;
  const encodedKey = encodeURIComponent(sourceKey);
  const targetUrl = new URL(targetOrigin);

  const server: Server = createServer((request, response) => {
    void (async () => {
      const target = request.url ?? "/";
      const isMetadataRead = request.method === "GET" &&
        target.includes(`/o/${encodedKey}`) &&
        !target.includes("alt=media");
      const isRewrite = request.method === "POST" &&
        target.includes("/rewriteTo/");
      // The sealed copy must observe the replacement, never the sealed bytes.
      if (isRewrite && pendingReplacement !== null) await pendingReplacement;

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

      const outgoing: Record<string, string> = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value === undefined || hopByHopHeaders.has(name)) continue;
        outgoing[name] = Array.isArray(value) ? value.join(", ") : value;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, outgoing);
      upstreamResponse.pipe(response);
      await new Promise<void>((resolve, reject) => {
        response.on("finish", resolve);
        response.on("error", reject);
      });

      if (isMetadataRead && !fired) {
        fired = true;
        pendingReplacement = onSealed();
        await pendingReplacement;
      }
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
