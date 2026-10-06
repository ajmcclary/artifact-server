// tests/support/invites.ts
import {expect} from "vitest";
import {z} from "zod";

import {browserLoginKinds, privateTeamBrowserAccess} from "../../src/core/browser-access.js";
import {LoopbackIdentityProvider} from "./loopback-identity-provider.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "./runtime-harness.js";

export interface InviteServer {
  readonly installation: TestInstallation;
  readonly provider: LoopbackIdentityProvider;
  readonly server: RunningTestServer;
  stop(): Promise<void>;
}

export interface Person {
  readonly displayName: string;
  readonly email: string;
  readonly emailVerificationAsserted?: boolean;
  readonly emailVerified?: boolean;
  readonly subject: string;
}

export interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

export const bootstrapAdministrator: Person = {
  displayName: "Jordan Lee",
  email: "jordan@acme.test",
  subject: "workos-jordan",
};

export async function startInviteServer(): Promise<InviteServer> {
  const installation = await createTestInstallation();
  const provider = new LoopbackIdentityProvider();
  const server = await startTestServer(installation, {
    bootstrapAdministratorEmail: bootstrapAdministrator.email,
    browserAccess: privateTeamBrowserAccess(browserLoginKinds.workOs),
    interactiveIdentityProvider: provider,
  });
  provider.baseUrl = server.baseUrl;
  return {
    installation,
    provider,
    server,
    stop: async () => {
      await server.stop();
      await removeTestInstallation(installation);
    },
  };
}

export function applicationCookies(setCookieHeaders: readonly string[]): ApplicationCookies {
  const pair = (prefix: string): string => {
    const value = setCookieHeaders.find((header) => header.startsWith(prefix))?.split(";", 1)[0];
    if (value === undefined) throw new Error(`The login did not issue ${prefix}.`);
    return value;
  };
  const session = pair("artifact_session=");
  const csrf = pair("artifact_csrf=");
  return {csrf: csrf.slice(csrf.indexOf("=") + 1), header: `${session}; ${csrf}`};
}

export function browserMutationHeaders(origin: string, cookies: ApplicationCookies | null): Headers {
  const headers = new Headers({
    "Content-Type": "application/json",
    Origin: origin,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  });
  if (cookies !== null) {
    headers.set("Cookie", cookies.header);
    headers.set("X-CSRF-Token", cookies.csrf);
  }
  return headers;
}

function identityOf(person: Person) {
  return {
    displayName: person.displayName,
    email: person.email,
    emailVerificationAsserted: person.emailVerificationAsserted ?? true,
    emailVerified: person.emailVerified ?? true,
    provider: "workos",
    subject: person.subject,
  };
}

/** Follow the loopback provider's redirect and return the callback response. */
async function completeLogin(context: InviteServer, started: Response): Promise<Response> {
  const location = started.headers.get("location");
  if (location === null) throw new Error("Sign-in did not redirect to the provider.");
  const handshake = started.headers.getSetCookie()
    .find((value) => value.startsWith("artifact_login="))?.split(";", 1)[0];
  if (handshake === undefined) throw new Error("Sign-in did not set the handshake cookie.");
  return fetch(location, {headers: {Cookie: handshake}, redirect: "manual"});
}

export async function signInAs(context: InviteServer, person: Person): Promise<ApplicationCookies> {
  context.provider.identity = identityOf(person);
  const started = await fetch(`${context.server.baseUrl}/auth/login`, {redirect: "manual"});
  const completed = await completeLogin(context, started);
  expect(completed.status).toBe(303);
  return applicationCookies(completed.headers.getSetCookie());
}

const issuedSchema = z.object({
  invite: z.looseObject({id: z.string(), status: z.string()}),
  url: z.string(),
});

/** The invite request body as a client sends it, including values the server must refuse. */
export interface InviteRequestBody {
  readonly email?: string;
  readonly expiresIn: string;
  readonly kind: "link" | "person";
  readonly maxUses?: number;
  readonly opens?: {readonly artifactId: string; readonly projectId: string; readonly versionId: string};
  readonly role?: string;
}

export async function createInvite(
  context: InviteServer,
  cookies: ApplicationCookies,
  body: InviteRequestBody,
): Promise<{readonly id: string; readonly token: string; readonly url: string}> {
  const response = await fetch(`${context.server.baseUrl}/api/v1/invites`, {
    body: JSON.stringify(body),
    headers: browserMutationHeaders(context.server.baseUrl, cookies),
    method: "POST",
  });
  expect(response.status).toBe(201);
  const issued = issuedSchema.parse(await response.json());
  const token = new URL(issued.url).hash.slice(1);
  return {id: issued.invite.id, token, url: issued.url};
}

export interface StartedRedemption {
  readonly authorizationUrl: string;
  readonly handshake: string;
}

/** Start an invite login as `person`; the provider remembers who signs in with this code. */
export async function startRedemption(
  context: InviteServer,
  token: string,
  person: Person,
  options: {readonly forceSignIn?: boolean} = {},
): Promise<StartedRedemption> {
  context.provider.identity = identityOf(person);
  const started = await fetch(`${context.server.baseUrl}/auth/invites/start`, {
    body: JSON.stringify({forceSignIn: options.forceSignIn ?? false, token}),
    headers: browserMutationHeaders(context.server.baseUrl, null),
    method: "POST",
  });
  expect(started.status).toBe(200);
  const body = z.object({authorizationUrl: z.string()}).parse(await started.json());
  const handshake = started.headers.getSetCookie()
    .find((value) => value.startsWith("artifact_login="))?.split(";", 1)[0] ?? "";
  return {authorizationUrl: body.authorizationUrl, handshake};
}

/** Complete a started invite login at the server's callback. */
export function finishRedemption(started: StartedRedemption): Promise<Response> {
  return fetch(started.authorizationUrl, {headers: {Cookie: started.handshake}, redirect: "manual"});
}

/** Start an invite login and complete it at the loopback provider. */
export async function redeem(
  context: InviteServer,
  token: string,
  person: Person,
  options: {readonly forceSignIn?: boolean} = {},
): Promise<Response> {
  return finishRedemption(await startRedemption(context, token, person, options));
}
