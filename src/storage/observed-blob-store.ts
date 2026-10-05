import type {BlobStore} from "../core/ports.js";

/** Observation seam for content-delivery tests; never parsed from the environment. */
export interface BlobReadObserver {
  readonly bytesRead: (byteLength: number) => void;
}

/** Pull-through counting keeps the source's backpressure: nothing is read ahead of demand. */
function countedStream(
  body: ReadableStream<Uint8Array>,
  observer: BlobReadObserver,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    cancel: (reason) => reader.cancel(reason),
    pull: async (controller) => {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      observer.bytesRead(next.value.byteLength);
      controller.enqueue(next.value);
    },
  }, {highWaterMark: 0});
}

export function observeBlobReads(blobs: BlobStore, observer: BlobReadObserver): BlobStore {
  const observed: BlobStore = {
    inspect: (sha256) => blobs.inspect(sha256),
    open: async (sha256) => {
      const opened = await blobs.open(sha256);
      return {...opened, body: countedStream(opened.body, observer)};
    },
    openRange: async (sha256, range) => {
      const opened = await blobs.openRange(sha256, range);
      return {...opened, body: countedStream(opened.body, observer)};
    },
    put: (write) => blobs.put(write),
  };
  if (blobs.promote === undefined) return observed;
  return {
    ...observed,
    // Calling through `blobs` keeps the adapter's own `this` binding.
    promote: (source) => {
      if (blobs.promote === undefined) throw new Error("The observed blob store stopped promoting.");
      return blobs.promote(source);
    },
  };
}
