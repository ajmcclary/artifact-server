# 0031: OIDC email binding requires an explicit verification claim

**Status:** Accepted
**Date:** September 28, 2026

## Decision

Generic OIDC browser login accepts an email for member lookup, first
administrator bootstrap, or a new issuer-subject binding only when the signed
ID token carries `email_verified: true`. A false or absent claim is refused.
The MCP OIDC path already requires that same positive assertion. There is no
configuration option that turns a missing assertion into verification.

This supersedes the missing-claim rule in [ADR 0020](0020-generic-oidc-login.md)
and the browser/MCP distinction recorded in
[ADR 0028](0028-oidc-mcp-oauth.md) and
[ADR 0030](0030-verified-domain-admission.md). Those records remain as the
history of the earlier compatibility decision.

## Reason

An ID token's signature, issuer, audience, nonce, and subject establish who
the issuer authenticated. They do not establish ownership of an email when
the issuer omits its verification claim. Artifact Server falls back from an
unbound subject to an admitted member's email, then binds that subject to the
member. On a fresh installation, the same email path can claim the bootstrap
administrator. Treating omission as verified lets an issuer that permits an
unverified email make those bindings without an affirmative ownership signal.

## Consequences

- IdPs that omit `email_verified` must be configured to emit it for browser
  login. Existing sessions and API keys are unaffected; a new browser login
  with an absent or false claim is refused.
- The adapter maps both `emailVerified` and `emailVerificationAsserted` to
  `true` only for an explicit `email_verified: true` claim. Admission continues
  to own member and role decisions.
- AUTH-019 normal and hostile tests use a real stub OIDC HTTP boundary: a true
  claim signs in, while absent and false claims create no member or session.
