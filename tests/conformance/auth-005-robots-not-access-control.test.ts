import {glob, readFile} from "node:fs/promises";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {publishNew} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

/** Wording that would present link secrecy or robots directives as protection. */
const protectiveClaims: readonly RegExp[] = [
  /\b(?:secret|secure|private|protected|hidden|unguessable)[- ](?:public[- ])?links?\b/iu,
  /\bsearch engines? (?:can.?t|cannot|won.?t|will not)\b/iu,
  /\bnot indexed\b/iu,
  /\bunlisted (?:and|so|means) (?:safe|secure|private|protected)\b/iu,
];

/** Where people and agents read product copy. */
const copySources = [
  "apps/web/src/**/*.{ts,tsx}",
  "src/cli/**/*.ts",
  "src/mcp/**/*.ts",
  "skills/**/*.md",
];

async function matchingFiles(pattern: string): Promise<readonly string[]> {
  const files: string[] = [];
  for await (const relativePath of glob(pattern, {cwd: repositoryRoot})) files.push(relativePath);
  return files;
}

function claimsIn(file: string, source: string): readonly string[] {
  return protectiveClaims
    .filter((claim) => claim.test(source))
    .map((claim) => `${file}: ${claim.source}`);
}

const crawlers = [
  {},
  {"User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"},
  {"User-Agent": "Mozilla/5.0 (compatible; bingbot/2.0)"},
] as const;

describe("robots directives and URL secrecy are not access control", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-005-F: no product copy or authorization check relies on robots directives or link secrecy", async () => {
    // Copy never calls a public link secret, secure, or hidden from search.
    const matched = await Promise.all(copySources.map(matchingFiles));
    expect(matched.map((files) => files.length > 0)).toEqual(copySources.map(() => true));
    const files = matched.flat();
    expect(files.some((file) => file.endsWith(".tsx"))).toBe(true);
    const claims = (await Promise.all(files.map(async (relativePath) =>
      claimsIn(
        relativePath.split(path.sep).join("/"),
        await readFile(path.join(repositoryRoot, relativePath), "utf8"),
      )
    ))).flat();
    expect(claims).toEqual([]);
    expect([
      ...claimsIn("a.tsx", "Only people with this secret link can open it."),
      ...claimsIn("b.ts", "Search engines can't find unlisted links."),
      ...claimsIn("c.md", "The artifact is not indexed, so it stays private."),
    ]).toHaveLength(3);

    // Authorization ignores crawler identity: a public version opens for
    // every caller alike despite noindex, and knowing the exact URL of an
    // account-required version opens it for no one.
    const shared = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: "<!doctype html><title>Public</title>",
      idempotencyKey: "auth-005-f-public",
    });
    const restricted = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Restricted</title>",
      idempotencyKey: "auth-005-f-restricted",
    });
    const outcomes = await Promise.all(crawlers.map(async (headers) => {
      const open = await fetchVersion(server, shared.body.links.version, "GET", headers);
      const exact = await fetchVersion(server, restricted.body.links.version, "GET", headers);
      const stable = await fetch(restricted.body.links.artifact, {headers, redirect: "manual"});
      return {
        exact: [exact.status, (await exact.text()).includes("Restricted")],
        open: [open.status, open.headers.get("x-robots-tag"), await open.text()],
        stable: [stable.status, (await stable.text()).includes("Restricted")],
      };
    }));
    expect(outcomes).toEqual(crawlers.map(() => ({
      exact: [401, false],
      open: [200, "noindex, nofollow", "<!doctype html><title>Public</title>"],
      stable: [401, false],
    })));
  });
});
