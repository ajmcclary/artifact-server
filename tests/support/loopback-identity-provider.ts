import {Effect} from "effect";

import type {
  InteractiveAuthorization,
  InteractiveIdentityProvider,
  LoginHints,
} from "../../src/application/interactive-login.js";
import {IdentityProviderFailure} from "../../src/core/errors.js";
import type {ExternalIdentity} from "../../src/core/installation-identity.js";

/**
 * A provider whose authorization URL is this server's own callback, so a
 * browser or fetch that follows redirects completes login without a network
 * identity provider. Set `identity` before each sign-in.
 */
export class LoopbackIdentityProvider implements InteractiveIdentityProvider {
  readonly authorizationCode = "loopback-authorization-code";
  baseUrl = "http://127.0.0.1";
  identity: ExternalIdentity = {
    displayName: "Nobody",
    email: "nobody@example.test",
    emailVerificationAsserted: true,
    emailVerified: true,
    provider: "workos",
    subject: "nobody",
  };
  readonly name = "workos";
  readonly startedWith: LoginHints[] = [];
  /** The identity each issued code completes as, captured when its login started. */
  readonly #identities = new Map<string, ExternalIdentity>();
  #starts = 0;

  start(hints: LoginHints = {}): Effect.Effect<InteractiveAuthorization, IdentityProviderFailure> {
    this.#starts += 1;
    this.startedWith.push(hints);
    const state = `loopback-login-state-with-sufficient-entropy-${this.#starts}`;
    const code = `${this.authorizationCode}-${this.#starts}`;
    this.#identities.set(code, this.identity);
    const url = new URL("/auth/callback", this.baseUrl);
    url.searchParams.set("code", code);
    url.searchParams.set("state", state);
    return Effect.succeed({
      authorizationUrl: url.toString(),
      codeVerifier: "loopback-code-verifier-with-sufficient-entropy",
      nonce: null,
      state,
    });
  }

  complete(code: string): Effect.Effect<ExternalIdentity, IdentityProviderFailure> {
    const identity = this.#identities.get(code);
    return identity === undefined
      ? Effect.fail(new IdentityProviderFailure({message: "Unexpected code."}))
      : Effect.succeed(identity);
  }
}
