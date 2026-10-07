import {DatabaseSync} from "node:sqlite";
import path from "node:path";

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, test} from "vitest";

import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  type OtlpLogCollector,
  startOtlpLogCollector,
} from "../support/otlp-log-collector.js";

/**
 * A repository failure's span keeps what failed and the driver's redacted
 * message, never the driver error itself: its stack frames name the provider's
 * internals, and a Postgres error's properties name the conflicting value.
 */
describe("repository failure telemetry", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;
  let collector: OtlpLogCollector;
  let lock: DatabaseSync | null = null;

  beforeAll(async () => {
    collector = await startOtlpLogCollector();
  });

  afterAll(async () => {
    await collector.stop();
  });

  beforeEach(async () => {
    installation = await createTestInstallation();
    collector.reset();
  });

  afterEach(async () => {
    lock?.exec("ROLLBACK");
    lock?.close();
    lock = null;
    // Stopping the server flushes its exporter before the next reset.
    if (server !== null) await server.stop();
    server = null;
    await removeTestInstallation(installation);
  });

  /** Another process holds the database's write lock past the server's busy timeout. */
  function holdWriteLock(): void {
    lock = new DatabaseSync(path.join(installation.dataDirectory, "artifact-server.db"));
    lock.exec("BEGIN EXCLUSIVE");
  }

  test("artifact and identity repository failures export a redacted cause, not the driver error", async () => {
    server = await startTestServer(installation, {observability: true});
    holdWriteLock();

    // Creating a project writes through the artifact repository.
    const created = await fetch(`${server.baseUrl}/api/v1/projects`, {
      body: JSON.stringify({name: "Locked project"}),
      headers: {Authorization: `Bearer ${installation.apiToken}`, "Content-Type": "application/json"},
      method: "POST",
    });
    expect(created.status).toBe(500);

    // Issuing a local browser login writes a login attempt through the identity repository.
    const issued = await fetch(`${server.baseUrl}/auth/local`, {
      headers: {Authorization: `Bearer ${installation.browserBootstrapToken}`},
      method: "POST",
    });
    expect(issued.status).toBe(500);

    await collector.waitForSpan("ArtifactRepositoryFailure");
    await collector.waitForSpan("IdentityRepositoryFailure");
    const spans = collector.spans();
    // Still diagnosable: what failed, and the driver's own words.
    expect(spans).toContain("database is locked");
    // Not the driver's stack: no frame from inside the SQLite repositories.
    expect(spans).not.toContain("sqlite-artifact-repository");
    expect(spans).not.toContain("sqlite-identity-repository");
    expect(spans).not.toContain(installation.dataDirectory);
  }, 60_000);
});
