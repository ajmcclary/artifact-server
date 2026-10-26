import {Schema} from "effect";
import {z} from "zod";

import type {ActionAttribution} from "../core/action-attribution.js";
import {
  accessPolicyParseOptions,
  accessPolicySchema,
  type AccessPolicy,
  type StoredAccessPolicy,
} from "../core/access-policy.js";
import {
  allPermissions,
  projectAccessModes,
  projectRoles,
  type AccessGrant,
  type ProjectAccess,
} from "../core/permissions.js";
import type {ShareLinkDraft} from "../core/share-link-ports.js";
import type {GuestRecord, ShareLink} from "../core/share-links.js";
import {attributedInsert, type ActionInsert} from "./action-insert.js";

const permissionListSchema = z.array(z.enum(allPermissions));
const roleSchema = z.enum(Object.values(projectRoles));

/** Columns of one grant row, aliased to camelCase, shared by every backend. */
export const grantSelectColumns = `
  id, project_id AS "projectId", artifact_id AS "artifactId", member_id AS "memberId",
  role, add_permissions_json AS "addJson", remove_permissions_json AS "removeJson",
  expires_at AS "expiresAt", created_at AS "createdAt",
  created_by_principal_id AS "createdByPrincipalId", updated_at AS "updatedAt", revision`;

export const grantRowSchema = z.object({
  addJson: z.string(),
  artifactId: z.string().nullable(),
  createdAt: z.string(),
  createdByPrincipalId: z.string(),
  expiresAt: z.string().nullable(),
  id: z.string(),
  memberId: z.string(),
  projectId: z.string(),
  removeJson: z.string(),
  revision: z.coerce.number().int().positive(),
  role: roleSchema,
  updatedAt: z.string(),
});

/** Decode one stored grant row. */
export function grantFromRow(row: z.infer<typeof grantRowSchema>): AccessGrant {
  return {
    add: permissionListSchema.parse(JSON.parse(row.addJson)),
    artifactId: row.artifactId,
    createdAt: row.createdAt,
    createdByPrincipalId: row.createdByPrincipalId,
    expiresAt: row.expiresAt,
    id: row.id,
    memberId: row.memberId,
    projectId: row.projectId,
    remove: permissionListSchema.parse(JSON.parse(row.removeJson)),
    revision: row.revision,
    role: row.role,
    updatedAt: row.updatedAt,
  };
}

/** Columns of one project's access settings, aliased to camelCase. */
export const projectAccessSelectColumns = `
  id AS "projectId", access_mode AS "accessMode", default_member_role AS "defaultMemberRole",
  access_revision AS "revision", archived_at AS "archivedAt"`;

export const projectAccessRowSchema = z.object({
  accessMode: z.enum(Object.values(projectAccessModes)),
  archivedAt: z.string().nullable(),
  defaultMemberRole: roleSchema,
  projectId: z.string(),
  revision: z.coerce.number().int().nonnegative(),
});

/** Decode one stored project access row. */
export function projectAccessFromRow(row: z.infer<typeof projectAccessRowSchema>): ProjectAccess {
  return {
    accessMode: row.accessMode,
    archived: row.archivedAt !== null,
    defaultMemberRole: row.defaultMemberRole,
    projectId: row.projectId,
    revision: row.revision,
  };
}

export const policyRowSchema = z.object({
  policyJson: z.string(),
  revision: z.coerce.number().int().positive(),
  updatedAt: z.string(),
  updatedByPrincipalId: z.string(),
});

/** Decode one stored policy row; a corrupt document is a storage failure, not a default. */
export function storedPolicyFromRow(row: z.infer<typeof policyRowSchema>): StoredAccessPolicy {
  const policy = Schema.decodeUnknownSync(accessPolicySchema)(
    JSON.parse(row.policyJson),
    accessPolicyParseOptions,
  );
  return {
    policy,
    revision: row.revision,
    updatedAt: row.updatedAt,
    updatedByPrincipalId: row.updatedByPrincipalId,
  };
}

/** Serialize a policy for storage. */
export function policyJson(policy: AccessPolicy): string {
  return JSON.stringify(policy);
}

/** The activity row for one grant mutation. */
export function grantAction(
  kind: "grant_create" | "grant_delete" | "grant_update",
  grant: AccessGrant,
  attribution: ActionAttribution,
  at: string,
): ActionInsert {
  return attributedInsert(attribution, {
    action: kind,
    createdAt: at,
    detail: grant.artifactId === null
      ? {role: grant.role}
      : {grantArtifactId: grant.artifactId, role: grant.role},
    idempotencyKey: `${kind}:${grant.id}:${grant.revision}`,
    projectId: grant.projectId,
    subjectId: grant.memberId,
  });
}

/** The activity row for one project access change. */
export function projectAccessAction(
  access: ProjectAccess,
  attribution: ActionAttribution,
  at: string,
): ActionInsert {
  return attributedInsert(attribution, {
    action: "project_access_change",
    createdAt: at,
    detail: {accessMode: access.accessMode, role: access.defaultMemberRole},
    idempotencyKey: `project_access_change:${access.projectId}:${access.revision}`,
    projectId: access.projectId,
    subjectId: access.projectId,
  });
}

/** The activity row for one installation policy change. */
export function policyAction(
  revision: number,
  attribution: ActionAttribution,
  at: string,
): ActionInsert {
  return attributedInsert(attribution, {
    action: "policy_change",
    createdAt: at,
    idempotencyKey: `policy_change:${revision}`,
    projectId: null,
  });
}

/** Bind value for an optional artifact-id filter: null means unfiltered. */
export function artifactIdsJson(artifactIds: readonly string[] | null): string | null {
  return artifactIds === null ? null : JSON.stringify(artifactIds);
}

const shareLinkPermissionsSchema = z.array(z.enum(allPermissions));

/** Columns of one share link with its live guest count; `l` is the share_links alias. */
export const shareLinkSelectColumns = `
  l.id, l.project_id AS "projectId", l.artifact_id AS "artifactId", l.label, l.token,
  l.target_kind AS "targetKind", l.pinned_version_id AS "pinnedVersionId",
  l.permissions_json AS "permissionsJson", l.expires_at AS "expiresAt", l.generation, l.revision,
  l.created_at AS "createdAt", l.created_by_principal_id AS "createdByPrincipalId",
  l.created_by_name AS "createdByName", l.revoked_at AS "revokedAt",
  (SELECT COUNT(*) FROM guest_principals g
    WHERE g.installation_id = l.installation_id AND g.share_link_id = l.id
      AND g.generation = l.generation) AS "guestCount"`;

export const shareLinkRowSchema = z.object({
  artifactId: z.string(),
  createdAt: z.string(),
  createdByName: z.string(),
  createdByPrincipalId: z.string(),
  expiresAt: z.string().nullable(),
  generation: z.coerce.number().int().nonnegative(),
  guestCount: z.coerce.number().int().nonnegative(),
  id: z.string(),
  label: z.string(),
  permissionsJson: z.string(),
  pinnedVersionId: z.string().nullable(),
  projectId: z.string(),
  revision: z.coerce.number().int().positive(),
  revokedAt: z.string().nullable(),
  targetKind: z.enum(["latest", "pinned"]),
  token: z.string(),
});

/** Decode one stored share link. */
export function shareLinkFromRow(row: z.infer<typeof shareLinkRowSchema>): ShareLink {
  return {
    artifactId: row.artifactId,
    createdAt: row.createdAt,
    createdByName: row.createdByName,
    createdByPrincipalId: row.createdByPrincipalId,
    expiresAt: row.expiresAt,
    generation: row.generation,
    guestCount: row.guestCount,
    id: row.id,
    label: row.label,
    permissions: shareLinkPermissionsSchema.parse(JSON.parse(row.permissionsJson)),
    projectId: row.projectId,
    revision: row.revision,
    revokedAt: row.revokedAt,
    target: row.targetKind === "pinned" && row.pinnedVersionId !== null
      ? {kind: "pinned", versionId: row.pinnedVersionId}
      : {kind: "latest"},
    token: row.token,
  };
}

/** Columns of one guest; `g` is the guest_principals alias. */
export const guestSelectColumns = `
  g.id AS "guestId", g.share_link_id AS "shareLinkId", g.generation AS "guestGeneration",
  g.display_name AS "displayName", g.contact_email AS "contactEmail", g.created_at AS "guestCreatedAt"`;

export const guestRowSchema = z.object({
  contactEmail: z.string().nullable(),
  displayName: z.string().nullable(),
  guestCreatedAt: z.string(),
  guestGeneration: z.coerce.number().int().nonnegative(),
  guestId: z.string(),
  shareLinkId: z.string(),
});

/** Decode one stored guest. */
export function guestFromRow(row: z.infer<typeof guestRowSchema>): GuestRecord {
  return {
    contactEmail: row.contactEmail,
    createdAt: row.guestCreatedAt,
    displayName: row.displayName,
    generation: row.guestGeneration,
    id: row.guestId,
    shareLinkId: row.shareLinkId,
  };
}

export const guestSessionRowSchema = z.object({
  csrfDigest: z.string(),
  sessionExpiresAt: z.string(),
  sessionGuestId: z.string(),
  sessionId: z.string(),
  sessionRevokedAt: z.string().nullable(),
});

/** Columns of one guest session; `s` is the guest_sessions alias. */
export const guestSessionSelectColumns = `
  s.id AS "sessionId", s.guest_id AS "sessionGuestId", s.expires_at AS "sessionExpiresAt",
  s.revoked_at AS "sessionRevokedAt", s.csrf_digest AS "csrfDigest"`;

/** Bind values for inserting one share link, in `shareLinkInsertColumns` order. */
export const shareLinkInsertColumns = `installation_id, id, project_id, artifact_id, label, token,
  target_kind, pinned_version_id, permissions_json, expires_at, generation, revision,
  created_at, created_by_principal_id, created_by_name`;

export function shareLinkInsertValues(installationId: string, link: ShareLinkDraft): readonly (string | number | null)[] {
  return [
    installationId,
    link.id,
    link.projectId,
    link.artifactId,
    link.label,
    link.token,
    link.target.kind,
    link.target.kind === "pinned" ? link.target.versionId : null,
    JSON.stringify(link.permissions),
    link.expiresAt,
    0,
    1,
    link.createdAt,
    link.createdByPrincipalId,
    link.createdByName,
  ];
}

/** The activity row for one share-link change. */
export function shareLinkAction(
  kind: "share_link_create" | "share_link_revoke" | "share_link_rotate" | "share_link_update",
  link: Pick<ShareLink, "artifactId" | "generation" | "id" | "label" | "projectId" | "revision">,
  versionId: string,
  attribution: ActionAttribution,
  at: string,
): ActionInsert {
  return {
    ...attributedInsert(attribution, {
      action: kind,
      createdAt: at,
      detail: {name: link.label},
      idempotencyKey: `${kind}:${link.id}:${link.revision}:${link.generation}`,
      projectId: link.projectId,
      subjectId: link.id,
    }),
    artifactId: link.artifactId,
    versionId,
  };
}

/** The activity row for one guest opening a share link. */
export function guestJoinAction(
  guest: GuestRecord,
  link: Pick<ShareLink, "artifactId" | "id" | "projectId">,
  versionId: string,
  attribution: ActionAttribution,
): ActionInsert {
  return {
    ...attributedInsert(attribution, {
      action: "guest_join",
      createdAt: guest.createdAt,
      idempotencyKey: `guest_join:${guest.id}`,
      projectId: link.projectId,
      subjectId: link.id,
    }),
    artifactId: link.artifactId,
    versionId,
  };
}
