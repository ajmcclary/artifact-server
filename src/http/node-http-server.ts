import {createServer, type RequestListener, type Server} from "node:http";

import {stagedWriteDeadlineMilliseconds} from "../core/publishing-limits.js";

/**
 * Headroom after the staged write deadline, so the application answers a
 * write that ran out of time before Node tears the connection down.
 */
const stagedWriteAnswerHeadroomMilliseconds = 30_000;

/** Node's own slow-header guard, independent of the long body allowance. */
const maximumHeadersTimeoutMilliseconds = 60_000;

/** Node's default sweep interval for expired requests. */
const maximumConnectionsCheckingIntervalMilliseconds = 30_000;

/**
 * The production request deadline: one staged write's full deadline plus
 * answer headroom. Node's own default (300 s, swept every 30 s) would cut a
 * slow upload that the application still allows.
 */
export const defaultHttpRequestTimeoutMilliseconds =
  stagedWriteDeadlineMilliseconds + stagedWriteAnswerHeadroomMilliseconds;

/** The Node HTTP server deadlines an Artifact Server process listens with. */
export interface NodeHttpServerTimeouts {
  readonly connectionsCheckingInterval: number;
  readonly headersTimeout: number;
  readonly requestTimeout: number;
}

/** Derive Node's request, header, and sweep deadlines from one request deadline. */
export function nodeHttpServerTimeouts(
  requestTimeoutMilliseconds: number = defaultHttpRequestTimeoutMilliseconds,
): NodeHttpServerTimeouts {
  return {
    connectionsCheckingInterval: Math.min(
      maximumConnectionsCheckingIntervalMilliseconds,
      Math.max(10, Math.floor(requestTimeoutMilliseconds / 10)),
    ),
    headersTimeout: Math.min(
      maximumHeadersTimeoutMilliseconds,
      requestTimeoutMilliseconds,
    ),
    requestTimeout: requestTimeoutMilliseconds,
  };
}

/** Create the Node HTTP server for one Artifact Server listener. */
export function createArtifactHttpServer(
  listener: RequestListener,
  requestTimeoutMilliseconds?: number,
): Server {
  return createServer(
    nodeHttpServerTimeouts(requestTimeoutMilliseconds),
    listener,
  );
}
