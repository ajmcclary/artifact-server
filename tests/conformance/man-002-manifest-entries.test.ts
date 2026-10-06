import {createHash} from "node:crypto";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  commitStagedUpload,
  createStagedUpload,
  requireSuccessfulUploads,
  type TestSiteFile,
  uploadEveryStagedFile,
  uploadStagedFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const manifestEntrySchema = z.object({
  disposition: z.enum(["attachment", "inline"]),
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: z.number(),
}).strict();
const versionResponseSchema = z.object({
  manifest: z.object({
    digest: z.string(),
    entries: z.array(manifestEntrySchema),
    entryPath: z.string(),
    routingMode: z.enum(["spa", "static"]),
  }).strict(),
});
const errorResponseSchema = z.object({
  error: z.object({code: z.string()}),
});

interface UploadDeclaration {
  readonly entryPath: string;
  readonly files: readonly {
    readonly mediaType: string;
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
  }[];
}

interface RepresentativeFile extends TestSiteFile {
  readonly disposition: "attachment" | "inline";
}

/** Files that span text, binary, empty, nested, non-ASCII, and download-only content. */
const representativeFiles: readonly RepresentativeFile[] = [
  {
    bytes: utf8("<!doctype html><title>Entry</title>"),
    disposition: "inline",
    mediaType: "text/html; charset=utf-8",
    path: "index.html",
  },
  {
    bytes: utf8("export const ready = true;"),
    disposition: "inline",
    mediaType: "text/javascript; charset=utf-8",
    path: "assets/js/app.js",
  },
  {
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]),
    disposition: "inline",
    mediaType: "image/png",
    path: "assets/mark.png",
  },
  {
    bytes: new Uint8Array(0),
    disposition: "inline",
    mediaType: "text/plain",
    path: "empty.txt",
  },
  {
    bytes: utf8("%PDF-1.7\n%%EOF\n"),
    disposition: "inline",
    mediaType: "application/pdf",
    path: "docs/résumé.pdf",
  },
  {
    bytes: utf8('{"valid":true}'),
    disposition: "inline",
    mediaType: "application/json",
    path: "data/values.json",
  },
  {
    bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]),
    disposition: "attachment",
    mediaType: "application/zip",
    path: "downloads/archive.zip",
  },
  {
    bytes: utf8("<script>not executable here</script>"),
    disposition: "attachment",
    mediaType: "application/octet-stream",
    path: "downloads/misleading.html",
  },
];

describe("MAN-002 manifest file entries", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("MAN-002-B: every committed entry records the exact path, byte length, media type, SHA-256, and disposition of the bytes it serves", async () => {
    const published = await publish(representativeFiles, "index.html", "man-002-b-publication");
    const manifest = await readManifest(published.artifactId, published.versionId);

    expect(manifest.entries).toHaveLength(representativeFiles.length);
    for (const file of representativeFiles) {
      const entry = manifest.entries.find((candidate) => candidate.path === file.path);
      expect(entry).toEqual({
        disposition: file.disposition,
        mediaType: file.mediaType,
        path: file.path,
        sha256: sha256(file.bytes),
        size: file.bytes.byteLength,
      });
    }

    await Promise.all(manifest.entries.map(async (entry) => {
      // Each served response is checked against its own manifest entry.
      const response = await fetchVersion(
        server,
        new URL(
          `/${entry.path.split("/").map(encodeURIComponent).join("/")}`,
          published.versionUrl,
        ).toString(),
      );
      const served = new Uint8Array(await response.arrayBuffer());
      expect(response.status).toBe(200);
      expect(served.byteLength).toBe(entry.size);
      expect(sha256(served)).toBe(entry.sha256);
      expect(response.headers.get("content-length")).toBe(String(entry.size));
      expect(response.headers.get("content-type")).toBe(entry.mediaType);
      expect(response.headers.get("content-disposition")).toBe(entry.disposition);
      expect(response.headers.get("etag")).toBe(`"${entry.sha256}"`);
    }));
  });

  test("MAN-002-F: a claimed size or fingerprint that differs from the uploaded or stored bytes is rejected", async () => {
    const actual = utf8("<!doctype html><title>Actual bytes</title>");
    const dishonestClaims: readonly {readonly name: string; readonly sha256: string; readonly size: number}[] = [
      {name: "size too large", sha256: sha256(actual), size: actual.byteLength + 1},
      {name: "size too small", sha256: sha256(actual), size: actual.byteLength - 1},
      {name: "zero size", sha256: sha256(actual), size: 0},
      {name: "fingerprint of other bytes", sha256: sha256(utf8("other bytes")), size: actual.byteLength},
      {name: "fingerprint off by one digit", sha256: flipLastHexDigit(sha256(actual)), size: actual.byteLength},
    ];

    for (const claim of dishonestClaims) {
      // Each claim gets its own upload so one rejection cannot mask another.
      // eslint-disable-next-line no-await-in-loop
      const planned = await postDeclaration({
        entryPath: "index.html",
        files: [{mediaType: "text/html", path: "index.html", sha256: claim.sha256, size: claim.size}],
      });
      const slot = planned.files[0];
      if (slot === undefined) throw new Error(`The ${claim.name} plan has no upload slot.`);
      // eslint-disable-next-line no-await-in-loop
      const upload = await uploadStagedFile(installation, slot, actual);
      expect({name: claim.name, status: upload.status}).toEqual({name: claim.name, status: 422});
      // eslint-disable-next-line no-await-in-loop
      expect(errorResponseSchema.parse(await upload.json()).error.code).toBe("INVALID_INPUT");

      // eslint-disable-next-line no-await-in-loop
      const commit = await fetch(planned.commitUrl, {
        body: JSON.stringify({
          target: {accessSetting: "public_link", kind: "new_artifact", name: "Must not commit"},
        }),
        headers: {
          Authorization: `Bearer ${installation.apiToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `man-002-f-${claim.name.replaceAll(" ", "-")}`,
        },
        method: "POST",
      });
      expect({name: claim.name, status: commit.status}).toEqual({name: claim.name, status: 409});
      // eslint-disable-next-line no-await-in-loop
      expect(errorResponseSchema.parse(await commit.json()).error.code).toBe("UPLOAD_INCOMPLETE");
    }

    // An honest claim for the same bytes still commits and records the true values.
    const honest = [
      {bytes: actual, mediaType: "text/html", path: "index.html"},
      {bytes: utf8("asset"), mediaType: "text/plain", path: "asset.txt"},
    ] satisfies readonly TestSiteFile[];
    const published = await publish(honest, "index.html", "man-002-f-honest-publication");
    const manifest = await readManifest(published.artifactId, published.versionId);
    const original = manifest.entries.find((entry) => entry.path === "asset.txt");
    expect(original).toMatchObject({sha256: sha256(utf8("asset")), size: 5});
    if (original === undefined) throw new Error("The honest manifest omits asset.txt.");

    // Stored claims that no longer match the committed manifest are never served.
    const storedTampering = [
      {column: "size", value: original.size + 1},
      {column: "sha256", value: sha256(utf8("forged"))},
    ] as const;
    for (const tampering of storedTampering) {
      // eslint-disable-next-line no-await-in-loop
      await server.stop();
      withDatabase((database) => database
        .prepare(`UPDATE manifest_entries SET ${tampering.column} = ? WHERE version_id = ? AND path = 'asset.txt'`)
        .run(tampering.value, published.versionId));
      // eslint-disable-next-line no-await-in-loop
      server = await startTestServer(installation);

      // eslint-disable-next-line no-await-in-loop
      const refused = await readManifestResponse(published.artifactId, published.versionId);
      expect({column: tampering.column, status: refused.status})
        .toEqual({column: tampering.column, status: 500});
      // eslint-disable-next-line no-await-in-loop
      const refusedBody: unknown = await refused.json();
      expect(refusedBody).not.toHaveProperty("manifest");

      // eslint-disable-next-line no-await-in-loop
      const content = await fetchVersion(
        server,
        new URL("/asset.txt", published.versionUrl).toString(),
      );
      // eslint-disable-next-line no-await-in-loop
      const contentBody = Buffer.from(await content.arrayBuffer()).toString("utf8");
      expect({column: tampering.column, status: content.status})
        .not.toEqual({column: tampering.column, status: 200});
      expect(contentBody).not.toBe("asset");

      // eslint-disable-next-line no-await-in-loop
      await server.stop();
      withDatabase((database) => database
        .prepare(`UPDATE manifest_entries SET ${tampering.column} = ? WHERE version_id = ? AND path = 'asset.txt'`)
        .run(original[tampering.column], published.versionId));
      // eslint-disable-next-line no-await-in-loop
      server = await startTestServer(installation);
      // eslint-disable-next-line no-await-in-loop
      expect(await readManifest(published.artifactId, published.versionId)).toEqual(manifest);
    }
  });

  async function publish(
    files: readonly TestSiteFile[],
    entryPath: string,
    idempotencyKey: string,
  ): Promise<{readonly artifactId: string; readonly versionId: string; readonly versionUrl: string}> {
    const planned = await createStagedUpload(server, installation, entryPath, files);
    expect(planned.response.status).toBe(201);
    await requireSuccessfulUploads(uploadEveryStagedFile(installation, planned.body, files));
    const committed = await commitStagedUpload(
      installation,
      planned.body,
      idempotencyKey,
      {accessSetting: "public_link", kind: "new_artifact", name: "Manifest entries"},
    );
    expect(committed.response.status).toBe(201);
    return {
      artifactId: committed.body.artifact.id,
      versionId: committed.body.version.id,
      versionUrl: committed.body.links.version,
    };
  }

  async function postDeclaration(declaration: UploadDeclaration): Promise<{
    readonly commitUrl: string;
    readonly files: readonly {
      readonly method: "PUT";
      readonly path: string;
      readonly size: number;
      readonly uploadUrl: string;
      readonly verified: boolean;
    }[];
  }> {
    const response = await fetch(`${server.baseUrl}/api/v1/uploads`, {
      body: JSON.stringify(declaration),
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(response.status).toBe(201);
    return z.object({
      commitUrl: z.url(),
      files: z.array(z.object({
        method: z.literal("PUT"),
        path: z.string(),
        size: z.number(),
        uploadUrl: z.url(),
        verified: z.boolean(),
      })),
    }).parse(await response.json());
  }

  async function readManifestResponse(artifactId: string, versionId: string): Promise<Response> {
    return fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}/versions/${versionId}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
  }

  async function readManifest(
    artifactId: string,
    versionId: string,
  ): Promise<z.infer<typeof versionResponseSchema>["manifest"]> {
    const response = await readManifestResponse(artifactId, versionId);
    expect(response.status).toBe(200);
    return versionResponseSchema.parse(await response.json()).manifest;
  }

  function withDatabase(operation: (database: DatabaseSync) => void): void {
    const database = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
    );
    try {
      operation(database);
    } finally {
      database.close();
    }
  }
});

function flipLastHexDigit(digest: string): string {
  const last = digest.at(-1);
  return `${digest.slice(0, -1)}${last === "0" ? "1" : "0"}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
