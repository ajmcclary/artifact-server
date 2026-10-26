import {z} from "zod";

import type {AccessRepository} from "../../../src/core/access-ports.js";
import type {ActionAttribution} from "../../../src/core/action-attribution.js";
import type {PageCursor} from "../../../src/core/model.js";
import type {ShareLinkRepository} from "../../../src/core/share-link-ports.js";
import type {GuestRecord, ShareLink} from "../../../src/core/share-links.js";
import {defaultAccessPolicy} from "../../../src/core/access-policy.js";
import type {AccessGrant, ProjectAccess} from "../../../src/core/permissions.js";
import type {Clock} from "../../../src/core/ports.js";
import {
  positionalActionInsertSql,
  positionalActionInsertWhereSql,
  positionalActionValues,
  type ActionInsert,
} from "../../../src/storage/action-insert.js";
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
} from "../../../src/storage/access-rows.js";

/**
 * D1 access store. D1 batches cannot branch, so each action row is written only
 * when the guarded statement immediately before it changed exactly one row.
 */
export function createD1AccessRepository(
  database: D1Database,
  clock: Clock,
): AccessRepository & ShareLinkRepository {
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

  const actionStatement = (insert: ActionInsert): D1PreparedStatement =>
    database.prepare(positionalActionInsertSql).bind(...positionalActionValues(insert));

  const findShareLink = async (installationId: string, linkId: string): Promise<ShareLink | null> => {
    const row = await database.prepare(`SELECT ${shareLinkSelectColumns} FROM share_links l
      WHERE l.installation_id = ? AND l.id = ?`).bind(installationId, linkId).first();
    return row === null ? null : shareLinkFromRow(shareLinkRowSchema.parse(row));
  };

  const findGuestRecord = async (installationId: string, guestId: string): Promise<GuestRecord | null> => {
    const row = await database.prepare(`SELECT ${guestSelectColumns} FROM guest_principals g
      WHERE g.installation_id = ? AND g.id = ?`).bind(installationId, guestId).first();
    return row === null ? null : guestFromRow(guestRowSchema.parse(row));
  };

  const revokeStatements = (
    installationId: string,
    link: ShareLink,
    versionId: string,
    attribution: ActionAttribution,
    at: string,
  ): readonly D1PreparedStatement[] => [
    database.prepare(`UPDATE share_links SET revoked_at = ?, revoked_by_principal_id = ?, revision = revision + 1
      WHERE installation_id = ? AND id = ? AND revoked_at IS NULL`)
      .bind(at, attribution.principalId ?? "system", installationId, link.id),
    actionAfterChange(shareLinkAction("share_link_revoke", {...link, revision: link.revision + 1}, versionId, attribution, at)),
  ];

  const shareLinkMethods: ShareLinkRepository = {
    createGuest: async (command) => {
      const link = await findShareLink(command.installationId, command.guest.shareLinkId);
      if (link === null) throw new Error("A guest needs an existing share link.");
      await database.batch([
        database.prepare(`INSERT INTO guest_principals
            (installation_id, id, share_link_id, generation, display_name, contact_email, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
          command.installationId, command.guest.id, command.guest.shareLinkId, command.guest.generation,
          command.guest.displayName, command.guest.contactEmail, command.guest.createdAt,
        ),
        database.prepare(`INSERT INTO guest_sessions
            (installation_id, id, guest_id, share_link_id, token_digest, csrf_digest, created_at, expires_at, revoked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
          command.installationId, command.session.id, command.guest.id, command.guest.shareLinkId,
          command.session.tokenDigest, command.session.csrfDigest, command.guest.createdAt,
          command.session.expiresAt, command.session.revokedAt,
        ),
        actionStatement(guestJoinAction(command.guest, link, command.versionId, command.attribution)),
      ]);
    },
    createShareLink: async (command) => {
      const draft = command.link;
      // The action is built from the values this batch writes; the read-back confirms them.
      const written: ShareLink = {...draft, generation: 0, guestCount: 0, revision: 1, revokedAt: null};
      await database.batch([
        database.prepare(`INSERT INTO share_links (${shareLinkInsertColumns})
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(...shareLinkInsertValues(command.installationId, draft)),
        actionStatement(shareLinkAction("share_link_create", written, command.versionId, command.attribution, draft.createdAt)),
      ]);
      const created = await findShareLink(command.installationId, draft.id);
      if (created === null) throw new Error("The share link was not stored.");
      return created;
    },
    findGuest: async (installationId, guestId) => {
      const guest = await findGuestRecord(installationId, guestId);
      if (guest === null) return null;
      const link = await findShareLink(installationId, guest.shareLinkId);
      return link === null ? null : {guest, link};
    },
    findGuestSession: async (installationId, tokenDigest) => {
      const row = await database.prepare(`SELECT ${guestSessionSelectColumns}, ${guestSelectColumns}
        FROM guest_sessions s JOIN guest_principals g
          ON g.installation_id = s.installation_id AND g.id = s.guest_id
        WHERE s.installation_id = ? AND s.token_digest = ?`).bind(installationId, tokenDigest).first();
      if (row === null) return null;
      const guest = guestFromRow(guestRowSchema.parse(row));
      const link = await findShareLink(installationId, guest.shareLinkId);
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
    },
    findShareLink,
    findShareLinkByToken: async (token) => {
      const row = await database.prepare(`SELECT ${shareLinkSelectColumns}, l.installation_id AS installationId
        FROM share_links l WHERE l.token = ?`).bind(token).first();
      if (row === null) return null;
      const {installationId} = z.object({installationId: z.string()}).parse(row);
      return {...shareLinkFromRow(shareLinkRowSchema.parse(row)), installationId};
    },
    listActiveShareLinks: async (command) => {
      const rows = await database.prepare(`SELECT ${shareLinkSelectColumns} FROM share_links l
        WHERE l.installation_id = ? AND l.revoked_at IS NULL
          AND (l.expires_at IS NULL OR l.expires_at > ?)
          AND (? IS NULL OR l.created_at < ? OR (l.created_at = ? AND l.id < ?))
        ORDER BY l.created_at DESC, l.id DESC LIMIT ?`).bind(
        command.installationId,
        command.now,
        command.cursor?.createdAt ?? null,
        command.cursor?.createdAt ?? null,
        command.cursor?.createdAt ?? null,
        command.cursor?.id ?? null,
        command.limit + 1,
      ).all();
      const links = rows.results.map((row) => shareLinkFromRow(shareLinkRowSchema.parse(row)));
      const items = links.slice(0, command.limit);
      const last = items.at(-1);
      const nextCursor: PageCursor | null = links.length > command.limit && last !== undefined
        ? {createdAt: last.createdAt, id: last.id}
        : null;
      return {items, nextCursor};
    },
    listArtifactShareLinks: async (installationId, projectId, artifactId) => {
      const rows = await database.prepare(`SELECT ${shareLinkSelectColumns} FROM share_links l
        WHERE l.installation_id = ? AND l.project_id = ? AND l.artifact_id = ?
        ORDER BY l.created_at, l.id`).bind(installationId, projectId, artifactId).all();
      return rows.results.map((row) => shareLinkFromRow(shareLinkRowSchema.parse(row)));
    },
    revokeArtifactShareLinks: async (command) => {
      const at = now();
      const rows = await database.prepare(`SELECT ${shareLinkSelectColumns} FROM share_links l
        WHERE l.installation_id = ? AND l.project_id = ? AND l.artifact_id = ? AND l.revoked_at IS NULL`)
        .bind(command.installationId, command.projectId, command.artifactId).all();
      const active = rows.results.map((row) => shareLinkFromRow(shareLinkRowSchema.parse(row)));
      if (active.length === 0) return 0;
      await database.batch(active.flatMap((link) =>
        revokeStatements(command.installationId, link, command.versionId, command.attribution, at)));
      return active.length;
    },
    revokeShareLink: async (command) => {
      const existing = await findShareLink(command.installationId, command.linkId);
      if (existing === null) return "missing";
      if (existing.revokedAt !== null) return existing;
      await database.batch([...revokeStatements(command.installationId, existing, command.versionId, command.attribution, now())]);
      return (await findShareLink(command.installationId, command.linkId)) ?? existing;
    },
    rotateShareLink: async (command) => {
      const existing = await findShareLink(command.installationId, command.linkId);
      if (existing === null) return "missing";
      const written: ShareLink = {
        ...existing,
        generation: existing.generation + 1,
        revision: command.expectedRevision + 1,
        token: command.token,
      };
      const [result] = await database.batch([
        database.prepare(`UPDATE share_links SET token = ?, generation = generation + 1, revision = revision + 1
          WHERE installation_id = ? AND id = ? AND revision = ? AND revoked_at IS NULL`)
          .bind(command.token, command.installationId, command.linkId, command.expectedRevision),
        actionAfterChange(shareLinkAction("share_link_rotate", written, command.versionId, command.attribution, now())),
      ]);
      if (result?.meta.changes !== 1) return "conflict";
      return (await findShareLink(command.installationId, command.linkId)) ?? "missing";
    },
    setGuestIdentity: async (command) => {
      await database.prepare(`UPDATE guest_principals SET display_name = ?, contact_email = ?
        WHERE installation_id = ? AND id = ?`)
        .bind(command.displayName, command.contactEmail, command.installationId, command.guestId).run();
      const guest = await findGuestRecord(command.installationId, command.guestId);
      if (guest === null) throw new Error("The guest does not exist.");
      return guest;
    },
    updateShareLink: async (command) => {
      const existing = await findShareLink(command.installationId, command.linkId);
      if (existing === null) return "missing";
      const written: ShareLink = {
        ...existing,
        expiresAt: command.expiresAt,
        label: command.label,
        permissions: command.permissions,
        revision: command.expectedRevision + 1,
        target: command.target,
      };
      const [result] = await database.batch([
        database.prepare(`UPDATE share_links
          SET label = ?, permissions_json = ?, expires_at = ?, target_kind = ?, pinned_version_id = ?,
            revision = revision + 1
          WHERE installation_id = ? AND id = ? AND revision = ? AND revoked_at IS NULL`).bind(
          command.label,
          JSON.stringify(command.permissions),
          command.expiresAt,
          command.target.kind,
          command.target.kind === "pinned" ? command.target.versionId : null,
          command.installationId,
          command.linkId,
          command.expectedRevision,
        ),
        actionAfterChange(shareLinkAction("share_link_update", written, command.versionId, command.attribution, now())),
      ]);
      if (result?.meta.changes !== 1) return "conflict";
      return (await findShareLink(command.installationId, command.linkId)) ?? "missing";
    },
  };

  return {
    ...shareLinkMethods,
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
