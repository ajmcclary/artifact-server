import {expect, test} from "@playwright/test";

import {publishNew} from "../support/publishing.js";
import {fetchVersion} from "../support/runtime-harness.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";
import {openInspectorTab, openReview} from "./review-helpers.js";

test.describe("public links are unlisted and say they can be redistributed", () => {
  test("AUTH-005-B: the visibility control warns that a public link can be redistributed, and public responses send noindex, nofollow", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Unlisted fixture</title><main><h1>Unlisted fixture</h1></main></html>",
        idempotencyKey: "auth-005-unlisted-fixture",
        name: "Unlisted fixture",
      });
      await localLogin(fixture);
      await openReview(fixture, {
        artifactId: published.body.artifact.id,
        path: "index.html",
        projectId: published.body.artifact.projectId,
        versionId: published.body.version.id,
      });
      await openInspectorTab(fixture.page, "Details");
      const inspector = fixture.page.getByRole("complementary", {name: "Artifact inspector"});
      const access = inspector.getByRole("combobox", {name: "Who can open this artifact"});
      await access.selectOption("public_link");
      // The product states before the change that the link can travel; it
      // does not present the link as private or protected.
      await expect(inspector.getByText(
        "The link can be redistributed. Earlier versions and history stay account-required.",
        {exact: true},
      )).toBeVisible();
      await inspector.getByRole("button", {name: "Save access"}).click();
      await expect(access).toHaveValue("public_link");

      // The public response asks crawlers not to index or follow it.
      const stable = await fetch(published.body.links.artifact, {redirect: "manual"});
      expect(stable.status).toBe(302);
      const location = stable.headers.get("location");
      if (location === null) throw new Error("The public link did not redirect.");
      const content = await fetchVersion(fixture.server, location);
      expect(content.status).toBe(200);
      expect(content.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(await content.text()).toContain("Unlisted fixture");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
