// tests/support/invitation-repository-cases.ts
import assert from "node:assert/strict";

import {systemAttribution} from "../../src/core/action-attribution.js";
import {type IdentityRepository, memberAdmissions} from "../../src/core/identity-ports.js";
import type {InvitationRepository, RedeemInviteRecord} from "../../src/core/invitation-ports.js";
import {inviteKinds, inviteTokenPrefix, type StoredInvite} from "../../src/core/invitations.js";

export type InvitationStore = InvitationRepository & Pick<
  IdentityRepository,
  "admitMember" | "deactivateMember" | "findActiveMemberByExternalIdentity" | "findMember" | "listMembers"
>;

export interface InvitationFixture {
  readonly actions: () => Promise<readonly {readonly action: string; readonly subjectId: string | null}[]>;
  readonly installationId: string;
  /** A second repository over the same store, for the race case. */
  readonly openSecond: () => Promise<{readonly close: () => Promise<void> | void; readonly store: InvitationStore}>;
  readonly store: InvitationStore;
}

export const caseAdministrator = {
  actor: {displayName: "Jordan Lee", kind: "human"},
  authorizedByPrincipalId: null,
  principalId: "member_admin",
} as const;

export function caseInvite(installationId: string, overrides: Partial<StoredInvite> = {}): StoredInvite {
  const id = overrides.id ?? "inv_00000000-0000-4000-8000-000000000001";
  return {
    createdAt: "2026-10-06T10:00:00.000Z",
    createdByPrincipalId: "member_admin",
    email: null,
    expiresAt: "2026-10-13T10:00:00.000Z",
    id,
    installationId,
    kind: inviteKinds.link,
    maxUses: 1,
    opens: null,
    revokedAt: null,
    revokedByPrincipalId: null,
    role: "member",
    secretDigest: "digest",
    tokenPrefix: inviteTokenPrefix(id),
    useCount: 0,
    ...overrides,
  };
}

export function caseRedemption(
  installationId: string,
  memberId: string,
  email: string,
  inviteId: string,
): RedeemInviteRecord {
  return {
    admission: {
      admittedHow: memberAdmissions.invite,
      attribution: caseAdministrator,
      createdAt: "2026-10-07T09:00:00.000Z",
      displayName: email,
      email,
      id: memberId,
      installationId,
      role: "member",
    },
    binding: {
      boundAt: "2026-10-07T09:00:00.000Z",
      email,
      memberId,
      provider: "workos",
      subject: `subject-${memberId}`,
    },
    email,
    inviteId,
    redeemedAt: "2026-10-07T09:00:00.000Z",
  };
}

/** Admit the administrator every case attributes to. */
export async function seedAdministrator(fixture: InvitationFixture): Promise<void> {
  await fixture.store.admitMember({
    admittedHow: memberAdmissions.owner,
    attribution: systemAttribution,
    createdAt: "2026-10-06T09:00:00.000Z",
    displayName: "Jordan Lee",
    email: "jordan@acme.test",
    id: "member_admin",
    installationId: fixture.installationId,
    role: "administrator",
  });
}

const inviteRows = async (fixture: InvitationFixture) =>
  (await fixture.actions()).filter((row) => row.action.startsWith("invite_"));

export const invitationRepositoryCases: readonly {
  readonly name: string;
  readonly run: (fixture: InvitationFixture) => Promise<void>;
}[] = [
  {
    name: "creates, lists newest first with the creator's name, finds and revokes with activity",
    run: async (fixture) => {
      const {installationId, store} = fixture;
      const first = "inv_00000000-0000-4000-8000-000000000001";
      const second = "inv_00000000-0000-4000-8000-000000000002";
      await store.createInvite({attribution: caseAdministrator, invite: caseInvite(installationId, {id: first})});
      await store.createInvite({
        attribution: caseAdministrator,
        invite: caseInvite(installationId, {
          createdAt: "2026-10-06T11:00:00.000Z",
          email: "dana@acme.test",
          id: second,
          kind: inviteKinds.person,
          opens: {artifactId: "art_1", projectId: "prj_default", versionId: "ver_1"},
          role: "administrator",
        }),
      });
      const listed = await store.listInvites(installationId);
      assert.deepEqual(listed.map((row) => [row.id, row.createdByName, row.opens?.versionId ?? null]), [
        [second, "Jordan Lee", "ver_1"],
        [first, "Jordan Lee", null],
      ]);
      const found = await store.findInvite(installationId, first);
      assert.equal(found?.secretDigest, "digest");
      assert.equal(found?.useCount, 0);

      const revoked = await store.revokeInvite({
        attribution: caseAdministrator,
        installationId,
        inviteId: first,
        revokedAt: "2026-10-06T12:00:00.000Z",
      });
      assert.equal(revoked.revokedByPrincipalId, "member_admin");
      await assert.rejects(store.revokeInvite({
        attribution: caseAdministrator,
        installationId,
        inviteId: first,
        revokedAt: "2026-10-06T12:01:00.000Z",
      }), {_tag: "IdentityConflict"});
      await assert.rejects(store.revokeInvite({
        attribution: caseAdministrator,
        installationId,
        inviteId: "inv_00000000-0000-4000-8000-000000000099",
        revokedAt: "2026-10-06T12:01:00.000Z",
      }), {_tag: "IdentityNotFound"});
      assert.deepEqual(await inviteRows(fixture), [
        {action: "invite_create", subjectId: first},
        {action: "invite_create", subjectId: second},
        {action: "invite_revoke", subjectId: first},
      ]);
    },
  },
  {
    name: "redemption admits with method invite, binds the identity and writes both rows",
    run: async (fixture) => {
      const {installationId, store} = fixture;
      const id = "inv_00000000-0000-4000-8000-000000000003";
      await store.createInvite({attribution: caseAdministrator, invite: caseInvite(installationId, {id, maxUses: 2})});
      const result = await store.redeemInvite(caseRedemption(installationId, "member_dana", "dana@acme.test", id));
      assert.equal(result.kind, "admitted");
      assert.equal(result.kind === "admitted" ? result.member.email : null, "dana@acme.test");
      const bound = await store.findActiveMemberByExternalIdentity(installationId, "workos", "subject-member_dana");
      assert.equal(bound?.id, "member_dana");
      const member = (await store.listMembers(installationId)).find((row) => row.id === "member_dana");
      assert.equal(member?.admittedHow, "invite");
      assert.equal(member?.admittedByName, "Jordan Lee");
      assert.equal((await store.findInvite(installationId, id))?.useCount, 1);
      const rows = (await fixture.actions()).filter((row) =>
        row.subjectId === "member_dana" || row.action === "invite_redeem");
      assert.deepEqual(rows.map((row) => row.action).toSorted(), ["invite_redeem", "member_admit"]);
    },
  },
  {
    name: "a spent invite, a wrong email and a deactivated member's email write nothing",
    run: async (fixture) => {
      const {installationId, store} = fixture;
      const link = "inv_00000000-0000-4000-8000-000000000004";
      const person = "inv_00000000-0000-4000-8000-000000000005";
      await store.createInvite({attribution: caseAdministrator, invite: caseInvite(installationId, {id: link})});
      await store.createInvite({
        attribution: caseAdministrator,
        invite: caseInvite(installationId, {email: "dana@acme.test", id: person, kind: inviteKinds.person}),
      });
      assert.equal((await store.redeemInvite(caseRedemption(installationId, "member_a", "a@acme.test", link))).kind, "admitted");
      assert.deepEqual(
        await store.redeemInvite(caseRedemption(installationId, "member_b", "b@acme.test", link)),
        {kind: "refused", outcome: "used"},
      );
      assert.deepEqual(
        await store.redeemInvite(caseRedemption(installationId, "member_c", "sam@acme.test", person)),
        {kind: "refused", outcome: "wrong_account"},
      );
      await store.deactivateMember(installationId, "member_a", "2026-10-07T10:00:00.000Z", caseAdministrator);
      const another = "inv_00000000-0000-4000-8000-000000000006";
      await store.createInvite({attribution: caseAdministrator, invite: caseInvite(installationId, {id: another, maxUses: 5})});
      assert.deepEqual(
        await store.redeemInvite(caseRedemption(installationId, "member_d", "a@acme.test", another)),
        {kind: "refused", outcome: "account_unavailable"},
      );
      assert.equal((await store.findInvite(installationId, another))?.useCount, 0);
      assert.equal(await store.findMember(installationId, "member_d"), null);
    },
  },
  {
    name: "two repositories racing for a last use admit exactly one person",
    run: async (fixture) => {
      const {installationId, store} = fixture;
      const id = "inv_00000000-0000-4000-8000-000000000007";
      await store.createInvite({attribution: caseAdministrator, invite: caseInvite(installationId, {id})});
      const second = await fixture.openSecond();
      try {
        const results = await Promise.all([
          store.redeemInvite(caseRedemption(installationId, "member_x", "x@acme.test", id)),
          second.store.redeemInvite(caseRedemption(installationId, "member_y", "y@acme.test", id)),
        ]);
        assert.equal(results.filter((result) => result.kind === "admitted").length, 1);
        assert.deepEqual(results.filter((result) => result.kind === "refused"), [{kind: "refused", outcome: "used"}]);
      } finally {
        await second.close();
      }
    },
  },
];
