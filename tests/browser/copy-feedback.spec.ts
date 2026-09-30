import {expect, test, type Page} from "@playwright/test";

import {publishNew} from "../support/publishing.js";
import {localLogin, startBrowserFixture, stopBrowserFixture} from "./browser-fixture.js";
import {openReview, openSettings} from "./review-helpers.js";

/** A browser that refuses clipboard writes: an insecure context or a denied permission. */
async function refuseClipboardWrites(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async () => {
        throw new DOMException("Clipboard write refused.", "NotAllowedError");
      },
    });
  });
}

async function issueApiKey(page: Page): Promise<void> {
  await openSettings(page, "api-keys");
  await page.getByRole("button", {name: "Issue API key"}).click();
  await page.getByRole("textbox", {exact: true, name: "Name"}).fill("Copy feedback key");
  await page.getByLabel("Expires at", {exact: true}).fill("2099-01-01T00:00");
  await page.getByRole("checkbox", {name: /Read artifacts/u}).click();
  await page.getByRole("button", {exact: true, name: "Issue API key"}).last().click();
  await expect(page.getByRole("region", {name: "API key secret"})).toHaveText(/^as_key_/u);
}

test.describe("Copy feedback", () => {
  test("ADM-004-B ADM-004-F: a refused clipboard write never claims the one-time API key secret was copied", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const page = fixture.page;
      await refuseClipboardWrites(page);
      await localLogin(fixture);
      await issueApiKey(page);

      const secret = page.getByRole("dialog", {name: "Copy API key now"});
      const copy = secret.getByRole("button", {name: "Copy API key"});
      await copy.click();
      // The copied state swaps the clipboard glyph for a check for two seconds;
      // read it once, without retrying past that hold.
      expect(await secret.locator(".bi-check2").count()).toBe(0);
      await expect(page.getByText("API key copied")).toHaveCount(0);
      await expect(secret.getByRole("alert")).toContainText("did not copy the API key");
      await expect(secret.getByRole("region", {name: "API key secret"})).toHaveText(/^as_key_/u);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ADM-004-B: an accepted clipboard write copies the one-time API key secret and says so", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const page = fixture.page;
      await fixture.context.grantPermissions(["clipboard-read", "clipboard-write"], {origin: fixture.server.baseUrl});
      await localLogin(fixture);
      await issueApiKey(page);

      const secret = page.getByRole("dialog", {name: "Copy API key now"});
      const value = await secret.getByRole("region", {name: "API key secret"}).textContent();
      const copy = secret.getByRole("button", {name: "Copy API key"});
      await copy.click();
      await expect(secret.locator(".bi-check2")).toHaveCount(1);
      await expect(secret.getByRole("alert")).toHaveCount(0);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(value);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("a refused clipboard write in the share popover never shows the copied state", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const page = fixture.page;
      const published = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Copy feedback</title><h1>Copy feedback</h1></html>",
        idempotencyKey: "copy-feedback-share-fixture",
        mediaType: "text/html; charset=utf-8",
        name: "Copy feedback fixture",
        path: "index.html",
      })).body;
      await refuseClipboardWrites(page);
      await localLogin(fixture);
      await openReview(fixture, {artifactId: published.artifact.id, versionId: published.version.id});
      await page.getByRole("button", {exact: true, name: "Share"}).click();
      const share = page.getByRole("dialog");
      await share.getByRole("button", {name: "Connect MCP"}).click();
      const copy = share.getByRole("button", {name: "Copy MCP server address"});
      await copy.click();
      expect(await share.locator(".bi-check2").count()).toBe(0);
      await expect(share.getByRole("alert")).toContainText("did not copy the MCP server address");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
