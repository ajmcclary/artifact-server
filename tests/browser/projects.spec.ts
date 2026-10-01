import {AxeBuilder} from "@axe-core/playwright";
import {expect, test} from "@playwright/test";
import {z} from "zod";

import {apiHeaders} from "../support/runtime-harness.js";
import {publishNew} from "../support/publishing.js";
import {localLogin, startBrowserFixture, stopBrowserFixture, type BrowserFixture} from "./browser-fixture.js";
import {createThreadOverApi} from "./comment-api.js";
import {waitForSettledPaint} from "./review-helpers.js";

async function createProject(fixture: BrowserFixture, name: string, key: string): Promise<string> {
  const response = await fetch(`${fixture.server.baseUrl}/api/v1/projects`, {
    body: JSON.stringify({name}),
    headers: apiHeaders(fixture.installation, key),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return z.object({project: z.object({id: z.string()})}).parse(await response.json()).project.id;
}

async function archiveProject(fixture: BrowserFixture, projectId: string): Promise<void> {
  const response = await fetch(`${fixture.server.baseUrl}/api/v1/projects/${projectId}/archive`, {
    headers: apiHeaders(fixture.installation, `archive-${projectId}`),
    method: "POST",
  });
  expect(response.ok).toBe(true);
}

test.describe("Projects screen", () => {
  test("ACT-006-B: projects list with counts beside their details and activity; the Projects item and legacy URLs open it while folders open artifacts", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const alphaId = await createProject(fixture, "Projects alpha", "projects-alpha");
      const archivedId = await createProject(fixture, "Projects archived", "projects-archived");
      await archiveProject(fixture, archivedId);
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Alpha page</title><h1>Alpha page</h1></html>",
        idempotencyKey: "projects-alpha-artifact",
        mediaType: "text/html; charset=utf-8",
        name: "Alpha page",
        path: "index.html",
        projectId: alphaId,
      });
      await createThreadOverApi(fixture, {
        artifactId: published.body.artifact.id,
        body: "Who owns this page?",
        idempotencyKey: "projects-alpha-thread",
        projectId: alphaId,
        versionId: published.body.version.id,
      });
      // A second project's artifact must never reach Alpha's Activity section.
      await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Default page</title><h1>Default page</h1></html>",
        idempotencyKey: "projects-default-artifact",
        mediaType: "text/html; charset=utf-8",
        name: "Default page",
        path: "index.html",
        projectId: "prj_default",
      });

      await localLogin(fixture);
      const page = fixture.page;

      // Bare /review/projects selects the first active project in place.
      await page.goto(`${fixture.server.baseUrl}/review/projects`);
      await expect(page).toHaveURL(/\/review\/projects\?project=prj_default$/u);
      const list = page.getByRole("complementary", {name: "Project list"});
      await expect(list.getByRole("heading", {name: "Projects"})).toBeVisible();
      const alphaRow = list.getByRole("button", {name: /Projects alpha/u});
      await expect(alphaRow).toContainText("1 unresolved");
      await expect(alphaRow).toContainText(/1 artifact · \d{2}\/\d{2}\/\d{4}/u);
      await expect(list.getByRole("button", {name: /Projects archived/u})).toContainText("Archived");
      await expect(list.getByText("3 projects", {exact: true})).toBeVisible();

      // Selecting a row replaces the URL and shows its details, artifacts and activity.
      await alphaRow.click();
      await expect(page).toHaveURL(new RegExp(`/review/projects\\?project=${alphaId}$`, "u"));
      const details = page.getByRole("region", {name: "Project details"});
      await expect(details.getByRole("heading", {name: "Projects alpha"})).toBeVisible();
      await expect(details.getByRole("region", {name: "Project identity"})).toBeVisible();
      await expect(details.getByRole("region", {name: "Artifacts in this project"}).getByText("Alpha page")).toBeVisible();
      await expect(details.getByRole("region", {name: "Activity"}).getByText("Alpha page").first()).toBeVisible();
      await expect(details.getByRole("region", {name: "Activity"}).getByText("Default page")).toHaveCount(0);
      await expect(details.getByRole("link", {name: "Open latest artifact"}))
        .toHaveAttribute("href", `/review?project=${alphaId}`);
      await waitForSettledPaint(page);
      expect((await new AxeBuilder({page}).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);

      // Search narrows the list; the footer states the fraction.
      await page.getByLabel("Search projects").fill("archived");
      await expect(list.getByText("1 of 3", {exact: true})).toBeVisible();
      await page.getByLabel("Search projects").fill("");

      // A navigation folder opens that project's artifacts, not the Projects screen.
      await page.getByRole("navigation", {name: "Review and projects"})
        .getByRole("link", {exact: true, name: "Projects alpha"}).click();
      await expect(page).toHaveURL(new RegExp(`/review\\?project=${alphaId}&artifact=`, "u"));
      await expect(page.getByRole("list", {name: "Artifacts"}).getByRole("button", {name: /^Alpha page/u})).toBeVisible();
      // The Projects row returns to the Projects screen.
      await page.getByRole("navigation", {name: "Review and projects"})
        .getByRole("link", {exact: true, name: "Projects"}).click();
      await expect(page).toHaveURL(/\/review\/projects\?project=/u);

      // New project opens the created project's details.
      await list.getByRole("button", {name: "New project"}).click();
      const dialog = page.getByRole("dialog", {name: "New project"});
      await dialog.getByRole("textbox").fill("Projects created here");
      await dialog.getByRole("button", {name: "Create project"}).click();
      await expect(page.getByRole("region", {name: "Project details"})
        .getByRole("heading", {name: "Projects created here"})).toBeVisible();
      await expect(page).toHaveURL(/\/review\/projects\?project=prj_/u);

      // Retired URLs replace themselves with the Projects screen.
      await page.goto(`${fixture.server.baseUrl}/review/settings/projects/${alphaId}`);
      await expect(page).toHaveURL(new RegExp(`/review/projects\\?project=${alphaId}$`, "u"));
      await page.goto(`${fixture.server.baseUrl}/projects`);
      await expect(page).toHaveURL(/\/review\/projects\?project=prj_default$/u);

      // On a phone the list is a sheet opened from the page head.
      await page.setViewportSize({height: 800, width: 390});
      await expect(page.getByRole("complementary", {name: "Project list"})).toHaveCount(0);
      await page.getByRole("button", {exact: true, name: "Projects"}).click();
      await page.getByRole("complementary", {name: "Project list"})
        .getByRole("button", {name: /Projects alpha/u}).click();
      await expect(page.getByRole("complementary", {name: "Project list"})).toHaveCount(0);
      await expect(page.getByRole("heading", {name: "Projects alpha"})).toBeVisible();
      await expect.poll(() => page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ACT-006-F: hidden, unknown and uncounted projects fail visibly, and no invented panel appears", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await createProject(fixture, "Visible project", "projects-visible");
      await localLogin(fixture);
      const page = fixture.page;

      await page.goto(`${fixture.server.baseUrl}/review/projects?project=prj_default`);
      const details = page.getByRole("region", {name: "Project details"});
      await expect(details.getByRole("heading", {name: "Default"})).toBeVisible();
      await Promise.all(["Publishing defaults", "Access and membership"].map((invented) =>
        expect(page.getByRole("region", {name: invented})).toHaveCount(0)));
      await expect(page.getByText("Copy all artifact URLs")).toHaveCount(0);

      // A search that hides the selection closes its detail and keeps focus in the list.
      const search = page.getByLabel("Search projects");
      await search.fill("zzz-no-match");
      await expect(details.getByRole("heading", {name: "Default"})).toHaveCount(0);
      await expect(details.getByText("No project selected")).toBeVisible();
      // The list's inline empty state shows the design system's filtered title and Clear Filters.
      await expect(page.getByRole("complementary", {name: "Project list"}).getByText("No projects match these filters")).toBeVisible();
      await expect(search).toBeFocused();
      await search.fill("");
      await expect(details.getByRole("heading", {name: "Default"})).toBeVisible();

      // An unknown project is named as not found instead of showing another one.
      await page.goto(`${fixture.server.baseUrl}/review/projects?project=prj_missing`);
      await expect(details.getByRole("heading", {name: "Project not found"}).first()).toBeVisible();
      await details.getByRole("button", {name: "Open projects"}).click();
      await expect(page).toHaveURL(/\/review\/projects\?project=prj_default$/u);

      // When the summary fails, every project is still listed by name, without counts.
      await page.route("**/api/v1/activity/summary**", (route) => route.fulfill({
        body: JSON.stringify({error: {code: "INTERNAL_ERROR", message: "Summary unavailable."}}),
        contentType: "application/json",
        status: 500,
      }));
      await page.reload();
      const list = page.getByRole("complementary", {name: "Project list"});
      await expect(list.getByRole("button", {name: /Visible project/u})).toBeVisible();
      await expect(list.getByText(/unresolved/u)).toHaveCount(0);
      await expect(details.getByRole("heading", {name: "Default"})).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
