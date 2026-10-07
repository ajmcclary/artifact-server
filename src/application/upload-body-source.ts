/**
 * A caller's upload body that remembers whether its own byte source failed.
 *
 * A staging write can fail because the provider failed or because the bytes
 * stopped arriving. Only the second is the caller's to retry, and the two are
 * indistinguishable once the provider wraps the stream error, so the
 * application observes the source before handing it to the provider.
 */
export interface ObservedUploadBody {
  readonly body: ReadableStream<Uint8Array>;
  /** The source's own failure; undefined while it streams, ends, or is cancelled. */
  sourceFailure(): {readonly cause: unknown} | undefined;
}

/** Pass an upload body through unchanged while recording a source failure. */
export function observeUploadBody(
  source: ReadableStream<Uint8Array>,
): ObservedUploadBody {
  const reader = source.getReader();
  let failure: {readonly cause: unknown} | undefined;
  const body = new ReadableStream<Uint8Array>({
    cancel: (reason) => reader.cancel(reason),
    pull: async (controller) => {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (cause) {
        failure = {cause};
        throw cause;
      }
      if (next.done) {
        controller.close();
      } else {
        controller.enqueue(next.value);
      }
    },
  }, {highWaterMark: 0});
  return {body, sourceFailure: () => failure};
}
