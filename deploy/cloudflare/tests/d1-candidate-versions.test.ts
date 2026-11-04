// deploy/cloudflare/tests/d1-candidate-versions.test.ts
import {fileURLToPath} from "node:url";

import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {getPlatformProxy} from "wrangler";
import {z} from "zod";

import {defaultProjectId} from "../../../src/core/model.js";
import {
  candidateRepositoryCases,
  commitOnto,
  type CandidateFixture,
  seedArtifact,
} from "../../../tests/support/candidate-repository-cases.js";
import {createD1ArtifactRepository} from "../src/d1-artifact-repository.js";
import {migrateD1, requiredD1SchemaVersion} from "../src/d1-migrations.js";

const openLocalD1 = () => getPlatformProxy<{ARTIFACT_SERVER_D1_DATABASE: D1Database}>({
  configPath: fileURLToPath(new URL("../wrangler.git-store.test.jsonc", import.meta.url)),
  envFiles: [],
  persist: false,
  remoteBindings: false,
});

describe("D1 candidate versions", () => {
  let proxy: Awaited<ReturnType<typeof openLocalD1>>;
  let binding: D1Database;
  let fixture: CandidateFixture;
  const installationId = "d1-candidates";

  beforeEach(async () => {
    proxy = await openLocalD1();
    binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    await migrateD1(binding, installationId);
    fixture = {
      mirrorJobVersionIds: async () => z.array(z.object({versionId: z.string()})).parse((await binding.prepare(
        "SELECT version_id AS versionId FROM git_history_jobs WHERE kind = 'mirror-version'",
      ).all()).results).map((row) => row.versionId),
      projectId: defaultProjectId,
      store: createD1ArtifactRepository(binding, installationId),
    };
  });

  afterEach(async () => {
    await proxy.dispose();
  });

  it.for(candidateRepositoryCases)("$name", async ({run}) => {
    await expect(run(fixture)).resolves.toBeUndefined();
  });

  it("CND-003 store: the D1 database itself refuses to point current at a candidate", async () => {
    const first = await seedArtifact(fixture, "trigger-a");
    const staged = await commitOnto(fixture, first.artifact.id, "trigger-b", first.version.id, true);
    await expect(binding.prepare(
      "UPDATE artifacts SET current_version_id = ? WHERE id = ?",
    ).bind(staged.version.id, first.artifact.id).run()).rejects.toThrow("current version must be accepted history");
  });

  it("CND-001 store: re-running the D1 migration keeps candidates and widened idempotency", async () => {
    const first = await seedArtifact(fixture, "rerun-a");
    const staged = await commitOnto(fixture, first.artifact.id, "rerun-b", first.version.id, true);
    await migrateD1(binding, installationId);
    const version = await fixture.store.findVersionRecord(defaultProjectId, first.artifact.id, staged.version.id);
    expect(version?.version).toMatchObject({baseVersionId: first.version.id, state: "candidate"});
    const schema = await binding.prepare(
      "SELECT version FROM artifact_server_schema WHERE component = 'runtime'",
    ).first<number>("version");
    expect(schema).toBe(requiredD1SchemaVersion);
  });
});
