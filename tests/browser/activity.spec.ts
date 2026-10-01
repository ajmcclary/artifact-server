import {expect, test} from "@playwright/test";

import {ApiClient, dispatchCreationSchema} from "../support/agent-dispatch.js";
import {publishNew, publishVersion, type PublishResponse} from "../support/publishing.js";
import {localLogin, startBrowserFixture, stopBrowserFixture, type BrowserFixture} from "./browser-fixture.js";
import {createReplyOverApi, createThreadOverApi} from "./comment-api.js";
import {inspectorTabButton} from "./review-helpers.js";

const key = (name: string): string => `activity-spec-${name}-key`;

async function publish(fixture: BrowserFixture, name: string, keyName: string, projectId = "prj_default"): Promise<PublishResponse> {
  return (await publishNew(fixture.server, fixture.installation, {
    accessSetting: "account_required",
    content: `<!doctype html><html lang="en"><head><title>${name}</title></head><body><h1 id="title">${name}</h1></body></html>`,
    idempotencyKey: key(keyName), mediaType: "text/html; charset=utf-8", name, path: "index.html", projectId,
  })).body;
}

async function thread(fixture: BrowserFixture, published: PublishResponse, body: string, keyName: string): Promise<string> {
  return (await createThreadOverApi(fixture, {
    artifactId: published.artifact.id, body, idempotencyKey: key(keyName), path: "index.html",
    projectId: published.artifact.projectId, versionId: published.version.id,
  })).id;
}

test.describe("Activity", () => {
  test("ACT-005-B: the feed shows versions, bursts and conversations under day panels, folds long threads, replies and resolves inline, filters through the URL, and opens the thread", async ({browser}) => {
    test.setTimeout(120_000);
    const fixture = await startBrowserFixture(browser);
    try {
      const burst = await publish(fixture, "Activity burst fixture", "burst-1");
      // Each version names the one before it, so they publish in order.
      await [2, 3].reduce(async (previous, n) => (await publishVersion(fixture.server, fixture.installation, {
        artifactId: burst.artifact.id, content: `<!doctype html><html lang="en"><title>v${n}</title><h1>v${n}</h1></html>`,
        expectedCurrentVersionId: await previous, idempotencyKey: key(`burst-${n}`),
      })).body.version.id, Promise.resolve(burst.version.id));
      const talked = await publish(fixture, "Activity conversation fixture", "talk");
      const threadId = await thread(fixture, talked, "Tighten the headline.", "talk-thread");
      // Replies post in order so "Reply number 5." is the newest.
      await [1, 2, 3, 4, 5].reduce(async (previous, n) => {
        await previous;
        await createReplyOverApi(fixture, {artifactId: talked.artifact.id, body: `Reply number ${n}.`, idempotencyKey: key(`reply-${n}`), projectId: talked.artifact.projectId, threadId});
      }, Promise.resolve());

      await localLogin(fixture);
      const page = fixture.page;
      await page.goto(`${fixture.server.baseUrl}/review`);
      await expect(page.getByRole("heading", {exact: true, level: 1, name: "Activity"})).toBeVisible();
      // The page header is the title alone: no projects-and-artifacts summary line.
      await expect(page.getByText(/\d+ projects? · /u)).toHaveCount(0);
      const today = page.getByRole("region", {name: /^Today \d{2}\/\d{2}\/\d{4}$/u});
      await expect(today.getByRole("heading", {exact: true, level: 2, name: "Today"})).toBeVisible();
      await expect(page.locator("[data-activity-feed]")).toContainText(/\d{1,2}:\d{2} (AM|PM)/u);

      // One publisher's versions across two artifacts within half an hour collapse into one burst.
      const burstEntry = page.locator("[data-entry^='burst:']");
      await expect(burstEntry.locator("[data-event]")).toHaveText(/published 4 versions in /u);
      await expect(burstEntry).toContainText("Activity conversation fixture and Activity burst fixture");
      await burstEntry.getByRole("button", {name: "Show 4 versions"}).click();
      const burstItem = burstEntry.locator("[data-group-item]").filter({hasText: "Activity burst fixture"});
      await expect(burstItem).toContainText("v1–v3");
      await expect(burstEntry.getByRole("button", {name: "Hide 4 versions"})).toHaveAttribute("aria-expanded", "true");
      // The open burst stays open across a reload in this tab.
      await page.reload();
      await expect(page.locator("[data-entry^='burst:']").getByRole("button", {name: "Hide 4 versions"})).toBeVisible();

      const conversation = page.getByLabel("Conversations on Activity conversation fixture");
      await expect(conversation.getByText("Reply number 5.")).toBeVisible();
      await expect(conversation.getByText("Reply number 1.")).toHaveCount(0);
      await conversation.getByRole("button", {name: "Show 3 earlier replies"}).click();
      await expect(conversation.getByText("Reply number 1.")).toBeVisible();

      await conversation.getByRole("button", {name: "Reply"}).first().click();
      await page.getByRole("textbox", {name: "Reply on Activity conversation fixture"}).fill("Inline from Activity.");
      await page.getByRole("button", {exact: true, name: "Reply"}).last().click();
      await expect(conversation.getByText("Inline from Activity.")).toBeVisible();

      await page.getByRole("radio", {name: /Needs you/u}).click();
      await expect(page).toHaveURL(/\/review\?segment=needs_you$/u);
      await expect(page.getByText(/Activity burst fixture/u)).toHaveCount(0);
      await page.getByRole("searchbox", {name: "Search activity"}).fill("headline");
      await expect(page).toHaveURL(/q=headline/u);
      await page.goBack();
      await expect(page).toHaveURL(/\/review\?segment=needs_you$/u);
      await page.getByRole("radio", {name: /^All/u}).click();

      await conversation.getByRole("button", {name: /^Resolve comment by/u}).first().click();
      // The resolution joins the conversation's card rather than adding a second one.
      await expect(conversation.getByText("Resolved", {exact: true})).toBeVisible();
      await expect(conversation.getByRole("button", {name: /^Reopen comment by/u})).toBeVisible();
      await expect(page.locator("[data-artifact-card]")).toHaveCount(1);

      // Record the address Open pushes; the workspace drops `thread=` as soon as it has selected the conversation.
      await page.evaluate(() => {
        const push = history.pushState.bind(history);
        history.pushState = (...args: Parameters<History["pushState"]>) => {
          document.documentElement.dataset["openedHref"] = String(args[2]);
          push(...args);
        };
      });
      await page.getByRole("button", {name: "Open Activity conversation fixture in review"}).first().click();
      await expect(page).toHaveURL(new RegExp(`artifact=${talked.artifact.id}`, "u"));
      expect(await page.evaluate(() => document.documentElement.dataset["openedHref"])).toContain(`thread=${threadId}`);
      await expect(inspectorTabButton(page, "Comments")).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("[aria-current='true']").filter({hasText: "Tighten the headline."}).first()).toBeVisible();
      await expect(page).not.toHaveURL(/thread=/u);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ACT-005-B: the Publish artifact popover offers the CLI command and the metric cards switch the segment", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publish(fixture, "Activity metric fixture", "metric");
      await thread(fixture, published, "Count me.", "metric-thread");
      await localLogin(fixture);
      const page = fixture.page;
      await page.goto(`${fixture.server.baseUrl}/review`);
      // The Activity row carries the Needs-you count.
      await expect(page.getByRole("navigation", {name: "Review and projects"}).getByRole("link", {name: /^Activity/u})).toContainText("1");
      await page.getByRole("button", {name: "Publish artifact"}).click();
      await expect(page.getByRole("dialog", {name: "Publish artifact"}).getByText("artifactserver publish ./dist")).toBeVisible();
      await page.keyboard.press("Escape");
      await page.getByRole("button", {name: /Needs you/u}).first().click();
      await expect(page).toHaveURL(/segment=needs_you/u);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ACT-005-F: a hostile comment body renders as inert text inside its card and stays searchable", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publish(fixture, "Activity hostile fixture", "hostile");
      const hostile = `‮evil‬​<img src=x onerror="window.pwnedMarker=1">${"W".repeat(10_000 - 64)}`;
      await thread(fixture, published, hostile.slice(0, 8_192), "hostile-thread");
      await localLogin(fixture);
      const page = fixture.page;
      await page.goto(`${fixture.server.baseUrl}/review`);
      const card = page.getByLabel("Conversations on Activity hostile fixture");
      await expect(card).toBeVisible();
      expect(await page.evaluate(() => "pwnedMarker" in window)).toBe(false);
      await expect(card.locator("img")).toHaveCount(0);
      const width = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(width).toBeLessThanOrEqual(0);
      await page.getByRole("searchbox", {name: "Search activity"}).fill("onerror");
      await expect(page.getByLabel("Conversations on Activity hostile fixture")).toBeVisible();
      await page.getByRole("searchbox", {name: "Search activity"}).fill("%_\\");
      await expect(page.getByText("Nothing matches these filters")).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ACT-005-F: a failed feed read offers Retry, and a failed summary leaves the feed working", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await publish(fixture, "Activity retry fixture", "retry");
      await localLogin(fixture);
      const page = fixture.page;
      const fail = {body: JSON.stringify({error: {code: "INTERNAL_ERROR", message: "Storage is unavailable."}}), contentType: "application/json", status: 500};
      await page.route("**/api/v1/activity/summary**", (route) => route.fulfill(fail));
      await page.route(/\/api\/v1\/activity\?/u, (route) => route.fulfill(fail));
      await page.goto(`${fixture.server.baseUrl}/review`);
      await expect(page.getByText("Activity could not load")).toBeVisible();
      // A failed summary hides the Needs-you badge rather than showing a guess.
      await expect(page.getByRole("navigation", {name: "Review and projects"}).getByRole("link", {name: /^Activity/u})).not.toContainText(/\d/u);
      await page.unroute(/\/api\/v1\/activity\?/u);
      await page.getByRole("button", {name: "Retry"}).click();
      await expect(page.getByText(/published v1 of Activity retry fixture/u)).toBeVisible();
      await expect(page.getByRole("button", {name: /Needs you/u}).first()).toContainText("—");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ACT-005-F: a filter whose read failed never shows another filter's entries when the reviewer returns to it", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await publish(fixture, "Activity cache fixture", "cache");
      await localLogin(fixture);
      const page = fixture.page;
      await page.goto(`${fixture.server.baseUrl}/review`);
      const published = page.getByText(/published v1 of Activity cache fixture/u);
      await expect(published).toBeVisible();
      // Every Needs-you read fails.
      await page.route(/\/api\/v1\/activity\?.*segment=needs_you/u, (route) => route.fulfill({
        body: JSON.stringify({error: {code: "INTERNAL_ERROR", message: "Storage is unavailable."}}), contentType: "application/json", status: 500,
      }));
      await page.getByRole("radio", {name: /Needs you/u}).click();
      await expect(page.getByText("Activity could not load")).toBeVisible();
      await page.getByRole("radio", {name: /^All/u}).click();
      await expect(published).toBeVisible();
      await page.getByRole("radio", {name: /Needs you/u}).click();
      await expect(page.getByText("Activity could not load")).toBeVisible();
      await expect(published).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ACT-005-F: the agent segment shows only threads held by an active send", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const owner = new ApiClient(fixture.server, fixture.installation.apiToken);
      const agent = await owner.registerAgent({agentSessionId: "activity-session", connectionKey: "activity-connection-key", displayName: "solo", workingDirectory: "/work/solo"});
      const held = await publish(fixture, "Activity held fixture", "held");
      const heldThread = await thread(fixture, held, "Agent, take this.", "held-thread");
      const response = await owner.sendDispatch({agentId: agent.id, idempotencyKey: key("held-send"), projectId: "prj_default", threadIds: [heldThread]});
      expect(dispatchCreationSchema.parse(await response.json()).dispatch.state).toBe("queued");
      const free = await publish(fixture, "Activity free fixture", "free");
      await thread(fixture, free, "Still mine.", "free-thread");
      await localLogin(fixture);
      await fixture.page.goto(`${fixture.server.baseUrl}/review?segment=with_agent`);
      await expect(fixture.page.getByLabel("Conversations on Activity held fixture")).toBeVisible();
      await expect(fixture.page.getByLabel("Conversations on Activity free fixture")).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});

test.describe("Activity people", () => {
  test("ACT-008-B: the People menu narrows the feed through the URL, counts the matches, and a chip removes the filter", async ({browser}) => {
    test.setTimeout(90_000);
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publish(fixture, "Activity people fixture", "people");
      await thread(fixture, published, "Who answers this?", "people-thread");
      await localLogin(fixture);
      const page = fixture.page;
      await page.goto(`${fixture.server.baseUrl}/review`);
      // The reviewer answers inline, so the conversation is now theirs.
      const conversation = page.getByLabel("Conversations on Activity people fixture");
      await conversation.getByRole("button", {name: "Reply"}).first().click();
      await page.getByRole("textbox", {name: "Reply on Activity people fixture"}).fill("I will.");
      await page.getByRole("button", {exact: true, name: "Reply"}).last().click();
      await expect(conversation.getByText("I will.")).toBeVisible();

      await page.getByRole("button", {name: "Everyone"}).click();
      const menu = page.getByRole("menu", {name: "People"});
      // The reviewer is marked as themselves; the installation token is a service principal, listed as an agent.
      await expect(menu.getByRole("menuitemcheckbox", {exact: true, name: "Local administrator"})).toContainText("You");
      const local = menu.getByRole("menuitemcheckbox", {exact: true, name: "Local"});
      await expect(local).toContainText("Agent");
      await local.click();
      await expect(page).toHaveURL(/\/review\?person=/u);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", {name: "People · 1"})).toBeVisible();
      // The conversation's newest reply is the reviewer's, so only the publish remains.
      await expect(page.getByText(/published v1 of Activity people fixture/u)).toBeVisible();
      await expect(page.getByLabel("Conversations on Activity people fixture")).toHaveCount(0);
      await expect(page.getByRole("status").filter({hasText: /^Showing \d+ of \d+ entries$/u})).toBeVisible();

      await page.getByRole("button", {name: "Remove Local filter"}).click();
      await expect(page).toHaveURL(/\/review$/u);
      await expect(page.getByLabel("Conversations on Activity people fixture")).toBeVisible();
      await expect(page.getByRole("button", {name: "Remove Local filter"})).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});

const anchorFor = (selector: string) => ({htmlAnchor: {point: {x: 0.5, y: 0.5}, selector, tagName: "H1"}, originalText: "Title"});

test.describe("Activity thumbnails", () => {
  test("ACT-005-B: an anchored conversation draws its exact version in the review frame, lazily and at most four at a time", async ({browser}) => {
    test.setTimeout(120_000);
    const fixture = await startBrowserFixture(browser);
    try {
      await Promise.all([1, 2, 3, 4, 5, 6].map(async (n) => {
        const published = await publish(fixture, `Activity thumb ${n}`, `thumb-${n}`);
        await createThreadOverApi(fixture, {anchor: anchorFor("#title"), artifactId: published.artifact.id, body: `Pin ${n}`,
          idempotencyKey: key(`thumb-thread-${n}`), path: "index.html", projectId: "prj_default", versionId: published.version.id});
      }));
      await localLogin(fixture);
      const page = fixture.page;
      let inFlight = 0;
      let peak = 0;
      page.on("request", (request) => {
        if (request.url().includes("/preview-leases")) peak = Math.max(peak, ++inFlight);
      });
      page.on("requestfinished", (request) => {
        if (request.url().includes("/preview-leases")) inFlight -= 1;
      });
      await page.goto(`${fixture.server.baseUrl}/review?type=comments`);
      await expect(page.locator("[data-thumbnail='frame']").first()).toBeVisible();
      expect(peak).toBeLessThanOrEqual(4);
      // The review frame draws the artifact in its own nested, sandboxed frame.
      const frame = page.frameLocator("[data-thumbnail='frame']").first().frameLocator("iframe");
      await expect(frame.getByRole("heading", {name: /Activity thumb/u})).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ACT-005-F: returning to the window re-reads the feed without re-leasing thumbnails or re-fetching replies", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publish(fixture, "Activity focus fixture", "focus");
      const threadId = (await createThreadOverApi(fixture, {anchor: anchorFor("#title"), artifactId: published.artifact.id, body: "Focus pin",
        idempotencyKey: key("focus-thread"), path: "index.html", projectId: "prj_default", versionId: published.version.id})).id;
      await [1, 2, 3, 4].reduce(async (previous, n) => {
        await previous;
        await createReplyOverApi(fixture, {artifactId: published.artifact.id, body: `Focus reply ${n}.`, idempotencyKey: key(`focus-reply-${n}`), projectId: "prj_default", threadId});
      }, Promise.resolve());
      // Count from the sign-in onward, landing straight on Activity: the workspace reads and leases on its own.
      const page = fixture.page;
      let leases = 0;
      let replyReads = 0;
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.endsWith("/preview-leases")) leases += 1;
        if (url.pathname.endsWith(`/comments/${threadId}`) && request.method() === "GET") replyReads += 1;
      });
      await localLogin(fixture, false);
      await expect(page.frameLocator("[data-thumbnail='frame']").first().frameLocator("iframe").getByRole("heading", {name: "Activity focus fixture"})).toBeVisible();
      await expect.poll(() => replyReads).toBe(1);
      const settled = {leases, replyReads};
      expect(settled.leases).toBe(1);
      const feedRead = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/activity");
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await feedRead;
      await page.waitForTimeout(1_000);
      expect({leases, replyReads}).toEqual(settled);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ACT-005-F: an anchor the page does not contain, and a non-HTML entry, show the file tile instead of a misplaced pin", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const html = await publish(fixture, "Activity lost anchor", "lost");
      await createThreadOverApi(fixture, {anchor: anchorFor("#not-on-this-page"), artifactId: html.artifact.id, body: "Where did it go?",
        idempotencyKey: key("lost-thread"), path: "index.html", projectId: "prj_default", versionId: html.version.id});
      const text = (await publishNew(fixture.server, fixture.installation, {accessSetting: "account_required", content: "plain notes",
        idempotencyKey: key("notes"), mediaType: "text/plain; charset=utf-8", name: "Activity notes", path: "notes.txt", projectId: "prj_default"})).body;
      await createThreadOverApi(fixture, {anchor: anchorFor("#title"), artifactId: text.artifact.id, body: "On a text file.",
        idempotencyKey: key("notes-thread"), path: "notes.txt", projectId: "prj_default", versionId: text.version.id});
      await localLogin(fixture);
      const page = fixture.page;
      await page.goto(`${fixture.server.baseUrl}/review?type=comments`);
      const lost = page.locator(`[data-thumbnail-for] >> nth=0`);
      await expect(page.locator("[data-thumbnail='tile'][data-thumbnail-reason='unanchored']")).toHaveCount(1);
      await expect(page.locator("[data-thumbnail='tile'][data-thumbnail-reason='not-html']")).toHaveCount(1);
      await expect(page.locator("[data-thumbnail='frame']")).toHaveCount(0);
      await expect(lost).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
