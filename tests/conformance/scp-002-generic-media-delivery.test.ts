import {createHash} from "node:crypto";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  commitStagedUpload,
  createStagedUpload,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {childProcessIds, listTree} from "../support/server-activity.js";

const encoder = new TextEncoder();

function bytes(...parts: readonly Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts));
}

const text = (value: string): Uint8Array => encoder.encode(value);
const raw = (...values: readonly number[]): Uint8Array => Uint8Array.from(values);

/** Small files whose leading bytes identify them as the named format. */
const mediaFiles: readonly TestSiteFile[] = [
  {bytes: encoder.encode("<!doctype html><title>Media</title>"), mediaType: "text/html; charset=utf-8", path: "index.html"},
  {bytes: bytes(raw(0x89), text("PNG\r\n"), raw(0x1a, 0x0a), text("image body")), mediaType: "image/png", path: "photo.png"},
  {bytes: bytes(raw(0, 0, 0, 0x18), text("ftypmp42"), text("video body")), mediaType: "video/mp4", path: "clip.mp4"},
  {bytes: bytes(text("ID3"), raw(3, 0, 0), text("audio body")), mediaType: "audio/mpeg", path: "voice.mp3"},
  {bytes: bytes(text("%PDF-1.7\n"), text("document body\n%%EOF\n")), mediaType: "application/pdf", path: "report.pdf"},
  {bytes: bytes(text("# Notes\n\n*Not rendered.*\n")), mediaType: "text/markdown", path: "notes.md"},
  {bytes: bytes(text("PK"), raw(3, 4), text("inner.html <!doctype html>")), mediaType: "application/zip", path: "bundle.zip"},
  {
    bytes: bytes(text("PK"), raw(3, 4), text("word/document.xml")),
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    path: "memo.docx",
  },
];

/** Files a browser presents itself; everything else is a download. */
const browserPresented = new Set(["index.html", "photo.png", "clip.mp4", "voice.mp3", "report.pdf", "notes.md"]);

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("media and documents use generic content delivery only", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation, {contentVariantBuilds: "manual"});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function publishMedia(key: string) {
    const upload = await createStagedUpload(server, installation, "index.html", mediaFiles);
    await uploadEveryStagedFile(installation, upload.body, mediaFiles);
    const committed = await commitStagedUpload(installation, upload.body, key, {
      accessSetting: "public_link",
      kind: "new_artifact",
      name: "Media",
      tags: [],
    });
    expect(committed.response.status).toBe(201);
    return committed.body;
  }

  test("SCP-002-B: browser-supported media opens directly and other files download, all as the exact published bytes", async () => {
    const published = await publishMedia("scp-002-media-delivery");
    const delivered = await Promise.all(mediaFiles.map(async (entry) => {
      const response = await fetchVersion(
        server,
        new URL(entry.path, published.links.version).toString(),
      );
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get("content-type"),
        disposition: response.headers.get("content-disposition")?.split(";", 1)[0] ?? null,
        noSniff: response.headers.get("x-content-type-options"),
        path: entry.path,
        status: response.status,
      };
    }));
    expect(delivered).toEqual(mediaFiles.map((entry) => ({
      bytes: entry.bytes,
      contentType: entry.mediaType,
      disposition: browserPresented.has(entry.path) ? "inline" : "attachment",
      noSniff: "nosniff",
      path: entry.path,
      status: 200,
    })));
  });

  test("SCP-002-F: uploading documents, archives, images, audio, and video queues no conversion, extraction, analysis, rendering, or preview work", async () => {
    const childrenBefore = await childProcessIds();
    const published = await publishMedia("scp-002-media-no-processing");
    // Run every piece of work a publish can queue.
    const variants = await server.buildContentVariants(1_000);
    expect(variants).toMatchObject({built: 0, failed: 0});

    // The version holds exactly the uploaded files; nothing was extracted
    // from an archive or derived from a document or media file.
    const version = z.object({
      manifest: z.object({entries: z.array(z.object({path: z.string()}).loose())}).loose(),
    }).loose().parse(await (await fetch(
      new URL(`/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}`, server.baseUrl),
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    )).json());
    expect(version.manifest.entries.map((entry) => entry.path).toSorted())
      .toEqual(mediaFiles.map((entry) => entry.path).toSorted());
    const archiveMember = await fetchVersion(
      server,
      new URL("inner.html", published.links.version).toString(),
    );
    expect(archiveMember.status).toBe(404);
    await archiveMember.arrayBuffer();

    // Stored blobs are exactly the uploaded bytes: no thumbnail, poster,
    // transcode, rendering, or extracted member was written, and no helper
    // process ran.
    const blobs = (await listTree(installation.dataDirectory))
      .filter((entry) => /^blobs\/[0-9a-f]{2}\/[0-9a-f]{64}$/u.test(entry))
      .map((entry) => entry.slice(entry.lastIndexOf("/") + 1));
    expect(blobs.toSorted()).toEqual(mediaFiles.map((entry) => sha256(entry.bytes)).toSorted());
    expect((await listTree(installation.dataDirectory))
      .filter((entry) => !/^(?:artifact-server\.db(?:-shm|-wal)?|blobs(?:\/.*)?|staging(?:\/.*)?)$/u.test(entry)))
      .toEqual([]);
    expect(await childProcessIds()).toEqual(childrenBefore);
  });
});
