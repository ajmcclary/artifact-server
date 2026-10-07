/**
 * A loopback HTTP proxy in front of the real Artifact Server that injects
 * staged-transfer faults into chosen file PUTs and batch POSTs, while
 * forwarding everything else so the publication client still talks to the
 * real server over a real network boundary.
 *
 * - `drop`: destroy the connection as soon as the first body bytes arrive,
 *   without forwarding: the wire shape of a client uplink or proxy dying
 *   mid-body.
 * - `status`: answer an error without forwarding, as an overloaded proxy or
 *   a server that saw the body cut short would.
 * - `corrupt`: flip one body byte, then forward, so the real server rejects
 *   the digest.
 */

import {createServer, type IncomingMessage, type Server} from "node:http";

import {z} from "zod";

/** One injected fault for the next matching transfer. */
export type UploadFault =
  | {readonly kind: "corrupt"}
  | {readonly kind: "drop"}
  | {readonly code: string; readonly kind: "status"; readonly status: number};

/** The running fault-injecting proxy. */
export interface UploadFaultProxy {
  /** Start times, in milliseconds since the epoch, of every batch POST. */
  batchAttempts(): readonly number[];
  /** Apply these faults, in order, to the next batch POSTs. */
  failBatches(faults: readonly UploadFault[]): void;
  /** Apply these faults, in order, to the next PUTs of one manifest path. */
  failFile(manifestPath: string, faults: readonly UploadFault[]): void;
  /** Start times, in milliseconds since the epoch, of every PUT of one manifest path. */
  fileAttempts(manifestPath: string): readonly number[];
  readonly origin: string;
  stop(): Promise<void>;
}

const assignedAddressSchema = z.object({port: z.number().int().positive()});
const uploadPlanSchema = z.object({
  files: z.array(z.object({path: z.string(), uploadUrl: z.url()}).loose()),
}).loose();
const forwardedRequestHeaders = new Set([
  "authorization",
  "content-type",
  "idempotency-key",
]);

/** Start the proxy in front of one Artifact Server origin. */
export async function startUploadFaultProxy(
  upstreamOrigin: string,
): Promise<UploadFaultProxy> {
  let origin = "";
  const pathByUploadRoute = new Map<string, string>();
  const fileFaults = new Map<string, UploadFault[]>();
  const fileAttempts = new Map<string, number[]>();
  const batchFaults: UploadFault[] = [];
  const batchAttempts: number[] = [];

  const server: Server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", upstreamOrigin);
    const manifestPath = request.method === "PUT"
      ? pathByUploadRoute.get(requestUrl.pathname)
      : undefined;
    const isBatch = request.method === "POST" &&
      requestUrl.pathname.endsWith("/batch");
    let fault: UploadFault | undefined;
    if (manifestPath !== undefined) {
      const attempts = fileAttempts.get(manifestPath) ?? [];
      attempts.push(Date.now());
      fileAttempts.set(manifestPath, attempts);
      fault = fileFaults.get(manifestPath)?.shift();
    } else if (isBatch) {
      batchAttempts.push(Date.now());
      fault = batchFaults.shift();
    }
    if (fault?.kind === "drop") {
      request.once("data", () => {
        request.socket.destroy();
      });
      return;
    }
    if (fault?.kind === "status") {
      request.resume();
      response.writeHead(fault.status, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        error: {code: fault.code, message: `Injected ${fault.status} ${fault.code}.`},
      }));
      return;
    }
    const corrupt = fault?.kind === "corrupt";
    void (async () => {
      const body = await readBody(request);
      if (corrupt && body.byteLength > 0) {
        body[0] = (body[0] ?? 0) ^ 0xff;
      }
      const headers = new Headers();
      for (const name of forwardedRequestHeaders) {
        const value = request.headers[name];
        if (value !== undefined) {
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
      }
      const init: RequestInit = {
        headers,
        method: request.method ?? "GET",
        redirect: "manual",
      };
      if (body.byteLength > 0) {
        init.body = body;
      }
      const upstream = await fetch(requestUrl, init);
      const text = (await upstream.text()).replaceAll(upstreamOrigin, origin);
      if (request.method === "POST" && requestUrl.pathname === "/api/v1/uploads") {
        rememberUploadRoutes(text, pathByUploadRoute);
      }
      response.writeHead(upstream.status, {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      });
      response.end(text);
    })().catch((cause: unknown) => {
      response.writeHead(599, {"Content-Type": "text/plain"});
      response.end(cause instanceof Error ? cause.message : "proxy failure");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${assignedAddressSchema.parse(server.address()).port}`;
  return {
    batchAttempts: () => [...batchAttempts],
    failBatches: (faults) => {
      batchFaults.push(...faults);
    },
    failFile: (manifestPath, faults) => {
      fileFaults.set(manifestPath, [...faults]);
    },
    fileAttempts: (manifestPath) => [...(fileAttempts.get(manifestPath) ?? [])],
    origin,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    },
  };
}

function rememberUploadRoutes(
  responseText: string,
  pathByUploadRoute: Map<string, string>,
): void {
  const plan = uploadPlanSchema.safeParse(JSON.parse(responseText));
  if (!plan.success) return;
  for (const file of plan.data.files) {
    pathByUploadRoute.set(new URL(file.uploadUrl).pathname, file.path);
  }
}

async function readBody(request: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const joined = Buffer.concat(chunks);
  const body = new Uint8Array(joined.byteLength);
  body.set(joined);
  return body;
}
