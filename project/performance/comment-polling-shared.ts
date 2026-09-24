import {createHash} from "node:crypto";
import {performance} from "node:perf_hooks";

import {z} from "zod";

/**
 * Shared comment-polling measurement phases. Both the local (SQLite,
 * in-process) and managed (compiled external-storage server against hosted
 * Postgres) baselines drive the same phases through this module so the
 * numbers are comparable.
 */
export interface LatencySummary {
  readonly count: number;
  readonly maximumMilliseconds: number;
  readonly meanMilliseconds: number;
  readonly minimumMilliseconds: number;
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
}

export interface PhaseSummary {
  readonly latency: LatencySummary;
  readonly operationsPerSecond: number;
  readonly totalMilliseconds: number;
}

export interface CommentPollingPhaseOptions {
  readonly concurrency: number;
  readonly contentionSeconds: number;
  readonly polls: number;
  readonly threads: number;
}

/** The narrow server surface the polling phases measure. */
export interface CommentPollingTarget {
  readonly createThread: (idempotencyKey: string, body: string) => Promise<string>;
  readonly deleteThread: (threadId: string) => Promise<void>;
  readonly listComments: (revision: number | null) => Promise<number>;
}

export interface CommentPollingPhaseReport {
  readonly contention: {
    readonly mutations: PhaseSummary;
    readonly mutationCount: number;
    readonly polls: PhaseSummary;
  };
  readonly phases: {
    readonly shortCircuit: PhaseSummary;
    readonly stalePage: PhaseSummary;
  };
  readonly setup: {
    readonly milliseconds: number;
    readonly threadsPerSecond: number;
  };
  readonly stalePolls: number;
}

export function summarize(samples: readonly number[]): PhaseSummary {
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

/** Seed the measured threads, then run the short-circuit/stale/contention phases. */
export async function runCommentPollingPhases(
  target: CommentPollingTarget,
  options: CommentPollingPhaseOptions,
): Promise<CommentPollingPhaseReport> {
  const setupStarted = performance.now();
  for (let index = 0; index < options.threads; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- setup writes must complete in order
    await target.createThread(`comment-polling-thread-${index}`, `Baseline thread ${index}.`);
  }
  const setupMilliseconds = performance.now() - setupStarted;

  const shortCircuit: number[] = [];
  for (let index = 0; index < options.polls; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- sequential polls measure per-request cost
    shortCircuit.push(await target.listComments(options.threads));
  }

  const stalePage: number[] = [];
  const stalePolls = Math.max(10, Math.floor(options.polls / 5));
  for (let index = 0; index < stalePolls; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- sequential polls measure per-request cost
    stalePage.push(await target.listComments(0));
  }

  let revision = options.threads;
  const contentionPolls: number[] = [];
  const contentionMutations: number[] = [];
  const contentionDeadline = performance.now() + options.contentionSeconds * 1_000;
  let contentionMutationCount = 0;
  const pollers = Array.from({length: options.concurrency}, async () => {
    while (performance.now() < contentionDeadline) {
      // eslint-disable-next-line no-await-in-loop -- each poller measures sequential request cost
      contentionPolls.push(await target.listComments(revision));
    }
  });
  while (performance.now() < contentionDeadline) {
    const started = performance.now();
    // eslint-disable-next-line no-await-in-loop -- the mutator serializes create/delete against the pollers
    const threadId = await target.createThread(
      `comment-polling-contention-${contentionMutationCount}`,
      `Contention thread ${contentionMutationCount}.`,
    );
    revision += 1;
    // eslint-disable-next-line no-await-in-loop -- the delete completes the measured mutation round trip
    await target.deleteThread(threadId);
    contentionMutations.push(performance.now() - started);
    contentionMutationCount += 1;
  }
  await Promise.all(pollers);

  return {
    contention: {
      mutations: summarize(contentionMutations),
      mutationCount: contentionMutationCount,
      polls: summarize(contentionPolls),
    },
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
    stalePolls,
  };
}

const threadPageSchema = z.object({
  items: z.array(z.unknown()),
  nextCursor: z.string().nullable(),
  revision: z.number().int().nonnegative(),
});

const publishedSchema = z.object({
  artifact: z.object({id: z.string(), projectId: z.string()}).loose(),
  version: z.object({id: z.string()}).loose(),
}).loose();

export interface PublishedCommentTarget {
  readonly artifactId: string;
  readonly projectId: string;
  readonly versionId: string;
}

/**
 * Publish one single-file artifact over the staged-upload HTTP API. Works
 * against any running server (local harness or managed compiled process).
 */
export async function publishCommentTarget(input: {
  readonly baseUrl: string;
  readonly content?: string;
  readonly idempotencyKey: string;
  readonly name: string;
  readonly token: string;
}): Promise<PublishedCommentTarget> {
  const bytes = new TextEncoder().encode(
    input.content ?? "<p>comment polling baseline target</p>",
  );
  const create = await fetch(`${input.baseUrl}/api/v1/uploads`, {
    body: JSON.stringify({
      entryPath: "index.html",
      files: [{
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      }],
      routingMode: "static",
    }),
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    method: "POST",
  });
  if (create.status !== 201 && create.status !== 200) {
    throw new Error(`Comment-target upload plan failed with ${create.status}.`);
  }
  const plan = z.object({
    commitUrl: z.url(),
    files: z.array(z.object({uploadUrl: z.url()}).loose()),
  }).loose().parse(await create.json());
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const filePlan = plan.files[0];
  if (filePlan === undefined) {
    throw new Error("Comment-target upload plan has no files.");
  }
  const upload = await fetch(filePlan.uploadUrl, {
    body: copy.buffer,
    headers: {Authorization: `Bearer ${input.token}`},
    method: "PUT",
  });
  if (upload.status !== 200) {
    throw new Error(`Comment-target file upload failed with ${upload.status}.`);
  }
  const commit = await fetch(plan.commitUrl, {
    body: JSON.stringify({target: {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: input.name,
      tags: ["comment-polling-baseline"],
    }}),
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    method: "POST",
  });
  if (commit.status !== 201 && commit.status !== 200) {
    throw new Error(`Comment-target commit failed with ${commit.status}.`);
  }
  const published = publishedSchema.parse(await commit.json());
  return {
    artifactId: published.artifact.id,
    projectId: published.artifact.projectId,
    versionId: published.version.id,
  };
}

/** Build the measured comment surface for one running server over plain HTTP. */
export function createHttpCommentTarget(input: {
  readonly baseUrl: string;
  readonly published: PublishedCommentTarget;
  readonly token: string;
}): CommentPollingTarget {
  const {baseUrl, published, token} = input;
  const headers = (idempotencyKey?: string) => {
    const base = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    if (idempotencyKey === undefined) return base;
    return {...base, "Idempotency-Key": idempotencyKey};
  };
  return {
    createThread: async (idempotencyKey, body) => {
      const response = await fetch(
        `${baseUrl}/api/v1/artifacts/${published.artifactId}` +
          `/versions/${published.versionId}/comments` +
          `?projectId=${published.projectId}`,
        {
          body: JSON.stringify({body, path: "index.html"}),
          headers: headers(idempotencyKey),
          method: "POST",
        },
      );
      if (response.status !== 201) {
        throw new Error(`Thread creation failed with ${response.status}.`);
      }
      const parsed = z.object({thread: z.object({id: z.string()})})
        .parse(await response.json());
      return parsed.thread.id;
    },
    deleteThread: async (threadId) => {
      const response = await fetch(
        `${baseUrl}/api/v1/artifacts/${published.artifactId}` +
          `/comments/${threadId}?projectId=${published.projectId}`,
        {
          headers: headers(`comment-polling-delete-${threadId}`),
          method: "DELETE",
        },
      );
      if (response.status !== 204) {
        throw new Error(`Thread deletion failed with ${response.status}.`);
      }
    },
    listComments: async (revision) => {
      const query = revision === null ? "" : `&revision=${revision}`;
      const started = performance.now();
      const response = await fetch(
        `${baseUrl}/api/v1/artifacts/${published.artifactId}/comments` +
          `?projectId=${published.projectId}${query}`,
        {headers: {Authorization: `Bearer ${token}`}},
      );
      if (response.status !== 200) {
        throw new Error(`Comment poll failed with ${response.status}.`);
      }
      threadPageSchema.parse(await response.json());
      return performance.now() - started;
    },
  };
}
