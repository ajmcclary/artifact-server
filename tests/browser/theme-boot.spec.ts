import {expect, test} from "@playwright/test";
import {z} from "zod";

import {localLogin, startBrowserFixture, stopBrowserFixture} from "./browser-fixture.js";

const paintOrder = z.array(z.enum(["body", "theme"]));

test.describe("ArkCase theme boot", () => {
  test("the stored theme mode is on <html> before the body is parsed", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      // Records, per document, whether data-theme changed before <body> existed.
      await fixture.context.addInitScript(() => {
        localStorage.setItem("arkcase.theme.v1", JSON.stringify("dark"));
        const order: string[] = [];
        new MutationObserver((records) => {
          for (const record of records) {
            if (record.type === "attributes") order.push("theme");
            for (const node of record.addedNodes) {
              if (node.nodeName === "BODY") order.push("body");
            }
          }
          sessionStorage.setItem("theme-paint-order", JSON.stringify(order));
        }).observe(document, {attributeFilter: ["data-theme"], attributes: true, childList: true, subtree: true});
      });
      await localLogin(fixture);
      const recorded = await fixture.page.evaluate(() => sessionStorage.getItem("theme-paint-order") ?? "[]");
      expect(paintOrder.parse(JSON.parse(recorded)).slice(0, 2)).toEqual(["theme", "body"]);
      await expect(fixture.page.locator("html")).toHaveAttribute("data-theme", "dark");
      await expect(fixture.page.locator("html")).toHaveAttribute("data-theme-mode", "dark");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("a legacy moon choice migrates to the Dark mode before first paint", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      // Re-seeds on every document; each later load then takes the "already chosen wins" path.
      await fixture.context.addInitScript(() => {
        localStorage.setItem("artifact-review-theme", "moon");
      });
      await localLogin(fixture);
      expect(await fixture.page.evaluate(() => localStorage.getItem("arkcase.theme.v1")))
        .toBe(JSON.stringify("dark"));
      expect(await fixture.page.evaluate(() => localStorage.getItem("artifact-review-theme"))).toBeNull();
      await expect(fixture.page.locator("html")).toHaveAttribute("data-theme", "dark");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("review.html loads theme-boot first as a same-origin classic script and uses the ArkCase favicon", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const reviewDocument = await fixture.page.request.get(`${fixture.server.baseUrl}/review`);
      expect(reviewDocument.status()).toBe(200);
      const html = await reviewDocument.text();
      const bootPath = z.string().parse(
        /<head>\s*<script src="(\/assets\/theme-boot-[0-9a-f]{10}\.js)"><\/script>/u.exec(html)?.[1],
      );
      const boot = await fixture.page.request.get(`${fixture.server.baseUrl}${bootPath}`);
      expect(boot.status()).toBe(200);
      expect(boot.headers()["content-type"]).toBe("text/javascript; charset=utf-8");
      const iconPath = z.string().parse(
        /<link rel="icon" href="(\/assets\/favicon-[\w-]+\.svg)" type="image\/svg\+xml"/u.exec(html)?.[1],
      );
      const icon = await fixture.page.request.get(`${fixture.server.baseUrl}${iconPath}`);
      expect(icon.status()).toBe(200);
      expect(icon.headers()["content-type"]).toBe("image/svg+xml");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});

test("theme boot and the review app survive a localStorage that throws", async ({browser}) => {
  const fixture = await startBrowserFixture(browser);
  try {
    await fixture.context.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          throw new DOMException("The operation is insecure.", "SecurityError");
        },
      });
    });
    const errors: string[] = [];
    fixture.page.on("pageerror", (error) => errors.push(error.message));
    await localLogin(fixture);
    await expect(fixture.page.locator("html")).toHaveAttribute("data-theme-mode", "system");
    expect(errors).toEqual([]);
  } finally {
    await stopBrowserFixture(fixture);
  }
});
