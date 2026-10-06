# 0032: Administrator-issued invite links

**Status:** Accepted
**Date:** October 6, 2026
**Supersedes in part:** [ADR 0025](0025-local-owner-and-private-team-access.md) ("no invitation")

## Decision

An installation administrator may issue an invite link. The link admits its
holder to the installation after they sign in through the installation's
configured identity provider. It is a fourth admission path beside manual
admission, the bootstrap owner and verified-domain admission.

Artifact Server owns the invite. It issues the token, stores only its SHA-256
digest, enforces expiry, use limits and revocation, and records every
creation, redemption and revocation in the activity log. The identity provider
only proves who the person is; it never decides admission. Artifact Server
sends no email: the administrator shares the link through the team's own
channel.

Two kinds exist. A one-person invite names one email address, may grant the
Member or Administrator role, and works once for a person whose verified
email matches. A link invite works for up to 100 people and only ever admits
Members. Every invite expires after 24 hours, 7 days or 30 days.

Redemption requires a verified email that the provider explicitly asserts.
Invites exist only when an interactive identity provider is configured; a
local-owner installation refuses them. Projects still have no members: an
invite admits a person to the installation and only chooses where they land.

The token travels in the URL fragment (`/join#<token>`) so it never reaches
server logs, proxies or `Referer` headers. Public invite endpoints accept the
token in a same-origin POST body and are bounded by an in-process limiter on
failed lookups.

## Consequences

Provider-side sign-up must stay enabled so that a person without an account
can create one; Artifact Server still refuses everyone it has not admitted.
