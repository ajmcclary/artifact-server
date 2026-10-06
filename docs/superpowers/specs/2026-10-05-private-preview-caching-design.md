# Private preview caching — design

Date: 2026-10-05
Status: approved in conversation; awaiting written-spec review
Source: [PLAN.md step 0](../../../PLAN.md) ("Decide private-preview cache semantics" and "Evaluate lease-origin reuse") and the hosted prototype measurements in [FINDINGS](../../../project/performance/FINDINGS.md).

## Intent

Stop private previews from re-downloading everything on every open. Today every preview open, including a switch between pages of the same version, issues a new 15-minute preview lease. Each lease is its own content origin (`review-<56 hex>.<content domain>`), and every successful lease response is `private, no-store`. Browsers cache per origin, so nothing is ever reused: the hosted warm ExtractionKit open still makes about 81 lease requests and transfers 2.8 MiB. On the current host, each request costs far more than its bytes.

### What the user decided

- Speed up both repeat visits: switching pages within a version, and reopening a prototype later.
- The reuse window is a working day: a lease lives a fixed 12 hours.
- Approach 1: reusable leases that the application confirms before each reuse, with browser freshness bounded by the lease's expiry. The alternatives were rejected. A permanent per-person origin with per-file revalidation saves bytes but not round trips, and its hostname would never expire. Reuse without confirmation would keep showing cached previews after logout or access removal.
- Leases are revoked on logout, member deactivation, and API-key revocation. They are not re-checked against the identity store on every content request.

### Success criteria

- A second open of the same version, and a switch to another page of that version, make no lease-origin requests for files already loaded. The only server request is the lease confirmation.
- The hosted warm prototype open (`pnpm perf:delivery`, read with its Host DB column) drops from about 81 lease requests and 2.8 MiB transferred to roughly the confirmation call.
- After logout, member deactivation, or API-key revocation, the application never renders a cached preview, and a direct request to a revoked lease hostname is rejected.
- CMT-018's existing tests and every CNT-010 and CNT-011 behavior still pass, and the critical browser matrix passes in Chromium, Firefox, and WebKit.

### Assumptions

- Access is installation-wide: every active member, and every API key with `readArtifacts` or `manageAnyArtifact`, can read every artifact. Access ends when a member is deactivated, an API key is revoked, or the artifact is deleted.
- Browsers partition their HTTP cache by top-level site. The preview iframe always sits under the application's site, so the same lease origin is reused consistently.
- `content_sessions` already stores `principal_id` for every preview lease, in SQLite, Postgres, and D1.

## Lease lifecycle

- **Lifetime.** A preview lease lasts a fixed 12 hours from issuance. Reuse never extends it. Content-session cookies for version-content hosts keep their current 15-minute lifetime; the two lifetimes become separate constants.
- **Confirmation.** `POST /api/v1/artifacts/:artifactId/versions/:versionId/preview-leases` accepts an optional JSON body `{"reuse": "<baseUrl>"}`, where `baseUrl` is a value this endpoint returned earlier. The server authenticates and authorizes the caller exactly as today. It then extracts the lease token from the URL's first hostname label, accepting it only under the configured content domain with the `review-` prefix. It returns that same lease, with the same `baseUrl` and `expiresAt`, as `200` when all of these hold:
  - the lease exists, is unexpired, and has not been revoked;
  - its `principal_id` is the caller's principal;
  - its project, artifact, and version match the request.

  In every other case, including a missing, malformed, foreign, expired, or revoked `reuse`, it issues a new lease as `201`. A request without a body behaves as today.
- **Response.** Same shape as today: `{baseUrl, expiresAt, versionId}`. The status code distinguishes reuse (`200`) from issuance (`201`).

## Client

- A small lease store in `apps/web` keeps leases in memory and in `localStorage`, keyed by principal id and version id, holding `{baseUrl, expiresAt}`. Every `localStorage` access is wrapped so that a blocked or empty store degrades to issuing a fresh lease.
- Before opening a preview, the client sends its stored `baseUrl` as `reuse` only if at least 30 minutes of the lease remain; otherwise it requests a fresh lease without a body. It stores whatever the server returns.
- The store drops expired entries when read. It is cleared on logout, and whenever the signed-in principal differs from the one that wrote it.
- Both lease callers use the store: the preview canvas (`preview-canvas.tsx`) and activity thumbnails (`activity-thumbnail.tsx`).
- A confirmation that fails authentication follows the application's existing signed-out handling. The client never loads a stored lease origin without a successful confirmation in the same open.
- Accepted risk: a stored `baseUrl` is a bearer secret readable by the application's own JavaScript. The application's session protections already depend on that JavaScript being trustworthy. Revocation (below) bounds what a leaked hostname can do.

## Content delivery on lease origins

- Successful responses on a lease origin carry `Cache-Control: private, max-age=<whole seconds until the lease expires>, immutable`. This applies to full files, stored Brotli variants, `206` range responses, `HEAD`, and the SPA entry fallback. `max-age` is computed per response from the lease's `expiresAt`, so no response is fresh past the lease's expiry. A lease with less than one second remaining gets `private, no-store`.
- `ETag`, `Vary: Accept-Encoding`, CNT-010 and CNT-011 variant negotiation, and range handling are unchanged. A browser keys an identity response and a Brotli response for the same file separately by `Vary`.
- Every error response on a lease origin stays `private, no-store`: `401`, `403`, `404`, and `416`.
- Unchanged:
  - version-content hosts that use content-session cookies;
  - current public-link content, which stays `public, no-cache, must-revalidate` because public eligibility can change;
  - application-origin routes.

## Access enforcement

Two layers:

1. **Application confirmation.** It covers everything the application shows. Every reuse starts with the authenticated confirmation call, so logout, deactivation, API-key revocation, artifact deletion, and a principal switch all stop the application from rendering a cached preview immediately.
2. **Lease revocation.** It covers someone who holds the hostname. A new narrow operation on the content-access repository port, `revokePreviewLeases(principalId)`, deletes every preview lease for that principal. It is implemented for SQLite, Postgres, and D1, deletes only `review-`-prefixed preview leases, and leaves content-session cookies alone.
   - `POST /api/v1/session/logout` revokes the principal's leases after revoking the application session. Leases are not bound to one sign-in session, so the person's other devices fall back to one cold load on their next open.
   - `deactivateMember` and `revokeApiKey` revoke leases after the identity change commits. They revoke every principal whose access the change ends: the member's own principal and the principal of each API key that acts for that member, or the revoked key's principal. If lease revocation fails, the operation reports a failure so it can be retried; the identity change stands. Both operations must stay idempotent so that a retry re-runs revocation.
   - `InstallationAccessService` receives revocation through a narrow port named for the behavior, such as `PreviewLeaseRevocation`. It does not depend on the artifact repository.
   - Artifact deletion already invalidates leases, through the existing join on `artifacts.deleted_at`.

Residual exposure, accepted: bytes already in a browser's cache under a lease hostname stay readable on that browser profile until the lease expires (12 hours at most), to someone who loads that exact hostname directly. The application never shows them without a successful confirmation. This is the same class of exposure as today's `private, max-age=31536000, immutable` caching on `/file`, `/media`, and `/archive`.

## Conformance

- **CMT-018 is revised.** "a short-lived read-only preview lease" becomes "a read-only preview lease of at most 12 hours that the application confirms before each reuse". CMT-018-B and CMT-018-F keep their tests.
- **New requirement CNT-012:** "Reopening a private preview within its lease reuses its origin and the browser cache, without outliving access." It is owned by content-delivery, depends on CMT-018 and CNT-010, and covers all deployments.
  - **CNT-012-B:** a second open of the same version, and a page switch within it, reuse one lease and make no lease-origin requests for files already loaded. Lease responses carry `max-age` no greater than the lease's remaining lifetime.
  - **CNT-012-F:** after logout, member deactivation, or API-key revocation, confirmation fails and the application does not render from cache, and a direct request to the revoked lease hostname is rejected. A `reuse` of another principal's lease, another version's lease, or an expired lease yields a fresh lease, never the old one. Error responses on lease origins stay `no-store`.
- The product spec gains a sentence describing reusable, confirmed preview leases.

## Tests

No module mocks. Tests use real application services, temporary SQLite and Postgres databases, local D1, and real HTTP.

- **Service and HTTP:**
  - reuse returns the same lease as `200`;
  - foreign-principal, cross-version, cross-artifact, expired, malformed, and revoked `reuse` values each get a fresh lease as `201`;
  - a request without a body still works;
  - a test clock proves `max-age` follows the remaining lifetime, including `no-store` at under one second;
  - error responses stay `no-store`;
  - logout, deactivation, and API-key revocation each make the lease hostname return `401`.
- **Stores:** `revokePreviewLeases` in SQLite, Postgres (external-storage runtime), and D1 deletes only that principal's preview leases.
- **Client:**
  - the lease store's 30-minute margin;
  - principal switching;
  - logout clearing;
  - tolerance of unavailable `localStorage`.
- **Browser:** a reopen and a page switch reuse one lease origin and make no repeat lease-origin file requests (CNT-012-B), and after logout the preview does not render (CNT-012-F). Run the critical matrix with `BROWSER_CRITICAL_ENGINES=all`.
- **Gate:** `pnpm verify:iteration`.

## Evidence and rollout

- **No migration.** Revocation deletes rows, and the lease table already records the principal.
- **Rolling deploy.** A new client that reaches an old pod gets a fresh 15-minute `no-store` lease, because the old route ignores the body. That is slower but correct.
- **Rollback.** Rolling back to the previous image stops reuse without any data change. Leases issued with 12-hour expiries remain valid on the old image until they expire, as `no-store` content.
- **Measurement.** Local and hosted `pnpm perf:delivery` before and after, read with the Host DB column. Record a FINDINGS section, and evidence for CMT-018 and CNT-012.
- **Deploy.** After the gate and the local after-run pass, with the user's approval.

## Out of scope

- Version-content hosts that use content-session cookies, and their 15-minute lifetime.
- Caching current public-link content.
- Binding leases to individual sign-in sessions.
- Per-request identity checks on lease-origin requests.
- Shared assets across artifacts (PLAN step 0's deferred shared-asset service).
- Service-worker behavior beyond what CNT-004 and CNT-006 already guarantee per origin.
