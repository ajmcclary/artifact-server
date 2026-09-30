import {AxeBuilder} from "@axe-core/playwright";
import {expect, test, type Page} from "@playwright/test";
import {unzipSync} from "fflate";
import {readFile} from "node:fs/promises";
import {z} from "zod";

import {
  apiHeaders,
  fetchVersion,
} from "../support/runtime-harness.js";
import {
  commitStagedUpload,
  createStagedUpload,
  publishNew,
  publishVersion,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  browserStorage,
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  type BrowserFixture,
} from "./browser-fixture.js";
import {
  artifactFrameSelectors,
  inspectorTabButton,
  isolatedReviewFrame,
  openComparison,
  openInspectorTab,
  openReview,
  openSettings,
} from "./review-helpers.js";
import {listThreadsOverApi} from "./comment-api.js";

const reviewImagePaths = [
  "media/preview.png",
  "media/preview.jpg",
  "media/preview.webp",
  "media/preview.gif",
  "media/preview.svg",
] as const;
const reviewPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7aEAAAAASUVORK5CYII=";
const reviewJpegBase64 = "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABAcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCaAU4d/9k=";
const reviewWebpBase64 = "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==";
const reviewGifBase64 = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const reviewWebmBase64 = "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAK0EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggElTbuMU6uEHFO7a1OsggKe7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAxV0GNTGF2ZjYyLjEyLjEwMUSJiEB5AAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYj918nP8i2d+ZyBACK1nIN1bmSIgQCGhVZfVlA5g4EBI+ODhAJiWgDgkLCBILqBGJqBAlWwhFW5gQESVMNnQIBzc6BjwIBnyJpFo4dFTkNPREVSRIeNTGF2ZjYyLjEyLjEwMXNz2mPAi2PFiP3Xyc/yLZ35Z8ilRaOHRU5DT0RFUkSHmExhdmM2Mi4yOC4xMDEgbGlidnB4LXZwOWfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDAuNDAwMDAwMDAwAB9DtnVA7eeBAKOrgQAAgIJJg0IAAfABdgA4JBwYSgAAMGAAABDf//Xtp/////2Ecf//+rwAAKOTgQAoAIYAQJKcAFAAAAMgAABDQKOTgQBQAIYAQJKcAE7gAAMgAABDQKOTgQB4AIYAQJKcAFAAAAMgAABDQKOTgQCgAIYAQJKcAE1AAAMgAABDQKOTgQDIAIYAQJKcAFAAAAMgAABDQKOTgQDwAIYAQJKcAE7gAAMgAABDQKOTgQEYAIYAQJKcAFAAAAMgAABDQKOTgQFAAIYAQJKcAEogAAMgAABDQKOTgQFoAIYAQJKcAFAAAAMgAABDQBxTu2uRu4+zgQC3iveBAfGCAavwgQM=";

test.describe("Artifact Server frontend MVP", () => {
  test("CMT-015-B CMT-015-F: the Artifact Server review application navigates projects and artifacts", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Review fixture</title><main><h1 id=\"review-target\">Review preview content</h1><p id=\"review-theme-target\">Theme target</p><button id=\"review-native-action\" onclick=\"this.dataset.clicked = 'true'\">Artifact action</button></main></html>",
        idempotencyKey: "frontend-review-fixture",
        name: "Review fixture",
        tags: ["inspection", "prototype"],
      });
      await publishVersion(fixture.server, fixture.installation, {
        artifactId: first.body.artifact.id,
        content: "<!doctype html><html lang=\"en\"><title>Review fixture</title><main><h1 id=\"review-target\">Review preview content</h1><p id=\"review-theme-target\">Theme target</p><button id=\"review-native-action\" onclick=\"this.dataset.clicked = 'true'\">Artifact action</button></main></html>",
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: "frontend-review-fixture-v2",
      });

      const legacyReview = await fixture.page.request.get(
        `${fixture.server.baseUrl}/workbench?project=prj_default`,
        {maxRedirects: 0},
      );
      expect(legacyReview.status()).toBe(308);
      expect(legacyReview.headers()["location"]).toBe("/review?project=prj_default");

      await localLogin(fixture);
      await fixture.page.goto(`${fixture.server.baseUrl}/review`);

      await expect(
        fixture.page.getByRole("heading", {exact: true, name: "Review fixture"}),
      ).toBeVisible();
      await expect(
        fixture.page.getByRole("button", {name: /Review fixture/u}),
      ).toHaveAttribute("aria-current", "true");
      await expect(
        fixture.page.getByRole("button", {name: /Review fixture.*2 versions/u}),
      ).toBeVisible();
      const catalogRefresh = fixture.page.getByRole("button", {
        name: "Refresh artifacts published by agents, the CLI, or other sessions",
      });
      await expect(catalogRefresh).toHaveAttribute(
        "title",
        "Refresh artifacts published by agents, the CLI, or other sessions",
      );
      await catalogRefresh.click();
      await expect(catalogRefresh).toHaveAttribute("data-state", "complete");
      const catalog = fixture.page.getByRole("complementary", {name: "Artifact catalog"});
      const inspector = fixture.page.getByRole("complementary", {name: "Artifact inspector"});
      const catalogPanel = fixture.page.locator('[data-panel="artifact-catalog"]');
      await expect(catalog.getByRole("button", {
        name: "Refresh artifacts published by agents, the CLI, or other sessions",
      })).toBeVisible();
      await expect(catalog.getByRole("button", {name: "Load more"})).toHaveCount(0);
      const shortcutTrigger = catalog.getByRole("button", {name: "Keyboard shortcuts"});
      await expect(shortcutTrigger).toBeVisible();
      await expect(shortcutTrigger).toHaveAttribute("title", "Keyboard shortcuts");
      await shortcutTrigger.click();
      const shortcutMap = fixture.page.getByRole("dialog", {name: "Keyboard shortcuts"});
      await expect(shortcutMap).toBeVisible();
      await expect(shortcutMap).toContainText("Previous artifact");
      await expect(shortcutMap).toContainText("Inspector or comments");
      await expect(shortcutMap.locator("kbd")).toHaveText([
        "K",
        "↑",
        "J",
        "↓",
        "[",
        "]",
        "F",
        "Esc",
        "⌘ / Ctrl",
        "\\",
      ]);
      await fixture.page.keyboard.press("Escape");
      await expect(shortcutMap).toBeHidden();
      await expect(inspector.getByRole("combobox", {name: "Access"})).toHaveValue("account_required");
      await expect(inspector.getByText("Account required", {exact: true})).toHaveCount(0);
      const reviewFrame = isolatedReviewFrame(fixture.page);
      const preview = reviewFrame.frameLocator("iframe");
      await expect(preview.getByRole("heading", {name: "Review preview content"}))
        .toBeVisible();

      const annotateMode = fixture.page.getByRole("button", {
        name: /^Annotate mode:/u,
      });
      await expect(annotateMode).toHaveAttribute("aria-pressed", "true");
      await preview.locator("#review-native-action").focus();
      await fixture.page.keyboard.press("Escape");
      const interactMode = fixture.page.getByRole("button", {
        name: /^Interact mode:/u,
      });
      await expect(interactMode).toHaveAttribute("aria-pressed", "false");
      await preview.locator("#review-native-action").click();
      await expect(preview.locator("#review-native-action"))
        .toHaveAttribute("data-clicked", "true");
      await expect(reviewFrame.getByPlaceholder("Add a comment...")).toHaveCount(0);
      await interactMode.click();
      await expect(annotateMode).toHaveAttribute("aria-pressed", "true");


      await preview.locator("#review-target").hover();
      await expect(preview.locator("[data-plannotator-pinpoint-box]"))
        .toBeVisible();
      await preview.locator("#review-target").click();
      const composer = reviewFrame.getByPlaceholder("Add a comment...");
      await expect(composer).toBeVisible();
      await composer.fill("Make the release status easier to scan.");
      await reviewFrame.getByRole("button", {name: "Save"}).click();

      await expect(inspectorTabButton(fixture.page, "Comments")).toHaveAttribute("aria-pressed", "true");
      await expect(inspectorTabButton(fixture.page, "Comments")).toHaveAccessibleName("Comments — 1");
      const selectedComment = fixture.page.getByRole("article", {name: /^Comment by /u}).filter({
        hasText: "Make the release status easier to scan.",
      });
      await expect(selectedComment).toBeVisible();
      await expect(selectedComment.locator('[aria-current="true"]')).toBeVisible();
      expect(await selectedComment.evaluate((element) => getComputedStyle(element).boxShadow))
        .not.toContain("inset");
      await expect(fixture.page.getByText(
        "Click any element in the HTML preview to place a comment.",
      )).toHaveCount(0);
      await expect(fixture.page.getByRole("toolbar", {name: "Preview controls"}).getByRole("button", {
        name: "Reload",
      })).toBeVisible();
      await expect(fixture.page.getByRole("button", {
        name: /Review fixture.*2 versions.*1 comment/u,
      })).toBeVisible();
      await expect(async () => {
        const stored = await listThreadsOverApi(
          fixture,
          first.body.artifact.id,
        );
        expect(stored).toHaveLength(1);
        expect(stored[0]?.body).toBe("Make the release status easier to scan.");
        expect(stored[0]?.path).toBe("index.html");
      }).toPass();
      const listedArtifacts = z.object({
        artifacts: z.array(z.object({
          artifact: z.object({id: z.string()}),
          commentCount: z.number().int().nonnegative(),
        })),
      }).parse(await (await fixture.page.request.get(
        `${fixture.server.baseUrl}/api/v1/artifacts?projectId=${first.body.artifact.projectId}`,
      )).json());
      expect(listedArtifacts.artifacts.find(({artifact}) => artifact.id === first.body.artifact.id))
        .toMatchObject({commentCount: 1});

      const quietArtifact = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><title>Quiet fixture</title><p>No review notes yet.</p>",
        idempotencyKey: "frontend-review-quiet-fixture",
        name: "Quiet fixture",
        tags: ["quiet"],
      });
      await catalogRefresh.click();
      await expect(catalogRefresh).toHaveAttribute("data-state", "complete");
      const catalogFilters = fixture.page.getByRole("button", {name: /Filter artifacts/u});
      await catalogFilters.click();
      const filterPopover = catalog.getByRole("group", {name: "Filters"});
      const catalogSort = fixture.page.getByRole("combobox", {name: "Sort artifacts"});
      await filterPopover.getByRole("radio", {name: "With comments"}).check();
      await expect(fixture.page.getByRole("button", {name: /Review fixture/u})).toBeVisible();
      await expect(fixture.page.getByRole("button", {name: /Quiet fixture/u})).toHaveCount(0);
      await filterPopover.getByRole("radio", {name: "No comments"}).check();
      await expect(fixture.page.getByRole("button", {name: /Quiet fixture/u})).toBeVisible();
      await expect(fixture.page.getByRole("button", {name: /Review fixture/u})).toHaveCount(0);
      await expect(preview.getByRole("heading", {name: "Review preview content"})).toBeVisible();
      await filterPopover.getByRole("radio", {name: "All artifacts"}).check();
      // The DS check mark sits over the native input, so the reader clicks the label.
      await filterPopover.getByText("quiet", {exact: true}).click();
      await expect(filterPopover.getByRole("checkbox", {name: "quiet"})).toBeChecked();
      await expect(fixture.page.getByRole("button", {name: /Quiet fixture/u})).toBeVisible();
      await expect(fixture.page.getByRole("button", {name: /Review fixture/u})).toHaveCount(0);
      await filterPopover.getByText("inspection", {exact: true}).click();
      await expect(filterPopover.getByRole("checkbox", {name: "inspection"})).toBeChecked();
      await expect(fixture.page.getByRole("button", {name: /Quiet fixture/u})).toBeVisible();
      await expect(fixture.page.getByRole("button", {name: /Review fixture/u})).toBeVisible();
      await filterPopover.getByText("quiet", {exact: true}).click();
      await expect(filterPopover.getByRole("checkbox", {name: "quiet"})).not.toBeChecked();
      await expect(fixture.page.getByRole("button", {name: /Quiet fixture/u})).toHaveCount(0);
      await expect(fixture.page.getByRole("button", {name: /Review fixture/u})).toBeVisible();
      await filterPopover.getByRole("button", {name: "Any tag"}).click();
      await catalogSort.selectOption("comments");
      await expect(catalog.getByRole("list", {name: "Artifacts"}).getByRole("button").first())
        .toContainText("Review fixture");
      await catalogSort.selectOption("newest");
      await expect(catalog.getByRole("list", {name: "Artifacts"}).getByRole("button").first())
        .toContainText("Quiet fixture");
      expect(quietArtifact.body.artifact.id).not.toBe(first.body.artifact.id);
      await fixture.page.keyboard.press("Escape");
      await expect(filterPopover).toBeHidden();

      const searchArtifacts = fixture.page.getByRole("searchbox", {
        name: "Search artifacts",
      });
      await searchArtifacts.focus();
      await fixture.page.keyboard.press("j");
      await expect(searchArtifacts).toHaveValue("j");
      await expect(fixture.page.getByRole("heading", {exact: true, name: "Review fixture"}))
        .toBeVisible();
      await searchArtifacts.fill("");
      await expect(fixture.page.getByRole("button", {name: /Quiet fixture/u})).toBeVisible();

      await fixture.page.getByRole("region", {name: "Artifact preview"}).focus();
      await fixture.page.keyboard.press("k");
      await expect(fixture.page.getByRole("heading", {exact: true, name: "Quiet fixture"}))
        .toBeVisible();
      await fixture.page.keyboard.press("j");
      await expect(fixture.page.getByRole("heading", {exact: true, name: "Review fixture"}))
        .toBeVisible();
      await fixture.page.keyboard.press("ArrowUp");
      await expect(fixture.page.getByRole("heading", {exact: true, name: "Quiet fixture"}))
        .toBeVisible();
      await fixture.page.keyboard.press("ArrowDown");
      await expect(fixture.page.getByRole("heading", {exact: true, name: "Review fixture"}))
        .toBeVisible();

      await catalogFilters.click();
      await expect(filterPopover).toBeVisible();
      await fixture.page.keyboard.press("k");
      await expect(fixture.page.getByRole("heading", {exact: true, name: "Review fixture"}))
        .toBeVisible();
      await fixture.page.keyboard.press("Escape");
      await expect(filterPopover).toBeHidden();

      const collapseCatalog = fixture.page.getByRole("button", {
        name: "Collapse artifact catalog",
      });
      await expect(collapseCatalog).toHaveAttribute("aria-keyshortcuts", "[");
      await fixture.page.getByRole("region", {name: "Artifact preview"}).focus();
      await fixture.page.keyboard.press("[");
      await expect(catalogPanel).toHaveAttribute("data-panel-state", "railed");
      const openCatalog = fixture.page.getByRole("button", {name: "Open artifact catalog"});
      await expect(openCatalog).toBeVisible();
      await expect(openCatalog).toHaveAttribute("aria-keyshortcuts", "[");
      await fixture.page.keyboard.press("[");
      await expect(catalogPanel).toHaveAttribute("data-panel-state", "pinned");

      const closeInspector = fixture.page.getByRole("button", {name: "Close inspector"});
      await expect(closeInspector).toHaveAttribute("aria-keyshortcuts", "]");
      await fixture.page.keyboard.press("]");
      const openInspector = fixture.page.getByRole("button", {name: "Open inspector"});
      await expect(openInspector).toBeVisible();
      await expect(openInspector).toHaveAttribute("aria-keyshortcuts", "]");
      await fixture.page.keyboard.press("]");
      await expect(inspector).toBeVisible();

      await expect(fixture.page.getByRole("button", {name: "Previous artifact"}))
        .toHaveAttribute("aria-keyshortcuts", "K ArrowUp");
      await expect(fixture.page.getByRole("button", {name: "Next artifact"}))
        .toHaveAttribute("aria-keyshortcuts", "J ArrowDown");

      await fixture.page.reload();
      await expect(preview.locator("#review-target")).toBeVisible();
      await expect(preview.locator("button[data-plannotator-marker]"))
        .toHaveCount(1);
      await openInspectorTab(fixture.page, "Details");

      await fixture.page.getByRole("button", {name: "Edit tags"}).click();
      await fixture.page.getByRole("textbox", {name: "Tags"})
        .fill("inspection, polished");
      await fixture.page.getByRole("button", {name: "Save tags"}).click();
      await expect(fixture.page.getByText("polished", {exact: true})).toBeVisible();
      const updatedCatalogCard = fixture.page.getByRole("button", {name: /Review fixture/u});
      await expect(updatedCatalogCard).toBeVisible();
      await expect(updatedCatalogCard).not.toContainText("polished");
      await catalogFilters.click();
      await expect(
        filterPopover
          .getByRole("checkbox", {name: "polished"}),
      ).toBeVisible();
      await fixture.page.keyboard.press("Escape");
      await expect(filterPopover).toBeHidden();


      await openInspectorTab(fixture.page, "Files");
      await expect(inspector.getByRole("region", {name: /^Files in version \d+$/u}).getByRole("button", {name: /^index\.html · /u})).toBeVisible();
      await openInspectorTab(fixture.page, "Versions");
      await expect(inspector.getByRole("list", {name: "Versions"}).getByRole("button", {name: "Version 2"})).toHaveAttribute("aria-current", "true");
      await expect(fixture.page.locator('a[href^="/projects"], a[href^="/workbench"]'))
        .toHaveCount(0);

      await expect(fixture.page.getByRole("complementary", {name: "Review navigation"}))
        .toHaveCount(0);
      const reviewNavigation = fixture.page.getByRole("navigation", {name: "Review and projects"});
      await expect(reviewNavigation.getByRole("link", {exact: true, name: "Review queue"}))
        .toHaveAttribute("href", "/review");
      await expect(reviewNavigation.getByRole("link", {exact: true, name: "Default"}))
        .toHaveAttribute("aria-current", "page");
      await reviewNavigation.getByRole("button", {exact: true, name: "New project"}).click();
      const projectDialog = fixture.page.getByRole("dialog", {name: "New project"});
      const projectNameInput = projectDialog.getByLabel("Project name");
      await expect(projectNameInput).toBeFocused();
      await projectNameInput.fill("Review project");
      await projectDialog.getByRole("button", {name: "Create project"}).click();
      await expect(fixture.page).toHaveURL(/\/review\?project=(?!prj_default)[^&]+/u);
      await expect(reviewNavigation.getByRole("link", {exact: true, name: "Review project"}))
        .toHaveAttribute("aria-current", "page");
      await reviewNavigation.getByRole("link", {exact: true, name: "Default"}).click();
      await expect(fixture.page).toHaveURL(/\/review\?project=prj_default/u);
      await expect(reviewNavigation.getByRole("link", {exact: true, name: "Default"}))
        .toHaveAttribute("aria-current", "page");
      const navigationBox = await fixture.page.locator("[data-ac-left-nav]").boundingBox();
      const catalogBox = await fixture.page.getByRole("complementary", {
        name: "Artifact catalog",
      }).boundingBox();
      // The 52 px rail plus its 1 px seam hairline.
      expect(navigationBox).toMatchObject({width: 53, x: 0});
      expect(catalogBox?.x).toBe(53);
      await catalog.getByRole("button", {name: "Collapse artifact catalog"}).click();
      await expect(catalogPanel).toHaveAttribute("data-panel-state", "railed");
      await fixture.page.getByRole("button", {name: "Open artifact catalog"}).click();
      await expect(catalogPanel).toHaveAttribute("data-panel-state", "pinned");
      await expect(fixture.page).toHaveURL(/\/review\?project=prj_default/u);
      await fixture.page.getByRole("button", {name: /Review fixture/u}).click();
      await expect(
        fixture.page.getByRole("heading", {exact: true, name: "Review fixture"}),
      ).toBeVisible();

      const accessibility = await new AxeBuilder({page: fixture.page})
        .exclude(artifactFrameSelectors[0]).exclude(artifactFrameSelectors[1])
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);

      await expect(fixture.page.getByRole("link", {name: "Artifact Server"}))
        .toHaveAttribute("href", "/review");
      await expect(fixture.page.getByRole("link", {name: "Artifact Server"}))
        .toBeVisible();
      await expect(
        fixture.page.getByRole("heading", {exact: true, name: "Review fixture"}),
      ).toBeVisible();
      await expect(preview.getByRole("heading", {name: "Review preview content"}))
        .toBeVisible();


    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-015-B CMT-015-F: settings returns to the active project and artifact", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const project = await createProject(fixture, "Navigation state project");
      const artifact = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><title>Navigation state</title><h1>Preserved review context</h1>",
        idempotencyKey: "frontend-review-settings-return",
        name: "Navigation state artifact",
        projectId: project.id,
      });
      const reviewUrl = `/review?${new URLSearchParams({
        artifact: artifact.body.artifact.id,
        project: project.id,
        version: artifact.body.version.id,
      })}`;

      await localLogin(fixture);
      await fixture.page.goto(`${fixture.server.baseUrl}${reviewUrl}`);
      const reviewNavigation = fixture.page.getByRole("navigation", {name: "Review and projects"});
      await expect(reviewNavigation.getByRole("link", {
        exact: true,
        name: "Navigation state project",
      })).toHaveAttribute("aria-current", "page");
      await expect(fixture.page.getByRole("heading", {
        exact: true,
        name: "Navigation state artifact",
      })).toBeVisible();
      const canonicalReviewLocation = new URL(fixture.page.url());
      const canonicalReviewUrl = `${canonicalReviewLocation.pathname}${canonicalReviewLocation.search}`;

      await fixture.page.getByRole("link", {name: "Project settings"}).click();
      await expect(fixture.page).toHaveURL(
        new RegExp(`/review/settings/projects/${project.id}$`, "u"),
      );
      const administrationNavigation = fixture.page.getByRole("navigation", {name: "Administration"});
      const backToReview = administrationNavigation.getByRole("link", {name: "Back to review"});
      await expect(backToReview).toHaveAttribute("href", canonicalReviewUrl);
      await expect(fixture.page.getByRole("link", {name: "Artifact Server"}))
        .toHaveAttribute("href", "/review");

      await backToReview.click();
      await expect(fixture.page).toHaveURL(`${fixture.server.baseUrl}${canonicalReviewUrl}`);
      await expect(reviewNavigation.getByRole("link", {
        exact: true,
        name: "Navigation state project",
      })).toHaveAttribute("aria-current", "page");
      await expect(fixture.page.getByRole("heading", {
        exact: true,
        name: "Navigation state artifact",
      })).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-015-F: on a phone the navigation rail becomes the menu drawer and returns focus to its launcher", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await localLogin(fixture);
      await fixture.page.setViewportSize({height: 844, width: 390});
      // Load as a phone does: the inspector starts closed below the docking floor.
      await fixture.page.reload();
      await expect(fixture.page.locator("[data-ac-left-nav]")).toHaveCount(0);
      const launcher = fixture.page.getByRole("button", {name: "Open menu"});
      await launcher.click();
      const drawer = fixture.page.getByRole("dialog", {name: "Review and projects"});
      await expect(drawer.getByRole("link", {name: "Artifact Server"}))
        .toHaveAttribute("href", "/review");
      await expect(drawer.getByRole("link", {exact: true, name: "Default"}))
        .toHaveAttribute("aria-current", "page");
      await fixture.page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
      await expect(launcher).toBeFocused();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("the account menu switches administration, appearance, and density and links the source", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await fixture.context.route("https://github.com/**", (route) => route.fulfill({
        body: "<!doctype html><title>Source</title>",
        contentType: "text/html",
        status: 200,
      }));
      await localLogin(fixture);
      const page = fixture.page;
      const accountButton = page.getByRole("button", {name: /^Account menu: /u});
      const accountMenu = page.getByRole("menu", {name: "Account menu"});
      await accountButton.click();
      await expect(accountMenu.getByRole("menuitem", {name: "Administration"})).toBeVisible();
      await expect(accountMenu.getByRole("menuitem", {name: "Sign out"})).toBeVisible();
      await Promise.all(["System", "Light", "Dark", "High contrast"].map((name) =>
        expect(accountMenu.getByRole("menuitemradio", {exact: true, name})).toBeVisible()));
      await expect(accountMenu.getByRole("menuitemradio", {name: "Comfortable"}))
        .toHaveAttribute("aria-checked", "true");
      await accountMenu.getByRole("menuitemradio", {name: "Compact"}).click();
      await expect(accountMenu.getByRole("menuitemradio", {name: "Compact"}))
        .toHaveAttribute("aria-checked", "true");
      expect(await page.evaluate(() => Object.keys(localStorage)))
        .toContain("artifact-review-density");
      await page.keyboard.press("Escape");
      await expect(accountMenu).toHaveCount(0);
      await expect(accountButton).toBeFocused();

      const sourcePage = fixture.context.waitForEvent("page");
      await accountButton.click();
      await accountMenu.getByRole("menuitem", {name: "Source on GitHub"}).click();
      const opened = await sourcePage;
      await opened.waitForLoadState();
      expect(opened.url()).toBe("https://github.com/ajmcclary/artifact-server");
      await opened.close();

      await accountButton.click();
      await accountMenu.getByRole("menuitem", {name: "Administration"}).click();
      await expect(page).toHaveURL(`${fixture.server.baseUrl}/review/settings/members`);
      await expect(page.getByRole("navigation", {name: "Administration"})).toBeVisible();
      await page.getByRole("button", {name: /^Account menu: /u}).click();
      await accountMenu.getByRole("menuitem", {name: "Back to review"}).click();
      await expect(page).toHaveURL(/\/review\?project=prj_default/u);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-015-F: a long project name stays inside the phone menu without widening the page", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const longName = "Quarterly review of the northern regional claims intake backlog and duplicate submission reconciliation";
      await createProject(fixture, longName);
      await localLogin(fixture);
      await fixture.page.setViewportSize({height: 844, width: 390});
      // Load as a phone does: the inspector starts closed below the docking floor.
      await fixture.page.reload();
      await fixture.page.getByRole("button", {name: "Open menu"}).click();
      const row = fixture.page.getByRole("link", {name: longName});
      await expect(row).toBeVisible();
      expect(await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("PUB-013-B PUB-013-F: publication review links deep-link the exact version into full-screen commenting", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Review link fixture</title><main><h1>Exact review handoff</h1></main></html>",
        idempotencyKey: "frontend-review-link-fixture",
        name: "Review link fixture",
      });
      await localLogin(fixture);
      await fixture.page.goto(published.body.links.review);

      await expect(fixture.page.getByRole("button", {name: "Exit full screen"}))
        .toBeVisible();
      await expect(fixture.page.getByRole("complementary", {name: "Artifact catalog"}))
        .toBeHidden();
      expect(Object.fromEntries(new URL(fixture.page.url()).searchParams)).toEqual({
        artifact: published.body.artifact.id,
        project: published.body.artifact.projectId,
        version: published.body.version.id,
        view: "focus",
      });
      const focusViewerControls = fixture.page.getByRole("toolbar", {
        name: "Artifact viewer controls",
      });
      await focusViewerControls.getByRole("button", {name: "Hide viewer controls"}).click();
      await expect(focusViewerControls).toBeHidden();
      await expect.poll(async () => Math.round(
        (await fixture.page.getByRole("region", {name: "Artifact preview"}).boundingBox())?.x ?? -1,
      )).toBe(0);
      await fixture.page.getByRole("button", {name: "Show viewer controls"}).click();
      await expect(focusViewerControls).toBeVisible();
      await fixture.page.reload();
      await expect(fixture.page.getByRole("button", {name: "Exit full screen"}))
        .toBeVisible();

      await fixture.page.getByRole("button", {name: "Exit full screen"}).click();
      expect(new URL(fixture.page.url()).searchParams.has("view")).toBe(false);
      await fixture.page.goBack();
      await expect(fixture.page.getByRole("button", {name: "Exit full screen"}))
        .toBeVisible();
      expect(new URL(fixture.page.url()).searchParams.get("version"))
        .toBe(published.body.version.id);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-021-B CMT-021-F: Review downloads the selected version in standard and full-screen modes without opening comments", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const downloadFixture = await publishReviewDownloadFixture(fixture);
      await localLogin(fixture);
      await openReview(fixture, {artifactId: downloadFixture.artifactId, projectId: downloadFixture.projectId, versionId: downloadFixture.versionId});

      const standardDownload = fixture.page.getByRole("link", {
        exact: true,
        name: "Download",
      });
      await expect(standardDownload).toBeVisible();
      await expect(standardDownload).toHaveAttribute(
        "title",
        "Download 2 files as a ZIP",
      );
      const [standardArchive] = await Promise.all([
        fixture.page.waitForEvent("download"),
        standardDownload.click(),
      ]);
      expect(standardArchive.suggestedFilename()).toBe(
        "Download fixture - version 1.zip",
      );
      expectDownloadArchive(
        await requiredDownloadBytes(standardArchive.path()),
        downloadFixture.files,
      );

      await fixture.page.getByRole("button", {name: "Full screen"}).click();
      const focusControls = fixture.page.getByRole("toolbar", {
        name: "Artifact viewer controls",
      });
      const focusComments = fixture.page.getByRole("complementary", {
        name: "Comments",
      });
      await expect(focusComments).toBeHidden();
      const focusDownload = focusControls.getByRole("link", {
        exact: true,
        name: "Download",
      });
      await expect(focusDownload).toHaveAttribute(
        "title",
        "Download 2 files as a ZIP",
      );
      const [focusArchive] = await Promise.all([
        fixture.page.waitForEvent("download"),
        focusDownload.click(),
      ]);
      expectDownloadArchive(
        await requiredDownloadBytes(focusArchive.path()),
        downloadFixture.files,
      );
      await expect(focusComments).toBeHidden();
      await expect(
        fixture.page.getByRole("button", {name: "Exit full screen"}),
      ).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-016-B CMT-016-F: an exact Review URL resolves outside the loaded catalog and never substitutes another version", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const target = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Exact target</title><main><h1>Historical exact target</h1></main></html>",
        idempotencyKey: "frontend-exact-target-v1",
        name: "Exact target beyond catalog page",
      });
      await publishVersion(fixture.server, fixture.installation, {
        artifactId: target.body.artifact.id,
        content: "<!doctype html><html lang=\"en\"><title>Exact target latest</title><main><h1>Newer target content</h1></main></html>",
        expectedCurrentVersionId: target.body.version.id,
        idempotencyKey: "frontend-exact-target-v2",
      });
      const decoy = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Catalog decoy</title><main><h1>Catalog decoy content</h1></main></html>",
        idempotencyKey: "frontend-exact-target-decoy",
        name: "Catalog decoy",
      });

      await localLogin(fixture);
      await fixture.page.route(/\/api\/v1\/artifacts\?.*/u, async (route) => {
        const response = await route.fetch();
        const body = z.object({
          artifacts: z.array(z.unknown()),
          nextCursor: z.string().nullable(),
        }).passthrough().parse(await response.json());
        const artifacts = body.artifacts.filter((item) => z.object({
          artifact: z.object({id: z.string()}),
        }).parse(item).artifact.id !== target.body.artifact.id);
        await route.fulfill({
          response,
          body: JSON.stringify({...body, artifacts, nextCursor: "next-catalog-page"}),
          contentType: "application/json",
        });
      });

      await fixture.page.goto(target.body.links.review);
      const reviewFrame = isolatedReviewFrame(fixture.page);
      const preview = reviewFrame.frameLocator("iframe");
      await expect(preview.getByRole("heading", {name: "Historical exact target"}))
        .toBeVisible();
      await expect(preview.getByRole("heading", {name: "Newer target content"}))
        .toHaveCount(0);
      expect(new URL(fixture.page.url()).searchParams.get("version"))
        .toBe(target.body.version.id);
      await fixture.page.goto(decoy.body.links.review);
      await expect(preview.getByRole("heading", {name: "Catalog decoy content"}))
        .toBeVisible();
      await fixture.page.goBack();
      await expect(preview.getByRole("heading", {name: "Historical exact target"}))
        .toBeVisible();
      await fixture.page.reload();
      await expect(preview.getByRole("heading", {name: "Historical exact target"}))
        .toBeVisible();

      await fixture.page.getByRole("button", {name: "Exit full screen"}).click();
      await expect(fixture.page.getByRole("heading", {
        exact: true,
        name: "Exact target beyond catalog page",
      })).toBeVisible();
      await expect(fixture.page.getByRole("button", {
        name: /Exact target beyond catalog page.*2 versions/u,
      })).toHaveAttribute("aria-current", "true");
      await expect(fixture.page.getByRole("button", {name: /Catalog decoy/u})).toBeVisible();

      const unavailable = new URL(target.body.links.review);
      unavailable.searchParams.set("version", "ver_missing-review-version");
      await fixture.page.goto(unavailable.toString());
      await expect(fixture.page.getByRole("heading", {name: "Review target unavailable"}))
        .toBeVisible();
      await expect(fixture.page.getByRole("heading", {name: "Catalog decoy content"}))
        .toHaveCount(0);
      expect(new URL(fixture.page.url()).searchParams.get("version"))
        .toBe("ver_missing-review-version");
      expect(decoy.body.artifact.id).not.toBe(target.body.artifact.id);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-018-B CMT-018-F: private historical HTML loads exact relative CSS, modules, images, fonts, and fetches", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const historical = await publishReviewMultifileFixture(fixture);
      await localLogin(fixture);
      const historicalReview = new URL(historical.body.links.review);
      historicalReview.searchParams.set("path", "site/pages/index.html");
      await fixture.page.goto(historicalReview.toString());

      const reviewFrame = isolatedReviewFrame(fixture.page);
      const preview = reviewFrame.frameLocator("iframe");
      const assertMultifilePreview = async (): Promise<void> => {
        const title = preview.getByRole("heading", {name: "Private historical site"});
        await expect(title).toBeVisible();
        await expect(title).toHaveCSS("color", "rgb(12, 34, 56)");
        await expect(preview.locator("html")).toHaveAttribute(
          "data-module",
          "module-ready",
        );
        await expect(preview.locator("html")).toHaveAttribute("data-font", "loaded");
        await expect(preview.locator("#release-status")).toHaveText("historical-data");
        await expect.poll(
          () => preview.locator("#relative-image").evaluate(
            (image: HTMLImageElement) => image.naturalWidth,
          ),
        ).toBeGreaterThan(0);
      };
      // Qualify the same exact multi-file version first while it is current,
      // then again after the artifact's current pointer has moved away.
      await assertMultifilePreview();
      await publishVersion(fixture.server, fixture.installation, {
        artifactId: historical.body.artifact.id,
        content: "<!doctype html><html lang=\"en\"><title>Current replacement</title><main><h1>Current replacement</h1></main></html>",
        expectedCurrentVersionId: historical.body.version.id,
        idempotencyKey: "frontend-private-multifile-v2",
      });
      await fixture.page.reload();
      await assertMultifilePreview();

      const resourceUrls = await preview.locator("html").evaluate(() =>
        performance.getEntriesByType("resource").map((entry) => entry.name)
      );
      const expectedPaths = [
        "/assets/pixel.png",
        "/data/release.json",
        "/site/scripts/app.js",
        "/site/scripts/status.js",
        "/site/styles/site.css",
      ];
      for (const expectedPath of expectedPaths) {
        const resourceUrl = resourceUrls.find((candidate) =>
          new URL(candidate).pathname === expectedPath
        );
        expect(resourceUrl, `missing ${expectedPath}`).toBeDefined();
        if (resourceUrl === undefined) continue;
        expect(new URL(resourceUrl).hostname).toMatch(/^review-[a-z0-9_-]+\.localhost$/u);
        expect(resourceUrl).not.toContain(historical.body.version.contentToken);
      }
      expect(new URL(fixture.page.url()).searchParams.get("version"))
        .toBe(historical.body.version.id);
      expect(new URL(fixture.page.url()).searchParams.get("path"))
        .toBe("site/pages/index.html");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-017-B CMT-017-F: Review shares the selected exact version and path before moving and raw links", async ({browser, browserName}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Share fixture</title><main><h1>Share fixture</h1></main></html>",
        idempotencyKey: "frontend-review-share-fixture",
        name: "Share fixture",
        tags: ["sharing"],
      });
      const latest = await publishVersion(fixture.server, fixture.installation, {
        artifactId: published.body.artifact.id,
        content: "<!doctype html><html lang=\"en\"><title>Share fixture latest</title><main><h1>Share fixture latest</h1></main></html>",
        expectedCurrentVersionId: published.body.version.id,
        idempotencyKey: "frontend-review-share-fixture-v2",
      });
      const canInspectClipboard = browserName === "chromium";
      if (canInspectClipboard) {
        await fixture.context.grantPermissions(
          ["clipboard-read", "clipboard-write"],
          {origin: fixture.server.baseUrl},
        );
      }
      await localLogin(fixture);
      const exactReviewLink = new URL(published.body.links.review);
      exactReviewLink.searchParams.set("path", "index.html");
      await openReview(fixture, {artifactId: published.body.artifact.id, path: "index.html", projectId: published.body.artifact.projectId, versionId: published.body.version.id});

      const headerActions = fixture.page.getByRole("toolbar", {exact: true, name: "Artifact"});
      const headerShare = headerActions.getByRole("button", {exact: true, name: "Share"});
      const fullScreen = headerActions.getByRole("button", {name: "Full screen"});
      await expect(headerShare).toBeVisible();
      // The header re-renders while the preview settles, so a one-shot pair
      // of boundingBox reads can straddle a detach; poll until both boxes
      // exist in the same frame and Share sits left of Full screen.
      await expect.poll(async () => {
        const [share, full] = await Promise.all([
          headerShare.boundingBox(),
          fullScreen.boundingBox(),
        ]);
        return share !== null && full !== null && share.x < full.x;
      }, {message: "Share is laid out left of Full screen"}).toBe(true);

      await headerShare.click();
      const share = fixture.page.getByRole("dialog", {name: "Share artifact"});
      await expect(share.getByRole("heading", {name: "Share fixture"})).toBeVisible();
      await expect(share.getByText("Exact version · Version 1", {exact: true})).toBeVisible();
      await expect(share.getByText(exactReviewLink.toString(), {exact: true})).toBeVisible();
      await expect(share.getByText(published.body.links.artifact, {exact: true})).toBeVisible();
      await expect(share.getByText(
        "People with access to this Artifact Server can review this exact version.",
        {exact: true},
      )).toBeVisible();
      await expect(share.getByText(published.body.links.version, {exact: true})).toBeVisible();
      await expect(share.getByText("Moves when a new version is published", {exact: true}))
        .toBeVisible();
      await expect.poll(() => fixture.page.evaluate(() => document.getAnimations().length)).toBe(0);
      const shareAccessibility = await new AxeBuilder({page: fixture.page})
        .exclude(artifactFrameSelectors[0]).exclude(artifactFrameSelectors[1])
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(shareAccessibility.violations).toEqual([]);
      if (canInspectClipboard) {
        await share.getByRole("button", {name: "Copy Review link"}).click();
        await expect(share.getByRole("button", {name: "Copied"})).toBeVisible();
        expect(await fixture.page.evaluate(() => navigator.clipboard.readText())).toBe(
          exactReviewLink.toString(),
        );
        await share.getByRole("button", {name: "Copy latest link"}).click();
        expect(await fixture.page.evaluate(() => navigator.clipboard.readText())).toBe(
          published.body.links.artifact,
        );
        await share.getByRole("button", {name: "Copy raw link"}).click();
        expect(await fixture.page.evaluate(() => navigator.clipboard.readText())).toBe(
          published.body.links.version,
        );
      }

      await expect(share.getByRole("img", {
        name: "Claude, Codex, Cursor, GitHub Copilot, Pi, and OpenCode",
      })).toBeVisible();
      if (canInspectClipboard) {
        await share.getByRole("button", {name: "Copy review prompt"}).click();
        await expect(share.getByRole("button", {name: "Prompt copied"})).toBeVisible();
        const agentPrompt = await fixture.page.evaluate(() => navigator.clipboard.readText());
        expect(agentPrompt).toContain("artifact_get");
        expect(agentPrompt).toContain("artifact_version_list");
        expect(agentPrompt).toContain("comment_create");
        expect(agentPrompt).toContain(published.body.artifact.projectId);
        expect(agentPrompt).toContain(published.body.artifact.id);
        expect(agentPrompt).toContain(published.body.version.id);
        expect(agentPrompt).toContain(exactReviewLink.toString());
        expect(agentPrompt).toContain(published.body.links.version);
        expect(agentPrompt).toContain(`${fixture.server.baseUrl}/mcp`);
        expect(agentPrompt).toContain("artifactserver connect");
      }

      await share.getByRole("button", {name: "Connect MCP"}).click();
      await expect(share.getByRole("heading", {name: "Connect MCP"})).toBeVisible();
      await expect(share.getByText("On this computer", {exact: true})).toBeVisible();
      await expect(share.getByText("Team or remote server", {exact: true})).toBeVisible();
      await expect(share.getByText("Without MCP", {exact: true})).toBeVisible();
      if (canInspectClipboard) {
        await share.getByRole("button", {name: "Copy MCP server address"}).click();
        expect(await fixture.page.evaluate(() => navigator.clipboard.readText())).toBe(
          `${fixture.server.baseUrl}/mcp`,
        );
      }
      await share.getByRole("button", {name: "Back to Share"}).click();

      await share.getByRole("button", {name: "Manage access"}).click();
      await expect(share.getByRole("heading", {name: "Artifact access"})).toBeVisible();
      await share.getByRole("radio", {name: /Public link/u}).check();
      await share.getByRole("button", {name: "Save"}).click();
      await expect(share.getByText(
        /The latest raw artifact is public/u,
      )).toBeVisible();
      await expect(fixture.page.getByRole("complementary", {name: "Artifact inspector"}).getByRole("combobox", {name: "Access"})).toHaveValue("public_link");
      await share.getByRole("button", {name: "Close Share"}).click();

      await fixture.page.getByRole("button", {name: "Full screen"}).click();
      const focusControls = fixture.page.getByRole("toolbar", {
        name: "Artifact viewer controls",
      });
      const focusShare = focusControls.getByRole("button", {exact: true, name: "Share"});
      const exitFullScreen = focusControls.getByRole("button", {name: "Exit full screen"});
      expect((await focusShare.boundingBox())?.x).toBeLessThan(
        (await exitFullScreen.boundingBox())?.x ?? 0,
      );
      await focusShare.click();
      await expect(share.getByRole("heading", {name: "Share fixture"})).toBeVisible();
      await expect(share.getByText(exactReviewLink.toString(), {exact: true})).toBeVisible();
      await expect(share.getByText(latest.body.links.version, {exact: true})).toHaveCount(0);
      await share.getByRole("button", {name: "Close Share"}).click();
      await exitFullScreen.click();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("PRV-001-B PRV-001-F PRV-002-B PRV-002-F PRV-004-B PRV-004-F PRV-005-B PRV-005-F: Artifact Server selects and settles exact image and video previews", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const media = await publishReviewMediaFixture(fixture);
      await localLogin(fixture);
      await openReview(fixture, {artifactId: media.artifactId, projectId: media.projectId, versionId: media.versionId});
      await openInspectorTab(fixture.page, "Files");

      const selectImage = async (
        path: (typeof reviewImagePaths)[number],
      ): Promise<void> => {
        await selectManifestFile(fixture.page, path);
        const image = fixture.page.getByRole("img", {
          name: `Review media fixture — ${path}`,
        });
        await expect(image).toBeVisible();
        await expect.poll(() => image.evaluate((node) =>
          node instanceof HTMLImageElement ? node.naturalWidth : 0
        )).toBeGreaterThan(0);
        expect(new URL(fixture.page.url()).searchParams.get("path")).toBe(path);
      };
      await selectImage(reviewImagePaths[0]);
      await selectImage(reviewImagePaths[1]);
      await selectImage(reviewImagePaths[2]);
      await selectImage(reviewImagePaths[3]);
      await selectImage(reviewImagePaths[4]);
      expect(await fixture.page.evaluate(() =>
        "__artifactSvgExecuted" in window
      )).toBe(false);

      await selectManifestFile(fixture.page, "media/preview.png");
      await fixture.page.getByRole("button", {name: "Full screen"}).click();
      await expect(fixture.page.getByRole("img", {
        name: "Review media fixture — media/preview.png",
      })).toBeVisible();
      await expect(fixture.page.getByRole("button", {name: "Exit full screen"})).toBeVisible();
      await fixture.page.getByRole("button", {name: "Exit full screen"}).click();

      await selectManifestFile(fixture.page, "media/clip.webm");
      const video = fixture.page.locator(
        'video[aria-label="Review media fixture — media/clip.webm"]',
      );
      await expect(video).toBeVisible();
      await expect.poll(() => video.evaluate((node) =>
        node instanceof HTMLVideoElement ? node.readyState : 0
      )).toBeGreaterThanOrEqual(1);
      await expect(video).toHaveAttribute("controls", "");
      await expect(video).toHaveAttribute("preload", "metadata");
      expect(await video.evaluate((node) => node instanceof HTMLVideoElement
        ? {autoplay: node.autoplay, paused: node.paused}
        : {autoplay: true, paused: false}
      ))
        .toEqual({autoplay: false, paused: true});

      await fixture.page.goBack();
      await expect(fixture.page).toHaveURL(/path=media%2Fpreview\.png/u);
      await expect(fixture.page.getByRole("img", {
        name: "Review media fixture — media/preview.png",
      })).toBeVisible();
      expect(new URL(fixture.page.url()).searchParams.get("version")).toBe(
        media.versionId,
      );

      await selectManifestFile(fixture.page, "media/broken.png");
      await expect(fixture.page.getByRole("heading", {
        name: "Image preview unavailable",
      })).toBeVisible();
      const brokenFallback = fixture.page.getByRole("region", {name: "Artifact preview"}).getByRole("alert");
      await expect(brokenFallback.getByText("media/broken.png", {exact: true}))
        .toBeVisible();
      await expect(brokenFallback.getByText("image/png", {exact: true})).toBeVisible();
      await expect(fixture.page.getByRole("button", {name: "Retry preview"})).toBeVisible();
      await expect(fixture.page.getByRole("link", {name: "Download file"})).toBeVisible();

      await selectManifestFile(fixture.page, "bundle/archive.zip");
      await expect(fixture.page.getByRole("heading", {
        name: "Preview not supported",
      })).toBeVisible();
      await expect(fixture.page.getByRole("region", {name: "Artifact preview"}).getByRole("alert")
        .getByText("application/zip", {exact: true})).toBeVisible();

      await openReview(fixture, {artifactId: media.artifactId, path: "missing/not-in-manifest.png", projectId: media.projectId, versionId: media.versionId});
      await expect(fixture.page.getByRole("heading", {name: "File not found"}))
        .toBeVisible();
      await expect(fixture.page.getByRole("region", {name: "Artifact preview"}).getByRole("alert").getByText("missing/not-in-manifest.png", {exact: true}))
        .toBeVisible();
      await expect(fixture.page.getByText("Loading preview", {exact: true}))
        .toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("AUTH-023-B AUTH-026-B: local-owner access, projects, artifact opening, session recovery, and deep links work", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const privateArtifact = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><title>Private fixture</title><p>private browser content</p>",
        idempotencyKey: "frontend-browser-private",
        name: "Private fixture",
        tags: ["private"],
      });
      const publicArtifact = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "public_link",
        content: "<!doctype html><title>Public fixture</title><p>public browser content</p>",
        idempotencyKey: "frontend-browser-public",
        name: "Public fixture",
        tags: ["ready"],
      });

      await localLogin(fixture);
      await expect(fixture.page.getByRole("button", {name: /Private fixture/u})).toBeVisible();
      await expect(fixture.page.getByRole("button", {name: /Public fixture/u})).toBeVisible();

      await fixture.page.getByRole("searchbox", {name: "Search artifacts"}).fill("ready");
      await expect(fixture.page.getByRole("button", {name: /Public fixture/u})).toBeVisible();
      await expect(fixture.page.getByRole("button", {name: /Private fixture/u})).toHaveCount(0);
      await fixture.page.getByRole("searchbox", {name: "Search artifacts"}).fill("");

      await fixture.page.getByRole("button", {name: /Public fixture/u}).click();
      const [publicPage] = await Promise.all([
        fixture.context.waitForEvent("page"),
        fixture.page.getByRole("button", {name: "Open raw artifact"}).click(),
      ]);
      await expect(publicPage.locator("body")).toContainText("public browser content");
      await publicPage.close();

      await fixture.page.getByRole("button", {name: /Private fixture/u}).click();
      const [privatePage] = await Promise.all([
        fixture.context.waitForEvent("page"),
        fixture.page.getByRole("button", {name: "Open raw artifact"}).click(),
      ]);
      await expect(privatePage.locator("body")).toContainText("private browser content");
      await privatePage.close();

      await expect(fixture.page).toHaveURL(
        new RegExp(`/review\\?project=prj_default&artifact=${privateArtifact.body.artifact.id}`, "u"),
      );
      await fixture.page.reload();
      await expect(fixture.page.getByRole("heading", {name: "Private fixture"})).toBeVisible();

      const cookies = await fixture.context.cookies();
      expect(cookies.some((cookie) => cookie.name === "artifact_session")).toBe(true);
      expect(await fixture.page.evaluate(() => document.cookie)).not.toContain("artifact_session");
      expect((await browserStorage(fixture.page)).indexedDatabaseNames).toEqual([]);

      await fixture.context.clearCookies();
      await fixture.page.reload();
      await expect(fixture.page.getByRole("heading", {name: "Private fixture"})).toBeVisible();
      await expect(fixture.page.getByRole("button", {name: "Log out"})).toHaveCount(0);

      expect(publicArtifact.body.artifact.projectId).toBe("prj_default");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ADM-003-B ADM-003-F ADM-004-B ADM-004-F ADM-007-B ADM-007-F: Review owns artifact history, mutations, members, and API keys", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: `before\n${"x".repeat(270_000)}`,
        idempotencyKey: "frontend-workflow-first",
        mediaType: "text/plain; charset=utf-8",
        name: "Workflow fixture",
        path: "payload.txt",
        tags: ["draft"],
      });
      const second = await publishVersion(fixture.server, fixture.installation, {
        artifactId: first.body.artifact.id,
        content: `after\n${"y".repeat(270_000)}`,
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: "frontend-workflow-second",
        mediaType: "text/plain; charset=utf-8",
        path: "payload.txt",
      });
      await createActionHistory(fixture, first.body.artifact.id, second.body.version.id);

      await localLogin(fixture);
      await expect(fixture.page.getByRole("heading", {name: "Workflow fixture"})).toBeVisible();

      await fixture.page.getByRole("button", {name: "Edit tags"}).click();
      await fixture.page
        .getByRole("textbox", {name: "Tags"})
        .fill("approved, release");
      await fixture.page.getByRole("button", {name: "Save tags"}).click();
      await expect(fixture.page.getByText("approved", {exact: true})).toBeVisible();

      await openComparison(fixture.page, "Compare");
      const comparePanel = fixture.page.getByRole("tabpanel", {name: "Compare"});
      await comparePanel.getByRole("button", {exact: true, name: "Compare"}).click();
      await expect(comparePanel.getByRole("heading", {name: "Changed files"})).toBeVisible();
      await expect(comparePanel.getByText("payload.txt", {exact: true})).toBeVisible();
      await fixture.page.getByRole("button", {name: "Back to the preview"}).click();
      await expect(fixture.page.getByRole("region", {name: "Comparison and history"})).toHaveCount(0);

      await openInspectorTab(fixture.page, "Versions");
      await fixture.page.getByRole("button", {name: "Make current"}).click();
      await fixture.page.getByRole("button", {name: "Make current", exact: true}).last().click();
      await expect(fixture.page.getByRole("list", {name: "Versions"}).getByRole("listitem").filter({hasText: "Version 1"}).getByText(/^Current/u)).toBeVisible();

      await openComparison(fixture.page, "Activity");
      const activityPanel = fixture.page.getByRole("tabpanel", {name: "Activity"});
      await expect(activityPanel.getByText("Restored version")).toBeVisible();
      await expect(activityPanel.getByText("Replaced tags").first()).toBeVisible();
      const activityRows = activityPanel.getByRole("table", {name: "Artifact activity"})
        .getByRole("row").filter({has: fixture.page.getByRole("cell")});
      await expect(activityPanel.getByRole("button", {name: "Load more"})).toBeVisible();
      await expect(activityRows).toHaveCount(50);
      await activityPanel.getByRole("button", {name: "Load more"}).click();
      await expect(activityRows).toHaveCount(56);

      await openSettings(fixture.page, "members");
      await fixture.page.getByRole("button", {name: "Admit member"}).click();
      await fixture.page.getByLabel("Display name").fill("Frontend member");
      await fixture.page.getByLabel("Email").fill("frontend-member@example.test");
      await fixture.page.getByRole("button", {name: "Admit member", exact: true}).last().click();
      await expect(fixture.page.getByRole("dialog")).toHaveCount(0);
      const memberRow = fixture.page.getByRole("row").filter({hasText: "Frontend member"});
      await expect(memberRow).toBeVisible();
      await memberRow.getByRole("button", {name: "Deactivate"}).click();
      await fixture.page.getByRole("button", {name: "Deactivate member"}).click();
      await expect(fixture.page.getByRole("dialog")).toHaveCount(0);
      await expect(memberRow.getByText("inactive", {exact: true})).toBeVisible();

      await fixture.page.getByRole("link", {name: "API keys"}).click();
      await fixture.page.getByRole("button", {name: "Issue API key"}).click();
      await fixture.page
        .getByRole("textbox", {name: "Name", exact: true})
        .fill("Browser workflow key");
      await fixture.page
        .getByLabel("Expires at", {exact: true})
        .fill("2099-01-01T00:00");
      await fixture.page
        .getByRole("checkbox", {name: /Read artifacts/u})
        .click();
      await fixture.page
        .getByRole("checkbox", {name: /Manage comments/u})
        .click();
      await fixture.page.getByRole("button", {name: "Issue API key", exact: true}).last().click();
      const secret = fixture.page.getByRole("region", {name: "API key secret"});
      await expect(secret).toHaveText(/^as_key_/u);
      const secretValue = await secret.textContent();
      expect(secretValue).toMatch(/^as_key_/u);
      await fixture.page.getByRole("button", {name: "I stored it"}).click();
      await expect(fixture.page.getByText(secretValue ?? "missing-secret")).toHaveCount(0);
      expect(await browserStorage(fixture.page)).toEqual({
        indexedDatabaseNames: [],
        localStorageKeys: [],
        sessionStorageKeys: ["artifact-review-return-url"],
      });

      const keyRow = fixture.page.getByRole("row").filter({hasText: "Browser workflow key"});
      await expect(keyRow.getByText("comment:write", {exact: true})).toBeVisible();
      await keyRow.getByRole("button", {name: "Rotate"}).click();
      await expect(fixture.page.getByRole("region", {name: "API key secret"})).toHaveText(/^as_key_/u);
      await fixture.page.getByRole("button", {name: "I stored it"}).click();
      await expect(keyRow.getByText("Revoked", {exact: true})).toBeVisible();

      await openReview(fixture, {artifactId: first.body.artifact.id});
      await fixture.page.getByRole("button", {name: "More artifact actions"}).click();
      await fixture.page.getByRole("menuitem", {name: "Delete artifact"}).click();
      await fixture.page.getByRole("textbox", {name: "Artifact name"}).fill("Workflow fixture");
      await fixture.page.getByRole("button", {name: "Delete artifact", exact: true}).last().click();
      await expect(fixture.page.getByRole("button", {name: /Workflow fixture/u})).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ADM-005-B ADM-005-F: administrators inventory public links across projects and retry stale bulk changes accessibly", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "public_link",
        content: "first public-link administration bytes",
        idempotencyKey: "frontend-public-links-first",
        name: "First public link",
      });
      const stale = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "public_link",
        content: "stale public-link administration bytes",
        idempotencyKey: "frontend-public-links-stale",
        name: "Stale public link",
      });
      const otherProject = await createProject(fixture, "Public links project");
      const other = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "public_link",
        content: "cross-project public-link administration bytes",
        idempotencyKey: "frontend-public-links-cross-project",
        name: "Cross-project public link",
        projectId: otherProject.id,
      });

      await localLogin(fixture);
      await openSettings(fixture.page, "public-links");
      await expect(fixture.page.getByRole("heading", {name: "Public links"})).toBeVisible();
      const firstRow = fixture.page.getByRole("row").filter({hasText: "First public link"});
      await expect(firstRow.getByText("Default", {exact: true})).toBeVisible();
      const crossProjectRow = fixture.page.getByRole("row").filter({
        hasText: "Cross-project public link",
      });
      await expect(
        crossProjectRow.getByText("Public links project", {exact: true}),
      ).toBeVisible();
      await expect(fixture.page.getByRole("button", {name: "Select all (3)"})).toBeVisible();
      await expect(fixture.page.getByText("Version 1", {exact: true})).toHaveCount(3);
      const accessibility = await new AxeBuilder({page: fixture.page})
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);

      await fixture.page.setViewportSize({height: 600, width: 1024});
      // The settings page scrolls inside the shell (its own scroll box), never the document.
      const scrollRange = await fixture.page.getByRole("table", {name: "Public links inventory"}).evaluate((table) => {
        let node = table.parentElement;
        while (node !== null && !["auto", "scroll"].includes(getComputedStyle(node).overflowY)) node = node.parentElement;
        if (node === null) return null;
        const before = {clientHeight: node.clientHeight, scrollHeight: node.scrollHeight};
        node.scrollTo(0, node.scrollHeight);
        const scrolled = node.scrollTop;
        node.scrollTo(0, 0);
        return {...before, scrolled};
      });
      expect(scrollRange).not.toBeNull();
      expect(scrollRange?.scrollHeight ?? 0).toBeGreaterThan(scrollRange?.clientHeight ?? 0);
      expect(scrollRange?.scrolled ?? 0).toBeGreaterThan(0);
      expect(await fixture.page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight))
        .toBe(0);

      const inventory = fixture.page.getByRole("table", {name: "Public links inventory"});
      expect(await inventory.evaluate((element) => element.scrollWidth - element.clientWidth))
        .toBe(0);
      const compactRowBox = await firstRow.boundingBox();
      expect(compactRowBox?.height).toBeLessThan(96);

      await fixture.page.setViewportSize({height: 720, width: 390});
      expect(await fixture.page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth
      )).toBe(0);
      expect(await inventory.evaluate((element) => element.scrollWidth - element.clientWidth))
        .toBe(0);
      await expect(firstRow.getByRole("link", {name: "Open"})).toBeVisible();
      await expect(firstRow.getByRole("button", {name: "Make private"})).toBeVisible();

      const otherRow = fixture.page.getByRole("row").filter({
        hasText: "Cross-project public link",
      });
      await otherRow.getByRole("button", {name: "Make private"}).click();
      await fixture.page.getByRole("button", {name: "Make private", exact: true}).last().click();
      await expect(otherRow).toHaveCount(0);

      await fixture.page.getByRole("checkbox", {name: "Select First public link"}).click();
      await fixture.page.getByRole("checkbox", {name: "Select Stale public link"}).click();
      await fixture.page.getByRole("button", {name: "Make 2 private"}).click();
      const staleUpdate = await publishVersion(fixture.server, fixture.installation, {
        artifactId: stale.body.artifact.id,
        content: "updated after the administrator selected the row",
        expectedCurrentVersionId: stale.body.version.id,
        idempotencyKey: "frontend-public-links-stale-update",
        projectId: "prj_default",
      });
      await fixture.page.getByRole("button", {name: "Make private", exact: true}).last().click();

      await expect(fixture.page.getByText("1 link was not changed")).toBeVisible();
      await expect(fixture.page.getByText(/1 public link is now private/u)).toBeVisible();
      await expect(fixture.page.getByText("First public link")).toHaveCount(0);
      await expect(fixture.page.getByRole("link", {name: "Stale public link"})).toBeVisible();
      await fixture.page.getByRole("button", {name: "Retry failed"}).click();
      await expect(fixture.page.getByRole("heading", {name: "No public links"})).toBeVisible();

      expect((await fetch(first.body.links.artifact, {redirect: "manual"})).status).toBe(401);
      expect((await fetch(other.body.links.artifact, {redirect: "manual"})).status).toBe(401);
      expect((await fetchVersion(fixture.server, staleUpdate.body.links.version)).status).toBe(401);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ADM-002-B ADM-002-F ADM-006-B ADM-006-F: canonical routing, project settings, and hostile boundaries fail closed", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "public_link",
        content: "<!doctype html><title>Isolation fixture</title><p>content only</p>",
        idempotencyKey: "frontend-hostile-first",
        name: "Isolation fixture",
      });
      const otherProject = await createProject(fixture, "Other project");

      await localLogin(fixture);
      const shell = await fixture.page.request.get(`${fixture.server.baseUrl}/review`);
      expect(shell.status()).toBe(200);
      expect(shell.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(shell.headers()["referrer-policy"]).toBe("no-referrer");
      expect(shell.headers()["x-content-type-options"]).toBe("nosniff");
      expect(shell.headers()["cache-control"]).toBe("no-cache, must-revalidate");

      const apiFallback = await fixture.page.request.get(
        `${fixture.server.baseUrl}/api/v1/route-that-does-not-exist`,
      );
      expect(apiFallback.status()).toBe(404);
      expect(apiFallback.headers()["content-type"]).toContain("application/json");

      const noCsrf = await fixture.page.request.post(
        `${fixture.server.baseUrl}/api/v1/projects`,
        {data: {name: "Must not exist"}},
      );
      expect(noCsrf.status()).toBe(403);

      const crossedProject = await fixture.page.request.get(
        `${fixture.server.baseUrl}/api/v1/artifacts/${first.body.artifact.id}?projectId=${otherProject.id}`,
      );
      expect(crossedProject.status()).toBe(404);

      const contentUi = new URL("/projects", first.body.links.version);
      const isolated = await fixture.page.request.get(contentUi.toString());
      expect(isolated.status()).toBe(404);
      expect(isolated.headers()["content-type"]).toContain("application/json");

      // The projects list is gone: its routes replace themselves with the review queue (which,
      // until the queue screen lands, still opens the Default project's first artifact).
      const historyLength = await fixture.page.evaluate(() => window.history.length);
      await fixture.page.goto(`${fixture.server.baseUrl}/projects`);
      await expect(fixture.page).toHaveURL(/\/review(?:\?project=prj_default(?:&[^#]*)?)?$/u);
      expect(await fixture.page.evaluate(() => window.history.length)).toBe(historyLength + 1);
      await fixture.page.goto(`${fixture.server.baseUrl}/review/settings`);
      await expect(fixture.page).toHaveURL(/\/review(?:\?project=prj_default(?:&[^#]*)?)?$/u);

      await fixture.page.goto(`${fixture.server.baseUrl}/review/settings/projects/prj_default`);
      await expect(fixture.page.getByRole("region", {name: "Project identity"})).toBeVisible();
      await expect(fixture.page.getByRole("region", {name: "Git history"})).toHaveCount(0);
      // Geometry at the DS display ladder: the 1680 px spec viewport is the desktop profile.
      await expect(fixture.page.locator("[data-ac-profile]").first())
        .toHaveAttribute("data-ac-profile", "desktop");
      await expect(fixture.page.getByRole("link", {name: "Artifact Server"}))
        .toHaveAttribute("href", "/review");
      const administrationNavigation = fixture.page.getByRole("navigation", {name: "Administration"});
      await expect(administrationNavigation.getByRole("link", {exact: true, name: "Back to review"}))
        .toBeVisible();
      const compactSettingsActions = [
        fixture.page.getByRole("link", {name: "Open artifacts"}),
        fixture.page.getByRole("button", {name: "Save name"}),
        fixture.page.getByRole("button", {name: "Archive project"}),
      ];
      const compactSettingsActionMetrics = await Promise.all(compactSettingsActions.map(async (action) => ({
        box: await action.boundingBox(),
        textTransform: await action.evaluate((element) => getComputedStyle(element).textTransform),
      })));
      for (const {box, textTransform} of compactSettingsActionMetrics) {
        expect(box?.height).toBeLessThanOrEqual(32);
        expect(textTransform).toBe("none");
      }
      const lifecycleBox = await fixture.page.getByLabel("Project lifecycle").boundingBox();
      const archiveBox = await fixture.page.getByRole("button", {name: "Archive project"}).boundingBox();
      expect(archiveBox?.width).toBeLessThan((lifecycleBox?.width ?? 0) / 2);
      await fixture.page.getByLabel("Project name").fill("Default renamed");
      await fixture.page.getByRole("button", {name: "Save name"}).click();
      await expect(fixture.page.getByRole("heading", {name: "Default renamed"})).toBeVisible();
      await fixture.page.getByRole("button", {name: "Archive project"}).click();
      await fixture.page.getByRole("button", {name: "Archive project", exact: true}).last().click();
      await expect(
        fixture.page.getByLabel("Project lifecycle").getByRole("button", {name: "Unarchive project"}),
      ).toBeVisible();
      await expect(fixture.page.getByRole("dialog")).toHaveCount(0);
      await fixture.page.getByLabel("Project lifecycle").getByRole("button", {name: "Unarchive project"}).click();
      await fixture.page.getByRole("button", {name: "Unarchive project", exact: true}).last().click();
      await expect(
        fixture.page.getByLabel("Project lifecycle").getByRole("button", {name: "Archive project"}),
      ).toBeVisible();
      await expect(fixture.page.getByRole("dialog")).toHaveCount(0);
      const accessibility = await new AxeBuilder({page: fixture.page})
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ADM-002-B ADM-006-B: an empty project shows its publish guidance and project settings list its artifacts", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const project = await createProject(fixture, "Empty guidance project");
      await localLogin(fixture);

      await fixture.page.goto(`${fixture.server.baseUrl}/review?project=${project.id}`);
      await expect(fixture.page.getByRole("heading", {name: "Nothing is published here yet"}))
        .toBeVisible();
      await expect(fixture.page.getByText(
        `artifactserver publish ./dist --project ${project.id}`,
        {exact: true},
      )).toBeVisible();

      await fixture.page.goto(`${fixture.server.baseUrl}/review/settings/projects/${project.id}`);
      const artifactsPanel = fixture.page.getByRole("region", {name: "Artifacts in this project"});
      await expect(artifactsPanel.getByRole("heading", {name: "Nothing is published here yet"}))
        .toBeVisible();

      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><title>Listed artifact</title><p>listed</p>",
        idempotencyKey: "frontend-project-settings-artifacts",
        name: "Listed artifact",
        projectId: project.id,
      });
      await fixture.page.reload();
      const listedRow = artifactsPanel.getByRole("row").filter({hasText: "Listed artifact"});
      await expect(listedRow.getByText("Account required", {exact: true})).toBeVisible();
      const accessibility = await new AxeBuilder({page: fixture.page})
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);

      await listedRow.getByRole("link", {name: "Listed artifact"}).click();
      await expect(fixture.page)
        .toHaveURL(new RegExp(`artifact=${published.body.artifact.id}`, "u"));
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("session expiry with a modal and the account menu open leaves no portal, scroll lock or inert sibling", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await localLogin(fixture);
      const page = fixture.page;
      await page.getByRole("button", {name: "New project"}).click();
      await expect(page.getByRole("dialog", {name: "New project"})).toBeVisible();
      await page.evaluate(() => window.dispatchEvent(new Event("artifact-session-expired")));
      await expect(page.getByRole("link", {name: "Artifact Server"})).toBeVisible();
      await expect(page.getByRole("dialog", {name: "New project"})).toHaveCount(0);
      expect(await page.evaluate(() => ({
        inert: document.querySelectorAll("body > [inert]").length,
        overflow: document.body.style.overflow,
        portals: document.querySelectorAll("[data-ak-modal-portal]").length,
      }))).toEqual({inert: 0, overflow: "", portals: 0});
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("project bootstrap failures remain visible and local expiration bounds use wall-clock time", async ({browser}) => {
    const fixture = await startBrowserFixture(browser, {
      timezoneId: "America/Los_Angeles",
    });
    try {
      await fixture.page.clock.install({
        time: new Date("2026-08-16T12:34:00.000Z"),
      });
      const projectsHeld = Promise.withResolvers<void>();
      await fixture.page.route("**/api/v1/projects", async (route) => {
        await projectsHeld.promise;
        await route.fulfill({
          body: JSON.stringify({
            error: {
              code: "INTERNAL_ERROR",
              message: "Project storage is temporarily unavailable.",
            },
          }),
          contentType: "application/json",
          status: 500,
        });
      });
      await fixture.page.goto(fixture.server.baseUrl);
      await expect(fixture.page.getByRole("heading", {name: "Loading Artifact Server"})).toBeVisible();
      projectsHeld.resolve();
      await expect(fixture.page.getByRole("heading", {name: "Artifact Server unavailable"})).toBeVisible();
      await expect(fixture.page.getByRole("alert").filter({
        hasText: "Project storage is temporarily unavailable.",
      })).toBeVisible();
      await expect(fixture.page.getByRole("heading", {name: "No projects"})).toHaveCount(0);

      await fixture.page.unroute("**/api/v1/projects");
      await fixture.page.getByRole("button", {name: "Try again"}).click();
      await expect(fixture.page.getByRole("link", {name: "Artifact Server"})).toBeVisible();

      await openSettings(fixture.page, "api-keys");
      await fixture.page.getByRole("button", {name: "Issue API key"}).click();
      await expect(fixture.page.getByLabel("Expires at", {exact: true})).toHaveAttribute(
        "min",
        "2026-08-16T05:34",
      );
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});

async function publishReviewMultifileFixture(fixture: BrowserFixture) {
  const encoder = new TextEncoder();
  const imageBytes = await readFile(
    new URL("../../project/evidence/frontend-mvp/error-not-found.png", import.meta.url),
  );
  const fontBytes = await readFile(
    new URL("../../apps/site/public/fonts/Inter-Bold.ttf", import.meta.url),
  );
  const files = [
    {
      bytes: encoder.encode(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Private historical site</title>
    <link rel="stylesheet" href="../styles/site.css">
  </head>
  <body>
    <main>
      <h1 id="multi-title">Private historical site</h1>
      <img alt="Relative pixel" id="relative-image" src="/assets/pixel.png">
      <p id="release-status">Loading</p>
    </main>
    <script src="../scripts/app.js" type="module"></script>
  </body>
</html>`),
      mediaType: "text/html; charset=utf-8",
      path: "site/pages/index.html",
    },
    {
      bytes: encoder.encode(`@font-face {
  font-family: "Review Lease Font";
  font-style: normal;
  font-weight: 700;
  src: url("../../assets/Inter-Bold.ttf") format("truetype");
}
#multi-title {
  color: rgb(12 34 56);
  font-family: "Review Lease Font", sans-serif;
  font-weight: 700;
}`),
      mediaType: "text/css; charset=utf-8",
      path: "site/styles/site.css",
    },
    {
      bytes: encoder.encode(`import {moduleStatus} from "./status.js";
const response = await fetch("../../data/release.json");
const release = await response.json();
document.documentElement.dataset.module = moduleStatus;
document.querySelector("#release-status").textContent = release.status;
await document.fonts.load('700 16px "Review Lease Font"');
document.documentElement.dataset.font = document.fonts.check('700 16px "Review Lease Font"')
  ? "loaded"
  : "missing";`),
      mediaType: "text/javascript; charset=utf-8",
      path: "site/scripts/app.js",
    },
    {
      bytes: encoder.encode('export const moduleStatus = "module-ready";'),
      mediaType: "text/javascript; charset=utf-8",
      path: "site/scripts/status.js",
    },
    {
      bytes: encoder.encode('{"status":"historical-data"}'),
      mediaType: "application/json; charset=utf-8",
      path: "data/release.json",
    },
    {
      bytes: imageBytes,
      mediaType: "image/png",
      path: "assets/pixel.png",
    },
    {
      bytes: fontBytes,
      mediaType: "font/ttf",
      path: "assets/Inter-Bold.ttf",
    },
  ] satisfies readonly TestSiteFile[];
  const upload = await createStagedUpload(
    fixture.server,
    fixture.installation,
    "site/pages/index.html",
    files,
  );
  await uploadEveryStagedFile(fixture.installation, upload.body, files);
  return commitStagedUpload(
    fixture.installation,
    upload.body,
    "frontend-private-multifile-v1",
    {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: "Private multi-file history",
      tags: ["private", "multi-file"],
    },
  );
}

async function publishReviewMediaFixture(
  fixture: BrowserFixture,
): Promise<{
  readonly artifactId: string;
  readonly projectId: string;
  readonly versionId: string;
}> {
  const encoder = new TextEncoder();
  const files = [
    {
      bytes: encoder.encode(
        "<!doctype html><html lang=\"en\"><title>Media entry</title><p>Media fixture entry</p>",
      ),
      mediaType: "text/html; charset=utf-8",
      path: "index.html",
    },
    {
      bytes: Buffer.from(reviewPngBase64, "base64"),
      mediaType: "image/png",
      path: "media/preview.png",
    },
    {
      bytes: Buffer.from(reviewJpegBase64, "base64"),
      mediaType: "image/jpeg",
      path: "media/preview.jpg",
    },
    {
      bytes: Buffer.from(reviewWebpBase64, "base64"),
      mediaType: "image/webp",
      path: "media/preview.webp",
    },
    {
      bytes: Buffer.from(reviewGifBase64, "base64"),
      mediaType: "image/gif",
      path: "media/preview.gif",
    },
    {
      bytes: encoder.encode(
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><script>parent.__artifactSvgExecuted=true</script><rect width="24" height="16" fill="#4f46e5"/></svg>',
      ),
      mediaType: "image/svg+xml",
      path: "media/preview.svg",
    },
    {
      bytes: Buffer.from(reviewWebmBase64, "base64"),
      mediaType: "video/webm",
      path: "media/clip.webm",
    },
    {
      bytes: encoder.encode("not image bytes"),
      mediaType: "image/png",
      path: "media/broken.png",
    },
    {
      bytes: encoder.encode("not an archive"),
      mediaType: "application/zip",
      path: "bundle/archive.zip",
    },
  ] satisfies readonly TestSiteFile[];
  const upload = await createStagedUpload(
    fixture.server,
    fixture.installation,
    "index.html",
    files,
  );
  await uploadEveryStagedFile(fixture.installation, upload.body, files);
  const committed = await commitStagedUpload(
    fixture.installation,
    upload.body,
    "frontend-review-media-fixture",
    {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: "Review media fixture",
      tags: ["media", "preview"],
    },
  );
  return {
    artifactId: committed.body.artifact.id,
    projectId: committed.body.artifact.projectId,
    versionId: committed.body.version.id,
  };
}

async function publishReviewDownloadFixture(
  fixture: BrowserFixture,
): Promise<{
  readonly artifactId: string;
  readonly files: readonly TestSiteFile[];
  readonly projectId: string;
  readonly versionId: string;
}> {
  const encoder = new TextEncoder();
  const files = [
    {
      bytes: encoder.encode(
        "<!doctype html><html lang=\"en\"><title>Download fixture</title><p>Exact export</p>",
      ),
      mediaType: "text/html; charset=utf-8",
      path: "index.html",
    },
    {
      bytes: encoder.encode("export const downloaded = true;\n"),
      mediaType: "text/javascript; charset=utf-8",
      path: "assets/app.js",
    },
  ] satisfies readonly TestSiteFile[];
  const upload = await createStagedUpload(
    fixture.server,
    fixture.installation,
    "index.html",
    files,
  );
  await uploadEveryStagedFile(fixture.installation, upload.body, files);
  const committed = await commitStagedUpload(
    fixture.installation,
    upload.body,
    "frontend-review-download-fixture",
    {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: "Download fixture",
      tags: ["download"],
    },
  );
  return {
    artifactId: committed.body.artifact.id,
    files,
    projectId: committed.body.artifact.projectId,
    versionId: committed.body.version.id,
  };
}

async function requiredDownloadBytes(
  pendingPath: Promise<string | null>,
): Promise<Uint8Array> {
  const path = await pendingPath;
  if (path === null) {
    throw new Error("The browser did not retain the downloaded file.");
  }
  return readFile(path);
}

function expectDownloadArchive(
  archive: Uint8Array,
  expectedFiles: readonly TestSiteFile[],
): void {
  const decoded = unzipSync(archive);
  expect(Object.keys(decoded).toSorted()).toEqual(
    expectedFiles.map(({path}) => path).toSorted(),
  );
  for (const file of expectedFiles) {
    expect(decoded[file.path]).toEqual(file.bytes);
  }
}

async function createProject(
  fixture: BrowserFixture,
  name: string,
): Promise<{readonly id: string}> {
  const response = await fetch(`${fixture.server.baseUrl}/api/v1/projects`, {
    body: JSON.stringify({name}),
    headers: apiHeaders(fixture.installation, "frontend-browser-project"),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return z.object({
    project: z.object({id: z.string()}),
  }).parse(await response.json()).project;
}

async function createActionHistory(
  fixture: BrowserFixture,
  artifactId: string,
  expectedCurrentVersionId: string,
): Promise<void> {
  const responses = await Promise.all(Array.from({length: 52}, (_, index) =>
    fetch(
      `${fixture.server.baseUrl}/api/v1/artifacts/${artifactId}/tags?projectId=prj_default`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId,
          tags: [`history-${index}`],
        }),
        headers: apiHeaders(
          fixture.installation,
          `frontend-history-${String(index).padStart(3, "0")}`,
        ),
        method: "PATCH",
      },
    )
  ));
  expect(responses.every((response) => response.status === 200)).toBe(true);
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Choose one manifest file in the Files tab, opening its folder first. */
async function selectManifestFile(page: Page, path: string): Promise<void> {
  const inventory = page.getByRole("complementary", {name: "Artifact inspector"})
    .getByRole("region", {name: /^Files in version \d+$/u});
  const slash = path.indexOf("/");
  const folder = slash < 0 ? null : path.slice(0, slash);
  const name = slash < 0 ? path : path.slice(slash + 1);
  if (folder !== null) {
    const disclosure = inventory.getByRole("button", {name: new RegExp(`^${escapeRegExp(folder)}/`, "u")});
    if (await disclosure.getAttribute("aria-expanded") === "false") await disclosure.click();
  }
  const list = folder === null
    ? inventory.getByRole("list").first()
    : inventory.getByRole("list", {name: `Files in ${folder}`});
  await list.getByRole("button", {name: new RegExp(`^${escapeRegExp(name)} · `, "u")}).click();
}
