# 0030: Optional verified-domain member admission

**Status:** Accepted
**Date:** September 16, 2026

## Decision

An administrator may configure a bounded list of email domains for first-login
member admission. The option is off by default. The configured bootstrap
administrator must complete the first external login before a domain can admit
any other member; a domain match never grants administrator authority.

Domain admission requires an explicit positive email-verification assertion
from the configured identity provider. Generic OIDC login has an established
rule that an absent `email_verified` claim is trusted for a pre-admitted person
or the bootstrap administrator. That rule remains intact. An absent claim is
insufficient to create a new member merely because their email matches a
configured domain. An explicit `false` still refuses all login.

The configuration is a set of normalized DNS domains, matched against the
entire domain after `@`, never a suffix. Cloudflare, Node compact and external
storage, Compose, Helm, AWS, and GCP pass the same optional setting. Invalid
configured domains fail validation rather than broadening admission.

Administrators retain explicit admission and deactivation controls. Changing
the allowed domains affects future first logins; it does not deactivate existing
members or change their durable attribution.
