import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  actorSnapshotOf,
  attributionOf,
  systemAttribution,
} from "../../src/core/action-attribution.js";
import {membershipRoles, principalKinds} from "../../src/core/identity.js";
import {defaultProjectId} from "../../src/core/model.js";
import {
  attributedInsert,
  companionIdempotencyKey,
  maximumActionDetailBytes,
  positionalActionInsertOnceSql,
  positionalActionInsertSql,
  positionalActionOnceValues,
  positionalActionValues,
  publicLinkTransition,
  serializeActionDetail,
} from "../../src/storage/action-insert.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";

const storedRowSchema = z.object({
  action: z.string(),
  actorKind: z.string().nullable(),
  actorName: z.string().nullable(),
  artifactId: z.string().nullable(),
  detailJson: z.string().nullable(),
  idempotencyKey: z.string(),
  principalId: z.string().nullable(),
  projectId: z.string().nullable(),
  subjectId: z.string().nullable(),
});

describe("the shared action writer", () => {
  let directory: string;
  let databasePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "action-insert-"));
    databasePath = path.join(directory, "artifact-server.db");
    new SqliteArtifactRepository(databasePath, "action-insert-installation").close();
  });

  afterEach(async () => {
    await rm(directory, {force: true, recursive: true});
  });

  test("an installation row stores its actor snapshot, subject and detail without an artifact", () => {
    const administrator = {
      authorizedByPrincipalId: null,
      capabilities: [],
      displayName: "Rosa Santoro",
      id: "member_rosa",
      installationId: "action-insert-installation",
      kind: principalKinds.human,
      membershipRole: membershipRoles.administrator,
    } as const;
    const insert = attributedInsert(attributionOf(administrator), {
      action: "member_admit",
      createdAt: "2026-10-01T12:00:00.000Z",
      detail: {how: "manual", role: "member", subjectName: "Dana Okonkwo"},
      idempotencyKey: "member_admit:member_dana",
      projectId: null,
      subjectId: "member_dana",
    });
    const database = new DatabaseSync(databasePath);
    try {
      database.prepare(positionalActionInsertSql).run(...positionalActionValues(insert));
      const row = storedRowSchema.parse(database.prepare(`
        SELECT action, actor_kind AS actorKind, actor_name AS actorName,
          artifact_id AS artifactId, detail_json AS detailJson,
          idempotency_key AS idempotencyKey, principal_id AS principalId,
          project_id AS projectId, subject_id AS subjectId
        FROM actions WHERE idempotency_key = ?
      `).get("member_admit:member_dana"));
      expect(row).toEqual({
        action: "member_admit",
        actorKind: "human",
        actorName: "Rosa Santoro",
        artifactId: null,
        detailJson: JSON.stringify({how: "manual", role: "member", subjectName: "Dana Okonkwo"}),
        idempotencyKey: "member_admit:member_dana",
        principalId: "member_rosa",
        projectId: null,
        subjectId: "member_dana",
      });
    } finally {
      database.close();
    }
  });

  test("a system row has no principal and no actor", () => {
    const insert = attributedInsert(systemAttribution, {
      action: "key_issue",
      createdAt: "2026-10-01T12:00:00.000Z",
      detail: {how: "bootstrap", subjectName: "Bootstrap"},
      idempotencyKey: "key_issue:key_bootstrap",
      projectId: null,
      subjectId: "key_bootstrap",
    });
    expect(insert.principalId).toBeNull();
    expect(insert.actor).toBeNull();
    expect(positionalActionValues(insert)[14]).toBeNull();
  });

  test("an insert-once row is written once however often it is offered", () => {
    const agent = {
      actor: {displayName: "site", kind: principalKinds.service},
      authorizedByPrincipalId: null,
      principalId: "service:key_site",
    };
    const insert = attributedInsert(agent, {
      action: "dispatch_addressed",
      createdAt: "2026-10-01T12:00:00.000Z",
      detail: {subjectName: "site"},
      idempotencyKey: "dispatch_addressed:dsp_1",
      // Dispatch rows are project-scoped (slice 2a scope rules).
      projectId: defaultProjectId,
      subjectId: "dsp_1",
    });
    const database = new DatabaseSync(databasePath);
    try {
      database.prepare(positionalActionInsertOnceSql).run(...positionalActionOnceValues(insert));
      database.prepare(positionalActionInsertOnceSql).run(...positionalActionOnceValues(insert));
      const count = z.object({count: z.number()}).parse(database.prepare(
        "SELECT COUNT(*) AS count FROM actions WHERE idempotency_key = ?",
      ).get("dispatch_addressed:dsp_1")).count;
      expect(count).toBe(1);
    } finally {
      database.close();
    }
  });

  test("detail larger than the limit is refused instead of truncated", () => {
    const oversized = {subjectName: "x".repeat(maximumActionDetailBytes)};
    expect(() => serializeActionDetail(oversized)).toThrow(RangeError);
    expect(serializeActionDetail(null)).toBeNull();
    expect(serializeActionDetail({subjectName: "ok"})).toBe("{\"subjectName\":\"ok\"}");
  });

  test("only a change in direction produces a public-link transition", () => {
    expect(publicLinkTransition("account_required", "public_link")).toBe("public_link_enable");
    expect(publicLinkTransition("public_link", "account_required")).toBe("public_link_disable");
    expect(publicLinkTransition(null, "public_link")).toBe("public_link_enable");
    expect(publicLinkTransition(null, "account_required")).toBeNull();
    expect(publicLinkTransition("public_link", "public_link")).toBeNull();
    expect(companionIdempotencyKey("publish-1")).toBe("publish-1:public_link");
  });

  test("the actor snapshot copies the principal's display name and kind", () => {
    expect(actorSnapshotOf({displayName: "Release key", kind: principalKinds.service}))
      .toEqual({displayName: "Release key", kind: "service"});
  });
});
