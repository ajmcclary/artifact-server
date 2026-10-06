// deploy/cloudflare/tests/d1-login-attempt-invite.test.ts
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";
import {getPlatformProxy} from "wrangler";

import {createD1IdentityRepository} from "../src/d1-identity-repository.js";
import {migrateD1} from "../src/d1-migrations.js";

const openLocalD1 = () => getPlatformProxy<{ARTIFACT_SERVER_D1_DATABASE: D1Database}>({
  configPath: fileURLToPath(new URL("../wrangler.git-store.test.jsonc", import.meta.url)),
  envFiles: [],
  persist: false,
  remoteBindings: false,
});

describe("D1 login attempts carry an invite", () => {
  it("returns the invite an attempt was started with", async () => {
    const proxy = await openLocalD1();
    try {
      const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
      await migrateD1(binding, "d1-login-invite");
      const identity = createD1IdentityRepository(binding);
      const base = {
        codeVerifier: "verifier",
        createdAt: "2026-10-06T10:00:00.000Z",
        expiresAt: "2026-10-06T10:10:00.000Z",
        nonce: null,
        provider: "workos",
        returnTo: "/review",
      };
      await identity.createLoginAttempt({...base, inviteId: "inv_1", stateDigest: "state-a"});
      await identity.createLoginAttempt({...base, inviteId: null, stateDigest: "state-b"});
      await expect(identity.consumeLoginAttempt("state-a", "workos", "2026-10-06T10:01:00.000Z"))
        .resolves.toMatchObject({inviteId: "inv_1"});
      await expect(identity.consumeLoginAttempt("state-b", "workos", "2026-10-06T10:01:00.000Z"))
        .resolves.toMatchObject({inviteId: null});
    } finally {
      await proxy.dispose();
    }
  });
});
