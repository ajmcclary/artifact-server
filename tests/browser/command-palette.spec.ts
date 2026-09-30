import {expect, test} from "@playwright/test";

import {ApiClient} from "../support/agent-dispatch.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  type BrowserFixture,
} from "./browser-fixture.js";

async function publishPaletteFixture(
  fixture: BrowserFixture,
  name: string,
  idempotencyKey: string,
  projectId = "prj_default",
): Promise<PublishResponse> {
  return (await publishNew(fixture.server, fixture.installation, {
    accessSetting: "account_required",
    content: `<!doctype html><html lang="en"><head><title>${name}</title></head><body><h1>${name}</h1></body></html>`,
    // The API requires idempotency keys of at least 16 characters.
    idempotencyKey: `command-palette-spec-${idempotencyKey}`,
    mediaType: "text/html; charset=utf-8",
    name,
    path: "index.html",
    projectId,
  })).body;
}

test.describe("Command palette", () => {
  test("Mod+K toggles it, / opens it only outside text fields, and workspace shortcuts keep working", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await publishPaletteFixture(fixture, "Palette shortcut fixture", "palette-shortcut");
      await localLogin(fixture);
      const page = fixture.page;
      const palette = page.getByRole("dialog", {name: "Search"});
      const field = palette.getByRole("combobox", {name: "Search"});

      await page.keyboard.press("ControlOrMeta+k");
      await expect(palette).toBeVisible();
      await expect(field).toBeFocused();
      await page.keyboard.press("ControlOrMeta+k");
      await expect(palette).toHaveCount(0);

      const catalogSearch = page.getByRole("searchbox", {name: "Search artifacts"});
      await catalogSearch.click();
      await page.keyboard.type("/");
      await expect(palette).toHaveCount(0);
      await expect(catalogSearch).toHaveValue("/");
      await catalogSearch.fill("");

      const collapseCatalog = page.getByRole("button", {name: "Collapse artifact catalog"});
      await collapseCatalog.focus();
      await page.keyboard.press("/");
      await expect(palette).toBeVisible();
      await page.keyboard.type("[j");
      await expect(field).toHaveValue("[j");
      await expect(collapseCatalog).toBeVisible();

      await page.keyboard.press("Escape");
      await expect(palette).toHaveCount(0);
      await expect(collapseCatalog).toBeFocused();
      await page.keyboard.press("[");
      await expect(page.getByRole("button", {name: "Open artifact catalog"})).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("Escape closes it and returns focus to the nav search button, from the queue too", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await localLogin(fixture);
      const page = fixture.page;
      await page.goto(`${fixture.server.baseUrl}/review`);
      await expect(page.getByRole("heading", {exact: true, name: "Review queue"})).toBeVisible();
      const opener = page.getByRole("button", {name: "Search everything"});
      await opener.click();
      const palette = page.getByRole("dialog", {name: "Search"});
      await expect(palette).toBeVisible();
      await expect(palette.getByText("Type to search artifact names")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(palette).toHaveCount(0);
      await expect(opener).toBeFocused();
      await expect(page.getByRole("heading", {exact: true, name: "Review queue"})).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("results span projects, match exact artifact identifiers, and open the chosen artifact", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const home = await publishPaletteFixture(fixture, "Palette default fixture", "palette-default");
      const owner = new ApiClient(fixture.server, fixture.installation.apiToken);
      const secondProjectId = await owner.createProject("Palette second project", "palette-second-project");
      const away = await publishPaletteFixture(
        fixture,
        "Palette second-project fixture",
        "palette-second-artifact",
        secondProjectId,
      );
      await localLogin(fixture);
      const page = fixture.page;
      const palette = page.getByRole("dialog", {name: "Search"});
      const field = palette.getByRole("combobox", {name: "Search"});
      const results = palette.getByRole("listbox", {name: "Search results"});

      await page.getByRole("button", {name: "Search everything"}).click();
      await field.fill("Palette");
      await expect(results.getByRole("option", {name: /Artifact.*Palette default fixture.*Default/u})).toBeVisible();
      await expect(results.getByRole("option", {name: /Artifact.*Palette second-project fixture.*Palette second project/u})).toBeVisible();
      await expect(results.getByRole("option", {name: /Project.*Palette second project/u})).toBeVisible();
      await expect(palette.getByText(/3 results for "Palette"/u)).toBeVisible();

      await results.getByRole("option", {name: /Artifact.*Palette second-project fixture/u}).click();
      await expect(palette).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`project=${secondProjectId}&artifact=${away.artifact.id}`, "u"));
      await expect(page.getByRole("searchbox", {name: "Search artifacts"})).toBeVisible();

      await page.keyboard.press("ControlOrMeta+k");
      await field.fill(home.artifact.id);
      await expect(results.getByRole("option", {name: new RegExp(home.artifact.id, "u")})).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(palette).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`project=prj_default&artifact=${home.artifact.id}`, "u"));

      await page.keyboard.press("ControlOrMeta+k");
      await field.fill("nothing is called this");
      await expect(palette.getByText("No artifact or project matches")).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
