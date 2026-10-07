import {expect, test} from "@playwright/test";

import {createThreadOverApi, listThreadsOverApi} from "./comment-api.js";
import {localLogin, startBrowserFixture, stopBrowserFixture, type BrowserFixture} from "./browser-fixture.js";
import {annotationFrame, openInspectorTab, previewFrame, reviewHref} from "./review-helpers.js";
import {publishScenarioFixture} from "./scenario-fixture.js";

let fixture: BrowserFixture;

test.beforeEach(async ({browser}) => {
  fixture = await startBrowserFixture(browser);
  await localLogin(fixture);
});

test.afterEach(async () => {
  await stopBrowserFixture(fixture);
});

function viewAnchor(scenarioId: string, scenarioLabel: string) {
  return {
    htmlAnchor: null,
    originalText: "",
    view: {
      scenarioId,
      scenarioLabel,
      sourceRef: {line: 7, path: "fixture/honest.html"},
      state: {direction: "ltr", locale: "en", parameters: {}, theme: "light", viewport: {height: 900, width: 1440}},
      viewFormat: 1,
      viewId: "fixture/honest",
    },
  };
}

function regionAnchor(scenarioId: string, scenarioLabel: string, regionId: string) {
  const anchor = viewAnchor(scenarioId, scenarioLabel);
  return {...anchor, view: {...anchor.view, regionId}};
}

test("DSN-009-B: a region comment in a designed scenario reopens there, and other scenarios are listed", async () => {
  const published = await publishScenarioFixture(fixture, "dsn-009-b");
  const {page} = fixture;
  const ids = {artifactId: published.artifact.id, versionId: published.version.id};
  await createThreadOverApi(fixture, {...ids, anchor: viewAnchor("6", "Logic"), body: "Logic needs a second rule.", idempotencyKey: "thread-dsn-009-b-logic", path: "honest.html"});

  await page.goto(`${reviewHref(fixture.server.baseUrl, {...ids, path: "honest.html"})}&scenario=5`);
  await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible();
  await page.getByRole("button", {name: /^Interact mode:/u}).click();
  await previewFrame(page).getByText("Minimum length").click();
  const composer = annotationFrame(page).getByPlaceholder("Add a comment...");
  await composer.fill("Raise the minimum length to 4.");
  await annotationFrame(page).getByRole("button", {name: "Save"}).click();

  // The save is asynchronous: read the stored anchor once the thread exists.
  await expect.poll(async () => (await listThreadsOverApi(fixture, ids.artifactId)).length).toBe(2);
  const threads = await listThreadsOverApi(fixture, ids.artifactId);
  const created = threads.find((thread) => thread.body === "Raise the minimum length to 4.");
  expect(created?.anchor).toMatchObject({
    view: {
      regionId: "inspector.validation.min-length",
      regionLabel: "Minimum length",
      scenarioId: "5",
      scenarioLabel: "Inspector · Validation",
      sourceRef: {line: 7, path: "fixture/honest.html"},
      state: {direction: "ltr", locale: "en", theme: "light"},
      viewId: "fixture/honest",
    },
  });

  // Reopen from the default scenario: the comment is listed in scenario 5 and opens there.
  await page.goto(reviewHref(fixture.server.baseUrl, {...ids, path: "honest.html"}));
  await openInspectorTab(page, "Comments");
  const thread = page.getByRole("article").filter({hasText: "Raise the minimum length to 4."});
  await expect(thread.getByText("In scenario 5 · Inspector · Validation")).toBeVisible();
  await thread.getByText("Raise the minimum length to 4.").click();
  await thread.getByRole("button", {exact: true, name: "Open scenario 5"}).click();
  await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible();
  await expect(thread.getByText(/^In scenario 5/u)).toHaveCount(0);
  await expect(thread.getByText(/^Location unavailable/u)).toHaveCount(0);

  // The scenario 6 comment follows the page when it moves to Logic from inside.
  const logic = page.getByRole("article").filter({hasText: "Logic needs a second rule."});
  await expect(logic.getByText("In scenario 6 · Logic")).toBeVisible();
  await page.goto(`${reviewHref(fixture.server.baseUrl, {...ids, path: "honest.html"})}&scenario=1`);
  await openInspectorTab(page, "Comments");
  await previewFrame(page).getByRole("button", {name: "Open Logic"}).click();
  await expect(page.getByRole("article").filter({hasText: "Logic needs a second rule."}).getByText(/^In scenario 6/u)).toHaveCount(0);
});

test("DSN-009-B: a comment made in high contrast says so, and reopening it keeps the reviewer's theme", async () => {
  const published = await publishScenarioFixture(fixture, "dsn-009-b-theme");
  const {page} = fixture;
  const ids = {artifactId: published.artifact.id, versionId: published.version.id};

  await page.emulateMedia({contrast: "more"});
  await page.goto(`${reviewHref(fixture.server.baseUrl, {...ids, path: "honest.html"})}&scenario=5`);
  await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible();
  await page.getByRole("button", {name: /^Interact mode:/u}).click();
  await previewFrame(page).getByText("Minimum length").click();
  await annotationFrame(page).getByPlaceholder("Add a comment...").fill("Min length is hard to read here.");
  await annotationFrame(page).getByRole("button", {name: "Save"}).click();
  await expect.poll(async () => (await listThreadsOverApi(fixture, ids.artifactId)).length).toBe(1);
  const [created] = await listThreadsOverApi(fixture, ids.artifactId);
  expect(created?.anchor).toMatchObject({view: {regionId: "inspector.validation.min-length", scenarioId: "5", state: {theme: "high-contrast"}}});

  // A restore sets the scenario, not the theme: the thread names the theme it was made in.
  await page.emulateMedia({contrast: "no-preference"});
  await page.goto(`${reviewHref(fixture.server.baseUrl, {...ids, path: "honest.html"})}&thread=${created?.id ?? ""}`);
  await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible();
  await openInspectorTab(page, "Comments");
  const thread = page.getByRole("article").filter({hasText: "Min length is hard to read here."});
  await expect(thread.getByText("Made in high contrast")).toBeVisible();
  await expect(previewFrame(page).locator("[data-plannotator-marker]")).toHaveCount(1);
});

test("DSN-009-F: a failed restore and a missing or duplicated region say the location is unavailable", async () => {
  const published = await publishScenarioFixture(fixture, "dsn-009-f");
  const {page} = fixture;
  const ids = {artifactId: published.artifact.id, versionId: published.version.id};
  await createThreadOverApi(fixture, {...ids, anchor: regionAnchor("5", "Inspector · Validation", "gone.region"), body: "Missing region.", idempotencyKey: "thread-dsn-009-f-missing", path: "honest.html"});
  await createThreadOverApi(fixture, {...ids, anchor: regionAnchor("5", "Inspector · Validation", "duplicate.note"), body: "Duplicated region.", idempotencyKey: "thread-dsn-009-f-duplicate", path: "honest.html"});
  await createThreadOverApi(fixture, {...ids, anchor: {...viewAnchor("5", "Inspector · Validation"), view: {viewFormat: 1, viewId: 42}}, body: "Broken view block.", idempotencyKey: "thread-dsn-009-f-broken", path: "honest.html"});

  await page.goto(`${reviewHref(fixture.server.baseUrl, {...ids, path: "honest.html"})}&scenario=5`);
  await openInspectorTab(page, "Comments");
  await expect(page.getByRole("article").filter({hasText: "Missing region."}).getByText("Location unavailable: the region isn't on the page")).toBeVisible();
  await expect(page.getByRole("article").filter({hasText: "Duplicated region."}).getByText("Location unavailable: the region isn't on the page")).toBeVisible();
  // An invalid view block reads as absent: the comment is placed like any legacy anchor.
  await expect(page.getByRole("article").filter({hasText: "Broken view block."}).getByText(/^In scenario/u)).toHaveCount(0);

  const liar = {artifactId: ids.artifactId, versionId: ids.versionId};
  await createThreadOverApi(fixture, {...liar, anchor: {...viewAnchor("5", "Inspector · Validation"), view: {...viewAnchor("5", "Inspector · Validation").view, viewId: "fixture/liar"}}, body: "Liar comment.", idempotencyKey: "thread-dsn-009-f-liar", path: "liar.html"});
  await page.goto(`${reviewHref(fixture.server.baseUrl, {...liar, path: "liar.html"})}&scenario=5`);
  await openInspectorTab(page, "Comments");
  await expect(page.getByRole("article").filter({hasText: "Liar comment."}).getByText("Location unavailable: scenario 5 couldn't be opened")).toBeVisible({timeout: 10_000});
});

test("a failed save repaints only the comments of the scenario on screen", async () => {
  const published = await publishScenarioFixture(fixture, "failed-save-repaint");
  const {page} = fixture;
  const ids = {artifactId: published.artifact.id, versionId: published.version.id};
  await createThreadOverApi(fixture, {...ids, anchor: regionAnchor("5", "Inspector · Validation", "inspector.validation.min-length"), body: "Scenario five comment.", idempotencyKey: "thread-failed-save-five", path: "honest.html"});
  await createThreadOverApi(fixture, {...ids, anchor: regionAnchor("1", "Library", "inspector.validation"), body: "Scenario one comment.", idempotencyKey: "thread-failed-save-one", path: "honest.html"});
  await page.route("**/api/v1/artifacts/*/versions/*/comments**", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({body: JSON.stringify({error: {code: "INTERNAL", message: "Injected failure."}}), contentType: "application/json", status: 500});
      return;
    }
    await route.continue();
  });

  await page.goto(`${reviewHref(fixture.server.baseUrl, {...ids, path: "honest.html"})}&scenario=5`);
  const markers = previewFrame(page).locator("[data-plannotator-marker]");
  await expect(markers).toHaveCount(1);
  await page.getByRole("button", {name: /^Interact mode:/u}).click();
  await previewFrame(page).getByText("First note").click();
  await annotationFrame(page).getByPlaceholder("Add a comment...").fill("This save fails.");
  await annotationFrame(page).getByRole("button", {name: "Save"}).click();
  // The repaint after the failure holds only scenario 5's comment, never scenario 1's.
  await expect(markers).toHaveCount(1);
});


test("a link to a comment reopens the comment's designed scenario", async () => {
  const published = await publishScenarioFixture(fixture, "thread-link-reopen");
  const {page} = fixture;
  const ids = {artifactId: published.artifact.id, versionId: published.version.id};
  const thread = await createThreadOverApi(fixture, {...ids, anchor: regionAnchor("5", "Inspector · Validation", "inspector.validation.min-length"), body: "Linked comment.", idempotencyKey: "thread-link-reopen-five", path: "honest.html"});
  await page.goto(`${reviewHref(fixture.server.baseUrl, {...ids, path: "honest.html"})}&thread=${thread.id}`);
  await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible();
  await expect(page.getByRole("combobox", {name: "Designed scenario"})).toHaveValue("5");
});
