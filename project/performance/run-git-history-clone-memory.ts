import {execFile} from "node:child_process";
import {createHash} from "node:crypto";
import {performance} from "node:perf_hooks";
import {promisify} from "node:util";

import {Command} from "commander";
import {z} from "zod";

import {
  commitGitHistoryVersion,
} from "../../src/git-history/cloudflare-artifacts-git-history-provider.js";
import type {
  GitHistoryCommitRequest,
  GitRepositoryCoordinates,
} from "../../src/git-history/git-history-mirror.js";
import {startGitSmartHttpServer} from "../../tests/support/git-smart-http-server.js";
import {captureMeasurementContext} from "./measurement-context.js";

const execute = promisify(execFile);
const token = "disposable-git-clone-memory-token";

const optionsSchema = z.object({
  histories: z.string().min(1),
  maximumMilliseconds: z.coerce.number().int().min(1_000).max(600_000),
  output: z.string().min(1),
});

interface MemoryPeaks {
  arrayBuffers: number;
  external: number;
  heapTotal: number;
  heapUsed: number;
  rss: number;
}

interface HistoryMeasurement {
  readonly durationMilliseconds: number;
  readonly historyCommits: number;
  readonly peakMemoryBytes: MemoryPeaks;
}

const program = new Command()
  .name("git-history-clone-memory")
  .description(
    "Measure peak process memory of the Git provider's full in-memory clone over bounded history sizes.",
  )
  .option("--histories <commits>", "comma-separated history sizes", "0,50,200,500")
  .option("--maximum-milliseconds <time>", "wall-time budget, maximum 600000", "300000")
  .option("--output <path>", "JSON report path",
    "project/evidence/git-history-clone-memory.json");

async function main(): Promise<void> {
  program.parse();
  const options = optionsSchema.parse(program.opts());
  const startedAt = new Date().toISOString();
  const histories = options.histories.split(",").map((value) =>
    Number.parseInt(value.trim(), 10)
  );
  const budgetMilliseconds = options.maximumMilliseconds;
  const measurements: HistoryMeasurement[] = [];
  for (const historyCommits of histories) {
    if (performance.now() > budgetMilliseconds) break;
    // eslint-disable-next-line no-await-in-loop -- one fresh remote per size
    measurements.push(await measureHistory(historyCommits));
  }
  const environment = await captureMeasurementContext();
  const report = {
    ...environment,
    completedAt: new Date().toISOString(),
    histories,
    measurements,
    note: "Peak process memory during one full commitGitHistoryVersion call (clone, checkout, commit, push) against a disposable local Git smart-HTTP remote seeded with that many commits. RSS is allocator high-water, not retained memory.",
    startedAt,
    success: true,
    target: "local",
  };
  await import("node:fs/promises").then(({writeFile}) =>
    writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  );
  process.stdout.write(`JSON report written to ${options.output}\n`);
}

async function measureHistory(historyCommits: number): Promise<HistoryMeasurement> {
  const remote = await startGitSmartHttpServer();
  try {
    const tip = await seedLinearHistory(remote.barePath, historyCommits);
    const coordinates: GitRepositoryCoordinates = {
      artifactId: "art_git_clone_memory",
      defaultBranch: "main",
      projectId: "prj_git_clone_memory",
      provider: "cloudflare-artifacts",
      remoteUrl: remote.remoteUrl,
      repositoryName: "repository.git",
      status: "provisioned",
    };
    const request = versionRequest(
      coordinates,
      historyCommits + 1,
      `ver_git_clone_memory_${historyCommits}`,
      tip,
    );
    const started = performance.now();
    const peaks = await samplePeakMemory(async () => {
      await commitGitHistoryVersion(request, token);
    });
    const durationMilliseconds = performance.now() - started;
    return {durationMilliseconds, historyCommits, peakMemoryBytes: peaks};
  } finally {
    await remote.close();
  }
}

async function seedLinearHistory(
  barePath: string,
  count: number,
): Promise<string | null> {
  if (count === 0) return null;
  const git = (arguments_: string[]): Promise<string> =>
    execute("git", ["--git-dir", barePath, ...arguments_], {
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: "git-test@invalid.example",
        GIT_AUTHOR_NAME: "Git test",
        GIT_COMMITTER_EMAIL: "git-test@invalid.example",
        GIT_COMMITTER_NAME: "Git test",
      },
    }).then((result) => result.stdout.trim());
  // The well-known empty tree object; avoids driving `git mktree` through
  // stdin from a measurement harness.
  const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  let tip = await git(["commit-tree", emptyTree, "-m", "seed 1"]);
  for (let index = 2; index <= count; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- each commit parents the previous
    tip = await git(["commit-tree", emptyTree, "-p", tip, "-m", `seed ${index}`]);
  }
  await git(["update-ref", "refs/heads/main", tip]);
  return tip;
}

async function samplePeakMemory(
  run: () => Promise<void>,
): Promise<MemoryPeaks> {
  if (globalThis.gc !== undefined) globalThis.gc();
  const peaks: MemoryPeaks = {arrayBuffers: 0, external: 0, heapTotal: 0, heapUsed: 0, rss: 0};
  const timer = setInterval(() => {
    const usage = process.memoryUsage();
    peaks.arrayBuffers = Math.max(peaks.arrayBuffers, usage.arrayBuffers);
    peaks.external = Math.max(peaks.external, usage.external);
    peaks.heapTotal = Math.max(peaks.heapTotal, usage.heapTotal);
    peaks.heapUsed = Math.max(peaks.heapUsed, usage.heapUsed);
    peaks.rss = Math.max(peaks.rss, usage.rss);
  }, 5);
  try {
    await run();
  } finally {
    clearInterval(timer);
  }
  return peaks;
}

function versionRequest(
  coordinates: GitRepositoryCoordinates,
  versionNumber: number,
  versionId: string,
  expectedParentCommitId: string | null,
): GitHistoryCommitRequest {
  const bytes = new TextEncoder().encode(`Git clone memory version ${versionNumber}`);
  return {
    assertOwner: async () => {},
    coordinates,
    expectedParentCommitId,
    files: [{bytes, path: "index.html"}],
    metadata: {
      artifactId: coordinates.artifactId,
      createdAt: new Date(Date.UTC(2026, 8, 18, 12, versionNumber)).toISOString(),
      entryPath: "index.html",
      installationId: "ins_git_clone_memory",
      manifestDigest: createHash("sha256").update(bytes).digest("hex"),
      projectId: coordinates.projectId,
      publisherPrincipalId: "principal_git_clone_memory",
      versionId,
      versionNumber,
    },
    pointers: [],
  };
}

main().catch((error) => {
  process.stderr.write(`git-history-clone-memory failed: ${String(error)}\n`);
  process.exit(1);
});
