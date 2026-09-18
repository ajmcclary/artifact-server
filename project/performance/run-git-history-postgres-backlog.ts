import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import {cpus, platform, release} from "node:os";
import path from "node:path";
import {performance} from "node:perf_hooks";

import {Command} from "commander";
import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {z} from "zod";

import {
  defaultGitHistoryFileCopyBytes,
  defaultGitHistoryVersionCopyBytes,
} from "../../src/git-history/git-history-capability.js";
import {PostgresArtifactRepository} from
  "../../src/storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";

const optionsSchema = z.object({
  count: z.coerce.number().int().min(1).max(3_301),
  maximumMilliseconds: z.coerce.number().int().min(1_000).max(120_000),
  output: z.string().min(1),
  passes: z.coerce.number().int().min(1).max(104),
});
const environmentSchema = z.object({
  ARTIFACT_SERVER_TEST_DATABASE_URL: z.string().min(1),
  ARTIFACT_SERVER_TEST_POSTGRES_IMAGE: z.string().min(1),
  ARTIFACT_SERVER_TEST_PROVIDER_READY_MILLISECONDS: z.coerce.number().int().nonnegative(),
});
const historyTimestamp = "2026-01-01T00:00:00.000Z";
const projectId = "prj_default";

const program = new Command()
  .name("git-history-postgres-backlog")
  .description("Measure bounded Git queue reconciliation against disposable Postgres.")
  .option("--count <versions>", "saved versions, maximum 3301", "1000")
  .option("--passes <count>", "claim passes, maximum 104", "30")
  .option("--maximum-milliseconds <time>", "claim-pass budget, maximum 120000", "60000")
  .option("--output <path>", "JSON report path",
    "project/evidence/git-history-postgres-backlog.json");

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
  readonly fixturePreparationMilliseconds: number;
}

async function main(): Promise<void> {
  program.parse();
  const options = optionsSchema.parse(program.opts());
  const environment = environmentSchema.parse(process.env);
  const connectStarted = performance.now();
  const database = await PostgresDatabase.open({
    applicationName: "artifact-server-git-backlog-diagnostic",
    maxConnections: 4,
    url: Redacted.make(environment.ARTIFACT_SERVER_TEST_DATABASE_URL),
  }, "apply");
  const connectAndMigrateMilliseconds = performance.now() - connectStarted;
  try {
    const startedAt = new Date().toISOString();
    const results = [
      await runScenario(database, "many-artifacts", options),
      await runScenario(database, "deep-history", options),
    ];
    const report = {
      commit: execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim(),
      environment: {
        cpu: cpus()[0]?.model ?? "unknown",
        node: process.version,
        os: `${platform()} ${release()}`,
        postgresImage: environment.ARTIFACT_SERVER_TEST_POSTGRES_IMAGE,
        providerReadyMilliseconds: environment.ARTIFACT_SERVER_TEST_PROVIDER_READY_MILLISECONDS,
        connectAndMigrateMilliseconds,
        poolMaximumConnections: 4,
        storage: "disposable pinned Postgres container on the current machine",
      },
      fixture: {count: options.count, passes: options.passes},
      note: "Bounded local-container diagnostic; this is not managed-Postgres capacity or a tail claim.",
      startedAt,
      completedAt: new Date().toISOString(),
      scenarios: results,
    };
    const outputPath = path.resolve(options.output);
    await mkdir(path.dirname(outputPath), {recursive: true});
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write([
      `Postgres Git backlog diagnostic: ${options.count} versions, ${options.passes} passes.`,
      ...results.map((result) =>
        `${result.mode}: enable ${result.enableMilliseconds.toFixed(2)} ms; ` +
        `claim median ${result.medianClaimMilliseconds.toFixed(2)} ms, ` +
        `max ${result.maximumClaimMilliseconds.toFixed(2)} ms; ` +
        `${result.pendingJobs} pending jobs.`),
      `Report: ${outputPath}`,
    ].join("\n") + "\n");
  } finally {
    await database.close();
  }
}

async function runScenario(
  database: PostgresDatabase,
  mode: ScenarioResult["mode"],
  options: z.infer<typeof optionsSchema>,
): Promise<ScenarioResult> {
  const installationId = `git-backlog-${mode}`;
  const store = await PostgresArtifactRepository.open(database, installationId);
  const fixtureStarted = performance.now();
  await seedVersions(database, installationId, mode, options.count);
  const fixturePreparationMilliseconds = performance.now() - fixtureStarted;
  const now = Date.now();
  const enabledAt = new Date(now).toISOString();
  const enableStart = performance.now();
  await store.storeProjectGitHistorySetting({
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
      throw new Error(`${mode} exceeded the bounded diagnostic claim-pass budget.`);
    }
    const passStart = performance.now();
    const job = await store.claimGitHistoryJob(enabledAt, leaseExpiresAt);
    samples.push(performance.now() - passStart);
    if (job !== null) claimed += 1;
    await runPass(index + 1);
  };
  await runPass(0);
  const progress = await store.readProjectGitHistoryProgress(projectId);
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
    fixturePreparationMilliseconds,
  };
}

async function seedVersions(
  database: PostgresDatabase,
  installationId: string,
  mode: ScenarioResult["mode"],
  count: number,
): Promise<void> {
  await database.run(Effect.gen(function*() {
    const sql = yield* SqlClient;
    yield* sql.withTransaction(Effect.gen(function*() {
      if (mode === "deep-history") {
        yield* sql.unsafe(`
          INSERT INTO artifacts (
            installation_id, project_id, id, name, search_name,
            access_setting, current_version_id, created_at, deleted_at
          ) VALUES ($1, $2, 'art_backlog_history', 'History', 'history',
            'account_required', NULL, $3, NULL)
        `, [installationId, projectId, historyTimestamp]);
      } else {
        yield* sql.unsafe(`
          INSERT INTO artifacts (
            installation_id, project_id, id, name, search_name,
            access_setting, current_version_id, created_at, deleted_at
          ) SELECT $1, $2, 'art_backlog_' || LPAD(n::text, 6, '0'),
            LPAD(n::text, 6, '0'), LPAD(n::text, 6, '0'),
            'account_required', NULL, $3, NULL
          FROM generate_series(1, $4) AS n
        `, [installationId, projectId, historyTimestamp, count]);
      }
      yield* sql.unsafe(`
        INSERT INTO versions (
          installation_id, project_id, id, artifact_id, number,
          manifest_digest, entry_path, routing_mode, content_token,
          publisher_principal_id, created_at
        ) SELECT $1, $2, 'ver_backlog_' || LPAD(n::text, 6, '0'),
          CASE WHEN $3 = 'deep-history' THEN 'art_backlog_history'
            ELSE 'art_backlog_' || LPAD(n::text, 6, '0') END,
          CASE WHEN $3 = 'deep-history' THEN n ELSE 1 END,
          REPEAT('0', 64), 'index.html', 'static',
          'content_backlog_' || LPAD(n::text, 6, '0'),
          'performance-fixture', $4
        FROM generate_series(1, $5) AS n
      `, [installationId, projectId, mode, historyTimestamp, count]);
      if (mode === "deep-history") {
        yield* sql.unsafe(`
          INSERT INTO git_history_mappings (
            installation_id, project_id, artifact_id, version_id,
            repository_name, commit_id, attempts, copied_bytes,
            status, created_at
          ) SELECT $1, $2, 'art_backlog_history',
            'ver_backlog_' || LPAD(n::text, 6, '0'),
            'art_backlog_history', 'commit_' || LPAD(n::text, 6, '0'),
            1, 0, 'recorded', $3
          FROM generate_series(1, $4) AS n
        `, [installationId, projectId, historyTimestamp, count - 1]);
      }
    }));
  }));
}

void main().catch((cause: unknown) => {
  const kind = cause instanceof Error ? cause.name : "unknown";
  process.stderr.write(`Postgres Git backlog diagnostic failed: ${kind}.\n`);
  process.exitCode = 1;
});
