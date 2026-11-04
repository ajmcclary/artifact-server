import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {z} from "zod";

import {defaultProjectId} from "../../src/core/model.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {
  candidateRepositoryCases,
  commitOnto,
  type CandidateFixture,
  seedArtifact,
} from "../support/candidate-repository-cases.js";

describe("SQLite candidate versions", () => {
  let directory: string;
  let databasePath: string;
  let repository: SqliteArtifactRepository;
  let fixture: CandidateFixture;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "artifact-server-candidates-"));
    databasePath = path.join(directory, "artifact-server.sqlite");
    repository = new SqliteArtifactRepository(databasePath, "sqlite-candidates");
    fixture = {
      mirrorJobVersionIds: () => {
        const database = new DatabaseSync(databasePath, {readOnly: true});
        try {
          return Promise.resolve(z.array(z.object({versionId: z.string()})).parse(
            database.prepare(
              "SELECT version_id AS versionId FROM git_history_jobs WHERE kind = 'mirror-version'",
            ).all(),
          ).map((row) => row.versionId));
        } finally {
          database.close();
        }
      },
      projectId: defaultProjectId,
      store: repository,
    };
  });

  afterEach(async () => {
    repository.close();
    await rm(directory, {force: true, recursive: true});
  });

  it.for(candidateRepositoryCases)("$name", async ({run}) => {
    await expect(run(fixture)).resolves.toBeUndefined();
  });

  it("CND-003 store: the database itself refuses to point current at a candidate", async () => {
    const first = await seedArtifact(fixture, "trigger-a");
    const staged = await commitOnto(fixture, first.artifact.id, "trigger-b", first.version.id, true);
    const database = new DatabaseSync(databasePath);
    try {
      expect(() => database.prepare(
        "UPDATE artifacts SET current_version_id = ? WHERE id = ?",
      ).run(staged.version.id, first.artifact.id)).toThrow("current version must be accepted history");
    } finally {
      database.close();
    }
  });
});
