import {randomUUID} from "node:crypto";

import {expect, test, type Browser, type Page} from "@playwright/test";
import {z} from "zod";

import {
  type ApplicationCookies,
  bootstrapAdministrator,
  browserMutationHeaders,
  type InviteServer,
  signInAs,
  startInviteServer,
} from "../support/invites.js";
import {publishNew, publishVersion} from "../support/publishing.js";

const linkSchema = z.object({link: z.object({id: z.string(), url: z.string()})});
const threadPageSchema = z.object({
  items: z.array(z.object({author: z.object({displayName: z.string(), principalKind: z.string()}), body: z.string()})),
});

const guestPage = async (browser: Browser, url: string) => {
  const context = await browser.newContext({viewport: {height: 1000, width: 1600}});
  const page = await context.newPage();
  await page.goto(url);
  return {context, page};
};

/** Post a first comment as a guest, naming themselves in the dialog it opens. */
const commentAsNewGuest = async (page: Page, body: string, name: string) => {
  await page.getByLabel("Add a comment").fill(body);
  await page.getByRole("button", {exact: true, name: "Comment"}).click();
  const dialog = page.getByRole("dialog", {name: "Before you comment"});
  await dialog.getByLabel("Your name, shown next to your comments").fill(name);
  await dialog.getByRole("button", {name: "Continue"}).click();
  await expect(page.getByRole("article", {name: `Comment by ${name}`})).toBeVisible();
};

test.describe("Guest review through a share link", () => {
  let server: InviteServer;
  let administrator: ApplicationCookies;

  const call = async (method: string, path: string, body: string | null = null) => {
    const init: RequestInit = {headers: browserMutationHeaders(server.server.baseUrl, administrator), method};
    if (body !== null) init.body = body;
    return fetch(`${server.server.baseUrl}${path}`, init);
  };

  const share = async (permissions: readonly string[]) => {
    const created = await call("POST", "/api/v1/projects", JSON.stringify({name: "Design"}));
    const projectId = z.object({project: z.object({id: z.string()})}).parse(await created.json()).project.id;
    const {body: published} = await publishNew(server.server, server.installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Landing</title><h1>Hello from the page</h1>",
      idempotencyKey: `guest-review-${randomUUID()}`,
      name: "Landing page",
      projectId,
    });
    const response = await call("POST", `/api/v1/projects/${projectId}/artifacts/${published.artifact.id}/share-links`, JSON.stringify({
      expiresAt: null,
      label: "Client review",
      permissions,
      target: {kind: "latest"},
    }));
    expect(response.status).toBe(201);
    const {link} = linkSchema.parse(await response.json());
    return {
      artifactId: published.artifact.id,
      link,
      projectId,
      versionId: published.version.id,
      review: `/review?project=${projectId}&artifact=${published.artifact.id}&version=${published.version.id}`,
    };
  };

  test.beforeEach(async () => {
    server = await startInviteServer();
    administrator = await signInAs(server, bootstrapAdministrator);
  });

  test.afterEach(async () => {
    await server.stop();
  });

  test("PRM-006-B: a guest opens a View and comment link, the address bar no longer contains the token, the page is in Interactive mode, names themselves on first comment, and the member sees the comment with a Guest badge", async ({browser}) => {
    const fixture = await share(["artifact.view", "comment.read", "comment.write"]);
    const token = new URL(fixture.link.url).pathname.split("/").at(-1) ?? "";
    const guest = await guestPage(browser, fixture.link.url);
    try {
      const {page} = guest;
      await expect(page).toHaveURL(new RegExp(`/review/shared/${fixture.link.id}$`, "u"));
      expect(page.url()).not.toContain(token);
      await expect(page.getByText(`Viewing as a guest via a link shared by ${bootstrapAdministrator.displayName}`)).toBeVisible();
      // Interactive: the live page on its content origin, with no annotation surface.
      await expect(page.frameLocator('iframe[title="Landing page"]').getByRole("heading", {name: "Hello from the page"}))
        .toBeVisible();
      await expect(page.getByRole("switch", {name: /annotate/iu})).toHaveCount(0);
      await commentAsNewGuest(page, "The hero image is cropped.", "Pat");
      await expect(page.getByRole("article", {name: "Comment by Pat"}).getByText("Guest", {exact: true})).toBeVisible();
    } finally {
      await guest.context.close();
    }

    const listed = await call("GET", `/api/v1/artifacts/${fixture.artifactId}/comments?projectId=${fixture.projectId}`);
    expect(threadPageSchema.parse(await listed.json()).items).toEqual([
      {author: expect.objectContaining({displayName: "Pat", principalKind: "guest"}), body: "The hero image is cropped."},
    ].map((item) => expect.objectContaining(item)));

    const memberContext = await browser.newContext({viewport: {height: 1000, width: 1700}});
    try {
      const member = await memberContext.newPage();
      server.provider.identity = {
        displayName: bootstrapAdministrator.displayName,
        email: bootstrapAdministrator.email,
        emailVerificationAsserted: true,
        emailVerified: true,
        provider: "workos",
        subject: bootstrapAdministrator.subject,
      };
      await member.goto(`${server.server.baseUrl}/auth/login?returnTo=${encodeURIComponent(fixture.review)}`);
      await member.getByRole("group", {name: "Inspector"}).getByRole("button", {name: "Comments"}).click();
      await expect(member.getByRole("article", {name: "Comment by Pat"}).getByText("Guest", {exact: true})).toBeVisible();
    } finally {
      await memberContext.close();
    }
  });

  test("PRM-006-B: a View only guest sees no Comments tab, Annotate switch, Versions, Files, Details, Share or navigation", async ({browser}) => {
    const fixture = await share(["artifact.view"]);
    const guest = await guestPage(browser, fixture.link.url);
    try {
      const {page} = guest;
      await expect(page.frameLocator('iframe[title="Landing page"]').getByRole("heading", {name: "Hello from the page"}))
        .toBeVisible();
      await expect(page.getByRole("complementary", {name: "Comments"})).toHaveCount(0);
      await expect(page.getByLabel("Add a comment")).toHaveCount(0);
      await expect(page.getByRole("switch", {name: /annotate/iu})).toHaveCount(0);
      await expect(page.getByRole("button", {name: "Share this version"})).toHaveCount(0);
      await expect(page.getByRole("navigation")).toHaveCount(0);
      for (const tab of ["Versions", "Files", "Details"]) {
        // eslint-disable-next-line no-await-in-loop -- each tab is checked in turn
        await expect(page.getByRole("button", {exact: true, name: tab})).toHaveCount(0);
      }
      await expect(page.getByRole("radiogroup", {name: "Platform"})).toBeVisible();
      await expect(page.getByLabel("Appearance")).toBeVisible();
    } finally {
      await guest.context.close();
    }
  });

  test("PRM-007-B: after the member revokes the link, the guest's next action shows the ended page", async ({browser}) => {
    const fixture = await share(["artifact.view", "comment.read", "comment.write"]);
    const guest = await guestPage(browser, fixture.link.url);
    try {
      const {page} = guest;
      await commentAsNewGuest(page, "First pass looks good.", "Pat");
      const revoked = await call("DELETE", `/api/v1/projects/${fixture.projectId}/share-links/${fixture.link.id}`);
      expect(revoked.status).toBe(200);
      // A new comment stays selected, so the next action is a reply to it.
      await page.getByLabel("Reply to Pat").fill("One more thing.");
      await page.getByRole("button", {exact: true, name: "Reply"}).click();
      await expect(page.getByRole("heading", {name: "This link has ended"})).toBeVisible();
      await expect(page.getByText("This link has ended or isn't valid. Ask the person who shared it for a new one."))
        .toBeVisible();
      await page.reload();
      await expect(page.getByRole("heading", {name: "This link has ended"})).toBeVisible();
    } finally {
      await guest.context.close();
    }
  });

  test("the guest frame is sandboxed against navigating the guest's tab", async ({browser}) => {
    const fixture = await share(["artifact.view"]);
    const guest = await guestPage(browser, fixture.link.url);
    try {
      const frame = guest.page.locator('iframe[title="Landing page"]');
      await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
      await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    } finally {
      await guest.context.close();
    }
  });

  test("two share links open in one browser each keep working", async ({browser}) => {
    const fixture = await share(["artifact.view", "comment.read", "comment.write"]);
    const response = await call("POST", `/api/v1/projects/${fixture.projectId}/artifacts/${fixture.artifactId}/share-links`, JSON.stringify({
      expiresAt: null,
      label: "Agency review",
      permissions: ["artifact.view", "comment.read", "comment.write"],
      target: {kind: "latest"},
    }));
    const second = linkSchema.parse(await response.json()).link;
    const guest = await guestPage(browser, fixture.link.url);
    try {
      const other = await guest.context.newPage();
      await other.goto(second.url);
      await expect(other).toHaveURL(new RegExp(`/review/shared/${second.id}$`, "u"));
      await commentAsNewGuest(guest.page, "From the first link.", "Pat");
      await commentAsNewGuest(other, "From the second link.", "Sam");
      await guest.page.reload();
      await expect(guest.page.getByRole("article", {name: "Comment by Pat"})).toBeVisible();
    } finally {
      await guest.context.close();
    }
  });

  test("a guest on a latest link moves to the new version instead of commenting on it unseen", async ({browser}) => {
    const fixture = await share(["artifact.view", "comment.read", "comment.write"]);
    const guest = await guestPage(browser, fixture.link.url);
    try {
      const {page} = guest;
      await commentAsNewGuest(page, "Version one note.", "Pat");
      await publishVersion(server.server, server.installation, {
        artifactId: fixture.artifactId,
        content: "<!doctype html><title>Landing</title><h1>Hello from version two</h1>",
        expectedCurrentVersionId: fixture.versionId,
        idempotencyKey: `guest-v2-${randomUUID()}`,
        projectId: fixture.projectId,
      });
      await page.getByLabel("Reply to Pat").fill("Another note.");
      await page.getByRole("button", {exact: true, name: "Reply"}).click();
      await expect(page.getByText("This link now opens version 2.")).toBeVisible();
      await expect(page.getByText("Version 2", {exact: true})).toBeVisible();
      await expect(page.frameLocator('iframe[title="Landing page"]').getByRole("heading", {name: "Hello from version two"}))
        .toBeVisible();
    } finally {
      await guest.context.close();
    }
  });
});
