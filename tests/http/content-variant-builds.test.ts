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

function script(label: string): Uint8Array {
  return encoder.encode(Array.from({length: 600}, (_, index) => `window.${label}.push({"row": ${index}});`).join("\n"));
}

async function encodingOf(running: RunningTestServer, published: PublishResponse, entryPath: string): Promise<string | null> {
  const response = await fetchVersion(
    running,
    new URL(entryPath, published.links.version).toString(),
    "GET",
    {"Accept-Encoding": "br"},
  );
  return response.headers.get("content-encoding");
}

describe("content variant builds", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;

  beforeEach(async () => {
    installation = await createTestInstallation();
  });

  afterEach(async () => {
    await server?.stop();
    server = null;
    await removeTestInstallation(installation);
  });

  async function publish(running: RunningTestServer, key: string, files: readonly TestSiteFile[]): Promise<PublishResponse> {
    const upload = await createStagedUpload(running, installation, "index.html", files);
    await uploadEveryStagedFile(installation, upload.body, files);
    const committed = await commitStagedUpload(installation, upload.body, key, {
      accessSetting: "public_link",
      kind: "new_artifact",
      name: `Builds ${key}`,
      tags: [],
    });
    expect(committed.response.status).toBe(201);
    return committed.body;
  }

  function site(label: string): readonly TestSiteFile[] {
    return [
      {bytes: encoder.encode("<!doctype html><title>Builds</title>"), mediaType: "text/html", path: "index.html"},
      {bytes: script(label), mediaType: "text/javascript", path: "app.js"},
      {bytes: script("shared"), mediaType: "text/javascript", path: "shared.js"},
    ];
  }


  test("CNT-011-B: publishing builds variants, the backfill counts each digest once, and mappings survive restart", async () => {
    const background = await startTestServer(installation, {contentVariantBuilds: "background"});
    server = background;
    const first = await publish(background, "cnt-011-b-background-site", site("first"));
    // Wait for the publish-queued builds without reading: a read miss would queue them too.
    await background.drainContentVariants();
    await background.stop();
    server = null;

    // A first read on a restarted server hits only if publishing built and recorded the variant.
    const manual = await startTestServer(installation, {contentVariantBuilds: "manual"});
    server = manual;
    expect(await encodingOf(manual, first, "app.js")).toBe("br");
    expect(await encodingOf(manual, first, "shared.js")).toBe("br");
    const second = await publish(manual, "cnt-011-b-manual-site-two", site("second"));
    const report = await manual.buildContentVariants(1_000);
    expect(report).toMatchObject({built: 1, failed: 0});
    expect(report.skipped).toBe(2);
    expect(await encodingOf(manual, second, "app.js")).toBe("br");
    expect(await encodingOf(manual, second, "shared.js")).toBe("br");
    const again = await manual.buildContentVariants(1_000);
    expect(again).toMatchObject({built: 0, failed: 0, skipped: 3});
  }, 60_000);
});
