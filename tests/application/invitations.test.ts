// tests/application/invitations.test.ts
import type {Effect} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {InvitationService} from "../../src/application/invitations.js";
import type {Principal} from "../../src/core/identity.js";
import {inviteIdFromToken} from "../../src/core/invitations.js";
import {startInvitationRuntime} from "../support/invitation-runtime.js";

describe("invitation service", () => {
  let context: Awaited<ReturnType<typeof startInvitationRuntime>>;
  let administrator: Principal;

  beforeEach(async () => {
    context = await startInvitationRuntime();
    administrator = await context.signIn({displayName: "Jordan Lee", email: "jordan@acme.test", subject: "admin"});
  });

  afterEach(async () => {
    await context.stop();
  });

  const invitations = <A, E>(use: (service: InvitationService["Service"]) => Effect.Effect<A, E>) =>
    context.runtime.runPromise(InvitationService.use(use));

  test("normalizes a padded mixed-case email and redeems it at sign-in", async () => {
    const issued = await invitations((service) => service.create({
      email: "  Dana@ACME.test ",
      expiresIn: "7d",
      kind: "person",
      principal: administrator,
      role: "member",
    }));
    expect(issued.invite.email).toBe("dana@acme.test");
    const member = await context.signIn(
      {displayName: "Dana", email: "DANA@acme.test", subject: "dana"},
      inviteIdFromToken(issued.token),
    );
    expect(member.membershipRole).toBe("member");
  });

  test("an expired invite cannot be revoked and stays listed as expired", async () => {
    const issued = await invitations((service) => service.create({
      expiresIn: "24h",
      kind: "link",
      maxUses: 3,
      principal: administrator,
    }));
    context.clock.advance(25 * 60 * 60 * 1_000);
    await expect(invitations((service) => service.revoke(administrator, issued.invite.id)))
      .rejects.toMatchObject({_tag: "IdentityConflict"});
    const listed = await invitations((service) => service.list(administrator));
    expect(listed.find((row) => row.id === issued.invite.id)?.status).toBe("expired");
  });

  test("preview of a tampered token is invalid and consumes nothing", async () => {
    const issued = await invitations((service) => service.create({
      expiresIn: "7d",
      kind: "link",
      maxUses: 1,
      principal: administrator,
    }));
    const tampered = `${issued.token.slice(0, -1)}${issued.token.endsWith("A") ? "B" : "A"}`;
    await expect(invitations((service) => service.preview(tampered))).resolves.toEqual({status: "invalid"});
    await expect(invitations((service) => service.preview(issued.token)))
      .resolves.toMatchObject({status: "active", usesLeft: 1});
  });

  test("an unknown destination is refused at creation", async () => {
    await expect(invitations((service) => service.create({
      expiresIn: "7d",
      kind: "link",
      maxUses: 2,
      opens: {artifactId: "art_missing", projectId: "prj_default", versionId: "ver_missing"},
      principal: administrator,
    }))).rejects.toMatchObject({_tag: "VersionNotFound"});
  });
});
