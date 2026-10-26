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
