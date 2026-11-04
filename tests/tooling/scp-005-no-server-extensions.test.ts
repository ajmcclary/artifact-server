import {glob, mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {describe, expect, test} from "vitest";

import {
  commitStagedUpload,
  createStagedUpload,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
} from "../support/runtime-harness.js";
import {listTree} from "../support/server-activity.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const encoder = new TextEncoder();

/** Every way server code could load or evaluate code it did not ship with. */
const dynamicLoaders: ReadonlyArray<readonly [string, RegExp]> = [
  ["dynamic import", /\bimport\s*\(/u],
  ["CommonJS require", /\brequire\s*\(/u],
  ["createRequire", /\bcreateRequire\b/u],
  ["native addon", /\b(?:process\.)?dlopen\b/u],
  ["eval", /\beval\s*\(/u],
  ["Function constructor", /\bnew\s+Function\s*\(/u],
  ["vm module", /["'](?:node:)?vm["']/u],
  ["module loader hooks", /["']node:module["']/u],
  ["worker evaluation", /["'](?:node:)?worker_threads["']/u],
];

function loaderViolations(file: string, source: string): readonly string[] {
  return dynamicLoaders
    .filter(([, pattern]) => pattern.test(source))
    .map(([name]) => `${file}: ${name}`);
}

describe("the server runs no add-ons or third-party programs", () => {
  test("SCP-005-F: neither configuration nor uploaded content can load server plugins, native modules, hooks, or executable extensions", async () => {
    // No server source can load or evaluate code chosen at run time.
    const violations: string[] = [];
    for await (const relativePath of glob("src/**/*.ts", {cwd: repositoryRoot})) {
      // eslint-disable-next-line no-await-in-loop -- a bounded source scan
      const source = await readFile(path.join(repositoryRoot, relativePath), "utf8");
      violations.push(...loaderViolations(relativePath.split(path.sep).join("/"), source));
    }
    expect(violations).toEqual([]);
    expect([
      ...loaderViolations("plugin-loader.ts", "const plugin = await import(configuredPath);"),
      ...loaderViolations("addon.ts", "process.dlopen(module, file);"),
      ...loaderViolations("hooks.ts", 'import {register} from "node:module";'),
      ...loaderViolations("sandbox.ts", 'import vm from "node:vm";'),
      ...loaderViolations("legacy.ts", "const extension = require(name);"),
      ...loaderViolations("template.ts", "const render = new Function('data', body);"),
    ]).toEqual([
      "plugin-loader.ts: dynamic import",
      "addon.ts: native addon",
      "hooks.ts: module loader hooks",
      "sandbox.ts: vm module",
      "legacy.ts: CommonJS require",
      "template.ts: Function constructor",
    ]);

    // Uploaded plugin code, a native addon, and a plugin declaration are
    // stored and served as bytes; none is loaded.
    const markers = await mkdtemp(path.join(tmpdir(), "scp-005-markers-"));
    const installation = await createTestInstallation();
    const server = await startTestServer(installation, {contentVariantBuilds: "manual"});
    try {
      const marker = JSON.stringify(path.join(markers, "plugin-loaded"));
      const files: readonly TestSiteFile[] = [
        {bytes: encoder.encode("<!doctype html><title>Extensions</title>"), mediaType: "text/html", path: "index.html"},
        {
          bytes: encoder.encode(`import {writeFileSync} from "node:fs"; writeFileSync(${marker}, "loaded");`),
          mediaType: "text/javascript",
          path: "plugins/server-plugin.mjs",
        },
        {bytes: Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]), mediaType: "application/octet-stream", path: "native/addon.node"},
        {
          bytes: encoder.encode(JSON.stringify({hooks: ["plugins/server-plugin.mjs"], plugins: ["./native/addon.node"]})),
          mediaType: "application/json",
          path: "artifactserver.plugins.json",
        },
      ];
      const upload = await createStagedUpload(server, installation, "index.html", files);
      await uploadEveryStagedFile(installation, upload.body, files);
      const committed = await commitStagedUpload(installation, upload.body, "scp-005-uploaded-extensions", {
        accessSetting: "public_link",
        kind: "new_artifact",
        name: "Extensions",
      });
      expect(committed.response.status).toBe(201);
      await server.buildContentVariants(1_000);
      const served = await Promise.all(files.map(async (file) => {
        const response = await fetchVersion(
          server,
          new URL(file.path, committed.body.links.version).toString(),
        );
        return [file.path, new Uint8Array(await response.arrayBuffer())] as const;
      }));
      expect(served).toEqual(files.map((file) => [file.path, file.bytes]));
      expect(await listTree(markers)).toEqual([]);
    } finally {
      await server.stop();
      await removeTestInstallation(installation);
      await rm(markers, {force: true, recursive: true});
    }
  });
});
