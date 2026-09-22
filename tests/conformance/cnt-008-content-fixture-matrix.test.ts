import {createHash} from "node:crypto";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  commitStagedUpload,
  createStagedUpload,
  uploadEveryStagedFile,
  type TestSiteFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("content fixture headers, ranges, and safe serving", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let contentOrigin: string;
  let files: readonly TestSiteFile[];

  const fixture = (): readonly TestSiteFile[] => [
    {
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      mediaType: "image/png",
      path: "image.png",
    },
    {bytes: utf8("%PDF-1.7\n"), mediaType: "application/pdf", path: "report.pdf"},
    {
      bytes: utf8("plain text"),
      mediaType: "text/plain; charset=utf-8",
      path: "notes.txt",
    },
    {
      bytes: utf8('{"valid":true}'),
      mediaType: "application/json",
      path: "data.json",
    },
    {
      bytes: utf8("not executable"),
      mediaType: "application/octet-stream",
      path: "misleading.html",
    },
    {
      bytes: utf8("opaque unknown bytes"),
      mediaType: "application/octet-stream",
      path: "LICENSE",
    },
  ];

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    files = fixture();
    const planned = await createStagedUpload(
      server,
      installation,
      "notes.txt",
      files,
    );
    await Promise.all((await uploadEveryStagedFile(
      installation,
      planned.body,
      files,
    )).map((response) => response.arrayBuffer()));
    const published = await commitStagedUpload(
      installation,
      planned.body,
      "content-fixture-matrix",
      {accessSetting: "public_link", kind: "new_artifact", name: "Content fixture"},
    );
    contentOrigin = published.body.links.version;
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("CNT-008-B: every fixture response carries explicit type, nosniff, stable ETag, safe disposition, conditional and range semantics", async () => {
    expect.hasAssertions();
    const inlinePaths = new Set(["image.png", "report.pdf", "notes.txt", "data.json"]);
    await Promise.all(files.map(async (file) => {
      const url = new URL(`/${file.path}`, contentOrigin).toString();
      const response = await fetchVersion(server, url);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(file.mediaType);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("etag")).toBe(`"${sha256(file.bytes)}"`);
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(response.headers.get("content-disposition")).toBe(
        inlinePaths.has(file.path) ? "inline" : "attachment",
      );
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(file.bytes);

      const revalidated = await fetchVersion(server, url, "GET", {
        "If-None-Match": `"${sha256(file.bytes)}"`,
      });
      expect(revalidated.status).toBe(304);

      const head = await fetchVersion(server, url, "HEAD");
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(
        String(file.bytes.byteLength),
      );
      expect(await head.text()).toBe("");
    }));

    // A bounded byte range is served with the exact bytes and never compressed.
    const imageUrl = new URL("/image.png", contentOrigin).toString();
    const range = await fetchVersion(server, imageUrl, "GET", {
      Range: "bytes=2-5",
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 2-5/8");
    expect(range.headers.get("content-encoding")).toBeNull();
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(
      new Uint8Array([0x4e, 0x47, 0x0d, 0x0a]),
    );
  });

  test("CNT-008-F: unsupported methods, malformed ranges, misleading extensions, and unknown files never bypass safe serving", async () => {
    expect.hasAssertions();
    const target = new URL("/image.png", contentOrigin).toString();
    await Promise.all(
      ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"].map(async (method) => {
        const response = await fetchVersion(server, target, method);
        expect(response.status).toBe(405);
        expect(response.headers.get("allow")).toBe("GET, HEAD");
      }),
    );

    const malformedRanges = [
      "bytes=20-30",
      "bytes=5-3",
      "bytes=0-1,4-5",
      "items=0-1",
    ];
    await Promise.all(malformedRanges.map(async (range) => {
      const response = await fetchVersion(server, target, "GET", {Range: range});
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */8");
    }));

    // A misleading extension is served by its declared media type, never
    // sniffed; an extensionless unknown file downloads the same way.
    await Promise.all(["misleading.html", "LICENSE"].map(async (path) => {
      const response = await fetchVersion(
        server,
        new URL(`/${path}`, contentOrigin).toString(),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(response.headers.get("content-disposition")).toBe("attachment");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }));
  });
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
