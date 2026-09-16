import {expect, test} from "@playwright/test";

import {publishNew} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";

const hostileArtifact = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Sandbox probe</title></head>
  <body>
    <p id="probe-parent">parent:pending</p>
    <p id="probe-cookie">cookie:pending</p>
    <p id="probe-fetch">fetch:pending</p>
    <script>
      (function () {
        var report = function (id, value) {
          document.getElementById(id).textContent = value;
        };
        try {
          var title = window.parent.document.title;
          report("probe-parent", "parent:reached:" + title);
        } catch (error) {
          report("probe-parent", "parent:blocked");
        }
        try {
          report("probe-cookie", "cookie:readable:[" + document.cookie + "]");
        } catch (error) {
          report("probe-cookie", "cookie:blocked");
        }
        try {
          fetch("/api/v1/session", {credentials: "include"}).then(
            function (response) {
              report("probe-fetch", "fetch:reached:" + response.status);
            },
            function () {
              report("probe-fetch", "fetch:blocked");
            }
          );
        } catch (error) {
          report("probe-fetch", "fetch:blocked");
        }
      })();
    </script>
  </body>
</html>`;

test.describe("Review sandbox isolation", () => {
  test("CMT-014-B CMT-014-F: hostile artifact HTML stays inside an opaque-origin sandbox", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: hostileArtifact,
        idempotencyKey: "review-sandbox-isolation",
        mediaType: "text/html; charset=utf-8",
        name: "Sandbox probe",
        path: "index.html",
      });
      await localLogin(fixture);
      await fixture.page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${published.body.artifact.id}&version=${published.body.version.id}`,
      );

      const reviewFrame = fixture.page.frameLocator(".as-artifact-frame");
      const sandboxElement = reviewFrame.locator("iframe");
      await expect(sandboxElement).toHaveAttribute("sandbox", "allow-scripts");
      await expect(sandboxElement).not.toHaveAttribute("sandbox", /allow-same-origin/u);
      await expect(sandboxElement).not.toHaveAttribute("sandbox", /allow-forms/u);
      await expect(sandboxElement).not.toHaveAttribute("sandbox", /allow-top-navigation/u);

      const artifactFrame = reviewFrame.frameLocator("iframe");
      expect(await artifactFrame.locator("body").evaluate(() => window.origin))
        .toBe("null");
      await expect(artifactFrame.locator("#probe-parent")).toHaveText("parent:blocked");
      await expect(artifactFrame.locator("#probe-cookie"))
        .toHaveText(/^cookie:(blocked|readable:\[\])$/u);
      await expect(artifactFrame.locator("#probe-fetch")).toHaveText("fetch:blocked");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-022-B CMT-022-F: script-dependent public HTML uses an isolated interactive preview and can return to annotations", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const content = `<!doctype html><html lang="en"><head><title>Interactive probe</title>
        <script src="data:text/javascript,window.externalLoaded%3Dtrue"></script>
        </head><body><p id="interactive-result">pending</p><script>
          const value = new Function("return 7")();
          localStorage.setItem("interactive-probe", String(value));
          let parentAccess = "blocked";
          try { parentAccess = window.parent.document.title; } catch {}
          document.getElementById("interactive-result").textContent =
            [window.externalLoaded, localStorage.getItem("interactive-probe"), parentAccess].join(":");
        </script></body></html>`;
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "public_link",
        content,
        idempotencyKey: "review-interactive-isolation",
        mediaType: "text/html; charset=utf-8",
        name: "Interactive probe",
        path: "index.html",
      });
      await localLogin(fixture);
      await fixture.page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${published.body.artifact.id}&version=${published.body.version.id}`,
      );

      const preview = fixture.page.locator(".as-html-preview");
      await expect(preview).toHaveAttribute("data-mode", "interactive");
      await expect(fixture.page.locator(".as-preview-header__actions")
        .getByRole("button", {name: /Annotate mode:|Interact mode:/u}))
        .toHaveCount(0);
      const interactiveFrame = preview.locator("iframe");
      await expect(interactiveFrame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
      await expect(interactiveFrame).toHaveAttribute(
        "src",
        new URL("index.html", published.body.links.version).toString(),
      );
      await expect(preview.frameLocator("iframe").locator("#interactive-result"))
        .toHaveText("true:7:blocked");

      await preview.getByRole("button", {name: "Annotate"}).click();
      await expect(preview).toHaveAttribute("data-mode", "annotate");
      await expect(fixture.page.locator(".as-preview-header__actions")
        .getByRole("button", {name: /Annotate mode:/u}))
        .toBeVisible();
      const annotationFrame = preview.frameLocator("iframe");
      await expect(annotationFrame.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
      await preview.getByRole("button", {name: "Interactive preview"}).click();
      await expect(preview.frameLocator("iframe").locator("#interactive-result"))
        .toHaveText("true:7:blocked");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-022-B CMT-022-F: private interactive preview stays on a temporary exact-version lease", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: `<!doctype html><html lang="en"><head>
          <script src="data:text/javascript,window.loaded%3Dtrue"></script>
          </head><body><p id="private-result">pending</p><p id="app-result">pending</p><script>
            let appAccess = "blocked";
            try { appAccess = window.parent.document.title; } catch {}
            document.getElementById("private-result").textContent =
              [window.loaded, new Function("return 9")(), appAccess].join(":");
            fetch(${JSON.stringify(`${fixture.server.baseUrl}/api/v1/session`)}, {credentials: "include"})
              .then(() => { document.getElementById("app-result").textContent = "reached"; })
              .catch(() => { document.getElementById("app-result").textContent = "blocked"; });
          </script></body></html>`,
        idempotencyKey: "review-private-interactive-isolation",
        mediaType: "text/html; charset=utf-8",
        name: "Private interactive probe",
        path: "nested/index.html",
      });
      await localLogin(fixture);
      await fixture.page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${published.body.artifact.id}&version=${published.body.version.id}`,
      );

      const preview = fixture.page.locator(".as-html-preview");
      await expect(preview).toHaveAttribute("data-mode", "interactive");
      await expect(preview).toContainText("Preview changes may be lost");
      await expect(preview.locator("iframe")).toHaveAttribute(
        "src",
        /^http:\/\/review-[a-z0-9_-]+\.localhost:\d+\/nested\/index\.html$/u,
      );
      await expect(preview.frameLocator("iframe").locator("#private-result"))
        .toHaveText("true:9:blocked");
      await expect(preview.frameLocator("iframe").locator("#app-result"))
        .toHaveText("blocked");
      expect(await fixture.page.request.get(published.body.links.version).then((response) => response.status()))
        .not.toBe(200);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
