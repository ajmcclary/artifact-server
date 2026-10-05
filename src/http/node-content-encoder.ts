import type {Transform} from "node:stream";
import {constants, createBrotliCompress, createGzip} from "node:zlib";

import type {ContentCoding, ContentEncoder} from "./content-encoding.js";

/** Brotli 4 and gzip 6 keep per-open CPU modest while streaming. */
const brotliQuality = 4;
/**
 * A 1 MiB window and no size hint bound Brotli's native state to about 3 MiB
 * per stream. A size hint for a 64 MiB entry grows it several-fold, and
 * concurrent large reads would multiply that.
 */
const brotliWindowBits = 20;
const gzipLevel = 6;

function createCompressor(coding: ContentCoding): Transform {
  return coding === "br"
    ? createBrotliCompress({
      params: {
        [constants.BROTLI_PARAM_QUALITY]: brotliQuality,
        [constants.BROTLI_PARAM_LGWIN]: brotliWindowBits,
      },
    })
    : createGzip({level: gzipLevel});
}

/**
 * Adapts a zlib transform to a web TransformStream. The stream calls
 * `transform` again only after the encoded side has been read, so at most one
 * input chunk's output waits in memory.
 */
function webCompression(compressor: Transform): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream<Uint8Array, Uint8Array>({
    flush: () => new Promise<void>((resolve, reject) => {
      compressor.once("end", resolve);
      compressor.once("error", reject);
      compressor.end();
    }),
    start: (controller) => {
      compressor.on("data", (chunk: Buffer) => {
        try {
          controller.enqueue(chunk);
        } catch {
          // zlib can finish a chunk after the response was cancelled; that
          // output has nowhere to go, so stop the compressor instead.
          compressor.destroy();
        }
      });
      compressor.once("error", (error) => {
        controller.error(error);
      });
    },
    transform: (chunk) => new Promise<void>((resolve, reject) => {
      compressor.write(chunk, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    }),
  });
}

/**
 * A cancelled response errors the transform, and `pipeThrough` then cancels its
 * source. This pull-through source turns that cancel into destroying the
 * compressor and cancelling the blob read, without reading ahead of demand.
 */
function cancellableSource(
  body: ReadableStream<Uint8Array>,
  compressor: Transform,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    cancel: async (reason) => {
      compressor.destroy();
      await reader.cancel(reason);
    },
    pull: async (controller) => {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
  }, {highWaterMark: 0});
}

export const nodeContentEncoder: ContentEncoder = {
  encode(body, coding) {
    const compressor = createCompressor(coding);
    return cancellableSource(body, compressor).pipeThrough(webCompression(compressor));
  },
};
