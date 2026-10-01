import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {signInAdministrator} from "../support/agent-dispatch.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

const membersSchema = z.object({
  members: z.array(z.object({
    email: z.string(),
    id: z.string(),
    lastActiveAt: z.string().nullable(),
  }).loose()),
});
const apiKeysSchema = z.object({
  apiKeys: z.array(z.object({
    id: z.string(),
    lastUsedAt: z.string().nullable(),
  }).loose()),
});
const issuedKeySchema = z.object({
  apiKey: z.object({id: z.string()}).loose(),
  token: z.string(),
});

function mutationHeaders(server: RunningTestServer, cookies: ApplicationCookies): Headers {
  return new Headers({
    "Content-Type": "application/json",
    Cookie: cookies.header,
    Origin: server.baseUrl,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": cookies.csrf,
  });
}

async function issueKey(
  server: RunningTestServer,
  cookies: ApplicationCookies,
  body: {readonly memberId?: string; readonly name: string},
): Promise<z.infer<typeof issuedKeySchema>> {
  const response = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
    body: JSON.stringify({
      capabilities: ["artifact:read"],
      expiresAt: "2099-01-01T00:00:00.000Z",
      ...body,
    }),
    headers: mutationHeaders(server, cookies),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return issuedKeySchema.parse(await response.json());
}

async function admit(
  server: RunningTestServer,
  cookies: ApplicationCookies,
  email: string,
): Promise<string> {
  const response = await fetch(`${server.baseUrl}/api/v1/members`, {
    body: JSON.stringify({displayName: "Ada Lovelace", email, role: "member"}),
    headers: mutationHeaders(server, cookies),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return z.object({member: z.object({id: z.string()})}).parse(await response.json()).member.id;
}

async function lastActive(
  server: RunningTestServer,
  cookies: ApplicationCookies,
  memberId: string,
): Promise<string | null | undefined> {
  const response = await fetch(`${server.baseUrl}/api/v1/members`, {
    headers: {Cookie: cookies.header},
  });
  expect(response.status).toBe(200);
  return membersSchema.parse(await response.json()).members
    .find((member) => member.id === memberId)?.lastActiveAt;
}

async function lastUsed(
  server: RunningTestServer,
  cookies: ApplicationCookies,
  keyId: string,
): Promise<string | null | undefined> {
  const response = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
    headers: {Cookie: cookies.header},
  });
  expect(response.status).toBe(200);
  return apiKeysSchema.parse(await response.json()).apiKeys
    .find((key) => key.id === keyId)?.lastUsedAt;
}

async function sessionPrincipalId(
  server: RunningTestServer,
  cookies: ApplicationCookies,
): Promise<string> {
  const response = await fetch(`${server.baseUrl}/api/v1/session`, {
    headers: {Cookie: cookies.header},
  });
  expect(response.status).toBe(200);
  return z.object({principal: z.object({id: z.string()})})
    .parse(await response.json()).principal.id;
}

function bearerStatus(server: RunningTestServer, token: string): Promise<number> {
  return fetch(`${server.baseUrl}/api/v1/artifacts`, {
    headers: {Authorization: `Bearer ${token}`},
  }).then((response) => response.status);
}

describe("ACT-007 principal activity tracking", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let now: Date;
  const clock = {now: () => now};

  beforeEach(async () => {
    now = new Date("2026-10-01T12:00:00.000Z");
    installation = await createTestInstallation();
    server = await startTestServer(installation, {clock});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("ACT-007-B: session and key use advance last active and last used at most once per five minutes per principal, across processes", async () => {
    const cookies = await signInAdministrator(server, installation);
    const administratorId = await sessionPrincipalId(server, cookies);
    await expect.poll(() => lastActive(server, cookies, administratorId))
      .toBe("2026-10-01T12:00:00.000Z");

    const service = await issueKey(server, cookies, {name: "Release bot"});
    const memberId = await admit(server, cookies, "ada@example.test");
    const memberKey = await issueKey(server, cookies, {memberId, name: "Ada's key"});
    expect(await bearerStatus(server, service.token)).toBe(200);
    expect(await bearerStatus(server, memberKey.token)).toBe(200);
    await expect.poll(() => lastUsed(server, cookies, service.apiKey.id))
      .toBe("2026-10-01T12:00:00.000Z");
    await expect.poll(() => lastUsed(server, cookies, memberKey.apiKey.id))
      .toBe("2026-10-01T12:00:00.000Z");
    await expect.poll(() => lastActive(server, cookies, memberId))
      .toBe("2026-10-01T12:00:00.000Z");

    // Inside five minutes, a second process with its own empty throttle
    // still leaves the stored instants alone: the database write is conditional.
    now = new Date("2026-10-01T12:04:00.000Z");
    const second = await startTestServer(installation, {clock});
    try {
      expect(await bearerStatus(second, service.token)).toBe(200);
      expect(await sessionPrincipalId(second, cookies)).toBe(administratorId);
      expect(await lastUsed(second, cookies, service.apiKey.id))
        .toBe("2026-10-01T12:00:00.000Z");
      expect(await lastActive(second, cookies, administratorId))
        .toBe("2026-10-01T12:00:00.000Z");
    } finally {
      await second.stop();
    }

    now = new Date("2026-10-01T12:05:01.000Z");
    expect(await bearerStatus(server, service.token)).toBe(200);
    await expect.poll(() => lastUsed(server, cookies, service.apiKey.id))
      .toBe("2026-10-01T12:05:01.000Z");
    await expect.poll(() => lastActive(server, cookies, administratorId))
      .toBe("2026-10-01T12:05:01.000Z");
  });

  test("ACT-007-F: a refused tracking write never fails the request, unknown or rejected credentials record nothing, and the refused write is retried", async () => {
    const cookies = await signInAdministrator(server, installation);
    const database = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
    );
    try {
      database.exec(`
        CREATE TRIGGER refuse_member_activity
        BEFORE UPDATE OF last_active_at ON installation_members
        BEGIN SELECT RAISE(ABORT, 'member activity refused'); END;
      `);

      const administratorId = await sessionPrincipalId(server, cookies);
      expect(await bearerStatus(server, installation.apiToken)).toBe(200);
      expect(await bearerStatus(server, "as_key_key_00000000-0000-0000-0000-000000000000_abcdefghijklmnopqrstuvwxyz012345"))
        .toBe(401);
      const service = await issueKey(server, cookies, {name: "Release bot"});
      const revoked = await fetch(
        `${server.baseUrl}/api/v1/api-keys/${encodeURIComponent(service.apiKey.id)}/revoke`,
        {headers: mutationHeaders(server, cookies), method: "POST"},
      );
      expect(revoked.status).toBe(200);
      expect(await bearerStatus(server, service.token)).toBe(401);

      expect(await lastActive(server, cookies, administratorId)).toBeNull();
      expect(await lastUsed(server, cookies, service.apiKey.id)).toBeNull();

      database.exec("DROP TRIGGER refuse_member_activity");
      expect(await sessionPrincipalId(server, cookies)).toBe(administratorId);
      await expect.poll(() => lastActive(server, cookies, administratorId))
        .toBe("2026-10-01T12:00:00.000Z");
    } finally {
      database.close();
    }
  });
});
