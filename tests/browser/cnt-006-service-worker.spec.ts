import {expect, test, type Page} from "@playwright/test";

import {
  commitStagedUpload,
  createStagedUpload,
  uploadEveryStagedFile,
  type TestSiteFile,
} from "../support/publishing.js";
import {
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";

const siteFiles = (serviceWorkerBytes: string): readonly TestSiteFile[] => [
  {
    bytes: new TextEncoder().encode(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Service worker fixture</title></head><body><p id="sw-state">pending</p></body></html>',
    ),
    mediaType: "text/html; charset=utf-8",
    path: "index.html",
  },
  {
    bytes: new TextEncoder().encode(serviceWorkerBytes),
    mediaType: "text/javascript; charset=utf-8",
    path: "sw.js",
  },
];

test.describe("service worker scope is bounded to one version origin", () => {
  test("CNT-006-B: a service worker installed by one version controls only its own origin", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishSite(fixture, "cnt-006-first-version");
      const firstOrigin = new URL(published.body.links.version).origin;

      await fixture.page.goto(
        new URL("index.html", published.body.links.version).toString(),
      );
      await fixture.page.locator("#sw-state").waitFor();
      const firstWorker = fixture.context.waitForEvent("serviceworker");
      await fixture.page.evaluate(() => {
        void navigator.serviceWorker.register("/sw.js");
      });
      const worker = await firstWorker;
      expect(new URL(worker.url()).origin).toBe(firstOrigin);
      expect(new URL(worker.url()).pathname).toBe("/sw.js");

      // A second version owns a distinct origin, so the first version's
      // registration cannot control it.
      const second = await publishVersion(
        fixture,
        published,
        "cnt-006-second-version",
      );
      const secondOrigin = new URL(second.body.links.version).origin;
      expect(secondOrigin).not.toBe(firstOrigin);
      await fixture.page.goto(
        new URL("index.html", second.body.links.version).toString(),
      );
      const registrations = await fixture.page.evaluate(async () => {
        const controller = await navigator.serviceWorker.getRegistration();
        return controller === undefined
          ? null
          : {scope: controller.scope, active: controller.active?.state};
      });
      expect(registrations).toBeNull();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CNT-006-F: registration for the application or another version origin gains no control", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishSite(fixture, "cnt-006-cross-origin");
      const appOrigin = new URL(fixture.server.baseUrl).origin;
      const second = await publishVersion(
        fixture,
        published,
        "cnt-006-cross-origin-second",
      );
      const secondOrigin = new URL(second.body.links.version).origin;

      await fixture.page.goto(
        new URL("index.html", published.body.links.version).toString(),
      );
      const application = await attemptCrossOriginRegistration(
        fixture.page,
        `${appOrigin}/sw.js`,
      );
      const otherVersion = await attemptCrossOriginRegistration(
        fixture.page,
        `${secondOrigin}/sw.js`,
      );
      expect(application).toBe("rejected");
      expect(otherVersion).toBe("rejected");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});

async function attemptCrossOriginRegistration(
  page: Page,
  url: string,
): Promise<string> {
  return page.evaluate(async (targetUrl) => {
    try {
      await navigator.serviceWorker.register(targetUrl);
      return "registered";
    } catch (error) {
      return error instanceof Error && error.name === "SecurityError"
        ? "rejected"
        : "unexpected";
    }
  }, url);
}

async function publishSite(
  fixture: Awaited<ReturnType<typeof startBrowserFixture>>,
  idempotencyKey: string,
): Promise<{readonly body: Awaited<ReturnType<typeof commitStagedUpload>>["body"]}> {
  const files = siteFiles("self.addEventListener('install', () => self.skipWaiting());");
  const planned = await createStagedUpload(
    fixture.server,
    fixture.installation,
    "index.html",
    files,
  );
  await Promise.all((await uploadEveryStagedFile(
    fixture.installation,
    planned.body,
    files,
  )).map((response) => response.arrayBuffer()));
  const published = await commitStagedUpload(
    fixture.installation,
    planned.body,
    idempotencyKey,
    {
      accessSetting: "public_link",
      kind: "new_artifact",
      name: "Service worker fixture",
    },
  );
  return {body: published.body};
}

async function publishVersion(
  fixture: Awaited<ReturnType<typeof startBrowserFixture>>,
  previous: {readonly body: {readonly artifact: {readonly id: string}; readonly version: {readonly id: string}}},
  idempotencyKey: string,
): Promise<{readonly body: Awaited<ReturnType<typeof commitStagedUpload>>["body"]}> {
  const files = siteFiles("self.addEventListener('install', () => self.skipWaiting());");
  const planned = await createStagedUpload(
    fixture.server,
    fixture.installation,
    "index.html",
    files,
  );
  await Promise.all((await uploadEveryStagedFile(
    fixture.installation,
    planned.body,
    files,
  )).map((response) => response.arrayBuffer()));
  const published = await commitStagedUpload(
    fixture.installation,
    planned.body,
    idempotencyKey,
    {
      artifactId: previous.body.artifact.id,
      expectedCurrentVersionId: previous.body.version.id,
      kind: "new_version",
    },
  );
  return {body: published.body};
}
