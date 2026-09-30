import {expect, test} from "@playwright/test";

import {publishNew} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  workspaceViewport,
} from "./browser-fixture.js";
import {openInspectorTab, reviewHref} from "./review-helpers.js";
import {
  createThreadOverApi,
  deleteThreadOverApi,
} from "./comment-api.js";

const pollWait = {timeout: 25_000};

test.describe("comment revision convergence", () => {
  test("two open reviewers converge when a thread is created and deleted elsewhere", async ({browser}) => {
    test.setTimeout(120_000);
    const fixture = await startBrowserFixture(browser);
    const secondContext = await browser.newContext({viewport: workspaceViewport});
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><h1>Convergence fixture</h1></html>",
        idempotencyKey: "cmt-convergence-fixture",
        name: "Convergence fixture",
      });
      const pageB = await secondContext.newPage();

      await localLogin(fixture);
      await pageB.goto(fixture.server.baseUrl);
      await expect(pageB.getByRole("link", {name: "Artifact Server"}))
        .toBeVisible();

      const target = reviewHref(fixture.server.baseUrl, {artifactId: published.body.artifact.id, versionId: published.body.version.id});
      await fixture.page.goto(target);
      await pageB.goto(target);
      await openInspectorTab(fixture.page, "Comments");
      await openInspectorTab(pageB, "Comments");

      const cardA = fixture.page.getByRole("article")
        .filter({hasText: "Converges everywhere"});
      const cardB = pageB.getByRole("article")
        .filter({hasText: "Converges everywhere"});

      // A thread created outside either browser appears on both open surfaces.
      const thread = await createThreadOverApi(fixture, {
        artifactId: published.body.artifact.id,
        body: "Converges everywhere",
        idempotencyKey: "cmt-convergence-thread",
        versionId: published.body.version.id,
      });
      await expect(cardA, "first reviewer sees the new thread").toBeVisible(pollWait);
      await expect(cardB, "second reviewer sees the new thread").toBeVisible(pollWait);

      // A deletion outside either browser removes it from both open surfaces.
      await deleteThreadOverApi(fixture, {
        artifactId: published.body.artifact.id,
        idempotencyKey: "cmt-convergence-delete",
        threadId: thread.id,
      });
      await expect(cardA, "first reviewer loses the deleted thread")
        .toHaveCount(0, pollWait);
      await expect(cardB, "second reviewer loses the deleted thread")
        .toHaveCount(0, pollWait);
    } finally {
      await secondContext.close();
      await stopBrowserFixture(fixture);
    }
  });
});
