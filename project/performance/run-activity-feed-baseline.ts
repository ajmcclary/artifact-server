import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {Command} from "commander";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
} from "../../tests/support/runtime-harness.js";
import {publishNew} from "../../tests/support/publishing.js";
import {captureMeasurementContext} from "./measurement-context.js";

const optionsSchema = z.object({
  actions: z.coerce.number().int().min(1_000).max(1_000_000),
  output: z.string().min(1),
  reads: z.coerce.number().int().min(10).max(2_000),
});

const program = new Command()
  .name("activity-feed-baseline")
  .description("Measure the first activity page and summary over a large action log.")
  .option("--actions <count>", "seeded actions", "100000")
  .option("--reads <count>", "measured reads per phase", "200")
  .option("--output <path>", "JSON report path", "project/evidence/activity-feed-baseline.json");

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return Math.round((sorted[Math.max(0, index)] ?? 0) * 100) / 100;
}

async function measure(reads: number, read: () => Promise<void>) {
  const samples: number[] = [];
  // Reads run strictly one after another so each sample times one request.
  await Array.from({length: reads}).reduce<Promise<void>>(async (previous) => {
    await previous;
    const startedAt = performance.now();
    await read();
    samples.push(performance.now() - startedAt);
  }, Promise.resolve());
  const sorted = samples.toSorted((left, right) => left - right);
  return {
    count: reads,
    p50Milliseconds: percentile(sorted, 0.5),
    p95Milliseconds: percentile(sorted, 0.95),
    p99Milliseconds: percentile(sorted, 0.99),
  };
}

async function warmUp(url: string, headers: Readonly<Record<string, string>>): Promise<void> {
  try {
    await (await fetch(url, {headers})).arrayBuffer();
  } catch {
    // A reset pooled socket fails once; the retry opens a fresh connection.
    await (await fetch(url, {headers})).arrayBuffer();
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
      content: "<p>activity feed baseline</p>",
      idempotencyKey: "activity-feed-baseline",
      name: "Activity feed baseline target",
    })).body;
    const seedStartedAt = performance.now();
    const database = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
      {timeout: 30_000},
    );
    try {
      database.exec("BEGIN IMMEDIATE");
      const thread = database.prepare(`INSERT INTO comment_threads (
          id, installation_id, project_id, artifact_id, version_id, path, anchor_json,
          body, state, author_principal_id, author_principal_kind, author_display_name,
          author_authorized_by_principal_id, idempotency_key, created_at, updated_at
        ) VALUES (?, 'local', ?, ?, ?, NULL, NULL, ?, 'open', 'perf-member', 'human',
          'Perf Member', NULL, ?, ?, ?)`);
      const action = database.prepare(`INSERT INTO actions (
          id, project_id, artifact_id, version_id, action, principal_id,
          authorized_by_principal_id, idempotency_key, created_at,
          thread_id, actor_name, actor_kind
        ) VALUES (?, ?, ?, ?, ?, 'perf-member', NULL, ?, ?, ?, 'Perf Member', 'human')`);
      const base = Date.parse("2026-01-01T00:00:00.000Z");
      for (let index = 0; index < options.actions; index += 1) {
        const at = new Date(base + index * 1_000).toISOString();
        const threadId = `perf_thread_${Math.floor(index / 5)}`;
        if (index % 5 === 0) {
          thread.run(
            threadId,
            published.artifact.projectId,
            published.artifact.id,
            published.version.id,
            `Perf thread ${index}`,
            `perf-thread-${index}`,
            at,
            at,
          );
        }
        action.run(
          `perf_action_${index}`,
          published.artifact.projectId,
          published.artifact.id,
          published.version.id,
          index % 5 === 0 ? "comment_create" : index % 5 === 4 ? "publish" : "comment_reply",
          `perf-action-${index}`,
          at,
          index % 5 === 4 ? null : threadId,
        );
      }
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    const seedMilliseconds = performance.now() - seedStartedAt;
    const headers = {Authorization: `Bearer ${installation.apiToken}`};
    // The publish's pooled connection idles past the server keep-alive while
    // seeding; one unmeasured warm-up read retires it before sampling begins.
    await warmUp(`${server.baseUrl}/api/v1/activity?limit=1`, headers);
    const firstPage = await measure(options.reads, async () => {
      const response = await fetch(`${server.baseUrl}/api/v1/activity?limit=30`, {headers});
      if (response.status !== 200) throw new Error(`Feed answered ${response.status}.`);
      await response.arrayBuffer();
    });
    const summary = await measure(options.reads, async () => {
      const response = await fetch(`${server.baseUrl}/api/v1/activity/summary`, {headers});
      if (response.status !== 200) throw new Error(`Summary answered ${response.status}.`);
      await response.arrayBuffer();
    });
    const report = {
      ...(await captureMeasurementContext()),
      completedAt: new Date().toISOString(),
      configuration: options,
      firstPage,
      note: "First activity page (30 entries, latest-per-thread folding) and summary over a seeded SQLite action log: one row in five opens a thread, three reply, one publishes. Seeding time is excluded from the measured phases.",
      seedMilliseconds: Math.round(seedMilliseconds),
      summary,
    };
    await mkdir(path.dirname(options.output), {recursive: true});
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({firstPage, summary})}\n`);
  } finally {
    await server.stop();
    await removeTestInstallation(installation);
  }
}

await main();
