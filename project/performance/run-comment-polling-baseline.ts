import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

import {Command} from "commander";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
} from "../../tests/support/runtime-harness.js";
import {publishNew} from "../../tests/support/publishing.js";
import {
  createHttpCommentTarget,
  runCommentPollingPhases,
} from "./comment-polling-shared.js";
import {captureMeasurementContext} from "./measurement-context.js";

const optionsSchema = z.object({
  concurrency: z.coerce.number().int().min(1).max(16),
  contentionSeconds: z.coerce.number().int().min(1).max(30),
  output: z.string().min(1),
  polls: z.coerce.number().int().min(10).max(5_000),
  threads: z.coerce.number().int().min(1).max(1_000),
});

const program = new Command()
  .name("comment-polling-baseline")
  .description(
    "Measure comment revision polling cost and mutation contention on a hot artifact.",
  )
  .option("--threads <count>", "threads on the measured artifact", "200")
  .option("--polls <count>", "measured polls per phase", "500")
  .option("--concurrency <count>", "parallel pollers in the contention phase", "8")
  .option("--contention-seconds <seconds>", "contention phase duration", "5")
  .option(
    "--output <path>",
    "JSON report path",
    "project/evidence/comment-polling-baseline.json",
  );

async function main(): Promise<void> {
  program.parse();
  const options = optionsSchema.parse(program.opts());
  const installation = await createTestInstallation();
  const server = await startTestServer(installation);
  try {
    const published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<p>comment polling baseline target</p>",
      idempotencyKey: "comment-polling-baseline",
      name: "Comment polling baseline target",
    })).body;

    const target = createHttpCommentTarget({
      baseUrl: server.baseUrl,
      published: {
        artifactId: published.artifact.id,
        projectId: published.artifact.projectId,
        versionId: published.version.id,
      },
      token: installation.apiToken,
    });
    const phases = await runCommentPollingPhases(target, options);

    const environment = await captureMeasurementContext();
    const report = {
      ...environment,
      completedAt: new Date().toISOString(),
      configuration: {
        concurrency: options.concurrency,
        contentionSeconds: options.contentionSeconds,
        polls: options.polls,
        stalePolls: phases.stalePolls,
        threads: options.threads,
      },
      contention: phases.contention,
      note: "Comment revision polling on one hot artifact: matching-revision polls short-circuit to an empty page, stale-revision polls return the authoritative first page, and the contention phase runs parallel short-circuit polls while one client creates and deletes threads. Setup time is excluded from the measured phases.",
      phases: phases.phases,
      setup: phases.setup,
      startedAt: environment.capturedAt,
      success: true,
      target: "local",
    };
    const outputPath = options.output;
    await mkdir(path.dirname(outputPath), {recursive: true});
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(
      [
        `Comment polling baseline complete (${options.threads} threads).`,
        `Short-circuit poll: ${report.phases.shortCircuit.operationsPerSecond.toFixed(1)} ops/s, p95 ${report.phases.shortCircuit.latency.p95Milliseconds.toFixed(2)} ms.`,
        `Stale page poll: p95 ${report.phases.stalePage.latency.p95Milliseconds.toFixed(2)} ms.`,
        `Contention: ${report.contention.mutationCount} mutations, poll p95 ${report.contention.polls.latency.p95Milliseconds.toFixed(2)} ms, mutation p95 ${report.contention.mutations.latency.p95Milliseconds.toFixed(2)} ms.`,
        `Report: ${outputPath}`,
      ].join("\n") + "\n",
    );
  } finally {
    await server.stop();
    await removeTestInstallation(installation);
  }
}

void main().catch((cause: unknown) => {
  const message = cause instanceof Error
    ? cause.message
    : "The comment polling baseline failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
