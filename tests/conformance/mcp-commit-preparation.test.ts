import {createHash} from "node:crypto";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {Duration} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const protocolVersion = "2026-07-28";
const toolCallResultSchema = z.object({
  jsonrpc: z.literal("2.0"),
  result: z.object({
    content: z.array(z.object({text: z.string(), type: z.literal("text")})),
    isError: z.boolean().optional(),
    structuredContent: z.unknown(),
  }).loose(),
});
const uploadPlanSchema = z.object({
  files: z.array(z.object({
    method: z.literal("PUT"),
    path: z.string(),
    uploadUrl: z.url(),
  })),
  kind: z.literal("upload"),
  uploadId: z.string().min(1),
});
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});
const committedSchema = z.object({
  artifact: z.object({currentVersionId: z.string(), id: z.string()}).loose(),
  replayed: z.boolean(),
  status: z.literal("committed"),
  version: z.object({id: z.string()}).loose(),
});
const artifactListSchema = z.object({
  artifacts: z.array(z.object({artifact: z.object({id: z.string()})})),
});

interface DeclaredFile {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mediaType: string;
  readonly path: string;
}

function declaredFile(path: string, mediaType: string, text: string): DeclaredFile {
  return {bytes: new TextEncoder().encode(text), mediaType, path};
}

describe("MCP commit of an upload that is still preparing", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    // One file per preparation pass and one zero-length wait inside a commit:
    // a three-file upload needs three passes, and one MCP call runs only two.
    server = await startTestServer(installation, {
      mcpCommitPreparationDelays: [Duration.zero],
      publicationPreparationConfig: {filesPerPass: 1, preparedEntriesPerPass: 1},
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("MCP-026-B MCP-026-F: an exhausted preparation wait returns UPLOAD_STILL_PREPARING, commits nothing, and the same key resumes to one version", async () => {
    const files = [
      declaredFile("index.html", "text/html; charset=utf-8", "<!doctype html><title>Preparing</title>\n"),
      declaredFile("first.txt", "text/plain", "first asset\n"),
      declaredFile("second.txt", "text/plain", "second asset\n"),
    ];
    const plan = uploadPlanSchema.parse((await callTool(server, installation.apiToken, "artifact_create_upload", {
      entryPath: "index.html",
      files: files.map((file) => ({
        mediaType: file.mediaType,
        path: file.path,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
        size: file.bytes.byteLength,
      })),
    })).structuredContent);
    for (const filePlan of plan.files) {
      const file = files.find((candidate) => candidate.path === filePlan.path);
      if (file === undefined) throw new Error(`The plan names an undeclared file ${filePlan.path}.`);
      // eslint-disable-next-line no-await-in-loop
      const written = await fetch(filePlan.uploadUrl, {body: file.bytes, method: filePlan.method});
      expect(written.status).toBe(200);
    }

    const commit: CommitUploadArguments = {
      idempotencyKey: "mcp-still-preparing-0001",
      target: {kind: "new_artifact", name: "Still preparing"},
      uploadId: plan.uploadId,
    };
    const preparing = await callTool(server, installation.apiToken, "artifact_commit_upload", commit);
    expect(preparing.isError).toBe(true);
    const failure = failureSchema.parse(preparing.structuredContent).error;
    expect(failure.code).toBe("UPLOAD_STILL_PREPARING");
    expect(failure.message).toContain("(2/3 files)");
    expect(failure.message).toContain(
      "Re-run artifact_commit_upload with the same uploadId and idempotency key to resume",
    );
    expect(preparing.content[0]?.text).toBe(`UPLOAD_STILL_PREPARING: ${failure.message}`);
    expect(await listedArtifactIds(server, installation)).toEqual([]);

    const resumed = await callTool(server, installation.apiToken, "artifact_commit_upload", commit);
    expect(resumed.isError).not.toBe(true);
    const committed = committedSchema.parse(resumed.structuredContent);
    expect(committed.replayed).toBe(false);
    expect(committed.artifact.currentVersionId).toBe(committed.version.id);
    expect(await listedArtifactIds(server, installation)).toEqual([committed.artifact.id]);

    const replay = committedSchema.parse((await callTool(
      server,
      installation.apiToken,
      "artifact_commit_upload",
      commit,
    )).structuredContent);
    expect(replay.replayed).toBe(true);
    expect(replay.version.id).toBe(committed.version.id);
    expect(await listedArtifactIds(server, installation)).toEqual([committed.artifact.id]);
  });
});

async function listedArtifactIds(
  server: RunningTestServer,
  installation: TestInstallation,
): Promise<ReadonlyArray<string>> {
  const response = await fetch(`${server.baseUrl}/api/v1/artifacts`, {
    headers: {Authorization: `Bearer ${installation.apiToken}`},
  });
  expect(response.status).toBe(200);
  return artifactListSchema.parse(await response.json()).artifacts
    .map((entry) => entry.artifact.id);
}

interface CreateUploadArguments {
  readonly entryPath: string;
  readonly files: ReadonlyArray<{
    readonly mediaType: string;
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
  }>;
}

interface CommitUploadArguments {
  readonly idempotencyKey: string;
  readonly target: {readonly kind: "new_artifact"; readonly name: string};
  readonly uploadId: string;
}

async function callTool(
  server: RunningTestServer,
  token: string,
  name: "artifact_commit_upload" | "artifact_create_upload",
  toolArguments: CommitUploadArguments | CreateUploadArguments,
) {
  const response = await fetch(`${server.baseUrl}/mcp`, {
    body: JSON.stringify({
      id: crypto.randomUUID(),
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: {name: "artifact-server-test", version: "1"},
          [PROTOCOL_VERSION_META_KEY]: protocolVersion,
        },
        arguments: toolArguments,
        name,
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": protocolVersion,
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    method: "POST",
  });
  expect(response.status).toBe(200);
  return toolCallResultSchema.parse(await response.json()).result;
}
