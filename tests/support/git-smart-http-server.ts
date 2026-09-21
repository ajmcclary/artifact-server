import {spawn, execFile} from "node:child_process";
import {mkdtemp, rm} from "node:fs/promises";
import {createServer, type IncomingMessage, type ServerResponse} from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";

import {z} from "zod";

const execute = promisify(execFile);
const maximumRequestBytes = 2 * 1024 * 1024;
const addressSchema = z.object({port: z.number().int().positive()});

/** Disposable Git smart-HTTP remote backed by the installed git-http-backend. */
export async function startGitSmartHttpServer() {
  const root = await mkdtemp(join(tmpdir(), "artifact-server-git-http-"));
  const barePath = join(root, "repository.git");
  await execute("git", ["init", "--bare", barePath]);
  await execute("git", ["--git-dir", barePath, "symbolic-ref", "HEAD", "refs/heads/main"]);
  await execute("git", ["--git-dir", barePath, "config", "http.receivepack", "true"]);
  await execute("git", [
    "--git-dir", barePath, "config", "receive.denyNonFastForwards", "true",
  ]);
  let receivePackCalls = 0;
  let receivePackDiscoveryCalls = 0;
  let receivePackUpdateCalls = 0;
  const droppedResponses = new Set<number>();
  let advanceBeforeDiscovery: string | null = null;
  let heldDiscovery: {
    readonly call: number;
    readonly entered: PromiseWithResolvers<void>;
    readonly resume: PromiseWithResolvers<void>;
  } | null = null;
  let heldUpdate: {
    readonly call: number;
    readonly entered: PromiseWithResolvers<void>;
    readonly resume: PromiseWithResolvers<void>;
  } | null = null;
  let heldResponse: {
    readonly call: number;
    readonly entered: PromiseWithResolvers<void>;
    readonly resume: PromiseWithResolvers<void>;
  } | null = null;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" &&
        url.searchParams.get("service") === "git-receive-pack") {
        receivePackDiscoveryCalls += 1;
        if (heldDiscovery?.call === receivePackDiscoveryCalls) {
          const held = heldDiscovery;
          heldDiscovery = null;
          held.entered.resolve();
          await held.resume.promise;
        }
      }
      if (
        advanceBeforeDiscovery !== null && request.method === "GET" &&
        url.searchParams.get("service") === "git-receive-pack"
      ) {
        await execute("git", [
          "--git-dir", barePath, "update-ref", "refs/heads/main",
          advanceBeforeDiscovery,
        ]);
        advanceBeforeDiscovery = null;
      }
      if (request.method === "POST" && url.pathname.endsWith("/git-receive-pack")) {
        receivePackUpdateCalls += 1;
        if (heldUpdate?.call === receivePackUpdateCalls) {
          const held = heldUpdate;
          heldUpdate = null;
          held.entered.resolve();
          await held.resume.promise;
        }
      }
      const body = await readBoundedRequest(request);
      const child = spawn("git", ["http-backend"], {
        env: {
          ...process.env,
          CONTENT_LENGTH: String(body.byteLength),
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          GIT_HTTP_EXPORT_ALL: "1",
          GIT_PROJECT_ROOT: root,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REMOTE_USER: "git-test",
          REQUEST_METHOD: request.method ?? "GET",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.end(body);
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? -1));
      });
      if (exitCode !== 0) {
        response.writeHead(500).end(Buffer.concat(errors));
        return;
      }
      if (request.method === "POST" && url.pathname.endsWith("/git-receive-pack")) {
        receivePackCalls += 1;
        if (heldResponse?.call === receivePackCalls) {
          const held = heldResponse;
          heldResponse = null;
          held.entered.resolve();
          await held.resume.promise;
        }
        if (droppedResponses.delete(receivePackCalls)) {
          response.destroy();
          return;
        }
      }
      writeCgiResponse(response, Buffer.concat(output));
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = addressSchema.parse(server.address());
  return {
    barePath,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) =>
        error === undefined ? resolve() : reject(error)));
      await rm(root, {recursive: true, force: true});
    },
    dropReceivePackResponseAt: (call: number) => droppedResponses.add(call),
    nextReceivePackCall: () => receivePackCalls + 1,
    holdReceivePackResponseAt: (call: number) => {
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      heldResponse = {call, entered, resume};
      return {entered: entered.promise, release: () => resume.resolve()};
    },
    holdNextReceivePackDiscovery: () => {
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      heldDiscovery = {call: receivePackDiscoveryCalls + 1, entered, resume};
      return {entered: entered.promise, release: () => resume.resolve()};
    },
    holdReceivePackDiscoveryAt: (call: number) => {
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      heldDiscovery = {call, entered, resume};
      return {entered: entered.promise, release: () => resume.resolve()};
    },
    holdReceivePackUpdateAt: (call: number) => {
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      heldUpdate = {call, entered, resume};
      return {entered: entered.promise, release: () => resume.resolve()};
    },
    nextReceivePackDiscoveryCall: () => receivePackDiscoveryCalls + 1,
    nextReceivePackUpdateCall: () => receivePackUpdateCalls + 1,
    advanceMainBeforeNextPush: (commitId: string) => {
      advanceBeforeDiscovery = commitId;
    },
    remoteUrl: `http://127.0.0.1:${address.port}/repository.git`,
  };
}

async function readBoundedRequest(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maximumRequestBytes) {
      throw new Error("The disposable Git request exceeded its byte bound.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function writeCgiResponse(response: ServerResponse, output: Buffer): void {
  const crlf = output.indexOf("\r\n\r\n");
  const lf = output.indexOf("\n\n");
  const separator = crlf === -1 ? lf : crlf;
  if (separator === -1) throw new Error("Git CGI response omitted its headers.");
  const separatorLength = crlf === -1 ? 2 : 4;
  const headerLines = output.subarray(0, separator).toString("utf8").split(/\r?\n/u);
  let status = 200;
  for (const line of headerLines) {
    const boundary = line.indexOf(":");
    if (boundary === -1) continue;
    const name = line.slice(0, boundary).trim();
    const value = line.slice(boundary + 1).trim();
    if (name.toLowerCase() === "status") {
      status = Number.parseInt(value, 10);
    } else {
      response.setHeader(name, value);
    }
  }
  response.writeHead(status).end(output.subarray(separator + separatorLength));
}
