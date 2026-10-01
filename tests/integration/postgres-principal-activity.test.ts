import {randomUUID} from "node:crypto";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {systemAttribution} from "../../src/core/action-attribution.js";
import {memberAdmissions} from "../../src/core/identity-ports.js";
import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";
import {PostgresIdentityRepository} from "../../src/storage/postgres-identity-repository.js";

function readDatabaseUrl(): string {
  const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  if (databaseUrl === undefined) {
    throw new Error("Run this test through pnpm test:external-storage-runtime.");
  }
  return databaseUrl;
}

describe("Postgres member admission and principal activity", () => {
  const scratch = `artifact_principal_activity_${randomUUID().replaceAll("-", "")}`;
  const installationId = `test-principal-activity-${randomUUID()}`;
  let maintenance: PostgresDatabase;
  let database: PostgresDatabase;
  let identity: PostgresIdentityRepository;

  beforeEach(async () => {
    maintenance = await PostgresDatabase.inspect({url: Redacted.make(readDatabaseUrl())});
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`CREATE DATABASE ${scratch}`);
    }));
    const scratchUrl = new URL(readDatabaseUrl());
    scratchUrl.pathname = `/${scratch}`;
    database = await PostgresDatabase.open({url: Redacted.make(scratchUrl.toString())}, "apply");
    await PostgresArtifactRepository.open(database, installationId);
    identity = new PostgresIdentityRepository(database, installationId);
  });

  afterEach(async () => {
    await database.close();
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    }));
    await maintenance.close();
  });

  test("a listed member reports how and by whom it was admitted", async () => {
    const owner = await identity.admitMember({
      admittedHow: memberAdmissions.owner,
      attribution: systemAttribution,
      createdAt: "2026-10-01T09:00:00.000Z",
      displayName: "Local administrator",
      email: "owner@example.test",
      id: "member_owner",
      installationId,
      role: "administrator",
    });
    await identity.admitMember({
      admittedHow: memberAdmissions.manual,
      attribution: {actor: {displayName: owner.displayName, kind: "human"}, authorizedByPrincipalId: null, principalId: owner.id},
      createdAt: "2026-10-01T09:05:00.000Z",
      displayName: "Ada Lovelace",
      email: "ada@example.test",
      id: "member_ada",
      installationId,
      role: "member",
    });

    expect((await identity.listMembers(installationId)).map((member) => ({
      admittedHow: member.admittedHow,
      admittedByName: member.admittedByName,
      id: member.id,
    }))).toEqual([
      {admittedHow: "owner", admittedByName: null, id: "member_owner"},
      {admittedHow: "manual", admittedByName: "Local administrator", id: "member_ada"},
    ]);
  });
});
