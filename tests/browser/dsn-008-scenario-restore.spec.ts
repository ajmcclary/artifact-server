import {expect, test} from "@playwright/test";

import {createThreadOverApi} from "./comment-api.js";
import {localLogin, startBrowserFixture, stopBrowserFixture, type BrowserFixture} from "./browser-fixture.js";
import {annotateSwitch, annotationFrame, interactiveFrame, previewFrame, reviewHref, startAnnotating} from "./review-helpers.js";
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
  await expect(annotateSwitch(page)).toHaveAttribute("aria-pressed", "false");
  // Choosing a scenario asks for the annotation surface, the only one that can be told which to show.
  await picker.selectOption("5");
  await expect(annotateSwitch(page)).toHaveAttribute("aria-pressed", "true");
  await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible();
  await expect(page).toHaveURL(/[?&]scenario=5(?:&|$)/u);

  await page.goto(scenarioUrl(published, "honest.html", "5"));
  await startAnnotating(page);
  await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible();
  await expect(picker).toHaveValue("5");

  // A scenario the page changes itself moves the picker with it. An armed
  // annotation surface takes a click as a comment, so the page moves itself.
  await page.goto(scenarioUrl(published, "honest.html", "1"));
  await startAnnotating(page);
  await expect(previewFrame(page).getByRole("heading", {name: "Library"})).toBeVisible();
  await expect(picker).toHaveValue("1");
  await previewFrame(page).getByRole("button", {name: "Open Logic"}).evaluate((button) => {
    if (button instanceof HTMLButtonElement) button.onclick?.(new PointerEvent("click"));
  });
  await expect(previewFrame(page).getByRole("heading", {name: "Logic"})).toBeVisible();
  await expect(picker).toHaveValue("6");
  await expect(annotationFrame(page).locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
});

test("DSN-008-F: a page without an adapter, a silent page and a lying page never change silently", async () => {
  const published = await publishScenarioFixture(fixture, "dsn-008-f");
  const {page} = fixture;

  await page.goto(scenarioUrl(published, "no-adapter.html", "5"));
  await startAnnotating(page);
  await expect(page.getByRole("status").filter({hasText: "Couldn't open scenario 5: this page can't be told which scenario to show."})).toBeVisible({timeout: 10_000});
  await expect(previewFrame(page).getByRole("heading", {name: "Library"})).toBeVisible();

  await page.goto(scenarioUrl(published, "silent.html", "5"));
  await startAnnotating(page);
  await expect(page.getByRole("status").filter({hasText: "Couldn't open scenario 5: the page didn't confirm it in time."})).toBeVisible({timeout: 15_000});
  await expect(previewFrame(page).getByRole("heading", {name: "Library"})).toBeVisible();

  await page.goto(scenarioUrl(published, "liar.html", "5"));
  await startAnnotating(page);
  await expect(page.getByRole("status").filter({hasText: "Couldn't open scenario 5: the page showed a different scenario."})).toBeVisible({timeout: 10_000});
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
  await startAnnotating(page);
  // Comments are placed once the adapter wait ends, so the outcome is settled here.
  await expect(previewFrame(page).locator("[data-plannotator-marker]")).toHaveCount(1, {timeout: 10_000});
  await expect(page.getByRole("combobox", {name: "Designed scenario"})).toHaveCount(0);
  await expect(page.getByRole("status").filter({hasText: "Couldn't open scenario"})).toHaveCount(0);
});

test("DSN-008-F: a restore superseded by a later one is not reported as a failure", async () => {
  const published = await publishScenarioFixture(fixture, "dsn-008-f-overlap");
  const {page} = fixture;
  await page.goto(scenarioUrl(published, "overlapping.html"));
  await startAnnotating(page);
  const picker = page.getByRole("combobox", {name: "Designed scenario"});
  await expect(picker).toHaveValue("1");
  // Two requests in quick succession, as a scripted input plus change event produces.
  await picker.evaluate((select) => {
    if (!(select instanceof HTMLSelectElement)) throw new Error("The scenario picker is not a select.");
    select.value = "5";
    select.dispatchEvent(new Event("input", {bubbles: true}));
    select.dispatchEvent(new Event("change", {bubbles: true}));
  });
  await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible();
  await expect(picker).toHaveValue("5");
  await page.waitForTimeout(500);
  await expect(page.getByRole("status").filter({hasText: "Couldn't open scenario"})).toHaveCount(0);
});

test("DSN-008-B: back and forward open the scenario their history entry names", async () => {
  const published = await publishScenarioFixture(fixture, "dsn-008-b-history");
  const {page} = fixture;
  await page.goto(scenarioUrl(published, "honest.html", "5"));
  await startAnnotating(page);
  await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible();
  // A later entry that names another scenario, as a shared link opened in place would.
  await page.evaluate(() => {
    const next = new URL(window.location.href);
    next.searchParams.set("scenario", "6");
    window.history.pushState(window.history.state, "", next);
  });
  await page.goBack();
  await expect(page).toHaveURL(/[?&]scenario=5(?:&|$)/u);
  await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible();
  await page.goForward();
  await expect(previewFrame(page).getByRole("heading", {name: "Logic"})).toBeVisible();
  await expect(page.getByRole("combobox", {name: "Designed scenario"})).toHaveValue("6");
});

test("DSN-008-B: a designed artboard opens live, and its linked scenario opens once Annotate is on, even when its first views read fails", async () => {
  const published = await publishScenarioFixture(fixture, "dsn-008-b-annotate");
  const {page} = fixture;
  let failed = 0;
  await page.route("**/versions/*/views?*", async (route) => {
    if (failed === 0) {
      failed += 1;
      await route.fulfill({body: "{}", contentType: "application/json", status: 503});
      return;
    }
    await route.continue();
  });
  await page.goto(scenarioUrl(published, "cold.dc.html", "5"));
  // Never Annotate on arrival, designed or not.
  await expect(interactiveFrame(page).getByRole("heading", {name: "Library"})).toBeVisible();
  await expect(annotateSwitch(page)).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator('iframe[src="/review-frame"]')).toHaveCount(0);
  await startAnnotating(page);
  await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible({timeout: 15_000});
  expect(failed).toBe(1);
  await expect(page.locator('iframe[title^="Interactive preview"]')).toHaveCount(0);
  await expect(page.getByRole("combobox", {name: "Designed scenario"})).toHaveValue("5");
});

test("DSN-008-B: a cold page whose runtime arrives after the hello window still opens the linked scenario", async () => {
  const published = await publishScenarioFixture(fixture, "dsn-008-b-cold");
  const {page} = fixture;
  await page.route("**/cold-runtime.js", async (route) => {
    // A cold cache: the runtime takes longer than the whole hello window to arrive.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await route.continue();
  });
  await page.goto(scenarioUrl(published, "cold.dc.html", "5"));
  await startAnnotating(page);
  await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible({timeout: 20_000});
  await expect(page.getByRole("status").filter({hasText: "Couldn't open scenario"})).toHaveCount(0);
});

test("DSN-008-B: an adapter that says hello after the window still receives the linked scenario", async () => {
  const published = await publishScenarioFixture(fixture, "dsn-008-b-late");
  const {page} = fixture;
  await page.goto(scenarioUrl(published, "late.html", "5"));
  await startAnnotating(page);
  await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible({timeout: 15_000});
  await expect(page.getByRole("combobox", {name: "Designed scenario"})).toHaveValue("5");
  await expect(page.getByRole("status").filter({hasText: "Couldn't open scenario"})).toHaveCount(0);
});
