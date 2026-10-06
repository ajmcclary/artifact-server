// tests/storage/sqlite-invitations.test.ts
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {systemAttribution} from "../../src/core/action-attribution.js";
import {memberAdmissions} from "../../src/core/identity-ports.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";
import {
  caseAdministrator,
  caseInvite,
  caseRedemption,
  type InvitationFixture,
  invitationRepositoryCases,
  seedAdministrator,
} from "../support/invitation-repository-cases.js";

const installationId = "invite-installation";
const rowsSchema = z.array(z.object({action: z.string(), subjectId: z.string().nullable()}));

function readActions(databasePath: string) {
  const database = new DatabaseSync(databasePath, {readOnly: true});
  try {
    return rowsSchema.parse(database.prepare(
      "SELECT action, subject_id AS subjectId FROM actions ORDER BY created_at, action",
    ).all());
  } finally {
    database.close();
  }
}

describe("SQLite invitations", () => {
  let dataDirectory: string;
  let databasePath: string;
  let artifacts: SqliteArtifactRepository;
  let identity: SqliteIdentityRepository;
  let fixture: InvitationFixture;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-invites-"));
    databasePath = path.join(dataDirectory, "artifact-server.db");
    artifacts = new SqliteArtifactRepository(databasePath, installationId);
    identity = new SqliteIdentityRepository(databasePath);
    fixture = {
      actions: async () => readActions(databasePath),
      installationId,
      openSecond: async () => {
        const second = new SqliteIdentityRepository(databasePath);
        return {close: () => second.close(), store: second};
      },
      store: identity,
    };
    await seedAdministrator(fixture);
  });

  afterEach(async () => {
    identity.close();
    artifacts.close();
    await rm(dataDirectory, {force: true, recursive: true});
  });

  test.for(invitationRepositoryCases)("$name", async ({run}) => {
    await expect(run(fixture)).resolves.toBeUndefined();
  });

  test("the database refuses rule-breaking rows written directly", () => {
    const database = new DatabaseSync(databasePath);
    const insert = (kind: string, email: string | null, role: string, maxUses: number, useCount: number) =>
      database.prepare(`INSERT INTO installation_invites (
        installation_id, id, kind, email, role, max_uses, use_count, secret_digest, token_prefix,
        expires_at, created_at, created_by_principal_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'd', 'p', 'x', 'x', 'm')`)
        .run(installationId, `inv_direct_${kind}_${role}_${maxUses}_${useCount}`, kind, email, role, maxUses, useCount);
    try {
      expect(() => insert("link", null, "administrator", 5, 0)).toThrow(/constraint failed/u);
      expect(() => insert("person", "a@b.test", "member", 3, 0)).toThrow(/constraint failed/u);
      expect(() => insert("link", null, "member", 2, 3)).toThrow(/constraint failed/u);
      expect(() => insert("link", "a@b.test", "member", 2, 0)).toThrow(/constraint failed/u);
      expect(() => insert("link", null, "member", 101, 0)).toThrow(/constraint failed/u);
    } finally {
      database.close();
    }
  });
});

describe("SQLite invitation migration", () => {
  test("a schema-20 database keeps its members, sessions, identities and actions", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-invites-migrate-"));
    const databasePath = path.join(dataDirectory, "artifact-server.db");
    try {
      const artifacts = new SqliteArtifactRepository(databasePath, installationId);
      const identity = new SqliteIdentityRepository(databasePath);
      await identity.admitMember({
        admittedHow: memberAdmissions.owner,
        attribution: systemAttribution,
        createdAt: "2026-10-06T09:00:00.000Z",
        displayName: "Jordan Lee",
        email: "jordan@acme.test",
        id: "member_admin",
        installationId,
        role: "administrator",
      });
      await identity.bindExternalIdentity({
        boundAt: "2026-10-06T09:00:00.000Z",
        email: "jordan@acme.test",
        memberId: "member_admin",
        provider: "workos",
        subject: "subject-admin",
      });
      await identity.createApplicationSession({
        createdAt: "2026-10-06T09:00:00.000Z",
        csrfDigest: "csrf",
        expiresAt: "2026-10-07T09:00:00.000Z",
        id: "session_1",
        installationId,
        memberId: "member_admin",
        tokenDigest: "token",
      });
      identity.close();
      artifacts.close();

      // Return the file to schema 20: the narrow admission CHECK, an actions CHECK
      // without invite kinds, and no invites table.
      const legacy = new DatabaseSync(databasePath);
      const actionsSql = z.object({sql: z.string()}).parse(legacy
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'actions'").get()).sql;
      const narrowActionsSql = actionsSql
        .replaceAll("'invite_create', ", "")
        .replaceAll("'invite_redeem', ", "")
        .replaceAll("'invite_revoke', ", "")
        .replace(/^CREATE TABLE "?actions"?/u, "CREATE TABLE actions_legacy");
      expect(narrowActionsSql).not.toContain("invite_");
      legacy.exec("PRAGMA foreign_keys = OFF;");
      legacy.exec("BEGIN;");
      legacy.exec(narrowActionsSql);
      legacy.exec("INSERT INTO actions_legacy SELECT * FROM actions;");
      legacy.exec("DROP TABLE actions;");
      legacy.exec("ALTER TABLE actions_legacy RENAME TO actions;");
      legacy.exec(`
        CREATE TABLE members_old AS SELECT * FROM installation_members;
        DROP TABLE installation_members;
        CREATE TABLE installation_members (
          id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, email TEXT NOT NULL,
          display_name TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
          status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_active_at TEXT,
          admitted_by_principal_id TEXT,
          admission_method TEXT
            CHECK (admission_method IS NULL OR admission_method IN ('manual', 'automatic', 'owner')),
          UNIQUE (installation_id, email));
        INSERT INTO installation_members SELECT * FROM members_old;
        DROP TABLE members_old;
        DROP TABLE installation_invites;
        PRAGMA user_version = 20;
        COMMIT;
      `);
      legacy.exec("PRAGMA foreign_keys = ON;");
      legacy.close();

      const reopenedArtifacts = new SqliteArtifactRepository(databasePath, installationId);
      const reopened = new SqliteIdentityRepository(databasePath);
      try {
        await expect(reopened.findActiveMemberByExternalIdentity(installationId, "workos", "subject-admin"))
          .resolves.toMatchObject({id: "member_admin"});
        await expect(reopened.findApplicationSession(installationId, "token", "2026-10-06T10:00:00.000Z"))
          .resolves.toMatchObject({id: "session_1"});
        const id = "inv_00000000-0000-4000-8000-000000000008";
        await reopened.createInvite({attribution: caseAdministrator, invite: caseInvite(installationId, {id})});
        await expect(reopened.redeemInvite(caseRedemption(installationId, "member_new", "new@acme.test", id)))
          .resolves.toMatchObject({kind: "admitted"});
        const check = new DatabaseSync(databasePath, {readOnly: true});
        try {
          expect(check.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
          expect(z.object({user_version: z.number()}).parse(check.prepare("PRAGMA user_version").get()).user_version)
            .toBe(21);
        } finally {
          check.close();
        }
      } finally {
        reopened.close();
        reopenedArtifacts.close();
      }
    } finally {
      await rm(dataDirectory, {force: true, recursive: true});
    }
  });
});
