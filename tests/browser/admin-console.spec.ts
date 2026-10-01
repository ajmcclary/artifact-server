import {AxeBuilder} from "@axe-core/playwright";
import {expect, test, type Page} from "@playwright/test";
import {z} from "zod";

import {issueApiKey, signInAdministrator} from "../support/agent-dispatch.js";
import {publishNew} from "../support/publishing.js";
import {localLogin, startBrowserFixture, stopBrowserFixture} from "./browser-fixture.js";
import {waitForSettledPaint} from "./review-helpers.js";

/** The session answer, kept whole so only the membership role is changed. */
const sessionSchema = z.looseObject({principal: z.looseObject({membershipRole: z.string()})});

async function noWcagViolations(page: Page): Promise<void> {
  await waitForSettledPaint(page);
  expect((await new AxeBuilder({page}).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
}

test.describe("Admin console", () => {
  test("ADM-008-B: administrators work members, keys and public links through areas, grids, detail panes and confirmations", async ({browser}) => {
    test.setTimeout(120_000);
    const fixture = await startBrowserFixture(browser);
    try {
      await publishNew(fixture.server, fixture.installation, {
        accessSetting: "public_link",
        content: "console public bytes",
        idempotencyKey: "admin-console-public",
        name: "Console public link",
      });
      await localLogin(fixture);
      const page = fixture.page;

      // The account menu opens the console on Members.
      await page.getByRole("button", {name: /^Account menu/u}).click();
      await page.getByRole("menuitem", {name: "Administration"}).click();
      await expect(page).toHaveURL(/\/review\/settings\/members$/u);
      await expect(page.getByRole("heading", {level: 1, name: "Members"})).toBeVisible();
      await expect(page.getByText("Members can open every project in this installation.")).toBeVisible();
      const areas = page.getByRole("navigation", {name: "Administration areas"});
      await Promise.all(["Members", "API keys", "Public links", "MCP & WebMCP"].map((label) =>
        expect(areas.getByRole("link", {exact: true, name: label})).toBeVisible()));
      await noWcagViolations(page);

      // Admit through the cap's "+", open the detail, and deep-link it.
      await page.getByRole("button", {name: "Admit member"}).click();
      await page.getByLabel("Display name").fill("Console member");
      await page.getByLabel("Email").fill("console-member@example.test");
      await page.getByRole("button", {exact: true, name: "Admit member"}).last().click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const grid = page.getByRole("grid", {name: "Members"});
      await grid.getByRole("button", {exact: true, name: "Console member"}).click();
      await expect(page).toHaveURL(/\/review\/settings\/members\?selected=/u);
      const detail = page.getByRole("complementary").or(page.getByRole("dialog")).filter({hasText: "console-member@example.test"});
      await expect(detail.getByText("Admitted by")).toBeVisible();
      await expect(detail.getByText("Last active")).toBeVisible();
      await expect(detail).toContainText(/\d{2}\/\d{2}\/\d{4}/u);
      await page.reload();
      await expect(page.getByText("console-member@example.test").last()).toBeVisible();
      await expect(page.getByText("Admitted by")).toBeVisible();

      // Destructive verbs live in the row menu and confirm in a danger dialog.
      await grid.getByRole("button", {name: "Actions for Console member"}).click();
      await page.getByRole("menuitem", {name: "Deactivate"}).click();
      await page.getByRole("button", {name: "Deactivate member"}).click();
      await expect(page.getByRole("dialog", {name: "Deactivate member"})).toHaveCount(0);
      await expect(grid.getByRole("row").filter({hasText: "Console member"}).getByText("Inactive")).toBeVisible();

      // API keys: issue, see last use after the key is used, open its capabilities, revoke.
      await areas.getByRole("link", {exact: true, name: "API keys"}).click();
      await expect(page).toHaveURL(/\/review\/settings\/api-keys$/u);
      await page.getByRole("button", {name: "Issue API key"}).click();
      const issue = page.getByRole("dialog", {name: "Issue API key"});
      await issue.getByRole("textbox", {exact: true, name: "Name"}).fill("Console key");
      await issue.getByLabel("Expires at", {exact: true}).fill("2099-01-01T00:00");
      await issue.getByRole("checkbox", {name: /Read artifacts/u}).click();
      await issue.getByRole("button", {exact: true, name: "Issue API key"}).click();
      const secret = (await page.getByRole("region", {name: "API key secret"}).textContent()) ?? "";
      expect(secret).toMatch(/^as_key_/u);
      await page.getByRole("button", {name: "I stored it"}).click();
      expect((await fetch(`${fixture.server.baseUrl}/api/v1/projects`, {
        headers: {Authorization: `Bearer ${secret}`},
      })).status).toBe(200);
      await page.reload();
      const keys = page.getByRole("grid", {name: "API keys"});
      const keyRow = keys.getByRole("row").filter({hasText: "Console key"});
      await expect(keyRow).toContainText(/\d{2}\/\d{2}\/\d{4}/u);
      // The key cell names the key and its prefix.
      await keyRow.getByRole("button", {name: /^Console key/u}).click();
      await expect(page.getByRole("list", {name: "Capabilities"}).getByText("Read artifacts")).toBeVisible();
      await keys.getByRole("button", {name: "Actions for Console key"}).click();
      await page.getByRole("menuitem", {name: "Revoke"}).click();
      await page.getByRole("button", {name: "Revoke API key"}).click();
      await expect(keyRow.getByText("Revoked")).toBeVisible();
      await expect(page.getByText(/Revoked.* by /u)).toBeVisible();
      await noWcagViolations(page);

      // Public links: made-public date, then Make private from the row menu.
      await areas.getByRole("link", {exact: true, name: "Public links"}).click();
      const inventory = page.getByRole("table", {name: "Public links inventory"});
      const linkRow = inventory.getByRole("row").filter({hasText: "Console public link"});
      await expect(linkRow).toContainText(/\d{2}\/\d{2}\/\d{4}/u);
      await linkRow.getByRole("button", {name: "Actions for Console public link"}).click();
      await page.getByRole("menuitem", {name: "Make private"}).click();
      await page.getByRole("button", {exact: true, name: "Make private"}).last().click();
      await expect(linkRow).toHaveCount(0);

      // MCP & WebMCP shows the real browser tool names.
      await areas.getByRole("link", {exact: true, name: "MCP & WebMCP"}).click();
      await expect(page.getByText("artifact_server_get_view", {exact: true})).toBeVisible();

      // The area menu's pin persists across a reload.
      await page.getByRole("button", {name: /Unpin the administration menu/u}).click();
      await page.reload();
      await expect(page.getByRole("button", {name: /Pin the administration menu|Expand menu/u}).first()).toBeVisible();

      // Phones choose the area from a Select in the head.
      await page.setViewportSize({height: 800, width: 390});
      await page.getByLabel("Administration area").selectOption({label: "API keys"});
      await expect(page).toHaveURL(/\/review\/settings\/api-keys$/u);
      await expect.poll(() => page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ADM-008-F: non-administrators get no console entry, the server refuses admin reads, and confirmations cannot be skipped", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await localLogin(fixture);
      const page = fixture.page;

      // An unknown deep-linked record opens no pane and raises no error.
      await page.goto(`${fixture.server.baseUrl}/review/settings/members?selected=mbr_missing`);
      await expect(page.getByRole("heading", {level: 1, name: "Members"})).toBeVisible();
      await expect(page.getByText("Admitted by")).toHaveCount(0);

      // Cancelling a destructive confirmation changes nothing.
      const grid = page.getByRole("grid", {name: "Members"});
      await page.getByRole("button", {name: "Admit member"}).click();
      await page.getByLabel("Display name").fill("Kept member");
      await page.getByLabel("Email").fill("kept-member@example.test");
      await page.getByRole("button", {exact: true, name: "Admit member"}).last().click();
      await grid.getByRole("button", {name: "Actions for Kept member"}).click();
      await page.getByRole("menuitem", {name: "Deactivate"}).click();
      await page.getByRole("dialog", {name: "Deactivate member"}).getByRole("button", {name: "Cancel"}).click();
      await expect(grid.getByRole("row").filter({hasText: "Kept member"}).getByText("Active", {exact: true})).toBeVisible();

      // The server refuses member administration to a non-administrator key.
      const cookies = await signInAdministrator(fixture.server, fixture.installation);
      const reader = await issueApiKey(fixture.server, cookies, ["artifact:read"], "Console reader");
      const refused = await Promise.all(["/api/v1/members", "/api/v1/api-keys", "/api/v1/administration/public-links"].map(async (path) =>
        (await fetch(`${fixture.server.baseUrl}${path}`, {headers: {Authorization: `Bearer ${reader}`}})).status));
      expect(refused).toEqual([403, 403, 403]);

      // A member session sees no administration entry and a forbidden state on direct URLs.
      await page.route("**/api/v1/session", async (route) => {
        const response = await route.fetch();
        const body = sessionSchema.parse(await response.json());
        await route.fulfill({json: {...body, principal: {...body.principal, membershipRole: "member"}}, response});
      });
      await page.goto(`${fixture.server.baseUrl}/review`);
      const memberNav = page.getByRole("navigation", {name: "Review and projects"});
      await expect(memberNav.getByRole("link", {name: "Administration"})).toHaveCount(0);
      // Non-administrators keep their route to MCP setup, in the navigation and the account menu.
      await expect(memberNav.getByRole("link", {name: "MCP & WebMCP"})).toHaveAttribute("href", "/review/settings/mcp");
      await page.getByRole("button", {name: /^Account menu/u}).click();
      await expect(page.getByRole("menuitem", {name: "Administration"})).toHaveCount(0);
      await expect(page.getByRole("menuitem", {name: "MCP & WebMCP"})).toBeVisible();
      await page.keyboard.press("Escape");
      // Visit each direct URL in turn; one page navigates at a time.
      await ["members", "api-keys", "public-links"].reduce(async (previous, path) => {
        await previous;
        await page.goto(`${fixture.server.baseUrl}/review/settings/${path}`);
        await expect(page.getByRole("heading", {name: "Administrator permission required"})).toBeVisible();
      }, Promise.resolve());
      await page.goto(`${fixture.server.baseUrl}/review/settings/mcp`);
      await expect(page.getByRole("heading", {level: 1, name: "MCP & WebMCP"})).toBeVisible();
      await expect(page.getByRole("navigation", {name: "Administration areas"})).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
