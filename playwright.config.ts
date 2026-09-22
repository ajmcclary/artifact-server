import {defineConfig} from "@playwright/test";

/**
 * The default Chromium run covers the whole browser suite. Firefox and WebKit
 * stay opt-in behind BROWSER_CRITICAL_ENGINES ("firefox", "webkit", or "all")
 * and run only the critical-engines slice, so the matrix proves the
 * security-sensitive paths on every engine without tripling the cosmetic
 * coverage.
 */
const criticalEngines = new Set(
  (process.env["BROWSER_CRITICAL_ENGINES"] ?? "")
    .split(",")
    .map((engine) => engine.trim().toLowerCase())
    .filter((engine) => engine.length > 0),
);
const wantsEngine = (engine: string): boolean =>
  criticalEngines.has(engine) || criticalEngines.has("all");

export default defineConfig({
  expect: {timeout: 10_000},
  fullyParallel: false,
  outputDir: "test-results/browser",
  projects: [
    {name: "chromium", use: {browserName: "chromium"}},
    ...(wantsEngine("firefox")
      ? [{name: "firefox", testMatch: /critical-engines\.spec\.ts/, use: {browserName: "firefox" as const}}]
      : []),
    ...(wantsEngine("webkit")
      ? [{name: "webkit", testMatch: /critical-engines\.spec\.ts/, use: {browserName: "webkit" as const}}]
      : []),
  ],
  reporter: [
    ["line"],
    ["json", {outputFile: "test-results/browser/playwright-report.json"}],
  ],
  testDir: "tests/browser",
  timeout: 60_000,
  use: {
    headless: true,
    trace: "retain-on-failure",
  },
  workers: 1,
});
