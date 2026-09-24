import {randomBytes} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {describe, expect, test} from "vitest";

import {PostgresDatabase} from "../../src/storage/postgres-database.js";
import {
  captureMeasurementContext,
  imageDigest,
} from "../../project/performance/measurement-context.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const evidencePath = path.join(
  repositoryRoot,
  "project/evidence/postgres-pool-shutdown.json",
);

interface PostgresPoolShutdownEvidence {
  readonly connectionsAfterClose: number;
  readonly connectionsBeforeClose: number;
  readonly note: string;
  readonly postCloseQueryOutcome: string;
  readonly repeatedCloseResolved: boolean;
}

describe("Postgres pool shutdown", () => {
  test("the pool closes exactly once, drains server-side connections, and refuses post-close use", async () => {
    expect.hasAssertions();
    const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
    if (databaseUrl === undefined) {
      throw new Error("Run this test through pnpm test:external-storage-runtime.");
    }
    const applicationName =
      `artifact-server-pool-shutdown-${randomBytes(4).toString("hex")}`;
    const url = Redacted.make(databaseUrl, {label: "pool-shutdown-probe"});
    const database = await PostgresDatabase.open({
      applicationName,
      maxConnections: 2,
      url,
    }, "apply");
    const inspector = await PostgresDatabase.inspect({
      applicationName: `${applicationName}-inspector`,
      maxConnections: 1,
      url,
    });
    const countPoolConnections = (): Promise<number> =>
      inspector.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        const rows = yield* sql<{readonly connections: number}>`
          SELECT COUNT(*)::int AS connections
          FROM pg_stat_activity
          WHERE application_name = ${applicationName}
        `;
        const row = rows[0];
        return row?.connections ?? 0;
      }));

    let evidence: PostgresPoolShutdownEvidence | null = null;
    try {
      await database.health();
      const connectionsBeforeClose = await countPoolConnections();
      expect(connectionsBeforeClose).toBeGreaterThan(0);

      await database.close();
      const connectionsAfterClose = await waitForConnectionCount(
        countPoolConnections,
        0,
      );
      expect(connectionsAfterClose).toBe(0);

      // A second disposal resolves quietly: Scope.close is idempotent, so the
      // pg pool finalizer cannot run twice.
      await database.close();

      const postCloseQueryOutcome = await database.run(Effect.void).then(
        () => "resolved",
        (cause: unknown) => `rejected: ${String(cause)}`,
      );
      expect(postCloseQueryOutcome).toContain("rejected");
      expect(postCloseQueryOutcome).toContain("ManagedRuntime disposed");

      expect(await countPoolConnections()).toBe(0);
      evidence = {
        connectionsAfterClose,
        connectionsBeforeClose,
        note: "T18 SQL-cancellation follow-up against the pinned Postgres container: one PostgresDatabase pool shows at least one server-side connection while open, pg_stat_activity drains to zero after close(), a second close() resolves without reconnecting, and post-close use rejects with 'ManagedRuntime disposed' rather than leaking a usable pool.",
        postCloseQueryOutcome,
        repeatedCloseResolved: true,
      };
    } finally {
      await inspector.close();
      await database.close();
    }

    const postgresImage = process.env["ARTIFACT_SERVER_TEST_POSTGRES_IMAGE"] ??
      "unreported";
    const context = await captureMeasurementContext({
      postgresImage,
      postgresImageDigest: imageDigest(postgresImage),
    });
    await mkdir(path.dirname(evidencePath), {recursive: true});
    await writeFile(
      evidencePath,
      `${JSON.stringify({
        ...context,
        ...evidence,
        probe: "T18-postgres-pool-shutdown",
        target: "postgres-container",
      }, null, 2)}\n`,
      "utf8",
    );
  });
});

async function waitForConnectionCount(
  count: () => Promise<number>,
  expected: number,
): Promise<number> {
  return pollConnectionCount(count, expected, Date.now() + 10_000);
}

async function pollConnectionCount(
  count: () => Promise<number>,
  expected: number,
  deadline: number,
): Promise<number> {
  const observed = await count();
  if (observed === expected || Date.now() >= deadline) return observed;
  await new Promise((resolve) => setTimeout(resolve, 100));
  return pollConnectionCount(count, expected, deadline);
}
