import {expect, test, type Browser, type Page} from "@playwright/test";
import {Redacted} from "effect";

import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {createOidcIdentityProvider} from "../../src/identity/oidc-identity-provider.js";
import {publishNew, publishVersion} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  reserveLoopbackPort,
  startTestServer,
} from "../support/runtime-harness.js";
import {startStubOidcProvider} from "../support/stub-oidc-provider.js";
import {createThreadOverApi} from "./comment-api.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";
import {
  collectCspViolations,
  openComparison,
  openInspectorTab,
  openReview,
  openSettings,
  previewFrame,
  type SettingsSection,
} from "./review-helpers.js";

/**
 * Success criterion 4: the production build raises no Content Security Policy
 * violation on any screen, in any theme mode. Each redesign task that adds or
 * moves a screen extends this walk.
 */
const themeModes = ["system", "default", "dark", "high-contrast"] as const;

const walkFixtureHtml = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
  + "<title>CSP walk</title></head><body><main><h1>CSP walk fixture</h1></main></body></html>";

async function visitSettings(page: Page, section: SettingsSection, heading: string): Promise<void> {
  await openSettings(page, section);
  // Old screens name their sections with headings; DS screens with labelled regions.
  await expect(page.getByRole("heading", {exact: true, name: heading})
    .or(page.getByRole("region", {exact: true, name: heading})).first()).toBeVisible();
}

test.describe("CSP-clean production build", () => {
  for (const mode of themeModes) {
    test(`review workspace and settings raise no CSP violations in the ${mode} theme mode`, async ({browser}) => {
      const fixture = await startBrowserFixture(browser);
      try {
        const published = await publishNew(fixture.server, fixture.installation, {
          accessSetting: "account_required",
          content: walkFixtureHtml,
          idempotencyKey: `csp-walk-fixture-${mode}`,
          mediaType: "text/html; charset=utf-8",
          name: "CSP walk fixture",
          path: "index.html",
        });
        await fixture.context.addInitScript((themeMode) => {
          localStorage.setItem("arkcase.theme.v1", JSON.stringify(themeMode));
        }, mode);
        const readViolations = collectCspViolations(fixture.page);
        expect(await readViolations()).toEqual([]);

        await localLogin(fixture);
        await openReview(fixture, {artifactId: published.body.artifact.id, versionId: published.body.version.id});
        await expect(previewFrame(fixture.page).getByRole("heading", {name: "CSP walk fixture"})).toBeVisible();
        await expect(fixture.page.locator("html")).toHaveAttribute("data-theme-mode", mode);
        // The DS shell adopts its injected styles as constructable sheets; none reach a <style>.
        expect(await fixture.page.evaluate(() => document.adoptedStyleSheets.length)).toBeGreaterThan(0);
        await expect(fixture.page.locator("style")).toHaveCount(0);

        await visitSettings(fixture.page, "project", "Project identity");
        await visitSettings(fixture.page, "members", "Members");
        await visitSettings(fixture.page, "api-keys", "API keys");
        await visitSettings(fixture.page, "public-links", "Public links");
        await visitSettings(fixture.page, "mcp", "Connect agents with MCP");
        await fixture.page.goto(`${fixture.server.baseUrl}/review/settings/webmcp`);
        await expect(fixture.page.getByRole("heading", {exact: true, name: "WebMCP"}).first()).toBeVisible();

        expect(await readViolations()).toEqual([]);
      } finally {
        await stopBrowserFixture(fixture);
      }
    });
  }

  test("the collector reports a blocked inline style", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const readViolations = collectCspViolations(fixture.page);
      expect(await readViolations()).toEqual([]);
      await localLogin(fixture);
      await fixture.page.evaluate(() => {
        const style = document.createElement("style");
        style.textContent = "body{outline:1px solid red}";
        document.head.append(style);
      });
      await expect.poll(async () => (await readViolations()).join("\n")).toContain("style-src-elem blocked inline");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});

const signInThemeModes = ["system", "default", "dark", "high-contrast"] as const;

async function expectCleanSignInGate(
  browser: Browser,
  baseUrl: string,
  mode: typeof signInThemeModes[number],
): Promise<void> {
  const context = await browser.newContext();
  try {
    await context.addInitScript((stored) => {
      localStorage.setItem("arkcase.theme.v1", stored);
    }, JSON.stringify(mode));
    const page = await context.newPage();
    const violations = collectCspViolations(page);
    await page.goto(`${baseUrl}/review?project=prj_default`);
    await expect(page.getByRole("heading", {name: "Sign in required"})).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme-mode", mode);
    const signIn = page.getByRole("link", {name: "Continue to sign in"});
    await expect(signIn).toHaveCount(1);
    await expect(signIn).toHaveAttribute(
      "href",
      `/auth/login?returnTo=${encodeURIComponent("/review?project=prj_default")}`,
    );
    await expect(page.getByRole("link", {name: "Artifact Server"})).toHaveCount(0);
    expect(await violations()).toEqual([]);
  } finally {
    await context.close();
  }
}

test("AUTH-026-B: the private-team sign-in gate offers one sign-in action and renders without CSP violations in every theme mode", async ({browser}) => {
  const clientSecret = "csp-clean-oidc-client-secret-with-entropy";
  const installation = await createTestInstallation();
  const provider = await startStubOidcProvider({
    clientId: "artifact-server-csp-clean",
    clientSecret,
  });
  const port = await reserveLoopbackPort();
  const applicationOrigin = `http://127.0.0.1:${port}`;
  const server = await startTestServer(installation, {
    applicationOrigin,
    browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
    interactiveIdentityProvider: createOidcIdentityProvider({
      applicationOrigin,
      clientId: provider.clientId,
      clientSecret: Redacted.make(clientSecret, {label: "oidc-client-secret"}),
      issuer: provider.issuer,
      scopes: "openid email profile",
    }),
    port,
  });
  try {
    await Promise.all(signInThemeModes.map((mode) => expectCleanSignInGate(browser, server.baseUrl, mode)));
  } finally {
    await server.stop();
    await provider.stop();
    await removeTestInstallation(installation);
  }
});

test("CSP-clean: the artifact review workspace raises no policy violation in any theme mode", async ({browser}) => {
  const fixture = await startBrowserFixture(browser);
  try {
    const first = await publishNew(fixture.server, fixture.installation, {
      accessSetting: "account_required",
      content: "<!doctype html><html lang=\"en\"><title>CSP workspace</title><main><h1>CSP workspace content</h1></main></html>",
      idempotencyKey: "csp-workspace-v1",
      name: "CSP workspace fixture",
    });
    const second = await publishVersion(fixture.server, fixture.installation, {
      artifactId: first.body.artifact.id,
      content: "<!doctype html><html lang=\"en\"><title>CSP workspace</title><main><h1>CSP workspace content</h1><p>Second</p></main></html>",
      expectedCurrentVersionId: first.body.version.id,
      idempotencyKey: "csp-workspace-v2",
    });
    await createThreadOverApi(fixture, {
      artifactId: first.body.artifact.id,
      body: "CSP workspace thread",
      idempotencyKey: "csp-workspace-thread",
      versionId: second.body.version.id,
    });
    const page = fixture.page;
    const violations = collectCspViolations(page);
    await localLogin(fixture);

    const walkWorkspace = async (
      media: {readonly colorScheme: "dark" | "light"; readonly contrast: "more" | "no-preference"},
    ): Promise<void> => {
      await page.emulateMedia(media);
      await openReview(fixture, {artifactId: first.body.artifact.id});
      await expect(previewFrame(page).getByRole("heading", {name: "CSP workspace content"})).toBeVisible();
      const toolbar = page.getByRole("toolbar", {exact: true, name: "Artifact"});
      await toolbar.getByRole("button", {exact: true, name: "Share"}).click();
      const share = page.getByRole("dialog", {name: "Share artifact"});
      await share.getByRole("button", {name: "Connect MCP"}).click();
      await share.getByRole("button", {name: "Back to Share"}).click();
      await share.getByRole("button", {name: "Manage access"}).click();
      await share.getByRole("button", {name: "Close Share"}).click();
      await openInspectorTab(page, "Comments");
      await openInspectorTab(page, "Details");
      await openInspectorTab(page, "Files");
      await openInspectorTab(page, "Versions");
      await openComparison(page, "Compare");
      await page.getByRole("tabpanel", {name: "Compare"}).getByRole("button", {exact: true, name: "Compare"}).click();
      await expect(page.getByRole("heading", {name: "Changed files"})).toBeVisible();
      await openComparison(page, "Activity");
      await page.getByRole("button", {name: "Back to the preview"}).click();
      await toolbar.getByRole("button", {name: "Full screen"}).click();
      const controls = page.getByRole("toolbar", {name: "Artifact viewer controls"});
      await controls.getByRole("button", {name: /^Comments/u}).click();
      await expect(page.getByRole("complementary", {name: "Comments"})).toBeVisible();
      await controls.getByRole("button", {name: "Hide viewer controls"}).click();
      await page.keyboard.press("Control+Backslash");
      await controls.getByRole("button", {name: "Exit full screen"}).click();
    };
    await walkWorkspace({colorScheme: "light", contrast: "no-preference"});
    await walkWorkspace({colorScheme: "dark", contrast: "no-preference"});
    await walkWorkspace({colorScheme: "light", contrast: "more"});
    expect(await violations()).toEqual([]);
  } finally {
    await stopBrowserFixture(fixture);
  }
});
