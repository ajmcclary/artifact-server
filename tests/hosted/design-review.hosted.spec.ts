import {createHash} from "node:crypto";

import {expect, test} from "@playwright/test";
import {z} from "zod";

import {createThreadOverApi, deleteThreadOverApi, listThreadsOverApi} from "../browser/comment-api.js";
import {annotationFrame, openInspectorTab, previewFrame, reviewHref, startAnnotating} from "../browser/review-helpers.js";
import {publishScenarioFixture, scenarioFixtureFiles} from "../browser/scenario-fixture.js";
import {
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  callHostedTool,
  deleteHostedArtifact,
  getHostedJson,
  type HostedFixture,
  startHostedFixture,
} from "./hosted-fixture.js";

/**
 * Hosted qualification of the Forms review pilot (DSN-007 … DSN-011) on a
 * deployed Artifact Server. It publishes one disposable artifact of its own,
 * never touches anyone else's, and deletes its artifact and comments when it
 * finishes. It registers no agent: a principal has one mailbox, so a
 * qualification mailbox would rename and then disconnect the operator's own.
 */

const encoder = new TextEncoder();
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const viewsPath = "artifactserver.views.json";
const provenancePath = "artifactserver.provenance.json";

const viewsOutcomeSchema = z.object({
  diagnostic: z.string().optional(),
  status: z.enum(["valid", "absent", "invalid", "unsupported-version"]),
  views: z.array(z.object({
    parameters: z.array(z.object({name: z.string()}).loose()),
    scenarios: z.array(z.object({scenarioId: z.string()}).loose()),
    viewId: z.string(),
  }).loose()).optional(),
}).loose();
const provenanceOutcomeSchema = z.object({
  coverage: z.object({
    declaredOutputs: z.number(),
    dependencyEdges: z.string(),
    externalVariability: z.array(z.string()),
    manifestFiles: z.number(),
  }).loose().optional(),
  mismatches: z.array(z.object({path: z.string(), reason: z.string()}).loose()).optional(),
  record: z.object({source: z.object({commit: z.string(), dirty: z.boolean()}).loose()}).loose().optional(),
  status: z.enum(["verified", "mismatch", "invalid", "unsupported-version", "not-recorded"]),
}).loose();
const versionContextSchema = z.object({
  provenance: z.object({status: z.string()}).loose(),
  versionId: z.string(),
  views: z.object({status: z.string()}).loose(),
}).loose();

/** The fixture's views document with one declared parameter on a view no restore depends on. */
function viewsWithParameter(files: readonly TestSiteFile[]): TestSiteFile[] {
  return files.map((file) => {
    if (file.path !== viewsPath) return file;
    const document = z.object({views: z.array(z.object({viewId: z.string()}).loose())}).loose()
      .parse(JSON.parse(new TextDecoder().decode(file.bytes)));
    const views = document.views.map((view) => view.viewId !== "fixture/silent" ? view : {
      ...view,
      parameters: [{
        default: "ltr",
        name: "direction",
        prop: "chromeRtl",
        values: [{propValue: false, value: "ltr"}, {propValue: true, value: "rtl"}],
      }],
    });
    return {...file, bytes: encoder.encode(JSON.stringify({...document, views}))};
  });
}

/** A provenance record declaring every other published file with its exact digest. */
function provenanceFor(files: readonly TestSiteFile[], commit: string, digestOf = sha256): TestSiteFile {
  const outputs = files.map((file) => ({path: file.path, sha256: digestOf(file.bytes), sources: []}));
  return {
    bytes: encoder.encode(JSON.stringify({
      build: {
        dsRevision: "3".repeat(40),
        lockfileSha256: "4".repeat(64),
        recipe: "hosted-qualification",
        recipeRevision: "2".repeat(40),
        renderer: {name: "scenario-fixture", sha256: "5".repeat(64)},
        toolchain: {node: process.version},
      },
      coverage: {dependencyEdges: "none", externalVariability: []},
      format: "artifact-server.source-provenance",
      inputs: [],
      outputs,
      source: {commit, descriptorId: "hosted-qualification", dirty: false, repository: "https://github.com/ajmcclary/artifact-server"},
      version: 1,
    })),
    mediaType: "application/json",
    path: provenancePath,
  };
}

async function publishVersion(
  fixture: HostedFixture,
  published: PublishResponse,
  files: readonly TestSiteFile[],
  key: string,
): Promise<PublishResponse> {
  const upload = await createStagedUpload(fixture.server, fixture.installation, "honest.html", files);
  await uploadEveryStagedFile(fixture.installation, upload.body, files);
  return (await commitStagedUpload(fixture.installation, upload.body, `${key}-${fixture.runTag}`, {
    artifactId: published.artifact.id,
    expectedCurrentVersionId: published.version.id,
    kind: "new_version",
  })).body;
}

function viewsUrl(published: PublishResponse): string {
  return `/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/views?projectId=${published.artifact.projectId}`;
}

function provenanceUrl(published: PublishResponse): string {
  return `/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/provenance?projectId=${published.artifact.projectId}`;
}

interface ViewAnchorExtra {
  readonly regionId?: string;
  readonly viewId?: string;
}

function viewAnchor(scenarioId: string, scenarioLabel: string, extra: ViewAnchorExtra = {}) {
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
      ...extra,
    },
  };
}

test.describe.serial("Forms review pilot on a hosted deployment", () => {
  let fixture: HostedFixture;
  let published: PublishResponse;
  const createdThreads: string[] = [];

  test.beforeAll(async ({browser}) => {
    fixture = await startHostedFixture(browser);
    const files = viewsWithParameter(scenarioFixtureFiles());
    published = await publishScenarioFixture(
      fixture,
      `hosted-${fixture.runTag}`,
      `Hosted qualification · design review ${fixture.runTag}`,
      [...files, provenanceFor(files, "1".repeat(40))],
    );
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

  test("DSN-007-B DSN-010-B: views and provenance read as valid and verified over HTTP and MCP, and as absent without them", async () => {
    const first = await getHostedJson(fixture, viewsUrl(published), viewsOutcomeSchema);
    expect(first.status).toBe("valid");
    expect(first.views?.map((view) => view.viewId)).toContain("fixture/honest");
    expect(first.views?.find((view) => view.viewId === "fixture/honest")?.scenarios.map((scenario) => scenario.scenarioId)).toEqual(["1", "5", "6"]);
    expect(first.views?.find((view) => view.viewId === "fixture/silent")?.parameters.map((parameter) => parameter.name)).toEqual(["direction"]);
    expect(await getHostedJson(fixture, viewsUrl(published), viewsOutcomeSchema)).toEqual(first);

    const provenance = await getHostedJson(fixture, provenanceUrl(published), provenanceOutcomeSchema);
    expect(provenance.status).toBe("verified");
    expect(provenance.record?.source).toMatchObject({commit: "1".repeat(40), dirty: false});
    expect(provenance.coverage?.declaredOutputs).toBe(provenance.coverage?.manifestFiles);

    const context = await callHostedTool(fixture, "artifact_version_context", {
      artifactId: published.artifact.id,
      projectId: published.artifact.projectId,
      versionId: published.version.id,
    }, versionContextSchema);
    expect(context).toMatchObject({provenance: {status: "verified"}, versionId: published.version.id, views: {status: "valid"}});

    const bare = await publishVersion(fixture, published, [{
      bytes: encoder.encode("<!doctype html><title>Bare</title>"),
      mediaType: "text/html; charset=utf-8",
      path: "honest.html",
    }], "hosted-bare");
    expect(await getHostedJson(fixture, viewsUrl(bare), viewsOutcomeSchema)).toEqual({status: "absent"});
    expect(await getHostedJson(fixture, provenanceUrl(bare), provenanceOutcomeSchema)).toEqual({status: "not-recorded"});
    published = {...published, version: bare.version};
  });

  test("DSN-007-F DSN-010-F: an invalid views document and changed outputs are reported without failing the version's other reads", async () => {
    const files = scenarioFixtureFiles().map((file) => file.path !== viewsPath ? file : {
      bytes: encoder.encode(JSON.stringify({format: "artifact-server.views", unexpected: true, version: 1, views: []})),
      mediaType: file.mediaType,
      path: file.path,
    });
    // The record claims a digest for honest.html that the published bytes do not have.
    const record = provenanceFor(files, "1".repeat(40), (bytes) => bytes === files[0]?.bytes ? "f".repeat(64) : sha256(bytes));
    const hostile = await publishVersion(fixture, published, [...files, record], "hosted-hostile");
    expect((await getHostedJson(fixture, viewsUrl(hostile), viewsOutcomeSchema)).status).toBe("invalid");
    const provenance = await getHostedJson(fixture, provenanceUrl(hostile), provenanceOutcomeSchema);
    expect(provenance.status).toBe("mismatch");
    expect(provenance.mismatches).toEqual([{path: "honest.html", reason: "digest"}]);
    const file = await fetch(
      `${fixture.server.baseUrl}/api/v1/artifacts/${hostile.artifact.id}/versions/${hostile.version.id}/file?${new URLSearchParams({path: "honest.html", projectId: hostile.artifact.projectId})}`,
      {headers: {Authorization: `Bearer ${fixture.installation.apiToken}`}},
    );
    expect(file.status).toBe(200);
    expect(await file.text()).toContain("data-fixture-behavior=\"honest\"");
    published = {...published, version: hostile.version};
  });

  test("DSN-008-B: the picker, a scenario link and an in-page change open the scenario the page confirms", async () => {
    const restored = await publishVersion(fixture, published, scenarioFixtureFiles(), "hosted-restore");
    published = {...published, version: restored.version};
    const {page} = fixture;
    const href = reviewHref(fixture.server.baseUrl, {artifactId: published.artifact.id, path: "honest.html", versionId: published.version.id});
    await page.goto(href);
    await startAnnotating(page);
    const picker = page.getByRole("combobox", {name: "Designed scenario"});
    await expect(picker).toHaveValue("1", {timeout: 30_000});
    await picker.selectOption("5");
    await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible();
    await expect(page).toHaveURL(/[?&]scenario=5(?:&|$)/u);

    await page.goto(`${href}&scenario=5`);
    await startAnnotating(page);
    await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible({timeout: 30_000});
    await expect(picker).toHaveValue("5");

    await page.goto(`${href}&scenario=1`);
    await startAnnotating(page);
    // An armed annotation surface takes a click as a comment, so the page moves itself.
    await previewFrame(page).getByRole("button", {name: "Open Logic"}).evaluate((button) => {
      if (button instanceof HTMLButtonElement) button.onclick?.(new PointerEvent("click"));
    }, undefined, {timeout: 30_000});
    await expect(previewFrame(page).getByRole("heading", {name: "Logic"})).toBeVisible();
    await expect(picker).toHaveValue("6");
    await expect(annotationFrame(page).locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
  });

  test("DSN-008-F: pages without an adapter, silent, lying and overlapping pages never change silently", async () => {
    const {page} = fixture;
    const href = (path: string) => `${reviewHref(fixture.server.baseUrl, {artifactId: published.artifact.id, path, versionId: published.version.id})}&scenario=5`;
    await page.goto(href("no-adapter.html"));
    await startAnnotating(page);
    await expect(page.getByRole("status").filter({hasText: "Couldn't open scenario 5: this page can't be told which scenario to show."})).toBeVisible({timeout: 30_000});
    await expect(previewFrame(page).getByRole("heading", {name: "Library"})).toBeVisible();

    await page.goto(href("silent.html"));
    await startAnnotating(page);
    await expect(page.getByRole("status").filter({hasText: "Couldn't open scenario 5: the page didn't confirm it in time."})).toBeVisible({timeout: 30_000});
    await expect(previewFrame(page).getByRole("heading", {name: "Library"})).toBeVisible();

    await page.goto(href("liar.html"));
    await startAnnotating(page);
    await expect(page.getByRole("status").filter({hasText: "Couldn't open scenario 5: the page showed a different scenario."})).toBeVisible({timeout: 30_000});

    await page.goto(reviewHref(fixture.server.baseUrl, {artifactId: published.artifact.id, path: "overlapping.html", versionId: published.version.id}));
    await startAnnotating(page);
    const picker = page.getByRole("combobox", {name: "Designed scenario"});
    await expect(picker).toHaveValue("1", {timeout: 30_000});
    await picker.evaluate((select) => {
      if (!(select instanceof HTMLSelectElement)) throw new Error("The scenario picker is not a select.");
      select.value = "6";
      select.dispatchEvent(new Event("change", {bubbles: true}));
      select.value = "5";
      select.dispatchEvent(new Event("change", {bubbles: true}));
    });
    await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible();
    await expect(picker).toHaveValue("5");
    await expect(page.getByRole("status").filter({hasText: "Couldn't open scenario"})).toHaveCount(0);
  });

  test("DSN-009-B: a region comment made in a designed scenario reopens there with its location", async () => {
    const {page} = fixture;
    const ids = {artifactId: published.artifact.id, versionId: published.version.id};
    const href = reviewHref(fixture.server.baseUrl, {...ids, path: "honest.html"});
    await page.goto(`${href}&scenario=5`);
    await startAnnotating(page);
    await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible({timeout: 30_000});
    await previewFrame(page).getByText("Minimum length").click();
    await annotationFrame(page).getByPlaceholder("Add a comment...").fill("Hosted qualification: raise the minimum length to 4.");
    await annotationFrame(page).getByRole("button", {name: "Save"}).click();

    await expect.poll(async () => (await listThreadsOverApi(fixture, ids.artifactId)).length, {timeout: 20_000}).toBe(1);
    const [created] = await listThreadsOverApi(fixture, ids.artifactId);
    if (created !== undefined) createdThreads.push(created.id);
    expect(created?.anchor).toMatchObject({
      view: {regionId: "inspector.validation.min-length", scenarioId: "5", scenarioLabel: "Inspector · Validation", viewId: "fixture/honest"},
    });

    await page.goto(href);
    await startAnnotating(page);
    await openInspectorTab(page, "Comments");
    const thread = page.getByRole("article").filter({hasText: "Hosted qualification: raise the minimum length to 4."});
    await expect(thread.getByText("In scenario 5 · Inspector · Validation")).toBeVisible({timeout: 30_000});
    await thread.getByText("Hosted qualification: raise the minimum length to 4.").click();
    await thread.getByRole("button", {exact: true, name: "Open scenario 5"}).click();
    await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible();
    await expect(thread.getByText(/^Location unavailable/u)).toHaveCount(0);
  });

  test("DSN-009-F: a missing or duplicated region and a failed restore say the location is unavailable", async () => {
    const {page} = fixture;
    const ids = {artifactId: published.artifact.id, versionId: published.version.id};
    const regions = [["gone.region", "Hosted qualification: missing region."], ["duplicate.note", "Hosted qualification: duplicated region."]] as const;
    const seeded = await Promise.all(regions.map(([regionId, body]) => createThreadOverApi(fixture, {
      ...ids,
      anchor: viewAnchor("5", "Inspector · Validation", {regionId}),
      body,
      idempotencyKey: `hosted-${fixture.runTag}-${regionId}`,
      path: "honest.html",
    })));
    createdThreads.push(...seeded.map((thread) => thread.id));
    const liar = await createThreadOverApi(fixture, {...ids, anchor: viewAnchor("5", "Inspector · Validation", {viewId: "fixture/liar"}), body: "Hosted qualification: liar.", idempotencyKey: `hosted-${fixture.runTag}-liar`, path: "liar.html"});
    createdThreads.push(liar.id);

    await page.goto(`${reviewHref(fixture.server.baseUrl, {...ids, path: "honest.html"})}&scenario=5`);
    await startAnnotating(page);
    await openInspectorTab(page, "Comments");
    await Promise.all(regions.map(([, body]) =>
      expect(page.getByRole("article").filter({hasText: body}).getByText("Location unavailable: the region isn't on the page")).toBeVisible({timeout: 30_000})));
    await page.goto(`${reviewHref(fixture.server.baseUrl, {...ids, path: "liar.html"})}&scenario=5`);
    await startAnnotating(page);
    await openInspectorTab(page, "Comments");
    await expect(page.getByRole("article").filter({hasText: "Hosted qualification: liar."}).getByText("Location unavailable: scenario 5 couldn't be opened")).toBeVisible({timeout: 30_000});
  });
});
