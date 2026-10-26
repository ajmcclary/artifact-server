import type {AccessRepository} from "../../../src/core/access-ports.js";
import {defaultAccessPolicy} from "../../../src/core/access-policy.js";
import type {AccessGrant, ProjectAccess} from "../../../src/core/permissions.js";
import type {Clock} from "../../../src/core/ports.js";
import {
  positionalActionInsertWhereSql,
  positionalActionValues,
  type ActionInsert,
} from "../../../src/storage/action-insert.js";
import {
  grantAction,
  grantFromRow,
  grantRowSchema,
  grantSelectColumns,
  policyAction,
  policyJson,
  policyRowSchema,
  projectAccessAction,
  projectAccessFromRow,
  projectAccessRowSchema,
  projectAccessSelectColumns,
  storedPolicyFromRow,
} from "../../../src/storage/access-rows.js";

/**
 * D1 access store. D1 batches cannot branch, so each action row is written only
 * when the guarded statement immediately before it changed exactly one row.
 */
export function createD1AccessRepository(database: D1Database, clock: Clock): AccessRepository {
  const now = () => clock.now().toISOString();
  const actionAfterChange = (insert: ActionInsert): D1PreparedStatement =>
    database.prepare(positionalActionInsertWhereSql("changes() = 1")).bind(...positionalActionValues(insert));

  const findGrant = async (installationId: string, grantId: string): Promise<AccessGrant | null> => {
    const row = await database.prepare(`SELECT ${grantSelectColumns} FROM access_grants
      WHERE installation_id = ? AND id = ?`).bind(installationId, grantId).first();
    return row === null ? null : grantFromRow(grantRowSchema.parse(row));
  };

  const readProjectAccess = async (installationId: string, projectId: string): Promise<ProjectAccess | null> => {
    const row = await database.prepare(`SELECT ${projectAccessSelectColumns} FROM projects
      WHERE installation_id = ? AND id = ?`).bind(installationId, projectId).first();
    return row === null ? null : projectAccessFromRow(projectAccessRowSchema.parse(row));
  };

  const listGrants = async (where: string, values: readonly string[]): Promise<readonly AccessGrant[]> => {
    const rows = await database.prepare(`SELECT ${grantSelectColumns} FROM access_grants
      WHERE ${where} ORDER BY project_id, created_at, id`).bind(...values).all();
    return rows.results.map((row) => grantFromRow(grantRowSchema.parse(row)));
  };

  return {
    deleteGrant: async (command) => {
      const existing = await findGrant(command.installationId, command.grantId);
      if (existing === null) return "missing";
      if (existing.revision !== command.expectedRevision) return "conflict";
      const [deleted] = await database.batch([
        database.prepare("DELETE FROM access_grants WHERE installation_id = ? AND id = ? AND revision = ?")
          .bind(command.installationId, command.grantId, command.expectedRevision),
        actionAfterChange(grantAction("grant_delete", existing, command.attribution, now())),
      ]);
      return deleted?.meta.changes === 1 ? "deleted" : "conflict";
    },
    findSubjectGrants: async (command) => {
      const rows = await database.prepare(`SELECT ${grantSelectColumns} FROM access_grants
        WHERE installation_id = ? AND project_id = ? AND member_id = ?
          AND (artifact_id IS NULL OR artifact_id = ?)
        ORDER BY created_at, id`)
        .bind(command.installationId, command.projectId, command.memberId, command.artifactId)
        .all();
      const grants = rows.results.map((row) => grantFromRow(grantRowSchema.parse(row)));
      return {
        artifactGrants: grants.filter((grant) => grant.artifactId !== null),
        projectGrant: grants.find((grant) => grant.artifactId === null) ?? null,
      };
    },
    listMemberGrants: async (installationId, memberId) =>
      listGrants("installation_id = ? AND member_id = ?", [installationId, memberId]),
    listProjectAccess: async (installationId) => {
      const rows = await database.prepare(`SELECT ${projectAccessSelectColumns} FROM projects
        WHERE installation_id = ? ORDER BY created_at, id`).bind(installationId).all();
      return rows.results.map((row) => projectAccessFromRow(projectAccessRowSchema.parse(row)));
    },
    listProjectGrants: async (installationId, projectId) =>
      listGrants("installation_id = ? AND project_id = ?", [installationId, projectId]),
    readAccessPolicy: async (installationId) => {
      const row = await database.prepare(`SELECT policy_json AS policyJson, revision,
          updated_at AS updatedAt, updated_by_principal_id AS updatedByPrincipalId
        FROM installation_access_policy WHERE installation_id = ?`).bind(installationId).first();
      if (row === null) {
        return {policy: defaultAccessPolicy, revision: 0, updatedAt: null, updatedByPrincipalId: null};
      }
      return storedPolicyFromRow(policyRowSchema.parse(row));
    },
    readProjectAccess,
    upsertGrant: async (command) => {
      const at = now();
      const {grant} = command;
      const write = command.expectedRevision === null
        ? database.prepare(`INSERT INTO access_grants (
            installation_id, id, project_id, artifact_id, member_id, role,
            add_permissions_json, remove_permissions_json, expires_at,
            created_at, created_by_principal_id, updated_at, revision
          ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
          WHERE NOT EXISTS (SELECT 1 FROM access_grants WHERE installation_id = ? AND (
            id = ? OR (project_id = ? AND member_id = ? AND COALESCE(artifact_id, '') = COALESCE(?, ''))
          ))`).bind(
            command.installationId, grant.id, grant.projectId, grant.artifactId, grant.memberId,
            grant.role, JSON.stringify(grant.add), JSON.stringify(grant.remove), grant.expiresAt,
            at, grant.createdByPrincipalId, at,
            command.installationId, grant.id, grant.projectId, grant.memberId, grant.artifactId,
          )
        : database.prepare(`UPDATE access_grants
            SET role = ?, add_permissions_json = ?, remove_permissions_json = ?, expires_at = ?,
              updated_at = ?, revision = revision + 1
            WHERE installation_id = ? AND id = ? AND revision = ?`).bind(
            grant.role, JSON.stringify(grant.add), JSON.stringify(grant.remove), grant.expiresAt,
            at, command.installationId, grant.id, command.expectedRevision,
          );
      const revision = command.expectedRevision === null ? 1 : command.expectedRevision + 1;
      // The action is built from the values this batch writes; the read-back below confirms them.
      const written: AccessGrant = {
        ...grant,
        createdAt: at,
        revision,
        updatedAt: at,
      };
      const [result] = await database.batch([
        write,
        actionAfterChange(grantAction(
          command.expectedRevision === null ? "grant_create" : "grant_update",
          written,
          command.attribution,
          at,
        )),
      ]);
      if (result?.meta.changes !== 1) return "conflict";
      return (await findGrant(command.installationId, grant.id)) ?? "conflict";
    },
    writeAccessPolicy: async (command) => {
      const at = now();
      const revision = command.expectedRevision + 1;
      const principalId = command.attribution.principalId ?? "";
      const write = command.expectedRevision === 0
        ? database.prepare(`INSERT INTO installation_access_policy
            (installation_id, policy_json, revision, updated_at, updated_by_principal_id)
          VALUES (?, ?, 1, ?, ?) ON CONFLICT (installation_id) DO NOTHING`)
          .bind(command.installationId, policyJson(command.policy), at, principalId)
        : database.prepare(`UPDATE installation_access_policy
            SET policy_json = ?, revision = revision + 1, updated_at = ?, updated_by_principal_id = ?
            WHERE installation_id = ? AND revision = ?`)
          .bind(policyJson(command.policy), at, principalId, command.installationId, command.expectedRevision);
      const [result] = await database.batch([
        write,
        actionAfterChange(policyAction(revision, command.attribution, at)),
      ]);
      if (result?.meta.changes !== 1) return "conflict";
      return {policy: command.policy, revision, updatedAt: at, updatedByPrincipalId: principalId};
    },
    writeProjectAccess: async (command) => {
      const at = now();
      const next: ProjectAccess | null = await readProjectAccess(command.installationId, command.projectId);
      if (next === null) return "conflict";
      const written: ProjectAccess = {
        ...next,
        accessMode: command.accessMode,
        defaultMemberRole: command.defaultMemberRole,
        revision: command.expectedRevision + 1,
      };
      const [result] = await database.batch([
        database.prepare(`UPDATE projects
          SET access_mode = ?, default_member_role = ?, access_revision = access_revision + 1
          WHERE installation_id = ? AND id = ? AND access_revision = ?`)
          .bind(
            command.accessMode,
            command.defaultMemberRole,
            command.installationId,
            command.projectId,
            command.expectedRevision,
          ),
        actionAfterChange(projectAccessAction(written, command.attribution, at)),
      ]);
      if (result?.meta.changes !== 1) return "conflict";
      return (await readProjectAccess(command.installationId, command.projectId)) ?? "conflict";
    },
  };
}
