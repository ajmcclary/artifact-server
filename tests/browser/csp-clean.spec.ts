import {expect, test, type Page} from "@playwright/test";

import {publishNew} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";
import {
  collectCspViolations,
  openReview,
  openSettings,
  previewFrame,
  type SettingsSection,
} from "./review-helpers.js";

/**
 * Success criterion 4: the production build raises no Content Security Policy
 * violation on any screen, in any theme mode. Each redesign task that adds or
 * moves a screen extends this walk.
 */
const themeModes = ["system", "default", "dark", "high-contrast"] as const;

const walkFixtureHtml = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
  + "<title>CSP walk</title></head><body><main><h1>CSP walk fixture</h1></main></body></html>";

async function visitSettings(page: Page, section: SettingsSection, heading: string): Promise<void> {
  await openSettings(page, section);
  await expect(page.getByRole("heading", {exact: true, name: heading}).first()).toBeVisible();
}

test.describe("CSP-clean production build", () => {
  for (const mode of themeModes) {
    test(`review workspace and settings raise no CSP violations in the ${mode} theme mode`, async ({browser}) => {
      const fixture = await startBrowserFixture(browser);
      try {
        const published = await publishNew(fixture.server, fixture.installation, {
          accessSetting: "account_required",
          content: walkFixtureHtml,
          idempotencyKey: `csp-walk-fixture-${mode}`,
          mediaType: "text/html; charset=utf-8",
          name: "CSP walk fixture",
          path: "index.html",
        });
        await fixture.context.addInitScript((themeMode) => {
          localStorage.setItem("arkcase.theme.v1", JSON.stringify(themeMode));
        }, mode);
        const readViolations = collectCspViolations(fixture.page);
        expect(await readViolations()).toEqual([]);

        await localLogin(fixture);
        await openReview(fixture, {artifactId: published.body.artifact.id, versionId: published.body.version.id});
        await expect(previewFrame(fixture.page).getByRole("heading", {name: "CSP walk fixture"})).toBeVisible();
        await expect(fixture.page.locator("html")).toHaveAttribute("data-theme-mode", mode);

        await visitSettings(fixture.page, "project", "Project identity");
        await visitSettings(fixture.page, "members", "Members");
        await visitSettings(fixture.page, "api-keys", "API keys");
        await visitSettings(fixture.page, "public-links", "Public links");
        await visitSettings(fixture.page, "mcp", "Connect agents with MCP");
        await fixture.page.goto(`${fixture.server.baseUrl}/review/settings/webmcp`);
        await expect(fixture.page.getByRole("heading", {exact: true, name: "WebMCP"}).first()).toBeVisible();

        expect(await readViolations()).toEqual([]);
      } finally {
        await stopBrowserFixture(fixture);
      }
    });
  }

  test("the collector reports a blocked inline style", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const readViolations = collectCspViolations(fixture.page);
      expect(await readViolations()).toEqual([]);
      await localLogin(fixture);
      await fixture.page.evaluate(() => {
        const style = document.createElement("style");
        style.textContent = "body{outline:1px solid red}";
        document.head.append(style);
      });
      await expect.poll(async () => (await readViolations()).join("\n")).toContain("style-src-elem blocked inline");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
