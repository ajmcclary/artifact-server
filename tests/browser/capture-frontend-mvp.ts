import {mkdir, rm} from "node:fs/promises";
import path from "node:path";

import {chromium, type Page} from "@playwright/test";

import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
} from "../support/runtime-harness.js";
import {publishNew, publishVersion} from "../support/publishing.js";
import {interactiveFrame} from "./review-helpers.js";

const outputDirectory = path.resolve("project/evidence/frontend-mvp");
const retiredCaptures = [
  "light-projects.png",
  "empty-artifacts.png",
  "populated-artifacts.png",
  "dark-artifact-detail.png",
  "narrow-artifacts.png",
];
const installation = await createTestInstallation();
const server = await startTestServer(installation);
const browser = await chromium.launch({headless: true});
const context = await browser.newContext({
  colorScheme: "light",
  viewport: {height: 900, width: 1440},
});
const page = await context.newPage();

try {
  await mkdir(outputDirectory, {recursive: true});
  await Promise.all(retiredCaptures.map((name) =>
    rm(path.join(outputDirectory, name), {force: true})
  ));
  await page.goto(server.baseUrl);
  await page.getByRole("link", {name: "Artifact Server"}).waitFor();

  await page.goto(`${server.baseUrl}/review?theme=default`);
  await page.getByText("Nothing to review yet").waitFor();
  await capture(page, "queue-empty.png");

  const first = await publishNew(server, installation, {
    accessSetting: "public_link",
    content: "<!doctype html><title>Release dashboard</title><p>Version one</p>",
    idempotencyKey: "frontend-screenshot-first",
    name: "Release dashboard",
    tags: ["approved", "release"],
  });
  const second = await publishVersion(server, installation, {
    artifactId: first.body.artifact.id,
    content: "<!doctype html><title>Release dashboard</title><p>Version two</p>",
    expectedCurrentVersionId: first.body.version.id,
    idempotencyKey: "frontend-screenshot-second",
  });
  const threadResponse = await fetch(
    `${server.baseUrl}/api/v1/artifacts/${first.body.artifact.id}/versions/${second.body.version.id}/comments?projectId=prj_default`,
    {
      body: JSON.stringify({anchor: {kind: "page"}, body: "Name the release owner."}),
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "frontend-screenshot-thread",
      },
      method: "POST",
    },
  );
  if (threadResponse.status !== 201) {
    throw new Error(`Seeding the screenshot thread answered ${threadResponse.status}.`);
  }

  await page.goto(`${server.baseUrl}/review?theme=default`);
  await page.getByRole("button", {name: /Release dashboard/u}).waitFor();
  await capture(page, "queue-populated.png");

  const workspace = `${server.baseUrl}/review?project=prj_default&artifact=${first.body.artifact.id}`;
  await page.goto(`${workspace}&theme=default`);
  await interactiveFrame(page).getByText("Version two").waitFor();
  await capture(page, "workspace-light.png");

  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox", {name: "Search"}).fill("Release");
  await page.getByRole("option", {name: /Release dashboard/u}).waitFor();
  await capture(page, "palette.png");
  await page.keyboard.press("Escape");

  await page.goto(`${workspace}&theme=dark`);
  await interactiveFrame(page).getByText("Version two").waitFor();
  await capture(page, "workspace-dark.png");

  await page.goto(`${workspace}&theme=high-contrast`);
  await interactiveFrame(page).getByText("Version two").waitFor();
  await capture(page, "workspace-high-contrast.png");

  await page.goto(`${server.baseUrl}/review/projects?project=prj_default&theme=default`);
  await page.getByRole("heading", {exact: true, name: "Default"}).waitFor();
  await capture(page, "project-settings.png");

  await page.setViewportSize({height: 844, width: 390});
  await page.goto(`${workspace}&theme=default`);
  await interactiveFrame(page).getByText("Version two").waitFor();
  await capture(page, "narrow-workspace.png");

  await page.setViewportSize({height: 900, width: 1440});
  await page.goto(`${server.baseUrl}/review?project=prj_default&artifact=art_missing&theme=default`);
  await page.getByRole("heading", {name: "Review target unavailable"}).waitFor();
  // frontend-mvp.spec.ts reads this file as fixture image bytes; keep the name.
  await capture(page, "error-not-found.png");
} finally {
  await context.close();
  await browser.close();
  await server.stop();
  await removeTestInstallation(installation);
}

async function capture(targetPage: Page, name: string): Promise<void> {
  await targetPage.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(outputDirectory, name),
  });
}
