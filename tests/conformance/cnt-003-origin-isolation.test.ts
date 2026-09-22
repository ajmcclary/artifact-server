import {Effect} from "effect";
import {getDomain} from "tldts";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {parseExternalStorageRuntimeConfiguration} from "../../src/lifecycle/runtime-configuration.js";
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

describe("application and content origins stay isolated", () => {
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

  test("CNT-003-B: application and content origins use different registrable domains and neither cookie crosses", async () => {
    expect.hasAssertions();
    await server.stop();
    server = await startTestServer(installation, {
      applicationOrigin: "https://artifacts.example.com",
      contentDomain: "content.artifacts.example.net",
    });

    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Isolated content</title>",
      idempotencyKey: "cnt-003-origin-isolation",
    });
    const contentUrl = new URL(published.body.links.version);
    expect(contentUrl.hostname).toMatch(
      /^[a-z0-9]+\.content\.artifacts\.example\.net$/u,
    );
    const applicationUrl = new URL("https://artifacts.example.com");
    expect(registrableDomain(applicationUrl.hostname))
      .not.toBe(registrableDomain(contentUrl.hostname));

    // The application session cookie is host-only, so it never reaches the
    // content registrable domain.
    const login = await fetch(`${server.baseUrl}/auth/local-owner`, {
      headers: {
        Origin: server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
      method: "POST",
    });
    expect(login.status).toBe(204);
    const appCookie = requiredHeader(login.headers, "set-cookie");
    expect(appCookie).toContain("artifact_session=");
    expect(appCookie).not.toContain("Domain=");

    // The content cookie is __Host-prefixed (host-only by construction),
    // Secure, and carries no Domain attribute.
    const issueResponse = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}/content-sessions`,
      {
        headers: {Authorization: `Bearer ${installation.apiToken}`},
        method: "POST",
      },
    );
    expect(issueResponse.status).toBe(201);
    const issued = bootstrapResponseSchema.parse(await issueResponse.json());
    const exchange = await fetchVersion(server, issued.bootstrapUrl);
    expect(exchange.status).toBe(200);
    const contentCookie = requiredHeader(exchange.headers, "set-cookie");
    expect(contentCookie).toContain("__Host-artifact_content=");
    expect(contentCookie).toContain("Secure");
    expect(contentCookie).toContain("HttpOnly");
    expect(contentCookie).not.toContain("Domain=");

    // The application surface is not reachable from the content origin.
    const applicationRoute = await fetchVersion(
      server,
      new URL("/api/v1/artifacts", published.body.links.version).toString(),
    );
    expect(applicationRoute.status).toBe(404);
  });

  test("CNT-003-F: an external-storage configuration that shares a registrable domain is rejected", async () => {
    expect.hasAssertions();
    await expect(Effect.runPromise(parseExternalStorageRuntimeConfiguration({
      environment: {
        ...externalConfigurationEnvironment(),
        // The application origin is artifacts.example.com, so a content domain
        // beneath example.com would make artifact JavaScript same-site with
        // the application.
        ARTIFACT_SERVER_CONTENT_DOMAIN: "content.example.com",
      },
      hostname: "127.0.0.1",
      port: "8787",
    }))).rejects.toMatchObject({
      field: "ARTIFACT_SERVER_CONTENT_DOMAIN",
      reason: "invalid_origin",
    });
  });
});

function registrableDomain(hostname: string): string | null {
  return getDomain(hostname, {allowPrivateDomains: true});
}

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (value === null) throw new Error(`The ${name} response header is missing.`);
  return value;
}

function externalConfigurationEnvironment(): NodeJS.ProcessEnv {
  return {
    ARTIFACT_SERVER_API_TOKEN:
      `as_key_key_00000000-0000-4000-8000-000000000000_${"a".repeat(40)}`,
    ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "admin@example.test",
    ARTIFACT_SERVER_CONTENT_DOMAIN: "content.example.net",
    ARTIFACT_SERVER_DATABASE_URL: "postgres://user:secret@localhost/artifacts",
    ARTIFACT_SERVER_INSTALLATION_ID: "test-installation",
    ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.com",
    ARTIFACT_SERVER_S3_BUCKET: "artifact-test-bucket",
    ARTIFACT_SERVER_S3_ACCESS_KEY_ID: "access-key",
    ARTIFACT_SERVER_S3_REGION: "us-east-1",
    ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY: "secret-access-key",
  };
}
