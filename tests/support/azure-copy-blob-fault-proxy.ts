import {
  createServer,
  type IncomingMessage,
  request as httpRequest,
  type Server,
} from "node:http";

import {z} from "zod";

/** The running Copy Blob fault proxy. */
export interface AzureCopyBlobFaultProxy {
  /** How many Copy Blob responses were destroyed or errored after forwarding. */
  readonly destroyedCopyBlobResponses: number;
  /** Proxy origin to use as an Azure Blob service endpoint. */
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
 * Start a loopback proxy in front of an Azure Blob-compatible endpoint that
 * simulates a lost Copy Blob response: the first Copy Blob request is forwarded
 * and its response is consumed, but the client socket is destroyed before the
 * response is returned, so the client sees a transport reset after the server
 * has already settled the copy.
 */
export async function startAzureCopyBlobFaultProxy(
  targetOrigin: string,
  dropCount = 1,
  mode: "drop" | "error" = "drop",
): Promise<AzureCopyBlobFaultProxy> {
  let armed = dropCount;
  let destroyed = 0;
  const targetUrl = new URL(targetOrigin);
  const basePath = targetUrl.pathname.replace(/\/$/u, "");

  const server: Server = createServer((request, response) => {
    void (async () => {
      const target = request.url ?? "/";
      const isCopyBlob = request.method === "PUT" &&
        request.headers["x-ms-copy-source"] !== undefined;

      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", resolve);
        request.on("error", reject);
      });

      const shouldFault = isCopyBlob && armed > 0;
      if (shouldFault) {
        armed -= 1;
        destroyed += 1;
        if (mode === "error") {
          const errorBody = Buffer.from(
            '<?xml version="1.0" encoding="UTF-8"?>' +
              "<Error><Code>BadRequest</Code>" +
              "<Message>Copy Blob fault injection</Message></Error>",
          );
          response.writeHead(400, {
            "content-length": String(errorBody.byteLength),
            "content-type": "application/xml",
          });
          response.end(errorBody);
          return;
        }
      }

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
    get destroyedCopyBlobResponses() {
      return destroyed;
    },
    origin: `${targetUrl.protocol}//127.0.0.1:${address.port}${basePath}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** The running seal-race proxy. */
export interface AzureSealRaceProxy {
  /** Proxy origin to use as an Azure Blob service endpoint. */
  readonly origin: string;
  stop(): Promise<void>;
}

/**
 * Start a loopback proxy that overwrites a staged source after the seal's
 * metadata read is answered, so the sealed ETag no longer matches at copy time.
 * The next Copy Blob is held until the replacement settles.
 */
export async function startAzureSealRaceProxy(
  targetOrigin: string,
  sourceKey: string,
  onSealed: () => Promise<void>,
): Promise<AzureSealRaceProxy> {
  let fired = false;
  let pendingReplacement: Promise<void> | null = null;
  const targetUrl = new URL(targetOrigin);
  const basePath = targetUrl.pathname.replace(/\/$/u, "");

  const server: Server = createServer((request, response) => {
    void (async () => {
      const target = request.url ?? "/";
      const isSourceHead = request.method === "HEAD" &&
        target.endsWith(`/${sourceKey}`);
      const isCopyBlob = request.method === "PUT" &&
        request.headers["x-ms-copy-source"] !== undefined;

      if (isCopyBlob && pendingReplacement !== null) {
        await pendingReplacement;
      }

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

      if (isSourceHead && !fired) {
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
    origin: `${targetUrl.protocol}//127.0.0.1:${address.port}${basePath}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
