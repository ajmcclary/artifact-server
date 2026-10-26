import {randomUUID} from "node:crypto";

import {expect, test, type Browser} from "@playwright/test";
import {z} from "zod";

import {
  type ApplicationCookies,
  bootstrapAdministrator,
  browserMutationHeaders,
  type InviteServer,
  type Person,
  signInAs,
  startInviteServer,
} from "../support/invites.js";
import {publishNew} from "../support/publishing.js";

const sam: Person = {displayName: "Sam Rivera", email: "sam@acme.test", subject: "workos-sam"};

async function freshPage(browser: Browser) {
  const context = await browser.newContext({viewport: {height: 1000, width: 1700}});
  return {context, page: await context.newPage()};
}

test.describe("Access-driven Review controls", () => {
  let server: InviteServer;
  let administrator: ApplicationCookies;

  const call = async (method: string, path: string, body: string | null = null) => {
    const init: RequestInit = {headers: browserMutationHeaders(server.server.baseUrl, administrator), method};
    if (body !== null) init.body = body;
    return fetch(`${server.server.baseUrl}${path}`, init);
  };

  const setup = async () => {
    const created = await call("POST", "/api/v1/projects", JSON.stringify({name: "Design"}));
    const projectId = z.object({project: z.object({id: z.string()})}).parse(await created.json()).project.id;
    const {body: published} = await publishNew(server.server, server.installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Access controls</title><p>Hello</p>",
      idempotencyKey: `access-controls-${randomUUID()}`,
      name: "Access controls",
      projectId,
    });
    const admitted = await call("POST", "/api/v1/members", JSON.stringify({displayName: sam.displayName, email: sam.email}));
    const memberId = z.object({member: z.object({id: z.string()})}).parse(await admitted.json()).member.id;
    return {artifactId: published.artifact.id, memberId, projectId, versionId: published.version.id};
  };

  const grant = async (projectId: string, memberId: string, role: string) => {
    const response = await call("PUT", `/api/v1/projects/${projectId}/grants/${memberId}`, JSON.stringify({
      add: [],
      expectedRevision: null,
      expiresAt: null,
      remove: [],
      role,
    }));
    expect(response.status).toBe(200);
  };

  const signInBrowser = async (browser: Browser, person: Person, returnTo: string) => {
    const opened = await freshPage(browser);
    server.provider.identity = {
      displayName: person.displayName,
      email: person.email,
      emailVerificationAsserted: true,
      emailVerified: true,
      provider: "workos",
      subject: person.subject,
    };
    await opened.page.goto(`${server.server.baseUrl}/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
    return opened;
  };

  test.beforeEach(async () => {
    server = await startInviteServer();
    administrator = await signInAs(server, bootstrapAdministrator);
  });

  test.afterEach(async () => {
    await server.stop();
  });

  test("PRM-010-B: a viewer sees no comment composer and no Share button", async ({browser}) => {
    const fixture = await setup();
    await grant(fixture.projectId, fixture.memberId, "viewer");
    const review = `/review?project=${fixture.projectId}&artifact=${fixture.artifactId}&version=${fixture.versionId}`;

    const viewer = await signInBrowser(browser, sam, review);
    try {
      // At this width the inspector opens docked; choose its Comments tab.
      await viewer.page.getByRole("group", {name: "Inspector"}).getByRole("button", {name: "Comments"}).click();
      await expect(viewer.page.getByLabel("Comment filters").first()).toBeVisible();
      await expect(viewer.page.getByLabel("Add a comment")).toHaveCount(0);
      await expect(viewer.page.getByRole("button", {name: "Share this version"})).toHaveCount(0);
    } finally {
      await viewer.context.close();
    }

    const manager = await signInBrowser(browser, bootstrapAdministrator, review);
    try {
      await expect(manager.page.getByRole("button", {name: "Share this version"}).first()).toBeVisible();
      await manager.page.getByRole("group", {name: "Inspector"}).getByRole("button", {name: "Comments"}).click();
      await expect(manager.page.getByLabel("Comment filters").first()).toBeVisible();
      await expect(manager.page.getByLabel("Add a comment").first()).toBeVisible();
    } finally {
      await manager.context.close();
    }
  });

  test("PRM-010-B: a manager restricts a project from its settings and confirms the count", async ({browser}) => {
    const fixture = await setup();
    const opened = await signInBrowser(browser, bootstrapAdministrator, `/review/projects?project=${fixture.projectId}`);
    try {
      await expect(opened.page.getByLabel("Who can open this project")).toBeVisible();
      await opened.page.getByLabel("Who can open this project").selectOption("restricted");
      await opened.page.getByRole("button", {name: "Save access"}).click();
      await expect(opened.page.getByText("1 member will lose access to this project.")).toBeVisible();
      await opened.page.getByRole("button", {name: "Restrict project"}).click();
      await expect(opened.page.getByText("Restricted", {exact: true}).first()).toBeVisible();
      await expect(opened.page.getByText("Only the people listed with a role, and administrators, can open this project."))
        .toBeVisible();
    } finally {
      await opened.context.close();
    }
  });

  test("PRM-010-F: a member whose project is restricted mid-session sees that access ended", async ({browser}) => {
    const fixture = await setup();
    const review = `/review?project=${fixture.projectId}&artifact=${fixture.artifactId}&version=${fixture.versionId}`;
    const opened = await signInBrowser(browser, sam, review);
    try {
      await expect(opened.page.getByRole("button", {name: "Comments"}).first()).toBeVisible();
      const read = await call("GET", `/api/v1/projects/${fixture.projectId}/access`);
      const {access} = z.object({access: z.object({revision: z.number()})}).parse(await read.json());
      const restricted = await call("PATCH", `/api/v1/projects/${fixture.projectId}/access`, JSON.stringify({
        accessMode: "restricted",
        confirmMembersLosingAccess: 1,
        defaultMemberRole: "editor",
        expectedRevision: access.revision,
      }));
      expect(restricted.status).toBe(200);
      await opened.page.reload();
      await expect(opened.page.getByText("You no longer have access to this project")).toBeVisible();
    } finally {
      await opened.context.close();
    }
  });
});
