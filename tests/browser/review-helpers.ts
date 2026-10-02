import {expect, type FrameLocator, type Locator, type Page} from "@playwright/test";
import {z} from "zod";

import type {BrowserFixture} from "./browser-fixture.js";

/**
 * Navigation and lookup helpers shared by the browser specs. Specs describe
 * what a reviewer does; when markup moves, only these helpers change.
 */

/** A review location; the project defaults to the local owner's Default project. */
export interface ReviewTarget {
  readonly artifactId?: string;
  readonly focus?: boolean;
  readonly path?: string;
  readonly projectId?: string;
  readonly versionId?: string;
}

export type InspectorTab = "Comments" | "Details" | "Files" | "Versions";

export type SettingsSection = "api-keys" | "mcp" | "members" | "project" | "public-links";

/** The review URL for a target, for pages other than the fixture's own. */
export function reviewHref(baseUrl: string, target: ReviewTarget): string {
  const parameters = new URLSearchParams({project: target.projectId ?? "prj_default"});
  if (target.artifactId !== undefined) parameters.set("artifact", target.artifactId);
  if (target.versionId !== undefined) parameters.set("version", target.versionId);
  if (target.path !== undefined) parameters.set("path", target.path);
  if (target.focus === true) parameters.set("view", "focus");
  return `${baseUrl}/review?${parameters.toString()}`;
}

/** Opens a review location in the fixture's page. */
export async function openReview(fixture: BrowserFixture, target: ReviewTarget): Promise<void> {
  await fixture.page.goto(reviewHref(fixture.server.baseUrl, target));
}

/** The isolated review-frame document that hosts the artifact and its annotation layer. */
export function isolatedReviewFrame(page: Page): FrameLocator {
  return annotationFrame(page);
}

/** Selectors axe must skip: artifact documents are not application UI. */
export const artifactFrameSelectors = [
  'iframe[src="/review-frame"]',
  'iframe[title^="Interactive preview: "]',
] as const;

/** The isolated `/review-frame` document that hosts Plannotator's annotation surface. */
export function annotationFrame(page: Page): FrameLocator {
  return page.frameLocator(artifactFrameSelectors[0]);
}

/** The artifact document itself, inside the review frame's opaque-origin sandbox. */
export function previewFrame(page: Page): FrameLocator {
  return annotationFrame(page).frameLocator("iframe");
}

/** The interactive preview: the version's own content origin, outside the review frame. */
export function interactiveFrame(page: Page): FrameLocator {
  return page.frameLocator(artifactFrameSelectors[1]);
}

/** Shows one inspector tab. */
/** One inspector view's toggle on the tab rail (RailTabs: aria-pressed buttons, not tabs). */
export function inspectorTabButton(
  page: Page,
  tab: "Comments" | "Details" | "Files" | "Versions",
): Locator {
  return page.getByRole("group", {name: "Inspector"})
    .getByRole("button", {name: new RegExp(`^${tab}(?: — \\d+)?$`, "u")});
}

export async function openInspectorTab(
  page: Page,
  tab: "Comments" | "Details" | "Files" | "Versions",
): Promise<void> {
  const toggle = inspectorTabButton(page, tab);
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
}

/**
 * Opens a settings screen on the server `page` is already showing. The
 * project screen opens the current `project` parameter, else Default.
 */
export async function openSettings(page: Page, section: SettingsSection): Promise<void> {
  const current = new URL(page.url());
  const pathname = section === "project"
    ? `/review/projects?project=${encodeURIComponent(current.searchParams.get("project") ?? "prj_default")}`
    : `/review/settings/${section}`;
  await page.goto(new URL(pathname, current.origin).toString());
}

let cspCollectors = 0;
const cspConsoleReport = /Content[ -]Security[ -]Policy/iu;

/**
 * Records every Content Security Policy violation in every frame of `page`:
 * `securitypolicyviolation` events and the engine's console reports. Await the
 * returned reader once before the first navigation it must cover; each call
 * returns the violations seen so far.
 */
export function collectCspViolations(page: Page): () => Promise<readonly string[]> {
  cspCollectors += 1;
  const binding = `reportCspViolation${cspCollectors}`;
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && cspConsoleReport.test(message.text())) {
      violations.push(`console: ${message.text()}`);
    }
  });
  const ready = Promise.all([
    page.exposeBinding(binding, (_source, report: string) => {
      violations.push(z.string().parse(report));
    }),
    page.addInitScript({
      content: `document.addEventListener("securitypolicyviolation", (event) => {
        window[${JSON.stringify(binding)}](
          event.effectiveDirective + " blocked " + (event.blockedURI || "inline") + " in " + event.documentURI,
        );
      });`,
    }),
  ]);
  return async () => {
    await ready;
    return [...violations];
  };
}

/** The toolbar breadcrumb's version crumb, which opens "Choose a version". */
export function versionCrumb(page: Page): Locator {
  return page.getByRole("toolbar", {exact: true, name: "Artifact"})
    .getByRole("button", {name: /^Version \d+, .* · Choose a version$/u});
}

/** The toolbar breadcrumb's page crumb, which opens "Choose a page". */
export function pageCrumb(page: Page): Locator {
  return page.getByRole("toolbar", {exact: true, name: "Artifact"})
    .getByRole("button", {name: /^Page .* · Choose a page$/u});
}

/** One conversation in the Comments panel, by text it contains. */
export function commentThread(page: Page, text: string): Locator {
  return page.getByRole("article", {name: /^Comment by /u}).filter({hasText: text});
}

/** Selects a conversation in the Comments panel: it opens, and the docked composer replies to it. */
export async function selectThread(page: Page, text: string): Promise<void> {
  const summary = commentThread(page, text).locator('[role="button"][aria-expanded]').first();
  if (await summary.getAttribute("aria-expanded") !== "true") await summary.click();
  await expect(summary).toHaveAttribute("aria-expanded", "true");
}

/** The Versions panel's history list. */
export function versionsList(page: Page): Locator {
  return page.getByRole("complementary", {name: "Artifact inspector"}).getByRole("region", {name: /^Versions of /u});
}

/** One version's row in the Versions panel: its preview button, actions and Current tag. */
export function versionRow(page: Page, number: number): Locator {
  return versionsList(page).locator("[data-row-actions-host]")
    .filter({has: page.getByRole("button", {name: new RegExp(`^v${number} `, "u")})});
}

/** Chooses one item of a version row's More menu (Make Current, Compare with vN, Action History). */
export async function chooseVersionAction(page: Page, number: number, action: string | RegExp): Promise<void> {
  await openInspectorTab(page, "Versions");
  await versionRow(page, number).getByRole("button", {name: `More actions for v${number}`}).click();
  await page.getByRole("menu", {name: `More actions for v${number}`}).getByRole("menuitem", {name: action}).click();
}

/** Makes a version current from its row and confirms. */
export async function makeVersionCurrent(page: Page, number: number): Promise<void> {
  await chooseVersionAction(page, number, "Make Current");
  await page.getByRole("dialog", {name: `Make Version ${number} current?`}).getByRole("button", {name: "Make Current"}).click();
}

/** Deletes the open artifact from Details and confirms. */
export async function deleteOpenArtifact(page: Page, name: string): Promise<void> {
  await openInspectorTab(page, "Details");
  await page.getByRole("complementary", {name: "Artifact inspector"}).getByRole("button", {name: "Delete Artifact"}).click();
  await page.getByRole("dialog", {name: `Delete ${name}?`}).getByRole("button", {name: "Delete Artifact"}).click();
}

/** Opens the page crumb's "Choose a page" menu. */
export async function openPageMenu(page: Page): Promise<Locator> {
  await pageCrumb(page).click();
  const menu = page.getByRole("dialog", {name: "Choose a page"});
  await expect(menu).toBeVisible();
  return menu;
}

/** The Gallery row pinned at the top of the page menu while a version has a gallery. */
export function galleryRow(menu: Locator): Locator {
  return menu.getByRole("button", {name: /^Gallery\b/u});
}

/** Focus hides the toolbar; its viewer controls keep their own way back to the gallery. */
async function inFocus(page: Page): Promise<boolean> {
  return await page.getByRole("toolbar", {name: "Artifact viewer controls"}).count() > 0;
}

/** Returns to the version's gallery: the page menu's Gallery row, or Focus's Back to gallery. */
export async function returnToGallery(page: Page): Promise<void> {
  if (await inFocus(page)) {
    await page.getByRole("toolbar", {name: "Artifact viewer controls"}).getByRole("button", {name: "Back to gallery"}).click();
    return;
  }
  await galleryRow(await openPageMenu(page)).click();
}

/** Checks whether the way back to a gallery is offered, closing the page menu after looking. */
export async function expectGalleryReturn(page: Page, offered: boolean): Promise<void> {
  if (await inFocus(page)) {
    await expect(page.getByRole("button", {name: "Back to gallery"})).toHaveCount(offered ? 1 : 0);
    return;
  }
  const menu = await openPageMenu(page);
  await expect(galleryRow(menu)).toHaveCount(offered ? 1 : 0);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
}

/** Open the toolbar's More menu and return it. */
export async function openMoreMenu(page: Page): Promise<Locator> {
  const menu = page.getByRole("menu", {name: "More artifact actions"});
  if (!(await menu.isVisible())) {
    await page.getByRole("toolbar", {exact: true, name: "Artifact"})
      .getByRole("button", {name: "More artifact actions"}).click();
  }
  await expect(menu).toBeVisible();
  return menu;
}

/** Refresh threads, sends and presence through the More menu's Reload. */
export async function reloadReview(page: Page): Promise<void> {
  const menu = await openMoreMenu(page);
  await menu.getByRole("menuitem", {exact: true, name: "Reload"}).click();
  await expect(menu).toHaveCount(0);
}

/** Open Comparison and history from the toolbar's More menu and choose one tab. */
export async function openComparison(page: Page, tab: "Compare" | "Activity"): Promise<void> {
  const view = page.getByRole("region", {name: "Comparison and history"});
  if (!(await view.isVisible())) {
    await page.getByRole("toolbar", {exact: true, name: "Artifact"})
      .getByRole("button", {name: "More artifact actions"}).click();
    await page.getByRole("menu", {name: "More artifact actions"})
      .getByRole("menuitem", {name: "Comparison and history"}).click();
    await expect(view).toBeVisible();
  }
  const control = view.getByRole("tab", {exact: true, name: tab});
  await control.click();
  await expect(control).toHaveAttribute("aria-selected", "true");
}

/**
 * One toast in the DS ToastRegion. Scoped to the drawn toast so the region's
 * visually hidden live-region copy of the same sentence never makes the
 * locator ambiguous.
 */
export function toast(page: Page, text: string | RegExp): Locator {
  return page.locator("[data-ak-toast-region] [data-ak-toast-motion]").filter({hasText: text});
}

/**
 * Wait until no CSS transition or animation is running. DS controls animate their ink
 * and fills across state and theme changes; accessibility scans read the settled page.
 */
export async function waitForSettledPaint(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
}
