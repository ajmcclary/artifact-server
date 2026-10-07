import {defineConfig} from "@playwright/test";

/**
 * Hosted qualification runs against a deployed Artifact Server named by
 * ARTIFACT_SERVER_HOSTED_URL (artifacts.backend.app by default), signed in
 * with the operator's CLI profile. It is never part of the local gate.
 */
export default defineConfig({
  expect: {timeout: 15_000},
  fullyParallel: false,
  outputDir: "test-results/hosted",
  projects: [{name: "chromium", use: {browserName: "chromium"}}],
  reporter: [
    ["line"],
    ["json", {outputFile: "test-results/hosted/playwright-report.json"}],
  ],
  retries: 0,
  testDir: "tests/hosted",
  testMatch: /\.hosted\.spec\.ts$/u,
  timeout: 180_000,
  use: {
    headless: true,
    trace: "retain-on-failure",
  },
  workers: 1,
});
