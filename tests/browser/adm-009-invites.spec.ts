import {expect, test, type Browser} from "@playwright/test";

import {bootstrapAdministrator, createInvite, signInAs, startInviteServer, type InviteServer} from "../support/invites.js";

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
});
