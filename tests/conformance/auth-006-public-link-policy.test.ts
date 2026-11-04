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
  applicationCookies,
  bootstrapAdministrator,
  browserMutationHeaders,
  createInvite,
  type InviteServer,
  redeem,
  signInAs,
  startInviteServer,
} from "../support/invites.js";
import {publishNew} from "../support/publishing.js";
import {fetchVersion} from "../support/runtime-harness.js";

const protocolVersion = "2026-07-28";

const storedPolicySchema = z.object({
  policy: z.object({
    policy: z.object({
      shareLinks: z.object({enabled: z.boolean()}).loose(),
    }).loose(),
    revision: z.number().int(),
  }).loose(),
}).loose();

const errorSchema = z.object({error: z.object({code: z.string()}).loose()}).loose();

const issuedKeySchema = z.object({token: z.string().min(1)}).loose();

const toolResultSchema = z.object({
  result: z.object({
    content: z.array(z.object({text: z.string()}).loose()),
    isError: z.boolean().optional(),
  }).loose(),
}).loose();

interface PublishedArtifact {
  readonly artifactId: string;
  readonly versionId: string;
  readonly versionUrl: string;
}

/** A caller of the application: a browser session or a bearer credential. */
type Caller =
  | {readonly cookies: ApplicationCookies; readonly kind: "browser"}
  | {readonly kind: "bearer"; readonly token: string};

type JsonValue =
  | boolean
  | number
  | string
  | null
  | readonly JsonValue[]
  | {readonly [key: string]: JsonValue};

async function status(response: Response): Promise<number> {
  await response.arrayBuffer();
  return response.status;
}

describe("administrators can disable public links for the installation", () => {
  let context: InviteServer;
  let administrator: Caller;

  beforeEach(async () => {
    context = await startInviteServer();
    administrator = {cookies: await signInAs(context, bootstrapAdministrator), kind: "browser"};
  });

  afterEach(async () => {
    await context.stop();
  });

  function request(caller: Caller, method: string, route: string, body?: JsonValue): Promise<Response> {
    const headers = caller.kind === "browser"
      ? browserMutationHeaders(context.server.baseUrl, caller.cookies)
      : new Headers({Authorization: `Bearer ${caller.token}`, "Content-Type": "application/json"});
    headers.set("Idempotency-Key", `auth-006-${randomUUID()}`);
    const init: RequestInit = {headers, method};
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(new URL(route, context.server.baseUrl), init);
  }

  async function writePublicLinks(caller: Caller, enabled: boolean): Promise<number> {
    const read = await request(administrator, "GET", "/api/v1/access-policy");
    expect(read.status).toBe(200);
    const stored = storedPolicySchema.parse(await read.json()).policy;
    return status(await request(caller, "PUT", "/api/v1/access-policy", {
      expectedRevision: stored.revision,
      policy: {...stored.policy, shareLinks: {...stored.policy.shareLinks, enabled}},
    }));
  }

  async function publish(
    accessSetting: "account_required" | "public_link",
    token = context.installation.apiToken,
  ): Promise<PublishedArtifact> {
    const published = await publishNew(context.server, {...context.installation, apiToken: token}, {
      accessSetting,
      content: `<!doctype html><title>${accessSetting} ${randomUUID()}</title>`,
      idempotencyKey: `auth-006-publish-${randomUUID()}`,
    });
    return {
      artifactId: published.body.artifact.id,
      versionId: published.body.version.id,
      versionUrl: published.body.links.version,
    };
  }

  /** Returns "changed", or the refusal's status and error code. */
  async function makePublic(caller: Caller, artifact: PublishedArtifact): Promise<string> {
    const response = await request(caller, "PATCH", `/api/v1/artifacts/${artifact.artifactId}/access`, {
      accessSetting: "public_link",
      expectedCurrentVersionId: artifact.versionId,
    });
    if (response.ok) {
      await response.arrayBuffer();
      return "changed";
    }
    return `${response.status} ${errorSchema.parse(await response.json()).error.code}`;
  }

  async function makePublicThroughMcp(token: string, artifact: PublishedArtifact): Promise<string> {
    const response = await fetch(new URL("/mcp", context.server.baseUrl), {
      body: JSON.stringify({
        id: randomUUID(),
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: {name: "auth-006-test", version: "1"},
            [PROTOCOL_VERSION_META_KEY]: protocolVersion,
          },
          arguments: {
            accessSetting: "public_link",
            artifactId: artifact.artifactId,
            expectedCurrentVersionId: artifact.versionId,
            idempotencyKey: `auth-006-mcp-${randomUUID()}`,
            projectId: "prj_default",
          },
          name: "artifact_set_visibility",
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "artifact_set_visibility",
        "MCP-Protocol-Version": protocolVersion,
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
    const {result} = toolResultSchema.parse(await response.json());
    return result.isError === true ? (result.content[0]?.text ?? "refused") : "changed";
  }

  async function anonymousRead(artifact: PublishedArtifact) {
    const stable = await fetch(
      new URL(`/artifacts/${artifact.artifactId}`, context.server.baseUrl),
      {redirect: "manual"},
    );
    return {
      content: await status(await fetchVersion(context.server, artifact.versionUrl)),
      stableLink: await status(stable),
    };
  }

  const publiclyReadable = {content: 200, stableLink: 302};
  const notPubliclyReadable = {content: 401, stableLink: 401};

  test("AUTH-006-B: disabling public links stops existing public artifacts from being read anonymously and keeps any artifact from becoming publicly readable", async () => {
    const existing = await publish("public_link");
    const privateArtifact = await publish("account_required");
    expect(await anonymousRead(existing)).toEqual(publiclyReadable);

    expect(await writePublicLinks(administrator, false)).toBe(200);

    // The existing public artifact stops being publicly readable at once.
    expect(await anonymousRead(existing)).toEqual(notPubliclyReadable);
    // A newly published "public" artifact is not publicly readable.
    expect(await anonymousRead(await publish("public_link"))).toEqual(notPubliclyReadable);
    // Even the administrator cannot make an artifact public under the policy.
    expect(await makePublic(administrator, privateArtifact)).toBe("403 SHARE_LINKS_DISABLED");
    expect(await anonymousRead(privateArtifact)).toEqual(notPubliclyReadable);

    // The policy, not a rewrite of stored settings, did this: re-enabling
    // public links restores the existing artifact's public reads.
    expect(await writePublicLinks(administrator, true)).toBe(200);
    expect(await anonymousRead(existing)).toEqual(publiclyReadable);
  });

  test("AUTH-006-F: members, API keys, and MCP agents cannot bypass the administrator's public-link policy", async () => {
    const adminCookies = administrator.kind === "browser" ? administrator.cookies : null;
    if (adminCookies === null) throw new Error("The administrator signs in through the browser.");
    const invite = await createInvite(context, adminCookies, {expiresIn: "7d", kind: "link", maxUses: 1});
    const joined = await redeem(context, invite.token, {
      displayName: "Sam Rivera",
      email: "sam@acme.test",
      subject: "sam",
    });
    expect(joined.status).toBe(303);
    const member: Caller = {cookies: applicationCookies(joined.headers.getSetCookie()), kind: "browser"};

    const issued = await request(administrator, "POST", "/api/v1/api-keys", {
      capabilities: ["artifact:create", "artifact:manage:any", "artifact:read"],
      expiresAt: "2099-01-01T00:00:00.000Z",
      name: "Agent key",
    });
    expect(issued.status).toBe(201);
    const agentKey = issuedKeySchema.parse(await issued.json()).token;
    const key: Caller = {kind: "bearer", token: agentKey};

    // Control: while public links are allowed, the key and its MCP agent can
    // make an artifact public, so a later refusal comes from the policy.
    expect(await makePublic(key, await publish("account_required", agentKey))).toBe("changed");
    expect(await makePublicThroughMcp(agentKey, await publish("account_required", agentKey))).toBe("changed");

    expect(await writePublicLinks(administrator, false)).toBe(200);
    const target = await publish("account_required", agentKey);

    // Neither a member nor a key can lift or rewrite the policy.
    expect(await writePublicLinks(member, true)).toBe(403);
    expect(await writePublicLinks(key, true)).toBe(403);
    // Nobody can make an artifact public through HTTP or MCP.
    expect(await makePublic(member, target)).toBe("403 SHARE_LINKS_DISABLED");
    expect(await makePublic(key, target)).toBe("403 SHARE_LINKS_DISABLED");
    expect(await makePublicThroughMcp(agentKey, target)).toMatch(/share links|public links/iu);
    // An artifact a key publishes as public is not publicly readable.
    expect(await anonymousRead(await publish("public_link", agentKey))).toEqual(notPubliclyReadable);
    expect(await anonymousRead(target)).toEqual(notPubliclyReadable);

    const policy = await request(administrator, "GET", "/api/v1/access-policy");
    expect(storedPolicySchema.parse(await policy.json()).policy.policy.shareLinks.enabled).toBe(false);
  });
});
