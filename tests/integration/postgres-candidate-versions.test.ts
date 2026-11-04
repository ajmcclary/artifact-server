import {randomUUID} from "node:crypto";
import {inspect} from "node:util";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {z} from "zod";

import {defaultProjectId} from "../../src/core/model.js";
import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";
import {
  candidateRepositoryCases,
  commitOnto,
  type CandidateFixture,
  seedArtifact,
} from "../support/candidate-repository-cases.js";

function readDatabaseUrl(): string {
  const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  if (databaseUrl === undefined) {
    throw new Error("Run this test through pnpm test:external-storage-runtime.");
  }
  return databaseUrl;
}

describe("Postgres candidate versions", () => {
  const scratch = `artifact_candidates_${randomUUID().replaceAll("-", "")}`;
  let maintenance: PostgresDatabase;
  let database: PostgresDatabase;
  let fixture: CandidateFixture;

  beforeEach(async () => {
    maintenance = await PostgresDatabase.inspect({url: Redacted.make(readDatabaseUrl())});
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`CREATE DATABASE ${scratch}`);
    }));
    const scratchUrl = new URL(readDatabaseUrl());
    scratchUrl.pathname = `/${scratch}`;
    database = await PostgresDatabase.open({url: Redacted.make(scratchUrl.toString())}, "apply");
    const repository = await PostgresArtifactRepository.open(database, `test-candidates-${randomUUID()}`);
    fixture = {
      mirrorJobVersionIds: async () => {
        const rows = await database.run(Effect.gen(function*() {
          const sql = yield* SqlClient;
          return yield* sql.unsafe<object>(
            `SELECT version_id AS "versionId" FROM git_history_jobs WHERE kind = 'mirror-version'`,
          );
        }));
        return z.array(z.object({versionId: z.string()})).parse(rows).map((row) => row.versionId);
      },
      projectId: defaultProjectId,
      store: repository,
    };
  });

  afterEach(async () => {
    await database.close();
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    }));
    await maintenance.close();
  });

  it.for(candidateRepositoryCases)("$name", async ({run}) => {
    await expect(run(fixture)).resolves.toBeUndefined();
  });

  it("CND-003 store: the Postgres database itself refuses to point current at a candidate", async () => {
    const first = await seedArtifact(fixture, "trigger-a");
    const staged = await commitOnto(fixture, first.artifact.id, "trigger-b", first.version.id, true);
    const outcome = await database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "UPDATE artifacts SET current_version_id = $1 WHERE id = $2",
        [staged.version.id, first.artifact.id],
      );
    }).pipe(Effect.match({
      onFailure: (failure) => inspect(failure, {depth: 10}),
      onSuccess: () => "committed",
    })));
    expect(outcome).toContain("current version must be accepted history");
    const artifact = await fixture.store.findArtifact(defaultProjectId, first.artifact.id);
    expect(artifact?.currentVersionId).toBe(first.version.id);
  });
});
