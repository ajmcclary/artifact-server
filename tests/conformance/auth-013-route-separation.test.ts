import {readFile} from "node:fs/promises";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {publishNew} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

interface ApplicationRoute {
  readonly method: string;
  readonly path: string;
}

const routeSource = new URL("../../src/http/create-http-app.ts", import.meta.url);

/**
 * Every route the HTTP application registers, read from the one module that
 * registers them. A version content host is answered by middleware before
 * any of these routes runs, so this list is the complete application surface
 * that must stay off content hosts.
 */
async function applicationRoutes(): Promise<readonly ApplicationRoute[]> {
  const source = await readFile(routeSource, "utf8");
  const registration =
    /\bapp\.(get|post|put|patch|delete|all|on)\(\s*(?:(\[[^\]]*\]|"[A-Z]+")\s*,\s*)?(\[[^\]]*\]|"\/[^"]*")/gu;
  const routes: ApplicationRoute[] = [];
  for (const match of source.matchAll(registration)) {
    const [, kind = "", methodList, pathList = ""] = match;
    if (kind === "on" && methodList === undefined) continue;
    const methods = kind === "on"
      ? [...(methodList ?? "").matchAll(/"([A-Z]+)"/gu)].map((method) => method[1] ?? "")
      : kind === "all"
        ? ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
        : [kind.toUpperCase()];
    for (const pathMatch of pathList.matchAll(/"(\/[^"]*)"/gu)) {
      for (const method of methods) {
        routes.push({method, path: pathMatch[1] ?? "/"});
      }
    }
  }
  return routes;
}

function concretePath(
  routePath: string,
  identities: {readonly artifactId: string; readonly versionId: string},
): string {
  return routePath
    .replaceAll(":artifactId", identities.artifactId)
    .replaceAll(":versionId", identities.versionId)
    .replaceAll(":projectId", "prj_default")
    .replace(/:[A-Za-z]+/gu, "probe")
    .replace(/\*$/u, "probe");
}

const sensitiveRoutes: readonly ApplicationRoute[] = [
  // Browser login and its callback.
  {method: "GET", path: "/auth/login"},
  {method: "GET", path: "/auth/callback"},
  {method: "POST", path: "/auth/local"},
  // OAuth protected-resource metadata.
  {method: "GET", path: "/.well-known/oauth-protected-resource/api"},
  // MCP.
  {method: "POST", path: "/mcp"},
  // Administration.
  {method: "GET", path: "/api/v1/administration/public-links"},
  {method: "PUT", path: "/api/v1/access-policy"},
  {method: "POST", path: "/api/v1/api-keys"},
  {method: "POST", path: "/api/v1/members"},
  // Artifact metadata mutation.
  {method: "PATCH", path: "/api/v1/artifacts/:artifactId/access"},
  {method: "PATCH", path: "/api/v1/artifacts/:artifactId/name"},
  {method: "DELETE", path: "/api/v1/artifacts/:artifactId"},
  {method: "POST", path: "/api/v1/uploads"},
];

const sessionSchema = z.object({
  principal: z.object({}).loose(),
}).loose();

describe("application and content routes stay on separate origins", () => {
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

  async function ownerSessionCookie(): Promise<string> {
    const login = await fetch(new URL("/auth/local-owner", server.baseUrl), {
      headers: {
        Origin: server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
      method: "POST",
    });
    expect(login.status).toBe(204);
    const cookie = login.headers.getSetCookie()
      .find((value) => value.startsWith("artifact_session="));
    if (cookie === undefined) throw new Error("No application session cookie was set.");
    return cookie.split(";", 1)[0] ?? "";
  }

  async function publishPublicFixture() {
    return publishNew(server, installation, {
      accessSetting: "public_link",
      content: "<!doctype html><title>Route separation fixture</title>",
      idempotencyKey: "auth-013-route-separation",
    });
  }

  test("AUTH-013-B: login, OAuth, MCP, administration, and metadata routes answer only on the application origin while the version origin serves read-only content", async () => {
    const routes = await applicationRoutes();
    const registered = new Set(routes.map((route) => `${route.method} ${route.path}`));
    expect(sensitiveRoutes.filter((route) => !registered.has(`${route.method} ${route.path}`)))
      .toEqual([]);
    // Every registered route is an absolute application path.
    expect(routes.filter((route) => !route.path.startsWith("/"))).toEqual([]);

    const published = await publishPublicFixture();
    const applicationHost = new URL(server.baseUrl).host;
    const versionUrl = new URL(published.body.links.version);
    expect(versionUrl.host).not.toBe(applicationHost);

    // The application origin answers its own routes.
    const context = await fetch(new URL("/auth/context", server.baseUrl));
    expect(context.status).toBe(200);
    expect(context.headers.get("content-type")).toContain("application/json");
    await context.arrayBuffer();
    const mcp = await fetch(new URL("/mcp", server.baseUrl), {
      body: "{}",
      headers: {"Content-Type": "application/json"},
      method: "POST",
    });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toMatch(/^Bearer/u);
    await mcp.arrayBuffer();
    const session = await fetch(new URL("/api/v1/session", server.baseUrl), {
      headers: {Cookie: await ownerSessionCookie()},
    });
    expect(session.status).toBe(200);
    sessionSchema.parse(await session.json());

    // The version origin serves the artifact's bytes and nothing else: it
    // accepts only GET and HEAD.
    const content = await fetchVersion(server, published.body.links.version);
    expect(content.status).toBe(200);
    expect(await content.text()).toContain("Route separation fixture");
    const write = await fetchVersion(server, published.body.links.version, "POST");
    expect(write.status).toBe(405);
    expect(write.headers.get("allow")).toBe("GET, HEAD");
    await write.arrayBuffer();
  });

  test("AUTH-013-F: no version content host exposes a login callback, OAuth, metadata mutation, administration, or MCP endpoint", async () => {
    const routes = await applicationRoutes();
    expect(routes.length).toBeGreaterThan(100);
    const published = await publishPublicFixture();
    const identities = {
      artifactId: published.body.artifact.id,
      versionId: published.body.version.id,
    };
    const sessionCookie = await ownerSessionCookie();
    // Present every application credential to the content host: neither the
    // bearer token nor the browser session may reach an application handler.
    const credentials = {
      Authorization: `Bearer ${installation.apiToken}`,
      Cookie: sessionCookie,
    };
    const contentOrigin = new URL(published.body.links.version).origin;

    const probe = async (route: ApplicationRoute) => {
      const target = new URL(concretePath(route.path, identities), contentOrigin);
      const response = await fetchVersion(
        server,
        target.toString(),
        route.method,
        credentials,
      );
      const body = await response.text();
      return {
        allow: response.headers.get("allow"),
        location: response.headers.get("location"),
        route: `${route.method} ${route.path}`,
        servesFixture: body.includes("Route separation fixture"),
        setCookie: response.headers.getSetCookie(),
        status: response.status,
        wwwAuthenticate: response.headers.get("www-authenticate"),
      };
    };
    // Probe one route at a time: over a hundred simultaneous connections
    // overflow macOS's default listen backlog (128) and come back as ECONNRESET.
    const observed: Awaited<ReturnType<typeof probe>>[] = [];
    for (const route of routes) {
      // eslint-disable-next-line no-await-in-loop
      observed.push(await probe(route));
    }
    // A content host serves only manifest entries for GET and HEAD, so an
    // application path is absent from the version (except the entry document
    // at "/"), and every other method is refused with 405.
    const expected = routes.map((route) => {
      const readOnly = route.method === "GET" || route.method === "HEAD";
      const entryDocument = readOnly
        && new URL(concretePath(route.path, identities), contentOrigin).pathname === "/";
      return {
        allow: readOnly ? null : "GET, HEAD",
        location: null,
        route: `${route.method} ${route.path}`,
        servesFixture: entryDocument && route.method === "GET",
        setCookie: [],
        status: readOnly ? (entryDocument ? 200 : 404) : 405,
        wwwAuthenticate: null,
      };
    });
    expect(observed).toEqual(expected);

    // The probes changed nothing on the application side.
    const artifact = await fetch(
      new URL(`/api/v1/artifacts/${identities.artifactId}`, server.baseUrl),
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(artifact.status).toBe(200);
    expect(z.object({
      artifact: z.object({
        accessSetting: z.literal("public_link"),
        currentVersionId: z.literal(identities.versionId),
      }).loose(),
    }).loose().parse(await artifact.json())).toBeDefined();
  });
});
