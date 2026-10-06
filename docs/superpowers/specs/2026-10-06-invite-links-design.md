# Invite links — design

Date: 2026-10-06
Status: approved (written spec reviewed 2026-10-06)
Source: the Share & Invite mockups (claude.ai artifact "Share & Invite Redesign", rows 2 and 3) and the brainstorming conversation of 2026-10-06.

## Intent

Let an installation administrator admit people with a link. The invitee opens the link, signs in through the installation's configured provider (WorkOS AuthKit in production, with passkeys, Google, GitHub and Magic Auth), and is admitted as a member without the administrator typing their details into Members first.

Today admission is closed: an administrator admits an email address, a verified email domain is auto-admitted, or the bootstrap administrator is created. Several specs exclude invitations outright. This design changes that decision on purpose and records it in a new ADR.

### What the user decided

- **Artifact Server owns the invites (approach 1).** It issues, stores, checks and audits its own invite tokens. The identity provider only signs people in. WorkOS-native invitations and a hybrid were rejected so that the product does not depend on WorkOS where it does not have to.
- **Production AuthKit sign-up stays enabled.** An invitee who has no WorkOS user must be able to create one. Unadmitted sign-ups are still refused by Artifact Server, so open provider sign-up admits nobody.
- **Two kinds of invite.** A one-person invite, bound to one email address, usable once. A link invite, usable by anyone with the link up to a cap.
- **Only human administrators create, list and revoke invites.** A link invite only ever admits a Member. A one-person invite may admit a Member or an Administrator.
- **The link is shown once.** Only a SHA-256 digest of the token is stored. A lost link is revoked and replaced.
- **All three identity backends** — SQLite, Postgres and Cloudflare D1 — implement invites in this cycle.
- **Invites ship before the rest of the Share redesign.** The compact link-target control and the folded AI-agent row are a separate follow-up.

### Success criteria

- An administrator creates a one-person or link invite from the Share popover or Settings › Members › Invites, copies the link once, and can revoke it.
- An invitee opens the link, sees who invited them, the role and the destination, signs in through WorkOS with any configured method, and lands on the invited artifact version as a member.
- A wrong account, an unverified email, an expired, revoked or used-up invite, and a tampered token each end on a readable `/join` page. None of them admits anyone or consumes a use.
- Two people racing for the last use of an invite never both get in.
- Every invite creation, revocation and redemption writes exactly one audited activity record; every admission still writes `member_admit`.
- AUTH-030, AUTH-031, AUTH-032 and ADM-009 have passing normal and hostile tests with evidence attached to the ledger, and `pnpm verify:iteration` passes.

### Assumptions

- Projects have no members (PRJ-003). An invite admits a person to the installation; its destination only decides where they land.
- WorkOS reports `emailVerified: true` for every configured method by the time `/auth/callback` runs: Magic Auth and Google are verified by WorkOS, and other methods pass AuthKit's verification step, which is on by default. The WorkOS provider sets both `emailVerified` and `emailVerificationAsserted` from that value.
- The UNIQUE `(installation_id, email)` constraint on `installation_members` stays. A deactivated member cannot be re-admitted by any path, invites included.

## The invite

| Field | One-person invite | Link invite |
|---|---|---|
| `id` | `inv_<uuid>` | same |
| `kind` | `person` | `link` |
| `email` | required, normalized with `normalizeEmail` | absent |
| `role` | `member` or `administrator` | `member` only |
| `maxUses` | always 1 | 1–100, chosen by the administrator |
| `useCount` | 0 or 1 | 0 to `maxUses` |
| `expiresAt` | creation + 24 hours, 7 days or 30 days | same |
| `opens` | optional exact artifact version to land on | same |
| `createdBy`, `createdAt` | the creating administrator | same |
| `revokedAt`, `revokedBy` | set once, never cleared | same |

**Token.** `as_inv_<inviteId>_<secret>`, where `secret` is `randomBase64Url(32)`, parsed with a pattern in the style of `managedApiKeyCredentialPattern`. The server looks the invite up by id and compares `digestIdentitySecret(token)` with the stored digest using `identitySecretsEqual`. The token is returned once, in the creation response, inside the invite URL. A `tokenPrefix` (the leading characters through the id) is stored for display.

**Status** is computed, never stored, in this order: **Revoked** if `revokedAt` is set; **Used** if `useCount = maxUses`; **Expired** if `expiresAt ≤ now`; otherwise **Active**. Revocation is final.

**Rules enforced by the application service:**

- Only a human administrator (`isHumanAdministrator`) may create, list or revoke invites. Members, service principals and API keys are refused.
- Invites exist only in `private_team` access mode. `local_owner` mode refuses every invite operation with `INVITES_UNAVAILABLE`, and the web application hides the controls.
- A one-person invite is refused at creation when its email already belongs to any member, active or inactive.
- A link invite with `role: administrator` is refused. `maxUses` outside 1–100 for a link invite is refused. Expiry is one of the three offered durations.
- `opens`, when given, is a project, artifact and version that exists and belongs together. The server builds the landing path from these ids; clients never supply a path.

**Admission by invite** uses a fourth method, `invite`, beside `manual`, `owner` and `automatic`. The admission is attributed to the administrator who created the invite. Redemption always requires `emailVerified === true` and `emailVerificationAsserted === true`, for both kinds.

## Redemption

### The link

The invite URL is `https://<origin>/join#<token>`. The token is in the fragment, so browsers never send it to the server: it cannot reach access logs, proxies or `Referer` headers. The server serves the application shell at `/join` with `Referrer-Policy: no-referrer`.

### Preview

The `/join` page reads the fragment and calls `POST /auth/invites/preview` with `{"token": "..."}`. For a same-origin request that is not rate-limited, the response is always `200`:

- An unparseable token, an unknown id or a digest mismatch returns `{"status": "invalid"}` and nothing else.
- A known invite returns `{"status": "active" | "used" | "expired" | "revoked", "kind", "role", "inviterName", "maskedEmail" (person only), "expiresAt", "opens": {"artifactName", "versionNumber"} | null}`.

Previewing never consumes a use and writes no activity.

### Starting sign-in

"Continue to sign in" calls `POST /auth/invites/start` with `{"token": "..."}`. When the invite is active, the server starts the existing interactive login with the invite id attached to the login attempt and returns `200 {"authorizationUrl": "..."}`, setting the usual login handshake cookie. The page navigates to `authorizationUrl`. For WorkOS:

- a link invite passes `screenHint: "sign-up"`;
- a one-person invite passes `loginHint: <email>`.

A provider without these hints ignores them. A non-active invite returns its status in the same shape as preview and starts no login.

### Callback

`/auth/callback` is unchanged until `resolveExternalMember`. When the consumed login attempt carries an invite id:

1. **Already a member.** If the identity matches an active member by external identity or by email, the person is signed in as today and redirected to the invite's destination. The invite is not consumed.
2. **Otherwise**, before bootstrap and domain auto-admission are considered, `redeemAndAdmit` runs in one transaction:
   - load the invite and require it to be active;
   - for a one-person invite, require the verified email to equal the invite's email;
   - increment `use_count` with a conditional update (`revoked_at IS NULL AND expires_at > now AND use_count < max_uses`) and require exactly one changed row;
   - admit the member with method `invite`, the invite's role and the inviter's attribution;
   - bind the external identity;
   - write `member_admit` and `invite_redeem`.

   Any failed check or a lost race rolls the whole transaction back.
3. The person is signed in and redirected to the destination, or to `/review/projects` when the invite has none.

### Refusals

An invite-carrying callback that does not admit redirects to `/join?outcome=<outcome>` instead of returning the JSON error body. The outcomes are `wrong_account`, `unverified`, `expired`, `revoked`, `used` and `invalid`. No session is created. The `/join` page renders the matching state from the mockups. Callbacks without an invite behave exactly as today.

"Sign in with another account" restarts the invite login with the provider parameter that forces a fresh sign-in. Which WorkOS parameter does this (`prompt` or `maxAge: 0`) is confirmed during planning against the WorkOS Node SDK. If none does, the page tells the person to sign out of the provider first.

### Rate limiting

Artifact Server trusts no client-address header today, so a per-address limit would need new proxy configuration. Instead, one in-process limiter guards both `/auth/invites/*` endpoints. It counts failed lookups (invalid tokens) in a sliding window and answers `429` with `Retry-After` once the window is full. This is defense in depth: with 256 bits of secret, guessing is not a practical attack, and the limiter mainly bounds load and log noise. Each replica keeps its own window.

## Storage

### `installation_invites`

Identical shape on SQLite, Postgres and D1:

| Column | Constraint |
|---|---|
| `installation_id` | part of the primary key |
| `id` | part of the primary key |
| `kind` | `CHECK (kind IN ('person', 'link'))` |
| `email` | `CHECK ((kind = 'person' AND email IS NOT NULL) OR (kind = 'link' AND email IS NULL))` |
| `role` | `CHECK (role IN ('member', 'administrator'))` and `CHECK (kind = 'person' OR role = 'member')` |
| `max_uses` | `CHECK (max_uses BETWEEN 1 AND 100)` and `CHECK (kind = 'link' OR max_uses = 1)` |
| `use_count` | `CHECK (use_count >= 0 AND use_count <= max_uses)` |
| `secret_digest`, `token_prefix` | not null |
| `opens_project_id`, `opens_artifact_id`, `opens_version_id` | all null or all set |
| `expires_at`, `created_at`, `created_by_principal_id` | not null |
| `revoked_at`, `revoked_by_principal_id` | both null or both set |

The database repeats the application rules so that no code path can store an administrator-granting link invite.

### Changes to existing tables

- `login_attempts` gains a nullable `invite_id`.
- `installation_members.admission_method` accepts `invite`. SQLite and D1 rebuild the table, since their CHECK constraints cannot be altered. Postgres replaces the constraint.
- The actions table accepts the new kinds `invite_create`, `invite_revoke` and `invite_redeem`. Its CHECK constraints are generated from the kind lists in `src/storage/activity-log-schema.ts`, so it is rebuilt on all three backends.

### Migrations

- **SQLite:** `requiredSqliteSchemaVersion` moves from 20 to 21 (shared with the artifact repository).
- **Postgres:** `0021_installation_invites`, with the matching `expectedHistory` entry and `requiredPostgresSchemaVersion` 21.
- **D1:** `requiredD1SchemaVersion` moves from 17 to 18 through `upgradeFromVersion17`.

Each migration upgrades an existing database at the current version without losing members, actions or login attempts.

### Port

A narrow `InvitationRepository` port, named for product behavior and implemented by all three backends:

- `create(invite, activity)` stores the invite and writes `invite_create` in one transaction;
- `list(installationId)` returns invites newest first, at most 200;
- `findById(installationId, id)`;
- `revoke(installationId, id, attribution, now)` succeeds only on an active invite and writes `invite_revoke`;
- `redeemAndAdmit(command)` performs the callback transaction above.

Ended invites stay listed; nothing deletes them in this version.

## Activity

| Kind | Attributed to | Detail |
|---|---|---|
| `invite_create` | the administrator | invite id, kind, role, max uses, expiry |
| `invite_revoke` | the administrator | invite id |
| `invite_redeem` | the new member | invite id, kind |
| `member_admit` (existing) | the inviting administrator | `how: "invite"`, role, invite id |

Expiry is computed and writes no activity. The feed in `src/application/activity-entries.ts` gains verbs for the three new kinds.

## HTTP API

### Administrator routes

Under `/api/v1`, behind the existing session-or-bearer, CSRF and same-origin middleware. Authorization is in the service through `requireAdministrator`. Bodies are validated with zod in the style of `admitMemberSchema`.

- `POST /api/v1/invites` — body `{kind, email?, role?, maxUses?, expiresIn: "24h" | "7d" | "30d", opens?: {projectId, artifactId, versionId}}`. Returns `201 {invite, url}`. `url` is the only place the token ever appears.
- `GET /api/v1/invites` — returns `{invites: [...]}` with computed status, creator name, use count, expiry and token prefix. Never the token or digest.
- `POST /api/v1/invites/:inviteId/revoke` — returns `200 {invite}`.

Failures, as tagged errors mapped in `src/http/artifact-http-failure.ts`:

| Status | Case |
|---|---|
| 403 | caller is not a human administrator |
| 404 | unknown invite or `opens` target |
| 409 | email already belongs to a member; invite is not active (revoke) |
| 409 `INVITES_UNAVAILABLE` | local-owner mode |
| 422 | link invite with `role: administrator`; `maxUses` or `expiresIn` out of range |

### Public routes

Under `/auth`, outside the `/api` gate. Both require a same-origin `Origin` header, accept a bounded JSON body, and pass through the invite rate limiter.

- `POST /auth/invites/preview`
- `POST /auth/invites/start`

## Web application

- **`/join`** renders without a session, ahead of the application's sign-in gate. It shows the four states from the mockups: invitation, wrong account, unavailable (expired, revoked or used) and welcome. It reads the token from the fragment and the outcome from `?outcome=`.
- **Share popover.** Administrators in `private_team` mode see an Invite row (member count and an Invite button) between the access line and the AI-agent band. It opens **Invite People** (one person or anyone with the link; email or number of uses; role; expiry) and then **Invite Link Ready** (copy once, revoke, link to all invites). The invite's destination is the version open in the popover. Members see no invite controls.
- **Settings › Members** gains Members | Invites tabs. The Invites tab lists invites as in the mockup, with Create Invite Link (the same form, in a dialog) and Revoke behind a confirmation. A member admitted by invite shows "Admitted by <name> · Invite".
- **Copy.** Two mockup lines are dropped: "expired invites are recorded in Activity" and "ended invites leave this list after 30 days". "Artifact Server does not send email" stays.

## Spec and ledger changes

- New `project/spec/decisions/0032-invite-link-admission.md`: invite links are a fourth admission path; Artifact Server sends no email; invitees sign in through the configured provider; only a token digest is stored.
- Edit `local-owner-and-private-team-access-spec.md` (lines 70–74 and 386–388), `frontend-mvp-developer-handoff.md:433` and `single-application-administration-spec.md:148` to describe invite links and drop the exclusion. Mark ADR 0025 superseded in part by 0032. `artifact-server-product-spec.html:2035` already mentions invitations and now agrees.
- Reword AUTH-001: admission happens through installation administration, verified-domain auto-admission or an administrator-issued invite; self sign-up stays excluded.
- ADM-003-F is unchanged: no screen claims to send an invitation.

New requirements:

| ID | Behavior (B) | Failure (F) |
|---|---|---|
| AUTH-030 Invite admission | One-person and link invites admit through external login with the invite's role, method `invite`, the inviter's attribution, `member_admit` and `invite_redeem`, then redirect to the destination. | Refuse a wrong email, an unverified or unasserted email, an expired, revoked or used-up invite and a tampered token without admitting or consuming. Admit exactly one of two concurrent redemptions of a last use. An active member consumes nothing. Local-owner mode refuses. Preview never consumes. |
| AUTH-031 Invite issuance | A human administrator creates, lists and revokes invites; the token is returned exactly once and only its digest is stored. | Refuse members, service principals and API keys; a link invite for an administrator; out-of-range uses or expiry; an email that belongs to any member. The database rejects rule-breaking rows written directly. |
| AUTH-032 Public invite endpoints | Preview and start work same-origin, and the token never appears in a request URL the server receives. | Refuse a cross-origin request, an oversized or malformed body, and answer `429` with `Retry-After` after repeated invalid tokens. |
| ADM-009 Invite screens | The Share Invite row and Settings › Members › Invites create, copy once and revoke an invite in a browser; `/join` walks an invitee to the welcome state. | Members see no invite controls; each refusal outcome renders its `/join` page rather than JSON. |

Each lists the same deployments as AUTH-029: `local`, `single_server`, `cloudflare`, `kubernetes`, `aws` and `gcp`.

## Testing

- **Conformance** (`tests/conformance/`): AUTH-030, AUTH-031 and AUTH-032 through real HTTP with `startTestServer`, `TestIdentityProvider` and `privateTeamBrowserAccess(browserLoginKinds.workOs)`. Test names start with their requirement IDs.
- **Storage** (`tests/storage/`, `tests/integration/`): migration from the current schema on SQLite, Postgres and D1; CHECK constraints rejecting invalid rows; the redemption race with two concurrent transactions.
- **Browser** (`tests/browser/`): ADM-009 through the Share popover, Settings › Members › Invites and `/join`.
- **Gates:** `pnpm verify:iteration`, `pnpm smoke`, and `pnpm verify:external-storage-runtime` for the Postgres migration. Any requirement still unproven at handoff is reported as such.

No module mocks: tests use the real application services, temporary SQLite databases, the Postgres harness and real HTTP.

## Rollout

- No new configuration or flag. Invites are available wherever `private_team` mode runs with an external provider.
- Production WorkOS AuthKit keeps sign-up enabled. The operator docs say that invites need provider sign-up open, and the server logs this once at startup in `private_team` mode.
- Deployment follows the usual image digest to Workspace GitOps pin.

## Out of scope

- The rest of the Share redesign (compact link-target control, folded AI-agent row).
- Sending email of any kind.
- Project-level membership or project-scoped invites.
- Reactivating deactivated members.
- Resending, editing or extending an invite.
- Per-client-address rate limiting and trusted-proxy configuration.

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
