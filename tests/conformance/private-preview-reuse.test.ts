import {createHash, randomBytes} from "node:crypto";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {Clock} from "../../src/core/ports.js";
import {signInAdministrator} from "../support/agent-dispatch.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {publishNew, publishVersion} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const leaseSchema = z.object({baseUrl: z.url(), expiresAt: z.string(), versionId: z.string()});
const twelveHours = 12 * 60 * 60 * 1_000;

type AdminBody = Readonly<Record<string, string | readonly string[]>>;

async function bearerLease(endpoint: string, token: string, reuse?: string): Promise<Response> {
  const init: RequestInit = {
    headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
    method: "POST",
  };
  if (reuse !== undefined) init.body = JSON.stringify({reuse});
  return fetch(endpoint, init);
}

class MutableTestClock implements Clock {
  #now: Date;
  constructor(start: Date) {
    this.#now = start;
  }
  now(): Date {
    return new Date(this.#now);
  }
  advance(milliseconds: number): void {
    this.#now = new Date(this.#now.getTime() + milliseconds);
  }
}

describe("reusable preview leases", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let clock: MutableTestClock;

  beforeEach(async () => {
    installation = await createTestInstallation();
    clock = new MutableTestClock(new Date("2026-10-05T12:00:00.000Z"));
    server = await startTestServer(installation, {clock});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  const leaseEndpoint = (artifactId: string, versionId: string, projectId: string): string =>
    `${server.baseUrl}/api/v1/artifacts/${artifactId}/versions/${versionId}/preview-leases?projectId=${projectId}`;

  async function requestLease(
    endpoint: string,
    reuse?: string,
  ): Promise<{readonly lease: z.infer<typeof leaseSchema>; readonly status: number}> {
    const headers = new Headers({Authorization: `Bearer ${installation.apiToken}`});
    const init: RequestInit = {headers, method: "POST"};
    if (reuse !== undefined) {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify({reuse});
    }
    const response = await fetch(endpoint, init);
    return {lease: leaseSchema.parse(await response.json()), status: response.status};
  }

  test("foundation: a lease lasts twelve hours and is returned unchanged on reuse", async () => {
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Reuse one</title>",
      idempotencyKey: "reuse-lifetime-v1",
      name: "Reuse lifetime",
    });
    const endpoint = leaseEndpoint(published.body.artifact.id, published.body.version.id, published.body.artifact.projectId);
    const issued = await requestLease(endpoint);
    expect(issued.status).toBe(201);
    expect(Date.parse(issued.lease.expiresAt) - clock.now().getTime()).toBe(twelveHours);

    clock.advance(60 * 60 * 1_000);
    const reused = await requestLease(endpoint, issued.lease.baseUrl);
    expect(reused.status).toBe(200);
    expect(reused.lease).toEqual(issued.lease);

    const noBody = await requestLease(endpoint);
    expect(noBody.status).toBe(201);
    expect(noBody.lease.baseUrl).not.toBe(issued.lease.baseUrl);
  });

  test("foundation: a malformed, foreign-host, cross-version, expired, or non-lease reuse yields a fresh lease", async () => {
    const first = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Reuse v1</title>",
      idempotencyKey: "reuse-hostile-v1",
      name: "Reuse hostile",
    });
    const second = await publishVersion(server, installation, {
      artifactId: first.body.artifact.id,
      content: "<!doctype html><title>Reuse v2</title>",
      expectedCurrentVersionId: first.body.version.id,
      idempotencyKey: "reuse-hostile-v2",
    });
    const projectId = first.body.artifact.projectId;
    const firstEndpoint = leaseEndpoint(first.body.artifact.id, first.body.version.id, projectId);
    const secondEndpoint = leaseEndpoint(first.body.artifact.id, second.body.version.id, projectId);
    const original = (await requestLease(firstEndpoint)).lease;

    const crossVersion = await requestLease(secondEndpoint, original.baseUrl);
    expect(crossVersion.status).toBe(201);
    expect(crossVersion.lease.baseUrl).not.toBe(original.baseUrl);

    const foreignHost = new URL(original.baseUrl);
    foreignHost.hostname = foreignHost.hostname.replace(/\.localhost$/u, ".example.test");
    for (const reuse of ["not a url", "", foreignHost.toString(), new URL("/", server.baseUrl).toString()]) {
      // eslint-disable-next-line no-await-in-loop -- each hostile value is checked on its own
      const fresh = await requestLease(firstEndpoint, reuse);
      expect(fresh.status).toBe(201);
      expect(fresh.lease.baseUrl).not.toBe(original.baseUrl);
    }

    const contentSession = new URL(original.baseUrl);
    contentSession.hostname = contentSession.hostname.replace(/^review-/u, "");
    expect((await requestLease(firstEndpoint, contentSession.toString())).status).toBe(201);

    clock.advance(twelveHours);
    const expired = await requestLease(firstEndpoint, original.baseUrl);
    expect(expired.status).toBe(201);
    expect(expired.lease.baseUrl).not.toBe(original.baseUrl);
  });

  test("foundation: lease-origin responses are fresh only until the lease expires and errors are never stored", async () => {
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><link rel=\"stylesheet\" href=\"site.css\"><title>Fresh</title>",
      idempotencyKey: "reuse-freshness-v1",
      name: "Reuse freshness",
    });
    const endpoint = leaseEndpoint(published.body.artifact.id, published.body.version.id, published.body.artifact.projectId);
    const {lease} = await requestLease(endpoint);
    const expiresAt = Date.parse(lease.expiresAt);

    const full = await fetchVersion(server, lease.baseUrl);
    expect(full.status).toBe(200);
    expect(full.headers.get("cache-control")).toBe(`private, max-age=${twelveHours / 1_000}, immutable`);

    const ranged = await fetchVersion(server, lease.baseUrl, "GET", {Range: "bytes=0-3"});
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("cache-control")).toMatch(/^private, max-age=\d+, immutable$/u);
    const head = await fetchVersion(server, lease.baseUrl, "HEAD");
    expect(head.headers.get("cache-control")).toMatch(/^private, max-age=\d+, immutable$/u);

    const unsatisfiable = await fetchVersion(server, lease.baseUrl, "GET", {Range: "bytes=999999-"});
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("cache-control")).toBe("private, no-store");
    const missing = await fetchVersion(server, new URL("missing.css", lease.baseUrl).toString());
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("private, no-store");
    const write = await fetchVersion(server, lease.baseUrl, "POST");
    expect(write.status).toBe(405);
    expect(write.headers.get("cache-control")).toBe("private, no-store");

    clock.advance(expiresAt - clock.now().getTime() - 10 * 60 * 1_000);
    expect((await fetchVersion(server, lease.baseUrl)).headers.get("cache-control"))
      .toBe("private, max-age=600, immutable");
    clock.advance(10 * 60 * 1_000 - 500);
    expect((await fetchVersion(server, lease.baseUrl)).headers.get("cache-control")).toBe("private, no-store");
    clock.advance(500);
    const expired = await fetchVersion(server, lease.baseUrl);
    expect(expired.status).toBe(401);
    expect(expired.headers.get("cache-control")).toBe("private, no-store");
  });

  async function adminFetch(
    cookies: {readonly csrf: string; readonly header: string},
    pathname: string,
    method: string,
    body?: AdminBody,
  ): Promise<Response> {
    const init: RequestInit = {
      headers: {
        "Content-Type": "application/json",
        Cookie: cookies.header,
        Origin: server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": cookies.csrf,
      },
      method,
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(`${server.baseUrl}${pathname}`, init);
  }

  const issuedKeySchema = z.object({apiKey: z.object({id: z.string()}), token: z.string()});
  const leaseReaderCapabilities = ["artifact:read", "content-session:issue"];

  test("foundation: logout, member deactivation, and key revocation end lease access, and another principal's lease is never reused", async () => {
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Revocation</title>",
      idempotencyKey: "reuse-revocation-v1",
      name: "Reuse revocation",
    });
    const endpoint = leaseEndpoint(published.body.artifact.id, published.body.version.id, published.body.artifact.projectId);
    const endpointPath = `${new URL(endpoint).pathname}${new URL(endpoint).search}`;
    const cookies = await signInAdministrator(server, installation);

    const adminLease = leaseSchema.parse(await (await adminFetch(cookies, endpointPath, "POST")).json());
    expect((await fetchVersion(server, adminLease.baseUrl)).status).toBe(200);

    const serviceKey = issuedKeySchema.parse(await (await adminFetch(cookies, "/api/v1/api-keys", "POST", {
      capabilities: leaseReaderCapabilities,
      expiresAt: "2099-01-01T00:00:00.000Z",
      name: "Lease reader",
    })).json());
    const foreign = await bearerLease(endpoint, serviceKey.token, adminLease.baseUrl);
    expect(foreign.status).toBe(201);
    expect(leaseSchema.parse(await foreign.json()).baseUrl).not.toBe(adminLease.baseUrl);

    expect((await adminFetch(cookies, "/api/v1/session/logout", "POST")).status).toBe(204);
    expect((await fetchVersion(server, adminLease.baseUrl)).status).toBe(401);

    const admin = await signInAdministrator(server, installation);
    const keyLease = leaseSchema.parse(await (await bearerLease(endpoint, serviceKey.token)).json());
    expect((await fetchVersion(server, keyLease.baseUrl)).status).toBe(200);
    expect((await adminFetch(admin, `/api/v1/api-keys/${serviceKey.apiKey.id}/revoke`, "POST")).status).toBe(200);
    expect((await fetchVersion(server, keyLease.baseUrl)).status).toBe(401);
    expect((await adminFetch(admin, `/api/v1/api-keys/${serviceKey.apiKey.id}/revoke`, "POST")).status).toBe(200);

    const member = z.object({member: z.object({id: z.string()})}).parse(await (await adminFetch(admin, "/api/v1/members", "POST", {
      displayName: "Lease Member",
      email: "lease-member@example.test",
    })).json()).member;
    const memberKey = issuedKeySchema.parse(await (await adminFetch(admin, "/api/v1/api-keys", "POST", {
      capabilities: leaseReaderCapabilities,
      expiresAt: "2099-01-01T00:00:00.000Z",
      memberId: member.id,
      name: "Member reader",
    })).json());
    const memberLease = leaseSchema.parse(await (await bearerLease(endpoint, memberKey.token)).json());
    expect((await fetchVersion(server, memberLease.baseUrl)).status).toBe(200);
    expect((await adminFetch(admin, `/api/v1/members/${member.id}/deactivate`, "POST")).status).toBe(200);
    expect((await fetchVersion(server, memberLease.baseUrl)).status).toBe(401);
    expect((await adminFetch(admin, `/api/v1/members/${member.id}/deactivate`, "POST")).status).toBe(200);
    expect((await bearerLease(endpoint, memberKey.token, memberLease.baseUrl)).status).toBe(401);
  });

  test("foundation: a logout whose lease revocation fails keeps the session so signing out can be retried", async () => {
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Logout retry</title>",
      idempotencyKey: "reuse-logout-retry-v1",
      name: "Logout retry",
    });
    const endpoint = leaseEndpoint(published.body.artifact.id, published.body.version.id, published.body.artifact.projectId);
    const cookies = await signInAdministrator(server, installation);
    const lease = leaseSchema.parse(await (await adminFetch(cookies, `${new URL(endpoint).pathname}${new URL(endpoint).search}`, "POST")).json());

    const database = new DatabaseSync(path.join(installation.dataDirectory, "artifact-server.db"));
    try {
      database.exec("ALTER TABLE content_sessions RENAME TO content_sessions_unavailable");
      expect((await adminFetch(cookies, "/api/v1/session/logout", "POST")).status).toBeGreaterThanOrEqual(500);
      expect((await adminFetch(cookies, "/api/v1/session", "GET")).status, "the session survives a failed sign-out").toBe(200);
      database.exec("ALTER TABLE content_sessions_unavailable RENAME TO content_sessions");
    } finally {
      database.close();
    }
    expect((await adminFetch(cookies, "/api/v1/session/logout", "POST")).status).toBe(204);
    expect((await fetchVersion(server, lease.baseUrl)).status).toBe(401);
  });

  test("foundation: rotating an API key ends the old key's leases", async () => {
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Rotation</title>",
      idempotencyKey: "reuse-rotation-v1",
      name: "Rotation",
    });
    const endpoint = leaseEndpoint(published.body.artifact.id, published.body.version.id, published.body.artifact.projectId);
    const admin = await signInAdministrator(server, installation);
    const key = issuedKeySchema.parse(await (await adminFetch(admin, "/api/v1/api-keys", "POST", {
      capabilities: leaseReaderCapabilities,
      expiresAt: "2099-01-01T00:00:00.000Z",
      name: "Rotated reader",
    })).json());
    const lease = leaseSchema.parse(await (await bearerLease(endpoint, key.token)).json());
    expect((await fetchVersion(server, lease.baseUrl)).status).toBe(200);
    expect((await adminFetch(admin, `/api/v1/api-keys/${key.apiKey.id}/rotate`, "POST")).status).toBe(201);
    expect((await fetchVersion(server, lease.baseUrl)).status).toBe(401);
  });

  test("foundation: a lease that lands just after a deactivation is swept once sign-in caches have expired", async () => {
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Late lease</title>",
      idempotencyKey: "reuse-late-lease-v1",
      name: "Late lease",
    });
    const admin = await signInAdministrator(server, installation);
    const member = z.object({member: z.object({id: z.string()})}).parse(await (await adminFetch(admin, "/api/v1/members", "POST", {
      displayName: "Late Member",
      email: "late-member@example.test",
    })).json()).member;
    expect((await adminFetch(admin, `/api/v1/members/${member.id}/deactivate`, "POST")).status).toBe(200);

    // A lease issued by a request that authenticated before the deactivation and committed after its revocation.
    const token = `review-${randomBytes(28).toString("hex")}`;
    const repository = new SqliteArtifactRepository(path.join(installation.dataDirectory, "artifact-server.db"), "local");
    try {
      await repository.createPreviewLease({
        artifactId: published.body.artifact.id,
        contentToken: new URL(published.body.links.version).hostname.split(".")[0] ?? "",
        createdAt: clock.now().toISOString(),
        expiresAt: new Date(clock.now().getTime() + twelveHours).toISOString(),
        principalId: member.id,
        projectId: published.body.artifact.projectId,
        tokenDigest: createHash("sha256").update(token).digest("hex"),
        versionId: published.body.version.id,
      });
    } finally {
      repository.close();
    }
    const lateLease = `http://${token}.localhost/`;
    expect((await fetchVersion(server, lateLease)).status).toBe(200);
    await expect.poll(async () => (await fetchVersion(server, lateLease)).status, {interval: 1_000, timeout: 45_000})
      .toBe(401);
  }, 60_000);
});
