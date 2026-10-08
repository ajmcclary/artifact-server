import {type BrowserContext, type ConsoleMessage, expect, type Page, test} from "@playwright/test";
import {z} from "zod";

import {deleteThreadOverApi, listThreadsOverApi} from "../browser/comment-api.js";
import {annotateSwitch, annotationFrame, interactiveFrame, openInspectorTab, previewFrame, reviewHref, startAnnotating} from "../browser/review-helpers.js";
import type {PublishResponse} from "../support/publishing.js";
import {
  deleteHostedArtifact,
  getHostedJson,
  type HostedFixture,
  openHostedContext,
  startHostedFixture,
} from "./hosted-fixture.js";
import {publishPinnedCopy, readPinnedVersion, type VersionPin} from "./pinned-copy.js";

/**
 * Hosted qualification of the Forms review pilot against Design's own page
 * adapter and Forms runtime, not the scenario fixture. It copies one pinned
 * Forms version into a disposable artifact of its own, so it never writes to
 * Design's artifact, and deletes the copy and its comments when it finishes.
 * The hostile restore cases stay on the fixture, since a real adapter cannot
 * be made to misbehave.
 */

/** Forms v17, published from Design `8c2edea`. Re-pin deliberately, never to "current". */
const formsPin: VersionPin = {
  artifactId: "art_743d037f-dba7-4051-ad8f-4eda916a9661",
  label: "Forms v17",
  versionId: "ver_5307bd25-2457-4aa2-8638-6ee4d3679396",
};

/** The little this suite knows about Forms beyond its views document; checked against it first. */
const forms = {
  regionId: "inspector.validation.min-length",
  regionLabel: "Min length",
  scenarioId: "5",
  scenarioLabel: "Inspector · Validation",
  // The ScenarioBar's "Next scenario" from scenario 5, whose rule editor names
  // its add button and fills its field picker through camelCase props.
  nextScenarioId: "6",
  ruleAddLabel: "Add Condition",
  ruleField: "Review Required",
  viewId: "arkcase-forms/form-builder",
} as const;

const viewsSchema = z.object({
  status: z.string(),
  views: z.array(z.object({
    defaultScenarioId: z.string(),
    path: z.string(),
    scenarios: z.array(z.object({label: z.string(), scenarioId: z.string()}).loose()),
    viewId: z.string(),
  }).loose()).optional(),
}).loose();
const provenanceSchema = z.object({
  mismatches: z.array(z.unknown()).optional(),
  record: z.object({source: z.object({commit: z.string(), dirty: z.boolean()}).loose()}).loose().optional(),
  status: z.string(),
}).loose();

type FormsView = NonNullable<z.infer<typeof viewsSchema>["views"]>[number];

/** Refuse to test a Forms whose views no longer match this suite's table. */
function formsViewOf(outcome: z.infer<typeof viewsSchema>): FormsView {
  const view = outcome.views?.find((candidate) => candidate.viewId === forms.viewId);
  const order = view?.scenarios.map((scenario) => scenario.scenarioId) ?? [];
  const label = view?.scenarios.find((scenario) => scenario.scenarioId === forms.scenarioId)?.label;
  if (view === undefined || label !== forms.scenarioLabel || order[order.indexOf(forms.scenarioId) + 1] !== forms.nextScenarioId) {
    throw new Error(`${formsPin.label} no longer matches this suite's Forms table; re-pin Forms and update the table together.`);
  }
  return view;
}

const violationPrefix = "hosted-qualification-csp-violation ";

/**
 * Record every content security policy violation in every frame of a context,
 * with the document, directive and source that caused it. Forms v17 no longer
 * probes `new Function` on an `about:` page, so no refusal is expected.
 */
async function watchPolicyViolations(context: BrowserContext, violations: string[]): Promise<void> {
  await context.addInitScript((prefix) => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.warn(prefix + JSON.stringify({
        blocked: event.blockedURI,
        directive: event.effectiveDirective,
        document: location.href.slice(0, 120),
        source: `${event.sourceFile}:${event.lineNumber}`,
      }));
    });
  }, violationPrefix);
  context.on("console", (message: ConsoleMessage) => {
    const text = message.text();
    if (text.startsWith(violationPrefix)) violations.push(text.slice(violationPrefix.length));
  });
}

/** The element Forms marks with the scenario actually on screen. */
const scenarioOnScreen = (page: Page) => previewFrame(page).locator("[data-review-scenario]");
const picker = (page: Page) => page.getByRole("combobox", {name: "Designed scenario"});

test.describe.serial("Forms itself on a hosted deployment", () => {
  let fixture: HostedFixture;
  let published: PublishResponse;
  let view: FormsView;
  const createdThreads: string[] = [];
  const violations: string[] = [];

  const href = (): string => reviewHref(fixture.server.baseUrl, {
    artifactId: published.artifact.id,
    path: view.path,
    projectId: published.artifact.projectId,
    versionId: published.version.id,
  });

  test.beforeAll(async ({browser}) => {
    fixture = await startHostedFixture(browser);
    await watchPolicyViolations(fixture.context, violations);
    const copy = await readPinnedVersion(fixture, formsPin);
    published = await publishPinnedCopy(fixture, copy, `Hosted qualification · Forms ${fixture.runTag}`, `hosted-forms-${fixture.runTag}`);
  });

  test.afterAll(async () => {
    // Clean up even after a failure; each step is independent of the others.
    await Promise.allSettled(createdThreads.map((threadId) => deleteThreadOverApi(fixture, {
      artifactId: published.artifact.id,
      idempotencyKey: `hosted-qualification-delete-${threadId}`,
      threadId,
    })));
    await deleteHostedArtifact(fixture, published.artifact.id, published.artifact.projectId);
    await fixture.context.close();
  });

  test("DSN-007-B DSN-010-B: a copy of Forms reads its views as valid and its provenance as verified", async () => {
    const versionPath = `/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}`;
    const project = `projectId=${published.artifact.projectId}`;
    const views = await getHostedJson(fixture, `${versionPath}/views?${project}`, viewsSchema);
    expect(views.status).toBe("valid");
    view = formsViewOf(views);
    expect(view.path).toBe(published.version.entryPath);

    const provenance = await getHostedJson(fixture, `${versionPath}/provenance?${project}`, provenanceSchema);
    expect(provenance.status).toBe("verified");
    expect(provenance.mismatches ?? []).toEqual([]);
    expect(provenance.record?.source.dirty).toBe(false);
  });

  test("CMT-022-B: Forms opens live with Annotate off, and its own ScenarioBar works there", async () => {
    const {page} = fixture;
    await page.goto(`${href()}&scenario=${forms.scenarioId}`);
    await expect(annotateSwitch(page)).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator('iframe[src="/review-frame"]')).toHaveCount(0);
    const live = interactiveFrame(page);
    const shown = live.locator("[data-review-scenario]");
    await expect(shown).toHaveAttribute("data-review-scenario", /.+/u, {timeout: 60_000});
    const before = await shown.getAttribute("data-review-scenario");
    await live.getByRole("region", {name: "Scenario review"}).getByRole("button", {name: "Next scenario"}).click();
    await expect(shown).not.toHaveAttribute("data-review-scenario", before ?? "", {timeout: 5_000});
  });

  test("DSN-008-B: on Forms, the picker and a scenario link open the scenario the page confirms", async () => {
    const {page} = fixture;
    await page.goto(href());
    await startAnnotating(page);
    await expect(picker(page)).toHaveValue(view.defaultScenarioId, {timeout: 60_000});
    await picker(page).selectOption(forms.scenarioId);
    await expect(scenarioOnScreen(page)).toHaveAttribute("data-review-scenario", forms.scenarioId);
    await expect(page).toHaveURL(new RegExp(`[?&]scenario=${forms.scenarioId}(?:&|$)`, "u"));

    await page.goto(`${href()}&scenario=${forms.scenarioId}`);
    await startAnnotating(page);
    await expect(scenarioOnScreen(page)).toHaveAttribute("data-review-scenario", forms.scenarioId, {timeout: 60_000});
    await expect(picker(page)).toHaveValue(forms.scenarioId);
  });

  test("DSN-008-B: on the annotation surface, Forms draws a restored scenario as it does live", async () => {
    // The sandbox page is a srcdoc whose template the HTML parser lowercased;
    // Forms v16 lost its imported components' camelCase props there, so scenario
    // 6's rule editor drew empty. The armed surface owns page clicks, so this
    // checks what the page draws rather than its ScenarioBar, which the live
    // test above drives.
    const {page} = fixture;
    await page.goto(`${href()}&scenario=${forms.nextScenarioId}`);
    await startAnnotating(page);
    await expect(scenarioOnScreen(page)).toHaveAttribute("data-review-scenario", forms.nextScenarioId, {timeout: 60_000});
    await expect(previewFrame(page).getByRole("button", {name: forms.ruleAddLabel, exact: true})).toBeVisible();
    await expect(previewFrame(page).getByRole("combobox")
      .filter({has: previewFrame(page).locator("option:checked", {hasText: forms.ruleField})})).toHaveCount(1);
  });

  test("DSN-008-B: rapid picker changes on Forms end on the last choice without a failure", async () => {
    const {page} = fixture;
    await page.goto(href());
    await startAnnotating(page);
    await expect(picker(page)).toHaveValue(view.defaultScenarioId, {timeout: 60_000});
    await picker(page).evaluate((select, ids) => {
      if (!(select instanceof HTMLSelectElement)) throw new Error("The scenario picker is not a select.");
      for (const id of ids) {
        select.value = id;
        select.dispatchEvent(new Event("change", {bubbles: true}));
      }
    }, [forms.nextScenarioId, forms.scenarioId]);
    await expect(scenarioOnScreen(page)).toHaveAttribute("data-review-scenario", forms.scenarioId);
    await expect(picker(page)).toHaveValue(forms.scenarioId);
    await expect(page.getByRole("status").filter({hasText: "Couldn't open scenario"})).toHaveCount(0);
  });

  test("DSN-008-B: a cold browser context still hears Forms say hello and opens the linked scenario", async ({browser}) => {
    const context = await openHostedContext(browser, fixture);
    try {
      await watchPolicyViolations(context, violations);
      const page = await context.newPage();
      await page.goto(`${href()}&scenario=${forms.scenarioId}`);
      await startAnnotating(page);
      await expect(scenarioOnScreen(page)).toHaveAttribute("data-review-scenario", forms.scenarioId, {timeout: 60_000});
      await expect(picker(page)).toHaveValue(forms.scenarioId);
      await expect(page.getByRole("status").filter({hasText: "Couldn't open scenario"})).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("DSN-009-B: a region comment on Forms in high contrast stores its theme, and reopening it says so", async () => {
    const {page} = fixture;
    // The reviewer's own contrast setting: Forms follows it in the review sandbox.
    await page.emulateMedia({contrast: "more"});
    await page.goto(`${href()}&scenario=${forms.scenarioId}`);
    await startAnnotating(page);
    await expect(scenarioOnScreen(page)).toHaveAttribute("data-review-scenario", forms.scenarioId, {timeout: 60_000});
    await expect(previewFrame(page).locator("html")).toHaveAttribute("data-theme", "high-contrast");
    await previewFrame(page).locator(`[data-review-region="${forms.regionId}"]`).getByLabel(forms.regionLabel, {exact: true}).click();
    const body = `Hosted qualification ${fixture.runTag}: ${forms.regionLabel} is hard to read here.`;
    await annotationFrame(page).getByPlaceholder("Add a comment...").fill(body);
    await annotationFrame(page).getByRole("button", {name: "Save"}).click();

    const ids = {artifactId: published.artifact.id};
    await expect.poll(async () => (await listThreadsOverApi(fixture, ids.artifactId)).length, {timeout: 20_000}).toBe(1);
    const [created] = await listThreadsOverApi(fixture, ids.artifactId);
    if (created !== undefined) createdThreads.push(created.id);
    expect(created?.anchor).toMatchObject({
      view: {
        regionId: forms.regionId,
        regionLabel: forms.regionLabel,
        scenarioId: forms.scenarioId,
        scenarioLabel: forms.scenarioLabel,
        state: {theme: "high-contrast"},
        viewId: forms.viewId,
      },
    });

    // A restore sets the scenario, not the theme (contract amendment 8).
    await page.emulateMedia({contrast: "no-preference"});
    await page.goto(`${href()}&thread=${created?.id ?? ""}`);
    await startAnnotating(page);
    await expect(scenarioOnScreen(page)).toHaveAttribute("data-review-scenario", forms.scenarioId, {timeout: 60_000});
    await expect(previewFrame(page).locator("html")).not.toHaveAttribute("data-theme", "high-contrast");
    await openInspectorTab(page, "Comments");
    const thread = page.getByRole("article").filter({hasText: body});
    await expect(thread.getByText("Made in high contrast")).toBeVisible();
    await expect(thread.getByText(/^Location unavailable/u)).toHaveCount(0);
    await expect(previewFrame(page).locator("[data-plannotator-marker]")).toHaveCount(1);
  });

  test("Forms draws no content security policy violation, live or in the review sandbox", () => {
    expect(violations).toEqual([]);
  });
});
