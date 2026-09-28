import {execFileSync} from "node:child_process";
import {mkdir, mkdtemp, realpath, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  apiHeaders,
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const sourceBindingSchema = z.object({
  lastVerifiedAt: z.iso.datetime(),
  path: z.string().min(1),
  status: z.enum(["in-sync", "modified", "missing", "unreadable"]),
}).strict();

const linkedPublicationSchema = z.object({
  artifact: z.object({id: z.string().min(1)}).loose(),
  links: z.object({
    artifact: z.string().min(1),
    live: z.string().min(1),
    review: z.string().min(1),
    version: z.string().min(1),
  }).strict(),
  replayed: z.boolean(),
  sourceBinding: sourceBindingSchema,
  version: z.object({id: z.string().min(1), number: z.number().int()}).loose(),
}).loose();

const errorSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).loose(),
}).loose();

const artifactDetailsSchema = z.object({
  links: z.object({live: z.string().min(1)}).loose(),
  sourceBinding: sourceBindingSchema,
}).loose();

const liveSessionSchema = z.object({
  bootstrapUrl: z.string().min(1),
  expiresAt: z.iso.datetime(),
}).strict();

describe("linked artifacts over the local HTTP boundary", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;
  let sourceRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    sourceRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "linked-artifact-sources-")),
    );
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    server = null;
    await removeTestInstallation(installation);
    await rm(sourceRoot, {force: true, recursive: true});
  });

  test("a file links in place, drifts, and captures a new version", async () => {
    server = await startTestServer(installation, {
      linkRoots: [sourceRoot],
      linkedFiles: "on",
    });
    const sourcePath = path.join(sourceRoot, "notes.md");
    await writeFile(sourcePath, "# original state\n");

    const linkResponse = await fetch(
      new URL("/api/v1/artifacts/link", server.baseUrl),
      {
        body: JSON.stringify({path: sourcePath}),
        headers: apiHeaders(installation, "link-notes-0000000001"),
        method: "POST",
      },
    );
    expect(linkResponse.status).toBe(201);
    const linked = linkedPublicationSchema.parse(await linkResponse.json());
    expect(linked.sourceBinding.status).toBe("in-sync");
    expect(linked.sourceBinding.path).toBe(sourcePath);
    expect(linked.replayed).toBe(false);

    const readFresh = await fetch(
      new URL(`/api/v1/artifacts/${linked.artifact.id}`, server.baseUrl),
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(readFresh.status).toBe(200);
    const freshDetails = artifactDetailsSchema.parse(await readFresh.json());
    expect(freshDetails.sourceBinding.status).toBe("in-sync");

    await writeFile(sourcePath, "# drifted state\n");
    const readDrifted = await fetch(
      new URL(`/api/v1/artifacts/${linked.artifact.id}`, server.baseUrl),
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    const driftedDetails = artifactDetailsSchema.parse(
      await readDrifted.json(),
    );
    expect(driftedDetails.sourceBinding.status).toBe("modified");

    const captureResponse = await fetch(
      new URL(
        `/api/v1/artifacts/${linked.artifact.id}/capture`,
        server.baseUrl,
      ),
      {
        body: JSON.stringify({expectedCurrentVersionId: linked.version.id}),
        headers: apiHeaders(installation, "capture-notes-000000001"),
        method: "POST",
      },
    );
    expect(captureResponse.status).toBe(201);
    const captured = linkedPublicationSchema.parse(
      await captureResponse.json(),
    );
    expect(captured.version.id).not.toBe(linked.version.id);
    expect(captured.sourceBinding.status).toBe("in-sync");

    const replayResponse = await fetch(
      new URL(
        `/api/v1/artifacts/${linked.artifact.id}/capture`,
        server.baseUrl,
      ),
      {
        body: JSON.stringify({expectedCurrentVersionId: linked.version.id}),
        headers: apiHeaders(installation, "capture-notes-000000001"),
        method: "POST",
      },
    );
    expect(replayResponse.status).toBe(201);
    const replayed = linkedPublicationSchema.parse(await replayResponse.json());
    expect(replayed.version.id).toBe(captured.version.id);
    expect(replayed.replayed).toBe(true);

    const inSyncCapture = await fetch(
      new URL(
        `/api/v1/artifacts/${linked.artifact.id}/capture`,
        server.baseUrl,
      ),
      {
        body: JSON.stringify({expectedCurrentVersionId: captured.version.id}),
        headers: apiHeaders(installation, "capture-notes-000000002"),
        method: "POST",
      },
    );
    expect(inSyncCapture.status).toBe(201);
    const inSync = linkedPublicationSchema.parse(await inSyncCapture.json());
    expect(inSync.version.id).toBe(captured.version.id);
    expect(inSync.replayed).toBe(true);
  });

  test("every linked route answers the stable shape while the capability is off", async () => {
    server = await startTestServer(installation);
    const sourcePath = path.join(sourceRoot, "notes.md");
    await writeFile(sourcePath, "# unreachable\n");

    const session = await fetch(new URL("/api/v1/session", server.baseUrl), {
      headers: {Authorization: `Bearer ${installation.apiToken}`},
    });
    const sessionBody = z.object({
      capabilities: z.object({
        gitHistory: z.unknown(),
        linkedArtifacts: z.boolean(),
      }).strict(),
    }).loose().parse(await session.json());
    expect(sessionBody.capabilities.linkedArtifacts).toBe(false);

    const linkResponse = await fetch(
      new URL("/api/v1/artifacts/link", server.baseUrl),
      {
        body: JSON.stringify({path: sourcePath}),
        headers: apiHeaders(installation, "link-disabled-000000001"),
        method: "POST",
      },
    );
    expect(linkResponse.status).toBe(501);
    const failure = errorSchema.parse(await linkResponse.json());
    expect(failure.error.code).toBe("CAPABILITY_UNAVAILABLE");

    const captureResponse = await fetch(
      new URL("/api/v1/artifacts/art_missing/capture", server.baseUrl),
      {
        body: JSON.stringify({expectedCurrentVersionId: "ver_missing"}),
        headers: apiHeaders(installation, "capture-disabled-0000001"),
        method: "POST",
      },
    );
    expect(captureResponse.status).toBe(501);

    const relinkResponse = await fetch(
      new URL("/api/v1/artifacts/art_missing/source", server.baseUrl),
      {
        body: JSON.stringify({
          expectedSha256: "a".repeat(64),
          path: sourcePath,
        }),
        headers: apiHeaders(installation, "relink-disabled-00000001"),
        method: "PUT",
      },
    );
    expect(relinkResponse.status).toBe(501);

    const liveSessionResponse = await fetch(
      new URL("/api/v1/artifacts/art_missing/live-sessions", server.baseUrl),
      {
        headers: apiHeaders(installation, "live-disabled-0000000001"),
        method: "POST",
      },
    );
    expect(liveSessionResponse.status).toBe(501);
  });

  test("the live origin streams current disk bytes to a session holder only", async () => {
    server = await startTestServer(installation, {
      linkRoots: [sourceRoot],
      linkedFiles: "on",
    });
    const sourcePath = path.join(sourceRoot, "live.md");
    await writeFile(sourcePath, "# captured state\n");

    const linkResponse = await fetch(
      new URL("/api/v1/artifacts/link", server.baseUrl),
      {
        body: JSON.stringify({path: sourcePath}),
        headers: apiHeaders(installation, "link-live-00000000001"),
        method: "POST",
      },
    );
    const linked = linkedPublicationSchema.parse(await linkResponse.json());
    const liveUrl = new URL(linked.links.live);
    expect(liveUrl.hostname.startsWith("live-")).toBe(true);
    expect(liveUrl.hostname.endsWith(".localhost")).toBe(true);

    const anonymous = await fetchVersion(server, linked.links.live);
    expect(anonymous.status).toBe(401);

    const liveSessionResponse = await fetch(
      new URL(
        `/api/v1/artifacts/${linked.artifact.id}/live-sessions`,
        server.baseUrl,
      ),
      {
        headers: apiHeaders(installation, "live-session-00000000001"),
        method: "POST",
      },
    );
    expect(liveSessionResponse.status).toBe(201);
    const liveSession = liveSessionSchema.parse(
      await liveSessionResponse.json(),
    );

    const exchanged = await fetchVersion(server, liveSession.bootstrapUrl);
    expect(exchanged.status).toBe(200);
    const contentCookie = exchanged.headers.getSetCookie().find((value) =>
      value.includes("artifact_content=")
    );
    expect(contentCookie).toBeDefined();
    const cookiePair = (contentCookie ?? "").split(";")[0] ?? "";

    await writeFile(sourcePath, "# live drifted bytes\n");
    const liveRead = await fetchVersion(server, linked.links.live, "GET", {
      Cookie: cookiePair,
    });
    expect(liveRead.status).toBe(200);
    expect(liveRead.headers.get("cache-control")).toBe("private, no-store");
    expect(liveRead.headers.get("artifact-source-freshness")).toBe("modified");
    expect(await liveRead.text()).toBe("# live drifted bytes\n");

    // The captured version keeps serving the held-still bytes untouched.
    const versionRead = await fetchVersion(server, linked.links.version, "GET", {
      Cookie: cookiePair,
    });
    expect(versionRead.status).toBe(401);
  });

  test("an ancestor swap between link validation and capture cannot publish outside bytes", async () => {
    const parent = path.join(sourceRoot, "inside");
    const outside = path.join(installation.dataDirectory, "outside");
    await mkdir(parent);
    await mkdir(outside);
    await writeFile(path.join(parent, "notes.md"), "allowed\n");
    await writeFile(path.join(outside, "notes.md"), "server-only\n");
    let swapped = false;
    server = await startTestServer(installation, {
      linkRoots: [sourceRoot],
      linkedFiles: "on",
      linkedCaptureHooks: {
        beforeOpen: async () => {
          if (swapped) return;
          swapped = true;
          await rm(parent, {recursive: true});
          await symlink(outside, parent);
        },
      },
    });

    const response = await fetch(new URL("/api/v1/artifacts/link", server.baseUrl), {
      body: JSON.stringify({path: path.join(parent, "notes.md")}),
      headers: apiHeaders(installation, "link-ancestor-swap-0001"),
      method: "POST",
    });
    expect(swapped).toBe(true);
    expect(response.status).toBe(409);
    expect(errorSchema.parse(await response.json()).error.code).toBe("SOURCE_UNREADABLE");
    const artifacts = await fetch(new URL("/api/v1/artifacts?limit=100", server.baseUrl), {
      headers: {Authorization: `Bearer ${installation.apiToken}`},
    });
    expect(z.object({artifacts: z.array(z.unknown())}).parse(await artifacts.json()).artifacts)
      .toEqual([]);
  });

  test("a replaced ancestor falls back to captured live bytes and blocks recapture", async () => {
    const parent = path.join(sourceRoot, "inside");
    const outside = path.join(installation.dataDirectory, "outside");
    await mkdir(parent);
    await mkdir(outside);
    await writeFile(path.join(parent, "notes.md"), "captured\n");
    await writeFile(path.join(outside, "notes.md"), "server-only\n");
    server = await startTestServer(installation, {
      linkRoots: [sourceRoot],
      linkedFiles: "on",
    });
    const linkedResponse = await fetch(new URL("/api/v1/artifacts/link", server.baseUrl), {
      body: JSON.stringify({path: path.join(parent, "notes.md")}),
      headers: apiHeaders(installation, "link-ancestor-safe-0001"),
      method: "POST",
    });
    expect(linkedResponse.status).toBe(201);
    const linked = linkedPublicationSchema.parse(await linkedResponse.json());
    const liveSessionResponse = await fetch(new URL(
      `/api/v1/artifacts/${linked.artifact.id}/live-sessions`,
      server.baseUrl,
    ), {
      headers: apiHeaders(installation, "live-ancestor-safe-0001"),
      method: "POST",
    });
    const liveSession = liveSessionSchema.parse(await liveSessionResponse.json());
    const exchanged = await fetchVersion(server, liveSession.bootstrapUrl);
    const contentCookie = exchanged.headers.getSetCookie().find((value) =>
      value.includes("artifact_content=")
    );
    expect(contentCookie).toBeDefined();
    await rm(parent, {recursive: true});
    await symlink(outside, parent);

    const live = await fetchVersion(server, linked.links.live, "GET", {
      Cookie: (contentCookie ?? "").split(";")[0] ?? "",
    });
    expect(live.status).toBe(200);
    expect(live.headers.get("artifact-source-freshness")).toBe("unreadable");
    expect(await live.text()).toBe("captured\n");

    const capture = await fetch(new URL(
      `/api/v1/artifacts/${linked.artifact.id}/capture`,
      server.baseUrl,
    ), {
      body: JSON.stringify({expectedCurrentVersionId: linked.version.id}),
      headers: apiHeaders(installation, "capture-ancestor-safe-0001"),
      method: "POST",
    });
    expect(capture.status).toBe(409);
    expect(errorSchema.parse(await capture.json()).error.code).toBe("SOURCE_UNREADABLE");
    const versions = await fetch(new URL(
      `/api/v1/artifacts/${linked.artifact.id}/versions`,
      server.baseUrl,
    ), {headers: {Authorization: `Bearer ${installation.apiToken}`}});
    expect(z.object({versions: z.array(z.unknown())}).parse(await versions.json()).versions)
      .toHaveLength(1);

    await rm(parent);
    await mkdir(parent);
    execFileSync("mkfifo", [path.join(parent, "notes.md")]);
    const fifoLive = await fetchVersion(server, linked.links.live, "GET", {
      Cookie: (contentCookie ?? "").split(";")[0] ?? "",
    });
    expect(fifoLive.status).toBe(200);
    expect(fifoLive.headers.get("artifact-source-freshness")).toBe("unreadable");
    expect(await fifoLive.text()).toBe("captured\n");
  });
});
