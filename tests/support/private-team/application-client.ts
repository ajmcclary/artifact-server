import {createHash} from "node:crypto";

import {
  Agent,
  type Dispatcher,
  fetch as undiciFetch,
  Headers,
  type RequestInit,
  type Response,
} from "undici";
import {z} from "zod";

import {signInAtKeycloak} from "../keycloak-realm.js";
import {loginHandshakeCookie} from "../runtime-harness.js";
import type {PrivateTeamIdentity} from "./identity-environment.js";

/** The management origin every packaged private-team runtime is configured with. */
export const packagedApplicationOrigin = "https://artifacts.example.com";
/** The separate registrable content domain those runtimes are configured with. */
export const packagedContentDomain = "content.example.net";
const applicationHost = new URL(packagedApplicationOrigin).host;

export interface SessionCookies {
  readonly csrf: string;
  readonly header: string;
}

/** One packaged replica, addressed as the management origin it serves. */
export interface ReplicaClient {
  readonly endpoint: string;
  readonly host: string;
  readonly port: number;
  fetch(pathOrUrl: string, init?: RequestInit): Promise<Response>;
}

/**
 * Address one packaged replica as the HTTPS management origin it serves:
 * the request travels as plain HTTP to that replica's port with the
 * management Host and `X-Forwarded-Proto: https`, the way the TLS gateway in
 * front of it sends it. Any other host arrives as a direct request would,
 * without a forwarded protocol.
 */
export function replicaClient(port: number, host = applicationHost): ReplicaClient {
  const target = `http://127.0.0.1:${port}`;
  const gatewayHeaders = host === applicationHost
    ? ["host", host, "x-forwarded-proto", "https"]
    : ["host", host];
  const dispatcher: Dispatcher = new Agent().compose((dispatch) => (options, handler) =>
    dispatch({
      ...options,
      headers: [...headerListWithoutHost(options.headers), ...gatewayHeaders],
      origin: target,
    }, handler));
  return {
    endpoint: `127.0.0.1:${port}`,
    fetch: (pathOrUrl, init) =>
      undiciFetch(new URL(pathOrUrl, packagedApplicationOrigin), {
        ...init,
        dispatcher,
        redirect: "manual",
      }),
    host,
    port,
  };
}

/** Flatten every undici header shape into `[name, value, …]` without Host or forwarded protocol. */
function headerListWithoutHost(
  headers: Dispatcher.DispatchOptions["headers"],
): string[] {
  const list: string[] = [];
  const add = (name: string, value: string | string[] | undefined): void => {
    const lowered = name.toLowerCase();
    if (value === undefined || lowered === "host" || lowered === "x-forwarded-proto") return;
    for (const item of Array.isArray(value) ? value : [value]) list.push(name, item);
  };
  if (headers === undefined || headers === null) return list;
  if (Array.isArray(headers)) {
    for (let index = 0; index + 1 < headers.length; index += 2) {
      add(String(headers[index]), String(headers[index + 1]));
    }
    return list;
  }
  if (Symbol.iterator in headers) {
    for (const [name, value] of headers) add(name, value);
    return list;
  }
  for (const [name, value] of Object.entries(headers)) add(name, value);
  return list;
}

const applicationCookie = /^(?:__Host-)?(artifact_session|artifact_csrf)=([^;]*)/u;

/** Read the session and CSRF cookies, with or without the `__Host-` prefix. */
export function sessionCookies(setCookie: readonly string[]): SessionCookies {
  const pairs = new Map<string, {readonly pair: string; readonly value: string}>();
  for (const header of setCookie) {
    const match = applicationCookie.exec(header);
    if (match?.[1] !== undefined && match[2] !== undefined && match[2] !== "") {
      pairs.set(match[1], {pair: header.split(";", 1)[0] ?? "", value: match[2]});
    }
  }
  const session = pairs.get("artifact_session");
  const csrf = pairs.get("artifact_csrf");
  if (session === undefined || csrf === undefined) {
    throw new Error("The response did not issue both application cookies.");
  }
  return {csrf: csrf.value, header: `${session.pair}; ${csrf.pair}`};
}

/** Whether a response issued an application session cookie. */
export function issuedSession(response: Response): boolean {
  return response.headers.getSetCookie().some((header) =>
    /^(?:__Host-)?artifact_session=[^;]+/u.test(header)
  );
}

/** Same-origin browser headers for a cookie-authenticated mutation. */
export function mutationHeaders(cookies: SessionCookies | null): Headers {
  const headers = new Headers({
    "Content-Type": "application/json",
    Origin: packagedApplicationOrigin,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  });
  if (cookies !== null) {
    headers.set("Cookie", cookies.header);
    headers.set("X-CSRF-Token", cookies.csrf);
  }
  return headers;
}

/** Drive one browser login through the real provider and return the callback answer. */
export async function signInThroughProvider(
  client: ReplicaClient,
  identity: PrivateTeamIdentity,
  credentials: {readonly password: string; readonly username: string},
): Promise<Response> {
  const login = await client.fetch("/auth/login");
  if (login.status !== 302) {
    throw new Error(`/auth/login on ${client.endpoint} answered ${login.status}.`);
  }
  const location = login.headers.get("location");
  if (location === null) throw new Error("/auth/login gave no provider location.");
  const callback = await signInAtKeycloak(identity.keycloak, new URL(location), credentials);
  return client.fetch(callback.toString(), {
    headers: {Cookie: loginHandshakeCookie(login)},
  });
}

const uploadPlanSchema = z.object({
  commitUrl: z.url(),
  files: z.array(z.object({path: z.string(), uploadUrl: z.url()}).loose()),
}).loose();
const committedSchema = z.object({
  artifact: z.object({id: z.string()}).loose(),
  version: z.object({id: z.string()}).loose(),
}).loose();

/** Publish one text file through a replica's staged upload flow with a bearer key. */
export async function publishThroughReplica(
  client: ReplicaClient,
  token: string,
  content: string,
): Promise<{readonly artifactId: string; readonly versionId: string}> {
  const bytes = new TextEncoder().encode(content);
  const authorization = `Bearer ${token}`;
  const planned = await client.fetch("/api/v1/uploads", {
    body: JSON.stringify({
      entryPath: "proof.txt",
      files: [{
        mediaType: "text/plain",
        path: "proof.txt",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      }],
      routingMode: "static",
    }),
    headers: {Authorization: authorization, "Content-Type": "application/json"},
    method: "POST",
  });
  if (planned.status !== 201 && planned.status !== 200) {
    throw new Error(`The upload plan answered ${planned.status}: ${await planned.text()}`);
  }
  const plan = uploadPlanSchema.parse(await planned.json());
  for (const file of plan.files) {
    // One file; the loop keeps the plan's own list authoritative.
    // eslint-disable-next-line no-await-in-loop
    const uploaded = await client.fetch(file.uploadUrl, {
      body: bytes,
      headers: {Authorization: authorization},
      method: "PUT",
    });
    if (!uploaded.ok) throw new Error(`The file upload answered ${uploaded.status}.`);
  }
  const committed = await client.fetch(plan.commitUrl, {
    body: JSON.stringify({
      target: {accessSetting: "account_required", kind: "new_artifact", name: "Member proof"},
    }),
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      "Idempotency-Key": `member-proof-${createHash("sha256").update(content).digest("hex").slice(0, 16)}`,
    },
    method: "POST",
  });
  if (!committed.ok) throw new Error(`The commit answered ${committed.status}: ${await committed.text()}`);
  const body = committedSchema.parse(await committed.json());
  return {artifactId: body.artifact.id, versionId: body.version.id};
}
