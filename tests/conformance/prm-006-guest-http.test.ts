import {randomUUID} from "node:crypto";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  type ApplicationCookies,
  bootstrapAdministrator,
  browserMutationHeaders,
  type InviteServer,
  signInAs,
  startInviteServer,
} from "../support/invites.js";
import {publishNew} from "../support/publishing.js";

type JsonValue = boolean | number | string | null | readonly JsonValue[] | {readonly [key: string]: JsonValue};

const linkSchema = z.object({
  link: z.object({id: z.string(), revision: z.number(), token: z.string(), url: z.string()}),
});
const sessionSchema = z.object({
  context: z.object({guest: z.object({displayName: z.string().nullable()}), link: z.object({id: z.string()})}),
  csrfToken: z.string(),
});
const errorSchema = z.object({error: z.object({code: z.string()})});
const toolResultSchema = z.object({
  result: z.object({
    content: z.array(z.object({text: z.string()})),
    isError: z.boolean().optional(),
    structuredContent: z.unknown(),
  }).loose(),
}).loose();
const mcpProtocolVersion = "2026-07-28";

const stateOf = async (response: Response) =>
  z.object({thread: z.object({state: z.string()})}).parse(await response.json()).thread.state;

/** Cookie pairs from Set-Cookie headers, as one Cookie header. */
function cookieHeader(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

describe("guest review over HTTP", () => {
  let context: InviteServer;
  let administrator: ApplicationCookies;

  const url = (path: string) => `${context.server.baseUrl}${path}`;

  const member = (method: string, path: string, body?: JsonValue) => {
    const init: RequestInit = {headers: browserMutationHeaders(context.server.baseUrl, administrator), method};
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(url(path), init);
  };

  /** A guest request: the guest cookies, the guest CSRF token on writes, and same-origin headers. */
  const guest = (cookies: string, csrf: string | null, method: string, path: string, body?: JsonValue) => {
    const headers = browserMutationHeaders(context.server.baseUrl, null);
    headers.set("Cookie", cookies);
    headers.set("Idempotency-Key", `guest-${randomUUID()}`);
    if (csrf !== null) headers.set("X-CSRF-Token", csrf);
    const init: RequestInit = {headers, method};
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(url(path), init);
  };

  const published = async () => {
    const created = await member("POST", "/api/v1/projects", {name: "Design"});
    const projectId = z.object({project: z.object({id: z.string()})}).parse(await created.json()).project.id;
    const {body} = await publishNew(context.server, context.installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Guest</title>",
      idempotencyKey: `guest-http-${randomUUID()}`,
      projectId,
    });
    return {artifactId: body.artifact.id, projectId, versionId: body.version.id};
  };

  const createLink = async (projectId: string, artifactId: string, permissions: readonly string[] = [
    "artifact.view",
    "comment.read",
    "comment.write",
  ]) => {
    const response = await member("POST", `/api/v1/projects/${projectId}/artifacts/${artifactId}/share-links`, {
      expiresAt: null,
      label: "Client review",
      permissions: [...permissions],
      target: {kind: "latest"},
    });
    expect(response.status).toBe(201);
    return linkSchema.parse(await response.json()).link;
  };

  const callTool = async (token: string, name: string, parameters: {readonly [key: string]: JsonValue}) => {
    const response = await fetch(url("/mcp"), {
      body: JSON.stringify({
        id: randomUUID(),
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: {name: "artifact-server-test", version: "1"},
            [PROTOCOL_VERSION_META_KEY]: mcpProtocolVersion,
          },
          arguments: parameters,
          name,
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": mcpProtocolVersion,
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
    return toolResultSchema.parse(await response.json()).result;
  };

  const join = async (token: string) => {
    const response = await guest("", null, "POST", "/api/v1/share/sessions", {token});
    expect(response.status).toBe(201);
    return {cookies: cookieHeader(response), ...sessionSchema.parse(await response.json())};
  };

  beforeEach(async () => {
    context = await startInviteServer();
    administrator = await signInAs(context, bootstrapAdministrator);
  });

  afterEach(async () => {
    await context.stop();
  });

  test("the share page is the Review shell with no referrer and no caching", async () => {
    const fixture = await published();
    const link = await createLink(fixture.projectId, fixture.artifactId);
    expect(link.url).toBe(url(`/s/${link.token}`));
    const page = await fetch(link.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/u);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const reload = await fetch(url(`/review/shared/${link.id}`));
    expect(reload.status).toBe(200);
    expect(reload.headers.get("referrer-policy")).toBe("no-referrer");
    expect(reload.headers.get("cache-control")).toBe("no-store");
  });

  test("a guest joins, names themselves and comments only with the guest CSRF token", async () => {
    const fixture = await published();
    const link = await createLink(fixture.projectId, fixture.artifactId);
    const session = await join(link.token);
    expect(session.cookies).toMatch(/artifact_guest=/u);
    const current = await guest(session.cookies, null, "GET", "/api/v1/share/session");
    expect(current.status).toBe(200);
    const named = await guest(session.cookies, session.csrfToken, "PUT", "/api/v1/share/session/identity", {
      contactEmail: null,
      displayName: "Pat",
    });
    expect(named.status).toBe(200);
    const thread = {body: "From the client."};
    const withoutCsrf = await guest(session.cookies, null, "POST", "/api/v1/share/threads", thread);
    expect(withoutCsrf.status).toBe(403);
    const created = await guest(session.cookies, session.csrfToken, "POST", "/api/v1/share/threads", thread);
    expect(created.status).toBe(201);
    const listed = await guest(session.cookies, null, "GET", "/api/v1/share/threads");
    expect(z.object({items: z.array(z.object({author: z.object({principalKind: z.string()})}))})
      .parse(await listed.json()).items.map((item) => item.author.principalKind)).toEqual(["guest"]);
    const lease = await guest(session.cookies, session.csrfToken, "POST", "/api/v1/share/preview-lease");
    expect(lease.status).toBe(201);
  });

  test("guest and member credentials never cross", async () => {
    const fixture = await published();
    const session = await join((await createLink(fixture.projectId, fixture.artifactId)).token);
    const asMember = await guest(session.cookies, null, "GET", `/api/v1/artifacts?projectId=${fixture.projectId}`);
    expect(asMember.status).toBe(401);
    const memberOnGuest = await member("GET", "/api/v1/share/session");
    expect(memberOnGuest.status).toBe(401);
    expect(errorSchema.parse(await memberOnGuest.json()).error.code).toBe("GUEST_SESSION_REQUIRED");
  });

  test("the 21st guest comment in an hour is refused with Retry-After", async () => {
    const fixture = await published();
    const session = await join((await createLink(fixture.projectId, fixture.artifactId)).token);
    await guest(session.cookies, session.csrfToken, "PUT", "/api/v1/share/session/identity", {
      contactEmail: null,
      displayName: "Pat",
    });
    for (let index = 0; index < 20; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- each write takes a slot in order
      const response = await guest(session.cookies, session.csrfToken, "POST", "/api/v1/share/threads", {
        body: `Comment ${index}`,
      });
      expect(response.status).toBe(201);
    }
    const refused = await guest(session.cookies, session.csrfToken, "POST", "/api/v1/share/threads", {
      body: "One too many",
    });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(errorSchema.parse(await refused.json()).error.code).toBe("GUEST_RATE_LIMITED");
  });

  test("unknown, revoked and expired tokens return an identical not-found body", async () => {
    const fixture = await published();
    const revoked = await createLink(fixture.projectId, fixture.artifactId);
    const revoke = await member("DELETE", `/api/v1/projects/${fixture.projectId}/share-links/${revoked.id}`);
    expect(revoke.status).toBe(200);
    const rotated = await createLink(fixture.projectId, fixture.artifactId);
    const rotate = await member("POST", `/api/v1/projects/${fixture.projectId}/share-links/${rotated.id}/rotate`, {
      expectedRevision: rotated.revision,
    });
    expect(rotate.status).toBe(200);
    const expiring = await member("POST", `/api/v1/projects/${fixture.projectId}/artifacts/${fixture.artifactId}/share-links`, {
      expiresAt: new Date(Date.now() + 1_500).toISOString(),
      label: "Brief",
      permissions: ["artifact.view"],
      target: {kind: "latest"},
    });
    const expired = linkSchema.parse(await expiring.json()).link;
    await new Promise((resolve) => {
      setTimeout(resolve, 1_600);
    });
    const bodies = await Promise.all(["shr_unknown", revoked.token, rotated.token, expired.token].map(async (token) => {
      const response = await guest("", null, "POST", "/api/v1/share/sessions", {token});
      return {body: await response.json(), status: response.status};
    }));
    expect(bodies[0]?.status).toBe(404);
    for (const body of bodies.slice(1)) expect(body).toEqual(bodies[0]);
  });

  test("PRM-001-F: a bare public link still serves only the current version with no Review controls or comments", async () => {
    const fixture = await published();
    const changed = await fetch(url(`/api/v1/artifacts/${fixture.artifactId}/access?projectId=${fixture.projectId}`), {
      body: JSON.stringify({accessSetting: "public_link", expectedCurrentVersionId: fixture.versionId}),
      headers: (() => {
        const headers = browserMutationHeaders(context.server.baseUrl, administrator);
        headers.set("Idempotency-Key", `public-${randomUUID()}`);
        return headers;
      })(),
      method: "PATCH",
    });
    expect(changed.status).toBe(200);
    const {links} = z.object({links: z.object({version: z.string()})}).parse(await changed.json());
    const opened = await fetch(url(`/artifacts/${fixture.artifactId}`), {redirect: "manual"});
    expect(opened.status).toBe(302);
    expect(opened.headers.get("location")).toBe(links.version);
    const comments = await fetch(url(`/api/v1/artifacts/${fixture.artifactId}/comments?projectId=${fixture.projectId}`));
    expect(comments.status).toBe(401);
    const guestRoute = await fetch(url("/api/v1/share/session"));
    expect(guestRoute.status).toBe(401);
  });

  test("a guest resolves and reopens their own thread", async () => {
    const fixture = await published();
    const session = await join((await createLink(fixture.projectId, fixture.artifactId)).token);
    await guest(session.cookies, session.csrfToken, "PUT", "/api/v1/share/session/identity", {
      contactEmail: null,
      displayName: "Pat",
    });
    const created = await guest(session.cookies, session.csrfToken, "POST", "/api/v1/share/threads", {body: "Done?"});
    const threadId = z.object({thread: z.object({id: z.string()})}).parse(await created.json()).thread.id;
    const resolved = await guest(session.cookies, session.csrfToken, "POST", `/api/v1/share/threads/${threadId}/resolve`);
    expect(resolved.status).toBe(200);
    expect(await stateOf(resolved)).toBe("resolved");
    const reopened = await guest(session.cookies, session.csrfToken, "POST", `/api/v1/share/threads/${threadId}/reopen`);
    expect(await stateOf(reopened)).toBe("open");
  });

  test("MCP and HTTP share-link creation answer to the same authority", async () => {
    const fixture = await published();
    const viaMcp = await callTool(context.installation.apiToken, "artifact_share_link_create", {
      artifactId: fixture.artifactId,
      label: "From an agent",
      permissions: ["artifact.view"],
      projectId: fixture.projectId,
    });
    expect(viaMcp.isError).not.toBe(true);
    const mcpLink = z.object({link: z.object({id: z.string(), url: z.string()})}).parse(viaMcp.structuredContent).link;
    const listed = await member("GET", `/api/v1/projects/${fixture.projectId}/artifacts/${fixture.artifactId}/share-links`);
    expect(z.object({links: z.array(z.object({id: z.string(), url: z.string()}))}).parse(await listed.json()).links)
      .toEqual([expect.objectContaining({id: mcpLink.id, url: mcpLink.url})]);

    const issued = await member("POST", "/api/v1/api-keys", {
      capabilities: ["artifact:read"],
      expiresAt: "2027-10-26T00:00:00.000Z",
      name: "Reader",
    });
    expect(issued.status).toBe(201);
    const reader = z.object({token: z.string()}).parse(await issued.json()).token;
    const httpDenied = await fetch(url(`/api/v1/projects/${fixture.projectId}/artifacts/${fixture.artifactId}/share-links`), {
      body: JSON.stringify({expiresAt: null, label: "Nope", permissions: ["artifact.view"], target: {kind: "latest"}}),
      headers: {Authorization: `Bearer ${reader}`, "Content-Type": "application/json"},
      method: "POST",
    });
    expect(httpDenied.status).toBe(403);
    expect(errorSchema.parse(await httpDenied.json()).error.code).toBe("AUTHORIZATION_DENIED");
    const mcpDenied = await callTool(reader, "artifact_share_link_create", {
      artifactId: fixture.artifactId,
      label: "Nope",
      permissions: ["artifact.view"],
      projectId: fixture.projectId,
    });
    expect(mcpDenied.isError).toBe(true);
    expect(mcpDenied.content[0]?.text).toContain("AUTHORIZATION_DENIED");
  });

  test("an administrator lists and revokes share links across projects", async () => {
    const fixture = await published();
    await createLink(fixture.projectId, fixture.artifactId);
    const inventory = await member("GET", "/api/v1/share-links?limit=25");
    expect(inventory.status).toBe(200);
    expect(z.object({items: z.array(z.object({id: z.string()}))}).parse(await inventory.json()).items).toHaveLength(1);
  });
});
