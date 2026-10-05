import {createHash} from "node:crypto";
import {readdir, unlink} from "node:fs/promises";
import path from "node:path";
import {brotliDecompressSync} from "node:zlib";

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
const belowThresholdBytes = encoder.encode("x".repeat(1023));

const leaseResponseSchema = z.object({baseUrl: z.url()});
const bootstrapResponseSchema = z.object({bootstrapUrl: z.url()});

function decodeBrotli(bytes: ArrayBuffer): Uint8Array {
  return new Uint8Array(brotliDecompressSync(Buffer.from(bytes)));
}

function siteFiles(extra: readonly TestSiteFile[] = []): readonly TestSiteFile[] {
  return [
    {bytes: encoder.encode("<!doctype html><title>Compression</title>"), mediaType: "text/html; charset=utf-8", path: "index.html"},
    {bytes: scriptBytes, mediaType: "text/javascript; charset=utf-8", path: scriptPath},
    ...extra,
  ];
}

describe("stored content variants", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let blobBytesRead = 0;

  beforeEach(async () => {
    installation = await createTestInstallation();
    blobBytesRead = 0;
    server = await startTestServer(installation, {
      blobReadObserver: {
        bytesRead: (byteLength) => {
          blobBytesRead += byteLength;
        },
        streamClosed: () => undefined,
      },
      contentVariantBuilds: "manual",
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
      name: `Variants ${idempotencyKey}`,
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

  test("CNT-010-B: eligible content is identity before its variant exists and stored br afterwards", async () => {
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
      // eslint-disable-next-line no-await-in-loop -- the miss must precede the drain
      const miss = await fetchVersion(server, target.url, "GET", {...base, "Accept-Encoding": "br"});
      expect(miss.status).toBe(200);
      expect(miss.headers.get("content-encoding")).toBeNull();
      expect(miss.headers.get("accept-ranges")).toBe("bytes");
      expect(miss.headers.get("etag")).toBe(`"${scriptDigest}"`);
      expect(miss.headers.get("vary")).toContain("Accept-Encoding");
      // eslint-disable-next-line no-await-in-loop -- the body belongs to this response
      expect(new Uint8Array(await miss.arrayBuffer())).toEqual(scriptBytes);
    }
    await server.drainContentVariants();
    for (const target of targets) {
      const base: Record<string, string> = target.cookie === null ? {} : {Cookie: target.cookie};
      // eslint-disable-next-line no-await-in-loop -- each request is asserted on its own
      const hit = await fetchVersion(server, target.url, "GET", {...base, "Accept-Encoding": "gzip, br"});
      expect(hit.status).toBe(200);
      expect(hit.headers.get("content-encoding")).toBe("br");
      expect(hit.headers.get("accept-ranges")).toBeNull();
      expect(hit.headers.get("etag")).toBe(`W/"${scriptDigest}"`);
      expect(hit.headers.get("vary")).toContain("Accept-Encoding");
      // eslint-disable-next-line no-await-in-loop -- the body belongs to this response
      const body = await hit.arrayBuffer();
      expect(hit.headers.get("content-length")).toBe(String(body.byteLength));
      expect(decodeBrotli(body)).toEqual(scriptBytes);

      // eslint-disable-next-line no-await-in-loop -- HEAD mirrors the GET just made
      const head = await fetchVersion(server, target.url, "HEAD", {...base, "Accept-Encoding": "br"});
      expect(head.headers.get("content-encoding")).toBe("br");
      expect(head.headers.get("content-length")).toBe(String(body.byteLength));
      expect(head.headers.get("etag")).toBe(`W/"${scriptDigest}"`);

      // eslint-disable-next-line no-await-in-loop -- revalidation follows the reads
      const revalidated = await fetchVersion(server, target.url, "GET", {
        ...base,
        "Accept-Encoding": "br",
        "If-None-Match": `W/"${scriptDigest}"`,
      });
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get("etag")).toBe(`W/"${scriptDigest}"`);
      expect(revalidated.headers.get("content-encoding")).toBeNull();
    }
  }, 60_000);

  test("CNT-010-F: ranges, refusals, small, binary, and unusable variants are served identity", async () => {
    const published = await publishSite("account_required", "cnt-010-f-identity-fallbacks", [
      {bytes: binaryBytes, mediaType: "application/octet-stream", path: "assets/blob.bin"},
      {bytes: belowThresholdBytes, mediaType: "text/javascript", path: "assets/below.js"},
    ]);
    const lease = await issuePreviewLease(published);
    const at = (entryPath: string) => new URL(entryPath, lease).toString();
    const size = scriptBytes.byteLength;
    await fetchVersion(server, at(scriptPath), "GET", {"Accept-Encoding": "br"});
    await server.drainContentVariants();

    const partial = await fetchVersion(server, at(scriptPath), "GET", {"Accept-Encoding": "br", Range: "bytes=0-9"});
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-encoding")).toBeNull();
    expect(partial.headers.get("content-range")).toBe(`bytes 0-9/${size}`);

    const weakIfRange = await fetchVersion(server, at(scriptPath), "GET", {
      "Accept-Encoding": "br",
      "If-Range": `W/"${scriptDigest}"`,
      Range: "bytes=0-9",
    });
    expect(weakIfRange.status).toBe(200);
    expect(weakIfRange.headers.get("content-encoding")).toBeNull();
    expect(new Uint8Array(await weakIfRange.arrayBuffer())).toEqual(scriptBytes);

    for (const refusal of ["gzip", "identity", "br;q=0, gzip", "br;q=0.0", "*"]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is asserted on its own
      const refused = await fetchVersion(server, at(scriptPath), "GET", {"Accept-Encoding": refusal});
      expect({
        acceptRanges: refused.headers.get("accept-ranges"),
        contentEncoding: refused.headers.get("content-encoding"),
        refusal,
      }).toEqual({acceptRanges: "bytes", contentEncoding: null, refusal});
    }

    const identityRevalidation = await fetchVersion(server, at(scriptPath), "GET", {
      "Accept-Encoding": "br",
      "If-None-Match": `"${scriptDigest}"`,
    });
    expect(identityRevalidation.status).toBe(304);
    expect(identityRevalidation.headers.get("etag")).toBe(`"${scriptDigest}"`);
    expect(identityRevalidation.headers.get("content-encoding")).toBeNull();

    for (const entryPath of ["assets/blob.bin", "assets/below.js"]) {
      // eslint-disable-next-line no-await-in-loop -- read once to queue, then confirm nothing was stored
      await fetchVersion(server, at(entryPath), "GET", {"Accept-Encoding": "br"});
    }
    await server.drainContentVariants();
    for (const entryPath of ["assets/blob.bin", "assets/below.js"]) {
      // eslint-disable-next-line no-await-in-loop -- each entry is asserted on its own
      const ineligible = await fetchVersion(server, at(entryPath), "GET", {"Accept-Encoding": "br"});
      expect(ineligible.headers.get("content-encoding")).toBeNull();
      expect(ineligible.headers.get("accept-ranges")).toBe("bytes");
    }

    const hit = await fetchVersion(server, at(scriptPath), "GET", {"Accept-Encoding": "br"});
    const variantBytes = new Uint8Array(await hit.arrayBuffer());
    const variantDigest = createHash("sha256").update(variantBytes).digest("hex");
    const blobRoot = path.join(installation.dataDirectory, "blobs");
    const variantPath = path.join(blobRoot, variantDigest.slice(0, 2), variantDigest);
    expect(await readdir(path.dirname(variantPath))).toContain(variantDigest);
    await unlink(variantPath);
    const unusable = await fetchVersion(server, at(scriptPath), "GET", {"Accept-Encoding": "br"});
    expect(unusable.status).toBe(200);
    expect(unusable.headers.get("content-encoding")).toBeNull();
    expect(new Uint8Array(await unusable.arrayBuffer())).toEqual(scriptBytes);
    await server.drainContentVariants();
    expect(await readdir(path.dirname(variantPath))).toContain(variantDigest);
  }, 60_000);
});
