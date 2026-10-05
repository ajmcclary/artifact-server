import {promisify} from "node:util";
import {brotliCompress, constants, gzip} from "node:zlib";

import {
  appendAcceptEncodingVary,
  isCompressibleMediaType,
  minimumCompressedBodyBytes,
  negotiateContentCoding,
} from "./content-encoding.js";

const compressWithGzip = promisify(gzip);
const compressWithBrotli = promisify(brotliCompress);

/**
 * Wrap a fetch-shaped handler so compressible Node responses are served
 * gzip- or brotli-encoded when the client allows it.
 *
 * Compresses the application's own in-memory responses (JSON, the HTML shell,
 * and memoized assets) by buffering them. Version content never reaches the
 * buffering path: `serveStoredVersionContent` either streams it through a
 * `ContentEncoder` (and sets `Content-Encoding`) or serves identity bytes with
 * `Accept-Ranges: bytes`, and both are passed through untouched here. The
 * Cloudflare Workers deployment receives edge compression instead of this
 * wrapper, which is why it wraps the Node request listener rather than living
 * inside the shared HTTP app.
 */
export function withNodeResponseCompression<
  Rest extends ReadonlyArray<unknown>,
>(
  handler: (request: Request, ...rest: Rest) => Response | Promise<Response>,
): (request: Request, ...rest: Rest) => Promise<Response> {
  return async (request, ...rest) => {
    const response = await handler(request, ...rest);
    return encodeServedResponse(request, response);
  };
}

async function encodeServedResponse(
  request: Request,
  response: Response,
): Promise<Response> {
  if (response.status < 200 || servesRangeableBytes(response.headers)) {
    return response;
  }
  if (response.status === 304) {
    // A 304 must carry the stored variant's Vary so caches keep keying
    // compressible routes on Accept-Encoding.
    return response.headers.has("ETag") ? withAppendedVary(response) : response;
  }
  if (!isCompressibleMediaType(response.headers.get("Content-Type"))) return response;
  const varied = withAppendedVary(response);
  if (
    request.method === "HEAD"
    || varied.status !== 200
    || varied.body === null
    || varied.headers.has("Content-Encoding")
  ) {
    return varied;
  }
  const encoding = negotiateContentCoding(request.headers.get("accept-encoding"));
  if (encoding === null) return varied;
  // Only in-memory application responses reach this point; version content is either already encoded or rangeable.
  const bytes = new Uint8Array(await varied.arrayBuffer());
  if (bytes.byteLength < minimumCompressedBodyBytes) {
    return new Response(bytes, {
      headers: varied.headers,
      status: varied.status,
      statusText: varied.statusText,
    });
  }
  const compressed = encoding === "br"
    ? await compressWithBrotli(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 5,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
      },
    })
    : await compressWithGzip(bytes);
  const headers = new Headers(varied.headers);
  headers.set("Content-Encoding", encoding);
  headers.set("Content-Length", String(compressed.byteLength));
  const etag = headers.get("ETag");
  if (etag !== null && !etag.startsWith("W/")) {
    // The encoded representation differs from the identity one byte for
    // byte, so its validator must be weak.
    headers.set("ETag", `W/${etag}`);
  }
  return new Response(compressed, {
    headers,
    status: varied.status,
    statusText: varied.statusText,
  });
}

function servesRangeableBytes(headers: Headers): boolean {
  return headers.get("Accept-Ranges") === "bytes"
    || headers.has("Content-Range");
}

function withAppendedVary(response: Response): Response {
  const headers = new Headers(response.headers);
  appendAcceptEncodingVary(headers);
  if (headers.get("Vary") === response.headers.get("Vary")) return response;
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
