import {randomUUID} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {expect, test, type Page} from "@playwright/test";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import {publishPath, type FilePublicationTarget} from "../../src/client/file-publication-client.js";
import {createDesignCardCatalog} from "../../src/manifest/claude-design.js";
import {parseDesignCard} from "../../src/manifest/design-card.js";
import {writeDesignCardFixture, writePreviewSourceFixture} from "../support/claude-design-fixture.js";
import {localLogin, startBrowserFixture, stopBrowserFixture, type BrowserFixture} from "./browser-fixture.js";
import {listThreadsOverApi} from "./comment-api.js";
import {annotationFrame, interactiveFrame, openInspectorTab, previewFrame} from "./review-helpers.js";

const privateArtifact = {kind: "new_artifact", accessSetting: "account_required", tags: []} as const;

function publish(fixture: BrowserFixture, inputPath: string, target: FilePublicationTarget = privateArtifact, entryPath?: string) {
  const command = {inputPath, idempotencyKey: randomUUID(), target};
  return Effect.runPromise(publishPath(
    {serverOrigin: fixture.server.baseUrl, apiToken: Redacted.make(fixture.installation.apiToken)},
    entryPath === undefined ? command : {...command, entryPath},
  ).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(NodeFileSystem.layer)));
}

/** A publication made before preview indexes existed: the catalog is its only entry. */
async function writeLegacyCatalog(directory: string, index?: string): Promise<void> {
  await writeDesignCardFixture(directory);
  const cards = [parseDesignCard("components/buttons.card.html", '<!-- @dsCard group="Actions" viewport="640x110" name="Primary button" -->')];
  const paths = ["components/buttons.card.html", "templates/Screen.dc.html"];
  await writeFile(path.join(directory, "artifact-server-design.html"), createDesignCardCatalog(paths, cards, "Legacy system"));
  if (index === undefined) return;
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
    await expect(view.getByRole("heading", {name: "Claims Workspace", level: 2})).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);
    await expect(view.getByRole("heading", {level: 3})).toHaveText([/^Prototypes/u, /^Templates/u, /^Components/u]);

    const app = view.getByRole("link", {name: "Open Examiner App · Prototype · Prototypes"});
    const portal = view.getByRole("link", {name: "Open Claimant Portal · Prototype · Portal"});
    await expect.poll(() => app.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBe(16);
    await expect.poll(() => view.locator("header img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(16);
    await expect(portal.locator('[data-gallery-thumbnail="placeholder"]')).toBeAttached();
    await expect(portal).toContainText("1280 × 900");
    await expect(portal).toContainText("No thumbnail");
    const href = new URL(await app.getAttribute("href") ?? "", page.url());
    expect(href.searchParams.get("version")).toBe(published.version.id);
    expect(href.searchParams.get("path")).toBe("project/App.dc.html");

    await view.getByRole("searchbox", {name: "Find a preview"}).fill("starter");
    await expect(view.getByRole("link")).toHaveCount(1);
    await view.getByRole("searchbox", {name: "Find a preview"}).fill("");
    await view.getByRole("radio", {name: "List"}).click();
    await view.getByRole("button", {name: /^Prototypes/u}).click();
    await expect(view.getByRole("link")).toHaveCount(2);
    await page.screenshot({path: "test-results/browser/design-gallery-list.png"});

    await portal.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/path=project%2FPortal\.dc\.html/u);
    expect(new URL(page.url()).searchParams.get("version")).toBe(published.version.id);
    await expect(interactiveFrame(page).getByRole("heading", {name: "Claimant portal"})).toBeVisible();
    await expect(page.getByText("Claimant Portal · Prototype · Portal")).toBeVisible();

    await page.goBack();
    await expect(view.getByRole("radio", {name: "List"})).toHaveAttribute("aria-checked", "true");
    await expect(view.getByRole("link")).toHaveCount(2);
    await expect(portal).toBeFocused();
    await page.goForward();
    await expect(interactiveFrame(page).getByRole("heading", {name: "Claimant portal"})).toBeVisible();
    await page.getByRole("button", {name: "Back to gallery"}).click();
    await expect(view.getByRole("heading", {name: "Claims Workspace", level: 2})).toBeVisible();
    expect(new URL(page.url()).searchParams.has("path")).toBe(false);

    await app.click();
    // Claude Design artboards run their own runtime, so they open in the Interactive preview.
    const interactive = interactiveFrame(page);
    await interactive.getByRole("button", {name: "Try button"}).click();
    await expect(interactive.locator("output")).toHaveText("Clicked");
    // The reversible mode switch sits with the workspace comment controls.
    await page.getByRole("button", {name: "Exit full screen"}).click();
    await expect(page.getByText("Examiner App · Prototype · Prototypes")).toBeVisible();
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

    const catalogUrl = new URL(page.url());
    catalogUrl.searchParams.set("path", "artifact-server-design.html");
    await page.goto(catalogUrl.toString());
    await expect(interactiveFrame(page).getByRole("heading", {name: "Claims Workspace"})).toBeVisible();
    await expect(page.getByText("Original generated catalog")).toBeVisible();
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
    await expect(view.locator("header img")).toHaveCount(0);
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

test("DSN-004: pre-index publications keep their catalog, later versions gain the gallery, and bad indexes fall back", async ({browser}) => {
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
    await expect(page.getByRole("button", {name: "Back to gallery"})).toHaveCount(0);
    const current = new URL(legacy.links.review);
    current.searchParams.set("version", indexed.version.id);
    await page.goto(current.toString());
    await expect(gallery(page).getByRole("heading", {name: "Claims Workspace", level: 2})).toBeVisible();
    await page.goBack();
    await expect(interactiveFrame(page).getByRole("heading", {name: "Legacy system"})).toBeVisible();

    const hostile = [
      [JSON.stringify({format: "artifact-server.preview-index", version: 2}), /Preview index version 2 is not supported/u],
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
  } finally {
    await stopBrowserFixture(fixture);
    await rm(directory, {recursive: true, force: true});
  }
});
