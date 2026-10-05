import {randomBytes} from "node:crypto";
import {brotliDecompressSync} from "node:zlib";

import {describe, expect, test} from "vitest";

import {nodeBrotliVariantCompressor} from "../../src/http/node-variant-compressor.js";

interface TrackedSource {
  readonly cancelled: () => boolean;
  readonly stream: ReadableStream<Uint8Array>;
}

/** A real stream over fixed chunks that records whether its consumer cancelled it. */
function trackedSource(chunks: readonly Uint8Array[]): TrackedSource {
  let index = 0;
  let wasCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel: () => {
      wasCancelled = true;
    },
    pull: (controller) => {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  });
  return {cancelled: () => wasCancelled, stream};
}

describe("node Brotli variant compressor", () => {
  test("foundation: compresses a source into Brotli that decodes to the exact bytes", async () => {
    const text = new TextEncoder().encode(
      Array.from({length: 4_000}, (_, index) => `{"id":"row-${index}","status":"awaiting-review"}`).join("\n"),
    );
    const chunks = Array.from({length: 8}, (_, index) =>
      text.slice(index * (text.byteLength / 8), (index + 1) * (text.byteLength / 8)));
    const compressed = await nodeBrotliVariantCompressor.compress(trackedSource(chunks).stream, text.byteLength);
    expect(compressed).not.toBeNull();
    expect(compressed?.byteLength).toBeLessThan(text.byteLength / 4);
    expect(new Uint8Array(brotliDecompressSync(compressed ?? new Uint8Array()))).toEqual(text);
  });

  test("foundation: stops and cancels the source once the output passes the limit", async () => {
    const chunks = Array.from({length: 64}, () => new Uint8Array(randomBytes(64 * 1_024)));
    const source = trackedSource(chunks);
    const compressed = await nodeBrotliVariantCompressor.compress(source.stream, 256 * 1_024);
    expect(compressed).toBeNull();
    expect(source.cancelled()).toBe(true);
  });
});
