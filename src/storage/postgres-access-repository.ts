import {Effect} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";

import {z} from "zod";

import type {AccessGrantDraft, AccessRepository} from "../core/access-ports.js";
import type {ActionAttribution} from "../core/action-attribution.js";
import type {PageCursor} from "../core/model.js";
import type {ShareLinkRepository} from "../core/share-link-ports.js";
import type {GuestRecord, ShareLink} from "../core/share-links.js";
import {defaultAccessPolicy, type StoredAccessPolicy} from "../core/access-policy.js";
import type {AccessGrant, ProjectAccess} from "../core/permissions.js";
import type {Clock} from "../core/ports.js";
import {
  guestFromRow,
  guestJoinAction,
  guestRowSchema,
  guestSelectColumns,
  guestSessionRowSchema,
  guestSessionSelectColumns,
  shareLinkAction,
  shareLinkFromRow,
  shareLinkInsertColumns,
  shareLinkInsertValues,
  shareLinkRowSchema,
  shareLinkSelectColumns,
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

const findShareLink = (installationId: string, linkId: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<object>(
      `SELECT ${shareLinkSelectColumns} FROM share_links l WHERE l.installation_id = $1 AND l.id = $2`,
      [installationId, linkId],
    );
    return rows[0] === undefined ? null : shareLinkFromRow(shareLinkRowSchema.parse(rows[0]));
  });

const findGuestRecord = (installationId: string, guestId: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<object>(
      `SELECT ${guestSelectColumns} FROM guest_principals g WHERE g.installation_id = $1 AND g.id = $2`,
      [installationId, guestId],
    );
    return rows[0] === undefined ? null : guestFromRow(guestRowSchema.parse(rows[0]));
  });

const revokeLink = (
  installationId: string,
  link: ShareLink,
  versionId: string,
  attribution: ActionAttribution,
  at: string,
) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      `UPDATE share_links SET revoked_at = $1, revoked_by_principal_id = $2, revision = revision + 1
       WHERE installation_id = $3 AND id = $4 AND revoked_at IS NULL`,
      [at, attribution.principalId ?? "system", installationId, link.id],
    );
    yield* insertPostgresAction(installationId, shareLinkAction(
      "share_link_revoke",
      {...link, revision: link.revision + 1},
      versionId,
      attribution,
      at,
    ));
  });

const placeholders = (count: number): string =>
  Array.from({length: count}, (_, index) => `$${index + 1}`).join(", ");

/** Postgres access store for stateless external-storage processes. */
export class PostgresAccessRepository implements AccessRepository, ShareLinkRepository {
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

  async createShareLink(
    command: Parameters<ShareLinkRepository["createShareLink"]>[0],
  ): ReturnType<ShareLinkRepository["createShareLink"]> {
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen(function*() {
        yield* sql.unsafe(
          `INSERT INTO share_links (${shareLinkInsertColumns}) VALUES (${placeholders(15)})`,
          [...shareLinkInsertValues(command.installationId, command.link)],
        );
        const created = yield* findShareLink(command.installationId, command.link.id);
        if (created === null) return yield* Effect.die(new Error("The share link was not stored."));
        yield* insertPostgresAction(command.installationId, shareLinkAction(
          "share_link_create",
          created,
          command.versionId,
          command.attribution,
          command.link.createdAt,
        ));
        return created;
      }));
    }));
  }

  async updateShareLink(
    command: Parameters<ShareLinkRepository["updateShareLink"]>[0],
  ): ReturnType<ShareLinkRepository["updateShareLink"]> {
    const at = this.#clock.now().toISOString();
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen(function*() {
        if ((yield* findShareLink(command.installationId, command.linkId)) === null) return "missing" as const;
        const changed = yield* sql.unsafe<object>(
          `UPDATE share_links
           SET label = $1, permissions_json = $2, expires_at = $3, target_kind = $4, pinned_version_id = $5,
             revision = revision + 1
           WHERE installation_id = $6 AND id = $7 AND revision = $8 AND revoked_at IS NULL RETURNING id`,
          [
            command.label,
            JSON.stringify(command.permissions),
            command.expiresAt,
            command.target.kind,
            command.target.kind === "pinned" ? command.target.versionId : null,
            command.installationId,
            command.linkId,
            command.expectedRevision,
          ],
        );
        if (changed.length === 0) return "conflict" as const;
        const updated = yield* findShareLink(command.installationId, command.linkId);
        if (updated === null) return "missing" as const;
        yield* insertPostgresAction(command.installationId, shareLinkAction(
          "share_link_update",
          updated,
          command.versionId,
          command.attribution,
          at,
        ));
        return updated;
      }));
    }));
  }

  async rotateShareLink(
    command: Parameters<ShareLinkRepository["rotateShareLink"]>[0],
  ): ReturnType<ShareLinkRepository["rotateShareLink"]> {
    const at = this.#clock.now().toISOString();
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen(function*() {
        if ((yield* findShareLink(command.installationId, command.linkId)) === null) return "missing" as const;
        const changed = yield* sql.unsafe<object>(
          `UPDATE share_links SET token = $1, generation = generation + 1, revision = revision + 1
           WHERE installation_id = $2 AND id = $3 AND revision = $4 AND revoked_at IS NULL RETURNING id`,
          [command.token, command.installationId, command.linkId, command.expectedRevision],
        );
        if (changed.length === 0) return "conflict" as const;
        const rotated = yield* findShareLink(command.installationId, command.linkId);
        if (rotated === null) return "missing" as const;
        yield* insertPostgresAction(command.installationId, shareLinkAction(
          "share_link_rotate",
          rotated,
          command.versionId,
          command.attribution,
          at,
        ));
        return rotated;
      }));
    }));
  }

  async revokeShareLink(
    command: Parameters<ShareLinkRepository["revokeShareLink"]>[0],
  ): ReturnType<ShareLinkRepository["revokeShareLink"]> {
    const at = this.#clock.now().toISOString();
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen(function*() {
        const existing = yield* findShareLink(command.installationId, command.linkId);
        if (existing === null) return "missing" as const;
        if (existing.revokedAt !== null) return existing;
        yield* revokeLink(command.installationId, existing, command.versionId, command.attribution, at);
        return (yield* findShareLink(command.installationId, command.linkId)) ?? existing;
      }));
    }));
  }

  async revokeArtifactShareLinks(
    command: Parameters<ShareLinkRepository["revokeArtifactShareLinks"]>[0],
  ): ReturnType<ShareLinkRepository["revokeArtifactShareLinks"]> {
    const at = this.#clock.now().toISOString();
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen(function*() {
        const rows = yield* sql.unsafe<object>(
          `SELECT ${shareLinkSelectColumns} FROM share_links l
           WHERE l.installation_id = $1 AND l.project_id = $2 AND l.artifact_id = $3 AND l.revoked_at IS NULL
           FOR UPDATE OF l`,
          [command.installationId, command.projectId, command.artifactId],
        );
        const active = rows.map((row) => shareLinkFromRow(shareLinkRowSchema.parse(row)));
        for (const link of active) {
          yield* revokeLink(command.installationId, link, command.versionId, command.attribution, at);
        }
        return active.length;
      }));
    }));
  }

  async findShareLink(installationId: string, linkId: string): Promise<ShareLink | null> {
    return this.#database.run(findShareLink(installationId, linkId));
  }

  async findShareLinkByToken(token: string): ReturnType<ShareLinkRepository["findShareLinkByToken"]> {
    const rows = await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.unsafe<object>(
        `SELECT ${shareLinkSelectColumns}, l.installation_id AS "installationId"
         FROM share_links l WHERE l.token = $1`,
        [token],
      );
    }));
    if (rows[0] === undefined) return null;
    const {installationId} = z.object({installationId: z.string()}).parse(rows[0]);
    return {...shareLinkFromRow(shareLinkRowSchema.parse(rows[0])), installationId};
  }

  async listArtifactShareLinks(installationId: string, projectId: string, artifactId: string): Promise<readonly ShareLink[]> {
    const rows = await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.unsafe<object>(
        `SELECT ${shareLinkSelectColumns} FROM share_links l
         WHERE l.installation_id = $1 AND l.project_id = $2 AND l.artifact_id = $3
         ORDER BY l.created_at, l.id`,
        [installationId, projectId, artifactId],
      );
    }));
    return rows.map((row) => shareLinkFromRow(shareLinkRowSchema.parse(row)));
  }

  async listActiveShareLinks(
    command: Parameters<ShareLinkRepository["listActiveShareLinks"]>[0],
  ): ReturnType<ShareLinkRepository["listActiveShareLinks"]> {
    const rows = await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.unsafe<object>(
        `SELECT ${shareLinkSelectColumns} FROM share_links l
         WHERE l.installation_id = $1 AND l.revoked_at IS NULL
           AND (l.expires_at IS NULL OR l.expires_at > $2)
           AND ($3::text IS NULL OR l.created_at < $3 OR (l.created_at = $3 AND l.id < $4))
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT $5`,
        [command.installationId, command.now, command.cursor?.createdAt ?? null, command.cursor?.id ?? null, command.limit + 1],
      );
    }));
    const links = rows.map((row) => shareLinkFromRow(shareLinkRowSchema.parse(row)));
    const items = links.slice(0, command.limit);
    const last = items.at(-1);
    const nextCursor: PageCursor | null = links.length > command.limit && last !== undefined
      ? {createdAt: last.createdAt, id: last.id}
      : null;
    return {items, nextCursor};
  }

  async createGuest(
    command: Parameters<ShareLinkRepository["createGuest"]>[0],
  ): ReturnType<ShareLinkRepository["createGuest"]> {
    await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.withTransaction(Effect.gen(function*() {
        const link = yield* findShareLink(command.installationId, command.guest.shareLinkId);
        if (link === null) throw new Error("A guest needs an existing share link.");
        yield* sql.unsafe(
          `INSERT INTO guest_principals
             (installation_id, id, share_link_id, generation, display_name, contact_email, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            command.installationId,
            command.guest.id,
            command.guest.shareLinkId,
            command.guest.generation,
            command.guest.displayName,
            command.guest.contactEmail,
            command.guest.createdAt,
          ],
        );
        yield* sql.unsafe(
          `INSERT INTO guest_sessions
             (installation_id, id, guest_id, share_link_id, token_digest, csrf_digest, created_at, expires_at, revoked_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            command.installationId,
            command.session.id,
            command.guest.id,
            command.guest.shareLinkId,
            command.session.tokenDigest,
            command.session.csrfDigest,
            command.guest.createdAt,
            command.session.expiresAt,
            command.session.revokedAt,
          ],
        );
        yield* insertPostgresAction(
          command.installationId,
          guestJoinAction(command.guest, link, command.versionId, command.attribution),
        );
      }));
    }));
  }

  async findGuestSession(
    installationId: string,
    tokenDigest: string,
  ): ReturnType<ShareLinkRepository["findGuestSession"]> {
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT ${guestSessionSelectColumns}, ${guestSelectColumns}
         FROM guest_sessions s JOIN guest_principals g
           ON g.installation_id = s.installation_id AND g.id = s.guest_id
         WHERE s.installation_id = $1 AND s.token_digest = $2`,
        [installationId, tokenDigest],
      );
      if (rows[0] === undefined) return null;
      const guest = guestFromRow(guestRowSchema.parse(rows[0]));
      const link = yield* findShareLink(installationId, guest.shareLinkId);
      if (link === null) return null;
      const session = guestSessionRowSchema.parse(rows[0]);
      return {
        guest,
        link,
        session: {
          csrfDigest: session.csrfDigest,
          expiresAt: session.sessionExpiresAt,
          guestId: session.sessionGuestId,
          id: session.sessionId,
          revokedAt: session.sessionRevokedAt,
        },
      };
    }));
  }

  async findGuest(installationId: string, guestId: string): ReturnType<ShareLinkRepository["findGuest"]> {
    return this.#database.run(Effect.gen(function*() {
      const guest = yield* findGuestRecord(installationId, guestId);
      if (guest === null) return null;
      const link = yield* findShareLink(installationId, guest.shareLinkId);
      return link === null ? null : {guest, link};
    }));
  }

  async setGuestIdentity(
    command: Parameters<ShareLinkRepository["setGuestIdentity"]>[0],
  ): ReturnType<ShareLinkRepository["setGuestIdentity"]> {
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        `UPDATE guest_principals SET display_name = $1, contact_email = $2
         WHERE installation_id = $3 AND id = $4`,
        [command.displayName, command.contactEmail, command.installationId, command.guestId],
      );
      const guest: GuestRecord | null = yield* findGuestRecord(command.installationId, command.guestId);
      if (guest === null) return yield* Effect.die(new Error("The guest does not exist."));
      return guest;
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
