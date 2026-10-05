import {AxeBuilder} from "@axe-core/playwright";
import {expect, test, type Page} from "@playwright/test";

import {publishNew} from "../support/publishing.js";
import {localLogin, startBrowserFixture, stopBrowserFixture, type BrowserFixture} from "./browser-fixture.js";
import {createThreadOverApi} from "./comment-api.js";
import {
  annotationFrame,
  artifactFrameSelectors,
  openReview,
  previewFrame,
  waitForSettledPaint,
} from "./review-helpers.js";

async function publishFocusFixture(fixture: BrowserFixture) {
  const published = await publishNew(fixture.server, fixture.installation, {
    accessSetting: "account_required",
    content: "<!doctype html><html lang=\"en\"><title>Focus fixture</title><main><h1 id=\"focus-target\">Focus fixture content</h1></main></html>",
    idempotencyKey: `cmt-015-focus-${crypto.randomUUID()}`,
    name: "Focus fixture",
  });
  await createThreadOverApi(fixture, {
    artifactId: published.body.artifact.id,
    body: "Full screen seeded thread",
    idempotencyKey: `cmt-015-focus-thread-${crypto.randomUUID()}`,
    versionId: published.body.version.id,
  });
  return published.body;
}

async function canvasBox(page: Page): Promise<readonly number[] | null> {
  const box = await page.getByRole("region", {name: "Artifact preview"}).boundingBox();
  return box === null
    ? null
    : [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)];
}

test.describe("Artifact review full screen", () => {
  test("CMT-015-B CMT-015-F: full screen gives the artifact an uninterrupted canvas with hideable, restorable viewer controls", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishFocusFixture(fixture);
      await localLogin(fixture);
      await openReview(fixture, {artifactId: published.artifact.id, versionId: published.version.id});
      const page = fixture.page;
      const viewport = page.viewportSize();
      if (viewport === null) throw new Error("The page has no viewport.");
      const fullCanvas = [0, 0, viewport.width, viewport.height];
      await expect(previewFrame(page).getByRole("heading", {name: "Focus fixture content"})).toBeVisible();

      await expect(page.getByRole("toolbar", {exact: true, name: "Artifact"}).getByRole("button", {name: "Focus — expand the workspace"}))
        .toHaveAttribute("aria-keyshortcuts", "F");
      await page.getByRole("region", {name: "Artifact preview"}).focus();
      await page.keyboard.press("f");
      const controls = page.getByRole("toolbar", {name: "Artifact viewer controls"});
      await expect(controls).toBeVisible();
      await expect(page.locator("[data-preview-bar]").getByRole("toolbar", {name: "Artifact viewer controls"})).toBeVisible();
      expect(await page.locator("[data-preview-bar]").evaluate((bar) => bar.getBoundingClientRect().height)).toBeLessThanOrEqual(36);
      const share = controls.getByRole("button", {name: "Share this version", exact: true});
      const raw = controls.getByRole("button", {name: "Open raw in a new window", exact: true});
      const exit = controls.getByRole("button", {name: "Exit full screen"});
      expect((await share.boundingBox())?.x).toBeLessThan((await raw.boundingBox())?.x ?? 0);
      expect((await raw.boundingBox())?.x).toBeLessThan((await exit.boundingBox())?.x ?? 0);
      const buttonStyles = await controls.getByRole("button").evaluateAll((buttons) => buttons.map((element) => ({background: getComputedStyle(element).backgroundColor, border: getComputedStyle(element).borderWidth})));
      expect(buttonStyles.every((style) => style.background === "rgba(0, 0, 0, 0)" && style.border === "0px")).toBe(true);
      await page.screenshot({path: "test-results/browser/focus-titlebar-desktop.png"});
      await page.setViewportSize({width: 390, height: 844});
      await expect(controls.getByRole("button", {name: "Exit full screen"})).toBeInViewport();
      await expect(controls.getByRole("button", {name: "Hide viewer controls"})).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await page.screenshot({path: "test-results/browser/focus-titlebar-phone.png"});
      await page.setViewportSize(viewport);
      await expect(controls.getByRole("button", {name: "Exit full screen"})).toHaveAttribute("aria-keyshortcuts", "F");
      expect(new URL(page.url()).searchParams.get("view")).toBe("focus");
      await expect(page.getByRole("complementary", {name: "Artifact catalog"})).toHaveCount(0);
      await expect(page.getByRole("complementary", {name: "Artifact inspector"})).toHaveCount(0);
      await expect(page.getByRole("toolbar", {exact: true, name: "Artifact"})).toHaveCount(0);
      await expect.poll(() => canvasBox(page)).toEqual(fullCanvas);
      // The shell's navigation cannot take focus beneath the full-screen layer.
      await expect(page.locator("[data-ac-left-nav]")).toHaveCount(0);
      expect(await page.evaluate(() => {
        const nav = document.querySelector('nav, [data-ac-left-nav]');
        return nav === null || nav.closest("[inert]") !== null;
      })).toBe(true);
      await expect(previewFrame(page).getByRole("heading", {name: "Focus fixture content"})).toBeVisible();

      // Comments open beside the canvas with ] and leave with ] or Escape.
      const focusComments = page.getByRole("complementary", {name: "Comments"});
      await expect(focusComments).toHaveCount(0);
      await page.keyboard.press("]");
      await expect(focusComments.getByRole("article", {name: /^Comment by /u}).filter({hasText: "Full screen seeded thread"}))
        .toBeVisible();
      await controls.getByRole("button", {name: /^Comments/u}).click();
      await expect(focusComments).toHaveCount(0);

      // Commenting in full screen keeps the canvas uninterrupted until asked.
      const annotate = controls.getByRole("button", {exact: true, name: "Annotate mode"});
      await expect(annotate).toHaveAttribute("aria-pressed", "true");
      await previewFrame(page).locator("#focus-target").click();
      const composer = annotationFrame(page).getByPlaceholder("Add a comment...");
      await expect(composer).toBeVisible();
      await composer.fill("Keep the full-screen canvas uninterrupted.");
      await annotationFrame(page).getByRole("button", {name: "Save"}).click();
      await expect(focusComments).toHaveCount(0);
      await page.getByRole("region", {name: "Artifact preview"}).focus();
      await page.keyboard.press("]");
      await expect(focusComments.getByRole("article", {name: /^Comment by /u})
        .filter({hasText: "Keep the full-screen canvas uninterrupted."})).toBeVisible();
      await waitForSettledPaint(page);
      const accessibility = await new AxeBuilder({page})
        .exclude(artifactFrameSelectors[0])
        .exclude(artifactFrameSelectors[1])
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);
      await page.keyboard.press("]");

      // Hidden controls leave one restore button and the whole canvas.
      await controls.getByRole("button", {name: "Hide viewer controls"}).click();
      await expect(controls).toBeHidden();
      const restore = page.getByRole("button", {name: "Show viewer controls"});
      await expect(restore).toBeFocused();
      await expect(restore).toHaveAttribute("aria-keyshortcuts", "Meta+\\ Control+\\");
      await expect.poll(() => canvasBox(page)).toEqual(fullCanvas);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", {exact: true, includeHidden: true, name: "Interact mode"}))
        .toHaveAttribute("aria-pressed", "false");
      await restore.click();
      await expect(controls).toBeVisible();
      await expect(controls.getByRole("button", {name: /^Comments/u})).toBeFocused();
      await controls.getByRole("button", {name: "Hide viewer controls"}).click();
      await page.keyboard.press("Control+Backslash");
      await expect(controls).toBeVisible();
      await expect(controls.getByRole("button", {name: /^Comments/u})).toBeFocused();

      // Escape leaves full screen once nothing inner is open; F toggles it.
      await page.keyboard.press("Escape");
      await expect(page.getByRole("toolbar", {exact: true, name: "Artifact"}).getByRole("button", {name: "Focus — expand the workspace"}))
        .toBeVisible();
      expect(new URL(page.url()).searchParams.has("view")).toBe(false);
      await expect(page.getByRole("complementary", {name: "Artifact catalog"})).toBeVisible();
      await page.keyboard.press("f");
      await expect(controls).toBeVisible();
      await page.keyboard.press("f");
      await expect(controls).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-015-B CMT-015-F: full screen, its comments and its controls never animate under reduced motion", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishFocusFixture(fixture);
      await fixture.page.emulateMedia({reducedMotion: "reduce"});
      await localLogin(fixture);
      await openReview(fixture, {artifactId: published.artifact.id, focus: true, versionId: published.version.id});
      const page = fixture.page;
      const controls = page.getByRole("toolbar", {name: "Artifact viewer controls"});
      await expect(controls).toBeVisible();
      await controls.getByRole("button", {name: /^Comments/u}).click();
      await expect(page.getByRole("complementary", {name: "Comments"})).toBeVisible();
      await controls.getByRole("button", {name: "Hide viewer controls"}).click();
      await page.keyboard.press("Control+Backslash");
      await expect(controls).toBeVisible();
      // Nothing keeps animating (the old global rule leaves 0.01 ms transitions that end within a frame).
      await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
      await controls.getByRole("button", {name: "Exit full screen"}).click();
      await expect.poll(() => page.locator('[data-panel="artifact-catalog"]').evaluate(
        (node) => Math.max(...getComputedStyle(node).transitionDuration.split(",").map((part) => Number.parseFloat(part))),
      )).toBeLessThanOrEqual(0.00001);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
