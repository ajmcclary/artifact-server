/** A content coding Artifact Server produces at the Node origin. */
export type ContentCoding = "br" | "gzip";

/**
 * Streams one stored representation through a content coding. Node runtimes
 * supply an implementation; the Workers runtime leaves it absent because its
 * edge compresses responses.
 */
export interface ContentEncoder {
  encode(
    body: ReadableStream<Uint8Array>,
    coding: ContentCoding,
    sizeHint: number,
  ): ReadableStream<Uint8Array>;
}

/** Media types worth compressing at the Node origin. */
const compressibleMediaTypes: ReadonlySet<string> = new Set([
  "application/javascript",
  "application/json",
  "image/svg+xml",
  "text/css",
  "text/html",
  "text/javascript",
]);

/** Smaller bodies gain too little to justify the coding overhead. */
export const minimumCompressedBodyBytes = 1024;

export function isCompressibleMediaType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mediaType = contentType.split(";")[0]?.trim().toLocaleLowerCase("en-US");
  return mediaType !== undefined && compressibleMediaTypes.has(mediaType);
}

/** Prefer Brotli, then gzip; a missing header, identity only, or q=0 selects neither. */
export function negotiateContentCoding(acceptEncoding: string | null): ContentCoding | null {
  if (acceptEncoding === null) return null;
  let brotliAllowed = false;
  let gzipAllowed = false;
  for (const candidate of acceptEncoding.split(",")) {
    const [name = "", ...parameters] = candidate.trim().split(";");
    const coding = name.trim().toLocaleLowerCase("en-US");
    if (coding !== "br" && coding !== "gzip") continue;
    if (acceptQuality(parameters) === 0) continue;
    if (coding === "br") brotliAllowed = true;
    else gzipAllowed = true;
  }
  if (brotliAllowed) return "br";
  return gzipAllowed ? "gzip" : null;
}

function acceptQuality(parameters: ReadonlyArray<string>): number {
  for (const parameter of parameters) {
    const [key = "", value = ""] = parameter.split("=");
    if (key.trim().toLocaleLowerCase("en-US") !== "q") continue;
    const quality = Number(value.trim());
    return Number.isFinite(quality) ? quality : 1;
  }
  return 1;
}

/** Add `Accept-Encoding` to `Vary` unless it, or `*`, is already there. */
export function appendAcceptEncodingVary(headers: Headers): void {
  const existing = headers.get("Vary");
  if (
    existing !== null
    && (existing.trim() === "*" || existing
      .toLocaleLowerCase("en-US")
      .split(",")
      .some((member) => member.trim() === "accept-encoding"))
  ) {
    return;
  }
  headers.set("Vary", existing === null ? "Accept-Encoding" : `${existing}, Accept-Encoding`);
}
