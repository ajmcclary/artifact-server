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

/** The Activity feed's read. */
function activityRead(url: URL): boolean {
  return url.pathname === "/api/v1/activity";
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
      await expect(page.getByRole("heading", {exact: true, level: 1, name: "Activity"})).toBeVisible();
      await expect(skeleton).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("NAV-001-F: a startup that does not answer in time offers Try again instead of loading forever", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await localLogin(fixture);
      const page = fixture.page;
      const sessionHeld = Promise.withResolvers<undefined>();
      await page.route("**/api/v1/session", async (route) => {
        await sessionHeld.promise;
        await route.continue();
      });
      await page.clock.install();
      await page.goto(`${fixture.server.baseUrl}/review`);
      await expect(page.getByRole("heading", {name: "Loading Artifact Server"})).toBeVisible();
      await page.clock.fastForward(21_000);
      await expect(page.getByRole("heading", {name: "Artifact Server unavailable"})).toBeVisible();
      await expect(page.getByText("Artifact Server did not answer in time. Check the connection, then try again.")).toBeVisible();
      sessionHeld.resolve(undefined);
      await page.getByRole("button", {name: "Try again"}).click();
      await expect(page.getByRole("heading", {exact: true, level: 1, name: "Activity"})).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("NAV-001-B: on a phone the menu drawer changes screens in place and the startup frame has no navigation column", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const page = fixture.page;
      await localLogin(fixture);
      await page.setViewportSize({height: 844, width: 390});
      await page.goto(`${fixture.server.baseUrl}/review`);
      await expect(page.getByRole("heading", {exact: true, level: 1, name: "Activity"})).toBeVisible();
      await page.evaluate(() => {
        document.documentElement.dataset["navigationProbe"] = "same-document";
      });
      const probe = () => page.evaluate(() => document.documentElement.dataset["navigationProbe"] ?? null);

      await page.getByRole("button", {name: "Open menu"}).click();
      const drawer = page.getByRole("dialog", {name: "Review and projects"});
      await drawer.getByRole("link", {name: "Design library"}).click();
      await expect(page).toHaveURL(/\/review\/library\?project=prj_default/u);
      await expect(drawer).toHaveCount(0);
      await page.getByRole("button", {name: "Open menu"}).click();
      await drawer.getByRole("link", {exact: true, name: "Activity"}).click();
      await expect(page.getByRole("heading", {exact: true, level: 1, name: "Activity"})).toBeVisible();
      expect(await probe()).toBe("same-document");

      const sessionHeld = Promise.withResolvers<undefined>();
      await page.route("**/api/v1/session", async (route) => {
        await sessionHeld.promise;
        await route.continue();
      });
      await page.goto(`${fixture.server.baseUrl}/review`);
      await expect(page.locator(".as-boot")).toBeVisible();
      await expect(page.locator(".as-boot__nav")).toBeHidden();
      sessionHeld.resolve(undefined);
      await expect(page.getByRole("heading", {exact: true, level: 1, name: "Activity"})).toBeVisible();
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
      await expect(page.getByRole("heading", {exact: true, level: 1, name: "Activity"})).toBeVisible();

      // A project whose first page is still being read opens, rather than asking for a selection.
      const catalogHeld = Promise.withResolvers<undefined>();
      await page.route(firstPage, async (route) => {
        await catalogHeld.promise;
        await route.continue();
      });
      // Project folders open Projects; the project's review is its workspace address.
      await page.goto(`${fixture.server.baseUrl}/review?project=prj_default`);
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

  test("NAV-001-B: Activity stays on screen while it re-reads and when the reviewer returns to it", async ({browser}) => {
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
      const row = page.getByText(/published v1 of/u).first();
      await expect(row).toBeVisible();

      const feedHeld = Promise.withResolvers<undefined>();
      await page.route(activityRead, async (route) => {
        await feedHeld.promise;
        await route.continue();
      });
      // Returning to the window re-reads the feed underneath what is shown.
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(row).toBeVisible();
      await expect(page.getByText("Loading activity")).toHaveCount(0);

      // Leaving and returning shows the last feed at once while it re-reads underneath.
      await page.getByRole("navigation", {name: "Review and projects"}).getByRole("link", {name: "Design library"}).click();
      await page.getByRole("navigation", {name: "Review and projects"}).getByRole("link", {exact: true, name: "Activity"}).click();
      await expect(page.getByRole("heading", {exact: true, level: 1, name: "Activity"})).toBeVisible();
      await expect(row).toBeVisible();
      await expect(page.getByText("Loading activity")).toHaveCount(0);
      feedHeld.resolve(undefined);
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
