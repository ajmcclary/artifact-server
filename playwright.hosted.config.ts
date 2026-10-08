import {existsSync, readFileSync} from "node:fs";
import {registerHooks, stripTypeScriptTypes} from "node:module";
import {fileURLToPath} from "node:url";
import {parseEnv} from "node:util";

import {defineConfig} from "@playwright/test";

/**
 * The DSN-011 test drives the extracted bridge core, a TypeScript-only
 * package. Playwright never transpiles node_modules and Node refuses to strip
 * types there, so this one package's source is stripped here. Every other
 * file still goes through Playwright's own transform.
 */
const bridgeCorePackage = "/node_modules/@plannotator/agent-bridge/";
registerHooks({
  load(url, context, nextLoad) {
    if (!url.includes(bridgeCorePackage) || !url.endsWith(".ts")) return nextLoad(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    return {format: "module", shortCircuit: true, source: stripTypeScriptTypes(source)};
  },
});

/**
 * The DSN-011 agent principal's key may live in the repository's ignored
 * `.env`. Only that one variable is taken from it, and only when the
 * environment does not already set it; nothing else in the file reaches the
 * run, and the key itself is never printed.
 */
const environmentFile = fileURLToPath(new URL(".env", import.meta.url));
if (process.env["BACKEND_AGENT_KEY"] === undefined && existsSync(environmentFile)) {
  const agentKey = parseEnv(readFileSync(environmentFile, "utf8"))["BACKEND_AGENT_KEY"];
  if (agentKey !== undefined) process.env["BACKEND_AGENT_KEY"] = agentKey;
}

/**
 * Hosted qualification runs against a deployed Artifact Server named by
 * ARTIFACT_SERVER_HOSTED_URL (artifacts.backend.app by default), signed in
 * with the operator's CLI profile. It is never part of the local gate.
 */
export default defineConfig({
  expect: {timeout: 15_000},
  fullyParallel: false,
  outputDir: "test-results/hosted",
  projects: [
    {name: "chromium", use: {browserName: "chromium"}},
    // Design reviews Forms in Safari, so the Forms run also goes through WebKit.
    {name: "webkit", testMatch: /forms-review\.hosted\.spec\.ts$/u, use: {browserName: "webkit"}},
  ],
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
