import {connect, type Socket} from "node:net";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {type InviteServer, startInviteServer} from "../support/invites.js";

/**
 * A declared oversized body is refused from its headers, and the server then
 * reads and discards the rest of the upload so the connection survives. If the
 * refusal opened the request body stream first, the adapter's drain stalls on
 * that stream's backpressure and force-closes the socket with bytes unread,
 * which resets the connection and can lose the 413 the client already got.
 */
const declaredBytes = 2_000_000;
const firstChunkBytes = 64 * 1_024;

let context: InviteServer;

beforeEach(async () => {
  context = await startInviteServer();
});

afterEach(async () => {
  await context.stop();
});

describe("oversized request bodies", () => {
  test("a declared oversized body gets a 413 and the connection stays usable for the next request", async () => {
    const base = new URL(context.server.baseUrl);
    const socket = await open(base);
    const reader = responseReader(socket);
    try {
      socket.write([
        "POST /auth/invites/preview HTTP/1.1",
        `Host: ${base.host}`,
        "Content-Type: application/json",
        `Origin: ${base.origin}`,
        "Sec-Fetch-Mode: cors",
        "Sec-Fetch-Site: same-origin",
        `Content-Length: ${declaredBytes}`,
        "",
        "",
      ].join("\r\n"));
      socket.write(Buffer.alloc(firstChunkBytes, 0x78));

      expect((await reader.next()).status).toBe(413);

      // The rest of the upload arrives after the refusal; the server must drain it.
      socket.write(Buffer.alloc(declaredBytes - firstChunkBytes, 0x78));
      socket.write(`GET /health HTTP/1.1\r\nHost: ${base.host}\r\n\r\n`);

      expect((await reader.next()).status).toBe(200);
    } finally {
      socket.destroy();
    }
  }, 15_000);
});

function open(base: URL): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(base.port), base.hostname, () => resolve(socket));
    socket.once("error", reject);
  });
}

/** The part of one HTTP/1.1 response these checks need. */
interface ResponseHead {
  readonly status: number;
}

/** Reads whole responses from one connection, in order. */
interface ResponseReader {
  readonly next: () => Promise<ResponseHead>;
}

/** Read whole HTTP/1.1 responses (Content-Length or chunked bodies), one at a time. */
function responseReader(socket: Socket): ResponseReader {
  let buffered = Buffer.alloc(0);
  let closed = false;
  let wake: (() => void) | null = null;
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    wake?.();
  });
  const onClosed = () => {
    closed = true;
    wake?.();
  };
  socket.on("end", onClosed);
  socket.on("close", onClosed);
  socket.on("error", onClosed);

  const take = (): ResponseHead | null => {
    const headerEnd = buffered.indexOf("\r\n\r\n");
    if (headerEnd < 0) return null;
    const head = buffered.subarray(0, headerEnd).toString("latin1");
    let total: number;
    if (/^transfer-encoding:\s*chunked/imu.test(head)) {
      const last = buffered.indexOf("\r\n0\r\n\r\n", headerEnd + 2);
      if (last < 0) return null;
      total = last + 7;
    } else {
      total = headerEnd + 4 + Number(/^content-length:\s*(\d+)/imu.exec(head)?.[1] ?? "0");
      if (buffered.length < total) return null;
    }
    buffered = buffered.subarray(total);
    return {status: Number(head.slice(9, 12))};
  };

  return {
    next: async () => {
      for (;;) {
        const response = take();
        if (response !== null) return response;
        if (closed) throw new Error("The server closed the connection before sending a complete response.");
        // eslint-disable-next-line no-await-in-loop -- wait for the next chunk or the close
        await new Promise<void>((resolve) => {
          wake = () => {
            wake = null;
            resolve();
          };
        });
      }
    },
  };
}
