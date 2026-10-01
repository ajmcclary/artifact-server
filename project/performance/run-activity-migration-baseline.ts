import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {performance} from "node:perf_hooks";

import {Command} from "commander";
import {z} from "zod";

import {defaultProjectId} from "../../src/core/model.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";
import {
  type ActivityHistoryFixture,
  populateActivityHistory,
} from "../../tests/support/activity-history-fixture.js";
import {
  downgradeSqliteActionsToLegacy,
  insertBulkLegacyActions,
} from "../../tests/support/sqlite-activity-log.js";
import {captureMeasurementContext} from "./measurement-context.js";

const optionsSchema = z.object({
  actions: z.coerce.number().int().min(1_000).max(5_000_000),
  limitSeconds: z.coerce.number().positive(),
  output: z.string().min(1),
});

const program = new Command()
  .name("activity-migration-baseline")
  .description("Time the SQLite activity-log migration of a populated schema-17 file.")
  .option("--actions <count>", "legacy actions in the measured file", "1000000")
  .option("--limit-seconds <seconds>", "stop threshold from the spec", "30")
  .option("--output <path>", "JSON report path", "project/evidence/activity-migration-baseline.json");

async function main(): Promise<void> {
  program.parse();
  const options = optionsSchema.parse(program.opts());
  const directory = await mkdtemp(path.join(tmpdir(), "artifact-activity-migration-"));
  try {
    const databasePath = path.join(directory, "artifact-server.db");
    const installationId = "activity-migration-baseline";
    const artifacts = new SqliteArtifactRepository(databasePath, installationId);
    const identity = new SqliteIdentityRepository(databasePath);
    let fixture: ActivityHistoryFixture | undefined;
    try {
      fixture = await populateActivityHistory({artifacts, identity, installationId});
    } finally {
      identity.close();
      artifacts.close();
    }
    if (fixture === undefined) throw new Error("The fixture was not recorded.");
    downgradeSqliteActionsToLegacy(databasePath);
    insertBulkLegacyActions(databasePath, {
      artifactId: fixture.artifactId,
      count: options.actions,
      projectId: defaultProjectId,
      versionId: fixture.versionId,
    });

    // The constructor is the whole startup path, including every per-start migration helper.
    const started = performance.now();
    new SqliteArtifactRepository(databasePath, installationId).close();
    const migrationSeconds = (performance.now() - started) / 1_000;

    const environment = await captureMeasurementContext();
    const success = migrationSeconds <= options.limitSeconds;
    const report = {
      ...environment,
      completedAt: new Date().toISOString(),
      configuration: {actions: options.actions},
      limitSeconds: options.limitSeconds,
      migrationSeconds,
      note: "Wall time of one SqliteArtifactRepository startup over a populated schema-17 file: the verified actions copy, trigger and index creation, and recovery of recorded activity, plus the per-start migration helpers. Fixture population and bulk insertion are excluded.",
      startedAt: environment.capturedAt,
      success,
      target: "local",
    };
    await mkdir(path.dirname(options.output), {recursive: true});
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(
      `Activity-log migration of ${options.actions} actions: ${migrationSeconds.toFixed(2)} s (limit ${options.limitSeconds} s).\nReport: ${options.output}\n`,
    );
    if (!success) {
      process.stderr.write("The migration exceeds the spec's 30-second stop. Stop and report before continuing.\n");
      process.exitCode = 1;
    }
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
}

void main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.message : "The activity migration baseline failed."}\n`);
  process.exitCode = 1;
});
