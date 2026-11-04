import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  reserveLoopbackPort,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  acceptsConnections,
  childProcessIds,
  listTree,
} from "../support/server-activity.js";

const encoder = new TextEncoder();

function file(filePath: string, mediaType: string, content: string): TestSiteFile {
  return {bytes: encoder.encode(content), mediaType, path: filePath};
}

/** Directory names that would only exist if something installed or built code. */
const buildArtifacts = /(?:^|\/)(?:node_modules|__pycache__|site-packages|\.venv|vendor|target|\.next|\.svelte-kit)(?:\/|$)/u;

describe("the server stores and serves finished files without running them", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let markers: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation, {contentVariantBuilds: "manual"});
    markers = await mkdtemp(path.join(tmpdir(), "prd-002-markers-"));
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
    await rm(markers, {force: true, recursive: true});
  });

  async function publishAndServe(files: readonly TestSiteFile[], key: string) {
    const upload = await createStagedUpload(server, installation, "index.html", files);
    await uploadEveryStagedFile(installation, upload.body, files);
    const committed = await commitStagedUpload(installation, upload.body, key, {
      accessSetting: "public_link",
      kind: "new_artifact",
      name: key,
      tags: [],
    });
    expect(committed.response.status).toBe(201);
    const published: PublishResponse = committed.body;
    // Run every piece of background work a publish can queue.
    const variants = await server.buildContentVariants(1_000);
    const served = await Promise.all(files.map(async (entry) => {
      const response = await fetchVersion(
        server,
        new URL(encodeURI(entry.path), published.links.version).toString(),
      );
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        path: entry.path,
        status: response.status,
      };
    }));
    return {served, variants};
  }

  test("PRD-002-B SCP-001-B: finished browser files are served byte for byte with no artifact runtime in the process list or on the network", async () => {
    const childrenBefore = await childProcessIds();
    const files = [
      file("index.html", "text/html; charset=utf-8", "<!doctype html><script src=\"app.js\"></script><link rel=\"stylesheet\" href=\"style.css\">"),
      file("app.js", "text/javascript", "document.body.dataset.ready = 'yes';"),
      file("style.css", "text/css", "body { color: #123; }"),
      file("data/records.json", "application/json", "{\"records\":[1,2,3]}"),
      file("about/index.html", "text/html; charset=utf-8", "<!doctype html><title>About</title>"),
    ];
    const {served} = await publishAndServe(files, "prd-002-finished-site");
    expect(served).toEqual(files.map((entry) => ({
      bytes: new Uint8Array(entry.bytes),
      path: entry.path,
      status: 200,
    })));
    expect(await childProcessIds()).toEqual(childrenBefore);
    expect((await listTree(installation.dataDirectory)).filter((entry) => buildArtifacts.test(entry)))
      .toEqual([]);
  });

  test("PRD-002-F SCP-001-F: build manifests, package files, server entry points, and backend dependencies are stored as bytes and never installed, compiled, executed, or provisioned", async () => {
    const childrenBefore = await childProcessIds();
    const runtimePort = await reserveLoopbackPort();
    const dataBefore = await listTree(installation.dataDirectory);
    // Each program writes a marker file (and the server entry also listens)
    // if anything ever runs it.
    const marker = (name: string) => JSON.stringify(path.join(markers, name));
    const nodeMarker = (name: string) =>
      `node -e "require('fs').writeFileSync(${marker(name).replaceAll("\"", "\\\"")}, 'ran')"`;
    const files = [
      file("index.html", "text/html; charset=utf-8", "<!doctype html><title>Source tree</title>"),
      file("package.json", "application/json", JSON.stringify({
        dependencies: {"left-pad": "1.3.0"},
        name: "runtime-source",
        scripts: {
          build: nodeMarker("npm-build"),
          postinstall: nodeMarker("npm-postinstall"),
          preinstall: nodeMarker("npm-preinstall"),
          start: "node server.js",
        },
      })),
      file("server.js", "text/javascript", [
        "require('node:fs').writeFileSync(" + marker("node-server") + ", 'ran');",
        `require('node:http').createServer((q, s) => s.end('dynamic')).listen(${runtimePort});`,
      ].join("\n")),
      file("api/handler.js", "text/javascript", "export default () => { require('node:fs').writeFileSync(" + marker("server-function") + ", 'ran'); };"),
      file("vite.config.js", "text/javascript", "require('node:fs').writeFileSync(" + marker("vite-build") + ", 'ran');"),
      file("app.py", "text/x-python", "open(" + marker("python-app") + ", 'w').write('ran')"),
      file("requirements.txt", "text/plain", "flask==3.0.0\n"),
      file("setup.py", "text/x-python", "open(" + marker("python-setup") + ", 'w').write('ran')"),
      file("Makefile", "text/plain", "build:\n\ttouch " + path.join(markers, "make-build") + "\n"),
      file("Dockerfile", "text/plain", "FROM node:24\nRUN touch " + path.join(markers, "docker-build") + "\n"),
      file("db/schema.sql", "application/sql", "CREATE TABLE provisioned (id integer);\n"),
      file("prisma/schema.prisma", "text/plain", "datasource db { provider = \"postgresql\" url = env(\"DATABASE_URL\") }\n"),
    ];
    const {served, variants} = await publishAndServe(files, "prd-002-runtime-source");

    // Every file is delivered as the exact bytes that were published.
    expect(served).toEqual(files.map((entry) => ({
      bytes: new Uint8Array(entry.bytes),
      path: entry.path,
      status: 200,
    })));
    expect(variants.failed).toBe(0);
    // Nothing ran: no marker, no child process, no listener on the port the
    // server entry would bind, and no installed, built, or provisioned
    // state in the installation's data directory.
    expect(await listTree(markers)).toEqual([]);
    expect(await childProcessIds()).toEqual(childrenBefore);
    expect(await acceptsConnections("127.0.0.1", runtimePort)).toBe(false);
    const created = (await listTree(installation.dataDirectory))
      .filter((entry) => !dataBefore.includes(entry));
    expect(created.filter((entry) =>
      buildArtifacts.test(entry) || /\.(?:sql|prisma|py|db)$|provisioned/u.test(entry)
    )).toEqual([]);
  });
});
