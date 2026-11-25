import {expect, test} from "@playwright/test";
import {z} from "zod";

import {apiHeaders} from "../support/runtime-harness.js";
import {publishNew, publishVersion} from "../support/publishing.js";
import {localLogin, startBrowserFixture, stopBrowserFixture, type BrowserFixture} from "./browser-fixture.js";
import {openReview} from "./review-helpers.js";

const versionStateSchema = z.object({
  artifact: z.object({currentVersionId: z.string()}),
});
const versionSchema = z.object({version: z.object({state: z.string()})});

async function publishWithCandidate(fixture: BrowserFixture, key: string) {
  const first = await publishNew(fixture.server, fixture.installation, {
    accessSetting: "account_required",
    content: "<!doctype html><html lang=\"en\"><title>Accepted</title><h1>Accepted</h1></html>",
    idempotencyKey: `${key}-first`,
    name: "Widget inspector board",
  });
  const candidate = await publishVersion(fixture.server, fixture.installation, {
    artifactId: first.body.artifact.id,
    content: "<!doctype html><html lang=\"en\"><title>Candidate</title><h1>Candidate</h1></html>",
    expectedCurrentVersionId: first.body.version.id,
    idempotencyKey: `${key}-candidate`,
    stage: true,
  });
  expect(candidate.response.status).toBe(201);
  return {artifactId: first.body.artifact.id, candidateId: candidate.body.version.id, firstId: first.body.version.id};
}

async function readState(fixture: BrowserFixture, artifactId: string, versionId: string) {
  const headers = apiHeaders(fixture.installation, `read-${versionId}`);
  const [artifact, version] = await Promise.all([
    fetch(`${fixture.server.baseUrl}/api/v1/artifacts/${artifactId}?projectId=prj_default`, {headers}),
    fetch(`${fixture.server.baseUrl}/api/v1/artifacts/${artifactId}/versions/${versionId}?projectId=prj_default`, {headers}),
  ]);
  return {
    currentVersionId: versionStateSchema.parse(await artifact.json()).artifact.currentVersionId,
    state: versionSchema.parse(await version.json()).version.state,
  };
}

test.describe("Candidate review", () => {
  test("CND-005-B: Reject asks first, Cancel changes nothing, and the reviewer stays on the closed candidate", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const staged = await publishWithCandidate(fixture, "cnd-005-review");
      await localLogin(fixture);
      await openReview(fixture, {artifactId: staged.artifactId, versionId: staged.candidateId});
      const page = fixture.page;
      const banner = page.getByTestId("candidate-banner");
      await expect(banner).toContainText("Candidate · based on version 1");
      await expect(page.getByRole("button", {name: "Make Current"})).toHaveCount(0);

      // Reject cannot be undone, so it asks in place; Cancel leaves the candidate open.
      await banner.getByRole("button", {name: "Reject"}).click();
      const question = "Reject candidate v2? It will never become current, and this cannot be undone. Its bytes and comments are kept.";
      await expect(banner.getByText(question)).toBeVisible();
      await banner.getByRole("button", {name: "Cancel"}).click();
      await expect(banner.getByText(question)).toHaveCount(0);
      expect(await readState(fixture, staged.artifactId, staged.candidateId)).toEqual({currentVersionId: staged.firstId, state: "candidate"});

      await banner.getByRole("button", {name: "Reject"}).click();
      await banner.getByRole("button", {name: "Reject Candidate"}).click();
      await expect(banner).toContainText("Rejected candidate · based on version 1");
      await expect(banner).toContainText("It never became current; its bytes and comments are kept. Version 1 is current.");
      await expect(banner.getByRole("button")).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`version=${staged.candidateId}`, "u"));
      // A closed candidate can never be made current from Review either.
      await expect(page.getByRole("button", {name: "Make Current"})).toHaveCount(0);
      expect(await readState(fixture, staged.artifactId, staged.candidateId)).toEqual({currentVersionId: staged.firstId, state: "rejected"});
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CND-003-B: a stale candidate's banner names its base and the current version, and Promote stays disabled", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const staged = await publishWithCandidate(fixture, "cnd-003-review");
      // An accepted publish moves current past the candidate's base.
      const accepted = await publishVersion(fixture.server, fixture.installation, {
        artifactId: staged.artifactId,
        content: "<!doctype html><html lang=\"en\"><title>Accepted again</title><h1>Accepted again</h1></html>",
        expectedCurrentVersionId: staged.firstId,
        idempotencyKey: "cnd-003-review-accepted",
      });
      expect(accepted.body.version.number).toBe(3);
      await localLogin(fixture);
      await openReview(fixture, {artifactId: staged.artifactId, versionId: staged.candidateId});
      const banner = fixture.page.getByTestId("candidate-banner");
      await expect(banner).toContainText(
        "Based on v1. Current is v3, so this candidate can no longer be promoted. Stage a new candidate on v3.",
      );
      await expect(banner.getByRole("button", {name: "Promote"})).toBeDisabled();
      expect(await readState(fixture, staged.artifactId, staged.candidateId))
        .toEqual({currentVersionId: accepted.body.version.id, state: "candidate"});
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
