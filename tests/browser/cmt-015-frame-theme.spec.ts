import {expect, test} from "@playwright/test";

import {publishNew} from "../support/publishing.js";
import {localLogin, startBrowserFixture, stopBrowserFixture} from "./browser-fixture.js";
import {annotationFrame, openReview, previewFrame} from "./review-helpers.js";

const themeModes = [
  {media: {colorScheme: "light", contrast: "no-preference"}, theme: "default"},
  {media: {colorScheme: "dark", contrast: "no-preference"}, theme: "dark"},
  {media: {colorScheme: "light", contrast: "more"}, theme: "high-contrast"},
] as const;

test("CMT-015-B CMT-015-F: ArkCase theme tokens reach the isolated review frame and follow every theme change", async ({browser}) => {
  const fixture = await startBrowserFixture(browser);
  try {
    const published = await publishNew(fixture.server, fixture.installation, {
      accessSetting: "account_required",
      content: "<!doctype html><html lang=\"en\"><title>Frame theme</title><main><h1>Frame theme target</h1></main></html>",
      idempotencyKey: "cmt-015-frame-theme",
      name: "Frame theme fixture",
    });
    const page = fixture.page;
    await page.emulateMedia(themeModes[0].media);
    await localLogin(fixture);
    await openReview(fixture, {
      artifactId: published.body.artifact.id,
      versionId: published.body.version.id,
    });
    await expect(previewFrame(page).getByRole("heading", {name: "Frame theme target"})).toBeVisible();

    const frameRoot = annotationFrame(page).locator("html");
    const shellToken = (token: string): Promise<string> => page.locator("html").evaluate(
      (node, name) => getComputedStyle(node).getPropertyValue(name).trim(),
      token,
    );
    const frameToken = (token: string): Promise<string> => frameRoot.evaluate(
      (node, name) => getComputedStyle(node).getPropertyValue(name).trim(),
      token,
    );
    // The default mode is "system", so the OS preference drives the theme and
    // the review must re-send tokens on every arkcase:themechange.
    const assertFrameFollows = async (mode: (typeof themeModes)[number]): Promise<string> => {
      await page.emulateMedia(mode.media);
      // The DS removes data-theme for its default (Light) theme.
      if (mode.theme === "default") {
        await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./u);
      } else {
        await expect(page.locator("html")).toHaveAttribute("data-theme", mode.theme);
      }
      const card = await shellToken("--surface-card");
      const primary = await shellToken("--bs-primary");
      const body = await shellToken("--text-body");
      const sans = await shellToken("--font-sans");
      await expect.poll(() => frameToken("--popover")).toBe(card);
      await expect.poll(() => frameToken("--background")).toBe(card);
      await expect.poll(() => frameToken("--primary")).toBe(primary);
      await expect.poll(() => frameToken("--foreground")).toBe(body);
      await expect.poll(() => frameToken("--font-sans")).toBe(sans);
      if (mode.theme === "dark") {
        await expect(frameRoot).not.toHaveClass(/\blight\b/u);
      } else {
        await expect(frameRoot).toHaveClass(/\blight\b/u);
      }
      return `${card}|${primary}`;
    };
    const lightPaint = await assertFrameFollows(themeModes[0]);
    const darkPaint = await assertFrameFollows(themeModes[1]);
    const contrastPaint = await assertFrameFollows(themeModes[2]);
    expect(new Set([lightPaint, darkPaint, contrastPaint]).size).toBe(3);
    await expect(previewFrame(page).getByRole("heading", {name: "Frame theme target"})).toBeVisible();
  } finally {
    await stopBrowserFixture(fixture);
  }
});
