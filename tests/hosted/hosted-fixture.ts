import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {expect, type Browser, type BrowserContext, type Page} from "@playwright/test";
import {z} from "zod";

import type {ApiTarget} from "../support/publishing.js";
import {apiHeaders} from "../support/runtime-harness.js";
import {hostedConnection} from "./hosted-connection.js";

const protocolVersion = "2026-07-28";
const toolCallResultSchema = z.object({
  result: z.object({content: z.unknown(), isError: z.boolean().optional(), structuredContent: z.unknown()}).loose(),
}).loose();
const artifactSchema = z.object({artifact: z.object({currentVersionId: z.string()}).loose()}).loose();

/**
 * A browser and HTTP session against a hosted Artifact Server, signed in with
 * the operator's API key instead of an interactive browser login.
 */
export interface HostedFixture extends ApiTarget {
  readonly context: BrowserContext;
  readonly page: Page;
  /** A tag unique to this run, so its artifacts and agent are recognisable and never reused. */
  readonly runTag: string;
}

/** Open one hosted session, signed in with the operator's API key. */
export async function startHostedFixture(browser: Browser): Promise<HostedFixture> {
  const hosted = await hostedConnection();
  const target = {installation: {apiToken: hosted.apiToken}, server: {baseUrl: hosted.baseUrl}};
  const context = await openHostedContext(browser, target);
  const page = await context.newPage();
  return {
    ...target,
    context,
    page,
    runTag: new Date().toISOString().replace(/[^0-9]/gu, "").slice(0, 14),
  };
}

/**
 * A fresh browser context signed in to the hosted server, with an empty cache.
 * The API key is attached only to the application origin's `/api/` requests,
 * never to the content origin, and the CSRF cookie the web client reads before
 * a mutation is a placeholder: the server checks CSRF only for browser
 * sessions, never for a bearer request.
 */
export async function openHostedContext(browser: Browser, target: ApiTarget): Promise<BrowserContext> {
  const context = await browser.newContext({viewport: {height: 1000, width: 1680}});
  await context.route(`${target.server.baseUrl}/api/**`, async (route) => {
    await route.continue({headers: {...route.request().headers(), authorization: `Bearer ${target.installation.apiToken}`}});
  });
  await context.addCookies([{
    name: "__Host-artifact_csrf",
    sameSite: "Strict",
    secure: true,
    url: target.server.baseUrl,
    value: "bearer-request",
  }]);
  return context;
}

/** Call one MCP tool on the hosted server and return its structured result. */
export async function callHostedTool<Output>(
  fixture: ApiTarget,
  name: string,
  parameters: Readonly<Record<string, string | null>>,
  output: z.ZodType<Output>,
): Promise<Output> {
  const response = await fetch(`${fixture.server.baseUrl}/mcp`, {
    body: JSON.stringify({
      id: crypto.randomUUID(),
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: {name: "hosted-design-review-qualification", version: "1"},
          [PROTOCOL_VERSION_META_KEY]: protocolVersion,
        },
        arguments: parameters,
        name,
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${fixture.installation.apiToken}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": protocolVersion,
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    method: "POST",
  });
  expect(response.status).toBe(200);
  const result = toolCallResultSchema.parse(await response.json()).result;
  expect(result.isError ?? false, `${name} failed: ${JSON.stringify(result).slice(0, 600)}`).toBe(false);
  return output.parse(result.structuredContent);
}

/** GET one JSON document from the hosted API. */
export async function getHostedJson<Output>(
  fixture: ApiTarget,
  path: string,
  output: z.ZodType<Output>,
): Promise<Output> {
  const response = await fetch(`${fixture.server.baseUrl}${path}`, {
    headers: {Authorization: `Bearer ${fixture.installation.apiToken}`},
  });
  expect(response.status, `GET ${path}`).toBe(200);
  return output.parse(await response.json());
}

/** Delete one qualification artifact, whatever its current version now is. */
export async function deleteHostedArtifact(
  fixture: ApiTarget,
  artifactId: string,
  projectId: string,
): Promise<void> {
  const current = await getHostedJson(
    fixture,
    `/api/v1/artifacts/${artifactId}?projectId=${projectId}`,
    artifactSchema,
  );
  const response = await fetch(`${fixture.server.baseUrl}/api/v1/artifacts/${artifactId}?projectId=${projectId}`, {
    body: JSON.stringify({expectedCurrentVersionId: current.artifact.currentVersionId}),
    headers: apiHeaders(fixture.installation, `hosted-qualification-delete-${artifactId}`),
    method: "DELETE",
  });
  expect(response.status, `DELETE ${artifactId}`).toBe(200);
}
