import {afterAll, beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  keycloakRealm,
  provisionKeycloakRealm,
  requestPasswordToken,
} from "../support/keycloak-realm.js";
import {
  issuedSession,
  packagedApplicationOrigin,
  type ReplicaClient,
  replicaClient,
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
} from "../support/private-team/runtime.js";

/**
 * Private-team acceptance on one packaged runtime. Each packaged harness
 * includes this file and names its runtime in ARTIFACT_SERVER_PRIVATE_TEAM_TARGET;
 * the evidence report it writes is that deployment's proof.
 */
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

let identity: PrivateTeamIdentity;
let runtime: PrivateTeamRuntime;

beforeAll(async () => {
  identity = await readPrivateTeamIdentity();
  runtime = await selectPrivateTeamRuntime(identity);
  await provisionKeycloakRealm(identity.keycloak, packagedApplicationOrigin, [
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
  ]);
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
      expect(noProvider).toContain(
        "A private-team server requires exactly one OIDC or WorkOS browser-login provider.",
      );
      const twoProviders = await runtime.expectStartupRefused({
        ARTIFACT_SERVER_WORKOS_CLIENT_ID: "client_conflicting_provider",
        ARTIFACT_SERVER_WORKOS_ISSUER: "https://api.workos.com",
      });
      expect(twoProviders).toContain("One installation has one browser-login provider");
      const localBootstrap = await runtime.expectStartupRefused({
        ARTIFACT_SERVER_LOCAL_BOOTSTRAP_TOKEN: "local-bootstrap-credential-".padEnd(43, "x"),
      });
      expect(localBootstrap).toContain(
        "A private-team server does not accept ARTIFACT_SERVER_LOCAL_BOOTSTRAP_TOKEN",
      );
      await runtime.start();
      expect((await firstReplica().fetch("/api/v1/artifacts", {
        headers: {Authorization: `Bearer ${runtime.serviceKey}`},
      })).status).toBe(200);
    });
  },
);

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
