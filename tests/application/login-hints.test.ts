// tests/application/login-hints.test.ts
import {Effect, Redacted} from "effect";
import {describe, expect, test} from "vitest";

import {OidcIdentityProvider} from "../../src/identity/oidc-identity-provider.js";
import {WorkOsIdentityProvider} from "../../src/identity/workos-identity-provider.js";
import {startStubOidcProvider} from "../support/stub-oidc-provider.js";

describe("sign-in hints", () => {
  test("WorkOS receives the login hint, the sign-up screen and a forced fresh sign-in", async () => {
    const provider = new WorkOsIdentityProvider({
      apiKey: Redacted.make("sk_test_hints"),
      clientId: "client_hints",
      redirectUri: "https://team.example.test/auth/callback",
    });
    const plain = new URL((await Effect.runPromise(provider.start())).authorizationUrl);
    expect(plain.searchParams.get("login_hint")).toBeNull();
    expect(plain.searchParams.get("max_age")).toBeNull();

    const hinted = new URL((await Effect.runPromise(provider.start({
      forceSignIn: true,
      loginHint: "dana@acme.test",
      screenHint: "sign-up",
    }))).authorizationUrl);
    expect(hinted.searchParams.get("login_hint")).toBe("dana@acme.test");
    expect(hinted.searchParams.get("screen_hint")).toBe("sign-up");
    expect(hinted.searchParams.get("max_age")).toBe("0");
  });

  test("OIDC receives login_hint and prompt=login, and ignores the screen hint", async () => {
    const issuer = await startStubOidcProvider();
    try {
      const provider = new OidcIdentityProvider({
        clientId: issuer.clientId,
        clientSecret: null,
        issuer: issuer.issuer,
        redirectUri: "https://team.example.test/auth/callback",
        scopes: "openid email profile",
      });
      const url = new URL((await Effect.runPromise(provider.start({
        forceSignIn: true,
        loginHint: "dana@acme.test",
        screenHint: "sign-up",
      }))).authorizationUrl);
      expect(url.searchParams.get("login_hint")).toBe("dana@acme.test");
      expect(url.searchParams.get("prompt")).toBe("login");
      expect(url.searchParams.get("screen_hint")).toBeNull();
    } finally {
      await issuer.stop();
    }
  });
});
