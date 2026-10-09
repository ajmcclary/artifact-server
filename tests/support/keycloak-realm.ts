import type {RequestInit, Response} from "undici";
import {z} from "zod";

/** The undici fetch shape, so a caller can route it through its own dispatcher. */
export type KeycloakFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** The Keycloak administrator and the transport that reaches it. */
export interface KeycloakEnvironment {
  readonly adminPassword: string;
  readonly adminUser: string;
  readonly baseUrl: string;
  readonly fetch: KeycloakFetch;
}

export interface KeycloakCredentials {
  readonly password: string;
  readonly username: string;
}

export interface KeycloakPerson extends KeycloakCredentials {
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
}

export interface ProvisionedRealm {
  readonly issuer: string;
  /** Keycloak subject for each provisioned person, keyed by email. */
  readonly subjects: ReadonlyMap<string, string>;
}

/** The fixed realm and client registrations every Keycloak suite uses. */
export const keycloakRealm = {
  mcpClientId: "artifact-server-mcp-integration",
  mcpClientSecret: "keycloak-integration-only-mcp-secret",
  name: "artifact-server",
  oidcClientId: "artifact-server-integration",
  oidcClientSecret: "keycloak-integration-only-client-secret",
  scopes: "openid email profile",
  unboundClientId: "artifact-server-unbound-integration",
  unboundClientSecret: "keycloak-integration-only-unbound-secret",
} as const;

const loginFormPattern =
  /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/u;
const adminTokenSchema = z.object({access_token: z.string().min(1)});

interface KeycloakRealmRepresentation {
  readonly enabled: boolean;
  readonly realm: string;
}

interface KeycloakProtocolMapperRepresentation {
  readonly config: Readonly<Record<string, string>>;
  readonly name: string;
  readonly protocol: string;
  readonly protocolMapper: string;
}

interface KeycloakClientRepresentation {
  readonly attributes: {readonly "pkce.code.challenge.method": string};
  readonly clientId: string;
  readonly protocolMappers?: readonly KeycloakProtocolMapperRepresentation[];
  readonly directAccessGrantsEnabled: boolean;
  readonly enabled: boolean;
  readonly protocol: string;
  readonly publicClient: boolean;
  readonly redirectUris: readonly string[];
  readonly secret: string;
  readonly serviceAccountsEnabled: boolean;
  readonly standardFlowEnabled: boolean;
  readonly webOrigins: readonly string[];
}

interface KeycloakUserRepresentation {
  readonly credentials: readonly {
    readonly temporary: boolean;
    readonly type: string;
    readonly value: string;
  }[];
  readonly email: string;
  readonly emailVerified: boolean;
  readonly enabled: boolean;
  readonly firstName: string;
  readonly lastName: string;
  readonly username: string;
}

type KeycloakRepresentation =
  | KeycloakClientRepresentation
  | KeycloakRealmRepresentation
  | KeycloakUserRepresentation;

/** Create the realm, its three clients, and one verified user per person. */
export async function provisionKeycloakRealm(
  environment: KeycloakEnvironment,
  applicationOrigin: string,
  people: readonly KeycloakPerson[],
): Promise<ProvisionedRealm> {
  const token = await requestAdminToken(environment);
  await adminRequest(environment, token, "POST", "/admin/realms", {
    enabled: true,
    realm: keycloakRealm.name,
  });
  await registerClients(environment, token, applicationOrigin);
  const subjects = new Map<string, string>();
  for (const person of people) {
    // Users are created in order so the returned subjects are deterministic.
    // eslint-disable-next-line no-await-in-loop
    subjects.set(person.email, await createKeycloakUser(environment, person, token));
  }
  return {
    issuer: `${environment.baseUrl}/realms/${keycloakRealm.name}`,
    subjects,
  };
}

async function registerClients(
  environment: KeycloakEnvironment,
  token: string,
  applicationOrigin: string,
): Promise<void> {
  await adminRequest(
    environment,
    token,
    "POST",
    `/admin/realms/${keycloakRealm.name}/clients`,
    {
      attributes: {"pkce.code.challenge.method": "S256"},
      clientId: keycloakRealm.oidcClientId,
      directAccessGrantsEnabled: false,
      enabled: true,
      protocol: "openid-connect",
      publicClient: false,
      redirectUris: [`${applicationOrigin}/auth/callback`],
      secret: keycloakRealm.oidcClientSecret,
      serviceAccountsEnabled: false,
      standardFlowEnabled: true,
      webOrigins: [applicationOrigin],
    },
  );
  await adminRequest(
    environment,
    token,
    "POST",
    `/admin/realms/${keycloakRealm.name}/clients`,
    {
      attributes: {"pkce.code.challenge.method": "S256"},
      clientId: keycloakRealm.mcpClientId,
      directAccessGrantsEnabled: true,
      enabled: true,
      protocol: "openid-connect",
      protocolMappers: [{
        config: {
          "access.token.claim": "true",
          "id.token.claim": "false",
          "included.custom.audience": `${applicationOrigin}/mcp`,
        },
        name: "mcp audience",
        protocol: "openid-connect",
        protocolMapper: "oidc-audience-mapper",
      }],
      publicClient: false,
      redirectUris: [`${applicationOrigin}/auth/callback`],
      secret: keycloakRealm.mcpClientSecret,
      serviceAccountsEnabled: false,
      standardFlowEnabled: true,
      webOrigins: [applicationOrigin],
    },
  );
  await adminRequest(
    environment,
    token,
    "POST",
    `/admin/realms/${keycloakRealm.name}/clients`,
    {
      attributes: {"pkce.code.challenge.method": "S256"},
      clientId: keycloakRealm.unboundClientId,
      directAccessGrantsEnabled: true,
      enabled: true,
      protocol: "openid-connect",
      publicClient: false,
      redirectUris: [`${applicationOrigin}/auth/callback`],
      secret: keycloakRealm.unboundClientSecret,
      serviceAccountsEnabled: false,
      standardFlowEnabled: true,
      webOrigins: [applicationOrigin],
    },
  );
}

/** Create one verified Keycloak user and return its subject. */
export async function createKeycloakUser(
  environment: KeycloakEnvironment,
  person: KeycloakPerson,
  token?: string,
): Promise<string> {
  const created = await adminRequest(
    environment,
    token ?? await requestAdminToken(environment),
    "POST",
    `/admin/realms/${keycloakRealm.name}/users`,
    {
      credentials: [{
        temporary: false,
        type: "password",
        value: person.password,
      }],
      email: person.email,
      emailVerified: true,
      enabled: true,
      firstName: person.firstName,
      lastName: person.lastName,
      username: person.username,
    },
  );
  const location = created.headers.get("location");
  if (location === null) {
    throw new Error("Keycloak created a user without a location header.");
  }
  const subject = location.split("/").pop();
  if (subject === undefined || subject === "") {
    throw new Error("Keycloak returned an unusable user location.");
  }
  return subject;
}

/** Obtain an access token through the password grant of one client. */
export async function requestPasswordToken(
  environment: KeycloakEnvironment,
  issuer: string,
  clientId: string,
  clientSecret: string,
  credentials: KeycloakCredentials,
): Promise<string> {
  const response = await environment.fetch(
    `${issuer}/protocol/openid-connect/token`,
    {
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "password",
        password: credentials.password,
        scope: keycloakRealm.scopes,
        username: credentials.username,
      }),
      headers: {"Content-Type": "application/x-www-form-urlencoded"},
      method: "POST",
    },
  );
  if (!response.ok) {
    throw new Error(
      `Keycloak refused the password grant: ${response.status} ${await response.text()}`,
    );
  }
  return z.object({access_token: z.string().min(1)})
    .parse(await response.json()).access_token;
}

/** Submit the real Keycloak login form and return the application callback URL. */
export async function signInAtKeycloak(
  environment: KeycloakEnvironment,
  authorizationUrl: URL,
  credentials: KeycloakCredentials,
): Promise<URL> {
  const cookies = new Map<string, string>();
  const page = await environment.fetch(authorizationUrl, {
    headers: {Cookie: cookieHeader(cookies)},
    redirect: "manual",
  });
  storeCookies(cookies, page.headers.getSetCookie());
  if (page.status !== 200) {
    throw new Error(
      `The Keycloak login page answered HTTP ${page.status}.`,
    );
  }
  const action = loginFormPattern.exec(await page.text())?.[1];
  if (action === undefined) {
    throw new Error("The Keycloak login page did not contain a login form.");
  }
  const submitted = await environment.fetch(action.replaceAll("&amp;", "&"), {
    body: new URLSearchParams({
      credentialId: "",
      password: credentials.password,
      username: credentials.username,
    }),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(cookies),
    },
    method: "POST",
    redirect: "manual",
  });
  storeCookies(cookies, submitted.headers.getSetCookie());
  if (submitted.status !== 302) {
    throw new Error(
      `Keycloak did not accept the credentials: HTTP ${submitted.status}`,
    );
  }
  return redirectTarget(submitted, "the Keycloak login form");
}

/** Read the absolute redirect target of a 3xx response. */
export function redirectTarget(
  response: {readonly headers: {get(name: string): string | null}; readonly status: number},
  step: string,
): URL {
  const location = response.headers.get("location");
  if (location === null) {
    throw new Error(
      `${step} answered ${response.status} without a redirect location.`,
    );
  }
  return new URL(location);
}

async function requestAdminToken(
  environment: KeycloakEnvironment,
): Promise<string> {
  const response = await environment.fetch(
    `${environment.baseUrl}/realms/master/protocol/openid-connect/token`,
    {
      body: new URLSearchParams({
        client_id: "admin-cli",
        grant_type: "password",
        password: environment.adminPassword,
        username: environment.adminUser,
      }),
      headers: {"Content-Type": "application/x-www-form-urlencoded"},
      method: "POST",
    },
  );
  if (!response.ok) {
    throw new Error(
      `Keycloak refused the administrator token: HTTP ${response.status}`,
    );
  }
  return adminTokenSchema.parse(await response.json()).access_token;
}

async function adminRequest(
  environment: KeycloakEnvironment,
  token: string,
  method: string,
  resourcePath: string,
  body: KeycloakRepresentation,
): Promise<Response> {
  const response = await environment.fetch(`${environment.baseUrl}${resourcePath}`, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method,
  });
  if (!response.ok) {
    throw new Error(
      `Keycloak refused ${method} ${resourcePath}: HTTP ${response.status} ${await response.text()}`,
    );
  }
  return response;
}

function storeCookies(
  cookies: Map<string, string>,
  setCookieHeaders: readonly string[],
): void {
  for (const header of setCookieHeaders) {
    const pair = header.split(";", 1)[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (value === "") cookies.delete(name);
    else cookies.set(name, value);
  }
}

function cookieHeader(cookies: ReadonlyMap<string, string>): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}
