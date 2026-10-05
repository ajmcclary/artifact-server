import {afterEach, beforeEach, describe, expect, test} from "vitest";

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

  test("foundation: the blob read observer counts a full identity read", async () => {
    const published = await publishSite("public_link", "observer-full-read");
    const response = await fetchVersion(server, new URL(scriptPath, published.links.version).toString());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(blobBytesRead).toBe(scriptBytes.byteLength);
  });
});
