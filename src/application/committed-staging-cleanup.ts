import {DateTime, Effect, Result} from "effect";
import {ArtifactRepositoryFailure, BlobStorageFailure} from "../core/errors.js";
import type {CommittedStagingCleanupRepository, OpenedStagedFile} from "../core/ports.js";
import type {ApplicationClock} from "./application-clock.js";
import type {StagingStoragePort} from "./staged-upload.js";
import {redactedFailureCause} from "../observability/failure-cause-summary.js";
import {verifyBlobContent} from "./verify-blob-content.js";

export interface CommittedStagingCleanupDependencies {
  readonly repository: CommittedStagingCleanupRepository;
  readonly openBlob: (sha256: string) => Effect.Effect<OpenedStagedFile, BlobStorageFailure>;
}

/** Clean only expired committed-upload staging; receipts and blob keys stay intact. */
export const cleanupCommittedStaging = Effect.fn("cleanupCommittedStaging")(
  function*(dependencies: CommittedStagingCleanupDependencies, clock: ApplicationClock,
    storage: Pick<StagingStoragePort,"remove">, command: {readonly limit:number;readonly maxFiles:number;
      readonly expiredBefore:string;readonly now:string;readonly maxDurationMilliseconds:number}) {
    const repository = dependencies.repository;
    const uploads = yield* repositoryCall("listCommittedStaging", () => repository.list(command.expiredBefore,command.limit));
    const deadline = DateTime.addDuration(yield* clock.now,Math.min(command.maxDurationMilliseconds,60_000));
    let filesRemaining = Math.min(command.maxFiles,1_024);
    let deleted=0, failed=0, claimRejected=0, budgetExhausted=false;
    const verified = new Set<string>();
    for (const upload of uploads) {
      if (filesRemaining<=0 || DateTime.isGreaterThan(yield* clock.now,deadline)) {budgetExhausted=true;break;}
      const claimed = yield* repositoryCall("claimCommittedStaging", () =>
        repository.claim(upload.id,command.expiredBefore,command.now,command.expiredBefore));
      if (!claimed) {claimRejected++;continue;}
      const result = yield* Effect.gen(function*() {
        for (const file of upload.files) {
          if (filesRemaining<=0 || DateTime.isGreaterThan(yield* clock.now,deadline)) {budgetExhausted=true;return false;}
          const identity=file.sha256+":"+file.size;
          if (!verified.has(identity)) {
            const opened=yield* dependencies.openBlob(file.sha256);
            const intact=yield* verifyBlobContent(opened,file.sha256,file.size).pipe(
              Effect.ensuring(Effect.promise(()=>opened.body.cancel().catch(()=>undefined))));
            if (!intact) return yield* new BlobStorageFailure({operation:"inspect",cause:new Error("Committed bytes are not intact; staging was retained.")});
            verified.add(identity);
          }
          yield* storage.remove(upload.id,file.storageToken);
          yield* repositoryCall("markCommittedStagingRemoved",()=>repository.markFileRemoved(upload.id,file.storageToken,command.now,command.now));
          filesRemaining--;
        }
        return yield* repositoryCall("completeCommittedStagingCleanup",()=>repository.complete(upload.id,command.now,command.now));
      }).pipe(
        Effect.ensuring(repositoryCall("releaseCommittedStagingCleanup",()=>repository.release(upload.id,command.now,command.expiredBefore)).pipe(
          Effect.catch(()=>Effect.logWarning("Committed staging cleanup claim will expire after a failed release.")))),
        Effect.result,
      );
      if (Result.isFailure(result)) failed++;
      else if (result.success) deleted++;
      else if (filesRemaining === 0) budgetExhausted = true;
    }
    return {selected:uploads.length,deleted,failed,claimRejected,budgetExhausted,remaining:uploads.length-deleted};
  },
);

function repositoryCall<A>(operation:ArtifactRepositoryFailure["operation"], run:()=>Promise<A>) {
  return Effect.tryPromise({try:run,catch:(cause)=>new ArtifactRepositoryFailure({cause:redactedFailureCause(cause),operation})});
}
