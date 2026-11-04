import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile} from "node:fs/promises";
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

/** The conventional unprivileged "nobody" identity. */
const unprivilegedId = 65_534;

function command(inputPath: string): FilePublicationCommand {
  return {
    idempotencyKey: randomUUID(),
    inputPath,
    target: {accessSetting: "account_required", kind: "new_artifact", tags: []},
  };
}

/**
 * Runs `operation` with an operating-system identity that file permissions
 * bind. Root bypasses permission bits, so a root test process drops its
 * effective identity for the operation and restores it afterwards.
 */
async function asPermissionBoundIdentity<T>(operation: () => Promise<T>): Promise<T> {
  const privileged = process.geteuid?.() === 0;
  if (!privileged) return operation();
  process.setegid?.(unprivilegedId);
  process.seteuid?.(unprivilegedId);
  try {
    return await operation();
  } finally {
    process.seteuid?.(0);
    process.setegid?.(0);
  }
}

describe("the local publishing client reads only safe, permitted paths", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let fixtures: string;

  beforeAll(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    fixtures = await mkdtemp(path.join(tmpdir(), "pub-010-client-path-"));
  });

  afterAll(async () => {
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

  async function applicationText(route: string): Promise<string> {
    const response = await fetch(new URL(route, server.baseUrl), {
      headers: {Authorization: `Bearer ${installation.apiToken}`},
    });
    expect(response.status).toBe(200);
    return response.text();
  }

  async function listedArtifactIds(): Promise<readonly string[]> {
    return artifactListSchema.parse(JSON.parse(await applicationText("/api/v1/artifacts")))
      .artifacts.map((entry) => entry.artifact.id).toSorted();
  }

  test("PUB-010-B: a regular local file publishes its bytes at upload time, and later source edits do not change the saved version", async () => {
    const source = path.join(fixtures, "client-notes.txt");
    await writeFile(source, "bytes read when the client published\n");
    const published = await publish(source);
    expect(published.success).toBe(true);
    if (!published.success) throw new Error("The regular file did not publish.");
    const {artifact, version} = published.result;

    await writeFile(source, "bytes edited after the publish\n");
    expect(await applicationText(
      `/api/v1/artifacts/${artifact.id}/versions/${version.id}/file?path=client-notes.txt`,
    )).toBe("bytes read when the client published\n");

    // The server keeps the file name the client derived, never the client's
    // filesystem path.
    const records = await Promise.all([
      applicationText(`/api/v1/artifacts/${artifact.id}`),
      applicationText(`/api/v1/artifacts/${artifact.id}/versions/${version.id}`),
      applicationText(`/api/v1/artifacts/${artifact.id}/actions`),
    ]);
    expect(records.filter((record) => record.includes(fixtures))).toEqual([]);
    expect(records[1]).toContain("client-notes.txt");
  });

  test("PUB-010-F: symbolic links, special files, forbidden manifest paths, and unreadable paths are refused before an upload exists", async () => {
    const before = await listedArtifactIds();
    const target = path.join(fixtures, "target.txt");
    await writeFile(target, "outside the publication");

    const link = path.join(fixtures, "link.txt");
    await symlink(target, link);
    const fifo = path.join(fixtures, "client.fifo");
    execFileSync("mkfifo", [fifo]);
    const gitDirectory = path.join(fixtures, "with-git");
    await mkdir(path.join(gitDirectory, ".git"), {recursive: true});
    await Promise.all([
      writeFile(path.join(gitDirectory, "index.html"), "<!doctype html><title>Site</title>"),
      writeFile(path.join(gitDirectory, ".git/config"), "[core]\n"),
    ]);
    // Names a filesystem accepts but a manifest forbids.
    const forbiddenNames = ["back\\slash.txt", ".artifactserver", "cafe\u0301.txt"];
    const forbiddenDirectories = await Promise.all(forbiddenNames.map(async (name, index) => {
      const directory = path.join(fixtures, `forbidden-${index}`);
      await mkdir(directory);
      await writeFile(path.join(directory, "index.html"), "<!doctype html><title>Site</title>");
      await writeFile(path.join(directory, name), "a name no manifest may carry");
      return directory;
    }));

    const unreadable = path.join(fixtures, "unreadable.txt");
    await writeFile(unreadable, "the client identity cannot read these bytes");
    await chmod(unreadable, 0o000);
    // The file exists; only the client's operating-system identity is denied.
    expect((await lstat(unreadable)).isFile()).toBe(true);

    const outcomes = await Promise.all([
      publish(link),
      publish(fifo),
      publish(gitDirectory),
      ...forbiddenDirectories.map((directory) => publish(directory)),
    ]);
    const denied = await asPermissionBoundIdentity(() => publish(unreadable));
    expect([...outcomes, denied].map((outcome) =>
      outcome.success ? "published" : outcome.reason
    )).toEqual([
      "symbolic_link",
      "unsupported_file_type",
      "invalid_path",
      "invalid_path",
      "invalid_path",
      "invalid_path",
      "read_failed",
    ]);
    expect(await listedArtifactIds()).toEqual(before);
  });
});
