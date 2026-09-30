import {expect, test, type Page} from "@playwright/test";

import {publishNew} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  workspaceViewport,
} from "./browser-fixture.js";
import {openReview} from "./review-helpers.js";

function catalogPanel(page: Page) {
  return page.locator('[data-panel="artifact-catalog"]');
}

async function storedPanels(page: Page): Promise<string> {
  return await page.evaluate(() => window.localStorage.getItem("artifact-review-panels")) ?? "";
}

test.describe("Artifact review workspace layout", () => {
  test("CMT-015-B CMT-015-F: the artifact catalog docks, resizes, rails, peeks and becomes a sheet on the display ladder", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Layout fixture</title><main><h1>Layout fixture content</h1></main></html>",
        idempotencyKey: "cmt-015-layout-fixture",
        name: "Layout fixture",
      });
      await localLogin(fixture);
      await openReview(fixture, {
        artifactId: published.body.artifact.id,
        versionId: published.body.version.id,
      });
      const page = fixture.page;
      const catalog = page.getByRole("complementary", {name: "Artifact catalog"});
      await expect(catalog.getByRole("heading", {name: "Artifacts"})).toBeVisible();
      await expect(catalogPanel(page)).toHaveAttribute("data-panel-state", "pinned");
      expect(await storedPanels(page)).toBe("");

      const seam = page.getByRole("separator", {name: "Resize the artifact catalog"});
      await expect(seam).toHaveAttribute("aria-valuenow", "302");
      await expect(seam).toHaveAttribute("aria-valuemin", "240");
      await expect(seam).toHaveAttribute("aria-valuemax", "460");

      // One key press is one 16 px step, committed and remembered.
      await seam.focus();
      await page.keyboard.press("ArrowRight");
      await expect(seam).toHaveAttribute("aria-valuenow", "318");
      await expect.poll(() => catalogPanel(page).evaluate(
        (node) => Math.round(node.getBoundingClientRect().width),
      )).toBe(318);
      await expect.poll(() => storedPanels(page)).toContain("\"artifact-catalog.w\":318");

      // A drag widens the pane under the pointer.
      const seamBox = await seam.boundingBox();
      if (seamBox === null) throw new Error("The catalog seam has no geometry.");
      const seamX = seamBox.x + seamBox.width / 2;
      const seamY = seamBox.y + 200;
      await page.mouse.move(seamX, seamY);
      await page.mouse.down();
      await page.mouse.move(seamX + 60, seamY, {steps: 4});
      await page.mouse.up();
      await expect.poll(async () => Number(await seam.getAttribute("aria-valuenow")))
        .toBeGreaterThanOrEqual(370);

      // A double-click resets the default width and forgets the stored one.
      await seam.dblclick();
      await expect(seam).toHaveAttribute("aria-valuenow", "302");
      await expect.poll(() => storedPanels(page)).not.toContain("artifact-catalog.w");

      // Holding the seam at its minimum collapses the catalog to its rail.
      const minimumBox = await seam.boundingBox();
      if (minimumBox === null) throw new Error("The catalog seam has no geometry.");
      await page.mouse.move(minimumBox.x + minimumBox.width / 2, seamY);
      await page.mouse.down();
      await page.mouse.move(minimumBox.x - 240, seamY, {steps: 6});
      await page.waitForTimeout(1_300);
      await page.mouse.up();
      await expect(catalogPanel(page)).toHaveAttribute("data-panel-state", "railed");
      await expect(page.getByRole("button", {name: "Open artifact catalog"}))
        .toHaveAttribute("aria-keyshortcuts", "[");

      // The rail peeks over the canvas; Escape puts the peek away.
      await page.getByRole("button", {name: "Show the artifact catalog"}).click();
      await expect(page.locator('[data-panel-peek="artifact-catalog"]')).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator('[data-panel-peek="artifact-catalog"]')).toHaveCount(0);

      // `[` pins and unpins it from the keyboard.
      await page.keyboard.press("[");
      await expect(catalogPanel(page)).toHaveAttribute("data-panel-state", "pinned");
      await expect(catalog.getByRole("button", {name: "Collapse artifact catalog"}))
        .toHaveAttribute("aria-keyshortcuts", "[");
      await page.keyboard.press("[");
      await expect(catalogPanel(page)).toHaveAttribute("data-panel-state", "railed");
      await page.keyboard.press("[");
      await expect(catalogPanel(page)).toHaveAttribute("data-panel-state", "pinned");

      // Below 1024 px the catalog stands down to its rail, keeping the preference.
      await page.setViewportSize({height: 800, width: 1023});
      await expect(catalogPanel(page)).toHaveAttribute("data-panel-state", "railed");
      await page.setViewportSize({height: 800, width: 1024});
      await page.getByRole("button", {name: "Close inspector"}).click();
      await expect(catalogPanel(page)).toHaveAttribute("data-panel-state", "pinned");

      // On a phone the catalog is a sheet that opens on request and closes on a choice.
      await page.setViewportSize({height: 844, width: 390});
      await expect(catalog).toHaveCount(0);
      await page.getByRole("button", {name: "Open artifact catalog"}).click();
      await expect(catalogPanel(page)).toHaveAttribute("data-panel-state", "sheet");
      await catalog.getByRole("button", {name: /Layout fixture/u}).click();
      await expect(catalog).toHaveCount(0);

      // Reduced motion: the pane never animates its width.
      await page.setViewportSize(workspaceViewport);
      await page.emulateMedia({reducedMotion: "reduce"});
      await page.reload();
      // No visible animation: 0s, or the 0.01 ms the global reduced-motion rule forces.
      await expect.poll(() => catalogPanel(page).evaluate(
        (node) => Math.max(...getComputedStyle(node).transitionDuration.split(",").map((part) => Number.parseFloat(part))),
      )).toBeLessThanOrEqual(0.00001);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
  test("CMT-015-F: a pinned navigation rails itself when the catalog and a docked inspector need the width", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Nav budget</title><main><h1>Nav budget content</h1></main></html>",
        idempotencyKey: "cmt-015-nav-budget-fixture",
        name: "Nav budget fixture",
      });
      // The reader pinned the navigation open on an earlier visit.
      await fixture.context.addInitScript(() => {
        window.localStorage.setItem("artifact-review-panels", JSON.stringify({navMenu: true}));
      });
      await localLogin(fixture);
      await openReview(fixture, {artifactId: published.body.artifact.id, versionId: published.body.version.id});
      const page = fixture.page;
      const navigation = page.locator("[data-ac-left-nav]");
      await expect(navigation).toHaveAttribute("data-ac-left-nav", "expanded");
      // At 1680 px the inspector opens docked; 1280 px cannot fit an expanded nav beside both panes.
      await page.setViewportSize({height: 900, width: 1280});
      await expect(navigation).toHaveAttribute("data-ac-left-nav", "rail");
      await page.getByRole("button", {name: "Close inspector"}).click();
      await expect(navigation).toHaveAttribute("data-ac-left-nav", "expanded");
      await page.getByRole("button", {name: "Open inspector"}).click();
      await expect(navigation).toHaveAttribute("data-ac-left-nav", "rail");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
