import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

import {Command} from "commander";
import {z} from "zod";

import {
  managedBootstrapToken,
  managedProcessExited,
  managedRunInstallationId,
  readManagedExternalStorageEnvironment,
  startManagedExternalStorageProcess,
} from "../../tests/support/managed-external-storage.js";
import {startStubOidcProvider} from "../../tests/support/stub-oidc-provider.js";
import {
  createHttpCommentTarget,
  publishCommentTarget,
  runCommentPollingPhases,
} from "./comment-polling-shared.js";
import {captureMeasurementContext} from "./measurement-context.js";

/**
 * Managed-provider comment polling baseline (T06): the same phases as the
 * local baseline, driven against the compiled external-storage server backed
 * by hosted Postgres and a real S3 bucket. Requires
 * ARTIFACT_SERVER_TEST_DATABASE_URL and ARTIFACT_SERVER_TEST_S3_BUCKET;
 * object-storage credentials resolve through the AWS provider chain.
 */
const optionsSchema = z.object({
  concurrency: z.coerce.number().int().min(1).max(16),
  contentionSeconds: z.coerce.number().int().min(1).max(30),
  output: z.string().min(1),
  polls: z.coerce.number().int().min(10).max(5_000),
  threads: z.coerce.number().int().min(1).max(1_000),
});

const program = new Command()
  .name("comment-polling-managed-baseline")
  .description(
    "Measure comment revision polling cost and mutation contention against managed Postgres.",
  )
  .option("--threads <count>", "threads on the measured artifact", "200")
  .option("--polls <count>", "measured polls per phase", "500")
  .option("--concurrency <count>", "parallel pollers in the contention phase", "8")
  .option("--contention-seconds <seconds>", "contention phase duration", "5")
  .option(
    "--output <path>",
    "JSON report path",
    "project/evidence/comment-polling-baseline-neon.json",
  );

async function main(): Promise<void> {
  program.parse();
  const options = optionsSchema.parse(program.opts());
  const environment = readManagedExternalStorageEnvironment();
  if (environment === undefined) {
    throw new Error(
      "Set ARTIFACT_SERVER_TEST_DATABASE_URL and ARTIFACT_SERVER_TEST_S3_BUCKET first.",
    );
  }
  const oidc = await startStubOidcProvider({
    clientId: "managed-external-storage-live",
  });
  const token = managedBootstrapToken("comment-polling-managed");
  const server = await startManagedExternalStorageProcess({
    apiToken: token,
    environment,
    installationId: managedRunInstallationId("comment-polling"),
    oidcIssuer: oidc.issuer,
    readinessTimeoutMilliseconds: 60_000,
  });
  try {
    const published = await publishCommentTarget({
      baseUrl: server.baseUrl,
      idempotencyKey: "comment-polling-managed-baseline",
      name: "Comment polling managed baseline target",
      token,
    });
    const target = createHttpCommentTarget({
      baseUrl: server.baseUrl,
      published,
      token,
    });
    const phases = await runCommentPollingPhases(target, options);

    const measurement = await captureMeasurementContext({
      objectStorage: "aws-s3",
      postgres: "managed",
      region: environment.s3Region,
    });
    const report = {
      ...measurement,
      completedAt: new Date().toISOString(),
      configuration: {
        concurrency: options.concurrency,
        contentionSeconds: options.contentionSeconds,
        polls: options.polls,
        stalePolls: phases.stalePolls,
        threads: options.threads,
      },
      contention: phases.contention,
      note: "Comment revision polling on one hot artifact against the compiled external-storage server on managed Postgres and real object storage: matching-revision polls short-circuit to an empty page, stale-revision polls return the authoritative first page, and the contention phase runs parallel short-circuit polls while one client creates and deletes threads. Setup time is excluded from the measured phases. The contention phase also exercises concurrent Postgres revision increments; completion without error demonstrates no lost revision bumps.",
      phases: phases.phases,
      setup: phases.setup,
      startedAt: measurement.capturedAt,
      success: true,
      target: "managed-postgres",
    };
    const outputPath = options.output;
    await mkdir(path.dirname(outputPath), {recursive: true});
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(
      [
        `Managed comment polling baseline complete (${options.threads} threads).`,
        `Short-circuit poll: ${report.phases.shortCircuit.operationsPerSecond.toFixed(1)} ops/s, p95 ${report.phases.shortCircuit.latency.p95Milliseconds.toFixed(2)} ms.`,
        `Stale page poll: p95 ${report.phases.stalePage.latency.p95Milliseconds.toFixed(2)} ms.`,
        `Contention: ${report.contention.mutationCount} mutations, poll p95 ${report.contention.polls.latency.p95Milliseconds.toFixed(2)} ms, mutation p95 ${report.contention.mutations.latency.p95Milliseconds.toFixed(2)} ms.`,
        `Report: ${outputPath}`,
      ].join("\n") + "\n",
    );
  } finally {
    if (!managedProcessExited(server.child)) await server.stop();
    await oidc.stop();
  }
}

void main().catch((cause: unknown) => {
  const message = cause instanceof Error
    ? cause.message
    : "The managed comment polling baseline failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
