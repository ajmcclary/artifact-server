import {expect, test, type Page} from "@playwright/test";

import {
  commitStagedUpload,
  createStagedUpload,
  publishNew,
  testSiteFile,
  uploadEveryStagedFile,
  type PublishResponse,
} from "../support/publishing.js";
import {localLogin, startBrowserFixture, stopBrowserFixture, type BrowserFixture} from "./browser-fixture.js";
import {createThreadOverApi} from "./comment-api.js";
import {pageCrumb} from "./review-helpers.js";

const phone = {height: 844, width: 390} as const;
const key = (name: string): string => `phone-navigation-${name}`;

/** Errors the page reports to its console, or throws. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** The window's offset once it holds across frames: day caps and heads compact after a scroll. */
async function settledScroll(page: Page): Promise<number> {
  return page.evaluate(() => new Promise<number>((resolve) => {
    let last = -1;
    let held = 0;
    const step = (): void => {
      const y = Math.round(window.scrollY);
      held = y === last ? held + 1 : 0;
      last = y;
      if (held >= 10) resolve(y);
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }));
}

/** A two-page artifact, so a review can change page before ‹ Back. */
async function publishPages(fixture: BrowserFixture): Promise<PublishResponse> {
  const files = [
    testSiteFile("<!doctype html><html lang=\"en\"><title>Home</title><main><h1>Phone pages home</h1></main></html>", undefined, "index.html"),
    testSiteFile("<!doctype html><html lang=\"en\"><title>About</title><main><h1>Phone pages about</h1></main></html>", undefined, "about.html"),
  ];
  const upload = await createStagedUpload(fixture.server, fixture.installation, "index.html", files);
  await uploadEveryStagedFile(fixture.installation, upload.body, files);
  return (await commitStagedUpload(fixture.installation, upload.body, key("pages"), {
    accessSetting: "account_required",
    kind: "new_artifact",
    name: "Phone pages fixture",
  })).body;
}

/** Conversations on many artifacts, so the Activity feed runs well past one phone screen. */
async function seedConversations(fixture: BrowserFixture, count: number): Promise<void> {
  await Promise.all(Array.from({length: count}, async (_unused, index) => {
    const published = (await publishNew(fixture.server, fixture.installation, {
      accessSetting: "account_required",
      content: `<!doctype html><html lang="en"><title>Filler ${index}</title><h1>Filler ${index}</h1></html>`,
      idempotencyKey: key(`filler-${index}`),
      name: `Phone filler ${index}`,
      path: "index.html",
    })).body;
    await createThreadOverApi(fixture, {
      artifactId: published.artifact.id,
      body: `Conversation ${index} needs an answer.`,
      idempotencyKey: key(`filler-thread-${index}`),
      path: "index.html",
      projectId: published.artifact.projectId,
      versionId: published.version.id,
    });
  }));
}

test.describe("Phone navigation", () => {
  test("NAV-001-B: on a phone the tab bar, More sheet and app bar replace the drawer launcher", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const page = fixture.page;
      // The first session probe answers 401 by design, before the local sign-in.
      await localLogin(fixture);
      const errors = collectErrors(page);
      await page.setViewportSize(phone);
      await page.goto(`${fixture.server.baseUrl}/review`);
      await expect(page.getByRole("heading", {exact: true, level: 1, name: "Activity"})).toBeVisible();
      await page.evaluate(() => {
        document.documentElement.dataset["navigationProbe"] = "same-document";
      });

      // No launcher, no navigation column, no drawer: a tab bar and a navy app bar instead.
      await expect(page.getByRole("button", {name: "Open menu"})).toHaveCount(0);
      await expect(page.locator("[data-ac-mnav-launcher], [data-ac-left-nav]")).toHaveCount(0);
      const tabs = page.getByRole("navigation", {name: "Primary"});
      await expect(tabs.getByRole("link", {exact: true, name: "Activity"})).toHaveAttribute("aria-current", "page");
      await expect(tabs.getByRole("link", {exact: true, name: "Library"})).toBeVisible();
      await expect(tabs.getByRole("link", {exact: true, name: "Projects"})).toBeVisible();
      const appBar = page.locator("[data-ak-app-bar]");
      await expect(appBar.getByRole("link", {name: "Artifact Server home"})).toBeVisible();
      await expect(appBar.getByRole("button", {name: "Quick Search"})).toBeVisible();

      // More opens the projects, Tools and the account; Escape returns focus to the More tab.
      const more = tabs.getByRole("button", {exact: true, name: "More"});
      await more.click();
      const sheet = page.getByRole("dialog", {name: "More"});
      await expect(sheet.getByRole("region", {name: "Projects"}).getByRole("link", {exact: true, name: "Default"})).toBeVisible();
      await expect(sheet.getByRole("region", {name: "Tools"}).getByRole("link", {name: "Administration"})).toBeVisible();
      await expect(sheet.getByRole("button", {name: "Sign out"})).toBeVisible();
      await expect(more).toHaveAttribute("aria-current", "page");
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
      await expect(more).toBeFocused();
      expect(await horizontalOverflow(page)).toBe(0);

      // Tabs and More tiles change screens in place.
      await tabs.getByRole("link", {exact: true, name: "Library"}).click();
      await expect(page).toHaveURL(/\/review\/library$/u);
      await expect(tabs.getByRole("link", {exact: true, name: "Library"})).toHaveAttribute("aria-current", "page");
      await more.click();
      await sheet.getByRole("link", {name: "Administration"}).click();
      await expect(page).toHaveURL(/\/review\/settings\/members$/u);
      await expect(page.getByRole("heading", {level: 1, name: "Members"})).toBeVisible();
      await expect(more).toHaveAttribute("aria-current", "page");

      // Projects is a list page; a project opens one level down and ‹ Projects returns.
      await tabs.getByRole("link", {exact: true, name: "Projects"}).click();
      await expect(page).toHaveURL(/\/review\/projects$/u);
      await page.getByRole("list", {name: "Projects"}).getByRole("button", {name: /Default/u}).click();
      await expect(page).toHaveURL(/\/review\/projects\?project=prj_default$/u);
      await expect(page.getByRole("region", {name: "Project details"}).getByRole("heading", {name: "Default"})).toBeVisible();
      await expect(tabs.getByRole("link", {exact: true, name: "Projects"})).toHaveAttribute("aria-current", "page");
      await appBar.getByRole("button", {name: "Back to Projects"}).click();
      await expect(page).toHaveURL(/\/review\/projects$/u);
      expect(await horizontalOverflow(page)).toBe(0);
      expect(await page.evaluate(() => document.documentElement.dataset["navigationProbe"] ?? null)).toBe("same-document");
      expect(errors).toEqual([]);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("NAV-001-B: on a phone the window scrolls Activity, and ‹ Back and browser Back return a review to the same offset", async ({browser}) => {
    test.setTimeout(120_000);
    const fixture = await startBrowserFixture(browser);
    try {
      const pages = await publishPages(fixture);
      await createThreadOverApi(fixture, {
        artifactId: pages.artifact.id,
        body: "Check the about page.",
        idempotencyKey: key("pages-thread"),
        path: "index.html",
        projectId: pages.artifact.projectId,
        versionId: pages.version.id,
      });
      await seedConversations(fixture, 10);
      const page = fixture.page;
      // The first session probe answers 401 by design, before the local sign-in.
      await localLogin(fixture);
      const errors = collectErrors(page);
      await page.setViewportSize(phone);
      await page.goto(`${fixture.server.baseUrl}/review`);
      await expect(page.getByRole("heading", {exact: true, level: 1, name: "Activity"})).toBeVisible();
      // The summary is a compact two-by-two grid.
      await expect(page.locator("[data-activity-metrics='compact']")).toBeVisible();
      const opener = page.getByRole("button", {name: "Open Phone pages fixture in review"}).first();
      await expect(opener).toBeVisible();

      // One scroll: the window moves, not a pane inside it.
      await page.evaluate(() => window.scrollTo(0, 400));
      await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(400);
      expect(await page.locator("main").evaluate((main) => main.scrollTop)).toBe(0);
      expect(await page.locator("main").evaluate((main) => getComputedStyle(main).overflowY)).toBe("visible");

      // Open the review from where the entry sits, then change its page.
      await opener.scrollIntoViewIfNeeded();
      const left = await settledScroll(page);
      expect(left).toBeGreaterThan(100);
      // A tap where it sits; Playwright's own click would scroll the page again first.
      await opener.evaluate((button: HTMLElement) => button.click());
      const appBar = page.locator("[data-ak-app-bar]");
      const back = appBar.getByRole("button", {name: "Back to Activity"});
      await expect(back).toBeVisible();
      await expect(appBar).toContainText("Phone pages fixture");
      // A conversation opens in the full-screen comments sheet; closing it shows the review.
      await page.getByRole("button", {name: "Close the inspector"}).click();
      // A review keeps the tab it was opened from; the Activity tab speaks its Needs-you count.
      await expect(page.getByRole("navigation", {name: "Primary"}).getByRole("link", {name: /^Activity, \d+ need you$/u}))
        .toHaveAttribute("aria-current", "page");
      await pageCrumb(page).click();
      await page.getByRole("dialog", {name: "Choose a page"}).getByRole("button", {name: /^about\.html/u}).click();
      await expect(page).toHaveURL(/path=about\.html/u);
      await expect(back).toBeVisible();

      // ‹ Back skips the page change and lands on Activity where it was left.
      await back.click();
      await expect(page).toHaveURL(`${fixture.server.baseUrl}/review`);
      await expect(page.getByRole("heading", {exact: true, level: 1, name: "Activity"})).toBeAttached();
      await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(left);
      // It was a history step, as the browser's own Back is: Forward returns to the review.
      await page.goForward();
      await expect(page).toHaveURL(/artifact=/u);
      await expect(back).toBeVisible();

      // The browser's Back does the same.
      await page.goBack();
      await expect(page).toHaveURL(`${fixture.server.baseUrl}/review`);
      await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(left);

      // Focus hides the tab bar and gives its room to the preview.
      await opener.click();
      await expect(back).toBeVisible();
      await page.getByRole("button", {name: "Close the inspector"}).click();
      await page.getByRole("toolbar", {exact: true, name: "Artifact"}).getByRole("button", {name: /^Focus/u}).click();
      await expect(page.getByRole("navigation", {name: "Primary"})).toHaveCount(0);
      expect(await horizontalOverflow(page)).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("NAV-001-B: tablet and desktop keep the navigation column and no phone bars", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const page = fixture.page;
      await localLogin(fixture);
      await page.setViewportSize({height: 800, width: 1280});
      await page.goto(`${fixture.server.baseUrl}/review`);
      await expect(page.getByRole("heading", {exact: true, level: 1, name: "Activity"})).toBeVisible();
      await expect(page.locator("[data-ac-left-nav]")).toHaveCount(1);
      await expect(page.locator("[data-ak-app-bar], [data-ak-tab-bar]")).toHaveCount(0);
      // The feed is still its own scroller beside the column.
      expect(await page.locator("main").evaluate((main) => getComputedStyle(main).overflowY)).toBe("auto");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
