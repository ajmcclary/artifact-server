import {createServer, type IncomingHttpHeaders, type Server} from "node:http";

import {expect, test} from "@playwright/test";
import {z} from "zod";

import {
  commitStagedUpload,
  createStagedUpload,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {fetchVersion} from "../support/runtime-harness.js";
import {
  startBrowserFixture,
  stopBrowserFixture,
  type BrowserFixture,
} from "./browser-fixture.js";

interface ExternalRequest {
  readonly origin: string | undefined;
  readonly path: string;
  readonly userAgent: string | undefined;
}

interface ExternalOrigin {
  readonly origin: string;
  readonly requests: readonly ExternalRequest[];
  close(): Promise<void>;
}

const libraryBytes = "window.externalLibrary = 'loaded from its own origin';\n";
const blockedBytes = "{\"secret\":\"readable only by its own origin\"}";

/** A separate origin: a permitted script and a JSON document without CORS. */
async function startExternalOrigin(): Promise<ExternalOrigin> {
  const requests: ExternalRequest[] = [];
  const record = (path: string, headers: IncomingHttpHeaders) => {
    requests.push({origin: headers.origin, path, userAgent: headers["user-agent"]});
  };
  const server: Server = createServer((request, response) => {
    const path = request.url ?? "/";
    record(path, request.headers);
    if (path === "/library.js") {
      response.writeHead(200, {"Content-Type": "text/javascript"});
      response.end(libraryBytes);
      return;
    }
    if (path === "/blocked.json") {
      // No Access-Control-Allow-Origin: other origins may not read it.
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(blockedBytes);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = z.object({port: z.number()}).parse(server.address()).port;
  return {
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
    }),
    origin: `http://127.0.0.1:${port}`,
    requests,
  };
}

function page(externalOrigin: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>External dependencies</title>
<script src="${externalOrigin}/library.js"></script></head>
<body><p id="state">pending</p><script>
fetch(${JSON.stringify(`${externalOrigin}/blocked.json`)})
  .then((response) => response.text())
  .then((text) => { document.getElementById("state").textContent = "read:" + text; })
  .catch(() => { document.getElementById("state").textContent = "blocked"; });
</script></body></html>`;
}

async function publishPage(fixture: BrowserFixture, html: string) {
  const files: readonly TestSiteFile[] = [
    {bytes: new TextEncoder().encode(html), mediaType: "text/html; charset=utf-8", path: "index.html"},
  ];
  const upload = await createStagedUpload(fixture.server, fixture.installation, "index.html", files);
  await uploadEveryStagedFile(fixture.installation, upload.body, files);
  const committed = await commitStagedUpload(fixture.installation, upload.body, "cnt-009-external-page", {
    accessSetting: "public_link",
    kind: "new_artifact",
    name: "External dependencies",
  });
  expect(committed.response.status).toBe(201);
  return committed.body;
}

test.describe("external dependencies load under normal browser rules", () => {
  let external: ExternalOrigin;
  let fixture: BrowserFixture;

  test.beforeEach(async ({browser}) => {
    external = await startExternalOrigin();
    fixture = await startBrowserFixture(browser);
  });

  test.afterEach(async () => {
    await stopBrowserFixture(fixture);
    await external.close();
  });

  test("CNT-009-B: a permitted external script loads from its own origin with its URL and bytes unchanged", async () => {
    const html = page(external.origin);
    const published = await publishPage(fixture, html);
    const contentOrigin = new URL(published.links.version).origin;

    // Artifact Server serves the page exactly as published: the external URL
    // is not rewritten to a copy or a proxy.
    const served = await fetchVersion(fixture.server, published.links.version);
    expect(await served.text()).toBe(html);

    await fixture.page.goto(published.links.version);
    // The library's own bytes ran in the page under their own URL.
    await expect.poll(() => fixture.page.evaluate("window.externalLibrary"))
      .toBe("loaded from its own origin");
    // The browser fetched the script straight from its origin.
    expect(external.requests.filter((request) => request.path === "/library.js")).toEqual([
      {origin: undefined, path: "/library.js", userAgent: expect.stringContaining("Chrome")},
    ]);
    const scriptUrl = await fixture.page.evaluate(() => document.scripts[0]?.src);
    expect(scriptUrl).toBe(`${external.origin}/library.js`);
    expect(new URL(scriptUrl ?? "").origin).not.toBe(contentOrigin);
  });

  test("CNT-009-F: a blocked external dependency stays blocked and is never proxied or copied by Artifact Server", async () => {
    const published = await publishPage(fixture, page(external.origin));
    const contentOrigin = new URL(published.links.version).origin;
    await fixture.page.goto(published.links.version);

    // The browser's cross-origin rules block the read; the artifact sees no bytes.
    await expect(fixture.page.locator("#state")).toHaveText("blocked");
    // Only the browser contacted the external origin, presenting the
    // artifact's own origin; Artifact Server made no request of its own.
    const blockedRequests = external.requests.filter((request) => request.path === "/blocked.json");
    expect(blockedRequests).toEqual([
      {origin: contentOrigin, path: "/blocked.json", userAgent: expect.stringContaining("Chrome")},
    ]);
    expect(external.requests.every((request) => request.userAgent?.includes("Chrome") === true))
      .toBe(true);

    // The version holds only the published page, and no content-host path
    // relays or serves the external document.
    const relayAttempts = await Promise.all([
      `/${external.origin}/blocked.json`,
      `/${encodeURIComponent(`${external.origin}/blocked.json`)}`,
      "/blocked.json",
    ].map(async (relayPath) => {
      const response = await fetchVersion(
        fixture.server,
        new URL(relayPath, published.links.version).toString(),
      );
      return [relayPath, response.status, (await response.text()).includes("secret")] as const;
    }));
    expect(relayAttempts.map(([, status, leaked]) => [status, leaked]))
      .toEqual(relayAttempts.map(() => [404, false]));
    expect(external.requests.filter((request) => request.path === "/blocked.json")).toHaveLength(1);
  });
});
