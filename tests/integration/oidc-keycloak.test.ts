import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {Redacted} from "effect";
import {fetch as undiciFetch} from "undici";
import {afterAll, beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";

import {privateTeamBrowserAccess, browserLoginKinds} from
  "../../src/core/browser-access.js";
import {createOidcHostedAuthentication} from
  "../../src/identity/oidc-hosted-authentication.js";
import {
  loginHandshakeCookie,
  reserveLoopbackPort,
  startTestServer,
} from "../support/runtime-harness.js";
import {
  type KeycloakEnvironment,
  keycloakRealm,
  provisionKeycloakRealm,
  type ProvisionedRealm,
  redirectTarget,
  requestPasswordToken,
  signInAtKeycloak,
} from "../support/keycloak-realm.js";

const {
  mcpClientId,
  mcpClientSecret,
  name: realmName,
  oidcClientId,
  oidcClientSecret,
  scopes: oidcScopes,
  unboundClientId,
  unboundClientSecret,
} = keycloakRealm;
const admittedEmail = "admitted@example.test";
const admittedPassword = "admitted-keycloak-integration-only";
const strangerEmail = "stranger@example.test";
const strangerPassword = "stranger-keycloak-integration-only";

const sessionResponseSchema = z.object({
  authenticationMethod: z.literal("session"),
  principal: z.object({
    id: z.string(),
    kind: z.literal("human"),
    membershipRole: z.literal("administrator"),
  }),
});
const memberListSchema = z.object({
  members: z.array(z.object({
    displayName: z.string(),
    email: z.string(),
    id: z.string(),
    role: z.string(),
    status: z.string(),
  })),
});
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});
const externalIdentityRowSchema = z.object({
  email: z.string(),
  member_id: z.string(),
  provider: z.string(),
  subject: z.string(),
});
const loginAttemptRowSchema = z.object({
  consumed_at: z.string().nullable(),
  nonce: z.string().nullable(),
  provider: z.string(),
});
const countRowSchema = z.object({total: z.number().int().nonnegative()});

interface RunningApplication {
  readonly baseUrl: string;
  readonly dataDirectory: string;
  stop(): Promise<void>;
}

describe.sequential("Keycloak generic OIDC browser login", () => {
  let keycloak: KeycloakEnvironment;
  let realm: ProvisionedRealm;
  let admittedSubject: string;
  let application: RunningApplication;

  beforeAll(async () => {
    keycloak = readKeycloakEnvironment();
    const port = await reserveLoopbackPort();
    const applicationOrigin = `http://127.0.0.1:${port}`;
    realm = await provisionKeycloakRealm(keycloak, applicationOrigin, [
      {
        email: admittedEmail,
        firstName: "Ada",
        lastName: "Lovelace",
        password: admittedPassword,
        username: admittedEmail,
      },
      {
        email: strangerEmail,
        firstName: "Grace",
        lastName: "Hopper",
        password: strangerPassword,
        username: strangerEmail,
      },
    ]);
    admittedSubject = realm.subjects.get(admittedEmail) ?? "";
    application = await startApplicationProcess(realm.issuer, applicationOrigin, port);
  });

  afterAll(async () => {
    if (application !== undefined) {
      await application.stop();
      await rm(application.dataDirectory, {force: true, recursive: true});
    }
  });

  test("an admitted person signs in through the real Keycloak login page", async () => {
    const login = await fetch(`${application.baseUrl}/auth/login`, {
      redirect: "manual",
    });
    expect(login.status).toBe(302);
    const authorizationUrl = redirectTarget(login, "/auth/login");
    expect(authorizationUrl.origin).toBe(keycloak.baseUrl);
    expect(authorizationUrl.pathname)
      .toBe(`/realms/${realmName}/protocol/openid-connect/auth`);
    const query = authorizationUrl.searchParams;
    expect(query.get("response_type")).toBe("code");
    expect(query.get("client_id")).toBe(oidcClientId);
    expect(query.get("redirect_uri"))
      .toBe(`${application.baseUrl}/auth/callback`);
    expect(query.get("scope")).toBe(oidcScopes);
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(query.get("code_challenge")).not.toBeNull();
    expect(query.get("nonce")).not.toBeNull();

    const attempts = loginAttempts(application.dataDirectory);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.provider).toBe("oidc");
    expect(attempts[0]?.nonce).toBe(query.get("nonce"));
    expect(attempts[0]?.consumed_at).toBeNull();

    const callbackUrl = await signInAtKeycloak(keycloak, authorizationUrl, {
      password: admittedPassword,
      username: admittedEmail,
    });
    expect(callbackUrl.origin).toBe(application.baseUrl);
    expect(callbackUrl.pathname).toBe("/auth/callback");
    expect(callbackUrl.searchParams.get("state")).toBe(query.get("state"));

    const completed = await fetch(callbackUrl, {
      headers: {Cookie: loginHandshakeCookie(login)},
      redirect: "manual",
    });
    expect(completed.status).toBe(303);
    const applicationCookies = applicationCookieHeader(
      completed.headers.getSetCookie(),
    );

    const session = await fetch(`${application.baseUrl}/api/v1/session`, {
      headers: {Cookie: applicationCookies},
    });
    expect(session.status).toBe(200);
    const principal = sessionResponseSchema.parse(await session.json()).principal;

    // The real browser session is not an MCP credential.
    const cookieOnly = await callMcp(application.baseUrl, null, applicationCookies);
    expect(cookieOnly.status).toBe(401);

    const members = await fetch(`${application.baseUrl}/api/v1/members`, {
      headers: {Cookie: applicationCookies},
    });
    expect(members.status).toBe(200);
    expect(memberListSchema.parse(await members.json()).members).toEqual([{
      displayName: "Ada Lovelace",
      email: admittedEmail,
      id: principal.id,
      role: "administrator",
      status: "active",
    }]);
    expect(externalIdentities(application.dataDirectory)).toEqual([{
      email: admittedEmail,
      member_id: principal.id,
      provider: `oidc:${realm.issuer}`,
      subject: admittedSubject,
    }]);
    const consumed = loginAttempts(application.dataDirectory);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]?.consumed_at).not.toBeNull();
  });

  test("a Keycloak identity that was never admitted is refused", async () => {
    const login = await fetch(`${application.baseUrl}/auth/login`, {
      redirect: "manual",
    });
    expect(login.status).toBe(302);
    const authorizationUrl = redirectTarget(login, "/auth/login");

    const callbackUrl = await signInAtKeycloak(keycloak, authorizationUrl, {
      password: strangerPassword,
      username: strangerEmail,
    });
    const refused = await fetch(callbackUrl, {
      headers: {Cookie: loginHandshakeCookie(login)},
      redirect: "manual",
    });
    expect(refused.status).toBe(403);
    expect(refused.headers.getSetCookie()).toEqual([]);
    expect(failureSchema.parse(await refused.json()).error.code)
      .toBe("IDENTITY_ADMISSION_DENIED");

    expect(externalIdentities(application.dataDirectory).map((row) => row.subject))
      .toEqual([admittedSubject]);
    expect(rowCount(application.dataDirectory, "installation_members")).toBe(1);
    expect(rowCount(application.dataDirectory, "application_sessions")).toBe(1);
  });

  test("a real Keycloak access token bound to /mcp authorizes the MCP endpoint", async () => {
    const bound = await requestPasswordToken(keycloak, realm.issuer, mcpClientId, mcpClientSecret, {
      password: admittedPassword,
      username: admittedEmail,
    });
    const authorized = await callMcp(application.baseUrl, bound);
    expect(authorized.status).toBe(200);
    expect(await readMcpToolNames(authorized)).toContain("artifact_capabilities");

    const unbound = await requestPasswordToken(
      keycloak,
      realm.issuer,
      unboundClientId,
      unboundClientSecret,
      {
        password: admittedPassword,
        username: admittedEmail,
      },
    );
    const refused = await callMcp(application.baseUrl, unbound);
    expect(refused.status).toBe(401);

    const missing = await callMcp(application.baseUrl, null);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain(
      `resource_metadata="${application.baseUrl}/.well-known/oauth-protected-resource/mcp"`,
    );

    const metadata = await fetch(
      `${application.baseUrl}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      authorization_servers: [realm.issuer],
      resource: `${application.baseUrl}/mcp`,
    });
  });

  test("a Keycloak identity that was never admitted is refused at MCP too", async () => {
    const stranger = await requestPasswordToken(keycloak, realm.issuer, mcpClientId, mcpClientSecret, {
      password: strangerPassword,
      username: strangerEmail,
    });
    const refused = await callMcp(application.baseUrl, stranger);
    expect(refused.status).toBe(401);
    expect(rowCount(application.dataDirectory, "installation_members")).toBe(1);
  });
});

function callMcp(
  baseUrl: string,
  token: string | null,
  cookie?: string,
): Promise<Response> {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  });
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  if (cookie !== undefined) headers.set("Cookie", cookie);
  return fetch(`${baseUrl}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
    }),
    headers,
    method: "POST",
  });
}

async function readMcpToolNames(response: Response): Promise<readonly string[]> {
  const body = await response.text();
  const payload = body.split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .at(-1) ?? body;
  const parsed: unknown = JSON.parse(payload);
  return z.object({
    result: z.object({tools: z.array(z.object({name: z.string()}))}),
  }).parse(parsed).result.tools.map((tool) => tool.name);
}

function readKeycloakEnvironment(): KeycloakEnvironment {
  const adminPassword = process.env["ARTIFACT_SERVER_TEST_KEYCLOAK_ADMIN_PASSWORD"];
  const adminUser = process.env["ARTIFACT_SERVER_TEST_KEYCLOAK_ADMIN_USER"];
  const baseUrl = process.env["ARTIFACT_SERVER_TEST_KEYCLOAK_URL"];
  if (
    adminPassword === undefined || adminUser === undefined || baseUrl === undefined
  ) {
    throw new Error("Run this test through pnpm test:oidc.");
  }
  return {adminPassword, adminUser, baseUrl, fetch: undiciFetch};
}

function applicationCookieHeader(setCookieHeaders: readonly string[]): string {
  const pairs = setCookieHeaders
    .filter((value) =>
      value.startsWith("artifact_session=") || value.startsWith("artifact_csrf=")
    )
    .map((value) => value.split(";", 1)[0]);
  if (pairs.length !== 2) {
    throw new Error("The login response did not issue both application cookies.");
  }
  return pairs.join("; ");
}

async function startApplicationProcess(
  issuer: string,
  applicationOrigin: string,
  port: number,
): Promise<RunningApplication> {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "artifact-server-oidc-"),
  );
  const hosted = await createOidcHostedAuthentication({
    applicationOrigin,
    clientId: oidcClientId,
    clientSecret: Redacted.make(oidcClientSecret, {label: "oidc-client-secret"}),
    issuer,
    scopes: oidcScopes,
  });
  const server = await startTestServer({
    apiToken:
      "as_key_key_00000000-0000-4000-8000-000000000002_oidcIntegrationMachineCredential12345",
    browserBootstrapToken: "unused-private-team-browser-bootstrap-token",
    dataDirectory,
  }, {
    applicationOrigin,
    bootstrapAdministratorEmail: admittedEmail,
    browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
    externalMcpOAuthVerifier: hosted.externalMcpOAuthVerifier,
    interactiveIdentityProvider: hosted.interactiveIdentityProvider,
    mcpOAuthResource: hosted.mcpOAuthResource,
    port,
  });
  return {
    baseUrl: server.baseUrl,
    dataDirectory,
    stop: () => server.stop(),
  };
}

function externalIdentities(
  dataDirectory: string,
): readonly z.infer<typeof externalIdentityRowSchema>[] {
  const database = openIdentityDatabase(dataDirectory);
  try {
    return database
      .prepare(
        "SELECT provider, subject, member_id, email FROM external_identities ORDER BY subject",
      )
      .all()
      .map((row) => externalIdentityRowSchema.parse(row));
  } finally {
    database.close();
  }
}

function loginAttempts(
  dataDirectory: string,
): readonly z.infer<typeof loginAttemptRowSchema>[] {
  const database = openIdentityDatabase(dataDirectory);
  try {
    return database
      .prepare(
        "SELECT consumed_at, nonce, provider FROM login_attempts ORDER BY created_at",
      )
      .all()
      .map((row) => loginAttemptRowSchema.parse(row));
  } finally {
    database.close();
  }
}

function rowCount(dataDirectory: string, table: string): number {
  const database = openIdentityDatabase(dataDirectory);
  try {
    return countRowSchema.parse(
      database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get(),
    ).total;
  } finally {
    database.close();
  }
}

function openIdentityDatabase(dataDirectory: string): DatabaseSync {
  return new DatabaseSync(path.join(dataDirectory, "artifact-server.db"), {
    readOnly: true,
  });
}
