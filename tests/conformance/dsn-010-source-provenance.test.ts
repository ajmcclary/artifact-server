import {createHash} from "node:crypto";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";

type JsonValue = boolean | number | string | null | readonly JsonValue[] | JsonObject;
interface JsonObject {
  readonly [key: string]: JsonValue;
}

const encoder = new TextEncoder();
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const outcomeSchema = z.object({
  coverage: z.object({
    declaredOutputs: z.number(),
    dependencyEdges: z.enum(["complete", "partial", "none"]),
    externalVariability: z.array(z.string()),
    manifestFiles: z.number(),
  }).strict().optional(),
  diagnostic: z.string().optional(),
  mismatchCount: z.number().optional(),
  mismatches: z.array(z.object({path: z.string(), reason: z.enum(["digest", "missing"])}).strict()).optional(),
  record: z.object({source: z.object({commit: z.string(), dirty: z.boolean()}).loose()}).loose().optional(),
  status: z.enum(["verified", "mismatch", "invalid", "unsupported-version", "not-recorded"]),
  version: z.number().optional(),
}).strict();

const page: TestSiteFile = {
  bytes: encoder.encode("<!doctype html><title>Builder</title>"),
  mediaType: "text/html; charset=utf-8",
  path: "index.html",
};
const script: TestSiteFile = {
  bytes: encoder.encode("window.ready = true;"),
  mediaType: "text/javascript",
  path: "support.js",
};

function record(overrides: JsonObject = {}) {
  return {
    build: {
      dsRevision: "3".repeat(40),
      lockfileSha256: "4".repeat(64),
      recipe: "publish-all",
      recipeRevision: "2".repeat(40),
      renderer: {name: "dc-support", sha256: sha256(script.bytes)},
      toolchain: {node: "v24.15.0"},
    },
    coverage: {dependencyEdges: "partial", externalVariability: ["cdn react"]},
    format: "artifact-server.source-provenance",
    inputs: [{path: "arkcase-forms/project/index.html", sha256: "6".repeat(64)}],
    outputs: [
      {path: "index.html", sha256: sha256(page.bytes), sources: [{path: "arkcase-forms/project/index.html"}]},
      {path: "support.js", sha256: sha256(script.bytes), sources: []},
    ],
    source: {commit: "1".repeat(40), descriptorId: "arkcase-forms", dirty: true, repository: "https://github.com/example/Design"},
    version: 1,
    ...overrides,
  };
}

function recordBytes(bytes: Uint8Array): TestSiteFile {
  return {bytes, mediaType: "application/json", path: "artifactserver.provenance.json"};
}

function recordFile(value: JsonValue): TestSiteFile {
  return recordBytes(encoder.encode(JSON.stringify(value)));
}

describe("DSN-010 source provenance", () => {
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

  async function publish(files: readonly TestSiteFile[], key: string): Promise<PublishResponse> {
    const upload = await createStagedUpload(server, installation, "index.html", files);
    await uploadEveryStagedFile(installation, upload.body, files);
    return (await commitStagedUpload(installation, upload.body, key, {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: "Forms",
      tags: [],
    })).body;
  }

  async function readProvenance(published: PublishResponse): Promise<z.infer<typeof outcomeSchema>> {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/provenance?projectId=${published.artifact.projectId}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(response.status).toBe(200);
    return outcomeSchema.parse(await response.json());
  }

  test("DSN-010-B: verifies a matching record with its coverage and reports a missing record", async () => {
    expect.hasAssertions();
    const verified = await readProvenance(await publish([page, script, recordFile(record())], "dsn-010-b-verified"));
    expect(verified.status).toBe("verified");
    expect(verified.coverage).toEqual({
      declaredOutputs: 2,
      dependencyEdges: "partial",
      externalVariability: ["cdn react"],
      manifestFiles: 2,
    });
    expect(verified.record?.source).toMatchObject({commit: "1".repeat(40), dirty: true});
    expect(await readProvenance(await publish([page], "dsn-010-b-absent"))).toEqual({status: "not-recorded"});
  });

  test("DSN-010-F: reports mismatches, invalid and unsupported records without affecting other reads", async () => {
    expect.hasAssertions();
    const mismatch = await readProvenance(await publish([page, script, recordFile(record({
      outputs: [
        {path: "index.html", sha256: "f".repeat(64), sources: []},
        {path: "removed.js", sha256: "a".repeat(64), sources: []},
      ],
    }))], "dsn-010-f-mismatch"));
    expect(mismatch.status).toBe("mismatch");
    expect(mismatch.mismatches).toEqual([
      {path: "index.html", reason: "digest"},
      {path: "removed.js", reason: "missing"},
    ]);

    const hostile: readonly [string, TestSiteFile, string][] = [
      ["malformed", recordBytes(encoder.encode("{")), "invalid"],
      ["escaping output", recordFile(record({outputs: [{path: "../x", sha256: "a".repeat(64), sources: []}]})), "invalid"],
      ["credential url", recordFile(record({source: {commit: "1".repeat(40), descriptorId: "a", dirty: false, repository: "https://u:p@example.com/r"}})), "invalid"],
      ["duplicate output", recordFile(record({outputs: [{path: "index.html", sha256: sha256(page.bytes), sources: []}, {path: "index.html", sha256: sha256(page.bytes), sources: []}]})), "invalid"],
      ["unknown version", recordFile({format: "artifact-server.source-provenance", version: 2}), "unsupported-version"],
    ];
    const observed = await Promise.all(hostile.map(async ([name, file]) => {
      const published = await publish([page, script, file], `dsn-010-f-${name.replaceAll(" ", "-")}`);
      const provenance = await readProvenance(published);
      const views = await fetch(
        `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/views?projectId=${published.artifact.projectId}`,
        {headers: {Authorization: `Bearer ${installation.apiToken}`}},
      );
      return {name, provenance: provenance.status, views: z.object({status: z.string()}).strict().parse(await views.json())};
    }));
    expect(observed).toEqual(hostile.map(([name, , status]) => ({name, provenance: status, views: {status: "absent"}})));
  });
});
