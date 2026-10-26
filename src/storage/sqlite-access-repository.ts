import {DatabaseSync} from "node:sqlite";

import {z} from "zod";

import type {AccessGrantDraft, AccessRepository} from "../core/access-ports.js";
import type {PageCursor} from "../core/model.js";
import type {ShareLinkRepository} from "../core/share-link-ports.js";
import type {GuestRecord, ShareLink} from "../core/share-links.js";
import {defaultAccessPolicy, type StoredAccessPolicy} from "../core/access-policy.js";
import type {AccessGrant, ProjectAccess} from "../core/permissions.js";
import type {Clock} from "../core/ports.js";
import {positionalActionInsertSql, positionalActionValues, type ActionInsert} from "./action-insert.js";
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

const changesOf = (result: {readonly changes: number | bigint}): number => Number(result.changes);

/**
 * SQLite access store. The schema belongs to `SqliteArtifactRepository#migrate`;
 * this class opens its own connection to the same file.
 */
export class SqliteAccessRepository implements AccessRepository, ShareLinkRepository {
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

  async createShareLink(
    command: Parameters<ShareLinkRepository["createShareLink"]>[0],
  ): ReturnType<ShareLinkRepository["createShareLink"]> {
    return this.#transaction(() => {
      this.#database.prepare(
        `INSERT INTO share_links (${shareLinkInsertColumns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(...shareLinkInsertValues(command.installationId, command.link));
      const created = this.#findShareLink(command.installationId, command.link.id);
      if (created === null) throw new Error("The share link was not stored.");
      this.#insertAction(shareLinkAction("share_link_create", created, command.versionId, command.attribution, command.link.createdAt));
      return created;
    });
  }

  async updateShareLink(
    command: Parameters<ShareLinkRepository["updateShareLink"]>[0],
  ): ReturnType<ShareLinkRepository["updateShareLink"]> {
    const at = this.#now();
    return this.#transaction(() => {
      if (this.#findShareLink(command.installationId, command.linkId) === null) return "missing" as const;
      const changed = changesOf(this.#database.prepare(`
        UPDATE share_links
        SET label = ?, permissions_json = ?, expires_at = ?, target_kind = ?, pinned_version_id = ?,
          revision = revision + 1
        WHERE installation_id = ? AND id = ? AND revision = ? AND revoked_at IS NULL
      `).run(
        command.label,
        JSON.stringify(command.permissions),
        command.expiresAt,
        command.target.kind,
        command.target.kind === "pinned" ? command.target.versionId : null,
        command.installationId,
        command.linkId,
        command.expectedRevision,
      ));
      if (changed === 0) return "conflict" as const;
      const updated = this.#findShareLink(command.installationId, command.linkId);
      if (updated === null) return "missing" as const;
      this.#insertAction(shareLinkAction("share_link_update", updated, command.versionId, command.attribution, at));
      return updated;
    });
  }

  async rotateShareLink(
    command: Parameters<ShareLinkRepository["rotateShareLink"]>[0],
  ): ReturnType<ShareLinkRepository["rotateShareLink"]> {
    const at = this.#now();
    return this.#transaction(() => {
      if (this.#findShareLink(command.installationId, command.linkId) === null) return "missing" as const;
      const changed = changesOf(this.#database.prepare(`
        UPDATE share_links SET token = ?, generation = generation + 1, revision = revision + 1
        WHERE installation_id = ? AND id = ? AND revision = ? AND revoked_at IS NULL
      `).run(command.token, command.installationId, command.linkId, command.expectedRevision));
      if (changed === 0) return "conflict" as const;
      const rotated = this.#findShareLink(command.installationId, command.linkId);
      if (rotated === null) return "missing" as const;
      this.#insertAction(shareLinkAction("share_link_rotate", rotated, command.versionId, command.attribution, at));
      return rotated;
    });
  }

  async revokeShareLink(
    command: Parameters<ShareLinkRepository["revokeShareLink"]>[0],
  ): ReturnType<ShareLinkRepository["revokeShareLink"]> {
    const at = this.#now();
    return this.#transaction(() => {
      const existing = this.#findShareLink(command.installationId, command.linkId);
      if (existing === null) return "missing" as const;
      if (existing.revokedAt !== null) return existing;
      this.#revoke(command.installationId, existing, command.versionId, command.attribution, at);
      return this.#findShareLink(command.installationId, command.linkId) ?? existing;
    });
  }

  async revokeArtifactShareLinks(
    command: Parameters<ShareLinkRepository["revokeArtifactShareLinks"]>[0],
  ): ReturnType<ShareLinkRepository["revokeArtifactShareLinks"]> {
    const at = this.#now();
    return this.#transaction(() => {
      const active = this.#database.prepare(`
        SELECT ${shareLinkSelectColumns} FROM share_links l
        WHERE l.installation_id = ? AND l.project_id = ? AND l.artifact_id = ? AND l.revoked_at IS NULL
      `).all(command.installationId, command.projectId, command.artifactId)
        .map((row) => shareLinkFromRow(shareLinkRowSchema.parse(row)));
      for (const link of active) this.#revoke(command.installationId, link, command.versionId, command.attribution, at);
      return active.length;
    });
  }

  async findShareLink(installationId: string, linkId: string): Promise<ShareLink | null> {
    return this.#findShareLink(installationId, linkId);
  }

  async findShareLinkByToken(token: string): ReturnType<ShareLinkRepository["findShareLinkByToken"]> {
    const row = this.#database.prepare(`
      SELECT ${shareLinkSelectColumns}, l.installation_id AS "installationId"
      FROM share_links l WHERE l.token = ?
    `).get(token);
    if (row === undefined) return null;
    const {installationId} = z.object({installationId: z.string()}).parse(row);
    return {...shareLinkFromRow(shareLinkRowSchema.parse(row)), installationId};
  }

  async listArtifactShareLinks(installationId: string, projectId: string, artifactId: string): Promise<readonly ShareLink[]> {
    return this.#database.prepare(`
      SELECT ${shareLinkSelectColumns} FROM share_links l
      WHERE l.installation_id = ? AND l.project_id = ? AND l.artifact_id = ?
      ORDER BY l.created_at, l.id
    `).all(installationId, projectId, artifactId).map((row) => shareLinkFromRow(shareLinkRowSchema.parse(row)));
  }

  async listActiveShareLinks(
    command: Parameters<ShareLinkRepository["listActiveShareLinks"]>[0],
  ): ReturnType<ShareLinkRepository["listActiveShareLinks"]> {
    const rows = this.#database.prepare(`
      SELECT ${shareLinkSelectColumns} FROM share_links l
      WHERE l.installation_id = ? AND l.revoked_at IS NULL
        AND (l.expires_at IS NULL OR l.expires_at > ?)
        AND (? IS NULL OR l.created_at < ? OR (l.created_at = ? AND l.id < ?))
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT ?
    `).all(
      command.installationId,
      command.now,
      command.cursor?.createdAt ?? null,
      command.cursor?.createdAt ?? null,
      command.cursor?.createdAt ?? null,
      command.cursor?.id ?? null,
      command.limit + 1,
    ).map((row) => shareLinkFromRow(shareLinkRowSchema.parse(row)));
    const items = rows.slice(0, command.limit);
    const last = items.at(-1);
    const nextCursor: PageCursor | null = rows.length > command.limit && last !== undefined
      ? {createdAt: last.createdAt, id: last.id}
      : null;
    return {items, nextCursor};
  }

  async createGuest(
    command: Parameters<ShareLinkRepository["createGuest"]>[0],
  ): ReturnType<ShareLinkRepository["createGuest"]> {
    this.#transaction(() => {
      const link = this.#findShareLink(command.installationId, command.guest.shareLinkId);
      if (link === null) throw new Error("A guest needs an existing share link.");
      this.#database.prepare(`
        INSERT INTO guest_principals
          (installation_id, id, share_link_id, generation, display_name, contact_email, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        command.installationId,
        command.guest.id,
        command.guest.shareLinkId,
        command.guest.generation,
        command.guest.displayName,
        command.guest.contactEmail,
        command.guest.createdAt,
      );
      this.#database.prepare(`
        INSERT INTO guest_sessions
          (installation_id, id, guest_id, share_link_id, token_digest, csrf_digest, created_at, expires_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        command.installationId,
        command.session.id,
        command.guest.id,
        command.guest.shareLinkId,
        command.session.tokenDigest,
        command.session.csrfDigest,
        command.guest.createdAt,
        command.session.expiresAt,
        command.session.revokedAt,
      );
      this.#insertAction(guestJoinAction(command.guest, link, command.versionId, command.attribution));
    });
  }

  async findGuestSession(
    installationId: string,
    tokenDigest: string,
  ): ReturnType<ShareLinkRepository["findGuestSession"]> {
    const row = this.#database.prepare(`
      SELECT ${guestSessionSelectColumns}, ${guestSelectColumns}
      FROM guest_sessions s JOIN guest_principals g
        ON g.installation_id = s.installation_id AND g.id = s.guest_id
      WHERE s.installation_id = ? AND s.token_digest = ?
    `).get(installationId, tokenDigest);
    if (row === undefined) return null;
    const guest = guestFromRow(guestRowSchema.parse(row));
    const link = this.#findShareLink(installationId, guest.shareLinkId);
    if (link === null) return null;
    const session = guestSessionRowSchema.parse(row);
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
  }

  async findGuest(installationId: string, guestId: string): ReturnType<ShareLinkRepository["findGuest"]> {
    const guest = this.#findGuest(installationId, guestId);
    if (guest === null) return null;
    const link = this.#findShareLink(installationId, guest.shareLinkId);
    return link === null ? null : {guest, link};
  }

  async setGuestIdentity(
    command: Parameters<ShareLinkRepository["setGuestIdentity"]>[0],
  ): ReturnType<ShareLinkRepository["setGuestIdentity"]> {
    this.#database.prepare(`
      UPDATE guest_principals SET display_name = ?, contact_email = ?
      WHERE installation_id = ? AND id = ?
    `).run(command.displayName, command.contactEmail, command.installationId, command.guestId);
    const guest = this.#findGuest(command.installationId, command.guestId);
    if (guest === null) throw new Error("The guest does not exist.");
    return guest;
  }

  #revoke(
    installationId: string,
    link: ShareLink,
    versionId: string,
    attribution: Parameters<ShareLinkRepository["revokeShareLink"]>[0]["attribution"],
    at: string,
  ): void {
    this.#database.prepare(`
      UPDATE share_links SET revoked_at = ?, revoked_by_principal_id = ?, revision = revision + 1
      WHERE installation_id = ? AND id = ? AND revoked_at IS NULL
    `).run(at, attribution.principalId ?? "system", installationId, link.id);
    this.#insertAction(shareLinkAction(
      "share_link_revoke",
      {...link, revision: link.revision + 1},
      versionId,
      attribution,
      at,
    ));
  }

  #findShareLink(installationId: string, linkId: string): ShareLink | null {
    const row = this.#database.prepare(`
      SELECT ${shareLinkSelectColumns} FROM share_links l WHERE l.installation_id = ? AND l.id = ?
    `).get(installationId, linkId);
    return row === undefined ? null : shareLinkFromRow(shareLinkRowSchema.parse(row));
  }

  #findGuest(installationId: string, guestId: string): GuestRecord | null {
    const row = this.#database.prepare(`
      SELECT ${guestSelectColumns} FROM guest_principals g WHERE g.installation_id = ? AND g.id = ?
    `).get(installationId, guestId);
    return row === undefined ? null : guestFromRow(guestRowSchema.parse(row));
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
