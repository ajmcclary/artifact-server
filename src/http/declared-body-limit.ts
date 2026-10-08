import type {MiddlewareHandler} from "hono";
import {bodyLimit} from "hono/body-limit";

type BodyLimitOptions = Parameters<typeof bodyLimit>[0];

/** Options for {@link declaredBodyLimit}; the refusal response is required. */
export type DeclaredBodyLimitOptions = BodyLimitOptions & {
  readonly onError: NonNullable<BodyLimitOptions["onError"]>;
};

/**
 * Hono's bodyLimit with the declared-size check moved first.
 *
 * bodyLimit reads `c.req.raw.body` before it compares Content-Length. Under
 * @hono/node-server that opens the request as a web stream whose unread queue
 * keeps pausing the request, so after the 413 the adapter cannot drain the rest
 * of the upload: it force-closes the socket with bytes unread, which resets the
 * connection and can lose the 413 the client already received. Refusing a
 * declared oversized body from its headers leaves the body stream unopened, so
 * the adapter drains it and the connection stays usable. Bodies without a
 * declared length still go through bodyLimit's streaming count.
 */
export function declaredBodyLimit(options: DeclaredBodyLimitOptions): MiddlewareHandler {
  const streamingLimit = bodyLimit(options);
  return async (context, next) => {
    const declared = context.req.header("content-length");
    if (
      declared !== undefined
      && context.req.header("transfer-encoding") === undefined
      && Number.parseInt(declared, 10) > options.maxSize
    ) {
      return options.onError(context);
    }
    return streamingLimit(context, next);
  };
}
