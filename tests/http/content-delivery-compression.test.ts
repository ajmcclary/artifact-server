import {createHash, randomBytes} from "node:crypto";
import {request} from "node:http";
import {brotliDecompressSync, gunzipSync} from "node:zlib";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const encoder = new TextEncoder();
const scriptPath = "assets/rows.js";
const scriptBytes = encoder.encode(`export const rows = [\n${
  Array.from({length: 400}, (_, index) => `  {"id": "row-${index}", "status": "awaiting-review"},`).join("\n")
}\n];\n`);

const scriptDigest = createHash("sha256").update(scriptBytes).digest("hex");
const binaryBytes = new Uint8Array(4096).map((_, index) => index % 251);
const thresholdBytes = encoder.encode("x".repeat(1024));
const belowThresholdBytes = encoder.encode("x".repeat(1023));

const leaseResponseSchema = z.object({baseUrl: z.url()});
const bootstrapResponseSchema = z.object({bootstrapUrl: z.url()});

const largeEntryPath = "assets/large.js";
/** Base64 text: still text/javascript, but close to incompressible, so socket buffers hold few source bytes. */
const largeBytes = encoder.encode(`const payload = "${randomBytes(48 * 1_048_576).toString("base64")}";\n`);
const disconnectReadBound = 8 * 1_048_576;
const concurrentReadMemoryBound = 256 * 1_048_576;

interface StreamOutcome {
  readonly bytes: number;
  readonly coding: string | null;
}

/** Streams one response, counting bytes without keeping them; optionally abandons it after the first chunk. */
function streamVersion(
  server: RunningTestServer,
  url: string,
  acceptEncoding: string,
  abandonAfterFirstChunk: boolean,
): Promise<StreamOutcome> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const outgoing = request({
      headers: ["Host", `${target.hostname}:${server.port}`, "Accept-Encoding", acceptEncoding],
      hostname: "127.0.0.1",
      method: "GET",
      path: `${target.pathname}${target.search}`,
      port: server.port,
    }, (incoming) => {
      const coding = incoming.headers["content-encoding"] ?? null;
      let bytes = 0;
      incoming.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (abandonAfterFirstChunk) {
          outgoing.destroy();
          resolve({bytes, coding});
        }
      });
      incoming.on("end", () => resolve({bytes, coding}));
      incoming.on("error", (error) => {
        if (!abandonAfterFirstChunk) reject(error);
      });
    });
    outgoing.on("error", (error) => {
      if (!abandonAfterFirstChunk) reject(error);
    });
    outgoing.end();
  });
}

/** Resolves once `read` stops changing for `quietMilliseconds`, or rejects after `limitMilliseconds`. */
function settled(read: () => number, quietMilliseconds: number, limitMilliseconds: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let last = read();
    let stableSince = performance.now();
    const started = stableSince;
    const timer = setInterval(() => {
      const now = performance.now();
      const current = read();
      if (current !== last) {
        last = current;
        stableSince = now;
      } else if (now - stableSince >= quietMilliseconds) {
        clearInterval(timer);
        resolve(current);
      }
      if (now - started > limitMilliseconds) {
        clearInterval(timer);
        reject(new Error("The storage read never settled."));
      }
    }, 25);
  });
}

function trackedMemory(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.external + usage.arrayBuffers;
}

function decode(coding: string | null, bytes: ArrayBuffer): Uint8Array {
  const buffer = Buffer.from(bytes);
  if (coding === "br") return new Uint8Array(brotliDecompressSync(buffer));
  if (coding === "gzip") return new Uint8Array(gunzipSync(buffer));
  return new Uint8Array(buffer);
}

function siteFiles(extra: readonly TestSiteFile[] = []): readonly TestSiteFile[] {
  return [
    {bytes: encoder.encode("<!doctype html><title>Compression</title>"), mediaType: "text/html; charset=utf-8", path: "index.html"},
    {bytes: scriptBytes, mediaType: "text/javascript; charset=utf-8", path: scriptPath},
    ...extra,
  ];
}

describe("streaming content-delivery compression", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let blobBytesRead = 0;
  let blobStreamsClosed = 0;

  beforeEach(async () => {
    installation = await createTestInstallation();
    blobBytesRead = 0;
    blobStreamsClosed = 0;
    server = await startTestServer(installation, {
      blobReadObserver: {
        bytesRead: (byteLength) => {
          blobBytesRead += byteLength;
        },
        streamClosed: () => {
          blobStreamsClosed += 1;
        },
      },
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function publishSite(
    accessSetting: "account_required" | "public_link",
    idempotencyKey: string,
    extra: readonly TestSiteFile[] = [],
  ): Promise<PublishResponse> {
    const files = siteFiles(extra);
    const upload = await createStagedUpload(server, installation, "index.html", files);
    await uploadEveryStagedFile(installation, upload.body, files);
    const committed = await commitStagedUpload(installation, upload.body, idempotencyKey, {
      accessSetting,
      kind: "new_artifact",
      name: `Compression ${idempotencyKey}`,
      tags: [],
    });
    expect(committed.response.status).toBe(201);
    return committed.body;
  }

  async function issuePreviewLease(published: PublishResponse): Promise<string> {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/preview-leases?projectId=${published.artifact.projectId}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}, method: "POST"},
    );
    expect(response.status).toBe(201);
    return leaseResponseSchema.parse(await response.json()).baseUrl;
  }

  async function openContentSession(published: PublishResponse): Promise<{readonly cookie: string; readonly origin: string}> {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/content-sessions`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}, method: "POST"},
    );
    expect(response.status).toBe(201);
    const issued = bootstrapResponseSchema.parse(await response.json());
    const exchange = await fetchVersion(server, issued.bootstrapUrl);
    const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
    if (cookie === undefined) throw new Error("The content session set no cookie.");
    return {cookie, origin: new URL(issued.bootstrapUrl).origin};
  }


  test("foundation: the blob read observer counts a full identity read", async () => {
    const published = await publishSite("public_link", "observer-full-read");
    const response = await fetchVersion(server, new URL(scriptPath, published.links.version).toString());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(blobBytesRead).toBe(scriptBytes.byteLength);
  });

  test("CNT-010-B: eligible full content responses stream br or gzip and decode to the stored bytes", async () => {
    const privateSite = await publishSite("account_required", "cnt-010-b-private");
    const publicSite = await publishSite("public_link", "cnt-010-b-public");
    const session = await openContentSession(privateSite);
    const targets = [
      {cookie: null, url: new URL(scriptPath, await issuePreviewLease(privateSite)).toString()},
      {cookie: null, url: new URL(scriptPath, publicSite.links.version).toString()},
      {cookie: session.cookie, url: new URL(scriptPath, session.origin).toString()},
    ];
    for (const target of targets) {
      const base: Record<string, string> = target.cookie === null ? {} : {Cookie: target.cookie};
      for (const coding of ["br", "gzip"] as const) {
        // eslint-disable-next-line no-await-in-loop -- each request is asserted on its own
        const encoded = await fetchVersion(server, target.url, "GET", {...base, "Accept-Encoding": coding});
        expect(encoded.status).toBe(200);
        expect(encoded.headers.get("content-encoding")).toBe(coding);
        expect(encoded.headers.get("etag")).toBe(`W/"${scriptDigest}"`);
        expect(encoded.headers.get("vary")).toContain("Accept-Encoding");
        expect(encoded.headers.get("content-length")).toBeNull();
        expect(encoded.headers.get("accept-ranges")).toBeNull();
        // Chunked transfer proves the buffering wrapper did not re-materialize the body.
        expect(encoded.headers.get("transfer-encoding")).toBe("chunked");
        // eslint-disable-next-line no-await-in-loop -- the body belongs to this response
        expect(decode(coding, await encoded.arrayBuffer())).toEqual(scriptBytes);

        // eslint-disable-next-line no-await-in-loop -- HEAD must mirror the GET just made
        const head = await fetchVersion(server, target.url, "HEAD", {...base, "Accept-Encoding": coding});
        expect(head.status).toBe(200);
        expect(head.headers.get("content-encoding")).toBe(coding);
        expect(head.headers.get("etag")).toBe(`W/"${scriptDigest}"`);
        expect(head.headers.get("content-length")).toBeNull();
        expect(head.headers.get("accept-ranges")).toBeNull();
      }

      // eslint-disable-next-line no-await-in-loop -- identity is asserted after both codings
      const identity = await fetchVersion(server, target.url, "GET", base);
      expect(identity.headers.get("content-encoding")).toBeNull();
      expect(identity.headers.get("accept-ranges")).toBe("bytes");
      expect(identity.headers.get("etag")).toBe(`"${scriptDigest}"`);
      expect(identity.headers.get("vary")).toContain("Accept-Encoding");
      // eslint-disable-next-line no-await-in-loop -- the body belongs to this response
      expect(new Uint8Array(await identity.arrayBuffer())).toEqual(scriptBytes);

      // eslint-disable-next-line no-await-in-loop -- revalidation follows the full reads
      const revalidated = await fetchVersion(server, target.url, "GET", {
        ...base,
        "Accept-Encoding": "gzip",
        "If-None-Match": `W/"${scriptDigest}"`,
      });
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get("vary")).toContain("Accept-Encoding");
      expect(revalidated.headers.get("content-encoding")).toBeNull();
    }
  }, 60_000);

  test("CNT-010-F: ranges, refusals, small and binary entries stay identity with ranges intact", async () => {
    const published = await publishSite("account_required", "cnt-010-f-identity-fallbacks", [
      {bytes: binaryBytes, mediaType: "application/octet-stream", path: "assets/blob.bin"},
      {bytes: thresholdBytes, mediaType: "text/javascript", path: "assets/threshold.js"},
      {bytes: belowThresholdBytes, mediaType: "text/javascript", path: "assets/below.js"},
    ]);
    const lease = await issuePreviewLease(published);
    const at = (entryPath: string) => new URL(entryPath, lease).toString();
    const size = scriptBytes.byteLength;

    const partial = await fetchVersion(server, at(scriptPath), "GET", {"Accept-Encoding": "gzip", Range: "bytes=0-9"});
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-encoding")).toBeNull();
    expect(partial.headers.get("content-range")).toBe(`bytes 0-9/${size}`);
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(scriptBytes.slice(0, 10));

    const weakIfRange = await fetchVersion(server, at(scriptPath), "GET", {
      "Accept-Encoding": "gzip",
      "If-Range": `W/"${scriptDigest}"`,
      Range: "bytes=0-9",
    });
    expect(weakIfRange.status).toBe(200);
    expect(weakIfRange.headers.get("content-encoding")).toBeNull();
    expect(weakIfRange.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await weakIfRange.arrayBuffer())).toEqual(scriptBytes);

    const unsatisfiable = await fetchVersion(server, at(scriptPath), "GET", {"Accept-Encoding": "gzip", Range: `bytes=${size + 10}-`});
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe(`bytes */${size}`);

    for (const refusal of ["identity", "br;q=0, gzip;q=0", "br;q=0.0, gzip;q=0.000", "*"]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is asserted on its own
      const refused = await fetchVersion(server, at(scriptPath), "GET", {"Accept-Encoding": refusal});
      expect({
        acceptRanges: refused.headers.get("accept-ranges"),
        contentEncoding: refused.headers.get("content-encoding"),
        refusal,
      }).toEqual({acceptRanges: "bytes", contentEncoding: null, refusal});
    }

    const spelled = await fetchVersion(server, at(scriptPath), "GET", {"Accept-Encoding": " GZIP "});
    expect(spelled.headers.get("content-encoding")).toBe("gzip");

    const binary = await fetchVersion(server, at("assets/blob.bin"), "GET", {"Accept-Encoding": "gzip"});
    expect(binary.headers.get("content-encoding")).toBeNull();
    expect(binary.headers.get("accept-ranges")).toBe("bytes");
    expect(binary.headers.get("vary")).toBeNull();
    expect(new Uint8Array(await binary.arrayBuffer())).toEqual(binaryBytes);

    const threshold = await fetchVersion(server, at("assets/threshold.js"), "GET", {"Accept-Encoding": "gzip"});
    expect(threshold.headers.get("content-encoding")).toBe("gzip");
    const below = await fetchVersion(server, at("assets/below.js"), "GET", {"Accept-Encoding": "gzip"});
    expect(below.headers.get("content-encoding")).toBeNull();
    expect(below.headers.get("accept-ranges")).toBe("bytes");

    // A cache holding the identity copy revalidates with a strong tag while accepting gzip.
    const identityRevalidation = await fetchVersion(server, at(scriptPath), "GET", {
      "Accept-Encoding": "gzip",
      "If-None-Match": `"${scriptDigest}"`,
    });
    expect(identityRevalidation.status).toBe(304);
    expect(identityRevalidation.headers.get("content-encoding")).toBeNull();
  }, 60_000);

  test("foundation: a client that disconnects after the first encoded chunk stops the storage read", async () => {
    const published = await publishSite("account_required", "disconnect-cancels-read", [
      {bytes: largeBytes, mediaType: "text/javascript", path: largeEntryPath},
    ]);
    const url = new URL(largeEntryPath, await issuePreviewLease(published)).toString();
    blobBytesRead = 0;
    blobStreamsClosed = 0;
    const outcome = await streamVersion(server, url, "gzip", true);
    expect(outcome.coding).toBe("gzip");
    const read = await settled(() => blobBytesRead, 300, 10_000);
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(disconnectReadBound);
    // The abandoned read was cancelled, not left holding its file handle.
    expect(blobStreamsClosed).toBe(1);

    const healthy = await fetchVersion(server, new URL(`/${scriptPath}`, url).toString());
    expect(healthy.status).toBe(200);
  }, 120_000);

  test("foundation: twenty concurrent encoded reads of a 64 MiB entry stay within the memory bound", async () => {
    const published = await publishSite("account_required", "concurrent-memory", [
      {bytes: largeBytes, mediaType: "text/javascript", path: largeEntryPath},
    ]);
    const url = new URL(largeEntryPath, await issuePreviewLease(published)).toString();
    const baseline = trackedMemory();
    let peak = baseline;
    const sampler = setInterval(() => {
      peak = Math.max(peak, trackedMemory());
    }, 25);
    try {
      const outcomes = await Promise.all(Array.from({length: 20}, () => streamVersion(server, url, "gzip", false)));
      for (const outcome of outcomes) {
        expect(outcome.coding).toBe("gzip");
        expect(outcome.bytes).toBeGreaterThan(0);
      }
    } finally {
      clearInterval(sampler);
    }
    expect(peak - baseline).toBeLessThan(concurrentReadMemoryBound);
  }, 180_000);
});
