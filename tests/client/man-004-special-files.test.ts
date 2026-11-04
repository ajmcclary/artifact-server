import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdir, mkdtemp, rm, symlink, writeFile} from "node:fs/promises";
import {createServer, type Server} from "node:net";
import {tmpdir} from "node:os";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {afterAll, beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  type FilePublicationCommand,
  publishPath,
} from "../../src/client/file-publication-client.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const artifactListSchema = z.object({
  artifacts: z.array(z.object({artifact: z.object({id: z.string()}).loose()}).loose()),
}).loose();

const manifestSchema = z.object({
  manifest: z.object({
    entries: z.array(z.object({path: z.string()}).loose()),
  }).loose(),
}).loose();

function command(inputPath: string): FilePublicationCommand {
  return {
    idempotencyKey: randomUUID(),
    inputPath,
    target: {accessSetting: "account_required", kind: "new_artifact", tags: []},
  };
}

function fifo(entryPath: string): Promise<void> {
  execFileSync("mkfifo", [entryPath]);
  return Promise.resolve();
}

function listenOnSocket(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

describe("publishing accepts only regular files and directories", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let fixtures: string;
  const socketServers: Server[] = [];

  beforeAll(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    // Unix socket paths are capped at 104 bytes on macOS, and its per-user
    // tmpdir() (/var/folders/…) leaves too little room for the nested socket.
    const fixtureRoot = process.platform === "darwin" ? "/tmp" : tmpdir();
    fixtures = await mkdtemp(path.join(fixtureRoot, "man-004-"));
  });

  afterAll(async () => {
    await Promise.all(socketServers.map((socketServer) =>
      new Promise<void>((resolve) => {
        socketServer.close(() => resolve());
      })
    ));
    await server.stop();
    await Promise.all([
      removeTestInstallation(installation),
      rm(fixtures, {force: true, recursive: true}),
    ]);
  });

  function publish(inputPath: string) {
    return Effect.runPromise(
      publishPath(
        {apiToken: Redacted.make(installation.apiToken), serverOrigin: server.baseUrl},
        command(inputPath),
      ).pipe(
        Effect.match({
          onFailure: (error) => ({
            reason: "reason" in error ? error.reason : error._tag,
            success: false as const,
          }),
          onSuccess: (result) => ({result, success: true as const}),
        }),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(NodeFileSystem.layer),
      ),
    );
  }

  async function listedArtifactIds(): Promise<readonly string[]> {
    const response = await fetch(new URL("/api/v1/artifacts", server.baseUrl), {
      headers: {Authorization: `Bearer ${installation.apiToken}`},
    });
    expect(response.status).toBe(200);
    return artifactListSchema.parse(await response.json()).artifacts
      .map((entry) => entry.artifact.id)
      .toSorted();
  }

  test("MAN-004-B: a directory containing only regular files and nested directories publishes every file", async () => {
    const site = path.join(fixtures, "regular-site");
    await mkdir(path.join(site, "assets/images"), {recursive: true});
    await Promise.all([
      writeFile(path.join(site, "index.html"), "<!doctype html><title>Regular</title>"),
      writeFile(path.join(site, "assets/app.js"), "document.title = 'ready';"),
      writeFile(path.join(site, "assets/images/pixel.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>"),
    ]);
    const published = await publish(site);
    expect(published.success).toBe(true);
    if (!published.success) throw new Error("The regular directory did not publish.");

    const version = await fetch(
      new URL(
        `/api/v1/artifacts/${published.result.artifact.id}/versions/${published.result.version.id}`,
        server.baseUrl,
      ),
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(version.status).toBe(200);
    expect(manifestSchema.parse(await version.json()).manifest.entries
      .map((entry) => entry.path)
      .toSorted()).toEqual(["assets/app.js", "assets/images/pixel.svg", "index.html"]);
  });

  test("MAN-004-F: symbolic links, FIFOs, sockets, and devices fail before an upload or version exists", async () => {
    const before = await listedArtifactIds();
    const target = path.join(fixtures, "target.txt");
    await writeFile(target, "outside the publication");

    // A special entry nested inside an otherwise valid directory.
    const nested = async (name: string, create: (entryPath: string) => Promise<void>) => {
      const directory = path.join(fixtures, `nested-${name}`);
      await mkdir(directory);
      await writeFile(path.join(directory, "index.html"), "<!doctype html><title>Valid</title>");
      await create(path.join(directory, `special-${name}`));
      return directory;
    };
    const socket = async (entryPath: string) => {
      const socketServer = createServer();
      socketServers.push(socketServer);
      await listenOnSocket(socketServer, entryPath);
    };

    const rootSymlink = path.join(fixtures, "root-link.txt");
    await symlink(target, rootSymlink);
    const rootFifo = path.join(fixtures, "root.fifo");
    await fifo(rootFifo);
    const rootSocket = path.join(fixtures, "root.sock");
    await socket(rootSocket);

    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["root symbolic link", rootSymlink, "symbolic_link"],
      ["root FIFO", rootFifo, "unsupported_file_type"],
      ["root socket", rootSocket, "unsupported_file_type"],
      ["character device", "/dev/null", "unsupported_file_type"],
      ["nested file symbolic link", await nested("file-link", (entryPath) => symlink(target, entryPath)), "symbolic_link"],
      ["nested directory symbolic link", await nested("directory-link", (entryPath) => symlink(fixtures, entryPath)), "symbolic_link"],
      ["nested dangling symbolic link", await nested("dangling-link", (entryPath) => symlink(path.join(fixtures, "absent"), entryPath)), "symbolic_link"],
      ["nested FIFO", await nested("fifo", fifo), "unsupported_file_type"],
      ["nested socket", await nested("socket", socket), "unsupported_file_type"],
    ];
    const outcomes = await Promise.all(cases.map(async ([label, inputPath]) => {
      const outcome = await publish(inputPath);
      return [label, outcome.success ? "published" : outcome.reason] as const;
    }));
    expect(outcomes).toEqual(cases.map(([label, , reason]) => [label, reason]));

    // No rejected input left an artifact or version behind.
    expect(await listedArtifactIds()).toEqual(before);
  });
});
