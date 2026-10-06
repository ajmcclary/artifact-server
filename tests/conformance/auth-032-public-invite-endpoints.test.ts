// tests/conformance/auth-032-public-invite-endpoints.test.ts
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  bootstrapAdministrator,
  browserMutationHeaders,
  createInvite,
  type InviteServer,
  signInAs,
  startInviteServer,
} from "../support/invites.js";

describe("public invite endpoints", () => {
  let context: InviteServer;

  beforeEach(async () => {
    context = await startInviteServer();
  });

  afterEach(async () => {
    await context.stop();
  });

  test("AUTH-032-B: preview and start work from the application origin and the link carries the token in its fragment", async () => {
    const administrator = await signInAs(context, bootstrapAdministrator);
    const link = await createInvite(context, administrator, {expiresIn: "7d", kind: "link", maxUses: 3});
    expect(new URL(link.url).search).toBe("");
    expect(new URL(link.url).hash).toBe(`#${link.token}`);

    const joined = await fetch(`${context.server.baseUrl}/join`, {redirect: "manual"});
    expect(joined.status).toBe(308);
    expect(joined.headers.get("location")).toBe("/review/join");

    const preview = await fetch(`${context.server.baseUrl}/auth/invites/preview`, {
      body: JSON.stringify({token: link.token}),
      headers: browserMutationHeaders(context.server.baseUrl, null),
      method: "POST",
    });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("cache-control")).toBe("private, no-store");
    expect(await preview.json()).toMatchObject({
      inviterName: "Jordan Lee",
      kind: "link",
      maskedEmail: null,
      role: "member",
      status: "active",
      usesLeft: 3,
    });

    const started = await fetch(`${context.server.baseUrl}/auth/invites/start`, {
      body: JSON.stringify({token: link.token}),
      headers: browserMutationHeaders(context.server.baseUrl, null),
      method: "POST",
    });
    expect(started.status).toBe(200);
    expect(z.object({authorizationUrl: z.string()}).parse(await started.json()).authorizationUrl)
      .toContain("/auth/callback");
    expect(started.headers.getSetCookie().some((value) => value.startsWith("artifact_login="))).toBe(true);
    expect(context.provider.startedWith.at(-1)).toEqual({screenHint: "sign-up"});
  });

  test("AUTH-032-F: cross-origin, malformed and repeated invalid requests are refused", async () => {
    const administrator = await signInAs(context, bootstrapAdministrator);
    const valid = await createInvite(context, administrator, {expiresIn: "7d", kind: "link", maxUses: 3});
    const crossOrigin = await fetch(`${context.server.baseUrl}/auth/invites/preview`, {
      body: JSON.stringify({token: "as_inv_x"}),
      headers: {"Content-Type": "application/json", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site"},
      method: "POST",
    });
    expect(crossOrigin.status).toBe(403);

    const malformed = await fetch(`${context.server.baseUrl}/auth/invites/preview`, {
      body: JSON.stringify({token: 7}),
      headers: browserMutationHeaders(context.server.baseUrl, null),
      method: "POST",
    });
    expect(malformed.status).toBe(422);

    const oversized = await fetch(`${context.server.baseUrl}/auth/invites/preview`, {
      body: JSON.stringify({token: "x".repeat(2_000_000)}),
      headers: browserMutationHeaders(context.server.baseUrl, null),
      method: "POST",
    });
    expect(oversized.status).toBe(413);

    const attempts = await Promise.all(Array.from({length: 40}, (_, attempt) =>
      fetch(`${context.server.baseUrl}/auth/invites/preview`, {
        body: JSON.stringify({token: `as_inv_inv_00000000-0000-4000-8000-${String(attempt).padStart(12, "0")}_${"a".repeat(43)}`}),
        headers: browserMutationHeaders(context.server.baseUrl, null),
        method: "POST",
      })));
    const limited = attempts.find((response) => response.status === 429);
    expect(limited?.status).toBe(429);
    expect(Number(limited?.headers.get("retry-after"))).toBeGreaterThan(0);

    // A full failure window never locks out a holder of a valid token.
    const stillWorks = await fetch(`${context.server.baseUrl}/auth/invites/preview`, {
      body: JSON.stringify({token: valid.token}),
      headers: browserMutationHeaders(context.server.baseUrl, null),
      method: "POST",
    });
    expect(stillWorks.status).toBe(200);
    expect(await stillWorks.json()).toMatchObject({status: "active"});
    const startStillWorks = await fetch(`${context.server.baseUrl}/auth/invites/start`, {
      body: JSON.stringify({token: valid.token}),
      headers: browserMutationHeaders(context.server.baseUrl, null),
      method: "POST",
    });
    expect(startStillWorks.status).toBe(200);
  });
});
