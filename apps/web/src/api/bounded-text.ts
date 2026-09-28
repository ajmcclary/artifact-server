/** Maximum HTML bytes Review may parse or copy into its annotation frame. */
export const maximumReviewHtmlBytes = 4 * 1024 * 1024;

export class ReviewHtmlTooLarge extends Error {
  constructor() {
    super("This HTML file is too large for Review. Open or download the raw artifact instead.");
    this.name = "ReviewHtmlTooLarge";
  }
}

/** Read a Review HTML response without trusting its declared length. */
export async function readBoundedReviewHtml(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maximumReviewHtmlBytes) {
    await response.body?.cancel();
    throw new ReviewHtmlTooLarge();
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pieces: string[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      // eslint-disable-next-line no-await-in-loop -- each chunk advances the stream
      const {done, value} = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumReviewHtmlBytes) {
        // eslint-disable-next-line no-await-in-loop -- stop the response before reporting the limit
        await reader.cancel();
        throw new ReviewHtmlTooLarge();
      }
      pieces.push(decoder.decode(value, {stream: true}));
    }
    pieces.push(decoder.decode());
    return pieces.join("");
  } finally {
    reader.releaseLock();
  }
}
