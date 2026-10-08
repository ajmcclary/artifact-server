import {randomUUID} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {expect, test} from "@playwright/test";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import {publishPath} from "../../src/client/file-publication-client.js";
import {writePreviewSourceFixture} from "../support/claude-design-fixture.js";

import {
  commitStagedUpload,
  createStagedUpload,
  publishNew,
  publishVersion,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  workspaceViewport,
} from "./browser-fixture.js";
import {fetchVersion} from "../support/runtime-harness.js";
import {annotateSwitch, interactiveFrame, isolatedReviewFrame, openInspectorTab, openReview, previewFrame, returnToGallery, reviewHref, startAnnotating} from "./review-helpers.js";
import {publishScenarioFixture} from "./scenario-fixture.js";
import {
  createThreadOverApi,
  deleteThreadOverApi,
} from "./comment-api.js";

/**
 * The critical cross-engine slice: the security-sensitive review paths that
 * the Firefox/WebKit matrix projects run. Kept compact on purpose — the full
 * Chromium suite owns the cosmetic coverage. Tag: @critical.
 */
test.describe("critical engine review paths @critical", () => {
  test("CMT-015-B CMT-015-F: pages open live with Annotate off, and the one Annotate switch moves to the sandbox and back @critical", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: `<!doctype html><html lang="en"><head><title>Fragment router</title></head><body>
          <nav><a href="#claims"><span>Claims</span></a></nav>
          <h1>Dashboard</h1><button onclick="this.textContent = 'Action saved'">Save action</button>
          <script>
            window.addEventListener('hashchange', function () {
              document.querySelector('h1').textContent = location.hash === '#claims' ? 'Claims screen' : 'Dashboard';
            });
            var home = document.createElement('a');
            home.href = '#dashboard'; home.textContent = 'Dashboard';
            document.querySelector('nav').appendChild(home);
          </script></body></html>`,
        idempotencyKey: "critical-fragment-navigation",
        name: "Fragment router",
      });
      await localLogin(fixture);
      await openReview(fixture, {artifactId: published.body.artifact.id, versionId: published.body.version.id});
      const page = fixture.page;
      const toggle = annotateSwitch(page);
      // The page opens live with Annotate off: its own links and controls work.
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      const live = interactiveFrame(page);
      await live.getByRole("button", {name: "Save action"}).click();
      await live.getByRole("link", {name: "Claims", exact: true}).click();
      await expect(live.getByRole("heading", {name: "Claims screen"})).toBeVisible();
      await expect(live.getByRole("button", {name: "Action saved"})).toBeVisible();

      await startAnnotating(page);
      const reviewFrame = isolatedReviewFrame(page);
      const preview = reviewFrame.frameLocator("iframe");
      await expect(reviewFrame.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
      expect(await preview.locator("body").evaluate(() => window.origin)).toBe("null");
      // Armed, a click on a link places a comment instead of navigating. The
      // sandbox's bridge starts in text-selection mode and switches plain clicks
      // to comments only when the review frame's set-input-method arrives after
      // the frame reports ready; it marks that switch on its body. Linux WebKit
      // can take long enough that a click sent before it navigates instead.
      await expect(preview.locator("body")).toHaveAttribute("data-plannotator-pinpoint-cursor", "");
      await preview.getByRole("link", {name: "Claims", exact: true}).click();
      await expect(reviewFrame.getByPlaceholder("Add a comment...")).toBeVisible();
      await expect(preview.getByRole("heading", {name: "Dashboard"})).toBeVisible();
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await expect(page.locator('iframe[src="/review-frame"]')).toHaveCount(0);
      await live.getByRole("link", {name: "Claims", exact: true}).click();
      await expect(live.getByRole("heading", {name: "Claims screen"})).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-016-B CMT-016-F: an exact Review URL renders the pinned version @critical", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const target = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Critical exact</title><main><h1>Critical historical target</h1></main></html>",
        idempotencyKey: "critical-exact-target-v1",
        name: "Critical exact target",
      });
      await publishVersion(fixture.server, fixture.installation, {
        artifactId: target.body.artifact.id,
        content: "<!doctype html><html lang=\"en\"><title>Critical exact latest</title><main><h1>Critical replacement content</h1></main></html>",
        expectedCurrentVersionId: target.body.version.id,
        idempotencyKey: "critical-exact-target-v2",
      });

      await localLogin(fixture);
      await fixture.page.goto(target.body.links.review);
      await startAnnotating(fixture.page);

      const reviewFrame = isolatedReviewFrame(fixture.page);
      const preview = reviewFrame.frameLocator("iframe");
      await expect(preview.getByRole("heading", {name: "Critical historical target"}))
        .toBeVisible();
      await expect(preview.getByRole("heading", {name: "Critical replacement content"}))
        .toHaveCount(0);
      expect(new URL(fixture.page.url()).searchParams.get("version"))
        .toBe(target.body.version.id);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-014-B CMT-014-F: hostile artifact HTML stays inside an opaque-origin sandbox @critical", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Critical sandbox probe</title></head><body><p id=\"critical-probe-parent\">parent:pending</p><script>(function () { try { window.parent.document.title; document.getElementById(\"critical-probe-parent\").textContent = \"parent:reached\"; } catch (error) { document.getElementById(\"critical-probe-parent\").textContent = \"parent:blocked\"; } })();</script></body></html>",
        idempotencyKey: "critical-sandbox-isolation",
        mediaType: "text/html; charset=utf-8",
        name: "Critical sandbox probe",
        path: "index.html",
      });
      await localLogin(fixture);
      await openReview(fixture, {artifactId: published.body.artifact.id, versionId: published.body.version.id});
      await startAnnotating(fixture.page);

      const reviewFrame = isolatedReviewFrame(fixture.page);
      const sandboxElement = reviewFrame.locator("iframe");
      await expect(sandboxElement).toHaveAttribute("sandbox", "allow-scripts");
      await expect(sandboxElement).not.toHaveAttribute("sandbox", /allow-same-origin/u);

      const artifactFrame = reviewFrame.frameLocator("iframe");
      expect(await artifactFrame.locator("body").evaluate(() => window.origin))
        .toBe("null");
      await expect(artifactFrame.locator("#critical-probe-parent")).toHaveText("parent:blocked");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-018-B CMT-018-F: private historical HTML renders after the current pointer moves on @critical", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const historical = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Critical historical</title><main><h1>Private historical asset</h1></main></html>",
        idempotencyKey: "critical-historical-asset-v1",
        name: "Critical historical asset",
      });
      await publishVersion(fixture.server, fixture.installation, {
        artifactId: historical.body.artifact.id,
        content: "<!doctype html><html lang=\"en\"><title>Critical replacement</title><main><h1>Current replacement</h1></main></html>",
        expectedCurrentVersionId: historical.body.version.id,
        idempotencyKey: "critical-historical-asset-v2",
      });

      await localLogin(fixture);
      await fixture.page.goto(historical.body.links.review);
      await startAnnotating(fixture.page);
      const reviewFrame = isolatedReviewFrame(fixture.page);
      const preview = reviewFrame.frameLocator("iframe");
      await expect(preview.getByRole("heading", {name: "Private historical asset"}))
        .toBeVisible();
      expect(new URL(fixture.page.url()).searchParams.get("version"))
        .toBe(historical.body.version.id);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CNT-012-B CNT-012-F: a reopen and a page switch reuse one lease origin from cache, and logout ends it @critical", async ({browser}) => {
    let bytesRead = 0;
    const fixture = await startBrowserFixture(browser, {serverOptions: {
      blobReadObserver: {
        bytesRead: (byteLength) => {
          bytesRead += byteLength;
        },
        streamClosed: () => undefined,
      },
      contentVariantBuilds: "manual",
    }});
    try {
      const encoder = new TextEncoder();
      const files: readonly TestSiteFile[] = [
        {bytes: encoder.encode("<!doctype html><html lang=\"en\"><link rel=\"stylesheet\" href=\"shared.css\"><h1>Lease page one</h1></html>"), mediaType: "text/html; charset=utf-8", path: "index.html"},
        {bytes: encoder.encode("<!doctype html><html lang=\"en\"><link rel=\"stylesheet\" href=\"shared.css\"><h1>Lease page two</h1></html>"), mediaType: "text/html; charset=utf-8", path: "two.html"},
        // Larger than both pages together, so any server read of it shows in the byte count.
        {bytes: encoder.encode(`h1 { color: rgb(1, 2, 3); }\n/*${"x".repeat(8_192)}*/`), mediaType: "text/css; charset=utf-8", path: "shared.css"},
      ];
      const stylesheetBytes = files[2]?.bytes.byteLength ?? 0;
      const upload = await createStagedUpload(fixture.server, fixture.installation, "index.html", files);
      await uploadEveryStagedFile(fixture.installation, upload.body, files);
      const published = (await commitStagedUpload(fixture.installation, upload.body, "critical-lease-reuse", {
        accessSetting: "account_required",
        kind: "new_artifact",
        name: "Critical lease reuse",
        tags: [],
      })).body;
      const target = {artifactId: published.artifact.id, versionId: published.version.id};
      const leaseHosts = new Set<string>();
      const leaseStatuses: number[] = [];
      fixture.page.on("response", (response) => {
        const url = new URL(response.url());
        if (url.hostname.startsWith("review-")) leaseHosts.add(url.hostname);
        if (url.pathname.endsWith("/preview-leases")) leaseStatuses.push(response.status());
      });

      await localLogin(fixture);
      await fixture.page.goto(reviewHref(fixture.server.baseUrl, target));
      await startAnnotating(fixture.page);
      const preview = isolatedReviewFrame(fixture.page).frameLocator("iframe");
      await expect(preview.getByRole("heading", {name: "Lease page one"})).toBeVisible();
      await expect.poll(() => leaseHosts.size).toBe(1);

      const beforeReopen = bytesRead;
      // A reopen is a new navigation to the same review, as a person returning to it makes.
      await fixture.page.goto("about:blank");
      await fixture.page.goto(reviewHref(fixture.server.baseUrl, target));
      await startAnnotating(fixture.page);
      await expect(preview.getByRole("heading", {name: "Lease page one"})).toBeVisible();
      expect(leaseStatuses.at(-1), "the reopen confirmed the stored lease").toBe(200);
      expect(leaseHosts.size, "the reopen used the same lease origin").toBe(1);
      // An engine may refetch the entry page through /file; the shared stylesheet must come from cache.
      expect(bytesRead - beforeReopen, "the reopen served the stylesheet from cache").toBeLessThan(stylesheetBytes);

      const beforeSwitch = bytesRead;
      await fixture.page.goto(reviewHref(fixture.server.baseUrl, {...target, path: "two.html"}));
      await startAnnotating(fixture.page);
      await expect(preview.getByRole("heading", {name: "Lease page two"})).toBeVisible();
      expect(leaseHosts.size, "the page switch used the same lease origin").toBe(1);
      expect(bytesRead - beforeSwitch, "the page switch served the shared stylesheet from cache").toBeLessThan(stylesheetBytes);

      const [leaseHost] = leaseHosts;
      expect(await fixture.page.evaluate(() => localStorage.getItem("artifact-server.preview-leases")))
        .toContain(leaseHost);
      await fixture.page.getByRole("button", {name: /^Account menu: /u}).click();
      await fixture.page.getByRole("menuitem", {name: "Sign out"}).click();
      // Sign-out forgets the stored lease and the server rejects its hostname from then on.
      await expect.poll(() => fixture.page.evaluate(
        () => localStorage.getItem("artifact-server.preview-leases"),
      ).catch(() => "navigating")).toBeNull();
      expect((await fetchVersion(fixture.server, `http://${leaseHost ?? ""}/index.html`)).status).toBe(401);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-023-B CMT-023-F: two open reviewers converge on thread create and delete @critical", async ({browser}) => {
    test.setTimeout(120_000);
    const fixture = await startBrowserFixture(browser);
    const secondContext = await browser.newContext({viewport: workspaceViewport});
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><h1>Critical convergence fixture</h1></html>",
        idempotencyKey: "critical-convergence-fixture",
        name: "Critical convergence fixture",
      });
      const pageB = await secondContext.newPage();

      await localLogin(fixture);
      await pageB.goto(fixture.server.baseUrl);
      await expect(pageB.getByRole("link", {name: "Artifact Server"})).toBeVisible();

      const target = reviewHref(fixture.server.baseUrl, {artifactId: published.body.artifact.id, versionId: published.body.version.id});
      await fixture.page.goto(target);
      await pageB.goto(target);
      await openInspectorTab(fixture.page, "Comments");
      await openInspectorTab(pageB, "Comments");

      const cardA = fixture.page.getByRole("article")
        .filter({hasText: "Critical convergence"});
      const cardB = pageB.getByRole("article")
        .filter({hasText: "Critical convergence"});

      const thread = await createThreadOverApi(fixture, {
        artifactId: published.body.artifact.id,
        body: "Critical convergence",
        idempotencyKey: "critical-convergence-thread",
        versionId: published.body.version.id,
      });
      await expect(cardA, "first reviewer sees the new thread").toBeVisible({timeout: 25_000});
      await expect(cardB, "second reviewer sees the new thread").toBeVisible({timeout: 25_000});

      await deleteThreadOverApi(fixture, {
        artifactId: published.body.artifact.id,
        idempotencyKey: "critical-convergence-delete",
        threadId: thread.id,
      });
      await expect(cardA, "first reviewer loses the deleted thread")
        .toHaveCount(0, {timeout: 25_000});
      await expect(cardB, "second reviewer loses the deleted thread")
        .toHaveCount(0, {timeout: 25_000});
    } finally {
      await secondContext.close();
      await stopBrowserFixture(fixture);
    }
  });

  test("DSN-008-B DSN-009-B: a designed scenario restores inside the opaque-origin sandbox @critical", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await localLogin(fixture);
      const published = await publishScenarioFixture(fixture, "critical-dsn-008");
      await fixture.page.goto(`${reviewHref(fixture.server.baseUrl, {artifactId: published.artifact.id, path: "honest.html", versionId: published.version.id})}&scenario=5`);
      await startAnnotating(fixture.page);
      await expect(previewFrame(fixture.page).getByRole("heading", {name: "Validation"})).toBeVisible();
      await expect(fixture.page.getByRole("combobox", {name: "Designed scenario"})).toHaveValue("5");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("DSN-004 gallery: a private design gallery opens exact sandboxed pages and returns through history @critical", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    const directory = await mkdtemp(path.join(tmpdir(), "critical-design-gallery-"));
    try {
      await writePreviewSourceFixture(directory);
      const published = await Effect.runPromise(publishPath({
        serverOrigin: fixture.server.baseUrl,
        apiToken: Redacted.make(fixture.installation.apiToken),
      }, {
        inputPath: directory,
        idempotencyKey: randomUUID(),
        target: {kind: "new_artifact", accessSetting: "account_required", tags: []},
      }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(NodeFileSystem.layer)));
      await localLogin(fixture);
      await fixture.page.goto(published.links.review.toString());
      const gallery = fixture.page.getByRole("region", {name: "Claims Workspace gallery"});
      const app = gallery.getByRole("link", {name: "Open Examiner App · Prototype · Prototypes"});
      const card = gallery.getByRole("link", {name: "Open Primary button · Component · Actions"});
      await expect.poll(() => app.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(16);
      await expect(fixture.page.locator("iframe")).toHaveCount(0);

      await card.click();
      // A gallery page opens live; Annotate moves it into the sandbox.
      await expect(interactiveFrame(fixture.page).getByRole("button", {name: "Try button"})).toBeVisible();
      await startAnnotating(fixture.page);
      const reviewFrame = isolatedReviewFrame(fixture.page);
      await expect(reviewFrame.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
      await expect(reviewFrame.frameLocator("iframe").getByRole("button", {name: "Try button"})).toBeVisible();
      const exact = new URL(fixture.page.url());
      expect(exact.searchParams.get("version")).toBe(published.version.id);
      expect(exact.searchParams.get("path")).toBe("project/components/buttons.card.html");

      await fixture.page.goBack();
      await expect(card).toBeFocused();
      await app.click();
      const interactive = fixture.page.locator('iframe[title^="Interactive preview: "]');
      await expect(interactive).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
      await expect(fixture.page.frameLocator('iframe[title^="Interactive preview: "]').getByRole("heading", {name: "Examiner app"})).toBeVisible();
      await fixture.page.goBack();
      await fixture.page.goForward();
      await expect(fixture.page.frameLocator('iframe[title^="Interactive preview: "]').getByRole("heading", {name: "Examiner app"})).toBeVisible();
      await returnToGallery(fixture.page);
      await expect(app).toBeFocused();
    } finally {
      await stopBrowserFixture(fixture);
      await rm(directory, {recursive: true, force: true});
    }
  });

  test("DSN-005 library: the Library opens an exact gallery page and returns through history @critical", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    const directory = await mkdtemp(path.join(tmpdir(), "critical-design-library-"));
    try {
      await writePreviewSourceFixture(directory);
      const published = await Effect.runPromise(publishPath({
        serverOrigin: fixture.server.baseUrl,
        apiToken: Redacted.make(fixture.installation.apiToken),
      }, {
        inputPath: directory,
        idempotencyKey: randomUUID(),
        target: {kind: "new_artifact", accessSetting: "account_required", name: "Claims Workspace", tags: []},
      }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(NodeFileSystem.layer)));
      await localLogin(fixture);
      await fixture.page.goto(`${fixture.server.baseUrl}/review/library`);
      const card = fixture.page.getByRole("region", {name: "Library", exact: true})
        .locator(`a[href*="artifact=${published.artifact.id}"][href*="path=${encodeURIComponent("project/components/buttons.card.html")}"]`);
      await card.click();
      const exact = new URL(fixture.page.url());
      expect(exact.searchParams.get("version")).toBe(published.version.id);
      expect(exact.searchParams.get("path")).toBe("project/components/buttons.card.html");
      await expect(interactiveFrame(fixture.page).getByRole("button", {name: "Try button"})).toBeVisible();
      await fixture.page.goBack();
      await expect(card).toBeFocused();
    } finally {
      await stopBrowserFixture(fixture);
      await rm(directory, {recursive: true, force: true});
    }
  });

  test("ACT-005-B ACT-005-F: an Activity thumbnail draws the thread's exact private version inside the review frame @critical", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = (await publishNew(fixture.server, fixture.installation, {accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Engine thumb</title><h1 id=\"title\">Engine thumb version one</h1></html>",
        idempotencyKey: "critical-activity-thumb-v1", mediaType: "text/html; charset=utf-8", name: "Engine thumb", path: "index.html"})).body;
      await createThreadOverApi(fixture, {anchor: {htmlAnchor: {point: {x: 0.5, y: 0.5}, selector: "#title", tagName: "H1"}, originalText: "Engine thumb"},
        artifactId: first.artifact.id, body: "On version one.", idempotencyKey: "critical-activity-thumb-thread", path: "index.html", versionId: first.version.id});
      await publishVersion(fixture.server, fixture.installation, {artifactId: first.artifact.id,
        content: "<!doctype html><html lang=\"en\"><title>Engine thumb</title><h1 id=\"title\">Engine thumb version two</h1></html>",
        expectedCurrentVersionId: first.version.id, idempotencyKey: "critical-activity-thumb-v2"});
      await localLogin(fixture);
      await fixture.page.goto(`${fixture.server.baseUrl}/review?type=comments`);
      // The review frame draws the artifact in its own nested, sandboxed frame.
      const frame = fixture.page.frameLocator("[data-thumbnail='frame']").first().frameLocator("iframe");
      await expect(frame.getByRole("heading", {name: "Engine thumb version one"})).toBeVisible();
      await expect(frame.getByRole("heading", {name: "Engine thumb version two"})).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
