import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {systemAttribution} from "../../src/core/action-attribution.js";
import {memberAdmissions} from "../../src/core/identity-ports.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";

const installationId = "admission-installation";

describe("SQLite member admission and activity facts", () => {
  let dataDirectory: string;
  let databasePath: string;
  let artifacts: SqliteArtifactRepository;
  let identity: SqliteIdentityRepository;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-admission-"));
    databasePath = path.join(dataDirectory, "artifact-server.db");
    artifacts = new SqliteArtifactRepository(databasePath, installationId);
    identity = new SqliteIdentityRepository(databasePath);
  });

  afterEach(async () => {
    identity.close();
    artifacts.close();
    await rm(dataDirectory, {force: true, recursive: true});
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
    await identity.admitMember({
      admittedHow: memberAdmissions.automatic,
      attribution: systemAttribution,
      createdAt: "2026-10-01T09:10:00.000Z",
      displayName: "Grace Hopper",
      email: "grace@example.test",
      id: "member_grace",
      installationId,
      role: "member",
    });

    const listed = await identity.listMembers(installationId);

    expect(listed.map((member) => ({
      admittedHow: member.admittedHow,
      admittedByName: member.admittedByName,
      id: member.id,
      lastActiveAt: member.lastActiveAt,
    }))).toEqual([
      {admittedHow: "owner", admittedByName: null, id: "member_owner", lastActiveAt: null},
      {admittedHow: "manual", admittedByName: "Local administrator", id: "member_ada", lastActiveAt: null},
      {admittedHow: "automatic", admittedByName: null, id: "member_grace", lastActiveAt: null},
    ]);
  });

  test("a database created before this revision gains the columns and keeps existing members unattributed", async () => {
    identity.close();
    artifacts.close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP TABLE installation_members;
      CREATE TABLE installation_members (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
        status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (installation_id, email)
      );
      INSERT INTO installation_members VALUES (
        'member_legacy', '${installationId}', 'legacy@example.test', 'Legacy Person',
        'member', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      ALTER TABLE managed_api_keys DROP COLUMN last_used_at;
      PRAGMA user_version = 18;
    `);
    legacy.close();

    artifacts = new SqliteArtifactRepository(databasePath, installationId);
    identity = new SqliteIdentityRepository(databasePath);

    const columns = (table: string) => z.array(z.object({name: z.string()}))
      .parse(new DatabaseSync(databasePath).prepare(`PRAGMA table_info(${table})`).all())
      .map((column) => column.name);
    expect(columns("installation_members")).toEqual(expect.arrayContaining([
      "admission_method", "admitted_by_principal_id", "last_active_at",
    ]));
    expect(columns("managed_api_keys")).toContain("last_used_at");
    expect(await identity.listMembers(installationId)).toEqual([
      expect.objectContaining({
        admittedHow: null,
        admittedByName: null,
        id: "member_legacy",
        lastActiveAt: null,
      }),
    ]);
  });

  test("the actions table has a partial subject index for administration lookups", () => {
    const indexes = z.array(z.object({name: z.string(), partial: z.number()}))
      .parse(new DatabaseSync(databasePath).prepare("PRAGMA index_list(actions)").all());
    expect(indexes).toEqual(expect.arrayContaining([
      {name: "actions_subject", partial: 1},
    ]));
  });
});
