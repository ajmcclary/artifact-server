import {expect, test, type Request} from "@playwright/test";
import {z} from "zod";

import {ApiClient, dispatchCreationSchema} from "../support/agent-dispatch.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {apiHeaders} from "../support/runtime-harness.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  type BrowserFixture,
} from "./browser-fixture.js";
import {createThreadOverApi} from "./comment-api.js";

/** The API requires idempotency keys of at least 16 characters. */
function specKey(key: string): string {
  return `review-queue-spec-${key}`;
}

async function publishQueueFixture(
  fixture: BrowserFixture,
  name: string,
  idempotencyKey: string,
  projectId = "prj_default",
): Promise<PublishResponse> {
  const published = await publishNew(fixture.server, fixture.installation, {
    accessSetting: "account_required",
    content: `<!doctype html><html lang="en"><head><title>${name}</title></head><body><h1>${name}</h1></body></html>`,
    idempotencyKey: specKey(idempotencyKey),
    mediaType: "text/html; charset=utf-8",
    name,
    path: "index.html",
    projectId,
  });
  return published.body;
}

async function openThread(
  fixture: BrowserFixture,
  published: PublishResponse,
  body: string,
  idempotencyKey: string,
): Promise<string> {
  const thread = await createThreadOverApi(fixture, {
    artifactId: published.artifact.id,
    body,
    idempotencyKey: specKey(idempotencyKey),
    path: "index.html",
    projectId: published.artifact.projectId,
    versionId: published.version.id,
  });
  return thread.id;
}

async function sendToAgent(
  owner: ApiClient,
  agentId: string,
  threadId: string,
  idempotencyKey: string,
): Promise<string> {
  const response = await owner.sendDispatch({
    agentId,
    idempotencyKey: specKey(idempotencyKey),
    projectId: "prj_default",
    threadIds: [threadId],
  });
  expect(response.status).toBe(201);
  const created = dispatchCreationSchema.parse(await response.json());
  expect(created.dispatch.state).toBe("queued");
  return created.dispatch.id;
}

function catalogRequest(request: Request): boolean {
  return request.url().includes("/api/v1/artifacts?");
}

async function createQueueProject(fixture: BrowserFixture, name: string, index: number): Promise<string> {
  const response = await fetch(`${fixture.server.baseUrl}/api/v1/projects`, {
    body: JSON.stringify({name}),
    headers: apiHeaders(fixture.installation, specKey(`project-${index}`)),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return z.object({project: z.object({id: z.string()})}).parse(await response.json()).project.id;
}

test.describe("Review queue", () => {
  test("groups real sends and conversations across projects, filters, copies ids and opens the workspace", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await fixture.context.grantPermissions(
        ["clipboard-read", "clipboard-write"],
        {origin: fixture.server.baseUrl},
      );
      const owner = new ApiClient(fixture.server, fixture.installation.apiToken);
      const agent = await owner.registerAgent({
        agentSessionId: "session-queue",
        connectionKey: "queue-connection-key",
        displayName: "solo",
        workingDirectory: "/work/solo",
      });

      const withAgent = await publishQueueFixture(fixture, "Queue agent fixture", "queue-agent");
      await sendToAgent(
        owner,
        agent.id,
        await openThread(fixture, withAgent, "Check the totals.", "queue-agent-thread"),
        "queue-agent-send",
      );
      const conversation = await publishQueueFixture(fixture, "Queue conversation fixture", "queue-conversation");
      await openThread(fixture, conversation, "Tighten the headline.", "queue-conversation-thread");
      const canceled = await publishQueueFixture(fixture, "Queue canceled fixture", "queue-canceled");
      const canceledSend = await sendToAgent(
        owner,
        agent.id,
        await openThread(fixture, canceled, "Recheck the source.", "queue-canceled-thread"),
        "queue-canceled-send",
      );
      expect((await owner.cancelDispatch(canceledSend, "prj_default")).status).toBe(200);
      await publishQueueFixture(fixture, "Queue quiet fixture", "queue-quiet");
      const secondProjectId = await owner.createProject("Queue second project", "queue-second-project");
      const foreign = await publishQueueFixture(
        fixture,
        "Queue second-project fixture",
        "queue-second-artifact",
        secondProjectId,
      );
      await openThread(fixture, foreign, "Different project, same queue.", "queue-second-thread");

      await localLogin(fixture);
      const page = fixture.page;
      await page.goto(`${fixture.server.baseUrl}/review`);
      await expect(page.getByRole("heading", {exact: true, name: "Review queue"})).toBeVisible();

      const agentGroup = page.getByRole("region", {name: "With an agent"});
      const conversationGroup = page.getByRole("region", {name: "Has conversations"});
      await expect(agentGroup.getByRole("button", {name: /Queue agent fixture/u})).toBeVisible();
      await expect(agentGroup.getByRole("button", {name: /Queue agent fixture/u})).toContainText("Queued");
      await expect(agentGroup.getByRole("button")).toHaveCount(2); // the row and its copy action
      await expect(conversationGroup.getByRole("button", {name: /Queue conversation fixture/u})).toBeVisible();
      await expect(conversationGroup.getByRole("button", {name: /Queue canceled fixture/u})).toBeVisible();
      await expect(conversationGroup.getByRole("button", {name: /Queue second-project fixture/u})).toBeVisible();
      await expect(conversationGroup.getByRole("button", {name: /Queue second-project fixture/u}))
        .toContainText("Queue second project");
      await expect(conversationGroup.getByRole("button", {name: /Queue agent fixture/u})).toHaveCount(0);
      await expect(page.getByRole("button", {name: /Queue quiet fixture/u})).toHaveCount(0);
      await expect(page.getByText(/unresolved|needs you/iu)).toHaveCount(0);

      await page.getByRole("tab", {name: /With an agent/u}).click();
      await expect(page.getByRole("tab", {name: /With an agent/u})).toHaveAttribute("aria-selected", "true");
      await expect(conversationGroup).toHaveCount(0);
      await expect(agentGroup.getByRole("button", {name: /Queue agent fixture/u})).toBeVisible();
      await page.getByRole("tab", {name: /Has conversations/u}).click();
      await expect(agentGroup).toHaveCount(0);
      await expect(conversationGroup.getByRole("button", {name: /Queue conversation fixture/u})).toBeVisible();
      await page.getByRole("tab", {name: /^All/u}).click();

      const filterBox = page.getByRole("searchbox", {name: "Filter the review queue"});
      await filterBox.fill("second project");
      await expect(page.getByRole("button", {name: /Queue second-project fixture/u})).toBeVisible();
      await expect(page.getByRole("button", {name: /Queue conversation fixture/u})).toHaveCount(0);
      await filterBox.fill("no artifact is called this");
      await expect(page.getByText("No artifacts match these filters")).toBeVisible();
      await page.getByRole("button", {name: "Clear Filters"}).click();
      await expect(filterBox).toHaveValue("");

      await agentGroup.getByRole("button", {name: `Copy identifier ${withAgent.artifact.id}`}).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(withAgent.artifact.id);
      await expect(page).toHaveURL(/\/review$/u);

      await agentGroup.getByRole("button", {name: /Queue agent fixture/u}).click();
      await expect(page).toHaveURL(new RegExp(`/review\\?project=prj_default&artifact=${withAgent.artifact.id}`, "u"));
      await expect(page.getByRole("searchbox", {name: "Search artifacts"})).toBeVisible();

      await page.goBack();
      await expect(page.getByRole("heading", {exact: true, name: "Review queue"})).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("an installation with nothing to review shows the empty state", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await publishQueueFixture(fixture, "Queue untouched fixture", "queue-untouched");
      await localLogin(fixture);
      await fixture.page.goto(`${fixture.server.baseUrl}/review`);
      await expect(fixture.page.getByRole("heading", {exact: true, name: "Review queue"})).toBeVisible();
      await expect(fixture.page.getByText("Nothing to review yet")).toBeVisible();
      await expect(fixture.page.getByRole("region", {name: "With an agent"})).toHaveCount(0);
      await expect(fixture.page.getByRole("region", {name: "Has conversations"})).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("a failed send listing shows the failed state and Retry recovers", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishQueueFixture(fixture, "Queue retry fixture", "queue-retry");
      await openThread(fixture, published, "Still here after the retry.", "queue-retry-thread");
      await localLogin(fixture);
      await fixture.page.route("**/api/v1/agent-dispatches?**", async (route) => {
        await route.fulfill({
          body: JSON.stringify({error: {code: "INTERNAL_ERROR", message: "Dispatch storage is unavailable."}}),
          contentType: "application/json",
          status: 500,
        });
      });
      await fixture.page.goto(`${fixture.server.baseUrl}/review`);
      await expect(fixture.page.getByText("Could not load the review queue")).toBeVisible();

      await fixture.page.unroute("**/api/v1/agent-dispatches?**");
      await fixture.page.getByRole("button", {name: "Retry"}).click();
      await expect(fixture.page.getByRole("button", {name: /Queue retry fixture/u})).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
  test("stays bounded with sixty projects, keeps long titles inside a phone, and lists archived projects", async ({browser}) => {
    test.setTimeout(120_000);
    const fixture = await startBrowserFixture(browser);
    try {
      const projectIds = await Promise.all(Array.from({length: 60}, (_, value) =>
        createQueueProject(fixture, `Queue load project ${value + 1}`, value + 1)));
      const longTitle = "Quarterly claims intake reconciliation review for the northern regional office with duplicate submission handling";
      expect(longTitle.length).toBeGreaterThanOrEqual(100);
      const lastProject = projectIds[59] ?? "";
      const archivedProject = projectIds[58] ?? "";
      const long = await publishQueueFixture(fixture, longTitle, "load-long", lastProject);
      await openThread(fixture, long, "Long title conversation.", "load-long-thread");
      const archived = await publishQueueFixture(fixture, "Archived project artifact", "load-archived", archivedProject);
      await openThread(fixture, archived, "Archived conversation.", "load-archived-thread");
      const archive = await fetch(`${fixture.server.baseUrl}/api/v1/projects/${archivedProject}/archive`, {
        headers: apiHeaders(fixture.installation, specKey("archive-project")),
        method: "POST",
      });
      expect(archive.status).toBe(200);

      await localLogin(fixture);
      const page = fixture.page;
      let inFlight = 0;
      let peak = 0;
      page.on("request", (request) => {
        if (!catalogRequest(request)) return;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
      });
      const settle = (request: Request): void => {
        if (catalogRequest(request)) inFlight -= 1;
      };
      page.on("requestfinished", settle);
      page.on("requestfailed", settle);
      await page.setViewportSize({height: 844, width: 390});
      await page.goto(`${fixture.server.baseUrl}/review`);
      await expect(page.getByRole("heading", {exact: true, name: "Review queue"})).toBeVisible();
      await expect(page.getByRole("button", {name: new RegExp(longTitle.slice(0, 40), "u")})).toBeVisible();
      await expect(page.getByRole("button", {name: /Archived project artifact/u})).toBeVisible();
      expect(peak).toBeLessThanOrEqual(4);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
