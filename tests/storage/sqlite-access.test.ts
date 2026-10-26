// tests/storage/sqlite-access.test.ts
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {systemAttribution} from "../../src/core/action-attribution.js";
import {SqliteAccessRepository} from "../../src/storage/sqlite-access-repository.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";
import {requiredSqliteSchemaVersion} from "../../src/storage/sqlite-schema.js";
import {
  accessRepositoryCases,
  caseManager,
  type AccessFixture,
} from "../support/access-repository-cases.js";

const installationId = "access-installation";
const clock = {now: () => new Date("2026-10-26T12:00:00.000Z")};
const rowsSchema = z.array(z.object({
  action: z.string(),
  projectId: z.string().nullable(),
  subjectId: z.string().nullable(),
}));

function readActions(databasePath: string) {
  const database = new DatabaseSync(databasePath, {readOnly: true});
  try {
    return rowsSchema.parse(database.prepare(
      `SELECT action, project_id AS projectId, subject_id AS subjectId
       FROM actions ORDER BY created_at, rowid`,
    ).all());
  } finally {
    database.close();
  }
}

describe("SQLite access repository", () => {
  let dataDirectory: string;
  let databasePath: string;
  let artifacts: SqliteArtifactRepository;
  let access: SqliteAccessRepository;
  const opened: {close(): void}[] = [];
  let fixture: AccessFixture;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-access-"));
    databasePath = path.join(dataDirectory, "artifact-server.db");
    artifacts = new SqliteArtifactRepository(databasePath, installationId);
    access = new SqliteAccessRepository(databasePath, clock);
    fixture = {
      actions: async () => readActions(databasePath),
      installationId,
      otherInstallation: async () => {
        const other = new SqliteAccessRepository(databasePath, clock);
        opened.push(other);
        return {installationId: "other-installation", store: other};
      },
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
      store: access,
    };
  });

  afterEach(async () => {
    for (const store of opened.splice(0)) store.close();
    access.close();
    artifacts.close();
    await rm(dataDirectory, {force: true, recursive: true});
  });

  test.for(accessRepositoryCases)("$name", async ({run}) => {
    await expect(run(fixture)).resolves.toBeUndefined();
  });

  test("the database refuses rule-breaking grant rows written directly", async () => {
    await fixture.seedProject("prj_access");
    const database = new DatabaseSync(databasePath);
    const insert = (id: string, artifactId: string | null, role: string) =>
      database.prepare(`INSERT INTO access_grants (
        installation_id, id, project_id, artifact_id, member_id, role,
        add_permissions_json, remove_permissions_json, expires_at,
        created_at, created_by_principal_id, updated_at, revision
      ) VALUES (?, ?, 'prj_access', ?, 'mem_x', ?, '[]', '[]', NULL, 'x', 'm', 'x', 1)`)
        .run(installationId, id, artifactId, role);
    try {
      expect(() => insert("g_bad_role", null, "owner")).toThrow(/CHECK constraint failed/u);
      expect(() => insert("g_none_artifact", "art_1", "none")).toThrow(/CHECK constraint failed/u);
      insert("g_ok", null, "viewer");
      expect(() => insert("g_duplicate", null, "editor")).toThrow(/UNIQUE constraint failed/u);
      expect(() => database.prepare(
        "UPDATE projects SET access_mode = 'secret' WHERE id = 'prj_access'",
      ).run()).toThrow(/CHECK constraint failed/u);
    } finally {
      database.close();
    }
  });
});

describe("SQLite access upgrade", () => {
  let dataDirectory: string;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-access-upgrade-"));
  });

  afterEach(async () => {
    await rm(dataDirectory, {force: true, recursive: true});
  });

  test("PRM-001-B: a v22 database upgrades with every project open/editor and every key unscoped", async () => {
    const databasePath = path.join(dataDirectory, "artifact-server.db");
    const first = new SqliteArtifactRepository(databasePath, installationId);
    const identity = new SqliteIdentityRepository(databasePath);
    await first.createProject({
      archivedAt: null,
      attribution: caseManager,
      createdAt: "2026-10-26T11:00:00.000Z",
      id: "prj_second",
      installationId,
      name: "Second",
    });
    await identity.createApiKey({
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
    identity.close();
    first.close();

    const downgrade = new DatabaseSync(databasePath);
    downgrade.exec(`
      DROP TABLE access_grants;
      DROP TABLE installation_access_policy;
      ALTER TABLE projects DROP COLUMN access_mode;
      ALTER TABLE projects DROP COLUMN default_member_role;
      ALTER TABLE projects DROP COLUMN access_revision;
      ALTER TABLE managed_api_keys DROP COLUMN project_ids_json;
      PRAGMA user_version = 22;
    `);
    downgrade.close();

    const artifacts = new SqliteArtifactRepository(databasePath, installationId);
    const reopenedIdentity = new SqliteIdentityRepository(databasePath);
    const access = new SqliteAccessRepository(databasePath, clock);
    try {
      const projects = await access.listProjectAccess(installationId);
      expect(projects.map((project) => project.projectId).toSorted()).toEqual(["prj_default", "prj_second"]);
      for (const project of projects) {
        expect(project).toMatchObject({accessMode: "open", defaultMemberRole: "editor", revision: 0});
      }
      const database = new DatabaseSync(databasePath, {readOnly: true});
      try {
        expect(database.prepare("SELECT project_ids_json FROM managed_api_keys").all())
          .toEqual([{project_ids_json: "[]"}]);
        expect(database.prepare("PRAGMA user_version").get())
          .toEqual({user_version: requiredSqliteSchemaVersion});
      } finally {
        database.close();
      }
    } finally {
      access.close();
      reopenedIdentity.close();
      artifacts.close();
    }
  });
});
