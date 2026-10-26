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

const dana: Person = {displayName: "Dana Cole", email: "dana@acme.test", subject: "workos-dana"};
const linksSchema = z.object({links: z.array(z.object({id: z.string(), label: z.string(), url: z.string()}))});

test.describe("Share links from Share and Settings", () => {
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
      content: "<!doctype html><title>Share links</title><p>Hello</p>",
      idempotencyKey: `share-links-${randomUUID()}`,
      name: "Landing page",
      projectId,
    });
    const linksPath = `/api/v1/projects/${projectId}/artifacts/${published.artifact.id}/share-links`;
    return {
      linksPath,
      review: `/review?project=${projectId}&artifact=${published.artifact.id}&version=${published.version.id}`,
    };
  };

  const signInBrowser = async (browser: Browser, person: Person, returnTo: string) => {
    const context = await browser.newContext({viewport: {height: 1000, width: 1700}});
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {origin: server.server.baseUrl});
    const page = await context.newPage();
    server.provider.identity = {
      displayName: person.displayName,
      email: person.email,
      emailVerificationAsserted: true,
      emailVerified: true,
      provider: "workos",
      subject: person.subject,
    };
    await page.goto(`${server.server.baseUrl}/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
    return {context, page};
  };

  test.beforeEach(async () => {
    server = await startInviteServer();
    administrator = await signInAs(server, bootstrapAdministrator);
  });

  test.afterEach(async () => {
    await server.stop();
  });

  test("PRM-006-B: an editor creates a View and comment link from Share, copies it, and sees it listed", async ({browser}) => {
    const fixture = await setup();
    const admitted = await call("POST", "/api/v1/members", JSON.stringify({displayName: dana.displayName, email: dana.email}));
    expect(admitted.status).toBe(201);
    const opened = await signInBrowser(browser, dana, fixture.review);
    try {
      const {page} = opened;
      await page.getByRole("button", {name: "Share this version"}).first().click();
      const share = page.getByRole("dialog", {name: "Share this version"});
      await share.getByRole("button", {exact: true, name: "Manage"}).click();
      await expect(share.getByText("No active share links open this artifact.")).toBeVisible();
      await share.getByRole("button", {name: "New Link"}).click();
      await share.getByLabel("Label").fill("Client review");
      await expect(share.getByRole("radio", {name: /View and comment/u})).toBeChecked();
      await share.getByRole("button", {name: "Create Link"}).click();

      const listed = share.getByRole("list", {name: "Share links"});
      await expect(listed.getByText("Client review")).toBeVisible();
      await expect(listed.getByText(/^View and comment · This version \(v1\) · Never expires · No guests yet$/u)).toBeVisible();
      await listed.getByRole("listitem").filter({hasText: "Client review"}).getByRole("button", {name: "Copy Link"}).click();

      const stored = linksSchema.parse(await (await call("GET", fixture.linksPath)).json()).links;
      expect(stored.map((link) => link.label)).toEqual(["Client review"]);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(stored[0]?.url);
      expect(stored[0]?.url).toMatch(/\/s\/shr_[0-9a-f]{48}$/u);
    } finally {
      await opened.context.close();
    }
  });

  test("PRM-007-B: revoking from the popover removes it from Settings › Share links", async ({browser}) => {
    const fixture = await setup();
    const created = await call("POST", fixture.linksPath, JSON.stringify({
      expiresAt: null,
      label: "Agency preview",
      permissions: ["artifact.view"],
      target: {kind: "latest"},
    }));
    expect(created.status).toBe(201);
    const opened = await signInBrowser(browser, bootstrapAdministrator, "/review/settings/public-links");
    try {
      const {page} = opened;
      const inventory = page.getByRole("table", {name: "Share links inventory"});
      await expect(inventory.getByText("Design · Agency preview", {exact: true})).toBeVisible();
      await expect(inventory.getByText("View only · Latest · Never expires · No guests yet")).toBeVisible();

      await page.goto(`${server.server.baseUrl}${fixture.review}`);
      await page.getByRole("button", {name: "Share this version"}).first().click();
      const share = page.getByRole("dialog", {name: "Share this version"});
      await expect(share.getByText("1 share link")).toBeVisible();
      await share.getByRole("button", {exact: true, name: "Manage"}).click();
      await share.getByRole("button", {name: "Revoke", exact: true}).click();
      await expect(share.getByText("People with this link lose access now. Their comments stay.")).toBeVisible();
      await share.getByRole("button", {name: "Revoke Link"}).click();
      await expect(share.getByText("No active share links open this artifact.")).toBeVisible();

      await page.goto(`${server.server.baseUrl}/review/settings/public-links`);
      await expect(page.getByText("No active share links. Create one from Share on any artifact.")).toBeVisible();
    } finally {
      await opened.context.close();
    }
  });
});
