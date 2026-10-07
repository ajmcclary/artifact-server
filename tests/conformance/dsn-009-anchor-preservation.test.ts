import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";

type JsonValue = boolean | number | string | null | readonly JsonValue[] | JsonObject;
interface JsonObject {
  readonly [key: string]: JsonValue;
}

const protocolVersion = "2026-07-28";
const threadSchema = z.object({anchor: z.json(), id: z.string()}).loose();
const toolCallResultSchema = z.object({
  result: z.object({isError: z.boolean().optional(), structuredContent: z.unknown()}).loose(),
}).loose();

/** A design review anchor carrying a field no current client knows. */
const anchor = {
  future: {kept: true},
  htmlAnchor: null,
  originalText: "Minimum length",
  view: {
    regionId: "inspector.validation.min-length",
    scenarioId: "5",
    scenarioLabel: "Inspector · Validation",
    sourceRef: {path: "arkcase-forms/project/Prototype - Form Builder.dc.html"},
    state: {direction: "ltr", locale: null, parameters: {}, theme: "light", viewport: {height: 900, width: 1440}},
    viewFormat: 1,
    viewId: "arkcase-forms/form-builder",
  },
} as const satisfies JsonObject;

describe("DSN-009 anchor preservation", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let published: PublishResponse;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Forms</title>",
      idempotencyKey: "dsn-009-anchor-preservation",
      name: "Forms",
    })).body;
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function createThread(): Promise<string> {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/comments?projectId=${published.artifact.projectId}`,
      {
        body: JSON.stringify({anchor, body: "Raise the minimum length to 4.", path: "index.html"}),
        headers: apiHeaders(installation, "dsn-009-anchor-thread"),
        method: "POST",
      },
    );
    expect(response.status).toBe(201);
    return z.object({thread: threadSchema}).loose().parse(await response.json()).thread.id;
  }

  async function readAnchor(threadId: string): Promise<z.infer<typeof threadSchema>["anchor"]> {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/comments/${threadId}?projectId=${published.artifact.projectId}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(response.status).toBe(200);
    return z.object({thread: threadSchema}).loose().parse(await response.json()).thread.anchor;
  }

  async function callTool(name: string, parameters: JsonObject): Promise<void> {
    const response = await fetch(`${server.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: crypto.randomUUID(),
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: {name: "dsn-009-test", version: "1"},
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
    expect(toolCallResultSchema.parse(await response.json()).result.isError ?? false).toBe(false);
  }

  test("DSN-009-F: anchor replacement over HTTP and MCP keeps view blocks and unknown fields", async () => {
    expect.hasAssertions();
    const threadId = await createThread();
    expect(await readAnchor(threadId)).toEqual(anchor);

    const replaced = {...anchor, future: {kept: "again"}};
    const patched = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/comments/${threadId}?projectId=${published.artifact.projectId}`,
      {
        body: JSON.stringify({anchor: replaced}),
        headers: apiHeaders(installation, "dsn-009-anchor-patch"),
        method: "PATCH",
      },
    );
    expect(patched.status).toBe(200);
    expect(await readAnchor(threadId)).toEqual(replaced);

    await callTool("comment_update", {
      anchor,
      artifactId: published.artifact.id,
      projectId: published.artifact.projectId,
      threadId,
    });
    expect(await readAnchor(threadId)).toEqual(anchor);
  });
});
