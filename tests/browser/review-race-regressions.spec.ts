import {randomUUID} from "node:crypto";

import {expect, test, type Page, type Route} from "@playwright/test";
import {z} from "zod";

import {
  type ApplicationCookies,
  bootstrapAdministrator,
  browserMutationHeaders,
  type InviteServer,
  signInAs,
  startInviteServer,
} from "../support/invites.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {localLogin, startBrowserFixture, stopBrowserFixture, type BrowserFixture} from "./browser-fixture.js";
import {createThreadOverApi, listThreadsOverApi} from "./comment-api.js";
import {commentThread, openInspectorTab, reviewHref} from "./review-helpers.js";

/**
 * Browser proofs for the Review races fixed together: a comment mutation that
 * settles after an artifact switch, a retried new-thread post whose first
 * response was lost, thumbnail load slots, and an unreadable share address.
 */

async function publishPage(fixture: BrowserFixture, name: string): Promise<PublishResponse> {
  return (await publishNew(fixture.server, fixture.installation, {
    accessSetting: "account_required",
    content: `<!doctype html><html lang="en"><head><title>${name}</title></head><body><h1 id="title">${name}</h1></body></html>`,
    idempotencyKey: `review-race-${randomUUID()}`,
    mediaType: "text/html; charset=utf-8",
    name,
    path: "index.html",
  })).body;
}

/** The member API's thread-create address for one artifact. */
function threadCreateUrl(artifactId: string) {
  return (url: URL): boolean =>
    url.pathname.includes(`/artifacts/${artifactId}/versions/`) && url.pathname.endsWith("/comments");
}

/** The guest API's thread-create address. */
const guestThreadCreateUrl = (url: URL): boolean => url.pathname === "/api/v1/share/threads";

/**
 * Send the browser's own request to the server from the route. Playwright's
 * route fetch runs outside the browser and drops the fetch metadata Chromium
 * computes, so the same-origin values Chromium sends for this request are
 * restored for the server's mutation-origin check.
 */
async function sendToServer(route: Route) {
  return route.fetch({headers: {
    ...await route.request().allHeaders(),
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  }});
}

/** Handle only the POST that creates a thread; every other request continues untouched. */
function onThreadCreate(handler: (route: Route) => Promise<void>) {
  return async (route: Route): Promise<void> => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await handler(route);
  };
}

/** Move Review to another artifact in the same document, as the in-app navigation does. */
async function navigateInDocument(page: Page, href: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState(window.history.state, "", target);
    window.dispatchEvent(new PopStateEvent("popstate", {state: window.history.state}));
  }, new URL(href).pathname + new URL(href).search);
}

test.describe("Review comment mutations across an artifact switch", () => {
  test("CMT-016-F: a new thread that settles after switching artifacts never lists or selects into the new artifact", async ({browser}) => {
    test.setTimeout(90_000);
    const fixture = await startBrowserFixture(browser);
    try {
      const alpha = await publishPage(fixture, "Alpha race page");
      const beta = await publishPage(fixture, "Beta race page");
      await createThreadOverApi(fixture, {
        artifactId: beta.artifact.id,
        body: "Beta standing thread",
        idempotencyKey: `review-race-${randomUUID()}`,
        versionId: beta.version.id,
      });
      await localLogin(fixture);
      const {page} = fixture;
      const betaHref = reviewHref(fixture.server.baseUrl, {artifactId: beta.artifact.id, versionId: beta.version.id});
      const alphaHref = reviewHref(fixture.server.baseUrl, {artifactId: alpha.artifact.id, versionId: alpha.version.id});
      await page.goto(betaHref);
      await openInspectorTab(page, "Comments");
      await expect(commentThread(page, "Beta standing thread")).toBeVisible();

      await navigateInDocument(page, alphaHref);
      await expect(page).toHaveURL(new RegExp(`artifact=${alpha.artifact.id}`, "u"));
      await expect(commentThread(page, "Beta standing thread")).toHaveCount(0);

      // The create reaches the server at once; its response is held until after the switch.
      const release = Promise.withResolvers<undefined>();
      const delivered = Promise.withResolvers<undefined>();
      await page.route(threadCreateUrl(alpha.artifact.id), onThreadCreate(async (route) => {
        const response = await sendToServer(route);
        expect(response.status()).toBe(201);
        await release.promise;
        await route.fulfill({response});
        delivered.resolve(undefined);
      }));
      const alphaListings: Array<string> = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (request.method() === "GET" && url.pathname.endsWith(`/artifacts/${alpha.artifact.id}/comments`)) {
          alphaListings.push(url.toString());
        }
      });

      await page.getByLabel("Add a comment").fill("Alpha late thread");
      await page.getByRole("button", {exact: true, name: "Post comment"}).click();
      await expect.poll(async () => (await listThreadsOverApi(fixture, alpha.artifact.id)).length).toBe(1);

      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`artifact=${beta.artifact.id}`, "u"));
      await expect(commentThread(page, "Beta standing thread")).toBeVisible();
      alphaListings.length = 0;

      release.resolve(undefined);
      await delivered.promise;
      // Give the settled mutation every chance to reload or select into this view.
      await page.waitForTimeout(1_500);
      expect(alphaListings).toEqual([]);
      await expect(commentThread(page, "Alpha late thread")).toHaveCount(0);
      await expect(commentThread(page, "Beta standing thread")).toBeVisible();
      await expect(page.getByLabel(/^Reply to /u)).toHaveCount(0);
      await expect(page.getByLabel("Add a comment")).toBeVisible();

      // The thread was created exactly once, on the artifact it was written on.
      await page.goForward();
      await expect(page).toHaveURL(new RegExp(`artifact=${alpha.artifact.id}`, "u"));
      await expect(commentThread(page, "Alpha late thread")).toHaveCount(1);
      await expect(commentThread(page, "Beta standing thread")).toHaveCount(0);
      expect((await listThreadsOverApi(fixture, beta.artifact.id)).map((thread) => thread.body))
        .toEqual(["Beta standing thread"]);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});

/**
 * Let the first thread create reach the server, then drop its response so the
 * browser sees a network failure for a thread the server did store.
 */
async function loseFirstCreateResponse(
  page: Page,
  createUrl: (url: URL) => boolean,
): Promise<{readonly keys: Array<string | null>; readonly lostStatuses: Array<number>}> {
  const keys: Array<string | null> = [];
  const lostStatuses: Array<number> = [];
  await page.route(createUrl, onThreadCreate(async (route) => {
    keys.push(route.request().headers()["idempotency-key"] ?? null);
    if (keys.length === 1) {
      lostStatuses.push((await sendToServer(route)).status());
      await route.abort("connectionreset");
      return;
    }
    await route.continue();
  }));
  return {keys, lostStatuses};
}

test.describe("Retrying a new thread after a lost response", () => {
  test("CMT-010-B: a member's retried new-thread post replays the stored thread instead of creating a second one", async ({browser}) => {
    test.setTimeout(90_000);
    const fixture = await startBrowserFixture(browser);
    try {
      const page = await publishPage(fixture, "Retry page");
      await localLogin(fixture);
      const {page: browserPage} = fixture;
      await browserPage.goto(reviewHref(fixture.server.baseUrl, {artifactId: page.artifact.id, versionId: page.version.id}));
      await openInspectorTab(browserPage, "Comments");
      const attempts = await loseFirstCreateResponse(browserPage, threadCreateUrl(page.artifact.id));

      await browserPage.getByLabel("Add a comment").fill("Posted once, retried once");
      const post = browserPage.getByRole("button", {exact: true, name: "Post comment"});
      await post.click();
      await expect.poll(() => attempts.lostStatuses).toEqual([201]);
      expect((await listThreadsOverApi(fixture, page.artifact.id)).map((thread) => thread.body))
        .toEqual(["Posted once, retried once"]);
      // The lost response leaves the text in the composer for a retry.
      await expect(browserPage.getByLabel("Add a comment")).toHaveValue("Posted once, retried once");
      await expect(post).toBeEnabled();
      await post.click();

      await expect(commentThread(browserPage, "Posted once, retried once")).toHaveCount(1);
      expect(attempts.keys).toHaveLength(2);
      expect(attempts.keys[0]).not.toBeNull();
      expect(attempts.keys[1]).toBe(attempts.keys[0]);
      expect((await listThreadsOverApi(fixture, page.artifact.id)).map((thread) => thread.body))
        .toEqual(["Posted once, retried once"]);
      await browserPage.reload();
      await openInspectorTab(browserPage, "Comments");
      await expect(commentThread(browserPage, "Posted once, retried once")).toHaveCount(1);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test.describe("as a guest", () => {
    let server: InviteServer;
    let administrator: ApplicationCookies;

    test.beforeEach(async () => {
      server = await startInviteServer();
      administrator = await signInAs(server, bootstrapAdministrator);
    });

    test.afterEach(async () => {
      await server.stop();
    });

    test("CMT-010-B: a guest's retried new-thread post replays the stored thread instead of creating a second one", async ({browser}) => {
      test.setTimeout(90_000);
      const call = async (method: string, path: string, body: string | null = null) => {
        const init: RequestInit = {headers: browserMutationHeaders(server.server.baseUrl, administrator), method};
        if (body !== null) init.body = body;
        return fetch(`${server.server.baseUrl}${path}`, init);
      };
      const created = await call("POST", "/api/v1/projects", JSON.stringify({name: "Guest retry"}));
      const projectId = z.object({project: z.object({id: z.string()})}).parse(await created.json()).project.id;
      const {body: published} = await publishNew(server.server, server.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><title>Guest retry</title><h1>Guest retry page</h1>",
        idempotencyKey: `review-race-${randomUUID()}`,
        name: "Guest retry page",
        projectId,
      });
      const shared = await call("POST", `/api/v1/projects/${projectId}/artifacts/${published.artifact.id}/share-links`, JSON.stringify({
        expiresAt: null,
        label: "Retry review",
        permissions: ["artifact.view", "comment.read", "comment.write"],
        target: {kind: "latest"},
      }));
      expect(shared.status).toBe(201);
      const {link} = z.object({link: z.object({url: z.string()})}).parse(await shared.json());

      const context = await browser.newContext({viewport: {height: 1000, width: 1600}});
      try {
        const page = await context.newPage();
        await page.goto(link.url);
        await expect(page.frameLocator('iframe[title="Guest retry page"]').getByRole("heading", {name: "Guest retry page"}))
          .toBeVisible();
        // Name the guest first, so both attempts below are the same plain post.
        await page.getByLabel("Add a comment").fill("Naming post");
        await page.getByRole("button", {exact: true, name: "Comment"}).click();
        const dialog = page.getByRole("dialog", {name: "Before you comment"});
        await dialog.getByLabel("Your name, shown next to your comments").fill("Pat");
        await dialog.getByRole("button", {name: "Continue"}).click();
        await expect(page.getByRole("article", {name: "Comment by Pat"})).toHaveCount(1);
        // A posted comment stays selected; clear it so the composer starts a new thread.
        await page.getByRole("article", {name: "Comment by Pat"}).locator('[role="button"][aria-expanded]').first().click();
        await expect(page.getByLabel("Add a comment")).toBeVisible();

        const attempts = await loseFirstCreateResponse(page, guestThreadCreateUrl);
        await page.getByLabel("Add a comment").fill("Guest posted once");
        const post = page.getByRole("button", {exact: true, name: "Comment"});
        await post.click();
        // The server stored the first attempt; only its response was lost.
        await expect.poll(() => attempts.lostStatuses).toEqual([201]);
        await expect(page.getByLabel("Add a comment")).toHaveValue("Guest posted once");
        await expect(post).toBeEnabled();
        await post.click();

        await expect(page.getByRole("article", {name: "Comment by Pat"}).filter({hasText: "Guest posted once"})).toHaveCount(1);
        expect(attempts.keys).toHaveLength(2);
        expect(attempts.keys[0]).not.toBeNull();
        expect(attempts.keys[1]).toBe(attempts.keys[0]);
      } finally {
        await context.close();
      }
      const listed = await call("GET", `/api/v1/artifacts/${published.artifact.id}/comments?projectId=${projectId}`);
      const bodies = z.object({items: z.array(z.object({body: z.string()}))}).parse(await listed.json()).items
        .map((item) => item.body);
      expect(bodies.toSorted()).toEqual(["Guest posted once", "Naming post"]);
    });
  });
});

test.describe("Activity thumbnail load slots", () => {
  test("ACT-005-B: more than four thumbnails all render without waiting out the frame-ready timeout", async ({browser}) => {
    test.setTimeout(120_000);
    const fixture = await startBrowserFixture(browser);
    try {
      const count = 6;
      await Promise.all(Array.from({length: count}, async (_, index) => {
        const published = await publishPage(fixture, `Slot thumb ${index + 1}`);
        await createThreadOverApi(fixture, {
          anchor: {htmlAnchor: {point: {x: 0.5, y: 0.5}, selector: "#title", tagName: "H1"}, originalText: "Title"},
          artifactId: published.artifact.id,
          body: `Slot pin ${index + 1}`,
          idempotencyKey: `review-race-${randomUUID()}`,
          path: "index.html",
          versionId: published.version.id,
        });
      }));
      await localLogin(fixture);
      const {page} = fixture;
      // Tall enough that every conversation is near the viewport at once, so
      // only the four load slots stand between the fifth screen and its load.
      await page.setViewportSize({height: 7_000, width: 1_680});
      await page.goto(`${fixture.server.baseUrl}/review?type=comments`);
      await expect(page.locator("[data-thumbnail-for]")).toHaveCount(count);
      await expect(page.locator("[data-thumbnail='frame']").first()).toBeVisible();
      // A slot held until the 10 s frame-ready timeout would keep the fifth
      // and sixth screens from even starting inside this window.
      await expect(page.locator("[data-thumbnail='frame']")).toHaveCount(count, {timeout: 6_000});
      for (let index = 0; index < count; index += 1) {
        const frame = page.frameLocator("[data-thumbnail='frame']").nth(index).frameLocator("iframe");
        // eslint-disable-next-line no-await-in-loop -- each screen is checked in turn
        await expect(frame.getByRole("heading", {name: /^Slot thumb \d$/u})).toBeVisible({timeout: 6_000});
      }
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});

test.describe("An unreadable share address", () => {
  for (const address of ["/s/%E0%A4%A", "/review/shared/%"]) {
    test(`PRM-007-F: ${address} shows the ended-link page instead of a blank page`, async ({browser}) => {
      const fixture = await startBrowserFixture(browser);
      const errors: Array<string> = [];
      fixture.page.on("pageerror", (error) => errors.push(error.message));
      try {
        const response = await fixture.page.goto(`${fixture.server.baseUrl}${address}`);
        expect(response?.status()).toBe(200);
        await expect(fixture.page.getByRole("heading", {name: "This link has ended"})).toBeVisible();
        await expect(fixture.page.getByText("This link has ended or isn't valid. Ask the person who shared it for a new one."))
          .toBeVisible();
        expect(errors).toEqual([]);
      } finally {
        await stopBrowserFixture(fixture);
      }
    });
  }
});
