import {randomUUID} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {expect, test} from "@playwright/test";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import {publishPath, type FilePublicationTarget} from "../../src/client/file-publication-client.js";
import {previewSourceFixture, writePreviewSourceFixture} from "../support/claude-design-fixture.js";
import {ApiClient} from "../support/agent-dispatch.js";
import {localLogin, startBrowserFixture, stopBrowserFixture, type BrowserFixture} from "./browser-fixture.js";
import {interactiveFrame} from "./review-helpers.js";

// Every publish names its project: once a second project exists, the server asks which one.
function publish(fixture: BrowserFixture, inputPath: string, target: FilePublicationTarget, entryPath?: string, projectId = "prj_default") {
  const command = {inputPath, idempotencyKey: randomUUID(), projectId, target};
  return Effect.runPromise(publishPath(
    {serverOrigin: fixture.server.baseUrl, apiToken: Redacted.make(fixture.installation.apiToken)},
    entryPath === undefined ? command : {...command, entryPath},
  ).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(NodeFileSystem.layer)));
}
const named = (name: string): FilePublicationTarget => ({kind: "new_artifact", accessSetting: "account_required", name, tags: []});

test("DSN-005-B: the design library gathers every current gallery across all projects and opens exact pages", async ({browser}) => {
  const fixture = await startBrowserFixture(browser);
  const directory = await mkdtemp(path.join(tmpdir(), "design-library-browser-"));
  try {
    const claims = path.join(directory, "claims");
    await writePreviewSourceFixture(claims);
    const studio = path.join(directory, "studio");
    await writePreviewSourceFixture(studio);
    await writeFile(path.join(studio, "artifactserver.previews.json"), JSON.stringify({...previewSourceFixture(), title: "Portal Studio"}));
    const plain = path.join(directory, "plain");
    await mkdir(plain);
    await writeFile(path.join(plain, "index.html"), "<!doctype html><h1>Plain page</h1>");
    const broken = path.join(directory, "broken");
    await mkdir(path.join(broken, "artifact-server-previews"), {recursive: true});
    await writeFile(path.join(broken, "artifact-server-design.html"), "<!doctype html><h1>Old catalog</h1>");
    await writeFile(path.join(broken, "artifact-server-previews/index.json"), "{not json");

    const claimsPublished = await publish(fixture, claims, named("Claims Workspace"));
    await publish(fixture, studio, named("Portal Studio"));
    await publish(fixture, plain, named("Plain page"));
    await publish(fixture, broken, named("Broken gallery"), "artifact-server-design.html");
    const portal = path.join(directory, "portal");
    await writePreviewSourceFixture(portal);
    await writeFile(path.join(portal, "artifactserver.previews.json"), JSON.stringify({...previewSourceFixture(), title: "Claimant Portal"}));
    const owner = new ApiClient(fixture.server, fixture.installation.apiToken);
    const portalProjectId = await owner.createProject("Portal project", "design-library-portal-project");
    await publish(fixture, portal, named("Claimant Portal"), undefined, portalProjectId);
    await localLogin(fixture);
    const page = fixture.page;

    await page.getByRole("link", {name: "Design library"}).click();
    await expect(page).toHaveURL(/\/review\/library$/u);
    const library = page.getByRole("region", {name: "Design library gallery"});
    await expect(library.getByRole("heading", {name: "Design library", level: 2})).toBeVisible();
    await expect(library.getByText(/^12 previews/u)).toBeVisible();
    await expect(library.getByText(/^3 galleries · current versions as of/u)).toBeVisible();
    await expect(page.getByText("These galleries could not be read and are not shown: Broken gallery.")).toBeVisible();
    await expect(library.getByRole("region", {name: "Prototypes · Claims Workspace · Prototypes"})).toBeVisible();
    await expect(library.getByRole("region", {name: "Prototypes · Portal Studio · Prototypes"})).toBeVisible();
    // The second project's gallery appears in the same library.
    await expect(library.getByRole("region", {name: "Prototypes · Claimant Portal · Prototypes"})).toBeVisible();
    await expect(library.getByText("Plain page")).toHaveCount(0);
    const claimsApp = library.getByRole("link", {name: "Open Examiner App · Prototype · Claims Workspace · Prototypes"});
    await expect.poll(() => claimsApp.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(16);
    const exact = new URL(await claimsApp.getAttribute("href") ?? "", page.url());
    expect(exact.pathname).toBe("/review");
    expect(exact.searchParams.get("artifact")).toBe(claimsPublished.artifact.id);
    expect(exact.searchParams.get("version")).toBe(claimsPublished.version.id);
    expect(exact.searchParams.get("path")).toBe("project/App.dc.html");

    await library.getByRole("searchbox", {name: "Find a preview"}).fill("portal studio");
    await expect(library.getByRole("link")).toHaveCount(4);
    await library.getByRole("searchbox", {name: "Find a preview"}).fill("examiner");
    await expect(library.getByRole("link")).toHaveCount(3);
    await claimsApp.click();
    await expect(page).toHaveURL(new RegExp(`artifact=${claimsPublished.artifact.id}.*path=project%2FApp\\.dc\\.html`, "u"));
    await expect(interactiveFrame(page).getByRole("heading", {name: "Examiner app"})).toBeVisible();
    await page.goBack();
    await expect(library.getByRole("searchbox", {name: "Find a preview"})).toHaveValue("examiner");
    await expect(claimsApp).toBeFocused();

    // A moving view: Refresh follows the newly current version.
    const next = await publish(fixture, claims, {kind: "new_version", artifactId: claimsPublished.artifact.id, expectedCurrentVersionId: claimsPublished.version.id});
    expect(new URL(await claimsApp.getAttribute("href") ?? "", page.url()).searchParams.get("version")).toBe(claimsPublished.version.id);
    await page.getByRole("button", {name: "Refresh"}).click();
    await expect.poll(async () => new URL(await claimsApp.getAttribute("href") ?? "", page.url()).searchParams.get("version")).toBe(next.version.id);
  } finally {
    await stopBrowserFixture(fixture);
    await rm(directory, {recursive: true, force: true});
  }
});

test("DSN-005: an installation with no galleries explains how they appear", async ({browser}) => {
  const fixture = await startBrowserFixture(browser);
  try {
    await localLogin(fixture);
    await fixture.page.goto(`${fixture.server.baseUrl}/review/library`);
    await expect(fixture.page).toHaveURL(/\/review\/library$/u);
    await expect(fixture.page.getByRole("heading", {name: "No design galleries yet"})).toBeVisible();
    // A pre-rollup project link still opens the one library.
    await fixture.page.goto(`${fixture.server.baseUrl}/review/library?project=prj_default`);
    await expect(fixture.page.getByRole("heading", {name: "No design galleries yet"})).toBeVisible();
  } finally {
    await stopBrowserFixture(fixture);
  }
});
