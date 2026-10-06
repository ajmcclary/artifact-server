// tests/conformance/auth-030-invite-admission.test.ts
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  applicationCookies,
  bootstrapAdministrator,
  browserMutationHeaders,
  createInvite,
  type InviteServer,
  finishRedemption,
  redeem,
  signInAs,
  startRedemption,
  startInviteServer,
} from "../support/invites.js";
import {publishNew} from "../support/publishing.js";
import {apiHeaders} from "../support/runtime-harness.js";

const sessionSchema = z.object({principal: z.object({id: z.string(), membershipRole: z.string()})});

describe("invite admission", () => {
  let context: InviteServer;

  beforeEach(async () => {
    context = await startInviteServer();
  });

  afterEach(async () => {
    await context.stop();
  });

  const session = async (response: Response) => {
    const cookies = applicationCookies(response.headers.getSetCookie());
    const answered = await fetch(`${context.server.baseUrl}/api/v1/session`, {headers: {Cookie: cookies.header}});
    return sessionSchema.parse(await answered.json()).principal;
  };

  test("AUTH-030-B: one-person and link invites admit with their role, attribution and activity", async () => {
    const administrator = await signInAs(context, bootstrapAdministrator);
    const {body: published} = await publishNew(context.server, context.installation, {
      accessSetting: "account_required",
      content: "pricing",
      idempotencyKey: "invite-destination",
      name: "Q3 Pricing Review",
    });
    const version = published.version;
    const person = await createInvite(context, administrator, {
      email: "dana@acme.test",
      expiresIn: "7d",
      kind: "person",
      opens: {artifactId: version.artifactId, projectId: version.projectId, versionId: version.id},
      role: "administrator",
    });
    const joined = await redeem(context, person.token, {displayName: "Dana Okonkwo", email: "dana@acme.test", subject: "dana"});
    expect(joined.status).toBe(303);
    const location = new URL(joined.headers.get("location") ?? "", context.server.baseUrl);
    expect(location.pathname).toBe("/review/join");
    expect(location.searchParams.get("next"))
      .toBe(`/review?artifact=${version.artifactId}&project=${version.projectId}&version=${version.id}&view=focus`);
    expect((await session(joined)).membershipRole).toBe("administrator");

    const link = await createInvite(context, administrator, {expiresIn: "7d", kind: "link", maxUses: 2});
    const sam = await redeem(context, link.token, {displayName: "Sam Rivera", email: "sam@acme.test", subject: "sam"});
    expect((await session(sam)).membershipRole).toBe("member");
    expect(new URL(sam.headers.get("location") ?? "", context.server.baseUrl).searchParams.get("next"))
      .toBe("/review/projects");

    const members = await fetch(`${context.server.baseUrl}/api/v1/members`, {headers: {Cookie: administrator.header}});
    const rows = z.object({members: z.array(z.looseObject({
      admittedBy: z.object({name: z.string()}).nullable(),
      admittedHow: z.string().nullable(),
      email: z.string(),
    }))}).parse(await members.json()).members;
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({admittedBy: {name: "Jordan Lee"}, admittedHow: "invite", email: "dana@acme.test"}),
      expect.objectContaining({admittedBy: {name: "Jordan Lee"}, admittedHow: "invite", email: "sam@acme.test"}),
    ]));

    const database = new DatabaseSync(path.join(context.installation.dataDirectory, "artifact-server.db"), {readOnly: true});
    try {
      const actions = z.array(z.object({action: z.string()})).parse(database.prepare(
        "SELECT action FROM actions WHERE action IN ('invite_redeem', 'member_admit') ORDER BY created_at",
      ).all()).map((row) => row.action);
      expect(actions.filter((action) => action === "invite_redeem")).toHaveLength(2);
      expect(actions.filter((action) => action === "member_admit")).toHaveLength(3);
    } finally {
      database.close();
    }
  });

  test("AUTH-030-F: wrong, unverified, ended, tampered and contended redemptions admit no one", async () => {
    const administrator = await signInAs(context, bootstrapAdministrator);
    const outcome = (response: Response) =>
      new URL(response.headers.get("location") ?? "", context.server.baseUrl).searchParams.get("outcome");

    const person = await createInvite(context, administrator, {email: "dana@acme.test", expiresIn: "7d", kind: "person"});
    const wrong = await redeem(context, person.token, {displayName: "Sam", email: "sam@acme.test", subject: "sam-wrong"});
    expect(wrong.status).toBe(303);
    expect(outcome(wrong)).toBe("wrong_account");
    expect(wrong.headers.getSetCookie().some((value) => value.startsWith("artifact_session="))).toBe(false);

    const unverified = await redeem(context, person.token, {
      displayName: "Dana",
      email: "dana@acme.test",
      emailVerificationAsserted: false,
      subject: "dana-unverified",
    });
    expect(outcome(unverified)).toBe("unverified");

    // Preview never consumes, and the person invite still admits Dana afterwards.
    const preview = await fetch(`${context.server.baseUrl}/auth/invites/preview`, {
      body: JSON.stringify({token: person.token}),
      headers: browserMutationHeaders(context.server.baseUrl, null),
      method: "POST",
    });
    expect(z.looseObject({status: z.string(), usesLeft: z.number()}).parse(await preview.json()))
      .toMatchObject({status: "active", usesLeft: 1});
    expect((await redeem(context, person.token, {displayName: "Dana", email: "dana@acme.test", subject: "dana"})).status)
      .toBe(303);
    // A spent invite never starts a login: start answers with the preview instead.
    const again = await fetch(`${context.server.baseUrl}/auth/invites/start`, {
      body: JSON.stringify({token: person.token}),
      headers: browserMutationHeaders(context.server.baseUrl, null),
      method: "POST",
    });
    expect(z.looseObject({status: z.string()}).parse(await again.json()).status).toBe("used");

    // A deactivated member's email cannot rejoin through a link.
    const samLink = await createInvite(context, administrator, {expiresIn: "7d", kind: "link", maxUses: 2});
    const samJoined = await redeem(context, samLink.token, {displayName: "Sam", email: "sam@acme.test", subject: "sam"});
    const samId = (await session(samJoined)).id;
    await fetch(`${context.server.baseUrl}/api/v1/members/${samId}/deactivate`, {
      headers: browserMutationHeaders(context.server.baseUrl, administrator),
      method: "POST",
    });
    const rejoin = await redeem(context, samLink.token, {displayName: "Sam", email: "sam@acme.test", subject: "sam-new"});
    expect(outcome(rejoin)).toBe("account_unavailable");

    // An active member redeeming a link consumes nothing.
    const link = await createInvite(context, administrator, {expiresIn: "7d", kind: "link", maxUses: 1});
    const existing = await redeem(context, link.token, {displayName: "Dana", email: "dana@acme.test", subject: "dana"});
    expect(existing.status).toBe(303);
    const after = await fetch(`${context.server.baseUrl}/auth/invites/preview`, {
      body: JSON.stringify({token: link.token}),
      headers: browserMutationHeaders(context.server.baseUrl, null),
      method: "POST",
    });
    expect(z.looseObject({usesLeft: z.number()}).parse(await after.json()).usesLeft).toBe(1);

    // Contention for the last use admits exactly one person.
    const startedX = await startRedemption(context, link.token, {displayName: "X", email: "x@acme.test", subject: "x"});
    const startedY = await startRedemption(context, link.token, {displayName: "Y", email: "y@acme.test", subject: "y"});
    const results = await Promise.all([finishRedemption(startedX), finishRedemption(startedY)]);
    const admitted = results.filter((response) =>
      response.headers.getSetCookie().some((value) => value.startsWith("artifact_session=")));
    expect(admitted).toHaveLength(1);

    // A revoked invite and a tampered token admit no one.
    const revokedLink = await createInvite(context, administrator, {expiresIn: "7d", kind: "link", maxUses: 3});
    await fetch(`${context.server.baseUrl}/api/v1/invites/${revokedLink.id}/revoke`, {
      headers: browserMutationHeaders(context.server.baseUrl, administrator),
      method: "POST",
    });
    const revokedStart = await fetch(`${context.server.baseUrl}/auth/invites/start`, {
      body: JSON.stringify({token: revokedLink.token}),
      headers: browserMutationHeaders(context.server.baseUrl, null),
      method: "POST",
    });
    expect(z.looseObject({status: z.string()}).parse(await revokedStart.json()).status).toBe("revoked");
    const tampered = await fetch(`${context.server.baseUrl}/auth/invites/start`, {
      body: JSON.stringify({token: `${revokedLink.token.slice(0, -2)}zz`}),
      headers: browserMutationHeaders(context.server.baseUrl, null),
      method: "POST",
    });
    expect(z.looseObject({status: z.string()}).parse(await tampered.json()).status).toBe("invalid");
  });

  test("a deleted destination leaves the preview without one and joining lands on Projects", async () => {
    const administrator = await signInAs(context, bootstrapAdministrator);
    const {body: published} = await publishNew(context.server, context.installation, {
      accessSetting: "account_required",
      content: "temporary",
      idempotencyKey: "deleted-destination",
      name: "Temporary Review",
    });
    const version = published.version;
    const link = await createInvite(context, administrator, {
      expiresIn: "7d",
      kind: "link",
      maxUses: 2,
      opens: {artifactId: version.artifactId, projectId: version.projectId, versionId: version.id},
    });
    const deleted = await fetch(
      `${context.server.baseUrl}/api/v1/artifacts/${version.artifactId}?projectId=${version.projectId}`,
      {
        body: JSON.stringify({expectedCurrentVersionId: version.id}),
        headers: apiHeaders(context.installation, "delete-destination"),
        method: "DELETE",
      },
    );
    expect(deleted.ok).toBe(true);
    const preview = await fetch(`${context.server.baseUrl}/auth/invites/preview`, {
      body: JSON.stringify({token: link.token}),
      headers: browserMutationHeaders(context.server.baseUrl, null),
      method: "POST",
    });
    expect(await preview.json()).toMatchObject({opens: null, status: "active"});
    const joined = await redeem(context, link.token, {displayName: "Rae", email: "rae@acme.test", subject: "rae"});
    expect(new URL(joined.headers.get("location") ?? "", context.server.baseUrl).searchParams.get("next"))
      .toBe("/review/projects");
  });
});
