import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const frameFixture = "<!doctype html><title>Review frame fixture</title>";

/** The policy's directives keyed by name, each with its source list. */
function directives(policy: string | null): ReadonlyMap<string, readonly string[]> {
  if (policy === null) throw new Error("The review frame has no Content-Security-Policy.");
  return new Map(policy.split(";").map((directive) => {
    const [name = "", ...sources] = directive.trim().split(/\s+/u);
    return [name, sources];
  }));
}

describe("the review frame's inherited sandbox policy", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | undefined;
  let webAssetsRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    webAssetsRoot = await mkdtemp(path.join(tmpdir(), "artifact-server-review-frame-"));
    await writeFile(path.join(webAssetsRoot, "review-frame.html"), frameFixture);
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    await removeTestInstallation(installation);
    await rm(webAssetsRoot, {force: true, recursive: true});
  });

  test("foundation: a separate content domain admits only HTTPS content hosts and refuses base and plugin injection", async () => {
    server = await startTestServer(installation, {
      applicationOrigin: "https://artifacts.example.test",
      contentDomain: "content.example-usercontent.test",
      webAssetsRoot,
    });
    const frame = await fetch(`${server.baseUrl}/review-frame`);
    expect(frame.status).toBe(200);
    expect(await frame.text()).toBe(frameFixture);
    const policy = directives(frame.headers.get("content-security-policy"));
    const content = "https://*.content.example-usercontent.test";

    expect(policy.get("default-src")).toEqual(["'none'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    // The sandbox's injected <base href> names the exact-version content host;
    // no other base can retarget the artifact's relative URLs.
    expect(policy.get("base-uri")).toEqual([content]);
    // Inline artifact scripts and styles still run in the opaque sandbox.
    expect(policy.get("script-src")).toEqual(["'self'", "'unsafe-inline'", content]);
    expect(policy.get("style-src")).toEqual(["'self'", "'unsafe-inline'", content]);
    expect(policy.get("connect-src")).toEqual([content]);
    expect(policy.get("frame-ancestors")).toEqual(["'self'"]);
    // No plain-HTTP wildcard-port source survives outside local development.
    expect([...policy.values()].flat().filter((source) => source.startsWith("http:")))
      .toEqual([]);
  });

  test("foundation: local development keeps loopback content hosts on any port", async () => {
    server = await startTestServer(installation, {webAssetsRoot});
    const frame = await fetch(`${server.baseUrl}/review-frame`);
    expect(frame.status).toBe(200);
    await frame.arrayBuffer();
    const policy = directives(frame.headers.get("content-security-policy"));
    const content = ["http://*.localhost:*", "https://*.localhost"];

    expect(policy.get("base-uri")).toEqual(content);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("script-src")).toEqual(["'self'", "'unsafe-inline'", ...content]);
    expect(policy.get("connect-src")).toEqual(content);
  });
});
