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

test("Files panel: every icon shares one edge, folder files sit under the folder name, labels end at the same edge", async ({browser}) => {
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

    const inventory = fixture.page.getByRole("complementary", {name: "Artifact inspector"})
      .getByRole("region", {name: /^Files in version \d+$/u});
    const topLevel = inventory.getByRole("list", {name: "Top-level files"});
    const folderButton = inventory.getByRole("button", {name: /^assets\//u});
    const folderFiles = inventory.getByRole("list", {name: "Files in assets"});
    await expect(folderFiles).toBeVisible();

    const panel = await box(inventory);
    const topIcon = await box(topLevel.getByRole("listitem").first().locator("i.bi"));
    const folderIcon = await box(folderButton.locator("i.bi-folder"));
    const folderName = await box(folderButton.getByText("assets/", {exact: true}));
    const folderFileIcon = await box(folderFiles.getByRole("listitem").first().locator("i.bi"));
    const defaultLabel = await box(topLevel.getByText("Default page", {exact: true}));
    const selectedLabel = await box(folderFiles.getByText("Selected", {exact: true}));

    expect(Math.abs(topIcon.left - folderIcon.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(topIcon.left - panel.left - 14)).toBeLessThanOrEqual(1);
    expect(Math.abs(folderFileIcon.left - folderName.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(panel.right - defaultLabel.right - 14)).toBeLessThanOrEqual(1);
    expect(Math.abs(defaultLabel.right - selectedLabel.right)).toBeLessThanOrEqual(1);
  } finally {
    await stopBrowserFixture(fixture);
  }
});
