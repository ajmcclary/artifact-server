import {randomUUID} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {expect, test} from "@playwright/test";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import {publishPath} from "../../src/client/file-publication-client.js";
import {writeClaudeDesignFixture, writeDesignCardFixture} from "../support/claude-design-fixture.js";
import {localLogin, startBrowserFixture, stopBrowserFixture} from "./browser-fixture.js";
import {interactiveFrame, openInspectorTab, previewFrame, returnToGallery, searchPreviews} from "./review-helpers.js";

for (const annotated of [false, true]) {
  test(`DSN-${annotated ? "002" : "001"}-B: browse a nested ${annotated ? "annotated" : "manifest"} system, run its scripts, search the gallery and open cards and templates in Review`, async ({browser}) => {
  const fixture = await startBrowserFixture(browser);
  const directory = await mkdtemp(path.join(tmpdir(), "claude-design-browser-"));
  try {
    await (annotated ? writeDesignCardFixture : writeClaudeDesignFixture)(directory, true);
    const published = await Effect.runPromise(publishPath({
      serverOrigin: fixture.server.baseUrl,
      apiToken: Redacted.make(fixture.installation.apiToken),
    }, {
      inputPath: directory,
      idempotencyKey: randomUUID(),
      target: {kind: "new_artifact", accessSetting: "account_required", tags: []},
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(NodeFileSystem.layer)));
    await localLogin(fixture);
    // The pathless Review URL lands on the native gallery; no generated catalog page exists.
    const page = fixture.page;
    await page.goto(published.links.review.toString());
    expect(published.version.entryPath).toBe("project/components/" + (annotated ? "buttons.card.html" : "card-button.html"));
    const title = annotated ? path.basename(directory) : "Example_System";
    const view = page.getByRole("region", {name: `${title} gallery`});
    // The review toolbar names the artifact, so the gallery shows no heading of its own.
    const toolbar = view.getByRole("toolbar", {name: "Gallery view"});
    await expect(toolbar).toBeVisible();
    await expect(view.getByRole("heading", {name: title})).toHaveCount(0);
    const button = view.getByRole("link", {name: "Open Primary button · Component · Actions"});
    await expect(button).toContainText("640 × 110");
    await searchPreviews(page, toolbar, "Screen");
    await expect(button).toBeHidden();
    await searchPreviews(page, toolbar, "absent");
    await expect(view.getByRole("link")).toHaveCount(0);
    await expect(view.getByText("Nothing matches these filters")).toBeVisible();
    await searchPreviews(page, toolbar, "");
    await page.screenshot({path: `test-results/browser/claude-design-${annotated ? "annotated" : "manifest"}-gallery.png`, fullPage: true});

    // A card opens as an exact page whose relative styles and scripts resolve from its original path.
    await button.click();
    await expect(previewFrame(page).getByRole("button", {name: "Try button"})).toHaveCSS("background-color", "rgb(20, 90, 60)");
    await page.getByRole("button", {name: "Exit full screen"}).click();
    await openInspectorTab(page, "Comments");
    await page.getByRole("group", {name: "HTML preview mode"}).getByRole("button", {name: "Interactive preview"}).click();
    const card = interactiveFrame(page);
    await card.getByRole("button", {name: "Try button"}).click();
    await expect(card.locator("output")).toHaveText("Clicked");
    await returnToGallery(page);
    await view.getByRole("link", {name: annotated ? "Open Screen · Artboard · Artboards" : "Open Screen · Template · Templates"}).click();
    await expect(page).toHaveURL(/path=project%2Ftemplates%2FScreen\.dc\.html/u);
    await expect(interactiveFrame(page).getByRole("heading", {name: "Template screen"})).toBeVisible();
  } finally {
    await stopBrowserFixture(fixture);
    await rm(directory, {recursive: true, force: true});
  }
});
}
