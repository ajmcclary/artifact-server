import {createHash} from "node:crypto";

import {Clock, Duration, Effect, Fiber, Schedule} from "effect";

import type {BlobStore} from "../core/ports.js";
import type {ArtifactVersion} from "../core/model.js";
import {
  defaultGitHistoryMaximumCopiedFiles,
  type GitHistoryCapabilityReader,
  type GitHistoryLimits,
} from "./git-history-capability.js";

export const gitHistoryJobKinds = {
  deleteRepository: "delete-repository",
  mirrorVersion: "mirror-version",
} as const;

export type GitHistoryJobKind =
  (typeof gitHistoryJobKinds)[keyof typeof gitHistoryJobKinds];

export interface GitRepositoryCoordinates {
  readonly artifactId: string;
  readonly defaultBranch: "main";
  readonly projectId: string;
  readonly provider: "cloudflare-artifacts";
  readonly remoteUrl: string;
  readonly repositoryName: string;
  readonly status: "provisioned" | "deleting" | "deleted";
}

export interface GitHistoryJob {
  readonly artifactId: string;
  readonly attempts: number;
  readonly id: string;
  readonly kind: GitHistoryJobKind;
  readonly limits: Pick<GitHistoryLimits, "fileCopyBytes" | "versionCopyBytes"> & {
    readonly maximumCopiedFiles: number;
    readonly storageBudgetBytes: number | null;
  } | null;
  readonly projectId: string;
  readonly versionId: string | null;
}

export interface GitHistoryMapping {
  readonly artifactId: string;
  readonly commitId: string;
  readonly copiedBytes: number;
  readonly projectId: string;
  readonly repositoryName: string;
  readonly versionId: string;
}

export interface GitHistoryPointer {
  readonly mediaType: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface GitHistoryCommitFile {
  readonly bytes: Uint8Array;
  readonly path: string;
}

export interface GitHistoryVersionMetadata {
  readonly artifactId: string;
  readonly createdAt: string;
  readonly entryPath: string;
  readonly installationId: string;
  readonly manifestDigest: string;
  readonly projectId: string;
  readonly publisherPrincipalId: string;
  readonly versionId: string;
  readonly versionNumber: number;
}

export interface GitHistoryCommitIdentity {
  readonly assertOwner: () => Promise<void>;
  readonly coordinates: GitRepositoryCoordinates;
  readonly expectedParentCommitId: string | null;
  readonly metadata: GitHistoryVersionMetadata;
}

export interface GitHistoryCommitRequest extends GitHistoryCommitIdentity {
  readonly files: readonly GitHistoryCommitFile[];
  readonly pointers: readonly GitHistoryPointer[];
}

export interface GitCloneCredential {
  readonly expiresAt: string;
  readonly token: string;
}

/** Provider behavior required by the derived Git mirror. */
export interface GitHistoryProvider {
  readonly name: "cloudflare-artifacts";
  commitVersion(
    request: GitHistoryCommitRequest,
  ): Promise<{readonly commitId: string}>;
  createRepository(
    projectId: string,
    artifactId: string,
  ): Promise<GitRepositoryCoordinates>;
  deleteRepository(coordinates: GitRepositoryCoordinates): Promise<void>;
  health(): Promise<{readonly detail: string; readonly healthy: boolean}>;
  issueCredential(
    coordinates: GitRepositoryCoordinates,
    scope: "read" | "write",
    ttlSeconds: number,
  ): Promise<GitCloneCredential>;
  lookupCommit(
    request: GitHistoryCommitRequest,
  ): Promise<{readonly commitId: string} | null>;
}

export type GitHistoryBudgetReservation =
  | {readonly _tag: "Reserved"}
  | {readonly _tag: "AlreadyReserved"}
  | {readonly _tag: "BudgetLimited"};

export type GitHistoryMirrorCompletion = "mirrored" | "artifact-deleted";

/** The durable claim changed owners or expired before this worker could act. */
export class GitHistoryLeaseLost extends Error {
  constructor() {
    super("git_history_lease_lost");
    this.name = "GitHistoryLeaseLost";
  }
}

/** Durable product state used by every mirror worker and persistence backend. */
export interface GitHistoryMirrorStore {
  claimGitHistoryJob(
    now: string,
    leaseExpiresAt: string,
  ): Promise<GitHistoryJob | null>;
  completeGitHistoryDeletion(
    job: GitHistoryJob,
    completedAt: string,
  ): Promise<void>;
  completeGitHistoryMirror(
    job: GitHistoryJob,
    mapping: GitHistoryMapping,
    completedAt: string,
  ): Promise<GitHistoryMirrorCompletion>;
  findGitHistoryMapping(
    projectId: string,
    artifactId: string,
    versionId: string,
  ): Promise<GitHistoryMapping | null>;
  findGitHistoryPredecessorMapping(
    projectId: string,
    artifactId: string,
    versionNumber: number,
  ): Promise<GitHistoryMapping | null>;
  findGitHistoryRepository(
    projectId: string,
    artifactId: string,
  ): Promise<GitRepositoryCoordinates | null>;
  findVersionRecord(
    projectId: string,
    artifactId: string,
    versionId: string,
  ): Promise<ArtifactVersion | null>;
  recordGitHistoryRepository(
    job: GitHistoryJob,
    coordinates: GitRepositoryCoordinates,
    recordedAt: string,
  ): Promise<GitRepositoryCoordinates>;
  releaseGitHistoryJob(
    job: GitHistoryJob,
    classification: string,
    availableAt: string,
  ): Promise<void>;
  renewGitHistoryJob(
    job: GitHistoryJob,
    now: string,
    leaseExpiresAt: string,
  ): Promise<boolean>;
  reserveGitHistoryBudget(
    job: GitHistoryJob,
    logicalBytes: number,
    storageBudgetBytes: number | null,
    updatedAt: string,
  ): Promise<GitHistoryBudgetReservation>;
}

export interface GitHistoryMirrorWorkerDependencies {
  readonly blobs: BlobStore;
  readonly capability: GitHistoryCapabilityReader;
  readonly installationId: string;
  readonly provider: GitHistoryProvider;
  readonly store: GitHistoryMirrorStore;
}

export interface GitHistoryMirrorPass {
  readonly claimed: boolean;
  readonly outcome: "idle" | "mirrored" | "deleted" | "budget-limited" | "retry";
}

const utf8 = new TextEncoder();
const jobLease = Duration.seconds(45);
const renewalInterval = Duration.seconds(15);
const retrySchedule = Schedule.exponential("1 second", 2).pipe(Schedule.jittered);

/** Create the provider-neutral, one-job-at-a-time mirror worker. */
export function makeGitHistoryMirrorWorker(
  dependencies: GitHistoryMirrorWorkerDependencies,
) {
  const runPass = Effect.fn("GitHistoryMirrorWorker.runPass")(function*() {
    if (dependencies.capability.read().providerState !== "available") {
      return {claimed: false, outcome: "idle"} as const;
    }
    const now = yield* Clock.currentTimeMillis;
    const claimedAt = new Date(now).toISOString();
    const job = yield* Effect.tryPromise(() =>
      dependencies.store.claimGitHistoryJob(
        claimedAt,
        new Date(now + Duration.toMillis(jobLease)).toISOString(),
      )
    );
    if (job === null) return {claimed: false, outcome: "idle"} as const;
    const result = yield* Effect.raceFirst(
      processJob(dependencies, job),
      renewClaim(dependencies.store, job),
    ).pipe(
      Effect.match({
        onFailure: (cause) => ({_tag: "Failure" as const, cause}),
        onSuccess: (outcome) => ({_tag: "Success" as const, outcome}),
      }),
    );
    if (result._tag === "Success") {
      return {claimed: true, outcome: result.outcome};
    }
    // A failed renewal cannot establish that an in-flight provider promise
    // stopped. Let the durable lease expire before another worker may claim it.
    if (result.cause instanceof GitHistoryLeaseLost) {
      return {claimed: true, outcome: "retry"} as const;
    }
    const failedAt = yield* Clock.currentTimeMillis;
    const delay = yield* retryDelay(job.attempts, failedAt);
    yield* Effect.tryPromise(() => dependencies.store.releaseGitHistoryJob(
      job,
      classifyMirrorFailure(result.cause),
      new Date(failedAt + Math.max(delay, 1_000)).toISOString(),
    ));
    return {claimed: true, outcome: "retry"} as const;
  });
  return {runPass};
}

const renewClaim = Effect.fn("GitHistoryMirrorWorker.renewClaim")(function*(
  store: GitHistoryMirrorStore,
  job: GitHistoryJob,
): Effect.fn.Return<never, unknown> {
  for (;;) {
    yield* Effect.sleep(renewalInterval);
    const now = yield* Clock.currentTimeMillis;
    const renewed = yield* Effect.tryPromise(() => store.renewGitHistoryJob(
      job,
      new Date(now).toISOString(),
      new Date(now + Duration.toMillis(jobLease)).toISOString(),
    )).pipe(Effect.catch(() => Effect.fail(new GitHistoryLeaseLost())));
    if (!renewed) return yield* Effect.fail(new GitHistoryLeaseLost());
  }
});

/** Start a bounded background drain. Closing interrupts it without touching jobs. */
export async function startGitHistoryMirrorWorker(
  dependencies: GitHistoryMirrorWorkerDependencies,
): Promise<{readonly close: () => Promise<void>}> {
  const worker = makeGitHistoryMirrorWorker(dependencies);
  const loop = (
    idlePasses: number,
  ): Effect.Effect<never, unknown> =>
    worker.runPass().pipe(
      Effect.flatMap((pass) => {
        const nextIdlePasses = pass.outcome === "idle"
          ? Math.min(idlePasses + 1, 4)
          : 0;
        const pause = pass.outcome === "idle"
          ? Effect.sleep(Duration.millis(Math.min(
            30_000,
            2_000 * (2 ** idlePasses),
          )))
          : Effect.yieldNow;
        return pause.pipe(
          Effect.andThen(Effect.suspend(() => loop(nextIdlePasses))),
        );
      }),
    );
  const fiber = Effect.runFork(loop(0));
  return {
    close: async () => {
      await Effect.runPromise(Fiber.interrupt(fiber));
    },
  };
}

const processJob = Effect.fn("GitHistoryMirrorWorker.processJob")(function*(
  dependencies: GitHistoryMirrorWorkerDependencies,
  job: GitHistoryJob,
) {
  if (job.kind === gitHistoryJobKinds.deleteRepository) {
    const coordinates = yield* Effect.tryPromise(() =>
      dependencies.store.findGitHistoryRepository(job.projectId, job.artifactId)
    );
    if (coordinates !== null && coordinates.status !== "deleted") {
      yield* Effect.tryPromise(() =>
        dependencies.provider.deleteRepository(coordinates)
      );
    }
    const completedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    yield* Effect.tryPromise(() =>
      dependencies.store.completeGitHistoryDeletion(job, completedAt)
    );
    return "deleted" as const;
  }
  if (job.versionId === null || job.limits === null) {
    return yield* Effect.die(new Error("A mirror-version job is incomplete."));
  }
  const versionId = job.versionId;
  const limits = job.limits;
  const existing = yield* Effect.tryPromise(() =>
    dependencies.store.findGitHistoryMapping(
      job.projectId,
      job.artifactId,
      versionId,
    )
  );
  if (existing !== null) {
    const completedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const completion = yield* Effect.tryPromise(() =>
      dependencies.store.completeGitHistoryMirror(job, existing, completedAt)
    );
    return completion === "artifact-deleted" ? "deleted" as const : "mirrored" as const;
  }
  const version = yield* Effect.tryPromise(() =>
    dependencies.store.findVersionRecord(
      job.projectId,
      job.artifactId,
      versionId,
    )
  );
  if (version === null) {
    return yield* Effect.fail(new Error("version-unavailable"));
  }
  const predecessor = version.version.number === 1
    ? null
    : yield* Effect.tryPromise(() => dependencies.store.findGitHistoryPredecessorMapping(
      job.projectId,
      job.artifactId,
      version.version.number - 1,
    ));
  if (version.version.number > 1 && predecessor === null) {
    return yield* Effect.fail(new Error("predecessor-unavailable"));
  }
  const plan = yield* buildCommitPlan(dependencies.blobs, version, limits);
  const reservedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
  const reservation = yield* Effect.tryPromise(() =>
    dependencies.store.reserveGitHistoryBudget(
      job,
      plan.copiedBytes,
      limits.storageBudgetBytes,
      reservedAt,
    )
  );
  if (reservation._tag === "BudgetLimited") {
    const budgetLimitedAt = yield* Clock.currentTimeMillis;
    yield* Effect.tryPromise(() => dependencies.store.releaseGitHistoryJob(
      job,
      "budget_limited",
      new Date(budgetLimitedAt + 60_000).toISOString(),
    ));
    return "budget-limited" as const;
  }
  let coordinates = yield* Effect.tryPromise(() =>
    dependencies.store.findGitHistoryRepository(job.projectId, job.artifactId)
  );
  if (coordinates === null) {
    const created = yield* Effect.tryPromise(() =>
      dependencies.provider.createRepository(job.projectId, job.artifactId)
    );
    const recordedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    coordinates = yield* Effect.tryPromise(() =>
      dependencies.store.recordGitHistoryRepository(job, created, recordedAt)
    );
  }
  const repositoryCoordinates = coordinates;
  if (
    predecessor !== null &&
    predecessor.repositoryName !== repositoryCoordinates.repositoryName
  ) {
    return yield* Effect.fail(new Error("predecessor-repository-mismatch"));
  }
  if (repositoryCoordinates.status !== "provisioned") {
    yield* Effect.tryPromise(() => dependencies.provider.deleteRepository(
      repositoryCoordinates,
    ));
    const completedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    yield* Effect.tryPromise(() => dependencies.store.completeGitHistoryDeletion(
      job,
      completedAt,
    ));
    return "deleted" as const;
  }
  const identity: GitHistoryCommitIdentity = {
    assertOwner: async () => {
      const now = Date.now();
      const renewed = await dependencies.store.renewGitHistoryJob(
        job,
        new Date(now).toISOString(),
        new Date(now + Duration.toMillis(jobLease)).toISOString(),
      );
      if (!renewed) throw new GitHistoryLeaseLost();
    },
    coordinates: repositoryCoordinates,
    expectedParentCommitId: predecessor?.commitId ?? null,
    metadata: {
      artifactId: version.version.artifactId,
      createdAt: version.version.createdAt,
      entryPath: version.version.entryPath,
      installationId: dependencies.installationId,
      manifestDigest: version.version.manifestDigest,
      projectId: version.version.projectId,
      publisherPrincipalId: version.version.publisherPrincipalId,
      versionId: version.version.id,
      versionNumber: version.version.number,
    },
  };
  const request: GitHistoryCommitRequest = {
    ...identity,
    files: plan.files,
    pointers: plan.pointers,
  };
  const adopted = yield* Effect.tryPromise(() =>
    dependencies.provider.lookupCommit(request)
  );
  const commit = adopted ?? (yield* Effect.tryPromise(() =>
    dependencies.provider.commitVersion(request)
  ));
  const completedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
  const completion = yield* Effect.tryPromise(() => dependencies.store.completeGitHistoryMirror(
    job,
    {
      artifactId: job.artifactId,
      commitId: commit.commitId,
      copiedBytes: plan.copiedBytes,
      projectId: job.projectId,
      repositoryName: repositoryCoordinates.repositoryName,
      versionId,
    },
    completedAt,
  ));
  if (completion === "artifact-deleted") {
    yield* Effect.tryPromise(() => dependencies.provider.deleteRepository(
      repositoryCoordinates,
    ));
    const deletedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    yield* Effect.tryPromise(() => dependencies.store.completeGitHistoryDeletion(
      job,
      deletedAt,
    ));
    return "deleted" as const;
  }
  return "mirrored" as const;
});

const retryDelay = Effect.fn("GitHistoryMirrorWorker.retryDelay")(function*(
  attempts: number,
  now: number,
) {
  const step = yield* Schedule.toStep(retrySchedule);
  let delay = Duration.seconds(1);
  for (let index = 0; index <= attempts; index += 1) {
    const [, nextDelay] = yield* step(now, undefined);
    delay = nextDelay;
  }
  return Math.min(Duration.toMillis(delay), Duration.toMillis("5 minutes"));
});

const buildCommitPlan = Effect.fn("GitHistoryMirrorWorker.buildCommitPlan")(
  function*(
    blobs: BlobStore,
    version: ArtifactVersion,
    limits: NonNullable<GitHistoryJob["limits"]>,
  ) {
    const files: GitHistoryCommitFile[] = [];
    const pointers: GitHistoryPointer[] = [];
    let copiedBytes = 0;
    const maximumCopiedFiles = Math.min(
      limits.maximumCopiedFiles,
      defaultGitHistoryMaximumCopiedFiles,
    );
    for (const entry of version.manifest.entries.toSorted((left, right) =>
      left.path.localeCompare(right.path))) {
      const copy = entry.size <= limits.fileCopyBytes &&
        copiedBytes + entry.size <= limits.versionCopyBytes &&
        files.length < maximumCopiedFiles;
      if (!copy) {
        pointers.push({
          mediaType: entry.mediaType,
          path: entry.path,
          sha256: entry.sha256,
          size: entry.size,
        });
        continue;
      }
      const opened = yield* Effect.tryPromise(() => blobs.open(entry.sha256));
      const bytes = yield* Effect.tryPromise(() => readExactBytes(
        opened.body,
        entry.size,
      ));
      files.push({bytes, path: entry.path});
      copiedBytes += entry.size;
    }
    return {copiedBytes, files, pointers};
  },
);

export function gitHistoryCopyPolicyDigest(
  limits: Pick<GitHistoryLimits, "fileCopyBytes" | "versionCopyBytes">,
  maximumCopiedFiles = defaultGitHistoryMaximumCopiedFiles,
): string {
  return createHash("sha256").update(JSON.stringify({
    fileCopyBytes: limits.fileCopyBytes,
    maximumCopiedFiles,
    versionCopyBytes: limits.versionCopyBytes,
  })).digest("hex");
}

export function gitHistoryJobId(
  kind: GitHistoryJobKind,
  artifactId: string,
  versionId: string | null,
): string {
  return `ghj_${createHash("sha256").update(
    `${kind}\0${artifactId}\0${versionId ?? "repository"}`,
  ).digest("hex").slice(0, 32)}`;
}

export function gitHistoryMetadataFiles(
  request: GitHistoryCommitRequest,
): readonly GitHistoryCommitFile[] {
  return [
    {
      bytes: utf8.encode(`${JSON.stringify(request.metadata, null, 2)}\n`),
      path: ".artifactserver/version.json",
    },
    {
      bytes: utf8.encode(`${JSON.stringify(request.pointers, null, 2)}\n`),
      path: ".artifactserver/pointers.json",
    },
  ];
}

async function readExactBytes(
  stream: ReadableStream<Uint8Array>,
  expectedSize: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const result = new Uint8Array(expectedSize);
  let offset = 0;
  const readNext = async (): Promise<void> => {
    const next = await reader.read();
    if (next.done) return;
    if (offset + next.value.byteLength > result.byteLength) {
      throw new Error("A primary blob exceeded its manifest size.");
    }
    result.set(next.value, offset);
    offset += next.value.byteLength;
    await readNext();
  };
  try {
    await readNext();
  } finally {
    reader.releaseLock();
  }
  if (offset !== expectedSize) {
    throw new Error("A primary blob did not match its manifest size.");
  }
  return result;
}

function classifyMirrorFailure(cause: unknown): string {
  if (cause instanceof GitHistoryLeaseLost) return "lease_lost";
  if (cause instanceof Error && cause.message === "version-unavailable") {
    return "version_unavailable";
  }
  if (cause instanceof Error && cause.message === "predecessor-unavailable") {
    return "predecessor_unavailable";
  }
  return "provider_or_storage_failure";
}
