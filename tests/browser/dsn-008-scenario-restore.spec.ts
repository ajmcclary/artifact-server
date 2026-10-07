import {expect, test} from "@playwright/test";

import {createThreadOverApi} from "./comment-api.js";
import {localLogin, startBrowserFixture, stopBrowserFixture, type BrowserFixture} from "./browser-fixture.js";
import {annotationFrame, previewFrame, reviewHref} from "./review-helpers.js";
import {publishScenarioFixture} from "./scenario-fixture.js";

let fixture: BrowserFixture;

test.beforeEach(async ({browser}) => {
  fixture = await startBrowserFixture(browser);
  await localLogin(fixture);
});

test.afterEach(async () => {
  await stopBrowserFixture(fixture);
});

function scenarioUrl(published: Awaited<ReturnType<typeof publishScenarioFixture>>, path: string, scenario?: string): string {
  const href = reviewHref(fixture.server.baseUrl, {artifactId: published.artifact.id, path, versionId: published.version.id});
  return scenario === undefined ? href : `${href}&scenario=${scenario}`;
}

test("DSN-008-B: the picker and a scenario link open a designed scenario that the page confirms", async () => {
  const published = await publishScenarioFixture(fixture, "dsn-008-b");
  const {page} = fixture;
  await page.goto(scenarioUrl(published, "honest.html"));
  const picker = page.getByRole("combobox", {name: "Designed scenario"});
  await expect(picker).toHaveValue("1");
  await expect(previewFrame(page).getByRole("heading", {name: "Library"})).toBeVisible();

  await picker.selectOption("5");
  await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible();
  await expect(page).toHaveURL(/[?&]scenario=5(?:&|$)/u);

  await page.goto(scenarioUrl(published, "honest.html", "5"));
  await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible();
  await expect(picker).toHaveValue("5");

  // A scenario changed from inside the page moves the picker with it.
  await page.goto(scenarioUrl(published, "honest.html", "1"));
  await previewFrame(page).getByRole("button", {name: "Open Logic"}).click();
  await expect(previewFrame(page).getByRole("heading", {name: "Logic"})).toBeVisible();
  await expect(picker).toHaveValue("6");
  await expect(annotationFrame(page).locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
});

test("DSN-008-F: a page without an adapter, a silent page and a lying page never change silently", async () => {
  const published = await publishScenarioFixture(fixture, "dsn-008-f");
  const {page} = fixture;

  await page.goto(scenarioUrl(published, "no-adapter.html", "5"));
  await expect(page.getByRole("status").filter({hasText: "Couldn't open scenario 5 (no-adapter)"})).toBeVisible({timeout: 10_000});
  await expect(previewFrame(page).getByRole("heading", {name: "Library"})).toBeVisible();

  await page.goto(scenarioUrl(published, "silent.html", "5"));
  await expect(page.getByRole("status").filter({hasText: "Couldn't open scenario 5 (timeout)"})).toBeVisible({timeout: 15_000});
  await expect(previewFrame(page).getByRole("heading", {name: "Library"})).toBeVisible();

  await page.goto(scenarioUrl(published, "liar.html", "5"));
  await expect(page.getByRole("status").filter({hasText: "Couldn't open scenario 5 (scenario-mismatch)"})).toBeVisible({timeout: 10_000});
});

test("a page with views but no adapter behaves as before, with no scenario controls", async () => {
  const published = await publishScenarioFixture(fixture, "no-adapter-plain-open");
  const {page} = fixture;
  await createThreadOverApi(fixture, {
    anchor: {htmlAnchor: {selector: "#root", tagName: "main"}, originalText: ""},
    artifactId: published.artifact.id,
    body: "A comment from before views.",
    idempotencyKey: "thread-no-adapter-legacy",
    path: "no-adapter.html",
    versionId: published.version.id,
  });
  await page.goto(scenarioUrl(published, "no-adapter.html"));
  // Comments are placed once the adapter wait ends, so the outcome is settled here.
  await expect(previewFrame(page).locator("[data-plannotator-marker]")).toHaveCount(1, {timeout: 10_000});
  await expect(page.getByRole("combobox", {name: "Designed scenario"})).toHaveCount(0);
  await expect(page.getByRole("status").filter({hasText: "Couldn't open scenario"})).toHaveCount(0);
});
