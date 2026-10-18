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

      const collapseCatalog = page.getByRole("button", {name: "Unpin the artifact catalog"});
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
      await expect(page.getByRole("button", {name: "Show the artifact catalog"})).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("Escape closes it and returns focus to the nav search button, from Activity too", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await localLogin(fixture);
      const page = fixture.page;
      await page.goto(`${fixture.server.baseUrl}/review`);
      await expect(page.getByRole("heading", {exact: true, level: 1, name: "Activity"})).toBeVisible();
      const opener = page.getByRole("button", {name: "Search everything"});
      await opener.click();
      const palette = page.getByRole("dialog", {name: "Search"});
      await expect(palette).toBeVisible();
      await expect(palette.getByText("Type to search artifact names")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(palette).toHaveCount(0);
      await expect(opener).toBeFocused();
      await expect(page.getByRole("heading", {exact: true, level: 1, name: "Activity"})).toBeVisible();
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
    const heldQueries = new Map(["Pal", "Pale", "Palet"].map(query => [query, Promise.withResolvers<void>()]));
    try {
      const owner = new ApiClient(fixture.server, fixture.installation.apiToken);
      const projectIds = await Promise.all(Array.from({length: 12}, async (_, index) =>
        owner.createProject(`Palette load project ${index + 1}`, `palette-load-project-${index + 1}`)));
      await publishPaletteFixture(fixture, "Palette load target", "palette-load-target", projectIds[11]);
      await localLogin(fixture);
      const page = fixture.page;

      let inFlight = 0;
      let peak = 0;
      const startedByQuery = new Map<string, number>();
      page.on("request", (request) => {
        if (!paletteSearchRequest(request)) return;
        const query = new URL(request.url()).searchParams.get("search") ?? "";
        startedByQuery.set(query, (startedByQuery.get(query) ?? 0) + 1);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
      });
      const settle = (request: Request): void => {
        if (paletteSearchRequest(request)) inFlight -= 1;
      };
      page.on("requestfinished", settle);
      page.on("requestfailed", settle);
      // Hold the first batch until the next input supersedes it. This proves
      // queued cancellation without relying on browser scheduling or wall-clock pauses.
      await page.route("**/api/v1/artifacts?**", async (route) => {
        if (paletteSearchRequest(route.request())) {
          const query = new URL(route.request().url()).searchParams.get("search") ?? "";
          await heldQueries.get(query)?.promise;
        }
        await route.continue();
      });

      await page.keyboard.press("ControlOrMeta+k");
      const palette = page.getByRole("dialog", {name: "Search"});
      const field = palette.getByRole("combobox", {name: "Search"});
      await field.fill("Pal");
      await expect.poll(() => startedByQuery.get("Pal")).toBe(4);
      await field.fill("Pale");
      heldQueries.get("Pal")?.resolve();
      await expect.poll(() => startedByQuery.get("Pale")).toBe(4);
      await field.fill("Palet");
      heldQueries.get("Pale")?.resolve();
      await expect.poll(() => startedByQuery.get("Palet")).toBe(4);
      await field.fill("Palette load");
      heldQueries.get("Palet")?.resolve();
      await expect(palette.getByRole("option", {name: /Palette load target/u})).toBeVisible();
      expect(peak).toBeLessThanOrEqual(4);
      for (const query of heldQueries.keys()) expect(startedByQuery.get(query)).toBe(4);
      // The final search covers all created projects and the existing Default project.
      expect(startedByQuery.get("Palette load")).toBe(projectIds.length + 1);
    } finally {
      for (const gate of heldQueries.values()) gate.resolve();
      await stopBrowserFixture(fixture);
    }
  });
});
