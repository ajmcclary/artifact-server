import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {signInAdministrator} from "../support/agent-dispatch.js";
import {publishNew} from "../support/publishing.js";
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

const nameSchema = z.object({name: z.string()}).strict().nullable();
const memberSchema = z.object({
  admittedAt: z.iso.datetime(),
  admittedBy: nameSchema,
  admittedHow: z.enum(["manual", "automatic", "owner"]).nullable(),
  createdAt: z.iso.datetime(),
  email: z.string(),
  id: z.string(),
  lastActiveAt: z.iso.datetime().nullable(),
}).loose();
const apiKeySchema = z.object({
  expiresAt: z.iso.datetime(),
  id: z.string(),
  lastUsedAt: z.iso.datetime().nullable(),
  ownerName: z.string().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  revokedBy: nameSchema,
  status: z.enum(["active", "revoked", "expired"]),
}).loose();
const publicLinkSchema = z.object({
  artifact: z.object({id: z.string()}).loose(),
  madePublicAt: z.iso.datetime().nullable(),
  madePublicBy: nameSchema,
}).loose();

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

async function readJson<T>(
  server: RunningTestServer,
  cookies: ApplicationCookies,
  pathname: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(`${server.baseUrl}${pathname}`, {headers: {Cookie: cookies.header}});
  expect(response.status).toBe(200);
  return schema.parse(await response.json());
}

describe("administration facts", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let now: Date;

  beforeEach(async () => {
    now = new Date("2026-10-01T12:00:00.000Z");
    installation = await createTestInstallation();
    server = await startTestServer(installation, {clock: {now: () => now}});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("ADM-003-B: the member list reports admission time, admitter, admission path and last activity", async () => {
    const cookies = await signInAdministrator(server, installation);
    const admitted = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({displayName: "Ada Lovelace", email: "ada@example.test", role: "member"}),
      headers: mutationHeaders(server, cookies),
      method: "POST",
    });
    expect(admitted.status).toBe(201);

    const members = await readJson(server, cookies, "/api/v1/members",
      z.object({members: z.array(memberSchema)}));
    const owner = members.members.find((member) => member.email === "administrator@example.test");
    const ada = members.members.find((member) => member.email === "ada@example.test");
    expect(owner).toMatchObject({admittedBy: null, admittedHow: "owner"});
    expect(ada).toMatchObject({
      admittedAt: "2026-10-01T12:00:00.000Z",
      admittedBy: {name: "Local administrator"},
      admittedHow: "manual",
      lastActiveAt: null,
    });
    expect(ada?.admittedAt).toBe(ada?.createdAt);
  });

  test("ADM-004-B: the key list reports owner, last use, derived status and who revoked it", async () => {
    const cookies = await signInAdministrator(server, installation);
    const issue = async (name: string, expiresAt: string) => {
      const response = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
        body: JSON.stringify({capabilities: ["artifact:read"], expiresAt, name}),
        headers: mutationHeaders(server, cookies),
        method: "POST",
      });
      expect(response.status).toBe(201);
      return z.object({apiKey: z.object({id: z.string()}).loose(), token: z.string()})
        .parse(await response.json());
    };
    const active = await issue("Release bot", "2099-01-01T00:00:00.000Z");
    const shortLived = await issue("Nightly import", "2026-10-01T13:00:00.000Z");
    const revoked = await issue("Retired bot", "2099-01-01T00:00:00.000Z");
    const revokeResponse = await fetch(
      `${server.baseUrl}/api/v1/api-keys/${encodeURIComponent(revoked.apiKey.id)}/revoke`,
      {headers: mutationHeaders(server, cookies), method: "POST"},
    );
    expect(revokeResponse.status).toBe(200);

    now = new Date("2026-10-01T14:00:00.000Z");
    const keys = (await readJson(server, cookies, "/api/v1/api-keys",
      z.object({apiKeys: z.array(apiKeySchema)}))).apiKeys;
    const byId = new Map(keys.map((key) => [key.id, key]));
    expect(byId.get(active.apiKey.id)).toMatchObject({
      ownerName: null, revokedBy: null, status: "active",
    });
    expect(byId.get(shortLived.apiKey.id)).toMatchObject({status: "expired"});
    expect(byId.get(revoked.apiKey.id)).toMatchObject({
      revokedAt: "2026-10-01T12:00:00.000Z",
      revokedBy: {name: "Local administrator"},
      status: "revoked",
    });
  });

  test("ADM-005-B: the public-link inventory reports when and by whom each link was made public", async () => {
    const cookies = await signInAdministrator(server, installation);
    const published = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: "made public at publish",
      idempotencyKey: "adm-005-made-public",
      name: "Made public at publish",
    });

    const page = await readJson(server, cookies, "/api/v1/administration/public-links",
      z.object({publicLinks: z.array(publicLinkSchema)}));
    expect(page.publicLinks).toEqual([
      expect.objectContaining({
        artifact: expect.objectContaining({id: published.body.artifact.id}),
        madePublicAt: "2026-10-01T12:00:00.000Z",
        madePublicBy: {name: "Local"},
      }),
    ]);
  });
});
