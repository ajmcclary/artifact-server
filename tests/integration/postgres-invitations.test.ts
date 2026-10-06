// tests/integration/postgres-invitations.test.ts
import {randomUUID} from "node:crypto";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";
import {PostgresIdentityRepository} from "../../src/storage/postgres-identity-repository.js";
import {
  type InvitationFixture,
  invitationRepositoryCases,
  seedAdministrator,
} from "../support/invitation-repository-cases.js";

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

  beforeEach(async () => {
    scratch = `artifact_invites_${randomUUID().replaceAll("-", "")}`;
    installationId = `test-invites-${randomUUID()}`;
    maintenance = await PostgresDatabase.inspect({url: Redacted.make(readDatabaseUrl())});
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`CREATE DATABASE ${scratch}`);
    }));
    const scratchUrl = new URL(readDatabaseUrl());
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

  test("migration 0022 kept every member admitted before it", async () => {
    const members = await fixture.store.listMembers(installationId);
    expect(members.map((member) => member.admittedHow)).toEqual(["owner"]);
  });
});
