import {DatabaseSync} from "node:sqlite";

import type {AccessGrantDraft, AccessRepository} from "../core/access-ports.js";
import {defaultAccessPolicy, type StoredAccessPolicy} from "../core/access-policy.js";
import type {AccessGrant, ProjectAccess} from "../core/permissions.js";
import type {Clock} from "../core/ports.js";
import {positionalActionInsertSql, positionalActionValues, type ActionInsert} from "./action-insert.js";
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
} from "./access-rows.js";

const changesOf = (result: {readonly changes: number | bigint}): number => Number(result.changes);

/**
 * SQLite access store. The schema belongs to `SqliteArtifactRepository#migrate`;
 * this class opens its own connection to the same file.
 */
export class SqliteAccessRepository implements AccessRepository {
  readonly #clock: Clock;
  readonly #database: DatabaseSync;

  /** Every operation names its installation, so one connection serves any installation in the file. */
  constructor(databasePath: string, clock: Clock) {
    this.#clock = clock;
    this.#database = new DatabaseSync(databasePath, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      open: true,
      timeout: 5_000,
    });
  }

  close(): void {
    this.#database.close();
  }

  async readAccessPolicy(installationId: string): Promise<StoredAccessPolicy> {
    const row = this.#database.prepare(`
      SELECT policy_json AS policyJson, revision, updated_at AS updatedAt,
        updated_by_principal_id AS updatedByPrincipalId
      FROM installation_access_policy WHERE installation_id = ?
    `).get(installationId);
    if (row === undefined) {
      return {policy: defaultAccessPolicy, revision: 0, updatedAt: null, updatedByPrincipalId: null};
    }
    return storedPolicyFromRow(policyRowSchema.parse(row));
  }

  async writeAccessPolicy(
    command: Parameters<AccessRepository["writeAccessPolicy"]>[0],
  ): ReturnType<AccessRepository["writeAccessPolicy"]> {
    const at = this.#now();
    const revision = command.expectedRevision + 1;
    return this.#transaction(() => {
      const changed = command.expectedRevision === 0
        ? changesOf(this.#database.prepare(`
            INSERT INTO installation_access_policy
              (installation_id, policy_json, revision, updated_at, updated_by_principal_id)
            VALUES (?, ?, 1, ?, ?)
            ON CONFLICT (installation_id) DO NOTHING
          `).run(command.installationId, policyJson(command.policy), at, command.attribution.principalId ?? ""))
        : changesOf(this.#database.prepare(`
            UPDATE installation_access_policy
            SET policy_json = ?, revision = revision + 1, updated_at = ?, updated_by_principal_id = ?
            WHERE installation_id = ? AND revision = ?
          `).run(
            policyJson(command.policy),
            at,
            command.attribution.principalId ?? "",
            command.installationId,
            command.expectedRevision,
          ));
      if (changed === 0) return "conflict" as const;
      this.#insertAction(policyAction(revision, command.attribution, at));
      return {
        policy: command.policy,
        revision,
        updatedAt: at,
        updatedByPrincipalId: command.attribution.principalId ?? "",
      };
    });
  }

  async listProjectAccess(installationId: string): Promise<readonly ProjectAccess[]> {
    return this.#database.prepare(`
      SELECT ${projectAccessSelectColumns} FROM projects
      WHERE installation_id = ? ORDER BY created_at, id
    `).all(installationId).map((row) => projectAccessFromRow(projectAccessRowSchema.parse(row)));
  }

  async readProjectAccess(installationId: string, projectId: string): Promise<ProjectAccess | null> {
    return this.#readProjectAccess(installationId, projectId);
  }

  async writeProjectAccess(
    command: Parameters<AccessRepository["writeProjectAccess"]>[0],
  ): ReturnType<AccessRepository["writeProjectAccess"]> {
    const at = this.#now();
    return this.#transaction(() => {
      const changed = changesOf(this.#database.prepare(`
        UPDATE projects
        SET access_mode = ?, default_member_role = ?, access_revision = access_revision + 1
        WHERE installation_id = ? AND id = ? AND access_revision = ?
      `).run(
        command.accessMode,
        command.defaultMemberRole,
        command.installationId,
        command.projectId,
        command.expectedRevision,
      ));
      if (changed === 0) return "conflict" as const;
      const access = this.#readProjectAccess(command.installationId, command.projectId);
      if (access === null) return "conflict" as const;
      this.#insertAction(projectAccessAction(access, command.attribution, at));
      return access;
    });
  }

  async findSubjectGrants(
    command: Parameters<AccessRepository["findSubjectGrants"]>[0],
  ): ReturnType<AccessRepository["findSubjectGrants"]> {
    const grants = this.#database.prepare(`
      SELECT ${grantSelectColumns} FROM access_grants
      WHERE installation_id = ? AND project_id = ? AND member_id = ?
        AND (artifact_id IS NULL OR artifact_id = ?)
      ORDER BY created_at, id
    `).all(command.installationId, command.projectId, command.memberId, command.artifactId)
      .map((row) => grantFromRow(grantRowSchema.parse(row)));
    return {
      artifactGrants: grants.filter((grant) => grant.artifactId !== null),
      projectGrant: grants.find((grant) => grant.artifactId === null) ?? null,
    };
  }

  async listMemberGrants(installationId: string, memberId: string): Promise<readonly AccessGrant[]> {
    return this.#database.prepare(`
      SELECT ${grantSelectColumns} FROM access_grants
      WHERE installation_id = ? AND member_id = ? ORDER BY project_id, created_at, id
    `).all(installationId, memberId).map((row) => grantFromRow(grantRowSchema.parse(row)));
  }

  async listProjectGrants(installationId: string, projectId: string): Promise<readonly AccessGrant[]> {
    return this.#database.prepare(`
      SELECT ${grantSelectColumns} FROM access_grants
      WHERE installation_id = ? AND project_id = ? ORDER BY created_at, id
    `).all(installationId, projectId).map((row) => grantFromRow(grantRowSchema.parse(row)));
  }

  async upsertGrant(
    command: Parameters<AccessRepository["upsertGrant"]>[0],
  ): ReturnType<AccessRepository["upsertGrant"]> {
    const at = this.#now();
    return this.#transaction(() => {
      if (command.expectedRevision === null) {
        if (this.#grantConflictsOnCreate(command.installationId, command.grant)) return "conflict" as const;
        this.#database.prepare(`
          INSERT INTO access_grants (
            installation_id, id, project_id, artifact_id, member_id, role,
            add_permissions_json, remove_permissions_json, expires_at,
            created_at, created_by_principal_id, updated_at, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `).run(
          command.installationId,
          command.grant.id,
          command.grant.projectId,
          command.grant.artifactId,
          command.grant.memberId,
          command.grant.role,
          JSON.stringify(command.grant.add),
          JSON.stringify(command.grant.remove),
          command.grant.expiresAt,
          at,
          command.grant.createdByPrincipalId,
          at,
        );
      } else {
        const changed = changesOf(this.#database.prepare(`
          UPDATE access_grants
          SET role = ?, add_permissions_json = ?, remove_permissions_json = ?, expires_at = ?,
            updated_at = ?, revision = revision + 1
          WHERE installation_id = ? AND id = ? AND revision = ?
        `).run(
          command.grant.role,
          JSON.stringify(command.grant.add),
          JSON.stringify(command.grant.remove),
          command.grant.expiresAt,
          at,
          command.installationId,
          command.grant.id,
          command.expectedRevision,
        ));
        if (changed === 0) return "conflict" as const;
      }
      const stored = this.#findGrant(command.installationId, command.grant.id);
      if (stored === null) return "conflict" as const;
      this.#insertAction(grantAction(
        command.expectedRevision === null ? "grant_create" : "grant_update",
        stored,
        command.attribution,
        at,
      ));
      return stored;
    });
  }

  async deleteGrant(
    command: Parameters<AccessRepository["deleteGrant"]>[0],
  ): ReturnType<AccessRepository["deleteGrant"]> {
    const at = this.#now();
    return this.#transaction(() => {
      const existing = this.#findGrant(command.installationId, command.grantId);
      if (existing === null) return "missing" as const;
      if (existing.revision !== command.expectedRevision) return "conflict" as const;
      this.#database.prepare(
        "DELETE FROM access_grants WHERE installation_id = ? AND id = ? AND revision = ?",
      ).run(command.installationId, command.grantId, command.expectedRevision);
      this.#insertAction(grantAction("grant_delete", existing, command.attribution, at));
      return "deleted" as const;
    });
  }

  #grantConflictsOnCreate(installationId: string, grant: AccessGrantDraft): boolean {
    const existing = this.#database.prepare(`
      SELECT 1 AS found FROM access_grants
      WHERE installation_id = ? AND (
        id = ? OR (project_id = ? AND member_id = ? AND COALESCE(artifact_id, '') = COALESCE(?, ''))
      )
    `).get(installationId, grant.id, grant.projectId, grant.memberId, grant.artifactId);
    return existing !== undefined;
  }

  #findGrant(installationId: string, grantId: string): AccessGrant | null {
    const row = this.#database.prepare(`
      SELECT ${grantSelectColumns} FROM access_grants WHERE installation_id = ? AND id = ?
    `).get(installationId, grantId);
    return row === undefined ? null : grantFromRow(grantRowSchema.parse(row));
  }

  #readProjectAccess(installationId: string, projectId: string): ProjectAccess | null {
    const row = this.#database.prepare(`
      SELECT ${projectAccessSelectColumns} FROM projects WHERE installation_id = ? AND id = ?
    `).get(installationId, projectId);
    return row === undefined ? null : projectAccessFromRow(projectAccessRowSchema.parse(row));
  }

  #insertAction(insert: ActionInsert): void {
    this.#database.prepare(positionalActionInsertSql).run(...positionalActionValues(insert));
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }

  #transaction<Result>(operation: () => Result): Result {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.#database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }
}
