import {Context, DateTime, Effect, Exit, Layer, Result} from "effect";

import type {ApplicationClock} from "./application-clock.js";
import {
  type ArtifactRepositoryFailure,
  InvalidCleanupBudget,
  InvalidPagination,
  type StagingStorageFailure,
} from "../core/errors.js";
import type {ExpiredStagedUpload} from "../core/ports.js";

/** Inputs for one bounded expired-staging cleanup pass. */
export interface RunExpiredStagingCleanupCommand {
  readonly limit: number;
  /** Maximum files to remove in this pass; defaults to unbounded. */
  readonly maxFiles?: number;
  /** Maximum wall-clock duration for this pass in milliseconds; defaults to unbounded. */
  readonly maxDurationMilliseconds?: number;
}

/** Bounded outcome from one expired-staging cleanup pass. */
export interface ExpiredStagingCleanupReport {
  readonly alreadyAbsent: number;
  readonly budgetExhausted: boolean;
  readonly claimRejected: number;
  readonly deleted: number;
  readonly failed: number;
  readonly remaining: number;
  readonly selected: number;
}

/** Repository operations required to remove expired staging records safely. */
export interface ExpiredStagingCleanupRepository {
  readonly claimExpiredStagedUploadForCleanup: (
    uploadId: string,
    expiredBefore: string,
    now: string,
    staleClaimBefore: string,
  ) => Effect.Effect<boolean, ArtifactRepositoryFailure>;
  readonly listExpiredStagedUploads: (
    expiredBefore: string,
    now: string,
    limit: number,
  ) => Effect.Effect<readonly ExpiredStagedUpload[], ArtifactRepositoryFailure>;
  readonly removeExpiredStagedFile: (
    uploadId: string,
    storageToken: string,
    expiredBefore: string,
    now: string,
  ) => Effect.Effect<void, ArtifactRepositoryFailure>;
  readonly removeExpiredStagedUpload: (
    uploadId: string,
    expiredBefore: string,
    now: string,
  ) => Effect.Effect<boolean, ArtifactRepositoryFailure>;
  readonly releaseStagedUploadCleanupClaim: (
    uploadId: string,
    claimedAt: string,
    staleClaimBefore: string,
  ) => Effect.Effect<void, ArtifactRepositoryFailure>;
}

/** Staging-object operation required by cleanup. */
export interface ExpiredStagingCleanupStorage {
  readonly remove: (
    uploadId: string,
    storageToken: string,
  ) => Effect.Effect<void, StagingStorageFailure>;
}

/** Dependencies and bounded concurrency policy for expired staging cleanup. */
export interface ExpiredStagingCleanupDependencies {
  readonly clock: ApplicationClock;
  readonly concurrency: number;
  readonly repository: ExpiredStagingCleanupRepository;
  readonly settleDelayMilliseconds: number;
  readonly storage: ExpiredStagingCleanupStorage;
}

interface ExpiredStagingCleanupOperations {
  readonly runPass: (
    command: RunExpiredStagingCleanupCommand,
  ) => Effect.Effect<
    ExpiredStagingCleanupReport,
    ArtifactRepositoryFailure | InvalidCleanupBudget | InvalidPagination
  >;
}

/** Removes only expired, never-committed staging records and their named objects. */
export class ExpiredStagingCleanupService extends Context.Service<
  ExpiredStagingCleanupService,
  ExpiredStagingCleanupOperations
>()("artifact-server/application/ExpiredStagingCleanupService") {
  /** Construct cleanup from deployment-neutral repository and storage ports. */
  static readonly layer = (
    dependencies: ExpiredStagingCleanupDependencies,
  ): Layer.Layer<ExpiredStagingCleanupService> =>
    Layer.succeed(
      ExpiredStagingCleanupService,
      makeExpiredStagingCleanupService(dependencies),
    );
}

const maxFilesUpperBound = 1_000_000;
const maxDurationUpperBound = 86_400_000;

const validateBudget = (
  value: number | undefined,
  lower: number,
  upper: number,
  name: string,
): Effect.Effect<number, InvalidCleanupBudget> =>
  Effect.gen(function*() {
    const resolved = value ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(resolved)) return resolved;
    if (
      !Number.isSafeInteger(resolved) ||
      resolved < lower ||
      resolved > upper
    ) {
      return yield* new InvalidCleanupBudget({
        message: `The cleanup ${name} must be an integer from ${lower} through ${upper} or omitted.`,
      });
    }
    return resolved;
  });

function makeExpiredStagingCleanupService(
  dependencies: ExpiredStagingCleanupDependencies,
): ExpiredStagingCleanupOperations {
  const removeClaimed = Effect.fnUntraced(
    function*(
      upload: ExpiredStagedUpload,
      expiredBefore: string,
      now: string,
      budget: {filesRemaining: number},
    ) {
      for (const file of upload.files) {
        if (budget.filesRemaining <= 0) {
          return "budget-exhausted" as const;
        }
        yield* dependencies.storage.remove(upload.id, file.storageToken);
        yield* dependencies.repository.removeExpiredStagedFile(
          upload.id,
          file.storageToken,
          expiredBefore,
          now,
        );
        budget.filesRemaining -= 1;
      }
      return yield* dependencies.repository.removeExpiredStagedUpload(
        upload.id,
        expiredBefore,
        now,
      );
    },
  );

  const cleanOne = Effect.fn("ExpiredStagingCleanupService.cleanOne")(
    function*(
      upload: ExpiredStagedUpload,
      expiredBefore: string,
      now: string,
      budget: {filesRemaining: number},
    ) {
      // A claim held for a whole settle delay is presumed abandoned by a
      // crashed pass; until then it keeps concurrent passes away.
      const claimed = yield* dependencies.repository
        .claimExpiredStagedUploadForCleanup(
          upload.id,
          expiredBefore,
          now,
          expiredBefore,
        );
      if (!claimed) return "claim-rejected" as const;
      // A pass that stops short hands the upload straight to the next pass.
      const release = dependencies.repository
        .releaseStagedUploadCleanupClaim(upload.id, now, expiredBefore)
        .pipe(Effect.ignore);
      return yield* removeClaimed(upload, expiredBefore, now, budget).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) && exit.value !== "budget-exhausted"
            ? Effect.void
            : release
        ),
      );
    },
  );

  const runPass = Effect.fn("ExpiredStagingCleanupService.runPass")(
    function*(command: RunExpiredStagingCleanupCommand) {
      if (!Number.isSafeInteger(command.limit) || command.limit < 1 || command.limit > 1_000) {
        return yield* new InvalidPagination({
          message: "The cleanup limit must be an integer from 1 through 1000.",
        });
      }
      const maxFiles = yield* validateBudget(
        command.maxFiles,
        1,
        maxFilesUpperBound,
        "maxFiles",
      );
      const maxDurationMilliseconds = yield* validateBudget(
        command.maxDurationMilliseconds,
        1,
        maxDurationUpperBound,
        "maxDurationMilliseconds",
      );
      const now = yield* dependencies.clock.now;
      const expiredBefore = DateTime.formatIso(DateTime.subtractDuration(
        now,
        dependencies.settleDelayMilliseconds,
      ));
      const deadline = Number.isFinite(maxDurationMilliseconds)
        ? DateTime.addDuration(now, maxDurationMilliseconds)
        : null;
      const uploads = yield* dependencies.repository.listExpiredStagedUploads(
        expiredBefore,
        DateTime.formatIso(now),
        command.limit,
      );
      const budget = {filesRemaining: maxFiles};
      let deleted = 0;
      let failed = 0;
      let alreadyAbsent = 0;
      let claimRejected = 0;
      let budgetExhausted = false;
      for (const upload of uploads) {
        if (deadline !== null && DateTime.isGreaterThan(
          yield* dependencies.clock.now,
          deadline,
        )) {
          budgetExhausted = true;
          break;
        }
        if (budget.filesRemaining <= 0) {
          budgetExhausted = true;
          break;
        }
        const result = yield* cleanOne(
          upload,
          expiredBefore,
          DateTime.formatIso(now),
          budget,
        ).pipe(Effect.result);
        if (Result.isFailure(result)) {
          failed += 1;
        } else if (result.success === true) {
          deleted += 1;
        } else if (result.success === false) {
          alreadyAbsent += 1;
        } else if (result.success === "claim-rejected") {
          claimRejected += 1;
        } else {
          budgetExhausted = true;
          break;
        }
      }
      const remaining = uploads.length - deleted - alreadyAbsent;
      const report: ExpiredStagingCleanupReport = {
        alreadyAbsent,
        budgetExhausted,
        claimRejected,
        deleted,
        failed,
        remaining,
        selected: uploads.length,
      };
      yield* Effect.logInfo("Expired staging cleanup pass completed.").pipe(
        Effect.annotateLogs({
          cleanup_budget_exhausted: report.budgetExhausted,
          cleanup_claim_rejected: report.claimRejected,
          cleanup_deleted: report.deleted,
          cleanup_failed: report.failed,
          cleanup_already_absent: report.alreadyAbsent,
          cleanup_remaining: report.remaining,
          cleanup_selected: report.selected,
        }),
      );
      return report;
    },
  );

  return ExpiredStagingCleanupService.of({runPass});
}
