import {expect, test, type Request} from "@playwright/test";

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

/** A palette catalog search: the workspace's own catalog listing carries no search text. */
function paletteSearchRequest(request: Request): boolean {
  return request.url().includes("/api/v1/artifacts?") && new URL(request.url()).searchParams.has("search");
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

  test("searching many projects keeps at most four catalog requests in flight and drops superseded keystrokes", async ({browser}) => {
    test.setTimeout(120_000);
    const fixture = await startBrowserFixture(browser);
    try {
      const owner = new ApiClient(fixture.server, fixture.installation.apiToken);
      const projectIds = await Promise.all(Array.from({length: 12}, async (_, index) =>
        owner.createProject(`Palette load project ${index + 1}`, `palette-load-project-${index + 1}`)));
      await publishPaletteFixture(fixture, "Palette load target", "palette-load-target", projectIds[11]);
      await localLogin(fixture);
      const page = fixture.page;

      let inFlight = 0;
      let peak = 0;
      let started = 0;
      page.on("request", (request) => {
        if (!paletteSearchRequest(request)) return;
        started += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
      });
      const settle = (request: Request): void => {
        if (paletteSearchRequest(request)) inFlight -= 1;
      };
      page.on("requestfinished", settle);
      page.on("requestfailed", settle);
      // Slow catalogs make consecutive debounced searches overlap, as on a busy server.
      await page.route("**/api/v1/artifacts?**", async (route) => {
        if (paletteSearchRequest(route.request())) await new Promise((resolve) => setTimeout(resolve, 250));
        await route.continue();
      });

      await page.keyboard.press("ControlOrMeta+k");
      const palette = page.getByRole("dialog", {name: "Search"});
      const field = palette.getByRole("combobox", {name: "Search"});
      // Each pause outlasts the debounce, so every keystroke starts a search.
      await field.fill("Pal");
      await page.waitForTimeout(200);
      await field.fill("Pale");
      await page.waitForTimeout(200);
      await field.fill("Palet");
      await page.waitForTimeout(200);
      await field.fill("Palette load");
      await expect(palette.getByRole("option", {name: /Palette load target/u})).toBeVisible();
      expect(peak).toBeLessThanOrEqual(4);
      // Four overlapping unbounded searches would ask every project four times.
      expect(started).toBeLessThan(projectIds.length * 2);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
