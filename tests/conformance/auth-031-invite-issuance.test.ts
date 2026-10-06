// tests/conformance/auth-031-invite-issuance.test.ts
import {DatabaseSync} from "node:sqlite";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  bootstrapAdministrator,
  browserMutationHeaders,
  createInvite,
  type InviteRequestBody,
  type InviteServer,
  redeem,
  signInAs,
  startInviteServer,
} from "../support/invites.js";
import {createTestInstallation, removeTestInstallation, startTestServer} from "../support/runtime-harness.js";

describe("invite issuance", () => {
  let context: InviteServer;

  beforeEach(async () => {
    context = await startInviteServer();
  });

  afterEach(async () => {
    await context.stop();
  });

  test("AUTH-031-B: an administrator creates, lists and revokes invites and sees each token once", async () => {
    const administrator = await signInAs(context, bootstrapAdministrator);
    const person = await createInvite(context, administrator, {
      email: "dana@acme.test",
      expiresIn: "7d",
      kind: "person",
      role: "administrator",
    });
    const link = await createInvite(context, administrator, {expiresIn: "24h", kind: "link", maxUses: 10});
    expect(person.url).toBe(`${context.server.baseUrl}/join#${person.token}`);
    expect(person.token).toMatch(/^as_inv_inv_[0-9a-f-]{36}_[A-Za-z0-9_-]{32,}$/u);

    const listed = await fetch(`${context.server.baseUrl}/api/v1/invites`, {
      headers: {Cookie: administrator.header},
    });
    expect(listed.status).toBe(200);
    const body = await listed.text();
    expect(body).not.toContain(person.token);
    expect(body).not.toContain(link.token.slice(-20));
    const invites = z.object({invites: z.array(z.looseObject({
      createdByName: z.string().nullable(),
      id: z.string(),
      kind: z.string(),
      maxUses: z.number(),
      status: z.string(),
    }))}).parse(JSON.parse(body)).invites;
    expect(invites.map((invite) => [invite.id, invite.kind, invite.maxUses, invite.status, invite.createdByName]))
      .toEqual([
        [link.id, "link", 10, "active", "Jordan Lee"],
        [person.id, "person", 1, "active", "Jordan Lee"],
      ]);

    const revoked = await fetch(`${context.server.baseUrl}/api/v1/invites/${link.id}/revoke`, {
      headers: browserMutationHeaders(context.server.baseUrl, administrator),
      method: "POST",
    });
    expect(revoked.status).toBe(200);
    expect(z.object({invite: z.looseObject({status: z.string()})}).parse(await revoked.json()).invite.status)
      .toBe("revoked");

    const database = new DatabaseSync(path.join(context.installation.dataDirectory, "artifact-server.db"), {readOnly: true});
    try {
      const stored = JSON.stringify(database.prepare("SELECT * FROM installation_invites").all());
      expect(stored).not.toContain(person.token);
      expect(stored).not.toContain(link.token);
    } finally {
      database.close();
    }
  });

  test("AUTH-031-F: members, keys, bad rules, existing emails and local-owner mode are refused", async () => {
    const administrator = await signInAs(context, bootstrapAdministrator);
    const post = (cookies: typeof administrator | null, body: InviteRequestBody) =>
      fetch(`${context.server.baseUrl}/api/v1/invites`, {
        body: JSON.stringify(body),
        headers: browserMutationHeaders(context.server.baseUrl, cookies),
        method: "POST",
      });

    const memberInvite = await createInvite(context, administrator, {expiresIn: "7d", kind: "link", maxUses: 5});
    await redeem(context, memberInvite.token, {displayName: "Sam Rivera", email: "sam@acme.test", subject: "sam"});
    const member = await signInAs(context, {displayName: "Sam Rivera", email: "sam@acme.test", subject: "sam"});
    expect((await post(member, {expiresIn: "7d", kind: "link", maxUses: 2})).status).toBe(403);
    const list = await fetch(`${context.server.baseUrl}/api/v1/invites`, {headers: {Cookie: member.header}});
    expect(list.status).toBe(403);

    const keyed = await fetch(`${context.server.baseUrl}/api/v1/invites`, {
      body: JSON.stringify({expiresIn: "7d", kind: "link", maxUses: 2}),
      headers: {Authorization: `Bearer ${context.installation.apiToken}`, "Content-Type": "application/json"},
      method: "POST",
    });
    expect(keyed.status).toBe(403);

    expect((await post(administrator, {expiresIn: "7d", kind: "link", maxUses: 2, role: "administrator"})).status).toBe(422);
    expect((await post(administrator, {expiresIn: "7d", kind: "link", maxUses: 101})).status).toBe(422);
    expect((await post(administrator, {expiresIn: "7d", kind: "link", maxUses: 0})).status).toBe(422);
    expect((await post(administrator, {expiresIn: "90d", kind: "link", maxUses: 2})).status).toBe(422);
    expect((await post(administrator, {email: "SAM@acme.test", expiresIn: "7d", kind: "person"})).status).toBe(409);
    expect((await post(administrator, {email: "jordan@acme.test", expiresIn: "7d", kind: "person"})).status).toBe(409);

    const local = await createTestInstallation();
    const localServer = await startTestServer(local);
    try {
      const refused = await fetch(`${localServer.baseUrl}/api/v1/invites`, {
        headers: {Authorization: `Bearer ${local.apiToken}`},
      });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({error: {code: "INVITES_UNAVAILABLE"}});
    } finally {
      await localServer.stop();
      await removeTestInstallation(local);
    }

    const database = new DatabaseSync(path.join(context.installation.dataDirectory, "artifact-server.db"));
    try {
      expect(() => database.prepare(`INSERT INTO installation_invites (
        installation_id, id, kind, email, role, max_uses, use_count, secret_digest,
        token_prefix, expires_at, created_at, created_by_principal_id
      ) SELECT installation_id, 'inv_direct', 'link', NULL, 'administrator', 5, 0, 'd', 'p', 'x', 'x', 'm'
        FROM installation_members LIMIT 1`).run()).toThrow(/constraint failed/u);
    } finally {
      database.close();
    }
  });
});
