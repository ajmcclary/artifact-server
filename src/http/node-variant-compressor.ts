import {constants, createBrotliCompress} from "node:zlib";

import type {ContentVariantCompressor} from "../core/content-variants.js";

/** One-time background builds can afford quality 9 and a 4 MiB window. */
const brotliQuality = 9;
const brotliWindowBits = 22;

function writeChunk(compressor: ReturnType<typeof createBrotliCompress>, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    compressor.write(chunk, (error) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}

/** Compresses a whole source into memory, abandoning it once the output passes the limit. */
export const nodeBrotliVariantCompressor: ContentVariantCompressor = {
  async compress(body, outputLimitBytes) {
    const compressor = createBrotliCompress({
      params: {
        [constants.BROTLI_PARAM_QUALITY]: brotliQuality,
        [constants.BROTLI_PARAM_LGWIN]: brotliWindowBits,
      },
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let exceeded = false;
    const finished = new Promise<void>((resolve, reject) => {
      compressor.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > outputLimitBytes) {
          exceeded = true;
          compressor.destroy();
          resolve();
          return;
        }
        chunks.push(chunk);
      });
      compressor.once("end", resolve);
      compressor.once("error", reject);
    });
    const reader = body.getReader();
    try {
      for (;;) {
        if (exceeded) {
          // eslint-disable-next-line no-await-in-loop -- cancelling ends the loop
          await reader.cancel();
          break;
        }
        // eslint-disable-next-line no-await-in-loop -- one chunk at a time keeps memory bounded
        const next = await reader.read();
        if (next.done) {
          compressor.end();
          break;
        }
        // eslint-disable-next-line no-await-in-loop -- zlib must accept a chunk before the next read
        await writeChunk(compressor, next.value);
      }
      await finished;
    } catch (error) {
      compressor.destroy();
      await reader.cancel().catch(() => undefined);
      // Writing into a compressor destroyed for exceeding the limit is the expected stop.
      if (exceeded) return null;
      throw error;
    }
    return exceeded ? null : Buffer.concat(chunks);
  },
};
