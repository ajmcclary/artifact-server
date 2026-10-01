import {expect, test, type Page} from "@playwright/test";

import {publishNew} from "../support/publishing.js";
import {localLogin, startBrowserFixture, stopBrowserFixture} from "./browser-fixture.js";
import {createThreadOverApi} from "./comment-api.js";

const forbidden = /prototype|fixture|demo|local example|browser-local|unavailable in/iu;

async function renderedCopy(page: Page): Promise<string> {
  return page.evaluate(() => {
    const labelled = [...document.querySelectorAll("[aria-label],[title],[placeholder]")]
      .flatMap((element) => ["aria-label", "title", "placeholder"]
        .map((name) => element.getAttribute(name) ?? ""));
    return [document.body.innerText, ...labelled].join("\n");
  });
}

test("new screens render no prototype annotation or disclaimer copy", async ({browser}) => {
  test.setTimeout(120_000);
  const fixture = await startBrowserFixture(browser);
  try {
    const published = await publishNew(fixture.server, fixture.installation, {
      accessSetting: "public_link",
      content: "<!doctype html><html lang=\"en\"><title>Copy walk</title><h1>Copy walk</h1></html>",
      idempotencyKey: "copy-walk-artifact",
      mediaType: "text/html; charset=utf-8",
      name: "Copy walk",
      path: "index.html",
    });
    await createThreadOverApi(fixture, {
      artifactId: published.body.artifact.id,
      body: "Check the heading.",
      idempotencyKey: "copy-walk-thread",
      versionId: published.body.version.id,
    });
    await localLogin(fixture);
    const page = fixture.page;
    const screens: readonly [string, string][] = [
      ["/review", "Activity"],
      ["/review/projects?project=prj_default", "Default"],
      ["/review/settings/members", "Members"],
      ["/review/settings/api-keys", "API keys"],
      ["/review/settings/public-links", "Public links"],
      ["/review/settings/mcp", "MCP & WebMCP"],
    ];
    // One page visits the screens in turn, collecting every offending line.
    const offenders = await screens.reduce(async (found, [path, heading]) => {
      const earlier = await found;
      await page.goto(`${fixture.server.baseUrl}${path}`);
      await expect(page.getByRole("heading", {exact: true, name: heading}).first()).toBeVisible();
      const copy = await renderedCopy(page);
      return [...earlier, ...copy.split("\n").filter((line) => forbidden.test(line)).map((line) => `${path}: ${line.trim()}`)];
    }, Promise.resolve<string[]>([]));
    expect(offenders).toEqual([]);
  } finally {
    await stopBrowserFixture(fixture);
  }
});
