import {Effect} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";

import type {AccessGrantDraft, AccessRepository} from "../core/access-ports.js";
import {defaultAccessPolicy, type StoredAccessPolicy} from "../core/access-policy.js";
import type {AccessGrant, ProjectAccess} from "../core/permissions.js";
import type {Clock} from "../core/ports.js";
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
import {insertPostgresAction} from "./postgres-action-insert.js";
import type {PostgresDatabase} from "./postgres-database.js";

const findGrant = (installationId: string, grantId: string, lock: boolean) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<object>(
      `SELECT ${grantSelectColumns} FROM access_grants
       WHERE installation_id = $1 AND id = $2 ${lock ? "FOR UPDATE" : ""}`,
      [installationId, grantId],
    );
    return rows[0] === undefined ? null : grantFromRow(grantRowSchema.parse(rows[0]));
  });

const readProjectAccess = (installationId: string, projectId: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<object>(
      `SELECT ${projectAccessSelectColumns} FROM projects WHERE installation_id = $1 AND id = $2`,
      [installationId, projectId],
    );
    return rows[0] === undefined ? null : projectAccessFromRow(projectAccessRowSchema.parse(rows[0]));
  });

const listGrants = (where: string, values: readonly string[]) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<object>(
      `SELECT ${grantSelectColumns} FROM access_grants WHERE ${where} ORDER BY project_id, created_at, id`,
      values,
    );
    return rows.map((row) => grantFromRow(grantRowSchema.parse(row)));
  });

/** Postgres access store for stateless external-storage processes. */
export class PostgresAccessRepository implements AccessRepository {
  readonly #clock: Clock;
  readonly #database: PostgresDatabase;

  /** Every operation names its installation, so one pool serves any installation. */
  constructor(database: PostgresDatabase, clock: Clock) {
    this.#clock = clock;
    this.#database = database;
  }

  async readAccessPolicy(installationId: string): Promise<StoredAccessPolicy> {
    const rows = await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.unsafe<object>(
        `SELECT policy_json AS "policyJson", revision, updated_at AS "updatedAt",
           updated_by_principal_id AS "updatedByPrincipalId"
         FROM installation_access_policy WHERE installation_id = $1`,
        [installationId],
      );
    }));
    if (rows[0] === undefined) {
      return {policy: defaultAccessPolicy, revision: 0, updatedAt: null, updatedByPrincipalId: null};
    }
    return storedPolicyFromRow(policyRowSchema.parse(rows[0]));
  }

  async writeAccessPolicy(
    command: Parameters<AccessRepository["writeAccessPolicy"]>[0],
  ): ReturnType<AccessRepository["writeAccessPolicy"]> {
    const at = this.#clock.now().toISOString();
    const revision = command.expectedRevision + 1;
    const principalId = command.attribution.principalId ?? "";
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen(function*() {
        const changed = command.expectedRevision === 0
          ? yield* sql.unsafe<object>(
            `INSERT INTO installation_access_policy
               (installation_id, policy_json, revision, updated_at, updated_by_principal_id)
             VALUES ($1, $2, 1, $3, $4)
             ON CONFLICT (installation_id) DO NOTHING RETURNING revision`,
            [command.installationId, policyJson(command.policy), at, principalId],
          )
          : yield* sql.unsafe<object>(
            `UPDATE installation_access_policy
             SET policy_json = $1, revision = revision + 1, updated_at = $2, updated_by_principal_id = $3
             WHERE installation_id = $4 AND revision = $5 RETURNING revision`,
            [policyJson(command.policy), at, principalId, command.installationId, command.expectedRevision],
          );
        if (changed.length === 0) return "conflict" as const;
        yield* insertPostgresAction(command.installationId, policyAction(revision, command.attribution, at));
        return {policy: command.policy, revision, updatedAt: at, updatedByPrincipalId: principalId};
      }));
    }));
  }

  async listProjectAccess(installationId: string): Promise<readonly ProjectAccess[]> {
    const rows = await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.unsafe<object>(
        `SELECT ${projectAccessSelectColumns} FROM projects
         WHERE installation_id = $1 ORDER BY created_at, id`,
        [installationId],
      );
    }));
    return rows.map((row) => projectAccessFromRow(projectAccessRowSchema.parse(row)));
  }

  async readProjectAccess(installationId: string, projectId: string): Promise<ProjectAccess | null> {
    return this.#database.run(readProjectAccess(installationId, projectId));
  }

  async writeProjectAccess(
    command: Parameters<AccessRepository["writeProjectAccess"]>[0],
  ): ReturnType<AccessRepository["writeProjectAccess"]> {
    const at = this.#clock.now().toISOString();
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen(function*() {
        const changed = yield* sql.unsafe<object>(
          `UPDATE projects
           SET access_mode = $1, default_member_role = $2, access_revision = access_revision + 1
           WHERE installation_id = $3 AND id = $4 AND access_revision = $5 RETURNING id`,
          [
            command.accessMode,
            command.defaultMemberRole,
            command.installationId,
            command.projectId,
            command.expectedRevision,
          ],
        );
        if (changed.length === 0) return "conflict" as const;
        const access = yield* readProjectAccess(command.installationId, command.projectId);
        if (access === null) return "conflict" as const;
        yield* insertPostgresAction(command.installationId, projectAccessAction(access, command.attribution, at));
        return access;
      }));
    }));
  }

  async findSubjectGrants(
    command: Parameters<AccessRepository["findSubjectGrants"]>[0],
  ): ReturnType<AccessRepository["findSubjectGrants"]> {
    const grants = await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT ${grantSelectColumns} FROM access_grants
         WHERE installation_id = $1 AND project_id = $2 AND member_id = $3
           AND (artifact_id IS NULL OR artifact_id = $4)
         ORDER BY created_at, id`,
        [command.installationId, command.projectId, command.memberId, command.artifactId],
      );
      return rows.map((row) => grantFromRow(grantRowSchema.parse(row)));
    }));
    return {
      artifactGrants: grants.filter((grant) => grant.artifactId !== null),
      projectGrant: grants.find((grant) => grant.artifactId === null) ?? null,
    };
  }

  async listMemberGrants(installationId: string, memberId: string): Promise<readonly AccessGrant[]> {
    return this.#database.run(listGrants("installation_id = $1 AND member_id = $2", [installationId, memberId]));
  }

  async listProjectGrants(installationId: string, projectId: string): Promise<readonly AccessGrant[]> {
    return this.#database.run(listGrants("installation_id = $1 AND project_id = $2", [installationId, projectId]));
  }

  async upsertGrant(
    command: Parameters<AccessRepository["upsertGrant"]>[0],
  ): ReturnType<AccessRepository["upsertGrant"]> {
    const at = this.#clock.now().toISOString();
    const {grant} = command;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen(function*() {
        const changed = command.expectedRevision === null
          ? yield* insertGrant(command.installationId, grant, at)
          : yield* sql.unsafe<object>(
            `UPDATE access_grants
             SET role = $1, add_permissions_json = $2, remove_permissions_json = $3, expires_at = $4,
               updated_at = $5, revision = revision + 1
             WHERE installation_id = $6 AND id = $7 AND revision = $8 RETURNING id`,
            [
              grant.role,
              JSON.stringify(grant.add),
              JSON.stringify(grant.remove),
              grant.expiresAt,
              at,
              command.installationId,
              grant.id,
              command.expectedRevision,
            ],
          );
        if (changed.length === 0) return "conflict" as const;
        const stored = yield* findGrant(command.installationId, grant.id, false);
        if (stored === null) return "conflict" as const;
        yield* insertPostgresAction(command.installationId, grantAction(
          command.expectedRevision === null ? "grant_create" : "grant_update",
          stored,
          command.attribution,
          at,
        ));
        return stored;
      }));
    }));
  }

  async deleteGrant(
    command: Parameters<AccessRepository["deleteGrant"]>[0],
  ): ReturnType<AccessRepository["deleteGrant"]> {
    const at = this.#clock.now().toISOString();
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen(function*() {
        const existing = yield* findGrant(command.installationId, command.grantId, true);
        if (existing === null) return "missing" as const;
        if (existing.revision !== command.expectedRevision) return "conflict" as const;
        yield* sql.unsafe(
          "DELETE FROM access_grants WHERE installation_id = $1 AND id = $2",
          [command.installationId, command.grantId],
        );
        yield* insertPostgresAction(command.installationId, grantAction("grant_delete", existing, command.attribution, at));
        return "deleted" as const;
      }));
    }));
  }
}

// A duplicate id or a second grant for the same member and scope inserts nothing.
function insertGrant(installationId: string, grant: AccessGrantDraft, at: string) {
  return Effect.gen(function*() {
    const sql = yield* SqlClient;
    return yield* sql.unsafe<object>(
      `INSERT INTO access_grants (
         installation_id, id, project_id, artifact_id, member_id, role,
         add_permissions_json, remove_permissions_json, expires_at,
         created_at, created_by_principal_id, updated_at, revision
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $10, 1)
       ON CONFLICT DO NOTHING RETURNING id`,
      [
        installationId,
        grant.id,
        grant.projectId,
        grant.artifactId,
        grant.memberId,
        grant.role,
        JSON.stringify(grant.add),
        JSON.stringify(grant.remove),
        grant.expiresAt,
        at,
        grant.createdByPrincipalId,
      ],
    );
  });
}
