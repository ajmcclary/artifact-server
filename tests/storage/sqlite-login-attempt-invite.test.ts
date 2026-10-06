// tests/storage/sqlite-login-attempt-invite.test.ts
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";

describe("SQLite login attempts carry an invite", () => {
  let dataDirectory: string;
  let databasePath: string;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-login-invite-"));
    databasePath = path.join(dataDirectory, "artifact-server.db");
  });

  afterEach(async () => {
    await rm(dataDirectory, {force: true, recursive: true});
  });

  test("an attempt returns the invite it was started with, and a plain one returns null", async () => {
    const artifacts = new SqliteArtifactRepository(databasePath, "installation");
    const identity = new SqliteIdentityRepository(databasePath);
    try {
      const base = {
        codeVerifier: "verifier",
        createdAt: "2026-10-06T10:00:00.000Z",
        expiresAt: "2026-10-06T10:10:00.000Z",
        nonce: null,
        provider: "workos",
        returnTo: "/review",
      };
      await identity.createLoginAttempt({...base, inviteId: "inv_1", stateDigest: "state-a"});
      await identity.createLoginAttempt({...base, inviteId: null, stateDigest: "state-b"});
      await expect(identity.consumeLoginAttempt("state-a", "workos", "2026-10-06T10:01:00.000Z"))
        .resolves.toMatchObject({inviteId: "inv_1"});
      await expect(identity.consumeLoginAttempt("state-b", "workos", "2026-10-06T10:01:00.000Z"))
        .resolves.toMatchObject({inviteId: null});
    } finally {
      identity.close();
      artifacts.close();
    }
  });

  test("a database created before the column gains it without losing attempts", async () => {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`CREATE TABLE login_attempts (
      state_digest TEXT PRIMARY KEY, provider TEXT NOT NULL, code_verifier TEXT NOT NULL,
      nonce TEXT, return_to TEXT NOT NULL, created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, consumed_at TEXT)`);
    legacy.prepare(`INSERT INTO login_attempts VALUES
      ('legacy', 'workos', 'verifier', NULL, '/review', '2026-10-06T10:00:00.000Z',
       '2026-10-06T10:10:00.000Z', NULL)`).run();
    legacy.close();
    const artifacts = new SqliteArtifactRepository(databasePath, "installation");
    const identity = new SqliteIdentityRepository(databasePath);
    try {
      await expect(identity.consumeLoginAttempt("legacy", "workos", "2026-10-06T10:01:00.000Z"))
        .resolves.toMatchObject({inviteId: null, returnTo: "/review"});
    } finally {
      identity.close();
      artifacts.close();
    }
  });
});
