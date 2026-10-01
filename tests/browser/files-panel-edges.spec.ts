import {expect, test, type Locator} from "@playwright/test";

import {
  commitStagedUpload,
  createStagedUpload,
  requireSuccessfulUploads,
  testSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {localLogin, startBrowserFixture, stopBrowserFixture} from "./browser-fixture.js";
import {openInspectorTab, openReview} from "./review-helpers.js";

async function box(locator: Locator): Promise<{readonly left: number; readonly right: number}> {
  const rect = await locator.boundingBox();
  if (rect === null) throw new Error("element has no layout box");
  return {left: rect.x, right: rect.x + rect.width};
}

test("Files panel: the version is a tree whose icons share one edge per level and whose sizes end at one edge", async ({browser}) => {
  const fixture = await startBrowserFixture(browser);
  try {
    const files = [
      testSiteFile("<!doctype html><title>Edges</title><h1>Edges</h1>", "text/html; charset=utf-8", "index.html"),
      testSiteFile("<!doctype html><title>About</title>", "text/html; charset=utf-8", "about.html"),
      testSiteFile("body{margin:0}", "text/css; charset=utf-8", "assets/app.css"),
      testSiteFile("<svg xmlns=\"http://www.w3.org/2000/svg\"/>", "image/svg+xml", "assets/logo.svg"),
    ];
    const upload = await createStagedUpload(fixture.server, fixture.installation, "index.html", files);
    await requireSuccessfulUploads(uploadEveryStagedFile(fixture.installation, upload.body, files));
    const published = await commitStagedUpload(fixture.installation, upload.body, "files-panel-edges", {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: "Files panel edges",
      tags: [],
    });

    await localLogin(fixture);
    await openReview(fixture, {
      artifactId: published.body.artifact.id,
      path: "assets/app.css",
      versionId: published.body.version.id,
    });
    await openInspectorTab(fixture.page, "Files");

    const tree = fixture.page.getByRole("complementary", {name: "Artifact inspector"})
      .getByRole("tree", {name: /^Files in version \d+$/u});
    const row = (level: number, label: string): Locator =>
      tree.locator(`[role="treeitem"][aria-level="${level}"]`).filter({hasText: new RegExp(`^${label.replaceAll(".", "\\.")}`, "u")});
    const folder = row(1, "assets");
    const selected = row(2, "app.css");
    // The folder holding the selected file opens itself; the selected file is the tree's selection.
    await expect(folder).toHaveAttribute("aria-expanded", "true");
    await expect(selected).toHaveAttribute("aria-selected", "true");
    // The inspector settles its width after opening; measure only once it stops moving.
    let previous = Number.NaN;
    await expect.poll(async () => {
      const left = (await box(tree)).left;
      const settled = left === previous;
      previous = left;
      return settled;
    }, {intervals: [100]}).toBe(true);

    // A chevron column keeps every icon of one level on one edge; each level steps in by 14px.
    const topIcon = await box(row(1, "index.html").locator("i.bi:not([data-tree-chevron])"));
    const folderIcon = await box(folder.locator("i.bi:not([data-tree-chevron])"));
    const nestedIcon = await box(row(2, "logo.svg").locator("i.bi:not([data-tree-chevron])"));
    expect(Math.abs(topIcon.left - folderIcon.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(nestedIcon.left - folderIcon.left - 14)).toBeLessThanOrEqual(1);
    // Sizes and the folder's file count end at one right edge (a pill such as Default page follows the size).
    const sizes = await Promise.all([row(1, "about.html"), folder, row(2, "logo.svg")].map((item) => box(item.locator("[data-tree-meta]"))));
    expect(Math.max(...sizes.map((size) => size.right)) - Math.min(...sizes.map((size) => size.right))).toBeLessThanOrEqual(1);
    await expect(folder.locator("[data-tree-meta]")).toHaveText("2 files");
    await expect(row(1, "index.html")).toContainText("Default page");
  } finally {
    await stopBrowserFixture(fixture);
  }
});
