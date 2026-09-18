import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import {cpus, platform, release} from "node:os";
import path from "node:path";
import {performance} from "node:perf_hooks";
import {fileURLToPath} from "node:url";

import {Command} from "commander";
import {getPlatformProxy} from "wrangler";
import {z} from "zod";

import {
  defaultGitHistoryFileCopyBytes,
  defaultGitHistoryVersionCopyBytes,
} from "../../../src/git-history/git-history-capability.js";
import {createD1ArtifactRepository} from "../src/d1-artifact-repository.js";
import {migrateD1} from "../src/d1-migrations.js";

const optionsSchema = z.object({
  count: z.coerce.number().int().min(1).max(3_301),
  maximumMilliseconds: z.coerce.number().int().min(1_000).max(120_000),
  output: z.string().min(1),
  passes: z.coerce.number().int().min(1).max(104),
});
const historyTimestamp = "2026-01-01T00:00:00.000Z";
const projectId = "prj_default";
const maximumStatementsPerBatch = 100;
const maximumPreparationMilliseconds = 180_000;

const program = new Command()
  .name("git-history-d1-backlog")
  .description("Measure bounded Git queue reconciliation against local Wrangler D1.")
  .option("--count <versions>", "saved versions, maximum 3301", "1000")
  .option("--passes <count>", "claim passes, maximum 104", "30")
  .option("--maximum-milliseconds <time>", "claim-pass budget, maximum 120000", "60000")
  .option("--output <path>", "JSON report path",
    "../../project/evidence/git-history-d1-backlog.json");

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
  readonly proxyStartupMilliseconds: number;
  readonly migrationMilliseconds: number;
  readonly fixturePreparationMilliseconds: number;
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
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve("../.."),
      encoding: "utf8",
    }).trim(),
    environment: {
      cpu: cpus()[0]?.model ?? "unknown",
      node: process.version,
      os: `${platform()} ${release()}`,
      compatibilityDate: "2026-08-15",
      storage: "nonpersistent local Wrangler D1 binding",
    },
    fixture: {count: options.count, passes: options.passes},
    note: "Bounded local-D1 diagnostic; this is not live Worker CPU or provider capacity.",
    startedAt,
    completedAt: new Date().toISOString(),
    scenarios: results,
  };
  const outputPath = path.resolve(options.output);
  await mkdir(path.dirname(outputPath), {recursive: true});
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write([
    `D1 Git backlog diagnostic: ${options.count} versions, ${options.passes} passes.`,
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
  const proxyStarted = performance.now();
  const proxy = await getPlatformProxy<{
    ARTIFACT_SERVER_D1_DATABASE: D1Database;
  }>({
    configPath: fileURLToPath(new URL("../wrangler.git-store.test.jsonc", import.meta.url)),
    envFiles: [],
    persist: false,
    remoteBindings: false,
  });
  const proxyStartupMilliseconds = performance.now() - proxyStarted;
  try {
    const database = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = `d1-backlog-${mode}`;
    const migrationStarted = performance.now();
    await migrateD1(database, installationId);
    const migrationMilliseconds = performance.now() - migrationStarted;
    const fixtureStarted = performance.now();
    await seedVersions(database, mode, options.count);
    const fixturePreparationMilliseconds = performance.now() - fixtureStarted;
    const store = createD1ArtifactRepository(database, installationId);
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
      proxyStartupMilliseconds,
      migrationMilliseconds,
      fixturePreparationMilliseconds,
    };
  } finally {
    await proxy.dispose();
  }
}

async function seedVersions(
  database: D1Database,
  mode: ScenarioResult["mode"],
  count: number,
): Promise<void> {
  const artifactStatement = `
    INSERT INTO artifacts (
      id, project_id, name, search_name, access_setting,
      current_version_id, created_at, deleted_at
    ) VALUES (?, ?, ?, ?, 'account_required', NULL, ?, NULL)
  `;
  const versionStatement = `
    INSERT INTO versions (
      id, project_id, artifact_id, number, manifest_digest,
      entry_path, routing_mode, content_token,
      publisher_principal_id, created_at
    ) VALUES (?, ?, ?, ?, ?, 'index.html', 'static', ?, ?, ?)
  `;
  const mappingStatement = `
    INSERT INTO git_history_mappings (
      installation_id, project_id, artifact_id, version_id,
      repository_name, commit_id, attempts, copied_bytes, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 'recorded', ?)
  `;
  const installationId = `d1-backlog-${mode}`;
  const statements: D1PreparedStatement[] = [];
  if (mode === "deep-history") {
    statements.push(database.prepare(artifactStatement).bind(
      "art_backlog_history", projectId, "History", "history", historyTimestamp,
    ));
  }
  for (let index = 1; index <= count; index += 1) {
    const suffix = String(index).padStart(6, "0");
    const artifactId = mode === "deep-history"
      ? "art_backlog_history"
      : `art_backlog_${suffix}`;
    if (mode === "many-artifacts") {
      statements.push(database.prepare(artifactStatement).bind(
        artifactId, projectId, suffix, suffix, historyTimestamp,
      ));
    }
    const versionId = `ver_backlog_${suffix}`;
    statements.push(database.prepare(versionStatement).bind(
      versionId, projectId, artifactId,
      mode === "deep-history" ? index : 1,
      "0".repeat(64), `content_backlog_${suffix}`,
      "performance-fixture", historyTimestamp,
    ));
    if (mode === "deep-history" && index < count) {
      statements.push(database.prepare(mappingStatement).bind(
        installationId, projectId, artifactId, versionId,
        artifactId, `commit_${suffix}`, historyTimestamp,
      ));
    }
  }
  const preparationStarted = performance.now();
  const runBatches = async (offset: number): Promise<void> => {
    const batch = statements.slice(offset, offset + maximumStatementsPerBatch);
    if (batch.length === 0) return;
    if (performance.now() - preparationStarted > maximumPreparationMilliseconds) {
      throw new Error("D1 fixture preparation exceeded its wall-time budget.");
    }
    await database.batch(batch);
    await runBatches(offset + maximumStatementsPerBatch);
  };
  await runBatches(0);
}

void main().catch((cause: unknown) => {
  const kind = cause instanceof Error ? cause.name : "unknown";
  process.stderr.write(`D1 Git backlog diagnostic failed: ${kind}.\n`);
  process.exitCode = 1;
});
