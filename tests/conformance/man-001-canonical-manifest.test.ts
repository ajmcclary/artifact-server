import {createHash, randomUUID} from "node:crypto";
import {mkdir, mkdtemp, rm, utimes, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  type FilePublicationResult,
  publishPath,
} from "../../src/client/file-publication-client.js";
import {
  commitStagedUpload,
  createStagedUpload,
  requireSuccessfulUploads,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
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
const manifestSchema = z.object({
  digest: z.string(),
  entries: z.array(manifestEntrySchema),
  entryPath: z.string(),
  routingMode: z.enum(["spa", "static"]),
}).strict();
const versionResponseSchema = z.object({
  manifest: manifestSchema,
  version: z.object({id: z.string(), manifestDigest: z.string()}),
});
const errorResponseSchema = z.object({
  error: z.object({code: z.string()}),
});

type CanonicalManifestView = z.infer<typeof manifestSchema>;

/**
 * The directory tree published twice. Walk order and canonical order differ:
 * a depth-first walk visits `assets/z.js` before `assets-extra.css`, while the
 * canonical order places `-` (U+002D) before `/` (U+002F).
 */
const directoryFiles: readonly {readonly content: string; readonly path: string}[] = [
  {content: "<!doctype html><title>Home</title>", path: "index.html"},
  {content: "body { color: black; }", path: "assets-extra.css"},
  {content: "export const z = 26;", path: "assets/z.js"},
  {content: "export const a = 1;", path: "assets/a.js"},
  {content: "Uppercase sorts first.", path: "B.txt"},
  {content: "Lowercase sorts later.", path: "a.txt"},
  {content: "Accented names sort by code unit.", path: "été.txt"},
  {content: "", path: "docs/empty.txt"},
  {content: "%PDF-1.4\n%%EOF\n", path: "docs/report.pdf"},
];

describe("MAN-001 canonical manifest", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let fixtureDirectory: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    fixtureDirectory = await mkdtemp(path.join(tmpdir(), "artifact-server-man-001-"));
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await Promise.all([
      removeTestInstallation(installation),
      rm(fixtureDirectory, {force: true, recursive: true}),
    ]);
  });

  test("MAN-001-B: equivalent directory walks and declaration orders yield identical canonical manifest bytes and digest", async () => {
    const firstDirectory = path.join(fixtureDirectory, "first");
    const secondDirectory = path.join(fixtureDirectory, "second");
    await writeDirectory(firstDirectory, directoryFiles, new Date("2020-01-01T00:00:00Z"));
    await writeDirectory(
      secondDirectory,
      directoryFiles.toReversed(),
      new Date("2024-06-15T12:30:00Z"),
    );

    const first = await publishDirectory(firstDirectory);
    const second = await publishDirectory(secondDirectory);
    expect(second.artifact.id).not.toBe(first.artifact.id);

    const firstManifest = await readManifest(first.artifact.id, first.version.id);
    const secondManifest = await readManifest(second.artifact.id, second.version.id);
    const firstBytes = canonicalManifestBytes(firstManifest);
    const secondBytes = canonicalManifestBytes(secondManifest);

    // Identical canonical bytes and digest from two independently walked trees.
    expect(secondBytes).toBe(firstBytes);
    expect(secondManifest).toEqual(firstManifest);
    expect(sha256(firstBytes)).toBe(firstManifest.digest);
    expect(first.version.manifestDigest).toBe(firstManifest.digest);
    expect(second.version.manifestDigest).toBe(firstManifest.digest);

    // The canonical list is sorted by normalized path, independent of walk order.
    const canonicalPaths = directoryFiles.map((file) => file.path).toSorted();
    expect(firstManifest.entries.map((entry) => entry.path)).toEqual(canonicalPaths);
    expect(canonicalPaths).not.toEqual(depthFirstWalkOrder(directoryFiles));
    expect(firstManifest.entryPath).toBe("index.html");
    expect(firstManifest.routingMode).toBe("static");
    for (const file of directoryFiles) {
      const entry = firstManifest.entries.find((candidate) => candidate.path === file.path);
      const bytes = new TextEncoder().encode(file.content);
      expect(entry).toMatchObject({sha256: sha256(bytes), size: bytes.byteLength});
    }

    // Every permutation of the same declaration produces the same manifest digest.
    const declared = directoryFiles.map((file): TestSiteFile => {
      const entry = firstManifest.entries.find((candidate) => candidate.path === file.path);
      if (entry === undefined) throw new Error(`The manifest omits ${file.path}.`);
      return {
        bytes: new TextEncoder().encode(file.content),
        mediaType: entry.mediaType,
        path: file.path,
      };
    });
    const permutations = [
      declared,
      declared.toReversed(),
      declared.toSorted((left, right) => left.bytes.byteLength - right.bytes.byteLength),
      [...declared.slice(4), ...declared.slice(0, 4)],
    ];
    const plannedDigests = await Promise.all(permutations.map(async (files) => {
      const planned = await createStagedUpload(server, installation, "index.html", files);
      expect(planned.response.status).toBe(201);
      expect(planned.body.files.map((file) => file.path)).toEqual(canonicalPaths);
      return planned.body.manifestDigest;
    }));
    expect(new Set(plannedDigests)).toEqual(new Set([firstManifest.digest]));

    // The stored canonical form survives a restart byte for byte.
    await server.stop();
    server = await startTestServer(installation);
    const reloaded = await readManifest(first.artifact.id, first.version.id);
    expect(canonicalManifestBytes(reloaded)).toBe(firstBytes);
    expect(reloaded.digest).toBe(firstManifest.digest);
  });

  test("MAN-001-F: duplicate paths, missing fields, unknown fields, absent entry files, and non-canonical stored manifests are rejected", async () => {
    const bytes = new TextEncoder().encode("<!doctype html><title>Entry</title>");
    const validFile = {
      mediaType: "text/html; charset=utf-8",
      path: "index.html",
      sha256: sha256(bytes),
      size: bytes.byteLength,
    };
    const asset = {...validFile, mediaType: "text/plain", path: "notes.txt"};
    const {mediaType: _mediaType, ...withoutMediaType} = validFile;
    const {path: _path, ...withoutPath} = validFile;
    const {sha256: _sha256, ...withoutSha256} = validFile;
    const {size: _size, ...withoutSize} = validFile;
    const rejectedDeclarations: readonly {readonly name: string; readonly body: unknown}[] = [
      {name: "exact duplicate paths", body: {entryPath: "index.html", files: [validFile, validFile]}},
      {
        name: "duplicate paths with different metadata",
        body: {entryPath: "index.html", files: [validFile, {...validFile, mediaType: "text/plain"}]},
      },
      {name: "missing media type", body: {entryPath: "index.html", files: [withoutMediaType]}},
      {name: "missing path", body: {entryPath: "index.html", files: [withoutPath]}},
      {name: "missing fingerprint", body: {entryPath: "index.html", files: [withoutSha256]}},
      {name: "missing size", body: {entryPath: "index.html", files: [withoutSize]}},
      {name: "null size", body: {entryPath: "index.html", files: [{...validFile, size: null}]}},
      {name: "empty media type", body: {entryPath: "index.html", files: [{...validFile, mediaType: " "}]}},
      {name: "missing entry path", body: {files: [validFile]}},
      {name: "missing file list", body: {entryPath: "index.html"}},
      {name: "empty file list", body: {entryPath: "index.html", files: []}},
      {
        name: "client-claimed serving disposition",
        body: {entryPath: "index.html", files: [{...validFile, disposition: "inline"}]},
      },
      {
        name: "client-claimed manifest digest",
        body: {digest: "0".repeat(64), entryPath: "index.html", files: [validFile]},
      },
      {name: "absent entry file", body: {entryPath: "missing.html", files: [validFile, asset]}},
      {name: "directory as entry file", body: {entryPath: "docs", files: [{...validFile, path: "docs/index.html"}]}},
      {name: "case-variant entry file", body: {entryPath: "INDEX.html", files: [validFile]}},
      {name: "non-normalized entry file", body: {entryPath: "./index.html", files: [validFile]}},
      {name: "empty entry path", body: {entryPath: "", files: [validFile]}},
      {name: "unknown routing mode", body: {entryPath: "index.html", files: [validFile], routingMode: "dynamic"}},
    ];

    for (const declaration of rejectedDeclarations) {
      // Each request is independent so one rejection cannot mask the next.
      // eslint-disable-next-line no-await-in-loop
      const response = await postUploadDeclaration(JSON.stringify(declaration.body));
      expect({name: declaration.name, status: response.status})
        .toEqual({name: declaration.name, status: 422});
      // eslint-disable-next-line no-await-in-loop
      await response.arrayBuffer();
    }

    // The server still accepts the valid manifest after every rejection.
    const files: readonly TestSiteFile[] = [
      {bytes, mediaType: validFile.mediaType, path: "index.html"},
      {bytes: new TextEncoder().encode("first"), mediaType: "text/plain", path: "a.txt"},
      {bytes: new TextEncoder().encode("second"), mediaType: "text/plain", path: "b.txt"},
    ];
    const planned = await createStagedUpload(server, installation, "index.html", files);
    expect(planned.response.status).toBe(201);
    await requireSuccessfulUploads(uploadEveryStagedFile(installation, planned.body, files));
    const committed = await commitStagedUpload(
      installation,
      planned.body,
      "man-001-f-valid-commit",
      {accessSetting: "account_required", kind: "new_artifact", name: "Canonical"},
    );
    expect(committed.response.status).toBe(201);
    const artifactId = committed.body.artifact.id;
    const versionId = committed.body.version.id;
    const original = await readManifest(artifactId, versionId);

    // A stored digest that commits to any order other than the canonical one is refused.
    const reordered = canonicalManifestBytes({
      ...original,
      entries: original.entries.toReversed(),
    });
    expect(sha256(reordered)).not.toBe(original.digest);
    await expectTamperedVersionRefused(
      artifactId,
      versionId,
      (database) => database
        .prepare("UPDATE versions SET manifest_digest = ? WHERE id = ?")
        .run(sha256(reordered), versionId),
      (database) => database
        .prepare("UPDATE versions SET manifest_digest = ? WHERE id = ?")
        .run(original.digest, versionId),
    );

    // A stored entry path that names no file is refused.
    await expectTamperedVersionRefused(
      artifactId,
      versionId,
      (database) => database
        .prepare("UPDATE versions SET entry_path = 'missing.html' WHERE id = ?")
        .run(versionId),
      (database) => database
        .prepare("UPDATE versions SET entry_path = 'index.html' WHERE id = ?")
        .run(versionId),
    );

    // A stored manifest that loses its entry file is refused.
    await expectTamperedVersionRefused(
      artifactId,
      versionId,
      (database) => database
        .prepare("DELETE FROM manifest_entries WHERE version_id = ? AND path = 'index.html'")
        .run(versionId),
      (database) => database
        .prepare(`INSERT INTO manifest_entries (
          version_id, path, size, media_type, sha256, disposition
        ) VALUES (?, 'index.html', ?, ?, ?, 'inline')`)
        .run(versionId, validFile.size, validFile.mediaType, validFile.sha256),
    );

    // A stored portable duplicate of an existing path is refused.
    await expectTamperedVersionRefused(
      artifactId,
      versionId,
      (database) => database
        .prepare(`INSERT INTO manifest_entries (
          version_id, path, size, media_type, sha256, disposition
        ) VALUES (?, 'INDEX.html', ?, ?, ?, 'inline')`)
        .run(versionId, validFile.size, validFile.mediaType, validFile.sha256),
      (database) => database
        .prepare("DELETE FROM manifest_entries WHERE version_id = ? AND path = 'INDEX.html'")
        .run(versionId),
    );

    const restored = await readManifest(artifactId, versionId);
    expect(canonicalManifestBytes(restored)).toBe(canonicalManifestBytes(original));
  });

  async function publishDirectory(inputPath: string): Promise<FilePublicationResult> {
    const config = {
      apiToken: Redacted.make(installation.apiToken, {label: "test-api-token"}),
      serverOrigin: server.baseUrl,
    };
    return Effect.runPromise(
      publishPath(config, {
        entryPath: "index.html",
        idempotencyKey: randomUUID(),
        inputPath,
        target: {accessSetting: "account_required", kind: "new_artifact", tags: []},
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(NodeFileSystem.layer),
      ),
    );
  }

  async function readManifestResponse(
    artifactId: string,
    versionId: string,
  ): Promise<Response> {
    return fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}/versions/${versionId}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
  }

  async function readManifest(
    artifactId: string,
    versionId: string,
  ): Promise<CanonicalManifestView> {
    const response = await readManifestResponse(artifactId, versionId);
    expect(response.status).toBe(200);
    const body = versionResponseSchema.parse(await response.json());
    expect(body.version.manifestDigest).toBe(body.manifest.digest);
    return body.manifest;
  }

  /** Posts a deliberately hostile declaration exactly as serialized by the caller. */
  async function postUploadDeclaration(serializedDeclaration: string): Promise<Response> {
    return fetch(`${server.baseUrl}/api/v1/uploads`, {
      body: serializedDeclaration,
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
  }

  async function expectTamperedVersionRefused(
    artifactId: string,
    versionId: string,
    tamper: (database: DatabaseSync) => void,
    restore: (database: DatabaseSync) => void,
  ): Promise<void> {
    await server.stop();
    withDatabase(tamper);
    server = await startTestServer(installation);
    const refused = await readManifestResponse(artifactId, versionId);
    expect(refused.status).toBe(500);
    const body: unknown = await refused.json();
    expect(errorResponseSchema.parse(body).error.code).toBe("INTERNAL_ERROR");
    expect(body).not.toHaveProperty("manifest");

    await server.stop();
    withDatabase(restore);
    server = await startTestServer(installation);
    await readManifest(artifactId, versionId);
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

async function writeDirectory(
  root: string,
  files: readonly {readonly content: string; readonly path: string}[],
  modifiedAt: Date,
): Promise<void> {
  for (const file of files) {
    const absolutePath = path.join(root, ...file.path.split("/"));
    // Files are written in the given order so each tree has a distinct creation history.
    // eslint-disable-next-line no-await-in-loop
    await mkdir(path.dirname(absolutePath), {recursive: true});
    // eslint-disable-next-line no-await-in-loop
    await writeFile(absolutePath, file.content);
    // eslint-disable-next-line no-await-in-loop
    await utimes(absolutePath, modifiedAt, modifiedAt);
  }
}

/** The order a sorted depth-first directory walk visits the fixture files. */
function depthFirstWalkOrder(
  files: readonly {readonly path: string}[],
): readonly string[] {
  return files
    .map((file) => file.path)
    .toSorted((left, right) => {
      const leftSegments = left.split("/");
      const rightSegments = right.split("/");
      const length = Math.min(leftSegments.length, rightSegments.length);
      for (let index = 0; index < length; index += 1) {
        const leftSegment = leftSegments[index] ?? "";
        const rightSegment = rightSegments[index] ?? "";
        if (leftSegment !== rightSegment) return leftSegment < rightSegment ? -1 : 1;
      }
      return leftSegments.length - rightSegments.length;
    });
}

/**
 * Canonical manifest bytes: compact JSON with lexicographically ordered keys
 * and path-ordered entries, serialized independently of response key order.
 */
function canonicalManifestBytes(manifest: CanonicalManifestView): string {
  return JSON.stringify({
    entries: manifest.entries.map((entry) => ({
      disposition: entry.disposition,
      mediaType: entry.mediaType,
      path: entry.path,
      sha256: entry.sha256,
      size: entry.size,
    })),
    entryPath: manifest.entryPath,
    routingMode: manifest.routingMode,
  });
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
