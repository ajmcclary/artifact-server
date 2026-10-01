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

  test("touch advances last active only when the stored instant is five minutes older, and never backwards", async () => {
    await identity.admitMember({
      admittedHow: memberAdmissions.manual,
      attribution: systemAttribution,
      createdAt: "2026-10-01T09:00:00.000Z",
      displayName: "Ada Lovelace",
      email: "ada@example.test",
      id: "member_ada",
      installationId,
      role: "member",
    });
    const lastActive = async () =>
      (await identity.listMembers(installationId))[0]?.lastActiveAt;

    await identity.touch("member_ada", "2026-10-01T12:00:00.000Z");
    expect(await lastActive()).toBe("2026-10-01T12:00:00.000Z");

    await identity.touch("member_ada", "2026-10-01T12:04:59.999Z");
    expect(await lastActive()).toBe("2026-10-01T12:00:00.000Z");

    await identity.touch("member_ada", "2026-10-01T11:00:00.000Z");
    expect(await lastActive()).toBe("2026-10-01T12:00:00.000Z");

    await identity.touch("member_ada", "2026-10-01T12:05:00.001Z");
    expect(await lastActive()).toBe("2026-10-01T12:05:00.001Z");

    await expect(identity.touch("member_unknown", "2026-10-01T12:10:00.000Z"))
      .resolves.toBeUndefined();
  });

  test("touchApiKey records last used, and the key listing names the owner", async () => {
    await identity.admitMember({
      admittedHow: memberAdmissions.manual,
      attribution: systemAttribution,
      createdAt: "2026-10-01T09:00:00.000Z",
      displayName: "Ada Lovelace",
      email: "ada@example.test",
      id: "member_ada",
      installationId,
      role: "member",
    });
    const base = {
      authorizedByPrincipalId: "member_ada",
      capabilities: ["artifact:read"] as const,
      createdAt: "2026-10-01T09:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      installationId,
      revokedAt: null,
      rotatedFromId: null,
    };
    await identity.createApiKey({
      ...base,
      id: "key_member",
      name: "Ada's key",
      prefix: "as_key_key_member_prefix",
      principalId: "member_ada",
      principalKind: "human",
      secretDigest: "digest-member",
    }, systemAttribution);
    await identity.createApiKey({
      ...base,
      id: "key_service",
      name: "Release bot",
      prefix: "as_key_key_service_prefix",
      principalId: "service:key_service",
      principalKind: "service",
      secretDigest: "digest-service",
    }, systemAttribution);

    await identity.touchApiKey("key_service", "2026-10-01T12:00:00.000Z");
    await identity.touchApiKey("key_service", "2026-10-01T12:01:00.000Z");

    const keys = await identity.listApiKeys(installationId);
    expect(keys.map((key) => ({
      id: key.id,
      lastUsedAt: key.lastUsedAt,
      ownerName: key.ownerName,
      revokedByName: key.revokedByName,
    }))).toEqual(expect.arrayContaining([
      {id: "key_member", lastUsedAt: null, ownerName: "Ada Lovelace", revokedByName: null},
      {id: "key_service", lastUsedAt: "2026-10-01T12:00:00.000Z", ownerName: null, revokedByName: null},
    ]));
    expect(keys.every((key) => !("secretDigest" in key))).toBe(true);
  });

  test("a key revoked by rotation names the administrator who rotated it", async () => {
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
    const rotator = {actor: {displayName: owner.displayName, kind: "human" as const}, authorizedByPrincipalId: null, principalId: owner.id};
    const key = {
      authorizedByPrincipalId: owner.id,
      capabilities: ["artifact:read"] as const,
      createdAt: "2026-10-01T09:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      installationId,
      principalKind: "service" as const,
      revokedAt: null,
    };
    await identity.createApiKey({
      ...key,
      id: "key_old",
      name: "Release bot",
      prefix: "as_key_key_old_prefix",
      principalId: "service:key_old",
      rotatedFromId: null,
      secretDigest: "digest-old",
    }, rotator);
    await identity.rotateApiKey(installationId, "key_old", {
      ...key,
      createdAt: "2026-10-01T10:00:00.000Z",
      id: "key_new",
      name: "Release bot",
      prefix: "as_key_key_new_prefix",
      principalId: "service:key_new",
      rotatedFromId: "key_old",
      secretDigest: "digest-new",
    }, "2026-10-01T10:00:00.000Z", rotator);

    const keys = await identity.listApiKeys(installationId);
    expect(keys.map((listed) => [listed.id, listed.revokedByName])).toEqual(expect.arrayContaining([
      ["key_old", "Local administrator"],
      ["key_new", null],
    ]));
  });

  test("the actions table has a partial subject index for administration lookups", () => {
    const indexes = z.array(z.object({name: z.string(), partial: z.number()}))
      .parse(new DatabaseSync(databasePath).prepare("PRAGMA index_list(actions)").all());
    expect(indexes).toEqual(expect.arrayContaining([
      {name: "actions_subject", partial: 1},
    ]));
  });
});
