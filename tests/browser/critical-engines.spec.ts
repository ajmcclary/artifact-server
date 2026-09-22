import {expect, test} from "@playwright/test";

import {publishNew, publishVersion} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";
import {
  createThreadOverApi,
  deleteThreadOverApi,
} from "./comment-api.js";

/**
 * The critical cross-engine slice: the security-sensitive review paths that
 * the Firefox/WebKit matrix projects run. Kept compact on purpose — the full
 * Chromium suite owns the cosmetic coverage. Tag: @critical.
 */
test.describe("critical engine review paths @critical", () => {
  test("CMT-016-B CMT-016-F: an exact Review URL renders the pinned version @critical", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const target = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Critical exact</title><main><h1>Critical historical target</h1></main></html>",
        idempotencyKey: "critical-exact-target-v1",
        name: "Critical exact target",
      });
      await publishVersion(fixture.server, fixture.installation, {
        artifactId: target.body.artifact.id,
        content: "<!doctype html><html lang=\"en\"><title>Critical exact latest</title><main><h1>Critical replacement content</h1></main></html>",
        expectedCurrentVersionId: target.body.version.id,
        idempotencyKey: "critical-exact-target-v2",
      });

      await localLogin(fixture);
      await fixture.page.goto(target.body.links.review);

      const reviewFrame = fixture.page.frameLocator(".as-artifact-frame");
      const preview = reviewFrame.frameLocator("iframe");
      await expect(preview.getByRole("heading", {name: "Critical historical target"}))
        .toBeVisible();
      await expect(preview.getByRole("heading", {name: "Critical replacement content"}))
        .toHaveCount(0);
      expect(new URL(fixture.page.url()).searchParams.get("version"))
        .toBe(target.body.version.id);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-014-B CMT-014-F: hostile artifact HTML stays inside an opaque-origin sandbox @critical", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Critical sandbox probe</title></head><body><p id=\"critical-probe-parent\">parent:pending</p><script>(function () { try { window.parent.document.title; document.getElementById(\"critical-probe-parent\").textContent = \"parent:reached\"; } catch (error) { document.getElementById(\"critical-probe-parent\").textContent = \"parent:blocked\"; } })();</script></body></html>",
        idempotencyKey: "critical-sandbox-isolation",
        mediaType: "text/html; charset=utf-8",
        name: "Critical sandbox probe",
        path: "index.html",
      });
      await localLogin(fixture);
      await fixture.page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${published.body.artifact.id}&version=${published.body.version.id}`,
      );

      const reviewFrame = fixture.page.frameLocator(".as-artifact-frame");
      const sandboxElement = reviewFrame.locator("iframe");
      await expect(sandboxElement).toHaveAttribute("sandbox", "allow-scripts");
      await expect(sandboxElement).not.toHaveAttribute("sandbox", /allow-same-origin/u);

      const artifactFrame = reviewFrame.frameLocator("iframe");
      expect(await artifactFrame.locator("body").evaluate(() => window.origin))
        .toBe("null");
      await expect(artifactFrame.locator("#critical-probe-parent")).toHaveText("parent:blocked");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-018-B CMT-018-F: private historical HTML renders after the current pointer moves on @critical", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const historical = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Critical historical</title><main><h1>Private historical asset</h1></main></html>",
        idempotencyKey: "critical-historical-asset-v1",
        name: "Critical historical asset",
      });
      await publishVersion(fixture.server, fixture.installation, {
        artifactId: historical.body.artifact.id,
        content: "<!doctype html><html lang=\"en\"><title>Critical replacement</title><main><h1>Current replacement</h1></main></html>",
        expectedCurrentVersionId: historical.body.version.id,
        idempotencyKey: "critical-historical-asset-v2",
      });

      await localLogin(fixture);
      await fixture.page.goto(historical.body.links.review);
      const reviewFrame = fixture.page.frameLocator(".as-artifact-frame");
      const preview = reviewFrame.frameLocator("iframe");
      await expect(preview.getByRole("heading", {name: "Private historical asset"}))
        .toBeVisible();
      expect(new URL(fixture.page.url()).searchParams.get("version"))
        .toBe(historical.body.version.id);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-023-B CMT-023-F: two open reviewers converge on thread create and delete @critical", async ({browser}) => {
    test.setTimeout(120_000);
    const fixture = await startBrowserFixture(browser);
    const secondContext = await browser.newContext();
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><h1>Critical convergence fixture</h1></html>",
        idempotencyKey: "critical-convergence-fixture",
        name: "Critical convergence fixture",
      });
      const pageB = await secondContext.newPage();

      await localLogin(fixture);
      await pageB.goto(fixture.server.baseUrl);
      await expect(pageB.getByRole("link", {name: "Artifact Server"})).toBeVisible();

      const target = `${fixture.server.baseUrl}/review?${new URLSearchParams({
        artifact: published.body.artifact.id,
        project: "prj_default",
        version: published.body.version.id,
      })}`;
      await fixture.page.goto(target);
      await pageB.goto(target);
      await fixture.page.getByRole("tab", {name: /Comments/u}).click();
      await pageB.getByRole("tab", {name: /Comments/u}).click();

      const cardA = fixture.page.getByRole("article")
        .filter({hasText: "Critical convergence"});
      const cardB = pageB.getByRole("article")
        .filter({hasText: "Critical convergence"});

      const thread = await createThreadOverApi(fixture, {
        artifactId: published.body.artifact.id,
        body: "Critical convergence",
        idempotencyKey: "critical-convergence-thread",
        versionId: published.body.version.id,
      });
      await expect(cardA, "first reviewer sees the new thread").toBeVisible({timeout: 25_000});
      await expect(cardB, "second reviewer sees the new thread").toBeVisible({timeout: 25_000});

      await deleteThreadOverApi(fixture, {
        artifactId: published.body.artifact.id,
        idempotencyKey: "critical-convergence-delete",
        threadId: thread.id,
      });
      await expect(cardA, "first reviewer loses the deleted thread")
        .toHaveCount(0, {timeout: 25_000});
      await expect(cardB, "second reviewer loses the deleted thread")
        .toHaveCount(0, {timeout: 25_000});
    } finally {
      await secondContext.close();
      await stopBrowserFixture(fixture);
    }
  });
});
