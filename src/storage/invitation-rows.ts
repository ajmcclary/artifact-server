import {z} from "zod";

import {type ActionAttribution} from "../core/action-attribution.js";
import {membershipRoles} from "../core/identity.js";
import type {InstallationMember} from "../core/installation-identity.js";
import {
  type Invite,
  inviteActivitySubject,
  inviteKinds,
  type ListedInvite,
  type StoredInvite,
} from "../core/invitations.js";
import {type ActionInsert, attributedInsert} from "./action-insert.js";

/** Quoted aliases read identically from SQLite, D1 and Postgres. */
export function inviteSelectColumns(alias: string): string {
  const c = (column: string) => `${alias}.${column}`;
  return [
    `${c("installation_id")} AS "installationId"`,
    `${c("id")} AS "id"`,
    `${c("kind")} AS "kind"`,
    `${c("email")} AS "email"`,
    `${c("role")} AS "role"`,
    `${c("max_uses")} AS "maxUses"`,
    `${c("use_count")} AS "useCount"`,
    `${c("secret_digest")} AS "secretDigest"`,
    `${c("token_prefix")} AS "tokenPrefix"`,
    `${c("opens_project_id")} AS "opensProjectId"`,
    `${c("opens_artifact_id")} AS "opensArtifactId"`,
    `${c("opens_version_id")} AS "opensVersionId"`,
    `${c("expires_at")} AS "expiresAt"`,
    `${c("created_at")} AS "createdAt"`,
    `${c("created_by_principal_id")} AS "createdByPrincipalId"`,
    `${c("revoked_at")} AS "revokedAt"`,
    `${c("revoked_by_principal_id")} AS "revokedByPrincipalId"`,
  ].join(",\n  ");
}

export const inviteRowSchema = z.object({
  createdAt: z.string(),
  createdByPrincipalId: z.string(),
  email: z.string().nullable(),
  expiresAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  kind: z.enum([inviteKinds.link, inviteKinds.person]),
  maxUses: z.coerce.number().int(),
  opensArtifactId: z.string().nullable(),
  opensProjectId: z.string().nullable(),
  opensVersionId: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokedByPrincipalId: z.string().nullable(),
  role: z.enum([membershipRoles.administrator, membershipRoles.member]),
  secretDigest: z.string(),
  tokenPrefix: z.string(),
  useCount: z.coerce.number().int(),
});

export const listedInviteRowSchema = inviteRowSchema.extend({
  createdByName: z.string().nullable(),
});

export type InviteRow = z.infer<typeof inviteRowSchema>;
export type ListedInviteRow = z.infer<typeof listedInviteRowSchema>;

/** A stored invite from one row already parsed with `inviteRowSchema`. */
export function storedInviteFromRow(row: InviteRow): StoredInvite {
  return {
    createdAt: row.createdAt,
    createdByPrincipalId: row.createdByPrincipalId,
    email: row.email,
    expiresAt: row.expiresAt,
    id: row.id,
    installationId: row.installationId,
    kind: row.kind,
    maxUses: row.maxUses,
    opens: row.opensProjectId === null || row.opensArtifactId === null || row.opensVersionId === null
      ? null
      : {artifactId: row.opensArtifactId, projectId: row.opensProjectId, versionId: row.opensVersionId},
    revokedAt: row.revokedAt,
    revokedByPrincipalId: row.revokedByPrincipalId,
    role: row.role,
    secretDigest: row.secretDigest,
    tokenPrefix: row.tokenPrefix,
    useCount: row.useCount,
  };
}

/** A listed invite from one row already parsed with `listedInviteRowSchema`. */
export function listedInviteFromRow(row: ListedInviteRow): ListedInvite {
  const {secretDigest: _secretDigest, ...invite} = storedInviteFromRow(row);
  return {...invite, createdByName: row.createdByName};
}

export function withoutInviteDigest(invite: StoredInvite): Invite {
  const {secretDigest: _secretDigest, ...rest} = invite;
  return rest;
}

/** Positional values for the INSERT every backend uses, in column order. */
export function inviteInsertValues(invite: StoredInvite): readonly (number | string | null)[] {
  return [
    invite.installationId,
    invite.id,
    invite.kind,
    invite.email,
    invite.role,
    invite.maxUses,
    invite.useCount,
    invite.secretDigest,
    invite.tokenPrefix,
    invite.opens?.projectId ?? null,
    invite.opens?.artifactId ?? null,
    invite.opens?.versionId ?? null,
    invite.expiresAt,
    invite.createdAt,
    invite.createdByPrincipalId,
  ];
}

export const inviteInsertColumns = `installation_id, id, kind, email, role, max_uses,
  use_count, secret_digest, token_prefix, opens_project_id, opens_artifact_id,
  opens_version_id, expires_at, created_at, created_by_principal_id`;

export function inviteCreateAction(invite: Invite, attribution: ActionAttribution): ActionInsert {
  return attributedInsert(attribution, {
    action: "invite_create",
    createdAt: invite.createdAt,
    detail: {
      expiresAt: invite.expiresAt,
      inviteId: invite.id,
      inviteKind: invite.kind,
      maxUses: invite.maxUses,
      role: invite.role,
      subjectName: inviteActivitySubject(invite),
    },
    idempotencyKey: `invite_create:${invite.id}`,
    projectId: null,
    subjectId: invite.id,
  });
}

export function inviteRevokeAction(
  invite: Invite,
  attribution: ActionAttribution,
  revokedAt: string,
): ActionInsert {
  return attributedInsert(attribution, {
    action: "invite_revoke",
    createdAt: revokedAt,
    detail: {inviteId: invite.id, subjectName: inviteActivitySubject(invite)},
    idempotencyKey: `invite_revoke:${invite.id}`,
    projectId: null,
    subjectId: invite.id,
  });
}

export function inviteRedeemAction(
  invite: Invite,
  member: Pick<InstallationMember, "displayName" | "id">,
  redeemedAt: string,
): ActionInsert {
  return attributedInsert(
    {
      actor: {displayName: member.displayName, kind: "human"},
      authorizedByPrincipalId: null,
      principalId: member.id,
    },
    {
      action: "invite_redeem",
      createdAt: redeemedAt,
      detail: {inviteId: invite.id, inviteKind: invite.kind, subjectName: inviteActivitySubject(invite)},
      idempotencyKey: `invite_redeem:${invite.id}:${member.id}`,
      projectId: null,
      subjectId: invite.id,
    },
  );
}

/** The `member_admit` row a redemption writes; detail names the invite. */
export function inviteAdmitAction(
  admission: {
    readonly attribution: ActionAttribution;
    readonly createdAt: string;
    readonly displayName: string;
    readonly id: string;
    readonly role: string;
  },
  inviteId: string,
): ActionInsert {
  return attributedInsert(admission.attribution, {
    action: "member_admit",
    createdAt: admission.createdAt,
    detail: {how: "invite", inviteId, role: admission.role, subjectName: admission.displayName},
    idempotencyKey: `member_admit:${admission.id}`,
    projectId: null,
    subjectId: admission.id,
  });
}
