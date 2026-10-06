// tests/application/invitations-model.test.ts
import {describe, expect, test} from "vitest";

import {
  InvalidInvite,
  InviteRejected,
  InvitesUnavailable,
} from "../../src/core/errors.js";
import {
  inviteActivitySubject,
  inviteDestinationPath,
  inviteIdFromToken,
  inviteKinds,
  inviteStatus,
  inviteStatuses,
  inviteTokenFor,
  inviteTokenPrefix,
  inviteWelcomePath,
  maskInviteEmail,
  redemptionRefusal,
  type StoredInvite,
} from "../../src/core/invitations.js";
import {artifactServerFailureResponse} from "../../src/http/artifact-http-failure.js";
import {toActivityEntry} from "../../src/application/activity-entries.js";

const inviteId = "inv_0f8fad5b-d9cb-469f-a165-70867728950e";
const secret = "aGVsbG8td29ybGQtaGVsbG8td29ybGQtaGVsbG8td28";

function storedInvite(overrides: Partial<StoredInvite> = {}): StoredInvite {
  return {
    createdAt: "2026-10-06T10:00:00.000Z",
    createdByPrincipalId: "member_admin",
    email: "dana@acme.test",
    expiresAt: "2026-10-13T10:00:00.000Z",
    id: inviteId,
    installationId: "installation",
    kind: inviteKinds.person,
    maxUses: 1,
    opens: null,
    revokedAt: null,
    revokedByPrincipalId: null,
    role: "member",
    secretDigest: "digest",
    tokenPrefix: inviteTokenPrefix(inviteId),
    useCount: 0,
    ...overrides,
  };
}

describe("invite model", () => {
  test("status prefers revoked, then used, then expired", () => {
    const now = new Date("2026-10-07T00:00:00.000Z");
    expect(inviteStatus(storedInvite(), now)).toBe(inviteStatuses.active);
    expect(inviteStatus(storedInvite({useCount: 1}), now)).toBe(inviteStatuses.used);
    expect(inviteStatus(storedInvite({expiresAt: "2026-10-06T23:59:59.999Z"}), now))
      .toBe(inviteStatuses.expired);
    expect(inviteStatus(storedInvite({expiresAt: now.toISOString()}), now))
      .toBe(inviteStatuses.expired);
    expect(inviteStatus(storedInvite({
      expiresAt: "2026-10-01T00:00:00.000Z",
      revokedAt: "2026-10-06T12:00:00.000Z",
      revokedByPrincipalId: "member_admin",
      useCount: 1,
    }), now)).toBe(inviteStatuses.revoked);
  });

  test("tokens round-trip their invite id and refuse other shapes", () => {
    const token = inviteTokenFor(inviteId, secret);
    expect(token).toBe(`as_inv_${inviteId}_${secret}`);
    expect(inviteIdFromToken(token)).toBe(inviteId);
    expect(inviteIdFromToken(`as_key_${inviteId}_${secret}`)).toBeNull();
    expect(inviteIdFromToken(`as_inv_${inviteId}_short`)).toBeNull();
    expect(inviteIdFromToken(`as_inv_inv_NOT-A-UUID_${secret}`)).toBeNull();
    expect(inviteIdFromToken(`${token}\n`)).toBeNull();
  });

  test("masking keeps the first character and the domain only", () => {
    expect(maskInviteEmail("dana.okonkwo@acme.test")).toBe("d••••••@acme.test");
    expect(maskInviteEmail("d@acme.test")).toBe("d••••••@acme.test");
    expect(maskInviteEmail("not-an-email")).toBe("••••••");
  });

  test("redemption refusals name why nothing was admitted", () => {
    const at = "2026-10-07T00:00:00.000Z";
    expect(redemptionRefusal(null, "dana@acme.test", at)).toBe("invalid");
    expect(redemptionRefusal(storedInvite(), "dana@acme.test", at)).toBeNull();
    expect(redemptionRefusal(storedInvite(), "sam@acme.test", at)).toBe("wrong_account");
    expect(redemptionRefusal(storedInvite({useCount: 1}), "dana@acme.test", at)).toBe("used");
    expect(redemptionRefusal(
      storedInvite({kind: inviteKinds.link, email: null, maxUses: 3}),
      "anyone@else.test",
      at,
    )).toBeNull();
  });

  test("destinations become review paths and the welcome path wraps them", () => {
    expect(inviteDestinationPath(null)).toBe("/review/projects");
    const destination = {artifactId: "art_1", projectId: "prj_default", versionId: "ver_2"};
    expect(inviteDestinationPath(destination))
      .toBe("/review?artifact=art_1&project=prj_default&version=ver_2&view=focus");
    expect(inviteWelcomePath(destination))
      .toBe(`/review/join?next=${encodeURIComponent(inviteDestinationPath(destination))}`);
  });

  test("activity subjects describe the invite without the token", () => {
    expect(inviteActivitySubject(storedInvite())).toBe("invite for dana@acme.test");
    expect(inviteActivitySubject(storedInvite({email: null, kind: inviteKinds.link, maxUses: 10})))
      .toBe("invite link (10 uses)");
  });

  test("invite errors map to stable HTTP failures", () => {
    expect(artifactServerFailureResponse(new InviteRejected({message: "No.", outcome: "expired"})))
      .toEqual({code: "INVITE_REJECTED", message: "No.", status: 403});
    expect(artifactServerFailureResponse(new InvitesUnavailable({message: "Off."})))
      .toEqual({code: "INVITES_UNAVAILABLE", message: "Off.", status: 409});
    expect(artifactServerFailureResponse(new InvalidInvite({message: "Bad."})))
      .toEqual({code: "INVALID_INPUT", message: "Bad.", status: 422});
  });

  test("invite activity appears in the admin feed with a described subject", () => {
    const entry = toActivityEntry({
      action: {
        accessFrom: null,
        accessTo: null,
        action: "invite_create",
        actor: {displayName: "Jordan Lee", kind: "human"},
        artifactId: null,
        createdAt: "2026-10-06T10:00:00.000Z",
        detail: {inviteId, subjectName: "invite link (10 uses)"},
        id: "act_1",
        principalId: "member_admin",
        projectId: null,
        replyId: null,
        subjectId: inviteId,
        threadId: null,
        versionId: null,
      },
      artifact: null,
      dispatch: null,
      excerpt: null,
      project: null,
      thread: null,
      versionNumber: null,
    }, {keys: new Map(), members: new Map()});
    expect(entry).toMatchObject({
      kind: "admin",
      subject: {id: inviteId, name: "invite link (10 uses)"},
      verb: "created",
    });
  });
});
