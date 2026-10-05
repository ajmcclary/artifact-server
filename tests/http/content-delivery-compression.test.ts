import {createHash} from "node:crypto";
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

const leaseResponseSchema = z.object({baseUrl: z.url()});
const bootstrapResponseSchema = z.object({bootstrapUrl: z.url()});

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

  beforeEach(async () => {
    installation = await createTestInstallation();
    blobBytesRead = 0;
    server = await startTestServer(installation, {
      blobReadObserver: {bytesRead: (byteLength) => {
        blobBytesRead += byteLength;
      }},
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
});
