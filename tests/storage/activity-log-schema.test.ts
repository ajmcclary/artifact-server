import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  artifactActionKinds,
  artifactHistoryActionKinds,
  installationActionKinds,
} from "../../src/core/model.js";
import {
  activityDetailJsonMaxBytes,
  installationScopedActionKinds,
  projectScopedActionKinds,
  recoveredActionId,
  sqliteActionsRebuildStatements,
} from "../../src/storage/activity-log-schema.js";

const columns = `id, project_id, artifact_id, version_id, action, principal_id,
  authorized_by_principal_id, idempotency_key, created_at, subject_id, detail_json`;

describe("activity log schema", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE artifacts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL) STRICT;
      CREATE TABLE versions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL) STRICT;
      CREATE TABLE actions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version_id TEXT NOT NULL REFERENCES versions(id),
        action TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        authorized_by_principal_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO projects (id) VALUES ('prj_a');
      INSERT INTO artifacts (id, project_id) VALUES ('art_a', 'prj_a');
      INSERT INTO versions (id, project_id) VALUES ('ver_a', 'prj_a');
      INSERT INTO actions VALUES (
        'act_legacy', 'prj_a', 'art_a', 'ver_a', 'publish', 'member_a', NULL,
        'publish-a', '2026-09-01T00:00:00.000Z'
      );
    `);
    database.exec("BEGIN;");
    for (const statement of sqliteActionsRebuildStatements({strict: true})) {
      database.exec(statement);
    }
    database.exec("COMMIT;");
  });

  afterEach(() => {
    database.close();
  });

  const insert = (values: readonly (string | null)[]) =>
    database.prepare(
      `INSERT INTO actions (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(...values);

  test("the kind groups partition every installation kind and history keeps the original 14", () => {
    expect([...projectScopedActionKinds, ...installationScopedActionKinds].toSorted())
      .toEqual(Object.values(installationActionKinds).toSorted());
    expect(artifactHistoryActionKinds).toHaveLength(14);
    expect(artifactHistoryActionKinds).not.toContain(artifactActionKinds.publicLinkEnable);
    expect(artifactHistoryActionKinds).not.toContain(artifactActionKinds.publicLinkDisable);
    expect(recoveredActionId("member_admit", "member_a")).toBe("recovered:member_admit:member_a");
  });

  test("the rebuilt table keeps the legacy row and accepts each scope's valid shape", () => {
    expect(database.prepare("SELECT id, actor_name FROM actions").all())
      .toEqual([{actor_name: null, id: "act_legacy"}]);
    insert(["act_member", null, null, null, "member_admit", "member_a", null, "admit-b", "2026-09-02T00:00:00.000Z", "member_b", null]);
    insert(["act_project", "prj_a", null, null, "project_create", "member_a", null, "project-a", "2026-09-02T00:00:00.000Z", "prj_a", JSON.stringify({name: "A"})]);
    insert(["act_public", "prj_a", "art_a", "ver_a", "public_link_enable", "member_a", null, "public-a", "2026-09-02T00:00:00.000Z", null, null]);
    insert(["recovered:key_revoke:key_a", null, null, null, "key_revoke", null, null, "recovered:key_revoke:key_a", "2026-09-02T00:00:00.000Z", "key_a", null]);
  });

  test("the rebuilt table refuses rows outside their scope, unattributed live rows and oversized details", () => {
    expect(() => insert(["bad_scope", "prj_a", "art_a", "ver_a", "member_admit", "member_a", null, "bad-1", "2026-09-02T00:00:00.000Z", "member_b", null])).toThrow(/CHECK/);
    expect(() => insert(["bad_project", null, null, null, "project_create", "member_a", null, "bad-2", "2026-09-02T00:00:00.000Z", "prj_a", null])).toThrow(/CHECK/);
    expect(() => insert(["bad_actor", null, null, null, "member_admit", null, null, "bad-3", "2026-09-02T00:00:00.000Z", "member_b", null])).toThrow(/CHECK/);
    expect(() => insert(["bad_kind", "prj_a", "art_a", "ver_a", "mystery", "member_a", null, "bad-4", "2026-09-02T00:00:00.000Z", null, null])).toThrow(/CHECK/);
    expect(() => insert(["bad_json", "prj_a", null, null, "project_create", "member_a", null, "bad-5", "2026-09-02T00:00:00.000Z", "prj_a", "{not json"])).toThrow(/CHECK/);
    const oversized = JSON.stringify({name: "x".repeat(activityDetailJsonMaxBytes)});
    expect(() => insert(["bad_size", "prj_a", null, null, "project_create", "member_a", null, "bad-6", "2026-09-02T00:00:00.000Z", "prj_a", oversized])).toThrow(/CHECK/);
  });

  test("installation rows cannot reuse an idempotency key", () => {
    insert(["act_one", null, null, null, "key_issue", "member_a", null, "same-key", "2026-09-02T00:00:00.000Z", "key_a", null]);
    expect(() => insert(["act_two", null, null, null, "key_revoke", "member_a", null, "same-key", "2026-09-02T00:00:01.000Z", "key_a", null])).toThrow(/UNIQUE/);
  });
});
