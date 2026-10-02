import {AxeBuilder} from "@axe-core/playwright";
import {expect, test, type Page} from "@playwright/test";

import {ApiClient} from "../support/agent-dispatch.js";
import {publishNew, publishVersion} from "../support/publishing.js";
import {localLogin, startBrowserFixture, stopBrowserFixture} from "./browser-fixture.js";
import {createThreadOverApi} from "./comment-api.js";
import {openComparison, openInspectorTab, openReview, openSettings, waitForSettledPaint} from "./review-helpers.js";

const auditedModes = [
  {label: "Light", mode: "default"},
  {label: "High contrast", mode: "high-contrast"},
] as const;

async function wcagViolations(page: Page): Promise<readonly string[]> {
  // Contrast is sampled from painted pixels; a mid-transition frame is not the screen.
  await waitForSettledPaint(page);
  // The isolated review frame renders the artifact's own document on an opaque
  // origin; its markup belongs to the artifact author, not to this application.
  const result = await new AxeBuilder({page})
    .exclude("iframe")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  return result.violations.map((violation) =>
    `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(" | ")}`
  );
}

for (const {label, mode} of auditedModes) {
  test(`every screen has no WCAG 2 A or AA violation in ${label}`, async ({browser}) => {
    test.setTimeout(240_000);
    const fixture = await startBrowserFixture(browser);
    const page = fixture.page;
    const found = new Map<string, readonly string[]>();
    const audit = async (screen: string): Promise<void> => {
      found.set(screen, await wcagViolations(page));
    };
    try {
      await fixture.context.addInitScript((themeMode) => {
        window.localStorage.setItem("arkcase.theme.v1", JSON.stringify(themeMode));
      }, mode);
      await localLogin(fixture);
      await expect(page.locator("html")).toHaveAttribute("data-theme-mode", mode);

      // An administrator's first-run feed holds the bootstrap admission; a filter that matches nothing shows the empty state.
      await page.goto(`${fixture.server.baseUrl}/review`);
      await expect(page.getByText(/admitted Local administrator/u)).toBeVisible();
      await audit("first-run activity");
      await page.goto(`${fixture.server.baseUrl}/review?type=comments`);
      await expect(page.getByText("Nothing matches these filters")).toBeVisible();
      await audit("empty activity");

      const first = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Accessibility fixture</title><h1>Accessibility fixture</h1><p>Version one</p></html>",
        idempotencyKey: `a11y-first-${mode}`,
        mediaType: "text/html; charset=utf-8",
        name: "Accessibility fixture",
        path: "index.html",
      })).body;
      const second = (await publishVersion(fixture.server, fixture.installation, {
        artifactId: first.artifact.id,
        content: "<!doctype html><html lang=\"en\"><title>Accessibility fixture</title><h1>Accessibility fixture</h1><p>Version two</p></html>",
        expectedCurrentVersionId: first.version.id,
        idempotencyKey: `a11y-second-${mode}`,
      })).body;
      await createThreadOverApi(fixture, {
        artifactId: first.artifact.id,
        body: "Name the release owner.",
        idempotencyKey: `a11y-thread-${mode}`,
        path: "index.html",
        versionId: second.version.id,
      });

      await page.goto(`${fixture.server.baseUrl}/review`);
      await expect(page.getByLabel("Conversations on Accessibility fixture")).toBeVisible();
      await audit("activity");
      await page.getByRole("button", {name: "Publish artifact"}).click();
      await expect(page.getByRole("dialog", {name: "Publish artifact"})).toBeVisible();
      await audit("publish artifact popover");
      await page.keyboard.press("Escape");

      await page.keyboard.press("ControlOrMeta+k");
      await page.getByRole("combobox", {name: "Search"}).fill("Accessibility");
      await expect(page.getByRole("option", {name: /Accessibility fixture/u})).toBeVisible();
      await audit("command palette");
      await page.keyboard.press("Escape");

      await page.getByRole("button", {name: /^Account menu/u}).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await audit("account menu");
      await page.keyboard.press("Escape");

      await page.goto(`${fixture.server.baseUrl}/review/projects`);
      await page.getByRole("button", {name: "New project"}).click();
      await expect(page.getByRole("dialog", {name: /project/iu})).toBeVisible();
      await audit("create project dialog");
      await page.keyboard.press("Escape");

      await openReview(fixture, {artifactId: first.artifact.id, versionId: second.version.id});
      await audit("artifact review");
      await openInspectorTab(page, "Comments");
      await audit("inspector comments");
      await openInspectorTab(page, "Details");
      await audit("inspector details");
      await openInspectorTab(page, "Files");
      await audit("inspector files");
      await openInspectorTab(page, "Versions");
      await audit("inspector versions");
      await openComparison(page, "Compare");
      await audit("version comparison");
      await openComparison(page, "Activity");
      await audit("activity history");

      await openReview(fixture, {artifactId: first.artifact.id, versionId: second.version.id});
      await page.getByRole("button", {exact: true, name: "Share this version"}).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await audit("share popover");
      await page.keyboard.press("Escape");

      await openReview(fixture, {artifactId: first.artifact.id, focus: true, versionId: second.version.id});
      await expect(page.getByRole("button", {name: "Exit full screen"})).toBeVisible();
      await audit("focus mode");

      const emptyProjectId = await new ApiClient(fixture.server, fixture.installation.apiToken)
        .createProject("Accessibility empty project", `a11y-empty-${mode}`);
      await openReview(fixture, {projectId: emptyProjectId});
      await audit("empty project");

      await openSettings(page, "project");
      await audit("project settings");
      await openSettings(page, "members");
      await audit("members");
      await openSettings(page, "api-keys");
      await audit("API keys");
      await openSettings(page, "public-links");
      await audit("public links");
      await openSettings(page, "mcp");
      await audit("MCP and WebMCP");

      await page.route("**/api/v1/projects", async (route) => {
        await route.fulfill({
          body: JSON.stringify({error: {code: "INTERNAL_ERROR", message: "Project storage is unavailable."}}),
          contentType: "application/json",
          status: 500,
        });
      });
      await page.goto(`${fixture.server.baseUrl}/review`);
      await expect(page.getByRole("heading", {name: "Artifact Server unavailable"})).toBeVisible();
      await audit("unavailable gate");
      await page.unroute("**/api/v1/projects");

      await fixture.context.clearCookies();
      await page.route("**/auth/context", async (route) => {
        await route.fulfill({
          body: JSON.stringify({accessMode: "private_team", login: {kind: "oidc"}}),
          contentType: "application/json",
          status: 200,
        });
      });
      await page.goto(`${fixture.server.baseUrl}/review`);
      await expect(page.getByRole("heading", {name: "Sign in required"})).toBeVisible();
      await audit("sign-in gate");

      expect(Object.fromEntries(found)).toEqual(
        Object.fromEntries([...found.keys()].map((screen) => [screen, []])),
      );
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
}
