import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {createHash} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {request as httpRequest} from "node:http";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {Effect, ManagedRuntime, Redacted} from "effect";
import {z} from "zod";

import type {
  InteractiveAuthorization,
  InteractiveIdentityProvider,
} from "../../src/application/interactive-login.js";
import type {BearerCredentialVerifier} from "../../src/application/authentication.js";
import {InstallationAccessService} from "../../src/application/installation-access.js";
import {SystemIdGenerator} from "../../src/core/system.js";
import {createLocalApplicationLayer} from "../../src/local/create-local-application-layer.js";
import {LocalBlobStore} from "../../src/storage/local-blob-store.js";
import {LocalStagingStore} from "../../src/storage/local-staging-store.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";
import {
  AuthenticationRequired,
  IdentityProviderFailure,
} from "../../src/core/errors.js";
import type {ExternalIdentity} from "../../src/core/installation-identity.js";
import type {Clock} from "../../src/core/ports.js";
import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {
  createTestInstallation,
  fetchVersion,
  issueLocalBrowserLogin,
  loginHandshakeCookie,
  type RunningTestServer,
  type TestInstallation,
  removeTestInstallation,
  startTestServer,
} from "../support/runtime-harness.js";

const sessionResponseSchema = z.object({
  authenticationMethod: z.literal("session"),
  principal: z.object({
    id: z.string(),
    kind: z.literal("human"),
    membershipRole: z.literal("administrator"),
  }),
});
const issuedKeySchema = z.object({
  apiKey: z.object({
    id: z.string(),
    revokedAt: z.string().nullable(),
  }),
  token: z.string().startsWith("as_key_"),
});
const issuedHumanKeySchema = z.object({
  apiKey: z.object({
    id: z.string(),
    principalId: z.string(),
    principalKind: z.literal("human"),
    revokedAt: z.string().nullable(),
  }),
  token: z.string().startsWith("as_key_"),
});

describe("installation identity and access", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let clock: MutableClock;

  beforeEach(async () => {
    installation = await createTestInstallation();
    clock = new MutableClock("2026-08-13T08:00:00.000Z");
    server = await startTestServer(installation, {clock});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-027-B AUTH-027-F: bootstrap membership and managed keys fail closed", async () => {
    const rejected = await fetch(`${server.baseUrl}/auth/local`, {
      headers: {Authorization: `Bearer ${"x".repeat(43)}`},
      method: "POST",
    });
    expect(rejected.status).toBe(401);

    const localBrowserToken = await issueLocalBrowserLogin(server, installation);
    expect(localBrowserToken).not.toBe(installation.browserBootstrapToken);
    const login = await fetch(
      `${server.baseUrl}/auth/local?token=${localBrowserToken}`,
      {redirect: "manual"},
    );
    expect(login.status).toBe(303);
    expect(login.headers.get("cache-control")).toBe("private, no-store");
    const cookies = applicationCookies(login.headers.getSetCookie());
    expect(cookies.sessionAttributes).toContain("HttpOnly");
    expect(cookies.sessionAttributes).toContain("SameSite=Lax");
    expect((await fetch(
      `${server.baseUrl}/auth/local?token=${localBrowserToken}`,
      {redirect: "manual"},
    )).status).toBe(401);
    expect((await fetch(
      `${server.baseUrl}/auth/local?token=${installation.browserBootstrapToken}`,
      {redirect: "manual"},
    )).status).toBe(401);

    const session = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Cookie: cookies.header},
    });
    expect(session.status).toBe(200);
    const principal = sessionResponseSchema.parse(await session.json()).principal;

    const missingCsrf = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({
        displayName: "Second member",
        email: "member@example.test",
      }),
      headers: {
        "Content-Type": "application/json",
        Cookie: cookies.header,
      },
      method: "POST",
    });
    expect(missingCsrf.status).toBe(403);

    const member = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({
        displayName: "Second member",
        email: "member@example.test",
      }),
      headers: browserMutationHeaders(server.baseUrl, cookies),
      method: "POST",
    });
    expect(member.status).toBe(201);
    const admittedMember = z.object({
      member: z.object({id: z.string()}),
    }).parse(await member.json()).member;

    const cannotRemoveLastAdministrator = await fetch(
      `${server.baseUrl}/api/v1/members/${principal.id}/deactivate`,
      {
        headers: browserMutationHeaders(server.baseUrl, cookies),
        method: "POST",
      },
    );
    expect(cannotRemoveLastAdministrator.status).toBe(409);

    const replacementAdministratorResponse = await fetch(
      `${server.baseUrl}/api/v1/members`,
      {
        body: JSON.stringify({
          displayName: "Replacement administrator",
          email: "replacement-local-administrator@example.test",
          role: "administrator",
        }),
        headers: browserMutationHeaders(server.baseUrl, cookies),
        method: "POST",
      },
    );
    expect(replacementAdministratorResponse.status).toBe(201);
    const replacementAdministrator = z.object({
      member: z.object({id: z.string()}),
    }).parse(await replacementAdministratorResponse.json()).member;
    const replacementKeyResponse = await fetch(
      `${server.baseUrl}/api/v1/api-keys`,
      {
        body: JSON.stringify({
          capabilities: ["artifact:read"],
          expiresAt: "2099-01-01T00:00:00.000Z",
          memberId: replacementAdministrator.id,
          name: "Replacement local administrator key",
        }),
        headers: browserMutationHeaders(server.baseUrl, cookies),
        method: "POST",
      },
    );
    expect(replacementKeyResponse.status).toBe(201);
    const replacementKey = issuedHumanKeySchema.parse(
      await replacementKeyResponse.json(),
    );
    const cannotRemoveLocalOwner = await fetch(
      `${server.baseUrl}/api/v1/members/${principal.id}/deactivate`,
      {
        headers: {Authorization: `Bearer ${replacementKey.token}`},
        method: "POST",
      },
    );
    expect(cannotRemoveLocalOwner.status).toBe(403);
    expect((await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Cookie: cookies.header},
    })).status).toBe(200);

    const pastExpiration = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify({
        capabilities: ["artifact:read"],
        expiresAt: "2026-08-13T07:59:59.999Z",
        name: "Already expired automation",
      }),
      headers: browserMutationHeaders(server.baseUrl, cookies),
      method: "POST",
    });
    expect(pastExpiration.status).toBe(409);
    expect(await pastExpiration.json()).toEqual({
      error: {
        code: "IDENTITY_CONFLICT",
        message: "The API key expiration must be a future date and time.",
      },
    });

    const issuedResponse = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify({
        capabilities: ["artifact:read"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        name: "Read-only automation",
      }),
      headers: browserMutationHeaders(server.baseUrl, cookies),
      method: "POST",
    });
    expect(issuedResponse.status).toBe(201);
    const issued = issuedKeySchema.parse(await issuedResponse.json());

    const keyRead = await fetch(`${server.baseUrl}/api/v1/artifacts`, {
      headers: {Authorization: `Bearer ${issued.token}`},
    });
    expect(keyRead.status).toBe(200);

    expect(await publishStatus(
      server,
      issued.token,
    )).toBe(403);

    const rotatedResponse = await fetch(
      `${server.baseUrl}/api/v1/api-keys/${issued.apiKey.id}/rotate`,
      {
        headers: browserMutationHeaders(server.baseUrl, cookies),
        method: "POST",
      },
    );
    expect(rotatedResponse.status).toBe(201);
    const rotated = issuedKeySchema.parse(await rotatedResponse.json());
    expect(rotated.token).not.toBe(issued.token);
    expect(await bearerStatus(server, issued.token)).toBe(401);
    expect(await bearerStatus(server, rotated.token)).toBe(200);
    expect((await fetch(
      `${server.baseUrl}/api/v1/api-keys/${issued.apiKey.id}/rotate`,
      {
        headers: browserMutationHeaders(server.baseUrl, cookies),
        method: "POST",
      },
    )).status).toBe(409);
    expect(await bearerStatus(server, rotated.token)).toBe(200);

    const revokedResponse = await fetch(
      `${server.baseUrl}/api/v1/api-keys/${rotated.apiKey.id}/revoke`,
      {
        headers: browserMutationHeaders(server.baseUrl, cookies),
        method: "POST",
      },
    );
    expect(revokedResponse.status).toBe(200);
    expect(await bearerStatus(server, rotated.token)).toBe(401);

    const malformedManagedKey = `${rotated.token}tampered`;
    expect(await bearerStatus(server, malformedManagedKey)).toBe(401);
    expect(await bearerStatus(server, installation.apiToken)).toBe(200);

    const expiringKeyResponse = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify({
        capabilities: ["artifact:read"],
        expiresAt: "2026-08-13T08:01:00.000Z",
        name: "Short-lived automation",
      }),
      headers: browserMutationHeaders(server.baseUrl, cookies),
      method: "POST",
    });
    const expiringKey = issuedKeySchema.parse(await expiringKeyResponse.json());
    expect(await bearerStatus(server, expiringKey.token)).toBe(200);
    clock.advance(60_001);
    expect(await bearerStatus(server, expiringKey.token)).toBe(401);

    const humanKeyResponse = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify({
        capabilities: ["artifact:read"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        memberId: admittedMember.id,
        name: "Second member personal key",
      }),
      headers: browserMutationHeaders(server.baseUrl, cookies),
      method: "POST",
    });
    expect(humanKeyResponse.status).toBe(201);
    const humanKey = issuedHumanKeySchema.parse(await humanKeyResponse.json());
    expect(humanKey.apiKey.principalId).toBe(admittedMember.id);
    expect(await bearerStatus(server, humanKey.token)).toBe(200);
    expect(await publishStatus(server, humanKey.token))
      .toBe(403);

    const deactivateMember = await fetch(
      `${server.baseUrl}/api/v1/members/${admittedMember.id}/deactivate`,
      {
        headers: browserMutationHeaders(server.baseUrl, cookies),
        method: "POST",
      },
    );
    expect(deactivateMember.status).toBe(200);
    expect(await bearerStatus(server, humanKey.token)).toBe(401);
  });

  test("AUTH-023-B AUTH-023-F AUTH-024-B: local-owner browsers receive a stable session only across the loopback same-origin boundary", async () => {
    const contextResponse = await fetch(`${server.baseUrl}/auth/context`);
    expect(contextResponse.status).toBe(200);
    expect(contextResponse.headers.get("cache-control")).toBe("private, no-store");
    await expect(contextResponse.json()).resolves.toEqual({
      accessMode: "local_owner",
      login: {kind: "local_owner"},
    });

    const exchange = () => fetch(`${server.baseUrl}/auth/local-owner`, {
      headers: {
        Origin: server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
      method: "POST",
    });
    const firstExchange = await exchange();
    expect(firstExchange.status).toBe(204);
    expect(firstExchange.headers.get("cache-control")).toBe("private, no-store");
    expect(firstExchange.headers.get("referrer-policy")).toBe("no-referrer");
    const firstCookies = applicationCookies(firstExchange.headers.getSetCookie());
    const firstSessionResponse = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Cookie: firstCookies.header},
    });
    const firstPrincipal = sessionResponseSchema.parse(
      await firstSessionResponse.json(),
    ).principal;

    const secondExchange = await exchange();
    expect(secondExchange.status).toBe(204);
    const secondCookies = applicationCookies(secondExchange.headers.getSetCookie());
    const secondSessionResponse = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Cookie: secondCookies.header},
    });
    const secondPrincipal = sessionResponseSchema.parse(
      await secondSessionResponse.json(),
    ).principal;
    expect(secondPrincipal.id).toBe(firstPrincipal.id);

    const hostileHeaders = {
      Origin: server.baseUrl,
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    };
    const deniedRequests = [
      fetch(`${server.baseUrl}/auth/local-owner`, {method: "POST"}),
      fetch(`${server.baseUrl}/auth/local-owner`, {
        headers: {...hostileHeaders, Origin: "https://hostile.example"},
        method: "POST",
      }),
      fetch(`${server.baseUrl}/auth/local-owner`, {
        headers: {...hostileHeaders, "Sec-Fetch-Site": "cross-site"},
        method: "POST",
      }),
      fetch(`${server.baseUrl}/auth/local-owner`, {
        headers: {...hostileHeaders, "X-Forwarded-For": "127.0.0.1"},
        method: "POST",
      }),
      fetch(`${server.baseUrl}/auth/local-owner`, {
        headers: {
          ...hostileHeaders,
          "X-Artifact-Server-Development-Proxy": "untrusted-proxy",
        },
        method: "POST",
      }),
      fetch(`${server.baseUrl}/auth/local-owner`, {
        headers: {
          ...hostileHeaders,
          Host: `loopback.example:${server.port}`,
          Origin: `http://loopback.example:${server.port}`,
        },
        method: "POST",
      }),
    ];
    await expect(Promise.all(deniedRequests).then((responses) =>
      responses.map((response) => response.status)
    )).resolves.toEqual([403, 403, 403, 403, 403, 403]);
    await expect(startTestServer(installation, {
      clock,
      hostname: "0.0.0.0",
    })).rejects.toThrow("must bind to an exact loopback address");

    const nonEmpty = await fetch(`${server.baseUrl}/auth/local-owner`, {
      body: "{}",
      headers: hostileHeaders,
      method: "POST",
    });
    expect(nonEmpty.status).toBe(422);

    const contentHostContext = await fetchVersion(
      server,
      `http://${"c".repeat(32)}.localhost:${server.port}/auth/context`,
    );
    expect(contentHostContext.status).toBe(404);

    await server.stop();
    const developmentProxyCredential = "development-proxy-credential-with-entropy";
    server = await startTestServer(installation, {
      clock,
      developmentProxyCredential,
    });
    const proxiedExchange = await fetch(`${server.baseUrl}/auth/local-owner`, {
      headers: {
        Origin: server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "X-Artifact-Server-Development-Proxy": developmentProxyCredential,
      },
      method: "POST",
    });
    expect(proxiedExchange.status).toBe(204);
  });

  test("AUTH-024-F: hostile, ambiguous, forwarded, proxied, and private-team requests never create a local-owner member or session", async () => {
    const boundary = {
      origin: server.baseUrl,
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    };
    const loopbackHost = `127.0.0.1:${server.port}`;
    const aliasRequests = [
      "localtest.me",
      "127.0.0.1.nip.io",
      "localhost.",
      "127.0.0.2",
      "0.0.0.0",
      "[::ffff:127.0.0.1]",
      `${"c".repeat(32)}.localhost`,
    ].map((alias) => {
      const host = `${alias}:${server.port}`;
      // Origin matches the claimed host, so only the host itself is refused.
      return {
        host,
        origin: `http://${host}`,
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      };
    });
    const deniedHeaderSets: Record<string, string | string[]>[] = [
      ...aliasRequests,
      {...boundary, host: loopbackHost, "sec-fetch-site": ["same-origin", "cross-site"]},
      {...boundary, host: loopbackHost, "sec-fetch-mode": ["cors", "navigate"]},
      {...boundary, host: loopbackHost, "sec-fetch-mode": "navigate"},
      {...boundary, host: loopbackHost, "sec-fetch-mode": "no-cors"},
      {host: loopbackHost, origin: server.baseUrl, "sec-fetch-mode": "cors"},
      {host: loopbackHost, origin: server.baseUrl, "sec-fetch-site": "same-origin"},
      {...boundary, host: loopbackHost, "sec-fetch-site": "same-site"},
      {...boundary, host: loopbackHost, "sec-fetch-site": "none"},
      {...boundary, host: loopbackHost, origin: "null"},
      {...boundary, host: loopbackHost, origin: [server.baseUrl, "https://hostile.example"]},
      {"sec-fetch-mode": "cors", "sec-fetch-site": "same-origin", host: loopbackHost},
      {...boundary, forwarded: "for=127.0.0.1;host=localhost", host: loopbackHost},
      {...boundary, host: loopbackHost, "x-forwarded-host": loopbackHost},
      {...boundary, host: loopbackHost, "x-forwarded-proto": "http"},
      {...boundary, host: loopbackHost, "x-real-ip": "127.0.0.1"},
      {...boundary, host: loopbackHost, "x-artifact-server-development-proxy": "forged-proxy-credential"},
    ];
    const denied = await Promise.all(deniedHeaderSets.map((headers) =>
      rawLocalOwnerExchange(server.port, headers)
    ));
    // An unparseable IPv4-mapped host is rejected as a bad request, and a
    // content host has no local-owner route; every other refusal is the
    // exchange's own 403.
    expect(denied.map(({status}) => status)).toEqual(deniedHeaderSets.map((_, index) =>
      index === 5 ? 400 : index === 6 ? 405 : 403
    ));
    expect(denied.flatMap(({setCookie}) => setCookie)).toEqual([]);

    // Non-loopback binds never start a local-owner runtime.
    await expect(startTestServer(installation, {clock, hostname: "0.0.0.0"}))
      .rejects.toThrow("must bind to an exact loopback address");
    await expect(startTestServer(installation, {clock, hostname: "::"}))
      .rejects.toThrow("must bind to an exact loopback address");

    // A credential from a previous development run is stale once the proxy
    // restarts with a fresh one.
    const priorRunCredential = "development-proxy-credential-from-the-prior-run";
    const currentRunCredential = "development-proxy-credential-for-the-current-run";
    await server.stop();
    server = await startTestServer(installation, {
      clock,
      developmentProxyCredential: currentRunCredential,
    });
    const proxied = (credential: string) => rawLocalOwnerExchange(server.port, {
      host: `127.0.0.1:${server.port}`,
      origin: server.baseUrl,
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "x-artifact-server-development-proxy": credential,
    });
    const stale = await proxied(priorRunCredential);
    expect([stale.status, stale.setCookie]).toEqual([403, []]);
    // Without a configured development proxy, any proxy credential is refused.
    await server.stop();
    server = await startTestServer(installation, {clock});
    const unconfigured = await proxied(currentRunCredential);
    expect([unconfigured.status, unconfigured.setCookie]).toEqual([403, []]);

    // Private-team mode has no local-owner route at all.
    await server.stop();
    server = await startTestServer(installation, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      clock,
      interactiveIdentityProvider: new TestIdentityProvider({
        displayName: "Team administrator",
        email: "administrator@example.test",
        emailVerified: true,
        provider: "test-oidc",
        subject: "team-administrator",
      }),
    });
    const privateTeam = await proxied(currentRunCredential);
    expect([privateTeam.status, privateTeam.setCookie]).toEqual([404, []]);
    const privateTeamDirect = await rawLocalOwnerExchange(server.port, {
      host: `127.0.0.1:${server.port}`,
      origin: server.baseUrl,
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    });
    expect([privateTeamDirect.status, privateTeamDirect.setCookie]).toEqual([404, []]);

    // None of the refusals created a member: the first valid exchange finds
    // only the stable local administrator.
    await server.stop();
    server = await startTestServer(installation, {clock});
    const accepted = await rawLocalOwnerExchange(server.port, {
      host: `127.0.0.1:${server.port}`,
      origin: server.baseUrl,
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    });
    expect(accepted.status).toBe(204);
    const members = await fetch(`${server.baseUrl}/api/v1/members`, {
      headers: {Cookie: applicationCookies(accepted.setCookie).header},
    });
    expect(members.status).toBe(200);
    expect(z.object({members: z.array(z.object({role: z.string()}))}).parse(await members.json()).members)
      .toEqual([expect.objectContaining({role: "administrator"})]);
  });

  test("AUTH-028-F: current-member, last-administrator, racing, and local-owner deactivations change no membership, session, or audit state", async () => {
    await server.stop();
    const provider = new TestIdentityProvider({
      displayName: "First administrator",
      email: "first@example.test",
      emailVerified: true,
      provider: "test-oidc",
      subject: "first-administrator",
    });
    server = await startTestServer(installation, {
      bootstrapAdministratorEmail: "first@example.test",
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      clock,
      interactiveIdentityProvider: provider,
    });
    const signIn = async (identity: {email: string; subject: string}) => {
      provider.identity = {...provider.identity, ...identity};
      const started = await fetch(`${server.baseUrl}/auth/login`, {redirect: "manual"});
      const callbackUrl = new URL("/auth/callback", server.baseUrl);
      callbackUrl.searchParams.set("code", provider.authorizationCode);
      callbackUrl.searchParams.set("state", provider.authorization.state);
      const completed = await fetch(callbackUrl, {
        headers: {Cookie: loginHandshakeCookie(started)},
        redirect: "manual",
      });
      expect(completed.status).toBe(303);
      const cookies = applicationCookies(completed.headers.getSetCookie());
      const session = await fetch(`${server.baseUrl}/api/v1/session`, {headers: {Cookie: cookies.header}});
      return {cookies, id: sessionResponseSchema.parse(await session.json()).principal.id};
    };
    const admit = async (email: string, role: "administrator" | "member") => {
      const response = await fetch(`${server.baseUrl}/api/v1/members`, {
        body: JSON.stringify({displayName: email, email, role}),
        headers: browserMutationHeaders(server.baseUrl, first.cookies),
        method: "POST",
      });
      expect(response.status).toBe(201);
    };
    const deactivate = (actor: ApplicationCookies, memberId: string) => fetch(
      `${server.baseUrl}/api/v1/members/${memberId}/deactivate`,
      {headers: browserMutationHeaders(server.baseUrl, actor), method: "POST"},
    );
    const memberStatesSchema = z.object({
      members: z.array(z.object({id: z.string(), role: z.string(), status: z.string()})),
    });
    const membership = async (actor: ApplicationCookies) => {
      const response = await fetch(`${server.baseUrl}/api/v1/members`, {headers: {Cookie: actor.header}});
      expect(response.status).toBe(200);
      return memberStatesSchema.parse(await response.json()).members
        .map(({id, role, status}) => `${id}:${role}:${status}`).toSorted();
    };
    const auditTotal = async (actor: ApplicationCookies) => {
      const response = await fetch(`${server.baseUrl}/api/v1/activity/facets`, {headers: {Cookie: actor.header}});
      expect(response.status).toBe(200);
      return z.object({total: z.number().int()}).parse(await response.json()).total;
    };
    const sessionStatus = (actor: ApplicationCookies) => fetch(
      `${server.baseUrl}/api/v1/session`,
      {headers: {Cookie: actor.header}},
    ).then((response) => response.status);

    const first = await signIn({email: "first@example.test", subject: "first-administrator"});
    await admit("second@example.test", "administrator");
    const second = await signIn({email: "second@example.test", subject: "second-administrator"});

    // Refusing the current member is its own rule: another administrator remains.
    const membershipBefore = await membership(first.cookies);
    const auditBefore = await auditTotal(first.cookies);
    const self = await deactivate(first.cookies, first.id);
    expect(self.status).toBe(409);
    expect(await self.json()).toMatchObject({error: {code: "IDENTITY_CONFLICT"}});
    expect(await membership(first.cookies)).toEqual(membershipBefore);
    expect(await auditTotal(first.cookies)).toBe(auditBefore);
    expect([await sessionStatus(first.cookies), await sessionStatus(second.cookies)]).toEqual([200, 200]);

    // Two administrators deactivating each other at once cannot remove both:
    // the later attempt meets the last-administrator rule.
    const raced = await Promise.all([
      deactivate(first.cookies, second.id),
      deactivate(second.cookies, first.id),
    ]);
    const racedStatuses = raced.map((response) => response.status);
    expect(racedStatuses.filter((status) => status === 200)).toHaveLength(1);
    expect(racedStatuses.filter((status) => status !== 200).every((status) => [401, 403, 409].includes(status)))
      .toBe(true);
    const survivor = racedStatuses[0] === 200 ? first : second;
    const removed = survivor === first ? second : first;
    const afterRace = await membership(survivor.cookies);
    expect(afterRace.filter((entry) => entry.endsWith(":administrator:active")))
      .toEqual([`${survivor.id}:administrator:active`]);
    expect(await sessionStatus(survivor.cookies)).toBe(200);
    expect(await sessionStatus(removed.cookies)).toBe(401);

    // The survivor is now the last administrator and still cannot remove itself.
    const auditAfterRace = await auditTotal(survivor.cookies);
    expect((await deactivate(survivor.cookies, survivor.id)).status).toBe(409);
    expect(await membership(survivor.cookies)).toEqual(afterRace);
    expect(await auditTotal(survivor.cookies)).toBe(auditAfterRace);
    expect(await sessionStatus(survivor.cookies)).toBe(200);

    // A local-owner installation has no HTTP sign-in for a second
    // administrator, so the stable local administrator's protection is
    // driven through the real application service and SQLite store.
    await expect(localOwnerDeactivationByAnotherAdministrator()).resolves.toEqual({
      failure: "IdentityConflict: The local-owner administrator cannot be deactivated.",
      localOwnerSessionStillValid: true,
      membersUnchanged: true,
    });
  });

  test("AUTH-025-B AUTH-025-F AUTH-026-F: private-team mode advertises its provider and has no local browser bootstrap route", async () => {
    await server.stop();
    const provider = new TestIdentityProvider({
      displayName: "Team administrator",
      email: "administrator@example.test",
      emailVerified: true,
      provider: "test-oidc",
      subject: "team-administrator",
    });
    server = await startTestServer(installation, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      interactiveIdentityProvider: provider,
    });

    const contextResponse = await fetch(`${server.baseUrl}/auth/context`);
    await expect(contextResponse.json()).resolves.toEqual({
      accessMode: "private_team",
      login: {kind: "oidc"},
    });
    const boundaryHeaders = {
      Origin: server.baseUrl,
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    };
    expect((await fetch(`${server.baseUrl}/auth/local-owner`, {
      headers: boundaryHeaders,
      method: "POST",
    })).status).toBe(404);
    expect((await fetch(`${server.baseUrl}/auth/local`, {
      headers: {Authorization: `Bearer ${installation.browserBootstrapToken}`},
      method: "POST",
    })).status).toBe(404);
    expect(await bearerStatus(
      server,
      "legacy-installation-bearer-with-sufficient-entropy",
    )).toBe(401);
    expect(await bearerStatus(server, installation.apiToken)).toBe(200);
    await expect(startTestServer(installation, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
    })).rejects.toThrow("requires exactly one OIDC or WorkOS");
    await expect(startTestServer({
      ...installation,
      apiToken: "legacy-installation-bearer-with-sufficient-entropy",
    }, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      interactiveIdentityProvider: provider,
    })).rejects.toThrow("must use the managed as_key_ format");
  });

  test("concurrent private-team startup cannot seed two machine authorities", async () => {
    await server.stop();
    const provider = new TestIdentityProvider({
      displayName: "Team administrator",
      email: "administrator@example.test",
      emailVerified: true,
      provider: "test-oidc",
      subject: "team-administrator",
    });
    const alternateApiToken =
      `as_key_key_10000000-0000-4000-8000-000000000000_${"z".repeat(43)}`;
    const options = {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      interactiveIdentityProvider: provider,
    } as const;
    const attempts = await Promise.allSettled([
      startTestServer(installation, options),
      startTestServer({...installation, apiToken: alternateApiToken}, options),
    ]);
    const started = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<RunningTestServer> =>
        attempt.status === "fulfilled",
    );
    const refused = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );
    expect(started).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(String(refused[0]?.reason)).toContain(
      "bootstrap key id cannot change",
    );
    const running = started[0]?.value;
    if (running === undefined) throw new Error("One private-team server must start.");
    server = running;
    const firstWon = attempts[0]?.status === "fulfilled";
    expect(await bearerStatus(
      server,
      firstWon ? installation.apiToken : alternateApiToken,
    )).toBe(200);
    expect(await bearerStatus(
      server,
      firstWon ? alternateApiToken : installation.apiToken,
    )).toBe(401);
  });

  test("AUTH-010-B AUTH-010-F AUTH-011-B AUTH-011-F AUTH-012-B AUTH-012-F: browser credentials stay on the application host and mutations require same-origin proof", async () => {
    const localBrowserToken = await issueLocalBrowserLogin(server, installation);
    const login = await fetch(
      `${server.baseUrl}/auth/local?token=${localBrowserToken}`,
      {redirect: "manual"},
    );
    const cookies = applicationCookies(login.headers.getSetCookie());
    expect(cookies.sessionAttributes).toContain("Path=/");
    expect(cookies.sessionAttributes).not.toContain("Domain=");

    const staleCsrf = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({
        displayName: "Must not exist",
        email: "stale-csrf@example.test",
      }),
      headers: {
        ...Object.fromEntries(browserMutationHeaders(server.baseUrl, cookies)),
        "X-CSRF-Token": "x".repeat(43),
      },
      method: "POST",
    });
    expect(staleCsrf.status).toBe(403);

    const hostileOrigin = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({
        displayName: "Must not exist",
        email: "hostile@example.test",
      }),
      headers: {
        ...Object.fromEntries(browserMutationHeaders(server.baseUrl, cookies)),
        Origin: "https://hostile.example",
      },
      method: "POST",
    });
    expect(hostileOrigin.status).toBe(403);

    const crossSiteFetch = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({
        displayName: "Must not exist",
        email: "cross-site@example.test",
      }),
      headers: {
        ...Object.fromEntries(browserMutationHeaders(server.baseUrl, cookies)),
        "Sec-Fetch-Site": "cross-site",
      },
      method: "POST",
    });
    expect(crossSiteFetch.status).toBe(403);

    const corsRead = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {
        Cookie: cookies.header,
        Origin: `http://${"c".repeat(32)}.localhost:${server.port}`,
      },
    });
    expect(corsRead.status).toBe(200);
    expect(corsRead.headers.get("access-control-allow-origin")).toBeNull();
    expect(corsRead.headers.get("access-control-allow-credentials")).toBeNull();

    const corsPreflight = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {
        "Access-Control-Request-Method": "GET",
        Origin: `http://${"c".repeat(32)}.localhost:${server.port}`,
      },
      method: "OPTIONS",
    });
    expect(corsPreflight.status).toBe(401);
    expect(corsPreflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(corsPreflight.headers.get("access-control-allow-credentials")).toBeNull();

    const contentHostLogin = await fetchVersion(
      server,
      `http://${"c".repeat(32)}.localhost:${server.port}/auth/local?token=${localBrowserToken}`,
    );
    expect(contentHostLogin.status).toBe(404);
    expect(contentHostLogin.headers.getSetCookie()).toEqual([]);

    const logout = await fetch(`${server.baseUrl}/api/v1/session/logout`, {
      headers: browserMutationHeaders(server.baseUrl, cookies),
      method: "POST",
    });
    expect(logout.status).toBe(204);
    const afterLogout = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Cookie: cookies.header},
    });
    expect(afterLogout.status).toBe(401);
  });

  test("AUTH-022-B AUTH-022-F: session authentication caching stays a bounded-staleness optimization", async () => {
    const sessionStatus = async (cookieHeader: string): Promise<number> => {
      const response = await fetch(`${server.baseUrl}/api/v1/session`, {
        headers: {Cookie: cookieHeader},
      });
      return response.status;
    };
    const loginCookies = async (): Promise<ApplicationCookies> => {
      const token = await issueLocalBrowserLogin(server, installation);
      const login = await fetch(
        `${server.baseUrl}/auth/local?token=${token}`,
        {redirect: "manual"},
      );
      expect(login.status).toBe(303);
      return applicationCookies(login.headers.getSetCookie());
    };

    expect(await sessionStatus(`artifact_session=${"s".repeat(43)}`)).toBe(401);

    const revoked = await loginCookies();
    expect(await sessionStatus(revoked.header)).toBe(200);
    // Another replica revokes the session directly in shared storage; this
    // process receives no eviction signal, so its warmed check keeps
    // succeeding until the 30-second cache bound passes.
    const database = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
    );
    try {
      database
        .prepare("UPDATE application_sessions SET revoked_at = ?")
        .run(clock.now().toISOString());
    } finally {
      database.close();
    }
    expect(await sessionStatus(revoked.header)).toBe(200);
    clock.advance(30_001);
    expect(await sessionStatus(revoked.header)).toBe(401);
    // The storage refusal is not cached into a later success.
    expect(await sessionStatus(revoked.header)).toBe(401);

    // Same-process logout evicts immediately instead of waiting out the bound.
    const loggedOut = await loginCookies();
    expect(await sessionStatus(loggedOut.header)).toBe(200);
    const logoutResponse = await fetch(`${server.baseUrl}/api/v1/session/logout`, {
      headers: browserMutationHeaders(server.baseUrl, loggedOut),
      method: "POST",
    });
    expect(logoutResponse.status).toBe(204);
    expect(await sessionStatus(loggedOut.header)).toBe(401);

    // A warmed entry never outlives the session's absolute expiry, even
    // inside a fresh 30-second cache window.
    const expiring = await loginCookies();
    clock.advance(12 * 60 * 60 * 1_000 - 10_000);
    expect(await sessionStatus(expiring.header)).toBe(200);
    clock.advance(15_000);
    expect(await sessionStatus(expiring.header)).toBe(401);
  });

  test("AUTH-001-B AUTH-001-F AUTH-028-B: external login admits only the configured first administrator and consumes state once", async () => {
    await server.stop();
    const provider = new TestIdentityProvider({
      displayName: "Michael Ramos",
      email: "ramos@plannotator.ai",
      emailVerified: true,
      provider: "test-workos",
      subject: "workos-user-ramos",
    });
    server = await startTestServer(installation, {
      bootstrapAdministratorEmail: "ramos@plannotator.ai",
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.workOs),
      interactiveIdentityProvider: provider,
    });

    const started = await fetch(
      `${server.baseUrl}/auth/login?returnTo=${encodeURIComponent("https://hostile.example")}`,
      {redirect: "manual"},
    );
    expect(started.status).toBe(302);
    expect(started.headers.get("location")).toBe(provider.authorizationUrl);

    const callbackUrl = new URL("/auth/callback", server.baseUrl);
    callbackUrl.searchParams.set("code", provider.authorizationCode);
    callbackUrl.searchParams.set("state", provider.authorization.state);
    const handshake = loginHandshakeCookie(started);
    const unboundCallback = await fetch(callbackUrl, {redirect: "manual"});
    expect(unboundCallback.status).toBe(401);
    expect(unboundCallback.headers.getSetCookie()).toEqual([]);
    const completed = await fetch(callbackUrl, {
      headers: {Cookie: handshake},
      redirect: "manual",
    });
    expect(completed.status).toBe(303);
    expect(completed.headers.get("location")).toBe("/api/v1/session");
    expect(provider.completedCodeVerifier).toBe(provider.authorization.codeVerifier);
    const cookies = applicationCookies(completed.headers.getSetCookie());
    const signedInSession = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Cookie: cookies.header},
    });
    expect(signedInSession.status).toBe(200);
    const firstAdministrator = sessionResponseSchema.parse(
      await signedInSession.json(),
    ).principal;

    const replay = await fetch(callbackUrl, {
      headers: {Cookie: handshake},
      redirect: "manual",
    });
    expect(replay.status).toBe(401);

    const replacementAdministratorResponse = await fetch(
      `${server.baseUrl}/api/v1/members`,
      {
        body: JSON.stringify({
          displayName: "Replacement administrator",
          email: "replacement@example.test",
          role: "administrator",
        }),
        headers: browserMutationHeaders(server.baseUrl, cookies),
        method: "POST",
      },
    );
    expect(replacementAdministratorResponse.status).toBe(201);
    const replacementAdministrator = z.object({
      member: z.object({email: z.string(), id: z.string()}),
    }).parse(await replacementAdministratorResponse.json()).member;
    provider.identity = {
      ...provider.identity,
      email: replacementAdministrator.email,
    };
    const rebindStart = await fetch(`${server.baseUrl}/auth/login`, {
      redirect: "manual",
    });
    expect(rebindStart.status).toBe(302);
    const rebindCallback = new URL("/auth/callback", server.baseUrl);
    rebindCallback.searchParams.set("code", provider.authorizationCode);
    rebindCallback.searchParams.set("state", provider.authorization.state);
    expect((await fetch(rebindCallback, {
      headers: {Cookie: loginHandshakeCookie(rebindStart)},
      redirect: "manual",
    })).status).toBe(303);

    provider.identity = {
      ...provider.identity,
      subject: "replacement-administrator",
    };
    const replacementStart = await fetch(`${server.baseUrl}/auth/login`, {
      redirect: "manual",
    });
    const replacementCallback = new URL("/auth/callback", server.baseUrl);
    replacementCallback.searchParams.set("code", provider.authorizationCode);
    replacementCallback.searchParams.set("state", provider.authorization.state);
    const replacementCompleted = await fetch(replacementCallback, {
      headers: {Cookie: loginHandshakeCookie(replacementStart)},
      redirect: "manual",
    });
    expect(replacementCompleted.status).toBe(303);
    const replacementCookies = applicationCookies(
      replacementCompleted.headers.getSetCookie(),
    );
    expect((await fetch(
      `${server.baseUrl}/api/v1/members/${firstAdministrator.id}/deactivate`,
      {
        headers: browserMutationHeaders(server.baseUrl, replacementCookies),
        method: "POST",
      },
    )).status).toBe(200);
    expect((await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Cookie: cookies.header},
    })).status).toBe(401);
    expect(await bearerStatus(server, installation.apiToken)).toBe(200);

    provider.identity = {
      ...provider.identity,
      subject: "workos-user-ramos",
    };
    const conflictingRebindStart = await fetch(`${server.baseUrl}/auth/login`, {
      redirect: "manual",
    });
    const conflictingRebindCallback = new URL("/auth/callback", server.baseUrl);
    conflictingRebindCallback.searchParams.set(
      "code",
      provider.authorizationCode,
    );
    conflictingRebindCallback.searchParams.set(
      "state",
      provider.authorization.state,
    );
    expect((await fetch(conflictingRebindCallback, {
      headers: {Cookie: loginHandshakeCookie(conflictingRebindStart)},
      redirect: "manual",
    })).status).toBe(409);

    provider.identity = {
      ...provider.identity,
      email: "outside@example.test",
      subject: "outside-user",
    };
    const outsideStart = await fetch(`${server.baseUrl}/auth/login`, {
      redirect: "manual",
    });
    expect(outsideStart.status).toBe(302);
    const outsideCallback = new URL("/auth/callback", server.baseUrl);
    outsideCallback.searchParams.set("code", provider.authorizationCode);
    outsideCallback.searchParams.set("state", provider.authorization.state);
    expect((await fetch(outsideCallback, {
      headers: {Cookie: loginHandshakeCookie(outsideStart)},
      redirect: "manual",
    })).status).toBe(403);

    const keysResponse = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
      headers: {Cookie: replacementCookies.header},
    });
    expect(keysResponse.status).toBe(200);
    const bootstrapKey = z.object({
      apiKeys: z.array(z.object({id: z.string(), name: z.string()})),
    }).parse(await keysResponse.json()).apiKeys.find(
      (key) => key.name === "Installation bootstrap key",
    );
    expect(bootstrapKey).toBeDefined();
    if (bootstrapKey === undefined) throw new Error("The bootstrap key is missing.");
    const revokedBootstrap = await fetch(
      `${server.baseUrl}/api/v1/api-keys/${bootstrapKey.id}/revoke`,
      {
        headers: browserMutationHeaders(server.baseUrl, replacementCookies),
        method: "POST",
      },
    );
    expect(revokedBootstrap.status).toBe(200);
    expect(await bearerStatus(server, installation.apiToken)).toBe(401);
  });

  test("AUTH-029-B AUTH-029-F: domain admission requires administrator bootstrap and explicit email verification", async () => {
    await server.stop();
    const provider = new TestIdentityProvider({
      displayName: "Michael Ramos",
      email: "ramos@plannotator.ai",
      emailVerified: true,
      emailVerificationAsserted: true,
      provider: "test-oidc",
      subject: "oidc-user-ramos",
    });
    server = await startTestServer(installation, {
      autoAdmitEmailDomains: ["plannotator.ai"],
      bootstrapAdministratorEmail: "ramos@plannotator.ai",
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      interactiveIdentityProvider: provider,
    });
    const login = async () => {
      const started = await fetch(`${server.baseUrl}/auth/login`, {redirect: "manual"});
      expect(started.status).toBe(302);
      const callbackUrl = new URL("/auth/callback", server.baseUrl);
      callbackUrl.searchParams.set("code", provider.authorizationCode);
      callbackUrl.searchParams.set("state", provider.authorization.state);
      return fetch(callbackUrl, {
        headers: {Cookie: loginHandshakeCookie(started)},
        redirect: "manual",
      });
    };
    const sessionRole = async (completed: Response) => {
      const cookies = applicationCookies(completed.headers.getSetCookie());
      const session = await fetch(`${server.baseUrl}/api/v1/session`, {
        headers: {Cookie: cookies.header},
      });
      expect(session.status).toBe(200);
      return z.object({
        principal: z.object({membershipRole: z.enum(["administrator", "member"])}),
      }).parse(await session.json()).principal.membershipRole;
    };

    provider.identity = {
      ...provider.identity,
      email: "first@plannotator.ai",
      subject: "oidc-user-first",
    };
    expect((await login()).status).toBe(403);

    // An allowed domain cannot create the first member ahead of the administrator.
    provider.identity = {
      ...provider.identity,
      email: "ramos@plannotator.ai",
      subject: "oidc-user-ramos",
    };
    const first = await login();
    expect(first.status).toBe(303);
    expect(await sessionRole(first)).toBe("administrator");

    // A colleague on the configured domain is admitted as a plain member.
    provider.identity = {
      ...provider.identity,
      displayName: "Priya Natarajan",
      email: "Priya.Natarajan@Plannotator.AI",
      subject: "oidc-user-natarajan",
    };
    const colleague = await login();
    expect(colleague.status).toBe(303);
    expect(await sessionRole(colleague)).toBe("member");
    const administrator = applicationCookies(first.headers.getSetCookie());
    const listed = await fetch(`${server.baseUrl}/api/v1/members`, {
      headers: {Cookie: administrator.header},
    });
    expect(listed.status).toBe(200);
    expect(z.object({
      members: z.array(z.object({
        admittedBy: z.object({name: z.string()}).nullable(),
        admittedHow: z.enum(["manual", "automatic", "owner"]).nullable(),
        email: z.string(),
      }).loose()),
    }).parse(await listed.json()).members).toEqual(expect.arrayContaining([
      expect.objectContaining({admittedBy: null, admittedHow: "owner", email: "ramos@plannotator.ai"}),
      expect.objectContaining({
        admittedBy: null,
        admittedHow: "automatic",
        email: "priya.natarajan@plannotator.ai",
      }),
    ]));

    // A verified identity outside the domain is still refused.
    provider.identity = {
      ...provider.identity,
      displayName: "Outside Person",
      email: "outside@example.test",
      subject: "outside-user",
    };
    expect((await login()).status).toBe(403);

    provider.identity = {
      ...provider.identity,
      email: "subdomain@team.plannotator.ai",
      subject: "oidc-user-subdomain",
    };
    expect((await login()).status).toBe(403);

    provider.identity = {
      ...provider.identity,
      email: "malformed@@plannotator.ai",
      subject: "oidc-user-malformed-domain",
    };
    expect((await login()).status).toBe(403);

    // An unverified email on the domain is still refused.
    provider.identity = {
      ...provider.identity,
      displayName: "Unverified Colleague",
      email: "unverified@plannotator.ai",
      emailVerified: false,
      subject: "oidc-user-unverified",
    };
    expect((await login()).status).toBe(403);

    // A missing verification assertion cannot admit a new colleague by domain.
    provider.identity = {
      displayName: "Missing assertion",
      email: "missing-claim@plannotator.ai",
      emailVerified: true,
      provider: "test-oidc",
      subject: "oidc-user-missing-claim",
    };
    expect((await login()).status).toBe(403);
  });

  test("external login reports a malformed verified identity as a typed conflict", async () => {
    await server.stop();
    const provider = new TestIdentityProvider({
      displayName: "Malformed identity",
      email: "not-an-email-address",
      emailVerified: true,
      provider: "test-workos",
      subject: "workos-user-malformed",
    });
    server = await startTestServer(installation, {
      bootstrapAdministratorEmail: "ramos@plannotator.ai",
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.workOs),
      interactiveIdentityProvider: provider,
    });

    const started = await fetch(`${server.baseUrl}/auth/login`, {
      redirect: "manual",
    });
    expect(started.status).toBe(302);
    const callback = new URL("/auth/callback", server.baseUrl);
    callback.searchParams.set("code", provider.authorizationCode);
    callback.searchParams.set("state", provider.authorization.state);
    const response = await fetch(callback, {
      headers: {Cookie: loginHandshakeCookie(started)},
      redirect: "manual",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "IDENTITY_CONFLICT",
        message: "A valid email address is required.",
      },
    });
  });

  test("a configured external bearer verifier shares the principal boundary without managed-key parser fallback", async () => {
    await server.stop();
    let verificationCount = 0;
    const externalBearerVerifier: BearerCredentialVerifier = {
      verify: (credential) => {
        verificationCount += 1;
        return Redacted.value(credential) === "trusted-external-access-token"
          ? Effect.succeed({
            authorizedByPrincipalId: "external-issuer",
            capabilities: ["artifact:read"],
            displayName: "External service",
            id: "external-service",
            installationId: "local",
            kind: "service",
            membershipRole: "member",
          })
          : Effect.fail(new AuthenticationRequired({
            message: "The external access token is invalid.",
          }));
      },
    };
    server = await startTestServer(installation, {
      externalApiBearerVerifier: externalBearerVerifier,
    });

    expect(await bearerStatus(server, "trusted-external-access-token")).toBe(200);
    expect(verificationCount).toBe(1);

    const managedLookingToken =
      `as_key_key_00000000-0000-4000-8000-000000000000_${"x".repeat(43)}`;
    expect(await bearerStatus(server, managedLookingToken)).toBe(401);
    expect(verificationCount).toBe(1);
    expect(await bearerStatus(server, "wrong-external-access-token")).toBe(401);
    expect(verificationCount).toBe(2);
  });

  test("API OAuth metadata and challenge name the exact API resource without enabling it by default", async () => {
    const absent = await fetch(
      `${server.baseUrl}/.well-known/oauth-protected-resource/api`,
    );
    expect(absent.status).toBe(404);

    await server.stop();
    server = await startTestServer(installation, {
      apiOAuthResource: {
        authorizationServers: ["https://auth.example.test"],
        resource: "https://team.example.test/api",
      },
    });
    const metadata = await fetch(
      `${server.baseUrl}/.well-known/oauth-protected-resource/api`,
    );
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toEqual({
      authorization_servers: ["https://auth.example.test"],
      bearer_methods_supported: ["header"],
      resource: "https://team.example.test/api",
      scopes_supported: ["artifactserver"],
    });

    const denied = await fetch(`${server.baseUrl}/api/v1/session`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe(
      "Bearer resource_metadata=\"https://team.example.test/.well-known/oauth-protected-resource/api\" scope=\"artifactserver\"",
    );
  });
});

class TestIdentityProvider implements InteractiveIdentityProvider {
  authorization: InteractiveAuthorization = {
    authorizationUrl: "https://identity.example/authorize",
    codeVerifier: "test-code-verifier-with-sufficient-entropy",
    nonce: null,
    state: "test-login-state-with-sufficient-entropy-0",
  };
  readonly authorizationCode = "test-authorization-code";
  readonly name = "test-workos";
  completedCodeVerifier: string | null = null;
  identity: ExternalIdentity;
  #startCount = 0;

  constructor(identity: ExternalIdentity) {
    this.identity = identity;
  }

  get authorizationUrl(): string {
    return this.authorization.authorizationUrl;
  }

  complete(
    code: string,
    codeVerifier: string,
  ): Effect.Effect<ExternalIdentity, IdentityProviderFailure> {
    if (code !== this.authorizationCode) {
      return Effect.fail(new IdentityProviderFailure({message: "Invalid code."}));
    }
    this.completedCodeVerifier = codeVerifier;
    return Effect.succeed(this.identity);
  }

  start(): Effect.Effect<InteractiveAuthorization, IdentityProviderFailure> {
    this.#startCount += 1;
    this.authorization = {
      ...this.authorization,
      state: `test-login-state-with-sufficient-entropy-${this.#startCount}`,
    };
    return Effect.succeed(this.authorization);
  }
}

class MutableClock implements Clock {
  #milliseconds: number;

  constructor(instant: string) {
    this.#milliseconds = new Date(instant).getTime();
  }

  advance(milliseconds: number): void {
    this.#milliseconds += milliseconds;
  }

  now(): Date {
    return new Date(this.#milliseconds);
  }
}

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
  readonly sessionAttributes: string;
}

/**
 * In a local-owner application, let a second, directly signed-in administrator
 * try to deactivate the stable local administrator.
 */
async function localOwnerDeactivationByAnotherAdministrator(): Promise<{
  readonly failure: string;
  readonly localOwnerSessionStillValid: boolean;
  readonly membersUnchanged: boolean;
}> {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-local-owner-admin-"));
  const databasePath = path.join(dataDirectory, "artifact-server.db");
  const repository = new SqliteArtifactRepository(databasePath);
  const identityRepository = new SqliteIdentityRepository(databasePath);
  const runtime = ManagedRuntime.make(createLocalApplicationLayer({
    apiToken: Redacted.make("local-owner-administrator-test-token"),
    blobs: new LocalBlobStore(path.join(dataDirectory, "blobs")),
    bootstrapAdministratorEmail: "local-owner@example.test",
    clock: new MutableClock("2026-08-13T08:00:00.000Z"),
    dispatches: repository,
    externalApiBearerVerifier: null,
    externalMcpBearerVerifier: null,
    externalMcpOAuthVerifier: null,
    ids: new SystemIdGenerator(),
    identityRepository,
    installationId: "local-owner-installation",
    interactiveIdentityProvider: null,
    localBootstrapCredential: null,
    protectBootstrapAdministrator: true,
    repository,
    staging: new LocalStagingStore(path.join(dataDirectory, "staging")),
  }));
  try {
    const run = <A, E>(effect: Effect.Effect<A, E, InstallationAccessService>) =>
      runtime.runPromise(effect);
    const principalOf = (token: string) => run(InstallationAccessService.use((access) =>
      access.authenticateSession(Redacted.make(token))
    )).then(({principal}) => principal);
    const localOwnerSession = await run(InstallationAccessService.use((access) => access.loginAsLocalOwner()));
    const localOwner = await principalOf(localOwnerSession.token);
    await run(InstallationAccessService.use((access) => access.admitMember({
      displayName: "Second administrator",
      email: "second@example.test",
      principal: localOwner,
      role: "administrator",
    })));
    const secondSession = await run(InstallationAccessService.use((access) =>
      access.completeExternalIdentity({
        displayName: "Second administrator",
        email: "second@example.test",
        emailVerified: true,
        provider: "test-oidc",
        subject: "second-administrator",
      })
    ));
    const second = await principalOf(secondSession.token);
    const members = () => run(InstallationAccessService.use((access) => access.listMembers(second)))
      .then((listed) => listed.map(({id, role, status}) => `${id}:${role}:${status}`).toSorted());
    const before = await members();
    const failure = await run(InstallationAccessService.use((access) =>
      access.deactivateMember(second, localOwner.id)
    ).pipe(
      Effect.map(() => "deactivated"),
      Effect.catch((error) => Effect.succeed(`${error._tag}: ${error.message}`)),
    ));
    const after = await members();
    const localOwnerSessionStillValid = await principalOf(localOwnerSession.token)
      .then((principal) => principal.id === localOwner.id, () => false);
    return {failure, localOwnerSessionStillValid, membersUnchanged: JSON.stringify(after) === JSON.stringify(before)};
  } finally {
    await runtime.dispose();
    identityRepository.close();
    repository.close();
    await rm(dataDirectory, {force: true, recursive: true});
  }
}

/** POST the local-owner exchange with exact raw headers, including Host. */
function rawLocalOwnerExchange(
  port: number,
  headers: Readonly<Record<string, string | string[]>>,
): Promise<{readonly setCookie: string[]; readonly status: number}> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      headers: {...headers, "content-length": "0"},
      host: "127.0.0.1",
      method: "POST",
      path: "/auth/local-owner",
      port,
    }, (response) => {
      response.resume();
      response.on("end", () => resolve({
        setCookie: response.headers["set-cookie"] ?? [],
        status: response.statusCode ?? 0,
      }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function applicationCookies(setCookieHeaders: readonly string[]): ApplicationCookies {
  const session = setCookieHeaders.find((value) => value.startsWith("artifact_session="));
  const csrf = setCookieHeaders.find((value) => value.startsWith("artifact_csrf="));
  if (session === undefined || csrf === undefined) {
    throw new Error("The login response did not issue both application cookies.");
  }
  const sessionPair = session.split(";", 1)[0];
  const csrfPair = csrf.split(";", 1)[0];
  if (sessionPair === undefined || csrfPair === undefined) {
    throw new Error("The login response issued a malformed application cookie.");
  }
  const csrfToken = csrfPair.slice(csrfPair.indexOf("=") + 1);
  return {
    csrf: csrfToken,
    header: `${sessionPair}; ${csrfPair}`,
    sessionAttributes: session,
  };
}

function browserMutationHeaders(
  origin: string,
  cookies: ApplicationCookies,
): Headers {
  return new Headers({
    "Content-Type": "application/json",
    Cookie: cookies.header,
    Origin: origin,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": cookies.csrf,
  });
}

async function bearerStatus(
  server: RunningTestServer,
  token: string,
): Promise<number> {
  return fetch(`${server.baseUrl}/api/v1/artifacts`, {
    headers: {Authorization: `Bearer ${token}`},
  }).then((response) => response.status);
}

async function publishStatus(
  server: RunningTestServer,
  token: string,
): Promise<number> {
  const bytes = new TextEncoder().encode("denied");
  return fetch(`${server.baseUrl}/api/v1/uploads`, {
    body: JSON.stringify({
      entryPath: "denied.txt",
      files: [{
        mediaType: "text/plain",
        path: "denied.txt",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      }],
    }),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  }).then((response) => response.status);
}
