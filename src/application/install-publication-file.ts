import {Effect} from "effect";

import {
  type BlobStorageFailure,
  type StagingStorageFailure,
} from "../core/errors.js";
import type {
  BlobWrite,
  SealedStagedSource,
  StoredBlob,
} from "../core/ports.js";

/** An immutable file source that can be opened during publication. */
export interface PublicationFileSource {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  /** When true, the file is already installed and publication may skip it. */
  readonly installed?: boolean;
  readonly signal?: AbortSignal;
  readonly staged?: {
    readonly storageToken: string;
    readonly uploadId: string;
  };
  open(): Effect.Effect<ReadableStream<Uint8Array>, StagingStorageFailure>;
}

/** Blob capabilities required to install one publication file. */
export interface InstallPublicationFileBlobs {
  readonly put: (
    write: BlobWrite,
  ) => Effect.Effect<StoredBlob, BlobStorageFailure>;
  readonly promote?: (
    source: SealedStagedSource,
  ) => Effect.Effect<StoredBlob, BlobStorageFailure>;
}

/** Install one immutable publication file, preferring sealed promotion. */
export const installPublicationFile = Effect.fn(
  "installPublicationFile",
)(function*(
  blobs: InstallPublicationFileBlobs,
  source: PublicationFileSource,
): Effect.fn.Return<StoredBlob, BlobStorageFailure | StagingStorageFailure> {
  const storeByStream = source.open().pipe(
    Effect.flatMap((body) => {
      const write = {
        body,
        sha256: source.sha256,
        size: source.size,
      };
      return blobs.put(source.signal === undefined
        ? write
        : {...write, signal: source.signal});
    }),
  );
  if (source.staged === undefined || blobs.promote === undefined) {
    return yield* storeByStream;
  }
  const {staged} = source;
  return yield* blobs.promote({
    sha256: source.sha256,
    size: source.size,
    storageToken: staged.storageToken,
    uploadId: staged.uploadId,
  }).pipe(
    // A promotion that cannot seal or install create-only degrades to the
    // proven verified-stream path rather than failing the commit.
    Effect.catch(() => storeByStream),
  );
});
