import {createHash} from "node:crypto";
import {Effect} from "effect";
import {BlobStorageFailure} from "../core/errors.js";
import type {OpenedStagedFile} from "../core/ports.js";
import {redactedFailureCause} from "../observability/failure-cause-summary.js";

/** Verify immutable bytes without writing another copy or buffering the file. */
export const verifyBlobContent = Effect.fn("verifyBlobContent")(
  function*(opened: OpenedStagedFile, sha256: string, expectedSize: number): Effect.fn.Return<boolean, BlobStorageFailure> {
    if (opened.size !== expectedSize) return false;
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const reader = opened.body.getReader();
        const cancel = () => { void reader.cancel().catch(() => undefined); };
        signal.addEventListener("abort", cancel, {once: true});
        try {
          const hash = createHash("sha256");
          let size = 0;
          while (true) {
            // eslint-disable-next-line no-await-in-loop -- stream chunks must be hashed in byte order
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > expectedSize) return false;
            hash.update(chunk.value);
          }
          return !signal.aborted && size === expectedSize && hash.digest("hex") === sha256;
        } finally {
          signal.removeEventListener("abort", cancel);
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      },
      catch: (cause) => new BlobStorageFailure({cause: redactedFailureCause(cause), operation: "open"}),
    });
  },
);
