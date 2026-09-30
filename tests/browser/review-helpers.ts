import type {FrameLocator, Page} from "@playwright/test";
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
  return page.frameLocator(".as-artifact-frame");
}

/** The artifact's own document, inside the isolated review frame. */
export function previewFrame(page: Page): FrameLocator {
  return isolatedReviewFrame(page).frameLocator("iframe");
}

/** Shows one inspector tab. */
export async function openInspectorTab(page: Page, tab: InspectorTab): Promise<void> {
  await page.getByRole("tab", {name: tab}).click();
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
