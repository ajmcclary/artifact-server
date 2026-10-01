import {Effect} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {isSqlError} from "effect/unstable/sql/SqlError";
import {z} from "zod";

import {
  IdentityConflict,
  IdentityNotFound,
  LoginAttemptRejected,
} from "../core/errors.js";
import type {
  AdmitMemberRecord,
  BindExternalIdentityRecord,
  BootstrapManagedApiKeyRepository,
  CreateApplicationSessionRecord,
} from "../core/identity-ports.js";
import {
  type ApplicationSession,
  type InstallationMember,
  type ListedMember,
  type LoginAttempt,
  type ManagedApiKey,
  memberStatuses,
  type StoredManagedApiKey,
} from "../core/installation-identity.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
} from "../core/identity.js";
import {
  type ActionAttribution,
  systemAttribution,
} from "../core/action-attribution.js";
import {memberAdmissions} from "../core/identity-ports.js";
import {attributedInsert} from "./action-insert.js";
import {insertPostgresAction} from "./postgres-action-insert.js";
import type {PostgresDatabase} from "./postgres-database.js";

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
const loginAttemptRowSchema = z.object({
  codeVerifier: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  nonce: z.string().nullable(),
  provider: z.string(),
  returnTo: z.string(),
  stateDigest: z.string(),
});
const countRowSchema = z.object({count: z.coerce.number().int().nonnegative()});

/** Installation-scoped Postgres persistence for membership and credentials. */
export class PostgresIdentityRepository implements BootstrapManagedApiKeyRepository {
  readonly #database: PostgresDatabase;
  readonly #installationId: string;

  constructor(database: PostgresDatabase, installationId: string) {
    this.#database = database;
    this.#installationId = installationId;
  }

  async hasMembers(installationId: string): Promise<boolean> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{present: boolean}>(
        `SELECT EXISTS(
          SELECT 1 FROM installation_members WHERE installation_id = $1
        ) AS present`,
        [installationId],
      );
      return z.object({present: z.boolean()}).parse(rows[0]).present;
    }));
  }

  async admitMember(command: AdmitMemberRecord): Promise<InstallationMember> {
    this.#assertInstallationScope(command.installationId);
    try {
      await this.#database.run(Effect.gen({self: this}, function*() {
        const sql = yield* SqlClient;
        yield* sql.withTransaction(Effect.gen(function*() {
          yield* sql`INSERT INTO installation_members (
            installation_id, id, email, display_name, role, status,
            created_at, updated_at, admitted_by_principal_id, admission_method
          ) VALUES (
            ${command.installationId}, ${command.id}, ${command.email},
            ${command.displayName}, ${command.role}, ${memberStatuses.active},
            ${command.createdAt}, ${command.createdAt},
            ${command.attribution.principalId}, ${command.admittedHow}
          )`;
          yield* insertPostgresAction(command.installationId, attributedInsert(command.attribution, {
            action: "member_admit",
            createdAt: command.createdAt,
            detail: {how: command.admittedHow, role: command.role, subjectName: command.displayName},
            idempotencyKey: `member_admit:${command.id}`,
            projectId: null,
            subjectId: command.id,
          }));
        }));
      }));
    } catch (cause) {
      if (isConstraintFailure(cause)) {
        throw new IdentityConflict({
          message: "That email is already admitted to this installation.",
        });
      }
      throw cause;
    }
    const member = await this.findMember(command.installationId, command.id);
    if (member === null) throw new Error("The admitted member was not persisted.");
    return member;
  }

  async listMembers(installationId: string): Promise<readonly ListedMember[]> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT member.id, member.installation_id AS "installationId", member.email,
          member.display_name AS "displayName", member.role, member.status,
          member.created_at AS "createdAt", member.updated_at AS "updatedAt",
          member.last_active_at AS "lastActiveAt",
          member.admission_method AS "admittedHow",
          admitter.display_name AS "admittedByName"
        FROM installation_members AS member
        LEFT JOIN installation_members AS admitter
          ON admitter.installation_id = member.installation_id
          AND admitter.id = member.admitted_by_principal_id
        WHERE member.installation_id = $1
        ORDER BY member.created_at ASC, member.id ASC`,
        [installationId],
      );
      return z.array(listedMemberRowSchema).parse(rows);
    }));
  }


  async findMember(
    installationId: string,
    memberId: string,
  ): Promise<InstallationMember | null> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(this.#findMember(installationId, memberId, false));
  }

  async findActiveMemberByEmail(
    installationId: string,
    email: string,
  ): Promise<InstallationMember | null> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(memberSelect(
        "WHERE installation_id = $1 AND email = $2 AND status = $3",
      ), [installationId, email, memberStatuses.active]);
      return memberRowSchema.nullable().parse(rows[0] ?? null);
    }));
  }

  async findActiveMemberByExternalIdentity(
    installationId: string,
    provider: string,
    subject: string,
  ): Promise<InstallationMember | null> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT member.id, member.installation_id AS "installationId",
          member.email, member.display_name AS "displayName", member.role,
          member.status, member.created_at AS "createdAt",
          member.updated_at AS "updatedAt"
         FROM external_identities AS external
         JOIN installation_members AS member
           ON member.installation_id = external.installation_id
          AND member.id = external.member_id
         WHERE member.installation_id = $1 AND external.provider = $2
           AND external.subject = $3 AND member.status = $4`,
        [installationId, provider, subject, memberStatuses.active],
      );
      return memberRowSchema.nullable().parse(rows[0] ?? null);
    }));
  }

  async bindExternalIdentity(command: BindExternalIdentityRecord): Promise<void> {
    const installationId = this.#installationId;
    const existingMember = await this.findMember(
      installationId,
      command.memberId,
    );
    if (existingMember === null) {
      throw new IdentityConflict({message: "The member does not exist."});
    }
    try {
      const changed = await this.#database.run(Effect.gen({self: this}, function*() {
        const sql = yield* SqlClient;
        return yield* sql`INSERT INTO external_identities (
          installation_id, provider, subject, member_id, email, bound_at
        ) VALUES (
          ${installationId}, ${command.provider}, ${command.subject},
          ${command.memberId}, ${command.email}, ${command.boundAt}
        )
        ON CONFLICT (installation_id, provider, subject) DO UPDATE SET
          email = EXCLUDED.email,
          bound_at = EXCLUDED.bound_at
        WHERE external_identities.member_id = EXCLUDED.member_id
        RETURNING member_id`;
      }));
      if (changed.length !== 1) throw identityBindingConflict();
    } catch (cause) {
      if (cause instanceof IdentityConflict) throw cause;
      if (isConstraintFailure(cause)) throw identityBindingConflict();
      throw cause;
    }
  }

  async deactivateMember(
    installationId: string,
    memberId: string,
    updatedAt: string,
    attribution: ActionAttribution,
  ): Promise<InstallationMember> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* sql`SELECT pg_advisory_xact_lock(
          hashtextextended(${`artifact-server:member-policy:${installationId}`}, 0)
        )`;
        const existing = yield* this.#findMember(installationId, memberId, true);
        if (existing === null) {
          return yield* new IdentityNotFound({message: "The member does not exist."});
        }
        if (
          existing.status === memberStatuses.active &&
          existing.role === membershipRoles.administrator
        ) {
          const rows = yield* sql.unsafe<object>(
            `SELECT COUNT(*) AS count FROM installation_members
             WHERE installation_id = $1 AND role = $2 AND status = $3`,
            [
              installationId,
              membershipRoles.administrator,
              memberStatuses.active,
            ],
          );
          if (countRowSchema.parse(rows[0]).count <= 1) {
            return yield* new IdentityConflict({
              message: "The installation must retain one active administrator.",
            });
          }
        }
        yield* sql`UPDATE installation_members
          SET status = ${memberStatuses.inactive}, updated_at = ${updatedAt}
          WHERE installation_id = ${installationId} AND id = ${memberId}`;
        yield* sql`UPDATE application_sessions
          SET revoked_at = COALESCE(revoked_at, ${updatedAt})
          WHERE installation_id = ${installationId} AND member_id = ${memberId}`;
        yield* sql`UPDATE managed_api_keys
          SET revoked_at = COALESCE(revoked_at, ${updatedAt})
          WHERE installation_id = ${installationId}
            AND principal_kind = ${principalKinds.human}
            AND principal_id = ${memberId}`;
        if (existing.status === memberStatuses.active) {
          yield* insertPostgresAction(installationId, attributedInsert(attribution, {
            action: "member_deactivate",
            createdAt: updatedAt,
            detail: {subjectName: existing.displayName},
            idempotencyKey: `member_deactivate:${memberId}:${updatedAt}`,
            projectId: null,
            subjectId: memberId,
          }));
        }
        return {...existing, status: memberStatuses.inactive, updatedAt};
      }));
    }));
  }

  async createApplicationSession(
    command: CreateApplicationSessionRecord,
  ): Promise<ApplicationSession> {
    this.#assertInstallationScope(command.installationId);
    await this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql`INSERT INTO application_sessions (
        installation_id, id, member_id, token_digest, csrf_digest,
        created_at, expires_at, revoked_at
      ) VALUES (
        ${command.installationId}, ${command.id}, ${command.memberId},
        ${command.tokenDigest}, ${command.csrfDigest}, ${command.createdAt},
        ${command.expiresAt}, NULL
      )`;
    }));
    const session = await this.findApplicationSession(
      command.installationId,
      command.tokenDigest,
      command.createdAt,
    );
    if (session === null) throw new Error("The application session was not persisted.");
    return session;
  }

  async findApplicationSession(
    installationId: string,
    tokenDigest: string,
    requestTime: string,
  ): Promise<ApplicationSession | null> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT session.id, session.installation_id AS "installationId",
          session.token_digest AS "tokenDigest",
          session.csrf_digest AS "csrfDigest",
          session.created_at AS "createdAt", session.expires_at AS "expiresAt",
          session.revoked_at AS "revokedAt", member.id AS "memberId",
          member.email AS "memberEmail",
          member.display_name AS "memberDisplayName",
          member.role AS "memberRole", member.status AS "memberStatus",
          member.created_at AS "memberCreatedAt",
          member.updated_at AS "memberUpdatedAt"
         FROM application_sessions AS session
         JOIN installation_members AS member
           ON member.installation_id = session.installation_id
          AND member.id = session.member_id
         WHERE session.installation_id = $1 AND session.token_digest = $2
           AND session.revoked_at IS NULL AND session.expires_at > $3
           AND member.status = $4`,
        [installationId, tokenDigest, requestTime, memberStatuses.active],
      );
      const parsed = sessionRowSchema.nullable().parse(rows[0] ?? null);
      if (parsed === null) return null;
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
    }));
  }

  async revokeApplicationSession(
    installationId: string,
    tokenDigest: string,
    revokedAt: string,
  ): Promise<void> {
    this.#assertInstallationScope(installationId);
    await this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql`UPDATE application_sessions
        SET revoked_at = COALESCE(revoked_at, ${revokedAt})
        WHERE installation_id = ${installationId}
          AND token_digest = ${tokenDigest}`;
    }));
  }

  async createApiKey(
    key: StoredManagedApiKey,
    attribution: ActionAttribution,
  ): Promise<ManagedApiKey> {
    this.#assertInstallationScope(key.installationId);
    await this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* this.#insertApiKey(key);
        yield* keyIssueAction(key, attribution, "administrator");
      }));
    }));
    return withoutSecretDigest(key);
  }

  async initializeBootstrapApiKey(
    key: StoredManagedApiKey,
  ): Promise<StoredManagedApiKey> {
    this.#assertInstallationScope(key.installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* sql.unsafe(
          "SELECT pg_advisory_xact_lock(hashtext($1))",
          [`artifact-server-bootstrap:${key.installationId}`],
        );
        const existing = yield* this.#findApiKey(
          key.installationId,
          key.id,
          false,
        );
        if (existing !== null) return existing;
        const rows = yield* sql.unsafe<{count: number}>(`
          SELECT (
            (SELECT COUNT(*) FROM installation_members WHERE installation_id = $1)
            + (SELECT COUNT(*) FROM managed_api_keys WHERE installation_id = $1)
          ) AS count
        `, [key.installationId]);
        if (countRowSchema.parse(rows[0]).count > 0) {
          return yield* new IdentityConflict({
            message:
              "The private-team bootstrap key id cannot change after installation identity exists.",
          });
        }
        yield* this.#insertApiKey(key);
        yield* keyIssueAction(key, systemAttribution, "bootstrap");
        return key;
      }));
    }));
  }

  async findApiKey(
    installationId: string,
    keyId: string,
  ): Promise<StoredManagedApiKey | null> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(this.#findApiKey(installationId, keyId, false));
  }

  async listApiKeys(installationId: string): Promise<readonly ManagedApiKey[]> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(apiKeySelect(
        "WHERE installation_id = $1 ORDER BY created_at DESC, id DESC",
      ), [installationId]);
      return z.array(apiKeyRowSchema).parse(rows).map((row) =>
        withoutSecretDigest(parseApiKey(row))
      );
    }));
  }

  async revokeApiKey(
    installationId: string,
    keyId: string,
    revokedAt: string,
    attribution: ActionAttribution,
  ): Promise<ManagedApiKey> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        const existing = yield* this.#findApiKey(installationId, keyId, true);
        if (existing === null) {
          return yield* new IdentityNotFound({
            message: "The API key does not exist.",
          });
        }
        // Revoking a revoked key changes nothing and writes nothing.
        if (existing.revokedAt === null) {
          yield* sql`UPDATE managed_api_keys SET revoked_at = ${revokedAt}
            WHERE installation_id = ${installationId} AND id = ${keyId}`;
          yield* insertPostgresAction(installationId, attributedInsert(attribution, {
            action: "key_revoke",
            createdAt: revokedAt,
            detail: {subjectName: existing.name},
            idempotencyKey: `key_revoke:${keyId}`,
            projectId: null,
            subjectId: keyId,
          }));
        }
        const key = yield* this.#findApiKey(installationId, keyId, false);
        if (key === null) throw new Error("The revoked API key disappeared.");
        return withoutSecretDigest(key);
      }));
    }));
  }

  async rotateApiKey(
    installationId: string,
    previousKeyId: string,
    replacement: StoredManagedApiKey,
    revokedAt: string,
    attribution: ActionAttribution,
  ): Promise<ManagedApiKey> {
    this.#assertInstallationScope(installationId);
    this.#assertInstallationScope(replacement.installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        const existing = yield* this.#findApiKey(
          installationId,
          previousKeyId,
          true,
        );
        if (existing === null) {
          return yield* new IdentityNotFound({
            message: "The API key does not exist.",
          });
        }
        if (existing.revokedAt !== null) {
          return yield* new IdentityConflict({
            message: "A revoked API key cannot be rotated.",
          });
        }
        yield* sql`UPDATE managed_api_keys SET revoked_at = ${revokedAt}
          WHERE installation_id = ${installationId} AND id = ${previousKeyId}`;
        yield* this.#insertApiKey(replacement);
        yield* insertPostgresAction(installationId, attributedInsert(attribution, {
          action: "key_rotate",
          createdAt: revokedAt,
          detail: {replacedKeyId: previousKeyId, subjectName: replacement.name},
          idempotencyKey: `key_rotate:${replacement.id}`,
          projectId: null,
          subjectId: replacement.id,
        }));
        return withoutSecretDigest(replacement);
      }));
    }));
  }

  async createLoginAttempt(attempt: LoginAttempt): Promise<void> {
    const installationId = this.#installationId;
    await this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      // `/auth/login` is unauthenticated, so every insert clears the attempts
      // that can no longer be consumed instead of growing the table forever.
      yield* sql`DELETE FROM login_attempts
        WHERE installation_id = ${installationId}
          AND expires_at <= ${attempt.createdAt}`;
      yield* sql`INSERT INTO login_attempts (
        installation_id, state_digest, provider, code_verifier, nonce, return_to,
        created_at, expires_at, consumed_at
      ) VALUES (
        ${installationId}, ${attempt.stateDigest}, ${attempt.provider},
        ${attempt.codeVerifier}, ${attempt.nonce}, ${attempt.returnTo},
        ${attempt.createdAt}, ${attempt.expiresAt}, NULL
      )`;
    }));
  }

  async consumeLoginAttempt(
    stateDigest: string,
    provider: string,
    consumedAt: string,
  ): Promise<LoginAttempt> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        const rows = yield* sql.unsafe<object>(
          `SELECT state_digest AS "stateDigest", provider,
            code_verifier AS "codeVerifier", nonce, return_to AS "returnTo",
            created_at AS "createdAt", expires_at AS "expiresAt"
           FROM login_attempts
           WHERE installation_id = $1 AND state_digest = $2 AND provider = $3
             AND consumed_at IS NULL AND expires_at > $4
           FOR UPDATE`,
          [installationId, stateDigest, provider, consumedAt],
        );
        const attempt = loginAttemptRowSchema.nullable().parse(rows[0] ?? null);
        if (attempt === null) {
          return yield* new LoginAttemptRejected({
            message: "The browser login attempt is invalid or no longer active.",
          });
        }
        const updated = yield* sql`UPDATE login_attempts
          SET consumed_at = ${consumedAt}
          WHERE installation_id = ${installationId}
            AND state_digest = ${stateDigest}
            AND consumed_at IS NULL
          RETURNING state_digest`;
        if (updated.length !== 1) {
          return yield* new LoginAttemptRejected({
            message: "The browser login attempt was already used.",
          });
        }
        return attempt;
      }));
    }));
  }

  #assertInstallationScope(installationId: string): void {
    if (installationId !== this.#installationId) {
      throw new IdentityNotFound({
        message: "The installation identity does not exist in this repository.",
      });
    }
  }

  #findMember(
    installationId: string,
    memberId: string,
    lock: boolean,
  ): Effect.Effect<InstallationMember | null, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(memberSelect(
        `WHERE installation_id = $1 AND id = $2 ${lock ? "FOR UPDATE" : ""}`,
      ), [installationId, memberId]);
      return memberRowSchema.nullable().parse(rows[0] ?? null);
    });
  }

  #findApiKey(
    installationId: string,
    keyId: string,
    lock: boolean,
  ): Effect.Effect<StoredManagedApiKey | null, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(apiKeySelect(
        `WHERE installation_id = $1 AND id = $2 ${lock ? "FOR UPDATE" : ""}`,
      ), [installationId, keyId]);
      const row = apiKeyRowSchema.nullable().parse(rows[0] ?? null);
      return row === null ? null : parseApiKey(row);
    });
  }

  #insertApiKey(
    key: StoredManagedApiKey,
  ): Effect.Effect<void, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql`INSERT INTO managed_api_keys (
        installation_id, id, name, prefix, secret_digest, principal_id,
        principal_kind, capabilities_json, authorized_by_principal_id,
        created_at, expires_at, revoked_at, rotated_from_id
      ) VALUES (
        ${key.installationId}, ${key.id}, ${key.name}, ${key.prefix},
        ${key.secretDigest}, ${key.principalId}, ${key.principalKind},
        ${JSON.stringify(key.capabilities)}, ${key.authorizedByPrincipalId},
        ${key.createdAt}, ${key.expiresAt}, ${key.revokedAt},
        ${key.rotatedFromId}
      )`;
    });
  }
}

function memberSelect(suffix: string): string {
  return `SELECT id, installation_id AS "installationId", email,
    display_name AS "displayName", role, status,
    created_at AS "createdAt", updated_at AS "updatedAt"
    FROM installation_members ${suffix}`;
}

function apiKeySelect(suffix: string): string {
  return `SELECT id, installation_id AS "installationId", name, prefix,
    secret_digest AS "secretDigest", principal_id AS "principalId",
    principal_kind AS "principalKind",
    capabilities_json AS "capabilitiesJson",
    authorized_by_principal_id AS "authorizedByPrincipalId",
    created_at AS "createdAt", expires_at AS "expiresAt",
    revoked_at AS "revokedAt", rotated_from_id AS "rotatedFromId"
    FROM managed_api_keys ${suffix}`;
}

function parseApiKey(
  row: z.infer<typeof apiKeyRowSchema>,
): StoredManagedApiKey {
  const decoded: unknown = JSON.parse(row.capabilitiesJson);
  const capabilities = z.array(principalCapabilitySchema).parse(decoded);
  return {
    authorizedByPrincipalId: row.authorizedByPrincipalId,
    capabilities,
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

function identityBindingConflict(): IdentityConflict {
  return new IdentityConflict({
    message: "That external identity is already bound to another member.",
  });
}

function isConstraintFailure(cause: unknown): boolean {
  if (isSqlError(cause)) {
    return cause.reason._tag === "ConstraintError" ||
      cause.reason._tag === "UniqueViolation";
  }
  return false;
}

/** The `key_issue` activity row written beside every new key. */
function keyIssueAction(
  key: StoredManagedApiKey,
  attribution: ActionAttribution,
  how: "administrator" | "bootstrap",
): Effect.Effect<void, unknown, SqlClient> {
  return insertPostgresAction(key.installationId, attributedInsert(attribution, {
    action: "key_issue",
    createdAt: key.createdAt,
    detail: {
      capabilities: key.capabilities,
      how,
      ownerPrincipalId: key.principalId,
      subjectName: key.name,
    },
    idempotencyKey: `key_issue:${key.id}`,
    projectId: null,
    subjectId: key.id,
  }));
}
