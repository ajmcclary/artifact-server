import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {cpus, platform, release, tmpdir} from "node:os";
import path from "node:path";
import {performance} from "node:perf_hooks";
import {DatabaseSync} from "node:sqlite";

import {Command} from "commander";
import {z} from "zod";

import {
  defaultGitHistoryFileCopyBytes,
  defaultGitHistoryVersionCopyBytes,
} from "../../src/git-history/git-history-capability.js";
import {SqliteArtifactRepository} from
  "../../src/storage/sqlite-artifact-repository.js";

const optionsSchema = z.object({
  count: z.coerce.number().int().min(1).max(3_301),
  maximumMilliseconds: z.coerce.number().int().min(1_000).max(120_000),
  output: z.string().min(1),
  passes: z.coerce.number().int().min(1).max(104),
});
const sqliteVersionSchema = z.object({version: z.string()});
const historyTimestamp = "2026-01-01T00:00:00.000Z";
const projectId = "prj_default";
const installationId = "git-backlog-measurement";

const program = new Command()
  .name("git-history-backlog")
  .description("Measure bounded Git queue reconciliation over synthetic saved versions.")
  .option("--count <versions>", "saved versions, maximum 3301", "1000")
  .option("--passes <count>", "claim passes, maximum 104", "30")
  .option("--maximum-milliseconds <time>", "wall-time budget, maximum 120000", "60000")
  .option("--output <path>", "JSON report path",
    "project/evidence/git-history-backlog-baseline.json");

interface ScenarioResult {
  readonly fixtureDigest: string;
  readonly mode: "many-artifacts" | "deep-history";
  readonly versionCount: number;
  readonly enableMilliseconds: number;
  readonly claimMilliseconds: readonly number[];
  readonly medianClaimMilliseconds: number;
  readonly maximumClaimMilliseconds: number;
  readonly claimed: number;
  readonly pendingJobs: number;
  readonly sqliteVersion: string;
}

async function main(): Promise<void> {
  program.parse();
  const options = optionsSchema.parse(program.opts());
  const startedAt = new Date().toISOString();
  const results = [
    await runScenario("many-artifacts", options),
    await runScenario("deep-history", options),
  ];
  const report = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim(),
    environment: {
      cpu: cpus()[0]?.model ?? "unknown",
      node: process.version,
      os: `${platform()} ${release()}`,
      storage: "temporary SQLite on the current filesystem",
    },
    fixture: {count: options.count, passes: options.passes},
    note: "Bounded diagnostic; 30 passes do not establish tail latency or a speedup.",
    startedAt,
    completedAt: new Date().toISOString(),
    scenarios: results,
  };
  const outputPath = path.resolve(options.output);
  await mkdir(path.dirname(outputPath), {recursive: true});
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write([
    `Git history backlog diagnostic: ${options.count} versions, ${options.passes} passes.`,
    ...results.map((result) =>
      `${result.mode}: enable ${result.enableMilliseconds.toFixed(2)} ms; ` +
      `claim median ${result.medianClaimMilliseconds.toFixed(2)} ms, ` +
      `max ${result.maximumClaimMilliseconds.toFixed(2)} ms; ` +
      `${result.pendingJobs} pending jobs.`),
    `Report: ${outputPath}`,
  ].join("\n") + "\n");
}

async function runScenario(
  mode: ScenarioResult["mode"],
  options: z.infer<typeof optionsSchema>,
): Promise<ScenarioResult> {
  const directory = await mkdtemp(path.join(tmpdir(), "artifact-server-git-backlog-"));
  const databasePath = path.join(directory, "artifact-server.db");
  let store: SqliteArtifactRepository | null = null;
  try {
    store = new SqliteArtifactRepository(databasePath, installationId);
    store.close();
    store = null;
    const sqliteVersion = seedVersions(databasePath, mode, options.count);
    store = new SqliteArtifactRepository(databasePath, installationId);
    const readyStore = store;
    const now = Date.now();
    const enabledAt = new Date(now).toISOString();
    const enableStart = performance.now();
    await readyStore.storeProjectGitHistorySetting({
      enabled: true,
      limits: {
        fileCopyBytes: defaultGitHistoryFileCopyBytes,
        logicalCopiedBytes: 0,
        logicalReservedBytes: 0,
        storageBudgetBytes: null,
        versionCopyBytes: defaultGitHistoryVersionCopyBytes,
      },
      projectId,
      updatedAt: enabledAt,
      updatedByPrincipalId: "performance-fixture",
    });
    const enableMilliseconds = performance.now() - enableStart;
    const samples: number[] = [];
    let claimed = 0;
    const budgetStarted = performance.now();
    const leaseExpiresAt = new Date(now + 120_000).toISOString();
    const runPass = async (index: number): Promise<void> => {
      if (index >= options.passes) return;
      if (performance.now() - budgetStarted > options.maximumMilliseconds) {
        throw new Error(`${mode} exceeded the bounded diagnostic wall-time budget.`);
      }
      const passStart = performance.now();
      const job = await readyStore.claimGitHistoryJob(enabledAt, leaseExpiresAt);
      samples.push(performance.now() - passStart);
      if (job !== null) claimed += 1;
      await runPass(index + 1);
    };
    await runPass(0);
    const progress = await readyStore.readProjectGitHistoryProgress(projectId);
    const ordered = samples.toSorted((left, right) => left - right);
    return {
      fixtureDigest: createHash("sha256").update(JSON.stringify({
        count: options.count, mode, timestamp: historyTimestamp,
      })).digest("hex"),
      mode,
      versionCount: options.count,
      enableMilliseconds,
      claimMilliseconds: samples,
      medianClaimMilliseconds: ordered[Math.floor(ordered.length / 2)] ?? 0,
      maximumClaimMilliseconds: ordered.at(-1) ?? 0,
      claimed,
      pendingJobs: progress.pendingJobs,
      sqliteVersion,
    };
  } finally {
    store?.close();
    await rm(directory, {force: true, recursive: true});
  }
}

function seedVersions(
  databasePath: string,
  mode: ScenarioResult["mode"],
  count: number,
): string {
  const database = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
  });
  const artifact = database.prepare(`
    INSERT INTO artifacts (
      id, project_id, name, search_name, access_setting,
      current_version_id, created_at, deleted_at
    ) VALUES (?, ?, ?, ?, 'account_required', NULL, ?, NULL)
  `);
  const version = database.prepare(`
    INSERT INTO versions (
      id, project_id, artifact_id, number, manifest_digest,
      entry_path, routing_mode, content_token,
      publisher_principal_id, created_at
    ) VALUES (?, ?, ?, ?, ?, 'index.html', 'static', ?, ?, ?)
  `);
  const mapping = database.prepare(`
    INSERT INTO git_history_mappings (
      installation_id, project_id, artifact_id, version_id,
      repository_name, commit_id, attempts, copied_bytes, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 'recorded', ?)
  `);
  try {
    const sqliteVersion = sqliteVersionSchema.parse(database.prepare(
      "SELECT sqlite_version() AS version",
    ).get()).version;
    database.exec("BEGIN");
    if (mode === "deep-history") {
      artifact.run("art_backlog_history", projectId, "History", "history", historyTimestamp);
    }
    for (let index = 1; index <= count; index += 1) {
      const suffix = String(index).padStart(6, "0");
      const artifactId = mode === "deep-history"
        ? "art_backlog_history"
        : `art_backlog_${suffix}`;
      if (mode === "many-artifacts") {
        artifact.run(artifactId, projectId, suffix, suffix, historyTimestamp);
      }
      const versionId = `ver_backlog_${suffix}`;
      version.run(
        versionId, projectId, artifactId,
        mode === "deep-history" ? index : 1,
        "0".repeat(64), `content_backlog_${suffix}`,
        "performance-fixture", historyTimestamp,
      );
      if (mode === "deep-history" && index < count) {
        mapping.run(
          installationId, projectId, artifactId, versionId,
          artifactId, `commit_${suffix}`, historyTimestamp,
        );
      }
    }
    database.exec("COMMIT");
    return sqliteVersion;
  } catch (cause) {
    database.exec("ROLLBACK");
    throw cause;
  } finally {
    database.close();
  }
}

void main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : "Git backlog diagnostic failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
