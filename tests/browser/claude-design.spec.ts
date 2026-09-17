import {randomUUID} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {expect, test} from "@playwright/test";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import {publishPath} from "../../src/client/file-publication-client.js";
import {writeClaudeDesignFixture} from "../support/claude-design-fixture.js";
import {localLogin, startBrowserFixture, stopBrowserFixture} from "./browser-fixture.js";

test("DSN-001-B: browse a nested design system, run its scripts, search and switch templates in Review", async ({browser}) => {
  const fixture = await startBrowserFixture(browser);
  const directory = await mkdtemp(path.join(tmpdir(), "claude-design-browser-"));
  try {
    await writeClaudeDesignFixture(directory, true);
    const published = await Effect.runPromise(publishPath({
      serverOrigin: fixture.server.baseUrl,
      apiToken: Redacted.make(fixture.installation.apiToken),
    }, {
      inputPath: directory,
      idempotencyKey: randomUUID(),
      target: {kind: "new_artifact", accessSetting: "account_required", tags: []},
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(NodeFileSystem.layer)));
    await localLogin(fixture);
    await fixture.page.goto(published.links.review.toString());
    const catalog = fixture.page.locator(".as-html-preview").frameLocator("iframe");
    await expect(catalog.getByRole("heading", {name: "Example_System"})).toBeVisible();
    const card = catalog.frameLocator('iframe[name="design-preview"]');
    await expect(card.getByRole("button", {name: "Try button"})).toHaveCSS("background-color", "rgb(20, 90, 60)");
    await card.getByRole("button", {name: "Try button"}).click();
    await expect(card.locator("output")).toHaveText("Clicked");
    await expect(catalog.locator('iframe[name="design-preview"]')).toHaveAttribute("width", "640");
    await expect(catalog.locator('iframe[name="design-preview"]')).toHaveAttribute("height", "110");
    await catalog.getByRole("searchbox", {name: "Find a preview"}).fill("Screen");
    await expect(catalog.getByRole("link", {name: "Primary button", exact: true})).toBeHidden();
    await catalog.getByRole("link", {name: "Screen", exact: true}).click();
    await expect(card.getByRole("heading", {name: "Template screen"})).toBeVisible();
    await expect(catalog.getByRole("link", {name: "Open full preview"})).toHaveAttribute("href", /project\/templates\/Screen.dc.html$/u);
    await catalog.getByRole("searchbox").fill("absent");
    await expect(catalog.getByText("No matching previews.")).toBeVisible();
    await catalog.getByRole("searchbox").fill("");
    await fixture.page.screenshot({path: "test-results/browser/claude-design-catalog.png", fullPage: true});
    await catalog.getByRole("link", {name: "Open full preview"}).click();
    await expect(catalog.getByRole("heading", {name: "Template screen"})).toBeVisible();
  } finally {
    await stopBrowserFixture(fixture);
    await rm(directory, {recursive: true, force: true});
  }
});
