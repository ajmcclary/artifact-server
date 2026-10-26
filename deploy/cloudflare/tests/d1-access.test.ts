// deploy/cloudflare/tests/d1-access.test.ts
import {fileURLToPath} from "node:url";

import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {getPlatformProxy} from "wrangler";
import {z} from "zod";

import {systemAttribution} from "../../../src/core/action-attribution.js";
import {
  accessRepositoryCases,
  caseManager,
  type AccessFixture,
} from "../../../tests/support/access-repository-cases.js";
import {createD1AccessRepository} from "../src/d1-access-repository.js";
import {createD1ArtifactRepository} from "../src/d1-artifact-repository.js";
import {createD1IdentityRepository} from "../src/d1-identity-repository.js";
import {migrateD1, requiredD1SchemaVersion} from "../src/d1-migrations.js";

const openLocalD1 = () => getPlatformProxy<{ARTIFACT_SERVER_D1_DATABASE: D1Database}>({
  configPath: fileURLToPath(new URL("../wrangler.git-store.test.jsonc", import.meta.url)),
  envFiles: [],
  persist: false,
  remoteBindings: false,
});

const clock = {now: () => new Date("2026-10-26T12:00:00.000Z")};
const rowsSchema = z.array(z.object({
  action: z.string(),
  projectId: z.string().nullable(),
  subjectId: z.string().nullable(),
}));

describe("D1 access repository", () => {
  let proxy: Awaited<ReturnType<typeof openLocalD1>>;
  let fixture: AccessFixture;
  const installationId = "d1-access";

  beforeEach(async () => {
    proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    await migrateD1(binding, installationId);
    const artifacts = createD1ArtifactRepository(binding, installationId);
    fixture = {
      actions: async () => rowsSchema.parse((await binding.prepare(
        `SELECT action, project_id AS projectId, subject_id AS subjectId
         FROM actions ORDER BY created_at, rowid`,
      ).all()).results),
      installationId,
      otherInstallation: async () => ({
        installationId: "d1-access-other",
        store: createD1AccessRepository(binding, clock),
      }),
      seedProject: async (projectId, archived = false) => {
        await artifacts.createProject({
          archivedAt: null,
          attribution: caseManager,
          createdAt: "2026-10-26T11:00:00.000Z",
          id: projectId,
          installationId,
          name: projectId,
        });
        if (archived) {
          await artifacts.setProjectArchive({
            archivedAt: "2026-10-26T11:30:00.000Z",
            attribution: caseManager,
            changedAt: "2026-10-26T11:30:00.000Z",
            projectId,
          });
        }
      },
      store: createD1AccessRepository(binding, clock),
    };
  });

  afterEach(async () => {
    await proxy.dispose();
  });

  it.for(accessRepositoryCases)("$name", async ({run}) => {
    await expect(run(fixture)).resolves.toBeUndefined();
  });

  it("an existing schema-20 database upgrades with every project open/editor and every key unscoped", async () => {
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    await fixture.seedProject("prj_second");
    await createD1IdentityRepository(binding).createApiKey({
      authorizedByPrincipalId: "mem_admin",
      capabilities: ["artifact:read"],
      createdAt: "2026-10-26T11:00:00.000Z",
      expiresAt: "2027-10-26T11:00:00.000Z",
      id: "key_upgrade",
      installationId,
      name: "Reader",
      prefix: "as_key_upgrade",
      principalId: "service:key_upgrade",
      principalKind: "service",
      projectIds: [],
      revokedAt: null,
      rotatedFromId: null,
      secretDigest: "digest",
    }, systemAttribution);
    await binding.batch([
      "DROP TABLE access_grants",
      "DROP TABLE installation_access_policy",
      "ALTER TABLE projects DROP COLUMN access_mode",
      "ALTER TABLE projects DROP COLUMN default_member_role",
      "ALTER TABLE projects DROP COLUMN access_revision",
      "ALTER TABLE managed_api_keys DROP COLUMN project_ids_json",
      "UPDATE artifact_server_schema SET version = 20 WHERE component = 'runtime'",
    ].map((statement) => binding.prepare(statement)));

    await migrateD1(binding, installationId);

    const projects = await fixture.store.listProjectAccess(installationId);
    expect(projects.map((project) => project.projectId).toSorted()).toEqual(["prj_default", "prj_second"]);
    for (const project of projects) {
      expect(project).toMatchObject({accessMode: "open", defaultMemberRole: "editor", revision: 0});
    }
    const keys = await binding.prepare("SELECT project_ids_json AS projectIds FROM managed_api_keys").all();
    expect(keys.results).toEqual([{projectIds: "[]"}]);
    const version = await binding.prepare(
      "SELECT version FROM artifact_server_schema WHERE component = 'runtime'",
    ).first<number>("version");
    expect(version).toBe(requiredD1SchemaVersion);
  });
});
