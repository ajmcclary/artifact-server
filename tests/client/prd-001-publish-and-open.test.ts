import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
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
import {fetchLoopbackContent} from "../support/fetch-loopback-content.js";
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

function command(inputPath: string): FilePublicationCommand {
  return {
    idempotencyKey: randomUUID(),
    inputPath,
    target: {accessSetting: "public_link", kind: "new_artifact", tags: []},
  };
}

async function open(url: string | URL) {
  const response = await fetchLoopbackContent(url.toString());
  return {
    body: Buffer.from(await response.arrayBuffer()).toString("utf8"),
    contentType: response.headers.get("content-type"),
    status: response.status,
  };
}

describe("finished sites and ordinary files publish and open", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let fixtures: string;

  beforeAll(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    fixtures = await mkdtemp(path.join(tmpdir(), "prd-001-inputs-"));
  });

  afterAll(async () => {
    await server.stop();
    await Promise.all([
      removeTestInstallation(installation),
      rm(fixtures, {force: true, recursive: true}),
    ]);
  });

  function publish(inputPath: string, entryPath?: string) {
    const base = command(inputPath);
    return Effect.runPromise(
      publishPath(
        {apiToken: Redacted.make(installation.apiToken), serverOrigin: server.baseUrl},
        entryPath === undefined ? base : {...base, entryPath},
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
      .map((entry) => entry.artifact.id).toSorted();
  }

  test("PRD-001-B: a complete client-side site and one ordinary file each publish and open from their own links", async () => {
    const site = path.join(fixtures, "site");
    await mkdir(path.join(site, "assets"), {recursive: true});
    await Promise.all([
      writeFile(path.join(site, "index.html"), "<!doctype html><link rel=\"stylesheet\" href=\"assets/site.css\"><script src=\"assets/app.js\"></script><a href=\"guide.html\">Guide</a>"),
      writeFile(path.join(site, "guide.html"), "<!doctype html><title>Guide page</title>"),
      writeFile(path.join(site, "assets/site.css"), "body { margin: 0; }"),
      writeFile(path.join(site, "assets/app.js"), "document.body.dataset.site = 'ready';"),
    ]);
    const report = path.join(fixtures, "quarterly-report.pdf");
    await writeFile(report, "%PDF-1.7\nquarterly figures\n%%EOF\n");

    const [publishedSite, publishedFile] = await Promise.all([publish(site), publish(report)]);
    if (!publishedSite.success || !publishedFile.success) {
      throw new Error("A valid site or file did not publish.");
    }
    expect(publishedSite.result.artifact.id).not.toBe(publishedFile.result.artifact.id);

    const siteOrigin = publishedSite.result.links.version;
    expect(await Promise.all([
      open(siteOrigin),
      open(new URL("guide.html", siteOrigin)),
      open(new URL("assets/site.css", siteOrigin)),
      open(new URL("assets/app.js", siteOrigin)),
    ])).toEqual([
      {body: expect.stringContaining("assets/app.js"), contentType: "text/html; charset=utf-8", status: 200},
      {body: "<!doctype html><title>Guide page</title>", contentType: "text/html; charset=utf-8", status: 200},
      {body: "body { margin: 0; }", contentType: "text/css; charset=utf-8", status: 200},
      {body: "document.body.dataset.site = 'ready';", contentType: "text/javascript; charset=utf-8", status: 200},
    ]);
    expect(await open(publishedFile.result.links.version)).toEqual({
      body: "%PDF-1.7\nquarterly figures\n%%EOF\n",
      contentType: "application/pdf",
      status: 200,
    });
  });

  test("PRD-001-F: input that is neither a valid file nor a finished client-side directory is rejected without creating an artifact", async () => {
    const before = await listedArtifactIds();
    const empty = path.join(fixtures, "empty-directory");
    await mkdir(empty);
    const noEntry = path.join(fixtures, "directory-without-entry");
    await mkdir(noEntry);
    await writeFile(path.join(noEntry, "notes.txt"), "no HTML entry document");
    const wrongEntry = path.join(fixtures, "directory-with-missing-entry");
    await mkdir(wrongEntry);
    await writeFile(path.join(wrongEntry, "index.html"), "<!doctype html>");
    const pipe = path.join(fixtures, "not-a-file.fifo");
    execFileSync("mkfifo", [pipe]);

    const outcomes = await Promise.all([
      publish(path.join(fixtures, "does-not-exist")),
      publish(empty),
      publish(noEntry),
      publish(wrongEntry, "missing.html"),
      publish(pipe),
    ]);
    expect(outcomes.map((outcome) => outcome.success ? "published" : outcome.reason)).toEqual([
      "read_failed",
      "empty_directory",
      "invalid_entry",
      "invalid_entry",
      "unsupported_file_type",
    ]);
    expect(await listedArtifactIds()).toEqual(before);
  });
});
