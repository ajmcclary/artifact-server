import {spawn} from "node:child_process";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import path from "node:path";

import {z} from "zod";

import {createTestInstallation, removeTestInstallation, startTestServer} from "./runtime-harness.js";

export interface CliResult {readonly code: number; readonly stdout: string; readonly stderr: string;}
export interface PublicationProxyHooks {
  before?: (pathname: string) => Promise<void>;
  after?: (pathname: string) => Promise<void>;
  dropCommit?: boolean;
}

export function startPublicationCli(args: readonly string[], environment: NodeJS.ProcessEnv = {}) {
  const inherited = {...process.env};
  delete inherited["ARTIFACT_SERVER_URL"];
  delete inherited["ARTIFACT_SERVER_API_TOKEN"];
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli/main.ts", ...args], {
    cwd: path.resolve(import.meta.dirname, "../.."), env: {...inherited, ...environment}, stdio: ["ignore", "pipe", "pipe"],
  });
  const result = new Promise<CliResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (bytes: Buffer) => { stdout += bytes.toString(); });
    child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({code: code ?? -1, stdout, stderr}));
  });
  return {child, result};
}

/** Real server plus a transparent loopback boundary for lost responses and forced interleavings. */
export async function publicationCliFixture(publicLinkOrigin?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "artifact-publications-"));
  const source = path.join(root, "source");
  const profiles = path.join(root, "profiles");
  const tokenFile = path.join(root, "token");
  await mkdir(source);
  await writeFile(path.join(source, "index.html"), "<h1>first</h1>");
  const installation = await createTestInstallation();
  await writeFile(tokenFile, installation.apiToken, {mode: 0o600});
  const upstream = await startTestServer(installation);
  const hooks: PublicationProxyHooks = {};
  let origin = "";
  let uploads = 0;
  let commits = 0;
  const errors: string[] = [];
  const proxy = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", upstream.baseUrl);
      if (request.method === "POST" && url.pathname === "/api/v1/uploads") uploads += 1;
      if (request.method === "POST" && url.pathname.endsWith("/commit")) commits += 1;
      await hooks.before?.(url.pathname);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(z.instanceof(Buffer).parse(chunk));
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      if (request.headers.authorization !== undefined) headers.set("authorization", request.headers.authorization);
      if (request.headers["content-type"] !== undefined) headers.set("content-type", request.headers["content-type"]);
      const key = request.headers["idempotency-key"];
      if (key !== undefined) headers.set("idempotency-key", Array.isArray(key) ? key.join(",") : key);
      let init: RequestInit = {method: request.method ?? "GET", headers};
      if (body.length > 0) init = {...init, body: new Uint8Array(body)};
      const result = await fetch(url, init);
      const text = await result.text();
      await hooks.after?.(url.pathname);
      if (hooks.dropCommit && url.pathname.endsWith("/commit") && result.ok) {
        hooks.dropCommit = false;
        response.destroy();
        return;
      }
      response.writeHead(result.status, {"content-type": "application/json"});
      const receipt = z.object({artifact: z.object({id: z.string()})}).safeParse(JSON.parse(text));
      const linkOrigin = receipt.success && publicLinkOrigin !== undefined ? publicLinkOrigin : origin;
      response.end(text.replaceAll(upstream.baseUrl, linkOrigin));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Proxy failed");
      response.writeHead(502);
      response.end("Proxy failed");
    }
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${z.object({port: z.number()}).parse(proxy.address()).port}`;
  const destination = ["--server", origin, "--token-file", tokenFile, "--profile-data", profiles];
  return {
    root, source, profiles, tokenFile, origin, installation, hooks, destination, errors,
    uploads: () => uploads, commits: () => commits,
    run: (args: readonly string[]) => startPublicationCli([...args, ...destination]).result,
    publish: (args: readonly string[] = []) => startPublicationCli(["publish", source, ...destination, ...args]).result,
    stop: async () => {
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) => proxy.close((error) => error === undefined ? resolve() : reject(error)));
      await upstream.stop();
      await removeTestInstallation(installation);
      await rm(root, {recursive: true, force: true});
    },
  };
}
