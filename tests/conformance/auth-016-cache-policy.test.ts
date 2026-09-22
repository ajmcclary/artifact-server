import {createHash} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {publishNew} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const bootstrapResponseSchema = z.object({
  bootstrapUrl: z.url(),
  expiresAt: z.string(),
  versionId: z.string(),
});

describe("cache policy keeps private bytes out of shared caches and public keys immutable", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let webAssetsRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    webAssetsRoot = await mkdtemp(
      path.join(tmpdir(), "artifact-server-auth-016-assets-"),
    );
    await mkdir(path.join(webAssetsRoot, "assets"), {recursive: true});
    await writeFile(
      path.join(webAssetsRoot, "assets", "app-fixture.js"),
      "export const value = 1;\n",
    );
    server = await startTestServer(installation, {webAssetsRoot});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
    await rm(webAssetsRoot, {force: true, recursive: true});
  });

  test("AUTH-016-B: private content is no-store, public content revalidates under an immutable key, and app assets are immutable", async () => {
    expect.hasAssertions();
    const privateBytes = "<!doctype html><title>Private</title>";
    const privatePublished = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: privateBytes,
      idempotencyKey: "auth-016-private-fixture",
      name: "Private cache fixture",
    });

    const issueResponse = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${privatePublished.body.artifact.id}/content-sessions`,
      {
        headers: {Authorization: `Bearer ${installation.apiToken}`},
        method: "POST",
      },
    );
    expect(issueResponse.status).toBe(201);
    const issued = bootstrapResponseSchema.parse(await issueResponse.json());
    const exchange = await fetchVersion(server, issued.bootstrapUrl);
    const cookie = requiredHeader(exchange.headers, "set-cookie").split(";", 1)[0];
    if (cookie === undefined) throw new Error("The content cookie is empty.");

    const privateResponse = await fetchVersion(
      server,
      privatePublished.body.links.version,
      "GET",
      {Cookie: cookie},
    );
    expect(privateResponse.status).toBe(200);
    expect(privateResponse.headers.get("cache-control")).toBe("private, no-store");

    const publicBytes = "<!doctype html><title>Public</title>";
    const publicPublished = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: publicBytes,
      idempotencyKey: "auth-016-public-fixture",
      name: "Public cache fixture",
    });
    const publicResponse = await fetchVersion(
      server,
      publicPublished.body.links.version,
    );
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers.get("cache-control")).toBe(
      "public, no-cache, must-revalidate",
    );
    expect(publicResponse.headers.get("etag")).toBe(
      `"${createHash("sha256").update(publicBytes, "utf8").digest("hex")}"`,
    );

    const asset = await fetch(`${server.baseUrl}/assets/app-fixture.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  test("AUTH-016-F: an unauthenticated viewer cannot receive private bytes from a cache populated by another viewer", async () => {
    expect.hasAssertions();
    const privatePublished = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Private only</title>",
      idempotencyKey: "auth-016-private-isolation",
    });

    const unauthorized = await fetchVersion(
      server,
      privatePublished.body.links.version,
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("cache-control")).toBe("private, no-store");
    expect(await unauthorized.text()).not.toContain("Private only");
  });
});

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (value === null) throw new Error(`The ${name} response header is missing.`);
  return value;
}
