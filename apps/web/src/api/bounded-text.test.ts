import {describe, expect, test} from "vitest";

import {
  maximumReviewHtmlBytes,
  readBoundedReviewHtml,
  ReviewHtmlTooLarge,
} from "./bounded-text";

describe("bounded Review HTML delivery", () => {
  test("preserves UTF-8 across chunks up to the byte limit", async () => {
    const prefix = new TextEncoder().encode("café");
    const bytes = new Uint8Array(maximumReviewHtmlBytes);
    bytes.fill(32);
    bytes.set(prefix);
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 4));
        controller.enqueue(bytes.subarray(4));
        controller.close();
      },
    }));
    const text = await readBoundedReviewHtml(response);
    expect(text.startsWith("café ")).toBe(true);
    expect(new TextEncoder().encode(text).byteLength).toBe(maximumReviewHtmlBytes);
  });

  test("refuses an oversized declared response before reading it", async () => {
    const response = new Response("large", {
      headers: {"Content-Length": String(maximumReviewHtmlBytes + 1)},
    });
    await expect(readBoundedReviewHtml(response)).rejects.toBeInstanceOf(
      ReviewHtmlTooLarge,
    );
  });

  test("stops an underestimated streamed response at the actual byte limit", async () => {
    let canceled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(maximumReviewHtmlBytes));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        canceled = true;
      },
    }), {headers: {"Content-Length": "1"}});
    await expect(readBoundedReviewHtml(response)).rejects.toBeInstanceOf(
      ReviewHtmlTooLarge,
    );
    expect(canceled).toBe(true);
  });
});
