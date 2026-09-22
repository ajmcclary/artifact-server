import {createHash} from "node:crypto";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {publishNew} from "../support/publishing.js";
import {
  apiHeaders,
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const changedAccessSchema = z.object({
  artifact: z.object({accessSetting: z.string()}).loose(),
  warning: z.string().nullable(),
}).loose();

describe("public to private visibility change stops new reads and never recalls copies", () => {
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

  test("AUTH-007-B: changing public to account-required denies the origin, warns about copies, and revalidates stale cache keys", async () => {
    expect.hasAssertions();
    const publicBytes = "<!doctype html><title>Was public</title>";
    const published = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: publicBytes,
      idempotencyKey: "auth-007-public-fixture",
      name: "Visibility fixture",
    });

    const publicEtag = `"${createHash("sha256").update(publicBytes, "utf8").digest("hex")}"`;
    const before = await fetchVersion(server, published.body.links.version);
    expect(before.status).toBe(200);
    expect(before.headers.get("etag")).toBe(publicEtag);

    const change = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}/access`,
      {
        body: JSON.stringify({
          accessSetting: "account_required",
          expectedCurrentVersionId: published.body.version.id,
        }),
        headers: apiHeaders(installation, "auth-007-change-visibility"),
        method: "PATCH",
      },
    );
    expect(change.status).toBe(200);
    const changed = changedAccessSchema.parse(await change.json());
    expect(changed.artifact.accessSetting).toBe("account_required");
    expect(changed.warning).toContain("cannot be recalled");

    // The public origin now refuses new reads.
    const after = await fetchVersion(server, published.body.links.version);
    expect(after.status).toBe(401);

    // A stale public cache key cannot obtain a fresh origin response: the
    // previously-issued ETag revalidates at the origin and is denied.
    const stale = await fetchVersion(server, published.body.links.version, "GET", {
      "If-None-Match": publicEtag,
    });
    expect(stale.status).toBe(401);
  });

  test("AUTH-007-F: a stale public cache key cannot obtain a fresh origin response and the interface never promises recall", async () => {
    expect.hasAssertions();
    const published = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: "<!doctype html><title>Public then private</title>",
      idempotencyKey: "auth-007-recall-fixture",
    });
    const publicEtag = requiredHeader(
      (await fetchVersion(server, published.body.links.version)).headers,
      "etag",
    );

    const change = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}/access`,
      {
        body: JSON.stringify({
          accessSetting: "account_required",
          expectedCurrentVersionId: published.body.version.id,
        }),
        headers: apiHeaders(installation, "auth-007-recall-change"),
        method: "PATCH",
      },
    );
    expect(change.status).toBe(200);
    const changed = changedAccessSchema.parse(await change.json());

    // The warning names the impossibility of recalling external copies.
    expect(changed.warning).toContain(
      "Copies already downloaded or cached outside Artifact Server cannot be recalled.",
    );

    // The stale ETag (a shared-cache revalidation) is refused, never served.
    const stale = await fetchVersion(server, published.body.links.version, "GET", {
      "If-None-Match": publicEtag,
    });
    expect(stale.status).toBe(401);
    expect(await stale.text()).not.toContain("Public then private");
  });
});

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (value === null) throw new Error(`The ${name} response header is missing.`);
  return value;
}
