import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {performance} from "node:perf_hooks";

import {describe, expect, it} from "vitest";
import {getPlatformProxy} from "wrangler";

import {migrateD1} from "../src/d1-migrations.js";

const openLocalD1 = () => getPlatformProxy<{
  ARTIFACT_SERVER_D1_DATABASE: D1Database;
}>({
  configPath: fileURLToPath(new URL("../wrangler.git-store.test.jsonc", import.meta.url)),
  envFiles: [],
  persist: false,
  remoteBindings: false,
});

const manifestEntryColumns = [
  "version_id",
  "path",
  "size",
  "media_type",
  "sha256",
  "disposition",
] as const;

const maximumBoundParametersPerStatement = 100;
const rowsPerStatement = Math.floor(
  maximumBoundParametersPerStatement / manifestEntryColumns.length,
);

const largeProbeEnabled =
  process.env["ARTIFACT_SERVER_D1_FINAL_BATCH_LIMITS"] === "1" ||
  process.env["ARTIFACT_SERVER_D1_FINAL_BATCH_LIMITS"] === "true";

const probeFileCounts = largeProbeEnabled
  ? [40, 1_000, 3_301, 10_000]
  : [40];

const projectId = "prj_default";
const publisherPrincipalId = "principal-d1-batch-limits";
const createdAt = "2026-09-26T00:00:00.000Z";

const artifactIdFor = (versionId: string): string => `art-${versionId}`;

interface BatchResult {
  readonly fileCount: number;
  readonly statementCount: number;
  readonly outcome: "ok" | "error";
  readonly milliseconds: number;
  error: string | undefined;
}

const longPathPrefix =
  "assets/very-long-directory-name-for-realistic-path-length/" +
  "another-segment-to-reach-roughly-one-hundred-characters/";

const sha256Hex = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const generateManifestRows = (
  versionId: string,
  fileCount: number,
  offset = 0,
): readonly (readonly (string | number)[])[] =>
  Array.from({length: fileCount}, (_, index) => {
    const number = offset + index + 1;
    const path = `${longPathPrefix}file-${String(number).padStart(5, "0")}.bin`;
    const sha256 = sha256Hex(path);
    return [
      versionId,
      path,
      1024 + (number % 1024),
      "application/octet-stream",
      sha256,
      number % 2 === 0 ? "inline" : "attachment",
    ] as const;
  });

const chunkedInsertStatements = (
  database: D1Database,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly (string | number)[])[],
): D1PreparedStatement[] => {
  const rowPlaceholders = `(${columns.map(() => "?").join(", ")})`;
  const rowsPerStatementForTable = Math.floor(
    maximumBoundParametersPerStatement / columns.length,
  );
  const statements: D1PreparedStatement[] = [];
  for (let start = 0; start < rows.length; start += rowsPerStatementForTable) {
    const chunk = rows.slice(start, start + rowsPerStatementForTable);
    statements.push(
      database
        .prepare(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${chunk.map(() => rowPlaceholders).join(", ")}`,
        )
        .bind(...chunk.flat()),
    );
  }
  return statements;
};

const seedArtifactAndVersion = async (
  database: D1Database,
  versionId: string,
): Promise<string> => {
  const artifactId = artifactIdFor(versionId);
  await database.batch([
    database
      .prepare(
        `INSERT INTO artifacts (
          id, project_id, name, search_name, access_setting,
          current_version_id, comment_revision, created_at, deleted_at
        ) VALUES (?, ?, ?, ?, 'account_required', NULL, 0, ?, NULL)`,
      )
      .bind(artifactId, projectId, "Batch Limits", "batch-limits", createdAt),
    database
      .prepare(
        `INSERT INTO versions (
          id, project_id, artifact_id, number, manifest_digest, entry_path,
          routing_mode, content_token, publisher_principal_id, created_at
        ) VALUES (?, ?, ?, ?, ?, 'index.html', 'static', ?, ?, ?)`,
      )
      .bind(
        versionId,
        projectId,
        artifactId,
        1,
        "0".repeat(64),
        `token-${versionId}`,
        publisherPrincipalId,
        createdAt,
      ),
  ]);
  return artifactId;
};

const measureBatch = async (
  database: D1Database,
  statements: D1PreparedStatement[],
): Promise<{readonly milliseconds: number; readonly error?: string}> => {
  const started = performance.now();
  try {
    await database.batch(statements);
    return {milliseconds: performance.now() - started};
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {milliseconds: performance.now() - started, error: message};
  }
};

const tryChunkedManifestBatch = async (
  database: D1Database,
  fileCount: number,
  versionId: string,
): Promise<BatchResult> => {
  await seedArtifactAndVersion(database, versionId);
  const rows = generateManifestRows(versionId, fileCount);
  const statements = chunkedInsertStatements(
    database,
    "manifest_entries",
    manifestEntryColumns,
    rows,
  );
  const {milliseconds, error} = await measureBatch(database, statements);
  return {
    fileCount,
    statementCount: statements.length,
    outcome: error === undefined ? "ok" : "error",
    milliseconds,
    error,
  };
};

const trySimulatedFinalBatch = async (
  database: D1Database,
  fileCount: number,
  versionId: string,
): Promise<BatchResult> => {
  const uploadId = `upl-${versionId}`;
  const artifactId = artifactIdFor(versionId);
  await database.batch([
    database
      .prepare(
        `INSERT INTO artifacts (
          id, project_id, name, search_name, access_setting,
          current_version_id, comment_revision, created_at, deleted_at
        ) VALUES (?, ?, ?, ?, 'account_required', NULL, 0, ?, NULL)`,
      )
      .bind(artifactId, projectId, "Batch Limits", "batch-limits", createdAt),
    database
      .prepare(
        `INSERT INTO versions (
          id, project_id, artifact_id, number, manifest_digest, entry_path,
          routing_mode, content_token, publisher_principal_id, created_at
        ) VALUES (?, ?, ?, ?, ?, 'index.html', 'static', ?, ?, ?)`,
      )
      .bind(
        versionId,
        projectId,
        artifactId,
        1,
        "0".repeat(64),
        `token-${versionId}`,
        publisherPrincipalId,
        createdAt,
      ),
    database
      .prepare(
        `INSERT INTO staged_uploads (
          id, project_id, principal_id, status, manifest_digest, entry_path,
          routing_mode, created_at, expires_at
        ) VALUES (?, ?, ?, 'open', ?, 'index.html', 'static', ?, ?)`,
      )
      .bind(
        uploadId,
        projectId,
        publisherPrincipalId,
        "0".repeat(64),
        createdAt,
        "2026-10-26T00:00:00.000Z",
      ),
  ]);

  const rows = generateManifestRows(versionId, fileCount);
  const manifestStatements = chunkedInsertStatements(
    database,
    "manifest_entries",
    manifestEntryColumns,
    rows,
  );

  const guardId = `guard-${versionId}`;
  const simulatedStatements: D1PreparedStatement[] = [
    database
      .prepare(
        `UPDATE artifacts SET current_version_id = ? WHERE project_id = ? AND id = ?`,
      )
      .bind(versionId, projectId, artifactId),
    ...manifestStatements,
    database
      .prepare(
        `INSERT INTO actions (
          id, project_id, artifact_id, version_id, action, principal_id,
          authorized_by_principal_id, idempotency_key, created_at
        ) VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'publish', ?, NULL, ?, ?)`,
      )
      .bind(projectId, artifactId, versionId, publisherPrincipalId, `idem-${versionId}`, createdAt),
    database
      .prepare(
        `INSERT INTO idempotency_records (
          project_id, idempotency_key, input_digest, artifact_id, version_id,
          operation, access_setting, tags_json, created_at
        ) VALUES (?, ?, ?, ?, ?, 'publish', NULL, NULL, ?)`,
      )
      .bind(
        projectId,
        `idem-${versionId}`,
        "0".repeat(64),
        artifactId,
        versionId,
        createdAt,
      ),
    database
      .prepare(
        `UPDATE staged_uploads SET status = 'committed', committed_version_id = ?
         WHERE project_id = ? AND id = ? AND principal_id = ? AND status = 'open'`,
      )
      .bind(versionId, projectId, uploadId, publisherPrincipalId),
    database
      .prepare(
        `INSERT OR IGNORE INTO git_history_jobs (
          id, installation_id, project_id, artifact_id, version_id,
          kind, state, attempts, file_copy_limit_bytes,
          version_copy_limit_bytes, maximum_copied_files,
          storage_budget_bytes, copy_policy_digest, lease_expires_at,
          available_at, last_error, created_at, updated_at
        )
        SELECT ?, setting.installation_id, setting.project_id, ?, ?,
          'mirror-version', 'queued', 0, setting.file_copy_limit_bytes,
          setting.version_copy_limit_bytes, setting.maximum_copied_files,
          setting.storage_budget_bytes, ?, ?,
          ?, NULL, ?, ?
        FROM git_history_project_settings setting
        WHERE setting.project_id = ?`,
      )
      .bind(
        `job-${versionId}`,
        artifactId,
        versionId,
        "policy-digest",
        "2026-10-26T00:00:00.000Z",
        createdAt,
        createdAt,
        createdAt,
        projectId,
      ),
    database
      .prepare(
        `INSERT INTO mutation_checks (id, succeeded)
         VALUES (?, CASE WHEN EXISTS (SELECT 1 FROM artifacts WHERE id = ?) THEN 1 ELSE 0 END)`,
      )
      .bind(guardId, artifactId),
    database.prepare(`DELETE FROM mutation_checks WHERE id = ?`).bind(guardId),
  ];

  const {milliseconds, error} = await measureBatch(database, simulatedStatements);
  return {
    fileCount,
    statementCount: simulatedStatements.length,
    outcome: error === undefined ? "ok" : "error",
    milliseconds,
    error,
  };
};

const preparedManifestEntryColumns = [
  "upload_id",
  "path",
  "size",
  "media_type",
  "sha256",
  "disposition",
] as const;

const createPreparedManifestTable = async (database: D1Database): Promise<void> => {
  await database.prepare(`
    CREATE TABLE IF NOT EXISTS prepared_manifest_entries (
      upload_id TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      disposition TEXT NOT NULL,
      PRIMARY KEY (upload_id, path)
    )
  `).run();
};

const seedPreparedManifestEntries = async (
  database: D1Database,
  uploadId: string,
  fileCount: number,
): Promise<void> => {
  const rows = generateManifestRows("ignored", fileCount).map((row) => {
    // Drop the generated version_id column; prepared_manifest_entries does not
    // store it.
    const [, ...entryValues] = row;
    const withUpload: (string | number)[] = [uploadId];
    withUpload.push(...entryValues);
    return withUpload;
  });
  const statements = chunkedInsertStatements(
    database,
    "prepared_manifest_entries",
    preparedManifestEntryColumns,
    rows,
  );
  await database.batch(statements);
};

const seedStagedUpload = async (
  database: D1Database,
  uploadId: string,
): Promise<void> => {
  await database.prepare(`
    INSERT INTO staged_uploads (
      id, project_id, principal_id, status, manifest_digest, entry_path,
      routing_mode, created_at, expires_at
    ) VALUES (?, ?, ?, 'open', ?, 'index.html', 'static', ?, ?)
  `).bind(
    uploadId,
    projectId,
    publisherPrincipalId,
    "0".repeat(64),
    createdAt,
    "2026-10-26T00:00:00.000Z",
  ).run();
};

const tryPreparedManifestBatch = async (
  database: D1Database,
  fileCount: number,
  uploadId: string,
  versionId: string,
): Promise<BatchResult> => {
  await seedArtifactAndVersion(database, versionId);
  await seedStagedUpload(database, uploadId);
  await createPreparedManifestTable(database);
  await seedPreparedManifestEntries(database, uploadId, fileCount);

  const statements = [
    database.prepare(`
      INSERT INTO manifest_entries (
        version_id, path, size, media_type, sha256, disposition
      )
      SELECT ?, path, size, media_type, sha256, disposition
      FROM prepared_manifest_entries
      WHERE upload_id = ?
    `).bind(versionId, uploadId),
    database.prepare(`
      DELETE FROM prepared_manifest_entries WHERE upload_id = ?
    `).bind(uploadId),
  ];

  const {milliseconds, error} = await measureBatch(database, statements);
  return {
    fileCount,
    statementCount: statements.length,
    outcome: error === undefined ? "ok" : "error",
    milliseconds,
    error,
  };
};

const bisectMaximumFileCount = async (
  database: D1Database,
  runner: (database: D1Database, fileCount: number, versionId: string) => Promise<BatchResult>,
  low: number,
  high: number,
): Promise<number> => {
  let currentLow = low;
  let currentHigh = high;
  while (currentHigh - currentLow > rowsPerStatement) {
    const mid = currentLow + Math.floor((currentHigh - currentLow) / 2);
    // eslint-disable-next-line no-await-in-loop
    const result = await runner(database, mid, `ver-bisect-${mid}`);
    if (result.outcome === "ok") {
      currentLow = mid;
    } else {
      currentHigh = mid;
    }
  }
  return currentLow;
};

const runSizeSeries = async (
  database: D1Database,
  label: string,
  runner: (database: D1Database, fileCount: number, versionId: string) => Promise<BatchResult>,
  fileCounts: readonly number[],
): Promise<BatchResult[]> => {
  const results: BatchResult[] = [];
  let lastSuccess = 0;
  for (const fileCount of fileCounts) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runner(database, fileCount, `ver-${label}-${fileCount}`);
    results.push(result);
    if (result.outcome === "ok") {
      lastSuccess = fileCount;
    } else if (fileCount > lastSuccess) {
      // eslint-disable-next-line no-await-in-loop
      const boundary = await bisectMaximumFileCount(database, runner, lastSuccess, fileCount);
      result.error = `${result.error ?? "failed"} (bisected maximum ≈ ${boundary} files)`;
    }
  }
  return results;
};

const formatResultsTable = (results: readonly BatchResult[]): string =>
  results
    .map(
      (result) =>
        `| ${result.fileCount.toLocaleString()} | ${result.statementCount} | ${result.outcome} | ${result.milliseconds.toFixed(2)} | ${result.error ?? ""} |`,
    )
    .join("\n");

describe("D1 final-commit batch limits", () => {
  it(
    "measures chunked INSERT INTO manifest_entries batch sizes",
    async () => {
      const proxy = await openLocalD1();
      const database = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
      try {
        await migrateD1(database, "d1-final-batch-limits-insert");
        const results = await runSizeSeries(
          database,
          "chunked-insert",
          tryChunkedManifestBatch,
          probeFileCounts,
        );
        // eslint-disable-next-line no-console
        console.log("Chunked manifest insert results:\n" + formatResultsTable(results));
        expect(results[0]?.outcome).toBe("ok");
      } finally {
        await proxy.dispose();
      }
    },
    largeProbeEnabled ? 120_000 : 30_000,
  );

  it(
    "measures simulated full final-commit batch sizes",
    async () => {
      const proxy = await openLocalD1();
      const database = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
      try {
        await migrateD1(database, "d1-final-batch-limits-final");
        const results = await runSizeSeries(
          database,
          "simulated-final",
          trySimulatedFinalBatch,
          probeFileCounts,
        );
        // eslint-disable-next-line no-console
        console.log("Simulated final batch results:\n" + formatResultsTable(results));
        expect(results[0]?.outcome).toBe("ok");
      } finally {
        await proxy.dispose();
      }
    },
    largeProbeEnabled ? 180_000 : 30_000,
  );

  it(
    "measures prepared-manifest INSERT-SELECT batch sizes",
    async () => {
      const proxy = await openLocalD1();
      const database = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
      try {
        await migrateD1(database, "d1-final-batch-limits-prepared");
        const results: BatchResult[] = [];
        for (const fileCount of probeFileCounts) {
          const uploadId = `upl-prepared-${fileCount}`;
          const versionId = `ver-prepared-${fileCount}`;
          // eslint-disable-next-line no-await-in-loop
          const result = await tryPreparedManifestBatch(database, fileCount, uploadId, versionId);
          results.push(result);
        }
        // eslint-disable-next-line no-console
        console.log("Prepared manifest insert-select results:\n" + formatResultsTable(results));
        expect(results[0]?.outcome).toBe("ok");
      } finally {
        await proxy.dispose();
      }
    },
    largeProbeEnabled ? 180_000 : 30_000,
  );

  it(
    "probes whether the local D1 binding enforces a per-invocation query limit",
    async () => {
      const proxy = await openLocalD1();
      const database = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
      try {
        await migrateD1(database, "d1-final-batch-limits-query-count");
        const probeCounts = largeProbeEnabled ? [1_000, 2_000, 5_000] : [100, 500];
        const outcomes = await Promise.all(
          probeCounts.map(async (count) => {
            const statements = Array.from({length: count}, (_, index) =>
              database.prepare("SELECT ? AS n").bind(index),
            );
            const {error} = await measureBatch(database, statements);
            return {count, outcome: error === undefined ? "ok" : "error", error};
          }),
        );
        // eslint-disable-next-line no-console
        console.log("Query-count probe results:", JSON.stringify(outcomes));
        expect(outcomes[0]?.outcome).toBe("ok");
      } finally {
        await proxy.dispose();
      }
    },
    60_000,
  );
});
