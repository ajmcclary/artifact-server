import {afterAll, beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createKeycloakUser,
  deleteKeycloakUser,
  keycloakRealm,
  provisionKeycloakRealm,
  requestPasswordToken,
} from "../support/keycloak-realm.js";
import {
  issuedSession,
  mutationHeaders,
  packagedApplicationOrigin,
  publishThroughReplica,
  type ReplicaClient,
  replicaClient,
  type SessionCookies,
  sessionCookies,
  signInThroughProvider,
} from "../support/private-team/application-client.js";
import {
  type PrivateTeamIdentity,
  readPrivateTeamIdentity,
} from "../support/private-team/identity-environment.js";
import {
  type PrivateTeamRuntime,
  selectPrivateTeamRuntime,
  type StartupRefusal,
} from "../support/private-team/runtime.js";

/**
 * Private-team acceptance on one packaged runtime. Each packaged harness
 * includes this file and names its runtime in ARTIFACT_SERVER_PRIVATE_TEAM_TARGET;
 * the evidence report it writes is that deployment's proof.
 */
/** AUTH-022: another replica may serve a cached decision for at most 30 seconds. */
const cacheBoundMilliseconds = 30_000;
/** Polling interval plus request time; refusal must still land within the bound. */
const cacheBoundSlackMilliseconds = 3_000;
// Decided at collection time, before any runtime exists: only compact Compose is single-replica.
const multiReplica = process.env["ARTIFACT_SERVER_PRIVATE_TEAM_TARGET"] !== "compact-compose";
const member = {
  displayName: "Team Member",
  email: "member@example.test",
  password: "member-keycloak-integration-only",
};
const outsider = {
  email: "outsider@example.test",
  password: "outsider-keycloak-integration-only",
};
const sessionSchema = z.object({
  principal: z.object({id: z.string(), kind: z.literal("human")}).loose(),
}).loose();
const failureSchema = z.object({error: z.object({code: z.string()}).loose()}).loose();
const admittedSchema = z.object({member: z.object({id: z.string()}).loose()}).loose();
const issuedKeySchema = z.object({
  apiKey: z.object({id: z.string(), principalId: z.string()}).loose(),
  token: z.string().startsWith("as_key_"),
}).loose();
const threadSchema = z.object({thread: z.object({id: z.string()}).loose()}).loose();
const memberListSchema = z.object({
  members: z.array(z.object({id: z.string(), status: z.string()}).loose()),
}).loose();

let identity: PrivateTeamIdentity;
let runtime: PrivateTeamRuntime;
let providerSubjects: ReadonlyMap<string, string> = new Map();
let deactivatedMember: {
  readonly id: string;
  readonly key: string;
  readonly session: string;
  readonly work: MemberWork;
} | null = null;

beforeAll(async () => {
  identity = await readPrivateTeamIdentity();
  runtime = await selectPrivateTeamRuntime(identity);
  providerSubjects = (await provisionKeycloakRealm(identity.keycloak, packagedApplicationOrigin, [
    {
      email: runtime.bootstrapAdministrator.email,
      firstName: "Ada",
      lastName: "Lovelace",
      password: runtime.bootstrapAdministrator.password,
      username: runtime.bootstrapAdministrator.email,
    },
    {
      email: member.email,
      firstName: "Team",
      lastName: "Member",
      password: member.password,
      username: member.email,
    },
    {
      email: outsider.email,
      firstName: "Out",
      lastName: "Sider",
      password: outsider.password,
      username: outsider.email,
    },
  ])).subjects;
  await runtime.start();
}, 600_000);

afterAll(async () => {
  await runtime?.destroy();
}, 300_000);

describe.sequential(
  `private-team access on ${process.env["ARTIFACT_SERVER_PRIVATE_TEAM_TARGET"] ?? "an unnamed runtime"}`,
  () => {
    test("AUTH-025-B: the packaged runtime bootstraps its administrator through the provider and admits only managed or provider-bound automation", async () => {
      const first = firstReplica();
      // Discovery over the private CA succeeded, so MCP OAuth is on.
      expect(await runtime.startupLogs()).not.toContain("discovery_failed");

      await expect((await first.fetch("/auth/context")).json()).resolves.toEqual({
        accessMode: "private_team",
        login: {kind: "oidc"},
      });

      const administratorLogin = await signInThroughProvider(first, identity, {
        password: runtime.bootstrapAdministrator.password,
        username: runtime.bootstrapAdministrator.email,
      });
      expect(administratorLogin.status).toBe(303);
      const administrator = sessionCookies(administratorLogin.headers.getSetCookie());
      const session = await first.fetch("/api/v1/session", {
        headers: {Cookie: administrator.header},
      });
      expect(session.status).toBe(200);
      sessionSchema.parse(await session.json());
      expect(await runtime.externalIdentityCount(runtime.bootstrapAdministrator.email))
        .toBe(1);

      // The managed machine key is request authority; a browser session is not MCP authority.
      expect((await first.fetch("/api/v1/artifacts", {
        headers: {Authorization: `Bearer ${runtime.serviceKey}`},
      })).status).toBe(200);
      expect((await callMcp(first, {cookie: administrator.header})).status).toBe(401);

      // A provider token bound to the exact /mcp resource is MCP authority and nothing else.
      const issuer = `${identity.keycloak.baseUrl}/realms/${keycloakRealm.name}`;
      const administratorCredentials = {
        password: runtime.bootstrapAdministrator.password,
        username: runtime.bootstrapAdministrator.email,
      };
      const bound = await requestPasswordToken(
        identity.keycloak,
        issuer,
        keycloakRealm.mcpClientId,
        keycloakRealm.mcpClientSecret,
        administratorCredentials,
      );
      expect((await callMcp(first, {token: bound})).status).toBe(200);
      expect((await first.fetch("/api/v1/artifacts", {
        headers: {Authorization: `Bearer ${bound}`},
      })).status).toBe(401);
      const unbound = await requestPasswordToken(
        identity.keycloak,
        issuer,
        keycloakRealm.unboundClientId,
        keycloakRealm.unboundClientSecret,
        administratorCredentials,
      );
      expect((await callMcp(first, {token: unbound})).status).toBe(401);

      // Only the bootstrap email could create the first member; an outsider stays out.
      const outsiderLogin = await signInThroughProvider(first, identity, {
        password: outsider.password,
        username: outsider.email,
      });
      expect(outsiderLogin.status).toBe(403);
      expect(issuedSession(outsiderLogin)).toBe(false);
      expect(failureSchema.parse(await outsiderLogin.json()).error.code)
        .toBe("IDENTITY_ADMISSION_DENIED");
      expect(await runtime.externalIdentityCount(outsider.email)).toBe(0);
    });

    test("AUTH-025-F: misconfigured providers, local bootstrap credentials, the legacy bearer, and foreign hosts grant no authority", async () => {
      const first = firstReplica();
      expect((await first.fetch("/auth/local-owner", {
        headers: {
          Origin: packagedApplicationOrigin,
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
        },
        method: "POST",
      })).status).toBe(404);
      for (const stray of await runtime.strayCredentials()) {
        // Each stray credential is checked on its own so a failure names it.
        // eslint-disable-next-line no-await-in-loop
        const exchange = await first.fetch("/auth/local", {
          headers: {Authorization: `Bearer ${stray.token}`},
          method: "POST",
        });
        // eslint-disable-next-line no-await-in-loop
        const bearer = await first.fetch("/api/v1/artifacts", {
          headers: {Authorization: `Bearer ${stray.token}`},
        });
        expect({exchange: exchange.status, name: stray.name, bearer: bearer.status})
          .toEqual({exchange: 404, name: stray.name, bearer: 401});
      }
      expect((await first.fetch("/api/v1/artifacts", {
        headers: {Authorization: "Bearer legacy-installation-bearer-with-sufficient-entropy"},
      })).status).toBe(401);

      // Rejecting other hosts is the ingress's job; behind it, a hostile Host
      // still cannot change the installation or storage scope a request sees,
      // and MCP answers only for the management host.
      const foreign = replicaClient(first.port, "evil.example");
      const serviceHeaders = {Authorization: `Bearer ${runtime.serviceKey}`};
      const [managementList, foreignList] = await Promise.all([
        first.fetch("/api/v1/artifacts", {headers: serviceHeaders}).then((response) => response.json()),
        foreign.fetch("/api/v1/artifacts", {headers: serviceHeaders}).then((response) => response.json()),
      ]);
      expect(foreignList).toEqual(managementList);
      expect((await callMcp(foreign, {token: runtime.serviceKey})).status).not.toBe(200);

      await runtime.stop();
      const noProvider = await runtime.expectStartupRefused({
        ARTIFACT_SERVER_OIDC_CLIENT_ID: null,
        ARTIFACT_SERVER_OIDC_CLIENT_SECRET: null,
        ARTIFACT_SERVER_OIDC_ISSUER: null,
        ARTIFACT_SERVER_OIDC_SCOPES: null,
      });
      // The process and the Helm chart word the same refusal differently.
      expect(refusalText(noProvider)).toMatch(
        /A private-team server requires exactly one OIDC or WorkOS browser-login provider\.|private-team deployments require exactly one browser-login provider/u,
      );
      const twoProviders = await runtime.expectStartupRefused({
        ARTIFACT_SERVER_WORKOS_CLIENT_ID: "client_conflicting_provider",
        ARTIFACT_SERVER_WORKOS_ISSUER: "https://api.workos.com",
      });
      expect(refusalText(twoProviders)).toMatch(/one installation has one browser-login provider/iu);
      const localBootstrap = await runtime.expectStartupRefused({
        ARTIFACT_SERVER_LOCAL_BOOTSTRAP_TOKEN: "local-bootstrap-credential-".padEnd(43, "x"),
      });
      // Either the process refuses the variable, or the package cannot deliver it at all.
      expect(localBootstrap.kind === "unconfigurable"
        ? `unconfigurable ${localBootstrap.variable}`
        : localBootstrap.message).toMatch(
        /^unconfigurable ARTIFACT_SERVER_LOCAL_BOOTSTRAP_TOKEN$|A private-team server does not accept ARTIFACT_SERVER_LOCAL_BOOTSTRAP_TOKEN/u,
      );
      await runtime.start();
      expect((await firstReplica().fetch("/api/v1/artifacts", {
        headers: {Authorization: `Bearer ${runtime.serviceKey}`},
      })).status).toBe(200);
    });

    test.runIf(multiReplica)("AUTH-027-B: deactivation stops provider login, sessions, and member keys on every replica within the cache bound", async () => {
      const [first, second] = twoReplicas();
      const administrator = sessionCookies((await signInThroughProvider(first, identity, {
        password: runtime.bootstrapAdministrator.password,
        username: runtime.bootstrapAdministrator.email,
      })).headers.getSetCookie());

      const admittedResponse = await first.fetch("/api/v1/members", {
        body: JSON.stringify({displayName: member.displayName, email: member.email}),
        headers: mutationHeaders(administrator),
        method: "POST",
      });
      expect(admittedResponse.status).toBe(201);
      const admitted = admittedSchema.parse(await admittedResponse.json()).member;
      const memberLogin = await signInThroughProvider(first, identity, {
        password: member.password,
        username: member.email,
      });
      expect(memberLogin.status).toBe(303);
      const memberSession = sessionCookies(memberLogin.headers.getSetCookie());
      const issued = await first.fetch("/api/v1/api-keys", {
        body: JSON.stringify({
          capabilities: ["artifact:read", "artifact:create", "comment:write"],
          expiresAt: "2099-01-01T00:00:00.000Z",
          memberId: admitted.id,
          name: "Member automation key",
        }),
        headers: mutationHeaders(administrator),
        method: "POST",
      });
      expect(issued.status).toBe(201);
      const memberKey = issuedKeySchema.parse(await issued.json());
      expect(memberKey.apiKey.principalId).toBe(admitted.id);

      // The member leaves durable, attributed work behind.
      const work = await publishAndComment(first, memberKey.token);

      // Warm both credentials on both replicas.
      for (const replica of [first, second]) {
        // eslint-disable-next-line no-await-in-loop
        expect(await credentialStatuses(replica, memberSession.header, memberKey.token))
          .toEqual({key: 200, session: 200});
      }

      expect((await first.fetch(`/api/v1/members/${admitted.id}/deactivate`, {
        headers: mutationHeaders(administrator),
        method: "POST",
      })).status).toBe(200);
      const deactivatedAt = Date.now();

      // The handling process refuses at once.
      expect(await credentialStatuses(first, memberSession.header, memberKey.token))
        .toEqual({key: 401, session: 401});

      // The other replica refuses within the documented authentication-cache bound.
      const refusedAt = await waitForRefusal(
        second,
        memberSession.header,
        memberKey.token,
        deactivatedAt + cacheBoundMilliseconds + cacheBoundSlackMilliseconds,
      );
      expect(refusedAt - deactivatedAt)
        .toBeLessThanOrEqual(cacheBoundMilliseconds + cacheBoundSlackMilliseconds);

      // Provider login is refused without a session or a second binding.
      const relogin = await signInThroughProvider(second, identity, {
        password: member.password,
        username: member.email,
      });
      expect(relogin.status).toBeGreaterThanOrEqual(400);
      expect(issuedSession(relogin)).toBe(false);
      expect(await runtime.externalIdentityCount(member.email)).toBe(1);

      await expectWorkPreserved(second, administrator, work, admitted.id);
      deactivatedMember = {id: admitted.id, key: memberKey.token, session: memberSession.header, work};
    });

    test.runIf(multiReplica)("AUTH-027-F: a deactivated member regains nothing through new bindings, old sessions, keys, or stale caches, and nothing attributed is removed", async () => {
      const [first, second] = twoReplicas();
      if (deactivatedMember === null) throw new Error("AUTH-027-B must run first.");
      const administrator = sessionCookies((await signInThroughProvider(second, identity, {
        password: runtime.bootstrapAdministrator.password,
        username: runtime.bootstrapAdministrator.email,
      })).headers.getSetCookie());

      // The provider account is deleted and recreated with the same email, so
      // it arrives with a new subject; it still cannot bind to the member.
      const originalSubject = providerSubjects.get(member.email);
      if (originalSubject === undefined) throw new Error("The member was never provisioned.");
      await deleteKeycloakUser(identity.keycloak, originalSubject);
      const recreatedSubject = await createKeycloakUser(identity.keycloak, {
        email: member.email,
        firstName: "Team",
        lastName: "Member",
        password: "recreated-keycloak-integration-only",
        username: member.email,
      });
      expect(recreatedSubject).not.toBe(originalSubject);
      const secondAccount = await signInThroughProvider(first, identity, {
        password: "recreated-keycloak-integration-only",
        username: member.email,
      });
      expect(secondAccount.status).toBeGreaterThanOrEqual(400);
      expect(issuedSession(secondAccount)).toBe(false);
      expect(await runtime.externalIdentityCount(member.email)).toBe(1);

      // Long past the bound, nothing the member held authenticates on either
      // replica, no request mints a replacement session, and the service
      // principal and the member's records remain.
      for (const replica of [first, second]) {
        // eslint-disable-next-line no-await-in-loop
        const session = await replica.fetch("/api/v1/session", {
          headers: {Cookie: deactivatedMember.session},
        });
        expect(session.status).toBe(401);
        expect(issuedSession(session)).toBe(false);
        // eslint-disable-next-line no-await-in-loop
        expect((await replica.fetch("/api/v1/artifacts", {
          headers: {Authorization: `Bearer ${deactivatedMember.key}`},
        })).status).toBe(401);
        // eslint-disable-next-line no-await-in-loop
        expect((await replica.fetch("/api/v1/artifacts", {
          headers: {Authorization: `Bearer ${runtime.serviceKey}`},
        })).status).toBe(200);
        // eslint-disable-next-line no-await-in-loop
        const members = memberListSchema.parse(await (await replica.fetch("/api/v1/members", {
          headers: {Cookie: administrator.header},
        })).json()).members;
        expect(members.find((entry) => entry.id === deactivatedMember?.id)?.status)
          .toBe("inactive");
        // eslint-disable-next-line no-await-in-loop
        await expectWorkPreserved(replica, administrator, deactivatedMember.work, deactivatedMember.id);
      }
    });
  },
);

function refusalText(refusal: StartupRefusal): string {
  if (refusal.kind === "unconfigurable") {
    throw new Error(`${refusal.variable} was expected to be configurable on ${runtime.target}.`);
  }
  return refusal.message;
}

function firstReplica(): ReplicaClient {
  const [first] = runtime.replicas;
  if (first === undefined) throw new Error("The runtime exposes no replica.");
  return first;
}

function callMcp(
  client: ReplicaClient,
  credential: {readonly cookie?: string; readonly token?: string},
) {
  const headers: [string, string][] = [
    ["Accept", "application/json, text/event-stream"],
    ["Content-Type", "application/json"],
  ];
  if (credential.token !== undefined) headers.push(["Authorization", `Bearer ${credential.token}`]);
  if (credential.cookie !== undefined) headers.push(["Cookie", credential.cookie]);
  return client.fetch("/mcp", {
    body: JSON.stringify({id: 1, jsonrpc: "2.0", method: "tools/list", params: {}}),
    headers,
    method: "POST",
  });
}

function twoReplicas(): readonly [ReplicaClient, ReplicaClient] {
  const [first, second] = runtime.replicas;
  if (first === undefined || second === undefined) {
    throw new Error("This acceptance test needs two replicas.");
  }
  if (first.port === second.port) throw new Error("Both clients reach the same replica.");
  return [first, second];
}

interface MemberWork {
  readonly artifactId: string;
  readonly threadId: string;
  readonly versionId: string;
}

async function publishAndComment(client: ReplicaClient, token: string): Promise<MemberWork> {
  const published = await publishThroughReplica(client, token, "member-owned proof");
  const thread = await client.fetch(
    `/api/v1/artifacts/${published.artifactId}/versions/${published.versionId}/comments`,
    {
      body: JSON.stringify({body: "member-authored comment"}),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "auth-027-member-comment",
      },
      method: "POST",
    },
  );
  expect(thread.status).toBe(201);
  const threadId = threadSchema.parse(await thread.json()).thread.id;
  return {...published, threadId};
}

async function credentialStatuses(
  client: ReplicaClient,
  sessionHeader: string,
  token: string,
): Promise<{readonly key: number; readonly session: number}> {
  const [session, key] = await Promise.all([
    client.fetch("/api/v1/session", {headers: {Cookie: sessionHeader}}),
    client.fetch("/api/v1/artifacts", {headers: {Authorization: `Bearer ${token}`}}),
  ]);
  return {key: key.status, session: session.status};
}

async function waitForRefusal(
  client: ReplicaClient,
  sessionHeader: string,
  token: string,
  deadline: number,
): Promise<number> {
  for (;;) {
    // Polling is the behavior under test: refusal must arrive inside the bound.
    // eslint-disable-next-line no-await-in-loop
    const statuses = await credentialStatuses(client, sessionHeader, token);
    if (statuses.session === 401 && statuses.key === 401) return Date.now();
    if (Date.now() > deadline) {
      throw new Error(
        `Replica ${client.endpoint} still accepted the deactivated member at the bound: ${JSON.stringify(statuses)}.`,
      );
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function expectWorkPreserved(
  client: ReplicaClient,
  administrator: SessionCookies,
  work: MemberWork,
  memberId: string,
): Promise<void> {
  const headers = {Cookie: administrator.header};
  const artifact = await client.fetch(`/api/v1/artifacts/${work.artifactId}`, {headers});
  expect(artifact.status).toBe(200);
  const comments = JSON.stringify(
    await (await client.fetch(`/api/v1/artifacts/${work.artifactId}/comments`, {headers})).json(),
  );
  expect(comments).toContain(work.threadId);
  expect(comments).toContain(memberId);
  const activity = JSON.stringify(
    await (await client.fetch("/api/v1/activity", {headers})).json(),
  );
  expect(activity).toContain(memberId);
  expect(activity).toContain(work.artifactId);
}
