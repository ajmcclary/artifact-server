import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
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
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";

type JsonValue = boolean | number | string | null | readonly JsonValue[] | JsonObject;
interface JsonObject {
  readonly [key: string]: JsonValue;
}

const protocolVersion = "2026-07-28";
const encoder = new TextEncoder();
const toolCallResultSchema = z.object({
  jsonrpc: z.literal("2.0"),
  result: z.object({
    content: z.array(z.object({text: z.string(), type: z.literal("text")})),
    isError: z.boolean().optional(),
    structuredContent: z.unknown(),
  }).loose(),
}).loose();
const contextSchema = z.object({
  artifactId: z.string(),
  provenance: z.object({status: z.string()}).loose(),
  versionId: z.string(),
  views: z.object({status: z.string()}).loose(),
}).strict();

describe("artifact_version_context", () => {
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

  async function callTool<Output>(name: string, parameters: JsonObject, output: z.ZodType<Output>): Promise<Output> {
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
          arguments: parameters,
          name,
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": protocolVersion,
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
    const result = toolCallResultSchema.parse(await response.json()).result;
    expect(result.isError ?? false).toBe(false);
    return output.parse(result.structuredContent);
  }

  test("returns a version's views and provenance outcomes", async () => {
    expect.hasAssertions();
    const files: readonly TestSiteFile[] = [
      {bytes: encoder.encode("<!doctype html><title>x</title>"), mediaType: "text/html; charset=utf-8", path: "index.html"},
      {
        bytes: encoder.encode(JSON.stringify({
          format: "artifact-server.views",
          version: 1,
          views: [{
            defaultScenarioId: "1",
            label: "Page",
            parameters: [],
            path: "index.html",
            scenarios: [{label: "One", props: {scenario: "1"}, scenarioId: "1"}],
            sourceRef: {path: "src/index.html"},
            viewId: "fixture/page",
          }],
        })),
        mediaType: "application/json",
        path: "artifactserver.views.json",
      },
    ];
    const upload = await createStagedUpload(server, installation, "index.html", files);
    await uploadEveryStagedFile(installation, upload.body, files);
    const published = (await commitStagedUpload(installation, upload.body, "dsn-011-version-context", {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: "Context",
      tags: [],
    })).body;
    const context = await callTool("artifact_version_context", {
      artifactId: published.artifact.id,
      projectId: published.artifact.projectId,
      versionId: published.version.id,
    }, contextSchema);
    expect(context.views.status).toBe("valid");
    expect(context.provenance).toEqual({status: "not-recorded"});
    expect(context.versionId).toBe(published.version.id);
  });
});
