import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {performance} from "node:perf_hooks";

import {Command} from "commander";
import {z} from "zod";

import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../../tests/support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../../tests/support/publishing.js";
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

interface LatencySummary {
  readonly count: number;
  readonly maximumMilliseconds: number;
  readonly meanMilliseconds: number;
  readonly minimumMilliseconds: number;
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
}

interface PhaseSummary {
  readonly latency: LatencySummary;
  readonly operationsPerSecond: number;
  readonly totalMilliseconds: number;
}

function summarize(samples: readonly number[]): PhaseSummary {
  const sorted = samples.toSorted((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const percentile = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ??
      0;
  return {
    latency: {
      count: sorted.length,
      maximumMilliseconds: sorted.at(-1) ?? 0,
      meanMilliseconds: sorted.length === 0 ? 0 : total / sorted.length,
      minimumMilliseconds: sorted[0] ?? 0,
      p50Milliseconds: percentile(0.5),
      p95Milliseconds: percentile(0.95),
    },
    operationsPerSecond: total === 0 ? 0 : (sorted.length / total) * 1_000,
    totalMilliseconds: total,
  };
}

const threadPageSchema = z.object({
  items: z.array(z.unknown()),
  nextCursor: z.string().nullable(),
  revision: z.number().int().nonnegative(),
});

async function listComments(
  server: RunningTestServer,
  installation: TestInstallation,
  published: PublishResponse,
  revision: number | null,
): Promise<number> {
  const query = revision === null ? "" : `&revision=${revision}`;
  const started = performance.now();
  const response = await fetch(
    `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/comments` +
      `?projectId=${published.artifact.projectId}${query}`,
    {headers: {Authorization: `Bearer ${installation.apiToken}`}},
  );
  if (response.status !== 200) {
    throw new Error(`Comment poll failed with ${response.status}.`);
  }
  threadPageSchema.parse(await response.json());
  return performance.now() - started;
}

async function createThread(
  server: RunningTestServer,
  installation: TestInstallation,
  published: PublishResponse,
  idempotencyKey: string,
  body: string,
): Promise<string> {
  const response = await fetch(
    `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}` +
      `/versions/${published.version.id}/comments` +
      `?projectId=${published.artifact.projectId}`,
    {
      body: JSON.stringify({body, path: "index.html"}),
      headers: apiHeaders(installation, idempotencyKey),
      method: "POST",
    },
  );
  if (response.status !== 201) {
    throw new Error(`Thread creation failed with ${response.status}.`);
  }
  const parsed = z.object({thread: z.object({id: z.string()})})
    .parse(await response.json());
  return parsed.thread.id;
}

async function deleteThread(
  server: RunningTestServer,
  installation: TestInstallation,
  published: PublishResponse,
  threadId: string,
): Promise<void> {
  const response = await fetch(
    `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}` +
      `/comments/${threadId}?projectId=${published.artifact.projectId}`,
    {
      headers: apiHeaders(installation, `comment-polling-delete-${threadId}`),
      method: "DELETE",
    },
  );
  if (response.status !== 204) {
    throw new Error(`Thread deletion failed with ${response.status}.`);
  }
}

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

    const setupStarted = performance.now();
    for (let index = 0; index < options.threads; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- setup writes must complete in order
      await createThread(
        server,
        installation,
        published,
        `comment-polling-thread-${index}`,
        `Baseline thread ${index}.`,
      );
    }
    const setupMilliseconds = performance.now() - setupStarted;

    const shortCircuit: number[] = [];
    for (let index = 0; index < options.polls; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential polls measure per-request cost
      shortCircuit.push(await listComments(server, installation, published, options.threads));
    }

    const stalePage: number[] = [];
    const stalePolls = Math.max(10, Math.floor(options.polls / 5));
    for (let index = 0; index < stalePolls; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential polls measure per-request cost
      stalePage.push(await listComments(server, installation, published, 0));
    }

    let revision = options.threads;
    const contentionPolls: number[] = [];
    const contentionMutations: number[] = [];
    const contentionDeadline = performance.now() + options.contentionSeconds * 1_000;
    let contentionMutationCount = 0;
    const pollers = Array.from({length: options.concurrency}, async () => {
      while (performance.now() < contentionDeadline) {
        // eslint-disable-next-line no-await-in-loop -- each poller measures sequential request cost
        contentionPolls.push(await listComments(server, installation, published, revision));
      }
    });
    while (performance.now() < contentionDeadline) {
      const started = performance.now();
      // eslint-disable-next-line no-await-in-loop -- the mutator serializes create/delete against the pollers
      const threadId = await createThread(
        server,
        installation,
        published,
        `comment-polling-contention-${contentionMutationCount}`,
        `Contention thread ${contentionMutationCount}.`,
      );
      revision += 1;
      // eslint-disable-next-line no-await-in-loop -- the delete completes the measured mutation round trip
      await deleteThread(server, installation, published, threadId);
      contentionMutations.push(performance.now() - started);
      contentionMutationCount += 1;
    }
    await Promise.all(pollers);

    const environment = await captureMeasurementContext();
    const report = {
      ...environment,
      completedAt: new Date().toISOString(),
      configuration: {
        concurrency: options.concurrency,
        contentionSeconds: options.contentionSeconds,
        polls: options.polls,
        stalePolls,
        threads: options.threads,
      },
      contention: {
        mutations: summarize(contentionMutations),
        mutationCount: contentionMutationCount,
        polls: summarize(contentionPolls),
      },
      note: "Comment revision polling on one hot artifact: matching-revision polls short-circuit to an empty page, stale-revision polls return the authoritative first page, and the contention phase runs parallel short-circuit polls while one client creates and deletes threads. Setup time is excluded from the measured phases.",
      phases: {
        shortCircuit: summarize(shortCircuit),
        stalePage: summarize(stalePage),
      },
      setup: {
        milliseconds: setupMilliseconds,
        threadsPerSecond: setupMilliseconds === 0
          ? 0
          : (options.threads / setupMilliseconds) * 1_000,
      },
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
        `Contention: ${contentionMutationCount} mutations, poll p95 ${report.contention.polls.latency.p95Milliseconds.toFixed(2)} ms, mutation p95 ${report.contention.mutations.latency.p95Milliseconds.toFixed(2)} ms.`,
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
