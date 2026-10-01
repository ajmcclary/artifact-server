import {expect, test, type Page} from "@playwright/test";

import {ApiClient} from "../support/agent-dispatch.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  type BrowserFixture,
} from "./browser-fixture.js";
import {openComparison} from "./review-helpers.js";

async function publishNavigationFixture(
  fixture: BrowserFixture,
  name: string,
  idempotencyKey: string,
  projectId = "prj_default",
): Promise<PublishResponse> {
  return (await publishNew(fixture.server, fixture.installation, {
    accessSetting: "account_required",
    content: `<!doctype html><html lang="en"><head><title>${name}</title></head><body><h1>${name}</h1></body></html>`,
    // The API requires idempotency keys of at least 16 characters.
    idempotencyKey: `shell-navigation-spec-${idempotencyKey}`,
    mediaType: "text/html; charset=utf-8",
    name,
    path: "index.html",
    projectId,
  })).body;
}

/**
 * Marks the current document and records whether the bootstrap gate ever
 * paints again. A document load clears the mark, so a surviving mark proves
 * every step since was an in-place route change.
 */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    const marks = document.documentElement.dataset;
    marks["navigationProbe"] = "same-document";
    marks["gateSeen"] = "no";
    new MutationObserver(() => {
      if (document.body.textContent.includes("Loading Artifact Server")) marks["gateSeen"] = "yes";
    }).observe(document.body, {childList: true, subtree: true});
  });
}

async function expectSameDocument(page: Page): Promise<void> {
  expect(await page.evaluate(() => ({
    gateSeen: document.documentElement.dataset["gateSeen"] ?? null,
    probe: document.documentElement.dataset["navigationProbe"] ?? null,
  }))).toEqual({gateSeen: "no", probe: "same-document"});
}

function artifactTitle(page: Page) {
  return page.getByRole("toolbar", {exact: true, name: "Artifact"}).getByRole("heading", {level: 1});
}

test.describe("Shell navigation", () => {
  test("NAV-001-B: left navigation, the account menu, the brand and history change screens without a document load", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await publishNavigationFixture(fixture, "Navigation home fixture", "navigation-home");
      const owner = new ApiClient(fixture.server, fixture.installation.apiToken);
      const secondProjectId = await owner.createProject("Navigation second project", "navigation-second-project");
      await publishNavigationFixture(fixture, "Navigation away fixture", "navigation-away", secondProjectId);
      await localLogin(fixture);
      const page = fixture.page;
      const nav = page.getByRole("navigation", {name: "Review and projects"});
      // Quick Search sits under the lock-up when the menu is pinned open; the rail keeps its icon.
      await page.getByRole("button", {name: "Pin the menu"}).click();
      const quickSearch = page.getByRole("button", {name: "Search everything"}).filter({hasText: "Quick Search"});
      await expect(quickSearch).toBeVisible();
      await expect(quickSearch).toHaveAttribute("aria-keyshortcuts", "Meta+K Control+K /");
      await quickSearch.click();
      await expect(page.getByRole("combobox", {name: "Search"})).toBeVisible();
      await page.keyboard.press("Escape");
      await page.getByRole("button", {name: "Unpin the menu"}).click();
      await expect(artifactTitle(page)).toHaveText("Navigation home fixture");
      await markDocument(page);

      // A project folder opens that project on the Projects screen.
      await nav.getByRole("link", {name: "Navigation second project"}).click();
      await expect(page).toHaveURL(new RegExp(`/review/projects\\?project=${secondProjectId}$`, "u"));
      await expect(page.getByRole("main").getByRole("heading", {name: "Navigation second project"})).toBeVisible();
      await expectSameDocument(page);

      await nav.getByRole("link", {name: "Design library"}).click();
      await expect(page).toHaveURL(new RegExp(`/review/library\\?project=${secondProjectId}`, "u"));
      await expectSameDocument(page);

      // A modified click still opens the screen in a new tab and leaves this one in place.
      const libraryUrl = page.url();
      const [opened] = await Promise.all([
        fixture.context.waitForEvent("page"),
        nav.getByRole("link", {exact: true, name: "Activity"}).click({modifiers: ["ControlOrMeta"]}),
      ]);
      await opened.waitForLoadState();
      expect(new URL(opened.url()).pathname).toBe("/review");
      await opened.close();
      expect(page.url()).toBe(libraryUrl);
      await expectSameDocument(page);

      await nav.getByRole("link", {exact: true, name: "Activity"}).click();
      await expect(page.getByRole("heading", {exact: true, level: 1, name: "Activity"})).toBeVisible();
      await expect(page).toHaveTitle(/Activity/u);
      await expectSameDocument(page);

      await page.getByRole("button", {name: /^Account menu/u}).first().click();
      await page.getByRole("menuitem", {name: "Administration"}).click();
      await expect(page).toHaveURL(/\/review\/settings\/members$/u);
      await expect(page.getByRole("heading", {name: "Members"}).first()).toBeVisible();
      const adminNav = page.getByRole("navigation", {name: "Administration"});
      await expectSameDocument(page);

      // Back to review returns to the last artifact reviewed; folders now open Projects, so that is still Default's.
      await adminNav.getByRole("link", {name: "Back to review"}).click();
      await expect(page).toHaveURL(/project=prj_default&artifact=/u);
      await expect(artifactTitle(page)).toHaveText("Navigation home fixture");
      await expectSameDocument(page);

      await page.goBack();
      await expect(page).toHaveURL(/\/review\/settings\/members$/u);
      await page.goBack();
      await expect(page.getByRole("heading", {exact: true, level: 1, name: "Activity"})).toBeVisible();
      await page.goForward();
      await expect(page).toHaveURL(/\/review\/settings\/members$/u);
      await expectSameDocument(page);

      await page.getByRole("link", {name: "Artifact Server"}).first().click();
      await expect(page.getByRole("heading", {exact: true, level: 1, name: "Activity"})).toBeVisible();
      await expectSameDocument(page);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("NAV-001-B: Activity, Projects and a project folder change screens in place and restore Activity filters through history", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await localLogin(fixture);
      const page = fixture.page;
      const nav = page.getByRole("navigation", {name: "Review and projects"});
      await nav.getByRole("link", {exact: true, name: "Activity"}).click();
      await expect(page.getByRole("heading", {exact: true, level: 1, name: "Activity"})).toBeVisible();
      await markDocument(page);
      await page.getByRole("radio", {name: /Needs you/u}).click();
      await nav.getByRole("link", {exact: true, name: "Projects"}).click();
      await expect(page).toHaveURL(/\/review\/projects$/u);
      await page.goBack();
      await expect(page).toHaveURL(/segment=needs_you/u);
      await expect(page.getByRole("radio", {name: /Needs you/u})).toBeChecked();
      await expectSameDocument(page);
      await page.goto(`${fixture.server.baseUrl}/review/settings/projects/prj_default`);
      await expect(page).toHaveURL(/\/review\/projects\?project=prj_default$/u);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("NAV-001-F: switching artifacts never shows the previous artifact's record while the next one loads", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = await publishNavigationFixture(fixture, "Navigation first artifact", "navigation-first");
      await publishNavigationFixture(fixture, "Navigation second artifact", "navigation-second");
      await localLogin(fixture);
      const page = fixture.page;
      await expect(artifactTitle(page)).toHaveText("Navigation second artifact");

      const held = Promise.withResolvers<undefined>();
      const firstDetails = (url: URL): boolean => url.pathname === `/api/v1/artifacts/${first.artifact.id}`;
      await page.route(firstDetails, async (route) => {
        await held.promise;
        await route.continue();
      });
      await page.getByRole("list", {name: "Artifacts"})
        .getByRole("button", {name: /^Navigation first artifact/u}).click();
      const versionControl = page.getByRole("toolbar", {exact: true, name: "Artifact"})
        .getByRole("button", {name: /^Choose version, showing /u});
      // The catalog already names the chosen artifact; the old record must not stay up.
      await expect(artifactTitle(page)).toHaveText("Navigation first artifact");
      await expect(versionControl).toHaveCount(0);
      await expect(page.getByRole("toolbar", {exact: true, name: "Artifact"}).getByRole("button", {exact: true, name: "Share"})).toBeDisabled();
      held.resolve(undefined);
      await expect(versionControl).toHaveAccessibleName("Choose version, showing v1 of 1, current");
      await expect(artifactTitle(page)).toHaveText("Navigation first artifact");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("NAV-001-F: a failed or empty activity history is requested once, not in a loop", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await publishNavigationFixture(fixture, "Navigation activity fixture", "navigation-activity");
      await localLogin(fixture);
      const page = fixture.page;
      await expect(artifactTitle(page)).toHaveText("Navigation activity fixture");
      let activityRequests = 0;
      await page.route("**/api/v1/artifacts/*/actions?*", async (route) => {
        activityRequests += 1;
        await route.fulfill({
          body: JSON.stringify({error: {code: "unavailable", message: "Activity is unavailable."}}),
          contentType: "application/json",
          status: 503,
        });
      });
      await openComparison(page, "Activity");
      await expect(page.getByRole("region", {name: "Comparison and history"}).getByRole("alert").first()).toBeVisible();
      await page.waitForTimeout(1_000);
      expect(activityRequests).toBe(1);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
