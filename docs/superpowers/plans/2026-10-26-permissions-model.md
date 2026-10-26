# Layered Permissions and Guest Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give projects member lists and roles, let a permission be overridden for one person on one project or artifact, put installation-wide ceilings above all of it, and let people without an account review and comment through share links.

**Architecture:** A pure resolver in `src/core/permissions.ts` turns policy, project access, grants and state into an effective permission set. `AuthorizationService` becomes scope-aware: every scoped check names a project or artifact and resolves through an `AccessRepository` port. SQLite, Postgres and D1 each implement that port next to their artifact repository. Guests are a third principal kind. They authenticate only through `/api/v1/share/*` with their own cookie, and never reach a member route.

**Tech Stack:** TypeScript, Effect (`Context.Service`, `Layer`, `Effect.fn`, `Schema.TaggedError`), node:sqlite, `@effect/sql` Postgres, Cloudflare D1, zod in storage and the web client, React web app in `apps/web`, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-26-permissions-model-design.md`. Task 1 appends "Adjustments during planning" to it. Executors must read both documents.

The work ships in two parts, and each ends with a full `pnpm verify:iteration` gate:

- **Part A — Project access** (Tasks 1–14): policy ceilings, project modes, grants, scoped authorization, visibility filtering, key project scope, and the Access interface.
- **Part B — Share links and guest review** (Tasks 15–25): share links, guest principals and sessions, the guest Review app, and guest-safe agent bundles.

## Global Constraints

- Before writing any Effect code, read `node_modules/effect/AGENTS.md` completely, as `AGENTS.md` requires.
- No module mocks. Tests use real services, temporary SQLite files, real Postgres from `ARTIFACT_SERVER_TEST_DATABASE_URL`, local D1 through wrangler `getPlatformProxy`, and real HTTP.
- Test names begin with the requirement ID: `PRM-00N-B: …` for behavior, `PRM-00N-F: …` for the hostile case.
- Do not weaken TypeScript, Oxlint, or anti-slop rules.
- Product logic never imports SQLite, Postgres, D1, HTTP or MCP modules. New storage code lives in `src/storage/` or `deploy/cloudflare/src/`.
- Every write goes in one transaction or batch with its `actions` row (the invite precedent).
- Every new table is keyed `(installation_id, id)`. A caller-supplied ID never selects an installation or a storage location.
- Upgrades must not change anyone's access (spec anti-goal 1). Every existing project becomes `open` with `default_member_role = 'editor'`, and every existing key has `project_ids_json = '[]'`.
- Untrusted human text (guest display names, comment bodies, link labels) is passed through `stripInvisibleControls` before storage or rendering to agents.
- Review pages open in Interactive mode, including the guest app (memory: "Never open Review in Annotate").
- Guest limits: 60 comment writes an hour per link, 20 an hour per guest. Body limit is the existing `maximumCommentBodyCharacters = 8_192`. Display name is 1–60 characters after stripping. Label is 1–80 characters.
- Share-link token is `shr_` + 48 hex characters (192 bits). The link URL is `/s/<token>`.
- Guest session cookie is `__Host-artifact_guest` and the CSRF cookie is `__Host-artifact_guest_csrf`. A session lasts `min(link expiry, 30 days)`.
- Each subject may have at most 500 artifact grants per project.

## Review Focus

1. **An empty visible set is treated as "every project".** The activity, listing and library filters treat `projectIds: []` as unfiltered today. A principal whose visibility is limited and empty must get empty results. Covered by Task 8 (`PRM-002-F empty visibility returns nothing`).
2. **A guest preview lease outlives its target.** After the latest version moves on a `latest` link, or the link is revoked or rotated, a 12-hour preview lease must stop serving on the next request. Covered by Task 20 (`PRM-007-F lease stops after target moves`).
3. **Two managers edit one grant at the same time.** The second write gets `ACCESS_REVISION_CONFLICT` rather than silently overwriting the first. Covered by the Task 4 repository cases (`grant upsert with stale revision conflicts`).
4. **A project is restricted while a member has Review open.** Their next request returns 404, and the workspace shows "You no longer have access to this project" instead of an error boundary. Covered by Task 13 (browser case).
5. **The share token leaks through Referer or history.** The `/s/<token>` response sends `Referrer-Policy: no-referrer`, and the app replaces the URL before loading any third-party-capable content. Covered by Task 21 (`PRM-006-F token not in Referer`).

## Corrections the plan makes to the spec

These are recorded by Task 1 under "Adjustments during planning". Each correction comes from reading the code.

1. **The roles shift one step.** Today's member can publish, edit, delete, change access and dispatch. They cannot moderate other people's comments (`artifact-comments.ts:502`) or rename and archive projects (`requireProjectManagement` is admin or `project:manage` only). So `editor` gains `artifact.delete` and `artifact.share`, `manager` is `editor` plus `comment.moderate` and `project.manage`, and the upgrade default is `editor`, not `manager`.
2. **The last-manager invariant is structural.** Administrators count as managers everywhere, and the installation already refuses to lose its last active administrator. So spec rules 6 and 8 need no code, and PRM-005 becomes "administrators can't receive grants or be blocked".
3. **Legacy public links stay as they are.** Today a public link is the artifact-ID URL `/artifacts/:artifactId`, which redirects to the version's content host, and has no token of its own. `artifacts.access_setting` stays authoritative for that bare link. Share links are separate rows that always open Review. There is no data migration, so the spec's `legacy_public_link` and `review_controls` columns are dropped. "Make private" in the inventory turns the bare link off and revokes share links.
4. **Grant subjects are members only.** Service keys are limited by their project scope plus their existing capability rules, not by grants, so `access_grants.subject_kind` is replaced by `member_id`.
5. **Service and member-bound keys keep their capability rules.** A key passes only if its existing capability rule allows the operation, the project is inside its scope, and, for a member-bound key, the member's effective permissions also allow it. Capabilities are not mapped to permissions.
6. **Guest records are created when the session starts.** The `guest_principals` row is created when the session is exchanged, with `display_name` null until the first comment, because a content session needs a principal ID.
7. **Rotation ends guests by generation.** Each link carries a `generation` counter and each guest stores the generation it joined under. Rotation increments the counter, which ends existing guests without touching their sessions one by one.
8. **Guest bundles carry a marker in the body text.** Bundle items have no author field, and the native bridge renderer is pinned by BRP-002-B. So the server prefixes a guest item's body text with a fixed marker instead of adding a field.
9. **Activity ignores artifact-only grants.** A member who sees only some artifacts in a project through artifact grants sees no activity feed for that project.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/core/permissions.ts` (new) | Permission and role constants, `rolePermissions`, `resolveEffectiveAccess`, `computeVisibleScope` |
| `src/core/access-policy.ts` (new) | `AccessPolicy` schema, defaults, normalization |
| `src/core/access-ports.ts` (new) | `AccessRepository` port and record types |
| `src/core/share-links.ts` (new, Part B) | Share link, guest and guest-session types and validation helpers |
| `src/core/share-link-ports.ts` (new, Part B) | `ShareLinkRepository` port |
| `src/core/untrusted-text.ts` (new, Part B) | `stripInvisibleControls`, moved from `src/mcp/dispatch-bundle-message.ts` |
| `src/application/authorization.ts` | Scope-aware checks over the resolver |
| `src/application/access-administration.ts` (new) | Policy, project access, grants, explain, member grants |
| `src/application/share-links.ts` (new, Part B) | Share-link lifecycle and inventory |
| `src/application/guest-review.ts` (new, Part B) | Guest sessions, target-only reads, guest comments |
| `src/storage/sqlite-access-repository.ts`, `src/storage/postgres-access-repository.ts`, `deploy/cloudflare/src/d1-access-repository.ts` (new) | `AccessRepository` (and `ShareLinkRepository` in Part B) per backend |
| `src/storage/access-rows.ts` (new) | Shared row schemas, column lists, and action builders |
| `src/http/guest-rate-limiter.ts` (new, Part B) | Per-link and per-guest write limits |
| `apps/web/src/review/settings/project-access-panel.tsx`, `permission-override-popover.tsx`, `access-explainer.tsx`, `access-policy-screen.tsx` (new) | Part A interface |
| `apps/web/src/review/guest/*` (new, Part B) | Guest Review app, name dialog, ended page |
| `tests/support/access-repository-cases.ts` (new) | Cross-backend repository cases (the `invitation-repository-cases.ts` pattern) |

---

# Part A — Project access

### Task 1: Decision record, spec adjustments and requirements

**Files:**
- Create: `project/spec/decisions/0033-layered-project-permissions-and-guest-review.md`
- Modify: `docs/superpowers/specs/2026-10-26-permissions-model-design.md` (append "Adjustments during planning" with the nine corrections above; change the role table and migration bullets to match corrections 1 and 3)
- Modify: `project/spec/conformance.yml` (add PRM-001…PRM-010 after the `PRJ-` block, `status: specified`; set SCP-008 `status: superseded`, `superseded_by: [PRM-002, PRM-003]`)
- Modify: `project/spec/artifact-server-product-spec.md` and `project/spec/artifact-server-product-spec.html` ("Access and mutation policy": replace "projects do not add a second access-control list" with a reference to ADR 0033; add the role table)
- Modify: `project/spec/artifact-comments-spec.md` §5 (guests may read and write comments on a share link's target; CMT-006 keeps "never on the content origin")

**Interfaces:**
- Produces: requirement IDs PRM-001…PRM-010 with the texts from the spec's "Proposed conformance requirements" table. PRM-005 is reworded to: "Administrators are always managers, can't receive grants, and can't be blocked; the installation keeps at least one manager on every project."

- [ ] **Step 1: Write ADR 0033.** Use the 0032 layout (Status, Date, Decision, Consequences). The Decision summarizes the five layers, the roles from correction 1, guests as a principal kind, and corrections 3–5.
- [ ] **Step 2: Edit the spec and product-spec files as listed.**
- [ ] **Step 3: Validate the ledger.** Run `pnpm conformance:validate`. Expected: exit 0. If `superseded` is not an accepted status, use the status the validator accepts for retired requirements and note it in the ADR.
- [ ] **Step 4: Commit.**

```bash
git add project/spec docs/superpowers/specs/2026-10-26-permissions-model-design.md
git commit -m "Record layered project permissions decision and requirements"
```

### Task 2: Permission model and resolver

**Files:**
- Create: `src/core/permissions.ts`, `src/core/access-policy.ts`
- Test: `tests/application/permissions-model.test.ts`

**Interfaces:**
- Produces, from `src/core/permissions.ts`:
  - `permissions` (const object): `artifactView: "artifact.view"`, `artifactHistory: "artifact.history"`, `commentRead: "comment.read"`, `commentWrite: "comment.write"`, `commentModerate: "comment.moderate"`, `artifactPublish: "artifact.publish"`, `artifactEdit: "artifact.edit"`, `artifactDelete: "artifact.delete"`, `artifactShare: "artifact.share"`, `agentDispatch: "agent.dispatch"`, `projectManage: "project.manage"`
  - `type Permission`, and `allPermissions: readonly Permission[]` in that order
  - `projectRoles` (`none`, `viewer`, `commenter`, `editor`, `manager`), `type ProjectRole`, `projectAccessModes` (`open`, `restricted`), `type ProjectAccessMode`
  - `rolePermissions(role: ProjectRole): ReadonlySet<Permission>`
  - `guestHoldablePermissions: ReadonlySet<Permission>`, which is view, comment.read and comment.write
  - `writePermissions: ReadonlySet<Permission>`, which is every permission except view, history and comment.read
  - `interface AccessGrant { readonly id: string; readonly projectId: string; readonly artifactId: string | null; readonly memberId: string; readonly role: ProjectRole; readonly add: readonly Permission[]; readonly remove: readonly Permission[]; readonly expiresAt: string | null; readonly revision: number; readonly createdAt: string; readonly createdByPrincipalId: string; readonly updatedAt: string }`
  - `interface ProjectAccess { readonly projectId: string; readonly accessMode: ProjectAccessMode; readonly defaultMemberRole: ProjectRole; readonly archived: boolean; readonly revision: number }`
  - `type AccessSubject = {readonly kind: "administrator"} | {readonly kind: "member"; readonly memberId: string} | {readonly kind: "guest"; readonly linkPermissions: readonly Permission[]}`
  - `type AccessSource`, a union on `layer` with these variants:
    - `"administrator"`
    - `"project_default"` with `role`
    - `"project_grant"` with `grantId`, `role`, `added`, `removed`
    - `"artifact_grant"` with the same fields
    - `"share_link"` with `shareLinkId`
    - `"policy"` with `removed`
    - `"state"` with `removed` and `reason: "archived" | "deleted" | "expired_grant"`
  - `interface EffectiveAccess { readonly permissions: ReadonlySet<Permission>; readonly sources: readonly AccessSource[] }`
  - `resolveEffectiveAccess(input: {subject: AccessSubject; project: ProjectAccess; projectGrant: AccessGrant | null; artifactGrants: readonly AccessGrant[]; artifactDeleted: boolean; policy: AccessPolicy; now: string; shareLinkId?: string}): EffectiveAccess`
  - `type VisibleScope = {readonly kind: "all"} | {readonly kind: "limited"; readonly projectIds: readonly string[]; readonly artifactIdsByProject: ReadonlyMap<string, readonly string[]>}`
  - `computeVisibleScope(input: {subject: AccessSubject; projects: readonly ProjectAccess[]; grants: readonly AccessGrant[]; policy: AccessPolicy; now: string}): VisibleScope`
- Produces, from `src/core/access-policy.ts`:
  - `interface AccessPolicy { readonly shareLinks: {enabled: boolean; guestPermissionsMax: readonly Permission[]; maxExpiryDays: number | null; linkCreators: "sharers" | "administrators"}; readonly projects: {defaultMode: ProjectAccessMode}; readonly members: {memberCeiling: readonly Permission[] | null} }`
  - `defaultAccessPolicy: AccessPolicy`, with the values from the spec's policy document and `linkCreators: "sharers"`
  - `accessPolicySchema` (Effect `Schema`, rejecting unknown keys and unknown permissions)
  - `interface StoredAccessPolicy { readonly policy: AccessPolicy; readonly revision: number; readonly updatedAt: string | null; readonly updatedByPrincipalId: string | null }`

- [ ] **Step 1: Write the failing tests.**

```ts
test("PRM-003-B: role ladder matches today's member at editor", () => {
  expect([...rolePermissions("editor")].sort()).toEqual([
    "agent.dispatch", "artifact.delete", "artifact.edit", "artifact.history",
    "artifact.publish", "artifact.share", "artifact.view", "comment.read", "comment.write",
  ]);
  expect(rolePermissions("manager").has("project.manage")).toBe(true);
  expect(rolePermissions("manager").has("comment.moderate")).toBe(true);
  expect(rolePermissions("none").size).toBe(0);
});
test("PRM-003-B: project grant replaces the open-project default", () => {
  const access = resolveEffectiveAccess({...base, projectGrant: grant({role: "viewer"})});
  expect(access.permissions.has("artifact.publish")).toBe(false);
  expect(access.sources[0]).toMatchObject({layer: "project_grant", role: "viewer"});
});
test("PRM-003-B: a none grant blocks a member on an open project", () => { /* permissions.size === 0 */ });
test("PRM-003-B: artifact grant adds on a restricted project", () => { /* restricted, no project grant, artifact grant commenter → comment.write */ });
test("PRM-003-F: an override applies only to its own grant", () => {
  // project grant editor remove artifact.delete; artifact grant viewer add artifact.delete
  // → delete allowed; with no artifact grant → delete denied
});
test("PRM-003-F: no grant beats the member ceiling or the archived state", () => {
  // memberCeiling excludes artifact.delete → absent even with manager grant; source {layer:"policy", removed:["artifact.delete"]}
  // archived → every writePermissions member absent; source {layer:"state", reason:"archived"}
});
test("PRM-005-B: administrators resolve to manager and ignore grants", () => { /* subject administrator + none grant → manager set */ });
test("PRM-003-F: expired grants are ignored and reported", () => { /* expiresAt < now → falls back to default; source reason expired_grant */ });
test("PRM-002-B: computeVisibleScope", () => {
  // member: open project A (default editor), restricted B with no grant, restricted C with artifact grant on art_1
  // → {kind:"limited", projectIds:["A"], artifactIdsByProject: Map{C:["art_1"]}}
  // administrator → {kind:"all"}
});
test("accessPolicySchema rejects unknown permissions and keys", () => { /* decodeUnknownEither fails */ });
```

- [ ] **Step 2: Run the tests.** Run `pnpm vitest run tests/application/permissions-model.test.ts`. Expected: FAIL, because the modules don't exist yet.
- [ ] **Step 3: Implement both modules.** Resolution follows the spec's algorithm with corrections 1 and 5. Steps 2a and 2c are mutually exclusive with 2b. Guests get `linkPermissions ∩ policy.shareLinks.guestPermissionsMax`, or nothing when links are disabled. Sources are listed in grant order, then policy, then state.
- [ ] **Step 4: Run the tests again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add permission model and effective-access resolver"`

### Task 3: Access port, errors and action kinds

**Files:**
- Create: `src/core/access-ports.ts`
- Modify: `src/core/errors.ts`, `src/http/artifact-http-failure.ts`, `src/core/model.ts`, `src/storage/activity-log-schema.ts`, `src/storage/activity-sql.ts`, `src/application/activity-entries.ts`, `src/core/identity.ts`, and every `Principal` construction (`installation-access.ts:humanPrincipal`, `:localPrincipal`, `authenticateManagedApiKey`, test fixtures)
- Test: `tests/application/invitations-model.test.ts` already pins activity verbs; extend `tests/application/permissions-model.test.ts` with error-mapping cases

**Interfaces:**
- Produces, from `src/core/access-ports.ts` (Promise-based, like `InvitationRepository`):

```ts
export interface AccessRepository {
  readAccessPolicy(installationId: string): Promise<StoredAccessPolicy>;          // defaults + revision 0 when absent
  writeAccessPolicy(command: {installationId: string; policy: AccessPolicy; expectedRevision: number; attribution: ActionAttribution}): Promise<StoredAccessPolicy | "conflict">;
  listProjectAccess(installationId: string): Promise<readonly ProjectAccess[]>;
  readProjectAccess(installationId: string, projectId: string): Promise<ProjectAccess | null>;
  writeProjectAccess(command: {installationId: string; projectId: string; accessMode: ProjectAccessMode; defaultMemberRole: ProjectRole; expectedRevision: number; attribution: ActionAttribution}): Promise<ProjectAccess | "conflict">;
  findSubjectGrants(command: {installationId: string; projectId: string; artifactId: string | null; memberId: string}): Promise<{projectGrant: AccessGrant | null; artifactGrants: readonly AccessGrant[]}>;
  listMemberGrants(installationId: string, memberId: string): Promise<readonly AccessGrant[]>;
  listProjectGrants(installationId: string, projectId: string): Promise<readonly AccessGrant[]>;   // project + artifact grants
  upsertGrant(command: {installationId: string; grant: Omit<AccessGrant, "createdAt" | "revision" | "updatedAt">; expectedRevision: number | null; attribution: ActionAttribution}): Promise<AccessGrant | "conflict">;
  deleteGrant(command: {installationId: string; grantId: string; expectedRevision: number; attribution: ActionAttribution}): Promise<"deleted" | "conflict" | "missing">;
}
```

- Produces, from `src/core/errors.ts`: tagged errors, their codes and HTTP statuses:
  - `AccessGrantInvalid` / `ACCESS_GRANT_INVALID` / 422
  - `PermissionNotHeld` / `PERMISSION_NOT_HELD` / 403
  - `AccessRevisionConflict` / `ACCESS_REVISION_CONFLICT` / 409
  - `AccessChangeUnconfirmed` / `ACCESS_CHANGE_UNCONFIRMED` / 409, with an extra `membersLosingAccess: number` field
  - All are added to `artifactServerFailureSchema` and mapped in `artifactServerFailureResponse`.
- Produces, in `src/core/model.ts`: project-scoped action kinds `grant_create`, `grant_update`, `grant_delete`, `project_access_change`, and the installation-scoped kind `policy_change`. They are registered in `projectScopedActionKinds` / `installationScopedActionKinds`, `feedKindsByType.admin`, `administrationKinds`, and `verbs` ("granted access", "changed access", "removed access", "changed project access", "changed the access policy").
- Produces, in `src/core/identity.ts`: `Principal` gains `readonly projectIds: readonly string[]`, where `[]` means every project. It is `[]` for humans and the local principal, and comes from the key for managed keys (Task 10 fills it).

- [ ] **Step 1: Write the failing tests.** In `permissions-model.test.ts`, assert that `artifactServerFailureResponse(new AccessChangeUnconfirmed({message, membersLosingAccess: 3}))` returns status 409 with body code `ACCESS_CHANGE_UNCONFIRMED` and `membersLosingAccess: 3`, and that `toActivityEntry` (`src/application/activity-entries.ts:154`) maps a `policy_change` action row to the verb "changed the access policy".
- [ ] **Step 2: Run the tests.** Run `pnpm vitest run tests/application/permissions-model.test.ts`. Expected: FAIL.
- [ ] **Step 3: Add the port, errors, action kinds and `Principal.projectIds`.** Then run `pnpm typecheck`, which lists every `Principal` literal to fix.
- [ ] **Step 4: Run the tests and typecheck.** Run `pnpm vitest run tests/application/permissions-model.test.ts && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add access repository port, errors and access action kinds"`

### Task 4: SQLite access repository

**Files:**
- Create: `src/storage/sqlite-access-repository.ts`, `src/storage/access-rows.ts`, `tests/support/access-repository-cases.ts`, `tests/storage/sqlite-access.test.ts`
- Modify: `src/storage/sqlite-artifact-repository.ts` (`#migrate`: tables, columns, `requiredSqliteSchemaVersion` 22 → 23 in `src/storage/sqlite-schema.ts`), `src/storage/sqlite-identity-repository.ts` (`managed_api_keys.project_ids_json` add-if-missing; `#tableColumns` union), `src/local/create-local-runtime.ts` (construct and close the repository)

**Interfaces:**
- Consumes: `AccessRepository` (Task 3).
- Produces:
  - `class SqliteAccessRepository implements AccessRepository { constructor(databasePath: string, installationId: string, clock: Clock); close(): void }`. It opens its own `DatabaseSync`, like `SqliteContentVariantIndex`, while the schema stays owned by `SqliteArtifactRepository#migrate`.
  - From `access-rows.ts`: `grantRowSchema`, `grantFromRow`, `projectAccessRowSchema`, `policyRowSchema`, `grantAction(kind, grant, attribution): ActionInsert`, `projectAccessAction(...)`, `policyAction(...)`.
  - From `access-repository-cases.ts`: `accessRepositoryCases: readonly {name: string; run(fixture: AccessFixture): Promise<void>}[]` with `interface AccessFixture { installationId: string; store: AccessRepository; actions(): Promise<readonly {kind: string; projectId: string | null}[]>; seedProject(id: string, archived?: boolean): Promise<void>; seedArtifact(projectId: string, id: string): Promise<void> }`.
- Schema: the spec's DDL with corrections 3 and 4.
  - `access_grants` has `member_id` and no `subject_kind`.
  - Both the project and artifact uniqueness constraints are implemented as `UNIQUE (installation_id, project_id, COALESCE(artifact_id, ''), member_id)`, as an expression index.
  - `share_links` waits for Part B.
  - `projects.access_mode`, `projects.default_member_role` default `'editor'`, and `projects.access_revision INTEGER NOT NULL DEFAULT 0`.

- [ ] **Step 1: Write the shared cases.** Each case is one `it` in each backend file.
  - `existing projects read as open editor revision 0`
  - `policy defaults then round-trips with revision 1 and writes policy_change`
  - `policy write with stale revision conflicts`
  - `project access write records project_access_change and bumps revision`
  - `grant upsert creates then updates with revision and records grant_create then grant_update`
  - `grant upsert with stale revision conflicts`
  - `artifact grant and project grant for one member coexist and findSubjectGrants returns both`
  - `deleteGrant missing, conflict, deleted`
  - `listMemberGrants spans projects`
  - `an installation never reads another installation's grants` (use `openSecond`-style second installation ID)
- [ ] **Step 2: Wire the cases into `tests/storage/sqlite-access.test.ts`** over a temporary database file. Also add a `PRM-001-B: a v22 database upgrades with every project open/editor and every key unscoped` test. The test creates a database through both repositories, adds a second project and issues a key, then closes it. It then downgrades the file by hand, following `storage-migration.test.ts`, which writes legacy schema directly:
  - `DROP TABLE access_grants`
  - `DROP TABLE installation_access_policy`
  - `ALTER TABLE projects DROP COLUMN` for `access_mode`, `default_member_role` and `access_revision`
  - `ALTER TABLE managed_api_keys DROP COLUMN project_ids_json`
  - `PRAGMA user_version = 22`

  Finally it reopens the file and asserts that both projects read `open`/`editor` and the key reads `projectIds: []`.
- [ ] **Step 3: Run the tests.** Run `pnpm vitest run tests/storage/sqlite-access.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement the migration, the repository and the rows module.** Writes use `BEGIN IMMEDIATE` with `positionalActionInsertSql` in the same transaction.
- [ ] **Step 5: Run the tests plus `tests/conformance/storage-migration.test.ts`.** Expected: PASS.
- [ ] **Step 6: Commit.** `git commit -m "Add SQLite access repository and schema v23"`

### Task 5: Postgres access repository

**Files:**
- Create: `src/storage/postgres-access-repository.ts`, `tests/integration/postgres-access.test.ts`
- Modify: `src/storage/postgres-migrations.ts`, `tests/configs/vitest.external-storage.config.ts` (include the new file), `src/external-storage/create-external-storage-runtime.ts` (construct it)

**Interfaces:**
- Produces:
  - `class PostgresAccessRepository implements AccessRepository { constructor(database: PostgresDatabase, installationId: string, clock: Clock) }`
  - Migration `"0025_layered_project_access"`: tables and columns as in Task 4, `managed_api_keys.project_ids_json`, and `actionRowChecks` re-applied the way 0023 does it.
  - `requiredPostgresSchemaVersion = 25`, and `{migration_id: 25, name: "layered_project_access"}` appended to `expectedHistory`.

- [ ] **Step 1: Run `accessRepositoryCases` against Postgres.** In `postgres-access.test.ts`, use the `postgres-invitations.test.ts` fixture pattern, and add `PRM-001-B: migration 25 preserves project and key access`. That test seeds at 24, deleting `migration_id >= 25` the way `postgres-invitations.test.ts:141` does.
- [ ] **Step 2: Run the tests.** Run `pnpm test:external-storage-runtime`. Expected: the new file fails.
- [ ] **Step 3: Implement the migration and repository.** Use `sql.withTransaction` with `insertPostgresAction`.
- [ ] **Step 4: Run the tests again.** Run `pnpm test:external-storage-runtime`. Expected: PASS, including `prj-004-project-migration.test.ts`, which pins `1..requiredPostgresSchemaVersion`.
- [ ] **Step 5: Commit.** `git commit -m "Add Postgres access repository and migration 25"`

### Task 6: D1 access repository

**Files:**
- Create: `deploy/cloudflare/src/d1-access-repository.ts`, `deploy/cloudflare/tests/d1-access.test.ts`
- Modify: `deploy/cloudflare/src/d1-migrations.ts` (`requiredD1SchemaVersion` 20 → 21, `addLayeredProjectAccessIfMissing(database)`), `deploy/cloudflare/src/worker.ts` (construct it)

**Interfaces:**
- Produces: `createD1AccessRepository(database: D1Database, installationId: string, clock: Clock): AccessRepository`. Each write is a single `database.batch([...rows, actionStatement(...)])`. Optimistic revision checks use `UPDATE … WHERE revision = ?` and read `meta.changes`, where 0 means `"conflict"`.

- [ ] **Step 1: Run `accessRepositoryCases` against local D1** (the `d1-invitations.test.ts` fixture), and add a `PRM-001-B` upgrade case from v20.
- [ ] **Step 2: Run the tests.** Run `pnpm --filter @artifact-server/cloudflare-deployment exec vitest run tests/d1-access.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the migration and repository.**
- [ ] **Step 4: Run the tests plus `tests/d1-activity-log-migration.test.ts` and `tests/comment-runtime.test.ts`**, which pin the schema version. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add D1 access repository and schema 21"`

### Task 7: Scope-aware AuthorizationService

**Files:**
- Modify: `src/application/authorization.ts`, `src/local/create-local-application-layer.ts` (add `access: AccessRepository` to `ApplicationAdapters` and build the Effect-wrapped port), and every call site listed below
- Test: `tests/conformance/prm-003-scoped-authorization.test.ts`, `tests/conformance/authorization-policy.test.ts` (update)

**Interfaces:**
- Consumes: `resolveEffectiveAccess`, `computeVisibleScope` (Task 2); `AccessRepository` (Task 3).
- Produces:
  - `AccessRepositoryEffects`: the same methods as `AccessRepository`, each returning `Effect<_, ArtifactRepositoryFailure>`. It is built in `create-local-application-layer.ts` with the `identityEffect` wrapping pattern used for invites.
  - `type AccessScope = {readonly projectId: string; readonly artifactId: string | null}`
  - `AuthorizationService.layer(dependencies: {installationId: string; access: AccessRepositoryEffects; clock: ApplicationClock["Service"]; artifacts: {isDeleted(projectId, artifactId): Effect<boolean | null, ArtifactRepositoryFailure>}})`. It becomes `Layer.succeed` over the Effect-wrapped ports; `null` from `isDeleted` means the artifact is missing.
  - `effectiveAccess(principal, scope): Effect<EffectiveAccess, ScopedDenial>`
  - `visibleScope(principal): Effect<VisibleScope, ArtifactRepositoryFailure>`
  - `type ScopedDenial = AuthorizationDenied | ProjectNotFound | ArtifactNotFound | ArtifactRepositoryFailure`
- Each scoped method now takes `scope: AccessScope` as its second argument and fails with `ScopedDenial`. Each one has a permission and a service-capability rule; the capability rule is copied unchanged from today's method.

| Method | Permission | Service capability rule |
| --- | --- | --- |
| `requireArtifactListing(p, {projectId, artifactId: null})` | project-level `artifact.view`, or any artifact grant in the project | read or manage |
| `requireArtifactRead` | `artifact.view` | read or manage |
| `requireArtifactHistory` (new) | `artifact.history` | read or manage |
| `requireCommentRead` | `comment.read` | read or manage |
| `requireCommentWrite` | `comment.write` | `comment:write` |
| `requireCommentModeration` (new) | `comment.moderate` | manage |
| `requireArtifactManagement(p, scope, permission: "artifact.edit" \| "artifact.delete" \| "artifact.share" \| "artifact.history")` | that permission | manage |
| `requireArtifactCreation(p, {projectId, artifactId: null})` | `artifact.publish` | create |
| `requireVersionPublication` | `artifact.publish` | publish any |
| `requirePublicationPreparation(p, scope \| null)` | `artifact.publish` when a scope is given | create or publish any |
| `requireContentSession(p, scope)` | `artifact.view` | `content-session:issue` |
| `requireDispatchSend(p, scope)` | `agent.dispatch` | manage |
| `requireProjectAccess(p, {projectId, artifactId: null})` | visible in `visibleScope` | any capability |
| `requireProjectManagement(p, {projectId, artifactId: null})` | `project.manage` | `project:manage` |
| `requireProjectCreation(p)` (new, installation-level) | human administrator | `project:manage` |

- Disclosure rule:
  - If the principal can't view the scope, the method fails with `ArtifactNotFound` when the scope names an artifact and `ProjectNotFound` otherwise.
  - If the principal can view it but lacks the permission, the method fails with `AuthorizationDenied`.
  - A service or member-bound key whose `projectIds` is non-empty and doesn't include `scope.projectId` fails with `ProjectNotFound`.
- Subjects:
  - A direct human administrator resolves as `administrator`.
  - A direct human member resolves as `member` with `memberId: principal.id`.
  - A member-bound key (`kind: "human"`, `authorizedByPrincipalId !== null`) must pass both the capability rule and the member resolution.
  - A service principal must pass both the capability rule and the project scope.
- Call sites to update (from recon). Each check moves after the project is resolved, so it can pass the resolved `projectId`:
  - `artifact-management.ts:400, 421, 457, 500, 532, 563, 578, 611, 640, 675, 708`. Lines 421, 457 and 500 use `requireArtifactHistory` for non-current versions, version lists and manifest entries. Line 563 (`listArtifactActions`) uses `requireArtifactManagement(…, "artifact.history")`, 578 restore and 640 rename use `"artifact.edit"`, 611 `changeAccess` uses `"artifact.share"`, 675 tags use `"artifact.edit"`, and 708 uses `"artifact.delete"`.
  - `artifact-comments.ts:496-511`. Remove the direct `hasCapability`/`isHumanAdministrator` checks. Non-author removal calls `requireCommentModeration`.
  - `artifact-comments.ts:499, 526, 579, 615, 633, 710, 735, 764`.
  - `compare-artifact.ts:209`, `git-history-access.ts:106`, `linked-artifacts.ts:519, 720, 792, 856, 899`.
  - `agent-dispatch.ts:514`, which keeps no scope and becomes installation-level `requireArtifactListing` over `visibleScope ≠ empty`.
  - `agent-dispatch.ts:559, 629, 651, 671`, `publish-artifact.ts:249, 319`, `staged-upload.ts:389, 553, 718`, `content-access.ts:262`.
  - `project-management.ts:142, 157, 197, 220, 232`. Line 197 (create) uses `requireProjectCreation`.
  - `project-git-history.ts:228, 242, 260`. Line 228 gains `requireProjectAccess`.

- [ ] **Step 1: Write the failing tests.** In `prm-003-scoped-authorization.test.ts`, use a real `ManagedRuntime` over `createLocalApplicationLayer` and a temporary SQLite file (the `tests/support/invitation-runtime.ts` pattern). Add a `startAccessRuntime()` helper in `tests/support/access-runtime.ts` that returns the runtime, `signIn(email, role)`, and the access repository.
  - `PRM-003-B: a viewer grant allows getArtifact and denies publish with AUTHORIZATION_DENIED`
  - `PRM-003-B: a manager grant lets a member rename a project and delete another member's comment`
  - `PRM-003-F: a member on a restricted project without a grant gets ARTIFACT_NOT_FOUND for a direct artifact id and PROJECT_NOT_FOUND for the project`
  - `PRM-003-F: an archived project denies comment.write even for a manager grant`
  - `PRM-005-B: an administrator with no grants manages a restricted project`
  - `PRM-003-B: deactivating a member keeps their grants, and reactivation restores the same access` (spec rule 19)
  - `PRM-001-B: with no access rows every existing authorization-policy case still passes`. `authorization-policy.test.ts` keeps all its current assertions with the new signatures.
- [ ] **Step 2: Run the tests.** Run `pnpm vitest run tests/conformance/prm-003-scoped-authorization.test.ts tests/conformance/authorization-policy.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the service and update every call site.** Each scoped call does one `findSubjectGrants`, one `readProjectAccess` and one cached-per-call `readAccessPolicy`. Nothing is cached across requests.
- [ ] **Step 4: Run the whole suite.** Run `pnpm typecheck && pnpm test`. Expected: PASS. Every existing CMT, DSP, LNK, PRJ, GIT and AUTH conformance test still passes, which is the evidence for PRM-001-B.
- [ ] **Step 5: Commit.** `git commit -m "Make authorization resolve project and artifact scope"`

### Task 8: Visibility filtering for lists, search, activity, library and MCP

**Files:**
- Modify: `src/core/ports.ts` (`ListArtifacts` gains `artifactIds: readonly string[] | null`), `listArtifacts` in `sqlite-artifact-repository.ts:2200`, `postgres-artifact-repository.ts:2098` and `d1-artifact-repository.ts:3208`, `src/application/artifact-management.ts:522`, `src/application/project-management.ts:155`, `src/application/activity.ts:167, 189, 199`, `src/application/library-catalog.ts:182`, `src/mcp/artifact-mcp-server.ts` (`dispatch_inbox` and nudge facts already go through services, so only verify them)
- Test: `tests/conformance/prm-002-visibility.test.ts`, plus a case in `tests/support/access-repository-cases.ts` for `listArtifacts` with `artifactIds`

**Interfaces:**
- Consumes: `AuthorizationService.visibleScope` (Task 7).
- Produces:
  - `listArtifacts` filters with `artifactIds`. SQLite and D1 use `id IN (SELECT value FROM json_each(?))` with one bound JSON array, because D1 is limited to 100 bound parameters. Postgres uses `id = ANY($n::text[])`. `null` means no filter, and `[]` returns an empty page.
  - `listProjects` returns only projects in `projectIds ∪ keys(artifactIdsByProject)`.
  - Activity intersects the requested `projectIds` with the visible `projectIds`. If the intersection is empty, it returns an empty page or zero counts without querying (correction 9).

- [ ] **Step 1: Write the failing tests.** Use HTTP through `startTestServer` and two signed-in members.
  - `PRM-002-B: a restricted project is absent from /api/v1/projects, artifact search, library, activity and the MCP project_list for a member without a grant`
  - `PRM-002-B: an artifact grant lists exactly that artifact in its project`
  - `PRM-002-F: empty visibility returns nothing`. A member blocked by `none` on every project gets `[]` projects, an empty activity page, a zero summary and an empty library.
  - `PRM-002-F: a direct version id, comparison, manifest page and git clone token on a hidden artifact return 404 without naming the artifact`
- [ ] **Step 2: Run the tests.** Run `pnpm vitest run tests/conformance/prm-002-visibility.test.ts tests/storage/sqlite-access.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the filtering.**
- [ ] **Step 4: Run the tests, then the Postgres and D1 suites.** Run `pnpm vitest run tests/conformance/prm-002-visibility.test.ts tests/storage/sqlite-access.test.ts && pnpm test:external-storage-runtime && pnpm check:cloudflare`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Filter projects, artifacts, activity and library by visible scope"`

### Task 9: Access administration service

**Files:**
- Create: `src/application/access-administration.ts`
- Modify: `src/local/create-local-application-layer.ts` and `src/application/application-runtime.ts` (add the service to the union)
- Test: `tests/conformance/prm-004-granting.test.ts`

**Interfaces:**
- Produces `class AccessAdministrationService extends Context.Service` with these operations. Every mutation takes `principal` and `idempotencyKey`.
  - `readPolicy(principal): Effect<StoredAccessPolicy, AuthorizationDenied | ArtifactRepositoryFailure>`. Administrators only.
  - `writePolicy({principal, policy, expectedRevision}): Effect<{policy: StoredAccessPolicy; narrowed: {grants: number; shareLinks: number}}, AuthorizationDenied | AccessRevisionConflict | ArtifactRepositoryFailure>`
  - `readProjectAccess({principal, projectId}): Effect<{access: ProjectAccess; grants: readonly AccessGrant[]; members: readonly {memberId: string; displayName: string; email: string; role: MembershipRole; effectiveRole: ProjectRole | "administrator"}[]}, ScopedDenial>`. Requires `project.manage`.
  - `changeProjectAccess({principal, projectId, accessMode, defaultMemberRole, expectedRevision, confirmMembersLosingAccess: number | null}): Effect<ProjectAccess, ScopedDenial | AccessRevisionConflict | AccessChangeUnconfirmed>`
  - `putGrant({principal, projectId, artifactId: string | null, memberId, role, add, remove, expiresAt, expectedRevision: number | null}): Effect<AccessGrant, ScopedDenial | AccessGrantInvalid | PermissionNotHeld | AccessRevisionConflict>`
  - `deleteGrant({principal, projectId, artifactId: string | null, memberId, expectedRevision}): Effect<void, ScopedDenial | AccessRevisionConflict>`
  - `explain({principal, projectId, artifactId: string | null, subjectMemberId: string | null}): Effect<EffectiveAccess & {subject: {id: string; displayName: string}}, ScopedDenial>`. A null subject means "me". Another subject requires `project.manage` on a project scope, or `artifact.share` on an artifact scope.
  - `listMemberGrants({principal, memberId}): Effect<readonly AccessGrant[], AuthorizationDenied>`. Administrators only.
- Validation, by spec rule number:
  1. `PermissionNotHeld` when `rolePermissions(role) ∪ add` is not a subset of the actor's effective permissions on the same scope.
  2. Project grants require `project.manage`. Artifact grants require `artifact.share`.
  3. Normalize `add` and `remove`: drop no-ops (adding what the role already gives, removing what it lacks), deduplicate and sort. Return `AccessGrantInvalid` for unknown permissions or for overlap between the two lists.
  4. Artifact grants with role `none` are rejected with `AccessGrantInvalid`, as is removing `artifact.view` from an artifact grant.
  5. A grant whose subject is an administrator or an unknown member is rejected with `AccessGrantInvalid`.
  6. `expiresAt` must be in the future (`AccessGrantInvalid`).
  7. More than 500 artifact grants per member per project is rejected with `AccessGrantInvalid`.
  8. Switching to `restricted` counts active non-administrator members whose project visibility would drop. When that count is above 0 and doesn't equal `confirmMembersLosingAccess`, the call fails with `AccessChangeUnconfirmed` and the count.

- [ ] **Step 1: Write the failing tests.**
  - `PRM-004-B: a manager grants commenter to a member and the member can comment`
  - `PRM-004-F: an editor cannot grant manager or add comment.moderate`, expecting `PERMISSION_NOT_HELD` through direct service calls that bypass any interface
  - `PRM-004-F: overlapping add/remove, unknown permission, artifact none, removing view, and past expiry each return ACCESS_GRANT_INVALID`
  - `PRM-005-F: granting to an administrator returns ACCESS_GRANT_INVALID`
  - `PRM-004-B: restricting with 2 affected members requires confirmMembersLosingAccess 2 and returns ACCESS_CHANGE_UNCONFIRMED with membersLosingAccess 2 otherwise`
  - `PRM-004-B: writePolicy that removes comment.write from guestPermissionsMax reports narrowed counts`. Share links are 0 until Part B.
  - `PRM-004-B: explain names the project grant and the policy ceiling as sources`
- [ ] **Step 2: Run the tests.** Run `pnpm vitest run tests/conformance/prm-004-granting.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the service.**
- [ ] **Step 4: Run the tests again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add access administration service with granting rules"`

### Task 10: Project-scoped API keys

**Files:**
- Modify: `src/application/installation-access.ts` (`issueApiKey` accepts `projectIds: readonly string[]`, validated against existing projects; rotation carries the scope forward; `authenticateManagedApiKey` sets `Principal.projectIds`); `parseApiKey` and `createApiKey` in `sqlite-identity-repository.ts:1125, 657`, `postgres-identity-repository.ts:955` and `d1-identity-repository.ts:890`; `src/core/identity-ports.ts` (API key record gains `projectIds`)
- Test: `tests/conformance/prm-009-key-scope.test.ts`

**Interfaces:**
- Produces: the `issueApiKey` command gains `projectIds: readonly string[]`, where `[]` means all projects. The stored key record gains `projectIds`.

- [ ] **Step 1: Write the failing tests.**
  - `PRM-009-B: a key scoped to project A publishes to A`
  - `PRM-009-F: the same key gets PROJECT_NOT_FOUND publishing to, listing, or reading B, over HTTP and over MCP`
  - `PRM-009-F: a member-bound key cannot exceed its member's viewer grant even with artifact:publish:any`
  - `PRM-009-F: issuing with an unknown project id fails with PROJECT_NOT_FOUND`
- [ ] **Step 2: Run the tests.** Run `pnpm vitest run tests/conformance/prm-009-key-scope.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the key scope.**
- [ ] **Step 4: Run the tests plus `tests/conformance/auth-009-api-key-rotation.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Scope managed API keys to projects"`

### Task 11: HTTP routes for access administration

**Files:**
- Modify: `src/http/create-http-app.ts` (routes; `issueApiKeySchema` gains `projectIds`)
- Test: `tests/conformance/prm-004-access-http.test.ts`

**Interfaces:**
- Produces these routes. Mutations require the CSRF header and `Idempotency-Key`. Bodies are zod schemas named `xxxSchema`.

| Route | Calls |
| --- | --- |
| `GET /api/v1/access-policy` | `readPolicy` |
| `PUT /api/v1/access-policy` `{policy, expectedRevision}` | `writePolicy` |
| `GET /api/v1/projects/:projectId/access` | `readProjectAccess` |
| `PATCH /api/v1/projects/:projectId/access` `{accessMode, defaultMemberRole, expectedRevision, confirmMembersLosingAccess}` | `changeProjectAccess` |
| `PUT /api/v1/projects/:projectId/grants/:memberId` `{role, add, remove, expiresAt, expectedRevision}` | `putGrant` (project scope) |
| `DELETE /api/v1/projects/:projectId/grants/:memberId?expectedRevision=N` | `deleteGrant` |
| `PUT`/`DELETE /api/v1/projects/:projectId/artifacts/:artifactId/grants/:memberId` | artifact-scope grant |
| `GET /api/v1/projects/:projectId/artifacts/:artifactId/access?subject=<memberId>` | `explain`; without `subject` it returns the caller's own access. The web client uses this for control visibility. |
| `GET /api/v1/projects/:projectId/access/effective?subject=` | project-scope `explain` |
| `GET /api/v1/members/:memberId/grants` | `listMemberGrants` |

- Response shape for `explain`: `{permissions: string[] (sorted), sources: AccessSource[], subject: {id, displayName}}`.

- [ ] **Step 1: Write the failing tests.**
  - `PRM-004-B: a manager round-trips project access and a grant over HTTP`
  - `PRM-004-F: a member PUT to another project's grants returns 404, not 403`
  - `PRM-004-F: a missing CSRF header returns 403 and changes nothing`
  - `PRM-010-B: GET artifact access returns the caller's sorted permissions`
- [ ] **Step 2: Run the tests.** Run `pnpm vitest run tests/conformance/prm-004-access-http.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the routes.**
- [ ] **Step 4: Run the tests again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Expose access administration over HTTP"`

### Task 12: Web — Project › Access panel and the override popover

**Files:**
- Modify: `apps/web/src/api/client.ts` (schemas `accessPolicySchema`, `projectAccessSchema`, `accessGrantSchema`, `effectiveAccessSchema`; methods `accessPolicy()`, `putAccessPolicy(policy, expectedRevision)`, `projectAccess(projectId)`, `changeProjectAccess(projectId, body)`, `putGrant(projectId, artifactId | null, memberId, body)`, `deleteGrant(projectId, artifactId | null, memberId, expectedRevision)`, `effectiveAccess(projectId, artifactId | null, subject?)`, `memberGrants(memberId)`), `apps/web/src/review/settings/project-settings.tsx` (new "Access" `AdminPanel` when the caller holds `project.manage`)
- Create: `apps/web/src/review/settings/project-access-panel.tsx`, `apps/web/src/review/settings/permission-override-popover.tsx`, `apps/web/src/review/settings/project-access-model.ts` (+ `.test.ts`)

**Interfaces:**
- Produces:
  - `ProjectAccessPanel({projectId}: {projectId: string})`
  - `PermissionOverridePopover({grant, role, actorPermissions, policyCeiling, onSave, onCancel})`
  - `project-access-model.ts`: `overrideRows(role: ProjectRole, add: readonly Permission[], remove: readonly Permission[], actorPermissions: ReadonlySet<Permission>, ceiling: readonly Permission[] | null): readonly {permission: Permission; label: string; state: "from_role" | "added" | "removed" | "off" | "blocked_by_policy"; disabledReason: string | null}[]`, and `restrictConfirmation(membersLosingAccess: number): string`
- Copy:
  - The mode options read "Open to all members" and "Restricted to people listed".
  - Administrator rows read "Manager (administrator)" and are locked.
  - The restrict confirmation reads "`N` members will lose access to this project."
  - Disabled reasons read "You don't have this permission" and "Blocked by installation policy".

- [ ] **Step 1: Write the failing model tests.** In `project-access-model.test.ts`:
  - `overrideRows` for editor with `remove: ["artifact.delete"]` marks delete as `removed` and publish as `from_role`.
  - When the actor lacks `project.manage`, that row is disabled with "You don't have this permission".
  - `restrictConfirmation(2)` returns "2 members will lose access to this project."
- [ ] **Step 2: Run the tests.** Run `pnpm --filter @artifact-server/web exec vitest run src/review/settings/project-access-model.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the client methods, the model and both components**, following `AdminPanel` and `admin-parts.tsx` patterns.
- [ ] **Step 4: Run the tests again plus `pnpm typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add project access panel and permission overrides"`

### Task 13: Web — access policy, member grants, explainer and permission-driven controls

**Files:**
- Create: `apps/web/src/review/settings/access-policy-screen.tsx`, `apps/web/src/review/settings/access-explainer.tsx`, `apps/web/src/review/workspace/use-effective-access.ts`
- Modify: `apps/web/src/review/settings/admin-areas.ts` (+ test; id `accessPolicy`, label "Access policy", `administratorOnly: true`), `settings-view.ts` (+ test), `settings-screen.tsx`, `apps/web/src/review/review-routes.ts` (+ test; `SettingsRoute` gains `accessPolicy` at `/review/settings/access-policy`), `members-screen.tsx` (the detail panel lists `api.memberGrants` with links to each project's Access panel), `share-popover.tsx` (a "People" section on the overview screen with an explainer entry), `review-app.tsx` (replace the client-derived `canComment`/`canManageArtifacts`/`canDeleteAnyComment` at `:647, 655, 662` with `useEffectiveAccess`; a 404 on the current project or artifact renders a "You no longer have access to this project" panel)
- Test: `tests/browser/prm-010-access-controls.spec.ts`

**Interfaces:**
- Produces:
  - `useEffectiveAccess(projectId: string, artifactId: string | null): {permissions: ReadonlySet<Permission>; status: "loading" | "ready" | "gone"}`
  - `AccessExplainer({projectId, artifactId})`, which renders sentences such as "Dana can comment: Commenter on Design. Deleting is blocked by installation policy."
  - `explainSentence(subjectName, permission, sources): string`, exported for tests
- `AccessPolicyScreen` asks for confirmation before saving whenever a narrowing change would affect grants or links: "This narrows `N` grants and `M` share links."

- [ ] **Step 1: Write the failing tests.**
  - Web unit (in `access-explainer.test.ts`): `explainSentence("Dana", "artifact.delete", [{layer: "project_grant", role: "commenter", …}, {layer: "policy", removed: ["artifact.delete"]}])` returns the exact copy above.
  - Browser:
    - `PRM-010-B: a viewer sees no Annotate switch, no composer, no Share button and no Delete`
    - `PRM-010-B: a manager restricts a project from Settings and the confirmation shows the count`
    - `PRM-010-F: a member whose project is restricted mid-session sees "You no longer have access to this project" on next navigation` (Review Focus 4)
    - `PRM-010-F: a hidden control's endpoint still refuses`: the viewer page calls the publish endpoint through `page.request` and gets 403
- [ ] **Step 2: Run the tests.** Run `pnpm --filter @artifact-server/web exec vitest run src/review/settings && pnpm exec playwright test tests/browser/prm-010-access-controls.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the screens, the hook and the review-app changes.**
- [ ] **Step 4: Run the tests again, plus the existing `tests/browser/admin-console.spec.ts`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Drive Review controls from effective access and add policy and explainer screens"`

### Task 14: Part A gate

**Files:**
- Modify: `project/spec/conformance.yml` (PRM-001…005, 009 and 010 move to `behavior_verified` with evidence entries pointing at `project/evidence/local-foundation.json` and the external-storage and Cloudflare evidence files those suites write; PRM-006…008 stay `specified`), `docs/deployment.md` (new "Project access" section: modes, roles, policy, key scope), `deploy/cloudflare/README.md` (schema 21)

- [ ] **Step 1: Run `BROWSER_CRITICAL_ENGINES=all pnpm test:web`**, because Review controls changed. Expected: PASS on chromium, firefox and webkit.
- [ ] **Step 2: Run `pnpm verify:iteration`.** Expected: exit 0. A load flake in `lifecycle-cli` or `mcp-onboarding` is a known quirk (memory). Rerun only that file and record both runs.
- [ ] **Step 3: Update the ledger and docs.** Run `pnpm conformance:validate && pnpm conformance:tests`. Expected: PASS.
- [ ] **Step 4: Commit.** `git commit -m "Record project access verification evidence"`

---

# Part B — Share links and guest review

### Task 15: Share-link model, guest principal kind, and widened author kinds

**Files:**
- Create: `src/core/share-links.ts`, `src/core/share-link-ports.ts`, `src/core/untrusted-text.ts`
- Modify:
  - `src/core/identity.ts`: `principalKinds.guest = "guest"`, and `Principal` gains `readonly shareLinkId: string | null`
  - `src/core/ports.ts`: `IdGenerator` gains `shareLinkId()`, `shareLinkToken()` and `guestId()`
  - `src/core/system.ts`: those generators — `shl_` + 24 hex, `shr_` + 48 hex, and `guest:gst_` + 24 hex
  - `src/mcp/dispatch-bundle-message.ts`: `sanitizeBundleText` delegates to `stripInvisibleControls`
  - `src/core/errors.ts` and `src/http/artifact-http-failure.ts`:
    - `ShareLinkNotFound` / `SHARE_LINK_NOT_FOUND` / 404
    - `ShareLinkInvalid` / `SHARE_LINK_INVALID` / 422
    - `ShareLinksDisabled` / `SHARE_LINKS_DISABLED` / 403
    - `GuestSessionRequired` / `GUEST_SESSION_REQUIRED` / 401
    - `GuestIdentityRequired` / `GUEST_IDENTITY_REQUIRED` / 422
    - `GuestRateLimited` / `GUEST_RATE_LIMITED` / 429, with `retryAfterSeconds`
  - `src/core/model.ts` plus the activity registration files from Task 3: artifact kinds `share_link_create`, `share_link_update`, `share_link_rotate`, `share_link_revoke` and `guest_join`. These are not in `artifactHistoryActionKinds`. The verbs are "created a share link", "changed a share link", "replaced a share link", "ended a share link" and "joined as a guest".
  - Zod author-kind enums widened to include `"guest"`: `src/storage/activity-sql.ts:89`, `src/mcp/artifact-mcp-server.ts:249-254`, `apps/web/src/api/client.ts:28`, `apps/web/src/api/activity-contract.ts:4`
- Test: `tests/application/share-links-model.test.ts`

**Interfaces:**
- Produces, from `src/core/share-links.ts`:
  - `interface ShareLink { readonly id: string; readonly projectId: string; readonly artifactId: string; readonly label: string; readonly token: string; readonly target: {readonly kind: "latest"} | {readonly kind: "pinned"; readonly versionId: string}; readonly permissions: readonly Permission[]; readonly expiresAt: string | null; readonly generation: number; readonly revision: number; readonly createdAt: string; readonly createdByPrincipalId: string; readonly createdByName: string; readonly revokedAt: string | null; readonly guestCount: number }`
  - `interface GuestRecord { readonly id: string; readonly shareLinkId: string; readonly generation: number; readonly displayName: string | null; readonly contactEmail: string | null; readonly createdAt: string }`
  - `interface GuestSessionRecord { readonly id: string; readonly guestId: string; readonly expiresAt: string; readonly revokedAt: string | null }`
  - `validateShareLinkPermissions(permissions, policy): readonly Permission[] | ShareLinkInvalid`, enforcing rules 10–11: non-empty, includes view, a subset of the guest-holdable permissions and of `guestPermissionsMax`, and `comment.write` requires `comment.read`
  - `isShareLinkActive(link, now): boolean`
  - `guestSessionExpiry(link, now): string`, which returns `min(link.expiresAt, now + 30 days)`
  - `normalizeGuestDisplayName(raw): string | GuestIdentityRequired`, which strips, trims and enforces 1–60 characters
- Produces, from `src/core/share-link-ports.ts`:

```ts
export interface ShareLinkRepository {
  createShareLink(command: {installationId: string; link: Omit<ShareLink, "generation" | "revision" | "guestCount" | "revokedAt">; attribution: ActionAttribution}): Promise<ShareLink>;
  updateShareLink(command: {installationId: string; linkId: string; expectedRevision: number; label: string; permissions: readonly Permission[]; expiresAt: string | null; target: ShareLink["target"]; attribution: ActionAttribution}): Promise<ShareLink | "conflict" | "missing">;
  rotateShareLink(command: {installationId: string; linkId: string; expectedRevision: number; token: string; attribution: ActionAttribution}): Promise<ShareLink | "conflict" | "missing">;   // generation + 1
  revokeShareLink(command: {installationId: string; linkId: string; attribution: ActionAttribution}): Promise<ShareLink | "missing">;
  revokeArtifactShareLinks(command: {installationId: string; projectId: string; artifactId: string; attribution: ActionAttribution}): Promise<number>;
  findShareLinkByToken(token: string): Promise<(ShareLink & {installationId: string}) | null>;
  findShareLink(installationId: string, linkId: string): Promise<ShareLink | null>;
  listArtifactShareLinks(installationId: string, projectId: string, artifactId: string): Promise<readonly ShareLink[]>;
  listActiveShareLinks(command: {installationId: string; cursor: PageCursor | null; limit: number; now: string}): Promise<{items: readonly ShareLink[]; nextCursor: PageCursor | null}>;
  createGuest(command: {installationId: string; guest: GuestRecord; session: GuestSessionRecord & {tokenDigest: string; csrfDigest: string}; attribution: ActionAttribution}): Promise<void>;
  findGuestSession(installationId: string, tokenDigest: string): Promise<{session: GuestSessionRecord & {csrfDigest: string}; guest: GuestRecord; link: ShareLink} | null>;
  findGuest(installationId: string, guestId: string): Promise<{guest: GuestRecord; link: ShareLink} | null>;
  setGuestIdentity(command: {installationId: string; guestId: string; displayName: string; contactEmail: string | null}): Promise<GuestRecord>;
}
```

- [ ] **Step 1: Write the failing tests.**
  - `validateShareLinkPermissions` rejects `[]`, `["comment.read"]`, `["artifact.view", "comment.write"]` and `["artifact.view", "artifact.publish"]`, and accepts `["artifact.view", "comment.read", "comment.write"]`.
  - `normalizeGuestDisplayName("‮alice​ ")` returns `"alice"`, and a 61-character name fails.
  - `guestSessionExpiry` with a link expiring in 2 days returns the link expiry.
  - `stripInvisibleControls` is byte-identical to the old `sanitizeBundleText` on the strings in `tests/conformance/dsp-011-bridge-bundle-render.test.ts`.
- [ ] **Step 2: Run the tests.** Run `pnpm vitest run tests/application/share-links-model.test.ts tests/conformance/dsp-011-bridge-bundle-render.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the model, ports, errors, kinds and widened enums.** Then run `pnpm typecheck` to find every `Principal` literal, which takes `shareLinkId: null`.
- [ ] **Step 4: Run the tests again plus `pnpm typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add share-link model, guest principals and guest author kind"`

### Task 16: SQLite share links and guests

**Files:**
- Modify: `src/storage/sqlite-access-repository.ts` (also implements `ShareLinkRepository`), `src/storage/access-rows.ts` (share-link, guest and session rows and their action builders), `src/storage/sqlite-artifact-repository.ts#migrate` (tables `share_links`, `guest_principals`, `guest_sessions`; widen `comment_threads`/`comment_replies` `author_principal_kind` and `resolved_by_principal_kind` CHECKs to include `'guest'` with the table-rebuild pattern `#widen…IfNeeded`; `actions.actor_kind` through `activity-log-schema.ts:90`; version 23 → 24)
- Modify: `tests/support/access-repository-cases.ts` (share-link cases), `tests/storage/sqlite-access.test.ts`

**Interfaces:**
- Schema: the spec's `share_links` with corrections 3 and 7.
  - No `legacy_public_link` or `review_controls`.
  - Adds `generation INTEGER NOT NULL DEFAULT 0` and `revision INTEGER NOT NULL DEFAULT 0`.
  - `guest_principals` adds `generation INTEGER NOT NULL`.
  - `guest_sessions` stores `share_link_id`.
  - `guestCount` is computed as `COUNT(*)` of guests whose `generation = link.generation`.

- [ ] **Step 1: Add the shared cases.**
  - `create, find by token, list for artifact`
  - `rotate bumps generation and the old guest no longer matches`
  - `revokeArtifactShareLinks revokes only that artifact`
  - `listActiveShareLinks skips revoked and expired and pages by cursor`
  - `createGuest writes guest_join and the session round-trips by digest`
  - `a comment authored by a guest principal persists with author kind guest` (insert through the artifact repository's existing comment create)
- [ ] **Step 2: Run the tests.** Run `pnpm vitest run tests/storage/sqlite-access.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the migration and the repository methods.**
- [ ] **Step 4: Run the tests plus `tests/conformance/cmt-*.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add SQLite share links, guests and guest comment authors"`

### Task 17: Postgres share links and guests

**Files:**
- Modify: `src/storage/postgres-access-repository.ts`, `src/storage/postgres-migrations.ts` (`"0026_share_links_and_guests"`, version 26, `expectedHistory`, CHECK widening, `actionRowChecks` re-applied), `tests/integration/postgres-access.test.ts`

- [ ] **Step 1: Run the Task 16 cases against Postgres.**
- [ ] **Step 2: Run the tests.** Run `pnpm test:external-storage-runtime`. Expected: the new cases fail.
- [ ] **Step 3: Implement the migration and methods.**
- [ ] **Step 4: Run the tests again.** Run `pnpm test:external-storage-runtime`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add Postgres share links and guests"`

### Task 18: D1 share links and guests

**Files:**
- Modify: `deploy/cloudflare/src/d1-access-repository.ts`, `deploy/cloudflare/src/d1-migrations.ts` (version 22; widening uses the snapshot rebuild with `PRAGMA defer_foreign_keys`), `deploy/cloudflare/tests/d1-access.test.ts`

- [ ] **Step 1: Run the Task 16 cases against local D1.**
- [ ] **Step 2: Run the tests.** Run `pnpm --filter @artifact-server/cloudflare-deployment exec vitest run tests/d1-access.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the migration and methods.**
- [ ] **Step 4: Run the tests again plus `tests/comment-runtime.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add D1 share links and guests"`

### Task 19: Share-link service, inventory and MCP tools

**Files:**
- Create: `src/application/share-links.ts`
- Modify:
  - `src/application/public-link-administration.ts`: the inventory merges bare public-link artifacts and active share links. `makePrivate` also calls `revokeArtifactShareLinks`.
  - `src/application/artifact-management.ts:605`: `changeAccess` to `public_link` fails with `ShareLinksDisabled` when the policy disables links.
  - `src/application/access-administration.ts`: `writePolicy`'s `narrowed.shareLinks` counts active links whose permissions exceed the new maximum.
  - `src/mcp/artifact-mcp-server.ts`: new tools `share_link_list`, `share_link_create` and `share_link_revoke`, following the `artifact_set_visibility` pattern (ADR 0016 parity for sharing).
  - Application layer wiring and the services union.
- Test: `tests/conformance/prm-006-share-links.test.ts`

**Interfaces:**
- Produces `ShareLinkService` with these operations:
  - `create({principal, projectId, artifactId, label, target, permissions, expiresAt, idempotencyKey}): Effect<ShareLink, ScopedDenial | ShareLinkInvalid | ShareLinksDisabled>`. It requires `artifact.share`, plus a human administrator when `policy.shareLinks.linkCreators === "administrators"`. A pinned target must name a version of the artifact. Expiry must be in the future and within `maxExpiryDays`. The label is stripped and 1–80 characters.
  - `update(...)`, `rotate(...)` and `revoke(...)`, with the same authority, returning `ShareLink`.
  - `listForArtifact({principal, projectId, artifactId}): Effect<readonly ShareLink[], ScopedDenial>`
  - `inventory({principal, cursor, limit})`. Administrators only, bounded to 1–100.
- Wire shape: `ShareLink` plus `url: "<appOrigin>/s/<token>"`. A token is returned only to callers who hold `artifact.share`.

- [ ] **Step 1: Write the failing tests.**
  - `PRM-006-B: an editor creates a view-and-comment link pinned to v2 and lists it with its URL`
  - `PRM-006-F: a viewer cannot create a link`, expecting `ARTIFACT_NOT_FOUND` when hidden and `AUTHORIZATION_DENIED` when visible
  - `PRM-006-F: permissions beyond guestPermissionsMax, a past expiry, an expiry beyond maxExpiryDays, a foreign pinned version and an empty label each return SHARE_LINK_INVALID`
  - `PRM-007-B: making an artifact private from the inventory revokes its share links and turns off the bare link in one request`
  - `PRM-007-B: disabling share links in policy makes changeAccess to public_link fail with SHARE_LINKS_DISABLED`
  - `PRM-006-B: MCP share_link_create matches HTTP authority`
- [ ] **Step 2: Run the tests.** Run `pnpm vitest run tests/conformance/prm-006-share-links.test.ts tests/conformance/public-link-administration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the service, the inventory merge and the MCP tools.**
- [ ] **Step 4: Run the tests again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add share-link service, merged inventory and MCP sharing tools"`

### Task 20: Guest review service and guest authorization

**Files:**
- Create: `src/application/guest-review.ts`
- Modify:
  - `src/application/authorization.ts`: a guest subject resolves `linkPermissions` from a fresh `findGuest`. A scope other than the link's artifact fails with `ArtifactNotFound`. An inactive link or a generation mismatch denies everything.
  - `src/application/content-access.ts`: `authorizePreviewContent` and `authorizeVersionContent`, for a lease or session whose `principal_id` starts with `guest:`, re-check `findGuest` (active link, matching generation) and that the version is still the link's target.
  - Application wiring.
- Test: `tests/conformance/prm-007-guest-sessions.test.ts`

**Interfaces:**
- Produces `GuestReviewService`:
  - `startSession({token}): Effect<{sessionToken: string; csrfToken: string; expiresAt: string; context: GuestContext}, ShareLinkNotFound>`. Every inactive, unknown, disabled or deleted case returns the same `ShareLinkNotFound` (spec "Ended link" rule).
  - `authenticate({sessionToken}): Effect<{principal: Principal; context: GuestContext; csrfDigest: string}, GuestSessionRequired>`. There is no cache: one `findGuestSession` per request.
  - `interface GuestContext { readonly link: {id: string; label: string; permissions: readonly Permission[]; expiresAt: string | null; createdByName: string}; readonly project: {id: string; name: string}; readonly artifact: {id: string; name: string}; readonly version: {id: string; number: number; savedAt: string}; readonly guest: {id: string; displayName: string | null} }`
  - `setIdentity({principal, displayName, contactEmail}): Effect<GuestContext, GuestIdentityRequired | GuestSessionRequired>`
  - `issuePreviewLease({principal}): Effect<{baseUrl: string; expiresAt: string; versionId: string}, ...>`, which delegates to `ContentAccessService.issuePreviewLease` with the target version
  - `listThreads`, `getThread`, `createThread`, `createReply`, `updateThread`, `updateReply`, `resolveThread`, `reopenThread`, `deleteThread` and `deleteReply`. Each takes `{principal, …}` without project, artifact or version IDs and delegates to `ArtifactCommentService` with the target forced. `getThread`, and any reply or update on a thread whose `versionId` isn't the target, fails with `CommentThreadNotFound` (the existing tag). Writes require a non-null `displayName` and otherwise fail with `GuestIdentityRequired`.
- The guest `Principal` is:

```ts
{kind: "guest", id: guest.id, displayName: guest.displayName ?? "Guest",
 installationId, membershipRole: "member", capabilities: [],
 authorizedByPrincipalId: link.createdByPrincipalId,
 projectIds: [link.projectId], shareLinkId: link.id}
```

- [ ] **Step 1: Write the failing tests.**
  - `PRM-006-B: a guest on a view-and-comment link names themselves and creates, replies to, edits and deletes their own thread`
  - `PRM-006-F: a guest cannot read history, another version's threads (by id), another artifact, or a member route`. Pass the guest principal directly to `ArtifactManagementService.listVersions`, which fails with `ArtifactNotFound`.
  - `PRM-006-F: a view-only guest gets AUTHORIZATION_DENIED on createThread`
  - `PRM-006-F: commenting before naming returns GUEST_IDENTITY_REQUIRED`
  - `PRM-007-B: revoke, rotate and expiry each end the session on the next authenticate`
  - `PRM-007-F: lease stops after target moves`. On a `latest` link, publishing v3 makes the v2 preview lease's next content request 404. Review Focus 2.
  - `PRM-007-F: narrowing guestPermissionsMax removes comment.write on the next request`
  - `PRM-007-B: an archived project masks comment.write and still serves the view`
- [ ] **Step 2: Run the tests.** Run `pnpm vitest run tests/conformance/prm-007-guest-sessions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the service, the guest authorization branch and the content re-checks.**
- [ ] **Step 4: Run the tests again plus `tests/conformance/private-preview-reuse.test.ts` and `cnt-*.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add guest review service with target-only authorization"`

### Task 21: Guest HTTP surface and rate limits

**Files:**
- Create: `src/http/guest-rate-limiter.ts` (the `invite-rate-limiter.ts` pattern)
- Modify: `src/http/create-http-app.ts`
- Test: `tests/http/guest-rate-limiter.test.ts`, `tests/conformance/prm-006-guest-http.test.ts`

**Interfaces:**
- Produces `createGuestRateLimiter(clock: Clock): {check(linkId: string, guestId: string): {allowed: true} | {allowed: false; retryAfterSeconds: number}}`. The limits are 60 per link and 20 per guest over a sliding hour.
- Routes. Guest routes read only `__Host-artifact_guest` and never the member session cookie. Member routes never read the guest cookie.

| Route | Behavior |
| --- | --- |
| `GET /s/:token` | Serves `review.html` with `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow` and `Cache-Control: no-store`. |
| `GET /review/shared/:linkId` | Same, for reloads after the URL is replaced. |
| `POST /api/v1/share/sessions` `{token}` | `startSession`. Sets both guest cookies (HttpOnly, Secure, SameSite=Lax, Path=/) and returns `{context, csrfToken}`. Rate-limited per IP with the invite limiter's IP bucket. |
| `GET /api/v1/share/session` | `authenticate`, returns `{context}`. |
| `PUT /api/v1/share/session/identity` `{displayName, contactEmail}` | `setIdentity`. |
| `POST /api/v1/share/preview-lease` | `issuePreviewLease`. |
| `GET/POST /api/v1/share/threads`, `GET/PATCH/DELETE /api/v1/share/threads/:threadId`, `POST /api/v1/share/threads/:threadId/replies`, `PATCH/DELETE /api/v1/share/threads/:threadId/replies/:replyId`, `POST /api/v1/share/threads/:threadId/resolve`, `/reopen` | Guest comment operations. Every write is gated by `X-CSRF-Token` against the guest CSRF digest and by the rate limiter (429 `GUEST_RATE_LIMITED` with `Retry-After`). |
| `POST/GET /api/v1/projects/:projectId/artifacts/:artifactId/share-links`, `PATCH/DELETE …/share-links/:linkId`, `POST …/share-links/:linkId/rotate` | `ShareLinkService`. |
| `GET /api/v1/share-links` | Inventory. Replaces the public-links listing route; the old route stays as an alias returning the same body. |

- [ ] **Step 1: Write the failing tests.**
  - Limiter unit test: the 21st write for one guest within an hour is refused with `retryAfterSeconds > 0`, and the window frees after the injected clock advances 3600 seconds.
  - `PRM-006-B: GET /s/<token> returns review.html with Referrer-Policy no-referrer and no-store`
  - `PRM-006-F: token not in Referer`. The `/s/<token>` response's `Referrer-Policy` is `no-referrer`, and `POST /api/v1/share/sessions` with the token in the body (not the URL) is the only call that carries it. Review Focus 5.
  - `PRM-006-F: a guest cookie on /api/v1/artifacts returns 401`
  - `PRM-006-F: a member session cookie on /api/v1/share/threads returns 401 GUEST_SESSION_REQUIRED`
  - `PRM-006-F: a guest write without X-CSRF-Token returns 403`
  - `PRM-008-B: the 21st guest comment in an hour returns 429 with Retry-After`
  - `PRM-006-F: unknown, revoked and expired tokens return an identical 404 body`
- [ ] **Step 2: Run the tests.** Run `pnpm vitest run tests/http/guest-rate-limiter.test.ts tests/conformance/prm-006-guest-http.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the limiter and the routes.**
- [ ] **Step 4: Run the tests again plus `tests/conformance/cnt-003-origin-isolation.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Expose share links and the guest review surface over HTTP"`

### Task 22: Guest marker in agent bundles

**Files:**
- Modify: the bundle assembly in `src/mcp/artifact-mcp-server.ts:2190-2310`
- Test: `tests/conformance/prm-008-guest-bundles.test.ts`

**Interfaces:**
- Produces: `export const guestBundleMarker = "[Guest · not a member · via a share link] "` from `src/mcp/dispatch-bundle-message.ts`. For each item whose source comment author has `principalKind === "guest"`, the body becomes `guestBundleMarker + stripInvisibleControls(body)`. Stored comments are unchanged.

- [ ] **Step 1: Write the failing tests.**
  - `PRM-008-B: a dispatched guest thread's bundle item body starts with the marker`
  - `PRM-008-F: a guest body that starts with a forged marker containing U+202E still renders exactly one leading marker, and the bidi character is removed`
  - `PRM-008-B: a member's thread has no marker`
- [ ] **Step 2: Run the tests.** Run `pnpm vitest run tests/conformance/prm-008-guest-bundles.test.ts tests/conformance/brp-002-mailbox-inbox.test.ts`. Expected: the new tests FAIL, and BRP-002 passes.
- [ ] **Step 3: Implement the marker.**
- [ ] **Step 4: Run the tests again plus `tests/conformance/dsp-011-bridge-bundle-render.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Mark guest comments as untrusted in agent bundles"`

### Task 23: Web — share links in the Share popover and the inventory screen

**Files:**
- Modify: `apps/web/src/api/client.ts` (`shareLinkSchema`; `shareLinks(projectId, artifactId)`, `createShareLink`, `updateShareLink`, `rotateShareLink`, `revokeShareLink`, `shareLinkInventory(cursor)`), `apps/web/src/review/workspace/share-popover.tsx` (`ShareScreen` gains `"links"` and `"createLink"`; the overview gets a "Links" section with count and Manage), `apps/web/src/review/settings/public-links-screen.tsx` (heading "Share links"; rows add Permissions, Guests and Created by columns; bare public links show as "Public link · current version"; bulk "Make private" stays at 100), `admin-areas.ts` (label "Share links")
- Create: `apps/web/src/review/workspace/share-link-form.tsx`, `apps/web/src/review/workspace/share-link-model.ts` (+ `.test.ts`)
- Test: `tests/browser/prm-006-share-links.spec.ts`

**Interfaces:**
- Produces:
  - `presetPermissions(preset: "view" | "comment" | "custom", custom: readonly Permission[]): readonly Permission[]`. View is `["artifact.view"]`. Comment is `["artifact.view", "comment.read", "comment.write"]`.
  - `linkSummary(link: ShareLink, now: string): string`, for example "View and comment · This version (v2) · Expires in 6 days · 3 guests".
  - `ShareLinkForm({details, selectedVersion, policy, onCreated, onCancel})`
- Copy:
  - Presets are labeled "View only", "View and comment" and "Custom".
  - Targets are labeled "This version" and "Latest".
  - The revoke confirmation reads "People with this link lose access now. Their comments stay."

- [ ] **Step 1: Write the failing tests.**
  - Model tests: `presetPermissions`, and `linkSummary` for pinned, latest and never-expiring links.
  - Browser:
    - `PRM-006-B: an editor creates a View and comment link from Share, copies it, and sees it listed`
    - `PRM-007-B: revoking from the popover removes it from Settings › Share links`
- [ ] **Step 2: Run the tests.** Run `pnpm --filter @artifact-server/web exec vitest run src/review/workspace/share-link-model.test.ts && pnpm exec playwright test tests/browser/prm-006-share-links.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the client methods, the model, the form, the popover screens and the inventory columns.**
- [ ] **Step 4: Run the tests again plus `tests/browser/admin-console.spec.ts`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Manage share links from Share and Settings"`

### Task 24: Web — guest Review app

**Files:**
- Create: `apps/web/src/review/guest/guest-review-app.tsx`, `guest-model.ts` (+ `.test.ts`), `guest-name-dialog.tsx`, `ended-link.tsx`, `apps/web/src/api/guest-client.ts`
- Modify:
  - `apps/web/src/review/main.tsx`: paths starting `/s/` or `/review/shared/` render `GuestReviewApp`.
  - `apps/web/src/review/review-comments.tsx`: `useReviewComments` takes a `CommentsTransport`, and the member transport keeps today's calls.
  - `apps/web/src/review/workspace/comments-tab.tsx`: a guest author renders a "Guest" badge and the link label. The composer's first submit opens the name dialog when `displayName` is null.
- Test: `tests/browser/prm-006-guest-review.spec.ts`

**Interfaces:**
- Produces:
  - `interface CommentsTransport { listThreads(versionId: string, cursor: string | null): Promise<ThreadPage>; getThread(threadId: string): Promise<ThreadDetail>; createThread(body: CreateThreadBody, idempotencyKey: string): Promise<ThreadDetail>; createReply(threadId: string, body: string, idempotencyKey: string): Promise<ReplyRecord>; updateThread(...); updateReply(...); resolve(threadId: string): Promise<ThreadDetail>; reopen(threadId: string): Promise<ThreadDetail>; deleteThread(threadId: string): Promise<void>; deleteReply(threadId: string, replyId: string): Promise<void> }`. The types are the existing client types.
  - `memberCommentsTransport(projectId, artifactId)`, and `guestCommentsTransport()` in `guest-client.ts` (guest CSRF from the `__Host-artifact_guest_csrf`-paired value returned by `POST /api/v1/share/sessions` and held in memory)
  - `guestShellControls(permissions: readonly Permission[]): {comments: boolean; annotate: boolean; composer: boolean}`
  - `GuestReviewApp()`:
    1. When the path is `/s/<token>`, read the token, POST it, and call `history.replaceState(null, "", "/review/shared/<linkId>")` before rendering the preview.
    2. On `/review/shared/*`, `GET /api/v1/share/session`.
    3. Render `PreviewCanvas` with the guest preview lease in Interactive mode, the platform and theme controls, the banner "Viewing as a guest via a link shared by `createdByName`" (with "· Expires `date`" when one is set), and `CommentsTab` with the guest transport when `comments` is true.
  - `EndedLink()` copy: "This link has ended or isn't valid. Ask the person who shared it for a new one."
  - `GuestNameDialog` copy: "Your name, shown next to your comments" (required), and "Email (optional) — only members of this workspace can see it".

- [ ] **Step 1: Write the failing tests.**
  - Model: `guestShellControls(["artifact.view"])` returns all false. `guestShellControls(["artifact.view", "comment.read"])` shows comments only. Adding `"comment.write"` makes all three true.
  - Browser:
    - `PRM-006-B: a guest opens a View and comment link, the address bar no longer contains the token, the page is in Interactive mode, names themselves on first comment, and the member sees the comment with a Guest badge`
    - `PRM-006-B: a View only guest sees no Comments tab, Annotate switch, Versions, Files, Details, Share or navigation`
    - `PRM-007-B: after the member revokes the link, the guest's next action shows the ended page`
- [ ] **Step 2: Run the tests.** Run `pnpm --filter @artifact-server/web exec vitest run src/review/guest && pnpm exec playwright test tests/browser/prm-006-guest-review.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the transport refactor, the guest app, the dialog, the ended page and the badge.**
- [ ] **Step 4: Run the tests again plus the existing comment browser specs** (`pnpm exec playwright test tests/browser --grep CMT`). Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add the guest Review app with link-scoped controls"`

### Task 25: Part B gate

**Files:**
- Modify: `project/spec/conformance.yml` (PRM-006…008 move to `behavior_verified` with evidence; recheck PRM-001 against schema 24/26/22), `docs/deployment.md` ("Share links and guest review": presets, policy ceilings, rate limits, what a guest can and can't see, and that copied bytes can't be recalled), `deploy/cloudflare/README.md`, `project/spec/frontend-mvp-developer-handoff.md` (guest routes)

- [ ] **Step 1: Run `BROWSER_CRITICAL_ENGINES=all pnpm test:web`.** Expected: PASS on all three engines. Review sandboxing, preview leases and comment convergence all changed, so this matrix is required (AGENTS.md).
- [ ] **Step 2: Run `pnpm smoke`**, because HTTP delivery and SQLite changed. Expected: PASS.
- [ ] **Step 3: Run `pnpm verify:iteration`.** Expected: exit 0.
- [ ] **Step 4: Update the ledger and docs.** Run `pnpm conformance:validate && pnpm conformance:tests`. Expected: PASS. Report any PRM requirement that still lacks external-storage or Cloudflare evidence as specified-but-unproved. Do not mark it verified.
- [ ] **Step 5: Commit.** `git commit -m "Record share link and guest review verification evidence"`
