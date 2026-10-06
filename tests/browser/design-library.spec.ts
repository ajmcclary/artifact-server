import {randomUUID} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {expect, test, type Locator} from "@playwright/test";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import {publishPath, type FilePublicationTarget} from "../../src/client/file-publication-client.js";
import {previewSourceFixture, writePreviewSourceFixture} from "../support/claude-design-fixture.js";
import {ApiClient} from "../support/agent-dispatch.js";
import {localLogin, startBrowserFixture, stopBrowserFixture, type BrowserFixture} from "./browser-fixture.js";
import {interactiveFrame} from "./review-helpers.js";

// Every publish names its project: once a second project exists, the server asks which one.
function publish(fixture: BrowserFixture, inputPath: string, target: FilePublicationTarget, entryPath?: string, projectId = "prj_default") {
  const command = {inputPath, idempotencyKey: randomUUID(), projectId, target};
  return Effect.runPromise(publishPath(
    {serverOrigin: fixture.server.baseUrl, apiToken: Redacted.make(fixture.installation.apiToken)},
    entryPath === undefined ? command : {...command, entryPath},
  ).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(NodeFileSystem.layer)));
}
const top = async (locator: Locator) => (await locator.boundingBox())?.y ?? Number.NaN;
const named = (name: string): FilePublicationTarget => ({kind: "new_artifact", accessSetting: "account_required", name, tags: []});

test("DSN-005-B: the Library gathers every current gallery across all projects, dates pages from server records and opens exact pages", async ({browser}) => {
  const fixture = await startBrowserFixture(browser);
  const directory = await mkdtemp(path.join(tmpdir(), "design-library-browser-"));
  try {
    const claims = path.join(directory, "claims");
    await writePreviewSourceFixture(claims);
    const studio = path.join(directory, "studio");
    await writePreviewSourceFixture(studio);
    await writeFile(path.join(studio, "artifactserver.previews.json"), JSON.stringify({...previewSourceFixture(), title: "Portal Studio"}));
    const plain = path.join(directory, "plain");
    await mkdir(plain);
    await writeFile(path.join(plain, "index.html"), "<!doctype html><h1>Plain page</h1>");
    const broken = path.join(directory, "broken");
    await mkdir(path.join(broken, "artifact-server-previews"), {recursive: true});
    await writeFile(path.join(broken, "artifact-server-design.html"), "<!doctype html><h1>Old catalog</h1>");
    await writeFile(path.join(broken, "artifact-server-previews/index.json"), "{not json");

    const claimsPublished = await publish(fixture, claims, named("Claims Workspace"));
    const studioPublished = await publish(fixture, studio, named("Portal Studio"));
    await publish(fixture, plain, named("Plain page"));
    await publish(fixture, broken, named("Broken gallery"), "artifact-server-design.html");
    const portal = path.join(directory, "portal");
    await writePreviewSourceFixture(portal);
    await writeFile(path.join(portal, "artifactserver.previews.json"), JSON.stringify({...previewSourceFixture(), title: "Claimant Portal"}));
    const owner = new ApiClient(fixture.server, fixture.installation.apiToken);
    const portalProjectId = await owner.createProject("Portal project", "design-library-portal-project");
    const portalPublished = await publish(fixture, portal, named("Claimant Portal"), undefined, portalProjectId);
    // Version 2 changes only the claimant portal page, so only it gains activity; its creation stays at version 1.
    await writeFile(path.join(claims, "project/Portal.dc.html"), "<!doctype html><h1>Claimant portal, revised</h1>");
    const claimsRevised = await publish(fixture, claims, {kind: "new_version", artifactId: claimsPublished.artifact.id, expectedCurrentVersionId: claimsPublished.version.id});
    // A comment on one page of an older gallery makes that page the most recently active.
    const commented = await owner.fetch(
      `/api/v1/artifacts/${studioPublished.artifact.id}/versions/${studioPublished.version.id}/comments?projectId=${studioPublished.artifact.projectId}`,
      {body: JSON.stringify({body: "Tighten the button spacing.", path: "project/components/buttons.card.html"}), idempotencyKey: randomUUID(), method: "POST"},
    );
    expect(commented.status).toBe(201);
    await localLogin(fixture);
    const page = fixture.page;

    await page.getByRole("link", {exact: true, name: "Library"}).click();
    await expect(page).toHaveURL(/\/review\/library$/u);
    const library = page.getByRole("region", {name: "Library", exact: true});
    await expect(library.getByRole("heading", {name: "Library", level: 1})).toBeVisible();
    await expect(page.getByText("These galleries could not be read and are not shown: Broken gallery.")).toBeVisible();
    const toolbar = library.getByRole("toolbar", {name: "Library view"});
    // Grouped by date and sorted by last activity by default; everything here happened today.
    await expect(toolbar.getByRole("button", {name: "Group: Date"})).toBeVisible();
    // The order stays in the trigger's accessible name but not on screen.
    const sortTrigger = toolbar.getByRole("button", {name: "Sort: Last activity (newest)"});
    await expect(sortTrigger).toBeVisible();
    expect((await sortTrigger.getByText("(newest)").boundingBox())?.width).toBeLessThanOrEqual(1);
    // The filter menus sit shoulder to shoulder in one group.
    const filters = toolbar.getByRole("group", {name: "View and filters"});
    await expect(filters.getByRole("button")).toHaveText([/^Group: Date/u, /^Sort: Last activity/u, /^All projects/u, /^All types/u]);
    await expect(library.getByRole("button", {name: /^Today · 12/u})).toHaveAttribute("aria-expanded", "true");
    const tiles = library.locator("a[data-gallery-path]");
    await expect(tiles).toHaveCount(12);
    await expect(library.getByText("Plain page")).toHaveCount(0);
    const tile = (artifactId: string, pagePath: string) =>
      library.locator(`a[href*="artifact=${artifactId}"][href*="path=${encodeURIComponent(pagePath)}"]`);
    const claimsApp = tile(claimsPublished.artifact.id, "project/App.dc.html");
    await expect(claimsApp).toHaveAttribute("aria-label", "Open Examiner App · Prototype · Default");
    await expect.poll(() => claimsApp.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(16);
    const exact = new URL(await claimsApp.getAttribute("href") ?? "", page.url());
    expect(exact.pathname).toBe("/review");
    expect(exact.searchParams.get("artifact")).toBe(claimsPublished.artifact.id);
    expect(exact.searchParams.get("version")).toBe(claimsRevised.version.id);
    expect(exact.searchParams.get("path")).toBe("project/App.dc.html");

    const order = () => tiles.evaluateAll((links) => links.map((link) => {
      const url = new URL(link.getAttribute("href") ?? "", window.location.href);
      return `${url.searchParams.get("artifact")}:${url.searchParams.get("path")}`;
    }));
    const studioButton = `${studioPublished.artifact.id}:project/components/buttons.card.html`;
    const claimsPortal = `${claimsPublished.artifact.id}:project/Portal.dc.html`;
    // Last activity: the commented page, then the page version 2 changed, then the rest.
    expect((await order()).slice(0, 2)).toEqual([studioButton, claimsPortal]);
    // Date created ignores both: the claims pages were all first listed by the oldest version.
    await toolbar.getByRole("button", {name: "Sort: Last activity (newest)"}).click();
    await page.getByRole("menuitemradio", {name: "Date created"}).click();
    await expect(toolbar.getByRole("button", {name: "Sort: Date created (newest)"})).toBeVisible();
    await expect.poll(async () => (await order()).slice(-4).includes(claimsPortal)).toBe(true);
    expect((await order())[0]?.startsWith(`${portalPublished.artifact.id}:`)).toBe(true);
    // Name sorts A to Z by default and offers the reverse.
    await toolbar.getByRole("button", {name: "Sort: Date created (newest)"}).click();
    await page.getByRole("menuitemradio", {name: "Name"}).click();
    await expect(toolbar.getByRole("button", {name: "Sort: Name (A–Z)"})).toBeVisible();
    await toolbar.getByRole("button", {name: "Sort: Name (A–Z)"}).click();
    await page.getByRole("menuitemradio", {name: "Z to A"}).click();
    await expect(toolbar.getByRole("button", {name: "Sort: Name (Z–A)"})).toBeVisible();
    await expect(tiles.first()).toHaveAttribute("aria-label", /^Open Screen · Template/u);

    // Types filter by kind with counts. While filtering, a row under the toolbar counts the
    // matches, offers a removable chip per type and Clear filters, which hands focus back to Types.
    await toolbar.getByRole("button", {name: "All types"}).click();
    await page.getByRole("menuitemcheckbox", {name: "Components"}).click();
    await page.keyboard.press("Escape");
    await expect(toolbar.getByRole("button", {name: "Types · 1"})).toBeVisible();
    await expect(tiles).toHaveCount(3);
    const summary = library.locator("[data-active-filters='on']");
    await expect(summary).toContainText("Showing 3 of 12 previews");
    await expect(summary.getByRole("button", {name: "Remove Components filter"})).toBeVisible();
    await expect(toolbar.getByRole("button", {name: "Clear filters"})).toHaveCount(0);
    await summary.getByRole("button", {name: "Clear filters"}).click();
    await expect(tiles).toHaveCount(12);
    await expect(library.locator("[data-active-filters]")).toHaveCount(0);
    await expect(toolbar.getByRole("button", {name: "All types"})).toBeFocused();

    // Projects filter by the project each preview names, with counts; the match count is
    // announced, and the project's chip removes it.
    await toolbar.getByRole("button", {name: "All projects"}).click();
    await expect(page.getByRole("menuitemcheckbox", {name: /^Default/u})).toContainText("8");
    await page.getByRole("menuitemcheckbox", {name: /^Portal project/u}).click();
    await page.keyboard.press("Escape");
    await expect(toolbar.getByRole("button", {name: "Projects · 1"})).toBeVisible();
    await expect(tiles).toHaveCount(4);
    await expect(page.getByText("4 matching previews.")).toBeAttached();
    await expect(summary).toContainText("Showing 4 of 12 previews");
    await summary.getByRole("button", {name: "Remove Portal project filter"}).click();
    await expect(tiles).toHaveCount(12);
    await expect(toolbar.getByRole("button", {name: "All projects"})).toBeVisible();
    await expect(page.getByText("12 matching previews.")).toBeAttached();

    // Docked at the scroller's top, the toolbar leads with the page title and no preview count.
    await expect(toolbar.locator("[data-toolbar-title]")).toHaveCount(0);
    await library.evaluate((section) => section.scrollTo({top: 400}));
    await expect(toolbar.locator("[data-toolbar-title]")).toHaveText("Library");
    await expect(toolbar).not.toContainText(/\d+ previews?/u);
    await library.evaluate((section) => section.scrollTo({top: 0}));
    await expect(toolbar.locator("[data-toolbar-title]")).toHaveCount(0);

    // Group by project, collapse one project's band, switch to list and search.
    await toolbar.getByRole("button", {name: "Group: Date"}).click();
    await page.getByRole("menuitemradio", {name: "Project"}).click();
    const portalBand = library.getByRole("button", {name: /^Portal project · /u});
    await expect(library.getByRole("button", {name: /^Default · 8/u})).toBeVisible();
    // The band counts the previews it holds under the current filters.
    await expect(portalBand).toHaveAccessibleName(/^Portal project · 4/u);
    await portalBand.click();
    await expect(portalBand).toHaveAttribute("aria-expanded", "false");
    await expect(tiles).toHaveCount(8);
    await toolbar.getByRole("radio", {name: "List"}).click();
    await toolbar.getByRole("searchbox", {name: "Search previews"}).fill("portal studio");
    await expect(tiles).toHaveCount(4);
    await toolbar.getByRole("searchbox", {name: "Search previews"}).fill("examiner");
    await expect(tiles).toHaveCount(2);

    // Opening a page and coming back restores every choice and the tile left from.
    await claimsApp.click();
    await expect(page).toHaveURL(new RegExp(`artifact=${claimsPublished.artifact.id}.*path=project%2FApp\\.dc\\.html`, "u"));
    await expect(interactiveFrame(page).getByRole("heading", {name: "Examiner app"})).toBeVisible();
    await page.goBack();
    await expect(toolbar.getByRole("searchbox", {name: "Search previews"})).toHaveValue("examiner");
    await expect(toolbar.getByRole("button", {name: "Group: Project"})).toBeVisible();
    await expect(toolbar.getByRole("button", {name: "Sort: Name (Z–A)"})).toBeVisible();
    await expect(toolbar.getByRole("radio", {name: "List"})).toHaveAttribute("aria-checked", "true");
    await expect(portalBand).toHaveAccessibleName(/^Portal project · 1/u);
    await expect(portalBand).toHaveAttribute("aria-expanded", "false");
    await expect(claimsApp).toBeFocused();

    // A moving view: the icon-only Refresh follows the newly current version.
    const refresh = toolbar.getByRole("button", {name: "Refresh", exact: true});
    await expect(refresh).toHaveAttribute("title", /^Refresh · read /u);
    const next = await publish(fixture, claims, {kind: "new_version", artifactId: claimsPublished.artifact.id, expectedCurrentVersionId: claimsRevised.version.id});
    expect(new URL(await claimsApp.getAttribute("href") ?? "", page.url()).searchParams.get("version")).toBe(claimsRevised.version.id);
    await refresh.click();
    await expect.poll(async () => new URL(await claimsApp.getAttribute("href") ?? "", page.url()).searchParams.get("version")).toBe(next.version.id);

    // Search, Grid/List and Refresh form one right-aligned cluster. At 1024px, docked with its
    // title, the bar keeps one row; at 880px the search folds to an icon that opens the field.
    const search = toolbar.getByRole("searchbox", {name: "Search previews"});
    await search.fill("");
    await portalBand.click();
    await expect(tiles).toHaveCount(12);
    await page.setViewportSize({height: 700, width: 1024});
    await library.evaluate((section) => section.scrollTo({top: 400}));
    await expect(toolbar.locator("[data-toolbar-title]")).toHaveText("Library");
    await expect(search).toBeVisible();
    await expect.poll(async () => Math.abs(await top(toolbar.getByRole("button", {name: "Group: Project"})) - await top(refresh))).toBeLessThan(8);
    await page.setViewportSize({height: 700, width: 880});
    const folded = toolbar.getByRole("button", {exact: true, name: "Search previews"});
    await expect(folded).toBeVisible();
    await expect(search).toHaveCount(0);
    await expect.poll(async () => Math.abs(await top(folded) - await top(refresh))).toBeLessThan(8);
    await folded.click();
    const popoverSearch = page.getByRole("dialog", {name: "Search previews"}).getByRole("searchbox", {name: "Search previews"});
    await expect(popoverSearch).toBeFocused();
    await popoverSearch.fill("examiner");
    await expect(tiles).toHaveCount(3);
    await page.keyboard.press("Escape");
    await expect(folded).toBeFocused();
    // Folded with a query applied, the icon quotes it.
    await expect(folded).toHaveAttribute("title", "Search previews: “examiner”");
  } finally {
    await stopBrowserFixture(fixture);
    await rm(directory, {recursive: true, force: true});
  }
});

test("DSN-005: an installation with no galleries explains how they appear", async ({browser}) => {
  const fixture = await startBrowserFixture(browser);
  const directory = await mkdtemp(path.join(tmpdir(), "design-library-empty-"));
  try {
    // One plain artifact: the empty state counts the artifacts it examined, not galleries.
    await writeFile(path.join(directory, "index.html"), "<!doctype html><h1>Plain page</h1>");
    await publish(fixture, directory, named("Plain page"));
    await localLogin(fixture);
    await fixture.page.goto(`${fixture.server.baseUrl}/review/library`);
    await expect(fixture.page).toHaveURL(/\/review\/library$/u);
    await expect(fixture.page.getByRole("heading", {name: "No design galleries yet"})).toBeVisible();
    await expect(fixture.page.getByText("None of the 1 artifacts has a design gallery.")).toBeVisible();
    // A pre-rollup project link still opens the one library.
    await fixture.page.goto(`${fixture.server.baseUrl}/review/library?project=prj_default`);
    await expect(fixture.page.getByRole("heading", {name: "No design galleries yet"})).toBeVisible();
  } finally {
    await stopBrowserFixture(fixture);
    await rm(directory, {force: true, recursive: true});
  }
});

test("DSN-006-B: the Library loads in one request with no per-gallery reads", async ({browser}) => {
  const fixture = await startBrowserFixture(browser);
  const directory = await mkdtemp(path.join(tmpdir(), "design-library-one-request-"));
  try {
    const claims = path.join(directory, "claims");
    await writePreviewSourceFixture(claims);
    await publish(fixture, claims, named("Claims Workspace"));
    await localLogin(fixture);
    // A fresh page, so requests still in flight from the Review page localLogin opened are not counted.
    const page = await fixture.context.newPage();
    const apiPaths: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/v1/")) apiPaths.push(url.pathname);
    });
    await page.goto(`${fixture.server.baseUrl}/review/library`);
    const library = page.getByRole("region", {exact: true, name: "Library"});
    await expect(library.locator("a[data-gallery-path]").first()).toBeVisible();
    expect(apiPaths.filter((pathName) => pathName === "/api/v1/library")).toHaveLength(1);
    // Thumbnails still load through the media route; versions, manifests, indexes and comments must not.
    expect(apiPaths.filter((pathName) => /\/versions(\/[^/]+)?$|\/file$|\/comments/u.test(pathName))).toEqual([]);
  } finally {
    await stopBrowserFixture(fixture);
    await rm(directory, {force: true, recursive: true});
  }
});
