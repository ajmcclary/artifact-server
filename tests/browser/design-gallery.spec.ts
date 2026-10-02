import {randomUUID} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {expect, test, type Page} from "@playwright/test";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import {publishPath, type FilePublicationTarget} from "../../src/client/file-publication-client.js";
import {writeDesignCardFixture, writePreviewSourceFixture} from "../support/claude-design-fixture.js";
import {localLogin, startBrowserFixture, stopBrowserFixture, type BrowserFixture} from "./browser-fixture.js";
import {listThreadsOverApi} from "./comment-api.js";
import {
  annotationFrame,
  expectGalleryReturn,
  interactiveFrame,
  openInspectorTab,
  previewFrame,
  returnToGallery,
  searchPreviews,
} from "./review-helpers.js";

const privateArtifact = {kind: "new_artifact", accessSetting: "account_required", tags: []} as const;

function publish(fixture: BrowserFixture, inputPath: string, target: FilePublicationTarget = privateArtifact, entryPath?: string) {
  const command = {inputPath, idempotencyKey: randomUUID(), target};
  return Effect.runPromise(publishPath(
    {serverOrigin: fixture.server.baseUrl, apiToken: Redacted.make(fixture.installation.apiToken)},
    entryPath === undefined ? command : {...command, entryPath},
  ).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(NodeFileSystem.layer)));
}

/** The catalog page older CLIs generated as a design publication's entry. */
const legacyCatalog = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="artifact-server-preview" content="claude-design-catalog"><title>Legacy system · Design System</title></head>
<body><h1>Legacy system</h1><a href="./components/buttons.card.html">Primary button</a></body></html>\n`;

/** A publication made by an older CLI: the catalog is its entry, with or without an index beside it. */
async function writeLegacyCatalog(directory: string, index?: string): Promise<void> {
  await writeDesignCardFixture(directory);
  await writeFile(path.join(directory, "artifact-server-design.html"), legacyCatalog);
  if (index === undefined) return;
  await writeIndex(directory, index);
}

async function writeIndex(directory: string, index: string): Promise<void> {
  await mkdir(path.join(directory, "artifact-server-previews"), {recursive: true});
  await writeFile(path.join(directory, "artifact-server-previews/index.json"), index);
}

function gallery(page: Page) {
  return page.getByRole("region", {name: "Claims Workspace gallery"});
}

test("DSN-004-B: open design previews from the native gallery as exact Review pages and return with state", async ({browser}) => {
  const fixture = await startBrowserFixture(browser);
  const directory = await mkdtemp(path.join(tmpdir(), "design-gallery-browser-"));
  try {
    await writePreviewSourceFixture(directory);
    const published = await publish(fixture, directory);
    await localLogin(fixture);
    await fixture.page.goto(published.links.review.toString());
    const page = fixture.page;
    const view = gallery(page);
    const toolbar = view.getByRole("toolbar", {name: "Gallery view"});
    await expect(toolbar).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);
    // The Library's design, scoped to this artifact. The review toolbar already names the
    // artifact, so the gallery has no heading, no docked title, and its bands are level 2.
    await expect(view.getByRole("heading", {name: "Claims Workspace"})).toHaveCount(0);
    await expect(view.getByRole("heading", {level: 1})).toHaveCount(0);
    await expect(view.locator("header img")).toHaveCount(0);
    await expect(toolbar.locator("[data-toolbar-title]")).toHaveCount(0);
    await expect(view.getByRole("heading", {level: 2})).toHaveText([/^Prototypes/u, /^Templates/u, /^Components/u]);
    await expect(view.getByRole("heading", {level: 3})).toHaveCount(0);
    // Group, Sort and Types, defaulting to Artifact type and Name A–Z; no Projects menu and no Refresh.
    await expect(toolbar.getByRole("group", {name: "View and filters"}).getByRole("button"))
      .toHaveText([/^Group: Artifact type/u, /^Sort: Name/u, /^All types/u]);
    await expect(toolbar.getByRole("button", {name: "Sort: Name (A–Z)"})).toBeVisible();
    await expect(toolbar.getByRole("button", {name: "Refresh", exact: true})).toHaveCount(0);

    const tiles = view.locator("[data-gallery-path]");
    const app = view.getByRole("link", {name: "Open Examiner App · Prototype · Prototypes"});
    const portal = view.getByRole("link", {name: "Open Claimant Portal · Prototype · Portal"});
    const button = view.getByRole("link", {name: "Open Primary button · Component · Actions"});
    await expect.poll(() => app.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBe(16);
    await expect(portal.locator('[data-gallery-thumbnail="placeholder"]')).toBeAttached();
    await expect(portal).toContainText("1280 × 900");
    // Grid tiles name their section and count their guides; pages are dated as of this version.
    await expect(button).toContainText("Actions");
    await expect(button).toContainText("2 guides");
    await expect(app).toContainText(/Last activity\s*\d{2}\/\d{2}\/\d{4}/u);
    const href = new URL(await app.getAttribute("href") ?? "", page.url());
    expect(href.searchParams.get("version")).toBe(published.version.id);
    expect(href.searchParams.get("path")).toBe("project/App.dc.html");

    await searchPreviews(page, toolbar, "starter");
    await expect(tiles).toHaveCount(1);
    await expect(page.getByText("1 matching previews.")).toBeAttached();
    await searchPreviews(page, toolbar, "");
    await expect(tiles).toHaveCount(4);

    // Types filter by kind; the summary row's Clear filters restores every preview.
    await toolbar.getByRole("button", {name: "All types"}).click();
    await page.getByRole("menuitemcheckbox", {name: "Components"}).click();
    await page.keyboard.press("Escape");
    await expect(toolbar.getByRole("button", {name: "Types · 1"})).toBeVisible();
    await expect(tiles).toHaveCount(1);
    await expect(button).toBeVisible();
    const summary = view.locator("[data-active-filters='on']");
    await expect(summary.getByRole("button", {name: "Remove Components filter"})).toBeVisible();
    await summary.getByRole("button", {name: "Clear filters"}).click();
    await expect(tiles).toHaveCount(4);
    await expect(toolbar.getByRole("button", {name: "All types"})).toBeFocused();

    // Section replaces Project: bands follow the index's first-seen order, and tiles drop the
    // section their band already names.
    await toolbar.getByRole("button", {name: "Group: Artifact type"}).click();
    await expect(page.getByRole("menuitemradio", {name: "Project"})).toHaveCount(0);
    await page.getByRole("menuitemradio", {name: "Section"}).click();
    await expect(toolbar.getByRole("button", {name: "Group: Section"})).toBeVisible();
    await expect(view.getByRole("heading", {level: 2})).toHaveText([/^Prototypes/u, /^Portal/u, /^Starter templates/u, /^Actions/u]);
    await expect(button).not.toContainText("Actions");

    await toolbar.getByRole("radio", {name: "List"}).click();
    await view.getByRole("button", {name: /^Prototypes/u}).click();
    await expect(tiles).toHaveCount(3);
    await page.screenshot({path: "test-results/browser/design-gallery-list.png"});

    await portal.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/path=project%2FPortal\.dc\.html/u);
    expect(new URL(page.url()).searchParams.get("version")).toBe(published.version.id);
    await expect(interactiveFrame(page).getByRole("heading", {name: "Claimant portal"})).toBeVisible();
    await expectGalleryReturn(page, true);

    // Browser Back and the page menu's Gallery row restore grouping, layout and collapsed
    // groups, and focus the tile left from.
    await page.goBack();
    await expect(toolbar.getByRole("radio", {name: "List"})).toHaveAttribute("aria-checked", "true");
    await expect(toolbar.getByRole("button", {name: "Group: Section"})).toBeVisible();
    await expect(tiles).toHaveCount(3);
    await expect(portal).toBeFocused();
    await page.goForward();
    await expect(interactiveFrame(page).getByRole("heading", {name: "Claimant portal"})).toBeVisible();
    await returnToGallery(page);
    await expect(toolbar.getByRole("button", {name: "Group: Section"})).toBeVisible();
    await expect(toolbar.getByRole("radio", {name: "List"})).toHaveAttribute("aria-checked", "true");
    await expect(tiles).toHaveCount(3);
    await expect(portal).toBeFocused();
    expect(new URL(page.url()).searchParams.has("path")).toBe(false);

    // In list view a row's guides link beneath it and open as exact text pages.
    const guides = view.getByRole("navigation", {name: "Guides for Primary button"});
    await expect(guides.getByRole("link")).toHaveText(["Button guide", "Button tokens"]);
    await guides.getByRole("link", {name: "Button guide"}).click();
    await expect(page).toHaveURL(/path=project%2Fcomponents%2FButton\.README\.md/u);
    await expect(page.getByLabel("Text of project/components/Button.README.md")).toContainText("Use one primary button per view.");
    await page.goBack();
    await expect(guides).toBeVisible();
    await expect(toolbar).toBeVisible();

    await view.getByRole("button", {name: /^Prototypes/u}).click();
    await app.click();
    // Claude Design artboards run their own runtime, so they open in the Interactive preview.
    const interactive = interactiveFrame(page);
    await interactive.getByRole("button", {name: "Try button"}).click();
    await expect(interactive.locator("output")).toHaveText("Clicked");
    // The reversible mode switch sits with the workspace comment controls.
    await page.getByRole("button", {name: "Exit full screen"}).click();
    await expectGalleryReturn(page, true);
    await openInspectorTab(page, "Comments");
    const mode = page.getByRole("group", {name: "HTML preview mode"});
    await expect(mode.getByRole("button", {name: "Interactive preview"})).toHaveAttribute("aria-pressed", "true");
    await mode.getByRole("button", {name: "Annotate"}).click();
    const preview = previewFrame(page);
    await expect(preview.getByRole("button", {name: "Try button"})).toHaveCSS("background-color", "rgb(20, 90, 60)");
    await preview.getByRole("heading", {name: "Examiner app"}).click();
    const composer = annotationFrame(page).getByPlaceholder("Add a comment...");
    await composer.fill("Tighten the claim header.");
    await annotationFrame(page).getByRole("button", {name: "Save"}).click();
    await expect(async () => {
      const threads = await listThreadsOverApi(fixture, published.artifact.id);
      expect(threads.map((thread) => [thread.body, thread.path])).toEqual([["Tighten the claim header.", "project/App.dc.html"]]);
    }).toPass();

    // The version's entry is its first preview, an ordinary exact page; no catalog page is published.
    expect(published.version.entryPath).toBe("project/App.dc.html");
  } finally {
    await stopBrowserFixture(fixture);
    await rm(directory, {recursive: true, force: true});
  }
});

test("DSN-004: the gallery fits phone widths without horizontal scrolling and restores scroll on return", async ({browser}) => {
  const fixture = await startBrowserFixture(browser);
  const directory = await mkdtemp(path.join(tmpdir(), "design-gallery-phone-"));
  try {
    await writePreviewSourceFixture(directory);
    const published = await publish(fixture, directory);
    await localLogin(fixture);
    await fixture.page.setViewportSize({width: 390, height: 844});
    await fixture.page.goto(published.links.review.toString());
    const view = gallery(fixture.page);
    const last = view.getByRole("link", {name: "Open Primary button · Component · Actions"});
    await expect(last).toBeVisible();
    await expect(view.getByRole("heading", {name: "Claims Workspace"})).toHaveCount(0);
    expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const boxes = await view.getByRole("link").evaluateAll((links) => links.map((link) => link.getBoundingClientRect().left));
    expect(new Set(boxes.map(Math.round)).size).toBe(1);
    await view.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await view.evaluate((element) => element.dispatchEvent(new Event("scroll")));
    const scrolled = await view.evaluate((element) => element.scrollTop);
    expect(scrolled).toBeGreaterThan(0);
    await fixture.page.screenshot({path: "test-results/browser/design-gallery-phone.png"});
    await last.click();
    await expect(fixture.page).toHaveURL(/path=project%2Fcomponents%2Fbuttons\.card\.html/u);
    await fixture.page.goBack();
    await expect(last).toBeFocused();
    await expect.poll(() => view.evaluate((element) => element.scrollTop)).toBe(scrolled);
  } finally {
    await stopBrowserFixture(fixture);
    await rm(directory, {recursive: true, force: true});
  }
});

test("DSN-004: older catalog publications keep their catalog, later versions gain the gallery, and bad indexes fall back", async ({browser}) => {
  const fixture = await startBrowserFixture(browser);
  const directory = await mkdtemp(path.join(tmpdir(), "design-gallery-compat-"));
  try {
    const legacyPath = path.join(directory, "legacy");
    await writeLegacyCatalog(legacyPath);
    const legacy = await publish(fixture, legacyPath, privateArtifact, "artifact-server-design.html");
    const indexedPath = path.join(directory, "indexed");
    await writePreviewSourceFixture(indexedPath);
    const indexed = await publish(fixture, indexedPath, {
      kind: "new_version",
      artifactId: legacy.artifact.id,
      expectedCurrentVersionId: legacy.version.id,
    });
    await localLogin(fixture);
    const page = fixture.page;

    await page.goto(legacy.links.review.toString());
    await expect(interactiveFrame(page).getByRole("heading", {name: "Legacy system"})).toBeVisible();
    await expect(gallery(page)).toHaveCount(0);
    await expectGalleryReturn(page, false);
    const current = new URL(legacy.links.review);
    current.searchParams.set("version", indexed.version.id);
    await page.goto(current.toString());
    await expect(gallery(page).getByRole("toolbar", {name: "Gallery view"})).toBeVisible();
    await page.goBack();
    await expect(interactiveFrame(page).getByRole("heading", {name: "Legacy system"})).toBeVisible();

    const hostile = [
      [JSON.stringify({format: "artifact-server.preview-index", version: 3}), /Preview index version 3 is not supported/u],
      ["{not json", /not valid JSON/u],
      [JSON.stringify({
        format: "artifact-server.preview-index", version: 1, origin: "producer", title: "Escape", description: "", cover: null,
        items: [{kind: "prototype", section: "S", title: "Up", description: "", path: "../outside.html", viewport: {width: 10, height: 10}, thumbnail: null}],
      }), /not an HTML file of this version/u],
    ] as const;
    const published = await Promise.all(hostile.map(async ([index]) => {
      const hostilePath = path.join(directory, `hostile-${randomUUID()}`);
      await writeLegacyCatalog(hostilePath, index);
      return publish(fixture, hostilePath, privateArtifact, "artifact-server-design.html");
    }));
    const visit = async (position: number): Promise<void> => {
      await page.goto(published[position]?.links.review.toString() ?? "");
      await expect(page.getByText(hostile[position]?.[1] ?? /unreachable/u)).toBeVisible();
      await expect(page.getByText(/Showing the original catalog\./u)).toBeVisible();
      await expect(interactiveFrame(page).getByRole("heading", {name: "Legacy system"})).toBeVisible();
    };
    // One page visits each publication in turn.
    await hostile.reduce<Promise<void>>((previous, _entry, position) => previous.then(() => visit(position)), Promise.resolve());

    // Without a legacy catalog, an unusable index falls back to the version's own entry page.
    const currentPath = path.join(directory, "current-hostile");
    await writeDesignCardFixture(currentPath);
    await writeIndex(currentPath, "{not json");
    const unreadable = await publish(fixture, currentPath, privateArtifact, "templates/Screen.dc.html");
    await page.goto(unreadable.links.review.toString());
    await expect(page.getByText(/not valid JSON\. Showing the first page\./u)).toBeVisible();
    await expect(interactiveFrame(page).getByRole("heading", {name: "Template screen"})).toBeVisible();
  } finally {
    await stopBrowserFixture(fixture);
    await rm(directory, {recursive: true, force: true});
  }
});
