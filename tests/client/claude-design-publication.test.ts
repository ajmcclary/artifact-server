import {randomUUID} from "node:crypto";
import {mkdtemp, readFile, readdir, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {afterAll, beforeAll, expect, test} from "vitest";

import {prepareFilePublication, publishPath} from "../../src/client/file-publication-client.js";
import {createClaudeDesignCatalog} from "../../src/manifest/claude-design.js";
import {writeClaudeDesignFixture} from "../support/claude-design-fixture.js";
import {fetchLoopbackContent} from "../support/fetch-loopback-content.js";
import {createTestInstallation, removeTestInstallation, startTestServer, type RunningTestServer, type TestInstallation} from "../support/runtime-harness.js";

let directory: string;
let installation: TestInstallation;
let server: RunningTestServer;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "claude-design-test-"));
  installation = await createTestInstallation();
  server = await startTestServer(installation);
});
afterAll(async () => {
  await server.stop();
  await removeTestInstallation(installation);
  await rm(directory, {recursive: true, force: true});
});

function intent(inputPath: string) {
  return {inputPath, target: {kind: "new_artifact", accessSetting: "public_link", tags: []}} as const;
}

test("DSN-001-B: flat and nested systems publish immutable catalogs and original assets through staged HTTP", async () => {
  await Promise.all([false, true].map(async (nested) => {
    const inputPath = path.join(directory, nested ? "nested" : "flat");
    const root = await writeClaudeDesignFixture(inputPath, nested);
    const original = await readFile(path.join(root, "components/card-button.html"));
    const first = await Effect.runPromise(prepareFilePublication(intent(inputPath)));
    const second = await Effect.runPromise(prepareFilePublication(intent(inputPath)));
    expect(second.operationDigest).toBe(first.operationDigest);
    expect(await readdir(inputPath)).not.toContain("artifact-server-design.html");
    const command = {...intent(inputPath), idempotencyKey: randomUUID()};
    const publish = () => Effect.runPromise(publishPath({serverOrigin: server.baseUrl, apiToken: Redacted.make(installation.apiToken)}, command).pipe(
      Effect.provide(FetchHttpClient.layer), Effect.provide(NodeFileSystem.layer),
    ));
    const result = await publish();
    expect(result.version.entryPath).toBe("artifact-server-design.html");
    expect((await publish()).version.id).toBe(result.version.id);
    const catalog = await fetchLoopbackContent(result.links.version);
    expect(await catalog.text()).toContain("Claude Design System");
    const prefix = nested ? "project/" : "";
    const card = await fetchLoopbackContent(new URL(`${prefix}components/card-button.html`, result.links.version).toString());
    expect(Buffer.from(await card.arrayBuffer())).toEqual(original);
    const font = await fetchLoopbackContent(new URL(`${prefix}font.woff2`, result.links.version).toString());
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(font.headers.get("content-disposition")).not.toContain("attachment");
  }));

  // Projects gain artboard navigation while existing and explicit entries win.
  const inputPath = path.join(directory, "project");
  await writeClaudeDesignFixture(inputPath);
  await rm(path.join(inputPath, "_ds_manifest.json"));
  const inferred = await Effect.runPromise(prepareFilePublication(intent(inputPath)));
  expect(inferred.publication.entryPath).toBe("artifact-server-design.html");
  const generated = inferred.publication.files.find((file) => file.kind === "generated");
  expect(generated?.kind === "generated" && generated.content).toContain("Claude Design Project");
  await writeFile(path.join(inputPath, "index.html"), "Existing entry");
  const existing = await Effect.runPromise(prepareFilePublication(intent(inputPath)));
  expect(existing.publication.entryPath).toBe("index.html");
  const explicit = await Effect.runPromise(prepareFilePublication({...intent(inputPath), entryPath: "templates/Screen.dc.html"}));
  expect(explicit.publication.entryPath).toBe("templates/Screen.dc.html");
  expect(explicit.publication.files.some((file) => file.kind === "generated")).toBe(false);
});

test("DSN-001-F: invalid metadata, references, symlinks and catalog collisions fail closed", async () => {
  for (const reference of ["../outside.html", "/outside.html", "https://example.com/card.html", "missing.html", "styles.css", "a%2fb.html", "a\\b.html"]) {
    expect(() => createClaudeDesignCatalog(["styles.css"], "_ds_manifest.json", JSON.stringify({namespace: "Test", cards: [{path: reference, name: "Unsafe"}]}))).toThrow(/.+/u);
  }
  for (const text of ["{", "null", '{"namespace":"Test","cards":[]}', '{"namespace":"Test","cards":"bad"}']) {
    expect(() => createClaudeDesignCatalog([], "_ds_manifest.json", text)).toThrow(/.+/u);
  }
  const html = createClaudeDesignCatalog(["card.html"], "_ds_manifest.json", JSON.stringify({namespace: '<script>alert(1)</script>', cards: [{path: "card.html", name: '"><script>alert(2)</script>', viewport: '1" onload=alert(3)'}]}));
  expect(html).not.toContain("<script>alert(");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain('data-width="1100"');

  // Filesystem refusals happen during preparation, before an upload exists.
  const collision = path.join(directory, "collision");
  await writeClaudeDesignFixture(collision);
  await writeFile(path.join(collision, "artifact-server-design.html"), "User catalog");
  await expect(Effect.runPromise(prepareFilePublication(intent(collision)))).rejects.toThrow("already exists");
  expect(await readFile(path.join(collision, "artifact-server-design.html"), "utf8")).toBe("User catalog");
  const oversized = path.join(directory, "oversized");
  await writeClaudeDesignFixture(oversized);
  await writeFile(path.join(oversized, "_ds_manifest.json"), " ".repeat(4 * 1024 * 1024 + 1));
  await expect(Effect.runPromise(prepareFilePublication(intent(oversized)))).rejects.toThrow("4 MiB");
  const linked = path.join(directory, "linked");
  await writeClaudeDesignFixture(linked);
  await symlink(path.join(collision, "styles.css"), path.join(linked, "linked.css"));
  await expect(Effect.runPromise(prepareFilePublication(intent(linked)))).rejects.toThrow("symbolic links");
});
