import {expect, test} from "@playwright/test";

import {publishNew, publishVersion} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";
import {openInspectorTab, reviewHref, selectThread, versionsList} from "./review-helpers.js";
import {createThreadOverApi} from "./comment-api.js";

const pageHtml = (title: string): string =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head>`
  + `<body><h1>${title}</h1><p id="claim">A claim worth reviewing.</p></body></html>`;

test.describe("comment draft durability", () => {
  test("DRF-001-B DRF-001-F: draft text survives a version switch, artifact navigation, and a page reload, restores into the same composer with the draft marker, and is gone after the comment posts and after explicit discard", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: pageHtml("Draft fixture"),
        idempotencyKey: "drf-001-fixture-v1",
        mediaType: "text/html; charset=utf-8",
        name: "Draft fixture",
        path: "index.html",
      });
      const second = await publishVersion(fixture.server, fixture.installation, {
        artifactId: first.body.artifact.id,
        content: pageHtml("Draft fixture v2"),
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: "drf-001-fixture-v2",
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
      });
      await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: pageHtml("Other fixture"),
        idempotencyKey: "drf-001-other-fixture",
        mediaType: "text/html; charset=utf-8",
        name: "Other fixture",
        path: "index.html",
      });
      const artifactId = first.body.artifact.id;
      const versionId = second.body.version.id;
      await createThreadOverApi(fixture, {
        artifactId,
        body: "Seeded thread for the reply draft.",
        idempotencyKey: "drf-001-seed-thread",
        versionId,
      });

      await localLogin(fixture);
      const page = fixture.page;
      page.on("dialog", (dialog) => void dialog.accept());
      const reviewUrl =
        reviewHref(fixture.server.baseUrl, {artifactId, versionId});
      await page.goto(reviewUrl);
      await openInspectorTab(page, "Comments");

      // One composer is docked at the panel's foot: a new comment, or a reply to the
      // selected thread. Each keeps its own draft while the other is shown.
      const newThread = page.getByLabel("Add a comment");
      const reply = page.getByLabel("Reply", {exact: true});
      const newText = "A careful multi-paragraph thought about the heading.";
      const replyText = "Reply in progress, do not lose me.";
      await newThread.fill(newText);
      await selectThread(page, "Seeded thread for the reply draft.");
      await expect(newThread).toHaveCount(0);
      await reply.fill(replyText);
      await page.getByRole("button", {exact: true, name: "Cancel reply"}).click();
      await expect(reply).toHaveCount(0);
      await expect(newThread).toHaveValue(newText);
      await selectThread(page, "Seeded thread for the reply draft.");
      await expect(reply).toHaveValue(replyText);
      await expect(page.locator("[data-comment-composer]")).toHaveCount(1);
      // The mirror write is debounced: poll until both the new-thread draft
      // and the reply draft have settled into localStorage.
      await expect.poll(() => page.evaluate(
        () => Object.keys(localStorage).filter((key) => key.startsWith("draft:")),
      ).catch(() => null).then((keys) => keys === null ? null : ({
        hasNewThread: keys.some((key) => key.includes(":new:")),
        hasReply: keys.some((key) => !key.includes(":new:")),
        total: keys.length,
      }))).toEqual({hasNewThread: true, hasReply: true, total: 2});

      const expectBothDrafts = async (): Promise<void> => {
        await openInspectorTab(page, "Comments");
        await expect(newThread.or(reply)).toBeVisible();
        if (await reply.count() > 0) await page.getByRole("button", {exact: true, name: "Cancel reply"}).click();
        await expect(newThread).toHaveValue(newText);
        await expect(page.locator("[data-draft-marker]")).toHaveCount(1);
        await selectThread(page, "Seeded thread for the reply draft.");
        await expect(reply).toHaveValue(replyText);
        await expect(page.locator("[data-draft-marker]")).toHaveCount(1);
      };

      // In-app version switch and back: the drafts never left.
      await openInspectorTab(page, "Versions");
      await versionsList(page).getByRole("button", {name: /^v1 /u}).click();
      await openInspectorTab(page, "Versions");
      await versionsList(page).getByRole("button", {name: /^v2 /u}).click();
      await expectBothDrafts();

      // Artifact navigation and back (the newer "Other fixture" sorts first,
      // so the drafted artifact is the last catalog entry).
      await page.getByRole("button", {name: "Previous artifact"}).click();
      await expect(page).not.toHaveURL(new RegExp(`artifact=${artifactId}`, "u"));
      await page.getByRole("button", {name: "Next artifact"}).click();
      await expectBothDrafts();

      // A full reload restores both from the mirror, marker included.
      await page.reload();
      await expectBothDrafts();

      // Posting the reply consumes its draft; the composer stays on the selected thread.
      await page.getByRole("button", {name: "Post reply"}).click();
      await expect(page.getByText(replyText)).toBeVisible();
      await expect(reply).toHaveValue("");

      // Discarding the new-thread draft empties it; neither survives a reload.
      await page.getByRole("button", {exact: true, name: "Cancel reply"}).click();
      await page.getByRole("button", {name: "Discard"}).click();
      await expect(newThread).toHaveValue("");
      await page.reload();
      await openInspectorTab(page, "Comments");
      await expect(newThread).toHaveValue("");
      await selectThread(page, "Seeded thread for the reply draft.");
      await expect(reply).toHaveValue("");
      await expect(page.locator("[data-draft-marker]")).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
