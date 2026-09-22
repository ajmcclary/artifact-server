import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  publishNew,
  publishVersion,
} from "../support/publishing.js";
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

describe("every saved version owns an immutable content origin", () => {
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

  test("CNT-004-B: two versions receive different origins and each serves its exact files", async () => {
    expect.hasAssertions();
    const first = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Version one</title>",
      idempotencyKey: "cnt-004-origin-v1",
      name: "Origin fixture",
    });
    const second = await publishVersion(server, installation, {
      artifactId: first.body.artifact.id,
      content: "<!doctype html><title>Version two</title>",
      expectedCurrentVersionId: first.body.version.id,
      idempotencyKey: "cnt-004-origin-v2",
    });

    const firstOrigin = new URL(first.body.links.version).origin;
    const secondOrigin = new URL(second.body.links.version).origin;
    expect(firstOrigin).not.toBe(secondOrigin);

    // Each immutable origin serves its own exact bytes.
    expect(await readPrivateBytes(
      first.body.artifact.id,
      first.body.version.id,
      first.body.links.version,
    )).toContain("Version one");
    expect(await readPrivateBytes(
      second.body.artifact.id,
      second.body.version.id,
      second.body.links.version,
    )).toContain("Version two");
  });

  test("CNT-004-F: one version's origin cannot read another version's storage, cookies, caches, or service-worker control", async () => {
    expect.hasAssertions();
    const first = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>First private</title>",
      idempotencyKey: "cnt-004-isolation-v1",
    });
    const second = await publishVersion(server, installation, {
      artifactId: first.body.artifact.id,
      content: "<!doctype html><title>Second private</title>",
      expectedCurrentVersionId: first.body.version.id,
      idempotencyKey: "cnt-004-isolation-v2",
    });

    const cookie = await issueContentCookie(
      first.body.artifact.id,
      first.body.version.id,
    );

    // The first version's host-only session is rejected by the second
    // version's origin.
    const wrongHost = await fetchVersion(
      server,
      second.body.links.version,
      "GET",
      {Cookie: cookie},
    );
    expect(wrongHost.status).toBe(401);

    // A content origin cannot reach the application surface.
    const applicationRoute = await fetchVersion(
      server,
      new URL("/api/v1/artifacts", first.body.links.version).toString(),
      "GET",
      {Cookie: cookie},
    );
    expect(applicationRoute.status).toBe(404);

    // A content origin serves only its own version's manifest entries.
    const missing = await fetchVersion(
      server,
      new URL("/not-in-the-manifest.html", first.body.links.version).toString(),
      "GET",
      {Cookie: cookie},
    );
    expect(missing.status).toBe(404);
  });

  async function issueContentCookie(
    artifactId: string,
    versionId: string,
  ): Promise<string> {
    const issueResponse = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}/versions/${versionId}/content-sessions`,
      {
        headers: {Authorization: `Bearer ${installation.apiToken}`},
        method: "POST",
      },
    );
    expect(issueResponse.status).toBe(201);
    const issued = bootstrapResponseSchema.parse(await issueResponse.json());
    const exchange = await fetchVersion(server, issued.bootstrapUrl);
    expect(exchange.status).toBe(200);
    const setCookie = requiredHeader(exchange.headers, "set-cookie");
    const cookie = setCookie.split(";", 1)[0];
    if (cookie === undefined) throw new Error("The content cookie is empty.");
    return cookie;
  }

  async function readPrivateBytes(
    artifactId: string,
    versionId: string,
    versionUrl: string,
  ): Promise<string> {
    const cookie = await issueContentCookie(artifactId, versionId);
    const response = await fetchVersion(server, versionUrl, "GET", {Cookie: cookie});
    expect(response.status).toBe(200);
    return response.text();
  }
});

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (value === null) throw new Error(`The ${name} response header is missing.`);
  return value;
}
