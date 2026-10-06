import {z} from "zod";

import type {
  CreateInviteRecord,
  InvitationRepository,
  RedeemInviteRecord,
  RedeemInviteResult,
  RevokeInviteRecord,
} from "../../../src/core/invitation-ports.js";
import {
  inviteStatus,
  inviteStatuses,
  redemptionRefusal,
  type StoredInvite,
} from "../../../src/core/invitations.js";
import {
  inviteAdmitAction,
  inviteCreateAction,
  inviteInsertColumns,
  inviteInsertValues,
  inviteRedeemAction,
  inviteRevokeAction,
  inviteRowSchema,
  inviteSelectColumns,
  listedInviteFromRow,
  listedInviteRowSchema,
  storedInviteFromRow,
  withoutInviteDigest,
} from "../../../src/storage/invitation-rows.js";

import type {ActionAttribution} from "../../../src/core/action-attribution.js";
import {memberAdmissions} from "../../../src/core/identity-ports.js";
import {principalActivityThreshold} from "../../../src/core/principal-activity.js";
import {
  type ActionInsert,
  attributedInsert,
  positionalActionInsertSql,
  positionalActionInsertWhereSql,
  positionalActionValues,
} from "../../../src/storage/action-insert.js";

import {
  IdentityConflict,
  IdentityNotFound,
  LoginAttemptRejected,
} from "../../../src/core/errors.js";
import type {
  AdmitMemberRecord,
  BindExternalIdentityRecord,
  CreateApplicationSessionRecord,
  IdentityRepository,
} from "../../../src/core/identity-ports.js";
import {
  type ApplicationSession,
  type InstallationMember,
  type ListedApiKey,
  type ListedMember,
  type LoginAttempt,
  type ManagedApiKey,
  memberStatuses,
  type StoredManagedApiKey,
} from "../../../src/core/installation-identity.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
} from "../../../src/core/identity.js";

const membershipRoleSchema = z.enum([
  membershipRoles.administrator,
  membershipRoles.member,
]);
const memberStatusSchema = z.enum([
  memberStatuses.active,
  memberStatuses.inactive,
]);
const principalKindSchema = z.enum([
  principalKinds.human,
  principalKinds.service,
]);
const principalCapabilitySchema = z.enum([
  principalCapabilities.connectAgents,
  principalCapabilities.createArtifact,
  principalCapabilities.issueContentSession,
  principalCapabilities.manageAnyArtifact,
  principalCapabilities.manageProjects,
  principalCapabilities.publishAnyArtifact,
  principalCapabilities.readArtifacts,
  principalCapabilities.writeComments,
]);
const memberRowSchema = z.object({
  createdAt: z.string(),
  displayName: z.string(),
  email: z.string(),
  id: z.string(),
  installationId: z.string(),
  role: membershipRoleSchema,
  status: memberStatusSchema,
  updatedAt: z.string(),
});
const listedMemberRowSchema = memberRowSchema.extend({
  admittedHow: z.enum([
    memberAdmissions.automatic,
    memberAdmissions.invite,
    memberAdmissions.manual,
    memberAdmissions.owner,
  ]).nullable(),
  admittedByName: z.string().nullable(),
  lastActiveAt: z.string().nullable(),
});
const sessionRowSchema = z.object({
  createdAt: z.string(),
  csrfDigest: z.string(),
  expiresAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  memberCreatedAt: z.string(),
  memberDisplayName: z.string(),
  memberEmail: z.string(),
  memberId: z.string(),
  memberRole: membershipRoleSchema,
  memberStatus: memberStatusSchema,
  memberUpdatedAt: z.string(),
  revokedAt: z.string().nullable(),
  tokenDigest: z.string(),
});
const apiKeyRowSchema = z.object({
  authorizedByPrincipalId: z.string(),
  capabilitiesJson: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  name: z.string(),
  prefix: z.string(),
  principalId: z.string(),
  principalKind: principalKindSchema,
  revokedAt: z.string().nullable(),
  rotatedFromId: z.string().nullable(),
  secretDigest: z.string(),
});
const listedApiKeyRowSchema = z.object({
  lastUsedAt: z.string().nullable(),
  ownerName: z.string().nullable(),
  revokedByName: z.string().nullable(),
});
const loginAttemptRowSchema = z.object({
  codeVerifier: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  inviteId: z.string().nullable(),
  nonce: z.string().nullable(),
  provider: z.string(),
  returnTo: z.string(),
  stateDigest: z.string(),
});
const presenceRowSchema = z.object({present: z.union([z.literal(0), z.literal(1)])});

const memberSelect = `
  SELECT id, installation_id AS installationId, email,
    display_name AS displayName, role, status,
    created_at AS createdAt, updated_at AS updatedAt
  FROM installation_members
`;
const apiKeySelect = `
  SELECT id, installation_id AS installationId, name, prefix,
    secret_digest AS secretDigest, principal_id AS principalId,
    principal_kind AS principalKind, capabilities_json AS capabilitiesJson,
    authorized_by_principal_id AS authorizedByPrincipalId,
    created_at AS createdAt, expires_at AS expiresAt,
    revoked_at AS revokedAt, rotated_from_id AS rotatedFromId
  FROM managed_api_keys
`;

/** Build the installation identity repository over one D1 binding. */
/** The `key_issue` activity row written beside every new key. */
const keyIssueAction = (
  key: StoredManagedApiKey,
  attribution: ActionAttribution,
): ActionInsert => attributedInsert(attribution, {
  action: "key_issue",
  createdAt: key.createdAt,
  detail: {
    capabilities: key.capabilities,
    how: "administrator",
    ownerPrincipalId: key.principalId,
    subjectName: key.name,
  },
  idempotencyKey: `key_issue:${key.id}`,
  projectId: null,
  subjectId: key.id,
});

export function createD1IdentityRepository(
  database: D1Database,
): IdentityRepository & InvitationRepository {
  const findMember = async (
    installationId: string,
    memberId: string,
  ): Promise<InstallationMember | null> => {
    const row = await database.prepare(`${memberSelect}
      WHERE installation_id = ? AND id = ?
    `).bind(installationId, memberId)
      .first<z.input<typeof memberRowSchema>>();
    return row === null ? null : memberRowSchema.parse(row);
  };

  const findApiKey = async (
    installationId: string,
    keyId: string,
  ): Promise<StoredManagedApiKey | null> => {
    const row = await database.prepare(`${apiKeySelect}
      WHERE installation_id = ? AND id = ?
    `).bind(installationId, keyId)
      .first<z.input<typeof apiKeyRowSchema>>();
    return row === null ? null : parseApiKey(row);
  };

  const insertApiKey = (key: StoredManagedApiKey): D1PreparedStatement =>
    database.prepare(`
      INSERT INTO managed_api_keys (
        id, installation_id, name, prefix, secret_digest, principal_id,
        principal_kind, capabilities_json, authorized_by_principal_id,
        created_at, expires_at, revoked_at, rotated_from_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      key.id,
      key.installationId,
      key.name,
      key.prefix,
      key.secretDigest,
      key.principalId,
      key.principalKind,
      JSON.stringify(key.capabilities),
      key.authorizedByPrincipalId,
      key.createdAt,
      key.expiresAt,
      key.revokedAt,
      key.rotatedFromId,
    );

  const actionStatement = (insert: ActionInsert): D1PreparedStatement =>
    database.prepare(positionalActionInsertSql).bind(...positionalActionValues(insert));
  const actionWhenStatement = (
    insert: ActionInsert,
    condition: string,
    bindings: readonly (string | null)[],
  ): D1PreparedStatement =>
    database.prepare(positionalActionInsertWhereSql(condition))
      .bind(...positionalActionValues(insert), ...bindings);

  const findInvite = async (installationId: string, inviteId: string): Promise<StoredInvite | null> => {
    const row = await database.prepare(`SELECT ${inviteSelectColumns("i")}
      FROM installation_invites AS i WHERE i.installation_id = ? AND i.id = ?`)
      .bind(installationId, inviteId).first();
    return row === null ? null : storedInviteFromRow(inviteRowSchema.parse(row));
  };

  return {
    createInvite: async (record: CreateInviteRecord) => {
      await database.batch([
        database.prepare(`INSERT INTO installation_invites (${inviteInsertColumns})
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(...inviteInsertValues(record.invite)),
        actionStatement(inviteCreateAction(record.invite, record.attribution)),
      ]);
      return withoutInviteDigest(record.invite);
    },

    findInvite: async (installationId: string, inviteId: string) => findInvite(installationId, inviteId),

    listInvites: async (installationId: string) => {
      const rows = await database.prepare(`
        SELECT ${inviteSelectColumns("i")}, creator.display_name AS "createdByName"
        FROM installation_invites AS i
        LEFT JOIN installation_members AS creator
          ON creator.installation_id = i.installation_id AND creator.id = i.created_by_principal_id
        WHERE i.installation_id = ?
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT 200
      `).bind(installationId).all();
      return rows.results.map((row) => listedInviteFromRow(listedInviteRowSchema.parse(row)));
    },

    revokeInvite: async (record: RevokeInviteRecord) => {
      const existing = await findInvite(record.installationId, record.inviteId);
      if (existing === null) throw new IdentityNotFound({message: "The invite does not exist."});
      if (inviteStatus(existing, new Date(record.revokedAt)) !== inviteStatuses.active) {
        throw new IdentityConflict({message: "Only an active invite can be revoked."});
      }
      const [updated] = await database.batch([
        database.prepare(`UPDATE installation_invites
          SET revoked_at = ?, revoked_by_principal_id = ?
          WHERE installation_id = ? AND id = ? AND revoked_at IS NULL`)
          .bind(record.revokedAt, record.attribution.principalId, record.installationId, record.inviteId),
        actionWhenStatement(
          inviteRevokeAction(existing, record.attribution, record.revokedAt),
          "EXISTS (SELECT 1 FROM installation_invites WHERE installation_id = ? AND id = ? AND revoked_at = ?)",
          [record.installationId, record.inviteId, record.revokedAt],
        ),
      ]);
      if (updated?.meta.changes !== 1) {
        throw new IdentityConflict({message: "Only an active invite can be revoked."});
      }
      const revoked = await findInvite(record.installationId, record.inviteId);
      if (revoked === null) throw new Error("The revoked invite was not persisted.");
      return withoutInviteDigest(revoked);
    },

    redeemInvite: async (record: RedeemInviteRecord): Promise<RedeemInviteResult> => {
      const {admission} = record;
      const invite = await findInvite(admission.installationId, record.inviteId);
      const refusal = redemptionRefusal(invite, record.email, record.redeemedAt);
      if (invite === null || refusal !== null) {
        return {kind: "refused", outcome: refusal === null || refusal === "unverified" ? "invalid" : refusal};
      }
      // D1 batches cannot branch: every later statement runs only if this
      // batch's guarded UPDATE recorded the new member as the latest redeemer.
      const redeemed = "EXISTS (SELECT 1 FROM installation_invites WHERE installation_id = ? AND id = ? AND last_redeemed_member_id = ?)";
      const redeemedBindings = [admission.installationId, record.inviteId, admission.id];
      try {
        const [updated] = await database.batch([
          database.prepare(`UPDATE installation_invites
            SET use_count = use_count + 1, last_redeemed_member_id = ?
            WHERE installation_id = ? AND id = ? AND revoked_at IS NULL
              AND expires_at > ? AND use_count < max_uses
              AND (kind = 'link' OR email = ?)`)
            .bind(admission.id, admission.installationId, record.inviteId, record.redeemedAt, record.email),
          database.prepare(`INSERT INTO installation_members (
              id, installation_id, email, display_name, role, status,
              created_at, updated_at, admitted_by_principal_id, admission_method
            ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${redeemed}`)
            .bind(
              admission.id, admission.installationId, admission.email, admission.displayName,
              admission.role, memberStatuses.active, admission.createdAt, admission.createdAt,
              admission.attribution.principalId, admission.admittedHow, ...redeemedBindings,
            ),
          actionWhenStatement(inviteAdmitAction(admission, invite.id), redeemed, redeemedBindings),
          database.prepare(`INSERT INTO external_identities (provider, subject, member_id, email, bound_at)
            SELECT ?, ?, ?, ?, ? WHERE ${redeemed}`)
            .bind(
              record.binding.provider, record.binding.subject, record.binding.memberId,
              record.binding.email, record.binding.boundAt, ...redeemedBindings,
            ),
          actionWhenStatement(inviteRedeemAction(invite, admission, record.redeemedAt), redeemed, redeemedBindings),
        ]);
        if (updated?.meta.changes !== 1) {
          const current = await findInvite(admission.installationId, record.inviteId);
          const outcome = redemptionRefusal(current, record.email, record.redeemedAt);
          return {kind: "refused", outcome: outcome === null || outcome === "unverified" ? "used" : outcome};
        }
      } catch (cause) {
        if (cause instanceof Error && isD1Constraint(cause)) {
          return {kind: "refused", outcome: "account_unavailable"};
        }
        throw cause;
      }
      const member = await findMember(admission.installationId, admission.id);
      if (member === null) throw new Error("The admitted member was not persisted.");
      return {kind: "admitted", member};
    },

    admitMember: async (command: AdmitMemberRecord) => {
      try {
        await database.batch([
          database.prepare(`
            INSERT INTO installation_members (
              id, installation_id, email, display_name, role, status,
              created_at, updated_at, admitted_by_principal_id, admission_method
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            command.id,
            command.installationId,
            command.email,
            command.displayName,
            command.role,
            memberStatuses.active,
            command.createdAt,
            command.createdAt,
            command.attribution.principalId,
            command.admittedHow,
          ),
          actionStatement(attributedInsert(command.attribution, {
            action: "member_admit",
            createdAt: command.createdAt,
            detail: {how: command.admittedHow, role: command.role, subjectName: command.displayName},
            idempotencyKey: `member_admit:${command.id}`,
            projectId: null,
            subjectId: command.id,
          })),
        ]);
      } catch (cause) {
        if (cause instanceof Error && isD1Constraint(cause)) {
          throw new IdentityConflict({
            message: "That email is already admitted to this installation.",
          });
        }
        throw cause;
      }
      const member = await findMember(command.installationId, command.id);
      if (member === null) throw new Error("The admitted member was not persisted.");
      return member;
    },

    bindExternalIdentity: async (command: BindExternalIdentityRecord) => {
      try {
        const result = await database.prepare(`
          INSERT INTO external_identities (
            provider, subject, member_id, email, bound_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(provider, subject) DO UPDATE SET
            email = excluded.email,
            bound_at = excluded.bound_at
          WHERE external_identities.member_id = excluded.member_id
        `).bind(
          command.provider,
          command.subject,
          command.memberId,
          command.email,
          command.boundAt,
        ).run();
        if (result.meta.changes !== 1) {
          throw new IdentityConflict({
            message: "That external identity is already bound to another member.",
          });
        }
      } catch (cause) {
        if (cause instanceof IdentityConflict) throw cause;
        if (cause instanceof Error && isD1Constraint(cause)) {
          throw new IdentityConflict({
            message: "That external identity is already bound to another member.",
          });
        }
        throw cause;
      }
    },

    consumeLoginAttempt: async (stateDigest, provider, consumedAt) => {
      const results = await database.batch([
        database.prepare(`
          UPDATE login_attempts SET consumed_at = ?
          WHERE state_digest = ? AND provider = ? AND consumed_at IS NULL
            AND expires_at > ?
        `).bind(consumedAt, stateDigest, provider, consumedAt),
        database.prepare(`
          SELECT state_digest AS stateDigest, provider,
            code_verifier AS codeVerifier, nonce, invite_id AS inviteId,
            return_to AS returnTo,
            created_at AS createdAt, expires_at AS expiresAt
          FROM login_attempts
          WHERE state_digest = ? AND provider = ? AND consumed_at = ?
        `).bind(stateDigest, provider, consumedAt),
      ]);
      const update = results[0];
      const read = results[1];
      if (update === undefined || read === undefined || update.meta.changes !== 1) {
        throw new LoginAttemptRejected({
          message: "The browser login attempt is invalid or no longer active.",
        });
      }
      const row = read.results[0];
      if (row === undefined) {
        throw new LoginAttemptRejected({
          message: "The browser login attempt was already used.",
        });
      }
      return loginAttemptRowSchema.parse(row);
    },

    createApiKey: async (key, attribution) => {
      await database.batch([insertApiKey(key), actionStatement(keyIssueAction(key, attribution))]);
      return withoutSecretDigest(key);
    },

    createApplicationSession: async (command: CreateApplicationSessionRecord) => {
      await database.prepare(`
        INSERT INTO application_sessions (
          id, installation_id, member_id, token_digest, csrf_digest,
          created_at, expires_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      `).bind(
        command.id,
        command.installationId,
        command.memberId,
        command.tokenDigest,
        command.csrfDigest,
        command.createdAt,
        command.expiresAt,
      ).run();
      const session = await findApplicationSession(
        database,
        command.installationId,
        command.tokenDigest,
        command.createdAt,
      );
      if (session === null) throw new Error("The application session was not persisted.");
      return session;
    },

    createLoginAttempt: async (attempt: LoginAttempt) => {
      // `/auth/login` is unauthenticated, so every insert clears the attempts
      // that can no longer be consumed instead of growing the table forever.
      await database.prepare(`
        DELETE FROM login_attempts WHERE expires_at <= ?
      `).bind(attempt.createdAt).run();
      await database.prepare(`
        INSERT INTO login_attempts (
          state_digest, provider, code_verifier, nonce, invite_id, return_to,
          created_at, expires_at, consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).bind(
        attempt.stateDigest,
        attempt.provider,
        attempt.codeVerifier,
        attempt.nonce,
        attempt.inviteId,
        attempt.returnTo,
        attempt.createdAt,
        attempt.expiresAt,
      ).run();
    },

    deactivateMember: async (installationId, memberId, updatedAt, attribution) => {
      const existing = await findMember(installationId, memberId);
      if (existing === null) {
        throw new IdentityNotFound({message: "The member does not exist."});
      }
      const results = await database.batch([
        database.prepare(`
          UPDATE installation_members
          SET status = ?, updated_at = ?
          WHERE installation_id = ? AND id = ? AND (
            status <> ? OR role <> ? OR (
              SELECT COUNT(*) FROM installation_members
              WHERE installation_id = ? AND role = ? AND status = ?
            ) > 1
          )
        `).bind(
          memberStatuses.inactive,
          updatedAt,
          installationId,
          memberId,
          memberStatuses.active,
          membershipRoles.administrator,
          installationId,
          membershipRoles.administrator,
          memberStatuses.active,
        ),
        database.prepare(`
          UPDATE application_sessions
          SET revoked_at = COALESCE(revoked_at, ?)
          WHERE installation_id = ? AND member_id = ?
            AND EXISTS (
              SELECT 1 FROM installation_members
              WHERE installation_id = ? AND id = ? AND status = ? AND updated_at = ?
            )
        `).bind(
          updatedAt,
          installationId,
          memberId,
          installationId,
          memberId,
          memberStatuses.inactive,
          updatedAt,
        ),
        database.prepare(`
          UPDATE managed_api_keys
          SET revoked_at = COALESCE(revoked_at, ?)
          WHERE installation_id = ? AND principal_kind = ? AND principal_id = ?
            AND EXISTS (
              SELECT 1 FROM installation_members
              WHERE installation_id = ? AND id = ? AND status = ? AND updated_at = ?
            )
        `).bind(
          updatedAt,
          installationId,
          principalKinds.human,
          memberId,
          installationId,
          memberId,
          memberStatuses.inactive,
          updatedAt,
        ),
        // Written only when an active member was just deactivated by this batch.
        ...(existing.status === memberStatuses.active
          ? [actionWhenStatement(
            attributedInsert(attribution, {
              action: "member_deactivate",
              createdAt: updatedAt,
              detail: {subjectName: existing.displayName},
              idempotencyKey: `member_deactivate:${memberId}:${updatedAt}`,
              projectId: null,
              subjectId: memberId,
            }),
            `EXISTS (
              SELECT 1 FROM installation_members
              WHERE installation_id = ? AND id = ? AND status = ? AND updated_at = ?
            )`,
            [installationId, memberId, memberStatuses.inactive, updatedAt],
          )]
          : []),
      ]);
      if (results[0]?.meta.changes !== 1) {
        throw new IdentityConflict({
          message: "The installation must retain one active administrator.",
        });
      }
      return {...existing, status: memberStatuses.inactive, updatedAt};
    },

    findActiveMemberByEmail: async (installationId, email) => {
      const row = await database.prepare(`${memberSelect}
        WHERE installation_id = ? AND email = ? AND status = ?
      `).bind(installationId, email, memberStatuses.active)
        .first<z.input<typeof memberRowSchema>>();
      return row === null ? null : memberRowSchema.parse(row);
    },

    findActiveMemberByExternalIdentity: async (
      installationId,
      provider,
      subject,
    ) => {
      const row = await database.prepare(`
        SELECT member.id, member.installation_id AS installationId,
          member.email, member.display_name AS displayName, member.role,
          member.status, member.created_at AS createdAt,
          member.updated_at AS updatedAt
        FROM external_identities AS external
        JOIN installation_members AS member ON member.id = external.member_id
        WHERE member.installation_id = ? AND external.provider = ?
          AND external.subject = ? AND member.status = ?
      `).bind(
        installationId,
        provider,
        subject,
        memberStatuses.active,
      ).first<z.input<typeof memberRowSchema>>();
      return row === null ? null : memberRowSchema.parse(row);
    },

    findApiKey,

    findApplicationSession: (installationId, tokenDigest, requestTime) =>
      findApplicationSession(database, installationId, tokenDigest, requestTime),

    findMember,

    hasMembers: async (installationId) => {
      const row = await database.prepare(`
        SELECT EXISTS(
          SELECT 1 FROM installation_members WHERE installation_id = ?
        ) AS present
      `).bind(installationId)
        .first<z.input<typeof presenceRowSchema>>();
      return presenceRowSchema.parse(row).present === 1;
    },

    listApiKeys: async (installationId): Promise<readonly ListedApiKey[]> => {
      const result = await database.prepare(`
        SELECT managed.id, managed.installation_id AS installationId, managed.name,
          managed.prefix, managed.secret_digest AS secretDigest,
          managed.principal_id AS principalId, managed.principal_kind AS principalKind,
          managed.capabilities_json AS capabilitiesJson,
          managed.authorized_by_principal_id AS authorizedByPrincipalId,
          managed.created_at AS createdAt, managed.expires_at AS expiresAt,
          managed.revoked_at AS revokedAt, managed.rotated_from_id AS rotatedFromId,
          managed.last_used_at AS lastUsedAt,
          owner.display_name AS ownerName,
          (
            SELECT entry.actor_name FROM actions AS entry
            WHERE (entry.action = 'key_revoke' AND entry.subject_id = managed.id)
              -- A rotation's subject is the replacement; it revoked the key it replaced.
              OR (entry.action = 'key_rotate' AND entry.subject_id IN (
                SELECT replacement.id FROM managed_api_keys AS replacement
                WHERE replacement.rotated_from_id = managed.id
              ))
            ORDER BY entry.created_at DESC, entry.id DESC
            LIMIT 1
          ) AS revokedByName
        FROM managed_api_keys AS managed
        LEFT JOIN installation_members AS owner
          ON owner.installation_id = managed.installation_id
          AND owner.id = managed.principal_id
        WHERE managed.installation_id = ?
        ORDER BY managed.created_at DESC, managed.id DESC
      `).bind(installationId).all<z.input<typeof apiKeyRowSchema>>();
      return result.results.map((row) => Object.assign(
        withoutSecretDigest(parseApiKey(row)),
        listedApiKeyRowSchema.parse(row),
      ));
    },

    touch: async (principalId: string, at: string): Promise<void> => {
      await database.prepare(`
        UPDATE installation_members SET last_active_at = ?
        WHERE id = ? AND (last_active_at IS NULL OR last_active_at < ?)
      `).bind(at, principalId, principalActivityThreshold(at)).run();
    },

    touchApiKey: async (keyId: string, at: string): Promise<void> => {
      await database.prepare(`
        UPDATE managed_api_keys SET last_used_at = ?
        WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)
      `).bind(at, keyId, principalActivityThreshold(at)).run();
    },

    listMembers: async (installationId): Promise<readonly ListedMember[]> => {
      const result = await database.prepare(`
        SELECT member.id, member.installation_id AS installationId, member.email,
          member.display_name AS displayName, member.role, member.status,
          member.created_at AS createdAt, member.updated_at AS updatedAt,
          member.last_active_at AS lastActiveAt,
          member.admission_method AS admittedHow,
          admitter.display_name AS admittedByName
        FROM installation_members AS member
        LEFT JOIN installation_members AS admitter
          ON admitter.installation_id = member.installation_id
          AND admitter.id = member.admitted_by_principal_id
        WHERE member.installation_id = ?
        ORDER BY member.created_at ASC, member.id ASC
      `).bind(installationId).all<z.input<typeof listedMemberRowSchema>>();
      return result.results.map((row) => listedMemberRowSchema.parse(row));
    },

    revokeApiKey: async (installationId, keyId, revokedAt, attribution) => {
      const existing = await findApiKey(installationId, keyId);
      if (existing === null) {
        throw new IdentityNotFound({message: "The API key does not exist."});
      }
      // Revoking a revoked key changes nothing and writes nothing.
      if (existing.revokedAt === null) {
        await database.batch([
          database.prepare(`
            UPDATE managed_api_keys SET revoked_at = ?
            WHERE installation_id = ? AND id = ? AND revoked_at IS NULL
          `).bind(revokedAt, installationId, keyId),
          actionWhenStatement(
            attributedInsert(attribution, {
              action: "key_revoke",
              createdAt: revokedAt,
              detail: {subjectName: existing.name},
              idempotencyKey: `key_revoke:${keyId}`,
              projectId: null,
              subjectId: keyId,
            }),
            `EXISTS (
              SELECT 1 FROM managed_api_keys
              WHERE installation_id = ? AND id = ? AND revoked_at = ?
            ) AND NOT EXISTS (SELECT 1 FROM actions WHERE idempotency_key = ?)`,
            [installationId, keyId, revokedAt, `key_revoke:${keyId}`],
          ),
        ]);
      }
      const key = await findApiKey(installationId, keyId);
      if (key === null) throw new Error("The revoked API key disappeared.");
      return withoutSecretDigest(key);
    },

    revokeApplicationSession: async (installationId, tokenDigest, revokedAt) => {
      await database.prepare(`
        UPDATE application_sessions SET revoked_at = COALESCE(revoked_at, ?)
        WHERE installation_id = ? AND token_digest = ?
      `).bind(revokedAt, installationId, tokenDigest).run();
    },

    rotateApiKey: async (
      installationId,
      previousKeyId,
      replacement,
      revokedAt,
      attribution,
    ) => {
      const existing = await findApiKey(installationId, previousKeyId);
      if (existing === null) {
        throw new IdentityNotFound({message: "The API key does not exist."});
      }
      if (existing.revokedAt !== null) {
        throw new IdentityConflict({
          message: "A revoked API key cannot be rotated.",
        });
      }
      const results = await database.batch([
        database.prepare(`
          UPDATE managed_api_keys SET revoked_at = ?
          WHERE installation_id = ? AND id = ? AND revoked_at IS NULL
        `).bind(revokedAt, installationId, previousKeyId),
        database.prepare(`
          INSERT INTO managed_api_keys (
            id, installation_id, name, prefix, secret_digest, principal_id,
            principal_kind, capabilities_json, authorized_by_principal_id,
            created_at, expires_at, revoked_at, rotated_from_id
          ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM managed_api_keys
            WHERE installation_id = ? AND id = ? AND revoked_at = ?
          )
        `).bind(
          replacement.id,
          replacement.installationId,
          replacement.name,
          replacement.prefix,
          replacement.secretDigest,
          replacement.principalId,
          replacement.principalKind,
          JSON.stringify(replacement.capabilities),
          replacement.authorizedByPrincipalId,
          replacement.createdAt,
          replacement.expiresAt,
          replacement.revokedAt,
          replacement.rotatedFromId,
          installationId,
          previousKeyId,
          revokedAt,
        ),
        actionWhenStatement(
          attributedInsert(attribution, {
            action: "key_rotate",
            createdAt: revokedAt,
            detail: {replacedKeyId: previousKeyId, subjectName: replacement.name},
            idempotencyKey: `key_rotate:${replacement.id}`,
            projectId: null,
            subjectId: replacement.id,
          }),
          `EXISTS (
            SELECT 1 FROM managed_api_keys
            WHERE installation_id = ? AND id = ? AND rotated_from_id = ?
          )`,
          [installationId, replacement.id, previousKeyId],
        ),
      ]);
      if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
        throw new IdentityConflict({
          message: "The API key changed during rotation.",
        });
      }
      return withoutSecretDigest(replacement);
    },
  };
}

async function findApplicationSession(
  database: D1Database,
  installationId: string,
  tokenDigest: string,
  requestTime: string,
): Promise<ApplicationSession | null> {
  const row = await database.prepare(`
    SELECT session.id, session.installation_id AS installationId,
      session.token_digest AS tokenDigest, session.csrf_digest AS csrfDigest,
      session.created_at AS createdAt, session.expires_at AS expiresAt,
      session.revoked_at AS revokedAt, member.id AS memberId,
      member.email AS memberEmail, member.display_name AS memberDisplayName,
      member.role AS memberRole, member.status AS memberStatus,
      member.created_at AS memberCreatedAt, member.updated_at AS memberUpdatedAt
    FROM application_sessions AS session
    JOIN installation_members AS member ON member.id = session.member_id
    WHERE session.installation_id = ? AND session.token_digest = ?
      AND session.revoked_at IS NULL AND session.expires_at > ?
      AND member.status = ?
  `).bind(
    installationId,
    tokenDigest,
    requestTime,
    memberStatuses.active,
  ).first<z.input<typeof sessionRowSchema>>();
  if (row === null) return null;
  const parsed = sessionRowSchema.parse(row);
  return {
    createdAt: parsed.createdAt,
    csrfDigest: parsed.csrfDigest,
    expiresAt: parsed.expiresAt,
    id: parsed.id,
    installationId: parsed.installationId,
    member: {
      createdAt: parsed.memberCreatedAt,
      displayName: parsed.memberDisplayName,
      email: parsed.memberEmail,
      id: parsed.memberId,
      installationId: parsed.installationId,
      role: parsed.memberRole,
      status: parsed.memberStatus,
      updatedAt: parsed.memberUpdatedAt,
    },
    revokedAt: parsed.revokedAt,
    tokenDigest: parsed.tokenDigest,
  };
}

function parseApiKey(
  input: z.input<typeof apiKeyRowSchema>,
): StoredManagedApiKey {
  const row = apiKeyRowSchema.parse(input);
  return {
    authorizedByPrincipalId: row.authorizedByPrincipalId,
    capabilities: z.array(principalCapabilitySchema).parse(
      JSON.parse(row.capabilitiesJson),
    ),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    id: row.id,
    installationId: row.installationId,
    name: row.name,
    prefix: row.prefix,
    principalId: row.principalId,
    principalKind: row.principalKind,
    revokedAt: row.revokedAt,
    rotatedFromId: row.rotatedFromId,
    secretDigest: row.secretDigest,
  };
}

function withoutSecretDigest(key: StoredManagedApiKey): ManagedApiKey {
  const {secretDigest: _secretDigest, ...metadata} = key;
  return metadata;
}

function isD1Constraint(error: Error): boolean {
  return /constraint|unique/iu.test(error.message);
}
