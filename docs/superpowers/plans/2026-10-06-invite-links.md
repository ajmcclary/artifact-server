# Invite Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an installation administrator issue a one-person or capped link invite that admits the holder through the configured sign-in provider (WorkOS AuthKit in production).

**Architecture:** Artifact Server owns the invite: a provider-neutral core model (`src/core/invitations.ts`), one `InvitationRepository` port implemented by SQLite, Postgres and D1, an `InvitationService` for issuance and preview, and redemption inside `InstallationAccessService.resolveExternalMember` driven by an invite id carried on the existing login attempt. Public `/auth/invites/*` endpoints and a `/review/join` screen let the invitee preview and start sign-in; administrators work invites from the Share popover and a Settings area.

**Tech Stack:** TypeScript, Effect 4 (`Context.Service`, `Effect.fn`, `Schema.TaggedError`), Hono, zod 4, `node:sqlite`, Postgres through `effect/unstable/sql`, Cloudflare D1, `@workos-inc/node` 10.9, React 18 with the ArkCase design system, Vitest, Playwright.

**Spec:** [docs/superpowers/specs/2026-10-06-invite-links-design.md](../specs/2026-10-06-invite-links-design.md)

## Global Constraints

- Token format: `as_inv_<inviteId>_<secret>`; `inviteId` is `inv_<uuid>`; `secret` comes from `IdentitySecretProvider.issue()` (32 random bytes, base64url). Only `sha256(token)` is stored; compare with `identitySecretsEqual`.
- The invite URL is `<origin>/join#<token>`; the token never appears in a request URL the server receives.
- `maxUses`: one-person invites exactly 1; link invites 1–100. Expiry is one of `24h`, `7d`, `30d`.
- A link invite only ever admits `member`. A one-person invite admits `member` or `administrator`.
- Only a human administrator (`isHumanAdministrator`) creates, lists or revokes invites. Invites exist only when an interactive identity provider is configured (`private_team`); otherwise `INVITES_UNAVAILABLE` (409).
- Redemption requires `emailVerified === true` and `emailVerificationAsserted === true`.
- Admission method `invite`; attribution is the creating administrator; every create, revoke and redemption writes exactly one activity row (`invite_create`, `invite_revoke`, `invite_redeem`), plus the existing `member_admit` on redemption.
- Status order: Revoked, then Used (`useCount >= maxUses`), then Expired (`expiresAt <= now`), else Active.
- No module mocks. Tests use real services, temporary SQLite files, the Postgres harness (`ARTIFACT_SERVER_TEST_DATABASE_URL`), local D1 through `wrangler.getPlatformProxy`, and real HTTP.
- Conformance test titles start with their requirement IDs (`AUTH-030-B`, `AUTH-030-F`, …). Browser specs record into `project/evidence/browser.json`.
- Do not weaken TypeScript, Oxlint or anti-slop rules. Copy follows the existing UI voice: Title Case buttons, sentence-case helper text, MM/DD/YYYY dates.

## Spec adjustments this plan makes

Task 1 writes these into the spec so the document stays the source of truth. Each is a consequence of reading the code; none changes a decision the user made.

1. **`last_redeemed_member_id` column** on `installation_invites` (all backends). D1 batches cannot branch, so the member insert is conditioned on this column matching the new member's id after the guarded `UPDATE`.
2. **Two Postgres migrations**: `0021_login_attempt_invite` (Task 3) and `0022_installation_invites` (Task 5), instead of one.
3. **`/join` redirects** (308) to `/review/join`, where the application shell already lives. Browsers carry the `#token` fragment across the redirect.
4. **Invites is its own administration area** ("Invites", under People and access, `/review/settings/invites`) rather than a tab inside Members. Every other people setting is an area; this reuses `AdminConsole`.
5. **New refusal outcome `account_unavailable`**: a link invite redeemed by the email or sign-in identity of a deactivated member.
6. **Preview carries `usesLeft`** so a link invite shows "7 of 10 uses left".
7. **Switching accounts**: the invitation screen offers "Use a Different Account", which restarts sign-in with WorkOS `maxAge: 0` (OIDC `prompt=login`). The wrong-account screen asks the person to reopen the link and choose it, because the server never sends the token back.
8. **After joining**, the callback returns to `/review/join?next=<destination>` so the welcome screen shows before the artifact opens.
9. **Startup notice** is printed by the Node CLI start commands only; Cloudflare has no startup console, so its README carries the note.

## Review Focus

1. **A deactivated member's email on a link invite.** Expected: refused as `account_unavailable`, no member created, use not consumed. Pinned in Task 4 (SQLite), Task 5 (Postgres), Task 6 (D1) and Task 8 (HTTP).
2. **An invite whose destination artifact was deleted after creation.** Expected: preview shows no destination; joining still works and lands on Projects. Pinned in Task 8.
3. **An expired invite that is revoked.** Expected: revoke refused with 409 (only an active invite can be revoked), list still shows Expired. Pinned in Task 7.
4. **Mixed-case or padded email on a one-person invite and at sign-in** (`" Dana@ACME.com "`). Expected: both normalize to the same address and redemption succeeds. Pinned in Task 7.
5. **A stale database from before this release** (members admitted, sessions and external identities present). Expected: every migration preserves those rows and their foreign keys. Pinned in Task 4, Task 5 and Task 6.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/invitations.ts` (new) | Provider-neutral invite model: kinds, statuses, lifetimes, token, masking, outcomes, destination paths |
| `src/core/invitation-ports.ts` (new) | `InvitationRepository` port and its record types |
| `src/core/errors.ts` | `InviteRejected`, `InvitesUnavailable`, `InvalidInvite`; new error codes; new repository operations |
| `src/core/identity-ports.ts` | `memberAdmissions.invite`; `IdentityRepository extends InvitationRepository` (Task 7) |
| `src/core/installation-identity.ts` | `LoginAttempt.inviteId` |
| `src/core/model.ts` | Three new installation action kinds; `ActivityDetail` invite fields |
| `src/storage/activity-log-schema.ts` | New kinds in installation-scoped lists; `sqliteActionsWidenStatements`; `sqliteActionsTableAcceptsEveryKind` |
| `src/storage/activity-sql.ts`, `src/application/activity-entries.ts` | Invite kinds in the admin feed |
| `src/storage/invitation-schema.ts` (new) | SQLite/D1 DDL for invites and the members-table rebuild |
| `src/storage/invitation-rows.ts` (new) | Shared row schema, select list, mappers, action inserts |
| `src/storage/sqlite-identity-repository.ts`, `src/storage/sqlite-artifact-repository.ts`, `src/storage/sqlite-schema.ts` | SQLite invites, login-attempt column, members rebuild, actions widen, schema 21 |
| `src/storage/postgres-identity-repository.ts`, `src/storage/postgres-migrations.ts` | Postgres invites, migrations 0021 and 0022 |
| `deploy/cloudflare/src/d1-identity-repository.ts`, `deploy/cloudflare/src/d1-migrations.ts` | D1 invites, schema 18 |
| `src/application/interactive-login.ts` | `LoginHints`; invite-carrying `start`; invite passed to completion |
| `src/identity/workos-identity-provider.ts`, `src/identity/oidc-identity-provider.ts` | Hints mapped to provider parameters |
| `src/application/installation-access.ts` | Redemption in `resolveExternalMember` |
| `src/application/invitations.ts` (new) | `InvitationService`: create, list, revoke, preview, plan login |
| `src/local/create-local-application-layer.ts`, `src/application/application-runtime.ts` | Composition |
| `src/http/invite-rate-limiter.ts` (new) | Sliding-window limiter for invalid invite lookups |
| `src/http/create-http-app.ts` | Admin and public invite routes, `/join`, callback refusal redirect |
| `src/cli/invite-sign-up-notice.ts` (new), `src/cli/lifecycle-commands.ts` | Startup notice |
| `apps/web/src/api/client.ts` | Invite schemas and calls |
| `apps/web/src/review/join/*` (new) | `/review/join` screen |
| `apps/web/src/review/invites/*` (new) | Shared invite form and link-ready panel |
| `apps/web/src/review/settings/*` | Invites area, Members "· Invite" label |
| `apps/web/src/review/workspace/share-popover.tsx`, `apps/web/src/review/review-app.tsx` | Share Invite row and screens |
| `tests/support/loopback-identity-provider.ts`, `tests/support/invites.ts` (new) | Test provider and HTTP helpers |
| Tests | `tests/application/*`, `tests/storage/*`, `tests/integration/*`, `deploy/cloudflare/tests/*`, `tests/conformance/auth-030…032-*.test.ts`, `tests/browser/adm-009-invites.spec.ts` |
| Spec and docs | ADR 0032, access specs, `conformance.yml`, `docs/deployment.md`, `deploy/cloudflare/README.md` |

---

### Task 1: Record the decision and the requirements

**Files:**
- Create: `project/spec/decisions/0032-invite-link-admission.md`
- Modify: `project/spec/local-owner-and-private-team-access-spec.md:72-73` and `:386-388`
- Modify: `project/spec/frontend-mvp-developer-handoff.md:433-434`
- Modify: `project/spec/single-application-administration-spec.md:148-149`
- Modify: `project/spec/decisions/0025-local-owner-and-private-team-access.md:68`
- Modify: `project/spec/conformance.yml` (AUTH-001 text; new AUTH-030, AUTH-031, AUTH-032 after AUTH-029; ADM-009 after ADM-008)
- Modify: `docs/superpowers/specs/2026-10-06-invite-links-design.md` (append "Adjustments during planning")

**Interfaces:**
- Produces: requirement IDs `AUTH-030`, `AUTH-031`, `AUTH-032`, `ADM-009` with acceptance IDs `-B`/`-F`, all `status: specified`, no evidence.

- [ ] **Step 1: Write ADR 0032**

```markdown
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
```

- [ ] **Step 2: Update the access specs and ADR 0025**

In `local-owner-and-private-team-access-spec.md`, replace

```markdown
- public sign-up, invitations sent by Artifact Server, and an organization
  switcher;
```

with

```markdown
- public sign-up, invitation email sent by Artifact Server, and an
  organization switcher (administrator-issued invite links are in scope; see
  ADR 0032);
```

and replace

```markdown
The first-release administration surface remains email-based admission. It
does not send an invitation email. The administrator communicates the server
URL through the team's normal channel.
```

with

```markdown
Administration supports email-based admission and administrator-issued invite
links (ADR 0032). Artifact Server never sends an invitation email: the
administrator shares the server URL or the invite link through the team's
normal channel.
```

In `frontend-mvp-developer-handoff.md`, replace `- Do not build organizations, invitations, public sign-up, project membership,` with `- Do not build organizations, invitation email, public sign-up, project membership,`.

In `single-application-administration-spec.md`, replace

```markdown
This page uses the product's closed admission model. It does not claim to send
an invitation email.
```

with

```markdown
This page uses the product's closed admission model. Administrators may also
issue invite links from the Invites area (ADR 0032). No screen claims to send
an invitation email.
```

In ADR 0025, leave the paragraph that begins `There is no public sign-up, invitation marketplace` (line 68) as it is and append this paragraph after it:

```markdown
ADR 0032 later added administrator-issued invite links as an admission path;
this decision's closed-admission rule otherwise stands.
```

- [ ] **Step 3: Update AUTH-001 and add the four requirements**

Replace AUTH-001's `behavior` and `acceptance.behavior.description`:

```yaml
    behavior: A standalone installation represents one person, team, or company and has no public self-sign-up or organization switcher; people join through installation administration, verified-domain admission, or an administrator-issued invite, and all projects use that installation membership group.
```

```yaml
      behavior: {id: AUTH-001-B, description: "Admit users through installation administration and confirm that each belongs to the one installation group."}
```

(The behavior description is unchanged; only `behavior:` changes.)

Insert after the AUTH-029 entry:

```yaml
  - id: AUTH-030
    kind: security
    behavior: An administrator-issued invite admits its holder through external login with the invite's role, the invite admission method, the inviter's attribution and an invite_redeem record, and refuses every wrong, unverified, ended, tampered or contended redemption without admitting anyone or consuming a use.
    owner: authorization
    source: {file: decisions/0032-invite-link-admission.md, anchor: decision}
    acceptance:
      behavior: {id: AUTH-030-B, description: "Redeem a one-person invite and a link invite through external login; each admits with the invite's role, admission method invite, the inviter as admitter, member_admit and invite_redeem activity, and returns to the invite's destination."}
      failure: {id: AUTH-030-F, description: "Refuse a wrong email, an unverified or unasserted email, an expired, revoked or used-up invite, a deactivated member's identity and a tampered token without admitting or consuming; admit exactly one of two concurrent redemptions of a last use; an active member consumes nothing; preview never consumes."}
    deployments: *all
    status: specified
    depends_on: [AUTH-019, AUTH-025, AUTH-029, ACT-001]
    evidence: []

  - id: AUTH-031
    kind: security
    behavior: Only a human installation administrator creates, lists and revokes invites; the invite token is returned exactly once and only its digest is stored; link invites admit only members and every invite is bounded in uses and lifetime.
    owner: authorization
    source: {file: decisions/0032-invite-link-admission.md, anchor: decision}
    acceptance:
      behavior: {id: AUTH-031-B, description: "As a human administrator create a one-person and a link invite, receive each token once, list them with status and creator, and revoke one."}
      failure: {id: AUTH-031-F, description: "Refuse members, API keys and service principals; a link invite for an administrator; out-of-range uses or lifetime; an email that already belongs to any member; local-owner mode; and reject rule-breaking rows written directly to the database."}
    deployments: *all
    status: specified
    depends_on: [AUTH-030, AUTH-009]
    evidence: []

  - id: AUTH-032
    kind: security
    behavior: Public invite preview and sign-in start accept the token only in a bounded same-origin POST body, never consume a use, and answer repeated invalid tokens with 429 and Retry-After.
    owner: http-api
    source: {file: decisions/0032-invite-link-admission.md, anchor: decision}
    acceptance:
      behavior: {id: AUTH-032-B, description: "Preview an active invite and start its sign-in from the application origin; the join link carries the token only in its fragment."}
      failure: {id: AUTH-032-F, description: "Refuse a cross-origin request and a malformed or oversized body, and answer 429 with Retry-After after repeated invalid tokens."}
    deployments: *all
    status: specified
    depends_on: [AUTH-030]
    evidence: []
```

Insert after the ADM-008 entry:

```yaml
  - id: ADM-009
    kind: behavior
    behavior: Administrators create, copy once and revoke invite links from Share and the Invites area, and an invitee walks from the join link through sign-in to the welcome screen; refusals render readable join pages.
    owner: web-application
    source: {file: single-application-administration-spec.md, anchor: members}
    acceptance:
      behavior: {id: ADM-009-B, description: "Create a link invite from Share and a one-person invite from the Invites area, copy each once, revoke one, and as the invitee open the link, sign in and reach the welcome screen and the artifact."}
      failure: {id: ADM-009-F, description: "A member sees no invite controls, and wrong-account, expired and invalid invites each render their join page rather than JSON."}
    deployments: *all
    status: specified
    depends_on: [AUTH-030, AUTH-031, AUTH-032, ADM-008]
    evidence: []
```

- [ ] **Step 4: Append the planning adjustments to the spec**

Append to `docs/superpowers/specs/2026-10-06-invite-links-design.md`:

```markdown
## Adjustments during planning

Recorded by the implementation plan (`docs/superpowers/plans/2026-10-06-invite-links.md`):

1. `installation_invites` gains `last_redeemed_member_id`; D1 conditions the member insert on it.
2. Postgres uses `0021_login_attempt_invite` and `0022_installation_invites`.
3. `/join` is a 308 redirect to `/review/join`; the fragment survives the redirect.
4. Invites is its own administration area under People and access.
5. Refusal outcome `account_unavailable` covers a deactivated member's email or identity.
6. Preview carries `usesLeft`.
7. The invitation screen offers "Use a Different Account" (WorkOS `maxAge: 0`, OIDC `prompt=login`); the wrong-account screen asks the person to reopen the link.
8. A successful invite login returns to `/review/join?next=<destination>`.
9. The startup notice is printed by the Node CLI start commands; Cloudflare documents it in its README.
```

- [ ] **Step 5: Validate the ledger**

Run: `pnpm conformance:validate && pnpm conformance:tests`
Expected: `Valid conformance ledger: … requirements` and no unknown-ID errors.

- [ ] **Step 6: Commit**

```bash
git add project/spec docs/superpowers/specs/2026-10-06-invite-links-design.md
git commit -m "Specify invite-link admission (ADR 0032, AUTH-030..032, ADM-009)"
```

---

### Task 2: Core invite model, errors and activity kinds

**Files:**
- Create: `src/core/invitations.ts`
- Create: `src/core/invitation-ports.ts`
- Modify: `src/core/errors.ts` (error codes, three tagged errors, union, repository operations)
- Modify: `src/http/artifact-http-failure.ts` (three cases)
- Modify: `src/core/identity-ports.ts` (`memberAdmissions.invite`)
- Modify: `src/core/model.ts` (`installationActionKinds`, `ActivityDetail`)
- Modify: `src/storage/activity-log-schema.ts` (`installationScopedActionKinds`)
- Modify: `src/storage/activity-sql.ts` (`feedKindsByType.admin`, `administrationKinds`)
- Modify: `src/application/activity-entries.ts` (`verbs`, `subjectOf`)
- Test: `tests/application/invitations-model.test.ts`

**Interfaces:**
- Produces (exact names later tasks import):
  - `inviteKinds`, `InviteKind`, `inviteStatuses`, `InviteStatus`, `inviteLifetimes`, `InviteLifetime`, `maximumInviteUses`
  - `InviteDestination`, `Invite`, `StoredInvite`, `ListedInvite`, `AdministeredInvite`
  - `inviteStatus(invite, now: Date): InviteStatus`
  - `inviteCredentialPattern`, `inviteTokenFor(inviteId, secret): string`, `inviteIdFromToken(token): string | null`, `inviteTokenPrefix(inviteId): string`
  - `maskInviteEmail(email): string`
  - `inviteOutcomes`, `InviteOutcome`, `inviteOutcomeMessages`, `outcomeForStatus(status)`, `redemptionRefusal(invite, email, at): InviteOutcome | null`
  - `inviteDestinationPath(destination | null): string`, `inviteWelcomePath(destination | null): string`, `inviteActivitySubject(invite): string`
  - `CreateInviteRecord`, `RevokeInviteRecord`, `RedeemInviteRecord`, `RedeemInviteResult`, `InvitationRepository`
  - errors `InviteRejected({message, outcome})`, `InvitesUnavailable({message})`, `InvalidInvite({message})`; `errorCodes.inviteRejected = "INVITE_REJECTED"`, `errorCodes.invitesUnavailable = "INVITES_UNAVAILABLE"`
  - `memberAdmissions.invite = "invite"`; `installationActionKinds.inviteCreate | inviteRedeem | inviteRevoke`

- [ ] **Step 1: Write the failing test**

```ts
// tests/application/invitations-model.test.ts
import {describe, expect, test} from "vitest";

import {
  InvalidInvite,
  InviteRejected,
  InvitesUnavailable,
} from "../../src/core/errors.js";
import {
  inviteActivitySubject,
  inviteDestinationPath,
  inviteIdFromToken,
  inviteKinds,
  inviteStatus,
  inviteStatuses,
  inviteTokenFor,
  inviteTokenPrefix,
  inviteWelcomePath,
  maskInviteEmail,
  redemptionRefusal,
  type StoredInvite,
} from "../../src/core/invitations.js";
import {artifactServerFailureResponse} from "../../src/http/artifact-http-failure.js";
import {toActivityEntry} from "../../src/application/activity-entries.js";

const inviteId = "inv_0f8fad5b-d9cb-469f-a165-70867728950e";
const secret = "aGVsbG8td29ybGQtaGVsbG8td29ybGQtaGVsbG8td28";

function storedInvite(overrides: Partial<StoredInvite> = {}): StoredInvite {
  return {
    createdAt: "2026-10-06T10:00:00.000Z",
    createdByPrincipalId: "member_admin",
    email: "dana@acme.test",
    expiresAt: "2026-10-13T10:00:00.000Z",
    id: inviteId,
    installationId: "installation",
    kind: inviteKinds.person,
    maxUses: 1,
    opens: null,
    revokedAt: null,
    revokedByPrincipalId: null,
    role: "member",
    secretDigest: "digest",
    tokenPrefix: inviteTokenPrefix(inviteId),
    useCount: 0,
    ...overrides,
  };
}

describe("invite model", () => {
  test("status prefers revoked, then used, then expired", () => {
    const now = new Date("2026-10-07T00:00:00.000Z");
    expect(inviteStatus(storedInvite(), now)).toBe(inviteStatuses.active);
    expect(inviteStatus(storedInvite({useCount: 1}), now)).toBe(inviteStatuses.used);
    expect(inviteStatus(storedInvite({expiresAt: "2026-10-06T23:59:59.999Z"}), now))
      .toBe(inviteStatuses.expired);
    expect(inviteStatus(storedInvite({expiresAt: now.toISOString()}), now))
      .toBe(inviteStatuses.expired);
    expect(inviteStatus(storedInvite({
      expiresAt: "2026-10-01T00:00:00.000Z",
      revokedAt: "2026-10-06T12:00:00.000Z",
      revokedByPrincipalId: "member_admin",
      useCount: 1,
    }), now)).toBe(inviteStatuses.revoked);
  });

  test("tokens round-trip their invite id and refuse other shapes", () => {
    const token = inviteTokenFor(inviteId, secret);
    expect(token).toBe(`as_inv_${inviteId}_${secret}`);
    expect(inviteIdFromToken(token)).toBe(inviteId);
    expect(inviteIdFromToken(`as_key_${inviteId}_${secret}`)).toBeNull();
    expect(inviteIdFromToken(`as_inv_${inviteId}_short`)).toBeNull();
    expect(inviteIdFromToken(`as_inv_inv_NOT-A-UUID_${secret}`)).toBeNull();
    expect(inviteIdFromToken(`${token}\n`)).toBeNull();
  });

  test("masking keeps the first character and the domain only", () => {
    expect(maskInviteEmail("dana.okonkwo@acme.test")).toBe("d••••••@acme.test");
    expect(maskInviteEmail("d@acme.test")).toBe("d••••••@acme.test");
    expect(maskInviteEmail("not-an-email")).toBe("••••••");
  });

  test("redemption refusals name why nothing was admitted", () => {
    const at = "2026-10-07T00:00:00.000Z";
    expect(redemptionRefusal(null, "dana@acme.test", at)).toBe("invalid");
    expect(redemptionRefusal(storedInvite(), "dana@acme.test", at)).toBeNull();
    expect(redemptionRefusal(storedInvite(), "sam@acme.test", at)).toBe("wrong_account");
    expect(redemptionRefusal(storedInvite({useCount: 1}), "dana@acme.test", at)).toBe("used");
    expect(redemptionRefusal(
      storedInvite({kind: inviteKinds.link, email: null, maxUses: 3}),
      "anyone@else.test",
      at,
    )).toBeNull();
  });

  test("destinations become review paths and the welcome path wraps them", () => {
    expect(inviteDestinationPath(null)).toBe("/review/projects");
    const destination = {artifactId: "art_1", projectId: "prj_default", versionId: "ver_2"};
    expect(inviteDestinationPath(destination))
      .toBe("/review?artifact=art_1&project=prj_default&version=ver_2&view=focus");
    expect(inviteWelcomePath(destination))
      .toBe(`/review/join?next=${encodeURIComponent(inviteDestinationPath(destination))}`);
  });

  test("activity subjects describe the invite without the token", () => {
    expect(inviteActivitySubject(storedInvite())).toBe("invite for dana@acme.test");
    expect(inviteActivitySubject(storedInvite({email: null, kind: inviteKinds.link, maxUses: 10})))
      .toBe("invite link (10 uses)");
  });

  test("invite errors map to stable HTTP failures", () => {
    expect(artifactServerFailureResponse(new InviteRejected({message: "No.", outcome: "expired"})))
      .toEqual({code: "INVITE_REJECTED", message: "No.", status: 403});
    expect(artifactServerFailureResponse(new InvitesUnavailable({message: "Off."})))
      .toEqual({code: "INVITES_UNAVAILABLE", message: "Off.", status: 409});
    expect(artifactServerFailureResponse(new InvalidInvite({message: "Bad."})))
      .toEqual({code: "INVALID_INPUT", message: "Bad.", status: 422});
  });

  test("invite activity appears in the admin feed with a described subject", () => {
    const entry = toActivityEntry({
      action: {
        accessFrom: null,
        accessTo: null,
        action: "invite_create",
        actor: {displayName: "Jordan Lee", kind: "human"},
        artifactId: null,
        createdAt: "2026-10-06T10:00:00.000Z",
        detail: {inviteId, subjectName: "invite link (10 uses)"},
        id: "act_1",
        principalId: "member_admin",
        projectId: null,
        replyId: null,
        subjectId: inviteId,
        threadId: null,
        versionId: null,
      },
      artifact: null,
      dispatch: null,
      excerpt: null,
      project: null,
      thread: null,
      versionNumber: null,
    }, {keys: new Map(), members: new Map()});
    expect(entry).toMatchObject({
      kind: "admin",
      subject: {id: inviteId, name: "invite link (10 uses)"},
      verb: "created",
    });
  });
});
```

If `ActivityRow` has more required fields than the object above, add them with `null` values; read `ActivityRow` in `src/core/ports.ts` before running.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/application/invitations-model.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/invitations.js'`.

- [ ] **Step 3: Write `src/core/invitations.ts`**

```ts
import type {MembershipRole} from "./identity.js";

/** The two kinds of invite an administrator can issue. */
export const inviteKinds = {
  link: "link",
  person: "person",
} as const;

/** One invite kind. */
export type InviteKind = (typeof inviteKinds)[keyof typeof inviteKinds];

/** Lifecycle shown for one invite at one instant; never stored. */
export const inviteStatuses = {
  active: "active",
  expired: "expired",
  revoked: "revoked",
  used: "used",
} as const;

/** One invite status. */
export type InviteStatus = (typeof inviteStatuses)[keyof typeof inviteStatuses];

/** The only lifetimes an administrator may choose, in milliseconds. */
export const inviteLifetimes = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
} as const;

/** One offered invite lifetime. */
export type InviteLifetime = keyof typeof inviteLifetimes;

/** Upper bound on a link invite's uses. */
export const maximumInviteUses = 100;

/** The exact version an invite lands on after joining. */
export interface InviteDestination {
  readonly artifactId: string;
  readonly projectId: string;
  readonly versionId: string;
}

/** One administrator-issued invite, without its secret digest. */
export interface Invite {
  readonly createdAt: string;
  readonly createdByPrincipalId: string;
  /** Normalized email for a one-person invite; null for a link invite. */
  readonly email: string | null;
  readonly expiresAt: string;
  readonly id: string;
  readonly installationId: string;
  readonly kind: InviteKind;
  readonly maxUses: number;
  readonly opens: InviteDestination | null;
  readonly revokedAt: string | null;
  readonly revokedByPrincipalId: string | null;
  readonly role: MembershipRole;
  /** `as_inv_<inviteId>`: identifies the token without its secret. */
  readonly tokenPrefix: string;
  readonly useCount: number;
}

/** An invite plus the SHA-256 digest of its token. */
export interface StoredInvite extends Invite {
  readonly secretDigest: string;
}

/** Administrator-facing invite with its creator's display name. */
export interface ListedInvite extends Invite {
  readonly createdByName: string | null;
}

/** Listed invite plus its status at one instant. */
export interface AdministeredInvite extends ListedInvite {
  readonly status: InviteStatus;
}

/** Revocation wins, then a spent cap, then expiry at its exact instant. */
export function inviteStatus(
  invite: Pick<Invite, "expiresAt" | "maxUses" | "revokedAt" | "useCount">,
  now: Date,
): InviteStatus {
  if (invite.revokedAt !== null) return inviteStatuses.revoked;
  if (invite.useCount >= invite.maxUses) return inviteStatuses.used;
  return Date.parse(invite.expiresAt) <= now.getTime()
    ? inviteStatuses.expired
    : inviteStatuses.active;
}

/** Serialized invite credential: `as_inv_<inv_uuid>_<secret>`. */
export const inviteCredentialPattern =
  /^as_inv_(inv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]{32,128})$/u;

/** The full token for one invite id and freshly issued secret. */
export function inviteTokenFor(inviteId: string, secret: string): string {
  return `as_inv_${inviteId}_${secret}`;
}

/** The invite id inside a well-formed token, or null. */
export function inviteIdFromToken(token: string): string | null {
  return inviteCredentialPattern.exec(token)?.[1] ?? null;
}

/** The display prefix stored beside the digest; it never contains the secret. */
export function inviteTokenPrefix(inviteId: string): string {
  return `as_inv_${inviteId}`;
}

/** First character and domain only, with a fixed-length mask so length leaks nothing. */
export function maskInviteEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "••••••";
  return `${email.slice(0, 1)}••••••${email.slice(at)}`;
}

/** Why an invite did not admit anyone; carried to `/review/join?outcome=`. */
export const inviteOutcomes = {
  accountUnavailable: "account_unavailable",
  expired: "expired",
  invalid: "invalid",
  revoked: "revoked",
  unverified: "unverified",
  used: "used",
  wrongAccount: "wrong_account",
} as const;

/** One refusal outcome. */
export type InviteOutcome = (typeof inviteOutcomes)[keyof typeof inviteOutcomes];

/** Plain sentences for each refusal; safe to show to the invitee. */
export const inviteOutcomeMessages: Readonly<Record<InviteOutcome, string>> = {
  account_unavailable: "This account cannot join. It may belong to a deactivated member.",
  expired: "This invite link has expired.",
  invalid: "This invite link is incomplete or was changed.",
  revoked: "This invite link was revoked.",
  unverified: "Your sign-in provider has not verified this email address.",
  used: "This invite link has already been used.",
  wrong_account: "This invite is for a different email address.",
};

/** The refusal outcome for an invite that is no longer active. */
export function outcomeForStatus(
  status: Exclude<InviteStatus, "active">,
): InviteOutcome {
  switch (status) {
    case inviteStatuses.expired:
      return inviteOutcomes.expired;
    case inviteStatuses.revoked:
      return inviteOutcomes.revoked;
    case inviteStatuses.used:
      return inviteOutcomes.used;
  }
}

/** Null when this verified email may redeem the invite at `at`; otherwise why not. */
export function redemptionRefusal(
  invite: StoredInvite | null,
  normalizedEmail: string,
  at: string,
): InviteOutcome | null {
  if (invite === null) return inviteOutcomes.invalid;
  const status = inviteStatus(invite, new Date(at));
  if (status !== inviteStatuses.active) return outcomeForStatus(status);
  if (invite.kind === inviteKinds.person && invite.email !== normalizedEmail) {
    return inviteOutcomes.wrongAccount;
  }
  return null;
}

/** The review URL an invite lands on; Projects when it names no version. */
export function inviteDestinationPath(destination: InviteDestination | null): string {
  if (destination === null) return "/review/projects";
  return `/review?${new URLSearchParams({
    artifact: destination.artifactId,
    project: destination.projectId,
    version: destination.versionId,
    view: "focus",
  })}`;
}

/** Where a successful invite login returns: the welcome screen, then the destination. */
export function inviteWelcomePath(destination: InviteDestination | null): string {
  return `/review/join?${new URLSearchParams({next: inviteDestinationPath(destination)})}`;
}

/** The activity-log subject; never contains the token. */
export function inviteActivitySubject(
  invite: Pick<Invite, "email" | "kind" | "maxUses">,
): string {
  if (invite.kind === inviteKinds.person) {
    return `invite for ${invite.email ?? "one person"}`;
  }
  return `invite link (${invite.maxUses} ${invite.maxUses === 1 ? "use" : "uses"})`;
}
```

- [ ] **Step 4: Write `src/core/invitation-ports.ts`**

```ts
import type {ActionAttribution} from "./action-attribution.js";
import type {
  AdmitMemberRecord,
  BindExternalIdentityRecord,
} from "./identity-ports.js";
import type {InstallationMember} from "./installation-identity.js";
import type {
  Invite,
  InviteOutcome,
  ListedInvite,
  StoredInvite,
} from "./invitations.js";

/** Values persisted when an administrator issues one invite. */
export interface CreateInviteRecord {
  readonly attribution: ActionAttribution;
  readonly invite: StoredInvite;
}

/** Values persisted when an administrator revokes one active invite. */
export interface RevokeInviteRecord {
  readonly attribution: ActionAttribution;
  readonly installationId: string;
  readonly inviteId: string;
  readonly revokedAt: string;
}

/** Everything one redemption writes in a single transaction. */
export interface RedeemInviteRecord {
  /** `admittedHow: invite`; attributed to the inviting administrator. */
  readonly admission: AdmitMemberRecord;
  readonly binding: BindExternalIdentityRecord;
  /** The verified, normalized email of the person redeeming. */
  readonly email: string;
  readonly inviteId: string;
  readonly redeemedAt: string;
}

/** Either the new member, or why nothing was written. */
export type RedeemInviteResult =
  | {readonly kind: "admitted"; readonly member: InstallationMember}
  | {readonly kind: "refused"; readonly outcome: Exclude<InviteOutcome, "unverified">};

/** Invite persistence; every backend implements all of it atomically. */
export interface InvitationRepository {
  /** Store the invite and its `invite_create` row together. */
  createInvite(record: CreateInviteRecord): Promise<Invite>;
  findInvite(installationId: string, inviteId: string): Promise<StoredInvite | null>;
  /** Newest first, at most 200. */
  listInvites(installationId: string): Promise<readonly ListedInvite[]>;
  /**
   * Redeem one use, admit the member, bind the identity and write
   * `member_admit` and `invite_redeem` in one transaction, or write nothing.
   */
  redeemInvite(record: RedeemInviteRecord): Promise<RedeemInviteResult>;
  /**
   * Revoke an active invite and write `invite_revoke`. Throws IdentityNotFound
   * for an unknown invite and IdentityConflict for one that is not active.
   */
  revokeInvite(record: RevokeInviteRecord): Promise<Invite>;
}
```

- [ ] **Step 5: Add the errors**

In `src/core/errors.ts`, add to `errorCodes` (keep the object alphabetical):

```ts
  inviteRejected: "INVITE_REJECTED",
  invitesUnavailable: "INVITES_UNAVAILABLE",
```

Add after `IdentityNotFound`:

```ts
/** An invite redemption admitted no one; `outcome` names why. */
export class InviteRejected extends Schema.TaggedError<InviteRejected>()(
  "InviteRejected",
  {
    message: Schema.String,
    outcome: Schema.Literals([
      "account_unavailable",
      "expired",
      "invalid",
      "revoked",
      "unverified",
      "used",
      "wrong_account",
    ]),
  },
) {}

/** Invites need an interactive identity provider; this installation has none. */
export class InvitesUnavailable extends Schema.TaggedError<InvitesUnavailable>()(
  "InvitesUnavailable",
  messageField,
) {}

/** An invite request broke a rule the caller can fix. */
export class InvalidInvite extends Schema.TaggedError<InvalidInvite>()(
  "InvalidInvite",
  messageField,
) {}
```

Add `InviteRejected`, `InvitesUnavailable` and `InvalidInvite` to `artifactServerFailureSchema`'s `Schema.Union([...])`. Add to `IdentityRepositoryFailure`'s operation literals: `"createInvite"`, `"findInvite"`, `"listInvites"`, `"redeemInvite"`, `"revokeInvite"`.

In `src/http/artifact-http-failure.ts`, after the `IdentityNotFound` case:

```ts
    case "InviteRejected":
      return {code: errorCodes.inviteRejected, message: failure.message, status: 403};
    case "InvitesUnavailable":
      return {code: errorCodes.invitesUnavailable, message: failure.message, status: 409};
    case "InvalidInvite":
      return {code: errorCodes.invalidInput, message: failure.message, status: 422};
```

- [ ] **Step 6: Add the admission method, action kinds and activity detail**

`src/core/identity-ports.ts`:

```ts
export const memberAdmissions = {
  automatic: "automatic",
  invite: "invite",
  manual: "manual",
  owner: "owner",
} as const;
```

`src/core/model.ts`, in `installationActionKinds` (alphabetical):

```ts
  inviteCreate: "invite_create",
  inviteRedeem: "invite_redeem",
  inviteRevoke: "invite_revoke",
```

and in `ActivityDetail`:

```ts
  readonly expiresAt?: string;
  readonly inviteId?: string;
  readonly inviteKind?: string;
  readonly maxUses?: number;
```

`src/storage/activity-log-schema.ts`, `installationScopedActionKinds`:

```ts
export const installationScopedActionKinds = [
  installationActionKinds.inviteCreate,
  installationActionKinds.inviteRedeem,
  installationActionKinds.inviteRevoke,
  installationActionKinds.keyIssue,
  installationActionKinds.keyRevoke,
  installationActionKinds.keyRotate,
  installationActionKinds.memberAdmit,
  installationActionKinds.memberDeactivate,
] as const;
```

`src/storage/activity-sql.ts`: append the three kinds to `feedKindsByType.admin` and to `administrationKinds`.

`src/application/activity-entries.ts`, in `verbs`:

```ts
  invite_create: ["admin", "created"],
  invite_redeem: ["admin", "joined with"],
  invite_revoke: ["admin", "revoked"],
```

and in `subjectOf`, before the `member_` branch:

```ts
  if (action.startsWith("invite_")) {
    const name = row.action.detail?.subjectName;
    return {id: subjectId, name: typeof name === "string" ? name : null};
  }
```

- [ ] **Step 7: Run the test and the typecheck**

Run: `pnpm vitest run tests/application/invitations-model.test.ts && pnpm typecheck`
Expected: PASS; typecheck clean. (Postgres and SQLite existing databases do not yet accept the new kinds; nothing writes them until Task 4.)

- [ ] **Step 8: Commit**

```bash
git add src/core src/http/artifact-http-failure.ts src/storage/activity-log-schema.ts src/storage/activity-sql.ts src/application/activity-entries.ts tests/application/invitations-model.test.ts
git commit -m "Add the provider-neutral invite model, errors and activity kinds"
```

---

### Task 3: Login attempts carry an invite and sign-in hints

**Files:**
- Modify: `src/core/installation-identity.ts` (`LoginAttempt.inviteId`)
- Modify: `src/application/interactive-login.ts` (`LoginHints`, `InteractiveIdentityProvider.start(hints?)`, `start(returnTo, invite)`)
- Modify: `src/application/installation-access.ts:issueLocalBrowserLogin` (`inviteId: null`)
- Modify: `src/identity/workos-identity-provider.ts`, `src/identity/oidc-identity-provider.ts`
- Modify: `src/storage/sqlite-identity-repository.ts` (column, create, consume, row schema, add-if-missing)
- Modify: `src/storage/postgres-identity-repository.ts`, `src/storage/postgres-migrations.ts` (`0021_login_attempt_invite`, version 21, expected history)
- Modify: `deploy/cloudflare/src/d1-identity-repository.ts`, `deploy/cloudflare/src/d1-migrations.ts` (schema column, add-if-missing)
- Test: `tests/storage/sqlite-login-attempt-invite.test.ts`, `tests/application/login-hints.test.ts`, `tests/integration/postgres-login-attempt-invite.test.ts` (+ `tests/configs/vitest.external-storage.config.ts`), `deploy/cloudflare/tests/d1-login-attempt-invite.test.ts`

**Interfaces:**
- Consumes: nothing from Task 2 beyond types.
- Produces:
  - `LoginAttempt.inviteId: string | null`
  - `export interface LoginHints { readonly forceSignIn?: boolean; readonly loginHint?: string; readonly screenHint?: "sign-in" | "sign-up"; }`
  - `InteractiveIdentityProvider.start(hints?: LoginHints)`
  - `InteractiveLoginService.start(returnTo: string, invite?: {readonly hints: LoginHints; readonly inviteId: string} | null)`

- [ ] **Step 1: Write the failing SQLite test**

```ts
// tests/storage/sqlite-login-attempt-invite.test.ts
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";

describe("SQLite login attempts carry an invite", () => {
  let dataDirectory: string;
  let databasePath: string;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-login-invite-"));
    databasePath = path.join(dataDirectory, "artifact-server.db");
  });

  afterEach(async () => {
    await rm(dataDirectory, {force: true, recursive: true});
  });

  test("an attempt returns the invite it was started with, and a plain one returns null", async () => {
    const artifacts = new SqliteArtifactRepository(databasePath, "installation");
    const identity = new SqliteIdentityRepository(databasePath);
    try {
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
      identity.close();
      artifacts.close();
    }
  });

  test("a database created before the column gains it without losing attempts", async () => {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`CREATE TABLE login_attempts (
      state_digest TEXT PRIMARY KEY, provider TEXT NOT NULL, code_verifier TEXT NOT NULL,
      nonce TEXT, return_to TEXT NOT NULL, created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, consumed_at TEXT)`);
    legacy.prepare(`INSERT INTO login_attempts VALUES
      ('legacy', 'workos', 'verifier', NULL, '/review', '2026-10-06T10:00:00.000Z',
       '2026-10-06T10:10:00.000Z', NULL)`).run();
    legacy.close();
    const artifacts = new SqliteArtifactRepository(databasePath, "installation");
    const identity = new SqliteIdentityRepository(databasePath);
    try {
      await expect(identity.consumeLoginAttempt("legacy", "workos", "2026-10-06T10:01:00.000Z"))
        .resolves.toMatchObject({inviteId: null, returnTo: "/review"});
    } finally {
      identity.close();
      artifacts.close();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/storage/sqlite-login-attempt-invite.test.ts`
Expected: FAIL — TypeScript or runtime error that `inviteId` is not part of the attempt / missing from the result.

- [ ] **Step 3: Add `inviteId` to the type and the SQLite repository**

`src/core/installation-identity.ts`, in `LoginAttempt`:

```ts
  /** The invite this login redeems; null for an ordinary sign-in. */
  readonly inviteId: string | null;
```

`src/application/installation-access.ts`, in `issueLocalBrowserLogin`'s `createLoginAttempt({...})` add `inviteId: null,`.

`src/storage/sqlite-identity-repository.ts`:
- `loginAttemptRowSchema` gains `inviteId: z.string().nullable(),`.
- `CREATE TABLE IF NOT EXISTS login_attempts` gains `invite_id TEXT,` after `nonce TEXT,`.
- `createLoginAttempt` inserts `invite_id`:

```ts
    this.#database.prepare(`
      INSERT INTO login_attempts (
        state_digest, provider, code_verifier, nonce, invite_id, return_to,
        created_at, expires_at, consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      attempt.stateDigest,
      attempt.provider,
      attempt.codeVerifier,
      attempt.nonce,
      attempt.inviteId,
      attempt.returnTo,
      attempt.createdAt,
      attempt.expiresAt,
    );
```

- `consumeLoginAttempt`'s SELECT adds `invite_id AS inviteId,` after `nonce,`.
- `#migrate()` calls a new `this.#addLoginAttemptInviteIfMissing();` after `#addLoginAttemptNonceIfMissing()`:

```ts
  #addLoginAttemptInviteIfMissing(): void {
    if (this.#tableColumns("login_attempts").includes("invite_id")) return;
    this.#database.exec("ALTER TABLE login_attempts ADD COLUMN invite_id TEXT");
  }
```

- [ ] **Step 4: Run the SQLite test**

Run: `pnpm vitest run tests/storage/sqlite-login-attempt-invite.test.ts`
Expected: PASS.

- [ ] **Step 5: Add Postgres and D1 support with their tests**

Postgres migration in `src/storage/postgres-migrations.ts`:

```ts
const addLoginAttemptInvite = Effect.gen(function*() {
  const sql = yield* SqlClient;
  yield* sql.unsafe("ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS invite_id TEXT");
});
```

Register `"0021_login_attempt_invite": addLoginAttemptInvite,` in `Migrator.fromRecord`, set `requiredPostgresSchemaVersion = 21`, and append `{migration_id: 21, name: "login_attempt_invite"}` to `expectedHistory`.

`src/storage/postgres-identity-repository.ts`: `loginAttemptRowSchema` gains `inviteId: z.string().nullable()`; `createLoginAttempt` inserts `invite_id` (`${attempt.inviteId}` after `${attempt.nonce}`); the consume SELECT adds `invite_id AS "inviteId",`.

D1 (`deploy/cloudflare/src/d1-migrations.ts`): in `schemaSql`'s `CREATE TABLE IF NOT EXISTS login_attempts`, add `invite_id TEXT,` after `nonce TEXT,`. Add and call (unconditionally, beside `addAdmissionAndActivityColumnsIfMissing`):

```ts
async function addLoginAttemptInviteIfMissing(database: D1Database): Promise<void> {
  const columns = await database.prepare("PRAGMA table_info(login_attempts)")
    .all<{name: string}>();
  if (columns.results.some((column) => column.name === "invite_id")) return;
  await database.prepare("ALTER TABLE login_attempts ADD COLUMN invite_id TEXT").run();
}
```

`deploy/cloudflare/src/d1-identity-repository.ts`: row schema gains `inviteId: z.string().nullable()`; `createLoginAttempt` inserts `invite_id`; the consume SELECT adds `invite_id AS inviteId`.

Tests, each following the SQLite test's first case (create two attempts, consume both):

```ts
// tests/integration/postgres-login-attempt-invite.test.ts
import {randomUUID} from "node:crypto";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";
import {PostgresIdentityRepository} from "../../src/storage/postgres-identity-repository.js";

function readDatabaseUrl(): string {
  const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  if (databaseUrl === undefined) {
    throw new Error("Run this test through pnpm test:external-storage-runtime.");
  }
  return databaseUrl;
}

describe("Postgres login attempts carry an invite", () => {
  const scratch = `artifact_login_invite_${randomUUID().replaceAll("-", "")}`;
  const installationId = `test-login-invite-${randomUUID()}`;
  let maintenance: PostgresDatabase;
  let database: PostgresDatabase;
  let identity: PostgresIdentityRepository;

  beforeEach(async () => {
    maintenance = await PostgresDatabase.inspect({url: Redacted.make(readDatabaseUrl())});
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`CREATE DATABASE ${scratch}`);
    }));
    const scratchUrl = new URL(readDatabaseUrl());
    scratchUrl.pathname = `/${scratch}`;
    database = await PostgresDatabase.open({url: Redacted.make(scratchUrl.toString())}, "apply");
    await PostgresArtifactRepository.open(database, installationId);
    identity = new PostgresIdentityRepository(database, installationId);
  });

  afterEach(async () => {
    await database.close();
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    }));
    await maintenance.close();
  });

  test("an attempt returns the invite it was started with, and a plain one returns null", async () => {
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
  });
});
```

Add `"tests/integration/postgres-login-attempt-invite.test.ts",` to the `include` list in `tests/configs/vitest.external-storage.config.ts`.

```ts
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
```

If `createD1IdentityRepository` takes more arguments, read its signature and pass what `d1-activity-log-writes.test.ts` passes.

- [ ] **Step 6: Write the failing hints test**

```ts
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
```

Run: `pnpm vitest run tests/application/login-hints.test.ts`
Expected: FAIL — `start` accepts no hints, so `login_hint` is null.

- [ ] **Step 7: Implement hints and the invite-carrying start**

`src/application/interactive-login.ts`:

```ts
/** Provider-neutral sign-in hints; a provider ignores any it does not support. */
export interface LoginHints {
  /** Ask the provider to re-authenticate even with a live provider session. */
  readonly forceSignIn?: boolean;
  /** Pre-fill the email field. */
  readonly loginHint?: string;
  /** Open the provider's sign-up or sign-in screen first. */
  readonly screenHint?: "sign-in" | "sign-up";
}
```

`InteractiveIdentityProvider.start` becomes `readonly start: (hints?: LoginHints) => Effect.Effect<InteractiveAuthorization, IdentityProviderFailure>;`.

`InteractiveLoginOperations.start` becomes:

```ts
  readonly start: (
    returnTo: string,
    invite?: {readonly hints: LoginHints; readonly inviteId: string} | null,
  ) => Effect.Effect<
    StartedInteractiveLogin,
    IdentityProviderFailure | IdentityRepositoryFailure | InteractiveLoginUnavailable
  >;
```

and its implementation:

```ts
  const start = Effect.fn("InteractiveLoginService.start")(
    function*(
      returnTo: string,
      invite: {readonly hints: LoginHints; readonly inviteId: string} | null = null,
    ) {
      const provider = dependencies.provider;
      if (provider === null) return yield* unavailable();
      const authorization = yield* provider.start(invite?.hints ?? {});
      const now = dependencies.clock.now();
      yield* dependencies.repository.create({
        codeVerifier: authorization.codeVerifier,
        createdAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() + dependencies.attemptLifetimeMilliseconds,
        ).toISOString(),
        inviteId: invite?.inviteId ?? null,
        nonce: authorization.nonce,
        provider: provider.name,
        returnTo: safeReturnTo(returnTo),
        stateDigest: digestIdentitySecret(authorization.state),
      });
      const started: StartedInteractiveLogin = {
        authorizationUrl: authorization.authorizationUrl,
        handshake: authorization.state,
      };
      return started;
    },
  );
```

`src/identity/workos-identity-provider.ts`:

```ts
  start(hints: LoginHints = {}): Effect.Effect<InteractiveAuthorization, IdentityProviderFailure> {
    return Effect.tryPromise({
      try: async () => {
        const authorization = await this.#workos.userManagement
          .getAuthorizationUrlWithPKCE({
            clientId: this.#clientId,
            provider: "authkit",
            redirectUri: this.#redirectUri,
            ...(hints.loginHint === undefined ? {} : {loginHint: hints.loginHint}),
            ...(hints.screenHint === undefined ? {} : {screenHint: hints.screenHint}),
            ...(hints.forceSignIn === true ? {maxAge: 0} : {}),
          });
        return {
          authorizationUrl: authorization.url,
          codeVerifier: authorization.codeVerifier,
          nonce: null,
          state: authorization.state,
        };
      },
      catch: () => providerFailure(),
    });
  }
```

(import `type LoginHints` from `../application/interactive-login.js`).

`src/identity/oidc-identity-provider.ts`: the `start` generator takes `hints: LoginHints = {}` after `this`, and before building `authorization`:

```ts
      if (hints.loginHint !== undefined) {
        authorizationUrl.searchParams.set("login_hint", hints.loginHint);
      }
      if (hints.forceSignIn === true) {
        authorizationUrl.searchParams.set("prompt", "login");
      }
```

- [ ] **Step 8: Run every test touched by this task and the typecheck**

Run: `pnpm vitest run tests/storage/sqlite-login-attempt-invite.test.ts tests/application/login-hints.test.ts tests/conformance/installation-identity.test.ts tests/conformance/auth-019-oidc-login.test.ts && pnpm --dir deploy/cloudflare exec vitest run tests/d1-login-attempt-invite.test.ts && pnpm typecheck`
Expected: PASS. Then with Docker available: `pnpm test:external-storage-runtime` — PASS including `postgres-login-attempt-invite`.

If `max_age` is not in the generated WorkOS URL, the SDK renamed the parameter: print `hinted.toString()` in the test, adjust the asserted name to what the SDK emits, and record the name in the commit message.

- [ ] **Step 9: Commit**

```bash
git add src tests deploy/cloudflare
git commit -m "Carry an invite id and sign-in hints through browser login"
```

---

### Task 4: SQLite invites, admission method and activity widening

**Files:**
- Create: `src/storage/invitation-schema.ts`
- Create: `src/storage/invitation-rows.ts`
- Modify: `src/storage/activity-log-schema.ts` (extract table definition; add widen helpers)
- Modify: `src/storage/sqlite-artifact-repository.ts` (`#widenActionKindsIfNeeded`)
- Modify: `src/storage/sqlite-identity-repository.ts` (implements `InvitationRepository`; members rebuild; `admittedHow` enum)
- Modify: `src/storage/sqlite-schema.ts` (`requiredSqliteSchemaVersion = 21`)
- Create: `tests/support/invitation-repository-cases.ts`
- Test: `tests/storage/sqlite-invitations.test.ts`

**Interfaces:**
- Consumes: Task 2 model and port; Task 3 `LoginAttempt.inviteId`.
- Produces:
  - `sqliteInvitesTableSql: string` and `sqliteMemberAdmissionWidenStatements: readonly string[]` (shared with D1)
  - `inviteSelectColumns(alias: string): string`, `inviteRowSchema`, `storedInviteFromRow(row): StoredInvite`, `listedInviteFromRow(row): ListedInvite`
  - `inviteCreateAction(invite, attribution): ActionInsert`, `inviteRevokeAction(invite, attribution, at): ActionInsert`, `inviteRedeemAction(invite, member, at): ActionInsert`
  - `sqliteActionsWidenStatements(options: {strict: boolean}): readonly string[]`, `sqliteActionsTableAcceptsEveryKind(tableSql: string): boolean`
  - `SqliteIdentityRepository implements BootstrapManagedApiKeyRepository, InvitationRepository`

- [ ] **Step 1: Write the shared repository cases and the failing SQLite test**

The four behavior cases are written once and run against every backend. They use `node:assert/strict` so the Cloudflare package can run them under its own Vitest instance.

```ts
// tests/support/invitation-repository-cases.ts
import assert from "node:assert/strict";

import {systemAttribution} from "../../src/core/action-attribution.js";
import {type IdentityRepository, memberAdmissions} from "../../src/core/identity-ports.js";
import type {InvitationRepository, RedeemInviteRecord} from "../../src/core/invitation-ports.js";
import {inviteKinds, inviteTokenPrefix, type StoredInvite} from "../../src/core/invitations.js";

export type InvitationStore = InvitationRepository & Pick<
  IdentityRepository,
  "admitMember" | "deactivateMember" | "findActiveMemberByExternalIdentity" | "findMember" | "listMembers"
>;

export interface InvitationFixture {
  readonly actions: () => Promise<readonly {readonly action: string; readonly subjectId: string | null}[]>;
  readonly installationId: string;
  /** A second repository over the same store, for the race case. */
  readonly openSecond: () => Promise<{readonly close: () => Promise<void> | void; readonly store: InvitationStore}>;
  readonly store: InvitationStore;
}

export const caseAdministrator = {
  actor: {displayName: "Jordan Lee", kind: "human"},
  authorizedByPrincipalId: null,
  principalId: "member_admin",
} as const;

export function caseInvite(installationId: string, overrides: Partial<StoredInvite> = {}): StoredInvite {
  const id = overrides.id ?? "inv_00000000-0000-4000-8000-000000000001";
  return {
    createdAt: "2026-10-06T10:00:00.000Z",
    createdByPrincipalId: "member_admin",
    email: null,
    expiresAt: "2026-10-13T10:00:00.000Z",
    id,
    installationId,
    kind: inviteKinds.link,
    maxUses: 1,
    opens: null,
    revokedAt: null,
    revokedByPrincipalId: null,
    role: "member",
    secretDigest: "digest",
    tokenPrefix: inviteTokenPrefix(id),
    useCount: 0,
    ...overrides,
  };
}

export function caseRedemption(
  installationId: string,
  memberId: string,
  email: string,
  inviteId: string,
): RedeemInviteRecord {
  return {
    admission: {
      admittedHow: memberAdmissions.invite,
      attribution: caseAdministrator,
      createdAt: "2026-10-07T09:00:00.000Z",
      displayName: email,
      email,
      id: memberId,
      installationId,
      role: "member",
    },
    binding: {
      boundAt: "2026-10-07T09:00:00.000Z",
      email,
      memberId,
      provider: "workos",
      subject: `subject-${memberId}`,
    },
    email,
    inviteId,
    redeemedAt: "2026-10-07T09:00:00.000Z",
  };
}

/** Admit the administrator every case attributes to. */
export async function seedAdministrator(fixture: InvitationFixture): Promise<void> {
  await fixture.store.admitMember({
    admittedHow: memberAdmissions.owner,
    attribution: systemAttribution,
    createdAt: "2026-10-06T09:00:00.000Z",
    displayName: "Jordan Lee",
    email: "jordan@acme.test",
    id: "member_admin",
    installationId: fixture.installationId,
    role: "administrator",
  });
}

const inviteRows = async (fixture: InvitationFixture) =>
  (await fixture.actions()).filter((row) => row.action.startsWith("invite_"));

export const invitationRepositoryCases: readonly {
  readonly name: string;
  readonly run: (fixture: InvitationFixture) => Promise<void>;
}[] = [
  {
    name: "creates, lists newest first with the creator's name, finds and revokes with activity",
    run: async (fixture) => {
      const {installationId, store} = fixture;
      const first = "inv_00000000-0000-4000-8000-000000000001";
      const second = "inv_00000000-0000-4000-8000-000000000002";
      await store.createInvite({attribution: caseAdministrator, invite: caseInvite(installationId, {id: first})});
      await store.createInvite({
        attribution: caseAdministrator,
        invite: caseInvite(installationId, {
          createdAt: "2026-10-06T11:00:00.000Z",
          email: "dana@acme.test",
          id: second,
          kind: inviteKinds.person,
          opens: {artifactId: "art_1", projectId: "prj_default", versionId: "ver_1"},
          role: "administrator",
        }),
      });
      const listed = await store.listInvites(installationId);
      assert.deepEqual(listed.map((row) => [row.id, row.createdByName, row.opens?.versionId ?? null]), [
        [second, "Jordan Lee", "ver_1"],
        [first, "Jordan Lee", null],
      ]);
      const found = await store.findInvite(installationId, first);
      assert.equal(found?.secretDigest, "digest");
      assert.equal(found?.useCount, 0);

      const revoked = await store.revokeInvite({
        attribution: caseAdministrator,
        installationId,
        inviteId: first,
        revokedAt: "2026-10-06T12:00:00.000Z",
      });
      assert.equal(revoked.revokedByPrincipalId, "member_admin");
      await assert.rejects(store.revokeInvite({
        attribution: caseAdministrator,
        installationId,
        inviteId: first,
        revokedAt: "2026-10-06T12:01:00.000Z",
      }), {_tag: "IdentityConflict"});
      await assert.rejects(store.revokeInvite({
        attribution: caseAdministrator,
        installationId,
        inviteId: "inv_00000000-0000-4000-8000-000000000099",
        revokedAt: "2026-10-06T12:01:00.000Z",
      }), {_tag: "IdentityNotFound"});
      assert.deepEqual(await inviteRows(fixture), [
        {action: "invite_create", subjectId: first},
        {action: "invite_create", subjectId: second},
        {action: "invite_revoke", subjectId: first},
      ]);
    },
  },
  {
    name: "redemption admits with method invite, binds the identity and writes both rows",
    run: async (fixture) => {
      const {installationId, store} = fixture;
      const id = "inv_00000000-0000-4000-8000-000000000003";
      await store.createInvite({attribution: caseAdministrator, invite: caseInvite(installationId, {id, maxUses: 2})});
      const result = await store.redeemInvite(caseRedemption(installationId, "member_dana", "dana@acme.test", id));
      assert.equal(result.kind, "admitted");
      assert.equal(result.kind === "admitted" ? result.member.email : null, "dana@acme.test");
      const bound = await store.findActiveMemberByExternalIdentity(installationId, "workos", "subject-member_dana");
      assert.equal(bound?.id, "member_dana");
      const member = (await store.listMembers(installationId)).find((row) => row.id === "member_dana");
      assert.equal(member?.admittedHow, "invite");
      assert.equal(member?.admittedByName, "Jordan Lee");
      assert.equal((await store.findInvite(installationId, id))?.useCount, 1);
      const rows = (await fixture.actions()).filter((row) =>
        row.subjectId === "member_dana" || row.action === "invite_redeem");
      assert.deepEqual(rows.map((row) => row.action).toSorted(), ["invite_redeem", "member_admit"]);
    },
  },
  {
    name: "a spent invite, a wrong email and a deactivated member's email write nothing",
    run: async (fixture) => {
      const {installationId, store} = fixture;
      const link = "inv_00000000-0000-4000-8000-000000000004";
      const person = "inv_00000000-0000-4000-8000-000000000005";
      await store.createInvite({attribution: caseAdministrator, invite: caseInvite(installationId, {id: link})});
      await store.createInvite({
        attribution: caseAdministrator,
        invite: caseInvite(installationId, {email: "dana@acme.test", id: person, kind: inviteKinds.person}),
      });
      assert.equal((await store.redeemInvite(caseRedemption(installationId, "member_a", "a@acme.test", link))).kind, "admitted");
      assert.deepEqual(
        await store.redeemInvite(caseRedemption(installationId, "member_b", "b@acme.test", link)),
        {kind: "refused", outcome: "used"},
      );
      assert.deepEqual(
        await store.redeemInvite(caseRedemption(installationId, "member_c", "sam@acme.test", person)),
        {kind: "refused", outcome: "wrong_account"},
      );
      await store.deactivateMember(installationId, "member_a", "2026-10-07T10:00:00.000Z", caseAdministrator);
      const another = "inv_00000000-0000-4000-8000-000000000006";
      await store.createInvite({attribution: caseAdministrator, invite: caseInvite(installationId, {id: another, maxUses: 5})});
      assert.deepEqual(
        await store.redeemInvite(caseRedemption(installationId, "member_d", "a@acme.test", another)),
        {kind: "refused", outcome: "account_unavailable"},
      );
      assert.equal((await store.findInvite(installationId, another))?.useCount, 0);
      assert.equal(await store.findMember(installationId, "member_d"), null);
    },
  },
  {
    name: "two repositories racing for a last use admit exactly one person",
    run: async (fixture) => {
      const {installationId, store} = fixture;
      const id = "inv_00000000-0000-4000-8000-000000000007";
      await store.createInvite({attribution: caseAdministrator, invite: caseInvite(installationId, {id})});
      const second = await fixture.openSecond();
      try {
        const results = await Promise.all([
          store.redeemInvite(caseRedemption(installationId, "member_x", "x@acme.test", id)),
          second.store.redeemInvite(caseRedemption(installationId, "member_y", "y@acme.test", id)),
        ]);
        assert.equal(results.filter((result) => result.kind === "admitted").length, 1);
        assert.deepEqual(results.filter((result) => result.kind === "refused"), [{kind: "refused", outcome: "used"}]);
      } finally {
        await second.close();
      }
    },
  },
];
```

```ts
// tests/storage/sqlite-invitations.test.ts
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {systemAttribution} from "../../src/core/action-attribution.js";
import {memberAdmissions} from "../../src/core/identity-ports.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";
import {
  caseAdministrator,
  caseInvite,
  caseRedemption,
  type InvitationFixture,
  invitationRepositoryCases,
  seedAdministrator,
} from "../support/invitation-repository-cases.js";

const installationId = "invite-installation";
const rowsSchema = z.array(z.object({action: z.string(), subjectId: z.string().nullable()}));

function readActions(databasePath: string) {
  const database = new DatabaseSync(databasePath, {readOnly: true});
  try {
    return rowsSchema.parse(database.prepare(
      "SELECT action, subject_id AS subjectId FROM actions ORDER BY created_at, action",
    ).all());
  } finally {
    database.close();
  }
}

describe("SQLite invitations", () => {
  let dataDirectory: string;
  let databasePath: string;
  let artifacts: SqliteArtifactRepository;
  let identity: SqliteIdentityRepository;
  let fixture: InvitationFixture;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-invites-"));
    databasePath = path.join(dataDirectory, "artifact-server.db");
    artifacts = new SqliteArtifactRepository(databasePath, installationId);
    identity = new SqliteIdentityRepository(databasePath);
    fixture = {
      actions: async () => readActions(databasePath),
      installationId,
      openSecond: async () => {
        const second = new SqliteIdentityRepository(databasePath);
        return {close: () => second.close(), store: second};
      },
      store: identity,
    };
    await seedAdministrator(fixture);
  });

  afterEach(async () => {
    identity.close();
    artifacts.close();
    await rm(dataDirectory, {force: true, recursive: true});
  });

  test.for(invitationRepositoryCases)("$name", async ({run}) => {
    await expect(run(fixture)).resolves.toBeUndefined();
  });

  test("the database refuses rule-breaking rows written directly", () => {
    const database = new DatabaseSync(databasePath);
    const insert = (kind: string, email: string | null, role: string, maxUses: number, useCount: number) =>
      database.prepare(`INSERT INTO installation_invites (
        installation_id, id, kind, email, role, max_uses, use_count, secret_digest, token_prefix,
        expires_at, created_at, created_by_principal_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'd', 'p', 'x', 'x', 'm')`)
        .run(installationId, `inv_direct_${kind}_${role}_${maxUses}_${useCount}`, kind, email, role, maxUses, useCount);
    try {
      expect(() => insert("link", null, "administrator", 5, 0)).toThrow(/constraint failed/u);
      expect(() => insert("person", "a@b.test", "member", 3, 0)).toThrow(/constraint failed/u);
      expect(() => insert("link", null, "member", 2, 3)).toThrow(/constraint failed/u);
      expect(() => insert("link", "a@b.test", "member", 2, 0)).toThrow(/constraint failed/u);
      expect(() => insert("link", null, "member", 101, 0)).toThrow(/constraint failed/u);
    } finally {
      database.close();
    }
  });
});

describe("SQLite invitation migration", () => {
  test("a schema-20 database keeps its members, sessions, identities and actions", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-invites-migrate-"));
    const databasePath = path.join(dataDirectory, "artifact-server.db");
    try {
      const artifacts = new SqliteArtifactRepository(databasePath, installationId);
      const identity = new SqliteIdentityRepository(databasePath);
      await identity.admitMember({
        admittedHow: memberAdmissions.owner,
        attribution: systemAttribution,
        createdAt: "2026-10-06T09:00:00.000Z",
        displayName: "Jordan Lee",
        email: "jordan@acme.test",
        id: "member_admin",
        installationId,
        role: "administrator",
      });
      await identity.bindExternalIdentity({
        boundAt: "2026-10-06T09:00:00.000Z",
        email: "jordan@acme.test",
        memberId: "member_admin",
        provider: "workos",
        subject: "subject-admin",
      });
      await identity.createApplicationSession({
        createdAt: "2026-10-06T09:00:00.000Z",
        csrfDigest: "csrf",
        expiresAt: "2026-10-07T09:00:00.000Z",
        id: "session_1",
        installationId,
        memberId: "member_admin",
        tokenDigest: "token",
      });
      identity.close();
      artifacts.close();

      // Return the file to schema 20: the narrow admission CHECK, an actions CHECK
      // without invite kinds, and no invites table.
      const legacy = new DatabaseSync(databasePath);
      const actionsSql = z.object({sql: z.string()}).parse(legacy
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'actions'").get()).sql;
      const narrowActionsSql = actionsSql
        .replaceAll("'invite_create', ", "")
        .replaceAll("'invite_redeem', ", "")
        .replaceAll("'invite_revoke', ", "")
        .replace("CREATE TABLE \"actions\"", "CREATE TABLE actions_legacy")
        .replace("CREATE TABLE actions", "CREATE TABLE actions_legacy");
      expect(narrowActionsSql).not.toContain("invite_");
      legacy.exec("PRAGMA foreign_keys = OFF;");
      legacy.exec("BEGIN;");
      legacy.exec(narrowActionsSql);
      legacy.exec("INSERT INTO actions_legacy SELECT * FROM actions;");
      legacy.exec("DROP TABLE actions;");
      legacy.exec("ALTER TABLE actions_legacy RENAME TO actions;");
      legacy.exec(`
        CREATE TABLE members_old AS SELECT * FROM installation_members;
        DROP TABLE installation_members;
        CREATE TABLE installation_members (
          id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, email TEXT NOT NULL,
          display_name TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
          status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_active_at TEXT,
          admitted_by_principal_id TEXT,
          admission_method TEXT
            CHECK (admission_method IS NULL OR admission_method IN ('manual', 'automatic', 'owner')),
          UNIQUE (installation_id, email));
        INSERT INTO installation_members SELECT * FROM members_old;
        DROP TABLE members_old;
        DROP TABLE installation_invites;
        PRAGMA user_version = 20;
        COMMIT;
      `);
      legacy.exec("PRAGMA foreign_keys = ON;");
      legacy.close();

      const reopenedArtifacts = new SqliteArtifactRepository(databasePath, installationId);
      const reopened = new SqliteIdentityRepository(databasePath);
      try {
        await expect(reopened.findActiveMemberByExternalIdentity(installationId, "workos", "subject-admin"))
          .resolves.toMatchObject({id: "member_admin"});
        await expect(reopened.findApplicationSession(installationId, "token", "2026-10-06T10:00:00.000Z"))
          .resolves.toMatchObject({id: "session_1"});
        const id = "inv_00000000-0000-4000-8000-000000000008";
        await reopened.createInvite({attribution: caseAdministrator, invite: caseInvite(installationId, {id})});
        await expect(reopened.redeemInvite(caseRedemption(installationId, "member_new", "new@acme.test", id)))
          .resolves.toMatchObject({kind: "admitted"});
        const check = new DatabaseSync(databasePath, {readOnly: true});
        try {
          expect(check.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
          expect(z.object({user_version: z.number()}).parse(check.prepare("PRAGMA user_version").get()).user_version)
            .toBe(21);
        } finally {
          check.close();
        }
      } finally {
        reopened.close();
        reopenedArtifacts.close();
      }
    } finally {
      await rm(dataDirectory, {force: true, recursive: true});
    }
  });
});
```

The `replaceAll` calls assume the kinds are emitted as `'invite_create', ` in the CHECK list. Run the test once, print `actionsSql` if the `not.toContain("invite_")` expectation fails, and adjust the replacements to the emitted text (the last kind in a list has no trailing comma).

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/storage/sqlite-invitations.test.ts`
Expected: FAIL — `identity.createInvite is not a function`.

- [ ] **Step 3: Write the shared schema and row helpers**

```ts
// src/storage/invitation-schema.ts

/** The invites table for SQLite and D1; identical rules on Postgres. */
export const sqliteInvitesTableSql = `
  CREATE TABLE IF NOT EXISTS installation_invites (
    installation_id TEXT NOT NULL,
    id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('person', 'link')),
    email TEXT,
    role TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
    max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 100),
    use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0 AND use_count <= max_uses),
    secret_digest TEXT NOT NULL,
    token_prefix TEXT NOT NULL,
    opens_project_id TEXT,
    opens_artifact_id TEXT,
    opens_version_id TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by_principal_id TEXT NOT NULL,
    revoked_at TEXT,
    revoked_by_principal_id TEXT,
    last_redeemed_member_id TEXT,
    PRIMARY KEY (installation_id, id),
    CHECK ((kind = 'person' AND email IS NOT NULL) OR (kind = 'link' AND email IS NULL)),
    CHECK (kind = 'person' OR role = 'member'),
    CHECK (kind = 'link' OR max_uses = 1),
    CHECK (
      (opens_project_id IS NULL AND opens_artifact_id IS NULL AND opens_version_id IS NULL)
      OR (opens_project_id IS NOT NULL AND opens_artifact_id IS NOT NULL AND opens_version_id IS NOT NULL)
    ),
    CHECK ((revoked_at IS NULL) = (revoked_by_principal_id IS NULL))
  )`;

export const sqliteInvitesIndexSql = `
  CREATE INDEX IF NOT EXISTS installation_invites_created
    ON installation_invites (installation_id, created_at DESC, id DESC)`;

/** Admission methods every backend's CHECK accepts. */
export const admissionMethodCheckSql =
  "admission_method IS NULL OR admission_method IN ('manual', 'automatic', 'owner', 'invite')";

/** Whether a stored installation_members CREATE statement already accepts `invite`. */
export function membersAcceptInviteAdmission(tableSql: string): boolean {
  return tableSql.includes("'invite'");
}

const memberColumns = `id, installation_id, email, display_name, role, status,
  created_at, updated_at, last_active_at, admitted_by_principal_id, admission_method`;

/** The installation_members rebuild for SQLite; the caller turns foreign keys off. */
export const sqliteMemberAdmissionWidenStatements: readonly string[] = [
  "DROP TABLE IF EXISTS installation_members_next",
  `CREATE TABLE installation_members_next (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
    status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_active_at TEXT,
    admitted_by_principal_id TEXT,
    admission_method TEXT CHECK (${admissionMethodCheckSql}),
    UNIQUE (installation_id, email)
  )`,
  `INSERT INTO installation_members_next (${memberColumns})
    SELECT ${memberColumns} FROM installation_members`,
  "DROP TABLE installation_members",
  "ALTER TABLE installation_members_next RENAME TO installation_members",
];

/**
 * The same rebuild for D1, which cannot turn foreign keys off: snapshot the
 * rows, rebuild empty, and re-insert after the rename so deferred foreign-key
 * checks balance before the batch commits.
 */
export const d1MemberAdmissionWidenStatements: readonly string[] = [
  "PRAGMA defer_foreign_keys = ON",
  "DROP TABLE IF EXISTS installation_members_snapshot",
  `CREATE TABLE installation_members_snapshot AS SELECT ${memberColumns} FROM installation_members`,
  "DROP TABLE IF EXISTS installation_members_next",
  `CREATE TABLE installation_members_next (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
    status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_active_at TEXT,
    admitted_by_principal_id TEXT,
    admission_method TEXT CHECK (${admissionMethodCheckSql}),
    UNIQUE (installation_id, email)
  )`,
  "DROP TABLE installation_members",
  "ALTER TABLE installation_members_next RENAME TO installation_members",
  `INSERT INTO installation_members (${memberColumns})
    SELECT ${memberColumns} FROM installation_members_snapshot`,
  "DROP TABLE installation_members_snapshot",
];
```

```ts
// src/storage/invitation-rows.ts
import {z} from "zod";

import {type ActionAttribution} from "../core/action-attribution.js";
import {membershipRoles} from "../core/identity.js";
import type {InstallationMember} from "../core/installation-identity.js";
import {
  type Invite,
  inviteActivitySubject,
  inviteKinds,
  type ListedInvite,
  type StoredInvite,
} from "../core/invitations.js";
import {type ActionInsert, attributedInsert} from "./action-insert.js";

/** Quoted aliases read identically from SQLite, D1 and Postgres. */
export function inviteSelectColumns(alias: string): string {
  const c = (column: string) => `${alias}.${column}`;
  return [
    `${c("installation_id")} AS "installationId"`,
    `${c("id")} AS "id"`,
    `${c("kind")} AS "kind"`,
    `${c("email")} AS "email"`,
    `${c("role")} AS "role"`,
    `${c("max_uses")} AS "maxUses"`,
    `${c("use_count")} AS "useCount"`,
    `${c("secret_digest")} AS "secretDigest"`,
    `${c("token_prefix")} AS "tokenPrefix"`,
    `${c("opens_project_id")} AS "opensProjectId"`,
    `${c("opens_artifact_id")} AS "opensArtifactId"`,
    `${c("opens_version_id")} AS "opensVersionId"`,
    `${c("expires_at")} AS "expiresAt"`,
    `${c("created_at")} AS "createdAt"`,
    `${c("created_by_principal_id")} AS "createdByPrincipalId"`,
    `${c("revoked_at")} AS "revokedAt"`,
    `${c("revoked_by_principal_id")} AS "revokedByPrincipalId"`,
  ].join(",\n  ");
}

export const inviteRowSchema = z.object({
  createdAt: z.string(),
  createdByPrincipalId: z.string(),
  email: z.string().nullable(),
  expiresAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  kind: z.enum([inviteKinds.link, inviteKinds.person]),
  maxUses: z.coerce.number().int(),
  opensArtifactId: z.string().nullable(),
  opensProjectId: z.string().nullable(),
  opensVersionId: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokedByPrincipalId: z.string().nullable(),
  role: z.enum([membershipRoles.administrator, membershipRoles.member]),
  secretDigest: z.string(),
  tokenPrefix: z.string(),
  useCount: z.coerce.number().int(),
});

export const listedInviteRowSchema = inviteRowSchema.extend({
  createdByName: z.string().nullable(),
});

export function storedInviteFromRow(input: unknown): StoredInvite {
  const row = inviteRowSchema.parse(input);
  return {
    createdAt: row.createdAt,
    createdByPrincipalId: row.createdByPrincipalId,
    email: row.email,
    expiresAt: row.expiresAt,
    id: row.id,
    installationId: row.installationId,
    kind: row.kind,
    maxUses: row.maxUses,
    opens: row.opensProjectId === null || row.opensArtifactId === null || row.opensVersionId === null
      ? null
      : {artifactId: row.opensArtifactId, projectId: row.opensProjectId, versionId: row.opensVersionId},
    revokedAt: row.revokedAt,
    revokedByPrincipalId: row.revokedByPrincipalId,
    role: row.role,
    secretDigest: row.secretDigest,
    tokenPrefix: row.tokenPrefix,
    useCount: row.useCount,
  };
}

export function listedInviteFromRow(input: unknown): ListedInvite {
  const {createdByName} = listedInviteRowSchema.parse(input);
  const {secretDigest: _secretDigest, ...invite} = storedInviteFromRow(input);
  return {...invite, createdByName};
}

export function withoutInviteDigest(invite: StoredInvite): Invite {
  const {secretDigest: _secretDigest, ...rest} = invite;
  return rest;
}

/** Positional values for the INSERT every backend uses, in column order. */
export function inviteInsertValues(invite: StoredInvite): readonly (number | string | null)[] {
  return [
    invite.installationId,
    invite.id,
    invite.kind,
    invite.email,
    invite.role,
    invite.maxUses,
    invite.useCount,
    invite.secretDigest,
    invite.tokenPrefix,
    invite.opens?.projectId ?? null,
    invite.opens?.artifactId ?? null,
    invite.opens?.versionId ?? null,
    invite.expiresAt,
    invite.createdAt,
    invite.createdByPrincipalId,
  ];
}

export const inviteInsertColumns = `installation_id, id, kind, email, role, max_uses,
  use_count, secret_digest, token_prefix, opens_project_id, opens_artifact_id,
  opens_version_id, expires_at, created_at, created_by_principal_id`;

export function inviteCreateAction(invite: Invite, attribution: ActionAttribution): ActionInsert {
  return attributedInsert(attribution, {
    action: "invite_create",
    createdAt: invite.createdAt,
    detail: {
      expiresAt: invite.expiresAt,
      inviteId: invite.id,
      inviteKind: invite.kind,
      maxUses: invite.maxUses,
      role: invite.role,
      subjectName: inviteActivitySubject(invite),
    },
    idempotencyKey: `invite_create:${invite.id}`,
    projectId: null,
    subjectId: invite.id,
  });
}

export function inviteRevokeAction(
  invite: Invite,
  attribution: ActionAttribution,
  revokedAt: string,
): ActionInsert {
  return attributedInsert(attribution, {
    action: "invite_revoke",
    createdAt: revokedAt,
    detail: {inviteId: invite.id, subjectName: inviteActivitySubject(invite)},
    idempotencyKey: `invite_revoke:${invite.id}`,
    projectId: null,
    subjectId: invite.id,
  });
}

export function inviteRedeemAction(
  invite: Invite,
  member: Pick<InstallationMember, "displayName" | "id">,
  redeemedAt: string,
): ActionInsert {
  return attributedInsert(
    {
      actor: {displayName: member.displayName, kind: "human"},
      authorizedByPrincipalId: null,
      principalId: member.id,
    },
    {
      action: "invite_redeem",
      createdAt: redeemedAt,
      detail: {inviteId: invite.id, inviteKind: invite.kind, subjectName: inviteActivitySubject(invite)},
      idempotencyKey: `invite_redeem:${invite.id}:${member.id}`,
      projectId: null,
      subjectId: invite.id,
    },
  );
}

/** The `member_admit` row a redemption writes; detail names the invite. */
export function inviteAdmitAction(
  admission: {
    readonly attribution: ActionAttribution;
    readonly createdAt: string;
    readonly displayName: string;
    readonly id: string;
    readonly role: string;
  },
  inviteId: string,
): ActionInsert {
  return attributedInsert(admission.attribution, {
    action: "member_admit",
    createdAt: admission.createdAt,
    detail: {how: "invite", inviteId, role: admission.role, subjectName: admission.displayName},
    idempotencyKey: `member_admit:${admission.id}`,
    projectId: null,
    subjectId: admission.id,
  });
}
```

- [ ] **Step 4: Add the actions widen helpers**

In `src/storage/activity-log-schema.ts`, extract the `CREATE TABLE actions_next (...)` body from `sqliteActionsRebuildStatements` into:

```ts
function actionsTableSql(name: string, strict: boolean): string {
  return `CREATE TABLE ${name} (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id),
      artifact_id TEXT REFERENCES artifacts(id),
      version_id TEXT REFERENCES versions(id),
      action TEXT NOT NULL,
      principal_id TEXT,
      authorized_by_principal_id TEXT,
      idempotency_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      thread_id TEXT,
      reply_id TEXT,
      subject_id TEXT,
      access_from TEXT,
      access_to TEXT,
      actor_name TEXT,
      actor_kind TEXT,
      detail_json TEXT,
      ${actionRowChecks.map((check) => `CHECK (${check})`).join(",\n      ")},
      CHECK (detail_json IS NULL OR (
        json_valid(detail_json)
        AND length(CAST(detail_json AS BLOB)) <= ${activityDetailJsonMaxBytes}
      ))
    )${strict ? " STRICT" : ""}`;
}

const actionsIndexStatements = [
  `CREATE INDEX IF NOT EXISTS actions_artifact_created
    ON actions (project_id, artifact_id, created_at DESC, id DESC)`,
  "CREATE INDEX IF NOT EXISTS actions_created ON actions (created_at DESC, id DESC)",
  `CREATE INDEX IF NOT EXISTS actions_project_created
    ON actions (project_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS actions_thread
    ON actions (thread_id) WHERE thread_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS actions_installation_idempotency
    ON actions (idempotency_key) WHERE project_id IS NULL`,
  `CREATE INDEX IF NOT EXISTS actions_subject
    ON actions (subject_id, created_at DESC, id DESC)
    WHERE subject_id IS NOT NULL`,
] as const;
```

Use `actionsTableSql("actions_next", options.strict)` and `...actionsIndexStatements.slice(0, 5)` inside `sqliteActionsRebuildStatements` so its output is unchanged. Then add:

```ts
const activityColumns = `id, project_id, artifact_id, version_id, action, principal_id,
  authorized_by_principal_id, idempotency_key, created_at, thread_id, reply_id,
  subject_id, access_from, access_to, actor_name, actor_kind, detail_json`;

/** Whether the stored actions CREATE statement accepts every current kind. */
export function sqliteActionsTableAcceptsEveryKind(tableSql: string): boolean {
  return [...Object.values(artifactActionKinds), ...Object.values(installationActionKinds)]
    .every((kind) => tableSql.includes(`'${kind}'`));
}

/**
 * Rebuild an activity-log-shaped `actions` table so its CHECKs accept every
 * current kind. Run inside the caller's transaction (SQLite) or batch (D1);
 * the copy check aborts unless every row arrived.
 */
export function sqliteActionsWidenStatements(
  options: {readonly strict: boolean},
): readonly string[] {
  return [
    "DROP TABLE IF EXISTS actions_next",
    "DROP TABLE IF EXISTS actions_copy_check",
    actionsTableSql("actions_next", options.strict),
    `INSERT INTO actions_next (${activityColumns}) SELECT ${activityColumns} FROM actions`,
    `CREATE TABLE actions_copy_check (
      expected INTEGER NOT NULL,
      copied INTEGER NOT NULL,
      CHECK (expected = copied)
    )`,
    `INSERT INTO actions_copy_check (expected, copied)
      SELECT (SELECT count(*) FROM actions), (SELECT count(*) FROM actions_next)`,
    "DROP TABLE actions_copy_check",
    "DROP TABLE actions",
    "ALTER TABLE actions_next RENAME TO actions",
    ...actionsIndexStatements,
  ];
}
```

In `src/storage/sqlite-artifact-repository.ts`, after `this.#addInstallationActivityLogIfMissing();` call `this.#widenActionKindsIfNeeded();`:

```ts
  /** Rebuild `actions` when a newer build added action kinds its CHECK refuses. */
  #widenActionKindsIfNeeded(): void {
    const tableSql = () => z.object({sql: z.string()}).parse(this.#database
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'actions'")
      .get()).sql;
    if (sqliteActionsTableAcceptsEveryKind(tableSql())) return;
    this.#transaction(() => {
      if (sqliteActionsTableAcceptsEveryKind(tableSql())) return;
      for (const statement of [
        ...sqliteActionsWidenStatements({strict: true}),
        ...sqliteActionTriggerStatements,
      ]) {
        this.#database.exec(statement);
      }
    });
  }
```

- [ ] **Step 5: Implement the SQLite repository**

In `src/storage/sqlite-identity-repository.ts`:

1. `implements BootstrapManagedApiKeyRepository, InvitationRepository`.
2. `listedMemberRowSchema.admittedHow` enum gains `memberAdmissions.invite`.
3. In `#migrate()`, after `this.#addLoginAttemptInviteIfMissing();`:

```ts
    this.#database.exec(sqliteInvitesTableSql);
    this.#database.exec(sqliteInvitesIndexSql);
    this.#widenMemberAdmissionIfNeeded();
```

and in the `CREATE TABLE IF NOT EXISTS installation_members` statement, replace the admission CHECK with `CHECK (${admissionMethodCheckSql})` (template literal) so fresh databases need no rebuild.

4. Add:

```ts
  #widenMemberAdmissionIfNeeded(): void {
    const tableSql = z.object({sql: z.string()}).parse(this.#database
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'installation_members'")
      .get()).sql;
    if (membersAcceptInviteAdmission(tableSql)) return;
    this.#database.exec("PRAGMA foreign_keys = OFF;");
    try {
      this.#inTransaction(() => {
        for (const statement of sqliteMemberAdmissionWidenStatements) {
          this.#database.exec(statement);
        }
      });
    } finally {
      this.#database.exec("PRAGMA foreign_keys = ON;");
    }
    if (this.#database.prepare("PRAGMA foreign_key_check").all().length > 0) {
      throw new Error("SQLite member admission migration produced invalid foreign keys.");
    }
  }
```

5. Extract the member INSERT from `admitMember` into `#insertMember(command: AdmitMemberRecord): void` (same SQL), and call it from `admitMember`.

6. Add the repository methods:

```ts
  async createInvite(record: CreateInviteRecord): Promise<Invite> {
    this.#inTransaction(() => {
      this.#database.prepare(`
        INSERT INTO installation_invites (${inviteInsertColumns})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...inviteInsertValues(record.invite));
      this.#insertAction(inviteCreateAction(record.invite, record.attribution));
    });
    return withoutInviteDigest(record.invite);
  }

  async findInvite(installationId: string, inviteId: string): Promise<StoredInvite | null> {
    return this.#findInvite(installationId, inviteId);
  }

  #findInvite(installationId: string, inviteId: string): StoredInvite | null {
    const row = this.#database.prepare(`
      SELECT ${inviteSelectColumns("i")}
      FROM installation_invites AS i
      WHERE i.installation_id = ? AND i.id = ?
    `).get(installationId, inviteId);
    return row === undefined ? null : storedInviteFromRow(row);
  }

  async listInvites(installationId: string): Promise<readonly ListedInvite[]> {
    const rows = this.#database.prepare(`
      SELECT ${inviteSelectColumns("i")}, creator.display_name AS "createdByName"
      FROM installation_invites AS i
      LEFT JOIN installation_members AS creator
        ON creator.installation_id = i.installation_id AND creator.id = i.created_by_principal_id
      WHERE i.installation_id = ?
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT 200
    `).all(installationId);
    return rows.map(listedInviteFromRow);
  }

  async revokeInvite(record: RevokeInviteRecord): Promise<Invite> {
    return this.#inTransaction(() => {
      const existing = this.#findInvite(record.installationId, record.inviteId);
      if (existing === null) {
        throw new IdentityNotFound({message: "The invite does not exist."});
      }
      if (inviteStatus(existing, new Date(record.revokedAt)) !== inviteStatuses.active) {
        throw new IdentityConflict({message: "Only an active invite can be revoked."});
      }
      this.#database.prepare(`
        UPDATE installation_invites
        SET revoked_at = ?, revoked_by_principal_id = ?
        WHERE installation_id = ? AND id = ? AND revoked_at IS NULL
      `).run(
        record.revokedAt,
        record.attribution.principalId,
        record.installationId,
        record.inviteId,
      );
      this.#insertAction(inviteRevokeAction(existing, record.attribution, record.revokedAt));
      const revoked = this.#findInvite(record.installationId, record.inviteId);
      if (revoked === null) throw new Error("The revoked invite was not persisted.");
      return withoutInviteDigest(revoked);
    });
  }

  async redeemInvite(record: RedeemInviteRecord): Promise<RedeemInviteResult> {
    const {admission} = record;
    try {
      return this.#inTransaction((): RedeemInviteResult => {
        const invite = this.#findInvite(admission.installationId, record.inviteId);
        const refusal = redemptionRefusal(invite, record.email, record.redeemedAt);
        if (invite === null || refusal !== null) {
          return {kind: "refused", outcome: refusal === "unverified" || refusal === null ? "invalid" : refusal};
        }
        const updated = this.#database.prepare(`
          UPDATE installation_invites
          SET use_count = use_count + 1, last_redeemed_member_id = ?
          WHERE installation_id = ? AND id = ? AND revoked_at IS NULL
            AND expires_at > ? AND use_count < max_uses
        `).run(admission.id, admission.installationId, record.inviteId, record.redeemedAt);
        if (updated.changes !== 1) return {kind: "refused", outcome: "used"};
        this.#insertMember(admission);
        this.#insertAction(inviteAdmitAction(admission, invite.id));
        this.#database.prepare(`
          INSERT INTO external_identities (provider, subject, member_id, email, bound_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          record.binding.provider,
          record.binding.subject,
          record.binding.memberId,
          record.binding.email,
          record.binding.boundAt,
        );
        this.#insertAction(inviteRedeemAction(invite, admission, record.redeemedAt));
        const member = this.#findMember(admission.installationId, admission.id);
        if (member === null) throw new Error("The admitted member was not persisted.");
        return {kind: "admitted", member};
      });
    } catch (cause) {
      if (isSqliteConstraint(cause)) return {kind: "refused", outcome: "account_unavailable"};
      throw cause;
    }
  }
```

`#insertMember` must write `admission.attribution.principalId` into `admitted_by_principal_id`, exactly as `admitMember` does. Import everything named above from `../core/invitations.js`, `../core/invitation-ports.js`, `./invitation-schema.js` and `./invitation-rows.js`.

7. `src/storage/sqlite-schema.ts`: `export const requiredSqliteSchemaVersion = 21;`

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run tests/storage && pnpm vitest run tests/conformance/act-001-activity-log-writes.test.ts tests/conformance/act-002-activity-log-migration.test.ts`
Expected: PASS. Fix any test that asserted schema version 20 by reading why it asserts it; update only version expectations, never behavior.

- [ ] **Step 7: Commit**

```bash
git add src/storage src/core tests/storage
git commit -m "Store invites in SQLite and accept invite admission and activity"
```

---

### Task 5: Postgres invites

**Files:**
- Modify: `src/storage/postgres-migrations.ts` (`0022_installation_invites`, version 22, expected history)
- Modify: `src/storage/postgres-identity-repository.ts` (implements `InvitationRepository`; `admittedHow` enum)
- Test: `tests/integration/postgres-invitations.test.ts` (+ external-storage config include)

**Interfaces:**
- Consumes: Task 4's `invitation-rows.ts` helpers and `admissionMethodCheckSql`.
- Produces: `PostgresIdentityRepository implements BootstrapManagedApiKeyRepository, InvitationRepository`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/postgres-invitations.test.ts
import {randomUUID} from "node:crypto";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";
import {PostgresIdentityRepository} from "../../src/storage/postgres-identity-repository.js";
import {
  type InvitationFixture,
  invitationRepositoryCases,
  seedAdministrator,
} from "../support/invitation-repository-cases.js";

function readDatabaseUrl(): string {
  const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  if (databaseUrl === undefined) {
    throw new Error("Run this test through pnpm test:external-storage-runtime.");
  }
  return databaseUrl;
}

describe("Postgres invitations", () => {
  let scratch: string;
  let installationId: string;
  let maintenance: PostgresDatabase;
  let database: PostgresDatabase;
  let fixture: InvitationFixture;

  beforeEach(async () => {
    scratch = `artifact_invites_${randomUUID().replaceAll("-", "")}`;
    installationId = `test-invites-${randomUUID()}`;
    maintenance = await PostgresDatabase.inspect({url: Redacted.make(readDatabaseUrl())});
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`CREATE DATABASE ${scratch}`);
    }));
    const scratchUrl = new URL(readDatabaseUrl());
    scratchUrl.pathname = `/${scratch}`;
    database = await PostgresDatabase.open({url: Redacted.make(scratchUrl.toString())}, "apply");
    await PostgresArtifactRepository.open(database, installationId);
    const store = new PostgresIdentityRepository(database, installationId);
    fixture = {
      actions: () => database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        return yield* sql.unsafe<{action: string; subjectId: string | null}>(
          `SELECT action, subject_id AS "subjectId" FROM actions
           WHERE installation_id = $1 ORDER BY created_at, action`,
          [installationId],
        );
      })),
      installationId,
      openSecond: async () => ({
        close: () => undefined,
        store: new PostgresIdentityRepository(database, installationId),
      }),
      store,
    };
    await seedAdministrator(fixture);
  });

  afterEach(async () => {
    await database.close();
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    }));
    await maintenance.close();
  });

  test.for(invitationRepositoryCases)("$name", async ({run}) => {
    await expect(run(fixture)).resolves.toBeUndefined();
  });

  test("the database refuses an administrator link invite written directly", async () => {
    await expect(database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`INSERT INTO installation_invites (
        installation_id, id, kind, email, role, max_uses, use_count, secret_digest,
        token_prefix, expires_at, created_at, created_by_principal_id
      ) VALUES ($1, 'inv_bad', 'link', NULL, 'administrator', 5, 0, 'd', 'p', 'x', 'x', 'm')`,
      [installationId]);
    }))).rejects.toBeDefined();
  });

  test("migration 0022 kept every member admitted before it", async () => {
    const members = await fixture.store.listMembers(installationId);
    expect(members.map((member) => member.admittedHow)).toEqual(["owner"]);
  });
});
```

The race case uses two repositories over one pool, so the two `redeemInvite` transactions run concurrently and the `FOR UPDATE` lock decides the winner.

Add `"tests/integration/postgres-invitations.test.ts",` to `tests/configs/vitest.external-storage.config.ts`. The Postgres migration-preservation proof for older databases already runs in `tests/integration/postgres-activity-log-migration.test.ts`; after adding 0022, run it and confirm it still passes against a database migrated step by step.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:external-storage-runtime`
Expected: FAIL — `identity.createInvite is not a function`.

- [ ] **Step 3: Add migration 0022**

```ts
const addInstallationInvites = Effect.gen(function*() {
  const sql = yield* SqlClient;
  const statements = [
    `CREATE TABLE IF NOT EXISTS installation_invites (
      installation_id TEXT NOT NULL REFERENCES artifact_installations(id),
      id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('person', 'link')),
      email TEXT,
      role TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
      max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 100),
      use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0 AND use_count <= max_uses),
      secret_digest TEXT NOT NULL,
      token_prefix TEXT NOT NULL,
      opens_project_id TEXT,
      opens_artifact_id TEXT,
      opens_version_id TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by_principal_id TEXT NOT NULL,
      revoked_at TEXT,
      revoked_by_principal_id TEXT,
      last_redeemed_member_id TEXT,
      PRIMARY KEY (installation_id, id),
      CHECK ((kind = 'person' AND email IS NOT NULL) OR (kind = 'link' AND email IS NULL)),
      CHECK (kind = 'person' OR role = 'member'),
      CHECK (kind = 'link' OR max_uses = 1),
      CHECK (
        (opens_project_id IS NULL AND opens_artifact_id IS NULL AND opens_version_id IS NULL)
        OR (opens_project_id IS NOT NULL AND opens_artifact_id IS NOT NULL AND opens_version_id IS NOT NULL)
      ),
      CHECK ((revoked_at IS NULL) = (revoked_by_principal_id IS NULL))
    )`,
    `CREATE INDEX IF NOT EXISTS installation_invites_created
      ON installation_invites (installation_id, created_at DESC, id DESC)`,
    `ALTER TABLE installation_members
      DROP CONSTRAINT IF EXISTS installation_members_admission_method_check,
      ADD CONSTRAINT installation_members_admission_method_check
        CHECK (${admissionMethodCheckSql})`,
    `ALTER TABLE actions
      DROP CONSTRAINT actions_action_check,
      ADD CONSTRAINT actions_action_check CHECK (${actionKindCheck}),
      DROP CONSTRAINT actions_scope_check,
      ADD CONSTRAINT actions_scope_check CHECK (${scopeCheck})`,
  ] as const;
  for (const statement of statements) yield* sql.unsafe(statement);
});
```

Register `"0022_installation_invites": addInstallationInvites`, set `requiredPostgresSchemaVersion = 22`, and append `{migration_id: 22, name: "installation_invites"}` to `expectedHistory`. Import `admissionMethodCheckSql` from `./invitation-schema.js`.

Before writing the members `DROP CONSTRAINT`, confirm the generated name on a migrated scratch database: `SELECT conname FROM pg_constraint WHERE conrelid = 'installation_members'::regclass;`. If it differs from `installation_members_admission_method_check`, use the observed name.

- [ ] **Step 4: Implement the Postgres repository**

Add `memberAdmissions.invite` to the listed-member enum. Add:

```ts
  async createInvite(record: CreateInviteRecord): Promise<Invite> {
    this.#assertInstallationScope(record.invite.installationId);
    await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.withTransaction(Effect.gen(function*() {
        yield* sql.unsafe(
          `INSERT INTO installation_invites (${inviteInsertColumns})
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [...inviteInsertValues(record.invite)],
        );
        yield* insertPostgresAction(
          record.invite.installationId,
          inviteCreateAction(record.invite, record.attribution),
        );
      }));
    }));
    return withoutInviteDigest(record.invite);
  }

  async findInvite(installationId: string, inviteId: string): Promise<StoredInvite | null> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(this.#findInvite(installationId, inviteId, false));
  }

  #findInvite(
    installationId: string,
    inviteId: string,
    lock: boolean,
  ): Effect.Effect<StoredInvite | null, unknown, SqlClient> {
    return Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT ${inviteSelectColumns("i")} FROM installation_invites AS i
         WHERE i.installation_id = $1 AND i.id = $2 ${lock ? "FOR UPDATE" : ""}`,
        [installationId, inviteId],
      );
      return rows[0] === undefined ? null : storedInviteFromRow(rows[0]);
    });
  }

  async listInvites(installationId: string): Promise<readonly ListedInvite[]> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT ${inviteSelectColumns("i")}, creator.display_name AS "createdByName"
         FROM installation_invites AS i
         LEFT JOIN installation_members AS creator
           ON creator.installation_id = i.installation_id AND creator.id = i.created_by_principal_id
         WHERE i.installation_id = $1
         ORDER BY i.created_at DESC, i.id DESC
         LIMIT 200`,
        [installationId],
      );
      return rows.map(listedInviteFromRow);
    }));
  }

  async revokeInvite(record: RevokeInviteRecord): Promise<Invite> {
    this.#assertInstallationScope(record.installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        const existing = yield* this.#findInvite(record.installationId, record.inviteId, true);
        if (existing === null) {
          return yield* new IdentityNotFound({message: "The invite does not exist."});
        }
        if (inviteStatus(existing, new Date(record.revokedAt)) !== inviteStatuses.active) {
          return yield* new IdentityConflict({message: "Only an active invite can be revoked."});
        }
        yield* sql`UPDATE installation_invites
          SET revoked_at = ${record.revokedAt},
              revoked_by_principal_id = ${record.attribution.principalId}
          WHERE installation_id = ${record.installationId} AND id = ${record.inviteId}`;
        yield* insertPostgresAction(
          record.installationId,
          inviteRevokeAction(existing, record.attribution, record.revokedAt),
        );
        const revoked = yield* this.#findInvite(record.installationId, record.inviteId, false);
        if (revoked === null) return yield* Effect.die(new Error("The revoked invite was not persisted."));
        return withoutInviteDigest(revoked);
      }));
    }));
  }

  async redeemInvite(record: RedeemInviteRecord): Promise<RedeemInviteResult> {
    const {admission} = record;
    this.#assertInstallationScope(admission.installationId);
    try {
      return await this.#database.run(Effect.gen({self: this}, function*() {
        const sql = yield* SqlClient;
        return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
          const invite = yield* this.#findInvite(admission.installationId, record.inviteId, true);
          const refusal = redemptionRefusal(invite, record.email, record.redeemedAt);
          if (invite === null || refusal !== null) {
            const outcome = refusal === null || refusal === "unverified" ? "invalid" : refusal;
            return {kind: "refused", outcome} satisfies RedeemInviteResult;
          }
          yield* sql`UPDATE installation_invites
            SET use_count = use_count + 1, last_redeemed_member_id = ${admission.id}
            WHERE installation_id = ${admission.installationId} AND id = ${record.inviteId}`;
          yield* sql`INSERT INTO installation_members (
            installation_id, id, email, display_name, role, status,
            created_at, updated_at, admitted_by_principal_id, admission_method
          ) VALUES (
            ${admission.installationId}, ${admission.id}, ${admission.email},
            ${admission.displayName}, ${admission.role}, ${memberStatuses.active},
            ${admission.createdAt}, ${admission.createdAt},
            ${admission.attribution.principalId}, ${admission.admittedHow}
          )`;
          yield* insertPostgresAction(admission.installationId, inviteAdmitAction(admission, invite.id));
          yield* sql`INSERT INTO external_identities (
            installation_id, provider, subject, member_id, email, bound_at
          ) VALUES (
            ${admission.installationId}, ${record.binding.provider}, ${record.binding.subject},
            ${record.binding.memberId}, ${record.binding.email}, ${record.binding.boundAt}
          )`;
          yield* insertPostgresAction(
            admission.installationId,
            inviteRedeemAction(invite, admission, record.redeemedAt),
          );
          const member = yield* this.#findMember(admission.installationId, admission.id, false);
          if (member === null) return yield* Effect.die(new Error("The admitted member was not persisted."));
          return {kind: "admitted", member} satisfies RedeemInviteResult;
        }));
      }));
    } catch (cause) {
      if (isConstraintFailure(cause)) return {kind: "refused", outcome: "account_unavailable"};
      throw cause;
    }
  }
```

The `FOR UPDATE` lock serializes the race: the second transaction waits, re-reads `use_count`, and `redemptionRefusal` returns `used`.

- [ ] **Step 5: Run the tests**

Run: `pnpm test:external-storage-runtime && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/storage tests/integration tests/configs
git commit -m "Store invites in Postgres"
```

---

### Task 6: D1 invites

**Files:**
- Modify: `deploy/cloudflare/src/d1-migrations.ts` (`requiredD1SchemaVersion = 18`; invites table; members widen; actions widen)
- Modify: `deploy/cloudflare/src/d1-identity-repository.ts` (invitation methods; `admittedHow` enum)
- Test: `deploy/cloudflare/tests/d1-invitations.test.ts`

**Interfaces:**
- Consumes: Task 4 `sqliteInvitesTableSql`, `sqliteInvitesIndexSql`, `d1MemberAdmissionWidenStatements`, `membersAcceptInviteAdmission`, `sqliteActionsWidenStatements`, `sqliteActionsTableAcceptsEveryKind`, row helpers.
- Produces: `createD1IdentityRepository(...)` returns an object satisfying `BootstrapManagedApiKeyRepository & InvitationRepository`.

- [ ] **Step 1: Write the failing test**

```ts
// deploy/cloudflare/tests/d1-invitations.test.ts
import {fileURLToPath} from "node:url";

import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {getPlatformProxy} from "wrangler";
import {z} from "zod";

import {systemAttribution} from "../../../src/core/action-attribution.js";
import {memberAdmissions} from "../../../src/core/identity-ports.js";
import {
  type InvitationFixture,
  invitationRepositoryCases,
  seedAdministrator,
} from "../../../tests/support/invitation-repository-cases.js";
import {createD1IdentityRepository} from "../src/d1-identity-repository.js";
import {migrateD1} from "../src/d1-migrations.js";

const openLocalD1 = () => getPlatformProxy<{ARTIFACT_SERVER_D1_DATABASE: D1Database}>({
  configPath: fileURLToPath(new URL("../wrangler.git-store.test.jsonc", import.meta.url)),
  envFiles: [],
  persist: false,
  remoteBindings: false,
});

const rowsSchema = z.array(z.object({action: z.string(), subjectId: z.string().nullable()}));

describe("D1 invitations", () => {
  let proxy: Awaited<ReturnType<typeof openLocalD1>>;
  let fixture: InvitationFixture;

  beforeEach(async () => {
    proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-invitations";
    await migrateD1(binding, installationId);
    fixture = {
      actions: async () => rowsSchema.parse((await binding.prepare(
        "SELECT action, subject_id AS subjectId FROM actions ORDER BY created_at, action",
      ).all()).results),
      installationId,
      openSecond: async () => ({close: () => undefined, store: createD1IdentityRepository(binding)}),
      store: createD1IdentityRepository(binding),
    };
    await seedAdministrator(fixture);
  });

  afterEach(async () => {
    await proxy.dispose();
  });

  it.for(invitationRepositoryCases)("$name", async ({run}) => {
    await expect(run(fixture)).resolves.toBeUndefined();
  });

  it("an existing schema-17 database gains invites without losing members or identities", async () => {
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const identity = createD1IdentityRepository(binding);
    await identity.admitMember({
      admittedHow: memberAdmissions.manual,
      attribution: systemAttribution,
      createdAt: "2026-10-06T09:30:00.000Z",
      displayName: "Rae Chen",
      email: "rae@acme.test",
      id: "member_rae",
      installationId: fixture.installationId,
      role: "member",
    });
    await identity.bindExternalIdentity({
      boundAt: "2026-10-06T09:30:00.000Z",
      email: "rae@acme.test",
      memberId: "member_rae",
      provider: "workos",
      subject: "subject-rae",
    });
    await binding.batch([
      "PRAGMA defer_foreign_keys = ON",
      "CREATE TABLE members_snapshot AS SELECT * FROM installation_members",
      "DROP TABLE installation_members",
      `CREATE TABLE installation_members (
        id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
        status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_active_at TEXT,
        admitted_by_principal_id TEXT,
        admission_method TEXT
          CHECK (admission_method IS NULL OR admission_method IN ('manual', 'automatic', 'owner')),
        UNIQUE (installation_id, email))`,
      "INSERT INTO installation_members SELECT * FROM members_snapshot",
      "DROP TABLE members_snapshot",
      "DROP TABLE installation_invites",
      "UPDATE artifact_server_schema SET version = 17 WHERE component = 'runtime'",
    ].map((statement) => binding.prepare(statement)));

    await migrateD1(binding, fixture.installationId);

    await expect(identity.findActiveMemberByExternalIdentity(fixture.installationId, "workos", "subject-rae"))
      .resolves.toMatchObject({id: "member_rae"});
    expect((await binding.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    const tableSql = await binding.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'installation_members'",
    ).first<{sql: string}>();
    expect(tableSql?.sql).toContain("'invite'");
  });
});
```

If the Cloudflare package's TypeScript config does not include `../../tests/support`, add that path to `deploy/cloudflare/tsconfig.json`'s `include` (the cases file imports only from `src/core`).

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --dir deploy/cloudflare exec vitest run tests/d1-invitations.test.ts`
Expected: FAIL — `identity.createInvite is not a function`.

- [ ] **Step 3: Add the D1 migration steps**

In `deploy/cloudflare/src/d1-migrations.ts`: set `requiredD1SchemaVersion = 18`; in `schemaSql`'s `installation_members` CREATE use `CHECK (${admissionMethodCheckSql})`; and after `await addLoginAttemptInviteIfMissing(database);` call:

```ts
  await addInstallationInvitesIfMissing(database);
  await widenMemberAdmissionIfNeeded(database);
  await widenActionKindsIfNeeded(database);
```

```ts
async function addInstallationInvitesIfMissing(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare(sqliteInvitesTableSql),
    database.prepare(sqliteInvitesIndexSql),
  ]);
}

async function tableSql(database: D1Database, name: string): Promise<string> {
  const row = await database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).bind(name).first<{sql: string}>();
  if (row === null) throw new Error(`D1 table ${name} is missing.`);
  return row.sql;
}

async function widenMemberAdmissionIfNeeded(database: D1Database): Promise<void> {
  if (membersAcceptInviteAdmission(await tableSql(database, "installation_members"))) return;
  await database.batch(d1MemberAdmissionWidenStatements.map((statement) => database.prepare(statement)));
}

async function widenActionKindsIfNeeded(database: D1Database): Promise<void> {
  if (sqliteActionsTableAcceptsEveryKind(await tableSql(database, "actions"))) return;
  try {
    await database.batch(sqliteActionsWidenStatements({strict: false})
      .map((statement) => database.prepare(statement)));
  } catch (cause) {
    // A concurrent isolate widened first; its table already accepts every kind.
    if (sqliteActionsTableAcceptsEveryKind(await tableSql(database, "actions"))) return;
    throw cause;
  }
}
```

- [ ] **Step 4: Implement the D1 repository methods**

Add to the object `createD1IdentityRepository` returns (and the listed-member enum gains `invite`):

```ts
    createInvite: async (record: CreateInviteRecord) => {
      await database.batch([
        database.prepare(`INSERT INTO installation_invites (${inviteInsertColumns})
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(...inviteInsertValues(record.invite)),
        actionStatement(inviteCreateAction(record.invite, record.attribution)),
      ]);
      return withoutInviteDigest(record.invite);
    },

    findInvite: async (installationId: string, inviteId: string) => findInvite(installationId, inviteId),

    listInvites: async (installationId: string) => {
      const rows = await database.prepare(`
        SELECT ${inviteSelectColumns("i")}, creator.display_name AS "createdByName"
        FROM installation_invites AS i
        LEFT JOIN installation_members AS creator
          ON creator.installation_id = i.installation_id AND creator.id = i.created_by_principal_id
        WHERE i.installation_id = ?
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT 200
      `).bind(installationId).all();
      return rows.results.map(listedInviteFromRow);
    },

    revokeInvite: async (record: RevokeInviteRecord) => {
      const existing = await findInvite(record.installationId, record.inviteId);
      if (existing === null) throw new IdentityNotFound({message: "The invite does not exist."});
      if (inviteStatus(existing, new Date(record.revokedAt)) !== inviteStatuses.active) {
        throw new IdentityConflict({message: "Only an active invite can be revoked."});
      }
      const [updated] = await database.batch([
        database.prepare(`UPDATE installation_invites
          SET revoked_at = ?, revoked_by_principal_id = ?
          WHERE installation_id = ? AND id = ? AND revoked_at IS NULL`)
          .bind(record.revokedAt, record.attribution.principalId, record.installationId, record.inviteId),
        actionWhenStatement(
          inviteRevokeAction(existing, record.attribution, record.revokedAt),
          "EXISTS (SELECT 1 FROM installation_invites WHERE installation_id = ? AND id = ? AND revoked_at = ?)",
          [record.installationId, record.inviteId, record.revokedAt],
        ),
      ]);
      if (updated?.meta.changes !== 1) {
        throw new IdentityConflict({message: "Only an active invite can be revoked."});
      }
      const revoked = await findInvite(record.installationId, record.inviteId);
      if (revoked === null) throw new Error("The revoked invite was not persisted.");
      return withoutInviteDigest(revoked);
    },

    redeemInvite: async (record: RedeemInviteRecord): Promise<RedeemInviteResult> => {
      const {admission} = record;
      const invite = await findInvite(admission.installationId, record.inviteId);
      const refusal = redemptionRefusal(invite, record.email, record.redeemedAt);
      if (invite === null || refusal !== null) {
        return {kind: "refused", outcome: refusal === null || refusal === "unverified" ? "invalid" : refusal};
      }
      const redeemed = "EXISTS (SELECT 1 FROM installation_invites WHERE installation_id = ? AND id = ? AND last_redeemed_member_id = ?)";
      const redeemedBindings = [admission.installationId, record.inviteId, admission.id] as const;
      try {
        const [updated] = await database.batch([
          database.prepare(`UPDATE installation_invites
            SET use_count = use_count + 1, last_redeemed_member_id = ?
            WHERE installation_id = ? AND id = ? AND revoked_at IS NULL
              AND expires_at > ? AND use_count < max_uses
              AND (kind = 'link' OR email = ?)`)
            .bind(admission.id, admission.installationId, record.inviteId, record.redeemedAt, record.email),
          database.prepare(`INSERT INTO installation_members (
              id, installation_id, email, display_name, role, status,
              created_at, updated_at, admitted_by_principal_id, admission_method
            ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${redeemed}`)
            .bind(
              admission.id, admission.installationId, admission.email, admission.displayName,
              admission.role, memberStatuses.active, admission.createdAt, admission.createdAt,
              admission.attribution.principalId, admission.admittedHow, ...redeemedBindings,
            ),
          actionWhenStatement(inviteAdmitAction(admission, invite.id), redeemed, redeemedBindings),
          database.prepare(`INSERT INTO external_identities (provider, subject, member_id, email, bound_at)
            SELECT ?, ?, ?, ?, ? WHERE ${redeemed}`)
            .bind(
              record.binding.provider, record.binding.subject, record.binding.memberId,
              record.binding.email, record.binding.boundAt, ...redeemedBindings,
            ),
          actionWhenStatement(inviteRedeemAction(invite, admission, record.redeemedAt), redeemed, redeemedBindings),
        ]);
        if (updated?.meta.changes !== 1) {
          const now = await findInvite(admission.installationId, record.inviteId);
          const outcome = redemptionRefusal(now, record.email, record.redeemedAt);
          return {kind: "refused", outcome: outcome === null || outcome === "unverified" ? "used" : outcome};
        }
      } catch (cause) {
        if (cause instanceof Error && isD1Constraint(cause)) {
          return {kind: "refused", outcome: "account_unavailable"};
        }
        throw cause;
      }
      const member = await findMember(admission.installationId, admission.id);
      if (member === null) throw new Error("The admitted member was not persisted.");
      return {kind: "admitted", member};
    },
```

with a local helper beside `findMember`:

```ts
  const findInvite = async (installationId: string, inviteId: string): Promise<StoredInvite | null> => {
    const row = await database.prepare(`SELECT ${inviteSelectColumns("i")}
      FROM installation_invites AS i WHERE i.installation_id = ? AND i.id = ?`)
      .bind(installationId, inviteId).first();
    return row === null ? null : storedInviteFromRow(row);
  };
```

`actionWhenStatement` takes `readonly (string | null)[]` bindings; pass `[...redeemedBindings]` if the readonly tuple does not type-check.

- [ ] **Step 5: Run the tests**

Run: `pnpm --dir deploy/cloudflare exec vitest run && pnpm check:cloudflare`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add deploy/cloudflare src/storage
git commit -m "Store invites in Cloudflare D1"
```

---

### Task 7: Invitation service and redemption at sign-in

**Files:**
- Create: `src/application/invitations.ts`
- Modify: `src/core/identity-ports.ts` (`IdentityRepository extends PrincipalActivityRecorder, InvitationRepository`)
- Modify: `src/application/installation-access.ts` (repository effects `findInvite`, `redeemInvite`; `completeExternalIdentity(identity, inviteId)`; redemption)
- Modify: `src/application/interactive-login.ts` (`complete` passes `attempt.inviteId`; error union adds `InviteRejected`)
- Modify: `src/local/create-local-application-layer.ts`, `src/application/application-runtime.ts`
- Create: `tests/support/loopback-identity-provider.ts`, `tests/support/invitation-runtime.ts`
- Test: `tests/application/invitations.test.ts`

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces:
  - `InvitationService` (`Context.Service`) with operations:
    - `create(command: CreateInviteCommand): Effect<IssuedInvite, AuthorizationDenied | IdentityConflict | InvalidInvite | InvitesUnavailable | VersionNotFound | ArtifactRepositoryFailure | IdentityRepositoryFailure>`
    - `list(principal): Effect<readonly AdministeredInvite[], AuthorizationDenied | InvitesUnavailable | IdentityRepositoryFailure>`
    - `revoke(principal, inviteId): Effect<AdministeredInvite, AuthorizationDenied | IdentityConflict | IdentityNotFound | InvitesUnavailable | IdentityRepositoryFailure>`
    - `preview(token): Effect<InvitePreview, ArtifactRepositoryFailure | IdentityRepositoryFailure>`
    - `planLogin(token, forceSignIn): Effect<InviteLoginPlan, ArtifactRepositoryFailure | IdentityRepositoryFailure | InvitesUnavailable>`
  - `CreateInviteCommand { kind; email?; role?; maxUses?; expiresIn; opens?; principal }`
  - `IssuedInvite { invite: AdministeredInvite; token: string }`
  - `InvitePreview = {status: "invalid"} | {status: InviteStatus; kind; role; inviterName; maskedEmail; expiresAt; usesLeft; opens: {artifactName; versionNumber} | null}`
  - `InviteLoginPlan = {kind: "start"; inviteId; returnTo; hints: LoginHints} | {kind: "unavailable"; preview: InvitePreview}`
  - `InstallationAccessOperations.completeExternalIdentity(identity, inviteId?: string | null)`

- [ ] **Step 1: Write the failing test**

The test drives the real composition (`createLocalApplicationLayer`) over a temporary SQLite installation, as `tests/conformance/installation-identity.test.ts` does for local-owner administration.

Create `tests/support/loopback-identity-provider.ts` (Tasks 8–11 reuse it):

```ts
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
  #starts = 0;

  start(hints: LoginHints = {}): Effect.Effect<InteractiveAuthorization, IdentityProviderFailure> {
    this.#starts += 1;
    this.startedWith.push(hints);
    const state = `loopback-login-state-with-sufficient-entropy-${this.#starts}`;
    const url = new URL("/auth/callback", this.baseUrl);
    url.searchParams.set("code", this.authorizationCode);
    url.searchParams.set("state", state);
    return Effect.succeed({
      authorizationUrl: url.toString(),
      codeVerifier: "loopback-code-verifier-with-sufficient-entropy",
      nonce: null,
      state,
    });
  }

  complete(code: string): Effect.Effect<ExternalIdentity, IdentityProviderFailure> {
    return code === this.authorizationCode
      ? Effect.succeed(this.identity)
      : Effect.fail(new IdentityProviderFailure({message: "Unexpected code."}));
  }
}
```

Create `tests/support/invitation-runtime.ts`:

```ts
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {ManagedRuntime, Redacted} from "effect";

import {InstallationAccessService} from "../../src/application/installation-access.js";
import type {Principal} from "../../src/core/identity.js";
import {SystemIdGenerator} from "../../src/core/system.js";
import {createLocalApplicationLayer} from "../../src/local/create-local-application-layer.js";
import {LocalBlobStore} from "../../src/storage/local-blob-store.js";
import {LocalStagingStore} from "../../src/storage/local-staging-store.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";
import {MutableClock} from "./agent-dispatch.js";
import {LoopbackIdentityProvider} from "./loopback-identity-provider.js";

export interface InvitationPerson {
  readonly displayName: string;
  readonly email: string;
  readonly subject: string;
}

/** The real application composition over a temporary SQLite installation with a team provider. */
export async function startInvitationRuntime() {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-invitation-runtime-"));
  const databasePath = path.join(dataDirectory, "artifact-server.db");
  const repository = new SqliteArtifactRepository(databasePath);
  const identityRepository = new SqliteIdentityRepository(databasePath);
  const clock = new MutableClock("2026-10-06T10:00:00.000Z");
  const runtime = ManagedRuntime.make(createLocalApplicationLayer({
    apiToken: Redacted.make("invitation-runtime-test-token"),
    blobs: new LocalBlobStore(path.join(dataDirectory, "blobs")),
    bootstrapAdministratorEmail: "jordan@acme.test",
    clock,
    dispatches: repository,
    externalApiBearerVerifier: null,
    externalMcpBearerVerifier: null,
    externalMcpOAuthVerifier: null,
    ids: new SystemIdGenerator(),
    identityRepository,
    installationId: "invitation-runtime",
    interactiveIdentityProvider: new LoopbackIdentityProvider(),
    localBootstrapCredential: null,
    protectBootstrapAdministrator: false,
    repository,
    staging: new LocalStagingStore(path.join(dataDirectory, "staging")),
  }));

  /** Complete an external login as `person`, optionally redeeming an invite, and return the principal. */
  const signIn = async (person: InvitationPerson, inviteId: string | null = null): Promise<Principal> => {
    const issued = await runtime.runPromise(InstallationAccessService.use((access) =>
      access.completeExternalIdentity({
        displayName: person.displayName,
        email: person.email,
        emailVerificationAsserted: true,
        emailVerified: true,
        provider: "workos",
        subject: person.subject,
      }, inviteId)));
    const authenticated = await runtime.runPromise(InstallationAccessService.use((access) =>
      access.authenticateSession(Redacted.make(issued.token))));
    return authenticated.principal;
  };

  return {
    clock,
    runtime,
    signIn,
    stop: async () => {
      await runtime.dispose();
      identityRepository.close();
      repository.close();
      await rm(dataDirectory, {force: true, recursive: true});
    },
  };
}
```

If `createLocalApplicationLayer` requires fields not listed here, copy them from the `createLocalApplicationLayer({...})` call in `tests/conformance/installation-identity.test.ts` (search for `local-owner-installation`).

```ts
// tests/application/invitations.test.ts
import {Effect} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {InvitationService} from "../../src/application/invitations.js";
import type {Principal} from "../../src/core/identity.js";
import {inviteIdFromToken} from "../../src/core/invitations.js";
import {startInvitationRuntime} from "../support/invitation-runtime.js";

describe("invitation service", () => {
  let context: Awaited<ReturnType<typeof startInvitationRuntime>>;
  let administrator: Principal;

  beforeEach(async () => {
    context = await startInvitationRuntime();
    administrator = await context.signIn({displayName: "Jordan Lee", email: "jordan@acme.test", subject: "admin"});
  });

  afterEach(async () => {
    await context.stop();
  });

  const invitations = <A, E>(use: (service: InvitationService["Service"]) => Effect.Effect<A, E>) =>
    context.runtime.runPromise(InvitationService.use(use));

  test("normalizes a padded mixed-case email and redeems it at sign-in", async () => {
    const issued = await invitations((service) => service.create({
      email: "  Dana@ACME.test ",
      expiresIn: "7d",
      kind: "person",
      principal: administrator,
      role: "member",
    }));
    expect(issued.invite.email).toBe("dana@acme.test");
    const member = await context.signIn(
      {displayName: "Dana", email: "DANA@acme.test", subject: "dana"},
      inviteIdFromToken(issued.token),
    );
    expect(member.membershipRole).toBe("member");
  });

  test("an expired invite cannot be revoked and stays listed as expired", async () => {
    const issued = await invitations((service) => service.create({
      expiresIn: "24h",
      kind: "link",
      maxUses: 3,
      principal: administrator,
    }));
    context.clock.advance(25 * 60 * 60 * 1_000);
    await expect(invitations((service) => service.revoke(administrator, issued.invite.id)))
      .rejects.toMatchObject({_tag: "IdentityConflict"});
    const listed = await invitations((service) => service.list(administrator));
    expect(listed.find((row) => row.id === issued.invite.id)?.status).toBe("expired");
  });

  test("preview of a tampered token is invalid and consumes nothing", async () => {
    const issued = await invitations((service) => service.create({
      expiresIn: "7d",
      kind: "link",
      maxUses: 1,
      principal: administrator,
    }));
    const tampered = `${issued.token.slice(0, -1)}${issued.token.endsWith("A") ? "B" : "A"}`;
    await expect(invitations((service) => service.preview(tampered))).resolves.toEqual({status: "invalid"});
    await expect(invitations((service) => service.preview(issued.token)))
      .resolves.toMatchObject({status: "active", usesLeft: 1});
  });

  test("an unknown destination is refused at creation", async () => {
    await expect(invitations((service) => service.create({
      expiresIn: "7d",
      kind: "link",
      maxUses: 2,
      opens: {artifactId: "art_missing", projectId: "prj_default", versionId: "ver_missing"},
      principal: administrator,
    }))).rejects.toMatchObject({_tag: "VersionNotFound"});
  });
});
```

`InvitationService["Service"]` is the operations type in Effect 4's `Context.Service`; if the typecheck rejects it, use `InvitationOperations` exported from `src/application/invitations.ts`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/application/invitations.test.ts`
Expected: FAIL — `Cannot find module '../../src/application/invitations.js'`.

- [ ] **Step 3: Write `src/application/invitations.ts`**

```ts
import {Context, Effect, Layer} from "effect";

import {attributionOf} from "../core/action-attribution.js";
import {
  type ArtifactRepositoryFailure,
  AuthorizationDenied,
  IdentityConflict,
  type IdentityNotFound,
  type IdentityRepositoryFailure,
  InvalidInvite,
  InvitesUnavailable,
  VersionNotFound,
} from "../core/errors.js";
import {
  isHumanAdministrator,
  membershipRoles,
  type MembershipRole,
  type Principal,
} from "../core/identity.js";
import type {InstallationMember, ListedMember} from "../core/installation-identity.js";
import type {CreateInviteRecord, RevokeInviteRecord} from "../core/invitation-ports.js";
import {
  type AdministeredInvite,
  type Invite,
  type InviteDestination,
  inviteIdFromToken,
  inviteKinds,
  type InviteKind,
  type InviteLifetime,
  inviteLifetimes,
  inviteStatus,
  inviteStatuses,
  type InviteStatus,
  inviteTokenFor,
  inviteTokenPrefix,
  inviteWelcomePath,
  type ListedInvite,
  maskInviteEmail,
  maximumInviteUses,
  type StoredInvite,
} from "../core/invitations.js";
import {identitySecretsEqual, type IdentitySecretProvider} from "./installation-access.js";
import type {LoginHints} from "./interactive-login.js";

export interface InvitationRepositoryEffects {
  readonly createInvite: (record: CreateInviteRecord) => Effect.Effect<Invite, IdentityRepositoryFailure>;
  readonly findInvite: (
    installationId: string,
    inviteId: string,
  ) => Effect.Effect<StoredInvite | null, IdentityRepositoryFailure>;
  readonly findMember: (
    installationId: string,
    memberId: string,
  ) => Effect.Effect<InstallationMember | null, IdentityRepositoryFailure>;
  readonly listInvites: (installationId: string) => Effect.Effect<readonly ListedInvite[], IdentityRepositoryFailure>;
  readonly listMembers: (installationId: string) => Effect.Effect<readonly ListedMember[], IdentityRepositoryFailure>;
  readonly revokeInvite: (
    record: RevokeInviteRecord,
  ) => Effect.Effect<Invite, IdentityConflict | IdentityNotFound | IdentityRepositoryFailure>;
}

/** Names an invite destination for preview; null when it no longer exists. */
export interface InviteDestinations {
  readonly describe: (
    destination: InviteDestination,
  ) => Effect.Effect<{readonly artifactName: string; readonly versionNumber: number} | null, ArtifactRepositoryFailure>;
}

export interface InvitationDependencies {
  readonly clock: {readonly now: () => Date};
  readonly destinations: InviteDestinations;
  /** False when no interactive identity provider is configured. */
  readonly enabled: boolean;
  readonly ids: {readonly inviteId: () => string};
  readonly installationId: string;
  readonly repository: InvitationRepositoryEffects;
  readonly secrets: IdentitySecretProvider;
}

export interface CreateInviteCommand {
  readonly email?: string | undefined;
  readonly expiresIn: InviteLifetime;
  readonly kind: InviteKind;
  readonly maxUses?: number | undefined;
  readonly opens?: InviteDestination | undefined;
  readonly principal: Principal;
  readonly role?: MembershipRole | undefined;
}

export interface IssuedInvite {
  readonly invite: AdministeredInvite;
  /** Returned once; only its digest is stored. */
  readonly token: string;
}

export type InvitePreview =
  | {readonly status: "invalid"}
  | {
    readonly expiresAt: string;
    readonly inviterName: string | null;
    readonly kind: InviteKind;
    readonly maskedEmail: string | null;
    readonly opens: {readonly artifactName: string; readonly versionNumber: number} | null;
    readonly role: MembershipRole;
    readonly status: InviteStatus;
    readonly usesLeft: number;
  };

/** A preview of an invite whose token matched. */
export type ActiveInvitePreview = Exclude<InvitePreview, {readonly status: "invalid"}>;

export type InviteLoginPlan =
  | {readonly hints: LoginHints; readonly inviteId: string; readonly kind: "start"; readonly returnTo: string}
  | {readonly kind: "unavailable"; readonly preview: InvitePreview};

export interface InvitationOperations {
  readonly create: (command: CreateInviteCommand) => Effect.Effect<
    IssuedInvite,
    | ArtifactRepositoryFailure
    | AuthorizationDenied
    | IdentityConflict
    | IdentityRepositoryFailure
    | InvalidInvite
    | InvitesUnavailable
    | VersionNotFound
  >;
  readonly list: (principal: Principal) => Effect.Effect<
    readonly AdministeredInvite[],
    AuthorizationDenied | IdentityRepositoryFailure | InvitesUnavailable
  >;
  readonly planLogin: (token: string, forceSignIn: boolean) => Effect.Effect<
    InviteLoginPlan,
    ArtifactRepositoryFailure | IdentityRepositoryFailure | InvitesUnavailable
  >;
  readonly preview: (token: string) => Effect.Effect<
    InvitePreview,
    ArtifactRepositoryFailure | IdentityRepositoryFailure
  >;
  readonly revoke: (principal: Principal, inviteId: string) => Effect.Effect<
    AdministeredInvite,
    AuthorizationDenied | IdentityConflict | IdentityNotFound | IdentityRepositoryFailure | InvitesUnavailable
  >;
}

/** Administrator-issued invites: issuance, listing, revocation and public preview. */
export class InvitationService extends Context.Service<InvitationService, InvitationOperations>()(
  "artifact-server/application/InvitationService",
) {
  static readonly layer = (dependencies: InvitationDependencies): Layer.Layer<InvitationService> =>
    Layer.succeed(InvitationService, makeInvitationService(dependencies));
}

function makeInvitationService(dependencies: InvitationDependencies): InvitationOperations {
  const requireEnabled = dependencies.enabled
    ? Effect.void
    : Effect.fail(new InvitesUnavailable({
      message: "Invites need an identity provider; this installation has none.",
    }));

  const requireAdministrator = (principal: Principal) =>
    principal.installationId === dependencies.installationId && isHumanAdministrator(principal)
      ? Effect.void
      : Effect.fail(new AuthorizationDenied({message: "An Artifact Server administrator is required."}));

  const administered = (invite: ListedInvite): AdministeredInvite =>
    Object.assign({}, invite, {status: inviteStatus(invite, dependencies.clock.now())});

  const create = Effect.fn("InvitationService.create")(function*(command: CreateInviteCommand) {
    yield* requireEnabled;
    yield* requireAdministrator(command.principal);
    if (!Object.hasOwn(inviteLifetimes, command.expiresIn)) {
      return yield* new InvalidInvite({message: "Choose an expiry of 24 hours, 7 days or 30 days."});
    }
    let email: string | null = null;
    let role: MembershipRole = command.role ?? membershipRoles.member;
    let maxUses: number;
    if (command.kind === inviteKinds.person) {
      if (command.maxUses !== undefined && command.maxUses !== 1) {
        return yield* new InvalidInvite({message: "A one-person invite works once."});
      }
      const normalized = (command.email ?? "").trim().toLocaleLowerCase("en-US");
      if (normalized.length < 3 || normalized.length > 320 || !normalized.includes("@")) {
        return yield* new InvalidInvite({message: "A valid email address is required."});
      }
      const members = yield* dependencies.repository.listMembers(dependencies.installationId);
      if (members.some((member) => member.email === normalized)) {
        return yield* new IdentityConflict({message: "That email already belongs to a member."});
      }
      email = normalized;
      maxUses = 1;
    } else {
      if (command.email !== undefined) {
        return yield* new InvalidInvite({message: "A link invite does not name an email."});
      }
      if (role !== membershipRoles.member) {
        return yield* new InvalidInvite({message: "A link invite only admits members."});
      }
      role = membershipRoles.member;
      maxUses = command.maxUses ?? 0;
      if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > maximumInviteUses) {
        return yield* new InvalidInvite({message: `A link invite allows 1 to ${maximumInviteUses} uses.`});
      }
    }
    const opens = command.opens ?? null;
    if (opens !== null && (yield* dependencies.destinations.describe(opens)) === null) {
      return yield* new VersionNotFound({message: "The invite destination version does not exist."});
    }
    const now = dependencies.clock.now();
    const id = dependencies.ids.inviteId();
    const token = inviteTokenFor(id, dependencies.secrets.issue());
    const stored: StoredInvite = {
      createdAt: now.toISOString(),
      createdByPrincipalId: command.principal.id,
      email,
      expiresAt: new Date(now.getTime() + inviteLifetimes[command.expiresIn]).toISOString(),
      id,
      installationId: dependencies.installationId,
      kind: command.kind,
      maxUses,
      opens,
      revokedAt: null,
      revokedByPrincipalId: null,
      role,
      secretDigest: dependencies.secrets.digest(token),
      tokenPrefix: inviteTokenPrefix(id),
      useCount: 0,
    };
    const invite = yield* dependencies.repository.createInvite({
      attribution: attributionOf(command.principal),
      invite: stored,
    });
    return {invite: administered({...invite, createdByName: command.principal.displayName}), token};
  });

  const list = Effect.fn("InvitationService.list")(function*(principal: Principal) {
    yield* requireEnabled;
    yield* requireAdministrator(principal);
    const invites = yield* dependencies.repository.listInvites(dependencies.installationId);
    return invites.map(administered);
  });

  const revoke = Effect.fn("InvitationService.revoke")(function*(principal: Principal, inviteId: string) {
    yield* requireEnabled;
    yield* requireAdministrator(principal);
    const invite = yield* dependencies.repository.revokeInvite({
      attribution: attributionOf(principal),
      installationId: dependencies.installationId,
      inviteId,
      revokedAt: dependencies.clock.now().toISOString(),
    });
    const creator = yield* dependencies.repository.findMember(
      dependencies.installationId,
      invite.createdByPrincipalId,
    );
    return administered({...invite, createdByName: creator?.displayName ?? null});
  });

  /** The stored invite a token names, only when its secret matches. */
  const resolve = Effect.fn("InvitationService.resolve")(function*(token: string) {
    if (!dependencies.enabled) return null;
    const inviteId = inviteIdFromToken(token);
    if (inviteId === null) return null;
    const stored = yield* dependencies.repository.findInvite(dependencies.installationId, inviteId);
    if (stored === null) return null;
    return identitySecretsEqual(dependencies.secrets.digest(token), stored.secretDigest) ? stored : null;
  });

  const describe = Effect.fn("InvitationService.describe")(function*(stored: StoredInvite) {
    const [inviter, opens] = yield* Effect.all([
      dependencies.repository.findMember(dependencies.installationId, stored.createdByPrincipalId),
      stored.opens === null ? Effect.succeed(null) : dependencies.destinations.describe(stored.opens),
    ]);
    const preview: ActiveInvitePreview = {
      expiresAt: stored.expiresAt,
      inviterName: inviter?.displayName ?? null,
      kind: stored.kind,
      maskedEmail: stored.email === null ? null : maskInviteEmail(stored.email),
      opens,
      role: stored.role,
      status: inviteStatus(stored, dependencies.clock.now()),
      usesLeft: Math.max(0, stored.maxUses - stored.useCount),
    };
    return preview;
  });

  const preview = Effect.fn("InvitationService.preview")(function*(token: string) {
    const stored = yield* resolve(token);
    if (stored === null) return {status: "invalid"} satisfies InvitePreview;
    return yield* describe(stored);
  });

  const planLogin = Effect.fn("InvitationService.planLogin")(function*(token: string, forceSignIn: boolean) {
    yield* requireEnabled;
    const stored = yield* resolve(token);
    if (stored === null) {
      return {kind: "unavailable", preview: {status: "invalid"}} satisfies InviteLoginPlan;
    }
    const summary = yield* describe(stored);
    if (summary.status !== inviteStatuses.active) {
      return {kind: "unavailable", preview: summary} satisfies InviteLoginPlan;
    }
    const hints: LoginHints = {
      ...(forceSignIn ? {forceSignIn: true} : {}),
      ...(stored.email === null ? {screenHint: "sign-up" as const} : {loginHint: stored.email}),
    };
    return {
      hints,
      inviteId: stored.id,
      kind: "start",
      returnTo: inviteWelcomePath(summary.opens === null ? null : stored.opens),
    } satisfies InviteLoginPlan;
  });

  return InvitationService.of({create, list, planLogin, preview, revoke});
}
```

- [ ] **Step 4: Add redemption to `InstallationAccessService`**

In `InstallationIdentityRepository` add:

```ts
  readonly findInvite: (
    installationId: string,
    inviteId: string,
  ) => Effect.Effect<StoredInvite | null, IdentityRepositoryFailure>;
  readonly redeemInvite: (
    record: RedeemInviteRecord,
  ) => Effect.Effect<RedeemInviteResult, IdentityRepositoryFailure>;
```

Change `completeExternalIdentity` in `InstallationAccessOperations` to

```ts
  readonly completeExternalIdentity: (
    identity: ExternalIdentity,
    inviteId?: string | null,
  ) => Effect.Effect<
    IssuedApplicationSession,
    IdentityAdmissionDenied | IdentityConflict | IdentityRepositoryFailure | InviteRejected
  >;
```

and its implementation calls `resolveExternalMember(identity, inviteId ?? null)`. `authenticateExternalIdentity` calls `resolveExternalMember(identity, null)`.

Replace `resolveExternalMember`:

```ts
  const rejectInvite = (outcome: InviteOutcome) =>
    Effect.fail(new InviteRejected({message: inviteOutcomeMessages[outcome], outcome}));

  const redeemInvite = Effect.fn("InstallationAccessService.redeemInvite")(
    function*(identity: ExternalIdentity, email: string, inviteId: string) {
      if (identity.emailVerificationAsserted !== true) {
        return yield* rejectInvite(inviteOutcomes.unverified);
      }
      const invite = yield* dependencies.repository.findInvite(dependencies.installationId, inviteId);
      if (invite === null) return yield* rejectInvite(inviteOutcomes.invalid);
      const inviter = yield* dependencies.repository.findMember(
        dependencies.installationId,
        invite.createdByPrincipalId,
      );
      const now = dependencies.clock.now().toISOString();
      const memberId = dependencies.ids.memberId();
      const result = yield* dependencies.repository.redeemInvite({
        admission: {
          admittedHow: memberAdmissions.invite,
          attribution: {
            actor: {displayName: inviter?.displayName ?? "Administrator", kind: principalKinds.human},
            authorizedByPrincipalId: null,
            principalId: invite.createdByPrincipalId,
          },
          createdAt: now,
          displayName: identity.displayName,
          email,
          id: memberId,
          installationId: dependencies.installationId,
          role: invite.role,
        },
        binding: {
          boundAt: now,
          email,
          memberId,
          provider: identity.provider,
          subject: identity.subject,
        },
        email,
        inviteId,
        redeemedAt: now,
      });
      if (result.kind === "refused") return yield* rejectInvite(result.outcome);
      return result.member;
    },
  );

  const resolveExternalMember = Effect.fn(
    "InstallationAccessService.resolveExternalMember",
  )(function*(identity: ExternalIdentity, inviteId: string | null) {
    if (!identity.emailVerified) {
      return yield* inviteId === null
        ? Effect.fail(new IdentityAdmissionDenied({
          message: "The login provider did not verify the email address.",
        }))
        : rejectInvite(inviteOutcomes.unverified);
    }
    const email = yield* normalizeEmail(identity.email);
    let member = yield* dependencies.repository.findActiveMemberByExternalIdentity(
      dependencies.installationId,
      identity.provider,
      identity.subject,
    );
    if (member === null) {
      member = yield* dependencies.repository.findActiveMemberByEmail(
        dependencies.installationId,
        email,
      );
    }
    if (member === null && inviteId !== null) {
      // The redemption transaction already bound the identity.
      return yield* redeemInvite(identity, email, inviteId);
    }
    if (member === null) {
      // ... the existing bootstrap and verified-domain block, unchanged ...
    }
    yield* dependencies.repository.bindExternalIdentity({
      boundAt: dependencies.clock.now().toISOString(),
      email,
      memberId: member.id,
      provider: identity.provider,
      subject: identity.subject,
    });
    return member;
  });
```

Keep the existing bootstrap/domain block exactly as it is today inside `if (member === null) { … }`.

In `src/application/interactive-login.ts`, `complete` calls `installationAccess.completeExternalIdentity(identity, attempt.inviteId)` and `InteractiveLoginOperations.complete`'s error union gains `InviteRejected`.

In `src/core/identity-ports.ts`: `export interface IdentityRepository extends PrincipalActivityRecorder, InvitationRepository {`.

- [ ] **Step 5: Compose the service**

In `src/local/create-local-application-layer.ts`:

1. Hoist the identity secrets into `const identitySecrets: IdentitySecretProvider = {digest: digestIdentitySecret, issue: () => randomBase64Url(32)};` (use exactly what `InstallationAccessService.layer` receives today) and pass it to both layers.
2. Add to `InstallationAccessService.layer`'s `repository`:

```ts
      findInvite: (installationId, inviteId) => identityEffect(
        "findInvite",
        () => identityRepository.findInvite(installationId, inviteId),
      ),
      redeemInvite: (record) => identityEffect(
        "redeemInvite",
        () => identityRepository.redeemInvite(record),
      ),
```

3. Add the layer:

```ts
  const invitationLayer = InvitationService.layer({
    clock: adapters.clock,
    destinations: {
      describe: (destination) => Effect.tryPromise({
        try: async () => {
          const artifact = await adapters.repository.findArtifact(destination.projectId, destination.artifactId);
          if (artifact === null || artifact.deletedAt !== null) return null;
          const version = await adapters.repository.findVersionMetadata(
            destination.projectId,
            destination.artifactId,
            destination.versionId,
          );
          return version === null ? null : {artifactName: artifact.name, versionNumber: version.number};
        },
        catch: (cause) => repositoryFailure("findVersionRecord", cause),
      }),
    },
    enabled: adapters.interactiveIdentityProvider !== null,
    ids: {inviteId: () => `inv_${randomUUID()}`},
    installationId: adapters.installationId,
    repository: {
      createInvite: (record) => identityEffect("createInvite", () => identityRepository.createInvite(record)),
      findInvite: (installationId, inviteId) => identityEffect(
        "findInvite",
        () => identityRepository.findInvite(installationId, inviteId),
      ),
      findMember: (installationId, memberId) => identityEffect(
        "findMember",
        () => identityRepository.findMember(installationId, memberId),
      ),
      listInvites: (installationId) => identityEffect(
        "listInvites",
        () => identityRepository.listInvites(installationId),
      ),
      listMembers: (installationId) => identityEffect(
        "listMembers",
        () => identityRepository.listMembers(installationId),
      ),
      revokeInvite: (record) => identityEffectWithConflictOrNotFound(
        "revokeInvite",
        () => identityRepository.revokeInvite(record),
      ),
    },
    secrets: identitySecrets,
  });
```

4. Add `invitationLayer` to the final `Layer.mergeAll(...)`.

In `src/application/application-runtime.ts`, add `| InvitationService` to `ApplicationServices`.

If `findVersionMetadata` or `findArtifact` is absent from the composed `repository` type, check `src/core/ports.ts:822` and use the exact method names there.

- [ ] **Step 6: Run the tests and typecheck**

Run: `pnpm vitest run tests/application tests/conformance/installation-identity.test.ts tests/conformance/auth-019-oidc-login.test.ts && pnpm typecheck && pnpm check:cloudflare`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src tests/application tests/support deploy/cloudflare
git commit -m "Issue, preview and redeem invites through the application services"
```

---

### Task 8: HTTP routes, rate limit and conformance tests

**Files:**
- Create: `src/http/invite-rate-limiter.ts`
- Modify: `src/http/create-http-app.ts`
- Create: `src/cli/invite-sign-up-notice.ts`; Modify: `src/cli/lifecycle-commands.ts`
- Create: `tests/support/invites.ts`
- Test: `tests/http/invite-rate-limiter.test.ts`, `tests/conformance/auth-030-invite-admission.test.ts`, `tests/conformance/auth-031-invite-issuance.test.ts`, `tests/conformance/auth-032-public-invite-endpoints.test.ts`

**Interfaces:**
- Consumes: `InvitationService`, `InteractiveLoginService.start(returnTo, invite)`, `InviteRejected`.
- Produces HTTP:
  - `POST /api/v1/invites` → `201 {invite, url}`; `GET /api/v1/invites` → `{invites}`; `POST /api/v1/invites/:inviteId/revoke` → `{invite}`
  - `POST /auth/invites/preview` `{token}` → `200 InvitePreview` | `429`
  - `POST /auth/invites/start` `{token, forceSignIn?}` → `200 {authorizationUrl}` or `200 InvitePreview` | `429`
  - `GET /join` → `308 /review/join`
  - `/auth/callback` with `InviteRejected` → `303 /review/join?outcome=<outcome>`
- `tests/support/invites.ts` exports `startInviteServer()`, `signInAs(context, person)`, `createInvite(context, cookies, body)`, `redeem(context, token, person)`, `browserMutationHeaders(origin, cookies)`, `applicationCookies(setCookie)`.

- [ ] **Step 1: Write the limiter test and implementation**

```ts
// tests/http/invite-rate-limiter.test.ts
import {describe, expect, test} from "vitest";

import {InviteRateLimiter} from "../../src/http/invite-rate-limiter.js";

describe("invite rate limiter", () => {
  test("limits after the window fills and frees as failures age out", () => {
    let now = 0;
    const limiter = new InviteRateLimiter({limit: 3, windowMilliseconds: 60_000}, () => now);
    for (let index = 0; index < 3; index += 1) {
      expect(limiter.retryAfterSeconds()).toBeNull();
      limiter.noteFailure();
    }
    expect(limiter.retryAfterSeconds()).toBe(60);
    now = 30_000;
    expect(limiter.retryAfterSeconds()).toBe(30);
    now = 60_001;
    expect(limiter.retryAfterSeconds()).toBeNull();
  });
});
```

```ts
// src/http/invite-rate-limiter.ts

/** Failed invite lookups allowed per window before every invite request waits. */
export interface InviteRateLimitPolicy {
  readonly limit: number;
  readonly windowMilliseconds: number;
}

export const defaultInviteRateLimitPolicy: InviteRateLimitPolicy = {
  limit: 30,
  windowMilliseconds: 60_000,
};

/**
 * One process-wide sliding window over failed invite lookups. The token's
 * 256-bit secret makes guessing impractical; this bounds load and log noise.
 */
export class InviteRateLimiter {
  readonly #failures: number[] = [];
  readonly #now: () => number;
  readonly #policy: InviteRateLimitPolicy;

  constructor(
    policy: InviteRateLimitPolicy = defaultInviteRateLimitPolicy,
    now: () => number = () => Date.now(),
  ) {
    this.#policy = policy;
    this.#now = now;
  }

  /** Seconds until a slot frees, or null when requests may proceed. */
  retryAfterSeconds(): number | null {
    const now = this.#now();
    this.#prune(now);
    const oldest = this.#failures[0];
    if (this.#failures.length < this.#policy.limit || oldest === undefined) return null;
    return Math.max(1, Math.ceil((oldest + this.#policy.windowMilliseconds - now) / 1_000));
  }

  noteFailure(): void {
    const now = this.#now();
    this.#prune(now);
    this.#failures.push(now);
    if (this.#failures.length > this.#policy.limit) this.#failures.shift();
  }

  #prune(now: number): void {
    while (this.#failures[0] !== undefined && this.#failures[0] <= now - this.#policy.windowMilliseconds) {
      this.#failures.shift();
    }
  }
}
```

Run: `pnpm vitest run tests/http/invite-rate-limiter.test.ts` — Expected: PASS.

- [ ] **Step 2: Write the support helpers**

```ts
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

export async function createInvite(
  context: InviteServer,
  cookies: ApplicationCookies,
  body: Readonly<Record<string, unknown>>,
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

/** Start an invite login and complete it at the loopback provider. */
export async function redeem(
  context: InviteServer,
  token: string,
  person: Person,
  options: {readonly forceSignIn?: boolean} = {},
): Promise<Response> {
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
  return fetch(body.authorizationUrl, {headers: {Cookie: handshake}, redirect: "manual"});
}
```

- [ ] **Step 3: Write the failing conformance tests**

```ts
// tests/conformance/auth-031-invite-issuance.test.ts
import {DatabaseSync} from "node:sqlite";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  bootstrapAdministrator,
  browserMutationHeaders,
  createInvite,
  type InviteServer,
  redeem,
  signInAs,
  startInviteServer,
} from "../support/invites.js";
import {createTestInstallation, removeTestInstallation, startTestServer} from "../support/runtime-harness.js";

describe("invite issuance", () => {
  let context: InviteServer;

  beforeEach(async () => {
    context = await startInviteServer();
  });

  afterEach(async () => {
    await context.stop();
  });

  test("AUTH-031-B: an administrator creates, lists and revokes invites and sees each token once", async () => {
    const administrator = await signInAs(context, bootstrapAdministrator);
    const person = await createInvite(context, administrator, {
      email: "dana@acme.test",
      expiresIn: "7d",
      kind: "person",
      role: "administrator",
    });
    const link = await createInvite(context, administrator, {expiresIn: "24h", kind: "link", maxUses: 10});
    expect(person.url).toBe(`${context.server.baseUrl}/join#${person.token}`);
    expect(person.token).toMatch(/^as_inv_inv_[0-9a-f-]{36}_[A-Za-z0-9_-]{32,}$/u);

    const listed = await fetch(`${context.server.baseUrl}/api/v1/invites`, {
      headers: {Cookie: administrator.header},
    });
    expect(listed.status).toBe(200);
    const body = await listed.text();
    expect(body).not.toContain(person.token);
    expect(body).not.toContain(link.token.slice(-20));
    const invites = z.object({invites: z.array(z.looseObject({
      createdByName: z.string().nullable(),
      id: z.string(),
      kind: z.string(),
      maxUses: z.number(),
      status: z.string(),
    }))}).parse(JSON.parse(body)).invites;
    expect(invites.map((invite) => [invite.id, invite.kind, invite.maxUses, invite.status, invite.createdByName]))
      .toEqual([
        [link.id, "link", 10, "active", "Jordan Lee"],
        [person.id, "person", 1, "active", "Jordan Lee"],
      ]);

    const revoked = await fetch(`${context.server.baseUrl}/api/v1/invites/${link.id}/revoke`, {
      headers: browserMutationHeaders(context.server.baseUrl, administrator),
      method: "POST",
    });
    expect(revoked.status).toBe(200);
    expect(z.object({invite: z.looseObject({status: z.string()})}).parse(await revoked.json()).invite.status)
      .toBe("revoked");

    const database = new DatabaseSync(path.join(context.installation.dataDirectory, "artifact-server.db"), {readOnly: true});
    try {
      const stored = JSON.stringify(database.prepare("SELECT * FROM installation_invites").all());
      expect(stored).not.toContain(person.token);
      expect(stored).not.toContain(link.token);
    } finally {
      database.close();
    }
  });

  test("AUTH-031-F: members, keys, bad rules, existing emails and local-owner mode are refused", async () => {
    const administrator = await signInAs(context, bootstrapAdministrator);
    const post = (cookies: typeof administrator | null, body: object, extra: HeadersInit = {}) =>
      fetch(`${context.server.baseUrl}/api/v1/invites`, {
        body: JSON.stringify(body),
        headers: {...Object.fromEntries(browserMutationHeaders(context.server.baseUrl, cookies)), ...extra},
        method: "POST",
      });

    const memberInvite = await createInvite(context, administrator, {expiresIn: "7d", kind: "link", maxUses: 5});
    await redeem(context, memberInvite.token, {displayName: "Sam Rivera", email: "sam@acme.test", subject: "sam"});
    const member = await signInAs(context, {displayName: "Sam Rivera", email: "sam@acme.test", subject: "sam"});
    expect((await post(member, {expiresIn: "7d", kind: "link", maxUses: 2})).status).toBe(403);
    const list = await fetch(`${context.server.baseUrl}/api/v1/invites`, {headers: {Cookie: member.header}});
    expect(list.status).toBe(403);

    const keyed = await fetch(`${context.server.baseUrl}/api/v1/invites`, {
      body: JSON.stringify({expiresIn: "7d", kind: "link", maxUses: 2}),
      headers: {Authorization: `Bearer ${context.installation.apiToken}`, "Content-Type": "application/json"},
      method: "POST",
    });
    expect(keyed.status).toBe(403);

    expect((await post(administrator, {expiresIn: "7d", kind: "link", maxUses: 2, role: "administrator"})).status).toBe(422);
    expect((await post(administrator, {expiresIn: "7d", kind: "link", maxUses: 101})).status).toBe(422);
    expect((await post(administrator, {expiresIn: "7d", kind: "link", maxUses: 0})).status).toBe(422);
    expect((await post(administrator, {expiresIn: "90d", kind: "link", maxUses: 2})).status).toBe(422);
    expect((await post(administrator, {email: "SAM@acme.test", expiresIn: "7d", kind: "person"})).status).toBe(409);
    expect((await post(administrator, {email: "jordan@acme.test", expiresIn: "7d", kind: "person"})).status).toBe(409);

    const local = await createTestInstallation();
    const localServer = await startTestServer(local);
    try {
      const refused = await fetch(`${localServer.baseUrl}/api/v1/invites`, {
        headers: {Authorization: `Bearer ${local.apiToken}`},
      });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({error: {code: "INVITES_UNAVAILABLE"}});
    } finally {
      await localServer.stop();
      await removeTestInstallation(local);
    }

    const database = new DatabaseSync(path.join(context.installation.dataDirectory, "artifact-server.db"));
    try {
      expect(() => database.prepare(`INSERT INTO installation_invites (
        installation_id, id, kind, email, role, max_uses, use_count, secret_digest,
        token_prefix, expires_at, created_at, created_by_principal_id
      ) SELECT installation_id, 'inv_direct', 'link', NULL, 'administrator', 5, 0, 'd', 'p', 'x', 'x', 'm'
        FROM installation_members LIMIT 1`).run()).toThrow(/constraint failed/u);
    } finally {
      database.close();
    }
  });
});
```

The local-owner case expects 409 because `InvitationService` checks availability (`requireEnabled`) before the caller's role.

```ts
// tests/conformance/auth-030-invite-admission.test.ts
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  applicationCookies,
  bootstrapAdministrator,
  browserMutationHeaders,
  createInvite,
  type InviteServer,
  redeem,
  signInAs,
  startInviteServer,
} from "../support/invites.js";
import {publishNew} from "../support/publishing.js";
import {apiHeaders} from "../support/runtime-harness.js";

const sessionSchema = z.object({principal: z.object({id: z.string(), membershipRole: z.string()})});

describe("invite admission", () => {
  let context: InviteServer;

  beforeEach(async () => {
    context = await startInviteServer();
  });

  afterEach(async () => {
    await context.stop();
  });

  const session = async (response: Response) => {
    const cookies = applicationCookies(response.headers.getSetCookie());
    const answered = await fetch(`${context.server.baseUrl}/api/v1/session`, {headers: {Cookie: cookies.header}});
    return sessionSchema.parse(await answered.json()).principal;
  };

  test("AUTH-030-B: one-person and link invites admit with their role, attribution and activity", async () => {
    const administrator = await signInAs(context, bootstrapAdministrator);
    const {body: published} = await publishNew(context.server, context.installation, {
      accessSetting: "account_required",
      content: "pricing",
      idempotencyKey: "invite-destination",
      name: "Q3 Pricing Review",
    });
    const version = published.version;
    const person = await createInvite(context, administrator, {
      email: "dana@acme.test",
      expiresIn: "7d",
      kind: "person",
      opens: {artifactId: version.artifactId, projectId: version.projectId, versionId: version.id},
      role: "administrator",
    });
    const joined = await redeem(context, person.token, {displayName: "Dana Okonkwo", email: "dana@acme.test", subject: "dana"});
    expect(joined.status).toBe(303);
    const location = new URL(joined.headers.get("location") ?? "", context.server.baseUrl);
    expect(location.pathname).toBe("/review/join");
    expect(location.searchParams.get("next"))
      .toBe(`/review?artifact=${version.artifactId}&project=${version.projectId}&version=${version.id}&view=focus`);
    expect((await session(joined)).membershipRole).toBe("administrator");

    const link = await createInvite(context, administrator, {expiresIn: "7d", kind: "link", maxUses: 2});
    const sam = await redeem(context, link.token, {displayName: "Sam Rivera", email: "sam@acme.test", subject: "sam"});
    expect((await session(sam)).membershipRole).toBe("member");
    expect(new URL(sam.headers.get("location") ?? "", context.server.baseUrl).searchParams.get("next"))
      .toBe("/review/projects");

    const members = await fetch(`${context.server.baseUrl}/api/v1/members`, {headers: {Cookie: administrator.header}});
    const rows = z.object({members: z.array(z.looseObject({
      admittedBy: z.object({name: z.string()}).nullable(),
      admittedHow: z.string().nullable(),
      email: z.string(),
    }))}).parse(await members.json()).members;
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({admittedBy: {name: "Jordan Lee"}, admittedHow: "invite", email: "dana@acme.test"}),
      expect.objectContaining({admittedBy: {name: "Jordan Lee"}, admittedHow: "invite", email: "sam@acme.test"}),
    ]));

    const database = new DatabaseSync(path.join(context.installation.dataDirectory, "artifact-server.db"), {readOnly: true});
    try {
      const actions = z.array(z.object({action: z.string()})).parse(database.prepare(
        "SELECT action FROM actions WHERE action IN ('invite_redeem', 'member_admit') ORDER BY created_at",
      ).all()).map((row) => row.action);
      expect(actions.filter((action) => action === "invite_redeem")).toHaveLength(2);
      expect(actions.filter((action) => action === "member_admit")).toHaveLength(3);
    } finally {
      database.close();
    }
  });

  test("AUTH-030-F: wrong, unverified, ended, tampered and contended redemptions admit no one", async () => {
    const administrator = await signInAs(context, bootstrapAdministrator);
    const outcome = (response: Response) =>
      new URL(response.headers.get("location") ?? "", context.server.baseUrl).searchParams.get("outcome");

    const person = await createInvite(context, administrator, {email: "dana@acme.test", expiresIn: "7d", kind: "person"});
    const wrong = await redeem(context, person.token, {displayName: "Sam", email: "sam@acme.test", subject: "sam-wrong"});
    expect(wrong.status).toBe(303);
    expect(outcome(wrong)).toBe("wrong_account");
    expect(wrong.headers.getSetCookie().some((value) => value.startsWith("artifact_session="))).toBe(false);

    const unverified = await redeem(context, person.token, {
      displayName: "Dana",
      email: "dana@acme.test",
      emailVerificationAsserted: false,
      subject: "dana-unverified",
    });
    expect(outcome(unverified)).toBe("unverified");

    // Preview never consumes, and the person invite still admits Dana afterwards.
    const preview = await fetch(`${context.server.baseUrl}/auth/invites/preview`, {
      body: JSON.stringify({token: person.token}),
      headers: browserMutationHeaders(context.server.baseUrl, null),
      method: "POST",
    });
    expect(z.looseObject({status: z.string(), usesLeft: z.number()}).parse(await preview.json()))
      .toMatchObject({status: "active", usesLeft: 1});
    expect((await redeem(context, person.token, {displayName: "Dana", email: "dana@acme.test", subject: "dana"})).status)
      .toBe(303);
    // A spent invite never starts a login: start answers with the preview instead.
    const again = await fetch(`${context.server.baseUrl}/auth/invites/start`, {
      body: JSON.stringify({token: person.token}),
      headers: browserMutationHeaders(context.server.baseUrl, null),
      method: "POST",
    });
    expect(z.looseObject({status: z.string()}).parse(await again.json()).status).toBe("used");

    // A deactivated member's email cannot rejoin through a link.
    const samLink = await createInvite(context, administrator, {expiresIn: "7d", kind: "link", maxUses: 2});
    const samJoined = await redeem(context, samLink.token, {displayName: "Sam", email: "sam@acme.test", subject: "sam"});
    const samId = (await session(samJoined)).id;
    await fetch(`${context.server.baseUrl}/api/v1/members/${samId}/deactivate`, {
      headers: browserMutationHeaders(context.server.baseUrl, administrator),
      method: "POST",
    });
    const rejoin = await redeem(context, samLink.token, {displayName: "Sam", email: "sam@acme.test", subject: "sam-new"});
    expect(outcome(rejoin)).toBe("account_unavailable");

    // An active member redeeming a link consumes nothing.
    const link = await createInvite(context, administrator, {expiresIn: "7d", kind: "link", maxUses: 1});
    const existing = await redeem(context, link.token, {displayName: "Dana", email: "dana@acme.test", subject: "dana"});
    expect(existing.status).toBe(303);
    const after = await fetch(`${context.server.baseUrl}/auth/invites/preview`, {
      body: JSON.stringify({token: link.token}),
      headers: browserMutationHeaders(context.server.baseUrl, null),
      method: "POST",
    });
    expect(z.looseObject({usesLeft: z.number()}).parse(await after.json()).usesLeft).toBe(1);

    // Contention for the last use admits exactly one person.
    const results = await Promise.all([
      redeem(context, link.token, {displayName: "X", email: "x@acme.test", subject: "x"}),
      redeem(context, link.token, {displayName: "Y", email: "y@acme.test", subject: "y"}),
    ]);
    const admitted = results.filter((response) =>
      response.headers.getSetCookie().some((value) => value.startsWith("artifact_session=")));
    expect(admitted).toHaveLength(1);

    // A revoked invite and a tampered token admit no one.
    const revokedLink = await createInvite(context, administrator, {expiresIn: "7d", kind: "link", maxUses: 3});
    await fetch(`${context.server.baseUrl}/api/v1/invites/${revokedLink.id}/revoke`, {
      headers: browserMutationHeaders(context.server.baseUrl, administrator),
      method: "POST",
    });
    const revokedStart = await fetch(`${context.server.baseUrl}/auth/invites/start`, {
      body: JSON.stringify({token: revokedLink.token}),
      headers: browserMutationHeaders(context.server.baseUrl, null),
      method: "POST",
    });
    expect(z.looseObject({status: z.string()}).parse(await revokedStart.json()).status).toBe("revoked");
    const tampered = await fetch(`${context.server.baseUrl}/auth/invites/start`, {
      body: JSON.stringify({token: `${revokedLink.token.slice(0, -2)}zz`}),
      headers: browserMutationHeaders(context.server.baseUrl, null),
      method: "POST",
    });
    expect(z.looseObject({status: z.string()}).parse(await tampered.json()).status).toBe("invalid");
  });

  test("a deleted destination leaves the preview without one and joining lands on Projects", async () => {
    const administrator = await signInAs(context, bootstrapAdministrator);
    const {body: published} = await publishNew(context.server, context.installation, {
      accessSetting: "account_required",
      content: "temporary",
      idempotencyKey: "deleted-destination",
      name: "Temporary Review",
    });
    const version = published.version;
    const link = await createInvite(context, administrator, {
      expiresIn: "7d",
      kind: "link",
      maxUses: 2,
      opens: {artifactId: version.artifactId, projectId: version.projectId, versionId: version.id},
    });
    const deleted = await fetch(
      `${context.server.baseUrl}/api/v1/artifacts/${version.artifactId}?projectId=${version.projectId}`,
      {
        body: JSON.stringify({expectedCurrentVersionId: version.id}),
        headers: apiHeaders(context.installation, "delete-destination"),
        method: "DELETE",
      },
    );
    expect(deleted.ok).toBe(true);
    const preview = await fetch(`${context.server.baseUrl}/auth/invites/preview`, {
      body: JSON.stringify({token: link.token}),
      headers: browserMutationHeaders(context.server.baseUrl, null),
      method: "POST",
    });
    expect(await preview.json()).toMatchObject({opens: null, status: "active"});
    const joined = await redeem(context, link.token, {displayName: "Rae", email: "rae@acme.test", subject: "rae"});
    expect(new URL(joined.headers.get("location") ?? "", context.server.baseUrl).searchParams.get("next"))
      .toBe("/review/projects");
  });
});
```

`publishNew` returns `{body, response}`; the version ids are `body.version.id`, `body.version.artifactId` and `body.version.projectId`.

```ts
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

    let limited: Response | null = null;
    for (let attempt = 0; attempt < 40 && limited === null; attempt += 1) {
      const response = await fetch(`${context.server.baseUrl}/auth/invites/preview`, {
        body: JSON.stringify({token: `as_inv_inv_00000000-0000-4000-8000-${String(attempt).padStart(12, "0")}_${"a".repeat(43)}`}),
        headers: browserMutationHeaders(context.server.baseUrl, null),
        method: "POST",
      });
      if (response.status === 429) limited = response;
    }
    expect(limited?.status).toBe(429);
    expect(Number(limited?.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm vitest run tests/conformance/auth-030-invite-admission.test.ts tests/conformance/auth-031-invite-issuance.test.ts tests/conformance/auth-032-public-invite-endpoints.test.ts`
Expected: FAIL — `/api/v1/invites` returns 404.

- [ ] **Step 5: Add the routes**

In `src/http/create-http-app.ts`:

1. `HttpAppDependencies` gains `readonly inviteRateLimit?: InviteRateLimitPolicy;`. Inside `createHttpApp`, `const inviteLimiter = new InviteRateLimiter(dependencies.inviteRateLimit);`.

2. Schemas, beside `admitMemberSchema`:

```ts
const inviteLifetimeSchema = z.enum(["24h", "7d", "30d"]);
const inviteDestinationSchema = z.object({
  artifactId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200),
  versionId: z.string().min(1).max(200),
}).strict();
const createInviteSchema = z.discriminatedUnion("kind", [
  z.object({
    email: z.string().trim().min(3).max(320),
    expiresIn: inviteLifetimeSchema,
    kind: z.literal("person"),
    opens: inviteDestinationSchema.optional(),
    role: memberRoleSchema.default(membershipRoles.member),
  }).strict(),
  z.object({
    expiresIn: inviteLifetimeSchema,
    kind: z.literal("link"),
    maxUses: z.number().int(),
    opens: inviteDestinationSchema.optional(),
    role: memberRoleSchema.default(membershipRoles.member),
  }).strict(),
]);
const inviteTokenBodySchema = z.object({
  forceSignIn: z.boolean().default(false),
  token: z.string().min(1).max(512),
}).strict();
```

(Range and role rules for `link` stay in the service, so the 422 comes from `InvalidInvite` with a readable message.)

3. Extract the origin half of `requireBrowserMutationSecurity` into:

```ts
function requireApplicationOrigin(
  context: Context<HttpEnvironment>,
  dependencies: HttpAppDependencies,
): void {
  const requestUrl = new URL(context.req.url);
  const trustedOrigin = dependencies.trustedApplicationOrigin ?? requestUrl.origin;
  const fetchMode = context.req.header("sec-fetch-mode");
  if (
    context.req.header("origin") !== trustedOrigin ||
    context.req.header("sec-fetch-site") !== "same-origin" ||
    (fetchMode !== "cors" && fetchMode !== "same-origin" && fetchMode !== "navigate")
  ) {
    throw new AuthorizationDenied({
      message: "Browser mutations must come from the Artifact Server application origin.",
    });
  }
}
```

and call it at the top of `requireBrowserMutationSecurity`.

4. Admin routes after the members routes:

```ts
  app.get("/api/v1/invites", async (context) => {
    const invites = await runHttpApplicationEffect(
      context,
      dependencies,
      InvitationService.use((invitations) => invitations.list(context.get("principal"))),
    );
    return context.json({invites});
  });

  app.post("/api/v1/invites", boundedJsonBody, async (context) => {
    const body = createInviteSchema.parse(await context.req.json());
    const issued = await runHttpApplicationEffect(
      context,
      dependencies,
      InvitationService.use((invitations) => invitations.create({
        ...(body.kind === "person" ? {email: body.email} : {maxUses: body.maxUses}),
        expiresIn: body.expiresIn,
        kind: body.kind,
        opens: body.opens,
        principal: context.get("principal"),
        role: body.role,
      })),
    );
    const origin = dependencies.trustedApplicationOrigin ?? new URL(context.req.url).origin;
    context.header("Cache-Control", "private, no-store");
    return context.json({invite: issued.invite, url: `${origin}/join#${issued.token}`}, 201);
  });

  app.post("/api/v1/invites/:inviteId/revoke", async (context) => {
    const invite = await runHttpApplicationEffect(
      context,
      dependencies,
      InvitationService.use((invitations) =>
        invitations.revoke(context.get("principal"), context.req.param("inviteId"))),
    );
    return context.json({invite});
  });
```

5. Public routes and `/join`, beside `/auth/login`:

```ts
  const inviteRetry = (context: Context<HttpEnvironment>): Response | null => {
    const seconds = inviteLimiter.retryAfterSeconds();
    if (seconds === null) return null;
    context.header("Retry-After", String(seconds));
    context.header("Cache-Control", "private, no-store");
    return context.json({
      error: {code: "RATE_LIMITED", message: "Too many invite attempts. Try again shortly."},
    }, 429);
  };

  app.post("/auth/invites/preview", boundedJsonBody, async (context) => {
    requireApplicationOrigin(context, dependencies);
    const limited = inviteRetry(context);
    if (limited !== null) return limited;
    const body = inviteTokenBodySchema.parse(await context.req.json());
    const preview = await runHttpApplicationEffect(
      context,
      dependencies,
      InvitationService.use((invitations) => invitations.preview(body.token)),
    );
    if (preview.status === "invalid") inviteLimiter.noteFailure();
    context.header("Cache-Control", "private, no-store");
    context.header("Referrer-Policy", "no-referrer");
    return context.json(preview);
  });

  app.post("/auth/invites/start", boundedJsonBody, async (context) => {
    requireApplicationOrigin(context, dependencies);
    const limited = inviteRetry(context);
    if (limited !== null) return limited;
    const body = inviteTokenBodySchema.parse(await context.req.json());
    const plan = await runHttpApplicationEffect(
      context,
      dependencies,
      InvitationService.use((invitations) => invitations.planLogin(body.token, body.forceSignIn)),
    );
    context.header("Cache-Control", "private, no-store");
    context.header("Referrer-Policy", "no-referrer");
    if (plan.kind === "unavailable") {
      if (plan.preview.status === "invalid") inviteLimiter.noteFailure();
      return context.json(plan.preview);
    }
    const started = await runHttpApplicationEffect(
      context,
      dependencies,
      InteractiveLoginService.use((login) =>
        login.start(plan.returnTo, {hints: plan.hints, inviteId: plan.inviteId})),
    );
    setLoginHandshakeCookie(context, dependencies, started.handshake);
    return context.json({authorizationUrl: started.authorizationUrl});
  });

  app.on(["GET", "HEAD"], "/join", (context) => redirectWithRequestQuery(context, "/review/join"));
```

Add `RATE_LIMITED` to `errorCodes` (`rateLimited: "RATE_LIMITED"`) and use the constant.

6. Callback: wrap the `complete` call:

```ts
    let completed;
    try {
      completed = await runHttpApplicationEffect(
        context,
        dependencies,
        InteractiveLoginService.use((login) => login.complete({...query, handshake})),
      );
    } catch (error) {
      if (error instanceof InviteRejected) {
        clearLoginHandshakeCookie(context, dependencies);
        context.header("Cache-Control", "private, no-store");
        context.header("Referrer-Policy", "no-referrer");
        return context.redirect(`/review/join?${new URLSearchParams({outcome: error.outcome})}`, 303);
      }
      throw error;
    }
```

Check how `runHttpApplicationEffect` rethrows failures (read `runApplicationEffect` in `src/application/application-runtime.ts`). If it wraps errors, test `isArtifactServerFailure(error) && error._tag === "InviteRejected"` instead of `instanceof`.

- [ ] **Step 6: Add the startup notice**

```ts
// src/cli/invite-sign-up-notice.ts
import type {BrowserAccess} from "../core/browser-access.js";

/** Remind operators once that invite links need provider-side sign-up. */
export function writeInviteSignUpNotice(browserAccess: BrowserAccess): void {
  if (browserAccess.mode !== "private_team") return;
  process.stderr.write(
    "Invite links need sign-up enabled at the identity provider so new people can create an account.\n",
  );
}
```

In `src/cli/lifecycle-commands.ts`, call `writeInviteSignUpNotice(browserAccess);` right after `browserAccess` is computed in both `start-external-storage` and `startCompactServer`.

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run tests/http tests/conformance && pnpm conformance:tests && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src tests
git commit -m "Serve invite administration, preview and sign-in over HTTP"
```

---

### Task 9: Web client and the join screen

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/shell/gates.tsx` (export `GateFrame`)
- Create: `apps/web/src/review/join/join-model.ts`, `apps/web/src/review/join/join-model.test.ts`
- Create: `apps/web/src/review/join/join-app.tsx`
- Modify: `apps/web/src/review/main.tsx`
- Test: `tests/browser/adm-009-invites.spec.ts` (first two cases)

**Interfaces:**
- Produces in `@/api/client`:
  - `api.previewInvite(token): Promise<InvitePreview>`, `api.startInvite(token, forceSignIn): Promise<{authorizationUrl: string} | InvitePreview>`
  - `api.invites(): Promise<AdministeredInvite[]>`, `api.createInvite(body): Promise<{invite: AdministeredInvite; url: string}>`, `api.revokeInvite(id): Promise<AdministeredInvite>`
  - types `InvitePreview`, `AdministeredInvite`, `CreateInviteBody`
- Produces in `join-model.ts`: `readJoinLocation(location): JoinLocation`, `safeReviewPath(value): string | null`, `joinCopy(outcome)`.

- [ ] **Step 1: Write the failing unit test**

```ts
// apps/web/src/review/join/join-model.test.ts
import {describe, expect, it} from "vitest";

import {joinCopy, readJoinLocation, safeReviewPath} from "@/review/join/join-model";

describe("join model", () => {
  it("reads the token from the fragment and never from the query", () => {
    expect(readJoinLocation({hash: "#as_inv_abc", search: ""})).toEqual({kind: "invite", token: "as_inv_abc"});
    expect(readJoinLocation({hash: "", search: "?token=as_inv_abc"})).toEqual({kind: "missing"});
  });

  it("reads refusal outcomes and the welcome destination", () => {
    expect(readJoinLocation({hash: "", search: "?outcome=wrong_account"}))
      .toEqual({kind: "outcome", outcome: "wrong_account"});
    expect(readJoinLocation({hash: "", search: "?outcome=nonsense"})).toEqual({kind: "missing"});
    expect(readJoinLocation({hash: "", search: "?next=%2Freview%2Fprojects"}))
      .toEqual({kind: "welcome", next: "/review/projects"});
  });

  it("only follows same-origin review paths", () => {
    expect(safeReviewPath("/review?artifact=a&project=p")).toBe("/review?artifact=a&project=p");
    expect(safeReviewPath("//evil.example/review")).toBeNull();
    expect(safeReviewPath("https://evil.example/review")).toBeNull();
    expect(safeReviewPath("/api/v1/session")).toBeNull();
    expect(safeReviewPath("/review\\@evil")).toBeNull();
  });

  it("gives every outcome a title and a next step", () => {
    for (const outcome of ["account_unavailable", "expired", "invalid", "revoked", "unverified", "used", "wrong_account"] as const) {
      const copy = joinCopy(outcome);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body.length).toBeGreaterThan(0);
    }
  });
});
```

Run: `pnpm --filter @artifact-server/web test -- join-model` — Expected: FAIL (module missing).

- [ ] **Step 2: Write `join-model.ts`**

```ts
// apps/web/src/review/join/join-model.ts
export const joinOutcomes = [
  "account_unavailable",
  "expired",
  "invalid",
  "revoked",
  "unverified",
  "used",
  "wrong_account",
] as const;

export type JoinOutcome = (typeof joinOutcomes)[number];

export type JoinLocation =
  | {readonly kind: "invite"; readonly token: string}
  | {readonly kind: "missing"}
  | {readonly kind: "outcome"; readonly outcome: JoinOutcome}
  | {readonly kind: "welcome"; readonly next: string};

const isOutcome = (value: string | null): value is JoinOutcome =>
  value !== null && (joinOutcomes as readonly string[]).includes(value);

/** What `/review/join` shows. The token is only ever read from the fragment. */
export function readJoinLocation(location: {readonly hash: string; readonly search: string}): JoinLocation {
  const token = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  if (token !== "") return {kind: "invite", token};
  const query = new URLSearchParams(location.search);
  const outcome = query.get("outcome");
  if (isOutcome(outcome)) return {kind: "outcome", outcome};
  const next = safeReviewPath(query.get("next"));
  if (next !== null) return {kind: "welcome", next};
  return {kind: "missing"};
}

/** A same-origin `/review` path, or null. */
export function safeReviewPath(value: string | null): string | null {
  if (value === null || !value.startsWith("/review") || value.includes("\\")) return null;
  try {
    const base = new URL("https://artifactserver.invalid");
    const parsed = new URL(value, base);
    if (parsed.origin !== base.origin || !parsed.pathname.startsWith("/review")) return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

export interface JoinCopy {
  readonly body: string;
  readonly pill: string;
  readonly title: string;
  readonly tone: "danger" | "neutral" | "primary" | "secondary";
}

export function joinCopy(outcome: JoinOutcome): JoinCopy {
  switch (outcome) {
    case "wrong_account":
      return {
        body: "Nothing has changed, and the invite is still unused. Open your invite link again and choose Use a Different Account.",
        pill: "Different account",
        title: "This invite is for a different account",
        tone: "danger",
      };
    case "unverified":
      return {
        body: "Finish verifying your email with your sign-in provider, then open the invite link again.",
        pill: "Not verified",
        title: "Your email isn't verified yet",
        tone: "secondary",
      };
    case "expired":
      return {body: "Invite links work for a limited time. Ask the person who invited you for a new link.", pill: "Expired", title: "This invite link has expired", tone: "secondary"};
    case "revoked":
      return {body: "An administrator turned this link off. Ask them for a new link.", pill: "Revoked", title: "This invite link was revoked", tone: "danger"};
    case "used":
      return {body: "It already admitted the people it was made for. Ask the person who invited you for a new link.", pill: "Used", title: "This invite link has been used", tone: "primary"};
    case "account_unavailable":
      return {body: "This account belongs to a deactivated member. Ask an administrator for help.", pill: "Unavailable", title: "This account can't join", tone: "danger"};
    case "invalid":
      return {body: "The link is incomplete or was changed. Ask the person who invited you for the full link.", pill: "Invalid", title: "This invite link doesn't work", tone: "danger"};
  }
}
```

Run the unit test — Expected: PASS.

- [ ] **Step 3: Add the client calls**

In `apps/web/src/api/client.ts`:

```ts
const inviteStatusSchema = z.enum(["active", "expired", "revoked", "used"]);
const inviteKindSchema = z.enum(["link", "person"]);
const invitePreviewSchema = z.union([
  z.object({status: z.literal("invalid")}),
  z.object({
    expiresAt: z.string(),
    inviterName: z.string().nullable(),
    kind: inviteKindSchema,
    maskedEmail: z.string().nullable(),
    opens: z.object({artifactName: z.string(), versionNumber: z.number().int()}).nullable(),
    role: membershipRoleSchema,
    status: inviteStatusSchema,
    usesLeft: z.number().int(),
  }),
]);
const administeredInviteSchema = z.object({
  createdAt: z.string(),
  createdByName: z.string().nullable(),
  email: z.string().nullable(),
  expiresAt: z.string(),
  id: z.string(),
  kind: inviteKindSchema,
  maxUses: z.number().int(),
  opens: z.object({artifactId: z.string(), projectId: z.string(), versionId: z.string()}).nullable(),
  revokedAt: z.string().nullable(),
  role: membershipRoleSchema,
  status: inviteStatusSchema,
  tokenPrefix: z.string(),
  useCount: z.number().int(),
});

export type InvitePreview = z.infer<typeof invitePreviewSchema>;
export type AdministeredInvite = z.infer<typeof administeredInviteSchema>;
export type CreateInviteBody =
  | {readonly email: string; readonly expiresIn: "24h" | "7d" | "30d"; readonly kind: "person"; readonly opens?: {readonly artifactId: string; readonly projectId: string; readonly versionId: string}; readonly role: "administrator" | "member"}
  | {readonly expiresIn: "24h" | "7d" | "30d"; readonly kind: "link"; readonly maxUses: number; readonly opens?: {readonly artifactId: string; readonly projectId: string; readonly versionId: string}};

/** Same-origin public POST: no CSRF header and no session-expiry event. */
async function publicPost<T>(schema: z.ZodType<T>, path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    body: JSON.stringify(body),
    credentials: "same-origin",
    headers: {"Content-Type": "application/json"},
    method: "POST",
  });
  if (!response.ok) throw await parseFailure(response);
  return schema.parse(await response.json());
}
```

`administeredMemberSchema.admittedHow` becomes `z.enum(["manual", "automatic", "owner", "invite"]).nullable()`.

Add to `api`:

```ts
  previewInvite: (token: string) => publicPost(invitePreviewSchema, "/auth/invites/preview", {token}),
  startInvite: (token: string, forceSignIn: boolean) => publicPost(
    z.union([z.object({authorizationUrl: z.string()}), invitePreviewSchema]),
    "/auth/invites/start",
    {forceSignIn, token},
  ),
  invites: () => request(
    z.object({invites: z.array(administeredInviteSchema)}),
    "/api/v1/invites",
  ).then(({invites}) => invites),
  createInvite: (body: CreateInviteBody) => request(
    z.object({invite: administeredInviteSchema, url: z.string()}),
    "/api/v1/invites",
    {body: JSON.stringify(body), headers: mutationHeaders(), method: "POST"},
  ),
  revokeInvite: (inviteId: string) => request(
    z.object({invite: administeredInviteSchema}),
    `/api/v1/invites/${encodeURIComponent(inviteId)}/revoke`,
    {headers: mutationHeaders(), method: "POST"},
  ).then(({invite}) => invite),
```

- [ ] **Step 4: Write the join screen**

Export `GateFrame` from `apps/web/src/shell/gates.tsx` (`export function GateFrame`).

```tsx
// apps/web/src/review/join/join-app.tsx
import {useEffect, useState} from "react";

import {api, ApiError, type InvitePreview} from "@/api/client";
import {Alert, AuthCard, Avatar, Button, Divider, StatusPill, SurfaceState} from "@/arkcase";
import {GateFrame} from "@/shell/gates";
import {usDate} from "@/ui/activity-model";

import {joinCopy, readJoinLocation, type JoinLocation, type JoinOutcome} from "./join-model.ts";

type ActivePreview = Exclude<InvitePreview, {readonly status: "invalid"}>;

const roleLabel = (role: "administrator" | "member") => role === "administrator" ? "Administrator" : "Member";

/** `/review/join`: preview an invite, start sign-in, explain refusals, welcome. */
export function JoinApp() {
  const [location] = useState<JoinLocation>(() => readJoinLocation(window.location));
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (location.kind !== "invite") return;
    void api.previewInvite(location.token).then(setPreview, (caught: unknown) => {
      setFailure(caught instanceof ApiError && caught.status === 429
        ? "Too many invite attempts from this server. Wait a minute and try again."
        : "The invite could not be checked. Try again.");
    });
  }, [location]);

  const start = async (forceSignIn: boolean) => {
    if (location.kind !== "invite") return;
    setPending(true);
    setFailure(null);
    try {
      const started = await api.startInvite(location.token, forceSignIn);
      if ("authorizationUrl" in started) {
        window.location.assign(started.authorizationUrl);
        return;
      }
      setPreview(started);
    } catch {
      setFailure("Sign-in could not start. Try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <GateFrame>
      {location.kind === "welcome" ? <Welcome next={location.next} />
        : location.kind === "outcome" ? <Refusal outcome={location.outcome} />
        : location.kind === "missing" ? <Refusal outcome="invalid" />
        : failure !== null && preview === null ? (
          <AuthCard flush title="Invite unavailable" titleSize="lg" width={440}>
            <Alert variant="danger">{failure}</Alert>
          </AuthCard>
        )
        : preview === null ? <SurfaceState loadingStyle="spinner" loadingTitle="Checking your invite" noun="invite" phase="loading" />
        : preview.status === "invalid" ? <Refusal outcome="invalid" />
        : preview.status !== "active" ? <Refusal outcome={preview.status} />
        : <Invitation failure={failure} onStart={(force) => void start(force)} pending={pending} preview={preview} />}
    </GateFrame>
  );
}

function Invitation({failure, onStart, pending, preview}: {
  readonly failure: string | null;
  readonly onStart: (forceSignIn: boolean) => void;
  readonly pending: boolean;
  readonly preview: ActivePreview;
}) {
  return (
    <AuthCard
      flush
      subtitle="You have been invited to review work on this Artifact Server."
      title="Join this Artifact Server"
      titleSize="lg"
      width={440}
    >
      <div style={{display: "flex", flexDirection: "column", gap: 18}}>
        {preview.inviterName === null ? null : (
          <div style={{alignItems: "center", background: "var(--surface-navy-subtle)", borderRadius: "var(--radius-md)", display: "flex", gap: 12, padding: 12}}>
            <Avatar name={preview.inviterName} size={36} />
            <span style={{fontSize: 14, fontWeight: 600}}>{preview.inviterName} invited you</span>
          </div>
        )}
        <dl style={{alignItems: "center", columnGap: 12, display: "grid", gridTemplateColumns: "108px minmax(0, 1fr)", margin: 0, rowGap: 10}}>
          <dt style={{color: "var(--text-secondary)", fontSize: 12}}>You Join As</dt>
          <dd style={{margin: 0}}><StatusPill label={roleLabel(preview.role)} tone="primary" /></dd>
          {preview.opens === null ? null : (
            <>
              <dt style={{color: "var(--text-secondary)", fontSize: 12}}>Opens</dt>
              <dd style={{margin: 0}}>{preview.opens.artifactName} · v{preview.opens.versionNumber}</dd>
            </>
          )}
          {preview.maskedEmail === null ? (
            <>
              <dt style={{color: "var(--text-secondary)", fontSize: 12}}>Uses</dt>
              <dd style={{fontFamily: "var(--font-data)", margin: 0}}>{preview.usesLeft} left</dd>
            </>
          ) : (
            <>
              <dt style={{color: "var(--text-secondary)", fontSize: 12}}>For</dt>
              <dd style={{fontFamily: "var(--font-data)", margin: 0}}>{preview.maskedEmail}</dd>
            </>
          )}
          <dt style={{color: "var(--text-secondary)", fontSize: 12}}>Expires</dt>
          <dd style={{fontFamily: "var(--font-data)", margin: 0}}>{usDate(Date.parse(preview.expiresAt))}</dd>
        </dl>
        {failure === null ? null : <Alert variant="danger">{failure}</Alert>}
        <Button block icon="bi-shield-lock" loading={pending} onClick={() => onStart(false)} touch variant="primary">
          Continue to Sign In
        </Button>
        <Button block disabled={pending} onClick={() => onStart(true)} variant="link">
          Use a Different Account
        </Button>
        <p style={{color: "var(--text-secondary)", fontSize: 12, lineHeight: 1.5, margin: 0}}>
          Sign in with a passkey, Google, GitHub or an email code. Artifact Server never sees your password.
        </p>
      </div>
    </AuthCard>
  );
}

function Refusal({outcome}: {readonly outcome: JoinOutcome}) {
  const copy = joinCopy(outcome);
  return (
    <AuthCard flush subtitle={copy.body} title={copy.title} titleSize="lg" width={440}>
      <div style={{display: "flex", flexDirection: "column", gap: 18}}>
        <div><StatusPill label={copy.pill} tone={copy.tone} /></div>
        <Divider label="Already a member" />
        <Button block href="/auth/login?returnTo=%2Freview" icon="bi-shield-lock" outline touch variant="secondary">
          Sign In
        </Button>
      </div>
    </AuthCard>
  );
}

function Welcome({next}: {readonly next: string}) {
  return (
    <AuthCard
      flush
      subtitle="You can open every project on this Artifact Server."
      title="Welcome to Artifact Server"
      titleSize="lg"
      width={440}
    >
      <div style={{display: "flex", flexDirection: "column", gap: 12}}>
        <Button block href={next} iconRight="bi-arrow-right" touch variant="primary">
          Continue
        </Button>
        <Button block href="/review/projects" variant="link">Browse Projects</Button>
      </div>
    </AuthCard>
  );
}
```

In `apps/web/src/review/main.tsx`, replace `<ReviewApp />` with `{window.location.pathname === "/review/join" ? <JoinApp /> : <ReviewApp />}` and import `JoinApp` from `./join/join-app.tsx`.

- [ ] **Step 5: Write the first browser cases**

```ts
// tests/browser/adm-009-invites.spec.ts
import {expect, test, type Browser} from "@playwright/test";

import {bootstrapAdministrator, createInvite, signInAs, startInviteServer, type InviteServer} from "../support/invites.js";

async function freshPage(browser: Browser) {
  const context = await browser.newContext({viewport: {height: 1000, width: 1280}});
  return {context, page: await context.newPage()};
}

test.describe("Invites", () => {
  let server: InviteServer;

  test.beforeEach(async () => {
    server = await startInviteServer();
  });

  test.afterEach(async () => {
    await server.stop();
  });

  test("ADM-009-B: an invitee opens a link, signs in and reaches the welcome screen", async ({browser}) => {
    const administrator = await signInAs(server, bootstrapAdministrator);
    const link = await createInvite(server, administrator, {expiresIn: "7d", kind: "link", maxUses: 3});
    const {context, page} = await freshPage(browser);
    try {
      server.provider.identity = {
        displayName: "Sam Rivera",
        email: "sam@acme.test",
        emailVerificationAsserted: true,
        emailVerified: true,
        provider: "workos",
        subject: "sam",
      };
      await page.goto(link.url);
      await expect(page).toHaveURL(/\/review\/join#as_inv_/u);
      await expect(page.getByRole("heading", {name: "Join this Artifact Server"})).toBeVisible();
      await expect(page.getByText("Jordan Lee invited you")).toBeVisible();
      await expect(page.getByText("3 left")).toBeVisible();
      await page.getByRole("button", {name: "Continue to Sign In"}).click();
      await expect(page.getByRole("heading", {name: "Welcome to Artifact Server"})).toBeVisible();
      await page.getByRole("link", {name: "Continue"}).click();
      await expect(page).toHaveURL(/\/review\/projects/u);
    } finally {
      await context.close();
    }
  });

  test("ADM-009-F: refusal outcomes render join pages rather than JSON", async ({browser}) => {
    const administrator = await signInAs(server, bootstrapAdministrator);
    const person = await createInvite(server, administrator, {email: "dana@acme.test", expiresIn: "7d", kind: "person"});
    const {context, page} = await freshPage(browser);
    try {
      server.provider.identity = {
        displayName: "Sam Rivera",
        email: "sam@acme.test",
        emailVerificationAsserted: true,
        emailVerified: true,
        provider: "workos",
        subject: "sam-wrong",
      };
      await page.goto(person.url);
      await page.getByRole("button", {name: "Continue to Sign In"}).click();
      await expect(page.getByRole("heading", {name: "This invite is for a different account"})).toBeVisible();

      await page.goto(`${server.server.baseUrl}/join#as_inv_broken`);
      await expect(page.getByRole("heading", {name: "This invite link doesn't work"})).toBeVisible();

      await page.goto(`${server.server.baseUrl}/review/join?outcome=expired`);
      await expect(page.getByRole("heading", {name: "This invite link has expired"})).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
```

If the browser runner discovers specs by name or list, register `adm-009-invites.spec.ts` the same way `admin-console.spec.ts` is registered (read `scripts/run-browser-evidence.ts` and `playwright.config.ts`).

- [ ] **Step 6: Run the web tests**

Run: `pnpm --filter @artifact-server/web test && pnpm --filter @artifact-server/web typecheck && pnpm build && pnpm exec playwright test tests/browser/adm-009-invites.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web tests/browser
git commit -m "Add the join screen for invite links"
```

---

### Task 10: Settings › Invites and the Members label

**Files:**
- Create: `apps/web/src/review/invites/invite-form.tsx`, `apps/web/src/review/invites/invite-link-ready.tsx`
- Create: `apps/web/src/review/settings/invites-screen.tsx`
- Modify: `apps/web/src/review/settings/admin-areas.ts` (+ `.test.ts`), `apps/web/src/review/settings/settings-view.ts` (+ `.test.ts`), `apps/web/src/review/settings/settings-screen.tsx`, `apps/web/src/review/review-routes.ts` (+ `.test.ts`)
- Test: `tests/browser/adm-009-invites.spec.ts` (settings case)

**Interfaces:**
- Produces:
  - `InviteForm` props `{opens: CreateInviteBody["opens"]; onCreated: (issued: {invite: AdministeredInvite; url: string}) => void; onCancel: () => void}`
  - `InviteLinkReady` props `{invite: AdministeredInvite; url: string; onRevoked: () => void; onDone: () => void; allInvitesHref?: string}`
  - `AdminAreaId` gains `"invites"`; `SettingsRoute` gains `{kind: "invites"}`; `SettingsView` gains `{kind: "invites"}`
  - `admittedLabel` returns `"<name> · Invite"` for `admittedHow: "invite"`

- [ ] **Step 1: Write the failing unit tests**

Add to `apps/web/src/review/settings/admin-areas.test.ts`:

```ts
  it("adds Invites under People and access and labels invite admissions", () => {
    expect(visibleAdminAreas(true).map((area) => area.label)).toEqual([
      "Members", "Invites", "API keys", "Public links", "MCP & WebMCP",
    ]);
    expect(adminAreaById("invites").href).toBe("/review/settings/invites");
    expect(admittedLabel({admittedBy: {name: "Jordan Lee"}, admittedHow: "invite"})).toBe("Jordan Lee · Invite");
  });
```

Update the existing "groups the four areas" expectation to include `["People and access", "Invites"]` second.

Add to `apps/web/src/review/review-routes.test.ts`: `expect(parseSettingsRoute("/review/settings/invites")).toEqual({kind: "invites"});`. Add to `settings-view.test.ts`: invites resolves to `{kind: "invites"}` for an administrator and `{kind: "administratorPermission"}` otherwise.

Run: `pnpm --filter @artifact-server/web test` — Expected: FAIL.

- [ ] **Step 2: Wire the area and the route**

`admin-areas.ts`: `AdminAreaId = "apiKeys" | "invites" | "mcp" | "members" | "publicLinks"`; insert after Members:

```ts
  {
    administratorOnly: true,
    group: "People and access",
    href: "/review/settings/invites",
    icon: "bi-person-plus",
    id: "invites",
    label: "Invites",
    lede: "Links that let someone join by signing in. Each link is shown once.",
  },
```

`admittedLabel` accepts `"invite"` and returns `` `${member.admittedBy?.name ?? "—"} · Invite` `` for it.

`review-routes.ts`: `SettingsRoute` adds `| {readonly kind: "invites"}`; `parseSettingsRoute` adds `case "invites": return {kind: "invites"};`.

`settings-view.ts`: `SettingsView` adds `| {readonly kind: "invites"}`; `resolveSettingsView` adds `case "invites": return access.administrator ? {kind: "invites"} : {kind: "administratorPermission"};`.

`settings-screen.tsx`: `case "invites": return <InvitesScreen />;`.

- [ ] **Step 3: Write the shared form and ready panel**

```tsx
// apps/web/src/review/invites/invite-form.tsx
import {useState} from "react";

import {api, type AdministeredInvite, type CreateInviteBody} from "@/api/client";
import {Alert, Button, ChoiceGroup, Input, Select} from "@/arkcase";

const expiryOptions = [
  {label: "24 hours", value: "24h"},
  {label: "7 days", value: "7d"},
  {label: "30 days", value: "30d"},
];

export interface InviteFormProps {
  readonly onCancel: () => void;
  readonly onCreated: (issued: {readonly invite: AdministeredInvite; readonly url: string}) => void;
  readonly opens: CreateInviteBody["opens"];
}

/** One-person or link invite, role and expiry. The server enforces every rule again. */
export function InviteForm({onCancel, onCreated, opens}: InviteFormProps) {
  const [kind, setKind] = useState<"link" | "person">("person");
  const [email, setEmail] = useState("");
  const [uses, setUses] = useState("10");
  const [role, setRole] = useState<"administrator" | "member">("member");
  const [expiresIn, setExpiresIn] = useState<"24h" | "30d" | "7d">("7d");
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const maxUses = Number.parseInt(uses, 10);
  const valid = kind === "person"
    ? email.trim().includes("@")
    : Number.isInteger(maxUses) && maxUses >= 1 && maxUses <= 100;

  const submit = async () => {
    setPending(true);
    setFailure(null);
    try {
      const destination = opens === undefined ? {} : {opens};
      onCreated(await api.createInvite(kind === "person"
        ? {email: email.trim(), expiresIn, kind, role, ...destination}
        : {expiresIn, kind, maxUses, ...destination}));
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : "The invite could not be created.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div style={{display: "flex", flexDirection: "column", gap: 14}}>
      <p style={{fontSize: 13, lineHeight: 1.5, margin: 0}}>
        Create a link that admits someone to this Artifact Server. They sign in, join with the role you choose, and land on this version.
      </p>
      <ChoiceGroup
        label="Who can use the link"
        onChange={(id) => {
          if (id === "person" || id === "link") setKind(id);
        }}
        options={[
          {description: "Works once, for the email you enter.", icon: "bi-person", id: "person", title: "One person"},
          {description: "Works for a set number of people. Use it for a team you trust.", icon: "bi-people", id: "link", title: "Anyone with the link"},
        ]}
        value={kind}
        variant="row"
      />
      {kind === "person" ? (
        <Input
          helper="The verified email they sign in with must match."
          label="Email"
          onChange={(event) => setEmail(event.currentTarget.value)}
          required
          size="sm"
          type="email"
          value={email}
        />
      ) : (
        <Input
          helper="1 to 100 people. The link stops working after that."
          label="Uses"
          onChange={(event) => setUses(event.currentTarget.value)}
          size="sm"
          type="number"
          value={uses}
        />
      )}
      <div style={{display: "grid", gap: 12, gridTemplateColumns: "repeat(2, minmax(0, 1fr))"}}>
        <Select
          disabled={kind === "link"}
          helper={kind === "link" ? "Links always admit Members." : undefined}
          label="Role"
          onChange={(event) => setRole(event.currentTarget.value === "administrator" ? "administrator" : "member")}
          options={kind === "link"
            ? [{label: "Member", value: "member"}]
            : [{label: "Member", value: "member"}, {label: "Administrator", value: "administrator"}]}
          size="sm"
          value={kind === "link" ? "member" : role}
        />
        <Select
          label="Expires"
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === "24h" || value === "7d" || value === "30d") setExpiresIn(value);
          }}
          options={expiryOptions}
          size="sm"
          value={expiresIn}
        />
      </div>
      <Alert density="compact" live="off" variant="neutral">
        Every member can open every project. An administrator can also manage members, API keys, and public links.
      </Alert>
      {failure === null ? null : <Alert variant="danger">{failure}</Alert>}
      <div style={{display: "flex", gap: 8, justifyContent: "flex-end"}}>
        <Button disabled={pending} onClick={onCancel} outline size="sm" variant="secondary">Cancel</Button>
        <Button disabled={!valid || pending} icon="bi-link-45deg" loading={pending} onClick={() => void submit()} size="sm">
          Create Invite Link
        </Button>
      </div>
    </div>
  );
}
```

If `Select`'s `helper` prop rejects `undefined` under `exactOptionalPropertyTypes`, spread it conditionally.

```tsx
// apps/web/src/review/invites/invite-link-ready.tsx
import {useState} from "react";

import {api, type AdministeredInvite} from "@/api/client";
import {Alert, Button, Input, StatusPill} from "@/arkcase";
import {CopyAction} from "@/ui/copy-action";
import {dateOrDash} from "../settings/admin-areas.ts";

export interface InviteLinkReadyProps {
  readonly allInvitesHref?: string;
  readonly invite: AdministeredInvite;
  readonly onDone: () => void;
  readonly onRevoked: () => void;
  readonly url: string;
}

/** The one moment the invite link exists in the browser. */
export function InviteLinkReady({allInvitesHref, invite, onDone, onRevoked, url}: InviteLinkReadyProps) {
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const revoke = async () => {
    setPending(true);
    try {
      await api.revokeInvite(invite.id);
      onRevoked();
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : "The invite could not be revoked.");
    } finally {
      setPending(false);
    }
  };
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 14}}>
      <Alert density="compact" title="Copy the link now" variant="success">
        Artifact Server keeps only a fingerprint of it, so this link is shown once.
      </Alert>
      <div style={{alignItems: "center", display: "flex", gap: 8}}>
        <Input aria-label="Invite link" icon="bi-link-45deg" mono readOnly size="sm" style={{flex: "1 1 auto", minWidth: 0}} value={url} />
        <CopyAction copiedLabel="Invite link copied" label="Copy invite link" text={url} variant="outline">Copy Link</CopyAction>
      </div>
      <dl style={{alignItems: "center", columnGap: 12, display: "grid", fontSize: 13, gridTemplateColumns: "88px minmax(0, 1fr)", margin: 0, rowGap: 10}}>
        <dt style={{color: "var(--text-secondary)", fontSize: 12}}>For</dt>
        <dd style={{fontFamily: "var(--font-data)", margin: 0}}>{invite.email ?? "Anyone with the link"}</dd>
        <dt style={{color: "var(--text-secondary)", fontSize: 12}}>Joins As</dt>
        <dd style={{margin: 0}}><StatusPill label={invite.role === "administrator" ? "Administrator" : "Member"} tone="primary" /></dd>
        <dt style={{color: "var(--text-secondary)", fontSize: 12}}>Uses</dt>
        <dd style={{fontFamily: "var(--font-data)", margin: 0}}>{invite.useCount} of {invite.maxUses}</dd>
        <dt style={{color: "var(--text-secondary)", fontSize: 12}}>Expires</dt>
        <dd style={{fontFamily: "var(--font-data)", margin: 0}}>{dateOrDash(invite.expiresAt)}</dd>
      </dl>
      <p style={{color: "var(--text-secondary)", fontSize: 12, margin: 0}}>
        Send it through your team's own channel. Artifact Server does not send email.
      </p>
      {failure === null ? null : <Alert variant="danger">{failure}</Alert>}
      <div style={{alignItems: "center", display: "flex", gap: 8}}>
        <Button danger disabled={pending} flush onClick={() => void revoke()} size="sm" variant="link">Revoke Link</Button>
        <span style={{flex: "1 1 auto"}} />
        {allInvitesHref === undefined ? null : <Button href={allInvitesHref} size="sm" variant="link">All Invites</Button>}
        <Button onClick={onDone} size="sm">Done</Button>
      </div>
    </div>
  );
}
```

Read `@/ui/copy-action`'s props before using it; the share popover already uses `CopyAction` with `copiedLabel`, `label`, `text`, `variant` and children.

- [ ] **Step 4: Write the Invites screen**

```tsx
// apps/web/src/review/settings/invites-screen.tsx
import {useEffect, useState} from "react";

import {api, ApiError, type AdministeredInvite} from "@/api/client";
import {Alert, DataGrid, Modal, RecordPanel, StatusPill, SurfaceState, type GridColumn} from "@/arkcase";
import {InviteForm} from "../invites/invite-form.tsx";
import {InviteLinkReady} from "../invites/invite-link-ready.tsx";
import {AddRecordButton, RequestFailure} from "./admin-parts.tsx";
import {AdminConsole} from "./admin-console.tsx";
import {dateOrDash} from "./admin-areas.ts";

interface InviteRow {
  readonly createdBy: string;
  readonly expires: string;
  readonly id: string;
  readonly invite: AdministeredInvite;
  readonly label: string;
  readonly role: string;
  readonly status: AdministeredInvite["status"];
  readonly uses: string;
}

const statusLabels = {active: "Active", expired: "Expired", revoked: "Revoked", used: "Used"} as const;
const statusTones = {active: "success", expired: "neutral", revoked: "danger", used: "primary"} as const;

/** Administrator-only invite links: create, copy once, revoke. */
export function InvitesScreen() {
  const [invites, setInvites] = useState<readonly AdministeredInvite[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<{readonly invite: AdministeredInvite; readonly url: string} | null>(null);
  const [revoking, setRevoking] = useState<AdministeredInvite | null>(null);
  const [pending, setPending] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setInvites(await api.invites());
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "INVITES_UNAVAILABLE") {
        setUnavailable(true);
      } else {
        setError(caught instanceof Error ? caught : new Error("Invite list failed."));
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const revoke = async (invite: AdministeredInvite) => {
    setPending(true);
    setError(null);
    try {
      await api.revokeInvite(invite.id);
      setRevoking(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("The invite could not be revoked."));
    } finally {
      setPending(false);
    }
  };

  const closeCreate = () => {
    setCreating(false);
    setIssued(null);
    void load();
  };

  const rows: InviteRow[] = invites.map((invite) => ({
    createdBy: invite.createdByName ?? "—",
    expires: dateOrDash(invite.expiresAt),
    id: invite.id,
    invite,
    label: invite.email ?? "Anyone with the link",
    role: invite.role === "administrator" ? "Administrator" : "Member",
    status: invite.status,
    uses: `${invite.useCount} of ${invite.maxUses}`,
  }));
  const columns: GridColumn<InviteRow>[] = [
    {field: "label", headerName: "Invite", width: 260},
    {field: "role", headerName: "Role", width: 140},
    {field: "createdBy", headerName: "Created by", width: 180},
    {field: "uses", headerName: "Uses", type: "count", width: 110},
    {field: "expires", headerName: "Expires", type: "date", width: 130},
    {
      cellRenderer: (value: InviteRow["status"]) => <StatusPill label={statusLabels[value]} tone={statusTones[value]} />,
      field: "status",
      headerName: "Status",
      width: 120,
    },
  ];

  return (
    <AdminConsole administrator area="invites" inspector={null}>
      {error === null || revoking !== null ? null : <RequestFailure error={error} onRetry={() => void load()} />}
      {unavailable ? (
        <SurfaceState
          count={0}
          emptyBody="Invite links work when Artifact Server signs people in through WorkOS or OIDC."
          emptyIcon="bi-person-plus"
          emptyTitle="Invites need team sign-in"
          noun="invites"
          phase="ready"
          variant="dashed"
        />
      ) : loading && invites.length === 0 ? (
        <SurfaceState loadingTitle="Loading invites" noun="invites" phase="loading" skeleton={3} />
      ) : (
        <>
          <Alert density="compact" live="off" variant="neutral">
            Invites admit people only through your sign-in provider. Every invite created, redeemed or revoked is recorded in Activity.
          </Alert>
          <RecordPanel
            actions={<AddRecordButton label="Create invite link" onClick={() => setCreating(true)} />}
            capAlign="center"
            label="Invites"
            metaWrap
            subtitle={`${invites.length} invites · ${invites.filter((invite) => invite.status === "active").length} active`}
          >
            <DataGrid
              ariaLabel="Invites"
              columns={columns}
              quickFilter
              rowActions={(row: InviteRow) => row.status === "active"
                ? [{danger: true, icon: "bi-x-circle", label: "Revoke", onClick: () => setRevoking(row.invite)}]
                : null}
              rowActionsLabel={(row: InviteRow) => `Actions for ${row.label}`}
              rows={rows}
              selectable={false}
              statusBar={false}
            />
          </RecordPanel>
        </>
      )}

      <Modal
        fullscreenBelow={768}
        icon="bi-person-plus"
        inertSiblings
        onClose={closeCreate}
        open={creating}
        portal
        title={issued === null ? "Create invite link" : "Invite link ready"}
      >
        {issued === null ? (
          <InviteForm onCancel={closeCreate} onCreated={setIssued} opens={undefined} />
        ) : (
          <InviteLinkReady invite={issued.invite} onDone={closeCreate} onRevoked={closeCreate} url={issued.url} />
        )}
      </Modal>

      <Modal
        icon="bi-x-circle"
        inertSiblings
        onClose={() => setRevoking(null)}
        open={revoking !== null}
        portal
        primaryAction={{
          disabled: pending || revoking === null,
          label: pending ? "Revoking…" : "Revoke link",
          onClick: () => {
            if (revoking !== null) void revoke(revoking);
          },
          variant: "danger",
        }}
        size="sm"
        subtitle="Nobody can join with this link after you revoke it. People who already joined stay members."
        title="Revoke invite link"
      >
        {error === null ? null : <RequestFailure error={error} />}
      </Modal>
    </AdminConsole>
  );
}
```

`AdminConsole`'s `area` prop is typed by `AdminAreaId`, which Step 2 widened. If `Modal` requires `primaryAction`, pass the create form's submit through it instead of the form's own buttons by lifting `submit` into the screen; keep the form's buttons for the Share popover, which has no modal.

- [ ] **Step 5: Add the settings browser case**

Append to `tests/browser/adm-009-invites.spec.ts`:

```ts
  test("ADM-009-B: an administrator creates, copies once and revokes from the Invites area", async ({browser}) => {
    const {context, page} = await freshPage(browser);
    try {
      server.provider.identity = {
        displayName: "Jordan Lee",
        email: "jordan@acme.test",
        emailVerificationAsserted: true,
        emailVerified: true,
        provider: "workos",
        subject: "workos-jordan",
      };
      await page.goto(`${server.server.baseUrl}/auth/login?returnTo=%2Freview%2Fsettings%2Finvites`);
      await expect(page.getByRole("heading", {level: 1, name: "Invites"})).toBeVisible();
      await page.getByRole("button", {name: "Create invite link"}).click();
      const dialog = page.getByRole("dialog", {name: "Create invite link"});
      await dialog.getByLabel("Email").fill("dana@acme.test");
      await dialog.getByRole("button", {name: "Create Invite Link"}).click();
      const link = page.getByRole("textbox", {name: "Invite link"});
      await expect(link).toHaveValue(/\/join#as_inv_/u);
      await page.getByRole("button", {name: "Done"}).click();
      await expect(page.getByRole("textbox", {name: "Invite link"})).toHaveCount(0);
      const grid = page.getByRole("grid", {name: "Invites"});
      await expect(grid.getByText("dana@acme.test")).toBeVisible();
      await grid.getByRole("button", {name: /Actions for/u}).first().click();
      await page.getByRole("menuitem", {name: "Revoke"}).click();
      await page.getByRole("button", {name: "Revoke link"}).click();
      await expect(grid.getByText("Revoked")).toBeVisible();
    } finally {
      await context.close();
    }
  });
```

The `Actions for` row-action label comes from `rowActionsLabel`; set it to `` `Actions for ${row.label}` `` in the screen.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @artifact-server/web test && pnpm --filter @artifact-server/web typecheck && pnpm build && pnpm exec playwright test tests/browser/adm-009-invites.spec.ts tests/browser/admin-console.spec.ts`
Expected: PASS. If `admin-console.spec.ts` asserts the exact list of area links, add "Invites" to its expectation (the area list is the behavior under test there, and it changed on purpose).

- [ ] **Step 7: Commit**

```bash
git add apps/web tests/browser
git commit -m "Add the Invites administration area and invite admission label"
```

---

### Task 11: Invite from Share

**Files:**
- Modify: `apps/web/src/review/workspace/share-popover.tsx`
- Modify: `apps/web/src/review/review-app.tsx` (pass `canInvite`)
- Test: `tests/browser/adm-009-invites.spec.ts` (Share case and member-sees-nothing case)

**Interfaces:**
- Consumes: `InviteForm`, `InviteLinkReady`, `api.members()`.
- Produces: `SharePopoverProps.canInvite: boolean`; `ShareScreen` gains `"invite" | "inviteReady"`.

- [ ] **Step 1: Write the failing browser cases**

Append to `tests/browser/adm-009-invites.spec.ts`:

```ts
  test("ADM-009-B: an administrator creates a link invite from Share for the open version", async ({browser}) => {
    const {context, page} = await freshPage(browser);
    try {
      const published = await publishNew(server.server, server.installation, {
        content: "pricing",
        idempotencyKey: "share-invite",
        name: "Q3 Pricing Review",
      });
      server.provider.identity = {
        displayName: "Jordan Lee",
        email: "jordan@acme.test",
        emailVerificationAsserted: true,
        emailVerified: true,
        provider: "workos",
        subject: "workos-jordan",
      };
      await page.goto(`${server.server.baseUrl}/auth/login?returnTo=${encodeURIComponent(`/review?project=${published.projectId}&artifact=${published.artifactId}`)}`);
      await page.getByRole("button", {name: "Share this version"}).click();
      await page.getByRole("button", {name: "Invite"}).click();
      await page.getByRole("radio", {name: /Anyone with the link/u}).click();
      await page.getByLabel("Uses").fill("5");
      await page.getByRole("button", {name: "Create Invite Link"}).click();
      const url = await page.getByRole("textbox", {name: "Invite link"}).inputValue();
      expect(url).toMatch(/\/join#as_inv_/u);

      const invitee = await freshPage(browser);
      try {
        server.provider.identity = {
          displayName: "Sam Rivera",
          email: "sam@acme.test",
          emailVerificationAsserted: true,
          emailVerified: true,
          provider: "workos",
          subject: "sam",
        };
        await invitee.page.goto(url);
        await expect(invitee.page.getByText("Q3 Pricing Review · v1")).toBeVisible();
        await invitee.page.getByRole("button", {name: "Continue to Sign In"}).click();
        await invitee.page.getByRole("link", {name: "Continue"}).click();
        await expect(invitee.page).toHaveURL(new RegExp(`artifact=${published.artifactId}`, "u"));
      } finally {
        await invitee.context.close();
      }
    } finally {
      await context.close();
    }
  });

  test("ADM-009-F: a member sees no invite controls", async ({browser}) => {
    const administrator = await signInAs(server, bootstrapAdministrator);
    const link = await createInvite(server, administrator, {expiresIn: "7d", kind: "link", maxUses: 2});
    const published = await publishNew(server.server, server.installation, {
      content: "member view",
      idempotencyKey: "member-share",
      name: "Member View",
    });
    const {context, page} = await freshPage(browser);
    try {
      server.provider.identity = {
        displayName: "Sam Rivera",
        email: "sam@acme.test",
        emailVerificationAsserted: true,
        emailVerified: true,
        provider: "workos",
        subject: "sam",
      };
      await page.goto(link.url);
      await page.getByRole("button", {name: "Continue to Sign In"}).click();
      await page.goto(`${server.server.baseUrl}/review?project=${published.projectId}&artifact=${published.artifactId}`);
      await page.getByRole("button", {name: "Share this version"}).click();
      await expect(page.getByRole("button", {name: "Invite"})).toHaveCount(0);
      await page.goto(`${server.server.baseUrl}/review/settings/invites`);
      await expect(page.getByText("Administrator permission required")).toBeVisible();
    } finally {
      await context.close();
    }
  });
```

Import `publishNew` from `../support/publishing.js`. If `publishNew` needs the bootstrap API token, `server.installation.apiToken` is the right credential.

Run: `pnpm exec playwright test tests/browser/adm-009-invites.spec.ts -g "Share|member sees"`
Expected: FAIL — no Invite button.

- [ ] **Step 2: Add the Invite row and screens**

In `share-popover.tsx`:

1. `SharePopoverProps` gains `/** Administrators on a team installation can invite people. */ readonly canInvite: boolean;`.
2. `type ShareScreen = "access" | "agents" | "invite" | "inviteReady" | "overview";`
3. State: `const [memberCount, setMemberCount] = useState<number | null>(null);` and `const [issued, setIssued] = useState<{invite: AdministeredInvite; url: string} | null>(null);`. In `updateOpen(next)` when `next && canInvite`, call `void api.members().then((members) => setMemberCount(members.filter((member) => member.status === "active").length), () => setMemberCount(null));`, and reset `setIssued(null)`.
4. Title/subtitle: `"invite"` → `"Invite People"`, `"inviteReady"` → `"Invite Link Ready"`, subtitle `details?.artifact.name`.
5. In the overview, after the access line `PanelSection` and before the AI-agent band, render when `canInvite`:

```tsx
          {canInvite ? (
            <PanelSection divided gap={8} padding="12px 16px">
              <div style={{alignItems: "center", display: "flex", gap: 12}}>
                <i aria-hidden="true" className="bi bi-people" />
                <span style={{display: "flex", flex: "1 1 auto", flexDirection: "column", gap: 2, minWidth: 0}}>
                  <span style={bandTitleStyle}>{memberCount === null ? "Members" : `${memberCount} members`}</span>
                  <span style={subtleStyle}>Invite someone with a link they redeem by signing in.</span>
                </span>
                <Button icon="bi-person-plus" onClick={() => setScreen("invite")} outline size="sm" variant="primary">
                  Invite
                </Button>
              </div>
            </PanelSection>
          ) : null}
```

If `PanelSection` lacks a `divided`/`padding` combination like this, read its `.d.ts` in `apps/web/src/arkcase` and mirror the access section's usage.

6. New screens in the screen switch:

```tsx
      ) : screen === "invite" ? (
        <InviteForm
          onCancel={() => setScreen("overview")}
          onCreated={(created) => {
            setIssued(created);
            setScreen("inviteReady");
          }}
          opens={details === null || selectedVersion === null ? undefined : {
            artifactId: details.artifact.id,
            projectId: details.artifact.projectId,
            versionId: selectedVersion.version.id,
          }}
        />
      ) : screen === "inviteReady" && issued !== null ? (
        <InviteLinkReady
          allInvitesHref="/review/settings/invites"
          invite={issued.invite}
          onDone={() => updateOpen(false)}
          onRevoked={() => setScreen("overview")}
          url={issued.url}
        />
      ) : screen === "agents" ? (
```

7. In `review-app.tsx`'s `sharePopover`, pass `canInvite={accessContextRef.current?.accessMode === "private_team" && session !== null && settingsAccess(session.principal).administrator}` (import `settingsAccess` from `./settings/settings-view.ts`).

- [ ] **Step 3: Run the tests**

Run: `pnpm --filter @artifact-server/web typecheck && pnpm build && pnpm exec playwright test tests/browser/adm-009-invites.spec.ts tests/browser/frontend-mvp.spec.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web tests/browser
git commit -m "Invite people from the Share popover"
```

---

### Task 12: Documentation, evidence and the full gate

**Files:**
- Modify: `docs/deployment.md` (new section after "Admit colleagues by verified email domain")
- Modify: `deploy/cloudflare/README.md`
- Modify: `project/spec/conformance.yml` (status and evidence for AUTH-030/031/032, ADM-009)

- [ ] **Step 1: Document invites for operators**

Append after the verified-domain section in `docs/deployment.md`:

```markdown
### Admit people with invite links

An administrator can create invite links from Share or Settings › Invites. A
one-person invite works once for a matching verified email and may grant the
Member or Administrator role; a link invite works for up to 100 people and
only admits Members. Links expire after 24 hours, 7 days or 30 days, and the
link is shown once. Artifact Server sends no email.

Invites need an identity provider (WorkOS or OIDC). Keep sign-up enabled at
the provider so a person without an account can create one; Artifact Server
still refuses anyone it has not admitted. With WorkOS AuthKit, the invitee can
choose any method the environment enables, such as a passkey, Google, GitHub
or Magic Auth.
```

Add the same paragraph (second half) to `deploy/cloudflare/README.md` under its identity section, noting that Cloudflare prints no startup notice.

- [ ] **Step 2: Run the full gate**

Run, in order (Docker running):

```bash
pnpm verify:iteration
pnpm smoke
pnpm verify:external-storage-runtime
BROWSER_CRITICAL_ENGINES=all pnpm test:web
```

Expected: each exits 0. Record failures exactly as printed; do not mark anything verified that failed.

- [ ] **Step 3: Attach evidence**

For each of AUTH-030, AUTH-031, AUTH-032 set `status: behavior_verified` only if `project/evidence/local-foundation.json` (or `browser.json` for ADM-009) contains passing results for both `-B` and `-F`, and add:

```yaml
    evidence:
      - deployment: local
        tests: [AUTH-030-B, AUTH-030-F]
        result: pass
        run: project/evidence/local-foundation.json
        recorded_at: "<timestamp printed in the evidence file>"
```

Add `proof_gap: "Local SQLite and Postgres/D1 storage tests prove the behavior; team deployments and the live WorkOS account-switch (maxAge: 0) are not yet recorded."` to each. Use `status: implementing` with that `proof_gap` for any requirement whose evidence is missing.

Run: `pnpm conformance:validate`
Expected: valid.

- [ ] **Step 4: Verify the live WorkOS account switch (manual, after deploy)**

On a staging or production installation with WorkOS: open an invite, choose Use a Different Account, and confirm AuthKit shows the account chooser instead of reusing the session. Record the result in `project/evidence/` as a dated note. If AuthKit reuses the session, change the join screen's helper under the button to "To use a different account, sign out of WorkOS first," and record the gap in AUTH-030's `proof_gap`.

- [ ] **Step 5: Commit**

```bash
git add docs deploy/cloudflare/README.md project/spec/conformance.yml project/evidence
git commit -m "Document invite links and attach evidence"
```
