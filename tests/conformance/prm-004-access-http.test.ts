import {randomUUID} from "node:crypto";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  type ApplicationCookies,
  bootstrapAdministrator,
  browserMutationHeaders,
  type InviteServer,
  type Person,
  signInAs,
  startInviteServer,
} from "../support/invites.js";
import {publishNew} from "../support/publishing.js";

const personOf = (name: string): Person => ({
  displayName: name,
  email: `${name.toLowerCase()}@acme.test`,
  subject: `workos-${name.toLowerCase()}`,
});

const memberSchema = z.object({member: z.object({id: z.string()})});
const projectSchema = z.object({project: z.object({id: z.string()})});
const errorSchema = z.object({error: z.object({code: z.string()})});

type JsonValue = boolean | number | string | null | readonly JsonValue[] | {readonly [key: string]: JsonValue};
type RequestBody = {readonly [key: string]: JsonValue};

describe("access administration over HTTP", () => {
  let context: InviteServer;
  let administrator: ApplicationCookies;

  /** One browser request; the body is a JSON value serialized for the wire. */
  const call = (cookies: ApplicationCookies | null, method: string, path: string, body?: RequestBody) => {
    const init: RequestInit = {headers: browserMutationHeaders(context.server.baseUrl, cookies), method};
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(`${context.server.baseUrl}${path}`, init);
  };

  const admit = async (name: string): Promise<{cookies: ApplicationCookies; id: string}> => {
    const person = personOf(name);
    const response = await call(administrator, "POST", "/api/v1/members", {
      displayName: person.displayName,
      email: person.email,
    });
    expect(response.status).toBe(201);
    const {member} = memberSchema.parse(await response.json());
    return {cookies: await signInAs(context, person), id: member.id};
  };

  const createProject = async (name: string): Promise<string> => {
    const response = await call(administrator, "POST", "/api/v1/projects", {name});
    expect(response.status).toBe(201);
    return projectSchema.parse(await response.json()).project.id;
  };

  const restrict = async (projectId: string) => {
    const read = await call(administrator, "GET", `/api/v1/projects/${projectId}/access`);
    const {access} = z.object({access: z.object({revision: z.number()})}).parse(await read.json());
    const attempt = await call(administrator, "PATCH", `/api/v1/projects/${projectId}/access`, {
      accessMode: "restricted",
      confirmMembersLosingAccess: null,
      defaultMemberRole: "editor",
      expectedRevision: access.revision,
    });
    if (attempt.status === 200) return;
    const refused = z.object({error: z.object({details: z.object({membersLosingAccess: z.number()})})})
      .parse(await attempt.json());
    const confirmed = await call(administrator, "PATCH", `/api/v1/projects/${projectId}/access`, {
      accessMode: "restricted",
      confirmMembersLosingAccess: refused.error.details.membersLosingAccess,
      defaultMemberRole: "editor",
      expectedRevision: access.revision,
    });
    expect(confirmed.status).toBe(200);
  };

  beforeEach(async () => {
    context = await startInviteServer();
    administrator = await signInAs(context, bootstrapAdministrator);
  });

  afterEach(async () => {
    await context.stop();
  });

  test("a manager round-trips project access and a grant", async () => {
    const projectId = await createProject("Design");
    const dana = await admit("Dana");
    const sam = await admit("Sam");
    const granted = await call(administrator, "PUT", `/api/v1/projects/${projectId}/grants/${dana.id}`, {
      add: [],
      expectedRevision: null,
      expiresAt: null,
      remove: [],
      role: "manager",
    });
    expect(granted.status).toBe(200);

    const toSam = await call(dana.cookies, "PUT", `/api/v1/projects/${projectId}/grants/${sam.id}`, {
      add: [],
      expectedRevision: null,
      expiresAt: null,
      remove: [],
      role: "viewer",
    });
    expect(toSam.status).toBe(200);
    expect(await toSam.json()).toMatchObject({grant: {memberId: sam.id, revision: 1, role: "viewer"}});

    const read = await call(dana.cookies, "GET", `/api/v1/projects/${projectId}/access`);
    expect(read.status).toBe(200);
    const body = z.object({
      access: z.object({accessMode: z.string()}),
      grants: z.array(z.object({memberId: z.string()})),
      members: z.array(z.object({effectiveRole: z.string(), memberId: z.string()})),
    }).parse(await read.json());
    expect(body.grants.map((grant) => grant.memberId).toSorted()).toEqual([dana.id, sam.id].toSorted());
    expect(body.members.find((member) => member.memberId === sam.id)?.effectiveRole).toBe("viewer");

    const removed = await call(dana.cookies, "DELETE", `/api/v1/projects/${projectId}/grants/${sam.id}?expectedRevision=1`);
    expect(removed.status).toBe(204);

    const explained = await call(administrator, "GET", `/api/v1/projects/${projectId}/access/effective?subject=${dana.id}`);
    expect(await explained.json()).toMatchObject({
      sources: [expect.objectContaining({layer: "project_grant", role: "manager"})],
      subject: {id: dana.id},
    });
  });

  test("a member writing grants on a project they cannot see gets 404, not 403", async () => {
    const projectId = await createProject("Secret");
    const sam = await admit("Sam");
    await restrict(projectId);
    const response = await call(sam.cookies, "PUT", `/api/v1/projects/${projectId}/grants/${sam.id}`, {
      add: [],
      expectedRevision: null,
      expiresAt: null,
      remove: [],
      role: "manager",
    });
    expect(response.status).toBe(404);
    expect(errorSchema.parse(await response.json()).error.code).toBe("PROJECT_NOT_FOUND");
  });

  test("a grant change without a CSRF token is refused and changes nothing", async () => {
    const projectId = await createProject("Design");
    const sam = await admit("Sam");
    const response = await fetch(`${context.server.baseUrl}/api/v1/projects/${projectId}/grants/${sam.id}`, {
      body: JSON.stringify({add: [], expectedRevision: null, expiresAt: null, remove: [], role: "none"}),
      headers: {
        "Content-Type": "application/json",
        Cookie: administrator.header,
        Origin: context.server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
      method: "PUT",
    });
    expect(response.status).toBe(403);
    const read = await call(administrator, "GET", `/api/v1/projects/${projectId}/access`);
    expect(z.object({grants: z.array(z.unknown())}).parse(await read.json()).grants).toEqual([]);
  });

  test("PRM-010-B: the artifact access route returns the caller's sorted permissions", async () => {
    const projectId = await createProject("Design");
    const {body: published} = await publishNew(context.server, context.installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Access</title>",
      idempotencyKey: `access-${randomUUID()}`,
      projectId,
    });
    const sam = await admit("Sam");
    await call(administrator, "PUT", `/api/v1/projects/${projectId}/grants/${sam.id}`, {
      add: [],
      expectedRevision: null,
      expiresAt: null,
      remove: [],
      role: "commenter",
    });
    const response = await call(sam.cookies, "GET", `/api/v1/projects/${projectId}/artifacts/${published.artifact.id}/access`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      permissions: ["artifact.history", "artifact.view", "comment.read", "comment.write"],
      subject: {id: sam.id},
    });
  });

  test("PRM-010-F: an operation behind a hidden control is still refused by the server", async () => {
    const projectId = await createProject("Design");
    const {body: published} = await publishNew(context.server, context.installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Rename</title>",
      idempotencyKey: `rename-${randomUUID()}`,
      name: "Original",
      projectId,
    });
    const sam = await admit("Sam");
    await call(administrator, "PUT", `/api/v1/projects/${projectId}/grants/${sam.id}`, {
      add: [],
      expectedRevision: null,
      expiresAt: null,
      remove: [],
      role: "viewer",
    });
    const response = await fetch(
      `${context.server.baseUrl}/api/v1/artifacts/${published.artifact.id}/name?projectId=${projectId}`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId: published.version.id,
          expectedName: "Original",
          name: "Renamed by a viewer",
        }),
        headers: (() => {
          const headers = browserMutationHeaders(context.server.baseUrl, sam.cookies);
          headers.set("Idempotency-Key", `viewer-rename-${randomUUID()}`);
          return headers;
        })(),
        method: "PATCH",
      },
    );
    expect(response.status).toBe(403);
    expect(errorSchema.parse(await response.json()).error.code).toBe("AUTHORIZATION_DENIED");
  });

  test("a key issued for one project over HTTP cannot list another", async () => {
    const projectA = await createProject("A");
    const projectB = await createProject("B");
    const issued = await call(administrator, "POST", "/api/v1/api-keys", {
      capabilities: ["artifact:read"],
      expiresAt: "2027-10-26T00:00:00.000Z",
      name: "A only",
      projectIds: [projectA],
    });
    expect(issued.status).toBe(201);
    const {token} = z.object({token: z.string()}).parse(await issued.json());
    const list = (projectId: string) => fetch(
      `${context.server.baseUrl}/api/v1/artifacts?projectId=${projectId}`,
      {headers: {Authorization: `Bearer ${token}`}},
    );
    expect((await list(projectA)).status).toBe(200);
    expect((await list(projectB)).status).toBe(404);
  });
});
