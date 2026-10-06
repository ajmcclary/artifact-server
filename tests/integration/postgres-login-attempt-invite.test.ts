// tests/integration/postgres-login-attempt-invite.test.ts
import {randomUUID} from "node:crypto";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

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

describe("Postgres login attempts carry an invite", () => {
  const scratch = `artifact_login_invite_${randomUUID().replaceAll("-", "")}`;
  const installationId = `test-login-invite-${randomUUID()}`;
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

  test("an attempt returns the invite it was started with, and a plain one returns null", async () => {
    const base = {
      codeVerifier: "verifier",
      createdAt: "2026-10-06T10:00:00.000Z",
      expiresAt: "2026-10-06T10:10:00.000Z",
      nonce: null,
      provider: "workos",
      returnTo: "/review",
    };
    await identity.createLoginAttempt({...base, inviteId: "inv_1", stateDigest: "state-a"});
    await identity.createLoginAttempt({...base, inviteId: null, stateDigest: "state-b"});
    await expect(identity.consumeLoginAttempt("state-a", "workos", "2026-10-06T10:01:00.000Z"))
      .resolves.toMatchObject({inviteId: "inv_1"});
    await expect(identity.consumeLoginAttempt("state-b", "workos", "2026-10-06T10:01:00.000Z"))
      .resolves.toMatchObject({inviteId: null});
  });
});
