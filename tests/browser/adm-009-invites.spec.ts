import {expect, test, type Browser} from "@playwright/test";

import {bootstrapAdministrator, createInvite, signInAs, startInviteServer, type InviteServer} from "../support/invites.js";
import {publishNew} from "../support/publishing.js";

async function freshPage(browser: Browser) {
  const context = await browser.newContext({viewport: {height: 1000, width: 1280}});
  return {context, page: await context.newPage()};
}

test.describe("Invites", () => {
  let server: InviteServer;

  test.beforeEach(async () => {
    server = await startInviteServer();
  });

  test.afterEach(async () => {
    await server.stop();
  });

  test("ADM-009-B: an invitee opens a link, signs in and reaches the welcome screen", async ({browser}) => {
    const administrator = await signInAs(server, bootstrapAdministrator);
    const link = await createInvite(server, administrator, {expiresIn: "7d", kind: "link", maxUses: 3});
    const {context, page} = await freshPage(browser);
    try {
      server.provider.identity = {
        displayName: "Sam Rivera",
        email: "sam@acme.test",
        emailVerificationAsserted: true,
        emailVerified: true,
        provider: "workos",
        subject: "sam",
      };
      await page.goto(link.url);
      await expect(page).toHaveURL(/\/review\/join#as_inv_/u);
      await expect(page.getByRole("heading", {name: "Join this Artifact Server"})).toBeVisible();
      await expect(page.getByText("Jordan Lee invited you")).toBeVisible();
      await expect(page.getByText("3 left")).toBeVisible();
      await page.getByRole("button", {name: "Continue to Sign In"}).click();
      await expect(page.getByRole("heading", {name: "Welcome to Artifact Server"})).toBeVisible();
      await page.getByRole("link", {name: "Continue"}).click();
      await expect(page).toHaveURL(/\/review\/projects/u);
    } finally {
      await context.close();
    }
  });

  test("ADM-009-F: refusal outcomes render join pages rather than JSON", async ({browser}) => {
    const administrator = await signInAs(server, bootstrapAdministrator);
    const person = await createInvite(server, administrator, {email: "dana@acme.test", expiresIn: "7d", kind: "person"});
    const {context, page} = await freshPage(browser);
    try {
      server.provider.identity = {
        displayName: "Sam Rivera",
        email: "sam@acme.test",
        emailVerificationAsserted: true,
        emailVerified: true,
        provider: "workos",
        subject: "sam-wrong",
      };
      await page.goto(person.url);
      await page.getByRole("button", {name: "Continue to Sign In"}).click();
      await expect(page.getByRole("heading", {name: "This invite is for a different account"})).toBeVisible();

      await page.goto(`${server.server.baseUrl}/join#as_inv_broken`);
      await expect(page.getByRole("heading", {name: "This invite link doesn't work"})).toBeVisible();

      await page.goto(`${server.server.baseUrl}/review/join?outcome=expired`);
      await expect(page.getByRole("heading", {name: "This invite link has expired"})).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("ADM-009-B: an administrator creates, copies once and revokes from the Invites area", async ({browser}) => {
    const {context, page} = await freshPage(browser);
    try {
      server.provider.identity = {
        displayName: "Jordan Lee",
        email: "jordan@acme.test",
        emailVerificationAsserted: true,
        emailVerified: true,
        provider: "workos",
        subject: "workos-jordan",
      };
      await page.goto(`${server.server.baseUrl}/auth/login?returnTo=%2Freview%2Fsettings%2Finvites`);
      await expect(page.getByRole("heading", {level: 1, name: "Invites"})).toBeVisible();
      await page.getByRole("button", {name: "Create invite link"}).click();
      const dialog = page.getByRole("dialog", {name: "Create invite link"});
      await dialog.getByLabel("Email").fill("dana@acme.test");
      await dialog.getByRole("button", {name: "Create Invite Link"}).click();
      const link = page.getByRole("textbox", {name: "Invite link"});
      await expect(link).toHaveValue(/\/join#as_inv_/u);
      await page.getByRole("button", {name: "Done"}).click();
      await expect(page.getByRole("textbox", {name: "Invite link"})).toHaveCount(0);
      const grid = page.getByRole("grid", {name: "Invites"});
      await expect(grid.getByText("dana@acme.test")).toBeVisible();
      await grid.getByRole("button", {name: /Actions for/u}).first().click();
      await page.getByRole("menuitem", {name: "Revoke"}).click();
      await page.getByRole("button", {name: "Revoke link"}).click();
      await expect(grid.getByText("Revoked")).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("ADM-009-B: an administrator creates a link invite from Share for the open version", async ({browser}) => {
    const {context, page} = await freshPage(browser);
    try {
      const {body: {version: published}} = await publishNew(server.server, server.installation, {
        accessSetting: "account_required",
        content: "pricing",
        idempotencyKey: "share-invite-destination",
        name: "Q3 Pricing Review",
      });
      server.provider.identity = {
        displayName: "Jordan Lee",
        email: "jordan@acme.test",
        emailVerificationAsserted: true,
        emailVerified: true,
        provider: "workos",
        subject: "workos-jordan",
      };
      await page.goto(`${server.server.baseUrl}/auth/login?returnTo=${encodeURIComponent(`/review?project=${published.projectId}&artifact=${published.artifactId}`)}`);
      await page.getByRole("button", {name: "Share this version"}).click();
      await page.getByRole("button", {name: "Invite"}).click();
      await page.getByRole("radio", {name: /Anyone with the link/u}).click();
      await page.getByLabel("Uses").fill("5");
      await page.getByRole("button", {name: "Create Invite Link"}).click();
      const url = await page.getByRole("textbox", {name: "Invite link"}).inputValue();
      expect(url).toMatch(/\/join#as_inv_/u);

      const invitee = await freshPage(browser);
      try {
        server.provider.identity = {
          displayName: "Sam Rivera",
          email: "sam@acme.test",
          emailVerificationAsserted: true,
          emailVerified: true,
          provider: "workos",
          subject: "sam",
        };
        await invitee.page.goto(url);
        await expect(invitee.page.getByText("Q3 Pricing Review · v1")).toBeVisible();
        await invitee.page.getByRole("button", {name: "Continue to Sign In"}).click();
        await invitee.page.getByRole("link", {name: "Continue"}).click();
        await expect(invitee.page).toHaveURL(new RegExp(`artifact=${published.artifactId}`, "u"));
      } finally {
        await invitee.context.close();
      }
    } finally {
      await context.close();
    }
  });

  test("ADM-009-F: a member sees no invite controls", async ({browser}) => {
    const administrator = await signInAs(server, bootstrapAdministrator);
    const link = await createInvite(server, administrator, {expiresIn: "7d", kind: "link", maxUses: 2});
    const {body: {version: published}} = await publishNew(server.server, server.installation, {
      accessSetting: "account_required",
      content: "member view",
      idempotencyKey: "member-share-destination",
      name: "Member View",
    });
    const {context, page} = await freshPage(browser);
    try {
      server.provider.identity = {
        displayName: "Sam Rivera",
        email: "sam@acme.test",
        emailVerificationAsserted: true,
        emailVerified: true,
        provider: "workos",
        subject: "sam",
      };
      await page.goto(link.url);
      await page.getByRole("button", {name: "Continue to Sign In"}).click();
      await expect(page.getByRole("heading", {name: "Welcome to Artifact Server"})).toBeVisible();
      await page.goto(`${server.server.baseUrl}/review?project=${published.projectId}&artifact=${published.artifactId}`);
      await page.getByRole("button", {name: "Share this version"}).click();
      await expect(page.getByRole("button", {name: "Invite"})).toHaveCount(0);
      await page.goto(`${server.server.baseUrl}/review/settings/invites`);
      await expect(page.getByText("Administrator permission required")).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
