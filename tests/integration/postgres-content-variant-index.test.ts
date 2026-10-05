import {randomUUID} from "node:crypto";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  brotliVariantEncoderId,
  ContentVariantConflict,
  type ContentVariantMapping,
} from "../../src/core/content-variants.js";
import {SystemClock} from "../../src/core/system.js";
import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresContentVariantIndex} from "../../src/storage/postgres-content-variant-index.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";

function readDatabaseUrl(): string {
  const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  if (databaseUrl === undefined) {
    throw new Error("Run this test through pnpm test:external-storage-runtime.");
  }
  return databaseUrl;
}

const mapping: ContentVariantMapping = {
  coding: "br",
  encoderId: brotliVariantEncoderId,
  sourceSha256: "a".repeat(64),
  variantSha256: "b".repeat(64),
  variantSize: 1234,
};

describe("Postgres content variant index", () => {
  const scratch = `artifact_content_variants_${randomUUID().replaceAll("-", "")}`;
  let maintenance: PostgresDatabase;
  let database: PostgresDatabase;
  let installationA: string;
  let installationB: string;

  beforeEach(async () => {
    maintenance = await PostgresDatabase.inspect({url: Redacted.make(readDatabaseUrl())});
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`CREATE DATABASE ${scratch}`);
    }));
    const scratchUrl = new URL(readDatabaseUrl());
    scratchUrl.pathname = `/${scratch}`;
    database = await PostgresDatabase.open({url: Redacted.make(scratchUrl.toString())}, "apply");
    installationA = `test-variants-a-${randomUUID()}`;
    installationB = `test-variants-b-${randomUUID()}`;
    // Opening the repository registers each installation row the index references.
    await PostgresArtifactRepository.open(database, installationA);
    await PostgresArtifactRepository.open(database, installationB);
  });

  afterEach(async () => {
    await database.close();
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    }));
    await maintenance.close();
  });

  test("foundation: the Postgres variant index records idempotently, rejects conflicts, and isolates installations", async () => {
    const indexA = new PostgresContentVariantIndex(database, installationA, new SystemClock());
    const indexB = new PostgresContentVariantIndex(database, installationB, new SystemClock());
    expect(await indexA.find(mapping)).toBeNull();
    await indexA.record(mapping);
    await indexA.record(mapping);
    expect(await indexA.find(mapping)).toEqual(mapping);
    await expect(indexA.record({...mapping, variantSize: 99})).rejects.toBeInstanceOf(ContentVariantConflict);
    expect(await indexB.find(mapping)).toBeNull();
  });
});
