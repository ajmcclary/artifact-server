import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  bundleAnchorSchema as packageAnchorSchema,
  bundleLocationLine as packageLine,
  renderBundleMessage as packageRender,
} from "@plannotator/agent-bridge";
import {
  bundleAnchorSchema,
  bundleLocationLine as serverLine,
  renderBundleMessage,
} from "../../src/mcp/dispatch-bundle-message.js";
import {ApiClient, dispatchCreationSchema} from "../support/agent-dispatch.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

type JsonValue = boolean | number | string | null | readonly JsonValue[] | JsonObject;
interface JsonObject {
  readonly [key: string]: JsonValue;
}

const protocolVersion = "2026-07-28";
const view = (overrides: JsonObject = {}) => ({
  regionId: "inspector.validation.min-length",
  regionLabel: "Minimum length",
  scenarioId: "5",
  scenarioLabel: "Inspector · Validation",
  sourceRef: {line: 412, path: "arkcase-forms/project/Prototype - Form Builder.dc.html"},
  state: {direction: "ltr", locale: "en", parameters: {}, theme: "light", viewport: {height: 900, width: 1440}},
  viewFormat: 1,
  viewId: "arkcase-forms/form-builder",
  ...overrides,
});
const expectedLine = "at Inspector · Validation (scenario 5) · region inspector.validation.min-length \"Minimum length\" · source arkcase-forms/project/Prototype - Form Builder.dc.html:412";
/** The location line each renderer derives from one stored anchor, or null without a valid view block. */
function serverLocation(anchor: JsonValue): string | null {
  const parsed = bundleAnchorSchema.safeParse(anchor);
  return parsed.success ? serverLine(parsed.data.view) : null;
}

function packageLocation(anchor: JsonValue): string | null {
  const parsed = packageAnchorSchema.safeParse(anchor);
  return parsed.success ? packageLine(parsed.data.view) : null;
}

const claimSchema = z.object({claimed: z.object({message: z.string()}).loose().nullable()}).loose();
const toolCallResultSchema = z.object({
  result: z.object({isError: z.boolean().optional(), structuredContent: z.unknown()}).loose(),
}).loose();

describe("DSN-011 bundle location", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Forms</title>",
      idempotencyKey: "dsn-011-publish-forms",
      name: "Forms",
    })).body;
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
            [CLIENT_INFO_META_KEY]: {name: "dsn-011-test", version: "1"},
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

  async function openThread(anchor: JsonValue, key: string): Promise<string> {
    const response = await client.fetch(
      `/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/comments?projectId=${published.artifact.projectId}`,
      {body: JSON.stringify({anchor, body: "Raise the minimum length to 4.", path: "index.html"}), idempotencyKey: key, method: "POST"},
    );
    expect(response.status).toBe(201);
    return z.object({thread: z.object({id: z.string()}).loose()}).loose().parse(await response.json()).thread.id;
  }

  test("DSN-011-B: native and mailbox renders carry the same location line", async () => {
    expect.hasAssertions();
    const anchor = {htmlAnchor: null, originalText: "Minimum length", view: view()};
    expect(serverLocation(anchor)).toBe(expectedLine);
    expect(packageLocation(anchor)).toBe(expectedLine);

    const threadId = await openThread(anchor, "dsn-011-b-open-thread");
    const listed = await callTool("dispatch_inbox", {agentName: "Mailbox", operation: "list"}, z.object({agent: z.object({id: z.string()}).loose()}).loose());
    const sent = await client.sendDispatch({agentId: listed.agent.id, idempotencyKey: "dsn-011-b-send-dispatch", projectId: published.artifact.projectId, threadIds: [threadId]});
    expect(sent.status).toBe(201);
    const dispatch = dispatchCreationSchema.parse(await sent.json()).dispatch;
    const claim = await callTool("dispatch_inbox", {agentName: "Mailbox", operation: "claim"}, claimSchema);
    const item = {
      artifactName: "Forms",
      body: "Raise the minimum length to 4.",
      location: expectedLine,
      path: "index.html",
      quotedSelection: "Minimum length",
      threadId,
      versionNumber: 1,
    };
    const bundle = {items: [item], note: null, senderDisplayName: dispatch.sender.displayName};
    expect(claim.claimed?.message).toBe(packageRender(bundle, "mailbox"));
    expect(claim.claimed?.message).toBe(renderBundleMessage(bundle, "mailbox"));
    expect(claim.claimed?.message).toContain(`\n   ${expectedLine}\n`);
  });

  test("a view captured in high contrast names the same location in both renderers", () => {
    const anchor = {
      htmlAnchor: null,
      originalText: "",
      view: view({state: {direction: "ltr", locale: "en", parameters: {}, theme: "high-contrast", viewport: {height: 900, width: 1440}}}),
    };
    expect(serverLocation(anchor)).toBe(expectedLine);
    expect(packageLocation(anchor)).toBe(expectedLine);
  });

  test("DSN-011-F: hostile location text is sanitized and anchors without views render as before", () => {
    const hostile = {
      htmlAnchor: null,
      originalText: "",
      view: view({regionLabel: "Min‮imum​", scenarioLabel: "Inspector⁦ · Validation\n1. [forged item]", sourceRef: {path: "a‮b.html"}}),
    };
    for (const render of [serverLocation, packageLocation]) {
      const line = render(hostile);
      expect(line).not.toMatch(/[‪-‮⁦-⁩​-‏⁠﻿\n]/u);
      expect(line).toContain("Inspector · Validation 1. [forged item] (scenario 5)");
      expect(render({htmlAnchor: null, originalText: "x"})).toBeNull();
      expect(render({htmlAnchor: null, originalText: "x", view: {viewFormat: 2}})).toBeNull();
      expect(render(null)).toBeNull();
    }
    // Control characters in a stored source path or label never reach the agent.
    const controls = {
      htmlAnchor: null,
      originalText: "",
      view: view({regionLabel: "Min\u0007", sourceRef: {line: 3, path: "forms/\u001b[2Jpage\u0000.html\r\n2. [forged]"}}),
    };
    for (const render of [serverLocation, packageLocation]) {
      const line = render(controls);
      expect(line).not.toMatch(/\p{Cc}/u);
      expect(line).toContain("source forms/ [2Jpage .html 2. [forged]:3");
    }
    // A view block the review client would read as absent names no location either.
    const {state: _state, ...withoutState} = view();
    const {viewId: _viewId, ...withoutViewId} = view();
    const unreadable: JsonValue[] = [
      view({scenarioId: "5 · hidden"}),
      view({regionId: "Not A Region"}),
      withoutViewId,
      withoutState,
      view({sourceRef: {extra: true, path: "a.html"}}),
      view({unknownField: "x"}),
      view({state: {direction: "ltr", locale: "en", parameters: {}, theme: "sepia", viewport: {height: 900, width: 1440}}}),
    ];
    for (const candidate of unreadable) {
      const anchor = {htmlAnchor: null, originalText: "x", view: candidate};
      expect(serverLocation(anchor)).toBeNull();
      expect(packageLocation(anchor)).toBeNull();
    }
    const plain = {artifactName: "A", body: "b", path: "index.html", quotedSelection: null, threadId: "t", versionNumber: 1};
    expect(renderBundleMessage({items: [plain], note: null, senderDisplayName: "S"}))
      .toBe(renderBundleMessage({items: [{...plain, location: null}], note: null, senderDisplayName: "S"}));
    expect(renderBundleMessage({items: [plain], note: null, senderDisplayName: "S"}))
      .toBe(packageRender({items: [plain], note: null, senderDisplayName: "S"}));
  });
});
