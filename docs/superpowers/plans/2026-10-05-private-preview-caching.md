# Private Preview Caching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse one 12-hour preview lease per person and version, confirmed by the application before each reuse, so that private previews load from the browser cache without outliving access.

**Architecture:** `ContentAccessService.issuePreviewLease` accepts an optional reuse token and returns the same lease when it still belongs to the caller and version. Lease-origin responses become fresh until the lease expires. `InstallationAccessService` revokes a principal's browser content access on logout, member deactivation, and API-key revocation, through a narrow port backed by the artifact repository. The web client keeps leases per principal and version, and confirms each one before reuse.

**Tech Stack:** TypeScript, Effect, Hono, Zod, SQLite (`node:sqlite`), Postgres (`effect/unstable/sql`), Cloudflare D1, React, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-05-private-preview-caching-design.md`

## Global Constraints

- Preview lease lifetime: a fixed 12 hours (`12 * 60 * 60 * 1_000` ms) from issuance; reuse never extends it. Content-session cookies keep 15 minutes.
- Client reuse margin: reuse a stored lease only when at least 30 minutes (`30 * 60 * 1_000` ms) remain.
- Successful lease-origin responses (200, 206, 304): `Cache-Control: private, max-age=<whole seconds remaining>, immutable`. Under 1 second remaining: `private, no-store`.
- Every other lease-origin status (401, 404, 405, 416) carries `private, no-store`.
- Reuse returns `200`; a new lease returns `201`. The response body shape `{baseUrl, expiresAt, versionId}` is unchanged.
- A missing, malformed, foreign, cross-version, cross-artifact, expired, or revoked `reuse` yields a fresh lease, never an error.
- No module mocks. Tests use real services, temporary SQLite and Postgres databases, local D1, and real HTTP. Each conformance ID appears in exactly one test title.
- Do not weaken TypeScript, Oxlint, or anti-slop rules.
- Work on `main` in the shared checkout, and stage exact paths only. Never stage `NEXT.md`.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01K5hnfZ71nzDtacBUUqoY2c
  ```

### Planning ruling (recorded for the reviewer)

Preview leases and content-session cookies share the `content_sessions` table, and both record `principal_id`; there is no column that tells them apart. Revocation therefore deletes **all** of a principal's `content_sessions` rows, both preview leases and 15-minute raw-content sessions. That is stricter than the spec's "preview leases only" and needs no migration. Raw-content sessions of a logged-out or deactivated principal ending is the safer behavior. Task 6 updates the spec sentence.

## Review Focus

1. **A `reuse` token that is a content-session cookie, not a lease.** Both live in one table, so a raw-content session token sent as `reuse` must never come back as a lease. Pinned in Task 1 (`reuse` is accepted only with the `review-` prefix under the configured content domain).
2. **A lease confirmed seconds before it expires.** Its responses must not be fresh past expiry. Pinned in Task 2 (a test clock 500 ms before expiry gives `no-store`, and 10 minutes before gives `max-age=600`).
3. **A `416` or `404` on a lease origin inheriting the success headers.** Pinned in Task 2 (an unsatisfiable range and a missing path both give `private, no-store`).
4. **Retrying an administrator action after lease revocation failed.** Deactivating an already-deactivated member, or revoking an already-revoked key, must still revoke content access. Pinned in Task 3 (calling it twice revokes both times and does not error).
5. **`localStorage` unavailable, or holding junk.** Reuse must degrade to a fresh lease, never throw. Pinned in Task 4 (a throwing storage and a corrupt entry).

---

### Task 1: Reusable 12-hour leases in the service and the lease route

**Files:**
- Modify: `src/application/content-access.ts` (lifetime constants near line 42; `IssuedPreviewLease` near line 124; `IssuePreviewLeaseCommand` near line 155; `issuePreviewLease` near line 296)
- Modify: `src/http/create-http-app.ts` (preview-leases route near line 2516)
- Test: `tests/conformance/private-preview-reuse.test.ts` (create)

**Interfaces:**
- Produces: `previewLeaseLifetimeMilliseconds` (exported constant); `IssuePreviewLeaseCommand.reuseToken: Redacted.Redacted | null`; `IssuedPreviewLease.reused: boolean`.
- Produces HTTP: `POST /api/v1/artifacts/:artifactId/versions/:versionId/preview-leases` with an optional body `{"reuse": "<baseUrl>"}` returns `200` for reuse and `201` for issuance.

- [ ] **Step 1: Write the failing tests**

Create `tests/conformance/private-preview-reuse.test.ts`:

```ts
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {Clock} from "../../src/core/ports.js";
import {publishNew, publishVersion} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const leaseSchema = z.object({baseUrl: z.url(), expiresAt: z.string(), versionId: z.string()});
const twelveHours = 12 * 60 * 60 * 1_000;

class MutableTestClock implements Clock {
  #now: Date;
  constructor(start: Date) {
    this.#now = start;
  }
  now(): Date {
    return new Date(this.#now);
  }
  advance(milliseconds: number): void {
    this.#now = new Date(this.#now.getTime() + milliseconds);
  }
}

describe("reusable preview leases", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let clock: MutableTestClock;

  beforeEach(async () => {
    installation = await createTestInstallation();
    clock = new MutableTestClock(new Date("2026-10-05T12:00:00.000Z"));
    server = await startTestServer(installation, {clock});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  const leaseEndpoint = (artifactId: string, versionId: string, projectId: string) =>
    `${server.baseUrl}/api/v1/artifacts/${artifactId}/versions/${versionId}/preview-leases?projectId=${projectId}`;

  async function requestLease(endpoint: string, reuse?: string): Promise<{status: number; lease: z.infer<typeof leaseSchema>}> {
    const response = await fetch(endpoint, {
      ...(reuse === undefined ? {} : {body: JSON.stringify({reuse})}),
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        ...(reuse === undefined ? {} : {"Content-Type": "application/json"}),
      },
      method: "POST",
    });
    return {lease: leaseSchema.parse(await response.json()), status: response.status};
  }

  test("foundation: a lease lasts twelve hours and is returned unchanged on reuse", async () => {
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Reuse one</title>",
      idempotencyKey: "reuse-lifetime",
      name: "Reuse lifetime",
    });
    const endpoint = leaseEndpoint(published.body.artifact.id, published.body.version.id, published.body.artifact.projectId);
    const issued = await requestLease(endpoint);
    expect(issued.status).toBe(201);
    expect(Date.parse(issued.lease.expiresAt) - clock.now().getTime()).toBe(twelveHours);

    clock.advance(60 * 60 * 1_000);
    const reused = await requestLease(endpoint, issued.lease.baseUrl);
    expect(reused.status).toBe(200);
    expect(reused.lease).toEqual(issued.lease);

    const noBody = await requestLease(endpoint);
    expect(noBody.status).toBe(201);
    expect(noBody.lease.baseUrl).not.toBe(issued.lease.baseUrl);
  });

  test("foundation: a foreign, malformed, cross-version, expired, or non-lease reuse yields a fresh lease", async () => {
    const first = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Reuse v1</title>",
      idempotencyKey: "reuse-hostile-v1",
      name: "Reuse hostile",
    });
    const second = await publishVersion(server, installation, {
      artifactId: first.body.artifact.id,
      content: "<!doctype html><title>Reuse v2</title>",
      expectedCurrentVersionId: first.body.version.id,
      idempotencyKey: "reuse-hostile-v2",
    });
    const projectId = first.body.artifact.projectId;
    const firstEndpoint = leaseEndpoint(first.body.artifact.id, first.body.version.id, projectId);
    const secondEndpoint = leaseEndpoint(first.body.artifact.id, second.body.version.id, projectId);
    const original = (await requestLease(firstEndpoint)).lease;

    const crossVersion = await requestLease(secondEndpoint, original.baseUrl);
    expect(crossVersion.status).toBe(201);
    expect(crossVersion.lease.baseUrl).not.toBe(original.baseUrl);

    const foreignHost = new URL(original.baseUrl);
    foreignHost.hostname = foreignHost.hostname.replace(/\.localhost$/u, ".example.test");
    for (const reuse of ["not a url", "", foreignHost.toString(), new URL("/", server.baseUrl).toString()]) {
      const fresh = await requestLease(firstEndpoint, reuse);
      expect(fresh.status).toBe(201);
      expect(fresh.lease.baseUrl).not.toBe(original.baseUrl);
    }

    const contentSession = new URL(original.baseUrl);
    contentSession.hostname = contentSession.hostname.replace(/^review-/u, "");
    expect((await requestLease(firstEndpoint, contentSession.toString())).status).toBe(201);

    clock.advance(twelveHours);
    const expired = await requestLease(firstEndpoint, original.baseUrl);
    expect(expired.status).toBe(201);
    expect(expired.lease.baseUrl).not.toBe(original.baseUrl);
  });
});
```

The cross-principal case is covered in Task 3, where a second principal exists.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/conformance/private-preview-reuse.test.ts`
Expected: FAIL. The lifetime assertion sees 15 minutes, and the reuse request returns `201` with a different `baseUrl`.

- [ ] **Step 3: Implement reuse in the service**

In `src/application/content-access.ts`, keep `contentSessionLifetimeMilliseconds` for content sessions and add the lease constant beside it:

```ts
const contentSessionLifetimeMilliseconds = 15 * 60 * 1_000;
/** A preview lease is reused across opens for a working day; reuse never extends it. */
export const previewLeaseLifetimeMilliseconds = 12 * 60 * 60 * 1_000;
```

Extend the types:

```ts
/** One content-host lease for embedded exact-version Review. */
export interface IssuedPreviewLease {
  readonly expiresAt: string;
  /** True when an earlier lease was confirmed instead of a new one issued. */
  readonly reused: boolean;
  readonly token: Redacted.Redacted;
  readonly versionId: string;
}

/** Input for issuing, or confirming for reuse, one embedded Review lease for an exact saved version. */
export interface IssuePreviewLeaseCommand {
  readonly artifactId: string;
  readonly principal: Principal;
  readonly projectId: string | null;
  /** A lease token the caller holds from an earlier issuance; null asks for a new lease. */
  readonly reuseToken: Redacted.Redacted | null;
  readonly versionId: string;
}
```

Replace the body of `issuePreviewLease` from `const now = …` onward:

```ts
    const now = yield* dependencies.clock.now;
    if (command.reuseToken !== null && isPreviewLeaseToken(Redacted.value(command.reuseToken))) {
      const existing = yield* dependencies.repository.findPreviewLease(
        dependencies.secrets.digest(command.reuseToken),
        DateTime.formatIso(now),
      );
      // Only the caller's own lease for this exact version is confirmed; anything else gets a new lease.
      if (
        existing !== null
        && existing.principalId === command.principal.id
        && existing.projectId === project.id
        && existing.artifactId === artifact.id
        && existing.versionId === target.id
      ) {
        return {expiresAt: existing.expiresAt, reused: true, token: command.reuseToken, versionId: target.id};
      }
    }
    const issued = dependencies.secrets.issue();
    // (keep the existing 56-character comment and token construction unchanged)
    const token = Redacted.make(
      `${previewLeaseTokenPrefix}${issued.digest.slice(0, 56)}`,
      {label: "preview-lease-token"},
    );
    const expiresAt = DateTime.formatIso(
      DateTime.addDuration(now, previewLeaseLifetimeMilliseconds),
    );
    yield* dependencies.repository.createPreviewLease({
      artifactId: artifact.id,
      contentToken: target.contentToken,
      createdAt: DateTime.formatIso(now),
      expiresAt,
      principalId: command.principal.id,
      projectId: project.id,
      tokenDigest: dependencies.secrets.digest(token),
      versionId: target.id,
    });
    return {expiresAt, reused: false, token, versionId: target.id};
```

If `ContentSessionRecord` has no `projectId`, the compiler says so. It does: `findPreviewLease` selects `project_id AS projectId` in every store.

- [ ] **Step 4: Parse `reuse` in the route**

In `src/http/create-http-app.ts`, add a schema beside the route's other request schemas at module scope:

```ts
/** An optional earlier lease the Review client asks the server to confirm for reuse. */
const previewLeaseRequestSchema = z.object({reuse: z.string().max(2_048).optional()});
```

Replace the preview-leases route with:

```ts
  app.post(
    "/api/v1/artifacts/:artifactId/versions/:versionId/preview-leases",
    boundedJsonBody,
    async (context) => {
      const issued = await runHttpApplicationEffect(
        context,
        dependencies,
        ContentAccessService.use((contentAccess) =>
          contentAccess.issuePreviewLease({
            artifactId: context.req.param("artifactId"),
            principal: context.get("principal"),
            projectId: requestedProjectId(context),
            reuseToken: previewLeaseReuseToken(await requestBodyText(context), dependencies.contentDomain),
            versionId: context.req.param("versionId"),
          })
        ),
      );
      return context.json({
        baseUrl: previewLeaseBrowserUrl(
          responseApplicationUrl(context, dependencies),
          dependencies.contentDomain,
          Redacted.value(issued.token),
        ),
        expiresAt: issued.expiresAt,
        versionId: issued.versionId,
      }, issued.reused ? 200 : 201);
    },
  );
```

`ContentAccessService.use` takes a synchronous callback, so read the body before building the effect if the compiler rejects `await` inside it. In that case, declare `const reuseToken = previewLeaseReuseToken(await requestBodyText(context), dependencies.contentDomain);` first, and pass `reuseToken`.

Add these module-scope helpers near `tokenFromContentHost`:

```ts
async function requestBodyText(context: Context<HttpEnvironment>): Promise<string> {
  return context.req.raw.body === null ? "" : context.req.text();
}

/** The lease token in an earlier lease base URL, or null; nothing malformed is an error. */
function previewLeaseReuseToken(body: string, contentDomain: string): Redacted.Redacted | null {
  if (body === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = previewLeaseRequestSchema.safeParse(value);
  const reuse = parsed.success ? parsed.data.reuse : undefined;
  if (reuse === undefined || !URL.canParse(reuse)) return null;
  const token = tokenFromContentHost(new URL(reuse).hostname, contentDomain);
  return token !== null && isPreviewLeaseToken(token)
    ? Redacted.make(token, {label: "preview-lease-token"})
    : null;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/conformance/private-preview-reuse.test.ts tests/conformance/private-content-session.test.ts`
Expected: the two new tests PASS. The existing CMT-018 test still asserts `private, no-store` and keeps passing until Task 2.

- [ ] **Step 6: Lint, typecheck, and commit**

```bash
pnpm exec oxlint --type-aware --type-check --deny-warnings src/application/content-access.ts src/http/create-http-app.ts tests/conformance/private-preview-reuse.test.ts
pnpm typecheck
git add src/application/content-access.ts src/http/create-http-app.ts tests/conformance/private-preview-reuse.test.ts
git commit -m "Reuse a confirmed twelve-hour preview lease per caller and version"
```

---

### Task 2: Lease-origin responses stay fresh until the lease expires

**Files:**
- Modify: `src/application/content-access.ts` (`authorizePreviewContent` near line 385, and the return type in `ContentAccessOperations`)
- Modify: `src/http/create-http-app.ts` (`servePreviewLeaseContent` near line 3777; `serveStoredVersionContent` near line 3809, and its other caller near line 3768)
- Create: `src/http/preview-lease-cache.ts`
- Test: `tests/conformance/private-preview-reuse.test.ts` (extend); `tests/conformance/private-content-session.test.ts:303` (update one assertion)

**Interfaces:**
- Consumes: `previewLeaseLifetimeMilliseconds` from Task 1.
- Produces: `AuthorizedPreviewContent {content: VersionContent; freshSeconds: number}`, returned by `authorizePreviewContent` (or `null` when the path does not exist); `previewLeaseCacheControl(freshSeconds: number): string`.

- [ ] **Step 1: Write the failing tests**

Append to the `describe` in `tests/conformance/private-preview-reuse.test.ts`, and import `fetchVersion` from `../support/runtime-harness.js`:

```ts
  test("foundation: lease-origin responses are fresh only until the lease expires and errors are never stored", async () => {
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><link rel=\"stylesheet\" href=\"site.css\"><title>Fresh</title>",
      idempotencyKey: "reuse-freshness",
      name: "Reuse freshness",
    });
    const endpoint = leaseEndpoint(published.body.artifact.id, published.body.version.id, published.body.artifact.projectId);
    const {lease} = await requestLease(endpoint);
    const expiresAt = Date.parse(lease.expiresAt);

    const full = await fetchVersion(server, lease.baseUrl);
    expect(full.status).toBe(200);
    expect(full.headers.get("cache-control")).toBe(`private, max-age=${twelveHours / 1_000}, immutable`);

    const ranged = await fetchVersion(server, lease.baseUrl, "GET", {Range: "bytes=0-3"});
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("cache-control")).toMatch(/^private, max-age=\d+, immutable$/u);
    const head = await fetchVersion(server, lease.baseUrl, "HEAD");
    expect(head.headers.get("cache-control")).toMatch(/^private, max-age=\d+, immutable$/u);

    const unsatisfiable = await fetchVersion(server, lease.baseUrl, "GET", {Range: "bytes=999999-"});
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("cache-control")).toBe("private, no-store");
    const missing = await fetchVersion(server, new URL("missing.css", lease.baseUrl).toString());
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("private, no-store");
    const write = await fetchVersion(server, lease.baseUrl, "POST");
    expect(write.status).toBe(405);
    expect(write.headers.get("cache-control")).toBe("private, no-store");

    clock.advance(expiresAt - clock.now().getTime() - 10 * 60 * 1_000);
    expect((await fetchVersion(server, lease.baseUrl)).headers.get("cache-control"))
      .toBe("private, max-age=600, immutable");
    clock.advance(10 * 60 * 1_000 - 500);
    expect((await fetchVersion(server, lease.baseUrl)).headers.get("cache-control")).toBe("private, no-store");
    clock.advance(500);
    const expired = await fetchVersion(server, lease.baseUrl);
    expect(expired.status).toBe(401);
    expect(expired.headers.get("cache-control")).toBe("private, no-store");
  });
```

In `tests/conformance/private-content-session.test.ts`, change the CMT-018 assertion near line 303 from `toBe("private, no-store")` to:

```ts
    expect(exact.headers.get("cache-control")).toMatch(/^private, max-age=\d+, immutable$/u);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/conformance/private-preview-reuse.test.ts -t "fresh only"`
Expected: FAIL at the first `cache-control` assertion, which receives `private, no-store`.

- [ ] **Step 3: Return the remaining freshness from the service**

In `src/application/content-access.ts`, add:

```ts
/** One authorized lease-origin read and how long a browser may keep it fresh. */
export interface AuthorizedPreviewContent {
  readonly content: VersionContent;
  /** Whole seconds until the lease expires; responses must not be fresh past it. */
  readonly freshSeconds: number;
}
```

Change the `authorizePreviewContent` signature in `ContentAccessOperations` to return `Effect.Effect<AuthorizedPreviewContent | null, ContentAccessFailure>`, and change the end of the implementation:

```ts
    yield* Effect.annotateCurrentSpan({"artifact.project.id": content.projectId});
    const remainingMilliseconds = Date.parse(lease.expiresAt) - Date.parse(now);
    return {content, freshSeconds: Math.max(0, Math.floor(remainingMilliseconds / 1_000))};
```

(`now` is already the ISO string computed at the top of `authorizePreviewContent`.)

- [ ] **Step 4: Map freshness to headers**

Create `src/http/preview-lease-cache.ts`:

```ts
/** Cache-Control for a successful lease-origin response: fresh only while its lease is. */
export function previewLeaseCacheControl(freshSeconds: number): string {
  return freshSeconds >= 1 ? `private, max-age=${freshSeconds}, immutable` : "private, no-store";
}

/** Lease-origin statuses that may be stored; every other status is never stored. */
export const cacheablePreviewLeaseStatuses: ReadonlySet<number> = new Set([200, 206, 304]);
```

In `src/http/create-http-app.ts`, import both. Change `serveStoredVersionContent`'s fourth parameter from `previewLease: boolean` to `previewLeaseCacheControlValue: string | null`, and its lease block to:

```ts
  if (previewLeaseCacheControlValue !== null) {
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Cache-Control", previewLeaseCacheControlValue);
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    headers.set("Referrer-Policy", "no-referrer");
  }
```

Update the other caller (near line 3768) to pass `null` where it passed `false`. Replace the body of `servePreviewLeaseContent` with:

```ts
  const response = await previewLeaseResponse(context, requestUrl, leaseToken, dependencies);
  // Only successful reads may be stored; an error must never be replayed from cache.
  if (!cacheablePreviewLeaseStatuses.has(response.status)) {
    response.headers.set("Cache-Control", "private, no-store");
  }
  return response;
```

Then move the previous body into a new `previewLeaseResponse` function with the same parameters, changing its ending to:

```ts
  if (authorized === null) return versionNotFoundResponse();
  return serveStoredVersionContent(
    context,
    authorized.content,
    false,
    previewLeaseCacheControl(authorized.freshSeconds),
    dependencies,
  );
```

Rename its `const content = await runHttpApplicationEffect(...)` to `const authorized = …`. A `401` from an expired or revoked lease reaches `app.onError`, which already sets `private, no-store` on `401`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/conformance/private-preview-reuse.test.ts tests/conformance/private-content-session.test.ts tests/http/content-delivery-compression.test.ts`
Expected: PASS. The compression tests prove that CNT-010 variants on lease origins are unchanged.

- [ ] **Step 6: Lint, typecheck, and commit**

```bash
pnpm exec oxlint --type-aware --type-check --deny-warnings src/application/content-access.ts src/http/create-http-app.ts src/http/preview-lease-cache.ts tests/conformance
pnpm typecheck
git add src/application/content-access.ts src/http/create-http-app.ts src/http/preview-lease-cache.ts tests/conformance/private-preview-reuse.test.ts tests/conformance/private-content-session.test.ts
git commit -m "Keep lease-origin responses fresh only until their lease expires"
```

---

### Task 3: Revoke content access on logout, deactivation, and key revocation

**Files:**
- Modify: `src/core/ports.ts` (`ContentSessionRepository` near line 883)
- Modify: `src/storage/sqlite-artifact-repository.ts` (beside `findPreviewLease` near line 2761)
- Modify: `src/storage/postgres-artifact-repository.ts` (beside `findPreviewLease` near line 2607)
- Modify: `deploy/cloudflare/src/d1-artifact-repository.ts` (beside `findPreviewLease` near line 3834)
- Modify: `src/core/errors.ts` (the `ArtifactRepositoryFailure` operation list near line 406)
- Modify: `src/application/installation-access.ts` (dependencies, `deactivateMember` near line 674, `revokeApiKey` near line 762, `revokeSession` near line 820, and operation signatures near lines 269, 311, 318)
- Modify: `src/local/create-local-application-layer.ts` (`InstallationAccessService.layer({...})` near line 951)
- Modify: `src/http/create-http-app.ts` (logout route near line 1090)
- Test: `tests/conformance/private-preview-reuse.test.ts` (extend); `tests/storage/sqlite-content-access-revocation.test.ts` (create); `tests/integration/postgres-content-access-revocation.test.ts` (create); `deploy/cloudflare/tests/d1-content-access-revocation.test.ts` (create)

**Interfaces:**
- Produces: `ContentSessionRepository.revokeContentSessions(principalIds: readonly string[]): Promise<void>`.
- Produces: `ContentAccessRevocation { readonly revokeForPrincipals: (principalIds: readonly string[]) => Effect.Effect<void, ArtifactRepositoryFailure> }`, exported from `src/application/installation-access.ts`, as the required dependency `contentAccessRevocation`.
- Produces: `InstallationAccessOperations.revokeSession(credential: Redacted.Redacted, principalId: string)`.

- [ ] **Step 1: Write the failing HTTP tests**

Append to `tests/conformance/private-preview-reuse.test.ts`. Import `signInAdministrator` and `ApiClient` from `../support/agent-dispatch.js`. Do not hard-code the cookie header names: take them from what `signInAdministrator` returns (`ApplicationCookies` with `header` and `csrf`).

```ts
  async function adminFetch(cookies: {readonly csrf: string; readonly header: string}, pathname: string, method: string, body?: unknown): Promise<Response> {
    return fetch(`${server.baseUrl}${pathname}`, {
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      headers: {
        "Content-Type": "application/json",
        Cookie: cookies.header,
        Origin: server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": cookies.csrf,
      },
      method,
    });
  }

  async function bearerLease(endpoint: string, token: string, reuse?: string): Promise<Response> {
    return fetch(endpoint, {
      ...(reuse === undefined ? {} : {body: JSON.stringify({reuse})}),
      headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
      method: "POST",
    });
  }

  test("foundation: logout, member deactivation, and key revocation end lease access, and a foreign principal's lease is never reused", async () => {
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Revocation</title>",
      idempotencyKey: "reuse-revocation",
      name: "Reuse revocation",
    });
    const endpoint = leaseEndpoint(published.body.artifact.id, published.body.version.id, published.body.artifact.projectId);
    const cookies = await signInAdministrator(server, installation);

    // Logout: the administrator's browser lease stops working.
    const adminLease = leaseSchema.parse(await (await adminFetch(cookies, new URL(endpoint).pathname + new URL(endpoint).search, "POST")).json());
    expect((await fetchVersion(server, adminLease.baseUrl)).status).toBe(200);

    // A different principal (a service key) cannot reuse the administrator's lease.
    const serviceKey = z.object({apiKey: z.object({id: z.string()}), token: z.string()}).parse(await (await adminFetch(cookies, "/api/v1/api-keys", "POST", {
      capabilities: ["artifact:read"], expiresAt: "2099-01-01T00:00:00.000Z", name: "Lease reader",
    })).json());
    const foreign = await bearerLease(endpoint, serviceKey.token, adminLease.baseUrl);
    expect(foreign.status).toBe(201);
    expect(leaseSchema.parse(await foreign.json()).baseUrl).not.toBe(adminLease.baseUrl);

    expect((await adminFetch(cookies, "/api/v1/session/logout", "POST")).status).toBe(204);
    expect((await fetchVersion(server, adminLease.baseUrl)).status).toBe(401);

    // Key revocation: the service key's lease stops working, even when revocation is retried.
    const admin = await signInAdministrator(server, installation);
    const keyLease = leaseSchema.parse(await (await bearerLease(endpoint, serviceKey.token)).json());
    expect((await fetchVersion(server, keyLease.baseUrl)).status).toBe(200);
    expect((await adminFetch(admin, `/api/v1/api-keys/${serviceKey.apiKey.id}/revoke`, "POST")).status).toBe(200);
    expect((await fetchVersion(server, keyLease.baseUrl)).status).toBe(401);
    expect((await adminFetch(admin, `/api/v1/api-keys/${serviceKey.apiKey.id}/revoke`, "POST")).status).toBe(200);

    // Deactivation: a member's key-issued lease stops working, even when deactivation is retried.
    const member = z.object({member: z.object({id: z.string()})}).parse(await (await adminFetch(admin, "/api/v1/members", "POST", {
      displayName: "Lease Member", email: "lease-member@example.test",
    })).json()).member;
    const memberKey = z.object({token: z.string()}).parse(await (await adminFetch(admin, "/api/v1/api-keys", "POST", {
      capabilities: ["artifact:read"], expiresAt: "2099-01-01T00:00:00.000Z", memberId: member.id, name: "Member reader",
    })).json());
    const memberLease = leaseSchema.parse(await (await bearerLease(endpoint, memberKey.token)).json());
    expect((await fetchVersion(server, memberLease.baseUrl)).status).toBe(200);
    expect((await adminFetch(admin, `/api/v1/members/${member.id}/deactivate`, "POST")).status).toBe(200);
    expect((await fetchVersion(server, memberLease.baseUrl)).status).toBe(401);
    expect((await adminFetch(admin, `/api/v1/members/${member.id}/deactivate`, "POST")).status).toBe(200);
    expect((await bearerLease(endpoint, memberKey.token, memberLease.baseUrl)).status).toBe(401);
  });
```

Confirm the request field names against the existing admin API before relying on them: `memberId` on `POST /api/v1/api-keys` (see `IssueApiKeyCommand.memberId` in `src/application/installation-access.ts`), and the `token` field in its response. Adjust the schemas to the real response shape, not the other way round.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/conformance/private-preview-reuse.test.ts -t "logout, member deactivation"`
Expected: FAIL at the first `401` expectation after logout, which receives `200`.

- [ ] **Step 3: Add the repository operation and failing store tests**

In `src/core/ports.ts`, add to `ContentSessionRepository`:

```ts
  /** End every preview lease and content session held by these principals. */
  revokeContentSessions(principalIds: readonly string[]): Promise<void>;
```

In `src/core/errors.ts`, add `"revokeContentSessions"` to the `ArtifactRepositoryFailure` operation list beside `"findPreviewLease"`.

Create `tests/storage/sqlite-content-access-revocation.test.ts`. Model it on `tests/storage/sqlite-library-dates.test.ts`: open a temporary SQLite artifact repository, publish one artifact through the same helper that file uses, and create three preview leases with `createPreviewLease` for principals `p-a`, `p-a`, and `p-b`. Then:

```ts
    await repository.revokeContentSessions(["p-a"]);
    expect(await repository.findPreviewLease("digest-a1", now)).toBeNull();
    expect(await repository.findPreviewLease("digest-a2", now)).toBeNull();
    expect(await repository.findPreviewLease("digest-b", now)).not.toBeNull();
    await repository.revokeContentSessions([]);
    expect(await repository.findPreviewLease("digest-b", now)).not.toBeNull();
```

Write the same assertions in `tests/integration/postgres-content-access-revocation.test.ts`, modeled on `tests/integration/postgres-library-dates.test.ts`. That file's scratch-database setup, `stageUpload`, and `commitPages` are reusable verbatim. Add one more check: a second installation's lease for `p-a` survives the first installation's revocation.

Write them again in `deploy/cloudflare/tests/d1-content-access-revocation.test.ts`, modeled on `deploy/cloudflare/tests/d1-library-dates.test.ts`.

- [ ] **Step 4: Implement the three stores**

SQLite (`src/storage/sqlite-artifact-repository.ts`):

```ts
  revokeContentSessions(principalIds: readonly string[]): Promise<void> {
    return Promise.resolve().then(() => {
      if (principalIds.length === 0) return;
      this.#database.prepare(
        "DELETE FROM content_sessions WHERE principal_id IN (SELECT value FROM json_each(?))",
      ).run(JSON.stringify(principalIds));
    });
  }
```

Postgres (`src/storage/postgres-artifact-repository.ts`):

```ts
  async revokeContentSessions(principalIds: readonly string[]): Promise<void> {
    if (principalIds.length === 0) return;
    const installationId = this.#installationId;
    await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        `DELETE FROM content_sessions
        WHERE installation_id = $1
          AND principal_id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
        [installationId, JSON.stringify(principalIds)],
      );
    }));
  }
```

D1 (`deploy/cloudflare/src/d1-artifact-repository.ts`, in the same object literal as `findPreviewLease`):

```ts
    revokeContentSessions: async (principalIds) => {
      if (principalIds.length === 0) return;
      await database.prepare(
        "DELETE FROM content_sessions WHERE principal_id IN (SELECT value FROM json_each(?))",
      ).bind(JSON.stringify(principalIds)).run();
    },
```

Run: `pnpm vitest run tests/storage/sqlite-content-access-revocation.test.ts` and `pnpm --filter ./deploy/cloudflare exec vitest run tests/d1-content-access-revocation.test.ts`. Use the same command the D1 library-dates test runs under; it is listed in `pnpm check:cloudflare`.
Expected: PASS. The Postgres test runs under `pnpm test:external-storage-runtime` in the gate.

- [ ] **Step 5: Wire revocation into identity**

In `src/application/installation-access.ts`, export the port and add the dependency:

```ts
/** Ends browser content access (preview leases and content sessions) for principals whose access ended. */
export interface ContentAccessRevocation {
  readonly revokeForPrincipals: (
    principalIds: readonly string[],
  ) => Effect.Effect<void, ArtifactRepositoryFailure>;
}
```

Add `readonly contentAccessRevocation: ContentAccessRevocation;` to `InstallationAccessDependencies`, and add `ArtifactRepositoryFailure` to the error unions of `deactivateMember`, `revokeApiKey`, and `revokeSession` in `InstallationAccessOperations`. Change `revokeSession` to take `(credential: Redacted.Redacted, principalId: string)`.

Implementation changes:

```ts
    // in deactivateMember, after the repository call and cache clears:
    // The identity change stands even if this fails; a retry re-runs revocation.
    yield* dependencies.contentAccessRevocation.revokeForPrincipals([memberId]);
    return member;

    // in revokeApiKey, after the repository call and cache clear:
    yield* dependencies.contentAccessRevocation.revokeForPrincipals([revoked.principalId]);
    return revoked;

    // in revokeSession, after evicting the cache entry:
    yield* dependencies.contentAccessRevocation.revokeForPrincipals([principalId]);
```

A member's API keys authenticate as the member's own principal id (`principalId: member?.id ?? \`service:${id}\``), so revoking `[memberId]` also covers leases those keys issued.

In `src/local/create-local-application-layer.ts`, add to `InstallationAccessService.layer({...})`:

```ts
    contentAccessRevocation: {
      revokeForPrincipals: (principalIds) =>
        Effect.tryPromise({
          try: () => adapters.repository.revokeContentSessions(principalIds),
          catch: (cause) => repositoryFailure("revokeContentSessions", cause),
        }),
    },
```

In `src/http/create-http-app.ts`, update the logout route's call:

```ts
          access.revokeSession(
            Redacted.make(sessionToken, {label: "application-session"}),
            context.get("principal").id,
          )
```

Run `pnpm typecheck`. Any other `InstallationAccessService.layer` or `revokeSession` caller it reports, in tests or deploy code, gets the same additions.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run tests/conformance/private-preview-reuse.test.ts tests/storage/sqlite-content-access-revocation.test.ts tests/conformance/installation-identity.test.ts tests/conformance/act-001-activity-log-writes.test.ts`
Expected: PASS.

- [ ] **Step 7: Lint, typecheck, and commit**

```bash
pnpm lint && pnpm typecheck && pnpm check:cloudflare
git add src/core/ports.ts src/core/errors.ts src/storage/sqlite-artifact-repository.ts src/storage/postgres-artifact-repository.ts deploy/cloudflare/src/d1-artifact-repository.ts src/application/installation-access.ts src/local/create-local-application-layer.ts src/http/create-http-app.ts tests/conformance/private-preview-reuse.test.ts tests/storage/sqlite-content-access-revocation.test.ts tests/integration/postgres-content-access-revocation.test.ts deploy/cloudflare/tests/d1-content-access-revocation.test.ts
git commit -m "Revoke a principal's preview leases and content sessions when their access ends"
```

---

### Task 4: The web client keeps and confirms leases

**Files:**
- Create: `apps/web/src/review/preview-lease-store.ts`
- Create: `apps/web/src/review/preview-lease-store.test.ts`
- Modify: `apps/web/src/api/client.ts` (`previewLease` near line 1209; `logout` near line 957)
- Modify: `apps/web/src/review/review-app.tsx` (beside `setDraftPrincipal(...)` near line 207)

**Interfaces:**
- Consumes: the Task 1 HTTP contract (`reuse` body; `200` or `201` with an unchanged shape).
- Produces: `createPreviewLeaseStore(storage: LeaseKeyValueStore, now: () => number): PreviewLeaseStore`; `PreviewLeaseStore { setPrincipal(principalId: string | null): void; forgetPrincipal(): void; reusableBaseUrl(versionId: string): string | null; remember(lease: PreviewLease): void }`; `setPreviewLeasePrincipal(principalId: string | null): void`, exported from `client.ts`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/review/preview-lease-store.test.ts`:

```ts
import {describe, expect, test} from "vitest";

import {createPreviewLeaseStore, type LeaseKeyValueStore} from "@/review/preview-lease-store";

function memoryStorage(): LeaseKeyValueStore & {readonly entries: Map<string, string>} {
  const entries = new Map<string, string>();
  return {
    entries,
    keys: () => [...entries.keys()],
    read: (key) => entries.get(key) ?? null,
    remove: (key) => {
      entries.delete(key);
    },
    write: (key, value) => {
      entries.set(key, value);
    },
  };
}

const hour = 60 * 60 * 1_000;
const lease = (versionId: string, expiresAt: number) => ({
  baseUrl: `https://review-${versionId}.content.test/`,
  expiresAt: new Date(expiresAt).toISOString(),
  versionId,
});

describe("preview lease store", () => {
  test("reuses a stored lease only while at least thirty minutes remain", () => {
    let now = 0;
    const store = createPreviewLeaseStore(memoryStorage(), () => now);
    store.setPrincipal("p-a");
    store.remember(lease("v1", 12 * hour));
    expect(store.reusableBaseUrl("v1")).toBe("https://review-v1.content.test/");
    now = 12 * hour - 31 * 60 * 1_000;
    expect(store.reusableBaseUrl("v1")).toBe("https://review-v1.content.test/");
    now = 12 * hour - 29 * 60 * 1_000;
    expect(store.reusableBaseUrl("v1")).toBeNull();
  });

  test("survives a reload through storage, but never across principals", () => {
    const storage = memoryStorage();
    const first = createPreviewLeaseStore(storage, () => 0);
    first.setPrincipal("p-a");
    first.remember(lease("v1", 12 * hour));
    const reloaded = createPreviewLeaseStore(storage, () => 0);
    reloaded.setPrincipal("p-a");
    expect(reloaded.reusableBaseUrl("v1")).toBe("https://review-v1.content.test/");
    reloaded.setPrincipal("p-b");
    expect(reloaded.reusableBaseUrl("v1")).toBeNull();
    expect([...storage.entries.keys()].some((key) => key.includes("p-a"))).toBe(false);
  });

  test("logout forgets the principal's leases and later remembers nothing", () => {
    const storage = memoryStorage();
    const store = createPreviewLeaseStore(storage, () => 0);
    store.setPrincipal("p-a");
    store.remember(lease("v1", 12 * hour));
    store.forgetPrincipal();
    expect(storage.entries.size).toBe(0);
    store.remember(lease("v2", 12 * hour));
    expect(store.reusableBaseUrl("v2")).toBeNull();
  });

  test("unavailable or corrupt storage degrades to asking for a fresh lease", () => {
    const throwing: LeaseKeyValueStore = {
      keys: () => {
        throw new Error("blocked");
      },
      read: () => {
        throw new Error("blocked");
      },
      remove: () => {
        throw new Error("blocked");
      },
      write: () => {
        throw new Error("blocked");
      },
    };
    const blocked = createPreviewLeaseStore(throwing, () => 0);
    blocked.setPrincipal("p-a");
    blocked.remember(lease("v1", 12 * hour));
    expect(blocked.reusableBaseUrl("v1")).toBe("https://review-v1.content.test/");
    blocked.forgetPrincipal();
    expect(blocked.reusableBaseUrl("v1")).toBeNull();

    const corrupt = memoryStorage();
    corrupt.entries.set("preview-lease:p-a:v1", "{not json");
    const store = createPreviewLeaseStore(corrupt, () => 0);
    store.setPrincipal("p-a");
    expect(store.reusableBaseUrl("v1")).toBeNull();
    expect(corrupt.entries.has("preview-lease:p-a:v1")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review/preview-lease-store.test.ts`
Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Implement the store**

Create `apps/web/src/review/preview-lease-store.ts`:

```ts
import {z} from "zod";

/** Reuse a stored lease only while this much of it remains, so it never expires mid-session. */
export const previewLeaseReuseMarginMilliseconds = 30 * 60 * 1_000;
const keyPrefix = "preview-lease:";

export interface PreviewLease {
  readonly baseUrl: string;
  readonly expiresAt: string;
  readonly versionId: string;
}

/** The storage the store needs; any method may throw when site data is blocked. */
export interface LeaseKeyValueStore {
  readonly keys: () => readonly string[];
  readonly read: (key: string) => string | null;
  readonly remove: (key: string) => void;
  readonly write: (key: string, value: string) => void;
}

export interface PreviewLeaseStore {
  /** Forget every lease of the current principal (logout). */
  readonly forgetPrincipal: () => void;
  readonly remember: (lease: PreviewLease) => void;
  /** The base URL to confirm for reuse, or null to ask for a fresh lease. */
  readonly reusableBaseUrl: (versionId: string) => string | null;
  /** Bind the store to the signed-in principal; any other principal's leases are dropped. */
  readonly setPrincipal: (principalId: string | null) => void;
}

const storedLeaseSchema = z.object({baseUrl: z.url(), expiresAt: z.string(), versionId: z.string()});

/**
 * Preview leases kept per principal and exact version, in memory and mirrored to
 * storage so a reopen in a later tab reuses the same lease origin and its cache.
 * The server confirms every reuse; this store only remembers what to ask for.
 */
export function createPreviewLeaseStore(storage: LeaseKeyValueStore, now: () => number): PreviewLeaseStore {
  const memory = new Map<string, PreviewLease>();
  let principalId: string | null = null;
  const keyFor = (principal: string, versionId: string): string => `${keyPrefix}${principal}:${versionId}`;
  const attempt = <T>(action: () => T, fallback: T): T => {
    try {
      return action();
    } catch {
      return fallback;
    }
  };
  const removeStoredWhere = (doomed: (key: string) => boolean): void => {
    for (const key of attempt(() => storage.keys(), [])) {
      if (key.startsWith(keyPrefix) && doomed(key)) attempt(() => storage.remove(key), undefined);
    }
  };
  const forget = (key: string): null => {
    memory.delete(key);
    attempt(() => storage.remove(key), undefined);
    return null;
  };

  return {
    forgetPrincipal: () => {
      if (principalId !== null) {
        const own = `${keyPrefix}${principalId}:`;
        removeStoredWhere((key) => key.startsWith(own));
      }
      memory.clear();
      principalId = null;
    },
    remember: (lease) => {
      if (principalId === null) return;
      const key = keyFor(principalId, lease.versionId);
      memory.set(key, lease);
      attempt(() => storage.write(key, JSON.stringify(lease)), undefined);
    },
    reusableBaseUrl: (versionId) => {
      if (principalId === null) return null;
      const key = keyFor(principalId, versionId);
      let lease = memory.get(key) ?? null;
      if (lease === null) {
        const raw = attempt(() => storage.read(key), null);
        if (raw === null) return null;
        const parsed = storedLeaseSchema.safeParse(attempt(() => JSON.parse(raw) as unknown, null));
        if (!parsed.success || parsed.data.versionId !== versionId) return forget(key);
        lease = parsed.data;
        memory.set(key, lease);
      }
      const remaining = Date.parse(lease.expiresAt) - now();
      return Number.isFinite(remaining) && remaining >= previewLeaseReuseMarginMilliseconds
        ? lease.baseUrl
        : forget(key);
    },
    setPrincipal: (next) => {
      if (next === principalId) return;
      memory.clear();
      if (next !== null) {
        const own = `${keyPrefix}${next}:`;
        removeStoredWhere((key) => !key.startsWith(own));
      }
      principalId = next;
    },
  };
}
```

If `as unknown` trips the anti-slop type-assertion rule, replace it with a typed helper: `const parseJson = (text: string): unknown => JSON.parse(text);`.

- [ ] **Step 4: Run the store tests to verify they pass**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review/preview-lease-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Use the store in the API client**

In `apps/web/src/api/client.ts`, import `createPreviewLeaseStore` and add at module scope:

```ts
function browserLeaseStorage(): LeaseKeyValueStore {
  return {
    keys: () => {
      const keys: string[] = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key !== null) keys.push(key);
      }
      return keys;
    },
    read: (key) => window.localStorage.getItem(key),
    remove: (key) => window.localStorage.removeItem(key),
    write: (key, value) => window.localStorage.setItem(key, value),
  };
}

const previewLeases = createPreviewLeaseStore(browserLeaseStorage(), Date.now);

/** The signed-in principal whose preview leases may be reused; null forgets them. */
export function setPreviewLeasePrincipal(principalId: string | null): void {
  previewLeases.setPrincipal(principalId);
}
```

The store already contains every throw from `localStorage`. Replace `previewLease` with:

```ts
  previewLease: async (
    projectId: string,
    artifactId: string,
    versionId: string,
  ) => {
    const reuse = previewLeases.reusableBaseUrl(versionId);
    const lease = await request(
      z.object({baseUrl: z.url(), expiresAt: z.string(), versionId: z.string()}),
      `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/preview-leases?${projectQuery(projectId)}`,
      reuse === null
        ? {headers: mutationHeaders(), method: "POST"}
        : {
          body: JSON.stringify({reuse}),
          headers: {...mutationHeaders(), "Content-Type": "application/json"},
          method: "POST",
        },
    );
    if (lease.versionId === versionId) previewLeases.remember(lease);
    return lease;
  },
```

Check what `mutationHeaders()` returns. If it is a `Headers` object rather than a plain record, build the headers with `new Headers(mutationHeaders())` and `.set("Content-Type", "application/json")` instead of spreading.

In `logout`, add `previewLeases.forgetPrincipal();` before `window.dispatchEvent(new Event("artifact-session-logout"));`.

In `apps/web/src/review/review-app.tsx`, import `setPreviewLeasePrincipal` from `@/api/client`, and call it beside the existing `setDraftPrincipal(session?.principal.id ?? null);`:

```ts
    setPreviewLeasePrincipal(session?.principal.id ?? null);
```

- [ ] **Step 6: Run the web tests, lint, typecheck, and commit**

```bash
pnpm --filter @artifact-server/web test
pnpm lint && pnpm typecheck
git add apps/web/src/review/preview-lease-store.ts apps/web/src/review/preview-lease-store.test.ts apps/web/src/api/client.ts apps/web/src/review/review-app.tsx
git commit -m "Keep preview leases per principal and version and confirm them before reuse"
```

---

### Task 5: Prove reuse in the browser across engines (CNT-012)

**Files:**
- Modify: `tests/browser/browser-fixture.ts` (`startBrowserFixture` near line 27)
- Modify: `tests/browser/critical-engines.spec.ts` (add one `@critical` test)

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: `startBrowserFixture(browser, {serverOptions?: Parameters<typeof startTestServer>[1]})`.

- [ ] **Step 1: Let the fixture pass server options**

In `tests/browser/browser-fixture.ts`, change the options type to `{readonly serverOptions?: Parameters<typeof startTestServer>[1]; readonly timezoneId?: string}`. Pass `options.serverOptions` to `startTestServer(installation, options.serverOptions)`, and pass only `timezoneId` (when defined) into `browser.newContext`.

- [ ] **Step 2: Write the failing browser test**

Add to `tests/browser/critical-engines.spec.ts`. The test counts blob streams the server opens, through `BlobReadObserver`, so a cache hit, which opens none, is observable in every engine. Variant builds are manual so that no background build reads a blob.

```ts
  test("CNT-012-B CNT-012-F: a reopen and a page switch reuse one lease origin from cache, and logout ends it @critical", async ({browser}) => {
    let streamsOpened = 0;
    const fixture = await startBrowserFixture(browser, {serverOptions: {
      blobReadObserver: {bytesRead: () => undefined, streamClosed: () => {
        streamsOpened += 1;
      }},
      contentVariantBuilds: "manual",
    }});
    try {
      const published = await publishSite(fixture, "critical-lease-reuse", [
        {path: "index.html", body: "<!doctype html><link rel=\"stylesheet\" href=\"shared.css\"><h1>Lease page one</h1><a href=\"two.html\">two</a>"},
        {path: "two.html", body: "<!doctype html><link rel=\"stylesheet\" href=\"shared.css\"><h1>Lease page two</h1>"},
        {path: "shared.css", body: "h1 { color: rgb(1, 2, 3); }"},
      ]);
      const leaseHosts = new Set<string>();
      const reuseStatuses: number[] = [];
      fixture.page.on("response", (response) => {
        const url = new URL(response.url());
        if (url.hostname.startsWith("review-")) leaseHosts.add(url.hostname);
        if (url.pathname.endsWith("/preview-leases")) reuseStatuses.push(response.status());
      });

      await localLogin(fixture);
      await fixture.page.goto(reviewHref(fixture.server.baseUrl, {artifactId: published.artifactId, versionId: published.versionId}));
      const preview = isolatedReviewFrame(fixture.page).frameLocator("iframe");
      await expect(preview.getByRole("heading", {name: "Lease page one"})).toBeVisible();
      await expect.poll(() => leaseHosts.size).toBe(1);

      const afterFirstOpen = streamsOpened;
      await fixture.page.reload();
      await expect(preview.getByRole("heading", {name: "Lease page one"})).toBeVisible();
      expect(reuseStatuses.at(-1), "the reopen confirmed the stored lease").toBe(200);
      expect(leaseHosts.size, "the reopen used the same lease origin").toBe(1);
      expect(streamsOpened - afterFirstOpen, "the reopen read no file from the server").toBe(0);

      await fixture.page.goto(reviewHref(fixture.server.baseUrl, {artifactId: published.artifactId, path: "two.html", versionId: published.versionId}));
      await expect(preview.getByRole("heading", {name: "Lease page two"})).toBeVisible();
      expect(leaseHosts.size, "the page switch used the same lease origin").toBe(1);

      await logoutThroughApplication(fixture);
      await fixture.page.goto(reviewHref(fixture.server.baseUrl, {artifactId: published.artifactId, versionId: published.versionId}));
      await expect(preview.getByRole("heading", {name: "Lease page one"})).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
```

Define two helpers in the spec file, adapted from existing helpers in this directory.

`publishSite(fixture, idempotencyKey, files)` publishes a multi-file `account_required` site and returns `{artifactId, versionId}`. Model it on the `publishPath` + `writePreviewSourceFixture` usage already imported at the top of `critical-engines.spec.ts`, or on `createStagedUpload`/`commitStagedUpload` in `tests/support/publishing.js`, which accept a `TestSiteFile[]`.

`logoutThroughApplication(fixture)` signs out the way a person does, through the account menu, using the same locator `tests/browser` already uses for sign-out. Search `account-menu` in the browser specs, and fall back to `fixture.page.evaluate(() => fetch("/api/v1/session/logout", …))` only if no UI path exists.

Check `reviewHref`'s accepted keys in `review-helpers.ts`, and use its real name for a page path if it is not `path`.

- [ ] **Step 3: Run the test to verify it fails, then passes**

The test passes only with Tasks 1–4 in place. To confirm it is a real test, first run it against a stash of Task 4's client change: `git stash push apps/web/src/api/client.ts`, then `pnpm build && pnpm exec playwright test tests/browser/critical-engines.spec.ts -g "CNT-012"`. Expected: FAIL on "the reopen used the same lease origin". Then `git stash pop`, rebuild, and rerun.
Expected: PASS.

- [ ] **Step 4: Run the full cross-engine matrix**

Run: `pnpm build && BROWSER_CRITICAL_ENGINES=all pnpm test:web`. If the engines are missing, run `pnpm exec playwright install firefox webkit` once first.
Expected: PASS in Chromium, Firefox, and WebKit. A WebKit or Firefox failure is a real finding: record which assertion failed. Do not loosen the test.

- [ ] **Step 5: Commit**

```bash
git add tests/browser/browser-fixture.ts tests/browser/critical-engines.spec.ts
git commit -m "Prove preview lease reuse and its logout boundary across browser engines"
```

---

### Task 6: Contracts, product prose, and evidence

**Files:**
- Modify: `project/spec/conformance.yml` (CMT-018 near line 3062; add CNT-012 after CNT-011 near line 1430)
- Modify: `project/spec/artifact-server-product-spec.md` (lines 152–155)
- Modify: `project/spec/artifact-comments-spec.md` (lines 393 and 403)
- Modify: `docs/superpowers/specs/2026-10-05-private-preview-caching-design.md` (the revocation sentence, per the planning ruling)

- [ ] **Step 1: Revise CMT-018 and add CNT-012**

In CMT-018's `behavior`, replace "through a short-lived read-only preview lease bound to that exact version" with "through a read-only preview lease of at most 12 hours, bound to that exact version and confirmed by the application before each reuse,". Leave the rest unchanged.

Add after CNT-011:

```yaml
  - id: CNT-012
    kind: security
    behavior: Reopening a private preview within its lease reuses the lease origin and the browser cache, and no reuse outlives the principal's access.
    owner: content-delivery
    source: {file: artifact-comments-spec.md, anchor: private-multi-file-review}
    acceptance:
      behavior: {id: CNT-012-B, description: "A reopen and a page switch within one version confirm and reuse one lease origin and read no already-loaded file from the server; lease-origin success responses are fresh for no longer than the lease's remaining lifetime."}
      failure: {id: CNT-012-F, description: "After logout, member deactivation, or API-key revocation the lease hostname is rejected and the application does not render the cached preview; a foreign, cross-version, expired, or non-lease reuse yields a fresh lease; lease-origin errors are never stored."}
    deployments: *all
    status: specified
    depends_on: [CMT-018, CNT-010]
```

- [ ] **Step 2: Update product and comments prose**

In `project/spec/artifact-server-product-spec.md`, change "issues a short-lived preview lease bound to the exact project, artifact, version, and viewer" to "issues a preview lease of at most 12 hours, bound to the exact project, artifact, version, and viewer and confirmed again before each reuse,". Add after that paragraph: "Reusing one lease keeps the preview on one origin, so the browser can serve its files from cache until the lease expires. Logging out, deactivation, and key revocation end the viewer's leases."

In `project/spec/artifact-comments-spec.md` line 393, change "use a short-lived preview lease" to "use a preview lease of at most 12 hours that Review confirms before each reuse". At line 403, keep the temporary-preview warning, because leases still expire.

- [ ] **Step 3: Record the planning ruling in the design**

In the spec's "Lease revocation" bullet, replace "deletes only `review-`-prefixed preview leases, and leaves content-session cookies alone" with "deletes the principal's preview leases and content sessions, which share one table".

- [ ] **Step 4: Run the gate and attach evidence**

Run: `pnpm verify:iteration`.
Expected: exit 0. It records `project/evidence/local-foundation.json` and `browser.json`. When CNT-012-B and CNT-012-F pass there, set CNT-012 to `status: behavior_verified`. Then add an `evidence` block mirroring CNT-011's, listing `local-foundation.json` and `browser.json`, with the `recorded_at` values from those files. Add a `proof_gap` stating that the hosted measurement is recorded in FINDINGS and that team-deployment conformance runs are unrecorded. Run `pnpm conformance:validate && pnpm conformance:tests`.

- [ ] **Step 5: Commit**

```bash
git add project/spec/conformance.yml project/spec/artifact-server-product-spec.md project/spec/artifact-comments-spec.md docs/superpowers/specs/2026-10-05-private-preview-caching-design.md project/evidence
git commit -m "Specify reusable preview leases and record local CNT-012 evidence"
```

---

## After the tasks (not a task: the deploy flow, run after a whole-branch review)

1. `pnpm build && pnpm perf:delivery --label after-preview-cache` (local). Then run the hosted command with `--label after-preview-cache`, read with the Host DB column. Expected: the warm prototype open makes roughly one `preview-leases` request, plus the app shell, and no repeat lease-origin file reads.
2. Add a FINDINGS section "October 2026 private preview caching (CNT-012)" with both tables and an honest reading.
3. Deploy only with the user's approval: push `main`, then `gh workflow run image.yml`. Take the digest, update the Workspace pins, refresh Argo, and verify 4 of 4 `component=server` pods.
