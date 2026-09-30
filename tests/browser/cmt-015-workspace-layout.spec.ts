import {expect, test, type Page} from "@playwright/test";

import {
  commitStagedUpload,
  createStagedUpload,
  publishNew,
  publishVersion,
  testSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  workspaceViewport,
} from "./browser-fixture.js";
import {inspectorTabButton, openInspectorTab, openReview, previewFrame} from "./review-helpers.js";

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
      // The one-second hold is measured in animation frames; keep holding until it fires.
      await expect(catalogPanel(page)).toHaveAttribute("data-panel-state", "railed", {timeout: 5_000});
      await page.mouse.up();
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
      await page.getByRole("button", {name: "Back to Default"}).click();
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
  test("CMT-015-B CMT-015-F: the toolbar switches the exact version and page and offers raw, download, share and full screen", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const files = [
        testSiteFile("<!doctype html><html lang=\"en\"><title>Home</title><main><h1>Pages home</h1></main></html>", undefined, "index.html"),
        testSiteFile("<!doctype html><html lang=\"en\"><title>About</title><main><h1>Pages about</h1></main></html>", undefined, "about.html"),
      ];
      const upload = await createStagedUpload(fixture.server, fixture.installation, "index.html", files);
      await uploadEveryStagedFile(fixture.installation, upload.body, files);
      const first = await commitStagedUpload(fixture.installation, upload.body, "cmt-015-toolbar-v1", {
        accessSetting: "account_required",
        kind: "new_artifact",
        name: "Pages fixture",
      });
      await publishVersion(fixture.server, fixture.installation, {
        artifactId: first.body.artifact.id,
        content: "<!doctype html><html lang=\"en\"><title>Home</title><main><h1>Pages second version</h1></main></html>",
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: "cmt-015-toolbar-v2",
      });
      await localLogin(fixture);
      await openReview(fixture, {artifactId: first.body.artifact.id});
      const page = fixture.page;
      const toolbar = page.getByRole("toolbar", {exact: true, name: "Artifact"});
      await expect(toolbar.getByRole("heading", {level: 1, name: "Pages fixture"})).toBeVisible();
      await expect(previewFrame(page).getByRole("heading", {name: "Pages second version"})).toBeVisible();

      await toolbar.getByRole("button", {name: /^Choose version, showing v2 of 2, current$/u}).click();
      const versionMenu = page.getByRole("menu", {name: "Version"});
      await expect(versionMenu.getByRole("menuitemradio", {name: /Version 2/u})).toHaveAttribute("aria-checked", "true");
      await versionMenu.getByRole("menuitemradio", {name: /Version 1/u}).click();
      await expect(previewFrame(page).getByRole("heading", {name: "Pages home"})).toBeVisible();
      expect(new URL(page.url()).searchParams.get("version")).toBe(first.body.version.id);

      await toolbar.getByRole("button", {name: /^Pages · index\.html · 2 pages$/u}).click();
      await page.getByRole("dialog", {name: "Pages"}).getByRole("button", {name: "Open page about.html"}).click();
      await expect(previewFrame(page).getByRole("heading", {name: "Pages about"})).toBeVisible();
      expect(new URL(page.url()).searchParams.get("path")).toBe("about.html");

      await expect(toolbar.getByRole("button", {name: "Open raw artifact"})).toBeEnabled();
      await expect(toolbar.getByRole("link", {exact: true, name: "Download"}))
        .toHaveAttribute("title", "Download 2 files as a ZIP");
      await expect(toolbar.getByRole("button", {name: "Full screen"})).toHaveAttribute("aria-keyshortcuts", "F");
      await expect(toolbar.getByRole("button", {name: "Close inspector"})).toHaveAttribute("aria-keyshortcuts", "]");
      await toolbar.getByRole("button", {name: "More artifact actions"}).click();
      await expect(page.getByRole("menu", {name: "More artifact actions"}).getByRole("menuitem", {name: "Delete artifact"})).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu", {name: "More artifact actions"})).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
  test("CMT-015-B CMT-015-F: the canvas offers only the preview widths that fit its column", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Preset fixture</title><main><h1>Preset fixture content</h1></main></html>",
        idempotencyKey: "cmt-015-preset-fixture",
        name: "Preset fixture",
      });
      await localLogin(fixture);
      await openReview(fixture, {
        artifactId: published.body.artifact.id,
        versionId: published.body.version.id,
      });
      const page = fixture.page;
      const widths = page.getByRole("toolbar", {name: "Preview controls"})
        .getByRole("group", {name: "Preview width"});
      const region = page.getByRole("region", {name: "Artifact preview"});
      await expect(widths.getByRole("button", {name: "Fit the column"})).toHaveAttribute("aria-pressed", "true");
      await expect(region).toHaveAttribute("data-preview-frame", "fit");
      await expect(widths.getByRole("button", {name: "1440 pixels wide"})).toHaveCount(0);

      await widths.getByRole("button", {name: "390 pixels wide"}).click();
      await expect(region).toHaveAttribute("data-preview-frame", "390");
      await expect.poll(async () => Math.round((await region.boundingBox())?.width ?? 0)).toBe(390);
      await expect(previewFrame(page).getByRole("heading", {name: "Preset fixture content"})).toBeVisible();

      // A wide screen with both panes put away has room for the desktop preset.
      await page.setViewportSize({height: 1000, width: 1920});
      await page.getByRole("button", {name: "Close inspector"}).click();
      await page.getByRole("complementary", {name: "Artifact catalog"})
        .getByRole("button", {name: "Collapse artifact catalog"}).click();
      await widths.getByRole("button", {name: "1440 pixels wide"}).click();
      await expect(region).toHaveAttribute("data-preview-frame", "1440");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
  test("CMT-015-B CMT-015-F: the inspector docks, resizes, floats, becomes a sheet and collapses to its tab rail", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Inspector fixture</title><main><h1>Inspector fixture content</h1></main></html>",
        idempotencyKey: "cmt-015-inspector-fixture",
        name: "Inspector fixture",
      });
      await localLogin(fixture);
      await openReview(fixture, {
        artifactId: published.body.artifact.id,
        versionId: published.body.version.id,
      });
      const page = fixture.page;
      const inspector = page.getByRole("complementary", {name: "Artifact inspector"});
      const inspectorPane = page.locator('[data-panel="artifact-inspector"]');
      await expect(inspectorPane).toHaveAttribute("data-panel-state", "pinned");
      await expect(inspectorTabButton(page, "Details")).toHaveAttribute("aria-pressed", "true");

      const seam = page.getByRole("separator", {name: "Resize the artifact inspector"});
      await expect(seam).toHaveAttribute("aria-valuenow", "392");
      await expect(seam).toHaveAttribute("aria-valuemin", "300");
      await expect(seam).toHaveAttribute("aria-valuemax", "560");
      await seam.focus();
      await page.keyboard.press("ArrowLeft");
      await expect(seam).toHaveAttribute("aria-valuenow", "408");
      await expect.poll(() => storedPanels(page)).toContain("\"artifact-inspector.w\":408");
      const seamBox = await seam.boundingBox();
      if (seamBox === null) throw new Error("The inspector seam has no geometry.");
      await page.mouse.move(seamBox.x + seamBox.width / 2, seamBox.y + 200);
      await page.mouse.down();
      await page.mouse.move(seamBox.x + seamBox.width / 2 - 40, seamBox.y + 200, {steps: 4});
      await page.mouse.up();
      await expect.poll(async () => Number(await seam.getAttribute("aria-valuenow")))
        .toBeGreaterThanOrEqual(440);

      // Pressing the open view again closes it; the rail stays.
      await inspectorTabButton(page, "Details").click();
      await expect(inspector).toHaveCount(0);
      await expect(page.getByRole("group", {name: "Inspector"})).toBeVisible();
      await expect(page.getByRole("button", {name: "Open inspector"})).toHaveAttribute("aria-keyshortcuts", "]");
      await page.keyboard.press("]");
      await expect(inspector).toBeVisible();
      await page.keyboard.press("]");
      await expect(inspector).toHaveCount(0);
      await openInspectorTab(page, "Comments");
      await expect(inspector.getByRole("complementary", {name: "Comments"})).toBeVisible();

      // Unpinned, it floats over the canvas's end edge and the catalog keeps its room.
      await inspector.getByRole("button", {name: "Unpin the inspector"}).click();
      await expect(inspectorPane).toHaveAttribute("data-panel-state", "floating");
      await expect.poll(() => storedPanels(page)).toContain("\"artifact-inspector\":false");
      await inspector.getByRole("button", {name: "Pin the inspector"}).click();
      await expect(inspectorPane).toHaveAttribute("data-panel-state", "pinned");

      // Laptop: the docked inspector wins the width; the catalog stands down to its rail.
      await page.setViewportSize({height: 900, width: 1280});
      await expect(inspectorPane).toHaveAttribute("data-panel-state", "pinned");
      await expect(catalogPanel(page)).toHaveAttribute("data-panel-state", "railed");

      // Tablet: it cannot dock, so it floats; Escape closes a floating inspector.
      await page.setViewportSize({height: 900, width: 900});
      await expect(inspectorPane).toHaveAttribute("data-panel-state", "floating");
      await page.keyboard.press("Escape");
      await expect(inspector).toHaveCount(0);

      // Phone: a sheet with its own close control.
      await page.setViewportSize({height: 844, width: 390});
      await page.getByRole("button", {name: "Open inspector"}).click();
      await expect(inspectorPane).toHaveAttribute("data-panel-state", "sheet");
      await page.getByRole("button", {name: "Close the inspector"}).click();
      await expect(inspector).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
