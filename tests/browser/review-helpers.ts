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
    ? `/review/settings/projects/${encodeURIComponent(current.searchParams.get("project") ?? "prj_default")}`
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

/** Open Comparison and history from the toolbar's version menu and choose one tab. */
export async function openComparison(page: Page, tab: "Compare" | "Activity"): Promise<void> {
  const view = page.getByRole("region", {name: "Comparison and history"});
  if (!(await view.isVisible())) {
    await page.getByRole("toolbar", {exact: true, name: "Artifact"})
      .getByRole("button", {name: /^Choose version, showing /u}).click();
    await page.getByRole("menu", {name: "Version"})
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
