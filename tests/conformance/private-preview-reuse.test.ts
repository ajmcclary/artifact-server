import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {Clock} from "../../src/core/ports.js";
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
});
