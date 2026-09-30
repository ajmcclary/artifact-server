import {expect, test, type Page} from "@playwright/test";

import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  type BrowserFixture,
} from "./browser-fixture.js";
import {createThreadOverApi} from "./comment-api.js";
import {openInspectorTab, toast} from "./review-helpers.js";

async function publishContinuityFixture(
  fixture: BrowserFixture,
  name: string,
  idempotencyKey: string,
): Promise<PublishResponse> {
  return (await publishNew(fixture.server, fixture.installation, {
    accessSetting: "account_required",
    content: `<!doctype html><html lang="en"><head><title>${name}</title></head><body><h1>${name}</h1></body></html>`,
    // The API requires idempotency keys of at least 16 characters.
    idempotencyKey: `ux-continuity-spec-${idempotencyKey}`,
    mediaType: "text/html; charset=utf-8",
    name,
    path: "index.html",
    projectId: "prj_default",
  })).body;
}

/** A catalog's first page with no search text. */
function firstPage(url: URL): boolean {
  return url.pathname === "/api/v1/artifacts" && !url.searchParams.has("search");
}

function searchPage(url: URL): boolean {
  return url.pathname === "/api/v1/artifacts" && url.searchParams.get("search") === "alpha";
}

/** The review queue's per-project read: most-discussed artifacts first. */
function queueRead(url: URL): boolean {
  return url.pathname === "/api/v1/artifacts" && url.searchParams.get("sort") === "comments";
}

function artifactTitle(page: Page) {
  return page.getByRole("toolbar", {exact: true, name: "Artifact"}).getByRole("heading", {level: 1});
}

function catalogRow(page: Page, name: string) {
  return page.getByRole("list", {name: "Artifacts"}).getByRole("button", {name: new RegExp(`^${name}`, "u")});
}

test.describe("Screen continuity", () => {
  test("NAV-001-B: startup paints the application's own frame, sized like the pinned navigation, never the sign-in layout", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await localLogin(fixture);
      const page = fixture.page;
      await page.getByRole("button", {name: "Pin the menu"}).click();
      await expect(page.getByRole("button", {name: "Unpin the menu"})).toBeVisible();
      const navigationWidth = await page.locator("[data-ac-left-nav]").evaluate((element) => element.getBoundingClientRect().width);

      const sessionHeld = Promise.withResolvers<undefined>();
      await page.route("**/api/v1/session", async (route) => {
        await sessionHeld.promise;
        await route.continue();
      });
      await page.goto(`${fixture.server.baseUrl}/review`);
      const skeleton = page.locator(".as-boot");
      await expect(skeleton).toBeVisible();
      await expect(page.getByRole("heading", {name: "Loading Artifact Server"})).toBeVisible();
      await expect(page.getByText("Review designs together.")).toHaveCount(0);
      const skeletonWidth = await page.locator(".as-boot__nav").evaluate((element) => element.getBoundingClientRect().width);
      expect(Math.abs(skeletonWidth - navigationWidth)).toBeLessThanOrEqual(1);
      sessionHeld.resolve(undefined);
      await expect(page.getByRole("heading", {exact: true, name: "Review queue"})).toBeVisible();
      await expect(skeleton).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("NAV-001-B: opening a project, searching the catalog, and switching artifacts never blank what is already known", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = await publishContinuityFixture(fixture, "Continuity alpha", "continuity-alpha");
      const second = await publishContinuityFixture(fixture, "Continuity beta", "continuity-beta");
      await createThreadOverApi(fixture, {
        artifactId: second.artifact.id,
        body: "A settled question.",
        idempotencyKey: "ux-continuity-spec-thread-beta",
        path: "index.html",
        versionId: second.version.id,
      });
      const page = fixture.page;
      await localLogin(fixture, false);
      await expect(page.getByRole("heading", {exact: true, name: "Review queue"})).toBeVisible();

      // A project whose first page is still being read opens, rather than asking for a selection.
      const catalogHeld = Promise.withResolvers<undefined>();
      await page.route(firstPage, async (route) => {
        await catalogHeld.promise;
        await route.continue();
      });
      await page.getByRole("navigation", {name: "Review and projects"}).getByRole("link", {name: "Default"}).click();
      await expect(page.getByText("Opening project")).toBeVisible();
      await expect(page.getByText("Select an artifact", {exact: true})).toHaveCount(0);
      await expect(page.getByText("Nothing selected")).toHaveCount(0);
      catalogHeld.resolve(undefined);
      await expect(artifactTitle(page)).toHaveText("Continuity beta");

      // Searching keeps the listed rows, dimmed and busy, until the new page lands.
      const searchHeld = Promise.withResolvers<undefined>();
      await page.route(searchPage, async (route) => {
        await searchHeld.promise;
        await route.continue();
      });
      await page.getByRole("searchbox", {name: "Search artifacts"}).fill("alpha");
      await expect(page.getByRole("list", {name: "Artifacts"})).toHaveAttribute("aria-busy", "true");
      await expect(catalogRow(page, "Continuity beta")).toBeVisible();
      searchHeld.resolve(undefined);
      await expect(catalogRow(page, "Continuity beta")).toHaveCount(0);
      await expect(catalogRow(page, "Continuity alpha")).toBeVisible();
      await expect(page.getByRole("list", {name: "Artifacts"})).not.toHaveAttribute("aria-busy", "true");
      await page.getByRole("searchbox", {name: "Search artifacts"}).fill("");
      await expect(catalogRow(page, "Continuity beta")).toBeVisible();

      // The Comments view the reviewer chose survives moving to another artifact.
      await openInspectorTab(page, "Comments");
      const resolvedView = page.getByRole("group", {name: "Comment filters"}).getByRole("button", {name: "Resolved"});
      await resolvedView.click();
      await expect(resolvedView).toHaveAttribute("aria-pressed", "true");
      await catalogRow(page, "Continuity alpha").click();
      await expect(artifactTitle(page)).toHaveText("Continuity alpha");
      await expect(page).toHaveURL(new RegExp(`artifact=${first.artifact.id}`, "u"));
      await expect(resolvedView).toHaveAttribute("aria-pressed", "true");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("NAV-001-B: the review queue stays on screen while it refreshes and when the reviewer returns to it", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishContinuityFixture(fixture, "Continuity queued", "continuity-queued");
      await createThreadOverApi(fixture, {
        artifactId: published.artifact.id,
        body: "Please look at the header.",
        idempotencyKey: "ux-continuity-spec-thread-queued",
        path: "index.html",
        versionId: published.version.id,
      });
      const page = fixture.page;
      await localLogin(fixture, false);
      const row = page.getByText("Continuity queued", {exact: true});
      await expect(row).toBeVisible();

      const queueHeld = Promise.withResolvers<undefined>();
      await page.route(queueRead, async (route) => {
        await queueHeld.promise;
        await route.continue();
      });
      await page.getByRole("button", {name: "Refresh queue"}).click();
      await expect(page.getByText(/· refreshing$/u)).toBeVisible();
      await expect(row).toBeVisible();
      await expect(page.getByText("Loading the review queue")).toHaveCount(0);
      await expect(page.getByRole("button", {name: "Refresh queue"})).toBeEnabled();

      // Leaving and returning shows the last queue at once while it re-reads underneath.
      await page.getByRole("navigation", {name: "Review and projects"}).getByRole("link", {name: "Design library"}).click();
      await page.getByRole("navigation", {name: "Review and projects"}).getByRole("link", {name: "Review queue"}).click();
      await expect(row).toBeVisible();
      await expect(page.getByText("Loading the review queue")).toHaveCount(0);
      queueHeld.resolve(undefined);
      await expect(page.getByText(/· refreshing$/u)).toHaveCount(0);
      await expect(row).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("NAV-001-F: a refused sign-out says so and keeps the reviewer signed in where they were", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await localLogin(fixture);
      const page = fixture.page;
      const before = page.url();
      await page.route("**/api/v1/session/logout", (route) => route.fulfill({
        body: JSON.stringify({error: {code: "INTERNAL_ERROR", message: "Session storage is unavailable."}}),
        contentType: "application/json",
        status: 500,
      }));
      await page.getByRole("button", {name: /^Account menu/u}).first().click();
      await page.getByRole("menuitem", {name: "Sign out"}).click();
      await expect(toast(page, "Session storage is unavailable. You are still signed in.")).toBeVisible();
      expect(page.url()).toBe(before);
      await expect(page.getByRole("link", {name: "Artifact Server"}).first()).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("NAV-001-B: native controls follow the chosen theme rather than the operating system", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await fixture.page.emulateMedia({colorScheme: "dark"});
      await localLogin(fixture);
      const page = fixture.page;
      const colorScheme = () => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
      await expect.poll(colorScheme).toBe("dark");
      await page.getByRole("button", {name: /^Account menu/u}).first().click();
      await page.getByRole("menuitemradio", {name: "Light"}).click();
      await expect.poll(colorScheme).toBe("light");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
