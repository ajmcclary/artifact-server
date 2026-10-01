# Activity feed, Projects and Admin console — design

Date: 2026-10-01
Status: approved in conversation; awaiting written-spec review
Source: `~/Dev/Design` at `e087280` (`arkcase-artifacts/project/App.dc.html`,
`workspace/projects/arkcase-artifacts/`), and the prototype's own spec
`docs/superpowers/specs/2026-09-30-artifacts-activity-redesign-design.md`.

## Intent

Bring the prototype's 09/30 redesign into Artifact Server. The product should
let a member catch up on everything that happened across the installation and
then act on what needs attention, browse projects beside their settings, and
administer the installation from one console, without placeholder or
prototype text.

### What the user decided

- One combined spec covering the component update, Activity, Projects and
  Admin.
- Track the low-cost Admin fields: member last active and admitted by, key
  last used, made public on/by, and the actor on deactivate and revoke.
  Public-link view counts and link expiry stay out.
- Every member sees actor display names in the feed. Email and role are never
  shown. Admin events are administrators only.
- "Needs you" keeps the prototype rule: an open thread that no active dispatch
  holds. It is the same for every viewer.
- Projects follows the prototype as of `e087280` (a docked list beside the
  settings), adds a per-project Activity section, and project folders open it.
- Approach 1: the existing `actions` table becomes the installation's single
  activity log.
- Conversation cards show real thumbnails, loaded lazily.

### Source of truth

The prototype at `e087280` sets the visual design. Its 09/30 spec fills only
the gaps that commit leaves unfinished:

- admin events in the feed;
- the full copy cleanup;
- folders opening Projects.

Where the prototype shows something the server cannot back, the server's real
behaviour wins and the control is omitted. It is not shown disabled.

### Success criteria

1. Activity replaces the review queue at `/review`. It matches the prototype's
   feed: header, metric cards, docking toolbar, sticky day headers,
   conversation cards with docking heads and thumbnails, folded threads,
   bursts, and paging.
2. Projects and the Admin console match the prototype's layouts at `e087280`,
   with the adjustments in this spec.
3. Every feed entry comes from immutable, server-recorded actions. Nothing is
   invented. An unknown actor shows as "Unknown".
4. Every printed date and time uses `MM/DD/YYYY` and `h:mm AM/PM` in local time.
5. No rendered text contains prototype annotation.
6. The new ACT requirements and the updated ADM and NAV requirements carry
   passing normal and hostile evidence. `pnpm verify:iteration` and
   `BROWSER_CRITICAL_ENGINES=all pnpm test:web` pass.

## Scope

In scope:

- Re-sync the component tree. Vendor the activity UI and model.
- Extend the activity log and recover existing rows, in SQLite, Postgres and D1.
- `ActivityService` with the `/activity` and `/activity/summary` endpoints.
- Last-active and last-used tracking. The admitted-by field.
- Navigation, the Activity screen, the Projects screen and the Admin console.
- Copy rule and copy test. Ledger, product-spec prose and evidence.

Out of scope:

- Public-link view counts and link expiry.
- Member role change, the member recent-activity list and the expiring-soon
  key pill.
- The project "Publishing defaults" and "Access and membership" panels. They
  have no backend.
- Web upload publishing. "Publish artifact" shows the CLI command.
- An MCP tool for reading activity. Notifications, unread state, digests.
- Streaming or polling feed updates.
- Per-project membership.
- Prototype-only affordances: DemoPanel, DemoChip, DemoDock and the Horizontal
  Tabs navigation variant.

## 1. Activity log (persistence)

### Schema

One migration per backend:

- SQLite: `sqlite-artifact-repository.ts` `#migrate`, which raises `user_version`.
- Postgres: a new named entry in `postgres-migrations.ts`.
- D1: `deploy/cloudflare/src/d1-migrations.ts`.

Changes to `actions`:

- `artifact_id` and `version_id` become nullable. A CHECK keeps them required
  for artifact kinds: publish, restore, change_access, change_tags, delete,
  link, capture, relink, every `comment_*`, and `public_link_*`.
  - The existing foreign keys stay. They apply when the value is present.
  - Postgres drops `NOT NULL` in place.
  - SQLite and D1 copy into a new table, then swap. IDs, idempotency keys and
    timestamps are preserved. Row counts and an order-independent checksum of
    `(id, idempotency_key, created_at)` must match before the swap.
- New nullable columns:

| Column | Meaning |
|---|---|
| `project_id` | Already populated for artifact kinds. Null only for installation-level admin rows. |
| `thread_id`, `reply_id` | The comment thread and reply acted on. |
| `subject_id` | The member, key, dispatch or project acted on. |
| `access_from`, `access_to` | `account_required` or `public_link`. |
| `actor_name`, `actor_kind` | A snapshot of the actor's display name and principal kind at write time, the same as comment authors. |
| `detail_json` | Small per-kind data: key capabilities, dispatch recipients and thread IDs, project name. Validated, at most 4 KiB. |

- New kinds:

| Kind | Notes |
|---|---|
| `member_admit`, `member_deactivate` | |
| `key_issue`, `key_rotate`, `key_revoke` | |
| `dispatch_create`, `dispatch_addressed` | |
| `public_link_enable`, `public_link_disable` | Written beside `change_access` when access changes direction, and on a publish that sets public-link access. |
| `project_create`, `project_archive`, `project_unarchive` | |

- Indexes:
  - `(installation_id, created_at DESC, id DESC)`
  - `(installation_id, project_id, created_at DESC, id DESC)`
  - `(installation_id, thread_id)`

Postgres also extends its `action` CHECK. It lists only the original five
kinds today.

### Writes

- Every action row is inserted in the same transaction as its mutation, keyed
  by the mutation's idempotency key, so a replay writes nothing.
- Today the identity repositories (members, keys) write separate tables. They
  gain the insert through the same database handle and transaction.
- `dispatch_addressed`: when an agent principal replies on a thread held by an
  active dispatch, that reply's transaction also writes `dispatch_addressed`
  with `subject_id` set to the dispatch ID.
- The `actor_name` snapshot comes from the member display name, or for a
  service principal from the key name and owner. Later renames do not rewrite
  history.

### Recovering existing rows

Recovery runs once inside the migration, using only recorded data:

- `thread_id` is parsed from `comment:<threadId>:<uuid>` idempotency keys.
- `access_to` comes from `idempotency_records.access_setting`. `access_from` is
  the previous recorded setting for the same artifact, when one exists.
- `actor_name` comes from current member names, or comment author snapshots
  for comment kinds.
- `member_admit` rows are reconstructed from `members.created_at`. `key_issue`
  rows come from `api_keys.created_at` and `authorized_by_principal_id`.
  `key_revoke` rows come from `revoked_at`, with the actor unknown.
  `dispatch_create` rows come from dispatch records.
  `project_create` and `project_archive` rows come from project timestamps.
- Reconstructed rows get deterministic IDs derived from their subject (for
  example `recovered:member_admit:<memberId>`), so a repeated migration cannot
  duplicate them.
- A missing actor stays null and shows as "Unknown".

### Port

`ActivityLog` in `src/core/ports.ts` has one read method:

```ts
listActivity(query: ActivityQuery): Effect<ActivityPage, StorageError>
```

It is separate from `ArtifactRepository`. Each backend implements it in its
own SQL.

## 2. Activity service and API

### `ActivityService` (`src/application/activity.ts`)

- An Effect `Context.Service` that depends on `ActivityLog`, the comment and
  dispatch repositories, and `Clock`.
- It owns visibility and the "Needs you" rule. Storage only runs queries.

### `GET /api/v1/activity`

Parameters:

| Parameter | Values |
|---|---|
| `project` | Repeatable. |
| `type` | Repeatable: `comments`, `versions`, `agents`, `access`, `admin`. |
| `segment` | `all`, `needs_you` or `with_agent`. |
| `q` | Trimmed, at most 100 characters. |
| `cursor` | Opaque. Validated like the existing `PageCursor` reads. |
| `limit` | Default 30, maximum 100. |

Response: `{ items: ActivityEntry[], nextCursor }`, newest first, keyset-paged
on `(at, id)`.

Every entry carries `id`, `kind`, `at`, `actor {name | null, kind}`,
`project {id, name}`, `artifact {id, name, archived} | null` and
`versionNumber | null`.

| Kind | Source kinds | Extra fields |
|---|---|---|
| `thread` | `comment_create`, `comment_reply` (latest per thread) | `verb` (commented or replied), `thread {id, opener, replies (newest two), replyCount, isResolved, state, anchor}` |
| `version` | `publish`, `restore` | `verb` |
| `resolution` | `comment_resolve`, `comment_reopen` | `threadId`, first line of the opener |
| `thread_deleted` | `comment_delete` | `threadId` |
| `agent` | `dispatch_create`, `dispatch_addressed` | `agentName`, `dispatchState`, `threadIds` |
| `access` | `public_link_enable`, `public_link_disable` | `from`, `to` |
| `admin` | `member_*`, `key_*`, `project_*` | `verb`, `subject {id, name}` |

Rules for thread entries:

- A thread is one entry, dated by its latest create or reply. A window
  function keeps the newest row per `thread_id`.
- A deleted thread has no `thread` entry. Its `thread_deleted` entry remains.
- "Show N earlier replies" fetches the full thread from the existing
  per-artifact comments endpoint.

Search matches actor name, artifact name, project name and comment text. It
uses parameterized, escaped `LIKE`.

Type mapping:

- `comments`: thread, resolution and thread_deleted.
- `versions`: version.
- `agents`: agent.
- `access`: access.
- `admin`: admin.

### Needs you, evaluated per thread

- An open thread not held by a dispatch in `queued`, `claimed` or `delivered`
  is `needs_you`.
- An open thread held by such a dispatch is `with_agent`.
- A closed thread is `resolved`.
- `segment=needs_you` and `segment=with_agent` return only thread entries in
  that state. `with_agent` also returns agent entries whose dispatch is active.

### `GET /api/v1/activity/summary?project=`

Returns:

```json
{ "needsYou": 0, "withAgent": 0, "openConversations": 0, "artifactsInReview": 0,
  "projects": [{ "id": "", "artifactCount": 0, "unresolved": 0, "lastActivityAt": "" }] }
```

- Counts come from one grouped query over open threads and active dispatches.
- `artifactsInReview` counts artifacts that have at least one open thread.
- This endpoint drives the nav badge, the metric cards and the Projects list.

### Visibility

- An active member session, or a key with read capability, sees every project
  in its installation, with actor display names.
- Admin kinds `member_*` and `key_*` are returned only to administrators.
  `project_*` is visible to every member.
- For a non-administrator, `type=admin` returns only `project_*` entries. It is
  not an error.
- An unknown or other-installation `project` ID returns the same empty or
  not-found shape as other project-scoped reads, without revealing whether it
  exists (PRJ-002-F).

### Freshness

The client inserts its own successful mutations at the top straight away. It
reloads the first page after each mutation and when the window regains focus.
There is no streaming or polling.

## 3. Admin tracking

### Last active and last used

- New columns: `members.last_active_at` and `api_keys.last_used_at`.
- The port `PrincipalActivityRecorder.touch(principalId, at)` is called after
  authentication succeeds.
- It runs one conditional update:
  `… WHERE last_active_at IS NULL OR last_active_at < :at - 5 minutes`. That is
  at most one write per principal every five minutes. It is safe across
  processes and an idempotent no-op otherwise.
- A failure is logged and swallowed. It never fails or delays the request; the
  touch runs after the response (`waitUntil` on Workers).

### Admitted by

- New column: `members.admitted_by_principal_id`, set by `POST /members`.
- `admittedHow` takes one of three values:
  - `manual`: admitted by `POST /members`;
  - `automatic`: OIDC auto-admit;
  - `owner`: the local owner bootstrap.
- Existing rows are null and show "—".

### Derived from the log

- Deactivated by and revoked by come from `member_deactivate` and `key_revoke`.
- Made public on and by come from the newest `public_link_enable` for the
  artifact. When no such row exists, the field shows "—".

### API additions

Additive only. Existing clients and the zod schemas stay compatible.

| Endpoint | New fields |
|---|---|
| `GET /api/v1/members` | `lastActiveAt`, `admittedAt`, `admittedBy {name} \| null`, `admittedHow` |
| `GET /api/v1/api-keys` | `lastUsedAt`, `ownerName`, `status` (active, revoked or expired), `revokedAt`, `revokedBy {name} \| null` |
| `GET /api/v1/administration/public-links` | `madePublicAt`, `madePublicBy {name} \| null` |

## 4. Web foundation

### Component re-sync

- Move `apps/web/src/arkcase/` from `804cd4a` to `e087280` with
  `scripts/sync-arkcase-ds.mjs`. This brings:
  - the `PageScaffold` `head="scroll"` option;
  - the `CommentThread` options `visibleReplies`, `expandedIds` and
    `onToggleReplies`;
  - `FileList` and `Disclosure` `inset`;
  - the Files panel edge and indent changes in `review-ui.jsx`.
- Add these entries and their imports to `scripts/arkcase-ds-entries.json`:
  - `data-display/Timeline`
  - `ScrollDock`
  - `MetricCard`
  - `AnnotationPin`
  - `DataGrid`
  - `navigation/SideNav`
  - `navigation/Breadcrumb`
- Change `reviewUi` from one path to a list:
  - `review-ui.jsx`
  - `activity-ui.jsx`
  - `activity-model.js`
- `pnpm check:arkcase-ds` continues to reject hand edits.
- The 25% bundle-size stop from the 09/29 redesign applies. If `DataGrid`
  trips it, Admin uses the vendored `RecordTable` instead.

### Vendored activity model

- `apps/web/src/review/activity/activity-adapter.ts` maps API entries to the
  model's event shape. That shape includes `atMs`, `type`, `actor`,
  `artifactName`, `version`, `thread` and `withAgent`.
- The web uses `mergeBursts`, `groupByDay`, `dayLabel`, `usDate`, `usTime` and
  `usDateTime`. Filtering, segments and paging are server-side.
- After each page load, `mergeBursts` re-runs over the concatenated list, so a
  burst that spans a page boundary still merges.
- `activity-adapter.test.ts` runs the prototype's 15 model cases against
  API-shaped input.

### Dates

`lib/presentation.ts` `formatTimestamp` and the design library's formatter
are replaced by the vendored US formatters on every screen.

### Navigation (`shell/nav-model.ts`)

- **Review group:**
  - Activity: `/review`, icon `bi-activity`, with a Needs-you badge.
  - Projects: `/review/projects?project=`.
  - Design library: `/review/library`, rolled up across all projects.
- **Projects group:** one folder per project, plus New project. A folder opens
  `/review/projects?project=<id>`.
- **Tools group:** Administration (`bi-gear`), for administrators only. It
  opens Members. The account menu also has Administration.
- Admin mode and "Back to review" are removed.
- A full-width Quick Search sits under the brand lock-up (LeftNav `search`
  slot, Cmd/Ctrl+K and `/`). Rail mode shows a search icon.
- Redirects:
  - `/review/settings/projects` and `/review/settings/project?id=` go to
    `/review/projects`.
  - `/review/library?project=` still loads.
- NAV-001 applies to every new route: navigation happens in place, modified
  clicks open new tabs, and screens stay steady while they load.

## 5. Activity screen (`apps/web/src/review/activity/`)

This replaces `review/queue/`. The queue model and screen are removed after
the Activity screen proves parity.

### Head

- It scrolls with the body.
- H1 "Activity", meta "N projects · M artifacts".
- "Publish artifact" opens a popover with the copyable
  `artifactserver publish` command.
- Four MetricCards:
  - Needs you and With an agent, which toggle the segment;
  - Open conversations and Artifacts in review, which are display only.

### Toolbar

- A ScrollDock that docks with a shadow.
- SegmentedControl: All, Needs you (n), With an agent (n).
- Projects and Types checkbox menus.
- "Search activity", debounced at 250 ms.
- Filters live in the URL (`?segment=&project=&type=&q=`).

### Timeline

- Sticky day headers under the toolbar: "Today", "Yesterday",
  "Mon 04/13/2026".
- Entries come from the vendored `ActivityFeed`.
- Reply (inline `CommentComposer`) and Resolve use the existing comment
  endpoints.
- Open goes to the workspace with the thread selected.
- "Show older (n)" loads the next cursor page.
- Fold state is kept per thread for the session.

### Conversation cards

- The head docks to one line on scroll: name, "Your turn" pill, facts, Open.
- At rest the head shows a 160×100 thumbnail.

### Thumbnails

- The thumbnail loads the thread's exact version in the existing Review
  sandbox, at 800px wide scaled to 0.2.
- It loads only when the card nears the viewport (IntersectionObserver), with
  at most four loading at once.
- `AnnotationPin` sits at the thread's anchor.
- A file that is not HTML, has no anchor, or fails to load shows a file-type
  tile.
- The Application CSP is unchanged.

### States

- Loading uses skeletons.
- An empty or fully filtered feed shows SurfaceState with "Clear filters".
- A feed failure shows SurfaceState with Try again.
- A summary failure shows the cards as "—" and hides the badge. The feed still
  works.
- An archived artifact keeps its entries with an Archived tag. Open is
  disabled, with a tooltip giving the reason.

## 6. Projects screen (`/review/projects`)

### Layout

- The review frame's resizable list Panel (240–460px) docks beside the detail.
  It can be pinned or peek from a rail.
- Below 768px the list opens as a sheet from the page head.

### List

- RailHeader "Projects" with a "+" New project button, using the existing
  create flow.
- "Search projects", with a footer showing "x of y".
- Rows show the name, an Archived pill, an "N unresolved" badge and
  "N artifacts · last activity", using the summary endpoint.
- Selecting a row replaces `?project=`.

### Detail

- PageScaffold with `head="scroll"` and no maximum width.
- The server's existing sections:
  - Project identity (rename);
  - Project lifecycle (archive and unarchive, with confirmation);
  - Git history, when available;
  - Artifacts in this project (ledger, with copy-link on each row).
- New: **Activity**, the feed filtered to this project, with "Show older".
- A head action, "Open latest artifact".

### Empty project

The CLI publish state, with the body "Publish a file or folder to create
version 1."

## 7. Admin console (`review/settings/admin-console.tsx`)

### Frame

- An area menu: a SideNav labelled "Administration areas".
  - People and access: Members, API keys.
  - Sharing: Public links.
  - Integrations: MCP & WebMCP.
- The menu can be pinned and resized (184–340px, default 224px). Width and pin
  persist in browser storage.
- On phones the menu becomes a Select in the head.
- The head shows a Breadcrumb ("Administration › Area"), an H1 and a
  one-line lede.
- Destructive actions confirm in a danger Modal.
- The detail opens in a 360px docked SlideOver, which stacks below 900px.
- Routes stay `/review/settings/{members,apiKeys,publicLinks,mcp}`.
  `?selected=<id>` reopens a detail.

### Members

- RecordPanel with a "+" Admit button, a DataGrid and a quick filter.
- Columns: Member (avatar and name, opens the detail), Email, Role, Status
  pill, Last active.
- Subtitle "N members · M active".
- Row menu: Deactivate, while active.
- The SlideOver shows Role, Admitted, Admitted by ("Automatic", "Installation
  owner" or a name) and Last active. Deactivate is in its footer.

### API keys

- Columns: Key (name and prefix), Owner, Capabilities (count), Last used,
  Expires, Status.
- "+" opens the existing issue flow, which shows the secret once.
- Row menu: Revoke, Rotate.
- The SlideOver shows created, last used, expires, capability tags, and
  revoked on and by.

### Public links

- Columns: Artifact (opens it), Project, Version, Link (with copy), Made
  public (date and by).
- Row menu: Make private, with confirmation.
- No detail pane.

### MCP & WebMCP

Four stacked panels:

- Local installation: `artifactserver connect` with client tags.
- Remote endpoint, with copy.
- The tool-group table.
- The WebMCP switch and tool tags.

### Non-administrators

- The nav item and account-menu entry are absent.
- A direct URL shows the existing not-authorized state.
- The server enforces access in every case.

## 8. Copy rule

- Labels and empty states come from the prototype at `e087280`.
- Designer annotation and prototype disclaimers are never ported, including
  everything in the prototype spec's §4 "Removed" list.
- A web unit test renders each new screen's main states. It fails on
  "prototype", "fixture", "demo", "local example", "browser-local" or
  "unavailable in".

## 9. Error handling

- **Migration failure:** the transaction rolls back and the server refuses to
  start, naming the migration. A rerun after an interrupted copy completes
  cleanly.
- **Tracking:** a `touch` failure is logged and ignored.
- **Inline actions:** a failed Reply or Resolve keeps the draft (existing
  `comment-drafts`) and shows a toast.
- **Unknown actors:** "Unknown". Deleted threads are handled as in §2.
  Archived artifacts are handled as in §5.
- **Filters:** a filter change that hides the selected Projects row or Admin
  record closes its detail and moves focus to the list.

## 10. Conformance ledger

New requirements in `project/spec/conformance.yml`, backed by new product-spec
prose in `artifact-server-product-spec.html` (Activity and Projects sections):

| ID | Behavior (B) | Failure (F) |
|---|---|---|
| ACT-001 | Every mutation, including admin and dispatch actions, writes exactly one action in its transaction, with actor snapshot. | A replay writes nothing. A mutation cannot commit without its action. |
| ACT-002 | Populated SQLite, Postgres and D1 installations migrate with IDs, keys and timestamps preserved, and recoverable fields recovered. | An interrupted or repeated migration cannot duplicate, drop or alter rows, or invent actors. |
| ACT-003 | The feed API pages, folds threads, filters, segments and searches. | Forged cursors, oversized limits, other installations' IDs and non-admin admin-kind requests fail safely without disclosure. |
| ACT-004 | Summary and segment counts agree with the per-thread rule. | Resolved, canceled-dispatch and deleted threads are never counted. |
| ACT-005 | The Activity screen shows the feed, folding, inline Reply and Resolve, bursts, sticky days, US dates, URL filters and lazy sandboxed thumbnails. | A thumbnail cannot escape the Review sandbox or load a version other than the thread's. Failures degrade to tiles and states. |
| ACT-006 | The Projects screen lists projects with counts and shows settings and project activity. Folders open it. | A filtered-out selection clears and returns focus. No invented ACL or panel. |
| ACT-007 | Last active and last used update at most once per five minutes per principal. | A tracking failure never fails or slows a request. |
| ADM-008 | The Admin console areas, detail panes, deep links and confirmations work. | Non-administrators see no entry, and the server refuses admin reads. |

Updated: AUD-001 (evidence from ACT-001), ADM-002, ADM-003, ADM-004, ADM-005
and NAV-001 (routes and fields).

## 11. Testing

All tests are named with their B and F IDs. They use real SQLite, HTTP and
temporary storage, with no module mocks.

- **Storage and service:**
  - `tests/conformance/act-00x-*.test.ts` against SQLite and HTTP.
  - Postgres integration tests in `tests/integration/`.
  - D1 through the Cloudflare check.
- **Migration:**
  - A populated `user_version` 17 database migrates and its rows are compared.
  - The migration is interrupted mid-copy and the process restarted.
  - The migration is repeated.
  - Postgres runs the same checks.
- **Web unit:**
  - The activity adapter, run against the 15 prototype cases.
  - `review-routes`, including redirects.
  - `nav-model`.
  - The copy test.
- **Browser:**
  - New `activity.spec.ts`, `projects.spec.ts` and `admin-console.spec.ts`.
  - Updated `shell-navigation`, `ux-continuity`, `review-queue` (retired or
    retargeted), `accessibility` (axe on every new screen) and `csp-clean`
    (thumbnail frames).
  - `BROWSER_CRITICAL_ENGINES=all pnpm test:web`.
- **Performance:**
  - `pnpm perf:baseline` before and after slice 3, and again after slice 4.
  - A new bounded case: first activity page and summary over 100k actions.
  - `pnpm smoke`, `pnpm verify:external-storage-runtime` and
    `pnpm verify:external-storage-performance`.
- **Gate:** `pnpm verify:iteration`.

## 12. Delivery slices

Each slice is committed, verified and has evidence attached on its own.

1. Component re-sync and new entries, the US date formatters, and the Files
   panel.
2. Activity log schema, migration and recovery in all three backends, plus
   writes for the new kinds (ACT-001, ACT-002, AUD-001).
3. Last-active and last-used tracking, admitted-by, and the Admin API fields
   (ACT-007, ADM-003 to ADM-005).
4. `ActivityService`, `/activity` and `/activity/summary` (ACT-003, ACT-004).
5. Navigation, the Activity screen and thumbnails (ACT-005, NAV-001).
6. Projects screen (ACT-006, ADM-002).
7. Admin console (ADM-008).
8. Copy test, docs (`NEXT-STEPS.md`, `docs/claude-design.md`) and final
   evidence.

## Risks

| Risk | Mitigation |
|---|---|
| SQLite or D1 table copy time on large installations | Measure at 1M actions. Stop for a decision if it exceeds 30 s. |
| D1 statement and transaction limits | Batch the copy if needed. Prove it with the Cloudflare check. |
| Bundle growth, with DataGrid the most likely cause | 25% stop. Fall back to RecordTable. |
| Thumbnail cost and sandbox exposure | Load near the viewport only, at most four at once. Exact-version leases. Cross-engine matrix. |
| Hot auth path from `touch` | Conditional update, run after the response. Perf baseline before and after. |
