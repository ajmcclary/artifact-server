// tests/integration/postgres-invitations.test.ts
import {randomUUID} from "node:crypto";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";
import {PostgresIdentityRepository} from "../../src/storage/postgres-identity-repository.js";
import {memberAdmissions} from "../../src/core/identity-ports.js";
import {actionRowChecks} from "../../src/storage/activity-log-schema.js";
import {
  caseAdministrator,
  caseInvite,
  caseRedemption,
  type InvitationFixture,
  invitationRepositoryCases,
  seedAdministrator,
} from "../support/invitation-repository-cases.js";

/** A CHECK body as it was before the invite kinds existed. */
function withoutInviteKinds(check: string): string {
  return check.replaceAll("'invite_create', 'invite_redeem', 'invite_revoke', ", "");
}

function readDatabaseUrl(): string {
  const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  if (databaseUrl === undefined) {
    throw new Error("Run this test through pnpm test:external-storage-runtime.");
  }
  return databaseUrl;
}

describe("Postgres invitations", () => {
  let scratch: string;
  let installationId: string;
  let maintenance: PostgresDatabase;
  let database: PostgresDatabase;
  let fixture: InvitationFixture;
  let scratchUrl: URL;

  beforeEach(async () => {
    scratch = `artifact_invites_${randomUUID().replaceAll("-", "")}`;
    installationId = `test-invites-${randomUUID()}`;
    maintenance = await PostgresDatabase.inspect({url: Redacted.make(readDatabaseUrl())});
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`CREATE DATABASE ${scratch}`);
    }));
    scratchUrl = new URL(readDatabaseUrl());
    scratchUrl.pathname = `/${scratch}`;
    database = await PostgresDatabase.open({url: Redacted.make(scratchUrl.toString())}, "apply");
    await PostgresArtifactRepository.open(database, installationId);
    const store = new PostgresIdentityRepository(database, installationId);
    fixture = {
      actions: () => database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        return yield* sql.unsafe<{action: string; subjectId: string | null}>(
          `SELECT action, subject_id AS "subjectId" FROM actions
           WHERE installation_id = $1 ORDER BY created_at, action`,
          [installationId],
        );
      })),
      installationId,
      openSecond: async () => ({
        close: () => undefined,
        store: new PostgresIdentityRepository(database, installationId),
      }),
      store,
    };
    await seedAdministrator(fixture);
  });

  afterEach(async () => {
    await database.close();
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    }));
    await maintenance.close();
  });

  test.for(invitationRepositoryCases)("$name", async ({run}) => {
    await expect(run(fixture)).resolves.toBeUndefined();
  });

  test("the database refuses an administrator link invite written directly", async () => {
    await expect(database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`INSERT INTO installation_invites (
        installation_id, id, kind, email, role, max_uses, use_count, secret_digest,
        token_prefix, expires_at, created_at, created_by_principal_id
      ) VALUES ($1, 'inv_bad', 'link', NULL, 'administrator', 5, 0, 'd', 'p', 'x', 'x', 'm')`,
      [installationId]);
    }))).rejects.toBeDefined();
  });

  test("migration 0022 upgrades a populated schema-21 database without losing members, identities or sessions", async () => {
    const legacyStore = new PostgresIdentityRepository(database, installationId);
    await legacyStore.admitMember({
      admittedHow: memberAdmissions.manual,
      attribution: caseAdministrator,
      createdAt: "2026-10-06T09:30:00.000Z",
      displayName: "Rae Chen",
      email: "rae@acme.test",
      id: "member_rae",
      installationId,
      role: "member",
    });
    await legacyStore.bindExternalIdentity({
      boundAt: "2026-10-06T09:30:00.000Z",
      email: "rae@acme.test",
      memberId: "member_rae",
      provider: "workos",
      subject: "subject-rae",
    });
    await legacyStore.createApplicationSession({
      createdAt: "2026-10-06T09:30:00.000Z",
      csrfDigest: "csrf-rae",
      expiresAt: "2126-10-06T09:30:00.000Z",
      id: "session_rae",
      installationId,
      memberId: "member_rae",
      tokenDigest: "token-rae",
    });
    const [actionKindCheck, scopeCheck] = actionRowChecks;
    // Return the database to schema 21: no invites table and the CHECKs that predate invites.
    await database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe("DROP TABLE installation_invites");
      yield* sql.unsafe(`ALTER TABLE installation_members
        DROP CONSTRAINT installation_members_admission_method_check,
        ADD CONSTRAINT installation_members_admission_method_check
          CHECK (admission_method IS NULL OR admission_method IN ('manual', 'automatic', 'owner'))`);
      yield* sql.unsafe(`ALTER TABLE actions
        DROP CONSTRAINT actions_action_check,
        ADD CONSTRAINT actions_action_check CHECK (${withoutInviteKinds(actionKindCheck ?? "")}),
        DROP CONSTRAINT actions_scope_check,
        ADD CONSTRAINT actions_scope_check CHECK (${withoutInviteKinds(scopeCheck ?? "")})`);
      yield* sql.unsafe("DELETE FROM artifact_server_postgres_migrations WHERE migration_id = 22");
    }));
    const actionsBefore = (await fixture.actions()).length;
    await database.close();

    database = await PostgresDatabase.open({url: Redacted.make(scratchUrl.toString())}, "apply");
    const upgraded = new PostgresIdentityRepository(database, installationId);
    await expect(upgraded.findActiveMemberByExternalIdentity(installationId, "workos", "subject-rae"))
      .resolves.toMatchObject({id: "member_rae"});
    await expect(upgraded.findApplicationSession(installationId, "token-rae", "2026-10-06T10:00:00.000Z"))
      .resolves.toMatchObject({id: "session_rae"});
    const id = "inv_00000000-0000-4000-8000-000000000042";
    await upgraded.createInvite({attribution: caseAdministrator, invite: caseInvite(installationId, {id})});
    await expect(upgraded.redeemInvite(caseRedemption(installationId, "member_new", "new@acme.test", id)))
      .resolves.toMatchObject({kind: "admitted"});
    const actionsAfter = await database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.unsafe<{action: string}>(
        "SELECT action FROM actions WHERE installation_id = $1",
        [installationId],
      );
    }));
    expect(actionsAfter.length).toBe(actionsBefore + 3);
  });
});
