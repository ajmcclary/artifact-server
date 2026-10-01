# Activity Feed, Projects and Admin Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the review queue with a server-backed installation Activity feed, add a Projects screen and an Admin console, and re-sync the ArkCase components, matching the prototype at Design `e087280`.

**Architecture:**
- The existing append-only `actions` table becomes the installation's single activity log in all three backends (SQLite, Postgres, D1). This covers new columns, new kinds, recovery of existing rows, and writes from the identity and dispatch repositories.
- A new `ActivityService` sits behind a narrow `ActivityLog` port. It serves a cursor-paged `/api/v1/activity` endpoint and a `/api/v1/activity/summary` endpoint.
- The web app vendors the prototype's activity UI and model through the ArkCase sync script. It adapts API entries into that model and builds the Activity, Projects and Admin console screens from vendored ArkCase components.

**Tech Stack:**
- Server: TypeScript, Effect (`Context.Service`, `Effect.fn`), Hono, `node:sqlite`, Postgres (`postgres-database.ts`), Cloudflare D1, zod, vitest.
- Web: React 19 and Vite in `apps/web`, Playwright in `tests/browser`.

**Spec:** `docs/superpowers/specs/2026-10-01-activity-projects-admin-design.md`. Read it before any task; section numbers below refer to it.

## Global Constraints

### Repository rules (from `AGENTS.md`)

- No module mocks. Use real SQLite databases, temporary disk storage and real HTTP (`tests/support/runtime-harness.ts`: `createTestInstallation`, `startTestServer`).
- Name every conformance test with its requirement ID, for example `test("ACT-003-B …")` or `test("ACT-003-F …")`.
- Do not weaken TypeScript, Oxlint or the anti-slop rules.
- Before writing any Effect code, read `node_modules/effect/AGENTS.md` completely.
- Keep product logic independent of SQLite, Postgres, D1, HTTP and MCP.
- Put concrete providers behind narrow ports named for product behaviour.
- `scripts/arkcase-ds-entries.json` `reviewUi` stays a single path. `review-ui.jsx` imports `activity-ui.jsx`, which imports `activity-model.js`, so the sync script picks both up.
- Never edit files under `apps/web/src/arkcase/` by hand. Change `~/Dev/Design` or `scripts/arkcase-ds-entries.json`, then run `node scripts/sync-arkcase-ds.mjs`. `pnpm check:arkcase-ds` must pass.
- Preserve immutable IDs, idempotency keys and `created_at` values across migrations, retries and restarts.

### Formats

- Every printed date and time is `MM/DD/YYYY` and `h:mm AM/PM`, in local time.
- Use the vendored `usDate`, `usTime` and `usDateTime` formatters.

### Feed API limits

| Parameter | Limit |
|---|---|
| `limit` | default 30, maximum 100 |
| `q` | trimmed, at most 100 characters |
| `detail_json` | at most 4 KiB |
| per-thread replies in a feed entry | the newest 2 |

### Tracking and thumbnails

- Last-active and last-used tracking writes at most once per principal per 5 minutes.
- Thumbnails load only near the viewport, with at most 4 loading at once.

### Copy rule

- Never render "prototype", "fixture", "demo", "local example", "browser-local" or "unavailable in" on any new screen.
- An unknown actor renders as "Unknown". A missing date renders as "—".

### Delivery gates

- Bundle size: stop and report if the web bundle grows more than 25% over the slice-1 baseline. If `DataGrid` is the cause, Admin uses `RecordTable`.
- Migration: stop and report if the SQLite table copy exceeds 30 s at 1,000,000 actions.
- Every slice ends green on `pnpm check`. The final slice ends green on `pnpm verify:iteration` and `BROWSER_CRITICAL_ENGINES=all pnpm test:web`.

### Commits and hand-off

- Commit messages are sentence-case imperative, matching the repo log (for example "Record administration actions in the activity log").
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Report any requirement still specified but not proved; never mark evidence optimistically.

## Shared Interfaces

Every task uses these exact names. A task that needs a name not listed here must define it in its own **Produces** block.

### `src/core/model.ts`

```ts
/** Artifact-scoped kinds: artifact_id and version_id are always present. */
export const artifactActionKinds = {
  /* …existing 14 kinds unchanged… */
  publicLinkDisable: "public_link_disable",
  publicLinkEnable: "public_link_enable",
} as const;

/** Installation-scoped kinds: artifact_id and version_id are null. */
export const installationActionKinds = {
  dispatchAddressed: "dispatch_addressed",
  dispatchCreate: "dispatch_create",
  keyIssue: "key_issue",
  keyRevoke: "key_revoke",
  keyRotate: "key_rotate",
  memberAdmit: "member_admit",
  memberDeactivate: "member_deactivate",
  projectArchive: "project_archive",
  projectCreate: "project_create",
  projectUnarchive: "project_unarchive",
} as const;
export type InstallationActionKind =
  (typeof installationActionKinds)[keyof typeof installationActionKinds];
export type ActionKind = ArtifactActionKind | InstallationActionKind;

/** Who performed an action, snapshotted at write time. */
export interface ActorSnapshot {
  readonly displayName: string;
  readonly kind: PrincipalKind;
}

/** One row of the installation activity log, as the activity read model sees it. */
export interface ActivityActionRow {
  readonly accessFrom: AccessSetting | null;
  readonly accessTo: AccessSetting | null;
  readonly action: ActionKind;
  readonly actor: ActorSnapshot | null;       // null = unknown (recovered rows)
  readonly artifactId: string | null;
  readonly createdAt: string;                  // ISO
  readonly detail: Readonly<Record<string, unknown>> | null;
  readonly id: string;
  readonly principalId: string | null;
  readonly projectId: string | null;
  readonly replyId: string | null;
  readonly subjectId: string | null;
  readonly threadId: string | null;
  readonly versionId: string | null;
}
```

`ArtifactActionRecord` and `GET /api/v1/artifacts/:id/actions` stay byte-for-byte unchanged. `tests/conformance/cmt-011-*` parses them with `.strict()`. The per-artifact listing keeps returning only the original 14 artifact kinds; it excludes `public_link_*` and every installation kind.

### `src/core/ports.ts`

```ts
export type ActivityType = "comments" | "versions" | "agents" | "access" | "admin";
export type ActivitySegment = "all" | "needs_you" | "with_agent";

export interface ActivityQuery {
  readonly cursor: PageCursor | null;
  readonly includeAdministration: boolean;   // false → exclude member_* and key_*
  readonly limit: number;                    // 1..100, already clamped
  readonly projectIds: readonly string[];    // empty = every project
  readonly search: string | null;            // normalized, ≤100 chars
  readonly segment: ActivitySegment;
  readonly types: readonly ActivityType[];   // empty = every type
}

/** Thread state per spec §2 "Needs you". */
export type ActivityThreadState = "needs_you" | "with_agent" | "resolved";

export interface ActivityThreadSnapshot {
  readonly anchor: unknown;
  readonly id: string;
  readonly isResolved: boolean;
  readonly opener: CommentThreadRecord;
  readonly replies: readonly CommentReplyRecord[];  // newest two, oldest first
  readonly replyCount: number;
  readonly state: ActivityThreadState;
}

export interface ActivityRow {
  readonly action: ActivityActionRow;
  readonly artifact: {readonly id: string; readonly name: string; readonly archived: boolean} | null;
  readonly dispatch: {readonly agentDisplayName: string; readonly state: AgentDispatchState; readonly threadIds: readonly string[]} | null;
  readonly project: {readonly id: string; readonly name: string} | null;
  readonly excerpt: string | null;                 // first line of the opener, for resolution rows
  readonly thread: ActivityThreadSnapshot | null;   // only for latest-per-thread comment rows
  readonly versionNumber: number | null;
}

export interface ActivityPage {
  readonly items: readonly ActivityRow[];
  readonly nextCursor: PageCursor | null;
}

export interface ActivityProjectSummary {
  readonly artifactCount: number;
  readonly id: string;
  readonly lastActivityAt: string | null;
  readonly unresolved: number;
}

export interface ActivitySummary {
  readonly artifactsInReview: number;
  readonly needsYou: number;
  readonly openConversations: number;
  readonly projects: readonly ActivityProjectSummary[];
  readonly withAgent: number;
}

/** Read side of the installation activity log. Promise-based like every core port. */
export interface ActivityLog {
  readonly listActivity: (query: ActivityQuery) => Promise<ActivityPage>;
  readonly summarizeActivity: (projectIds: readonly string[]) => Promise<ActivitySummary>;
}

/** Throttled last-active / last-used tracking (spec §3). */
export interface PrincipalActivityRecorder {
  readonly touch: (principalId: string, at: string) => Promise<void>;
  readonly touchApiKey: (keyId: string, at: string) => Promise<void>;  // member-bound keys authenticate as the member
}
```

`ActivityLog` is implemented by `SqliteArtifactRepository`, `PostgresArtifactRepository` and `D1ArtifactRepository`. `PrincipalActivityRecorder` is implemented by the three identity repositories. Effect wrapping happens in the application layer (`ActivityPersistence` in `src/application/activity.ts`, wired with `Effect.tryPromise` in `src/local/create-local-application-layer.ts`). Failures surface as `ArtifactRepositoryFailure` with operation `"listActivity"` or `"summarizeActivity"`.

#### Action scope rules (slice 2a)

| Kinds | `project_id` | `artifact_id` and `version_id` | `principal_id` |
|---|---|---|---|
| artifact kinds, including `comment_*` and `public_link_*` | required | required | required on live rows |
| `projectScopedActionKinds` (`dispatch_*`, `project_*`) | required | null | required on live rows |
| `installationScopedActionKinds` (`member_*`, `key_*`) | null | null | required on live rows |

- `principal_id` is null only on recovered rows. The ID prefix `recovered:` is reserved for those rows.
- `dispatch_*` rows carry the dispatch ID in `subject_id`.
- A `key_rotate` row's `subject_id` is the old key.

### `src/application/activity.ts`

```ts
export class ActivityService extends Context.Service<ActivityService, {
  readonly list: (principal: Principal, request: ActivityRequest) => Effect.Effect<{items: ActivityEntry[]; nextCursor: PageCursor | null}, ActivityError>;
  readonly summary: (principal: Principal, projectIds: readonly string[]) => Effect.Effect<ActivitySummary, ActivityError>;
}>()("ActivityService") {
  static layer = (dependencies: {readonly directory: ActivityDirectory; readonly persistence: ActivityPersistence}) => /* … */;
}
```

- `ActivityRequest` is the parsed HTTP query: `project[]`, `type[]`, `segment`, `q`, the decoded cursor, and `limit`.
- The HTTP adapter encodes `nextCursor` with the existing `encodePageCursor`.
- `ActivityDirectory` resolves member and key subject names through the identity repository, so artifact SQL never joins identity tables.
- `toActivityEntry` and the wire types live in `src/application/activity-entries.ts`.
- The zod wire schemas live in `apps/web/src/api/activity-contract.ts`.

### HTTP wire shape (`src/http`, mirrored by zod schemas in `apps/web/src/api/client.ts`)

```ts
type ActivityEntryKind = "thread" | "version" | "resolution" | "thread_deleted" | "agent" | "access" | "admin";
interface ActivityEntry {
  id: string; kind: ActivityEntryKind; at: string;
  actor: {name: string | null; kind: PrincipalKind | null};
  project: {id: string; name: string} | null;
  artifact: {id: string; name: string; archived: boolean} | null;
  versionNumber: number | null;
  verb: string;                // "commented" | "replied" | "published" | "restored" | "resolved" | "reopened" | "deleted" | "sent" | "answered" | "enabled" | "disabled" | "admitted" | "deactivated" | "issued" | "rotated" | "revoked" | "created" | "archived" | "unarchived"
  thread?: {id: string; opener: WireComment; replies: WireComment[]; replyCount: number; isResolved: boolean; state: ActivityThreadState; anchor: unknown};
  threadId?: string; excerpt?: string;                         // resolution, thread_deleted
  agent?: {name: string; dispatchState: AgentDispatchState; threadIds: string[]};
  access?: {from: AccessSetting | null; to: AccessSetting};
  subject?: {id: string; name: string | null};                 // admin
}
interface WireComment { id: string; author: {name: string; kind: PrincipalKind}; body: string; createdAt: string }
```

`GET /api/v1/activity/summary` returns `ActivitySummary` as JSON.

### Web (`apps/web/src`)

```ts
// api/client.ts
api.listActivity(params: {projects?: string[]; types?: ActivityType[]; segment?: ActivitySegment; q?: string; cursor?: string | null; limit?: number}): Promise<{items: ActivityEntry[]; nextCursor: string | null}>
api.activitySummary(projects?: string[]): Promise<ActivitySummary>

// review/activity/activity-adapter.ts
// ActivityEvent is the vendored model's event type (exported from @/ui/review-ui); its time field `at` is epoch milliseconds.
export function toFeedEvents(entries: readonly ActivityEntry[]): ActivityEvent[]
export function feedGroups(events: readonly ActivityEvent[], now: number): ActivityDayGroup[]  // mergeBursts then groupByDay

// review/activity/activity-feed-section.tsx — reused by Projects (slice 6)
export function ActivityFeedSection(props: {principalId: string; projectId: string | null}): JSX.Element  // apps/web has no session context; callers pass the principal

// review/activity/use-activity-feed.ts
export function useActivityFeed(filters: ActivityFilters): {phase: "loading" | "ready" | "failed"; groups; hasMore: boolean; loadOlder(): void; reload(): void; insertLocal(entry: ActivityEntry): void}

// review/review-routes.ts — new route kinds
type ReviewRoute = … | {kind: "activity"; filters: ActivityFilters} | {kind: "projects"; projectId: string | null}
interface ActivityFilters { segment: ActivitySegment; projects: string[]; types: ActivityType[]; q: string }
```

The `queue` route kind is renamed `activity`. It keeps the bare `/review` URL.

## Review Focus

These are the inputs the spec implies but no feature test would naturally hit. Each line names the task that adds the test that pins it.

1. **A thread replied to across a page boundary must appear exactly once.** A reply that moves a thread to the top after page 1 loaded must not leave a duplicate on page 2. Test: Task 4.2.
2. **A comment with bidirectional overrides, zero-width characters or a maximum-length body must not break feed layout or search.** The server refuses bodies over its 8,192-character limit, so the test uses an 8,192-character hostile body and proves the refusal above it. The body renders escaped and truncated by the vendored card, and search matching stays parameterized. Test: Task 4.2 for the server and Task 5.3 for the browser.
3. **An administrator who is demoted or deactivated mid-session must stop seeing `member_*` and `key_*` entries** on the next request, not after a cache expiry. Test: Task 4.2.
4. **A migration interrupted mid-copy (process killed) restarts cleanly**, with `actions` row count and checksum unchanged. Test: Task 2.2.
5. **A thumbnail for a version with an anchor outside the 800 px page, or for a non-HTML entry, shows the file tile instead of a misplaced pin or a blank frame.** Test: Task 5.4.

---
## Slice 1 — Components, dates and Files panel

This slice moves the vendored ArkCase tree from Design `804cd4a` to `e087280`, adds the components later slices need, exposes the vendored activity model and UI through typed wrappers, and switches every printed date to the US formats. It changes no server code.

**Correction to the shared header.** `scripts/arkcase-ds-entries.json` `reviewUi` stays a single path. At `e087280`, `review-ui.jsx` imports `./activity-ui.jsx`, which imports `./activity-model.js`. The sync script's `importClosure` already follows relative imports, so both files are vendored with no script change. Spec §4's "change `reviewUi` to a list" is therefore unnecessary. Task 1.1 Step 6 proves both files arrive.

**The vendored event type.** The vendored model's event type is `ActivityEvent`, exported from `@/arkcase/review-ui/review-ui.jsx` (its shipped `review-ui.d.ts`). Its time field is `at`, in epoch milliseconds; the model also stamps `atMs` on each thread and reply internally. Task 1.2 re-exports the type as `ActivityEvent` from `@/ui/review-ui`. Slice 5 defines `FeedEvent = ActivityEvent & {entry: ActivityEntry}` for events that keep their API entry. Application code imports the model only through `@/ui/activity-model`.

### Task 1.1: Re-sync ArkCase components to `e087280` and prove the Files panel edges

**Files:**
- Create: `tests/browser/files-panel-edges.spec.ts`
- Modify: `scripts/arkcase-ds-entries.json` (the `components` array)
- Regenerate (never hand-edit): `apps/web/src/arkcase/**`, including `SOURCE.json` and `index.ts`
- Modify: `project/evidence/web-bundle-size.json` (via `scripts/measure-web-bundle.mjs`)

**Interfaces:**
- Consumes: Design checkout at `~/Dev/Design`, HEAD `e08728098ae5700d085c9ab20ab2eeac717ceb93`, clean in `arkcase/project/{components,tokens,assets/brand}` and `workspace/projects/arkcase-artifacts`.
- Produces, as `@/arkcase` barrel exports (from their shipped `.d.ts` files): `Timeline`, `ScrollDock`, `MetricCard`, `AnnotationPin`, `DataGrid`, `DataGridColumnChooser`, `SideNav`, `Breadcrumb`, plus their prop types.
- Produces vendored files `@/arkcase/review-ui/activity-ui.jsx` and `@/arkcase/review-ui/activity-model.js`.
- Produces the new optional props:
  - `PageScaffold` `head?: "fixed" | "scroll"`
  - `CommentThread` `visibleReplies?`, `expandedIds?`, `onToggleReplies?`
  - `FileList` `inset?`
  - `Disclosure` `inset?`
- Produces bundle measurement label `before-activity`, the baseline every later slice compares against.

- [ ] **Step 1: Write the failing Files panel geometry test**

At `804cd4a`, top-level file rows sit 10px further in than the folder icon, and a folder's files are indented past the folder name. At `e087280`, every icon shares one 14px column, a folder's file icons sit under the folder name, and trailing labels end 14px from the edge. Create `tests/browser/files-panel-edges.spec.ts`:

```ts
import {expect, test, type Locator} from "@playwright/test";

import {
  commitStagedUpload,
  createStagedUpload,
  requireSuccessfulUploads,
  testSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {localLogin, startBrowserFixture, stopBrowserFixture} from "./browser-fixture.js";
import {openInspectorTab, openReview} from "./review-helpers.js";

async function box(locator: Locator): Promise<{readonly left: number; readonly right: number}> {
  const rect = await locator.boundingBox();
  if (rect === null) throw new Error("element has no layout box");
  return {left: rect.x, right: rect.x + rect.width};
}

test("Files panel: every icon shares one edge, folder files sit under the folder name, labels end at the same edge", async ({browser}) => {
  const fixture = await startBrowserFixture(browser);
  try {
    const files = [
      testSiteFile("<!doctype html><title>Edges</title><h1>Edges</h1>", "text/html; charset=utf-8", "index.html"),
      testSiteFile("<!doctype html><title>About</title>", "text/html; charset=utf-8", "about.html"),
      testSiteFile("body{margin:0}", "text/css; charset=utf-8", "assets/app.css"),
      testSiteFile("<svg xmlns=\"http://www.w3.org/2000/svg\"/>", "image/svg+xml", "assets/logo.svg"),
    ];
    const upload = await createStagedUpload(fixture.server, fixture.installation, "index.html", files);
    await requireSuccessfulUploads(uploadEveryStagedFile(fixture.installation, upload.body, files));
    const published = await commitStagedUpload(fixture.installation, upload.body, "files-panel-edges", {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: "Files panel edges",
      tags: [],
    });

    await localLogin(fixture);
    await openReview(fixture, {
      artifactId: published.body.artifact.id,
      path: "assets/app.css",
      versionId: published.body.version.id,
    });
    await openInspectorTab(fixture.page, "Files");

    const inventory = fixture.page.getByRole("complementary", {name: "Artifact inspector"})
      .getByRole("region", {name: /^Files in version \d+$/u});
    const topLevel = inventory.getByRole("list", {name: "Top-level files"});
    const folderButton = inventory.getByRole("button", {name: /^assets\//u});
    const folderFiles = inventory.getByRole("list", {name: "Files in assets"});
    await expect(folderFiles).toBeVisible();

    const panel = await box(inventory);
    const topIcon = await box(topLevel.getByRole("listitem").first().locator("i.bi"));
    const folderIcon = await box(folderButton.locator("i.bi-folder"));
    const folderName = await box(folderButton.getByText("assets/", {exact: true}));
    const folderFileIcon = await box(folderFiles.getByRole("listitem").first().locator("i.bi"));
    const defaultLabel = await box(topLevel.getByText("Default page", {exact: true}));
    const selectedLabel = await box(folderFiles.getByText("Selected", {exact: true}));

    expect(Math.abs(topIcon.left - folderIcon.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(topIcon.left - panel.left - 14)).toBeLessThanOrEqual(1);
    expect(Math.abs(folderFileIcon.left - folderName.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(panel.right - defaultLabel.right - 14)).toBeLessThanOrEqual(1);
    expect(Math.abs(defaultLabel.right - selectedLabel.right)).toBeLessThanOrEqual(1);
  } finally {
    await stopBrowserFixture(fixture);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails on the old pin**

Run: `pnpm build && pnpm exec playwright test tests/browser/files-panel-edges.spec.ts --project=chromium`

Expected: FAIL. At least one `toBeLessThanOrEqual(1)` assertion fails, for example `topIcon.left - folderIcon.left` is about 10.

- [ ] **Step 3: Record the bundle-size baseline before any vendored change**

`dist/web` is already built by Step 2.

Run: `node scripts/measure-web-bundle.mjs --label before-activity`

Expected output: `before-activity: <N> bytes; gzip js <n>, css <n>.` Also `project/evidence/web-bundle-size.json` gains a `before-activity` entry.

- [ ] **Step 4: Add the new components to the entries file**

In `scripts/arkcase-ds-entries.json`, add these seven paths to `components`. Keep the array in code-point order; each is shown with its alphabetical neighbour, and `reviewUi` and `brand` are unchanged:

```json
    "app/RailHeader.jsx",
    "app/ScrollDock.jsx",
    "app/SlideOver.jsx",
    "canvas/AnnotationPin.jsx",
    "canvas/PreviewFrame.jsx",
    "data-display/FileList.jsx",
    "data-display/IdentityBlock.jsx",
    "data-display/MetricCard.jsx",
    "data-display/StatusPill.jsx",
    "data-display/Tag.jsx",
    "data-display/Timeline.jsx",
    "feedback/Alert.jsx",
    "forms/Textarea.jsx",
    "grid/DataGrid.jsx",
    "navigation/Breadcrumb.jsx",
    "navigation/LeftNav.jsx",
    "navigation/SegmentedControl.jsx",
    "navigation/SideNav.jsx",
    "navigation/Tabs.jsx",
```

The final array is the existing 67 paths plus these seven: `app/ScrollDock.jsx`, `canvas/AnnotationPin.jsx`, `data-display/MetricCard.jsx`, `data-display/Timeline.jsx`, `grid/DataGrid.jsx`, `navigation/Breadcrumb.jsx` and `navigation/SideNav.jsx`.

Their relative imports come along automatically through `importClosure`:
- `grid/data-grid-model.js`, `grid/data-grid-controller.js` and `grid/data-grid-view.jsx`
- `navigation/NavigationIcon.jsx` and `panel/resize-seam.jsx`
- the already vendored `Button`, `IconButton`, `Menu`, `StatusPill`, `Tooltip` and `DisplayProfile`

`Timeline.jsx` and `DataGrid.jsx` inject a `<style>` element through `document.createElement('style')`. `rewriteStyleInjection` routes that through `akStyleDocument`, the same as the existing components.

- [ ] **Step 5: Run the sync against the pinned Design commit**

Run: `git -C ~/Dev/Design rev-parse HEAD && pnpm sync:arkcase-ds`

Expected:

```
e08728098ae5700d085c9ab20ab2eeac717ceb93
Vendored <N> ArkCase files from e08728098ae5700d085c9ab20ab2eeac717ceb93 into apps/web/src/arkcase.
```

If it stops with `X is exported by both A and B`, two shipped `.d.ts` files declare the same name. Report the pair and stop; do not edit vendored output. The likely candidate is `usesDataFont` or `comparatorFor` from `grid/DataGrid.d.ts`.

- [ ] **Step 6: Verify the vendored tree, the pin and the activity files**

Run:

```bash
pnpm check:arkcase-ds
node -e 'const s=require("./apps/web/src/arkcase/SOURCE.json");console.log(s.commit);for (const f of ["review-ui/activity-ui.jsx","review-ui/activity-model.js","components/data-display/Timeline.jsx","components/app/ScrollDock.jsx","components/data-display/MetricCard.jsx","components/canvas/AnnotationPin.jsx","components/grid/DataGrid.jsx","components/navigation/SideNav.jsx","components/navigation/Breadcrumb.jsx"]) console.log(f, f in s.files)'
grep -E "^export \{(Timeline|ScrollDock|MetricCard|AnnotationPin|DataGrid|SideNav|Breadcrumb)[,}]" apps/web/src/arkcase/index.ts
```

Expected:
- `ArkCase vendored tree matches e08728098ae5700d085c9ab20ab2eeac717ceb93 (<N> files).`
- `e08728098ae5700d085c9ab20ab2eeac717ceb93`
- Nine `… true` lines.
- Seven `export {…}` lines. `DataGrid`'s line also lists `DataGridColumnChooser`, `comparatorFor` and `usesDataFont`.

- [ ] **Step 7: Typecheck and run the existing web and tooling tests**

The new component props are optional with the old defaults:
- `PageScaffold` `head` defaults to `"fixed"`.
- `CommentThread` shows every reply without `visibleReplies`.
- `FileList` and `Disclosure` `inset` default to 14px and 24px.

So no application call site changes. Run: `pnpm typecheck && pnpm --filter @artifact-server/web test && pnpm exec vitest run tests/tooling/sync-arkcase-ds.test.ts`

Expected: typecheck exits 0, and every web and tooling test passes.

- [ ] **Step 8: Run the Files panel test again, then the browser specs that render the changed components**

`files-panel-edges` covers FileList and Disclosure. The others cover:

| Spec | Component |
|---|---|
| `frontend-mvp`, `linked-artifacts` | Files tab |
| `cmt-023-comment-convergence`, `review-wave-three` | CommentThread |
| `design-library`, `accessibility`, `csp-clean` | PageScaffold, CSP after the new style injections |

Run: `pnpm build && pnpm exec playwright test tests/browser/files-panel-edges.spec.ts tests/browser/frontend-mvp.spec.ts tests/browser/linked-artifacts.spec.ts tests/browser/cmt-023-comment-convergence.spec.ts tests/browser/review-wave-three.spec.ts tests/browser/design-library.spec.ts tests/browser/accessibility.spec.ts tests/browser/csp-clean.spec.ts --project=chromium`

Expected: every test passes, including `Files panel: every icon shares one edge…`. Any failure in the other specs is a regression from the re-sync. Report it with the failing assertion; do not change vendored files.

- [ ] **Step 9: Measure the bundle against the baseline**

Run: `node scripts/measure-web-bundle.mjs --label after-task-1.1 --baseline before-activity`

Expected: `Growth over before-activity: <x> percent.` with an exit code of 0, meaning at most 25%. Nothing imports the new components yet, so growth should be under 1%.

- [ ] **Step 10: Commit**

```bash
git add scripts/arkcase-ds-entries.json apps/web/src/arkcase tests/browser/files-panel-edges.spec.ts project/evidence/web-bundle-size.json
git commit -m "Re-sync ArkCase components to e087280 and line up the Files panel edges

Vendors Timeline, ScrollDock, MetricCard, AnnotationPin, DataGrid, SideNav and
Breadcrumb for the activity, projects and admin screens; the review UI's import
closure brings the activity UI and model along.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 1.2: Typed wrappers for the vendored activity model and UI

**Files:**
- Create: `apps/web/src/ui/vendored-activity-model.d.ts`
- Create: `apps/web/src/ui/activity-model.ts`
- Create: `apps/web/src/ui/activity-model.test.ts`
- Modify: `apps/web/src/ui/review-ui.ts`

**Interfaces:**
- Consumes (Task 1.1): `@/arkcase/review-ui/activity-model.js`, `@/arkcase/review-ui/review-ui.jsx` (`createReviewUI`, `ActivityEvent`, `ActivityFeedProps`, `ActivityHeaderProps`, `ActivityMetric`, `ActivityToolbarProps`), and `@/arkcase` (`AnnotationPin`, `AutoGrid`, `CommentThread`, `Menu`, `MetricCard`, `ScrollDock`, `SectionHeading`, `StatusPill`, `Timeline`).
- Produces in `@/ui/activity-model`: `usDate(ms: number): string`, `usTime(ms: number): string` and `usDateTime(ms: number): string`. All three return `""` for NaN.
- Produces in `@/ui/activity-model`: `sortEvents(events: readonly ActivityEvent[]): ActivityEvent[]` (newest first, unreadable times last, ties by id), `mergeBursts(events: readonly ActivityEvent[]): ActivityEvent[]`, `dayKey(ms: number): string`, `dayLabel(key: string, now: number): string` and `groupByDay(events: readonly ActivityEvent[], now: number): ActivityDayGroup[]`.
- Produces in `@/ui/activity-model` the type `ActivityDayGroup = {readonly key: string; readonly label: string; readonly events: ActivityEvent[]}`.
- Produces in `@/ui/review-ui`: `ActivityFeed`, `ActivityHeader` and `ActivityToolbar` components, plus the types `ActivityEvent`, `ActivityFeedProps`, `ActivityHeaderProps`, `ActivityMetric` and `ActivityToolbarProps`.

- [ ] **Step 1: Write the failing test**

Expected values are built from local-time `Date` parts, so the test passes in any time zone. Create `apps/web/src/ui/activity-model.test.ts`:

```ts
import {describe, expect, test} from "vitest";

import type {ActivityEvent} from "@/ui/review-ui";

import {dayKey, dayLabel, groupByDay, mergeBursts, sortEvents, usDate, usDateTime, usTime} from "./activity-model";

const at = (year: number, month: number, day: number, hour: number, minute: number): number =>
  new Date(year, month - 1, day, hour, minute).getTime();

function versionEvent(id: string, version: number, when: number, actor = "Claude"): ActivityEvent {
  return {
    actor, adminOnly: false, artifactId: "art_1", artifactName: "Stage bar", at: when, fromVersion: version - 1,
    id, needsYou: false, type: "version", verb: "published", version, withAgent: false,
  };
}

describe("vendored activity model", () => {
  test("prints US dates and a 12-hour clock in local time", () => {
    expect(usDate(at(2026, 4, 14, 15, 5))).toBe("04/14/2026");
    expect(usTime(at(2026, 4, 14, 15, 5))).toBe("3:05 PM");
    expect(usTime(at(2026, 4, 14, 0, 7))).toBe("12:07 AM");
    expect(usTime(at(2026, 4, 14, 12, 0))).toBe("12:00 PM");
    expect(usDateTime(at(2026, 4, 14, 9, 30))).toBe("04/14/2026 9:30 AM");
    expect(usDate(Number.NaN)).toBe("");
    expect(usDateTime(Number.NaN)).toBe("");
  });

  test("labels days as Today, Yesterday, then weekday and US date", () => {
    const now = at(2026, 4, 15, 10, 0);
    expect(dayLabel(dayKey(at(2026, 4, 15, 8, 0)), now)).toBe("Today");
    expect(dayLabel(dayKey(at(2026, 4, 14, 23, 59)), now)).toBe("Yesterday");
    expect(dayLabel(dayKey(at(2026, 4, 13, 9, 0)), now)).toBe("Mon 04/13/2026");
  });

  test("merges one publisher's consecutive versions and groups newest-first events by day", () => {
    const now = at(2026, 4, 15, 10, 0);
    const merged = mergeBursts([
      versionEvent("v7", 7, at(2026, 4, 15, 9, 0)),
      versionEvent("v6", 6, at(2026, 4, 15, 8, 0)),
      versionEvent("v5", 5, at(2026, 4, 14, 8, 0), "Dana Okonkwo"),
    ]);
    expect(merged.map((event) => [event.id, event.firstVersion, event.count])).toEqual([["v7", 6, 2], ["v5", 5, 1]]);
    expect(groupByDay(merged, now).map((group) => [group.label, group.events.length])).toEqual([["Today", 1], ["Yesterday", 1]]);
  });

  test("sorts newest first and puts unreadable times last", () => {
    const sorted = sortEvents([
      versionEvent("old", 1, at(2026, 4, 13, 8, 0)),
      versionEvent("undated", 2, Number.NaN),
      versionEvent("new", 3, at(2026, 4, 15, 8, 0)),
    ]);
    expect(sorted.map((event) => event.id)).toEqual(["new", "old", "undated"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @artifact-server/web exec vitest run src/ui/activity-model.test.ts`

Expected: FAIL with `Failed to resolve import "./activity-model"`.

- [ ] **Step 3: Declare the vendored model's types**

The vendored `activity-model.js` ships no `.d.ts`, and files under `apps/web/src/arkcase/` cannot be added by hand. An ambient declaration for the exact non-relative specifier gives it types. Declare only the functions the application uses. Create `apps/web/src/ui/vendored-activity-model.d.ts`:

```ts
/**
 * Types for the vendored, untyped activity model (scripts/sync-arkcase-ds.mjs copies
 * workspace/projects/arkcase-artifacts/activity-model.js without a declaration). Only the
 * functions the application calls are declared; their behaviour is pinned by
 * src/ui/activity-model.test.ts.
 */
declare module "@/arkcase/review-ui/activity-model.js" {
  import type {ActivityEvent} from "@/arkcase/review-ui/review-ui.jsx";

  export interface ActivityDayGroup {
    readonly events: ActivityEvent[];
    readonly key: string;
    readonly label: string;
  }

  export function usDate(ms: number): string;
  export function usTime(ms: number): string;
  export function usDateTime(ms: number): string;
  export function sortEvents(events: readonly ActivityEvent[]): ActivityEvent[];
  export function mergeBursts(events: readonly ActivityEvent[]): ActivityEvent[];
  export function dayKey(ms: number): string;
  export function dayLabel(key: string, now: number): string;
  export function groupByDay(events: readonly ActivityEvent[], now: number): ActivityDayGroup[];
}
```

- [ ] **Step 4: Add the model entry point**

Create `apps/web/src/ui/activity-model.ts`:

```ts
/**
 * The vendored activity model's pure helpers: US date formats, burst merging and day
 * grouping. Filtering, segments and paging belong to the server's activity API.
 */
export {
  dayKey,
  dayLabel,
  groupByDay,
  mergeBursts,
  sortEvents,
  usDate,
  usDateTime,
  usTime,
} from "@/arkcase/review-ui/activity-model.js";
export type {ActivityDayGroup} from "@/arkcase/review-ui/activity-model.js";
```

- [ ] **Step 5: Expose the activity components from the review UI wrapper**

`createReviewUI` at `e087280` spreads in `createActivityUI(React, DS)`. `ActivityHeader` needs `SectionHeading`, `AutoGrid` and `MetricCard`. `ActivityFeed` needs `Timeline`, `CommentThread`, `StatusPill`, `Button`, `SurfaceState`, `GroupBand`, `ScrollDock` and `AnnotationPin`. `ActivityToolbar` needs `SegmentedControl`, `Button`, `Menu`, `Input` and `ScrollDock`. Replace `apps/web/src/ui/review-ui.ts` with:

```ts
import React from "react";

import {
  AnnotationPin,
  AutoGrid,
  Button,
  CommentThread,
  Disclosure,
  FileList,
  GroupBand,
  Input,
  Menu,
  MetricCard,
  Modal,
  Popover,
  ScrollDock,
  SectionHeading,
  SegmentedControl,
  SelectableRow,
  StatusPill,
  SurfaceState,
  Timeline,
} from "@/arkcase";
import {createReviewUI} from "@/arkcase/review-ui/review-ui.jsx";

/**
 * The project-owned review controls (contract correction 4), built once from
 * the application's React and the vendored ArkCase components.
 */
const reviewUi = createReviewUI(React, {
  AnnotationPin,
  AutoGrid,
  Button,
  CommentThread,
  Disclosure,
  FileList,
  GroupBand,
  Input,
  Menu,
  MetricCard,
  Modal,
  Popover,
  ScrollDock,
  SectionHeading,
  SegmentedControl,
  SelectableRow,
  StatusPill,
  SurfaceState,
  Timeline,
});

export const {
  ActivityFeed,
  ActivityHeader,
  ActivityToolbar,
  ArtifactLinks,
  DesignGallery,
  FileGroups,
  PagePicker,
} = reviewUi;
export type {
  ActivityEvent,
  ActivityFeedProps,
  ActivityHeaderProps,
  ActivityMetric,
  ActivityToolbarProps,
  ArtifactFile,
  ArtifactLinkRow,
  ArtifactPage as ReviewPage,
  GalleryItem,
  PagePickerProps,
} from "@/arkcase/review-ui/review-ui.jsx";
```

- [ ] **Step 6: Run the test, typecheck and lint**

Run: `pnpm --filter @artifact-server/web exec vitest run src/ui/activity-model.test.ts && pnpm --filter @artifact-server/web typecheck && pnpm lint`

Expected: three tests pass, typecheck exits 0, and oxlint reports no warnings.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/ui/vendored-activity-model.d.ts apps/web/src/ui/activity-model.ts apps/web/src/ui/activity-model.test.ts apps/web/src/ui/review-ui.ts
git commit -m "Expose the vendored activity model and feed components with types

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 1.3: Print US dates and a 12-hour clock everywhere, and close slice 1

**Files:**
- Modify: `apps/web/src/lib/presentation.ts:3-12` (`formatTimestamp`)
- Modify: `apps/web/src/review/library/design-library-screen.tsx:19,118` (`timeFormat`)
- Create: `apps/web/src/lib/presentation.test.ts`
- Modify: `project/evidence/web-bundle-size.json`

**Interfaces:**
- Consumes (Task 1.2): `usDateTime` and `usTime` from `@/ui/activity-model`.
- Produces: `formatTimestamp(value: string): string`, which keeps its signature. It returns `MM/DD/YYYY h:mm AM/PM` in local time, or the input unchanged when it is not a readable instant. Its 25 call sites need no edit.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/presentation.test.ts`:

```ts
import {describe, expect, test} from "vitest";

import {formatTimestamp} from "./presentation";

const iso = (year: number, month: number, day: number, hour: number, minute: number): string =>
  new Date(year, month - 1, day, hour, minute).toISOString();

describe("formatTimestamp", () => {
  test("prints MM/DD/YYYY and a 12-hour clock in local time", () => {
    expect(formatTimestamp(iso(2026, 4, 14, 15, 5))).toBe("04/14/2026 3:05 PM");
    expect(formatTimestamp(iso(2026, 12, 31, 0, 0))).toBe("12/31/2026 12:00 AM");
    expect(formatTimestamp(iso(2026, 1, 2, 12, 30))).toBe("01/02/2026 12:30 PM");
  });

  test("returns an unreadable value unchanged", () => {
    expect(formatTimestamp("not a time")).toBe("not a time");
    expect(formatTimestamp("")).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @artifact-server/web exec vitest run src/lib/presentation.test.ts`

Expected: FAIL. The first assertion receives the browser-locale `Intl` string, for example `"Apr 14, 2026, 3:05 PM"`, not `"04/14/2026 3:05 PM"`.

- [ ] **Step 3: Implement the formatter on the vendored US formats**

In `apps/web/src/lib/presentation.ts`, add `import {usDateTime} from "@/ui/activity-model";` after the existing `@/api/client` import. Replace lines 3–12 with:

```ts
/** Formats a stored ISO timestamp as MM/DD/YYYY and a 12-hour clock, in local time. */
export function formatTimestamp(value: string): string {
  return usDateTime(Date.parse(value)) || value;
}
```

- [ ] **Step 4: Switch the design library's as-of time**

In `apps/web/src/review/library/design-library-screen.tsx`:
- Delete line 19: `const timeFormat = new Intl.DateTimeFormat(undefined, {hour: "numeric", minute: "2-digit"});`
- Add `import {usTime} from "@/ui/activity-model";` with the other `@/` imports.
- On line 118, replace `{timeFormat.format(library.loadedAt)}` with `{usTime(library.loadedAt.getTime())}`.

- [ ] **Step 5: Run the tests and prove no locale formatter remains**

Run:

```bash
pnpm --filter @artifact-server/web exec vitest run src/lib/presentation.test.ts
grep -rnE "Intl\.DateTimeFormat|toLocale(Date|Time)?String" apps/web/src --include='*.ts' --include='*.tsx' | grep -v '/arkcase/'
```

Expected: both tests pass, and `grep` prints nothing. `formatRelativeTime`'s `Intl.RelativeTimeFormat` is a relative phrase, not a date, so it stays.

- [ ] **Step 6: Run the slice gate**

Run: `pnpm check`

Expected: every stage passes:
- `check:release-version`
- `check:arkcase-ds`
- `lint`
- `typecheck`
- `build`
- `verify:site`
- `test`
- web `test`
- `conformance:validate`
- `conformance:tests`
- `check:cloudflare`

- [ ] **Step 7: Run the browser specs that print dates, then measure the bundle**

Run:

```bash
pnpm exec playwright test tests/browser/frontend-mvp.spec.ts tests/browser/design-library.spec.ts tests/browser/review-queue.spec.ts tests/browser/shell-navigation.spec.ts --project=chromium
node scripts/measure-web-bundle.mjs --label after-slice-1 --baseline before-activity
```

Expected: every test passes. Then `Growth over before-activity: <x> percent.` with an exit code of 0, meaning at most 25%.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/presentation.ts apps/web/src/lib/presentation.test.ts apps/web/src/review/library/design-library-screen.tsx project/evidence/web-bundle-size.json
git commit -m "Print US dates and a 12-hour clock throughout the application

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 1.4: "Show older" without a count when the total is unknown (upstream Design change, then re-sync)

The server pages the feed by cursor and never reports how many entries remain. The vendored `ActivityFeed` always prints `Show older ({remaining})`, so Artifact Server would show "Show older (0)". The fix belongs in Design, the source of the vendored copy. Never edit `apps/web/src/arkcase/review-ui/activity-ui.jsx` here.

**Files:**
- Modify (Design repo): `~/Dev/Design/workspace/projects/arkcase-artifacts/activity-ui.jsx:113-115`
- Modify (Design repo): `~/Dev/Design/workspace/projects/arkcase-artifacts/review-ui.d.ts:131` (document `remaining`)
- Modify (Design repo): `~/Dev/Design/stories/projects/ArtifactsActivity.stories.jsx` (new `ShowOlderWithoutTotal` story)
- Regenerate (Design repo, never hand-edit): `~/Dev/Design/arkcase-artifacts/project/features/session-model.bundle.js` via `npm run build:artifacts`
- Regenerate (this repo, never hand-edit): `apps/web/src/arkcase/**`, including `SOURCE.json`

**Interfaces:**
- Consumes: Task 1.1's vendored `activity-ui.jsx`.
- Produces: `ActivityFeed` with `remaining={0}` and `hasMore` prints exactly "Show older". With `remaining > 0` it prints "Show older (n)", unchanged. Task 5.3's `ActivityFeedPanel` relies on this when it passes `remaining={0}`.

- [ ] **Step 1: Write the failing story in Design**

In `~/Dev/Design/stories/projects/ArtifactsActivity.stories.jsx`, append after the `Page` story:

```jsx
/** A host that pages by cursor knows only that more exist, not how many: the button carries no count. */
export const ShowOlderWithoutTotal = {
  args: { onOpen: fn(), onReply: fn() },
  render: (args) => <UI.ActivityFeed events={EVENTS.slice(0, 2)} now={NOW} hasMore remaining={0} onShowOlder={fn()}
    onOpen={args.onOpen} onReply={args.onReply} onResolve={() => {}} filtered={false} onClearFilters={() => {}} stickyTop={0} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole('button', { name: 'Show older' })).toBeVisible();
    await expect(c.queryByRole('button', { name: /Show older \(/ })).toBeNull();
  },
};
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/Dev/Design && npx vitest run stories/projects/ArtifactsActivity.stories.jsx`

Expected: `ShowOlderWithoutTotal` FAILS. `getByRole('button', { name: 'Show older' })` finds no exact match, because the button reads "Show older (0)". `Feed`, `EmptyFiltered` and `Page` pass.

- [ ] **Step 3: Omit the count when it is unknown**

In `~/Dev/Design/workspace/projects/arkcase-artifacts/activity-ui.jsx`, replace:

```jsx
      {hasMore && <Button variant="secondary" outline size="sm" icon="bi-chevron-down" onClick={onShowOlder} style={{ alignSelf: 'flex-start' }}>
        Show older ({remaining})
      </Button>}
```

with:

```jsx
      {hasMore && <Button variant="secondary" outline size="sm" icon="bi-chevron-down" onClick={onShowOlder} style={{ alignSelf: 'flex-start' }}>
        {remaining > 0 ? `Show older (${remaining})` : 'Show older'}
      </Button>}
```

In `~/Dev/Design/workspace/projects/arkcase-artifacts/review-ui.d.ts`, replace `  remaining: number;` inside `ActivityFeedProps` with:

```ts
  /** Entries not yet shown. `0` means "unknown": a cursor-paged host prints plain "Show older". */
  remaining: number;
```

- [ ] **Step 4: Regenerate the prototype bundle and run the Design gates**

Run:

```bash
cd ~/Dev/Design
npm run build:artifacts
npm run check:artifacts
npm run test:models
npx vitest run stories/projects/ArtifactsActivity.stories.jsx
```

Expected:
- `build:artifacts` rewrites `arkcase-artifacts/project/features/session-model.bundle.js`.
- `check:artifacts` exits 0.
- `test:models` passes, including all of `tests/models/artifacts-activity.test.mjs`.
- All four stories pass, including `ShowOlderWithoutTotal`.

- [ ] **Step 5: Commit in Design**

```bash
cd ~/Dev/Design
git add workspace/projects/arkcase-artifacts/activity-ui.jsx workspace/projects/arkcase-artifacts/review-ui.d.ts \
  stories/projects/ArtifactsActivity.stories.jsx arkcase-artifacts/project/features/session-model.bundle.js
git commit -m "Print Show older without a count when the host cannot know it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git rev-parse HEAD
```

Expected: one commit. Note the printed hash; Step 6 pins it.

- [ ] **Step 6: Re-sync and verify the pin**

Run, from this repository:

```bash
pnpm sync:arkcase-ds
pnpm check:arkcase-ds
node -e 'const s=require("./apps/web/src/arkcase/SOURCE.json");console.log(s.commit)'
grep -n "Show older" apps/web/src/arkcase/review-ui/activity-ui.jsx
```

Expected:
- The sync prints `Vendored <N> ArkCase files from <hash from Step 5> into apps/web/src/arkcase.`
- `check:arkcase-ds` exits 0.
- `SOURCE.json`'s `commit` is the Step 5 hash.
- The `grep` shows the `remaining > 0 ? … : 'Show older'` line.

- [ ] **Step 7: Run the web checks**

Run: `pnpm typecheck && pnpm --filter @artifact-server/web test && pnpm exec vitest run tests/tooling/sync-arkcase-ds.test.ts`

Expected: PASS. Only the vendored file changed, and its props are unchanged.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/arkcase
git commit -m "Re-sync ArkCase components for a count-free Show older

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
## Slice 2a — Activity log schema, migration and recovery

**Requirement:** ACT-002 (spec §1 "Schema" and "Recovering existing rows").

The `actions` table becomes the installation's activity log in all three backends:

| Backend | How it migrates |
|---|---|
| SQLite | Copies into a new table and verifies the copy. |
| D1 | Same copy as SQLite, in one atomic batch. |
| Postgres | Changes the table in place, in one migration transaction. |

Each backend then recovers what the old records already show. Slice 2a writes no new live rows; Slice 2b does that.

**Facts that shape this slice (verified in the code):**

- **SQLite has one installation per file.**
  - `actions` has no `installation_id`. Identity tables (`installation_members`, `managed_api_keys`) live in the same file but are created by `SqliteIdentityRepository`, a separate `DatabaseSync` connection. `src/local/create-local-runtime.ts:156-157` opens the artifact repository first.
  - So on a brand-new file the identity tables do not exist yet when the artifact migration runs. Recovery from those tables must be guarded.
- **SQLite migrations run on every startup**, guarded by checking columns, not `user_version`.
  - `#addProjectScopeIfMissing` re-runs every time.
  - It does `CREATE TRIGGER IF NOT EXISTS actions_project_insert …`.
  - It writes `PRAGMA user_version = 17` before later helpers run.
  - So this slice guards on the `subject_id` column, never on `user_version`.
- **D1 uses the same dialect and table names as SQLite** (see `deploy/cloudflare/src/d1-migrations.ts`), with no triggers on `actions`. It tracks its schema in `artifact_server_schema` (currently 15).
- **Postgres keeps an ordered `Migrator` registry** in `src/storage/postgres-migrations.ts`:
  - The registry stops at `0017`.
  - `actions_action_check` lists only 11 kinds.
  - Rows are keyed by `(installation_id, …)`.
- **Comment action keys follow one pattern.** They are always `comment:<threadId>:<randomUUID()>`; the UUID is 36 characters. In D1 `commentActionIdentity(command.id).idempotencyKey` throws away the action id (`d1-artifact-repository.ts:3666`). So the thread id is recovered by stripping the fixed 37-character `:<uuid>` suffix, not by matching the action id.
- **Idempotency records hold the access setting:**
  - `change_access` records the new setting.
  - `change_tags`, `delete` and `restore` record the artifact's setting at that moment.
  - `publish` records `NULL`.
- **One test per acceptance ID.** `scripts/check-conformance-test-ids.rb` lets each acceptance ID be claimed by exactly one test title across `apps deploy packaging project/performance skills src tests tools`. The SQLite tests carry `ACT-002-B` and `ACT-002-F`. The Postgres and D1 parity tests must not put an acceptance ID in their titles.

### Produces (Slice 2b and later rely on these exact names)

**`src/core/model.ts`** (header "Shared Interfaces" plus one addition):

- `installationActionKinds`, `InstallationActionKind`, `ActionKind`, `ActorSnapshot`, `ActivityActionRow`.
- `artifactActionKinds.publicLinkEnable` and `artifactActionKinds.publicLinkDisable`.
- `artifactHistoryActionKinds: readonly ArtifactActionKind[]`: the 14 kinds the per-artifact history endpoint may return.

**`src/storage/activity-log-schema.ts`**, shared by SQLite, D1 and Postgres:

- `recoveredActionIdPrefix = "recovered:"` and `recoveredActionId(kind, subjectId)`. The resulting `recovered:<kind>:<subjectId>` IDs are reserved, and live writes must never produce one.
- Kind groupings:
  - `projectScopedActionKinds`: `dispatch_*` and `project_*`. These rows have `project_id` set and both `artifact_id` and `version_id` null.
  - `installationScopedActionKinds`: `member_*` and `key_*`. These rows have `project_id`, `artifact_id` and `version_id` all null.
- SQL lists: `allActionKindSql`, `artifactActionKindSql`, `artifactHistoryActionKindSql`, `projectScopedActionKindSql`, `installationScopedActionKindSql`.
- Constraints: `actionRowChecks` and `activityDetailJsonMaxBytes = 4096`.
- SQLite-dialect builders: `sqliteActionsRebuildStatements({strict})` and `sqliteActivityRecoveryStatements({identity})`.

**`actions` columns after the migration.** Existing columns are kept; the new nullable columns are:

| Column | Values |
|---|---|
| `thread_id` | TEXT |
| `reply_id` | TEXT |
| `subject_id` | TEXT |
| `access_from` | `account_required` or `public_link` |
| `access_to` | `account_required` or `public_link` |
| `actor_name` | TEXT |
| `actor_kind` | `human` or `service` |
| `detail_json` | TEXT; valid JSON and at most 4096 bytes in SQLite and D1, at most 4096 bytes in Postgres |

`project_id`, `artifact_id`, `version_id` and `principal_id` become nullable under these rules:

- **Scope:** artifact kinds require all three of `project_id`, `artifact_id` and `version_id`. Project-scoped kinds require `project_id` only. Installation-scoped kinds require none of them.
- **Principal:** `principal_id IS NOT NULL OR id LIKE 'recovered:%'`. Every live write keeps a principal (AUD-001-F).
- **Idempotency:** a unique index on `idempotency_key` for installation rows (`WHERE project_id IS NULL`). In Postgres it is per `installation_id`.

**`detail_json` shapes.** Slice 2b must write live rows in exactly these shapes, and recovery writes them too:

| Kind | `detail_json` |
|---|---|
| `key_issue`, `key_rotate` | `{"capabilities": PrincipalCapability[]}` |
| `dispatch_create` | `{"agentDisplayName": string, "threadIds": string[]}` |
| `dispatch_addressed` | `{"agentDisplayName": string}` |
| `project_create` | `{"name": string}` |
| every other kind | `null` |

**Indexes:**

| Backend | Indexes |
|---|---|
| SQLite and D1 | `actions_artifact_created (project_id, artifact_id, created_at DESC, id DESC)`<br>`actions_created (created_at DESC, id DESC)`<br>`actions_project_created (project_id, created_at DESC, id DESC)`<br>`actions_thread (thread_id) WHERE thread_id IS NOT NULL`<br>`actions_installation_idempotency UNIQUE (idempotency_key) WHERE project_id IS NULL` |
| Postgres | `actions_installation_created`, `actions_installation_project_created`, `actions_installation_thread` and `actions_installation_idempotency`: the same columns, each led by `installation_id` |

**Schema versions:** SQLite `requiredSqliteSchemaVersion = 18`, Postgres migration `0018_installation_activity_log` (`requiredPostgresSchemaVersion = 18`), and D1 `requiredD1SchemaVersion = 16`.

**Test support, reused by later slices:**

- `tests/support/activity-history-fixture.ts`: `populateActivityHistory`, `activityFixtureTimes`, `recoveredRowSchema`, `expectRecoveredActivity`.
- `tests/support/sqlite-activity-log.ts`:
  - `downgradeSqliteActionsToLegacy`
  - `insertBulkLegacyActions`
  - `legacyActionsDigest`
  - `fullActionsDigest`
  - `readSqliteActionRows`
  - `withSqliteDatabase`
- `tests/support/open-sqlite-artifact-repository.ts`: a child-process entry point that opens and closes the repository.

---

### Task 2.1: Action kinds and the shared activity-log schema module

**Files:**
- Modify: `src/core/model.ts:12-32` (action kinds) and the area after `ArtifactActionRecord` (`src/core/model.ts:130-141`)
- Create: `src/storage/activity-log-schema.ts`
- Test: `tests/storage/activity-log-schema.test.ts`

**Interfaces:**
- Consumes: the existing `artifactActionKinds`, `ArtifactActionKind`, `AccessSetting`, `PrincipalKind` (already imported at `model.ts:3`) and `defaultProjectId` (`model.ts:67`).
- Produces: everything listed for `model.ts` and `activity-log-schema.ts` in **Produces** above.

- [ ] **Step 1: Write the failing test**

Create `tests/storage/activity-log-schema.test.ts`:

```ts
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  artifactActionKinds,
  artifactHistoryActionKinds,
  installationActionKinds,
} from "../../src/core/model.js";
import {
  activityDetailJsonMaxBytes,
  installationScopedActionKinds,
  projectScopedActionKinds,
  recoveredActionId,
  sqliteActionsRebuildStatements,
} from "../../src/storage/activity-log-schema.js";

const columns = `id, project_id, artifact_id, version_id, action, principal_id,
  authorized_by_principal_id, idempotency_key, created_at, subject_id, detail_json`;

describe("activity log schema", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE artifacts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL) STRICT;
      CREATE TABLE versions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL) STRICT;
      CREATE TABLE actions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version_id TEXT NOT NULL REFERENCES versions(id),
        action TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        authorized_by_principal_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO projects (id) VALUES ('prj_a');
      INSERT INTO artifacts (id, project_id) VALUES ('art_a', 'prj_a');
      INSERT INTO versions (id, project_id) VALUES ('ver_a', 'prj_a');
      INSERT INTO actions VALUES (
        'act_legacy', 'prj_a', 'art_a', 'ver_a', 'publish', 'member_a', NULL,
        'publish-a', '2026-09-01T00:00:00.000Z'
      );
    `);
    database.exec("BEGIN;");
    for (const statement of sqliteActionsRebuildStatements({strict: true})) {
      database.exec(statement);
    }
    database.exec("COMMIT;");
  });

  afterEach(() => {
    database.close();
  });

  const insert = (values: readonly (string | null)[]) =>
    database.prepare(
      `INSERT INTO actions (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(...values);

  test("the kind groups partition every installation kind and history keeps the original 14", () => {
    expect([...projectScopedActionKinds, ...installationScopedActionKinds].sort())
      .toEqual(Object.values(installationActionKinds).sort());
    expect(artifactHistoryActionKinds).toHaveLength(14);
    expect(artifactHistoryActionKinds).not.toContain(artifactActionKinds.publicLinkEnable);
    expect(artifactHistoryActionKinds).not.toContain(artifactActionKinds.publicLinkDisable);
    expect(recoveredActionId("member_admit", "member_a")).toBe("recovered:member_admit:member_a");
  });

  test("the rebuilt table keeps the legacy row and accepts each scope's valid shape", () => {
    expect(database.prepare("SELECT id, actor_name FROM actions").all())
      .toEqual([{actor_name: null, id: "act_legacy"}]);
    insert(["act_member", null, null, null, "member_admit", "member_a", null, "admit-b", "2026-09-02T00:00:00.000Z", "member_b", null]);
    insert(["act_project", "prj_a", null, null, "project_create", "member_a", null, "project-a", "2026-09-02T00:00:00.000Z", "prj_a", JSON.stringify({name: "A"})]);
    insert(["act_public", "prj_a", "art_a", "ver_a", "public_link_enable", "member_a", null, "public-a", "2026-09-02T00:00:00.000Z", null, null]);
    insert(["recovered:key_revoke:key_a", null, null, null, "key_revoke", null, null, "recovered:key_revoke:key_a", "2026-09-02T00:00:00.000Z", "key_a", null]);
  });

  test("the rebuilt table refuses rows outside their scope, unattributed live rows and oversized details", () => {
    expect(() => insert(["bad_scope", "prj_a", "art_a", "ver_a", "member_admit", "member_a", null, "bad-1", "2026-09-02T00:00:00.000Z", "member_b", null])).toThrow(/CHECK/);
    expect(() => insert(["bad_project", null, null, null, "project_create", "member_a", null, "bad-2", "2026-09-02T00:00:00.000Z", "prj_a", null])).toThrow(/CHECK/);
    expect(() => insert(["bad_actor", null, null, null, "member_admit", null, null, "bad-3", "2026-09-02T00:00:00.000Z", "member_b", null])).toThrow(/CHECK/);
    expect(() => insert(["bad_kind", "prj_a", "art_a", "ver_a", "mystery", "member_a", null, "bad-4", "2026-09-02T00:00:00.000Z", null, null])).toThrow(/CHECK/);
    expect(() => insert(["bad_json", "prj_a", null, null, "project_create", "member_a", null, "bad-5", "2026-09-02T00:00:00.000Z", "prj_a", "{not json"])).toThrow(/CHECK/);
    const oversized = JSON.stringify({name: "x".repeat(activityDetailJsonMaxBytes)});
    expect(() => insert(["bad_size", "prj_a", null, null, "project_create", "member_a", null, "bad-6", "2026-09-02T00:00:00.000Z", "prj_a", oversized])).toThrow(/CHECK/);
  });

  test("installation rows cannot reuse an idempotency key", () => {
    insert(["act_one", null, null, null, "key_issue", "member_a", null, "same-key", "2026-09-02T00:00:00.000Z", "key_a", null]);
    expect(() => insert(["act_two", null, null, null, "key_revoke", "member_a", null, "same-key", "2026-09-02T00:00:01.000Z", "key_a", null])).toThrow(/UNIQUE/);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm exec vitest run tests/storage/activity-log-schema.test.ts`

Expected: FAIL. Vitest reports `Failed to load url ../../src/storage/activity-log-schema.js` (or the missing `installationActionKinds` export).

- [ ] **Step 3: Add the kinds to `src/core/model.ts`**

Replace the `artifactActionKinds` block and the `ArtifactActionKind` alias at `src/core/model.ts:12-32` with:

```ts
/** Artifact mutation kinds persisted in the standalone action history. */
export const artifactActionKinds = {
  capture: "capture",
  changeAccess: "change_access",
  changeTags: "change_tags",
  commentCreate: "comment_create",
  commentDelete: "comment_delete",
  commentReopen: "comment_reopen",
  commentReply: "comment_reply",
  commentResolve: "comment_resolve",
  commentUpdate: "comment_update",
  delete: "delete",
  link: "link",
  publicLinkDisable: "public_link_disable",
  publicLinkEnable: "public_link_enable",
  publish: "publish",
  relink: "relink",
  restore: "restore",
} as const;

/** One persisted artifact mutation kind. */
export type ArtifactActionKind =
  (typeof artifactActionKinds)[keyof typeof artifactActionKinds];

/**
 * Kinds the per-artifact action history has always returned. The public-link
 * kinds duplicate `change_access` for the activity feed and stay out of it.
 */
export const artifactHistoryActionKinds: readonly ArtifactActionKind[] = [
  artifactActionKinds.capture,
  artifactActionKinds.changeAccess,
  artifactActionKinds.changeTags,
  artifactActionKinds.commentCreate,
  artifactActionKinds.commentDelete,
  artifactActionKinds.commentReopen,
  artifactActionKinds.commentReply,
  artifactActionKinds.commentResolve,
  artifactActionKinds.commentUpdate,
  artifactActionKinds.delete,
  artifactActionKinds.link,
  artifactActionKinds.publish,
  artifactActionKinds.relink,
  artifactActionKinds.restore,
];

/** Installation-scoped kinds: artifact_id and version_id are null. */
export const installationActionKinds = {
  dispatchAddressed: "dispatch_addressed",
  dispatchCreate: "dispatch_create",
  keyIssue: "key_issue",
  keyRevoke: "key_revoke",
  keyRotate: "key_rotate",
  memberAdmit: "member_admit",
  memberDeactivate: "member_deactivate",
  projectArchive: "project_archive",
  projectCreate: "project_create",
  projectUnarchive: "project_unarchive",
} as const;

/** One installation-scoped activity kind. */
export type InstallationActionKind =
  (typeof installationActionKinds)[keyof typeof installationActionKinds];

/** Every kind the installation activity log accepts. */
export type ActionKind = ArtifactActionKind | InstallationActionKind;
```

Then, directly after the `ArtifactActionRecord` interface (`model.ts:130-141`), add:

```ts
/** Who performed an action, snapshotted at write time. */
export interface ActorSnapshot {
  readonly displayName: string;
  readonly kind: PrincipalKind;
}

/** One row of the installation activity log, as the activity read model sees it. */
export interface ActivityActionRow {
  readonly accessFrom: AccessSetting | null;
  readonly accessTo: AccessSetting | null;
  readonly action: ActionKind;
  /** Null when the actor was never recorded (rows recovered from older records). */
  readonly actor: ActorSnapshot | null;
  readonly artifactId: string | null;
  readonly createdAt: string;
  readonly detail: Readonly<Record<string, unknown>> | null;
  readonly id: string;
  readonly principalId: string | null;
  readonly projectId: string | null;
  readonly replyId: string | null;
  readonly subjectId: string | null;
  readonly threadId: string | null;
  readonly versionId: string | null;
}
```

- [ ] **Step 4: Create `src/storage/activity-log-schema.ts`**

```ts
import {
  type ActionKind,
  artifactActionKinds,
  artifactHistoryActionKinds,
  defaultProjectId,
  installationActionKinds,
} from "../core/model.js";

/** Prefix reserved for rows reconstructed from recorded state during migration. */
export const recoveredActionIdPrefix = "recovered:";

/** Largest serialized `detail_json` the activity log stores. */
export const activityDetailJsonMaxBytes = 4096;

/** Deterministic id of one reconstructed row, so a repeated migration cannot duplicate it. */
export function recoveredActionId(kind: ActionKind, subjectId: string): string {
  return `${recoveredActionIdPrefix}${kind}:${subjectId}`;
}

/** Kinds that belong to one project but no artifact. */
export const projectScopedActionKinds = [
  installationActionKinds.dispatchAddressed,
  installationActionKinds.dispatchCreate,
  installationActionKinds.projectArchive,
  installationActionKinds.projectCreate,
  installationActionKinds.projectUnarchive,
] as const;

/** Kinds that belong to the installation as a whole. */
export const installationScopedActionKinds = [
  installationActionKinds.keyIssue,
  installationActionKinds.keyRevoke,
  installationActionKinds.keyRotate,
  installationActionKinds.memberAdmit,
  installationActionKinds.memberDeactivate,
] as const;

// Every value comes from a closed constant set, so quoting needs no escaping.
const sqlList = (kinds: readonly string[]): string =>
  kinds.map((kind) => `'${kind}'`).join(", ");

export const artifactActionKindSql = sqlList(Object.values(artifactActionKinds));
export const artifactHistoryActionKindSql = sqlList(artifactHistoryActionKinds);
export const projectScopedActionKindSql = sqlList(projectScopedActionKinds);
export const installationScopedActionKindSql = sqlList(installationScopedActionKinds);
export const allActionKindSql = sqlList([
  ...Object.values(artifactActionKinds),
  ...Object.values(installationActionKinds),
]);

const commentKindSql = sqlList([
  artifactActionKinds.commentCreate,
  artifactActionKinds.commentDelete,
  artifactActionKinds.commentReopen,
  artifactActionKinds.commentReply,
  artifactActionKinds.commentResolve,
  artifactActionKinds.commentUpdate,
]);
const firstPublicationKindSql = sqlList([
  artifactActionKinds.capture,
  artifactActionKinds.link,
  artifactActionKinds.publish,
]);

/** Row rules every backend's `actions` table enforces, as portable CHECK bodies. */
export const actionRowChecks = [
  `action IN (${allActionKindSql})`,
  `(action IN (${artifactActionKindSql})
      AND project_id IS NOT NULL AND artifact_id IS NOT NULL AND version_id IS NOT NULL)
    OR (action IN (${projectScopedActionKindSql})
      AND project_id IS NOT NULL AND artifact_id IS NULL AND version_id IS NULL)
    OR (action IN (${installationScopedActionKindSql})
      AND project_id IS NULL AND artifact_id IS NULL AND version_id IS NULL)`,
  `principal_id IS NOT NULL OR id LIKE '${recoveredActionIdPrefix}%'`,
  "actor_kind IS NULL OR actor_kind IN ('human', 'service')",
  "access_from IS NULL OR access_from IN ('account_required', 'public_link')",
  "access_to IS NULL OR access_to IN ('account_required', 'public_link')",
] as const;

const legacyColumns = `id, project_id, artifact_id, version_id, action, principal_id,
  authorized_by_principal_id, idempotency_key, created_at`;

/**
 * Copy `actions` into the activity-log shape inside the caller's transaction
 * (SQLite) or batch (D1). The copy-check table's CHECK aborts the whole
 * transaction unless both tables hold exactly the same legacy rows.
 */
export function sqliteActionsRebuildStatements(
  options: {readonly strict: boolean},
): readonly string[] {
  const strict = options.strict ? " STRICT" : "";
  return [
    "DROP TABLE IF EXISTS actions_next",
    "DROP TABLE IF EXISTS actions_copy_check",
    `CREATE TABLE actions_next (
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
    )${strict}`,
    `INSERT INTO actions_next (${legacyColumns})
      SELECT ${legacyColumns} FROM actions`,
    `CREATE TABLE actions_copy_check (
      expected INTEGER NOT NULL,
      copied INTEGER NOT NULL,
      missing INTEGER NOT NULL,
      CHECK (expected = copied AND missing = 0)
    )`,
    `INSERT INTO actions_copy_check (expected, copied, missing)
      SELECT
        (SELECT count(*) FROM actions),
        (SELECT count(*) FROM actions_next),
        (SELECT count(*) FROM (
          SELECT ${legacyColumns} FROM actions
          EXCEPT
          SELECT ${legacyColumns} FROM actions_next
        ))`,
    "DROP TABLE actions_copy_check",
    "DROP TABLE actions",
    "ALTER TABLE actions_next RENAME TO actions",
    `CREATE INDEX IF NOT EXISTS actions_artifact_created
      ON actions (project_id, artifact_id, created_at DESC, id DESC)`,
    "CREATE INDEX IF NOT EXISTS actions_created ON actions (created_at DESC, id DESC)",
    `CREATE INDEX IF NOT EXISTS actions_project_created
      ON actions (project_id, created_at DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS actions_thread
      ON actions (thread_id) WHERE thread_id IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS actions_installation_idempotency
      ON actions (idempotency_key) WHERE project_id IS NULL`,
  ];
}

const recoveredInsertColumns = `id, project_id, artifact_id, version_id, action,
  principal_id, authorized_by_principal_id, idempotency_key, created_at,
  subject_id, actor_name, actor_kind, detail_json`;

/**
 * Fill the new columns and reconstruct rows from what SQLite or D1 already
 * recorded. Every statement is idempotent: updates only touch NULL columns
 * and inserts use deterministic ids with INSERT OR IGNORE. Pass
 * `identity: false` when the identity tables do not exist yet.
 */
export function sqliteActivityRecoveryStatements(
  options: {readonly identity: boolean},
): readonly string[] {
  const threadAndAccess = [
    // comment:<threadId>:<36-character uuid>
    `UPDATE actions
       SET thread_id = substr(idempotency_key, 9, length(idempotency_key) - 45)
     WHERE action IN (${commentKindSql})
       AND thread_id IS NULL
       AND idempotency_key LIKE 'comment:%'
       AND length(idempotency_key) > 45
       AND substr(idempotency_key, length(idempotency_key) - 36, 1) = ':'`,
    `UPDATE actions
       SET reply_id = (
         SELECT r.id FROM comment_replies r
          WHERE r.thread_id = actions.thread_id
            AND r.created_at = actions.created_at
            AND r.author_principal_id = actions.principal_id)
     WHERE action = 'comment_reply'
       AND reply_id IS NULL
       AND thread_id IS NOT NULL
       AND (SELECT count(*) FROM comment_replies r
             WHERE r.thread_id = actions.thread_id
               AND r.created_at = actions.created_at
               AND r.author_principal_id = actions.principal_id) = 1`,
    `UPDATE actions
       SET access_to = (
         SELECT i.access_setting FROM idempotency_records i
          WHERE i.project_id = actions.project_id
            AND i.idempotency_key = actions.idempotency_key
            AND i.operation = 'change_access')
     WHERE action = 'change_access' AND access_to IS NULL`,
    `UPDATE actions
       SET access_from = (
         SELECT i.access_setting
           FROM actions p
           JOIN idempotency_records i
             ON i.project_id = p.project_id AND i.idempotency_key = p.idempotency_key
          WHERE p.project_id = actions.project_id
            AND p.artifact_id = actions.artifact_id
            AND i.access_setting IS NOT NULL
            AND (p.created_at < actions.created_at
              OR (p.created_at = actions.created_at AND p.id < actions.id))
          ORDER BY p.created_at DESC, p.id DESC
          LIMIT 1)
     WHERE action = 'change_access' AND access_from IS NULL`,
  ];
  const reconstructed = [
    `INSERT OR IGNORE INTO actions (${recoveredInsertColumns})
     SELECT 'recovered:dispatch_create:' || d.id, d.project_id, NULL, NULL,
       'dispatch_create', d.sender_principal_id, d.sender_authorized_by_principal_id,
       'recovered:dispatch_create:' || d.id, d.created_at, d.id,
       d.sender_display_name, d.sender_principal_kind,
       json_object('agentDisplayName', d.agent_display_name,
         'threadIds', json(d.thread_ids_json))
       FROM agent_dispatches d`,
    `INSERT OR IGNORE INTO actions (${recoveredInsertColumns})
     SELECT 'recovered:dispatch_addressed:' || d.id, d.project_id, NULL, NULL,
       'dispatch_addressed',
       (SELECT ra.principal_id FROM registered_agents ra WHERE ra.id = d.agent_id),
       NULL, 'recovered:dispatch_addressed:' || d.id, d.addressed_at, d.id,
       d.agent_display_name, 'service',
       json_object('agentDisplayName', d.agent_display_name)
       FROM agent_dispatches d
      WHERE d.addressed_at IS NOT NULL`,
    `INSERT OR IGNORE INTO actions (${recoveredInsertColumns})
     SELECT 'recovered:project_create:' || p.id, p.id, NULL, NULL,
       'project_create', NULL, NULL, 'recovered:project_create:' || p.id,
       p.created_at, p.id, NULL, NULL, json_object('name', p.name)
       FROM projects p
      WHERE p.id <> '${defaultProjectId}'`,
    `INSERT OR IGNORE INTO actions (${recoveredInsertColumns})
     SELECT 'recovered:project_archive:' || p.id, p.id, NULL, NULL,
       'project_archive', NULL, NULL, 'recovered:project_archive:' || p.id,
       p.archived_at, p.id, NULL, NULL, NULL
       FROM projects p
      WHERE p.archived_at IS NOT NULL`,
  ];
  const identityRows = options.identity
    ? [
      `INSERT OR IGNORE INTO actions (${recoveredInsertColumns})
       SELECT 'recovered:member_admit:' || m.id, NULL, NULL, NULL,
         'member_admit', NULL, NULL, 'recovered:member_admit:' || m.id,
         m.created_at, m.id, NULL, NULL, NULL
         FROM installation_members m`,
      `INSERT OR IGNORE INTO actions (${recoveredInsertColumns})
       SELECT 'recovered:' || kind || ':' || k.id, NULL, NULL, NULL,
         kind, k.authorized_by_principal_id, NULL,
         'recovered:' || kind || ':' || k.id, k.created_at, k.id, NULL, NULL,
         json_object('capabilities', json(k.capabilities_json))
         FROM (
           SELECT managed_api_keys.*,
             CASE WHEN rotated_from_id IS NULL THEN 'key_issue' ELSE 'key_rotate' END AS kind
             FROM managed_api_keys
         ) k`,
      `INSERT OR IGNORE INTO actions (${recoveredInsertColumns})
       SELECT 'recovered:key_revoke:' || k.id, NULL, NULL, NULL,
         'key_revoke', NULL, NULL, 'recovered:key_revoke:' || k.id,
         k.revoked_at, k.id, NULL, NULL, NULL
         FROM managed_api_keys k
        WHERE k.revoked_at IS NOT NULL`,
    ]
    : [];
  const actorNames = [
    `UPDATE actions
       SET (actor_name, actor_kind) = (
         SELECT t.author_display_name, t.author_principal_kind FROM comment_threads t
          WHERE t.id = actions.thread_id AND t.author_principal_id = actions.principal_id)
     WHERE actor_name IS NULL AND thread_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM comment_threads t
                    WHERE t.id = actions.thread_id
                      AND t.author_principal_id = actions.principal_id)`,
    `UPDATE actions
       SET (actor_name, actor_kind) = (
         SELECT r.author_display_name, r.author_principal_kind FROM comment_replies r
          WHERE r.thread_id = actions.thread_id AND r.author_principal_id = actions.principal_id
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT 1)
     WHERE actor_name IS NULL AND thread_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM comment_replies r
                    WHERE r.thread_id = actions.thread_id
                      AND r.author_principal_id = actions.principal_id)`,
    `UPDATE actions
       SET (actor_name, actor_kind) = (
         SELECT t.resolved_by_display_name, t.resolved_by_principal_kind FROM comment_threads t
          WHERE t.id = actions.thread_id AND t.resolved_by_principal_id = actions.principal_id)
     WHERE actor_name IS NULL AND thread_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM comment_threads t
                    WHERE t.id = actions.thread_id
                      AND t.resolved_by_principal_id = actions.principal_id)`,
    ...(options.identity
      ? [
        `UPDATE actions
           SET (actor_name, actor_kind) = (
             SELECT m.display_name, 'human' FROM installation_members m
              WHERE m.id = actions.principal_id)
         WHERE actor_name IS NULL AND principal_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM installation_members m
                        WHERE m.id = actions.principal_id)`,
        `UPDATE actions
           SET (actor_name, actor_kind) = (
             SELECT k.name, 'service' FROM managed_api_keys k
              WHERE k.id = substr(actions.principal_id, 9))
         WHERE actor_name IS NULL AND principal_id LIKE 'service:%'
           AND EXISTS (SELECT 1 FROM managed_api_keys k
                        WHERE k.id = substr(actions.principal_id, 9))`,
      ]
      : []),
  ];
  const publicLinks = [
    `INSERT OR IGNORE INTO actions (
       id, project_id, artifact_id, version_id, action, principal_id,
       authorized_by_principal_id, idempotency_key, created_at,
       access_from, access_to, actor_name, actor_kind)
     SELECT 'recovered:public_link_enable:' || a.id, a.project_id, a.artifact_id,
       a.version_id, 'public_link_enable', a.principal_id,
       a.authorized_by_principal_id, 'recovered:public_link_enable:' || a.id,
       a.created_at, a.access_from, a.access_to, a.actor_name, a.actor_kind
       FROM actions a
      WHERE a.action = 'change_access'
        AND a.access_from = 'account_required' AND a.access_to = 'public_link'`,
    `INSERT OR IGNORE INTO actions (
       id, project_id, artifact_id, version_id, action, principal_id,
       authorized_by_principal_id, idempotency_key, created_at,
       access_from, access_to, actor_name, actor_kind)
     SELECT 'recovered:public_link_disable:' || a.id, a.project_id, a.artifact_id,
       a.version_id, 'public_link_disable', a.principal_id,
       a.authorized_by_principal_id, 'recovered:public_link_disable:' || a.id,
       a.created_at, a.access_from, a.access_to, a.actor_name, a.actor_kind
       FROM actions a
      WHERE a.action = 'change_access'
        AND a.access_from = 'public_link' AND a.access_to = 'account_required'`,
    // An artifact still public that never changed access was published public.
    `INSERT OR IGNORE INTO actions (
       id, project_id, artifact_id, version_id, action, principal_id,
       authorized_by_principal_id, idempotency_key, created_at,
       access_from, access_to, actor_name, actor_kind)
     SELECT 'recovered:public_link_enable:' || p.id, p.project_id, p.artifact_id,
       p.version_id, 'public_link_enable', p.principal_id,
       p.authorized_by_principal_id, 'recovered:public_link_enable:' || p.id,
       p.created_at, NULL, 'public_link', p.actor_name, p.actor_kind
       FROM actions p
       JOIN artifacts art ON art.id = p.artifact_id
      WHERE art.access_setting = 'public_link'
        AND p.action IN (${firstPublicationKindSql})
        AND NOT EXISTS (SELECT 1 FROM actions c
                         WHERE c.artifact_id = p.artifact_id AND c.action = 'change_access')
        AND NOT EXISTS (SELECT 1 FROM actions e
                         WHERE e.artifact_id = p.artifact_id
                           AND e.action IN (${firstPublicationKindSql})
                           AND (e.created_at < p.created_at
                             OR (e.created_at = p.created_at AND e.id < p.id)))`,
  ];
  return [...threadAndAccess, ...reconstructed, ...identityRows, ...actorNames, ...publicLinks];
}
```

A `public_link_*` row is recovered only when the direction is known. A first `change_access` whose earlier setting was never recorded stays a plain `change_access`; a guess is never recorded.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm exec vitest run tests/storage/activity-log-schema.test.ts`

Expected: PASS, 4 tests.

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`

Expected: both exit 0. If an exhaustive `switch` or `Record<ArtifactActionKind, …>` elsewhere fails because of the two new artifact kinds, add the two cases there with the same treatment as `change_access`, and name the file in the commit message.

- [ ] **Step 7: Commit**

```bash
git add src/core/model.ts src/storage/activity-log-schema.ts tests/storage/activity-log-schema.test.ts
git commit -m "Define the installation activity log kinds and portable schema rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.2: SQLite copy into the activity-log shape, crash safety and the ACT-002 ledger entry

**Files:**
- Modify: `src/storage/sqlite-artifact-repository.ts`
  - `#migrate`, around lines 5546-5567: call the new helper last, before `PRAGMA user_version`.
  - `#tableColumns`, at 6185.
  - `listArtifactActions`, at 2187.
  - Add the helpers `#tableExists` and `#addInstallationActivityLogIfMissing`.
- Modify: `src/storage/sqlite-schema.ts:9` (`requiredSqliteSchemaVersion = 18`)
- Modify: `project/spec/conformance.yml`: add ACT-002 after AUD-001, around line 1109.
- Create: `tests/support/sqlite-activity-log.ts`, `tests/support/open-sqlite-artifact-repository.ts`
- Test: `tests/conformance/act-002-activity-log-migration.test.ts`

**Interfaces:**
- Consumes: `sqliteActionsRebuildStatements`, `sqliteActivityRecoveryStatements` and `artifactHistoryActionKindSql` from Task 2.1.
- Produces:
  - `SqliteArtifactRepository` migrates any file to the activity-log shape on construction.
  - On failure it throws `Error("SQLite migration installation_activity_log failed: …")`.
  - The test helpers listed in **Produces** above.

- [ ] **Step 1: Add the ACT-002 ledger entry**

`pnpm conformance:tests` rejects unknown IDs in test titles, so the entry comes first. Insert it in `project/spec/conformance.yml` directly after the AUD-001 block, which ends with `evidence: []` around line 1108:

```yaml
  - id: ACT-002
    kind: release_gate
    behavior: Existing installations upgrade their action history into the installation activity log without changing any action identity, idempotency key, timestamp, or attribution, and recover only activity the installation already recorded.
    owner: database-adapters
    source: {file: artifact-server-product-spec.html, anchor: artifact}
    acceptance:
      behavior: {id: ACT-002-B, description: "Populated SQLite, Postgres and D1 installations migrate with IDs, keys and timestamps preserved, and recoverable fields recovered."}
      failure: {id: ACT-002-F, description: "An interrupted or repeated migration cannot duplicate, drop or alter rows, or invent actors."}
    deployments: *all
    status: implementing
    proof_gap: The SQLite acceptance tests are being written; Postgres and D1 parity tests and deployment evidence are not attached.
    depends_on: [PRJ-004]
    evidence: []
```

Run: `pnpm conformance:validate`

Expected: exit 0, with the report counting one more `implementing` requirement.

- [ ] **Step 2: Write the test-support helpers**

Create `tests/support/open-sqlite-artifact-repository.ts`, the child-process entry point:

```ts
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";

const databasePath = process.argv[2];
if (databasePath === undefined) {
  throw new Error("Pass the SQLite database path as the first argument.");
}
const repository = new SqliteArtifactRepository(databasePath);
repository.close();
```

Create `tests/support/sqlite-activity-log.ts`:

```ts
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";

import {z} from "zod";

import {artifactHistoryActionKinds} from "../../src/core/model.js";

const legacyColumns = `id, project_id, artifact_id, version_id, action, principal_id,
  authorized_by_principal_id, idempotency_key, created_at`;
const historyKindSql = artifactHistoryActionKinds.map((kind) => `'${kind}'`).join(", ");

/** Open one SQLite file, run `read`, and always close the connection. */
export function withSqliteDatabase<Result>(
  databasePath: string,
  read: (database: DatabaseSync) => Result,
): Result {
  const database = new DatabaseSync(databasePath, {timeout: 5_000});
  try {
    return read(database);
  } finally {
    database.close();
  }
}

/**
 * Rebuild `actions` in the exact schema-17 shape, keeping only rows a
 * schema-17 file could hold, so a test can upgrade a realistic legacy file.
 */
export function downgradeSqliteActionsToLegacy(databasePath: string): void {
  withSqliteDatabase(databasePath, (database) => {
    database.exec("PRAGMA foreign_keys = OFF;");
    database.exec(`
      BEGIN IMMEDIATE;
      DROP TRIGGER IF EXISTS actions_project_insert;
      DROP TRIGGER IF EXISTS actions_project_update;
      CREATE TABLE actions_legacy (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version_id TEXT NOT NULL REFERENCES versions(id),
        action TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        authorized_by_principal_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO actions_legacy (${legacyColumns})
        SELECT ${legacyColumns} FROM actions
         WHERE id NOT LIKE 'recovered:%' AND action IN (${historyKindSql});
      DROP TABLE actions;
      ALTER TABLE actions_legacy RENAME TO actions;
      CREATE INDEX actions_artifact_created
        ON actions (project_id, artifact_id, created_at DESC, id DESC);
      CREATE TRIGGER actions_project_insert
      BEFORE INSERT ON actions
      WHEN NOT EXISTS (
        SELECT 1 FROM artifacts
        WHERE id = NEW.artifact_id AND project_id = NEW.project_id
      ) OR NOT EXISTS (
        SELECT 1 FROM versions
        WHERE id = NEW.version_id AND project_id = NEW.project_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'action project mismatch');
      END;
      CREATE TRIGGER actions_project_update
      BEFORE UPDATE OF project_id ON actions
      WHEN NEW.project_id <> OLD.project_id
      BEGIN
        SELECT RAISE(ABORT, 'action project cannot change');
      END;
      COMMIT;
    `);
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec("PRAGMA user_version = 17;");
  });
}

/** Append `count` legacy `change_tags` rows to one published artifact. */
export function insertBulkLegacyActions(
  databasePath: string,
  target: {
    readonly artifactId: string;
    readonly count: number;
    readonly projectId: string;
    readonly versionId: string;
  },
): void {
  withSqliteDatabase(databasePath, (database) => {
    database.prepare(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO actions (${legacyColumns})
      SELECT printf('act_bulk_%08d', i), ?, ?, ?, 'change_tags', 'principal-bulk', NULL,
        printf('bulk-%08d', i),
        strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01T00:00:00Z', '+' || i || ' seconds')
      FROM n
    `).run(target.count, target.projectId, target.artifactId, target.versionId);
  });
}

const legacyRowSchema = z.object({
  action: z.string(),
  artifact_id: z.string().nullable(),
  authorized_by_principal_id: z.string().nullable(),
  created_at: z.string(),
  id: z.string(),
  idempotency_key: z.string(),
  principal_id: z.string().nullable(),
  project_id: z.string().nullable(),
  version_id: z.string().nullable(),
});

/** Count and order-independent digest of the legacy columns of a migration's input rows. */
export interface ActionsDigest {
  readonly count: number;
  readonly digest: string;
}

function digestRows(rows: readonly unknown[]): ActionsDigest {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(`${JSON.stringify(row)}\n`);
  return {count: rows.length, digest: hash.digest("hex")};
}

/** Digest of every non-recovered row a schema-17 file could hold. */
export function legacyActionsDigest(database: DatabaseSync): ActionsDigest {
  return digestRows(z.array(legacyRowSchema).parse(database.prepare(`
    SELECT ${legacyColumns} FROM actions
     WHERE id NOT LIKE 'recovered:%' AND action IN (${historyKindSql})
     ORDER BY id
  `).all()));
}

/** Digest of every column of every row, to prove a repeated startup changes nothing. */
export function fullActionsDigest(database: DatabaseSync): ActionsDigest {
  return digestRows(database.prepare("SELECT * FROM actions ORDER BY id").all());
}

/** Names of the columns `actions` currently has. */
export function actionColumns(database: DatabaseSync): readonly string[] {
  return z.array(z.object({name: z.string()}))
    .parse(database.prepare("PRAGMA table_info(actions)").all())
    .map((column) => column.name);
}

/** Names of every table in the file. */
export function tableNames(database: DatabaseSync): readonly string[] {
  return z.array(z.object({name: z.string()}))
    .parse(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all())
    .map((table) => table.name);
}
```

- [ ] **Step 3: Write the failing ACT-002-F test**

Create `tests/conformance/act-002-activity-log-migration.test.ts`. Task 2.3 appends the B test to this same file.

```ts
import {spawn} from "node:child_process";
import {existsSync, statSync} from "node:fs";
import {copyFile, mkdtemp, rm} from "node:fs/promises";
import {once} from "node:events";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {defaultProjectId} from "../../src/core/model.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";
import {populateActivityHistory} from "../support/activity-history-fixture.js";
import {
  actionColumns,
  downgradeSqliteActionsToLegacy,
  fullActionsDigest,
  insertBulkLegacyActions,
  legacyActionsDigest,
  tableNames,
  withSqliteDatabase,
} from "../support/sqlite-activity-log.js";

const installationId = "act-002-installation";
const childScript = path.resolve(import.meta.dirname, "../support/open-sqlite-artifact-repository.ts");

interface ChildOutcome {
  readonly exitCode: number | null;
  readonly peakWalBytes: number;
  readonly signal: NodeJS.Signals | null;
}

/** Open the repository in a child process; optionally SIGKILL it once its WAL reaches `killAtWalBytes`. */
async function runMigrationChild(
  databasePath: string,
  killAtWalBytes: number | null,
): Promise<ChildOutcome> {
  const child = spawn(process.execPath, ["--import", "tsx", childScript, databasePath], {
    stdio: "ignore",
  });
  const walPath = `${databasePath}-wal`;
  let peakWalBytes = 0;
  const timer = setInterval(() => {
    const size = existsSync(walPath) ? statSync(walPath).size : 0;
    peakWalBytes = Math.max(peakWalBytes, size);
    if (killAtWalBytes !== null && size >= killAtWalBytes) child.kill("SIGKILL");
  }, 1);
  const [exitCode, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  clearInterval(timer);
  return {exitCode, peakWalBytes, signal};
}

/** A populated file with the history fixture, downgraded to the schema-17 actions shape. */
async function legacyInstallation(databasePath: string) {
  const artifacts = new SqliteArtifactRepository(databasePath, installationId);
  const identity = new SqliteIdentityRepository(databasePath);
  try {
    return await populateActivityHistory({artifacts, identity, installationId});
  } finally {
    identity.close();
    artifacts.close();
    downgradeSqliteActionsToLegacy(databasePath);
  }
}

describe("ACT-002 activity log migration (SQLite)", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "artifact-act-002-"));
  });

  afterEach(async () => {
    await rm(directory, {force: true, recursive: true});
  });

  test("ACT-002-F an interrupted or repeated migration cannot duplicate, drop or alter rows, or invent actors", {timeout: 180_000}, async () => {
    const databasePath = path.join(directory, "interrupted.db");
    const fixture = await legacyInstallation(databasePath);
    insertBulkLegacyActions(databasePath, {
      artifactId: fixture.artifactId,
      count: 300_000,
      projectId: defaultProjectId,
      versionId: fixture.versionId,
    });
    const legacy = withSqliteDatabase(databasePath, legacyActionsDigest);
    expect(legacy.count).toBeGreaterThan(300_000);

    // Measure one complete migration on a copy, then kill the real one at 60% of its peak log.
    const measuredPath = path.join(directory, "measured.db");
    await copyFile(databasePath, measuredPath);
    const measured = await runMigrationChild(measuredPath, null);
    expect(measured.exitCode).toBe(0);
    expect(measured.peakWalBytes).toBeGreaterThan(0);
    const killed = await runMigrationChild(databasePath, Math.floor(measured.peakWalBytes * 0.6));
    expect(killed.signal).toBe("SIGKILL");

    // The killed file still holds the complete legacy table and no half-built copy.
    withSqliteDatabase(databasePath, (database) => {
      expect(actionColumns(database)).not.toContain("subject_id");
      expect(tableNames(database)).not.toContain("actions_next");
      expect(tableNames(database)).not.toContain("actions_copy_check");
      expect(legacyActionsDigest(database)).toEqual(legacy);
    });

    // A restart completes the migration and keeps every legacy row byte for byte.
    new SqliteArtifactRepository(databasePath, installationId).close();
    const migrated = withSqliteDatabase(databasePath, (database) => {
      expect(actionColumns(database)).toContain("subject_id");
      expect(legacyActionsDigest(database)).toEqual(legacy);
      expect(database.prepare(`
        SELECT count(*) AS named FROM actions
         WHERE principal_id = 'principal-bulk' AND actor_name IS NOT NULL
      `).get()).toEqual({named: 0});
      return fullActionsDigest(database);
    });

    // A repeated startup changes nothing.
    new SqliteArtifactRepository(databasePath, installationId).close();
    expect(withSqliteDatabase(databasePath, fullActionsDigest)).toEqual(migrated);
  });
});
```

This test also imports `populateActivityHistory`, which Task 2.3 creates. Create a minimal version of it now so this task stays self-contained. It publishes one artifact; Task 2.3 replaces this file with the full history.

```ts
// tests/support/activity-history-fixture.ts (Task 2.2 version; Task 2.3 replaces it)
import {createHash} from "node:crypto";

import type {IdentityRepository} from "../../src/core/identity-ports.js";
import {defaultProjectId} from "../../src/core/model.js";
import type {ArtifactRepository, StagedUploadRepository} from "../../src/core/ports.js";
import {createManifest} from "../../src/manifest/create-manifest.js";

export interface ActivityHistoryStores {
  readonly artifacts: Pick<ArtifactRepository, "commitNewArtifact"> &
    Pick<StagedUploadRepository,
      | "claimUploadPreparation"
      | "createStagedUpload"
      | "markStagedFileUploaded"
      | "markUploadPrepared"
      | "recordStagedFileInstalled"
      | "writePreparedManifestEntries">;
  readonly identity: Pick<IdentityRepository, "admitMember">;
  readonly installationId: string;
}

export async function populateActivityHistory(stores: ActivityHistoryStores) {
  const at = "2026-09-03T09:00:00.000Z";
  const bytes = new TextEncoder().encode("<!doctype html><title>Activity fixture</title>");
  const manifest = createManifest({
    entryPath: "index.html",
    files: [{
      mediaType: "text/html",
      path: "index.html",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    }],
    routingMode: "static",
  });
  const uploadId = "upl_activity_fixture";
  const storageToken = "tok_activity_fixture";
  await stores.artifacts.createStagedUpload({
    createdAt: at,
    expiresAt: "2026-09-03T10:00:00.000Z",
    files: manifest.entries.map((entry) => ({entry, storageToken})),
    id: uploadId,
    idempotencyKey: "activity-fixture-upload",
    manifest,
    principalId: "member_dana",
    projectId: defaultProjectId,
  });
  await stores.artifacts.markStagedFileUploaded(defaultProjectId, uploadId, "member_dana", storageToken, at);
  const claim = await stores.artifacts.claimUploadPreparation(uploadId, at, "2026-09-03T09:10:00.000Z");
  if (claim === null) throw new Error("The activity fixture upload could not be claimed.");
  await stores.artifacts.recordStagedFileInstalled(uploadId, storageToken, claim.attempts, at);
  await stores.artifacts.writePreparedManifestEntries(uploadId, claim.attempts, manifest.entries);
  await stores.artifacts.markUploadPrepared(uploadId, claim.attempts, at);
  const published = await stores.artifacts.commitNewArtifact({
    accessSetting: "account_required",
    artifactId: "art_activity_fixture",
    authorizedByPrincipalId: null,
    contentToken: "content-activity-fixture",
    createdAt: at,
    idempotencyKey: "activity-fixture-publish",
    inputDigest: manifest.digest,
    manifest,
    name: "Inspector docking study",
    principalId: "member_dana",
    projectId: defaultProjectId,
    source: {kind: "staged_upload", principalId: "member_dana", projectId: defaultProjectId, uploadId},
    tags: [],
    versionId: "ver_activity_fixture_1",
  });
  return {artifactId: published.artifact.id, versionId: published.version.id};
}
```

- [ ] **Step 4: Run the test and confirm it fails**

Run: `pnpm exec vitest run tests/conformance/act-002-activity-log-migration.test.ts`

Expected: FAIL at `expect(actionColumns(database)).toContain("subject_id")` after the restart. Nothing migrates yet.

- [ ] **Step 5: Implement the SQLite migration**

In `src/storage/sqlite-artifact-repository.ts`, import the builders next to the existing `./sqlite-schema.js` import (`sqlite-artifact-repository.ts:136`):

```ts
import {
  artifactHistoryActionKindSql,
  sqliteActionsRebuildStatements,
  sqliteActivityRecoveryStatements,
} from "./activity-log-schema.js";
```

In `#migrate`, call the new helper after `this.#addStagedUploadPreparationColumnsIfMissing();` and after the `projects_active_created` index, immediately before `PRAGMA user_version`:

```ts
    this.#database.exec(`
      CREATE INDEX IF NOT EXISTS projects_active_created
        ON projects (archived_at, created_at, id);
    `);
    this.#addInstallationActivityLogIfMissing();
    this.#database.exec(`PRAGMA user_version = ${requiredSqliteSchemaVersion};`);
```

Add these private methods directly before `#tableColumns`:

```ts
  /**
   * Copy `actions` into the activity-log shape and recover recorded activity
   * in one IMMEDIATE transaction. The copy-check table aborts the transaction
   * unless every legacy row arrived unchanged; a crash before COMMIT leaves
   * the legacy table untouched, and the column guard retries next start.
   */
  #addInstallationActivityLogIfMissing(): void {
    if (this.#tableColumns("actions").includes("subject_id")) return;
    const identity = this.#tableExists("installation_members") &&
      this.#tableExists("managed_api_keys");
    try {
      this.#transaction(() => {
        for (const statement of [
          ...sqliteActionsRebuildStatements({strict: true}),
          ...sqliteActionTriggerStatements,
          ...sqliteActivityRecoveryStatements({identity}),
        ]) {
          this.#database.exec(statement);
        }
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`SQLite migration installation_activity_log failed: ${detail}`, {cause});
    }
  }

  #tableExists(table: string): boolean {
    return this.#database
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(table) !== undefined;
  }
```

Add this module-level constant near `commentActionIdentity` (`sqlite-artifact-repository.ts:6551`). Dropping `actions` drops its triggers, and installation rows have no artifact, so the project-match trigger only applies to artifact rows:

```ts
const sqliteActionTriggerStatements = [
  `CREATE TRIGGER IF NOT EXISTS actions_project_insert
   BEFORE INSERT ON actions
   WHEN NEW.artifact_id IS NOT NULL AND (
     NOT EXISTS (
       SELECT 1 FROM artifacts
       WHERE id = NEW.artifact_id AND project_id = NEW.project_id
     ) OR NOT EXISTS (
       SELECT 1 FROM versions
       WHERE id = NEW.version_id AND project_id = NEW.project_id
     )
   )
   BEGIN
     SELECT RAISE(ABORT, 'action project mismatch');
   END`,
  `CREATE TRIGGER IF NOT EXISTS actions_project_update
   BEFORE UPDATE OF project_id ON actions
   WHEN NEW.project_id IS NOT OLD.project_id
   BEGIN
     SELECT RAISE(ABORT, 'action project cannot change');
   END`,
] as const;
```

`#addProjectScopeIfMissing` re-runs `CREATE TRIGGER IF NOT EXISTS actions_project_insert` on every start. The new trigger already exists under that name, so the older body is never reinstalled.

Keep the per-artifact history unchanged. In `listArtifactActions` (`sqlite-artifact-repository.ts:2205`) change

```sql
           WHERE project_id = ? AND artifact_id = ?
```

to

```sql
           WHERE project_id = ? AND artifact_id = ?
             AND action IN (${artifactHistoryActionKindSql})
```

Make it a template literal; the string is built from constants, so no binding is needed.

In `src/storage/sqlite-schema.ts`:

```ts
/** SQLite schema revision required by this Artifact Server build. */
export const requiredSqliteSchemaVersion = 18;
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `pnpm exec vitest run tests/conformance/act-002-activity-log-migration.test.ts`

Expected: PASS, 1 test. Most of its time goes to inserting 300,000 rows and the two child runs.

If `killed.signal` is `null` because the child finished before reaching 60% of the measured peak, do not raise the fraction past 0.8. Print `measured.peakWalBytes` and stop for a decision instead. It means a transaction other than the copy dominates the write-ahead log.

- [ ] **Step 7: Run the existing SQLite storage and migration suites**

Run: `pnpm exec vitest run tests/storage tests/conformance/storage-migration.test.ts tests/conformance/cmt-011-comment-action-ledger.test.ts`

Expected: PASS. The `cmt-011` per-artifact action ledger, which uses strict schemas, is unchanged.

- [ ] **Step 8: Commit**

```bash
git add src/storage/sqlite-artifact-repository.ts src/storage/sqlite-schema.ts \
  project/spec/conformance.yml tests/support/sqlite-activity-log.ts \
  tests/support/open-sqlite-artifact-repository.ts tests/support/activity-history-fixture.ts \
  tests/conformance/act-002-activity-log-migration.test.ts
git commit -m "Copy SQLite actions into the activity log shape and survive an interrupted copy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.3: SQLite recovery of recorded activity (ACT-002-B)

**Files:**
- Replace: `tests/support/activity-history-fixture.ts`, with the full history used by SQLite, Postgres, D1 and the timing script.
- Modify: `tests/conformance/act-002-activity-log-migration.test.ts`, appending the B test.
- Add to `tests/support/sqlite-activity-log.ts`: `readSqliteActionRows`.

**Interfaces:**
- Consumes: Task 2.2's migration, which already runs `sqliteActivityRecoveryStatements`. This task proves it end to end against real repositories.
- Produces:
  - `populateActivityHistory(stores): Promise<ActivityHistoryFixture>`
  - `activityFixtureTimes`
  - `recoveredRowSchema` and `RecoveredActionRow`
  - `expectRecoveredActivity(rows, fixture)`

- [ ] **Step 1: Replace the fixture with the full recorded history**

Overwrite `tests/support/activity-history-fixture.ts`:

```ts
import {createHash} from "node:crypto";

import {expect} from "vitest";
import {z} from "zod";

import {principalCapabilities} from "../../src/core/identity.js";
import type {IdentityRepository} from "../../src/core/identity-ports.js";
import {type CommentAuthor, defaultProjectId} from "../../src/core/model.js";
import type {
  AgentDispatchRepository,
  ArtifactRepository,
  CommentRepository,
  ProjectRepository,
  StagedUploadRepository,
} from "../../src/core/ports.js";
import {createManifest} from "../../src/manifest/create-manifest.js";

/** Every recorded moment of the fixture history, oldest first. */
export const activityFixtureTimes = {
  projectCreated: "2026-09-01T09:00:00.000Z",
  danaAdmitted: "2026-09-01T10:00:00.000Z",
  rosaAdmitted: "2026-09-01T10:05:00.000Z",
  keyIssued: "2026-09-02T10:00:00.000Z",
  published: "2026-09-03T09:00:00.000Z",
  threadOpened: "2026-09-03T09:10:00.000Z",
  replied: "2026-09-03T09:20:00.000Z",
  resolved: "2026-09-03T09:30:00.000Z",
  secondThreadOpened: "2026-09-03T09:40:00.000Z",
  dispatched: "2026-09-03T09:50:00.000Z",
  tagged: "2026-09-03T09:55:00.000Z",
  madePublic: "2026-09-03T10:00:00.000Z",
  keyRevoked: "2026-09-04T10:00:00.000Z",
  projectArchived: "2026-09-05T09:00:00.000Z",
} as const;

const t = activityFixtureTimes;
const keyCapabilities = [principalCapabilities.readArtifacts, principalCapabilities.createArtifact];
const dana: CommentAuthor = {
  authorizedByPrincipalId: null,
  displayName: "Dana Okonkwo",
  principalId: "member_dana",
  principalKind: "human",
};
const rosa: CommentAuthor = {
  authorizedByPrincipalId: null,
  displayName: "Rosa Santoro",
  principalId: "member_rosa",
  principalKind: "human",
};

/** The repository slices the fixture needs; every backend's repositories satisfy them. */
export interface ActivityHistoryStores {
  readonly artifacts:
    & Pick<ArtifactRepository, "changeAccessSetting" | "changeTags" | "commitNewArtifact">
    & Pick<StagedUploadRepository,
      | "claimUploadPreparation"
      | "createStagedUpload"
      | "markStagedFileUploaded"
      | "markUploadPrepared"
      | "recordStagedFileInstalled"
      | "writePreparedManifestEntries">
    & Pick<CommentRepository, "createReply" | "createThread" | "updateThread">
    & Pick<AgentDispatchRepository, "createDispatch">
    & Pick<ProjectRepository, "createProject" | "setProjectArchive">;
  readonly identity: Pick<IdentityRepository, "admitMember" | "createApiKey" | "revokeApiKey">;
  readonly installationId: string;
}

export interface ActivityHistoryFixture {
  readonly artifactId: string;
  readonly dispatchId: string;
  readonly projectId: string;
  readonly replyId: string;
  readonly threads: {readonly dispatched: string; readonly resolved: string};
  readonly versionId: string;
}

/** Record one realistic history through the real repositories, in time order. */
export async function populateActivityHistory(
  stores: ActivityHistoryStores,
): Promise<ActivityHistoryFixture> {
  const {artifacts, identity, installationId} = stores;
  const projectId = "prj_activity_fixture";
  await artifacts.createProject({
    archivedAt: null,
    createdAt: t.projectCreated,
    id: projectId,
    installationId,
    name: "Claims workstation",
  });
  await identity.admitMember({
    createdAt: t.danaAdmitted,
    displayName: "Dana Okonkwo",
    email: "dana@example.test",
    id: "member_dana",
    installationId,
    role: "administrator",
  });
  await identity.admitMember({
    createdAt: t.rosaAdmitted,
    displayName: "Rosa Santoro",
    email: "rosa@example.test",
    id: "member_rosa",
    installationId,
    role: "member",
  });
  await identity.createApiKey({
    authorizedByPrincipalId: "member_dana",
    capabilities: keyCapabilities,
    createdAt: t.keyIssued,
    expiresAt: "2027-09-02T10:00:00.000Z",
    id: "key_ci",
    installationId,
    name: "CI publisher",
    prefix: "ask_ci_fixture",
    principalId: "service:key_ci",
    principalKind: "service",
    revokedAt: null,
    rotatedFromId: null,
    secretDigest: "digest-activity-fixture",
  });

  const bytes = new TextEncoder().encode("<!doctype html><title>Activity fixture</title>");
  const manifest = createManifest({
    entryPath: "index.html",
    files: [{
      mediaType: "text/html",
      path: "index.html",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    }],
    routingMode: "static",
  });
  const uploadId = "upl_activity_fixture";
  const storageToken = "tok_activity_fixture";
  await artifacts.createStagedUpload({
    createdAt: t.published,
    expiresAt: "2026-09-03T10:00:00.000Z",
    files: manifest.entries.map((entry) => ({entry, storageToken})),
    id: uploadId,
    idempotencyKey: "activity-fixture-upload",
    manifest,
    principalId: dana.principalId,
    projectId: defaultProjectId,
  });
  await artifacts.markStagedFileUploaded(defaultProjectId, uploadId, dana.principalId, storageToken, t.published);
  const claim = await artifacts.claimUploadPreparation(uploadId, t.published, "2026-09-03T09:10:00.000Z");
  if (claim === null) throw new Error("The activity fixture upload could not be claimed.");
  await artifacts.recordStagedFileInstalled(uploadId, storageToken, claim.attempts, t.published);
  await artifacts.writePreparedManifestEntries(uploadId, claim.attempts, manifest.entries);
  await artifacts.markUploadPrepared(uploadId, claim.attempts, t.published);
  const published = await artifacts.commitNewArtifact({
    accessSetting: "account_required",
    artifactId: "art_activity_fixture",
    authorizedByPrincipalId: null,
    contentToken: "content-activity-fixture",
    createdAt: t.published,
    idempotencyKey: "activity-fixture-publish",
    inputDigest: manifest.digest,
    manifest,
    name: "Inspector docking study",
    principalId: dana.principalId,
    projectId: defaultProjectId,
    source: {kind: "staged_upload", principalId: dana.principalId, projectId: defaultProjectId, uploadId},
    tags: [],
    versionId: "ver_activity_fixture_1",
  });
  const artifactId = published.artifact.id;
  const versionId = published.version.id;

  const resolved = await artifacts.createThread({
    anchor: null,
    artifactId,
    author: rosa,
    body: "The inspector overlaps the stage bar.",
    createdAt: t.threadOpened,
    id: "thr_activity_resolved",
    idempotencyKey: "activity-fixture-thread-1",
    installationId,
    path: null,
    projectId: defaultProjectId,
    versionId,
  });
  const reply = await artifacts.createReply({
    artifactId,
    author: dana,
    body: "Docked it to the right edge in v2.",
    createdAt: t.replied,
    id: "rep_activity_fixture",
    idempotencyKey: "activity-fixture-reply-1",
    projectId: defaultProjectId,
    threadId: resolved.thread.id,
  });
  await artifacts.updateThread({
    anchor: null,
    artifactId,
    authorizedByPrincipalId: null,
    body: null,
    principalId: rosa.principalId,
    projectId: defaultProjectId,
    state: {resolvedAt: t.resolved, resolvedBy: rosa, state: "resolved"},
    threadId: resolved.thread.id,
    updatedAt: t.resolved,
  });
  const dispatched = await artifacts.createThread({
    anchor: null,
    artifactId,
    author: rosa,
    body: "Can an agent tighten the spacing?",
    createdAt: t.secondThreadOpened,
    id: "thr_activity_dispatched",
    idempotencyKey: "activity-fixture-thread-2",
    installationId,
    path: null,
    projectId: defaultProjectId,
    versionId,
  });
  const dispatch = await artifacts.createDispatch({
    agentDisplayName: "Codex",
    agentId: "agent_codex",
    createdAt: t.dispatched,
    id: "dsp_activity_fixture",
    idempotencyKey: "activity-fixture-dispatch",
    installationId,
    note: null,
    projectId: defaultProjectId,
    sender: dana,
    threadIds: [dispatched.thread.id],
  });
  await artifacts.changeTags({
    artifactId,
    authorizedByPrincipalId: null,
    createdAt: t.tagged,
    expectedCurrentVersionId: versionId,
    idempotencyKey: "activity-fixture-tags",
    inputDigest: "activity-fixture-tags",
    principalId: dana.principalId,
    projectId: defaultProjectId,
    tags: ["claims"],
  });
  await artifacts.changeAccessSetting({
    accessSetting: "public_link",
    artifactId,
    authorizedByPrincipalId: null,
    createdAt: t.madePublic,
    expectedCurrentVersionId: versionId,
    idempotencyKey: "activity-fixture-public",
    inputDigest: "activity-fixture-public",
    principalId: dana.principalId,
    projectId: defaultProjectId,
  });
  await identity.revokeApiKey(installationId, "key_ci", t.keyRevoked);
  await artifacts.setProjectArchive({archivedAt: t.projectArchived, projectId});

  return {
    artifactId,
    dispatchId: dispatch.dispatch.id,
    projectId,
    replyId: reply.reply.id,
    threads: {dispatched: dispatched.thread.id, resolved: resolved.thread.id},
    versionId,
  };
}

/** One `actions` row read back with snake_case column names in any backend. */
export const recoveredRowSchema = z.object({
  access_from: z.string().nullable(),
  access_to: z.string().nullable(),
  action: z.string(),
  actor_kind: z.string().nullable(),
  actor_name: z.string().nullable(),
  artifact_id: z.string().nullable(),
  created_at: z.string(),
  detail_json: z.string().nullable(),
  id: z.string(),
  idempotency_key: z.string(),
  principal_id: z.string().nullable(),
  project_id: z.string().nullable(),
  reply_id: z.string().nullable(),
  subject_id: z.string().nullable(),
  thread_id: z.string().nullable(),
  version_id: z.string().nullable(),
});
export type RecoveredActionRow = z.infer<typeof recoveredRowSchema>;

/** The SELECT list every backend uses to read rows for `expectRecoveredActivity`. */
export const recoveredRowColumns = `id, project_id, artifact_id, version_id, action,
  principal_id, idempotency_key, created_at, thread_id, reply_id, subject_id,
  access_from, access_to, actor_name, actor_kind, detail_json`;

function only(rows: readonly RecoveredActionRow[], predicate: (row: RecoveredActionRow) => boolean, label: string): RecoveredActionRow {
  const matches = rows.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} row, found ${matches.length}.`);
  }
  const [row] = matches;
  if (row === undefined) throw new Error(`Missing ${label} row.`);
  return row;
}

/** Assert what a migrated backend recovered from the fixture history. */
export function expectRecoveredActivity(
  rows: readonly RecoveredActionRow[],
  fixture: ActivityHistoryFixture,
): void {
  const byId = (id: string) => only(rows, (row) => row.id === id, id);
  const detailOf = (row: RecoveredActionRow): unknown =>
    row.detail_json === null ? null : JSON.parse(row.detail_json);

  expect(only(rows, (row) => row.action === "comment_create" && row.thread_id === fixture.threads.resolved, "first thread"))
    .toMatchObject({actor_kind: "human", actor_name: "Rosa Santoro"});
  expect(only(rows, (row) => row.action === "comment_create" && row.thread_id === fixture.threads.dispatched, "second thread"))
    .toMatchObject({actor_name: "Rosa Santoro"});
  expect(only(rows, (row) => row.action === "comment_reply", "reply"))
    .toMatchObject({actor_name: "Dana Okonkwo", reply_id: fixture.replyId, thread_id: fixture.threads.resolved});
  expect(only(rows, (row) => row.action === "comment_resolve", "resolve"))
    .toMatchObject({actor_name: "Rosa Santoro", thread_id: fixture.threads.resolved});
  expect(only(rows, (row) => row.action === "publish", "publish"))
    .toMatchObject({actor_kind: "human", actor_name: "Dana Okonkwo"});

  const access = only(rows, (row) => row.action === "change_access", "access change");
  expect(access).toMatchObject({access_from: "account_required", access_to: "public_link", actor_name: "Dana Okonkwo"});
  expect(byId(`recovered:public_link_enable:${access.id}`)).toMatchObject({
    access_from: "account_required",
    access_to: "public_link",
    actor_name: "Dana Okonkwo",
    artifact_id: fixture.artifactId,
    created_at: activityFixtureTimes.madePublic,
    principal_id: "member_dana",
  });

  for (const [memberId, admittedAt] of [
    ["member_dana", activityFixtureTimes.danaAdmitted],
    ["member_rosa", activityFixtureTimes.rosaAdmitted],
  ] as const) {
    expect(byId(`recovered:member_admit:${memberId}`)).toMatchObject({
      actor_kind: null,
      actor_name: null,
      created_at: admittedAt,
      principal_id: null,
      project_id: null,
      subject_id: memberId,
    });
  }
  const issued = byId("recovered:key_issue:key_ci");
  expect(issued).toMatchObject({
    actor_kind: "human",
    actor_name: "Dana Okonkwo",
    created_at: activityFixtureTimes.keyIssued,
    principal_id: "member_dana",
    subject_id: "key_ci",
  });
  expect(detailOf(issued)).toEqual({capabilities: keyCapabilities});
  expect(byId("recovered:key_revoke:key_ci")).toMatchObject({
    actor_name: null,
    created_at: activityFixtureTimes.keyRevoked,
    principal_id: null,
  });

  const dispatch = byId(`recovered:dispatch_create:${fixture.dispatchId}`);
  expect(dispatch).toMatchObject({
    actor_kind: "human",
    actor_name: "Dana Okonkwo",
    artifact_id: null,
    created_at: activityFixtureTimes.dispatched,
    project_id: defaultProjectId,
    subject_id: fixture.dispatchId,
  });
  expect(detailOf(dispatch)).toEqual({agentDisplayName: "Codex", threadIds: [fixture.threads.dispatched]});

  const created = byId(`recovered:project_create:${fixture.projectId}`);
  expect(created).toMatchObject({created_at: activityFixtureTimes.projectCreated, project_id: fixture.projectId});
  expect(detailOf(created)).toEqual({name: "Claims workstation"});
  expect(byId(`recovered:project_archive:${fixture.projectId}`))
    .toMatchObject({created_at: activityFixtureTimes.projectArchived});
  expect(rows.some((row) => row.id === `recovered:project_create:${defaultProjectId}`)).toBe(false);

  // An actor is never half-known.
  expect(rows.filter((row) => (row.actor_name === null) !== (row.actor_kind === null))).toEqual([]);
}
```

Append to `tests/support/sqlite-activity-log.ts`:

```ts
import {type RecoveredActionRow, recoveredRowColumns, recoveredRowSchema} from "./activity-history-fixture.js";

/** Every `actions` row of one SQLite file, in the shared recovered-row shape. */
export function readSqliteActionRows(databasePath: string): readonly RecoveredActionRow[] {
  return withSqliteDatabase(databasePath, (database) =>
    z.array(recoveredRowSchema).parse(
      database.prepare(`SELECT ${recoveredRowColumns} FROM actions ORDER BY created_at, id`).all(),
    ));
}
```

Put this import at the top of the file with the other imports.

- [ ] **Step 2: Append the failing ACT-002-B test**

Add these imports to `tests/conformance/act-002-activity-log-migration.test.ts`:

```ts
import {expectRecoveredActivity} from "../support/activity-history-fixture.js";
import {readSqliteActionRows} from "../support/sqlite-activity-log.js";
```

Inside the `describe`, before the F test, add:

```ts
  test("ACT-002-B a populated SQLite installation keeps every action and recovers recorded activity", async () => {
    const databasePath = path.join(directory, "artifact-server.db");
    const fixture = await legacyInstallation(databasePath);
    // The agent answered before the upgrade; only its dispatch row recorded that.
    withSqliteDatabase(databasePath, (database) => {
      database.prepare(`
        UPDATE agent_dispatches
           SET state = 'addressed', addressed_at = ?, updated_at = ?
         WHERE id = ?
      `).run("2026-09-03T11:00:00.000Z", "2026-09-03T11:00:00.000Z", fixture.dispatchId);
    });
    const legacy = withSqliteDatabase(databasePath, legacyActionsDigest);
    const legacyArtifactIds = withSqliteDatabase(databasePath, (database) =>
      database.prepare("SELECT id FROM actions WHERE artifact_id = ? ORDER BY id")
        .all(fixture.artifactId).map((row) => String(row["id"])));

    const upgraded = new SqliteArtifactRepository(databasePath, installationId);
    try {
      expect(withSqliteDatabase(databasePath, legacyActionsDigest)).toEqual(legacy);
      const rows = readSqliteActionRows(databasePath);
      expectRecoveredActivity(rows, fixture);
      expect(rows.find((row) => row.id === `recovered:dispatch_addressed:${fixture.dispatchId}`))
        .toMatchObject({
          actor_kind: "service",
          actor_name: "Codex",
          created_at: "2026-09-03T11:00:00.000Z",
          project_id: defaultProjectId,
        });

      // The per-artifact history endpoint still returns exactly the legacy rows.
      const history = await upgraded.listArtifactActions({
        artifactId: fixture.artifactId,
        cursor: null,
        limit: 100,
        projectId: defaultProjectId,
      });
      expect(history.items.map((item) => item.id).sort()).toEqual(legacyArtifactIds);
    } finally {
      upgraded.close();
    }
  });
```

- [ ] **Step 3: Run the tests and look at the result**

Run: `pnpm exec vitest run tests/conformance/act-002-activity-log-migration.test.ts`

Expected: the B test runs against Task 2.2's migration, which already runs the recovery statements. If it passes on the first run, go to Step 5. If any assertion fails, it names the row or field, for example `Expected exactly one recovered:key_issue:key_ci row, found 0.`. Go to Step 4.

- [ ] **Step 4: Fix the recovery statement the failure names**

Change only the statement in `src/storage/activity-log-schema.ts` `sqliteActivityRecoveryStatements` that produces the failing row. Keep every statement idempotent: `UPDATE … WHERE <column> IS NULL`, or `INSERT OR IGNORE` with a `recovered:` id. Re-run Step 3 until it passes.

- [ ] **Step 5: Run the full root suite**

Run: `pnpm test`

Expected: PASS. This also rewrites `project/evidence/local-foundation.json`, which Task 2.7 cites.

- [ ] **Step 6: Commit**

```bash
git add tests/support/activity-history-fixture.ts tests/support/sqlite-activity-log.ts \
  tests/conformance/act-002-activity-log-migration.test.ts src/storage/activity-log-schema.ts
git commit -m "Recover recorded threads, access changes, members, keys, dispatches and projects into the activity log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.4: D1 migration and parity test

**Files:**
- Modify: `deploy/cloudflare/src/d1-migrations.ts`
  - Line 11: `requiredD1SchemaVersion = 16`.
  - Add `addInstallationActivityLogIfMissing`.
  - Call it from `migrateD1`.
- Modify: `deploy/cloudflare/src/d1-artifact-repository.ts:3189-3200` (per-artifact listing filter)
- Test: `deploy/cloudflare/tests/d1-activity-log-migration.test.ts`

**Interfaces:**
- Consumes: `sqliteActionsRebuildStatements({strict: false})`, `sqliteActivityRecoveryStatements({identity: true})`, `artifactHistoryActionKindSql`, `populateActivityHistory`, `expectRecoveredActivity`, `recoveredRowColumns` and `recoveredRowSchema`.
- Produces: `migrateD1` upgrades any D1 database to the activity-log shape. On failure it throws `Error("D1 migration installation_activity_log failed: …")`.

- [ ] **Step 1: Write the failing parity test**

Create `deploy/cloudflare/tests/d1-activity-log-migration.test.ts`. Its title carries no acceptance ID, because ACT-002-B is claimed by the SQLite test.

```ts
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";
import {getPlatformProxy} from "wrangler";
import {z} from "zod";

import {defaultProjectId} from "../../../src/core/model.js";
import {
  expectRecoveredActivity,
  populateActivityHistory,
  recoveredRowColumns,
  recoveredRowSchema,
} from "../../../tests/support/activity-history-fixture.js";
import {createD1ArtifactRepository} from "../src/d1-artifact-repository.js";
import {createD1IdentityRepository} from "../src/d1-identity-repository.js";
import {migrateD1} from "../src/d1-migrations.js";

const openLocalD1 = () => getPlatformProxy<{
  ARTIFACT_SERVER_D1_DATABASE: D1Database;
}>({
  configPath: fileURLToPath(new URL("../wrangler.git-store.test.jsonc", import.meta.url)),
  envFiles: [],
  persist: false,
  remoteBindings: false,
});

const schema15ActionKinds = [
  "publish", "restore", "change_access", "change_tags", "delete",
  "comment_create", "comment_reply", "comment_update",
  "comment_resolve", "comment_reopen", "comment_delete",
].map((kind) => `'${kind}'`).join(", ");
const legacyColumns = `id, project_id, artifact_id, version_id, action, principal_id,
  authorized_by_principal_id, idempotency_key, created_at`;

/** Put `actions` back in the schema-15 shape and mark the database as schema 15. */
async function downgradeD1ToSchema15(binding: D1Database): Promise<void> {
  await binding.batch([
    `CREATE TABLE actions_legacy (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      artifact_id TEXT NOT NULL REFERENCES artifacts(id),
      version_id TEXT NOT NULL REFERENCES versions(id),
      action TEXT NOT NULL CHECK (action IN (${schema15ActionKinds})),
      principal_id TEXT NOT NULL,
      authorized_by_principal_id TEXT,
      idempotency_key TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `INSERT INTO actions_legacy (${legacyColumns})
      SELECT ${legacyColumns} FROM actions
       WHERE id NOT LIKE 'recovered:%' AND action IN (${schema15ActionKinds})`,
    "DROP TABLE actions",
    "ALTER TABLE actions_legacy RENAME TO actions",
    `CREATE INDEX actions_artifact_created
      ON actions(project_id, artifact_id, created_at DESC, id DESC)`,
    "UPDATE artifact_server_schema SET version = 15 WHERE component = 'runtime'",
  ].map((statement) => binding.prepare(statement)));
}

const legacyRowsSql = `SELECT ${legacyColumns} FROM actions
  WHERE id NOT LIKE 'recovered:%' AND action IN (${schema15ActionKinds}) ORDER BY id`;

describe("D1 activity log migration", () => {
  it("upgrades a schema-15 database, keeps every action and recovers recorded activity", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-activity-log-migration";
    try {
      await migrateD1(binding, installationId);
      const fixture = await populateActivityHistory({
        artifacts: createD1ArtifactRepository(binding, installationId),
        identity: createD1IdentityRepository(binding),
        installationId,
      });
      await downgradeD1ToSchema15(binding);
      const legacy = (await binding.prepare(legacyRowsSql).all()).results;
      expect(legacy.length).toBeGreaterThan(0);

      await migrateD1(binding, installationId);

      expect((await binding.prepare(legacyRowsSql).all()).results).toEqual(legacy);
      const rows = z.array(recoveredRowSchema).parse(
        (await binding.prepare(`SELECT ${recoveredRowColumns} FROM actions`).all()).results,
      );
      expectRecoveredActivity(rows, fixture);
      expect(await binding.prepare(
        "SELECT version FROM artifact_server_schema WHERE component = 'runtime'",
      ).first<number>("version")).toBe(16);

      // A repeated migration changes nothing.
      const before = (await binding.prepare("SELECT * FROM actions ORDER BY id").all()).results;
      await migrateD1(binding, installationId);
      expect((await binding.prepare("SELECT * FROM actions ORDER BY id").all()).results).toEqual(before);

      const history = await createD1ArtifactRepository(binding, installationId).listArtifactActions({
        artifactId: fixture.artifactId,
        cursor: null,
        limit: 100,
        projectId: defaultProjectId,
      });
      expect(history.items.every((item) => !item.id.startsWith("recovered:"))).toBe(true);
    } finally {
      await proxy.dispose();
    }
  });
});
```

If `createD1ArtifactRepository`'s return type lacks one of the fixture's `Pick<…>` members, the typecheck error names it. Pass the D1 object that `deploy/cloudflare/src/worker.ts` composes for that port, and keep the fixture types unchanged.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --dir deploy/cloudflare exec vitest run tests/d1-activity-log-migration.test.ts`

Expected: FAIL. `D1_ERROR: no such column: thread_id` (from `recoveredRowColumns`), or the version assertion receives 15.

- [ ] **Step 3: Implement the D1 migration**

In `deploy/cloudflare/src/d1-migrations.ts`, add to the imports:

```ts
import {
  sqliteActionsRebuildStatements,
  sqliteActivityRecoveryStatements,
} from "../../../src/storage/activity-log-schema.js";
```

Set `export const requiredD1SchemaVersion = 16;`.

In `migrateD1`, add the call after the `if (current === null || current < requiredD1SchemaVersion) { … }` block and before the final `database.batch([...])` that writes the schema version. It is guarded by columns, not by version:

```ts
  await addInstallationActivityLogIfMissing(database);
```

Add the function next to the other `…IfMissing` helpers:

```ts
/**
 * Copy `actions` into the activity-log shape and recover recorded activity in
 * one atomic batch. The copy-check CHECK aborts the batch unless every legacy
 * row arrived unchanged.
 */
async function addInstallationActivityLogIfMissing(
  database: D1Database,
): Promise<void> {
  const columns = await database.prepare("PRAGMA table_info(actions)")
    .all<{name: string}>();
  if (columns.results.some((column) => column.name === "subject_id")) return;
  try {
    await database.batch([
      ...sqliteActionsRebuildStatements({strict: false}),
      ...sqliteActivityRecoveryStatements({identity: true}),
    ].map((statement) => database.prepare(statement)));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`D1 migration installation_activity_log failed: ${detail}`, {cause});
  }
}
```

In `deploy/cloudflare/src/d1-artifact-repository.ts` `listArtifactActions` (line 3194), import `artifactHistoryActionKindSql` from `../../../src/storage/activity-log-schema.js` and change the `WHERE` line to:

```ts
        FROM actions WHERE project_id = ? AND artifact_id = ?
          AND action IN (${artifactHistoryActionKindSql})
```

- [ ] **Step 4: Run the D1 suite**

Run: `pnpm --dir deploy/cloudflare exec vitest run`

Expected: PASS, including the existing `comment-runtime` and `agent-dispatch-runtime` schema assertions. They read `requiredD1SchemaVersion`, so 16 flows through.

If D1 rejects the batch over a statement or time limit, record the exact error. Then split only the recovery statements into a second batch, which is safe because every recovery statement is idempotent. The rebuild statements must stay in one batch.

- [ ] **Step 5: Run the Cloudflare gate**

Run: `pnpm check:cloudflare`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add deploy/cloudflare/src/d1-migrations.ts deploy/cloudflare/src/d1-artifact-repository.ts \
  deploy/cloudflare/tests/d1-activity-log-migration.test.ts
git commit -m "Migrate D1 actions into the activity log and recover recorded activity

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.5: Postgres migration `0018_installation_activity_log` and parity test

**Files:**
- Modify: `src/storage/postgres-migrations.ts`
  - Add `addInstallationActivityLog`.
  - Add the loader entry `"0018_installation_activity_log"` after line 733.
  - Set `requiredPostgresSchemaVersion = 18` (line 737).
  - Add `{migration_id: 18, name: "installation_activity_log"}` to `expectedHistory`.
- Modify: `src/storage/postgres-artifact-repository.ts:2052-2054` (per-artifact listing filter)
- Modify: `tests/configs/vitest.external-storage.config.ts` (add the new test to `include`)
- Test: `tests/integration/postgres-activity-log-migration.test.ts`

**Interfaces:**
- Consumes: `actionRowChecks`, `activityDetailJsonMaxBytes`, `artifactHistoryActionKindSql`, `defaultProjectId` and the fixture helpers.
- Produces: Postgres `actions` has the same columns, rules and recovered rows as SQLite and D1, scoped by `installation_id`. The constraint names are:
  - `actions_action_check`
  - `actions_scope_check`
  - `actions_principal_check`
  - `actions_actor_kind_check`
  - `actions_access_from_check`
  - `actions_access_to_check`
  - `actions_detail_check`

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/postgres-activity-log-migration.test.ts`:

```ts
import {randomUUID} from "node:crypto";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {defaultProjectId} from "../../src/core/model.js";
import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";
import {PostgresIdentityRepository} from "../../src/storage/postgres-identity-repository.js";
import {
  expectRecoveredActivity,
  populateActivityHistory,
  recoveredRowColumns,
  recoveredRowSchema,
} from "../support/activity-history-fixture.js";

const installationId = "postgres-activity-log-migration";
const schema17ActionKinds = [
  "publish", "restore", "change_access", "change_tags", "delete",
  "comment_create", "comment_reply", "comment_update",
  "comment_resolve", "comment_reopen", "comment_delete",
].map((kind) => `'${kind}'`).join(", ");
const legacyColumns = `id, project_id, artifact_id, version_id, action, principal_id,
  authorized_by_principal_id, idempotency_key, created_at`;

function readDatabaseUrl(): string {
  const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  if (databaseUrl === undefined) {
    throw new Error("Run this test through pnpm test:external-storage-runtime.");
  }
  return databaseUrl;
}

const query = (database: PostgresDatabase, statement: string, parameters: readonly unknown[] = []) =>
  database.run(Effect.gen(function*() {
    const sql = yield* SqlClient;
    return yield* sql.unsafe<Record<string, unknown>>(statement, parameters);
  }));

/** Reverse migration 0018 so the next open applies it to a populated schema-17 database. */
async function downgradeToSchema17(database: PostgresDatabase): Promise<void> {
  for (const statement of [
    `DELETE FROM actions WHERE id LIKE 'recovered:%' OR action NOT IN (${schema17ActionKinds})`,
    "DROP INDEX actions_installation_created",
    "DROP INDEX actions_installation_project_created",
    "DROP INDEX actions_installation_thread",
    "DROP INDEX actions_installation_idempotency",
    `ALTER TABLE actions
      DROP CONSTRAINT actions_scope_check,
      DROP CONSTRAINT actions_principal_check,
      DROP CONSTRAINT actions_actor_kind_check,
      DROP CONSTRAINT actions_access_from_check,
      DROP CONSTRAINT actions_access_to_check,
      DROP CONSTRAINT actions_detail_check,
      DROP CONSTRAINT actions_action_check,
      DROP COLUMN thread_id, DROP COLUMN reply_id, DROP COLUMN subject_id,
      DROP COLUMN access_from, DROP COLUMN access_to,
      DROP COLUMN actor_name, DROP COLUMN actor_kind, DROP COLUMN detail_json,
      ALTER COLUMN project_id SET NOT NULL,
      ALTER COLUMN artifact_id SET NOT NULL,
      ALTER COLUMN version_id SET NOT NULL,
      ALTER COLUMN principal_id SET NOT NULL,
      ADD CONSTRAINT actions_action_check CHECK (action IN (${schema17ActionKinds}))`,
    "DELETE FROM artifact_server_postgres_migrations WHERE migration_id >= 18",
  ]) {
    await query(database, statement);
  }
}

describe("Postgres activity log migration", () => {
  let control: PostgresDatabase;
  let scratch: string;
  let scratchUrl: Redacted.Redacted<string>;

  beforeEach(async () => {
    control = await PostgresDatabase.open({url: Redacted.make(readDatabaseUrl())}, "apply");
    scratch = `artifact_activity_log_${randomUUID().replaceAll("-", "")}`;
    await query(control, `CREATE DATABASE ${scratch}`);
    const url = new URL(readDatabaseUrl());
    url.pathname = `/${scratch}`;
    scratchUrl = Redacted.make(url.toString());
  });

  afterEach(async () => {
    await query(control, `DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    await control.close();
  });

  test("upgrades a populated schema-17 database, keeps every action and recovers recorded activity", async () => {
    const legacyRowsSql = `SELECT ${legacyColumns} FROM actions
      WHERE installation_id = $1 AND id NOT LIKE 'recovered:%'
        AND action IN (${schema17ActionKinds})
      ORDER BY id`;
    const seeded = await PostgresDatabase.open({url: scratchUrl}, "apply");
    let fixture;
    let legacyBefore: readonly Record<string, unknown>[] = [];
    try {
      const artifacts = await PostgresArtifactRepository.open(seeded, installationId);
      fixture = await populateActivityHistory({
        artifacts,
        identity: new PostgresIdentityRepository(seeded, installationId),
        installationId,
      });
      await downgradeToSchema17(seeded);
      legacyBefore = await query(seeded, legacyRowsSql, [installationId]);
    } finally {
      await seeded.close();
    }

    const upgraded = await PostgresDatabase.open({url: scratchUrl}, "apply");
    try {
      const rows = z.array(recoveredRowSchema).parse(await query(
        upgraded,
        `SELECT ${recoveredRowColumns} FROM actions WHERE installation_id = $1`,
        [installationId],
      ));
      expectRecoveredActivity(rows, fixture);
      // Every legacy row keeps its id, key, timestamp and attribution.
      expect(legacyBefore.length).toBeGreaterThan(0);
      expect(await query(upgraded, legacyRowsSql, [installationId])).toEqual(legacyBefore);

      const history = await (await PostgresArtifactRepository.open(upgraded, installationId))
        .listArtifactActions({
          artifactId: fixture.artifactId,
          cursor: null,
          limit: 100,
          projectId: defaultProjectId,
        });
      expect(history.items.every((item) => !item.id.startsWith("recovered:"))).toBe(true);

      // Reopening applies nothing and changes nothing.
      const before = await query(upgraded, legacyRowsSql, [installationId]);
      const again = await PostgresDatabase.open({url: scratchUrl}, "apply");
      try {
        expect(await query(again, `SELECT * FROM actions WHERE installation_id = $1 ORDER BY id`, [installationId]))
          .toEqual(await query(upgraded, `SELECT * FROM actions WHERE installation_id = $1 ORDER BY id`, [installationId]));
        expect(await query(again, legacyRowsSql, [installationId])).toEqual(before);
      } finally {
        await again.close();
      }
    } finally {
      await upgraded.close();
    }
  });
});
```

`let fixture;` is implicitly `any` under `strict`. Declare it as `let fixture: ActivityHistoryFixture | undefined;`, importing the type from the fixture module. Then add `if (fixture === undefined) throw new Error("The fixture was not recorded.");` before the first use, to satisfy the typecheck.

Add `"tests/integration/postgres-activity-log-migration.test.ts"` to `include` in `tests/configs/vitest.external-storage.config.ts`, keeping alphabetical order.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm test:external-storage-runtime`. It requires Docker and runs the whole external-storage suite.

Expected: the new test FAILS at `DROP INDEX actions_installation_created` (`index "actions_installation_created" does not exist`). The other files PASS.

- [ ] **Step 3: Implement migration 0018**

In `src/storage/postgres-migrations.ts`, add the import:

```ts
import {defaultProjectId} from "../core/model.js";
import {
  actionRowChecks,
  activityDetailJsonMaxBytes,
} from "./activity-log-schema.js";
```

Add before `const migrationLoader`:

```ts
const commentKinds = `'comment_create', 'comment_delete', 'comment_reopen',
  'comment_reply', 'comment_resolve', 'comment_update'`;
const firstPublicationKinds = "'capture', 'link', 'publish'";
const [
  actionKindCheck,
  scopeCheck,
  principalCheck,
  actorKindCheck,
  accessFromCheck,
  accessToCheck,
] = actionRowChecks;

const addInstallationActivityLog = Effect.gen(function*() {
  const sql = yield* SqlClient;
  const statements = [
    `ALTER TABLE actions
      ALTER COLUMN project_id DROP NOT NULL,
      ALTER COLUMN artifact_id DROP NOT NULL,
      ALTER COLUMN version_id DROP NOT NULL,
      ALTER COLUMN principal_id DROP NOT NULL,
      ADD COLUMN thread_id TEXT,
      ADD COLUMN reply_id TEXT,
      ADD COLUMN subject_id TEXT,
      ADD COLUMN access_from TEXT,
      ADD COLUMN access_to TEXT,
      ADD COLUMN actor_name TEXT,
      ADD COLUMN actor_kind TEXT,
      ADD COLUMN detail_json TEXT,
      DROP CONSTRAINT actions_action_check,
      ADD CONSTRAINT actions_action_check CHECK (${actionKindCheck}),
      ADD CONSTRAINT actions_scope_check CHECK (${scopeCheck}),
      ADD CONSTRAINT actions_principal_check CHECK (${principalCheck}),
      ADD CONSTRAINT actions_actor_kind_check CHECK (${actorKindCheck}),
      ADD CONSTRAINT actions_access_from_check CHECK (${accessFromCheck}),
      ADD CONSTRAINT actions_access_to_check CHECK (${accessToCheck}),
      ADD CONSTRAINT actions_detail_check CHECK (
        detail_json IS NULL OR octet_length(detail_json) <= ${activityDetailJsonMaxBytes}
      )`,
    `CREATE INDEX actions_installation_created
      ON actions (installation_id, created_at DESC, id DESC)`,
    `CREATE INDEX actions_installation_project_created
      ON actions (installation_id, project_id, created_at DESC, id DESC)`,
    `CREATE INDEX actions_installation_thread
      ON actions (installation_id, thread_id) WHERE thread_id IS NOT NULL`,
    `CREATE UNIQUE INDEX actions_installation_idempotency
      ON actions (installation_id, idempotency_key) WHERE project_id IS NULL`,
    // comment:<threadId>:<36-character uuid>
    `UPDATE actions
       SET thread_id = substr(idempotency_key, 9, length(idempotency_key) - 45)
     WHERE action IN (${commentKinds})
       AND thread_id IS NULL
       AND idempotency_key LIKE 'comment:%'
       AND length(idempotency_key) > 45
       AND substr(idempotency_key, length(idempotency_key) - 36, 1) = ':'`,
    `UPDATE actions a SET reply_id = r.id
       FROM comment_replies r
      WHERE a.action = 'comment_reply' AND a.reply_id IS NULL AND a.thread_id IS NOT NULL
        AND r.installation_id = a.installation_id AND r.thread_id = a.thread_id
        AND r.created_at = a.created_at AND r.author_principal_id = a.principal_id
        AND (SELECT count(*) FROM comment_replies r2
              WHERE r2.installation_id = a.installation_id AND r2.thread_id = a.thread_id
                AND r2.created_at = a.created_at
                AND r2.author_principal_id = a.principal_id) = 1`,
    `UPDATE actions a SET access_to = i.access_setting
       FROM idempotency_records i
      WHERE a.action = 'change_access' AND a.access_to IS NULL
        AND i.installation_id = a.installation_id AND i.project_id = a.project_id
        AND i.idempotency_key = a.idempotency_key AND i.operation = 'change_access'`,
    `UPDATE actions a SET access_from = (
       SELECT i.access_setting
         FROM actions p
         JOIN idempotency_records i
           ON i.installation_id = p.installation_id AND i.project_id = p.project_id
          AND i.idempotency_key = p.idempotency_key
        WHERE p.installation_id = a.installation_id AND p.project_id = a.project_id
          AND p.artifact_id = a.artifact_id AND i.access_setting IS NOT NULL
          AND (p.created_at < a.created_at OR (p.created_at = a.created_at AND p.id < a.id))
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT 1)
      WHERE a.action = 'change_access' AND a.access_from IS NULL`,
    `INSERT INTO actions (installation_id, id, project_id, artifact_id, version_id,
       action, principal_id, authorized_by_principal_id, idempotency_key, created_at,
       subject_id, actor_name, actor_kind, detail_json)
     SELECT d.installation_id, 'recovered:dispatch_create:' || d.id, d.project_id,
       NULL, NULL, 'dispatch_create', d.sender_principal_id,
       d.sender_authorized_by_principal_id, 'recovered:dispatch_create:' || d.id,
       d.created_at, d.id, d.sender_display_name, d.sender_principal_kind,
       json_build_object('agentDisplayName', d.agent_display_name,
         'threadIds', d.thread_ids_json::json)::text
       FROM agent_dispatches d
     ON CONFLICT DO NOTHING`,
    `INSERT INTO actions (installation_id, id, project_id, artifact_id, version_id,
       action, principal_id, authorized_by_principal_id, idempotency_key, created_at,
       subject_id, actor_name, actor_kind, detail_json)
     SELECT d.installation_id, 'recovered:dispatch_addressed:' || d.id, d.project_id,
       NULL, NULL, 'dispatch_addressed',
       (SELECT ra.principal_id FROM registered_agents ra
         WHERE ra.installation_id = d.installation_id AND ra.id = d.agent_id),
       NULL, 'recovered:dispatch_addressed:' || d.id, d.addressed_at, d.id,
       d.agent_display_name, 'service',
       json_build_object('agentDisplayName', d.agent_display_name)::text
       FROM agent_dispatches d
      WHERE d.addressed_at IS NOT NULL
     ON CONFLICT DO NOTHING`,
    `INSERT INTO actions (installation_id, id, project_id, artifact_id, version_id,
       action, principal_id, authorized_by_principal_id, idempotency_key, created_at,
       subject_id, actor_name, actor_kind, detail_json)
     SELECT p.installation_id, 'recovered:project_create:' || p.id, p.id, NULL, NULL,
       'project_create', NULL, NULL, 'recovered:project_create:' || p.id,
       p.created_at, p.id, NULL, NULL, json_build_object('name', p.name)::text
       FROM projects p
      WHERE p.id <> '${defaultProjectId}'
     ON CONFLICT DO NOTHING`,
    `INSERT INTO actions (installation_id, id, project_id, artifact_id, version_id,
       action, principal_id, authorized_by_principal_id, idempotency_key, created_at,
       subject_id, actor_name, actor_kind, detail_json)
     SELECT p.installation_id, 'recovered:project_archive:' || p.id, p.id, NULL, NULL,
       'project_archive', NULL, NULL, 'recovered:project_archive:' || p.id,
       p.archived_at, p.id, NULL, NULL, NULL
       FROM projects p
      WHERE p.archived_at IS NOT NULL
     ON CONFLICT DO NOTHING`,
    `INSERT INTO actions (installation_id, id, project_id, artifact_id, version_id,
       action, principal_id, authorized_by_principal_id, idempotency_key, created_at,
       subject_id, actor_name, actor_kind, detail_json)
     SELECT m.installation_id, 'recovered:member_admit:' || m.id, NULL, NULL, NULL,
       'member_admit', NULL, NULL, 'recovered:member_admit:' || m.id,
       m.created_at, m.id, NULL, NULL, NULL
       FROM installation_members m
     ON CONFLICT DO NOTHING`,
    `INSERT INTO actions (installation_id, id, project_id, artifact_id, version_id,
       action, principal_id, authorized_by_principal_id, idempotency_key, created_at,
       subject_id, actor_name, actor_kind, detail_json)
     SELECT k.installation_id, 'recovered:' || k.kind || ':' || k.id, NULL, NULL, NULL,
       k.kind, k.authorized_by_principal_id, NULL,
       'recovered:' || k.kind || ':' || k.id, k.created_at, k.id, NULL, NULL,
       json_build_object('capabilities', k.capabilities_json::json)::text
       FROM (
         SELECT managed_api_keys.*,
           CASE WHEN rotated_from_id IS NULL THEN 'key_issue' ELSE 'key_rotate' END AS kind
           FROM managed_api_keys
       ) k
     ON CONFLICT DO NOTHING`,
    `INSERT INTO actions (installation_id, id, project_id, artifact_id, version_id,
       action, principal_id, authorized_by_principal_id, idempotency_key, created_at,
       subject_id, actor_name, actor_kind, detail_json)
     SELECT k.installation_id, 'recovered:key_revoke:' || k.id, NULL, NULL, NULL,
       'key_revoke', NULL, NULL, 'recovered:key_revoke:' || k.id,
       k.revoked_at, k.id, NULL, NULL, NULL
       FROM managed_api_keys k
      WHERE k.revoked_at IS NOT NULL
     ON CONFLICT DO NOTHING`,
    `UPDATE actions a SET actor_name = t.author_display_name, actor_kind = t.author_principal_kind
       FROM comment_threads t
      WHERE a.actor_name IS NULL AND a.thread_id IS NOT NULL
        AND t.installation_id = a.installation_id AND t.id = a.thread_id
        AND t.author_principal_id = a.principal_id`,
    `UPDATE actions a SET actor_name = r.author_display_name, actor_kind = r.author_principal_kind
       FROM (
         SELECT DISTINCT ON (installation_id, thread_id, author_principal_id)
           installation_id, thread_id, author_principal_id,
           author_display_name, author_principal_kind
           FROM comment_replies
          ORDER BY installation_id, thread_id, author_principal_id, created_at DESC, id DESC
       ) r
      WHERE a.actor_name IS NULL AND a.thread_id IS NOT NULL
        AND r.installation_id = a.installation_id AND r.thread_id = a.thread_id
        AND r.author_principal_id = a.principal_id`,
    `UPDATE actions a SET actor_name = t.resolved_by_display_name,
       actor_kind = t.resolved_by_principal_kind
       FROM comment_threads t
      WHERE a.actor_name IS NULL AND a.thread_id IS NOT NULL
        AND t.installation_id = a.installation_id AND t.id = a.thread_id
        AND t.resolved_by_principal_id = a.principal_id`,
    `UPDATE actions a SET actor_name = m.display_name, actor_kind = 'human'
       FROM installation_members m
      WHERE a.actor_name IS NULL AND a.principal_id IS NOT NULL
        AND m.installation_id = a.installation_id AND m.id = a.principal_id`,
    `UPDATE actions a SET actor_name = k.name, actor_kind = 'service'
       FROM managed_api_keys k
      WHERE a.actor_name IS NULL AND a.principal_id LIKE 'service:%'
        AND k.installation_id = a.installation_id AND k.id = substr(a.principal_id, 9)`,
    `INSERT INTO actions (installation_id, id, project_id, artifact_id, version_id,
       action, principal_id, authorized_by_principal_id, idempotency_key, created_at,
       access_from, access_to, actor_name, actor_kind)
     SELECT a.installation_id, 'recovered:public_link_enable:' || a.id, a.project_id,
       a.artifact_id, a.version_id, 'public_link_enable', a.principal_id,
       a.authorized_by_principal_id, 'recovered:public_link_enable:' || a.id,
       a.created_at, a.access_from, a.access_to, a.actor_name, a.actor_kind
       FROM actions a
      WHERE a.action = 'change_access'
        AND a.access_from = 'account_required' AND a.access_to = 'public_link'
     ON CONFLICT DO NOTHING`,
    `INSERT INTO actions (installation_id, id, project_id, artifact_id, version_id,
       action, principal_id, authorized_by_principal_id, idempotency_key, created_at,
       access_from, access_to, actor_name, actor_kind)
     SELECT a.installation_id, 'recovered:public_link_disable:' || a.id, a.project_id,
       a.artifact_id, a.version_id, 'public_link_disable', a.principal_id,
       a.authorized_by_principal_id, 'recovered:public_link_disable:' || a.id,
       a.created_at, a.access_from, a.access_to, a.actor_name, a.actor_kind
       FROM actions a
      WHERE a.action = 'change_access'
        AND a.access_from = 'public_link' AND a.access_to = 'account_required'
     ON CONFLICT DO NOTHING`,
    `INSERT INTO actions (installation_id, id, project_id, artifact_id, version_id,
       action, principal_id, authorized_by_principal_id, idempotency_key, created_at,
       access_from, access_to, actor_name, actor_kind)
     SELECT p.installation_id, 'recovered:public_link_enable:' || p.id, p.project_id,
       p.artifact_id, p.version_id, 'public_link_enable', p.principal_id,
       p.authorized_by_principal_id, 'recovered:public_link_enable:' || p.id,
       p.created_at, NULL, 'public_link', p.actor_name, p.actor_kind
       FROM actions p
       JOIN artifacts art ON art.installation_id = p.installation_id AND art.id = p.artifact_id
      WHERE art.access_setting = 'public_link'
        AND p.action IN (${firstPublicationKinds})
        AND NOT EXISTS (SELECT 1 FROM actions c
                         WHERE c.installation_id = p.installation_id
                           AND c.artifact_id = p.artifact_id AND c.action = 'change_access')
        AND NOT EXISTS (SELECT 1 FROM actions e
                         WHERE e.installation_id = p.installation_id
                           AND e.artifact_id = p.artifact_id
                           AND e.action IN (${firstPublicationKinds})
                           AND (e.created_at < p.created_at
                             OR (e.created_at = p.created_at AND e.id < p.id)))
     ON CONFLICT DO NOTHING`,
  ] as const;

  for (const statement of statements) {
    yield* sql.unsafe(statement);
  }
});
```

Register it and bump the version:

```ts
  "0017_staged_upload_cleanup_claim": addStagedUploadCleanupClaim,
  "0018_installation_activity_log": addInstallationActivityLog,
});

/** Schema revision required by this Artifact Server build. */
export const requiredPostgresSchemaVersion = 18;
```

Append `{migration_id: 18, name: "installation_activity_log"}` after the `staged_upload_cleanup_claim` entry in `expectedHistory`.

`runPostgresMigrations` already wraps every pending migration in one transaction under `pg_advisory_xact_lock`. An interrupted 0018 rolls back completely and reruns on the next open.

In `src/storage/postgres-artifact-repository.ts` `listArtifactActions` (line 2053), import `artifactHistoryActionKindSql` and change

```sql
         WHERE installation_id = $1 AND project_id = $2 AND artifact_id = $3
```

to

```sql
         WHERE installation_id = $1 AND project_id = $2 AND artifact_id = $3
           AND action IN (${artifactHistoryActionKindSql})
```

- [ ] **Step 4: Run the external-storage suite**

Run: `pnpm test:external-storage-runtime`

Expected: PASS for every file, including `external-storage-runtime.test.ts`, whose migration-status assertions read `requiredPostgresSchemaVersion`.

- [ ] **Step 5: Typecheck and run the root suite**

Run: `pnpm typecheck && pnpm test`

Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/storage/postgres-migrations.ts src/storage/postgres-artifact-repository.ts \
  tests/integration/postgres-activity-log-migration.test.ts tests/configs/vitest.external-storage.config.ts
git commit -m "Add Postgres migration 0018 for the installation activity log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Note for later slices:** if a later slice adds migration `0019+`, extend `downgradeToSchema17` in this test so it also reverts that migration. The `>= 18` delete already removes its history row.

---

### Task 2.6: 1,000,000-action SQLite migration timing with the 30-second stop

**Files:**
- Create: `project/performance/run-activity-migration-baseline.ts`
- Modify: `package.json` (add a `perf:activity-migration` script next to `perf:comment-polling`, line 60)
- Output: `project/evidence/activity-migration-baseline.json`

**Interfaces:**
- Consumes: `populateActivityHistory`, `downgradeSqliteActionsToLegacy`, `insertBulkLegacyActions`, `captureMeasurementContext` (`project/performance/measurement-context.ts`), `SqliteArtifactRepository` and `SqliteIdentityRepository`.
- Produces: a JSON report with `migrationSeconds`, `limitSeconds` and `success`. The script exits 1 when the migration exceeds the limit.

- [ ] **Step 1: Write the script**

```ts
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {performance} from "node:perf_hooks";

import {Command} from "commander";
import {z} from "zod";

import {defaultProjectId} from "../../src/core/model.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";
import {populateActivityHistory} from "../../tests/support/activity-history-fixture.js";
import {
  downgradeSqliteActionsToLegacy,
  insertBulkLegacyActions,
} from "../../tests/support/sqlite-activity-log.js";
import {captureMeasurementContext} from "./measurement-context.js";

const optionsSchema = z.object({
  actions: z.coerce.number().int().min(1_000).max(5_000_000),
  limitSeconds: z.coerce.number().positive(),
  output: z.string().min(1),
});

const program = new Command()
  .name("activity-migration-baseline")
  .description("Time the SQLite activity-log migration of a populated schema-17 file.")
  .option("--actions <count>", "legacy actions in the measured file", "1000000")
  .option("--limit-seconds <seconds>", "stop threshold from the spec", "30")
  .option("--output <path>", "JSON report path", "project/evidence/activity-migration-baseline.json");

async function main(): Promise<void> {
  program.parse();
  const options = optionsSchema.parse(program.opts());
  const directory = await mkdtemp(path.join(tmpdir(), "artifact-activity-migration-"));
  try {
    const databasePath = path.join(directory, "artifact-server.db");
    const installationId = "activity-migration-baseline";
    const artifacts = new SqliteArtifactRepository(databasePath, installationId);
    const identity = new SqliteIdentityRepository(databasePath);
    let fixture;
    try {
      fixture = await populateActivityHistory({artifacts, identity, installationId});
    } finally {
      identity.close();
      artifacts.close();
    }
    downgradeSqliteActionsToLegacy(databasePath);
    insertBulkLegacyActions(databasePath, {
      artifactId: fixture.artifactId,
      count: options.actions,
      projectId: defaultProjectId,
      versionId: fixture.versionId,
    });

    // The constructor is the whole startup path, including every per-start migration helper.
    const started = performance.now();
    new SqliteArtifactRepository(databasePath, installationId).close();
    const migrationSeconds = (performance.now() - started) / 1_000;

    const environment = await captureMeasurementContext();
    const success = migrationSeconds <= options.limitSeconds;
    const report = {
      ...environment,
      completedAt: new Date().toISOString(),
      configuration: {actions: options.actions},
      limitSeconds: options.limitSeconds,
      migrationSeconds,
      note: "Wall time of one SqliteArtifactRepository startup over a populated schema-17 file: the verified actions copy, trigger and index creation, and recovery of recorded activity, plus the per-start migration helpers. Fixture population and bulk insertion are excluded.",
      startedAt: environment.capturedAt,
      success,
      target: "local",
    };
    await mkdir(path.dirname(options.output), {recursive: true});
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(
      `Activity-log migration of ${options.actions} actions: ${migrationSeconds.toFixed(2)} s (limit ${options.limitSeconds} s).\nReport: ${options.output}\n`,
    );
    if (!success) {
      process.stderr.write("The migration exceeds the spec's 30-second stop. Stop and report before continuing.\n");
      process.exitCode = 1;
    }
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
}

void main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.message : "The activity migration baseline failed."}\n`);
  process.exitCode = 1;
});
```

Type `fixture` the same way as in Task 2.5: `let fixture: ActivityHistoryFixture | undefined;`, plus a guard before use.

Add to `package.json` `scripts`:

```json
    "perf:activity-migration": "node --import tsx project/performance/run-activity-migration-baseline.ts",
```

- [ ] **Step 2: Run a small smoke check**

Run: `pnpm perf:activity-migration --actions 10000 --output /private/tmp/claude-501/activity-migration-smoke.json`

Expected: exit 0. It prints `Activity-log migration of 10000 actions: <n> s (limit 30 s).`

- [ ] **Step 3: Run the 1,000,000-action measurement**

Run: `pnpm perf:activity-migration`

Expected: exit 0, with `migrationSeconds` at or below 30 in `project/evidence/activity-migration-baseline.json`.

If it exits 1, **stop**. Report the measured seconds, the machine (`cpu`, `node` in the report) and whether the copy or the recovery dominates. To find out, time the copy alone with `--actions 1000000` against a branch where `sqliteActivityRecoveryStatements` returns `[]`, and do not commit that change. Do not tighten or loosen the limit; it is a spec decision.

- [ ] **Step 4: Record the finding**

Add one row to the risk table in `project/performance/FINDINGS.md` with:

- the measured seconds, the machine and the date;
- the decision: within budget, or stopped for a decision.

- [ ] **Step 5: Commit**

```bash
git add project/performance/run-activity-migration-baseline.ts package.json \
  project/evidence/activity-migration-baseline.json project/performance/FINDINGS.md
git commit -m "Measure the SQLite activity-log migration at one million actions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.7: Attach ACT-002 evidence

**Files:**
- Modify: `project/spec/conformance.yml` (the ACT-002 block from Task 2.2)

**Interfaces:**
- Consumes: `project/evidence/local-foundation.json`, written by `pnpm test`.
- Produces: ACT-002 at `behavior_verified`, with local evidence and an honest proof gap.

- [ ] **Step 1: Produce fresh local evidence**

Run: `pnpm test`

Expected: PASS. `project/evidence/local-foundation.json` now contains passing results titled `ACT-002-B …` and `ACT-002-F …`.

- [ ] **Step 2: Update the ACT-002 block**

Replace the ACT-002 `status`, `proof_gap` and `evidence` lines with the following. Use `date -u +%Y-%m-%dT%H:%M:%SZ` for `recorded_at`, taken after Step 1.

```yaml
    status: behavior_verified
    proof_gap: SQLite behavior and failure tests pass locally. Postgres (tests/integration/postgres-activity-log-migration.test.ts, via pnpm test:external-storage-runtime) and D1 (deploy/cloudflare/tests/d1-activity-log-migration.test.ts, via pnpm check:cloudflare) parity tests carry no acceptance IDs, and no single_server, kubernetes, cloudflare, aws or gcp deployment evidence is attached. Interrupted-migration proof exists for SQLite only; Postgres relies on its transactional migrator and D1 on its atomic batch, neither crash-tested.
    depends_on: [PRJ-004]
    evidence:
      - deployment: local
        tests: [ACT-002-B, ACT-002-F]
        result: pass
        run: project/evidence/local-foundation.json
        recorded_at: "<UTC timestamp from date -u>"
```

- [ ] **Step 3: Validate the ledger**

Run: `pnpm conformance:validate && pnpm conformance:tests`

Expected: both exit 0. `conformance:tests` reports exactly one implementation test for each of `ACT-002-B` and `ACT-002-F`.

- [ ] **Step 4: Run the slice gate**

Run: `pnpm check`

Expected: exit 0.

Also run `pnpm smoke`, as `AGENTS.md` requires after changing SQLite. Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add project/spec/conformance.yml project/evidence/local-foundation.json
git commit -m "Attach local evidence for the activity log migration

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
## Slice 2b: Record every mutation in the activity log

Spec: §1 "Writes". Requirements: ACT-001, plus the first evidence for AUD-001.

This slice depends on slice 2a (Tasks 2.1–2.3). Slice 2a adds these nullable columns to `actions` in SQLite, Postgres and D1:

- `thread_id`, `reply_id`, `subject_id`
- `access_from`, `access_to`
- `actor_name`, `actor_kind`
- `detail_json`

It also makes three existing columns nullable for installation kinds: `project_id`, `artifact_id`/`version_id`, and `principal_id`. It widens the Postgres and D1 `action` CHECKs to every `ActionKind` and adds the model types from the header (`installationActionKinds`, `ActionKind`, `ActorSnapshot`).

No row written in this slice invents an actor:

- Automatic admission and the bootstrap key write `principal_id = NULL` and a null actor.
- Every other row carries the acting principal and an `actor_name`/`actor_kind` snapshot taken at write time.

### Design decisions

These decisions bind every task in this slice.

1. **How the actor reaches storage.**
   - Every artifact and comment repository command that today carries `principalId` and `authorizedByPrincipalId` gains `readonly actor: ActorSnapshot`.
   - Services fill it with `actorSnapshotOf(principal)`. The snapshot is the principal's `displayName`: the member display name for humans, the key name for service keys, as `installation-access.ts:585` builds it.
   - `CreateCommentThread`, `CreateCommentReply` and `CreateAgentDispatch` already carry a `CommentAuthor` snapshot. Their actor comes from `actorSnapshotOfAuthor(author)`, so their commands do not change.
   - Identity and project mutations take an `ActionAttribution` (`{actor, principalId, authorizedByPrincipalId}`), because some of them have no person behind them.

2. **Replay safety.**
   - Every new row is written in the same transaction as its mutation, after the existing replay check returns early. A replay therefore writes nothing.
   - Rows derived from one mutation use derived idempotency keys that never collide with caller keys:
     - companion public-link rows: `${idempotencyKey}:public_link`
     - `member_admit:${memberId}`
     - `member_deactivate:${memberId}:${updatedAt}`
     - `key_issue:${keyId}`
     - `key_revoke:${keyId}`
     - `key_rotate:${replacementKeyId}`
     - `project_create:${projectId}`
     - `project_archive:${projectId}:${archivedAt}`
     - `project_unarchive:${projectId}:${actionId}`
     - `dispatch_create:${dispatchId}`
     - `dispatch_addressed:${dispatchId}`
   - `dispatch_addressed` is exactly-once. It uses the "insert once" form: `WHERE NOT EXISTS` in SQLite and D1, `ON CONFLICT DO NOTHING` in Postgres.
   - Re-revoking a revoked key, deactivating an inactive member, or archiving an archived project changes nothing and writes nothing.

3. **`detail_json` keys** are stable for slice 4's read model:
   - Every installation kind carries `subjectName`: the member display name, key name, project name or agent name.
   - Other keys, by kind:

     | Kind | Keys |
     |---|---|
     | `member_admit` | `how` (`manual`, `automatic` or `owner`), `role` |
     | `key_issue` | `capabilities`, `ownerPrincipalId`, `how` (`administrator` or `bootstrap`) |
     | `key_rotate` | `replacedKeyId` |
     | `dispatch_create` | `agentId`, `threadIds` |

   - Serialized detail is at most 4 KiB. `serializeActionDetail` throws past that, so the mutation fails rather than truncating history.

4. **Scope.**
   - `member_*` and `key_*` rows have `project_id = NULL`.
   - `project_*` and `dispatch_*` rows carry their `project_id` and have `artifact_id`/`version_id` NULL.
   - `public_link_*` rows are artifact-scoped and stay out of the per-artifact `/actions` listing (header, "Shared Interfaces").

5. **Test IDs.** `scripts/check-conformance-test-ids.rb` lets exactly one test claim each acceptance ID.
   - `ACT-001-B`, `ACT-001-F`, `AUD-001-B` and `AUD-001-F` are each claimed once, in `tests/conformance/act-001-activity-log-writes.test.ts`.
   - Postgres and D1 parity tests use descriptive titles without IDs.
   - The ACT-001 ledger entry lands in Task 2.9, before the first test that names it.

---

### Task 2.8: Attribution vocabulary and the shared action writer

**Files:**
- Create: `src/core/action-attribution.ts`
- Create: `src/storage/action-insert.ts`
- Create: `src/storage/postgres-action-insert.ts`
- Test: `tests/storage/action-insert.test.ts`

**Interfaces:**
- Consumes (from slice 2a and the header): `ActionKind`, `ArtifactActionKind`, `AccessSetting`, `ActorSnapshot` from `src/core/model.ts`; the slice-2a `actions` columns.
- Produces:
  - `src/core/action-attribution.ts`:
    - `interface ActionAttribution {actor: ActorSnapshot | null; principalId: string | null; authorizedByPrincipalId: string | null}`
    - `actorSnapshotOf(principal: Pick<Principal, "displayName" | "kind">): ActorSnapshot`
    - `actorSnapshotOfAuthor(author: CommentAuthor): ActorSnapshot`
    - `attributionOf(principal: Principal): ActionAttribution`
    - `systemAttribution: ActionAttribution`
  - `src/storage/action-insert.ts`:
    - `interface ActionInsert`
    - `maximumActionDetailBytes = 4_096`
    - `actionInsertColumns`
    - `positionalActionInsertSql`
    - `positionalActionInsertOnceSql`
    - `positionalActionValues(insert): (string | null)[]`
    - `positionalActionOnceValues(insert): (string | null)[]`
    - `serializeActionDetail(detail): string | null`
    - `publicLinkTransition(from, to): "public_link_enable" | "public_link_disable" | null`
    - `companionIdempotencyKey(key): string`
    - `attributedInsert(attribution, fields): ActionInsert`
  - `src/storage/postgres-action-insert.ts`: `insertPostgresAction(installationId: string, insert: ActionInsert, options?: {once?: boolean}): Effect.Effect<void, unknown, SqlClient>`

- [ ] **Step 1: Write the failing test**

Create `tests/storage/action-insert.test.ts`. It uses a real temporary SQLite database migrated by `SqliteArtifactRepository`, so the writer is proved against the slice-2a schema rather than a hand-made table.

```ts
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  actorSnapshotOf,
  attributionOf,
  systemAttribution,
} from "../../src/core/action-attribution.js";
import {membershipRoles, principalKinds} from "../../src/core/identity.js";
import {
  attributedInsert,
  companionIdempotencyKey,
  maximumActionDetailBytes,
  positionalActionInsertOnceSql,
  positionalActionInsertSql,
  positionalActionOnceValues,
  positionalActionValues,
  publicLinkTransition,
  serializeActionDetail,
} from "../../src/storage/action-insert.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";

const storedRowSchema = z.object({
  action: z.string(),
  actorKind: z.string().nullable(),
  actorName: z.string().nullable(),
  artifactId: z.string().nullable(),
  detailJson: z.string().nullable(),
  idempotencyKey: z.string(),
  principalId: z.string().nullable(),
  projectId: z.string().nullable(),
  subjectId: z.string().nullable(),
});

describe("the shared action writer", () => {
  let directory: string;
  let databasePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "action-insert-"));
    databasePath = path.join(directory, "artifact-server.db");
    new SqliteArtifactRepository(databasePath, "action-insert-installation").close();
  });

  afterEach(async () => {
    await rm(directory, {force: true, recursive: true});
  });

  test("an installation row stores its actor snapshot, subject and detail without an artifact", () => {
    const administrator = {
      authorizedByPrincipalId: null,
      capabilities: [],
      displayName: "Rosa Santoro",
      id: "member_rosa",
      installationId: "action-insert-installation",
      kind: principalKinds.human,
      membershipRole: membershipRoles.administrator,
    } as const;
    const insert = attributedInsert(attributionOf(administrator), {
      action: "member_admit",
      createdAt: "2026-10-01T12:00:00.000Z",
      detail: {how: "manual", role: "member", subjectName: "Dana Okonkwo"},
      idempotencyKey: "member_admit:member_dana",
      projectId: null,
      subjectId: "member_dana",
    });
    const database = new DatabaseSync(databasePath);
    try {
      database.prepare(positionalActionInsertSql).run(...positionalActionValues(insert));
      const row = storedRowSchema.parse(database.prepare(`
        SELECT action, actor_kind AS actorKind, actor_name AS actorName,
          artifact_id AS artifactId, detail_json AS detailJson,
          idempotency_key AS idempotencyKey, principal_id AS principalId,
          project_id AS projectId, subject_id AS subjectId
        FROM actions WHERE idempotency_key = ?
      `).get("member_admit:member_dana"));
      expect(row).toEqual({
        action: "member_admit",
        actorKind: "human",
        actorName: "Rosa Santoro",
        artifactId: null,
        detailJson: JSON.stringify({how: "manual", role: "member", subjectName: "Dana Okonkwo"}),
        idempotencyKey: "member_admit:member_dana",
        principalId: "member_rosa",
        projectId: null,
        subjectId: "member_dana",
      });
    } finally {
      database.close();
    }
  });

  test("a system row has no principal and no actor", () => {
    const insert = attributedInsert(systemAttribution, {
      action: "key_issue",
      createdAt: "2026-10-01T12:00:00.000Z",
      detail: {how: "bootstrap", subjectName: "Bootstrap"},
      idempotencyKey: "key_issue:key_bootstrap",
      projectId: null,
      subjectId: "key_bootstrap",
    });
    expect(insert.principalId).toBeNull();
    expect(insert.actor).toBeNull();
    expect(positionalActionValues(insert)[14]).toBeNull();
  });

  test("an insert-once row is written once however often it is offered", () => {
    const insert = attributedInsert(systemAttribution, {
      action: "dispatch_addressed",
      createdAt: "2026-10-01T12:00:00.000Z",
      detail: {subjectName: "site"},
      idempotencyKey: "dispatch_addressed:dsp_1",
      projectId: null,
      subjectId: "dsp_1",
    });
    const database = new DatabaseSync(databasePath);
    try {
      database.prepare(positionalActionInsertOnceSql).run(...positionalActionOnceValues(insert));
      database.prepare(positionalActionInsertOnceSql).run(...positionalActionOnceValues(insert));
      const count = z.object({count: z.number()}).parse(database.prepare(
        "SELECT COUNT(*) AS count FROM actions WHERE idempotency_key = ?",
      ).get("dispatch_addressed:dsp_1")).count;
      expect(count).toBe(1);
    } finally {
      database.close();
    }
  });

  test("detail larger than the limit is refused instead of truncated", () => {
    const oversized = {subjectName: "x".repeat(maximumActionDetailBytes)};
    expect(() => serializeActionDetail(oversized)).toThrow(RangeError);
    expect(serializeActionDetail(null)).toBeNull();
    expect(serializeActionDetail({subjectName: "ok"})).toBe("{\"subjectName\":\"ok\"}");
  });

  test("only a change in direction produces a public-link transition", () => {
    expect(publicLinkTransition("account_required", "public_link")).toBe("public_link_enable");
    expect(publicLinkTransition("public_link", "account_required")).toBe("public_link_disable");
    expect(publicLinkTransition(null, "public_link")).toBe("public_link_enable");
    expect(publicLinkTransition(null, "account_required")).toBeNull();
    expect(publicLinkTransition("public_link", "public_link")).toBeNull();
    expect(companionIdempotencyKey("publish-1")).toBe("publish-1:public_link");
  });

  test("the actor snapshot copies the principal's display name and kind", () => {
    expect(actorSnapshotOf({displayName: "Release key", kind: principalKinds.service}))
      .toEqual({displayName: "Release key", kind: "service"});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/storage/action-insert.test.ts`

Expected: FAIL with `Failed to resolve import "../../src/core/action-attribution.js"`.

- [ ] **Step 3: Write `src/core/action-attribution.ts`**

```ts
import type {Principal} from "./identity.js";
import type {ActorSnapshot, CommentAuthor} from "./model.js";

/**
 * Who caused one installation-level mutation. A null actor and principal mark
 * a system mutation, such as automatic admission or the bootstrap key, so the
 * activity log never invents a person.
 */
export interface ActionAttribution {
  readonly actor: ActorSnapshot | null;
  readonly authorizedByPrincipalId: string | null;
  readonly principalId: string | null;
}

/** The display name and kind recorded with an action at write time. */
export function actorSnapshotOf(
  principal: Pick<Principal, "displayName" | "kind">,
): ActorSnapshot {
  return {displayName: principal.displayName, kind: principal.kind};
}

/** The same snapshot taken from a comment or dispatch author record. */
export function actorSnapshotOfAuthor(author: CommentAuthor): ActorSnapshot {
  return {displayName: author.displayName, kind: author.principalKind};
}

/** Attribution for a mutation one authenticated principal performed. */
export function attributionOf(principal: Principal): ActionAttribution {
  return {
    actor: actorSnapshotOf(principal),
    authorizedByPrincipalId: principal.authorizedByPrincipalId,
    principalId: principal.id,
  };
}

/** Attribution for a mutation no person performed. */
export const systemAttribution: ActionAttribution = Object.freeze({
  actor: null,
  authorizedByPrincipalId: null,
  principalId: null,
});
```

- [ ] **Step 4: Write `src/storage/action-insert.ts`**

```ts
import type {ActionAttribution} from "../core/action-attribution.js";
import type {AccessSetting, ActionKind, ActorSnapshot} from "../core/model.js";

/** Largest serialized `detail_json` an action may carry (spec §1). */
export const maximumActionDetailBytes = 4_096;

/** One row for the installation activity log, independent of the backend. */
export interface ActionInsert {
  readonly accessFrom?: AccessSetting | null;
  readonly accessTo?: AccessSetting | null;
  readonly action: ActionKind;
  /** A caller-chosen id; null lets the database generate one. */
  readonly actionId?: string | null;
  readonly actor: ActorSnapshot | null;
  readonly artifactId: string | null;
  readonly authorizedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly detail?: Readonly<Record<string, unknown>> | null;
  readonly idempotencyKey: string;
  readonly principalId: string | null;
  readonly projectId: string | null;
  readonly replyId?: string | null;
  readonly subjectId?: string | null;
  readonly threadId?: string | null;
  readonly versionId: string | null;
}

/** Columns after `id`, in bind order, shared by every writer. */
export const actionInsertColumns = [
  "project_id",
  "artifact_id",
  "version_id",
  "action",
  "principal_id",
  "authorized_by_principal_id",
  "idempotency_key",
  "created_at",
  "thread_id",
  "reply_id",
  "subject_id",
  "access_from",
  "access_to",
  "actor_name",
  "actor_kind",
  "detail_json",
] as const;

const columnList = `id, ${actionInsertColumns.join(", ")}`;
const placeholders = actionInsertColumns.map(() => "?").join(", ");

/** SQLite and D1 insert; the first bind value is the optional action id. */
export const positionalActionInsertSql =
  `INSERT INTO actions (${columnList})
   VALUES (COALESCE(?, lower(hex(randomblob(16)))), ${placeholders})`;

/** SQLite and D1 insert that does nothing when the idempotency key exists. */
export const positionalActionInsertOnceSql =
  `INSERT INTO actions (${columnList})
   SELECT COALESCE(?, lower(hex(randomblob(16)))), ${placeholders}
   WHERE NOT EXISTS (SELECT 1 FROM actions WHERE idempotency_key = ?)`;

/** Serialize bounded detail, refusing (not truncating) oversized history. */
export function serializeActionDetail(
  detail: Readonly<Record<string, unknown>> | null | undefined,
): string | null {
  if (detail === null || detail === undefined) return null;
  const json = JSON.stringify(detail);
  if (new TextEncoder().encode(json).byteLength > maximumActionDetailBytes) {
    throw new RangeError(
      `Action detail exceeds ${maximumActionDetailBytes} bytes.`,
    );
  }
  return json;
}

/** Bind values for {@link positionalActionInsertSql}. */
export function positionalActionValues(insert: ActionInsert): (string | null)[] {
  return [
    insert.actionId ?? null,
    insert.projectId,
    insert.artifactId,
    insert.versionId,
    insert.action,
    insert.principalId,
    insert.authorizedByPrincipalId,
    insert.idempotencyKey,
    insert.createdAt,
    insert.threadId ?? null,
    insert.replyId ?? null,
    insert.subjectId ?? null,
    insert.accessFrom ?? null,
    insert.accessTo ?? null,
    insert.actor?.displayName ?? null,
    insert.actor?.kind ?? null,
    serializeActionDetail(insert.detail),
  ];
}

/** Bind values for {@link positionalActionInsertOnceSql}. */
export function positionalActionOnceValues(insert: ActionInsert): (string | null)[] {
  return [...positionalActionValues(insert), insert.idempotencyKey];
}

/** The companion row an access change writes when its direction changes. */
export function publicLinkTransition(
  from: AccessSetting | null,
  to: AccessSetting,
): "public_link_enable" | "public_link_disable" | null {
  if (from === to) return null;
  if (to === "public_link") return "public_link_enable";
  return from === "public_link" ? "public_link_disable" : null;
}

/** Derived key for a companion row; never collides with a caller key. */
export function companionIdempotencyKey(idempotencyKey: string): string {
  return `${idempotencyKey}:public_link`;
}

/** Build an installation-level row from an attribution. */
export function attributedInsert(
  attribution: ActionAttribution,
  fields: Omit<
    ActionInsert,
    "actor" | "artifactId" | "authorizedByPrincipalId" | "principalId" | "versionId"
  >,
): ActionInsert {
  return {
    ...fields,
    actor: attribution.actor,
    artifactId: null,
    authorizedByPrincipalId: attribution.authorizedByPrincipalId,
    principalId: attribution.principalId,
    versionId: null,
  };
}
```

- [ ] **Step 5: Write `src/storage/postgres-action-insert.ts`**

Postgres `actions` carries `installation_id`, and its `UNIQUE (installation_id, idempotency_key)` makes "once" a conflict clause.

```ts
import {Effect} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";

import {
  type ActionInsert,
  actionInsertColumns,
  positionalActionValues,
} from "./action-insert.js";

const columnList = `installation_id, id, ${actionInsertColumns.join(", ")}`;
const placeholders = actionInsertColumns.map((_, index) => `$${index + 3}`).join(", ");

/** Insert one activity-log row inside the caller's Postgres transaction. */
export function insertPostgresAction(
  installationId: string,
  insert: ActionInsert,
  options: {readonly once?: boolean} = {},
): Effect.Effect<void, unknown, SqlClient> {
  const [actionId, ...values] = positionalActionValues(insert);
  return Effect.gen(function*() {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      `INSERT INTO actions (${columnList})
       VALUES ($1, COALESCE($2::text, gen_random_uuid()::text), ${placeholders})
       ${options.once === true
        ? "ON CONFLICT (installation_id, idempotency_key) DO NOTHING"
        : ""}`,
      [installationId, actionId ?? null, ...values],
    );
  });
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/storage/action-insert.test.ts`

Expected: PASS, 6 tests.

If the first test fails with `NOT NULL constraint failed: actions.principal_id` or `actions.project_id`, slice 2a is incomplete. Stop and report; do not loosen the test.

- [ ] **Step 7: Lint, typecheck, commit**

Run: `pnpm lint && pnpm typecheck`

Expected: exit 0.

```bash
git add src/core/action-attribution.ts src/storage/action-insert.ts src/storage/postgres-action-insert.ts tests/storage/action-insert.test.ts
git commit -m "Add the shared activity-log action writer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.9: Artifact and comment mutations record actor, thread and reply (SQLite)

**Files:**
- Modify: `src/core/ports.ts`. Add `readonly actor: ActorSnapshot;` to:
  - `CommitNewArtifact` (:126), `CommitArtifactVersion` (:143), `RestoreArtifactVersion` (:159)
  - `ChangeArtifactAccessSetting` (:172), `ChangeArtifactTags` (:185), `DeleteArtifact` (:198)
  - `UpdateCommentThread` (:277), `DeleteCommentThread` (:290), `UpdateCommentReply` (:312)
  - `ClearCommentThreads` (:329), `DeleteCommentReply` (:341), `RelinkSourceBinding` (:429)
- Modify the services that build those commands. Each listed line is an `authorizedByPrincipalId:` line; add `actor` beside it:
  - `src/application/artifact-management.ts:567,599,630,664`
  - `src/application/publish-artifact.ts:291,350`
  - `src/application/linked-artifacts.ts:584,688,812`
  - `src/application/artifact-comments.ts:660,690,715,773,802`
- Modify: `src/storage/sqlite-artifact-repository.ts`: `#insertAction` (:3458) and every caller (:1409–4223).
- Modify: `project/spec/conformance.yml`. Add ACT-001 after AUD-001 (:1107).
- Modify test fixtures that build the changed commands directly. Find them with `grep -rln "commitNewArtifact(\|commitVersion(\|changeAccessSetting(\|restoreVersion(" tests src --include=*.ts`. Known: `tests/integration/postgres-version-pagination.test.ts:95,112`, `tests/storage/sqlite-version-pagination.test.ts`, `tests/storage/sqlite-source-binding.test.ts`.
- Test: `tests/conformance/act-001-activity-log-writes.test.ts` (new)

**Interfaces:**
- Consumes: `ActionInsert`, `positionalActionInsertSql`, `positionalActionValues` (Task 2.8); `actorSnapshotOf`, `actorSnapshotOfAuthor` (Task 2.8).
- Produces:
  - Every artifact and comment port command above has `actor: ActorSnapshot`.
  - SQLite rows for `comment_*` carry `thread_id`. Reply create, update and delete also carry `reply_id`.
  - Every artifact-kind row carries `actor_name`/`actor_kind`.
  - SQLite `#insertAction(insert: ActionInsert): void`.

- [ ] **Step 1: Add the ACT-001 ledger entry**

The test-ID checker rejects unknown IDs, so the entry lands first. Insert after the AUD-001 block in `project/spec/conformance.yml`:

```yaml
  - id: ACT-001
    kind: security
    behavior: Every mutation, including member, key, project, and agent-dispatch administration, appends exactly one immutable activity-log action in the same transaction, with the acting principal, its authorizer, and a display-name snapshot taken at write time.
    owner: authorization
    source: {file: artifact-server-product-spec.html, anchor: safety}
    acceptance:
      behavior: {id: ACT-001-B, description: "Perform artifact, comment, access, member, key, project, and dispatch mutations through human and agent principals and inspect one action per mutation carrying its kind, actor snapshot, thread, reply, subject, access direction, and bounded detail."}
      failure: {id: ACT-001-F, description: "Replaying a mutation writes no further action, repeating a no-op administration change writes nothing, and a mutation whose action is refused does not commit."}
    deployments: *all
    status: specified
    depends_on: [AUD-001]
    evidence: []
```

Run: `pnpm conformance:validate`

Expected: exits 0 and the report lists `ACT-001 specified`.

- [ ] **Step 2: Write the failing ACT-001-B test (artifact and comment kinds)**

Create `tests/conformance/act-001-activity-log-writes.test.ts`. Later tasks extend the same `ACT-001-B` test body; it is the one test that claims the ID.

```ts
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {ApiClient, signInAdministrator} from "../support/agent-dispatch.js";

const activityRowSchema = z.object({
  accessFrom: z.string().nullable(),
  accessTo: z.string().nullable(),
  action: z.string(),
  actorKind: z.enum(["human", "service"]).nullable(),
  actorName: z.string().nullable(),
  artifactId: z.string().nullable(),
  authorizedByPrincipalId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  detailJson: z.string().nullable(),
  idempotencyKey: z.string(),
  principalId: z.string().nullable(),
  projectId: z.string().nullable(),
  replyId: z.string().nullable(),
  subjectId: z.string().nullable(),
  threadId: z.string().nullable(),
  versionId: z.string().nullable(),
}).strict();
type ActivityRow = z.infer<typeof activityRowSchema>;

const threadCreationSchema = z.object({
  thread: z.object({id: z.string()}).loose(),
}).loose();
const replyCreationSchema = z.object({
  reply: z.object({id: z.string()}).loose(),
}).loose();

describe("the installation activity log records every mutation", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("ACT-001-B: each mutation appends one action with its kind, actor snapshot, thread, reply, subject and access direction", async () => {
    expect.hasAssertions();
    // Artifact kinds.
    const published = await publish("act-001-publish", "account_required");
    const afterPublish = rowsFor(published.artifact.id);
    expect(afterPublish).toEqual([
      expect.objectContaining({
        action: "publish",
        actorKind: "service",
        actorName: "Local",
        idempotencyKey: "act-001-publish",
        principalId: "local-api-token",
        versionId: published.version.id,
      }),
    ]);

    // Comment kinds carry the thread and reply they changed.
    const thread = threadCreationSchema.parse(await expectJson(
      await client.fetch(versionComments(published), {
        body: JSON.stringify({body: "The legend overlaps the axis.", path: "index.html"}),
        idempotencyKey: "act-001-thread",
        method: "POST",
      }),
      201,
    )).thread;
    const reply = replyCreationSchema.parse(await expectJson(
      await client.fetch(`${threadPath(published, thread.id)}/replies${scope(published)}`, {
        body: JSON.stringify({body: "Moved the legend below the chart."}),
        idempotencyKey: "act-001-reply",
        method: "POST",
      }),
      201,
    )).reply;
    await expectJson(await client.fetch(`${threadPath(published, thread.id)}${scope(published)}`, {
      body: JSON.stringify({state: "resolved"}),
      method: "PATCH",
    }), 200);

    const commentRows = rowsFor(published.artifact.id)
      .filter((row) => row.action.startsWith("comment_"));
    expect(commentRows.map((row) => [row.action, row.threadId, row.replyId])).toEqual([
      ["comment_create", thread.id, null],
      ["comment_reply", thread.id, reply.id],
      ["comment_resolve", thread.id, null],
    ]);
    for (const row of commentRows) {
      expect(row).toMatchObject({actorKind: "service", actorName: "Local"});
    }
  });

  function rowsFor(artifactId: string): ActivityRow[] {
    return readRows("WHERE artifact_id = ? ORDER BY created_at, rowid", [artifactId]);
  }

  function readRows(where: string, values: readonly string[]): ActivityRow[] {
    const database = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
      {readOnly: true, timeout: 5_000},
    );
    try {
      return z.array(activityRowSchema).parse(database.prepare(`
        SELECT access_from AS accessFrom, access_to AS accessTo, action,
          actor_kind AS actorKind, actor_name AS actorName,
          artifact_id AS artifactId,
          authorized_by_principal_id AS authorizedByPrincipalId,
          created_at AS createdAt, detail_json AS detailJson,
          idempotency_key AS idempotencyKey, principal_id AS principalId,
          project_id AS projectId, reply_id AS replyId,
          subject_id AS subjectId, thread_id AS threadId,
          version_id AS versionId
        FROM actions ${where}
      `).all(...values));
    } finally {
      database.close();
    }
  }

  async function publish(
    idempotencyKey: string,
    accessSetting: "account_required" | "public_link",
  ): Promise<PublishResponse> {
    return (await publishNew(server, installation, {
      accessSetting,
      content: "<!doctype html><title>Activity</title><p>chart</p>",
      idempotencyKey,
      name: "Quarterly chart",
    })).body;
  }
});

function scope(published: PublishResponse): string {
  return `?projectId=${published.artifact.projectId}`;
}

function versionComments(published: PublishResponse): string {
  return `/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/comments${scope(published)}`;
}

function threadPath(published: PublishResponse, threadId: string): string {
  return `/api/v1/artifacts/${published.artifact.id}/comments/${threadId}`;
}

async function expectJson(response: Response, status: number): Promise<unknown> {
  const text = await response.text();
  if (response.status !== status) {
    throw new Error(`Expected ${status}, received ${response.status}: ${text}`);
  }
  return text === "" ? null : JSON.parse(text);
}
```

`signInAdministrator` is imported here and used from Task 2.11 on. If Oxlint rejects the unused import in this task, add the import in Task 2.11 instead.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/conformance/act-001-activity-log-writes.test.ts`

Expected: FAIL. The publish row has `actorName: null` (the snapshot is not written yet), and the comment rows have `threadId: null`.

- [ ] **Step 4: Add `actor` to the port commands**

In `src/core/ports.ts`, import the type and add the field to each command listed under **Files**. For example, `ChangeArtifactAccessSetting` becomes:

```ts
import type {ActorSnapshot} from "./model.js";

/** Values used to atomically change one artifact's read setting. */
export interface ChangeArtifactAccessSetting {
  readonly accessSetting: AccessSetting;
  /** Display-name snapshot recorded with the action (ACT-001). */
  readonly actor: ActorSnapshot;
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly principalId: string;
  readonly projectId: string;
}
```

If `ActorSnapshot` is already imported via `./model.js` in `ports.ts`, extend that import instead of adding a second one.

- [ ] **Step 5: Fill `actor` in every service**

At each line listed under **Files**, add the field next to the existing attribution. In `src/application/artifact-management.ts` the four management commands become:

```ts
import {actorSnapshotOf} from "../core/action-attribution.js";
// …
        actor: actorSnapshotOf(command.principal),
        authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
```

Apply the same two lines at:

- `publish-artifact.ts:291,350`
- `linked-artifacts.ts:584,812`
- `artifact-comments.ts:660,690,715,773,802`

`linked-artifacts.ts:688` reads `input.principal`, so use `actor: actorSnapshotOf(input.principal),` there.

Run: `pnpm typecheck`

Expected: the only errors are in the test fixtures named under **Files**, each reporting `Property 'actor' is missing`. Add `actor: {displayName: "Test publisher", kind: "service"},` to each fixture command. In `tests/integration/postgres-version-pagination.test.ts`, add it to both `commitNewArtifact` (:95) and `commitVersion` (:112). Re-run `pnpm typecheck` until it exits 0.

- [ ] **Step 6: Replace the SQLite `#insertAction` with the shared writer**

In `src/storage/sqlite-artifact-repository.ts`, replace `#insertAction` (:3458–3491) with:

```ts
  #insertAction(insert: ActionInsert): void {
    this.#database
      .prepare(positionalActionInsertSql)
      .run(...positionalActionValues(insert));
  }
```

Add the imports:

```ts
import {actorSnapshotOfAuthor} from "../core/action-attribution.js";
import {
  type ActionInsert,
  positionalActionInsertSql,
  positionalActionValues,
} from "./action-insert.js";
```

Rewrite every caller as an object literal. Each call keeps its existing `projectId`, `artifactId`, `versionId`, `idempotencyKey`, `createdAt`, `action`, `principalId` and `authorizedByPrincipalId` arguments, now named. Add the extra fields from this table:

| Line (before) | Mutation | Extra fields |
|---|---|---|
| 1409 | relink | `actor: command.actor` |
| 1477 | new artifact (publish or link) | `actor: command.actor` |
| 1589 | version (publish or capture) | `actor: command.actor` |
| 1729 | change access | `actor: command.actor, accessFrom: artifact.accessSetting, accessTo: command.accessSetting` |
| 1775 | change tags | `actor: command.actor` |
| 1838 | delete | `actor: command.actor` |
| 2268 | restore | `actor: command.actor` |
| 3777 | comment create | `actor: actorSnapshotOfAuthor(command.author), threadId: command.id, actionId: createAction.actionId` |
| 3945 | comment update, resolve or reopen | `actor: command.actor, threadId: command.threadId, actionId: commentAction.actionId` |
| 3998 | comment delete | `actor: command.actor, threadId: command.threadId, actionId: commentAction.actionId` |
| 4061 | comment clear (per thread) | `actor: command.actor, threadId: <the loop's thread id variable>, actionId: commentAction.actionId` |
| 4140 | reply create | `actor: actorSnapshotOfAuthor(command.author), threadId: command.threadId, replyId: command.id, actionId: replyAction.actionId` |
| 4197 | reply update | `actor: command.actor, threadId: command.threadId, replyId: command.replyId, actionId: commentAction.actionId` |
| 4223 | reply delete | `actor: command.actor, threadId: command.threadId, replyId: command.replyId, actionId: commentAction.actionId` |

The change-access call (:1729) becomes:

```ts
        this.#insertAction({
          accessFrom: artifact.accessSetting,
          accessTo: command.accessSetting,
          action: artifactActionKinds.changeAccess,
          actor: command.actor,
          artifactId: command.artifactId,
          authorizedByPrincipalId: command.authorizedByPrincipalId,
          createdAt: command.createdAt,
          idempotencyKey: command.idempotencyKey,
          principalId: command.principalId,
          projectId: command.projectId,
          versionId: command.expectedCurrentVersionId,
        });
```

The reply-create call (:4140) becomes:

```ts
        this.#insertAction({
          action: artifactActionKinds.commentReply,
          actionId: replyAction.actionId,
          actor: actorSnapshotOfAuthor(command.author),
          artifactId: command.artifactId,
          authorizedByPrincipalId: command.author.authorizedByPrincipalId,
          createdAt: command.createdAt,
          idempotencyKey: replyAction.idempotencyKey,
          principalId: command.author.principalId,
          projectId: command.projectId,
          replyId: command.id,
          threadId: command.threadId,
          versionId: thread.versionId,
        });
```

`#readArtifact` returns an `ArtifactRecord` whose `accessSetting` is the value before the `UPDATE`, because it is read before it. Keep that ordering.

The per-artifact listing (`ListArtifactActions`) must keep returning only the original 14 kinds. Add `AND action NOT IN ('public_link_enable', 'public_link_disable')` to its `WHERE` in the SQLite query. Installation kinds already have `artifact_id IS NULL`.

- [ ] **Step 7: Run the tests**

Run: `pnpm exec vitest run tests/conformance/act-001-activity-log-writes.test.ts tests/conformance/cmt-011-comment-action-ledger.test.ts tests/conformance/auth-009-api-key-rotation.test.ts`

Expected: PASS. CMT-011 still passes, because the per-artifact listing shape is unchanged.

- [ ] **Step 8: Run the full unit suite, then commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

Expected: exit 0. `pnpm conformance:tests` reports `ACT-001-B` claimed once.

```bash
git add src/core/ports.ts src/application src/storage/sqlite-artifact-repository.ts tests project/spec/conformance.yml
git commit -m "Record actor snapshots, threads and replies on artifact actions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.10: Public-link enable and disable rows (SQLite)

**Files:**
- Modify: `src/storage/sqlite-artifact-repository.ts`: `changeAccessSetting` (:1656) and `#applyNewArtifactCommit` (around :1477).
- Test: `tests/conformance/act-001-activity-log-writes.test.ts` (extend ACT-001-B).

**Interfaces:**
- Consumes: `publicLinkTransition`, `companionIdempotencyKey` (Task 2.8); `#insertAction(insert)` (Task 2.9).
- Produces:
  - A `public_link_enable` or `public_link_disable` row, keyed `${idempotencyKey}:public_link`, whenever access changes direction.
  - A `public_link_enable` row for a new artifact first published with `public_link`, with `access_from = NULL`.
  - Slice 4 derives "made public on/by" from these rows.

- [ ] **Step 1: Extend the ACT-001-B test**

Append to the end of the `ACT-001-B` test body:

```ts
    // Access changes record direction; a public-link companion appears only
    // when the artifact moves into or out of public-link access.
    await expectJson(await client.fetch(
      `/api/v1/artifacts/${published.artifact.id}/access${scope(published)}`,
      {
        body: JSON.stringify({
          accessSetting: "public_link",
          expectedCurrentVersionId: published.version.id,
        }),
        idempotencyKey: "act-001-make-public",
        method: "PATCH",
      },
    ), 200);
    await expectJson(await client.fetch(
      `/api/v1/artifacts/${published.artifact.id}/access${scope(published)}`,
      {
        body: JSON.stringify({
          accessSetting: "account_required",
          expectedCurrentVersionId: published.version.id,
        }),
        idempotencyKey: "act-001-make-private",
        method: "PATCH",
      },
    ), 200);
    const accessRows = rowsFor(published.artifact.id).filter((row) =>
      row.action === "change_access" || row.action.startsWith("public_link_")
    );
    expect(accessRows.map((row) => [row.action, row.accessFrom, row.accessTo, row.idempotencyKey]))
      .toEqual([
        ["change_access", "account_required", "public_link", "act-001-make-public"],
        ["public_link_enable", "account_required", "public_link", "act-001-make-public:public_link"],
        ["change_access", "public_link", "account_required", "act-001-make-private"],
        ["public_link_disable", "public_link", "account_required", "act-001-make-private:public_link"],
      ]);

    const publicFromStart = await publish("act-001-public-publish", "public_link");
    expect(rowsFor(publicFromStart.artifact.id).map((row) => [row.action, row.accessFrom, row.accessTo]))
      .toEqual([
        ["publish", null, null],
        ["public_link_enable", null, "public_link"],
      ]);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/conformance/act-001-activity-log-writes.test.ts -t "ACT-001-B"`

Expected: FAIL. `accessRows` has only the two `change_access` rows.

- [ ] **Step 3: Write the companion rows**

In `changeAccessSetting`, directly after the `change_access` insert:

```ts
        const transition = publicLinkTransition(
          artifact.accessSetting,
          command.accessSetting,
        );
        if (transition !== null) {
          this.#insertAction({
            accessFrom: artifact.accessSetting,
            accessTo: command.accessSetting,
            action: transition,
            actor: command.actor,
            artifactId: command.artifactId,
            authorizedByPrincipalId: command.authorizedByPrincipalId,
            createdAt: command.createdAt,
            idempotencyKey: companionIdempotencyKey(command.idempotencyKey),
            principalId: command.principalId,
            projectId: command.projectId,
            versionId: command.expectedCurrentVersionId,
          });
        }
```

In `#applyNewArtifactCommit`, directly after the publish/link insert:

```ts
    if (publicLinkTransition(null, command.accessSetting) !== null) {
      this.#insertAction({
        accessFrom: null,
        accessTo: command.accessSetting,
        action: artifactActionKinds.publicLinkEnable,
        actor: command.actor,
        artifactId: command.artifactId,
        authorizedByPrincipalId: command.authorizedByPrincipalId,
        createdAt: command.createdAt,
        idempotencyKey: companionIdempotencyKey(command.idempotencyKey),
        principalId: command.principalId,
        projectId: command.projectId,
        versionId: command.versionId,
      });
    }
```

Extend the `./action-insert.js` import with `companionIdempotencyKey` and `publicLinkTransition`.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/conformance/act-001-activity-log-writes.test.ts tests/conformance/auth-007-visibility-change.test.ts tests/conformance/cmt-011-comment-action-ledger.test.ts`

Expected: PASS. AUTH-007 and CMT-011 per-artifact listings are unchanged, because `public_link_*` is excluded from them.

- [ ] **Step 5: Commit**

```bash
git add src/storage/sqlite-artifact-repository.ts tests/conformance/act-001-activity-log-writes.test.ts
git commit -m "Record public-link enable and disable actions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.11: Member, key and project actions (SQLite)

**Files:**
- Modify: `src/core/identity-ports.ts`.
  - `AdmitMemberRecord` gains `attribution` and `admittedHow`.
  - Add `memberAdmissions` and `MemberAdmission`.
  - `deactivateMember`, `createApiKey`, `revokeApiKey` and `rotateApiKey` gain a trailing `attribution: ActionAttribution`.
- Modify: `src/core/ports.ts`. `CreateProject` becomes an interface with `attribution`; `SetProjectArchive` gains `attribution`.
- Modify: `src/application/installation-access.ts`. Update the dependency signatures (:100–140) and the call sites at :413, :487, :606, :646, :697, :712, :754.
- Modify: `src/application/project-management.ts:198,236`.
- Modify: `src/local/create-local-application-layer.ts:522,542,945,953,975,1028,1042`, which pass the new arguments through the Effect adapters.
- Modify: `src/storage/sqlite-identity-repository.ts`: `admitMember` (:135), `deactivateMember` (:286), `createApiKey` (:436), `initializeBootstrapApiKey` (:441), `revokeApiKey` (:527), `rotateApiKey` (:545).
- Modify: `src/storage/sqlite-artifact-repository.ts`: `createProject` (:589) and `setProjectArchive` (:1288).
- Test: `tests/conformance/act-001-activity-log-writes.test.ts`. This task extends ACT-001-B and adds ACT-001-F.

**Interfaces:**
- Consumes: `ActionAttribution`, `attributionOf`, `systemAttribution` (Task 2.8); `attributedInsert`, `positionalActionInsertSql`, `positionalActionValues` (Task 2.8).
- Produces:
  - `memberAdmissions = {automatic: "automatic", manual: "manual", owner: "owner"} as const` and `type MemberAdmission`, exported from `src/core/identity-ports.ts`. Slice 3 reuses `admittedHow` and `attribution.principalId` to fill `members.admitted_by_principal_id`.
  - Repository signatures:

    ```ts
    admitMember(command: AdmitMemberRecord /* + attribution, admittedHow */): Promise<InstallationMember>;
    deactivateMember(installationId: string, memberId: string, updatedAt: string, attribution: ActionAttribution): Promise<InstallationMember>;
    createApiKey(key: StoredManagedApiKey, attribution: ActionAttribution): Promise<ManagedApiKey>;
    revokeApiKey(installationId: string, keyId: string, revokedAt: string, attribution: ActionAttribution): Promise<ManagedApiKey>;
    rotateApiKey(installationId: string, previousKeyId: string, replacement: StoredManagedApiKey, revokedAt: string, attribution: ActionAttribution): Promise<ManagedApiKey>;
    createProject(command: CreateProject /* ProjectRecord + attribution */): Promise<ProjectRecord>;
    setProjectArchive(command: SetProjectArchive /* + attribution */): Promise<ProjectRecord>;
    ```

  - Rows written: `member_admit`, `member_deactivate`, `key_issue`, `key_rotate`, `key_revoke`, `project_create`, `project_archive` and `project_unarchive`, with the keys and `detail` from "Design decisions".

- [ ] **Step 1: Extend ACT-001-B and add ACT-001-F**

Append to the `ACT-001-B` test body:

```ts
    // Administration: a human administrator admits, issues, rotates and
    // revokes; the rows carry that administrator and name their subject.
    const cookies = await signInAdministrator(server, installation);
    const administratorId = await sessionPrincipalId(cookies.header);
    const admitted = z.object({member: z.object({id: z.string()})}).parse(await expectJson(
      await adminFetch(cookies, "/api/v1/members", "POST", {displayName: "Dana Okonkwo", email: "dana@example.test"}),
      201,
    )).member;
    const issued = z.object({apiKey: z.object({id: z.string()})}).parse(await expectJson(
      await adminFetch(cookies, "/api/v1/api-keys", "POST", {
        capabilities: ["artifact:read"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        name: "Release key",
      }),
      201,
    )).apiKey;
    const rotated = z.object({apiKey: z.object({id: z.string()})}).parse(await expectJson(
      await adminFetch(cookies, `/api/v1/api-keys/${issued.id}/rotate`, "POST"),
      201,
    )).apiKey;
    await expectJson(await adminFetch(cookies, `/api/v1/api-keys/${rotated.id}/revoke`, "POST"), 200);
    await expectJson(await adminFetch(cookies, `/api/v1/members/${admitted.id}/deactivate`, "POST"), 200);
    const projectId = await client.createProject("Claims workstation", "act-001-project");
    await expectJson(await client.fetch(`/api/v1/projects/${projectId}/archive`, {method: "POST"}), 200);
    await expectJson(await client.fetch(`/api/v1/projects/${projectId}/unarchive`, {method: "POST"}), 200);

    const administration = readRows(
      "WHERE action LIKE 'member\\_%' ESCAPE '\\' OR action LIKE 'key\\_%' ESCAPE '\\' OR action LIKE 'project\\_%' ESCAPE '\\' ORDER BY created_at, rowid",
      [],
    );
    // The local owner admitted themself at sign-in: an "owner" row with no actor.
    expect(administration[0]).toMatchObject({
      action: "member_admit",
      actorName: null,
      principalId: null,
      subjectId: administratorId,
    });
    expect(JSON.parse(administration[0]?.detailJson ?? "null")).toMatchObject({how: "owner"});
    expect(administration.slice(1).map((row) => [row.action, row.subjectId, row.principalId, row.projectId]))
      .toEqual([
        ["member_admit", admitted.id, administratorId, null],
        ["key_issue", issued.id, administratorId, null],
        ["key_rotate", rotated.id, administratorId, null],
        ["key_revoke", rotated.id, administratorId, null],
        ["member_deactivate", admitted.id, administratorId, null],
        ["project_create", projectId, "local-api-token", projectId],
        ["project_archive", projectId, "local-api-token", projectId],
        ["project_unarchive", projectId, "local-api-token", projectId],
      ]);
    expect(JSON.parse(administration[1]?.detailJson ?? "null"))
      .toEqual({how: "manual", role: "member", subjectName: "Dana Okonkwo"});
    expect(JSON.parse(administration[2]?.detailJson ?? "null")).toMatchObject({
      capabilities: ["artifact:read"],
      how: "administrator",
      subjectName: "Release key",
    });
    expect(JSON.parse(administration[6]?.detailJson ?? "null"))
      .toEqual({subjectName: "Claims workstation"});
```

Add a new test after `ACT-001-B` and before the helper functions:

```ts
  test("ACT-001-F: replays and no-op administration write nothing, and a refused action rolls its mutation back", async () => {
    expect.hasAssertions();
    const published = await publish("act-001-f-publish", "account_required");
    await publish("act-001-f-publish", "account_required");
    expect(readRows("WHERE idempotency_key LIKE 'act-001-f-publish%'", [])).toHaveLength(1);

    const cookies = await signInAdministrator(server, installation);
    const issued = z.object({apiKey: z.object({id: z.string()})}).parse(await expectJson(
      await adminFetch(cookies, "/api/v1/api-keys", "POST", {
        capabilities: ["artifact:read"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        name: "Short-lived key",
      }),
      201,
    )).apiKey;
    await expectJson(await adminFetch(cookies, `/api/v1/api-keys/${issued.id}/revoke`, "POST"), 200);
    await expectJson(await adminFetch(cookies, `/api/v1/api-keys/${issued.id}/revoke`, "POST"), 200);
    expect(readRows("WHERE action = 'key_revoke' AND subject_id = ?", [issued.id])).toHaveLength(1);

    const projectId = await client.createProject("Archive twice", "act-001-f-project");
    await expectJson(await client.fetch(`/api/v1/projects/${projectId}/archive`, {method: "POST"}), 200);
    await expectJson(await client.fetch(`/api/v1/projects/${projectId}/archive`, {method: "POST"}), 200);
    expect(readRows("WHERE action = 'project_archive' AND subject_id = ?", [projectId])).toHaveLength(1);

    // A refused action leaves no member and no partial row.
    withWritableDatabase((database) => database.exec(`
      CREATE TRIGGER member_action_outage BEFORE INSERT ON actions
      WHEN NEW.action = 'member_admit'
      BEGIN SELECT RAISE(ABORT, 'the activity log refused the write'); END;
    `));
    const refused = await adminFetch(cookies, "/api/v1/members", "POST", {
      displayName: "Refused Member",
      email: "refused@example.test",
    });
    expect(refused.status).toBeGreaterThanOrEqual(500);
    withWritableDatabase((database) => database.exec("DROP TRIGGER member_action_outage;"));
    const members = z.object({members: z.array(z.object({email: z.string()}).loose())})
      .parse(await expectJson(await adminFetch(cookies, "/api/v1/members", "GET"), 200)).members;
    expect(members.map((member) => member.email)).not.toContain("refused@example.test");
    expect(published.artifact.id).toEqual(expect.any(String));
  });
```

Add these helpers inside the `describe`, next to `readRows`:

```ts
  function withWritableDatabase(operation: (database: DatabaseSync) => void): void {
    const database = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
      {timeout: 5_000},
    );
    try {
      operation(database);
    } finally {
      database.close();
    }
  }

  function adminFetch(
    cookies: {readonly csrf: string; readonly header: string},
    pathname: string,
    method: string,
    body?: object,
  ): Promise<Response> {
    const headers = new Headers({
      "Content-Type": "application/json",
      Cookie: cookies.header,
      Origin: server.baseUrl,
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": cookies.csrf,
    });
    return fetch(`${server.baseUrl}${pathname}`, body === undefined
      ? {headers, method}
      : {body: JSON.stringify(body), headers, method});
  }

  async function sessionPrincipalId(cookie: string): Promise<string> {
    const response = await fetch(`${server.baseUrl}/api/v1/session`, {headers: {Cookie: cookie}});
    return z.object({principal: z.object({id: z.string()})}).parse(await response.json()).principal.id;
  }
```

Check the HTTP status that `POST /api/v1/api-keys/:keyId/rotate` and `POST /api/v1/api-keys/:keyId/revoke` return at `src/http/create-http-app.ts:1135-1162`, and use those exact codes in `expectJson`. `auth-009` uses them.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/conformance/act-001-activity-log-writes.test.ts`

Expected: FAIL. `ACT-001-B` fails with `administration[0]` undefined (no member rows). `ACT-001-F` fails because the member admission still commits.

- [ ] **Step 3: Change the identity and project ports**

In `src/core/identity-ports.ts`:

```ts
import type {ActionAttribution} from "./action-attribution.js";

/** How a member entered the installation (spec §3 "Admitted by"). */
export const memberAdmissions = {
  automatic: "automatic",
  manual: "manual",
  owner: "owner",
} as const;
export type MemberAdmission = (typeof memberAdmissions)[keyof typeof memberAdmissions];

/** Values persisted when admitting one installation member. */
export interface AdmitMemberRecord {
  readonly admittedHow: MemberAdmission;
  /** The administrator for manual admission; system attribution otherwise. */
  readonly attribution: ActionAttribution;
  readonly createdAt: string;
  readonly displayName: string;
  readonly email: string;
  readonly id: string;
  readonly installationId: string;
  readonly role: InstallationMember["role"];
}
```

In the `IdentityRepository` interface:

```ts
  createApiKey(key: StoredManagedApiKey, attribution: ActionAttribution): Promise<ManagedApiKey>;
  deactivateMember(
    installationId: string,
    memberId: string,
    updatedAt: string,
    attribution: ActionAttribution,
  ): Promise<InstallationMember>;
  revokeApiKey(
    installationId: string,
    keyId: string,
    revokedAt: string,
    attribution: ActionAttribution,
  ): Promise<ManagedApiKey>;
  rotateApiKey(
    installationId: string,
    previousKeyId: string,
    replacement: StoredManagedApiKey,
    revokedAt: string,
    attribution: ActionAttribution,
  ): Promise<ManagedApiKey>;
```

In `src/core/ports.ts`:

```ts
/** Values used to create one project, with who created it (ACT-001). */
export interface CreateProject extends ProjectRecord {
  readonly attribution: ActionAttribution;
}

/** Values used to archive or unarchive one project. */
export interface SetProjectArchive {
  readonly archivedAt: string | null;
  readonly attribution: ActionAttribution;
  readonly projectId: string;
}
```

Update the `SqliteArtifactRepository.createProject` parameter type from `ProjectRecord` to `CreateProject`. The default project created by `#addProjectScopeIfMissing` during migration does not go through `createProject` and writes no action; slice 2a's recovery writes its `project_create`.

- [ ] **Step 4: Pass attribution from the services**

In `src/application/installation-access.ts`:

- **`:413` (`loginAsLocalOwner`):** add `admittedHow: memberAdmissions.owner, attribution: systemAttribution,`.
- **`:487` (`resolveExternalMember`):** add `admittedHow: isBootstrapAdministrator ? memberAdmissions.owner : memberAdmissions.automatic, attribution: systemAttribution,`.
- **`:606` (`admitMember`):** add `admittedHow: memberAdmissions.manual, attribution: attributionOf(command.principal),`.
- **`:646`:** `deactivateMember(installationId, memberId, now, attributionOf(principal))`.
- **`:697`:** `createApiKey(key, attributionOf(command.principal))`.
- **`:712`:** `revokeApiKey(installationId, keyId, now, attributionOf(principal))`.
- **`:754`:** `rotateApiKey(installationId, previous.id, replacement, now, attributionOf(principal))`.

Mirror the new trailing parameters in the dependency signature block (:100–140) and in `src/local/create-local-application-layer.ts:945–1042`, which forwards them unchanged.

In `src/application/project-management.ts`:

- `:198`: add `attribution: attributionOf(command.principal),` to the `createProject` object.
- `:236`: add the same field to the `setProjectArchive` object.

Also forward `attribution` in `create-local-application-layer.ts:522,542`, and in the Postgres and D1 project adapters if `pnpm typecheck` names them.

Run: `pnpm typecheck`

Expected: errors only in the three identity repositories and three project repositories. SQLite is fixed in Step 5; Postgres and D1 get temporary signature-only acceptance now, ignoring the new parameter, and real writes in Tasks 2.13 and 2.14. Exit 0 once those signatures match.

- [ ] **Step 5: Write the identity rows in SQLite, each inside one transaction**

In `src/storage/sqlite-identity-repository.ts`, import the writer:

```ts
import type {ActionAttribution} from "../core/action-attribution.js";
import {systemAttribution} from "../core/action-attribution.js";
import {
  type ActionInsert,
  attributedInsert,
  positionalActionInsertSql,
  positionalActionValues,
} from "./action-insert.js";
```

Add two private helpers:

```ts
  #insertAction(insert: ActionInsert): void {
    this.#database.prepare(positionalActionInsertSql).run(...positionalActionValues(insert));
  }

  /** Run one identity mutation and its action in a single SQLite transaction. */
  #inTransaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.#database.exec("COMMIT;");
      return result;
    } catch (cause) {
      this.#database.exec("ROLLBACK;");
      throw cause;
    }
  }
```

Replace `admitMember` with:

```ts
  async admitMember(command: AdmitMemberRecord): Promise<InstallationMember> {
    try {
      this.#inTransaction(() => {
        this.#database.prepare(`
          INSERT INTO installation_members (
            id, installation_id, email, display_name, role, status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          command.id,
          command.installationId,
          command.email,
          command.displayName,
          command.role,
          memberStatuses.active,
          command.createdAt,
          command.createdAt,
        );
        this.#insertAction(attributedInsert(command.attribution, {
          action: "member_admit",
          createdAt: command.createdAt,
          detail: {how: command.admittedHow, role: command.role, subjectName: command.displayName},
          idempotencyKey: `member_admit:${command.id}`,
          projectId: null,
          subjectId: command.id,
        }));
      });
    } catch (cause) {
      if (isSqliteConstraint(cause)) {
        throw new IdentityConflict({
          message: "That email is already admitted to this installation.",
        });
      }
      throw cause;
    }
    const member = await this.findMember(command.installationId, command.id);
    if (member === null) throw new Error("The admitted member was not persisted.");
    return member;
  }
```

The `RAISE(ABORT)` trigger in ACT-001-F surfaces as a generic SQLite error, not a constraint error, so it propagates as a 500, as the test expects.

In `deactivateMember`, after the existing `UPDATE installation_members SET status = ?` and before `COMMIT`, write the row only when the member was active:

```ts
      if (existing.status === memberStatuses.active) {
        this.#insertAction(attributedInsert(attribution, {
          action: "member_deactivate",
          createdAt: updatedAt,
          detail: {subjectName: existing.displayName},
          idempotencyKey: `member_deactivate:${memberId}:${updatedAt}`,
          projectId: null,
          subjectId: memberId,
        }));
      }
```

Replace `createApiKey` and add the bootstrap row:

```ts
  async createApiKey(
    key: StoredManagedApiKey,
    attribution: ActionAttribution,
  ): Promise<ManagedApiKey> {
    this.#inTransaction(() => {
      this.#insertApiKey(key);
      this.#insertKeyIssue(key, attribution, "administrator");
    });
    return withoutSecretDigest(key);
  }

  #insertKeyIssue(
    key: StoredManagedApiKey,
    attribution: ActionAttribution,
    how: "administrator" | "bootstrap",
  ): void {
    this.#insertAction(attributedInsert(attribution, {
      action: "key_issue",
      createdAt: key.createdAt,
      detail: {
        capabilities: key.capabilities,
        how,
        ownerPrincipalId: key.principalId,
        subjectName: key.name,
      },
      idempotencyKey: `key_issue:${key.id}`,
      projectId: null,
      subjectId: key.id,
    }));
  }
```

In `initializeBootstrapApiKey`, call `this.#insertKeyIssue(key, systemAttribution, "bootstrap");` immediately after `this.#insertApiKey(key);`. It is already inside its `BEGIN IMMEDIATE`.

Replace `revokeApiKey`, so a second revoke changes nothing and writes nothing:

```ts
  async revokeApiKey(
    installationId: string,
    keyId: string,
    revokedAt: string,
    attribution: ActionAttribution,
  ): Promise<ManagedApiKey> {
    this.#inTransaction(() => {
      const existing = this.#findApiKey(installationId, keyId);
      if (existing === null) {
        throw new IdentityNotFound({message: "The API key does not exist."});
      }
      if (existing.revokedAt !== null) return;
      this.#database.prepare(`
        UPDATE managed_api_keys SET revoked_at = ?
        WHERE installation_id = ? AND id = ? AND revoked_at IS NULL
      `).run(revokedAt, installationId, keyId);
      this.#insertAction(attributedInsert(attribution, {
        action: "key_revoke",
        createdAt: revokedAt,
        detail: {subjectName: existing.name},
        idempotencyKey: `key_revoke:${keyId}`,
        projectId: null,
        subjectId: keyId,
      }));
    });
    const key = await this.findApiKey(installationId, keyId);
    if (key === null) throw new Error("The revoked API key disappeared.");
    return withoutSecretDigest(key);
  }
```

In `rotateApiKey`, add the trailing `attribution: ActionAttribution` parameter. Immediately after `this.#insertApiKey(replacement);` and before `COMMIT`:

```ts
      this.#insertAction(attributedInsert(attribution, {
        action: "key_rotate",
        createdAt: revokedAt,
        detail: {replacedKeyId: previousKeyId, subjectName: replacement.name},
        idempotencyKey: `key_rotate:${replacement.id}`,
        projectId: null,
        subjectId: replacement.id,
      }));
```

- [ ] **Step 6: Write the project rows in SQLite**

In `src/storage/sqlite-artifact-repository.ts`, wrap `createProject`'s insert in `this.#transaction(() => { … })` if it is not already wrapped, and add after the `INSERT INTO projects`:

```ts
        this.#insertAction(attributedInsert(command.attribution, {
          action: "project_create",
          createdAt: command.createdAt,
          detail: {subjectName: command.name},
          idempotencyKey: `project_create:${command.id}`,
          projectId: command.id,
          subjectId: command.id,
        }));
```

Replace `setProjectArchive`, so that only a real state change writes a row:

```ts
  setProjectArchive(command: SetProjectArchive): Promise<ProjectRecord> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const result = this.#database.prepare(
          command.archivedAt === null
            ? "UPDATE projects SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL"
            : "UPDATE projects SET archived_at = ? WHERE id = ? AND archived_at IS NULL",
        ).run(...(command.archivedAt === null
          ? [command.projectId]
          : [command.archivedAt, command.projectId]));
        const project = this.#readProjectOrNull(command.projectId);
        if (project === null) {
          throw new ProjectNotFound({message: "The project does not exist."});
        }
        if (result.changes === 1) {
          const actionId = crypto.randomUUID();
          const changedAt = command.archivedAt ?? new Date().toISOString();
          this.#insertAction(attributedInsert(command.attribution, {
            action: command.archivedAt === null ? "project_unarchive" : "project_archive",
            actionId,
            createdAt: changedAt,
            detail: {subjectName: project.name},
            idempotencyKey: command.archivedAt === null
              ? `project_unarchive:${command.projectId}:${actionId}`
              : `project_archive:${command.projectId}:${command.archivedAt}`,
            projectId: command.projectId,
            subjectId: command.projectId,
          }));
        }
        return project;
      }),
    );
  }
```

`SetProjectArchive` has no timestamp for unarchive. Add `readonly changedAt: string;` to `SetProjectArchive` and pass the service clock's `DateTime.formatIso(yield* dependencies.clock.now)` from `project-management.ts:236`, so the repository never reads the wall clock. Then replace `command.archivedAt ?? new Date().toISOString()` with `command.changedAt`.

If `#readProjectOrNull` does not exist, use the existing `#readProject` inside a `try`, keeping the current `ProjectNotFound` error for an unknown ID.

- [ ] **Step 7: Run the tests**

Run: `pnpm exec vitest run tests/conformance/act-001-activity-log-writes.test.ts tests/conformance/auth-009-api-key-rotation.test.ts tests/conformance/ops-006-retention.test.ts`

Expected: PASS. Then run `pnpm test`; expected exit 0. Existing member, key and project tests keep their behaviour, because every write is additive.

- [ ] **Step 8: Commit**

```bash
git add src/core src/application src/local src/storage tests/conformance/act-001-activity-log-writes.test.ts
git commit -m "Record member, key and project administration in the activity log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.12: Dispatch sent and answered actions (SQLite)

**Files:**
- Modify: `src/storage/sqlite-artifact-repository.ts`: `createDispatch` (:4446) and `createReply` (:4082).
- Test: `tests/conformance/act-001-activity-log-writes.test.ts` (extend ACT-001-B; add a replay assertion to ACT-001-F).

**Interfaces:**
- Consumes: `attributedInsert`, `positionalActionInsertOnceSql`, `positionalActionOnceValues`, `actorSnapshotOfAuthor` (Task 2.8).
- Produces:
  - A `dispatch_create` row (project-scoped, `subject_id` = dispatch ID, detail `{agentId, subjectName: agentDisplayName, threadIds}`).
  - Exactly one `dispatch_addressed` row per dispatch, written by the first reply whose author is the dispatch's registered agent principal while the dispatch is queued, claimed or delivered. It has `thread_id` set and detail `{subjectName: agentDisplayName}`.

- [ ] **Step 1: Extend the tests**

Append to `ACT-001-B`:

```ts
    // Dispatch: the installation credential registers itself as an agent, so
    // its reply on a held thread is the agent answering.
    const agent = await client.registerAgent({
      connectionKey: "act-001-agent",
      displayName: "site",
      workingDirectory: "/work/site",
    });
    const heldThread = await client.openThread(published, "Check the totals row.", "act-001-held-thread");
    const dispatch = z.object({dispatch: z.object({id: z.string()}).loose()}).loose().parse(await expectJson(
      await client.sendDispatch({
        agentId: agent.id,
        idempotencyKey: "act-001-dispatch",
        projectId: published.artifact.projectId,
        threadIds: [heldThread.id],
      }),
      201,
    )).dispatch;
    for (const key of ["act-001-agent-reply-1", "act-001-agent-reply-2"]) {
      await expectJson(await client.fetch(`${threadPath(published, heldThread.id)}/replies${scope(published)}`, {
        body: JSON.stringify({body: `Answered (${key}).`}),
        idempotencyKey: key,
        method: "POST",
      }), 201);
    }
    const dispatchRows = readRows(
      "WHERE action LIKE 'dispatch\\_%' ESCAPE '\\' ORDER BY created_at, rowid",
      [],
    );
    expect(dispatchRows.map((row) => [row.action, row.subjectId, row.projectId, row.artifactId, row.threadId]))
      .toEqual([
        ["dispatch_create", dispatch.id, published.artifact.projectId, null, null],
        ["dispatch_addressed", dispatch.id, published.artifact.projectId, null, heldThread.id],
      ]);
    expect(JSON.parse(dispatchRows[0]?.detailJson ?? "null"))
      .toEqual({agentId: agent.id, subjectName: "site", threadIds: [heldThread.id]});
```

Append to `ACT-001-F`, before its final `expect`:

```ts
    const agent = await client.registerAgent({
      connectionKey: "act-001-f-agent",
      displayName: "site",
      workingDirectory: "/work/site",
    });
    const thread = await client.openThread(published, "Replay me.", "act-001-f-thread");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await client.sendDispatch({
        agentId: agent.id,
        idempotencyKey: "act-001-f-dispatch",
        projectId: published.artifact.projectId,
        threadIds: [thread.id],
      });
    }
    expect(readRows("WHERE action = 'dispatch_create'", [])).toHaveLength(1);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/conformance/act-001-activity-log-writes.test.ts`

Expected: FAIL. `dispatchRows` is `[]`.

- [ ] **Step 3: Write `dispatch_create` inside `createDispatch`**

In `createDispatch`, after the thread-marking loop and before `#bumpCommentRevisionForThreads`:

```ts
        this.#insertAction(attributedInsert(
          {
            actor: actorSnapshotOfAuthor(command.sender),
            authorizedByPrincipalId: command.sender.authorizedByPrincipalId,
            principalId: command.sender.principalId,
          },
          {
            action: "dispatch_create",
            createdAt: command.createdAt,
            detail: {
              agentId: command.agentId,
              subjectName: command.agentDisplayName,
              threadIds: command.threadIds,
            },
            idempotencyKey: `dispatch_create:${command.id}`,
            projectId: command.projectId,
            subjectId: command.id,
          },
        ));
```

The replay branch returns before this point, so a replay writes nothing.

- [ ] **Step 4: Write `dispatch_addressed` inside `createReply`**

Add the private helper:

```ts
  /**
   * The first reply by a dispatch's own agent on a thread that dispatch holds
   * records that the agent answered. The derived key makes it exactly-once.
   */
  #recordDispatchAnswer(command: CreateCommentReply): void {
    const held = z.object({agentName: z.string(), dispatchId: z.string()}).nullable().parse(
      this.#database.prepare(`
        SELECT d.id AS dispatchId, d.agent_display_name AS agentName
        FROM comment_threads t
        JOIN agent_dispatches d ON d.id = t.dispatch_id
        JOIN registered_agents a ON a.id = d.agent_id
        WHERE t.id = ? AND t.project_id = ?
          AND d.state IN ('queued', 'claimed', 'delivered')
          AND a.principal_id = ?
      `).get(command.threadId, command.projectId, command.author.principalId) ?? null,
    );
    if (held === null) return;
    const insert = attributedInsert(
      {
        actor: actorSnapshotOfAuthor(command.author),
        authorizedByPrincipalId: command.author.authorizedByPrincipalId,
        principalId: command.author.principalId,
      },
      {
        action: "dispatch_addressed",
        createdAt: command.createdAt,
        detail: {subjectName: held.agentName},
        idempotencyKey: `dispatch_addressed:${held.dispatchId}`,
        projectId: command.projectId,
        subjectId: held.dispatchId,
        threadId: command.threadId,
      },
    );
    this.#database
      .prepare(positionalActionInsertOnceSql)
      .run(...positionalActionOnceValues(insert));
  }
```

Call `this.#recordDispatchAnswer(command);` in `createReply` directly after the `comment_reply` insert. Extend the `./action-insert.js` import with `attributedInsert`, `positionalActionInsertOnceSql` and `positionalActionOnceValues`.

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run tests/conformance/act-001-activity-log-writes.test.ts tests/conformance/dsp-003-dispatch-send.test.ts tests/conformance/dsp-008-addressed-inference.test.ts tests/conformance/cmt-020-dispatched-comment-deletion.test.ts`

Expected: PASS. The DSP suites are unchanged; dispatch state transitions are untouched.

- [ ] **Step 6: Commit**

```bash
git add src/storage/sqlite-artifact-repository.ts tests/conformance/act-001-activity-log-writes.test.ts
git commit -m "Record agent dispatches and their first agent answer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.13: Postgres parity for every new action

**Files:**
- Modify: `src/storage/postgres-artifact-repository.ts`:
  - `#insertAction` (:4527) and its callers (:1442–3970)
  - `#managementTransaction` (:3937), for the public-link companion
  - the new-artifact commits (:1442, :1543)
  - `createDispatch`, `createReply` (the reply call near :3300), `createProject` (:580) and `setProjectArchive` (:1364)
- Modify: `src/storage/postgres-identity-repository.ts`: `admitMember` (:130), and `deactivateMember`, `createApiKey`, `initializeBootstrapApiKey`, `revokeApiKey` and `rotateApiKey` (the `withTransaction` blocks at :255–538).
- Test: `tests/integration/postgres-activity-log-writes.test.ts` (new)
- Modify: `tests/configs/vitest.external-storage.config.ts:12-19`. Add the new test to `include`.

**Interfaces:**
- Consumes: `insertPostgresAction(installationId, insert, {once})` (Task 2.8); the command `actor` and attribution signatures from Tasks 2.9 and 2.11.
- Produces: rows identical to the SQLite rows, with the same kinds, keys and detail, in the same transaction as each Postgres mutation.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/postgres-activity-log-writes.test.ts`. It drives the repositories directly against a scratch database, the same way `postgres-version-pagination.test.ts` does, so it needs no HTTP stack.

```ts
import {randomUUID} from "node:crypto";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {systemAttribution} from "../../src/core/action-attribution.js";
import {memberAdmissions} from "../../src/core/identity-ports.js";
import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";
import {PostgresIdentityRepository} from "../../src/storage/postgres-identity-repository.js";

const administrator = {
  actor: {displayName: "Rosa Santoro", kind: "human"},
  authorizedByPrincipalId: null,
  principalId: "member_rosa",
} as const;

const rowSchema = z.object({
  action: z.string(),
  actorName: z.string().nullable(),
  detailJson: z.string().nullable(),
  idempotencyKey: z.string(),
  principalId: z.string().nullable(),
  projectId: z.string().nullable(),
  subjectId: z.string().nullable(),
});

function readDatabaseUrl(): string {
  const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  if (databaseUrl === undefined) {
    throw new Error("Run this test through pnpm test:external-storage-runtime.");
  }
  return databaseUrl;
}

describe("Postgres activity-log writes", () => {
  const scratch = `artifact_activity_writes_${randomUUID().replaceAll("-", "")}`;
  const installationId = `test-activity-writes-${randomUUID()}`;
  let maintenance: PostgresDatabase;
  let database: PostgresDatabase;
  let artifacts: PostgresArtifactRepository;
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
    artifacts = await PostgresArtifactRepository.open(database, installationId);
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

  test("member, key and project administration each append one attributed row, and no-ops append none", async () => {
    await identity.admitMember({
      admittedHow: memberAdmissions.owner,
      attribution: systemAttribution,
      createdAt: "2026-10-01T10:00:00.000Z",
      displayName: "Rosa Santoro",
      email: "rosa@example.test",
      id: "member_rosa",
      installationId,
      role: "administrator",
    });
    await identity.admitMember({
      admittedHow: memberAdmissions.manual,
      attribution: administrator,
      createdAt: "2026-10-01T10:01:00.000Z",
      displayName: "Dana Okonkwo",
      email: "dana@example.test",
      id: "member_dana",
      installationId,
      role: "member",
    });
    const key = {
      authorizedByPrincipalId: "member_rosa",
      capabilities: ["artifact:read"] as const,
      createdAt: "2026-10-01T10:02:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      id: "key_release",
      installationId,
      name: "Release key",
      prefix: "as_key_key_release_",
      principalId: "service:key_release",
      principalKind: "service" as const,
      revokedAt: null,
      rotatedFromId: null,
      secretDigest: "digest-release",
    };
    await identity.createApiKey(key, administrator);
    await identity.revokeApiKey(installationId, key.id, "2026-10-01T10:03:00.000Z", administrator);
    await identity.revokeApiKey(installationId, key.id, "2026-10-01T10:04:00.000Z", administrator);
    await identity.deactivateMember(installationId, "member_dana", "2026-10-01T10:05:00.000Z", administrator);
    await artifacts.createProject({
      archivedAt: null,
      attribution: administrator,
      createdAt: "2026-10-01T10:06:00.000Z",
      id: "prj_claims",
      installationId,
      name: "Claims workstation",
    });
    await artifacts.setProjectArchive({
      archivedAt: "2026-10-01T10:07:00.000Z",
      attribution: administrator,
      changedAt: "2026-10-01T10:07:00.000Z",
      projectId: "prj_claims",
    });
    await artifacts.setProjectArchive({
      archivedAt: "2026-10-01T10:08:00.000Z",
      attribution: administrator,
      changedAt: "2026-10-01T10:08:00.000Z",
      projectId: "prj_claims",
    });

    const rows = await readRows();
    expect(rows.map((row) => [row.action, row.subjectId, row.principalId, row.projectId])).toEqual([
      ["member_admit", "member_rosa", null, null],
      ["member_admit", "member_dana", "member_rosa", null],
      ["key_issue", "key_release", "member_rosa", null],
      ["key_revoke", "key_release", "member_rosa", null],
      ["member_deactivate", "member_dana", "member_rosa", null],
      ["project_create", "prj_claims", "member_rosa", "prj_claims"],
      ["project_archive", "prj_claims", "member_rosa", "prj_claims"],
    ]);
    expect(JSON.parse(rows[1]?.detailJson ?? "null"))
      .toEqual({how: "manual", role: "member", subjectName: "Dana Okonkwo"});
    expect(rows[1]?.actorName).toBe("Rosa Santoro");
  });

  async function readRows(): Promise<z.infer<typeof rowSchema>[]> {
    return database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const result = yield* sql.unsafe<object>(
        `SELECT action, actor_name AS "actorName", detail_json::text AS "detailJson",
           idempotency_key AS "idempotencyKey", principal_id AS "principalId",
           project_id AS "projectId", subject_id AS "subjectId"
         FROM actions WHERE installation_id = $1 AND artifact_id IS NULL
         ORDER BY created_at, id`,
        [installationId],
      );
      return z.array(rowSchema).parse(result);
    }));
  }
});
```

Match the `StoredManagedApiKey` field names to `src/core/installation-identity.ts` exactly; the object above mirrors the SQLite `#findApiKey` column list. Add `"tests/integration/postgres-activity-log-writes.test.ts",` to the `include` array in `tests/configs/vitest.external-storage.config.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:external-storage-runtime`. It requires Docker.

Expected: the new file FAILS with `rows` equal to `[]`, because the Postgres repositories ignore attribution.

- [ ] **Step 3: Route Postgres artifact actions through `insertPostgresAction`**

Replace `#insertAction` (:4527–4554) with:

```ts
  #insertAction(
    command: {
      readonly accessFrom?: AccessSetting | null;
      readonly accessTo?: AccessSetting | null;
      readonly actionId?: string | undefined;
      readonly actor: ActorSnapshot;
      readonly artifactId: string;
      readonly authorizedByPrincipalId: string | null;
      readonly createdAt: string;
      readonly idempotencyKey: string;
      readonly principalId: string;
      readonly projectId: string;
      readonly replyId?: string | null;
      readonly threadId?: string | null;
    },
    action: ArtifactActionKind,
    versionId: string,
  ): Effect.Effect<void, unknown, SqlClient> {
    return insertPostgresAction(this.#installationId, {
      accessFrom: command.accessFrom ?? null,
      accessTo: command.accessTo ?? null,
      action,
      actionId: command.actionId ?? null,
      actor: command.actor,
      artifactId: command.artifactId,
      authorizedByPrincipalId: command.authorizedByPrincipalId,
      createdAt: command.createdAt,
      idempotencyKey: command.idempotencyKey,
      principalId: command.principalId,
      projectId: command.projectId,
      replyId: command.replyId ?? null,
      threadId: command.threadId ?? null,
      versionId,
    });
  }
```

Callers that pass `command` directly compile unchanged, because every artifact command now has `actor`. Add these fields to the comment call sites:

| Line | Fields to add to the object literal |
|---|---|
| 2924 (thread create) | `actor: actorSnapshotOfAuthor(command.author), threadId: command.id` |
| 3077 (thread update) | `actor: command.actor, threadId: command.threadId` |
| 3141 (thread delete) | `actor: command.actor, threadId: command.threadId` |
| 3208 (thread clear) | `actor: command.actor, threadId: row.id` |
| 3300 (reply create) | `actor: actorSnapshotOfAuthor(command.author), threadId: command.threadId, replyId: command.id` |
| 3358 (reply update) | `actor: command.actor, threadId: command.threadId, replyId: command.replyId` |
| 3388 (reply delete) | `actor: command.actor, threadId: command.threadId, replyId: command.replyId` |

At :3970 (`#managementTransaction`), change the call to pass access direction, then write the companion:

```ts
        yield* this.#insertAction(
          {...command, accessFrom: artifact.accessSetting, accessTo: command.accessSetting},
          operation,
          command.expectedCurrentVersionId,
        );
        const transition = publicLinkTransition(artifact.accessSetting, command.accessSetting);
        if (transition !== null) {
          yield* insertPostgresAction(this.#installationId, {
            accessFrom: artifact.accessSetting,
            accessTo: command.accessSetting,
            action: transition,
            actor: command.actor,
            artifactId: command.artifactId,
            authorizedByPrincipalId: command.authorizedByPrincipalId,
            createdAt: command.createdAt,
            idempotencyKey: companionIdempotencyKey(command.idempotencyKey),
            principalId: command.principalId,
            projectId: command.projectId,
            versionId: command.expectedCurrentVersionId,
          });
        }
```

After the new-artifact `publish` insert at :1442 (and the linked variant at :1543, if it is a new artifact), add the same `public_link_enable` companion as Task 2.10 Step 3, using `yield* insertPostgresAction(this.#installationId, {...})`.

Exclude `public_link_*` from the Postgres `ListArtifactActions` query, as in Task 2.9 Step 6.

- [ ] **Step 4: Postgres projects and dispatches**

In `createProject` (:580), inside its transaction and after the `INSERT INTO projects`:

```ts
        yield* insertPostgresAction(installationId, attributedInsert(command.attribution, {
          action: "project_create",
          createdAt: command.createdAt,
          detail: {subjectName: command.name},
          idempotencyKey: `project_create:${command.id}`,
          projectId: command.id,
          subjectId: command.id,
        }));
```

If `createProject` is not inside `sql.withTransaction`, wrap it in one.

In `setProjectArchive` (:1364), use `UPDATE … WHERE archived_at IS NULL` (archive) or `WHERE archived_at IS NOT NULL` (unarchive) with `RETURNING id, name`. Insert `project_archive` or `project_unarchive` with the Task 2.11 Step 6 keys only when a row is returned. Keep `ProjectNotFound` for an unknown ID by selecting the project first `FOR UPDATE`.

In `createDispatch`, after its thread markers, insert `dispatch_create` with the Task 2.12 Step 3 fields through `insertPostgresAction`.

In the reply-create transaction, after the `comment_reply` action:

```ts
        const held = yield* sql.unsafe<object>(
          `SELECT d.id AS "dispatchId", d.agent_display_name AS "agentName"
           FROM comment_threads t
           JOIN agent_dispatches d
             ON d.installation_id = t.installation_id AND d.id = t.dispatch_id
           JOIN registered_agents a
             ON a.installation_id = d.installation_id AND a.id = d.agent_id
           WHERE t.installation_id = $1 AND t.project_id = $2 AND t.id = $3
             AND d.state IN ('queued', 'claimed', 'delivered')
             AND a.principal_id = $4`,
          [installationId, command.projectId, command.threadId, command.author.principalId],
        );
        const answer = z.array(z.object({agentName: z.string(), dispatchId: z.string()})).parse(held)[0];
        if (answer !== undefined) {
          yield* insertPostgresAction(installationId, attributedInsert(
            {
              actor: actorSnapshotOfAuthor(command.author),
              authorizedByPrincipalId: command.author.authorizedByPrincipalId,
              principalId: command.author.principalId,
            },
            {
              action: "dispatch_addressed",
              createdAt: command.createdAt,
              detail: {subjectName: answer.agentName},
              idempotencyKey: `dispatch_addressed:${answer.dispatchId}`,
              projectId: command.projectId,
              subjectId: answer.dispatchId,
              threadId: command.threadId,
            },
          ), {once: true});
        }
```

Check the Postgres column names of `agent_dispatches`, `comment_threads.dispatch_id` and `registered_agents.principal_id` in `postgres-migrations.ts` before running. If a table lacks `installation_id`, drop that join predicate.

- [ ] **Step 5: Postgres identity rows**

In `postgres-identity-repository.ts`:

- Wrap `admitMember`'s insert in `sql.withTransaction` and add the `member_admit` insert from Task 2.11 Step 5, via `insertPostgresAction(this.#installationId, attributedInsert(command.attribution, {...}))`.
- In the existing `withTransaction` blocks of `deactivateMember`, `revokeApiKey` and `rotateApiKey`, add the matching rows with the same "write only on a real change" rules.
  - `revokeApiKey` becomes `UPDATE … SET revoked_at = $1 WHERE … AND revoked_at IS NULL RETURNING name`, and inserts `key_revoke` only when a row returns. An unknown key still raises `IdentityNotFound`.
- In `createApiKey`, wrap the key insert and the `key_issue` row in `withTransaction`.
- In `initializeBootstrapApiKey`, add `key_issue` with `systemAttribution` and `how: "bootstrap"` in its transaction.

- [ ] **Step 6: Run the tests**

Run: `pnpm typecheck && pnpm test:external-storage-runtime`

Expected: exit 0. The new file passes and the existing external-storage suites still pass.

- [ ] **Step 7: Commit**

```bash
git add src/storage/postgres-artifact-repository.ts src/storage/postgres-identity-repository.ts tests/integration/postgres-activity-log-writes.test.ts tests/configs/vitest.external-storage.config.ts
git commit -m "Record every activity-log action on Postgres

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.14: D1 parity for every new action

**Files:**
- Modify: `deploy/cloudflare/src/d1-artifact-repository.ts`:
  - `actionStatement` (:975) and its callers (:2756–3661)
  - `commentActionStatement` (:1290) and its callers (:3664–4151)
  - the dispatch-create and reply-create batches
  - the project create and archive functions
- Modify: `deploy/cloudflare/src/d1-identity-repository.ts`: `admitMember` (:168), `createApiKey` (:262), `deactivateMember` (:314), `revokeApiKey` (:446), `rotateApiKey` (:466). Each statement joins its existing `database.batch([...])`, which D1 runs as one transaction.
- Test: `deploy/cloudflare/tests/activity-log-runtime.test.ts` (new)

**Interfaces:**
- Consumes: `positionalActionInsertSql`, `positionalActionValues`, `positionalActionInsertOnceSql`, `positionalActionOnceValues`, `attributedInsert`, `publicLinkTransition`, `companionIdempotencyKey`, `actorSnapshotOfAuthor` (Task 2.8). Import from `../../../src/storage/action-insert.js` and `../../../src/core/action-attribution.js`; `d1-artifact-repository.ts` already imports `../../../src/core/…` this way.
- Produces: the same rows as SQLite on D1, each inside the mutation's single `batch`.

- [ ] **Step 1: Write the failing Worker runtime test**

Create `deploy/cloudflare/tests/activity-log-runtime.test.ts`:

```ts
import {createHash} from "node:crypto";
import {mkdtemp, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";

import {unstable_dev, type Unstable_DevWorker} from "wrangler";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {z} from "zod";

const apiToken = "cloudflare-activity-test-api-token-0000001";
const origin = "https://artifacts.example.test";

const publicationSchema = z.object({
  artifact: z.object({id: z.string()}),
  version: z.object({id: z.string()}),
});
const uploadPlanSchema = z.object({
  commitUrl: z.url(),
  files: z.array(z.object({path: z.string(), uploadUrl: z.url()})).length(1),
});
const rowSchema = z.object({
  accessFrom: z.string().nullable(),
  accessTo: z.string().nullable(),
  action: z.string(),
  actorName: z.string().nullable(),
  idempotencyKey: z.string(),
  replyId: z.string().nullable(),
  threadId: z.string().nullable(),
});

let persistPath: string;
let worker: Unstable_DevWorker;

beforeAll(async () => {
  persistPath = await mkdtemp(join(tmpdir(), "artifact-server-cloudflare-activity-"));
  worker = await startWorker(persistPath);
}, 60_000);

afterAll(async () => {
  await worker.stop();
  await rm(persistPath, {force: true, recursive: true});
});

describe("Cloudflare D1 activity-log writes", () => {
  it("records actor snapshots, threads, replies and public-link direction in one batch per mutation", async () => {
    const published = await publishArtifact("activity-publish-0000001", "public_link");
    const artifactUrl = `${origin}/api/v1/artifacts/${published.artifact.id}`;
    const thread = z.object({thread: z.object({id: z.string()}).loose()}).loose().parse(await (await worker.fetch(
      `${artifactUrl}/versions/${published.version.id}/comments`,
      {body: JSON.stringify({body: "Check the legend.", path: "index.html"}), headers: mutationHeaders("activity-thread-00000001"), method: "POST"},
    )).json()).thread;
    const reply = z.object({reply: z.object({id: z.string()}).loose()}).loose().parse(await (await worker.fetch(
      `${artifactUrl}/comments/${thread.id}/replies`,
      {body: JSON.stringify({body: "Moved it."}), headers: mutationHeaders("activity-reply-000000001"), method: "POST"},
    )).json()).reply;
    const madePrivate = await worker.fetch(`${artifactUrl}/access`, {
      body: JSON.stringify({accessSetting: "account_required", expectedCurrentVersionId: published.version.id}),
      headers: mutationHeaders("activity-private-0000001"),
      method: "PATCH",
    });
    expect(madePrivate.status).toBe(200);
    await worker.stop();

    const database = new DatabaseSync(await findD1DatabaseFile(persistPath), {readOnly: true});
    try {
      const rows = z.array(rowSchema).parse(database.prepare(`
        SELECT access_from AS accessFrom, access_to AS accessTo, action,
          actor_name AS actorName, idempotency_key AS idempotencyKey,
          reply_id AS replyId, thread_id AS threadId
        FROM actions WHERE artifact_id = ? ORDER BY created_at, rowid
      `).all(published.artifact.id));
      expect(rows.map((row) => [row.action, row.accessFrom, row.accessTo, row.threadId, row.replyId])).toEqual([
        ["publish", null, null, null, null],
        ["public_link_enable", null, "public_link", null, null],
        ["comment_create", null, null, thread.id, null],
        ["comment_reply", null, null, thread.id, reply.id],
        ["change_access", "public_link", "account_required", null, null],
        ["public_link_disable", "public_link", "account_required", null, null],
      ]);
      expect(new Set(rows.map((row) => row.actorName))).toEqual(new Set(["Local"]));
    } finally {
      database.close();
    }
    worker = await startWorker(persistPath);
  }, 120_000);
});

function bearerHeaders() {
  return {Authorization: `Bearer ${apiToken}`};
}

function mutationHeaders(idempotencyKey: string) {
  return {...bearerHeaders(), "Content-Type": "application/json", "Idempotency-Key": idempotencyKey};
}

async function publishArtifact(idempotencyKey: string, accessSetting: "account_required" | "public_link") {
  const bytes = new TextEncoder().encode("<h1>Activity target</h1>");
  const plan = uploadPlanSchema.parse(await (await worker.fetch(`${origin}/api/v1/uploads`, {
    body: JSON.stringify({
      entryPath: "index.html",
      files: [{
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      }],
    }),
    headers: {...bearerHeaders(), "Content-Type": "application/json"},
    method: "POST",
  })).json());
  const file = plan.files[0];
  if (file === undefined) throw new Error("The upload plan is empty.");
  expect((await worker.fetch(file.uploadUrl, {body: bytes, headers: bearerHeaders(), method: "PUT"})).status).toBe(200);
  const committed = await worker.fetch(plan.commitUrl, {
    body: JSON.stringify({target: {accessSetting, kind: "new_artifact", name: "Activity target", tags: []}}),
    headers: mutationHeaders(idempotencyKey),
    method: "POST",
  });
  expect(committed.status).toBe(201);
  return publicationSchema.parse(await committed.json());
}

async function findD1DatabaseFile(directory: string): Promise<string> {
  const entries = await readdir(directory, {recursive: true, withFileTypes: true});
  const found = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite") && entry.parentPath.includes("D1"))
    .map((entry) => join(entry.parentPath, entry.name))
    .find((candidate) => {
      const database = new DatabaseSync(candidate, {readOnly: true});
      try {
        return database.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifact_server_schema'",
        ).get() !== undefined;
      } finally {
        database.close();
      }
    });
  if (found === undefined) throw new Error("The Worker did not persist a local D1 database file.");
  return found;
}

function startWorker(persistenceDirectory: string): Promise<Unstable_DevWorker> {
  return unstable_dev("src/worker.ts", {
    bundle: true,
    compatibilityDate: "2026-08-15",
    compatibilityFlags: ["nodejs_compat"],
    config: "wrangler.test.jsonc",
    experimental: {
      d1Databases: [{
        binding: "ARTIFACT_SERVER_D1_DATABASE",
        database_id: "artifact-server-test-d1",
        database_name: "artifact-server-test-d1",
      }],
      disableDevRegistry: true,
      disableExperimentalWarning: true,
      testScheduled: true,
      watch: false,
    },
    inspect: false,
    local: true,
    logLevel: "error",
    persist: true,
    persistTo: persistenceDirectory,
    r2: [{binding: "ARTIFACT_SERVER_R2_BUCKET", bucket_name: "artifact-server-test-r2"}],
    vars: {
      ARTIFACT_SERVER_API_TOKEN: apiToken,
      ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "administrator@example.test",
      ARTIFACT_SERVER_CONTENT_DOMAIN: "content.example.test",
      ARTIFACT_SERVER_INSTALLATION_ID: "cloudflare-activity-test",
      ARTIFACT_SERVER_OIDC_CLIENT_ID: "cloudflare-activity-test",
      ARTIFACT_SERVER_OIDC_ISSUER: "https://identity.example.test",
      ARTIFACT_SERVER_ORIGIN: origin,
      ARTIFACT_SERVER_QUALIFICATION_MODE: "enabled",
      ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    },
  });
}
```

`startWorker` mirrors `deploy/cloudflare/tests/comment-runtime.test.ts:658-700`. If that file's options have changed, copy its current values.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --dir deploy/cloudflare exec vitest run tests/activity-log-runtime.test.ts`

Expected: FAIL. `actorName` is `null` and the `public_link_*` rows are missing.

- [ ] **Step 3: Rewrite `actionStatement` and `commentActionStatement`**

Replace `actionStatement` (:975–1000) with:

```ts
  const actionStatement = (insert: ActionInsert): D1PreparedStatement =>
    database.prepare(positionalActionInsertSql).bind(...positionalActionValues(insert));
  const actionOnceStatement = (insert: ActionInsert): D1PreparedStatement =>
    database.prepare(positionalActionInsertOnceSql).bind(...positionalActionOnceValues(insert));
  const artifactAction = (
    command: {
      readonly actor: ActorSnapshot;
      readonly artifactId: string;
      readonly authorizedByPrincipalId: string | null;
      readonly createdAt: string;
      readonly idempotencyKey: string;
      readonly principalId: string;
      readonly projectId: string;
    },
    versionId: string,
    action: ArtifactActionKind,
    extra: Partial<Pick<ActionInsert, "accessFrom" | "accessTo">> = {},
  ): D1PreparedStatement => actionStatement({
    ...extra,
    action,
    actor: command.actor,
    artifactId: command.artifactId,
    authorizedByPrincipalId: command.authorizedByPrincipalId,
    createdAt: command.createdAt,
    idempotencyKey: command.idempotencyKey,
    principalId: command.principalId,
    projectId: command.projectId,
    versionId,
  });
```

Rename the existing callers from `actionStatement(command, versionId, kind)` to `artifactAction(command, versionId, kind)` at :2756, :2819, :3315, :3356, :3401 and :3661.

At the access change (:3275), the artifact's previous `accessSetting` has already been read for the expected-version check. Replace the single statement with:

```ts
        artifactAction(command, command.expectedCurrentVersionId, artifactActionKinds.changeAccess, {
          accessFrom: artifact.accessSetting,
          accessTo: command.accessSetting,
        }),
        ...(() => {
          const transition = publicLinkTransition(artifact.accessSetting, command.accessSetting);
          return transition === null ? [] : [actionStatement({
            accessFrom: artifact.accessSetting,
            accessTo: command.accessSetting,
            action: transition,
            actor: command.actor,
            artifactId: command.artifactId,
            authorizedByPrincipalId: command.authorizedByPrincipalId,
            createdAt: command.createdAt,
            idempotencyKey: companionIdempotencyKey(command.idempotencyKey),
            principalId: command.principalId,
            projectId: command.projectId,
            versionId: command.expectedCurrentVersionId,
          })];
        })(),
```

Use the variable name the surrounding code gives the artifact read. At the new-artifact batches (:2756, :2819), append the `public_link_enable` statement when `publicLinkTransition(null, command.accessSetting) !== null`.

Extend `commentActionStatement` (:1290) to bind the new columns. It keeps the `SELECT … FROM thread` source, so the thread's project, artifact and version still come from the row:

```ts
  const commentActionStatement = (
    entry: {
      readonly action: ArtifactActionKind;
      readonly actionId: string | null;
      readonly actor: ActorSnapshot;
      readonly authorizedByPrincipalId: string | null;
      readonly changedAt: string;
      readonly idempotencyKey: string;
      readonly principalId: string;
      readonly replyId: string | null;
      readonly threadId: string;
    },
    source: string,
    sourceBindings: readonly string[],
  ): D1PreparedStatement => database.prepare(`
    INSERT INTO actions (
      id, project_id, artifact_id, version_id, action, principal_id,
      authorized_by_principal_id, idempotency_key, created_at,
      thread_id, reply_id, actor_name, actor_kind
    )
    SELECT COALESCE(?, lower(hex(randomblob(16)))), t.project_id, t.artifact_id,
      t.version_id, ?, ?, ?, ?, ?, ?, ?, ?, ?
    ${source}
  `).bind(
    entry.actionId,
    entry.action,
    entry.principalId,
    entry.authorizedByPrincipalId,
    entry.idempotencyKey,
    entry.changedAt,
    entry.threadId,
    entry.replyId,
    entry.actor.displayName,
    entry.actor.kind,
    ...sourceBindings,
  );
```

At each caller (:3664, :3816, :3881, :3973, :4035, :4114, :4151), add:

- `actor`:
  - `actorSnapshotOfAuthor(command.author)` for thread and reply create
  - `command.actor` otherwise
- `threadId`: the thread being changed
- `replyId`: the reply ID for reply create, update and delete; `null` otherwise

Exclude `public_link_*` from the D1 `ListArtifactActions` query.

- [ ] **Step 4: D1 dispatches, projects and identity**

- **Dispatch create batch:** append `actionStatement(attributedInsert({actor: actorSnapshotOfAuthor(command.sender), authorizedByPrincipalId: command.sender.authorizedByPrincipalId, principalId: command.sender.principalId}, {action: "dispatch_create", createdAt: command.createdAt, detail: {agentId: command.agentId, subjectName: command.agentDisplayName, threadIds: command.threadIds}, idempotencyKey: `dispatch_create:${command.id}`, projectId: command.projectId, subjectId: command.id}))`.
- **Reply create batch:** D1 cannot branch inside a batch. Express the agent-answer condition in SQL with an insert-once statement built from a `SELECT … WHERE EXISTS`:

  ```ts
  database.prepare(`
    INSERT INTO actions (
      id, project_id, artifact_id, version_id, action, principal_id,
      authorized_by_principal_id, idempotency_key, created_at, thread_id,
      actor_name, actor_kind, subject_id, detail_json
    )
    SELECT lower(hex(randomblob(16))), t.project_id, NULL, NULL,
      'dispatch_addressed', ?, ?, 'dispatch_addressed:' || d.id, ?, t.id, ?, ?,
      d.id, json_object('subjectName', d.agent_display_name)
    FROM comment_threads t
    JOIN agent_dispatches d ON d.id = t.dispatch_id
    JOIN registered_agents a ON a.id = d.agent_id
    WHERE t.id = ? AND t.project_id = ?
      AND d.state IN ('queued', 'claimed', 'delivered')
      AND a.principal_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM actions WHERE idempotency_key = 'dispatch_addressed:' || d.id
      )
  `).bind(
    command.author.principalId,
    command.author.authorizedByPrincipalId,
    command.createdAt,
    command.author.displayName,
    command.author.principalKind,
    command.threadId,
    command.projectId,
    command.author.principalId,
  ),
  ```

- **Project create and archive:** add the Task 2.11 Step 6 rows to the D1 project functions. Make archive and unarchive conditional on the `WHERE archived_at IS [NOT] NULL` update changing a row, using an `INSERT … SELECT … WHERE changes() = 1`. That expression must be the statement immediately after the update in the same batch.
- **Identity:** in `d1-identity-repository.ts`, convert `admitMember`, `createApiKey`, `revokeApiKey` and `deactivateMember` to `database.batch([...])`, with the mutation first and the `actionStatement` second.
  - Make conditional rows (`key_revoke`, `member_deactivate`) depend on the preceding update through `INSERT … SELECT … WHERE changes() = 1`.
  - Change `revokeApiKey`'s update to `WHERE … AND revoked_at IS NULL` so a repeat revoke changes no row.
  - Append the `key_rotate` row to the existing `rotateApiKey` batch, gated by the same `WHERE EXISTS (… revoked_at = ?)` predicate its insert already uses.

- [ ] **Step 5: Run the tests**

Run: `pnpm check:cloudflare`

Expected: exit 0. `activity-log-runtime.test.ts` passes, and `comment-runtime.test.ts`, `agent-dispatch-runtime.test.ts` and `oidc-login-runtime.test.ts` still pass.

- [ ] **Step 6: Commit**

```bash
git add deploy/cloudflare/src/d1-artifact-repository.ts deploy/cloudflare/src/d1-identity-repository.ts deploy/cloudflare/tests/activity-log-runtime.test.ts
git commit -m "Record every activity-log action on Cloudflare D1

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.15: Claim AUD-001, then attach ACT-001 and AUD-001 evidence

**Files:**
- Modify: `tests/conformance/act-001-activity-log-writes.test.ts` (add `AUD-001-B` and `AUD-001-F`)
- Modify: `project/spec/conformance.yml`: ACT-001 (from Task 2.9) and AUD-001 (:1096)

**Interfaces:**
- Consumes: the rows written by Tasks 2.9–2.14.
- Produces:
  - `ACT-001` with local evidence, moving to `behavior_verified`.
  - `AUD-001` with its first evidence, moving to `behavior_verified`.

- [ ] **Step 1: Add the AUD-001 tests**

AUD-001 covers attribution for human and agent principals, and atomicity for non-comment mutations. CMT-011 already proves the comment cases. Add to the `describe` block:

```ts
  test("AUD-001-B: publish, access and delete through human and agent principals record the effective principal and its human authorizer", async () => {
    expect.hasAssertions();
    const cookies = await signInAdministrator(server, installation);
    const administratorId = await sessionPrincipalId(cookies.header);
    const issued = z.object({token: z.string()}).parse(await expectJson(
      await adminFetch(cookies, "/api/v1/api-keys", "POST", {
        capabilities: ["artifact:create", "artifact:manage:any", "artifact:read"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        name: "Release agent",
      }),
      201,
    ));
    const agent = new ApiClient(server, issued.token);
    const published = await publish("aud-001-publish", "account_required");
    await expectJson(await agent.fetch(
      `/api/v1/artifacts/${published.artifact.id}/access${scope(published)}`,
      {
        body: JSON.stringify({accessSetting: "public_link", expectedCurrentVersionId: published.version.id}),
        idempotencyKey: "aud-001-agent-access",
        method: "PATCH",
      },
    ), 200);
    const rows = rowsFor(published.artifact.id);
    expect(rows.find((row) => row.idempotencyKey === "aud-001-publish")).toMatchObject({
      authorizedByPrincipalId: null,
      principalId: "local-api-token",
    });
    expect(rows.find((row) => row.idempotencyKey === "aud-001-agent-access")).toMatchObject({
      actorKind: "service",
      actorName: "Release agent",
      authorizedByPrincipalId: administratorId,
      principalId: expect.stringMatching(/^service:/u),
    });
  });

  test("AUD-001-F: a publish or access change whose action record is refused does not commit", async () => {
    expect.hasAssertions();
    const published = await publish("aud-001-f-publish", "account_required");
    withWritableDatabase((database) => database.exec(`
      CREATE TRIGGER access_action_outage BEFORE INSERT ON actions
      WHEN NEW.action = 'change_access'
      BEGIN SELECT RAISE(ABORT, 'the activity log refused the write'); END;
    `));
    const refused = await client.fetch(
      `/api/v1/artifacts/${published.artifact.id}/access${scope(published)}`,
      {
        body: JSON.stringify({accessSetting: "public_link", expectedCurrentVersionId: published.version.id}),
        idempotencyKey: "aud-001-f-access",
        method: "PATCH",
      },
    );
    expect(refused.status).toBeGreaterThanOrEqual(500);
    withWritableDatabase((database) => database.exec("DROP TRIGGER access_action_outage;"));
    const artifact = z.object({artifact: z.object({accessSetting: z.string()}).loose()}).loose()
      .parse(await expectJson(await client.fetch(
        `/api/v1/artifacts/${published.artifact.id}${scope(published)}`,
      ), 200));
    expect(artifact.artifact.accessSetting).toBe("account_required");
    expect(rowsFor(published.artifact.id).map((row) => row.action)).toEqual(["publish"]);
  });
```

If `GET /api/v1/artifacts/:id` nests the setting differently, adjust the parse to the shape `src/http/create-http-app.ts` returns. The assertion stays "access unchanged".

Run: `pnpm exec vitest run tests/conformance/act-001-activity-log-writes.test.ts && pnpm conformance:tests`

Expected: PASS (4 tests). The checker reports ACT-001-B/F and AUD-001-B/F each claimed once.

- [ ] **Step 2: Produce local evidence**

Run: `pnpm test`

Expected: exit 0, writing `project/evidence/local-foundation.json`. Confirm the four titles appear in it with `"status":"passed"`:

`grep -o '"ACT-001-[BF][^"]*","status":"passed"\|"AUD-001-[BF][^"]*","status":"passed"' project/evidence/local-foundation.json`

Note the run's timestamp: the `startTime` field, as an ISO string.

- [ ] **Step 3: Update the ledger**

Set ACT-001 to:

```yaml
    status: behavior_verified
    proof_gap: Local SQLite behavior and failure evidence is recorded. Postgres parity is proved by tests/integration/postgres-activity-log-writes.test.ts and D1 parity by deploy/cloudflare/tests/activity-log-runtime.test.ts, but no team, external-storage, or Cloudflare deployment evidence is recorded against ACT-001 yet.
    depends_on: [AUD-001]
    evidence:
      - deployment: local
        tests: [ACT-001-B, ACT-001-F]
        result: pass
        run: project/evidence/local-foundation.json
        recorded_at: "<startTime from Step 2>"
```

Set AUD-001 to:

```yaml
    status: behavior_verified
    proof_gap: Local evidence proves human and agent attribution and atomic refusal for publish and access changes; CMT-011 proves the comment mutations. Connection changes and non-local deployments have no recorded AUD-001 evidence.
    depends_on: []
    evidence:
      - deployment: local
        tests: [AUD-001-B, AUD-001-F]
        result: pass
        run: project/evidence/local-foundation.json
        recorded_at: "<startTime from Step 2>"
```

Neither requirement is marked `verified`, because every applicable deployment would need evidence.

Run: `pnpm conformance:validate`

Expected: exit 0, with ACT-001 and AUD-001 reported `behavior_verified`.

- [ ] **Step 4: Run the slice gate and commit**

Run: `pnpm check`

Expected: exit 0. Then run `pnpm test:external-storage-runtime`, which needs Docker. Expected: exit 0.

```bash
git add tests/conformance/act-001-activity-log-writes.test.ts project/spec/conformance.yml project/evidence/local-foundation.json project/evidence/external-storage-runtime.json
git commit -m "Attach activity-log and attribution evidence

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
## Slice 3 — Admin tracking and API fields

This slice covers spec §3 and the requirements ACT-007, ADM-003, ADM-004 and ADM-005.

**Assumptions about Slice 2.** This slice assumes the activity-log slices (2a and 2b) are merged. Specifically:

- `actions` has nullable `project_id`, `artifact_id` and `version_id`.
- `actions` has the columns `subject_id`, `actor_name` and `actor_kind`.
- The identity and artifact repositories write `member_deactivate`, `key_revoke`, `key_rotate` and `public_link_enable` rows.
- A `key_rotate` row's `subject_id` is the **previous** (now revoked) key's ID. If Slice 2 records the replacement key instead, Task 3.2's `revokedByName` lookup must match `rotated_from_id` instead. Check `git grep -n "keyRotate" src` before starting.

**Schema numbers.** These assume Slice 2 left the schema at these values:

| Backend | Slice 2 leaves | This slice sets |
|---|---|---|
| SQLite (`requiredSqliteSchemaVersion`) | 18 | 19 |
| Postgres migration ID | `0018` | `0019` |
| D1 (`requiredD1SchemaVersion`) | 16 | 17 |

If Slice 2 used more numbers, take the next free ones and keep the names.

**Conformance IDs.** The validator `scripts/check-conformance-test-ids.rb` allows each acceptance ID to be claimed by exactly one `*.test.ts` title. Browser `*.spec.ts` files are not counted.

- This slice claims **ACT-007-B**, **ACT-007-F**, **ADM-003-B**, **ADM-004-B** and **ADM-005-B** in `*.test.ts` files.
- Later slices must not reuse those five IDs in any `*.test.ts` title. Browser specs may keep using them.

**Interface addition.** The header's `PrincipalActivityRecorder` gains a second method, `touchApiKey`.

- A member-bound API key authenticates as the member's own principal ID (`installation-access.ts`, `principalId: member?.id ?? \`service:${id}\``).
- So `touch(principalId, at)` alone cannot record which key was used.

### Task 3.1: Schema for admission and activity facts, and admission recording

**Files:**
- Create: `src/core/principal-activity.ts`
- Modify: `src/core/installation-identity.ts` (new `ListedMember`; the admission vocabulary `memberAdmissions` / `MemberAdmission` already lives in `src/core/identity-ports.ts` from Task 2.11)
- Modify: `src/core/identity-ports.ts` (`listMembers` return type only; `AdmitMemberRecord` already carries `admittedHow` and `attribution` from Task 2.11)
- Modify: `src/application/installation-access.ts` (`listMembers` types only; Task 2.11 already set `admittedHow` and `attribution` at the three admission call sites)
- Modify: `src/storage/sqlite-identity-repository.ts` (columns, `admitMember`, `listMembers`)
- Modify: `src/storage/sqlite-schema.ts` (`requiredSqliteSchemaVersion` 18 → 19)
- Modify: `src/storage/sqlite-artifact-repository.ts` (`actions_subject` index in `#migrate`)
- Modify: `src/storage/postgres-migrations.ts` (migration `0019_member_admission_and_activity`, expected history, required version 19)
- Modify: `src/storage/postgres-identity-repository.ts` (`admitMember`, `listMembers`)
- Modify: `deploy/cloudflare/src/d1-migrations.ts` (columns, index, required version 17)
- Modify: `deploy/cloudflare/src/d1-identity-repository.ts` (`admitMember`, `listMembers`)
- Modify: `tests/configs/vitest.external-storage.config.ts` (include the new Postgres test)
- Test: `tests/storage/sqlite-member-admission-activity.test.ts` (new)
- Test: `tests/integration/postgres-principal-activity.test.ts` (new)
- Test: `deploy/cloudflare/tests/d1-principal-activity.test.ts` (new)

**Interfaces:**
- Consumes:
  - Slice 2's `actions.subject_id` column.
  - From Task 2.11 (`src/core/identity-ports.ts`): `memberAdmissions`, `type MemberAdmission`, and `AdmitMemberRecord` with `admittedHow: MemberAdmission` and `attribution: ActionAttribution`.
  - From Task 2.8 (`src/core/action-attribution.ts`): `type ActionAttribution`, `systemAttribution`.
- Produces:

```ts
// src/core/installation-identity.ts
export interface ListedMember extends InstallationMember {
  readonly admittedHow: MemberAdmission | null;  // null = admitted before this slice
  readonly admittedByName: string | null;
  readonly lastActiveAt: string | null;
}
// Persistence rule: members.admission_method = command.admittedHow;
// members.admitted_by_principal_id = command.attribution.principalId (null for systemAttribution).
// IdentityRepository.listMembers(installationId): Promise<readonly ListedMember[]>
// src/core/principal-activity.ts
export const principalActivityResolutionMilliseconds = 300_000;
export function principalActivityThreshold(at: string): string;
```

The new columns are:

```sql
installation_members.last_active_at TEXT NULL
installation_members.admitted_by_principal_id TEXT NULL
installation_members.admission_method TEXT NULL CHECK (admission_method IS NULL OR admission_method IN ('manual','automatic','owner'))
managed_api_keys.last_used_at TEXT NULL
```

The new index is `actions_subject` on `subject_id` (partial, `WHERE subject_id IS NOT NULL`).

- [ ] **Step 1: Write the failing SQLite repository test**

Create `tests/storage/sqlite-member-admission-activity.test.ts`:

```ts
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

const installationId = "admission-installation";

describe("SQLite member admission and activity facts", () => {
  let dataDirectory: string;
  let databasePath: string;
  let artifacts: SqliteArtifactRepository;
  let identity: SqliteIdentityRepository;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-admission-"));
    databasePath = path.join(dataDirectory, "artifact-server.db");
    artifacts = new SqliteArtifactRepository(databasePath, installationId);
    identity = new SqliteIdentityRepository(databasePath);
  });

  afterEach(async () => {
    identity.close();
    artifacts.close();
    await rm(dataDirectory, {force: true, recursive: true});
  });

  test("a listed member reports how and by whom it was admitted", async () => {
    const owner = await identity.admitMember({
      admittedHow: memberAdmissions.owner,
      attribution: systemAttribution,
      createdAt: "2026-10-01T09:00:00.000Z",
      displayName: "Local administrator",
      email: "owner@example.test",
      id: "member_owner",
      installationId,
      role: "administrator",
    });
    await identity.admitMember({
      admittedHow: memberAdmissions.manual,
      attribution: {actor: {displayName: owner.displayName, kind: "human"}, authorizedByPrincipalId: null, principalId: owner.id},
      createdAt: "2026-10-01T09:05:00.000Z",
      displayName: "Ada Lovelace",
      email: "ada@example.test",
      id: "member_ada",
      installationId,
      role: "member",
    });
    await identity.admitMember({
      admittedHow: memberAdmissions.automatic,
      attribution: systemAttribution,
      createdAt: "2026-10-01T09:10:00.000Z",
      displayName: "Grace Hopper",
      email: "grace@example.test",
      id: "member_grace",
      installationId,
      role: "member",
    });

    const listed = await identity.listMembers(installationId);

    expect(listed.map((member) => ({
      admittedHow: member.admittedHow,
      admittedByName: member.admittedByName,
      id: member.id,
      lastActiveAt: member.lastActiveAt,
    }))).toEqual([
      {admittedHow: "owner", admittedByName: null, id: "member_owner", lastActiveAt: null},
      {admittedHow: "manual", admittedByName: "Local administrator", id: "member_ada", lastActiveAt: null},
      {admittedHow: "automatic", admittedByName: null, id: "member_grace", lastActiveAt: null},
    ]);
  });

  test("a database created before this revision gains the columns and keeps existing members unattributed", async () => {
    identity.close();
    artifacts.close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP TABLE installation_members;
      CREATE TABLE installation_members (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
        status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (installation_id, email)
      );
      INSERT INTO installation_members VALUES (
        'member_legacy', '${installationId}', 'legacy@example.test', 'Legacy Person',
        'member', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      ALTER TABLE managed_api_keys DROP COLUMN last_used_at;
      PRAGMA user_version = 18;
    `);
    legacy.close();

    artifacts = new SqliteArtifactRepository(databasePath, installationId);
    identity = new SqliteIdentityRepository(databasePath);

    const columns = (table: string) => z.array(z.object({name: z.string()}))
      .parse(new DatabaseSync(databasePath).prepare(`PRAGMA table_info(${table})`).all())
      .map((column) => column.name);
    expect(columns("installation_members")).toEqual(expect.arrayContaining([
      "admission_method", "admitted_by_principal_id", "last_active_at",
    ]));
    expect(columns("managed_api_keys")).toContain("last_used_at");
    expect(await identity.listMembers(installationId)).toEqual([
      expect.objectContaining({
        admittedHow: null,
        admittedByName: null,
        id: "member_legacy",
        lastActiveAt: null,
      }),
    ]);
  });

  test("the actions table has a partial subject index for administration lookups", () => {
    const indexes = z.array(z.object({name: z.string(), partial: z.number()}))
      .parse(new DatabaseSync(databasePath).prepare("PRAGMA index_list(actions)").all());
    expect(indexes).toEqual(expect.arrayContaining([
      {name: "actions_subject", partial: 1},
    ]));
  });
});
```

`PRAGMA index_list` returns more fields than `name` and `partial`. `z.object` strips the extra keys, so `toEqual(expect.arrayContaining(...))` compares only these two.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/storage/sqlite-member-admission-activity.test.ts`

Expected: all three tests FAIL.

- The first fails with `expected [ { admittedHow: undefined, … } ] to deeply equal …`.
- The second fails with `no such column: last_used_at` from the `DROP COLUMN`.
- The third fails because `actions_subject` is missing.

- [ ] **Step 3: Add the core types and the threshold helper**

Create `src/core/principal-activity.ts`:

```ts
/** The coarsest interval at which last-active and last-used facts advance. */
export const principalActivityResolutionMilliseconds = 5 * 60 * 1_000;

/**
 * The newest stored instant that a write at `at` may replace. A stored value
 * at or after it is recent enough, and a later clock never moves it backwards.
 */
export function principalActivityThreshold(at: string): string {
  return new Date(Date.parse(at) - principalActivityResolutionMilliseconds)
    .toISOString();
}
```

Task 2.11 already owns the admission vocabulary. Do not define a second one. `src/core/identity-ports.ts` exports `memberAdmissions`, `type MemberAdmission`, and an `AdmitMemberRecord` with `admittedHow` and `attribution`. This slice only persists those values and lists them.

In `src/core/installation-identity.ts`, add after `InstallationMember`. A type-only import from `./identity-ports.js` is safe, because `identity-ports.ts` imports only types from this file.

```ts
import type {MemberAdmission} from "./identity-ports.js";

/** Administrator-facing member record with admission and activity facts. */
export interface ListedMember extends InstallationMember {
  /** Null for members admitted before admission was recorded. */
  readonly admittedHow: MemberAdmission | null;
  readonly admittedByName: string | null;
  readonly lastActiveAt: string | null;
}
```

In `src/core/identity-ports.ts`:

1. Import `type ListedMember` from `./installation-identity.js`.
2. Leave `AdmitMemberRecord` exactly as Task 2.11 left it: `admittedHow`, `attribution`, `createdAt`, `displayName`, `email`, `id`, `installationId`, `role`.
3. Change `listMembers(installationId: string): Promise<readonly InstallationMember[]>;` to `listMembers(installationId: string): Promise<readonly ListedMember[]>;`.

Persistence rule, used by all three backends below:

- `admission_method` ← `command.admittedHow`
- `admitted_by_principal_id` ← `command.attribution.principalId`. This is `null` for `systemAttribution`, which covers the local-owner bootstrap and automatic OIDC admission.

In `src/application/installation-access.ts`:

1. Import `type ListedMember` from `../core/installation-identity.js`.
2. Change `InstallationIdentityRepository.listMembers` and `InstallationAccessOperations.listMembers` to return `readonly ListedMember[]`.
3. Do not touch the three `admitMember` call sites (`loginAsLocalOwner`, `resolveExternalMember`, `admitMember`). Task 2.11 already passes `admittedHow` and `attribution` there:
   - `loginAsLocalOwner`: `owner` with `systemAttribution`.
   - `resolveExternalMember`: `owner` when the email matches the bootstrap administrator, otherwise `automatic`, both with `systemAttribution`.
   - `admitMember`: `manual` with `attributionOf(command.principal)`.

   Confirm with `git grep -n "admittedHow" src/application/installation-access.ts`, which should print three lines. If it doesn't, stop: Task 2.11 is not merged.

An OIDC first login that matches the bootstrap administrator email is the installation's owner. It records `owner`, the same as the local owner bootstrap, and the Admin console shows "Installation owner" for both.

- [ ] **Step 4: SQLite schema, admission write, and listing**

In `src/storage/sqlite-schema.ts`, set `export const requiredSqliteSchemaVersion = 19;`.

In `src/storage/sqlite-identity-repository.ts`:

1. Import `memberAdmissions` from `../core/identity-ports.js` (D1: `../../../src/core/identity-ports.js`) and `type ListedMember` from the matching `installation-identity.js`.
2. Add the three member columns to `CREATE TABLE IF NOT EXISTS installation_members` after `updated_at TEXT NOT NULL,`:

```sql
        last_active_at TEXT,
        admitted_by_principal_id TEXT,
        admission_method TEXT
          CHECK (admission_method IS NULL OR admission_method IN ('manual', 'automatic', 'owner')),
```

3. Add `last_used_at TEXT,` to `managed_api_keys` after `rotated_from_id …,`.
4. In `#migrate()`, call the new step after `this.#addLoginAttemptNonceIfMissing();`:

```ts
    this.#addAdmissionAndActivityColumnsIfMissing();
```

5. Add the step and widen `#tableColumns`:

```ts
  #addAdmissionAndActivityColumnsIfMissing(): void {
    const memberColumns = this.#tableColumns("installation_members");
    if (!memberColumns.includes("last_active_at")) {
      this.#database.exec("ALTER TABLE installation_members ADD COLUMN last_active_at TEXT");
    }
    if (!memberColumns.includes("admitted_by_principal_id")) {
      this.#database.exec(
        "ALTER TABLE installation_members ADD COLUMN admitted_by_principal_id TEXT",
      );
    }
    if (!memberColumns.includes("admission_method")) {
      this.#database.exec(`ALTER TABLE installation_members ADD COLUMN admission_method TEXT
        CHECK (admission_method IS NULL OR admission_method IN ('manual', 'automatic', 'owner'))`);
    }
    if (!this.#tableColumns("managed_api_keys").includes("last_used_at")) {
      this.#database.exec("ALTER TABLE managed_api_keys ADD COLUMN last_used_at TEXT");
    }
  }

  #tableColumns(
    table: "installation_members" | "login_attempts" | "managed_api_keys",
  ): readonly string[] {
    const rows = this.#database.prepare(`PRAGMA table_info(${table})`).all();
    const columns = z.array(z.object({name: z.string()})).parse(rows);
    return columns.map((column) => column.name);
  }
```

6. Add a listed-member row schema next to `memberRowSchema`:

```ts
const listedMemberRowSchema = memberRowSchema.extend({
  admittedHow: z.enum([
    memberAdmissions.automatic,
    memberAdmissions.manual,
    memberAdmissions.owner,
  ]).nullable(),
  admittedByName: z.string().nullable(),
  lastActiveAt: z.string().nullable(),
});
```

7. Replace the body of `admitMember`'s INSERT:

```ts
      this.#database.prepare(`
        INSERT INTO installation_members (
          id, installation_id, email, display_name, role, status,
          created_at, updated_at, admitted_by_principal_id, admission_method
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        command.id,
        command.installationId,
        command.email,
        command.displayName,
        command.role,
        memberStatuses.active,
        command.createdAt,
        command.createdAt,
        command.attribution.principalId,
        command.admittedHow,
      );
```

If Slice 2 already wraps this INSERT in a transaction with the `member_admit` action insert, edit only the INSERT statement and its bound values. Keep the transaction.

8. Replace `listMembers`:

```ts
  async listMembers(installationId: string): Promise<readonly ListedMember[]> {
    const rows = this.#database.prepare(`
      SELECT
        member.id,
        member.installation_id AS installationId,
        member.email,
        member.display_name AS displayName,
        member.role,
        member.status,
        member.created_at AS createdAt,
        member.updated_at AS updatedAt,
        member.last_active_at AS lastActiveAt,
        member.admission_method AS admittedHow,
        admitter.display_name AS admittedByName
      FROM installation_members AS member
      LEFT JOIN installation_members AS admitter
        ON admitter.installation_id = member.installation_id
        AND admitter.id = member.admitted_by_principal_id
      WHERE member.installation_id = ?
      ORDER BY member.created_at ASC, member.id ASC
    `).all(installationId);
    return rows.map((row) => listedMemberRowSchema.parse(row));
  }
```

Administrators are always human members, because `requireAdministrator` refuses service principals. So a join on `installation_members` resolves every recorded admitter.

In `src/storage/sqlite-artifact-repository.ts` `#migrate`, add to the index block that already creates `projects_active_created`:

```sql
      CREATE INDEX IF NOT EXISTS actions_subject
        ON actions (subject_id, created_at DESC, id DESC)
        WHERE subject_id IS NOT NULL;
```

Place it after Slice 2's activity-log step (the table copy). `subject_id` exists only once that step has run.

- [ ] **Step 5: Run the SQLite test to verify it passes**

Run: `pnpm exec vitest run tests/storage/sqlite-member-admission-activity.test.ts`

Expected: PASS (3 tests).

- [ ] **Step 6: Postgres migration and repository**

In `src/storage/postgres-migrations.ts`, add before `const migrationLoader`:

```ts
const addMemberAdmissionAndActivity = Effect.gen(function*() {
  const sql = yield* SqlClient;
  const statements = [
    `ALTER TABLE installation_members
      ADD COLUMN IF NOT EXISTS last_active_at TEXT,
      ADD COLUMN IF NOT EXISTS admitted_by_principal_id TEXT,
      ADD COLUMN IF NOT EXISTS admission_method TEXT
        CHECK (admission_method IS NULL OR admission_method IN ('manual', 'automatic', 'owner'))`,
    `ALTER TABLE managed_api_keys
      ADD COLUMN IF NOT EXISTS last_used_at TEXT`,
    `CREATE INDEX IF NOT EXISTS actions_subject
      ON actions (installation_id, subject_id, created_at DESC, id DESC)
      WHERE subject_id IS NOT NULL`,
  ] as const;
  for (const statement of statements) yield* sql.unsafe(statement);
});
```

Then:

1. Register `"0019_member_admission_and_activity": addMemberAdmissionAndActivity,` as the last entry in `Migrator.fromRecord({...})`.
2. Set `export const requiredPostgresSchemaVersion = 19;`.
3. Append to `expectedHistory`:

```ts
  }, {
    migration_id: 19,
    name: "member_admission_and_activity",
```

In `src/storage/postgres-identity-repository.ts`:

1. Import `memberAdmissions` from `../core/identity-ports.js` (D1: `../../../src/core/identity-ports.js`) and `type ListedMember` from the matching `installation-identity.js`.
2. Add a row schema:

```ts
const listedMemberRowSchema = memberRowSchema.extend({
  admittedHow: z.enum([
    memberAdmissions.automatic,
    memberAdmissions.manual,
    memberAdmissions.owner,
  ]).nullable(),
  admittedByName: z.string().nullable(),
  lastActiveAt: z.string().nullable(),
});
```

3. Change `admitMember`'s INSERT. If Slice 2 added an action insert, keep it in the same `run`.

```ts
        yield* sql`INSERT INTO installation_members (
          installation_id, id, email, display_name, role, status,
          created_at, updated_at, admitted_by_principal_id, admission_method
        ) VALUES (
          ${command.installationId}, ${command.id}, ${command.email},
          ${command.displayName}, ${command.role}, ${memberStatuses.active},
          ${command.createdAt}, ${command.createdAt},
          ${command.attribution.principalId}, ${command.admittedHow}
        )`;
```

4. Replace `listMembers`:

```ts
  async listMembers(installationId: string): Promise<readonly ListedMember[]> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT member.id, member.installation_id AS "installationId", member.email,
          member.display_name AS "displayName", member.role, member.status,
          member.created_at AS "createdAt", member.updated_at AS "updatedAt",
          member.last_active_at AS "lastActiveAt",
          member.admission_method AS "admittedHow",
          admitter.display_name AS "admittedByName"
        FROM installation_members AS member
        LEFT JOIN installation_members AS admitter
          ON admitter.installation_id = member.installation_id
          AND admitter.id = member.admitted_by_principal_id
        WHERE member.installation_id = $1
        ORDER BY member.created_at ASC, member.id ASC`,
        [installationId],
      );
      return z.array(listedMemberRowSchema).parse(rows);
    }));
  }
```

- [ ] **Step 7: Write the Postgres repository test**

Create `tests/integration/postgres-principal-activity.test.ts`:

```ts
import {randomUUID} from "node:crypto";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {systemAttribution} from "../../src/core/action-attribution.js";
import {memberAdmissions} from "../../src/core/identity-ports.js";
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

describe("Postgres member admission and principal activity", () => {
  const scratch = `artifact_principal_activity_${randomUUID().replaceAll("-", "")}`;
  const installationId = `test-principal-activity-${randomUUID()}`;
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

  test("a listed member reports how and by whom it was admitted", async () => {
    const owner = await identity.admitMember({
      admittedHow: memberAdmissions.owner,
      attribution: systemAttribution,
      createdAt: "2026-10-01T09:00:00.000Z",
      displayName: "Local administrator",
      email: "owner@example.test",
      id: "member_owner",
      installationId,
      role: "administrator",
    });
    await identity.admitMember({
      admittedHow: memberAdmissions.manual,
      attribution: {actor: {displayName: owner.displayName, kind: "human"}, authorizedByPrincipalId: null, principalId: owner.id},
      createdAt: "2026-10-01T09:05:00.000Z",
      displayName: "Ada Lovelace",
      email: "ada@example.test",
      id: "member_ada",
      installationId,
      role: "member",
    });

    expect((await identity.listMembers(installationId)).map((member) => ({
      admittedHow: member.admittedHow,
      admittedByName: member.admittedByName,
      id: member.id,
    }))).toEqual([
      {admittedHow: "owner", admittedByName: null, id: "member_owner"},
      {admittedHow: "manual", admittedByName: "Local administrator", id: "member_ada"},
    ]);
  });
});
```

Add `"tests/integration/postgres-principal-activity.test.ts",` to the `include` list in `tests/configs/vitest.external-storage.config.ts`.

- [ ] **Step 8: D1 migration and repository**

In `deploy/cloudflare/src/d1-migrations.ts`:

1. Set `export const requiredD1SchemaVersion = 17;`.
2. In `schemaSql`, add to `CREATE TABLE IF NOT EXISTS installation_members` after `updated_at TEXT NOT NULL,`:

```sql
    last_active_at TEXT,
    admitted_by_principal_id TEXT,
    admission_method TEXT
      CHECK (admission_method IS NULL OR admission_method IN ('manual', 'automatic', 'owner')),
```

3. Add `last_used_at TEXT,` to `managed_api_keys` after the `rotated_from_id` line.
4. Add the upgrade step and call it inside `if (current === null || current < requiredD1SchemaVersion) { … }`, after Slice 2's activity-log step:

```ts
/**
 * Add admission and activity facts to identity tables created before this
 * revision. `CREATE TABLE IF NOT EXISTS` leaves an existing table unchanged.
 */
async function addAdmissionAndActivityColumnsIfMissing(
  database: D1Database,
): Promise<void> {
  const members = await database.prepare("PRAGMA table_info(installation_members)")
    .all<{name: string}>();
  const memberColumns = members.results.map((column) => column.name);
  const statements: string[] = [];
  if (!memberColumns.includes("last_active_at")) {
    statements.push("ALTER TABLE installation_members ADD COLUMN last_active_at TEXT");
  }
  if (!memberColumns.includes("admitted_by_principal_id")) {
    statements.push("ALTER TABLE installation_members ADD COLUMN admitted_by_principal_id TEXT");
  }
  if (!memberColumns.includes("admission_method")) {
    statements.push(`ALTER TABLE installation_members ADD COLUMN admission_method TEXT
      CHECK (admission_method IS NULL OR admission_method IN ('manual', 'automatic', 'owner'))`);
  }
  const keys = await database.prepare("PRAGMA table_info(managed_api_keys)")
    .all<{name: string}>();
  if (!keys.results.some((column) => column.name === "last_used_at")) {
    statements.push("ALTER TABLE managed_api_keys ADD COLUMN last_used_at TEXT");
  }
  statements.push(`CREATE INDEX IF NOT EXISTS actions_subject
    ON actions (subject_id, created_at DESC, id DESC)
    WHERE subject_id IS NOT NULL`);
  await database.batch(statements.map((statement) => database.prepare(statement)));
}
```

In `deploy/cloudflare/src/d1-identity-repository.ts`:

1. Import `memberAdmissions` from `../core/identity-ports.js` (D1: `../../../src/core/identity-ports.js`) and `type ListedMember` from the matching `installation-identity.js`.
2. Add `listedMemberRowSchema`, identical to the SQLite one.
3. Change `admitMember`'s INSERT to include `admitted_by_principal_id, admission_method` and bind `command.attribution.principalId, command.admittedHow`. Keep Slice 2's batch if it added the action statement.
4. Replace `listMembers`:

```ts
    listMembers: async (installationId): Promise<readonly ListedMember[]> => {
      const result = await database.prepare(`
        SELECT member.id, member.installation_id AS installationId, member.email,
          member.display_name AS displayName, member.role, member.status,
          member.created_at AS createdAt, member.updated_at AS updatedAt,
          member.last_active_at AS lastActiveAt,
          member.admission_method AS admittedHow,
          admitter.display_name AS admittedByName
        FROM installation_members AS member
        LEFT JOIN installation_members AS admitter
          ON admitter.installation_id = member.installation_id
          AND admitter.id = member.admitted_by_principal_id
        WHERE member.installation_id = ?
        ORDER BY member.created_at ASC, member.id ASC
      `).bind(installationId).all<z.input<typeof listedMemberRowSchema>>();
      return result.results.map((row) => listedMemberRowSchema.parse(row));
    },
```

Create `deploy/cloudflare/tests/d1-principal-activity.test.ts`:

```ts
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";
import {getPlatformProxy} from "wrangler";

import {systemAttribution} from "../../../src/core/action-attribution.js";
import {memberAdmissions} from "../../../src/core/identity-ports.js";
import {createD1IdentityRepository} from "../src/d1-identity-repository.js";
import {migrateD1} from "../src/d1-migrations.js";

const openLocalD1 = () => getPlatformProxy<{
  ARTIFACT_SERVER_D1_DATABASE: D1Database;
}>({
  configPath: fileURLToPath(new URL("../wrangler.git-store.test.jsonc", import.meta.url)),
  envFiles: [],
  persist: false,
  remoteBindings: false,
});

const installationId = "d1-principal-activity-installation";

describe("D1 member admission and principal activity", () => {
  it("a listed member reports how and by whom it was admitted", async () => {
    const proxy = await openLocalD1();
    try {
      const database = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
      await migrateD1(database, installationId);
      const identity = createD1IdentityRepository(database);
      const owner = await identity.admitMember({
        admittedHow: memberAdmissions.owner,
        attribution: systemAttribution,
        createdAt: "2026-10-01T09:00:00.000Z",
        displayName: "Workspace owner",
        email: "owner@example.test",
        id: "member_owner",
        installationId,
        role: "administrator",
      });
      await identity.admitMember({
        admittedHow: memberAdmissions.manual,
        attribution: {actor: {displayName: owner.displayName, kind: "human"}, authorizedByPrincipalId: null, principalId: owner.id},
        createdAt: "2026-10-01T09:05:00.000Z",
        displayName: "Ada Lovelace",
        email: "ada@example.test",
        id: "member_ada",
        installationId,
        role: "member",
      });

      expect((await identity.listMembers(installationId)).map((member) => ({
        admittedHow: member.admittedHow,
        admittedByName: member.admittedByName,
        id: member.id,
      }))).toEqual([
        {admittedHow: "owner", admittedByName: null, id: "member_owner"},
        {admittedHow: "manual", admittedByName: "Workspace owner", id: "member_ada"},
      ]);
    } finally {
      await proxy.dispose();
    }
  });
});
```

- [ ] **Step 9: Run all three backends and the typecheck**

Run each of these:

```bash
pnpm typecheck
pnpm exec vitest run tests/storage/sqlite-member-admission-activity.test.ts tests/conformance/installation-identity.test.ts tests/conformance/auth-009-api-key-rotation.test.ts
pnpm check:cloudflare
pnpm test:external-storage-runtime
```

Expected:

- `typecheck` exits 0.
- The vitest run passes. Existing identity tests still pass because admission only adds fields.
- `check:cloudflare` passes, including `d1-principal-activity.test.ts`. The two runtime tests asserting `requiredD1SchemaVersion` now read 17.
- The external-storage run passes, including `postgres-principal-activity.test.ts`. `external-storage-runtime.test.ts` reads `requiredPostgresSchemaVersion` (19). This run requires Docker.

- [ ] **Step 10: Commit**

```bash
git add src/core/principal-activity.ts src/core/installation-identity.ts src/core/identity-ports.ts \
  src/application/installation-access.ts src/storage/sqlite-identity-repository.ts src/storage/sqlite-schema.ts \
  src/storage/sqlite-artifact-repository.ts src/storage/postgres-migrations.ts src/storage/postgres-identity-repository.ts \
  deploy/cloudflare/src/d1-migrations.ts deploy/cloudflare/src/d1-identity-repository.ts \
  tests/storage/sqlite-member-admission-activity.test.ts tests/integration/postgres-principal-activity.test.ts \
  deploy/cloudflare/tests/d1-principal-activity.test.ts tests/configs/vitest.external-storage.config.ts
git commit -m "Record how and by whom each member was admitted

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3.2: Conditional last-active and last-used writes, and the enriched key listing

**Files:**
- Modify: `src/core/ports.ts` (add `PrincipalActivityRecorder`)
- Modify: `src/core/installation-identity.ts` (add `ListedApiKey`)
- Modify: `src/core/identity-ports.ts` (`IdentityRepository extends PrincipalActivityRecorder`; `listApiKeys` return type)
- Modify: `src/application/installation-access.ts` (`InstallationIdentityRepository.listApiKeys` type)
- Modify: `src/storage/sqlite-identity-repository.ts`, `src/storage/postgres-identity-repository.ts`, `deploy/cloudflare/src/d1-identity-repository.ts`
- Test: `tests/storage/sqlite-member-admission-activity.test.ts`, `tests/integration/postgres-principal-activity.test.ts`, `deploy/cloudflare/tests/d1-principal-activity.test.ts`

**Interfaces:**
- Consumes: Task 3.1's columns and `principalActivityThreshold`.
- Produces:

```ts
// src/core/ports.ts
export interface PrincipalActivityRecorder {
  /** Advance a member's last-active instant when the stored one is ≥5 minutes older. */
  readonly touch: (principalId: string, at: string) => Promise<void>;
  /** Advance an API key's last-used instant under the same rule. */
  readonly touchApiKey: (keyId: string, at: string) => Promise<void>;
}
// src/core/installation-identity.ts
export interface ListedApiKey extends ManagedApiKey {
  readonly lastUsedAt: string | null;
  readonly ownerName: string | null;      // member display name; null for service keys
  readonly revokedByName: string | null;  // actor of newest key_revoke/key_rotate on this key
}
// IdentityRepository.listApiKeys(installationId): Promise<readonly ListedApiKey[]>
```

- [ ] **Step 1: Write the failing SQLite tests**

Append inside the `describe` in `tests/storage/sqlite-member-admission-activity.test.ts`:

```ts
  test("touch advances last active only when the stored instant is five minutes older, and never backwards", async () => {
    await identity.admitMember({
      admittedHow: memberAdmissions.manual,
      attribution: systemAttribution,
      createdAt: "2026-10-01T09:00:00.000Z",
      displayName: "Ada Lovelace",
      email: "ada@example.test",
      id: "member_ada",
      installationId,
      role: "member",
    });
    const lastActive = async () =>
      (await identity.listMembers(installationId))[0]?.lastActiveAt;

    await identity.touch("member_ada", "2026-10-01T12:00:00.000Z");
    expect(await lastActive()).toBe("2026-10-01T12:00:00.000Z");

    await identity.touch("member_ada", "2026-10-01T12:04:59.999Z");
    expect(await lastActive()).toBe("2026-10-01T12:00:00.000Z");

    await identity.touch("member_ada", "2026-10-01T11:00:00.000Z");
    expect(await lastActive()).toBe("2026-10-01T12:00:00.000Z");

    await identity.touch("member_ada", "2026-10-01T12:05:00.001Z");
    expect(await lastActive()).toBe("2026-10-01T12:05:00.001Z");

    await expect(identity.touch("member_unknown", "2026-10-01T12:10:00.000Z"))
      .resolves.toBeUndefined();
  });

  test("touchApiKey records last used, and the key listing names the owner", async () => {
    await identity.admitMember({
      admittedHow: memberAdmissions.manual,
      attribution: systemAttribution,
      createdAt: "2026-10-01T09:00:00.000Z",
      displayName: "Ada Lovelace",
      email: "ada@example.test",
      id: "member_ada",
      installationId,
      role: "member",
    });
    const base = {
      authorizedByPrincipalId: "member_ada",
      capabilities: ["artifact:read"] as const,
      createdAt: "2026-10-01T09:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      installationId,
      revokedAt: null,
      rotatedFromId: null,
    };
    await identity.createApiKey({
      ...base,
      id: "key_member",
      name: "Ada's key",
      prefix: "as_key_key_member_prefix",
      principalId: "member_ada",
      principalKind: "human",
      secretDigest: "digest-member",
    });
    await identity.createApiKey({
      ...base,
      id: "key_service",
      name: "Release bot",
      prefix: "as_key_key_service_prefix",
      principalId: "service:key_service",
      principalKind: "service",
      secretDigest: "digest-service",
    });

    await identity.touchApiKey("key_service", "2026-10-01T12:00:00.000Z");
    await identity.touchApiKey("key_service", "2026-10-01T12:01:00.000Z");

    const keys = await identity.listApiKeys(installationId);
    expect(keys.map((key) => ({
      id: key.id,
      lastUsedAt: key.lastUsedAt,
      ownerName: key.ownerName,
      revokedByName: key.revokedByName,
    }))).toEqual(expect.arrayContaining([
      {id: "key_member", lastUsedAt: null, ownerName: "Ada Lovelace", revokedByName: null},
      {id: "key_service", lastUsedAt: "2026-10-01T12:00:00.000Z", ownerName: null, revokedByName: null},
    ]));
    expect(keys.every((key) => !("secretDigest" in key))).toBe(true);
  });
```

`"artifact:read"` is `principalCapabilities.readArtifacts` in `src/core/identity.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/storage/sqlite-member-admission-activity.test.ts`

Expected: the two new tests FAIL.

- The first fails with `TypeError: identity.touch is not a function`.
- The second fails with `TypeError: identity.touchApiKey is not a function`.

- [ ] **Step 3: Add the port and types**

In `src/core/ports.ts`, add near `Clock`:

```ts
/** Throttled last-active and last-used persistence (spec §3). */
export interface PrincipalActivityRecorder {
  /**
   * Advance one member's last-active instant to `at` when the stored instant
   * is missing or at least five minutes older. An unknown ID changes nothing.
   */
  readonly touch: (principalId: string, at: string) => Promise<void>;
  /** Advance one managed API key's last-used instant under the same rule. */
  readonly touchApiKey: (keyId: string, at: string) => Promise<void>;
}
```

In `src/core/installation-identity.ts`, add after `StoredManagedApiKey`:

```ts
/** Administrator-facing key record with use and revocation facts. */
export interface ListedApiKey extends ManagedApiKey {
  readonly lastUsedAt: string | null;
  /** The owning member's display name; null for a service key. */
  readonly ownerName: string | null;
  /** Actor of the newest revoke or rotate action on this key, when recorded. */
  readonly revokedByName: string | null;
}
```

In `src/core/identity-ports.ts`:

1. Import `type ListedApiKey` and `import type {PrincipalActivityRecorder} from "./ports.js";`.
2. Change the interface declaration to `export interface IdentityRepository extends PrincipalActivityRecorder {`.
3. Change `listApiKeys(installationId: string): Promise<readonly ManagedApiKey[]>;` to return `Promise<readonly ListedApiKey[]>`.

In `src/application/installation-access.ts`, change `InstallationIdentityRepository.listApiKeys` to return `Effect.Effect<readonly ListedApiKey[], IdentityRepositoryFailure>`.

- [ ] **Step 4: Implement the three backends**

**SQLite** (`src/storage/sqlite-identity-repository.ts`). Import `principalActivityThreshold` from `../core/principal-activity.js` and `type ListedApiKey`. Add a row schema:

```ts
const listedApiKeyRowSchema = z.object({
  lastUsedAt: z.string().nullable(),
  ownerName: z.string().nullable(),
  revokedByName: z.string().nullable(),
});
```

Add the methods:

```ts
  async touch(principalId: string, at: string): Promise<void> {
    this.#database.prepare(`
      UPDATE installation_members SET last_active_at = ?
      WHERE id = ? AND (last_active_at IS NULL OR last_active_at < ?)
    `).run(at, principalId, principalActivityThreshold(at));
  }

  async touchApiKey(keyId: string, at: string): Promise<void> {
    this.#database.prepare(`
      UPDATE managed_api_keys SET last_used_at = ?
      WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)
    `).run(at, keyId, principalActivityThreshold(at));
  }
```

Replace `listApiKeys`:

```ts
  async listApiKeys(installationId: string): Promise<readonly ListedApiKey[]> {
    const rows = this.#database.prepare(`
      SELECT
        managed.id,
        managed.installation_id AS installationId,
        managed.name,
        managed.prefix,
        managed.secret_digest AS secretDigest,
        managed.principal_id AS principalId,
        managed.principal_kind AS principalKind,
        managed.capabilities_json AS capabilitiesJson,
        managed.authorized_by_principal_id AS authorizedByPrincipalId,
        managed.created_at AS createdAt,
        managed.expires_at AS expiresAt,
        managed.revoked_at AS revokedAt,
        managed.rotated_from_id AS rotatedFromId,
        managed.last_used_at AS lastUsedAt,
        owner.display_name AS ownerName,
        (
          SELECT entry.actor_name FROM actions AS entry
          WHERE entry.subject_id = managed.id
            AND entry.action IN ('key_revoke', 'key_rotate')
          ORDER BY entry.created_at DESC, entry.id DESC
          LIMIT 1
        ) AS revokedByName
      FROM managed_api_keys AS managed
      LEFT JOIN installation_members AS owner
        ON owner.installation_id = managed.installation_id
        AND owner.id = managed.principal_id
      WHERE managed.installation_id = ?
      ORDER BY managed.created_at DESC, managed.id DESC
    `).all(installationId);
    return rows.map((row) => {
      const facts = listedApiKeyRowSchema.parse(row);
      return {
        ...withoutSecretDigest(parseApiKey(row)),
        lastUsedAt: facts.lastUsedAt,
        ownerName: facts.ownerName,
        revokedByName: facts.revokedByName,
      };
    });
  }
```

**Postgres** (`src/storage/postgres-identity-repository.ts`). Use the same imports and the same `listedApiKeyRowSchema`. Add:

```ts
  async touch(principalId: string, at: string): Promise<void> {
    const installationId = this.#installationId;
    const threshold = principalActivityThreshold(at);
    await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql`UPDATE installation_members SET last_active_at = ${at}
        WHERE installation_id = ${installationId} AND id = ${principalId}
          AND (last_active_at IS NULL OR last_active_at < ${threshold})`;
    }));
  }

  async touchApiKey(keyId: string, at: string): Promise<void> {
    const installationId = this.#installationId;
    const threshold = principalActivityThreshold(at);
    await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql`UPDATE managed_api_keys SET last_used_at = ${at}
        WHERE installation_id = ${installationId} AND id = ${keyId}
          AND (last_used_at IS NULL OR last_used_at < ${threshold})`;
    }));
  }
```

Replace `listApiKeys`:

```ts
  async listApiKeys(installationId: string): Promise<readonly ListedApiKey[]> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT managed.id, managed.installation_id AS "installationId", managed.name,
          managed.prefix, managed.secret_digest AS "secretDigest",
          managed.principal_id AS "principalId", managed.principal_kind AS "principalKind",
          managed.capabilities_json AS "capabilitiesJson",
          managed.authorized_by_principal_id AS "authorizedByPrincipalId",
          managed.created_at AS "createdAt", managed.expires_at AS "expiresAt",
          managed.revoked_at AS "revokedAt", managed.rotated_from_id AS "rotatedFromId",
          managed.last_used_at AS "lastUsedAt",
          owner.display_name AS "ownerName",
          (
            SELECT entry.actor_name FROM actions AS entry
            WHERE entry.installation_id = managed.installation_id
              AND entry.subject_id = managed.id
              AND entry.action IN ('key_revoke', 'key_rotate')
            ORDER BY entry.created_at DESC, entry.id DESC
            LIMIT 1
          ) AS "revokedByName"
        FROM managed_api_keys AS managed
        LEFT JOIN installation_members AS owner
          ON owner.installation_id = managed.installation_id
          AND owner.id = managed.principal_id
        WHERE managed.installation_id = $1
        ORDER BY managed.created_at DESC, managed.id DESC`,
        [installationId],
      );
      return z.array(apiKeyRowSchema.merge(listedApiKeyRowSchema)).parse(rows)
        .map((row) => ({
          ...withoutSecretDigest(parseApiKey(row)),
          lastUsedAt: row.lastUsedAt,
          ownerName: row.ownerName,
          revokedByName: row.revokedByName,
        }));
    }));
  }
```

`parseApiKey` in the Postgres file takes a parsed `apiKeyRowSchema` row, so the merged row satisfies it. If the Postgres file has no `withoutSecretDigest`, copy the SQLite one:

```ts
function withoutSecretDigest(key: StoredManagedApiKey): ManagedApiKey {
  const {secretDigest: _secretDigest, ...metadata} = key;
  return metadata;
}
```

**D1** (`deploy/cloudflare/src/d1-identity-repository.ts`). Import `principalActivityThreshold` from `../../../src/core/principal-activity.js` and `type ListedApiKey`. Add `listedApiKeyRowSchema`, identical to SQLite, and these members to the returned object:

```ts
    touch: async (principalId: string, at: string): Promise<void> => {
      await database.prepare(`
        UPDATE installation_members SET last_active_at = ?
        WHERE id = ? AND (last_active_at IS NULL OR last_active_at < ?)
      `).bind(at, principalId, principalActivityThreshold(at)).run();
    },

    touchApiKey: async (keyId: string, at: string): Promise<void> => {
      await database.prepare(`
        UPDATE managed_api_keys SET last_used_at = ?
        WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)
      `).bind(at, keyId, principalActivityThreshold(at)).run();
    },
```

Replace `listApiKeys` with the SQLite query text, run as `database.prepare(…).bind(installationId).all<Record<string, unknown>>()`. Map each row as in SQLite: `{...withoutSecretDigest(parseApiKey(row)), lastUsedAt, ownerName, revokedByName}`.

- [ ] **Step 5: Run the SQLite tests to verify they pass**

Run: `pnpm exec vitest run tests/storage/sqlite-member-admission-activity.test.ts`

Expected: PASS (5 tests).

- [ ] **Step 6: Add the Postgres and D1 equivalents of the touch test**

Append to `tests/integration/postgres-principal-activity.test.ts`, inside the `describe`:

```ts
  test("touch and touchApiKey advance at most once per five minutes", async () => {
    await identity.admitMember({
      admittedHow: memberAdmissions.manual,
      attribution: systemAttribution,
      createdAt: "2026-10-01T09:00:00.000Z",
      displayName: "Ada Lovelace",
      email: "ada@example.test",
      id: "member_ada",
      installationId,
      role: "member",
    });
    await identity.createApiKey({
      authorizedByPrincipalId: "member_ada",
      capabilities: ["artifact:read"],
      createdAt: "2026-10-01T09:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      id: "key_service",
      installationId,
      name: "Release bot",
      prefix: "as_key_key_service_prefix",
      principalId: "service:key_service",
      principalKind: "service",
      revokedAt: null,
      rotatedFromId: null,
      secretDigest: "digest-service",
    });

    await identity.touch("member_ada", "2026-10-01T12:00:00.000Z");
    await identity.touch("member_ada", "2026-10-01T12:03:00.000Z");
    await identity.touchApiKey("key_service", "2026-10-01T12:00:00.000Z");
    await identity.touchApiKey("key_service", "2026-10-01T12:06:00.000Z");

    expect((await identity.listMembers(installationId))[0]?.lastActiveAt)
      .toBe("2026-10-01T12:00:00.000Z");
    expect(await identity.listApiKeys(installationId)).toEqual([
      expect.objectContaining({
        id: "key_service",
        lastUsedAt: "2026-10-01T12:06:00.000Z",
        ownerName: null,
        revokedByName: null,
      }),
    ]);
  });
```

Append the same test body to `deploy/cloudflare/tests/d1-principal-activity.test.ts` as a second `it(…)`. Use the same `openLocalD1` and `migrateD1` preamble, the same `try/finally proxy.dispose()`, and `createD1IdentityRepository(database)`.

- [ ] **Step 7: Run all backends**

```bash
pnpm typecheck
pnpm exec vitest run tests/storage/sqlite-member-admission-activity.test.ts
pnpm check:cloudflare
pnpm test:external-storage-runtime
```

Expected: every run is green. `check:cloudflare` reports 2 passing tests in `d1-principal-activity.test.ts`. The external-storage run reports 2 passing in `postgres-principal-activity.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/core/ports.ts src/core/installation-identity.ts src/core/identity-ports.ts \
  src/application/installation-access.ts src/storage/sqlite-identity-repository.ts \
  src/storage/postgres-identity-repository.ts deploy/cloudflare/src/d1-identity-repository.ts \
  tests/storage/sqlite-member-admission-activity.test.ts tests/integration/postgres-principal-activity.test.ts \
  deploy/cloudflare/tests/d1-principal-activity.test.ts
git commit -m "Advance member last-active and key last-used at most once per five minutes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3.3: Record credential use after the response (ACT-007)

**Files:**
- Create: `src/application/principal-activity.ts`
- Modify: `src/application/application-runtime.ts` (add `PrincipalActivityService` to `ApplicationServices`)
- Modify: `src/application/installation-access.ts` (new optional dependency; note on four authentication paths)
- Modify: `src/local/create-local-application-layer.ts` (build the tracker; pass it to the identity layer; merge its layer; add it to the return type)
- Modify: `src/http/create-http-app.ts` (flush after `/api/*` and `/mcp` responses)
- Test: `tests/conformance/act-007-principal-activity.test.ts` (new)

**Interfaces:**
- Consumes: `PrincipalActivityRecorder` (Task 3.2), implemented by every `IdentityRepository`; `principalActivityResolutionMilliseconds` (Task 3.1).
- Produces:

```ts
// src/application/principal-activity.ts
export interface PrincipalActivitySubject { readonly id: string; readonly kind: "api_key" | "member" }
export interface PrincipalActivityOperations {
  readonly flush: () => Effect.Effect<void>;                            // never fails
  readonly note: (subject: PrincipalActivitySubject) => Effect.Effect<void>;  // no I/O
}
export class PrincipalActivityService extends Context.Service<PrincipalActivityService, PrincipalActivityOperations>()(
  "artifact-server/application/PrincipalActivityService") {
  static readonly layer: (operations: PrincipalActivityOperations) => Layer.Layer<PrincipalActivityService>;
}
export function makePrincipalActivity(dependencies: {
  readonly clock: {readonly now: () => Date};
  readonly maxSubjects?: number;      // default 10_000
  readonly recorder: PrincipalActivityRecorder;
}): PrincipalActivityOperations;
// InstallationAccessDependencies gains:
readonly principalActivity?: Pick<PrincipalActivityOperations, "note">;
```

- [ ] **Step 1: Record the performance baseline before the change**

AGENTS.md requires a before-and-after comparison on the same machine, Node version and workload. This task puts work on every authenticated request. Run:

```bash
node --version
pnpm perf:baseline --output "${TMPDIR:-/tmp}/act-007-perf-before.json"
```

Expected: the command prints the summary and `Report: …/act-007-perf-before.json`. Keep the file for Step 9.

- [ ] **Step 2: Write the failing conformance test**

Create `tests/conformance/act-007-principal-activity.test.ts`:

```ts
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {signInAdministrator} from "../support/agent-dispatch.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

const membersSchema = z.object({
  members: z.array(z.object({
    email: z.string(),
    id: z.string(),
    lastActiveAt: z.string().nullable(),
  }).loose()),
});
const apiKeysSchema = z.object({
  apiKeys: z.array(z.object({
    id: z.string(),
    lastUsedAt: z.string().nullable(),
  }).loose()),
});
const issuedKeySchema = z.object({
  apiKey: z.object({id: z.string()}).loose(),
  token: z.string(),
});

function mutationHeaders(server: RunningTestServer, cookies: ApplicationCookies): Headers {
  return new Headers({
    "Content-Type": "application/json",
    Cookie: cookies.header,
    Origin: server.baseUrl,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": cookies.csrf,
  });
}

async function issueKey(
  server: RunningTestServer,
  cookies: ApplicationCookies,
  body: {readonly memberId?: string; readonly name: string},
): Promise<z.infer<typeof issuedKeySchema>> {
  const response = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
    body: JSON.stringify({
      capabilities: ["artifact:read"],
      expiresAt: "2099-01-01T00:00:00.000Z",
      ...body,
    }),
    headers: mutationHeaders(server, cookies),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return issuedKeySchema.parse(await response.json());
}

async function admit(
  server: RunningTestServer,
  cookies: ApplicationCookies,
  email: string,
): Promise<string> {
  const response = await fetch(`${server.baseUrl}/api/v1/members`, {
    body: JSON.stringify({displayName: "Ada Lovelace", email, role: "member"}),
    headers: mutationHeaders(server, cookies),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return z.object({member: z.object({id: z.string()})}).parse(await response.json()).member.id;
}

async function lastActive(
  server: RunningTestServer,
  cookies: ApplicationCookies,
  memberId: string,
): Promise<string | null | undefined> {
  const response = await fetch(`${server.baseUrl}/api/v1/members`, {
    headers: {Cookie: cookies.header},
  });
  expect(response.status).toBe(200);
  return membersSchema.parse(await response.json()).members
    .find((member) => member.id === memberId)?.lastActiveAt;
}

async function lastUsed(
  server: RunningTestServer,
  cookies: ApplicationCookies,
  keyId: string,
): Promise<string | null | undefined> {
  const response = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
    headers: {Cookie: cookies.header},
  });
  expect(response.status).toBe(200);
  return apiKeysSchema.parse(await response.json()).apiKeys
    .find((key) => key.id === keyId)?.lastUsedAt;
}

async function sessionPrincipalId(
  server: RunningTestServer,
  cookies: ApplicationCookies,
): Promise<string> {
  const response = await fetch(`${server.baseUrl}/api/v1/session`, {
    headers: {Cookie: cookies.header},
  });
  expect(response.status).toBe(200);
  return z.object({principal: z.object({id: z.string()})})
    .parse(await response.json()).principal.id;
}

function bearerStatus(server: RunningTestServer, token: string): Promise<number> {
  return fetch(`${server.baseUrl}/api/v1/artifacts`, {
    headers: {Authorization: `Bearer ${token}`},
  }).then((response) => response.status);
}

describe("ACT-007 principal activity tracking", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let now: Date;
  const clock = {now: () => now};

  beforeEach(async () => {
    now = new Date("2026-10-01T12:00:00.000Z");
    installation = await createTestInstallation();
    server = await startTestServer(installation, {clock});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("ACT-007-B: session and key use advance last active and last used at most once per five minutes per principal, across processes", async () => {
    const cookies = await signInAdministrator(server, installation);
    const administratorId = await sessionPrincipalId(server, cookies);
    await expect.poll(() => lastActive(server, cookies, administratorId))
      .toBe("2026-10-01T12:00:00.000Z");

    const service = await issueKey(server, cookies, {name: "Release bot"});
    const memberId = await admit(server, cookies, "ada@example.test");
    const memberKey = await issueKey(server, cookies, {memberId, name: "Ada's key"});
    expect(await bearerStatus(server, service.token)).toBe(200);
    expect(await bearerStatus(server, memberKey.token)).toBe(200);
    await expect.poll(() => lastUsed(server, cookies, service.apiKey.id))
      .toBe("2026-10-01T12:00:00.000Z");
    await expect.poll(() => lastUsed(server, cookies, memberKey.apiKey.id))
      .toBe("2026-10-01T12:00:00.000Z");
    await expect.poll(() => lastActive(server, cookies, memberId))
      .toBe("2026-10-01T12:00:00.000Z");

    // Inside five minutes, a second process with its own empty throttle
    // still leaves the stored instants alone: the database write is conditional.
    now = new Date("2026-10-01T12:04:00.000Z");
    const second = await startTestServer(installation, {clock});
    try {
      expect(await bearerStatus(second, service.token)).toBe(200);
      expect(await sessionPrincipalId(second, cookies)).toBe(administratorId);
      expect(await lastUsed(second, cookies, service.apiKey.id))
        .toBe("2026-10-01T12:00:00.000Z");
      expect(await lastActive(second, cookies, administratorId))
        .toBe("2026-10-01T12:00:00.000Z");
    } finally {
      await second.stop();
    }

    now = new Date("2026-10-01T12:05:01.000Z");
    expect(await bearerStatus(server, service.token)).toBe(200);
    await expect.poll(() => lastUsed(server, cookies, service.apiKey.id))
      .toBe("2026-10-01T12:05:01.000Z");
    await expect.poll(() => lastActive(server, cookies, administratorId))
      .toBe("2026-10-01T12:05:01.000Z");
  });

  test("ACT-007-F: a refused tracking write never fails the request, unknown or rejected credentials record nothing, and the refused write is retried", async () => {
    const cookies = await signInAdministrator(server, installation);
    const database = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
    );
    try {
      database.exec(`
        CREATE TRIGGER refuse_member_activity
        BEFORE UPDATE OF last_active_at ON installation_members
        BEGIN SELECT RAISE(ABORT, 'member activity refused'); END;
      `);

      const administratorId = await sessionPrincipalId(server, cookies);
      expect(await bearerStatus(server, installation.apiToken)).toBe(200);
      expect(await bearerStatus(server, "as_key_key_00000000-0000-0000-0000-000000000000_abcdefghijklmnopqrstuvwxyz012345"))
        .toBe(401);
      const service = await issueKey(server, cookies, {name: "Release bot"});
      const revoked = await fetch(
        `${server.baseUrl}/api/v1/api-keys/${encodeURIComponent(service.apiKey.id)}/revoke`,
        {headers: mutationHeaders(server, cookies), method: "POST"},
      );
      expect(revoked.status).toBe(200);
      expect(await bearerStatus(server, service.token)).toBe(401);

      expect(await lastActive(server, cookies, administratorId)).toBeNull();
      expect(await lastUsed(server, cookies, service.apiKey.id)).toBeNull();

      database.exec("DROP TRIGGER refuse_member_activity");
      expect(await sessionPrincipalId(server, cookies)).toBe(administratorId);
      await expect.poll(() => lastActive(server, cookies, administratorId))
        .toBe("2026-10-01T12:00:00.000Z");
    } finally {
      database.close();
    }
  });
});
```

Notes on the test:

- `installation.apiToken` is the local service token (`principal.id = "local-api-token"`). No member or key row matches it, so its touch is a no-op and must not fail.
- The malformed `as_key_…` credential and the revoked key both return 401. Rejected credentials never reach `note`.
- `expect.poll` waits for the write that runs after the response. The `toBeNull` reads after the trigger can be read directly: every refused write has already finished, because each read is itself a later authenticated request.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/conformance/act-007-principal-activity.test.ts`

Expected: both tests FAIL. `expect.poll` times out with `expected null to be '2026-10-01T12:00:00.000Z'`, because nothing records activity yet.

- [ ] **Step 4: Write the tracker service**

Read `node_modules/effect/AGENTS.md` first if you have not already. Create `src/application/principal-activity.ts`:

```ts
import {Context, Effect, Layer} from "effect";

import {principalActivityResolutionMilliseconds} from "../core/principal-activity.js";
import type {PrincipalActivityRecorder} from "../core/ports.js";

/** One credential whose use is recorded for administrators. */
export interface PrincipalActivitySubject {
  readonly id: string;
  readonly kind: "api_key" | "member";
}

export interface PrincipalActivityDependencies {
  readonly clock: {readonly now: () => Date};
  /** Distinct subjects remembered by the in-process throttle. */
  readonly maxSubjects?: number;
  readonly recorder: PrincipalActivityRecorder;
}

export interface PrincipalActivityOperations {
  /** Persist every due subject. Failures are logged, never raised. */
  readonly flush: () => Effect.Effect<void>;
  /** Remember one authenticated use. Performs no I/O. */
  readonly note: (subject: PrincipalActivitySubject) => Effect.Effect<void>;
}

/** Throttled last-active and last-used recording shared by every protocol adapter. */
export class PrincipalActivityService extends Context.Service<
  PrincipalActivityService,
  PrincipalActivityOperations
>()("artifact-server/application/PrincipalActivityService") {
  static readonly layer = (
    operations: PrincipalActivityOperations,
  ): Layer.Layer<PrincipalActivityService> =>
    Layer.succeed(PrincipalActivityService, operations);
}

interface PendingTouch {
  readonly at: string;
  readonly subject: PrincipalActivitySubject;
}

export function makePrincipalActivity(
  dependencies: PrincipalActivityDependencies,
): PrincipalActivityOperations {
  const maxSubjects = dependencies.maxSubjects ?? 10_000;
  // Insertion order doubles as recency, so the oldest entry is dropped first.
  const lastNoted = new Map<string, number>();
  const pending = new Map<string, PendingTouch>();
  const keyOf = (subject: PrincipalActivitySubject) => `${subject.kind}:${subject.id}`;

  const note = (subject: PrincipalActivitySubject) => Effect.sync(() => {
    const now = dependencies.clock.now();
    const key = keyOf(subject);
    const previous = lastNoted.get(key);
    if (
      previous !== undefined &&
      now.getTime() - previous < principalActivityResolutionMilliseconds
    ) {
      return;
    }
    lastNoted.delete(key);
    lastNoted.set(key, now.getTime());
    if (lastNoted.size > maxSubjects) {
      const oldest = lastNoted.keys().next();
      if (!oldest.done) lastNoted.delete(oldest.value);
    }
    pending.set(key, {at: now.toISOString(), subject});
  });

  const write = (key: string, touch: PendingTouch) => Effect.tryPromise({
    catch: (cause) => cause,
    try: () => touch.subject.kind === "member"
      ? dependencies.recorder.touch(touch.subject.id, touch.at)
      : dependencies.recorder.touchApiKey(touch.subject.id, touch.at),
  }).pipe(
    Effect.catch((cause) => {
      // Forget the throttle entry so the next use retries the write.
      lastNoted.delete(key);
      return Effect.logWarning("principal.activity.touch_failed").pipe(
        Effect.annotateLogs({
          reason: cause instanceof Error ? cause.message : "unknown",
          subject_kind: touch.subject.kind,
        }),
      );
    }),
  );

  const flush = () => Effect.suspend(() => {
    const due = [...pending.entries()];
    pending.clear();
    return Effect.forEach(due, ([key, touch]) => write(key, touch), {
      concurrency: 1,
      discard: true,
    });
  });

  return {flush, note};
}
```

In `src/application/application-runtime.ts`, import `PrincipalActivityService` and add `| PrincipalActivityService` to `ApplicationServices`, in alphabetical position after `InteractiveLoginService`.

- [ ] **Step 5: Note credential use on every authentication path**

In `src/application/installation-access.ts`:

1. Import `type PrincipalActivityOperations` and `type PrincipalActivitySubject` from `./principal-activity.js`.
2. Add to `InstallationAccessDependencies`:

```ts
  /** Records successful credential use; absent, nothing is recorded. */
  readonly principalActivity?: Pick<PrincipalActivityOperations, "note">;
```

3. Inside `makeInstallationAccessService`, after the caches:

```ts
  const noteActivity = (subject: PrincipalActivitySubject) =>
    dependencies.principalActivity === undefined
      ? Effect.void
      : dependencies.principalActivity.note(subject);
  const noteKeyUse = (keyId: string, principal: Principal) =>
    Effect.andThen(
      noteActivity({id: keyId, kind: "api_key"}),
      principal.kind === principalKinds.human
        ? noteActivity({id: principal.id, kind: "member"})
        : Effect.void,
    );
```

4. `authenticateSession`:
   - Replace `if (cached !== undefined) return cached;` with:

```ts
    if (cached !== undefined) {
      yield* noteActivity({id: cached.principal.id, kind: "member"});
      return cached;
    }
```

   - Before the final `return authenticated;`, add `yield* noteActivity({id: session.member.id, kind: "member"});`.

5. `authenticateManagedApiKey`:
   - Replace `if (cached !== undefined) return cached;` with:

```ts
    if (cached !== undefined) {
      yield* noteKeyUse(parsed[1], cached);
      return cached;
    }
```

   - Before the final `return principal;`, add `yield* noteKeyUse(key.id, principal);`.

6. `authenticateExternalSubject`:

```ts
    if (member === null) return null;
    yield* noteActivity({id: member.id, kind: "member"});
    return humanPrincipal(member);
```

7. `authenticateExternalIdentity`:

```ts
    const member = yield* resolveExternalMember(identity);
    yield* noteActivity({id: member.id, kind: "member"});
    return humanPrincipal(member);
```

Only successful authentications reach these lines. A rejected or revoked credential fails before `note`.

- [ ] **Step 6: Build the tracker in the application layer**

In `src/local/create-local-application-layer.ts`:

1. Import `makePrincipalActivity` and `PrincipalActivityService` from `../application/principal-activity.js`.
2. Add `| PrincipalActivityService` to `createApplicationLayer`'s return type union.
3. Directly after `const identityRepository = adapters.identityRepository;`:

```ts
  const principalActivity = makePrincipalActivity({
    clock: adapters.clock,
    recorder: identityRepository,
  });
```

4. In the `InstallationAccessService.layer({ … })` argument, add `principalActivity,` (alphabetically after `localLoginAttemptLifetimeMilliseconds`).
5. Add `PrincipalActivityService.layer(principalActivity),` to the final `Layer.mergeAll(…)`.

All three runtimes compose through `createApplicationLayer`: `src/local/create-local-runtime.ts`, `src/external-storage/create-external-storage-runtime.ts` and `deploy/cloudflare/src/worker.ts`. So no composition root changes.

- [ ] **Step 7: Flush after `/api/*` and `/mcp` responses**

In `src/http/create-http-app.ts`:

1. Import `PrincipalActivityService` from `../application/principal-activity.js`.
2. Make sure `runApplicationEffect` is imported from `../application/application-runtime.js`.
3. Add near `runHttpApplicationEffect`:

```ts
/**
 * Persist due last-active and last-used facts without holding the response.
 * Workers keep the flush alive with `waitUntil`; Node adapters have no
 * execution context, and the detached promise completes on its own.
 */
function recordPrincipalActivityAfterResponse(
  context: Context<HttpEnvironment>,
  dependencies: Pick<HttpAppDependencies, "applicationRuntime">,
): void {
  const flushed = runApplicationEffect(
    dependencies.applicationRuntime,
    PrincipalActivityService.use((activity) => activity.flush()),
  ).catch(() => {
    // The flush logs each failed write itself. A runtime disposed during
    // shutdown has nothing left to record.
  });
  let executionContext: {waitUntil(promise: Promise<unknown>): void} | null = null;
  try {
    executionContext = context.executionCtx;
  } catch {
    // Hono throws when the adapter supplied no execution context.
  }
  executionContext?.waitUntil(flushed);
}
```

4. In the `app.use("/api/*", …)` middleware, change the bearer branch's `return next();` (the one after `context.set("sessionToken", null);`) to:

```ts
      await next();
      recordPrincipalActivityAfterResponse(context, dependencies);
      return;
```

5. Change the session branch's final `return next();` to:

```ts
    await next();
    recordPrincipalActivityAfterResponse(context, dependencies);
```

6. Leave the staged-upload early `return next();` unchanged. It carries no credential.
7. Replace the MCP route:

```ts
  app.all("/mcp", boundedMcpBody, async (context) => {
    const response = await mcp.fetch(requestWithRequestId(context));
    recordPrincipalActivityAfterResponse(context, dependencies);
    return response;
  });
```

- [ ] **Step 8: Run the conformance test and the affected suites**

```bash
pnpm exec vitest run tests/conformance/act-007-principal-activity.test.ts
pnpm exec vitest run tests/conformance/installation-identity.test.ts tests/conformance/auth-009-api-key-rotation.test.ts tests/conformance/auth-016-cache-policy.test.ts
pnpm typecheck && pnpm lint
```

Expected:

- `ACT-007-B` and `ACT-007-F` PASS.
- The identity, rotation and cache-policy suites stay green. The cached paths now also note use, and noting performs no I/O.
- `typecheck` and `lint` exit 0.

- [ ] **Step 9: Record the after baseline and compare**

```bash
pnpm perf:baseline
node -e 'const b=require(process.argv[1]),a=require("./project/evidence/local-performance-baseline.json");console.log(JSON.stringify({before:b.summary??b,after:a.summary??a},null,2))' "${TMPDIR:-/tmp}/act-007-perf-before.json"
```

Expected: content-read latency percentiles are within run-to-run noise of the before report on the same machine. Do not tighten any gate from this one run.

If p95 read latency regresses by more than 10%, stop and investigate before committing. The likely cause is a missed `return` that makes the flush awaited. Record both report paths in the commit body.

- [ ] **Step 10: Commit**

```bash
git add src/application/principal-activity.ts src/application/application-runtime.ts \
  src/application/installation-access.ts src/local/create-local-application-layer.ts \
  src/http/create-http-app.ts tests/conformance/act-007-principal-activity.test.ts \
  project/evidence/local-performance-baseline.json
git commit -m "Record member and key activity after each authenticated response

Before and after pnpm perf:baseline runs on the same machine show no
read-latency regression; the before report stayed outside the repository.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3.4: Admin API fields for members, API keys and public links

**Files:**
- Modify: `src/core/installation-identity.ts` (add `apiKeyStatuses`, `ApiKeyStatus`, `AdministeredApiKey`, `apiKeyStatus`)
- Modify: `src/application/installation-access.ts` (`listApiKeys` returns `AdministeredApiKey[]`)
- Modify: `src/application/public-link-administration.ts` (`PublicLinkInventoryItem` gains `madePublicAt` and `madePublicByName`)
- Modify: `src/storage/public-link-inventory-row.ts` (row schema and projection)
- Modify: `src/storage/sqlite-artifact-repository.ts`, `src/storage/postgres-artifact-repository.ts`, `deploy/cloudflare/src/d1-artifact-repository.ts` (`listPublicLinks` selects)
- Modify: `src/http/create-http-app.ts` (member, key and public-link presenters)
- Modify: `apps/web/src/api/client.ts` (additive zod schemas)
- Modify: `tests/conformance/installation-identity.test.ts` (automatic and owner assertions in the AUTH-029 test)
- Test: `tests/conformance/adm-administration-facts.test.ts` (new)

**Interfaces:**
- Consumes: `ListedMember` and `ListedApiKey` (Tasks 3.1 and 3.2); Slice 2's `public_link_enable`, `key_revoke` and `member_deactivate` actions with `actor_name`.
- Produces the additive wire fields:

| Endpoint | New fields |
|---|---|
| `GET /api/v1/members` (each member) | `admittedAt: string`, `admittedBy: {name: string} \| null`, `admittedHow: "manual" \| "automatic" \| "owner" \| null`, `lastActiveAt: string \| null` |
| `GET /api/v1/api-keys` (each key) | `lastUsedAt: string \| null`, `ownerName: string \| null`, `status: "active" \| "revoked" \| "expired"`, `revokedBy: {name: string} \| null` (`revokedAt` already exists) |
| `GET /api/v1/administration/public-links` (each item) | `madePublicAt: string \| null`, `madePublicBy: {name: string} \| null` |

Web client types:

- `AdministeredMember` and `AdministeredApiKey` are returned by `api.members()` and `api.apiKeys()`.
- `PublicLinkItem` gains `madePublicAt` and `madePublicBy`.
- Mutation responses (admit, deactivate, issue, rotate, revoke) keep their existing schemas.

- [ ] **Step 1: Write the failing HTTP conformance test**

Create `tests/conformance/adm-administration-facts.test.ts`:

```ts
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {signInAdministrator} from "../support/agent-dispatch.js";
import {publishNew} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

const nameSchema = z.object({name: z.string()}).strict().nullable();
const memberSchema = z.object({
  admittedAt: z.iso.datetime(),
  admittedBy: nameSchema,
  admittedHow: z.enum(["manual", "automatic", "owner"]).nullable(),
  createdAt: z.iso.datetime(),
  email: z.string(),
  id: z.string(),
  lastActiveAt: z.iso.datetime().nullable(),
}).loose();
const apiKeySchema = z.object({
  expiresAt: z.iso.datetime(),
  id: z.string(),
  lastUsedAt: z.iso.datetime().nullable(),
  ownerName: z.string().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  revokedBy: nameSchema,
  status: z.enum(["active", "revoked", "expired"]),
}).loose();
const publicLinkSchema = z.object({
  artifact: z.object({id: z.string()}).loose(),
  madePublicAt: z.iso.datetime().nullable(),
  madePublicBy: nameSchema,
}).loose();

function mutationHeaders(server: RunningTestServer, cookies: ApplicationCookies): Headers {
  return new Headers({
    "Content-Type": "application/json",
    Cookie: cookies.header,
    Origin: server.baseUrl,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": cookies.csrf,
  });
}

async function readJson<T>(
  server: RunningTestServer,
  cookies: ApplicationCookies,
  pathname: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(`${server.baseUrl}${pathname}`, {headers: {Cookie: cookies.header}});
  expect(response.status).toBe(200);
  return schema.parse(await response.json());
}

describe("administration facts", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let now: Date;

  beforeEach(async () => {
    now = new Date("2026-10-01T12:00:00.000Z");
    installation = await createTestInstallation();
    server = await startTestServer(installation, {clock: {now: () => now}});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("ADM-003-B: the member list reports admission time, admitter, admission path and last activity", async () => {
    const cookies = await signInAdministrator(server, installation);
    const admitted = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({displayName: "Ada Lovelace", email: "ada@example.test", role: "member"}),
      headers: mutationHeaders(server, cookies),
      method: "POST",
    });
    expect(admitted.status).toBe(201);

    const members = await readJson(server, cookies, "/api/v1/members",
      z.object({members: z.array(memberSchema)}));
    const owner = members.members.find((member) => member.email === "administrator@example.test");
    const ada = members.members.find((member) => member.email === "ada@example.test");
    expect(owner).toMatchObject({admittedBy: null, admittedHow: "owner"});
    expect(ada).toMatchObject({
      admittedAt: "2026-10-01T12:00:00.000Z",
      admittedBy: {name: "Local administrator"},
      admittedHow: "manual",
      lastActiveAt: null,
    });
    expect(ada?.admittedAt).toBe(ada?.createdAt);
  });

  test("ADM-004-B: the key list reports owner, last use, derived status and who revoked it", async () => {
    const cookies = await signInAdministrator(server, installation);
    const issue = async (name: string, expiresAt: string) => {
      const response = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
        body: JSON.stringify({capabilities: ["artifact:read"], expiresAt, name}),
        headers: mutationHeaders(server, cookies),
        method: "POST",
      });
      expect(response.status).toBe(201);
      return z.object({apiKey: z.object({id: z.string()}).loose(), token: z.string()})
        .parse(await response.json());
    };
    const active = await issue("Release bot", "2099-01-01T00:00:00.000Z");
    const shortLived = await issue("Nightly import", "2026-10-01T13:00:00.000Z");
    const revoked = await issue("Retired bot", "2099-01-01T00:00:00.000Z");
    const revokeResponse = await fetch(
      `${server.baseUrl}/api/v1/api-keys/${encodeURIComponent(revoked.apiKey.id)}/revoke`,
      {headers: mutationHeaders(server, cookies), method: "POST"},
    );
    expect(revokeResponse.status).toBe(200);

    now = new Date("2026-10-01T14:00:00.000Z");
    const keys = (await readJson(server, cookies, "/api/v1/api-keys",
      z.object({apiKeys: z.array(apiKeySchema)}))).apiKeys;
    const byId = new Map(keys.map((key) => [key.id, key]));
    expect(byId.get(active.apiKey.id)).toMatchObject({
      ownerName: null, revokedBy: null, status: "active",
    });
    expect(byId.get(shortLived.apiKey.id)).toMatchObject({status: "expired"});
    expect(byId.get(revoked.apiKey.id)).toMatchObject({
      revokedAt: "2026-10-01T12:00:00.000Z",
      revokedBy: {name: "Local administrator"},
      status: "revoked",
    });
  });

  test("ADM-005-B: the public-link inventory reports when and by whom each link was made public", async () => {
    const cookies = await signInAdministrator(server, installation);
    const published = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: "made public at publish",
      idempotencyKey: "adm-005-made-public",
      name: "Made public at publish",
    });

    const page = await readJson(server, cookies, "/api/v1/administration/public-links",
      z.object({publicLinks: z.array(publicLinkSchema)}));
    expect(page.publicLinks).toEqual([
      expect.objectContaining({
        artifact: expect.objectContaining({id: published.body.artifact.id}),
        madePublicAt: "2026-10-01T12:00:00.000Z",
        madePublicBy: {name: "Local"},
      }),
    ]);
  });
});
```

Three values in this test come from existing code:

- `"administrator@example.test"` is the harness default bootstrap email.
- `"Local administrator"` is the display name `loginAsLocalOwner` gives the owner.
- `"Local"` is the display name of the installation API token principal that `publishNew` uses.

Spec §3 says a publish that sets public-link access writes `public_link_enable`. If Slice 2 did not add that write, implement it in this task's Step 4.

- [ ] **Step 2: Extend AUTH-029 with the automatic and owner admission paths**

In `tests/conformance/installation-identity.test.ts`, inside the `AUTH-029-B AUTH-029-F` test, insert directly after `expect(await sessionRole(colleague)).toBe("member");`:

```ts
    const administrator = applicationCookies(first.headers.getSetCookie());
    const listed = await fetch(`${server.baseUrl}/api/v1/members`, {
      headers: {Cookie: administrator.header},
    });
    expect(listed.status).toBe(200);
    expect(z.object({
      members: z.array(z.object({
        admittedBy: z.object({name: z.string()}).nullable(),
        admittedHow: z.enum(["manual", "automatic", "owner"]).nullable(),
        email: z.string(),
      }).loose()),
    }).parse(await listed.json()).members).toEqual(expect.arrayContaining([
      expect.objectContaining({admittedBy: null, admittedHow: "owner", email: "ramos@plannotator.ai"}),
      expect.objectContaining({
        admittedBy: null,
        admittedHow: "automatic",
        email: "priya.natarajan@plannotator.ai",
      }),
    ]));
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/conformance/adm-administration-facts.test.ts tests/conformance/installation-identity.test.ts`

Expected: the three ADM tests and AUTH-029 FAIL with zod errors such as `admittedAt: Invalid input: expected string, received undefined`.

- [ ] **Step 4: Status helper, service types and public-link query fields**

In `src/core/installation-identity.ts`, add after `ListedApiKey`:

```ts
/** Lifecycle shown for one managed API key. */
export const apiKeyStatuses = {
  active: "active",
  expired: "expired",
  revoked: "revoked",
} as const;

export type ApiKeyStatus = (typeof apiKeyStatuses)[keyof typeof apiKeyStatuses];

/** Administrator-facing key record with its status at one instant. */
export interface AdministeredApiKey extends ListedApiKey {
  readonly status: ApiKeyStatus;
}

/** Revocation wins over expiry; a key expires at its exact expiry instant. */
export function apiKeyStatus(key: ManagedApiKey, now: Date): ApiKeyStatus {
  if (key.revokedAt !== null) return apiKeyStatuses.revoked;
  return Date.parse(key.expiresAt) <= now.getTime()
    ? apiKeyStatuses.expired
    : apiKeyStatuses.active;
}
```

In `src/application/installation-access.ts`:

1. Import `apiKeyStatus` and `type AdministeredApiKey`.
2. Change `InstallationAccessOperations.listApiKeys` to return `Effect.Effect<readonly AdministeredApiKey[], AuthorizationDenied | IdentityRepositoryFailure>`.
3. Change the implementation's last line to:

```ts
    const keys = yield* dependencies.repository.listApiKeys(dependencies.installationId);
    const now = dependencies.clock.now();
    return keys.map((key) => ({...key, status: apiKeyStatus(key, now)}));
```

In `src/application/public-link-administration.ts`, extend `PublicLinkInventoryItem`:

```ts
export interface PublicLinkInventoryItem {
  readonly artifact: ArtifactRecord;
  readonly currentVersion: VersionRecord;
  /** Newest recorded change to public-link access; null when never recorded. */
  readonly madePublicAt: string | null;
  readonly madePublicByName: string | null;
  readonly project: ProjectRecord;
}
```

In `src/storage/public-link-inventory-row.ts`:

1. Add `madePublicAt: z.string().nullable(),` and `madePublicByName: z.string().nullable(),` to `publicLinkInventoryRowSchema`.
2. In `publicLinkPageFromRows`, add `madePublicAt: row.madePublicAt, madePublicByName: row.madePublicByName,` to each returned item.

Add the same two correlated columns to each `listPublicLinks` SELECT list, directly after `version.created_at AS versionCreatedAt`.

SQLite (`src/storage/sqlite-artifact-repository.ts`):

```sql
            version.created_at AS versionCreatedAt,
            (
              SELECT entry.created_at FROM actions AS entry
              WHERE entry.project_id = artifact.project_id
                AND entry.artifact_id = artifact.id
                AND entry.action = 'public_link_enable'
              ORDER BY entry.created_at DESC, entry.id DESC
              LIMIT 1
            ) AS madePublicAt,
            (
              SELECT entry.actor_name FROM actions AS entry
              WHERE entry.project_id = artifact.project_id
                AND entry.artifact_id = artifact.id
                AND entry.action = 'public_link_enable'
              ORDER BY entry.created_at DESC, entry.id DESC
              LIMIT 1
            ) AS madePublicByName
```

D1 (`deploy/cloudflare/src/d1-artifact-repository.ts`) uses the identical SQL text.

Postgres (`src/storage/postgres-artifact-repository.ts`) adds the installation predicate and quoted aliases:

```sql
          version.created_at AS "versionCreatedAt",
          (
            SELECT entry.created_at FROM actions AS entry
            WHERE entry.installation_id = artifact.installation_id
              AND entry.artifact_id = artifact.id
              AND entry.action = 'public_link_enable'
            ORDER BY entry.created_at DESC, entry.id DESC
            LIMIT 1
          ) AS "madePublicAt",
          (
            SELECT entry.actor_name FROM actions AS entry
            WHERE entry.installation_id = artifact.installation_id
              AND entry.artifact_id = artifact.id
              AND entry.action = 'public_link_enable'
            ORDER BY entry.created_at DESC, entry.id DESC
            LIMIT 1
          ) AS "madePublicByName"
```

The existing per-artifact action indexes serve these lookups:

- SQLite and D1: `actions_artifact_created (project_id, artifact_id, created_at DESC, id DESC)`.
- Postgres: `(installation_id, artifact_id, created_at)`.

Each lookup reads only that artifact's history.

- [ ] **Step 5: HTTP presenters**

In `src/http/create-http-app.ts`, import `type AdministeredApiKey` and `type ListedMember`. Add next to `publicLinkInventoryPageResponse`:

```ts
function administeredMemberResponse(member: ListedMember) {
  const {admittedByName, ...record} = member;
  return {
    ...record,
    admittedAt: member.createdAt,
    admittedBy: admittedByName === null ? null : {name: admittedByName},
  };
}

function administeredApiKeyResponse(key: AdministeredApiKey) {
  const {revokedByName, ...record} = key;
  return {
    ...record,
    revokedBy: revokedByName === null ? null : {name: revokedByName},
  };
}
```

Change the two list routes' responses:

1. `GET /api/v1/members` returns `context.json({members: members.map(administeredMemberResponse)});`.
2. `GET /api/v1/api-keys` returns `context.json({apiKeys: apiKeys.map(administeredApiKeyResponse)});`.

In `publicLinkInventoryPageResponse`, add to each mapped item:

```ts
      madePublicAt: item.madePublicAt,
      madePublicBy: item.madePublicByName === null ? null : {name: item.madePublicByName},
```

- [ ] **Step 6: Web client schemas**

In `apps/web/src/api/client.ts`, after `apiKeySchema`:

```ts
const nameReferenceSchema = z.object({ name: z.string() }).nullable();

const administeredMemberSchema = memberSchema.extend({
  admittedAt: z.string(),
  admittedBy: nameReferenceSchema,
  admittedHow: z.enum(["manual", "automatic", "owner"]).nullable(),
  lastActiveAt: z.string().nullable(),
});

const administeredApiKeySchema = apiKeySchema.extend({
  lastUsedAt: z.string().nullable(),
  ownerName: z.string().nullable(),
  revokedBy: nameReferenceSchema,
  status: z.enum(["active", "revoked", "expired"]),
});

export type AdministeredMember = z.infer<typeof administeredMemberSchema>;
export type AdministeredApiKey = z.infer<typeof administeredApiKeySchema>;
```

Then:

1. `members` uses `z.object({ members: z.array(administeredMemberSchema) })`.
2. `apiKeys` uses `z.object({ apiKeys: z.array(administeredApiKeySchema) })`.
3. Extend `publicLinkItemSchema` with `madePublicAt: z.string().nullable(), madePublicBy: z.object({ name: z.string() }).nullable(),`.
4. Leave the admit, deactivate, issue, rotate and revoke schemas unchanged.

The extended types are assignable to the existing `InstallationMember` and `ManagedApiKey` state in `members-screen.tsx` and `api-keys-screen.tsx`, so those screens compile without changes. Slice 7 renders the new fields.

- [ ] **Step 7: Run the tests and the web checks**

```bash
pnpm exec vitest run tests/conformance/adm-administration-facts.test.ts tests/conformance/installation-identity.test.ts
pnpm exec vitest run tests/conformance/cmt-011-comment-action-ledger.test.ts tests/conformance/auth-007-visibility-change.test.ts
pnpm typecheck && pnpm --filter @artifact-server/web test
pnpm check:cloudflare
pnpm test:external-storage-runtime
```

Expected:

- ADM-003-B, ADM-004-B, ADM-005-B and AUTH-029 PASS.
- The per-artifact action ledger test (`cmt-011`, which parses with `.strict()`) still passes, because the per-artifact listing is unchanged.
- `auth-007` passes.
- `typecheck` and the web tests exit 0. D1 and Postgres stay green with the widened public-link select.

- [ ] **Step 8: Commit**

```bash
git add src/core/installation-identity.ts src/application/installation-access.ts \
  src/application/public-link-administration.ts src/storage/public-link-inventory-row.ts \
  src/storage/sqlite-artifact-repository.ts src/storage/postgres-artifact-repository.ts \
  deploy/cloudflare/src/d1-artifact-repository.ts src/http/create-http-app.ts apps/web/src/api/client.ts \
  tests/conformance/adm-administration-facts.test.ts tests/conformance/installation-identity.test.ts
git commit -m "Report admission, activity, key status and made-public facts to administrators

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3.5: Ledger and slice gate

**Files:**
- Modify: `project/spec/conformance.yml` (new ACT-007 entry; ADM-003, ADM-004 and ADM-005 descriptions and proof gaps)
- Modify: `project/evidence/local-foundation.json` (regenerated by `pnpm test`)

**Interfaces:**
- Consumes: the test titles from Tasks 3.3 and 3.4.
- Produces: the ledger entry ACT-007 with status `behavior_verified`, citing local evidence.

- [ ] **Step 1: Add the ACT-007 requirement**

Insert after the `ADM-007` entry in `project/spec/conformance.yml`:

```yaml
  - id: ACT-007
    kind: behavior
    behavior: Administrators see when each member was last active and when each API key was last used, advanced at most once per principal every five minutes, without failing or holding the request that used the credential.
    owner: authorization
    source: {file: single-application-administration-spec.md, anchor: members}
    acceptance:
      behavior: {id: ACT-007-B, description: "Use a browser session, a service key, and a member-bound key across two processes and observe last active and last used advance at most once per five minutes per principal."}
      failure: {id: ACT-007-F, description: "A refused tracking write, the installation token, a malformed key, or a revoked key never fails a request or records activity, and a refused write is retried on the next use."}
    deployments: *all
    status: behavior_verified
    proof_gap: Local SQLite HTTP evidence proves session, key, cross-process, refusal and retry behavior; Postgres and D1 repository tests prove the conditional write; no team deployment is recorded.
    depends_on: [AUTH-009, AUTH-027]
    evidence:
      - deployment: local
        tests: [ACT-007-B, ACT-007-F]
        result: pass
        run: project/evidence/local-foundation.json
        recorded_at: "<ISO of local-foundation.json startTime — see Step 3>"
```

- [ ] **Step 2: Extend ADM-003, ADM-004 and ADM-005**

Edit only the `acceptance.behavior.description` and `proof_gap` lines. Keep IDs, status and the browser evidence.

- `ADM-003-B` description becomes: `"As an administrator, list active and inactive members with when, how, and by whom each was admitted and when each was last active, admit a member and administrator by provider email, and deactivate an eligible member while durable attributed records remain."`
- `ADM-004-B` description becomes: `"Issue a minimally scoped expiring member or service key, copy its one-time secret, rotate it and copy the replacement, then revoke the active key and observe its owner, last use, derived active, expired, or revoked status, and who revoked it."`
- `ADM-005-B` description becomes: `"Page through active public links from multiple projects with when and by whom each was made public, open their public and Review destinations, make one and a bounded selection private, and retry a stale failed item without rolling back successful items."`
- Prepend to each of the three `proof_gap` values: `Local SQLite HTTP tests prove the administration facts; the canonical Admin console rendering them is proved in Slice 7. `

Then add a second evidence entry under each of ADM-003, ADM-004 and ADM-005:

```yaml
      - deployment: local
        tests: [ADM-003-B]          # ADM-004-B / ADM-005-B respectively
        result: pass
        run: project/evidence/local-foundation.json
        recorded_at: "<ISO of local-foundation.json startTime — see Step 3>"
```

- [ ] **Step 3: Run the full local suite to produce evidence, then fill the timestamps**

```bash
pnpm test
node -e 'console.log(new Date(require("./project/evidence/local-foundation.json").startTime).toISOString())'
```

Expected:

- `pnpm test` passes and rewrites `project/evidence/local-foundation.json`.
- The `node` command prints one ISO instant. Replace each `"<ISO of local-foundation.json startTime — see Step 3>"` with that exact value, so there are four occurrences (ACT-007, ADM-003, ADM-004, ADM-005).
- Confirm with `git grep -n "see Step 3" project/spec/conformance.yml`, which must print nothing.

- [ ] **Step 4: Run the slice gate**

```bash
pnpm conformance:validate
pnpm conformance:tests
pnpm check
```

Expected:

- `conformance:validate` reports no errors.
- `conformance:tests` prints `Valid conformance test mapping: …` with no "claimed by more than one test" line.
- `pnpm check` exits 0.

If `check` fails, fix the cause; do not relax a rule.

- [ ] **Step 5: Commit**

```bash
git add project/spec/conformance.yml project/evidence/local-foundation.json
git commit -m "Attach evidence for administration facts and principal activity tracking

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Still specified but not proved after this slice:**

- ACT-007 has no team-deployment evidence. Postgres and D1 are repository-level only.
- ADM-003 to ADM-005 browser rendering of the new fields waits for Slice 7.
- MCP-path credential use runs through the same `note`, but no test exercises it. The flush after `/mcp` is covered only by type checking and the shared code path.
## Slice 4 — Activity service and API

Implements spec §2 (requirements ACT-003 and ACT-004). It assumes Slices 2 and 3 have landed:

- `actions` already has the nullable `artifact_id`, `version_id` and `project_id` columns.
- `actions` already has `thread_id`, `reply_id`, `subject_id`, `access_from`, `access_to`, `actor_name`, `actor_kind` and `detail_json`.
- Every new kind is written in its mutation's transaction.
- `dispatch_*` rows carry the dispatch ID in `subject_id`.

### Slice-local refinements of the Shared Interfaces

Read these before Task 4.1. Every later task in this slice uses these exact forms.

1. **`ActivityLog` is Promise-based in `src/core/ports.ts`.** Every core repository port there (`ArtifactRepository`, `ProjectRepository`, `CommentRepository`) returns `Promise`.
   - Effect wrapping happens in the application layer through `ActivityPersistence`, in `src/application/activity.ts`.
   - That wrapping is wired in `src/local/create-local-application-layer.ts` with `Effect.tryPromise`, the same way `publicLinkAdministrationRepository` is wired today.
   - Failures surface as `ArtifactRepositoryFailure` with operation `"listActivity"` or `"summarizeActivity"`.
2. **`ActivityRow` gains `readonly excerpt: string | null`.** It holds the first line of the thread opener for `resolution` rows, or null.
3. **`ActivityService.list` returns `{items: ActivityEntry[], nextCursor: PageCursor | null}`.** The HTTP adapter encodes the cursor with the existing `encodePageCursor`, as every other paged route does.
   - `ActivityService.layer` takes `{directory: ActivityDirectory; persistence: ActivityPersistence}`.
   - `ActivityDirectory` resolves member and key subject names for administrators. It reads them through the identity repository, so artifact SQL never joins identity tables.
4. **Latest-per-thread uses `NOT EXISTS` against a newer create or reply of the same `thread_id`.** This is equivalent to the spec's `ROW_NUMBER() … = 1`. It is chosen because it lets `ORDER BY created_at DESC, id DESC LIMIT n` stop scanning early, and Task 4.8's 100k-action case measures it. It also guarantees the page-boundary rule (Review Focus 1): only the current newest row of a thread can ever match.
5. **Search uses `instr` (SQLite and D1) or `strpos` (Postgres) over lower-cased text, with the query normalized by `normalizeArtifactSearchText`.** This is the existing artifact-search technique (`sqlite-artifact-repository.ts:2085`, `postgres-artifact-repository.ts:1953`). The query is a bound parameter and is never parsed as a pattern, so `%`, `_`, `\` and `'` match literally. That meets the spec's "parameterized, escaped" requirement without a `LIKE` escape clause.
6. **A `project` filter naming an unknown ID, or another installation's ID, matches nothing.** The response is a 200 with an empty page, identical in both cases (PRJ-002-F).
7. **Archived entries:** `artifact.archived` is true when the artifact is deleted (`artifacts.deleted_at`) or its project is archived (`projects.archived_at`).
8. **SQLite and D1 statements carry no installation predicate.** Both stores are one installation per database; the existing `listArtifactActions` statements likewise scope only by project. The Postgres dialect adds `installation_id` to every table reference.

---

### Task 4.1: First activity feed end to end (SQLite)

Build the vertical path for publishes and conversations, newest first, with actor names:

- the shared statement builder;
- `listActivity` in all three repositories;
- `ActivityService`;
- `GET /api/v1/activity`.

Postgres and D1 receive the same builder-driven implementation here so every runtime keeps type-checking. Their behaviour is proven in Tasks 4.5 and 4.6.

**Files:**
- Modify: `src/core/ports.ts` (append activity types after `ListArtifactActions`, around line 229)
- Modify: `src/core/publishing-limits.ts` (append constants)
- Modify: `src/core/errors.ts:369` (add `"listActivity"` and `"summarizeActivity"` to `ArtifactRepositoryFailure.operation`)
- Create: `src/storage/activity-sql.ts`
- Modify: `src/storage/sqlite-artifact-repository.ts` (add `listActivity` beside `listArtifactActions` at line 2187)
- Modify: `src/storage/postgres-artifact-repository.ts` (add `listActivity` beside `listArtifactActions` at line 2044)
- Modify: `deploy/cloudflare/src/d1-artifact-repository.ts` (add `listActivity` beside `listArtifactActions` at line 3189; extend `D1ArtifactRepository` at line 618)
- Create: `src/application/activity-entries.ts`
- Create: `src/application/activity.ts`
- Modify: `src/application/application-runtime.ts` (add `ActivityService` to `ApplicationServices`)
- Modify: `src/local/create-local-application-layer.ts` (adapters type, persistence and directory adapters, layer, return type)
- Modify: `src/http/create-http-app.ts` (query schema near line 371; route after `/api/v1/agent-dispatches` near line 1338)
- Test: `tests/conformance/act-003-activity-feed.test.ts`

**Interfaces:**
- Consumes:
  - `ActivityActionRow`, `ActorSnapshot`, `ActionKind`, `artifactActionKinds` (including `publicLinkEnable` and `publicLinkDisable`) and `installationActionKinds`, all from `src/core/model.ts` (Slice 2).
  - The `actions` columns `actor_name`, `actor_kind`, `thread_id`, `reply_id`, `subject_id`, `access_from`, `access_to` and `detail_json` (Slice 2).
- Produces:
  - `ActivityType`, `ActivitySegment`, `ActivityQuery`, `ActivityThreadState`, `ActivityThreadSnapshot`, `ActivityRow` (with `excerpt`), `ActivityPage` and `ActivityLog { listActivity(query): Promise<ActivityPage> }` in `src/core/ports.ts`.
  - `defaultActivityPageSize = 30`, `maximumActivityPageSize = 100`, `maximumActivitySearchCharacters = 100` and `maximumActivityProjectFilters = 50` in `publishing-limits.ts`.
  - `ActivitySqlDialect`, `ActivityStatement`, `feedKindsByType`, `administrationKinds`, `threadHeadKinds`, `buildListActivityStatement(dialect, query, installationId)`, `buildNewestRepliesStatement(dialect, threadIds, installationId)`, `activitySqlRowSchema`, `snapshotThreadIds(rows, limit)` and `assembleActivityPage(rows, threads, replies, limit)` in `src/storage/activity-sql.ts`.
  - `ActivityEntry`, `ActivityEntryKind`, `WireComment`, `SubjectNames` and `toActivityEntry(row, names)` in `src/application/activity-entries.ts`.
  - `ActivityService`, `ActivityPersistence`, `ActivityDirectory`, `ActivityRequest`, `ActivityResponse` and `ActivityFailure` in `src/application/activity.ts`.
  - `GET /api/v1/activity`.

- [ ] **Step 1: Write the failing conformance test**

Create `tests/conformance/act-003-activity-feed.test.ts`:

```ts
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {ApiClient, MutableClock} from "../support/agent-dispatch.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const wireCommentSchema = z.object({
  author: z.object({
    kind: z.enum(["human", "service"]),
    name: z.string(),
  }).strict(),
  body: z.string(),
  createdAt: z.iso.datetime(),
  id: z.string(),
}).strict();
const entrySchema = z.object({
  access: z.object({
    from: z.enum(["account_required", "public_link"]).nullable(),
    to: z.enum(["account_required", "public_link"]),
  }).strict().optional(),
  actor: z.object({
    kind: z.enum(["human", "service"]).nullable(),
    name: z.string().nullable(),
  }).strict(),
  agent: z.object({
    dispatchState: z.string(),
    name: z.string(),
    threadIds: z.array(z.string()),
  }).strict().optional(),
  artifact: z.object({
    archived: z.boolean(),
    id: z.string(),
    name: z.string(),
  }).strict().nullable(),
  at: z.iso.datetime(),
  excerpt: z.string().optional(),
  id: z.string(),
  kind: z.enum([
    "thread",
    "version",
    "resolution",
    "thread_deleted",
    "agent",
    "access",
    "admin",
  ]),
  project: z.object({id: z.string(), name: z.string()}).strict().nullable(),
  subject: z.object({id: z.string(), name: z.string().nullable()}).strict()
    .optional(),
  thread: z.object({
    anchor: z.unknown(),
    id: z.string(),
    isResolved: z.boolean(),
    opener: wireCommentSchema,
    replies: z.array(wireCommentSchema),
    replyCount: z.number().int().nonnegative(),
    state: z.enum(["needs_you", "with_agent", "resolved"]),
  }).strict().optional(),
  threadId: z.string().optional(),
  verb: z.string(),
  versionNumber: z.number().int().positive().nullable(),
}).strict();
export const activityPageSchema = z.object({
  items: z.array(entrySchema),
  nextCursor: z.string().nullable(),
}).strict();
export type ActivityPageBody = z.infer<typeof activityPageSchema>;

describe("installation activity feed", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let clock: MutableClock;
  let reader: ApiClient;

  beforeEach(async () => {
    installation = await createTestInstallation();
    clock = new MutableClock("2026-10-01T12:00:00.000Z");
    server = await startTestServer(installation, {clock});
    reader = new ApiClient(server, installation.apiToken);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("ACT-003-B: the feed lists publishes and conversations newest first with actor names", async () => {
    expect.hasAssertions();
    const published = await publish("feed-first", "Stage bar walkthrough");
    clock.advance(1_000);
    await reader.openThread(
      published,
      "The stage bar overlaps the header.",
      "feed-first-thread",
    );
    clock.advance(1_000);

    const page = await readFeed(reader, "");
    const visible = page.items.filter((entry) => entry.kind !== "admin");

    expect(visible.map((entry) => [entry.kind, entry.verb, entry.artifact?.name]))
      .toEqual([
        ["thread", "commented", "Stage bar walkthrough"],
        ["version", "published", "Stage bar walkthrough"],
      ]);
    expect(visible[0]?.actor).toEqual({kind: "service", name: "Local"});
    expect(visible[0]?.thread?.opener.body).toBe("The stage bar overlaps the header.");
    expect(visible[0]?.thread?.state).toBe("needs_you");
    expect(visible[1]?.versionNumber).toBe(1);
    expect(visible[1]?.project).toEqual({
      id: published.artifact.projectId,
      name: expect.any(String),
    });
    expect(page.nextCursor).toBeNull();
  });

  async function publish(key: string, name: string): Promise<PublishResponse> {
    return (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: `<p>${name}</p>`,
      idempotencyKey: key,
      name,
    })).body;
  }
});

/** Read one feed page with the given query string ("" or "?…"). */
export async function readFeed(
  client: ApiClient,
  query: string,
): Promise<ActivityPageBody> {
  const response = await client.fetch(`/api/v1/activity${query}`);
  expect(response.status).toBe(200);
  return activityPageSchema.parse(await response.json());
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/conformance/act-003-activity-feed.test.ts`
Expected: FAIL. `expect(response.status).toBe(200)` receives `404`, because the route does not exist.

- [ ] **Step 3: Add the core types and limits**

Append to `src/core/ports.ts`, after `ListArtifactActions`. Add `ActivityActionRow`, `AgentDispatchState`, `CommentReplyRecord` and `CommentThreadRecord` to the existing `./model.js` type import if any are missing.

```ts
/** Feed type filters accepted by the activity read model. */
export type ActivityType = "access" | "admin" | "agents" | "comments" | "versions";

/** Feed segments; "needs_you" and "with_agent" follow the per-thread rule. */
export type ActivitySegment = "all" | "needs_you" | "with_agent";

/** Values used to read one bounded page of the installation activity log. */
export interface ActivityQuery {
  readonly cursor: PageCursor | null;
  /** False excludes member_* and key_* rows. project_* stays visible. */
  readonly includeAdministration: boolean;
  /** Already clamped to 1..maximumActivityPageSize. */
  readonly limit: number;
  /** Empty means every project. Unknown IDs match nothing. */
  readonly projectIds: readonly string[];
  /** Normalized with normalizeArtifactSearchText, or null. */
  readonly search: string | null;
  readonly segment: ActivitySegment;
  /** Empty means every type. */
  readonly types: readonly ActivityType[];
}

/** Thread state per the spec's "Needs you" rule. */
export type ActivityThreadState = "needs_you" | "resolved" | "with_agent";

/** The thread a latest-per-thread comment row stands for. */
export interface ActivityThreadSnapshot {
  readonly anchor: unknown;
  readonly id: string;
  readonly isResolved: boolean;
  readonly opener: CommentThreadRecord;
  /** The newest two replies, oldest first. */
  readonly replies: readonly CommentReplyRecord[];
  readonly replyCount: number;
  readonly state: ActivityThreadState;
}

/** One feed row joined with the records it names. */
export interface ActivityRow {
  readonly action: ActivityActionRow;
  readonly artifact: {
    readonly archived: boolean;
    readonly id: string;
    readonly name: string;
  } | null;
  readonly dispatch: {
    readonly agentDisplayName: string;
    readonly state: AgentDispatchState;
    readonly threadIds: readonly string[];
  } | null;
  /** First line of the thread opener for resolution rows, otherwise null. */
  readonly excerpt: string | null;
  readonly project: {readonly id: string; readonly name: string} | null;
  /** Present only on the newest create or reply row of a live thread. */
  readonly thread: ActivityThreadSnapshot | null;
  readonly versionNumber: number | null;
}

/** One bounded page of activity rows, newest first. */
export interface ActivityPage {
  readonly items: readonly ActivityRow[];
  readonly nextCursor: PageCursor | null;
}

/** Read side of the installation activity log. */
export interface ActivityLog {
  listActivity(query: ActivityQuery): Promise<ActivityPage>;
}
```

Append to `src/core/publishing-limits.ts`:

```ts
/** Activity entries returned when a caller does not ask for a page size. */
export const defaultActivityPageSize = 30;

/** Maximum activity entries returned by one bounded page. */
export const maximumActivityPageSize = 100;

/** Maximum characters accepted in one activity search. */
export const maximumActivitySearchCharacters = 100;

/** Maximum project filters accepted by one activity read. */
export const maximumActivityProjectFilters = 50;
```

In `src/core/errors.ts`, add `"listActivity"` and `"summarizeActivity"` to the `ArtifactRepositoryFailure` `operation: Schema.Literals([...])` list (line 369), keeping alphabetical order.

- [ ] **Step 4: Create the shared statement builder**

Create `src/storage/activity-sql.ts`:

```ts
import {z} from "zod";

import {
  type ActionKind,
  type ActivityActionRow,
  artifactActionKinds,
  type CommentReplyRecord,
  type CommentThreadRecord,
  installationActionKinds,
} from "../core/model.js";
import type {
  ActivityPage,
  ActivityQuery,
  ActivityRow,
  ActivityThreadSnapshot,
  ActivityType,
} from "../core/ports.js";

/** SQL dialects that share the activity statement shape. */
export type ActivitySqlDialect = "postgres" | "sqlite";

/** One positional statement ready for the backend driver. */
export interface ActivityStatement {
  readonly text: string;
  readonly values: readonly (number | string | null)[];
}

/** Comment kinds whose newest row per thread stands for the thread. */
export const threadHeadKinds = [
  artifactActionKinds.commentCreate,
  artifactActionKinds.commentReply,
] as const;

/** Action kinds each feed type shows. Kinds outside every list never reach the feed. */
export const feedKindsByType = {
  access: [
    artifactActionKinds.publicLinkEnable,
    artifactActionKinds.publicLinkDisable,
  ],
  admin: [
    installationActionKinds.memberAdmit,
    installationActionKinds.memberDeactivate,
    installationActionKinds.keyIssue,
    installationActionKinds.keyRotate,
    installationActionKinds.keyRevoke,
    installationActionKinds.projectCreate,
    installationActionKinds.projectArchive,
    installationActionKinds.projectUnarchive,
  ],
  agents: [
    installationActionKinds.dispatchCreate,
    installationActionKinds.dispatchAddressed,
  ],
  comments: [
    artifactActionKinds.commentCreate,
    artifactActionKinds.commentReply,
    artifactActionKinds.commentResolve,
    artifactActionKinds.commentReopen,
    artifactActionKinds.commentDelete,
  ],
  versions: [artifactActionKinds.publish, artifactActionKinds.restore],
} as const satisfies Record<ActivityType, readonly ActionKind[]>;

/** Kinds only administrators may read. */
export const administrationKinds: readonly ActionKind[] = [
  installationActionKinds.memberAdmit,
  installationActionKinds.memberDeactivate,
  installationActionKinds.keyIssue,
  installationActionKinds.keyRotate,
  installationActionKinds.keyRevoke,
];

const allActionKinds = [
  ...Object.values(artifactActionKinds),
  ...Object.values(installationActionKinds),
] as [ActionKind, ...ActionKind[]];

const activeDispatchStates = "('queued', 'claimed', 'delivered')";

/** Positional values bound in textual order. */
class StatementValues {
  readonly values: (number | string | null)[] = [];

  constructor(readonly dialect: ActivitySqlDialect) {}

  bind(value: number | string | null): string {
    this.values.push(value);
    return this.dialect === "postgres" ? `$${this.values.length}` : "?";
  }

  /** A subquery yielding each string in `items`, bound as one JSON value. */
  bindList(items: readonly string[]): string {
    const placeholder = this.bind(JSON.stringify(items));
    return this.dialect === "postgres"
      ? `(SELECT jsonb_array_elements_text(${placeholder}::jsonb))`
      : `(SELECT value FROM json_each(${placeholder}))`;
  }
}

/** Constant kind names only; never caller input. */
function kindLiterals(kinds: readonly ActionKind[]): string {
  return kinds.map((kind) => {
    if (!/^[a-z_]+$/u.test(kind)) throw new Error(`Unsafe action kind: ${kind}`);
    return `'${kind}'`;
  }).join(", ");
}

function scope(dialect: ActivitySqlDialect, alias: string, owner: string): string {
  return dialect === "postgres"
    ? ` AND ${alias}.installation_id = ${owner}.installation_id`
    : "";
}

function visibleKinds(query: ActivityQuery): readonly ActionKind[] {
  const types: readonly ActivityType[] = query.types.length === 0
    ? ["access", "admin", "agents", "comments", "versions"]
    : query.types;
  const kinds = types.flatMap((type) => feedKindsByType[type]);
  return query.includeAdministration
    ? kinds
    : kinds.filter((kind) => !administrationKinds.includes(kind));
}

/** Build the one-page feed statement for a dialect. */
export function buildListActivityStatement(
  dialect: ActivitySqlDialect,
  query: ActivityQuery,
  installationId: string,
): ActivityStatement {
  const values = new StatementValues(dialect);
  const heads = kindLiterals(threadHeadKinds);
  const where: string[] = [];
  if (dialect === "postgres") {
    where.push(`x.installation_id = ${values.bind(installationId)}`);
  }
  where.push(`x.action IN (${kindLiterals(visibleKinds(query))})`);
  where.push(`(x.action NOT IN (${heads}) OR (t.id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM actions newer
      WHERE newer.thread_id = x.thread_id${scope(dialect, "newer", "x")}
        AND newer.action IN (${heads})
        AND (newer.created_at > x.created_at
          OR (newer.created_at = x.created_at AND newer.id > x.id)))))`);
  if (query.projectIds.length > 0) {
    where.push(`x.project_id IN ${values.bindList(query.projectIds)}`);
  }
  if (query.cursor !== null) {
    const createdAt = values.bind(query.cursor.createdAt);
    const sameCreatedAt = values.bind(query.cursor.createdAt);
    const id = values.bind(query.cursor.id);
    where.push(`(x.created_at < ${createdAt}
      OR (x.created_at = ${sameCreatedAt} AND x.id < ${id}))`);
  }
  const limit = values.bind(query.limit + 1);
  const text = `SELECT
      x.id AS "id",
      x.action AS "action",
      x.created_at AS "createdAt",
      x.principal_id AS "principalId",
      x.actor_name AS "actorName",
      x.actor_kind AS "actorKind",
      x.project_id AS "projectId",
      x.artifact_id AS "artifactId",
      x.version_id AS "versionId",
      x.thread_id AS "threadId",
      x.reply_id AS "replyId",
      x.subject_id AS "subjectId",
      x.access_from AS "accessFrom",
      x.access_to AS "accessTo",
      x.detail_json AS "detailJson",
      p.name AS "projectName",
      a.name AS "artifactName",
      CASE WHEN a.id IS NULL THEN NULL
        WHEN a.deleted_at IS NOT NULL OR p.archived_at IS NOT NULL THEN 1
        ELSE 0 END AS "artifactArchived",
      v.number AS "versionNumber",
      d.agent_display_name AS "dispatchAgentName",
      d.state AS "dispatchState",
      d.thread_ids_json AS "dispatchThreadIdsJson",
      t.id AS "liveThreadId",
      t.state AS "threadState",
      CASE WHEN held.id IS NULL THEN 0 ELSE 1 END AS "threadHeld",
      substr(t.body, 1, 280) AS "threadExcerpt"
    FROM actions x
    LEFT JOIN projects p ON p.id = x.project_id${scope(dialect, "p", "x")}
    LEFT JOIN artifacts a ON a.id = x.artifact_id${scope(dialect, "a", "x")}
    LEFT JOIN versions v ON v.id = x.version_id${scope(dialect, "v", "x")}
    LEFT JOIN comment_threads t ON t.id = x.thread_id${scope(dialect, "t", "x")}
    LEFT JOIN agent_dispatches held ON held.id = t.dispatch_id${scope(dialect, "held", "t")}
      AND held.state IN ${activeDispatchStates}
    LEFT JOIN agent_dispatches d ON d.id = x.subject_id${scope(dialect, "d", "x")}
      AND x.action IN (${kindLiterals(feedKindsByType.agents)})
    WHERE ${where.join("\n      AND ")}
    ORDER BY x.created_at DESC, x.id DESC
    LIMIT ${limit}`;
  return {text, values: values.values};
}

/** The newest two replies of each thread, oldest first within a thread. */
export function buildNewestRepliesStatement(
  dialect: ActivitySqlDialect,
  threadIds: readonly string[],
  installationId: string,
): ActivityStatement {
  const values = new StatementValues(dialect);
  const installation = dialect === "postgres"
    ? `r.installation_id = ${values.bind(installationId)} AND `
    : "";
  const ids = values.bindList(threadIds);
  return {
    text: `SELECT "id", "threadId", "projectId", "body", "authorPrincipalId",
        "authorPrincipalKind", "authorDisplayName",
        "authorAuthorizedByPrincipalId", "createdAt", "updatedAt"
      FROM (
        SELECT r.id AS "id", r.thread_id AS "threadId",
          r.project_id AS "projectId", r.body AS "body",
          r.author_principal_id AS "authorPrincipalId",
          r.author_principal_kind AS "authorPrincipalKind",
          r.author_display_name AS "authorDisplayName",
          r.author_authorized_by_principal_id AS "authorAuthorizedByPrincipalId",
          r.created_at AS "createdAt", r.updated_at AS "updatedAt",
          ROW_NUMBER() OVER (
            PARTITION BY r.thread_id ORDER BY r.created_at DESC, r.id DESC
          ) AS "newestRank"
        FROM comment_replies r
        WHERE ${installation}r.thread_id IN ${ids}
      ) ranked
      WHERE "newestRank" <= 2
      ORDER BY "threadId", "createdAt", "id"`,
    values: values.values,
  };
}

const accessSettingSchema = z.enum(["account_required", "public_link"]);
const principalKindSchema = z.enum(["human", "service"]);
const dispatchStateSchema = z.enum([
  "addressed",
  "canceled",
  "claimed",
  "delivered",
  "failed",
  "queued",
]);

/** One flat feed row exactly as every dialect's statement returns it. */
export const activitySqlRowSchema = z.object({
  accessFrom: accessSettingSchema.nullable(),
  accessTo: accessSettingSchema.nullable(),
  action: z.enum(allActionKinds),
  actorKind: principalKindSchema.nullable(),
  actorName: z.string().nullable(),
  artifactArchived: z.number().int().nullable(),
  artifactId: z.string().nullable(),
  artifactName: z.string().nullable(),
  createdAt: z.string(),
  detailJson: z.string().nullable(),
  dispatchAgentName: z.string().nullable(),
  dispatchState: dispatchStateSchema.nullable(),
  dispatchThreadIdsJson: z.string().nullable(),
  id: z.string(),
  liveThreadId: z.string().nullable(),
  principalId: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  replyId: z.string().nullable(),
  subjectId: z.string().nullable(),
  threadExcerpt: z.string().nullable(),
  threadHeld: z.number().int(),
  threadId: z.string().nullable(),
  threadState: z.enum(["open", "resolved"]).nullable(),
  versionId: z.string().nullable(),
  versionNumber: z.number().int().nullable(),
});

export type ActivitySqlRow = z.infer<typeof activitySqlRowSchema>;

const isThreadHead = (action: ActionKind): boolean =>
  (threadHeadKinds as readonly ActionKind[]).includes(action);

/** Live thread IDs on the returned page whose snapshot must be read. */
export function snapshotThreadIds(
  rows: readonly ActivitySqlRow[],
  limit: number,
): readonly string[] {
  return [...new Set(rows.slice(0, limit).flatMap((row) =>
    isThreadHead(row.action) && row.liveThreadId !== null
      ? [row.liveThreadId]
      : []
  ))];
}

const threadIdListSchema = z.array(z.string());
const detailSchema = z.record(z.string(), z.unknown());

function actionFromRow(row: ActivitySqlRow): ActivityActionRow {
  return {
    accessFrom: row.accessFrom,
    accessTo: row.accessTo,
    action: row.action,
    actor: row.actorName === null || row.actorKind === null
      ? null
      : {displayName: row.actorName, kind: row.actorKind},
    artifactId: row.artifactId,
    createdAt: row.createdAt,
    detail: row.detailJson === null
      ? null
      : detailSchema.parse(JSON.parse(row.detailJson)),
    id: row.id,
    principalId: row.principalId,
    projectId: row.projectId,
    replyId: row.replyId,
    subjectId: row.subjectId,
    threadId: row.threadId,
    versionId: row.versionId,
  };
}

function snapshotFor(
  row: ActivitySqlRow,
  threads: ReadonlyMap<string, CommentThreadRecord>,
  replies: ReadonlyMap<string, readonly CommentReplyRecord[]>,
): ActivityThreadSnapshot | null {
  if (!isThreadHead(row.action) || row.liveThreadId === null) return null;
  const opener = threads.get(row.liveThreadId);
  if (opener === undefined) return null;
  const isResolved = opener.state === "resolved";
  return {
    anchor: opener.anchor,
    id: opener.id,
    isResolved,
    opener,
    replies: replies.get(opener.id) ?? [],
    replyCount: opener.replyCount,
    state: isResolved ? "resolved" : row.threadHeld === 1 ? "with_agent" : "needs_you",
  };
}

/** Turn statement rows plus thread snapshots into one bounded page. */
export function assembleActivityPage(
  rows: readonly ActivitySqlRow[],
  threads: readonly CommentThreadRecord[],
  replies: readonly CommentReplyRecord[],
  limit: number,
): ActivityPage {
  const page = rows.slice(0, limit);
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const repliesByThread = new Map<string, CommentReplyRecord[]>();
  for (const reply of replies) {
    const list = repliesByThread.get(reply.threadId) ?? [];
    list.push(reply);
    repliesByThread.set(reply.threadId, list);
  }
  const items: ActivityRow[] = page.map((row) => ({
    action: actionFromRow(row),
    artifact: row.artifactId === null || row.artifactName === null
      ? null
      : {
        archived: row.artifactArchived === 1,
        id: row.artifactId,
        name: row.artifactName,
      },
    dispatch: row.dispatchState === null || row.dispatchAgentName === null
      ? null
      : {
        agentDisplayName: row.dispatchAgentName,
        state: row.dispatchState,
        threadIds: threadIdListSchema.parse(
          JSON.parse(row.dispatchThreadIdsJson ?? "[]"),
        ),
      },
    excerpt: row.action === artifactActionKinds.commentResolve ||
        row.action === artifactActionKinds.commentReopen
      ? row.threadExcerpt?.split("\n", 1)[0] ?? null
      : null,
    project: row.projectId === null || row.projectName === null
      ? null
      : {id: row.projectId, name: row.projectName},
    thread: snapshotFor(row, threadsById, repliesByThread),
    versionNumber: row.versionNumber,
  }));
  const last = page.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last !== undefined
      ? {createdAt: last.createdAt, id: last.id}
      : null,
  };
}
```

- [ ] **Step 5: Implement `listActivity` in the three repositories**

`src/storage/sqlite-artifact-repository.ts`:

- Add `ActivityLog`, `ActivityPage` and `ActivityQuery` to the `../core/ports.js` import.
- Import `activitySqlRowSchema`, `assembleActivityPage`, `buildListActivityStatement`, `buildNewestRepliesStatement` and `snapshotThreadIds` from `./activity-sql.js`.
- Add `ActivityLog` to the class's `implements` list.
- Insert the method after `listArtifactActions`:

```ts
  listActivity(query: ActivityQuery): Promise<ActivityPage> {
    return Promise.resolve().then(() => {
      const statement = buildListActivityStatement(
        "sqlite",
        query,
        this.#installationId,
      );
      const rows = z.array(activitySqlRowSchema).parse(
        this.#database.prepare(statement.text).all(...statement.values),
      );
      const threadIds = snapshotThreadIds(rows, query.limit);
      if (threadIds.length === 0) {
        return assembleActivityPage(rows, [], [], query.limit);
      }
      const threads = z.array(commentThreadRowSchema).parse(
        this.#database
          .prepare(
            `${commentThreadColumns}
             WHERE t.id IN (SELECT value FROM json_each(?))`,
          )
          .all(JSON.stringify(threadIds)),
      ).map(commentThreadFromRow);
      const repliesStatement = buildNewestRepliesStatement(
        "sqlite",
        threadIds,
        this.#installationId,
      );
      const replies = z.array(commentReplyRowSchema).parse(
        this.#database.prepare(repliesStatement.text)
          .all(...repliesStatement.values),
      ).map(commentReplyFromRow);
      return assembleActivityPage(rows, threads, replies, query.limit);
    });
  }
```

`src/storage/postgres-artifact-repository.ts`:

- Same imports, with `implements ActivityLog`.
- Insert after `listArtifactActions`:

```ts
  async listActivity(query: ActivityQuery): Promise<ActivityPage> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const statement = buildListActivityStatement(
        "postgres",
        query,
        installationId,
      );
      const rows = z.array(activitySqlRowSchema).parse(
        yield* sql.unsafe<object>(statement.text, [...statement.values]),
      );
      const threadIds = snapshotThreadIds(rows, query.limit);
      if (threadIds.length === 0) {
        return assembleActivityPage(rows, [], [], query.limit);
      }
      const threads = z.array(commentThreadRowSchema).parse(
        yield* sql.unsafe<object>(
          `${commentThreadColumns}
           WHERE thread.installation_id = $1
             AND thread.id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
          [installationId, JSON.stringify(threadIds)],
        ),
      ).map(commentThreadFromRow);
      const repliesStatement = buildNewestRepliesStatement(
        "postgres",
        threadIds,
        installationId,
      );
      const replies = z.array(commentReplyRowSchema).parse(
        yield* sql.unsafe<object>(
          repliesStatement.text,
          [...repliesStatement.values],
        ),
      ).map(commentReplyFromRow);
      return assembleActivityPage(rows, threads, replies, query.limit);
    }));
  }
```

`deploy/cloudflare/src/d1-artifact-repository.ts`:

- Add `ActivityLog`, `ActivityPage` and `ActivityQuery` to the ports import.
- Import the same five helpers from `../../../src/storage/activity-sql.js`.
- Extend the type at line 618 to `export type D1ArtifactRepository = ActivityLog & AgentDispatchRepository & ArtifactRepository & …`.
- Add the property beside `listArtifactActions` in the returned object:

```ts
    listActivity: async (query: ActivityQuery): Promise<ActivityPage> => {
      const statement = buildListActivityStatement("sqlite", query, installationId);
      const result = await database.prepare(statement.text)
        .bind(...statement.values)
        .all<z.input<typeof activitySqlRowSchema>>();
      const rows = z.array(activitySqlRowSchema).parse(result.results);
      const threadIds = snapshotThreadIds(rows, query.limit);
      if (threadIds.length === 0) {
        return assembleActivityPage(rows, [], [], query.limit);
      }
      const threadResult = await database.prepare(
        `${commentThreadSelect} WHERE t.id IN (SELECT value FROM json_each(?))`,
      ).bind(JSON.stringify(threadIds))
        .all<z.input<typeof commentThreadRowSchema>>();
      const threads = threadResult.results
        .map((row) => commentThreadFromRow(commentThreadRowSchema.parse(row)));
      const repliesStatement = buildNewestRepliesStatement(
        "sqlite",
        threadIds,
        installationId,
      );
      const replyResult = await database.prepare(repliesStatement.text)
        .bind(...repliesStatement.values)
        .all<z.input<typeof commentReplyRowSchema>>();
      const replies = replyResult.results
        .map((row) => commentReplyFromRow(commentReplyRowSchema.parse(row)));
      return assembleActivityPage(rows, threads, replies, query.limit);
    },
```

D1's limit of 100 bound parameters per statement is respected: the feed statement binds at most six values, because project IDs and thread IDs travel as one JSON value each.

- [ ] **Step 6: Map rows to the wire shape**

Create `src/application/activity-entries.ts`:

```ts
import type {AccessSetting, AgentDispatchState} from "../core/model.js";
import type {PrincipalKind} from "../core/identity.js";
import type {
  ActivityRow,
  ActivityThreadState,
} from "../core/ports.js";

/** Feed entry kinds the web renders. */
export type ActivityEntryKind =
  | "access"
  | "admin"
  | "agent"
  | "resolution"
  | "thread"
  | "thread_deleted"
  | "version";

/** One comment or reply as the feed shows it. */
export interface WireComment {
  readonly author: {readonly kind: PrincipalKind; readonly name: string};
  readonly body: string;
  readonly createdAt: string;
  readonly id: string;
}

/** One feed entry on the wire. Optional fields appear only for their kinds. */
export interface ActivityEntry {
  readonly access?: {readonly from: AccessSetting | null; readonly to: AccessSetting};
  readonly actor: {readonly kind: PrincipalKind | null; readonly name: string | null};
  readonly agent?: {
    readonly dispatchState: AgentDispatchState;
    readonly name: string;
    readonly threadIds: readonly string[];
  };
  readonly artifact: {
    readonly archived: boolean;
    readonly id: string;
    readonly name: string;
  } | null;
  readonly at: string;
  readonly excerpt?: string;
  readonly id: string;
  readonly kind: ActivityEntryKind;
  readonly project: {readonly id: string; readonly name: string} | null;
  readonly subject?: {readonly id: string; readonly name: string | null};
  readonly thread?: {
    readonly anchor: unknown;
    readonly id: string;
    readonly isResolved: boolean;
    readonly opener: WireComment;
    readonly replies: readonly WireComment[];
    readonly replyCount: number;
    readonly state: ActivityThreadState;
  };
  readonly threadId?: string;
  readonly verb: string;
  readonly versionNumber: number | null;
}

/** Display names for member and key subjects, by ID. */
export interface SubjectNames {
  readonly keys: ReadonlyMap<string, string>;
  readonly members: ReadonlyMap<string, string>;
}

const verbs = {
  comment_create: ["thread", "commented"],
  comment_delete: ["thread_deleted", "deleted"],
  comment_reopen: ["resolution", "reopened"],
  comment_reply: ["thread", "replied"],
  comment_resolve: ["resolution", "resolved"],
  dispatch_addressed: ["agent", "answered"],
  dispatch_create: ["agent", "sent"],
  key_issue: ["admin", "issued"],
  key_revoke: ["admin", "revoked"],
  key_rotate: ["admin", "rotated"],
  member_admit: ["admin", "admitted"],
  member_deactivate: ["admin", "deactivated"],
  project_archive: ["admin", "archived"],
  project_create: ["admin", "created"],
  project_unarchive: ["admin", "unarchived"],
  public_link_disable: ["access", "disabled"],
  public_link_enable: ["access", "enabled"],
  publish: ["version", "published"],
  restore: ["version", "restored"],
} as const satisfies Record<string, readonly [ActivityEntryKind, string]>;

type FeedKind = keyof typeof verbs;

const isFeedKind = (action: string): action is FeedKind =>
  Object.hasOwn(verbs, action);

function wireComment(comment: {
  readonly author: {readonly displayName: string; readonly principalKind: PrincipalKind};
  readonly body: string;
  readonly createdAt: string;
  readonly id: string;
}): WireComment {
  return {
    author: {kind: comment.author.principalKind, name: comment.author.displayName},
    body: comment.body,
    createdAt: comment.createdAt,
    id: comment.id,
  };
}

function subjectOf(
  row: ActivityRow,
  names: SubjectNames,
): {readonly id: string; readonly name: string | null} | undefined {
  const {action, subjectId} = row.action;
  if (action.startsWith("project_")) {
    return row.project === null
      ? undefined
      : {id: row.project.id, name: row.project.name};
  }
  if (subjectId === null) return undefined;
  if (action.startsWith("member_")) {
    return {id: subjectId, name: names.members.get(subjectId) ?? null};
  }
  if (action.startsWith("key_")) {
    return {id: subjectId, name: names.keys.get(subjectId) ?? null};
  }
  return undefined;
}

/** Map one read-model row to its wire entry, or null for a non-feed kind. */
export function toActivityEntry(
  row: ActivityRow,
  names: SubjectNames,
): ActivityEntry | null {
  const {action} = row.action;
  if (!isFeedKind(action)) return null;
  const [kind, verb] = verbs[action];
  const base = {
    actor: {
      kind: row.action.actor?.kind ?? null,
      name: row.action.actor?.displayName ?? null,
    },
    artifact: row.artifact,
    at: row.action.createdAt,
    id: row.action.id,
    kind,
    project: row.project,
    verb,
    versionNumber: row.versionNumber,
  };
  switch (kind) {
    case "thread":
      return row.thread === null
        ? null
        : {
          ...base,
          thread: {
            anchor: row.thread.anchor,
            id: row.thread.id,
            isResolved: row.thread.isResolved,
            opener: wireComment(row.thread.opener),
            replies: row.thread.replies.map(wireComment),
            replyCount: row.thread.replyCount,
            state: row.thread.state,
          },
        };
    case "resolution":
    case "thread_deleted": {
      const threadId = row.action.threadId;
      const withThread = threadId === null ? base : {...base, threadId};
      return row.excerpt === null ? withThread : {...withThread, excerpt: row.excerpt};
    }
    case "agent":
      return row.dispatch === null
        ? base
        : {
          ...base,
          agent: {
            dispatchState: row.dispatch.state,
            name: row.dispatch.agentDisplayName,
            threadIds: row.dispatch.threadIds,
          },
        };
    case "access":
      return {
        ...base,
        access: {
          from: row.action.accessFrom,
          to: row.action.accessTo ??
            (action === "public_link_enable" ? "public_link" : "account_required"),
        },
      };
    case "admin": {
      const subject = subjectOf(row, names);
      return subject === undefined ? base : {...base, subject};
    }
    case "version":
      return base;
  }
}
```

- [ ] **Step 7: Create the service**

Create `src/application/activity.ts`:

```ts
import {Context, Effect, Layer} from "effect";

import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";
import {normalizeArtifactSearchText} from "./artifact-tags.js";
import {
  type ActivityEntry,
  type SubjectNames,
  toActivityEntry,
} from "./activity-entries.js";
import type {
  ArtifactRepositoryFailure,
  AuthorizationDenied,
  IdentityRepositoryFailure,
} from "../core/errors.js";
import {isHumanAdministrator, type Principal} from "../core/identity.js";
import type {PageCursor} from "../core/model.js";
import type {
  ActivityPage,
  ActivityQuery,
  ActivitySegment,
  ActivityType,
} from "../core/ports.js";
import {maximumActivitySearchCharacters} from "../core/publishing-limits.js";

/** Activity reads, as the application consumes them. */
export interface ActivityPersistence {
  readonly listActivity: (
    query: ActivityQuery,
  ) => Effect.Effect<ActivityPage, ArtifactRepositoryFailure>;
}

/** Member and key names, read only for administrators. */
export interface ActivityDirectory {
  readonly listApiKeys: () => Effect.Effect<
    readonly {readonly id: string; readonly name: string}[],
    IdentityRepositoryFailure
  >;
  readonly listMembers: () => Effect.Effect<
    readonly {readonly displayName: string; readonly id: string}[],
    IdentityRepositoryFailure
  >;
}

/** Dependencies used to construct the activity service. */
export interface ActivityDependencies {
  readonly directory: ActivityDirectory;
  readonly persistence: ActivityPersistence;
}

/** One parsed feed request. Bounds are enforced at the protocol boundary. */
export interface ActivityRequest {
  readonly cursor: PageCursor | null;
  readonly limit: number;
  readonly projectIds: readonly string[];
  readonly search: string | null;
  readonly segment: ActivitySegment;
  readonly types: readonly ActivityType[];
}

/** One feed page; the protocol adapter encodes the cursor. */
export interface ActivityResponse {
  readonly items: readonly ActivityEntry[];
  readonly nextCursor: PageCursor | null;
}

/** Expected failures produced by activity reads. */
export type ActivityFailure =
  | ArtifactRepositoryFailure
  | AuthorizationDenied
  | IdentityRepositoryFailure;

interface ActivityOperations {
  readonly list: (
    principal: Principal,
    request: ActivityRequest,
  ) => Effect.Effect<ActivityResponse, ActivityFailure>;
}

/** Reads the installation activity log under membership visibility rules. */
export class ActivityService extends Context.Service<
  ActivityService,
  ActivityOperations
>()("artifact-server/application/ActivityService") {
  /** Construct activity reads over deployment-neutral persistence. */
  static readonly layer = (
    dependencies: ActivityDependencies,
  ): Layer.Layer<ActivityService, never, AuthorizationService> =>
    Layer.effect(
      ActivityService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        return makeActivityService(dependencies, authorization);
      }),
    );
}

const emptyNames: SubjectNames = {keys: new Map(), members: new Map()};

function normalizeActivitySearch(candidate: string | null): string | null {
  if (candidate === null) return null;
  const normalized = normalizeArtifactSearchText(
    candidate.slice(0, maximumActivitySearchCharacters),
  );
  return normalized === "" ? null : normalized;
}

function makeActivityService(
  dependencies: ActivityDependencies,
  authorization: AuthorizationOperations,
): ActivityOperations {
  const subjectNames = Effect.fn("ActivityService.subjectNames")(
    function*(page: ActivityPage) {
      const needsNames = page.items.some(({action}) =>
        action.action.startsWith("member_") || action.action.startsWith("key_")
      );
      if (!needsNames) return emptyNames;
      const members = yield* dependencies.directory.listMembers();
      const keys = yield* dependencies.directory.listApiKeys();
      return {
        keys: new Map(keys.map((key) => [key.id, key.name])),
        members: new Map(members.map((member) => [member.id, member.displayName])),
      } satisfies SubjectNames;
    },
  );

  const list = Effect.fn("ActivityService.list")(function*(
    principal: Principal,
    request: ActivityRequest,
  ) {
    yield* authorization.requireArtifactListing(principal);
    const includeAdministration = isHumanAdministrator(principal);
    const page = yield* dependencies.persistence.listActivity({
      cursor: request.cursor,
      includeAdministration,
      limit: request.limit,
      projectIds: request.projectIds,
      search: normalizeActivitySearch(request.search),
      segment: request.segment,
      types: request.types,
    });
    const names = includeAdministration ? yield* subjectNames(page) : emptyNames;
    return {
      items: page.items.flatMap((row) => {
        const entry = toActivityEntry(row, names);
        return entry === null ? [] : [entry];
      }),
      nextCursor: page.nextCursor,
    } satisfies ActivityResponse;
  });

  return {list};
}
```

- [ ] **Step 8: Wire the runtime**

In `src/application/application-runtime.ts`, add `import type {ActivityService} from "./activity.js";` and `| ActivityService` as the first member of `ApplicationServices`.

In `src/local/create-local-application-layer.ts`:

1. Add `ActivityLog` to the `../core/ports.js` type import. Change `ApplicationAdapters.repository` to begin `readonly repository: ActivityLog & ArtifactRepository & …`.
2. Add `import {ActivityService} from "../application/activity.js";`.
3. Add `| ActivityService` as the first member of `createApplicationLayer`'s return type.
4. After `publicLinkAdministrationRepository` (line 816), add:

```ts
  const activityLayer = ActivityService.layer({
    directory: {
      listApiKeys: () => identityEffect(
        "listApiKeys",
        () => adapters.identityRepository.listApiKeys(adapters.installationId),
      ),
      listMembers: () => identityEffect(
        "listMembers",
        () => adapters.identityRepository.listMembers(adapters.installationId),
      ),
    },
    persistence: {
      listActivity: (query) =>
        Effect.tryPromise({
          try: () => adapters.repository.listActivity(query),
          catch: (cause) => repositoryFailure("listActivity", cause),
        }),
    },
  }).pipe(Layer.provideMerge(authorizationLayer));
```

5. Add `activityLayer,` as the first argument of the final `Layer.mergeAll(...)` (line 1293).

The external-storage runtime (`src/external-storage/create-external-storage-runtime.ts`) and the Worker (`deploy/cloudflare/src/worker.ts`) already pass their repositories as `adapters.repository`. The Postgres class and the D1 factory now satisfy `ActivityLog`, so neither file needs to change; `pnpm typecheck` proves it.

- [ ] **Step 9: Add the route**

In `src/http/create-http-app.ts`:

- Add `import {ActivityService} from "../application/activity.js";`.
- Add `defaultActivityPageSize`, `maximumActivityPageSize`, `maximumActivityProjectFilters` and `maximumActivitySearchCharacters` to the `../core/publishing-limits.js` import.
- After `publicLinksPageQuerySchema` (line 381), add:

```ts
const activityQuerySchema = z.object({
  cursor: z.string().max(1_024).optional(),
  limit: z.coerce.number().int().min(1).max(maximumActivityPageSize)
    .default(defaultActivityPageSize),
  project: z.array(projectIdSchema).max(maximumActivityProjectFilters)
    .default([]),
  q: z.string().max(maximumActivitySearchCharacters).optional(),
  segment: z.enum(["all", "needs_you", "with_agent"]).default("all"),
  type: z.array(z.enum(["access", "admin", "agents", "comments", "versions"]))
    .max(5).default([]),
});
```

After the `app.get("/api/v1/agent-dispatches/:dispatchId", …)` handler, add:

```ts
  app.get("/api/v1/activity", async (context) => {
    const query = activityQuerySchema.parse({
      ...context.req.query(),
      project: context.req.queries("project") ?? [],
      type: context.req.queries("type") ?? [],
    });
    const page = await runHttpApplicationEffect(
      context,
      dependencies,
      ActivityService.use((activity) =>
        activity.list(context.get("principal"), {
          cursor: decodePageCursor(query.cursor),
          limit: query.limit,
          projectIds: query.project,
          search: query.q ?? null,
          segment: query.segment,
          types: query.type,
        })
      ),
    );
    return context.json({
      items: page.items,
      nextCursor: encodePageCursor(page.nextCursor),
    });
  });
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/conformance/act-003-activity-feed.test.ts`
Expected: PASS (1 test).

Run: `pnpm typecheck && pnpm lint`
Expected: both exit 0. This includes `deploy/cloudflare`; also run `pnpm --dir deploy/cloudflare typecheck` and expect exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/core/ports.ts src/core/publishing-limits.ts src/core/errors.ts \
  src/storage/activity-sql.ts src/storage/sqlite-artifact-repository.ts \
  src/storage/postgres-artifact-repository.ts \
  deploy/cloudflare/src/d1-artifact-repository.ts \
  src/application/activity-entries.ts src/application/activity.ts \
  src/application/application-runtime.ts \
  src/local/create-local-application-layer.ts src/http/create-http-app.ts \
  tests/conformance/act-003-activity-feed.test.ts
git commit -m "$(cat <<'EOF'
Serve the installation activity feed newest first

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4.2: Thread folding, filters, segments, search, visibility and paging

This task adds:

- the type, segment and search predicates to the statement builder;
- server-side proof of folding, paging, filtering and visibility;
- Review Focus 1, 2 and 3.

**Files:**
- Modify: `src/storage/activity-sql.ts` (`buildListActivityStatement` and helpers)
- Test: `tests/conformance/act-003-activity-feed.test.ts` (new tests in the same `describe`)

**Interfaces:**
- Consumes: everything Task 4.1 produced; `ApiClient`, `signInAdministrator` and `issueApiKey` from `tests/support/agent-dispatch.ts`; `publishVersion` from `tests/support/publishing.ts`.
- Produces: `segmentPredicate(segment, heads)` and `searchPredicate(dialect, values, search)`, both module-private in `activity-sql.ts`. The behaviour is the contract; no new exports.

- [ ] **Step 1: Write the failing tests**

Add these imports at the top of `tests/conformance/act-003-activity-feed.test.ts`:

```ts
import {Effect, Redacted} from "effect";

import type {BearerCredentialVerifier} from "../../src/application/authentication.js";
import {AuthenticationRequired} from "../../src/core/errors.js";
import {membershipRoles, principalKinds, type MembershipRole} from "../../src/core/identity.js";
import {issueApiKey, signInAdministrator} from "../support/agent-dispatch.js";
import {publishVersion} from "../support/publishing.js";
```

Inside the existing `describe`, after the first test, add:

```ts
  test("ACT-003: a thread is one entry dated by its newest reply and carries its newest two replies", async () => {
    expect.hasAssertions();
    const published = await publish("feed-fold", "Inspector docking study");
    clock.advance(1_000);
    const thread = await reader.openThread(published, "Opening note", "feed-fold-thread");
    for (const [index, body] of ["first", "second", "third"].entries()) {
      clock.advance(1_000);
      await reply(published, thread.id, body, `feed-fold-reply-${index}`);
    }
    clock.advance(1_000);
    await publishVersion(server, installation, {
      artifactId: published.artifact.id,
      content: "<p>v2</p>",
      expectedCurrentVersionId: published.version.id,
      idempotencyKey: "feed-fold-v2",
      projectId: published.artifact.projectId,
    });
    clock.advance(1_000);
    await reply(published, thread.id, "fourth", "feed-fold-reply-3");

    const entries = (await readFeed(reader, "?type=comments&type=versions")).items;

    expect(entries.map((entry) => entry.kind)).toEqual(["thread", "version", "version"]);
    const folded = entries[0];
    expect(folded?.verb).toBe("replied");
    expect(folded?.thread?.replyCount).toBe(4);
    expect(folded?.thread?.replies.map((comment) => comment.body)).toEqual(["third", "fourth"]);
    expect(entries.filter((entry) => entry.thread?.id === thread.id)).toHaveLength(1);
  });

  test("ACT-003: type and project filters narrow the feed", async () => {
    expect.hasAssertions();
    const first = await publish("feed-filter-a", "Claims workstation");
    const otherProjectId = await reader.createProject("Records retention", "feed-filter-project");
    clock.advance(1_000);
    const second = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<p>Retention</p>",
      idempotencyKey: "feed-filter-b",
      name: "Retention schedule",
      projectId: otherProjectId,
    })).body;
    clock.advance(1_000);
    await reader.openThread(first, "Check the claim totals.", "feed-filter-thread");

    const versionsOnly = await readFeed(reader, "?type=versions");
    expect(versionsOnly.items.map((entry) => entry.kind)).toEqual(["version", "version"]);

    const scoped = await readFeed(reader, `?project=${otherProjectId}`);
    expect(scoped.items.filter((entry) => entry.kind !== "admin")
      .map((entry) => entry.artifact?.id)).toEqual([second.artifact.id]);

    const unknown = await readFeed(reader, "?project=prj_does_not_exist");
    expect(unknown).toEqual({items: [], nextCursor: null});
  });

  test("ACT-003: segments split open threads by whether an active dispatch holds them", async () => {
    expect.hasAssertions();
    const administrator = await signInAdministrator(server, installation);
    const agentToken = await issueApiKey(
      server,
      administrator,
      ["agent:connect", "artifact:read", "comment:write"],
      "Codex bridge",
    );
    const agent = new ApiClient(server, agentToken);
    const registered = await agent.registerAgent({
      connectionKey: "feed-segment-agent",
      displayName: "Codex",
      workingDirectory: "/work",
    });
    const published = await publish("feed-segment", "Stage bar walkthrough");
    clock.advance(1_000);
    const held = await reader.openThread(published, "Send me to Codex", "feed-segment-held");
    clock.advance(1_000);
    const waiting = await reader.openThread(published, "Waiting on a person", "feed-segment-wait");
    clock.advance(1_000);
    const sent = await reader.sendDispatch({
      agentId: registered.id,
      idempotencyKey: "feed-segment-dispatch",
      projectId: published.artifact.projectId,
      threadIds: [held.id],
    });
    expect(sent.status).toBe(201);

    const needsYou = await readFeed(reader, "?segment=needs_you");
    expect(needsYou.items.map((entry) => entry.thread?.id)).toEqual([waiting.id]);
    expect(needsYou.items[0]?.thread?.state).toBe("needs_you");

    const withAgent = await readFeed(reader, "?segment=with_agent");
    expect(withAgent.items.map((entry) => entry.kind)).toEqual(["agent", "thread"]);
    expect(withAgent.items[0]?.agent).toEqual({
      dispatchState: "queued",
      name: "Codex",
      threadIds: [held.id],
    });
    expect(withAgent.items[1]?.thread?.id).toBe(held.id);
    expect(withAgent.items[1]?.thread?.state).toBe("with_agent");
  });

  test("ACT-003: search matches actor, artifact, project and comment text literally", async () => {
    expect.hasAssertions();
    const published = await publish("feed-search", "Quarterly revenue");
    clock.advance(1_000);
    await reader.openThread(published, "Axis label reads 100%_off", "feed-search-thread");

    const byName = await readFeed(reader, "?q=quarterly&type=comments&type=versions");
    expect(byName.items.map((entry) => entry.kind)).toEqual(["thread", "version"]);
    expect(byName.items.every((entry) => entry.artifact?.name === "Quarterly revenue"))
      .toBe(true);
    expect((await readFeed(reader, `?q=${encodeURIComponent("100%_off")}`)).items
      .map((entry) => entry.kind)).toEqual(["thread"]);
    expect((await readFeed(reader, `?q=${encodeURIComponent("%")}`)).items
      .map((entry) => entry.kind)).toEqual(["thread"]);
    expect((await readFeed(reader, "?q=local")).items.length).toBeGreaterThan(0);
    expect((await readFeed(reader, "?q=nothing-matches-this")).items).toEqual([]);
  });

  test("ACT-003: pages walk the feed without gaps or duplicates", async () => {
    expect.hasAssertions();
    for (let index = 0; index < 5; index += 1) {
      clock.advance(1_000);
      await publish(`feed-page-${index}`, `Artifact ${index}`);
    }
    const seen: string[] = [];
    let query = "?type=versions&limit=2";
    for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
      const page = await readFeed(reader, query);
      seen.push(...page.items.map((entry) => entry.id));
      if (page.nextCursor === null) break;
      query = `?type=versions&limit=2&cursor=${page.nextCursor}`;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  test("ACT-003-F: a thread replied to across a page boundary appears exactly once", async () => {
    expect.hasAssertions();
    const published = await publish("feed-boundary", "Boundary study");
    const threads = [];
    for (const name of ["A", "B", "C", "D"]) {
      clock.advance(1_000);
      threads.push(await reader.openThread(published, `Thread ${name}`, `feed-boundary-${name}`));
    }
    const [threadA, threadB, threadC, threadD] = threads;
    const firstPage = await readFeed(reader, "?type=comments&limit=2");
    expect(firstPage.items.map((entry) => entry.thread?.id)).toEqual([threadD?.id, threadC?.id]);

    clock.advance(1_000);
    await reply(published, threadC?.id ?? "", "moves C to the top", "feed-boundary-reply-c");
    clock.advance(1_000);
    await reply(published, threadA?.id ?? "", "moves A to the top", "feed-boundary-reply-a");

    const secondPage = await readFeed(
      reader,
      `?type=comments&limit=2&cursor=${firstPage.nextCursor ?? ""}`,
    );
    expect(secondPage.items.map((entry) => entry.thread?.id)).toEqual([threadB?.id]);
    const staleTraversal = [...firstPage.items, ...secondPage.items]
      .map((entry) => entry.thread?.id);
    expect(new Set(staleTraversal).size).toBe(staleTraversal.length);

    const fresh = await readFeed(reader, "?type=comments&limit=10");
    expect(fresh.items.map((entry) => entry.thread?.id))
      .toEqual([threadA?.id, threadC?.id, threadD?.id, threadB?.id]);
  });

  test("ACT-003: hostile comment text stays byte-exact, searchable and well-formed", async () => {
    expect.hasAssertions();
    const published = await publish("feed-hostile-text", "Hostile text");
    const hostile = `‮evil‬ zero​width ' OR 1=1 -- `.padEnd(8_192, "x");
    clock.advance(1_000);
    await reader.openThread(published, hostile, "feed-hostile-thread");
    const oversized = await reader.fetch(
      `/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/comments` +
        `?projectId=${published.artifact.projectId}`,
      {
        body: JSON.stringify({body: "y".repeat(10_000), path: "index.html"}),
        idempotencyKey: "feed-hostile-oversized",
        method: "POST",
      },
    );
    expect(oversized.status).toBe(422);

    const page = await readFeed(reader, `?q=${encodeURIComponent("' OR 1=1 --")}`);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.thread?.opener.body).toBe(hostile);
    const everything = await readFeed(reader, "?type=comments");
    expect(everything.items).toHaveLength(1);
  });

  async function reply(
    published: PublishResponse,
    threadId: string,
    body: string,
    key: string,
  ): Promise<void> {
    const response = await reader.fetch(
      `/api/v1/artifacts/${published.artifact.id}/comments/${threadId}/replies` +
        `?projectId=${published.artifact.projectId}`,
      {body: JSON.stringify({body}), idempotencyKey: key, method: "POST"},
    );
    expect(response.status).toBe(201);
  }
```

Add a second `describe` at the bottom of the file, outside the first, for visibility. Its external verifier reads the role and active flag on every call, so a test can demote or deactivate the caller between requests:

```ts
describe("activity visibility", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let role: MembershipRole;
  let active: boolean;
  const roleToken = "activity-visibility-flippable-administrator";

  beforeEach(async () => {
    installation = await createTestInstallation();
    role = membershipRoles.administrator;
    active = true;
    server = await startTestServer(installation, {
      externalApiBearerVerifier: flippableVerifier(),
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("ACT-003: administrators see member and key events with subject names; members do not", async () => {
    expect.hasAssertions();
    const administrator = await signInAdministrator(server, installation);
    const admitted = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({displayName: "Rosa Santoro", email: "rosa@example.test"}),
      headers: cookieHeaders(server, administrator),
      method: "POST",
    });
    expect(admitted.status).toBe(201);

    const adminView = await fetch(`${server.baseUrl}/api/v1/activity?type=admin`, {
      headers: {Cookie: administrator.header},
    });
    expect(adminView.status).toBe(200);
    const adminPage = activityPageSchema.parse(await adminView.json());
    expect(adminPage.items.find((entry) => entry.verb === "admitted")?.subject?.name)
      .toBe("Rosa Santoro");

    const memberPage = await readFeed(new ApiClient(server, installation.apiToken), "?type=admin");
    expect(memberPage.items.some((entry) =>
      entry.verb === "admitted" || entry.verb === "issued"
    )).toBe(false);
  });

  test("ACT-003: an administrator demoted mid-session stops seeing member and key events on the next request", async () => {
    expect.hasAssertions();
    const administrator = await signInAdministrator(server, installation);
    await issueApiKey(server, administrator, ["artifact:read"], "Reader key");
    const flipping = new ApiClient(server, roleToken);

    const before = await readFeed(flipping, "?type=admin");
    expect(before.items.some((entry) => entry.verb === "issued")).toBe(true);

    role = membershipRoles.member;
    const after = await readFeed(flipping, "?type=admin");
    expect(after.items.some((entry) => entry.verb === "issued")).toBe(false);

    active = false;
    const refused = await flipping.fetch("/api/v1/activity");
    expect(refused.status).toBe(401);
  });

  function flippableVerifier(): BearerCredentialVerifier {
    return {
      verify: (credential) => Effect.suspend(() => {
        if (Redacted.value(credential) !== roleToken || !active) {
          return Effect.fail(new AuthenticationRequired({
            message: "The activity credential is invalid.",
          }));
        }
        return Effect.succeed({
          authorizedByPrincipalId: null,
          capabilities: [],
          displayName: "Marc Delacroix",
          id: "member_flippable",
          installationId: "local",
          kind: principalKinds.human,
          membershipRole: role,
        });
      }),
    };
  }
});

function cookieHeaders(
  server: RunningTestServer,
  cookies: {readonly csrf: string; readonly header: string},
): Headers {
  return new Headers({
    "Content-Type": "application/json",
    Cookie: cookies.header,
    Origin: server.baseUrl,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": cookies.csrf,
  });
}
```

Use `import {Effect, Redacted} from "effect";` in the imports added above.

Two things to check if a test fails here:

- **Admin event 403.** If `POST /api/v1/members` or the admin-session `GET` answers 403, check that `startTestServer`'s `bootstrapAdministratorEmail` default (`administrator@example.test`) is the account `signInAdministrator` signs in as.
- **Role caching.** The external verifier is not behind `AuthenticationCache`, which only wraps session and managed-key checks (`installation-access.ts:653-654`). The demotion test therefore proves the service re-reads `membershipRole` on every request instead of caching visibility. There is no product route that changes a role; deactivation clears both caches in-process.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/conformance/act-003-activity-feed.test.ts`
Expected: FAIL. `segments split open threads` returns both threads under `needs_you`, because there is no segment predicate. `search matches` returns every entry, because there is no search predicate. The fold, filter, page, boundary and visibility tests already pass from Task 4.1's head and visibility rules; keep them as regression coverage.

- [ ] **Step 3: Add the segment and search predicates**

In `src/storage/activity-sql.ts`, add the import `import type {ActivitySegment} from "../core/ports.js";` (merge it into the existing ports import). Add these helpers above `buildListActivityStatement`:

```ts
function segmentPredicate(segment: ActivitySegment, heads: string): string | null {
  if (segment === "all") return null;
  const openHead = `(x.action IN (${heads}) AND t.state = 'open')`;
  if (segment === "needs_you") return `(${openHead} AND held.id IS NULL)`;
  return `((${openHead} AND held.id IS NOT NULL)
      OR (x.action IN (${kindLiterals(feedKindsByType.agents)})
        AND d.state IN ${activeDispatchStates}))`;
}

function searchPredicate(
  dialect: ActivitySqlDialect,
  values: StatementValues,
  search: string | null,
): string | null {
  if (search === null) return null;
  const find = dialect === "postgres" ? "strpos" : "instr";
  const needle = () => values.bind(search);
  return `(${find}(lower(COALESCE(x.actor_name, '')), ${needle()}) > 0
      OR ${find}(lower(COALESCE(a.name, '')), ${needle()}) > 0
      OR ${find}(lower(COALESCE(p.name, '')), ${needle()}) > 0
      OR ${find}(lower(COALESCE(t.body, '')), ${needle()}) > 0
      OR EXISTS (
        SELECT 1 FROM comment_replies sr
        WHERE sr.thread_id = t.id${scope(dialect, "sr", "t")}
          AND ${find}(lower(sr.body), ${needle()}) > 0))`;
}
```

In `buildListActivityStatement`, insert immediately after the `query.projectIds` block and before the cursor block, so bind order matches text order:

```ts
  const segment = segmentPredicate(query.segment, heads);
  if (segment !== null) where.push(segment);
  const search = searchPredicate(dialect, values, query.search);
  if (search !== null) where.push(search);
```

The type filter and `includeAdministration` are already enforced by `visibleKinds` from Task 4.1.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/conformance/act-003-activity-feed.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage/activity-sql.ts tests/conformance/act-003-activity-feed.test.ts
git commit -m "$(cat <<'EOF'
Filter, segment and search the activity feed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4.3: Activity summary counts

Adds `summarizeActivity` to the port and the three repositories, and adds `ActivityService.summary` and `GET /api/v1/activity/summary`.

**Files:**
- Modify: `src/core/ports.ts` (summary types and the `ActivityLog.summarizeActivity` method)
- Modify: `src/storage/activity-sql.ts` (`buildSummaryStatements` and `activitySummaryTotalsSchema` / `activityProjectSummarySchema`)
- Modify: `src/storage/sqlite-artifact-repository.ts`, `src/storage/postgres-artifact-repository.ts` and `deploy/cloudflare/src/d1-artifact-repository.ts` (`summarizeActivity`)
- Modify: `src/application/activity.ts` (`summary`, and `summarizeActivity` on `ActivityPersistence`)
- Modify: `src/local/create-local-application-layer.ts` (persistence adapter)
- Modify: `src/http/create-http-app.ts` (summary route)
- Test: `tests/conformance/act-004-activity-summary.test.ts`

**Interfaces:**
- Consumes: Task 4.1's builder helpers and service.
- Produces:
  - `ActivityProjectSummary`, `ActivitySummary` and `ActivityLog.summarizeActivity(projectIds): Promise<ActivitySummary>` in ports.
  - `buildSummaryStatements(dialect, projectIds, installationId): {projects: ActivityStatement; totals: ActivityStatement}`, `activitySummaryTotalsSchema` and `activityProjectSummarySchema` in `activity-sql.ts`.
  - `ActivityService.summary(principal, projectIds): Effect<ActivitySummary, ActivityFailure>`.
  - `GET /api/v1/activity/summary`.

- [ ] **Step 1: Write the failing test**

Create `tests/conformance/act-004-activity-summary.test.ts`:

```ts
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  ApiClient,
  issueApiKey,
  MutableClock,
  signInAdministrator,
} from "../support/agent-dispatch.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

export const activitySummarySchema = z.object({
  artifactsInReview: z.number().int().nonnegative(),
  needsYou: z.number().int().nonnegative(),
  openConversations: z.number().int().nonnegative(),
  projects: z.array(z.object({
    artifactCount: z.number().int().nonnegative(),
    id: z.string(),
    lastActivityAt: z.iso.datetime().nullable(),
    unresolved: z.number().int().nonnegative(),
  }).strict()),
  withAgent: z.number().int().nonnegative(),
}).strict();

describe("activity summary", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let clock: MutableClock;
  let reader: ApiClient;

  beforeEach(async () => {
    installation = await createTestInstallation();
    clock = new MutableClock("2026-10-01T12:00:00.000Z");
    server = await startTestServer(installation, {clock});
    reader = new ApiClient(server, installation.apiToken);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("ACT-004-B: summary and segment counts agree with the per-thread rule", async () => {
    expect.hasAssertions();
    const {agent, agentId} = await connectAgent("summary-agent");
    const first = await publish("summary-a", "Stage bar walkthrough");
    const second = await publish("summary-b", "Inspector docking study");
    clock.advance(1_000);
    const held = await reader.openThread(first, "For Codex", "summary-held");
    await reader.openThread(first, "For a person", "summary-open-a");
    await reader.openThread(second, "Also for a person", "summary-open-b");
    const resolved = await reader.openThread(second, "Done already", "summary-resolved");
    expect((await reader.setThreadState(second, resolved.id, "resolved")).status).toBe(200);
    expect((await reader.sendDispatch({
      agentId,
      idempotencyKey: "summary-dispatch",
      projectId: first.artifact.projectId,
      threadIds: [held.id],
    })).status).toBe(201);
    void agent;

    const summary = await readSummary("");
    expect(summary).toMatchObject({
      artifactsInReview: 2,
      needsYou: 2,
      openConversations: 3,
      withAgent: 1,
    });
    const project = summary.projects.find((entry) => entry.id === first.artifact.projectId);
    expect(project).toMatchObject({artifactCount: 2, unresolved: 3});
    expect(project?.lastActivityAt).not.toBeNull();

    const needsYouEntries = (await readFeed(`?segment=needs_you&limit=100`)).length;
    const withAgentThreads = (await readFeed(`?segment=with_agent&type=comments&limit=100`)).length;
    expect(needsYouEntries).toBe(summary.needsYou);
    expect(withAgentThreads).toBe(summary.withAgent);
  });

  test("ACT-004-F: resolved, canceled-dispatch and deleted threads are never counted as waiting", async () => {
    expect.hasAssertions();
    const {agentId} = await connectAgent("summary-cancel-agent");
    const published = await publish("summary-f", "Retention schedule");
    clock.advance(1_000);
    const canceled = await reader.openThread(published, "Dispatched then canceled", "summary-f-cancel");
    const deleted = await reader.openThread(published, "Deleted thread", "summary-f-delete");
    const resolved = await reader.openThread(published, "Resolved thread", "summary-f-resolve");
    const sent = await reader.sendDispatch({
      agentId,
      idempotencyKey: "summary-f-dispatch",
      projectId: published.artifact.projectId,
      threadIds: [canceled.id],
    });
    const dispatchId = z.object({dispatch: z.object({id: z.string()}).loose()}).loose()
      .parse(await sent.json()).dispatch.id;
    expect((await reader.cancelDispatch(dispatchId, published.artifact.projectId)).status)
      .toBe(200);
    expect((await reader.fetch(
      `/api/v1/artifacts/${published.artifact.id}/comments/${deleted.id}` +
        `?projectId=${published.artifact.projectId}`,
      {method: "DELETE"},
    )).status).toBe(204);
    expect((await reader.setThreadState(published, resolved.id, "resolved")).status).toBe(200);

    const summary = await readSummary(`?project=${published.artifact.projectId}`);
    expect(summary).toMatchObject({
      needsYou: 1,
      openConversations: 1,
      withAgent: 0,
    });
    expect(summary.projects.map((project) => project.id))
      .toEqual([published.artifact.projectId]);

    const unknown = await readSummary("?project=prj_does_not_exist");
    expect(unknown).toEqual({
      artifactsInReview: 0,
      needsYou: 0,
      openConversations: 0,
      projects: [],
      withAgent: 0,
    });
  });

  async function connectAgent(key: string): Promise<{agent: ApiClient; agentId: string}> {
    const administrator = await signInAdministrator(server, installation);
    const token = await issueApiKey(server, administrator, ["agent:connect"], key);
    const agent = new ApiClient(server, token);
    const registered = await agent.registerAgent({
      connectionKey: key,
      displayName: "Codex",
      workingDirectory: "/work",
    });
    return {agent, agentId: registered.id};
  }

  async function publish(key: string, name: string): Promise<PublishResponse> {
    return (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: `<p>${name}</p>`,
      idempotencyKey: key,
      name,
    })).body;
  }

  async function readSummary(query: string) {
    const response = await reader.fetch(`/api/v1/activity/summary${query}`);
    expect(response.status).toBe(200);
    return activitySummarySchema.parse(await response.json());
  }

  async function readFeed(query: string): Promise<readonly unknown[]> {
    const response = await reader.fetch(`/api/v1/activity${query}`);
    expect(response.status).toBe(200);
    return z.object({items: z.array(z.unknown())}).loose()
      .parse(await response.json()).items;
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/conformance/act-004-activity-summary.test.ts`
Expected: FAIL. `readSummary` sees status `404`.

- [ ] **Step 3: Add the summary types, statements and repository methods**

Append to `src/core/ports.ts`, and add the method to `ActivityLog`:

```ts
/** Per-project counts shown in the Projects list. */
export interface ActivityProjectSummary {
  readonly artifactCount: number;
  readonly id: string;
  readonly lastActivityAt: string | null;
  readonly unresolved: number;
}

/** Counts behind the nav badge, metric cards and Projects rows. */
export interface ActivitySummary {
  readonly artifactsInReview: number;
  readonly needsYou: number;
  readonly openConversations: number;
  readonly projects: readonly ActivityProjectSummary[];
  readonly withAgent: number;
}

export interface ActivityLog {
  listActivity(query: ActivityQuery): Promise<ActivityPage>;
  summarizeActivity(projectIds: readonly string[]): Promise<ActivitySummary>;
}
```

Append to `src/storage/activity-sql.ts`:

```ts
/** Totals and per-project counts over live open threads. */
export function buildSummaryStatements(
  dialect: ActivitySqlDialect,
  projectIds: readonly string[],
  installationId: string,
): {readonly projects: ActivityStatement; readonly totals: ActivityStatement} {
  const totalValues = new StatementValues(dialect);
  const totalWhere = ["t.state = 'open'"];
  if (dialect === "postgres") {
    totalWhere.push(`t.installation_id = ${totalValues.bind(installationId)}`);
  }
  if (projectIds.length > 0) {
    totalWhere.push(`t.project_id IN ${totalValues.bindList(projectIds)}`);
  }
  const totals = {
    text: `SELECT
        COALESCE(SUM(CASE WHEN held.id IS NULL THEN 1 ELSE 0 END), 0) AS "needsYou",
        COALESCE(SUM(CASE WHEN held.id IS NULL THEN 0 ELSE 1 END), 0) AS "withAgent",
        COUNT(t.id) AS "openConversations",
        COUNT(DISTINCT t.artifact_id) AS "artifactsInReview"
      FROM comment_threads t
      JOIN artifacts a ON a.id = t.artifact_id${scope(dialect, "a", "t")}
        AND a.deleted_at IS NULL
      LEFT JOIN agent_dispatches held ON held.id = t.dispatch_id${scope(dialect, "held", "t")}
        AND held.state IN ${activeDispatchStates}
      WHERE ${totalWhere.join(" AND ")}`,
    values: totalValues.values,
  };
  const projectValues = new StatementValues(dialect);
  const projectWhere: string[] = [];
  if (dialect === "postgres") {
    projectWhere.push(`p.installation_id = ${projectValues.bind(installationId)}`);
  }
  if (projectIds.length > 0) {
    projectWhere.push(`p.id IN ${projectValues.bindList(projectIds)}`);
  }
  const projects = {
    text: `SELECT
        p.id AS "id",
        (SELECT COUNT(*) FROM artifacts pa
          WHERE pa.project_id = p.id${scope(dialect, "pa", "p")}
            AND pa.deleted_at IS NULL) AS "artifactCount",
        (SELECT COUNT(*) FROM comment_threads pt
          JOIN artifacts pta ON pta.id = pt.artifact_id${scope(dialect, "pta", "pt")}
            AND pta.deleted_at IS NULL
          WHERE pt.project_id = p.id${scope(dialect, "pt", "p")}
            AND pt.state = 'open') AS "unresolved",
        (SELECT MAX(px.created_at) FROM actions px
          WHERE px.project_id = p.id${scope(dialect, "px", "p")}) AS "lastActivityAt"
      FROM projects p
      ${projectWhere.length === 0 ? "" : `WHERE ${projectWhere.join(" AND ")}`}
      ORDER BY p.created_at, p.id`,
    values: projectValues.values,
  };
  return {projects, totals};
}

/** Postgres returns COUNT and SUM as bigint strings; SQLite as numbers. */
export const activitySummaryTotalsSchema = z.object({
  artifactsInReview: z.coerce.number().int().nonnegative(),
  needsYou: z.coerce.number().int().nonnegative(),
  openConversations: z.coerce.number().int().nonnegative(),
  withAgent: z.coerce.number().int().nonnegative(),
});

export const activityProjectSummarySchema = z.object({
  artifactCount: z.coerce.number().int().nonnegative(),
  id: z.string(),
  lastActivityAt: z.string().nullable(),
  unresolved: z.coerce.number().int().nonnegative(),
});
```

SQLite repository (after `listActivity`). Add `ActivitySummary`, `buildSummaryStatements`, `activitySummaryTotalsSchema` and `activityProjectSummarySchema` to the imports.

```ts
  summarizeActivity(projectIds: readonly string[]): Promise<ActivitySummary> {
    return Promise.resolve().then(() => {
      const {projects, totals} = buildSummaryStatements(
        "sqlite",
        projectIds,
        this.#installationId,
      );
      const total = activitySummaryTotalsSchema.parse(
        this.#database.prepare(totals.text).get(...totals.values),
      );
      return {
        ...total,
        projects: z.array(activityProjectSummarySchema).parse(
          this.#database.prepare(projects.text).all(...projects.values),
        ),
      };
    });
  }
```

Postgres repository:

```ts
  async summarizeActivity(projectIds: readonly string[]): Promise<ActivitySummary> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const {projects, totals} = buildSummaryStatements(
        "postgres",
        projectIds,
        installationId,
      );
      const totalRows = yield* sql.unsafe<object>(totals.text, [...totals.values]);
      const projectRows = yield* sql.unsafe<object>(projects.text, [...projects.values]);
      return {
        ...activitySummaryTotalsSchema.parse(totalRows[0]),
        projects: z.array(activityProjectSummarySchema).parse(projectRows),
      };
    }));
  }
```

D1 repository property:

```ts
    summarizeActivity: async (projectIds: readonly string[]): Promise<ActivitySummary> => {
      const {projects, totals} = buildSummaryStatements("sqlite", projectIds, installationId);
      const [totalResult, projectResult] = await database.batch([
        database.prepare(totals.text).bind(...totals.values),
        database.prepare(projects.text).bind(...projects.values),
      ]);
      return {
        ...activitySummaryTotalsSchema.parse(totalResult?.results[0]),
        projects: z.array(activityProjectSummarySchema).parse(projectResult?.results ?? []),
      };
    },
```

- [ ] **Step 4: Add the service method, adapter and route**

In `src/application/activity.ts`:

- Add `ActivitySummary` to the ports import.
- Add `summarizeActivity` to `ActivityPersistence`:

```ts
  readonly summarizeActivity: (
    projectIds: readonly string[],
  ) => Effect.Effect<ActivitySummary, ArtifactRepositoryFailure>;
```

- Add `summary` to `ActivityOperations`:

```ts
  readonly summary: (
    principal: Principal,
    projectIds: readonly string[],
  ) => Effect.Effect<ActivitySummary, ActivityFailure>;
```

- Add the implementation inside `makeActivityService` and return `{list, summary}`:

```ts
  const summary = Effect.fn("ActivityService.summary")(function*(
    principal: Principal,
    projectIds: readonly string[],
  ) {
    yield* authorization.requireArtifactListing(principal);
    return yield* dependencies.persistence.summarizeActivity(projectIds);
  });
```

In `src/local/create-local-application-layer.ts`, add to the `persistence` object of `activityLayer`:

```ts
      summarizeActivity: (projectIds) =>
        Effect.tryPromise({
          try: () => adapters.repository.summarizeActivity(projectIds),
          catch: (cause) => repositoryFailure("summarizeActivity", cause),
        }),
```

In `src/http/create-http-app.ts`, after the `/api/v1/activity` route:

```ts
  app.get("/api/v1/activity/summary", async (context) => {
    const projectIds = z.array(projectIdSchema).max(maximumActivityProjectFilters)
      .parse(context.req.queries("project") ?? []);
    const summary = await runHttpApplicationEffect(
      context,
      dependencies,
      ActivityService.use((activity) =>
        activity.summary(context.get("principal"), projectIds)
      ),
    );
    return context.json(summary);
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/conformance/act-004-activity-summary.test.ts tests/conformance/act-003-activity-feed.test.ts`
Expected: PASS (13 tests).

Run: `pnpm typecheck && pnpm --dir deploy/cloudflare typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/core/ports.ts src/storage/activity-sql.ts \
  src/storage/sqlite-artifact-repository.ts src/storage/postgres-artifact-repository.ts \
  deploy/cloudflare/src/d1-artifact-repository.ts src/application/activity.ts \
  src/local/create-local-application-layer.ts src/http/create-http-app.ts \
  tests/conformance/act-004-activity-summary.test.ts
git commit -m "$(cat <<'EOF'
Count waiting conversations for the activity summary

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4.4: Hostile feed and summary requests

These tests prove ACT-003-F at the protocol boundary: forged cursors, bounds, unknown IDs and authority. If a bound is missing, fix it in `activityQuerySchema` or the summary route.

**Files:**
- Test: `tests/conformance/act-003-activity-feed.test.ts` (new `describe("hostile activity requests")`)
- Modify (only if a test fails): `src/http/create-http-app.ts`

**Interfaces:**
- Consumes: Task 4.1's route and Task 4.3's route.
- Produces: none.

- [ ] **Step 1: Write the tests**

Append to `tests/conformance/act-003-activity-feed.test.ts`:

```ts
describe("hostile activity requests", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let reader: ApiClient;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    reader = new ApiClient(server, installation.apiToken);
    await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<p>hostile</p>",
      idempotencyKey: "feed-hostile-seed",
      name: "Hostile seed",
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  const failureSchema = z.object({
    error: z.object({code: z.string(), message: z.string()}).strict(),
  }).strict();

  test.each([
    ["a malformed cursor", "?cursor=not*base64"],
    ["a cursor with extra fields", `?cursor=${Buffer.from(JSON.stringify({createdAt: "2026-01-01T00:00:00.000Z", id: "x", role: "admin"})).toString("base64url")}`],
    ["a limit above the maximum", "?limit=101"],
    ["a zero limit", "?limit=0"],
    ["a non-numeric limit", "?limit=ten"],
    ["an overlong search", `?q=${"a".repeat(101)}`],
    ["an unknown type", "?type=secrets"],
    ["an unknown segment", "?segment=everyone"],
    ["a path-shaped project", `?project=${encodeURIComponent("../../etc")}`],
    ["too many projects", `?${Array.from({length: 51}, (_, i) => `project=prj_${i}`).join("&")}`],
  ])("ACT-003-F: the feed refuses %s with INVALID_INPUT", async (_label, query) => {
    expect.hasAssertions();
    const response = await reader.fetch(`/api/v1/activity${query}`);
    expect(response.status).toBe(422);
    expect(failureSchema.parse(await response.json()).error.code).toBe("INVALID_INPUT");
  });

  test("ACT-003: a well-formed forged cursor pages safely and cannot inject SQL", async () => {
    expect.hasAssertions();
    const forged = Buffer.from(JSON.stringify({
      createdAt: "9999-12-31T00:00:00.000Z' OR '1'='1",
      id: "zzzz\"; DROP TABLE actions; --",
    })).toString("base64url");
    const response = await reader.fetch(`/api/v1/activity?cursor=${forged}`);
    expect(response.status).toBe(200);
    expect(activityPageSchema.parse(await response.json()).items.length).toBeGreaterThan(0);
    expect((await readFeed(reader, "")).items.length).toBeGreaterThan(0);
  });

  test("ACT-003: unknown projects disclose nothing", async () => {
    expect.hasAssertions();
    expect(await readFeed(reader, "?project=prj_never_created")).toEqual({
      items: [],
      nextCursor: null,
    });
    const summary = await reader.fetch("/api/v1/activity/summary?project=prj_never_created");
    expect(summary.status).toBe(200);
  });

  test("ACT-003: anonymous and capability-less callers are refused", async () => {
    expect.hasAssertions();
    expect((await fetch(`${server.baseUrl}/api/v1/activity`)).status).toBe(401);
    expect((await fetch(`${server.baseUrl}/api/v1/activity/summary`)).status).toBe(401);
    const administrator = await signInAdministrator(server, installation);
    const connectOnly = new ApiClient(
      server,
      await issueApiKey(server, administrator, ["agent:connect"], "Connect only"),
    );
    expect((await connectOnly.fetch("/api/v1/activity")).status).toBe(403);
    expect((await connectOnly.fetch("/api/v1/activity/summary")).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `pnpm exec vitest run tests/conformance/act-003-activity-feed.test.ts -t "hostile activity requests"`
Expected: PASS (13 tests).

If "a cursor with extra fields" passes with 200, `pageCursorSchema` lost its `.strict()` at `create-http-app.ts:409`; restore `.strict()`. If "too many projects" passes, `activityQuerySchema.project` is missing `.max(maximumActivityProjectFilters)`.

- [ ] **Step 3: Commit**

```bash
git add tests/conformance/act-003-activity-feed.test.ts src/http/create-http-app.ts
git commit -m "$(cat <<'EOF'
Prove hostile activity requests fail safely

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4.5: Postgres activity read model

This task proves `listActivity` and `summarizeActivity` against real Postgres, including installation isolation between two installations sharing one database.

**Files:**
- Create: `tests/integration/postgres-activity-feed.test.ts`
- Modify: `tests/configs/vitest.external-storage.config.ts` (add the file to `include`)
- Modify (only if a test fails): `src/storage/activity-sql.ts`, `src/storage/postgres-artifact-repository.ts`

**Interfaces:**
- Consumes: `PostgresArtifactRepository.open(database, installationId)`, `PostgresDatabase.inspect/open` and the repository commands `commitNewArtifact`, `createThread` and `createReply`.
- Produces: none.

- [ ] **Step 1: Write the test**

Create `tests/integration/postgres-activity-feed.test.ts`. The seeding helpers mirror `tests/integration/postgres-version-pagination.test.ts:23-123`, parameterized by artifact ID.

```ts
import {createHash, randomUUID} from "node:crypto";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {defaultProjectId} from "../../src/core/model.js";
import type {ActivityQuery, PublicationSource} from "../../src/core/ports.js";
import {createManifest} from "../../src/manifest/create-manifest.js";
import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";

const principalId = "member_activity_pg";
const author = {
  authorizedByPrincipalId: null,
  displayName: "Dana Okonkwo",
  principalId,
  principalKind: "human" as const,
};

function readDatabaseUrl(): string {
  const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  if (databaseUrl === undefined) {
    throw new Error("Run this test through pnpm test:external-storage-runtime.");
  }
  return databaseUrl;
}

function query(overrides: Partial<ActivityQuery> = {}): ActivityQuery {
  return {
    cursor: null,
    includeAdministration: false,
    limit: 30,
    projectIds: [],
    search: null,
    segment: "all",
    types: [],
    ...overrides,
  };
}

async function publishArtifact(
  repository: PostgresArtifactRepository,
  artifactId: string,
  name: string,
  createdAt: string,
) {
  const uploadId = `upl_${artifactId}`;
  const bytes = new TextEncoder().encode(`<p>${name}</p>`);
  const manifest = createManifest({
    entryPath: "index.html",
    files: [{
      mediaType: "text/html",
      path: "index.html",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    }],
    routingMode: "static",
  });
  const files = manifest.entries.map((entry) => ({
    entry,
    storageToken: `token-${uploadId}-${entry.sha256}`,
  }));
  await repository.createStagedUpload({
    createdAt,
    expiresAt: "2099-12-31T00:00:00.000Z",
    files,
    id: uploadId,
    idempotencyKey: null,
    manifest,
    principalId,
    projectId: defaultProjectId,
  });
  await Promise.all(files.map((file) =>
    repository.markStagedFileUploaded(
      defaultProjectId,
      uploadId,
      principalId,
      file.storageToken,
      createdAt,
    )
  ));
  const leaseExpiresAt = new Date(Date.parse(createdAt) + 600_000).toISOString();
  await repository.claimUploadPreparation(uploadId, createdAt, leaseExpiresAt);
  await Promise.all(files.map((file) =>
    repository.recordStagedFileInstalled(uploadId, file.storageToken, 1, createdAt)
  ));
  await repository.writePreparedManifestEntries(uploadId, 1, manifest.entries);
  await repository.markUploadPrepared(uploadId, 1, createdAt);
  const source: PublicationSource = {
    kind: "staged_upload",
    principalId,
    projectId: defaultProjectId,
    uploadId,
  };
  return repository.commitNewArtifact({
    accessSetting: "account_required",
    artifactId,
    authorizedByPrincipalId: null,
    contentToken: `content-${uploadId}`,
    createdAt,
    idempotencyKey: `publish-${uploadId}`,
    inputDigest: `digest-${uploadId}`,
    manifest,
    name,
    principalId,
    projectId: defaultProjectId,
    source,
    tags: [],
    versionId: `ver_${artifactId}`,
  });
}

describe("Postgres activity read model", () => {
  const scratch = `artifact_activity_${randomUUID().replaceAll("-", "")}`;
  let maintenance: PostgresDatabase;
  let database: PostgresDatabase;
  let first: PostgresArtifactRepository;
  let second: PostgresArtifactRepository;

  beforeEach(async () => {
    maintenance = await PostgresDatabase.inspect({url: Redacted.make(readDatabaseUrl())});
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`CREATE DATABASE ${scratch}`);
    }));
    const scratchUrl = new URL(readDatabaseUrl());
    scratchUrl.pathname = `/${scratch}`;
    database = await PostgresDatabase.open({url: Redacted.make(scratchUrl.toString())}, "apply");
    first = await PostgresArtifactRepository.open(database, `activity-a-${randomUUID()}`);
    second = await PostgresArtifactRepository.open(database, `activity-b-${randomUUID()}`);
  });

  afterEach(async () => {
    await database.close();
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    }));
    await maintenance.close();
  });

  test("ACT-003: Postgres folds threads, pages without duplicates and searches literally", async () => {
    const published = await publishArtifact(first, "art_pg_feed", "Stage bar 100%", "2026-10-01T10:00:00.000Z");
    const thread = await first.createThread({
      anchor: null,
      artifactId: published.artifact.id,
      author,
      body: "Opening note",
      createdAt: "2026-10-01T10:01:00.000Z",
      id: "cmt_pg_thread",
      idempotencyKey: "pg-thread",
      installationId: published.artifact.installationId,
      path: null,
      projectId: defaultProjectId,
      versionId: published.version.id,
    });
    for (const [index, minute] of ["02", "03", "04"].entries()) {
      await first.createReply({
        artifactId: published.artifact.id,
        author,
        body: `reply ${index}`,
        createdAt: `2026-10-01T10:${minute}:00.000Z`,
        id: `rpl_pg_${index}`,
        idempotencyKey: `pg-reply-${index}`,
        projectId: defaultProjectId,
        threadId: thread.thread.id,
      });
    }

    const page = await first.listActivity(query({types: ["comments", "versions"]}));
    expect(page.items.map((row) => row.action.action)).toEqual(["comment_reply", "publish"]);
    expect(page.items[0]?.thread?.replyCount).toBe(3);
    expect(page.items[0]?.thread?.replies.map((reply) => reply.body))
      .toEqual(["reply 1", "reply 2"]);
    expect(page.items[0]?.thread?.state).toBe("needs_you");

    const firstPage = await first.listActivity(query({limit: 1, types: ["comments", "versions"]}));
    const secondPage = await first.listActivity(query({
      cursor: firstPage.nextCursor,
      limit: 1,
      types: ["comments", "versions"],
    }));
    expect([...firstPage.items, ...secondPage.items].map((row) => row.action.id))
      .toEqual(page.items.map((row) => row.action.id));

    expect((await first.listActivity(query({search: "100%"}))).items
      .some((row) => row.artifact?.name === "Stage bar 100%")).toBe(true);
    expect((await first.listActivity(query({search: "%"}))).items
      .every((row) => row.artifact?.name === "Stage bar 100%")).toBe(true);

    const summary = await first.summarizeActivity([]);
    expect(summary).toMatchObject({needsYou: 1, openConversations: 1, withAgent: 0});
  });

  test("ACT-003: Postgres never returns another installation's activity", async () => {
    await publishArtifact(first, "art_pg_a", "Installation A artifact", "2026-10-01T10:00:00.000Z");
    await publishArtifact(second, "art_pg_b", "Installation B artifact", "2026-10-01T10:00:00.000Z");

    const firstFeed = await first.listActivity(query({types: ["versions"]}));
    const secondFeed = await second.listActivity(query({types: ["versions"]}));
    expect(firstFeed.items.map((row) => row.artifact?.name)).toEqual(["Installation A artifact"]);
    expect(secondFeed.items.map((row) => row.artifact?.name)).toEqual(["Installation B artifact"]);

    const firstSummary = await first.summarizeActivity([]);
    expect(firstSummary.projects.map((project) => project.artifactCount)).toEqual([1]);
  });
});
```

If Slice 2 added a required actor field to `CommitNewArtifact`, `CreateCommentThread` or `CreateCommentReply` (check its Task 2.x **Produces** block), pass `actor: {displayName: "Dana Okonkwo", kind: "human"}` in each call above. If Slice 2 derives the actor from `author` and `principalId`, change nothing.

Add `"tests/integration/postgres-activity-feed.test.ts",` to the `include` array in `tests/configs/vitest.external-storage.config.ts`, keeping alphabetical order.

- [ ] **Step 2: Run the test**

Run: `pnpm test:external-storage-runtime`
Expected: PASS, including the two new tests. This requires Docker; the script starts pinned Postgres and MinIO.

If the fold test fails with Postgres reporting `operator does not exist: text > text` or a type error on `substr`, check that every `created_at` comparison in `buildListActivityStatement` compares `TEXT` to `TEXT`. The columns are `TEXT` in `postgres-migrations.ts`. If `artifactArchived` parses as a string, change the `CASE` to `CAST(… AS INTEGER)` in the builder.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/postgres-activity-feed.test.ts tests/configs/vitest.external-storage.config.ts \
  src/storage/activity-sql.ts src/storage/postgres-artifact-repository.ts
git commit -m "$(cat <<'EOF'
Prove the activity read model on Postgres with installation isolation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4.6: D1 activity read model

**Files:**
- Create: `deploy/cloudflare/tests/d1-activity-feed.test.ts`
- Modify (only if a test fails): `deploy/cloudflare/src/d1-artifact-repository.ts`, `src/storage/activity-sql.ts`

**Interfaces:**
- Consumes: `createD1ArtifactRepository(binding, installationId)`, `migrateD1(binding, installationId)` and `getPlatformProxy` from `wrangler`.
- Produces: none.

- [ ] **Step 1: Write the test**

Create `deploy/cloudflare/tests/d1-activity-feed.test.ts`:

```ts
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";
import {getPlatformProxy} from "wrangler";

import {defaultProjectId} from "../../../src/core/model.js";
import type {ActivityQuery, PublicationSource} from "../../../src/core/ports.js";
import {createManifest} from "../../../src/manifest/create-manifest.js";
import {createD1ArtifactRepository} from "../src/d1-artifact-repository.js";
import {migrateD1} from "../src/d1-migrations.js";

const openLocalD1 = () => getPlatformProxy<{
  ARTIFACT_SERVER_D1_DATABASE: D1Database;
}>({
  configPath: fileURLToPath(new URL("../wrangler.git-store.test.jsonc", import.meta.url)),
  envFiles: [],
  persist: false,
  remoteBindings: false,
});

const principalId = "member_activity_d1";
const author = {
  authorizedByPrincipalId: null,
  displayName: "Dana Okonkwo",
  principalId,
  principalKind: "human" as const,
};

function query(overrides: Partial<ActivityQuery> = {}): ActivityQuery {
  return {
    cursor: null,
    includeAdministration: false,
    limit: 30,
    projectIds: [],
    search: null,
    segment: "all",
    types: [],
    ...overrides,
  };
}

async function publishArtifact(
  store: ReturnType<typeof createD1ArtifactRepository>,
  artifactId: string,
  createdAt: string,
) {
  const uploadId = `upl_${artifactId}`;
  const bytes = new TextEncoder().encode(`<p>${artifactId}</p>`);
  const manifest = createManifest({
    entryPath: "index.html",
    files: [{
      mediaType: "text/html",
      path: "index.html",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    }],
    routingMode: "static",
  });
  const files = manifest.entries.map((entry) => ({
    entry,
    storageToken: `token-${uploadId}-${entry.sha256}`,
  }));
  await store.createStagedUpload({
    createdAt,
    expiresAt: "2099-12-31T00:00:00.000Z",
    files,
    id: uploadId,
    idempotencyKey: null,
    manifest,
    principalId,
    projectId: defaultProjectId,
  });
  await Promise.all(files.map((file) =>
    store.markStagedFileUploaded(defaultProjectId, uploadId, principalId, file.storageToken, createdAt)
  ));
  await store.claimUploadPreparation(
    uploadId,
    createdAt,
    new Date(Date.parse(createdAt) + 600_000).toISOString(),
  );
  await Promise.all(files.map((file) =>
    store.recordStagedFileInstalled(uploadId, file.storageToken, 1, createdAt)
  ));
  await store.writePreparedManifestEntries(uploadId, 1, manifest.entries);
  await store.markUploadPrepared(uploadId, 1, createdAt);
  const source: PublicationSource = {
    kind: "staged_upload",
    principalId,
    projectId: defaultProjectId,
    uploadId,
  };
  return store.commitNewArtifact({
    accessSetting: "account_required",
    artifactId,
    authorizedByPrincipalId: null,
    contentToken: `content-${uploadId}`,
    createdAt,
    idempotencyKey: `publish-${uploadId}`,
    inputDigest: `digest-${uploadId}`,
    manifest,
    name: `D1 ${artifactId}`,
    principalId,
    projectId: defaultProjectId,
    source,
    tags: [],
    versionId: `ver_${artifactId}`,
  });
}

describe("D1 activity read model", () => {
  it("ACT-003: D1 folds threads, filters by project and counts waiting conversations", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-activity-feed";
    try {
      await migrateD1(binding, installationId);
      const store = createD1ArtifactRepository(binding, installationId);
      const published = await publishArtifact(store, "art_d1_feed", "2026-10-01T10:00:00.000Z");
      const thread = await store.createThread({
        anchor: null,
        artifactId: published.artifact.id,
        author,
        body: "Opening note",
        createdAt: "2026-10-01T10:01:00.000Z",
        id: "cmt_d1_thread",
        idempotencyKey: "d1-thread",
        installationId,
        path: null,
        projectId: defaultProjectId,
        versionId: published.version.id,
      });
      for (const [index, minute] of ["02", "03", "04"].entries()) {
        await store.createReply({
          artifactId: published.artifact.id,
          author,
          body: `reply ${index}`,
          createdAt: `2026-10-01T10:${minute}:00.000Z`,
          id: `rpl_d1_${index}`,
          idempotencyKey: `d1-reply-${index}`,
          projectId: defaultProjectId,
          threadId: thread.thread.id,
        });
      }

      const page = await store.listActivity(query({types: ["comments", "versions"]}));
      expect(page.items.map((row) => row.action.action)).toEqual(["comment_reply", "publish"]);
      expect(page.items[0]?.thread?.replies.map((reply) => reply.body))
        .toEqual(["reply 1", "reply 2"]);

      const scoped = await store.listActivity(query({projectIds: ["prj_absent"]}));
      expect(scoped.items).toEqual([]);

      const summary = await store.summarizeActivity([]);
      expect(summary).toMatchObject({needsYou: 1, openConversations: 1, withAgent: 0});
    } finally {
      await proxy.dispose();
    }
  });
});
```

The same note about Slice 2 actor fields from Task 4.5 Step 1 applies here.

- [ ] **Step 2: Run the test**

Run: `pnpm --dir deploy/cloudflare exec vitest run tests/d1-activity-feed.test.ts`
Expected: PASS (1 test).

Then run `pnpm --dir deploy/cloudflare check` and expect exit 0 (lint, typecheck, full D1 suite).

- [ ] **Step 3: Commit**

```bash
git add deploy/cloudflare/tests/d1-activity-feed.test.ts \
  deploy/cloudflare/src/d1-artifact-repository.ts src/storage/activity-sql.ts
git commit -m "$(cat <<'EOF'
Prove the activity read model on D1

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4.7: Web API client and wire contract

The web parses the feed with zod schemas that live in an importable module. The server conformance suite parses real responses with those exact schemas, so client and server cannot drift.

**Files:**
- Create: `apps/web/src/api/activity-contract.ts`
- Modify: `apps/web/src/api/client.ts` (import the schemas, add `api.listActivity` and `api.activitySummary`, re-export the types)
- Create: `tests/client/activity-contract.test.ts`

**Interfaces:**
- Consumes: `GET /api/v1/activity` and `GET /api/v1/activity/summary`.
- Produces:
  - `activityEntrySchema`, `activityPageSchema`, `activitySummarySchema`, `ActivityEntry`, `ActivityPageResponse`, `ActivitySummary`, `ActivityType`, `ActivitySegment` and `ActivityListParams` in `apps/web/src/api/activity-contract.ts`.
  - `api.listActivity(params: ActivityListParams): Promise<ActivityPageResponse>` and `api.activitySummary(projects?: readonly string[]): Promise<ActivitySummary>` in `apps/web/src/api/client.ts`.
  - `activityQueryString(params): string`, exported from the contract module for reuse by `use-activity-feed.ts` in Slice 5.

- [ ] **Step 1: Write the failing contract test**

Create `tests/client/activity-contract.test.ts`:

```ts
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  activityPageSchema,
  activityQueryString,
  activitySummarySchema,
} from "../../apps/web/src/api/activity-contract.js";
import {ApiClient, MutableClock} from "../support/agent-dispatch.js";
import {publishNew} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

describe("web activity contract", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let clock: MutableClock;

  beforeEach(async () => {
    installation = await createTestInstallation();
    clock = new MutableClock("2026-10-01T12:00:00.000Z");
    server = await startTestServer(installation, {clock});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("ACT-003: the web schemas parse real feed and summary responses", async () => {
    expect.hasAssertions();
    const reader = new ApiClient(server, installation.apiToken);
    const published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<p>contract</p>",
      idempotencyKey: "contract-publish",
      name: "Contract target",
    })).body;
    clock.advance(1_000);
    await reader.openThread(published, "Contract note", "contract-thread");

    const query = activityQueryString({
      projects: [published.artifact.projectId],
      segment: "all",
      types: ["comments", "versions"],
    });
    expect(query).toBe(
      `?project=${published.artifact.projectId}&type=comments&type=versions&segment=all`,
    );
    const page = activityPageSchema.parse(
      await (await reader.fetch(`/api/v1/activity${query}`)).json(),
    );
    expect(page.items.map((entry) => entry.kind)).toEqual(["thread", "version"]);

    const summary = activitySummarySchema.parse(
      await (await reader.fetch("/api/v1/activity/summary")).json(),
    );
    expect(summary.needsYou).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/client/activity-contract.test.ts`
Expected: FAIL with `Cannot find module '../../apps/web/src/api/activity-contract.js'`.

- [ ] **Step 3: Create the contract module**

Create `apps/web/src/api/activity-contract.ts`:

```ts
import { z } from "zod";

const accessSettingSchema = z.enum(["account_required", "public_link"]);
const principalKindSchema = z.enum(["human", "service"]);
const dispatchStateSchema = z.enum([
  "addressed",
  "canceled",
  "claimed",
  "delivered",
  "failed",
  "queued",
]);

export const activityTypes = ["comments", "versions", "agents", "access", "admin"] as const;
export const activitySegments = ["all", "needs_you", "with_agent"] as const;
export type ActivityType = (typeof activityTypes)[number];
export type ActivitySegment = (typeof activitySegments)[number];

const wireCommentSchema = z.object({
  author: z.object({ kind: principalKindSchema, name: z.string() }),
  body: z.string(),
  createdAt: z.string(),
  id: z.string(),
});

export const activityEntrySchema = z.object({
  access: z.object({ from: accessSettingSchema.nullable(), to: accessSettingSchema }).optional(),
  actor: z.object({ kind: principalKindSchema.nullable(), name: z.string().nullable() }),
  agent: z.object({
    dispatchState: dispatchStateSchema,
    name: z.string(),
    threadIds: z.array(z.string()),
  }).optional(),
  artifact: z.object({ archived: z.boolean(), id: z.string(), name: z.string() }).nullable(),
  at: z.string(),
  excerpt: z.string().optional(),
  id: z.string(),
  kind: z.enum(["thread", "version", "resolution", "thread_deleted", "agent", "access", "admin"]),
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
  subject: z.object({ id: z.string(), name: z.string().nullable() }).optional(),
  thread: z.object({
    anchor: z.json().nullable(),
    id: z.string(),
    isResolved: z.boolean(),
    opener: wireCommentSchema,
    replies: z.array(wireCommentSchema),
    replyCount: z.number().int().nonnegative(),
    state: z.enum(["needs_you", "with_agent", "resolved"]),
  }).optional(),
  threadId: z.string().optional(),
  verb: z.string(),
  versionNumber: z.number().int().positive().nullable(),
});

export const activityPageSchema = z.object({
  items: z.array(activityEntrySchema),
  nextCursor: z.string().nullable(),
});

export const activitySummarySchema = z.object({
  artifactsInReview: z.number().int().nonnegative(),
  needsYou: z.number().int().nonnegative(),
  openConversations: z.number().int().nonnegative(),
  projects: z.array(z.object({
    artifactCount: z.number().int().nonnegative(),
    id: z.string(),
    lastActivityAt: z.string().nullable(),
    unresolved: z.number().int().nonnegative(),
  })),
  withAgent: z.number().int().nonnegative(),
});

export type ActivityEntry = z.infer<typeof activityEntrySchema>;
export type ActivityPageResponse = z.infer<typeof activityPageSchema>;
export type ActivitySummary = z.infer<typeof activitySummarySchema>;

export interface ActivityListParams {
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly projects?: readonly string[];
  readonly q?: string;
  readonly segment?: ActivitySegment;
  readonly types?: readonly ActivityType[];
}

/** Serialize feed parameters in a stable order; empty values are omitted. */
export function activityQueryString(params: ActivityListParams): string {
  const search = new URLSearchParams();
  for (const project of params.projects ?? []) search.append("project", project);
  for (const type of params.types ?? []) search.append("type", type);
  if (params.segment !== undefined) search.set("segment", params.segment);
  const q = params.q?.trim() ?? "";
  if (q !== "") search.set("q", q);
  if (params.cursor !== undefined && params.cursor !== null) search.set("cursor", params.cursor);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  const serialized = search.toString();
  return serialized === "" ? "" : `?${serialized}`;
}
```

In `apps/web/src/api/client.ts`, add after the existing `./bounded-text` import:

```ts
import {
  activityPageSchema,
  type ActivityListParams,
  activityQueryString,
  activitySummarySchema,
} from "./activity-contract";

export type {
  ActivityEntry,
  ActivityListParams,
  ActivityPageResponse,
  ActivitySegment,
  ActivitySummary,
  ActivityType,
} from "./activity-contract";
```

Add these two members inside `export const api = {` immediately after `session: …`:

```ts
  listActivity: (params: ActivityListParams) =>
    request(activityPageSchema, `/api/v1/activity${activityQueryString(params)}`),
  activitySummary: (projects: readonly string[] = []) =>
    request(
      activitySummarySchema,
      `/api/v1/activity/summary${activityQueryString({ projects })}`,
    ),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/client/activity-contract.test.ts`
Expected: PASS (1 test).

Run: `pnpm --filter @artifact-server/web exec tsc --noEmit -p .` and `pnpm lint`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/activity-contract.ts apps/web/src/api/client.ts tests/client/activity-contract.test.ts
git commit -m "$(cat <<'EOF'
Read the activity feed and summary from the web client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4.8: Bounded activity performance

This task measures the first feed page and the summary over 100k actions locally, and adds the same reads to the two-process Postgres/MinIO baseline.

**Files:**
- Create: `project/performance/run-activity-feed-baseline.ts`
- Modify: `package.json` (script `perf:activity-feed`)
- Modify: `project/performance/external-storage-baseline.ts` (activity phases; report fields)
- Modify: `project/performance/FINDINGS.md` (record the measured result)
- Create (by running): `project/evidence/activity-feed-baseline.json`

**Interfaces:**
- Consumes: `createTestInstallation`, `startTestServer`, `publishNew`, `captureMeasurementContext` and the `runMeasured` pattern in `external-storage-baseline.ts:708`.
- Produces: `pnpm perf:activity-feed` and the report fields `activityFeed` and `activitySummary` in `ExternalStorageBaselineReport`.

- [ ] **Step 1: Write the baseline script**

Create `project/performance/run-activity-feed-baseline.ts`:

```ts
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {Command} from "commander";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
} from "../../tests/support/runtime-harness.js";
import {publishNew} from "../../tests/support/publishing.js";
import {captureMeasurementContext} from "./measurement-context.js";

const optionsSchema = z.object({
  actions: z.coerce.number().int().min(1_000).max(1_000_000),
  output: z.string().min(1),
  reads: z.coerce.number().int().min(10).max(2_000),
});

const program = new Command()
  .name("activity-feed-baseline")
  .description("Measure the first activity page and summary over a large action log.")
  .option("--actions <count>", "seeded actions", "100000")
  .option("--reads <count>", "measured reads per phase", "200")
  .option("--output <path>", "JSON report path", "project/evidence/activity-feed-baseline.json");

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return Math.round((sorted[Math.max(0, index)] ?? 0) * 100) / 100;
}

async function measure(reads: number, read: () => Promise<void>) {
  const samples: number[] = [];
  for (let index = 0; index < reads; index += 1) {
    const startedAt = performance.now();
    await read();
    samples.push(performance.now() - startedAt);
  }
  const sorted = samples.toSorted((left, right) => left - right);
  return {
    count: reads,
    p50Milliseconds: percentile(sorted, 0.5),
    p95Milliseconds: percentile(sorted, 0.95),
    p99Milliseconds: percentile(sorted, 0.99),
  };
}

async function main(): Promise<void> {
  program.parse();
  const options = optionsSchema.parse(program.opts());
  const installation = await createTestInstallation();
  const server = await startTestServer(installation);
  try {
    const published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<p>activity feed baseline</p>",
      idempotencyKey: "activity-feed-baseline",
      name: "Activity feed baseline target",
    })).body;
    const seedStartedAt = performance.now();
    const database = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
      {timeout: 30_000},
    );
    try {
      database.exec("BEGIN IMMEDIATE");
      const thread = database.prepare(`INSERT INTO comment_threads (
          id, installation_id, project_id, artifact_id, version_id, path, anchor_json,
          body, state, author_principal_id, author_principal_kind, author_display_name,
          author_authorized_by_principal_id, idempotency_key, created_at, updated_at
        ) VALUES (?, 'local', ?, ?, ?, NULL, NULL, ?, 'open', 'perf-member', 'human',
          'Perf Member', NULL, ?, ?, ?)`);
      const action = database.prepare(`INSERT INTO actions (
          id, project_id, artifact_id, version_id, action, principal_id,
          authorized_by_principal_id, idempotency_key, created_at,
          thread_id, actor_name, actor_kind
        ) VALUES (?, ?, ?, ?, ?, 'perf-member', NULL, ?, ?, ?, 'Perf Member', 'human')`);
      const base = Date.parse("2026-01-01T00:00:00.000Z");
      for (let index = 0; index < options.actions; index += 1) {
        const at = new Date(base + index * 1_000).toISOString();
        const threadId = `perf_thread_${Math.floor(index / 5)}`;
        if (index % 5 === 0) {
          thread.run(
            threadId,
            published.artifact.projectId,
            published.artifact.id,
            published.version.id,
            `Perf thread ${index}`,
            `perf-thread-${index}`,
            at,
            at,
          );
        }
        action.run(
          `perf_action_${index}`,
          published.artifact.projectId,
          published.artifact.id,
          published.version.id,
          index % 5 === 0 ? "comment_create" : index % 5 === 4 ? "publish" : "comment_reply",
          `perf-action-${index}`,
          at,
          index % 5 === 4 ? null : threadId,
        );
      }
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    const seedMilliseconds = performance.now() - seedStartedAt;
    const headers = {Authorization: `Bearer ${installation.apiToken}`};
    const firstPage = await measure(options.reads, async () => {
      const response = await fetch(`${server.baseUrl}/api/v1/activity?limit=30`, {headers});
      if (response.status !== 200) throw new Error(`Feed answered ${response.status}.`);
      await response.arrayBuffer();
    });
    const summary = await measure(options.reads, async () => {
      const response = await fetch(`${server.baseUrl}/api/v1/activity/summary`, {headers});
      if (response.status !== 200) throw new Error(`Summary answered ${response.status}.`);
      await response.arrayBuffer();
    });
    const report = {
      ...(await captureMeasurementContext()),
      completedAt: new Date().toISOString(),
      configuration: options,
      firstPage,
      note: "First activity page (30 entries, latest-per-thread folding) and summary over a seeded SQLite action log: one row in five opens a thread, three reply, one publishes. Seeding time is excluded from the measured phases.",
      seedMilliseconds: Math.round(seedMilliseconds),
      summary,
    };
    await mkdir(path.dirname(options.output), {recursive: true});
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({firstPage, summary})}\n`);
  } finally {
    await server.stop();
    await removeTestInstallation(installation);
  }
}

await main();
```

The seed writes `comment_threads` and `actions` directly through a second connection to the installation's own database file. The same technique is used by `tests/conformance/cmt-011-comment-action-ledger.test.ts:380`. It is used here only to reach 100k rows in seconds rather than hours of HTTP traffic. If Slice 2 made any other `actions` column `NOT NULL`, add it to the `INSERT` with the value Slice 2 writes for that kind.

Add `"perf:activity-feed": "node --import tsx project/performance/run-activity-feed-baseline.ts",` to `package.json` scripts, after `"perf:comment-polling"`.

- [ ] **Step 2: Run the local baseline**

Run: `pnpm perf:activity-feed`
Expected: exit 0, printing `{"firstPage":{…},"summary":{…}}` and writing `project/evidence/activity-feed-baseline.json`.

There is no hard timing gate (Global Constraints: no tightening from one laptop run). If `firstPage.p95Milliseconds` exceeds 250 ms, add `CREATE INDEX IF NOT EXISTS actions_thread_created ON actions (thread_id, created_at DESC, id DESC)` to Slice 2's SQLite migration owner. Do the same in the Postgres migration (with `installation_id` leading) and in the D1 migration. Then re-run, and record both runs in `FINDINGS.md`.

- [ ] **Step 3: Add activity phases to the external-storage baseline**

In `project/performance/external-storage-baseline.ts`:

Add these fields to `ExternalStorageBaselineReport`, after `artifactList`:

```ts
  readonly activityFeed: ExternalStorageOperationSummary;
  readonly activitySummary: ExternalStorageOperationSummary;
```

After the `artifactLists` phase (line ~313), add:

```ts
    const activityFeeds = await runMeasured(
      configuration.listReads,
      configuration.operationConcurrency,
      async (index) => {
        const server = initialProcesses[index % initialProcesses.length] ?? first;
        await assertActivityRead(server, apiToken, "/api/v1/activity?limit=30");
      },
    );
    const activitySummaries = await runMeasured(
      configuration.listReads,
      configuration.operationConcurrency,
      async (index) => {
        const server = initialProcesses[index % initialProcesses.length] ?? first;
        await assertActivityRead(server, apiToken, "/api/v1/activity/summary");
      },
    );
```

Add `activityFeed: activityFeeds.summary,` and `activitySummary: activitySummaries.summary,` to `reportWithoutWarnings`, after `artifactList`. Add the helper next to `assertArtifactList`:

```ts
async function assertActivityRead(
  server: ExternalStorageProcess,
  apiToken: string,
  pathname: string,
): Promise<void> {
  const response = await fetch(`${server.baseUrl}${pathname}`, {
    headers: {Authorization: `Bearer ${apiToken}`},
  });
  if (response.status !== 200) {
    throw new Error(`An external-storage activity read returned ${response.status}.`);
  }
  await response.arrayBuffer();
}
```

- [ ] **Step 4: Run the external-storage baseline**

Run: `pnpm verify:external-storage-performance`
Expected: exit 0 (Docker required), with `activityFeed` and `activitySummary` present in the written report.

- [ ] **Step 5: Record the findings**

Append to `project/performance/FINDINGS.md`, replacing each `<measured>` with the value from `project/evidence/activity-feed-baseline.json` or the external-storage report written in Step 4. Do not round them away.

```markdown
## Activity feed read path (2026-10)

- Local SQLite, 100,000 actions (`pnpm perf:activity-feed`): first page p50 <measured> ms / p95 <measured> ms; summary p50 <measured> ms / p95 <measured> ms. Evidence: `project/evidence/activity-feed-baseline.json`.
- Two-process Postgres/MinIO (`pnpm verify:external-storage-performance`): activityFeed p95 <measured> ms; activitySummary p95 <measured> ms.
- Risk: latest-per-thread folding probes `actions.thread_id` per candidate row; the summary scans open threads per request. Revisit if open threads exceed 10,000 per installation.
```

- [ ] **Step 6: Commit**

```bash
git add project/performance/run-activity-feed-baseline.ts package.json \
  project/performance/external-storage-baseline.ts project/performance/FINDINGS.md \
  project/evidence/activity-feed-baseline.json
git commit -m "$(cat <<'EOF'
Measure activity feed and summary reads over a large action log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4.9: Ledger entries, product prose and slice verification

**Files:**
- Modify: `project/spec/artifact-server-product-spec.html` (an `activity` section)
- Modify: `project/spec/conformance.yml` (ACT-003, ACT-004)
- Modify: `project/evidence/local-foundation.json` (regenerated by `pnpm test`)

**Interfaces:**
- Consumes: every test ID added in Tasks 4.1–4.7.
- Produces: the ledger requirements `ACT-003` and `ACT-004`, citing `artifact-server-product-spec.html#activity`.

- [ ] **Step 1: Add the product prose**

Check whether an earlier slice already created the anchor:

```bash
grep -n 'id="activity"' project/spec/artifact-server-product-spec.html
```

If it prints nothing, insert this section immediately before the `<section class="section" id="sharing"` line. If it prints a line, append only the `<p>` elements inside that existing section's `section-heading` div.

```html
        <section class="section" id="activity" aria-labelledby="activity-title">
          <div class="section-heading">
            <span class="section-label">Activity</span>
            <h2 id="activity-title">One feed of what happened, and what waits on you</h2>
            <p>
              Every member can read one reverse-chronological feed of the installation built
              only from recorded actions: versions published and restored, conversations started
              and replied to, resolutions, agent dispatches and answers, public links enabled and
              disabled, and project changes. A conversation appears once, dated by its newest
              reply, with its opening comment and newest two replies. Every member sees who acted
              by display name; member and API key events are visible only to administrators.
            </p>
            <p>
              An open conversation that no active agent dispatch holds needs a person; one an
              active dispatch holds is with an agent. The feed filters by project, type, those two
              segments, and literal text search, pages by a stable cursor without gaps or
              duplicates, and a summary reports the waiting counts and each project's artifacts,
              open conversations and latest activity. Filters naming unknown projects match
              nothing rather than revealing whether a project exists.
            </p>
          </div>
        </section>
```

- [ ] **Step 2: Add the ledger entries**

In `project/spec/conformance.yml`, insert after `AUD-001`. If Slice 2 already inserted `ACT-001` and `ACT-002`, insert after `ACT-002` instead.

```yaml
  - id: ACT-003
    kind: behavior
    behavior: Members read one installation activity feed built from recorded actions, newest first, with one entry per conversation dated by its newest reply, type, project, segment and literal search filters, stable cursor paging, and administrator-only member and key events.
    owner: http-api
    source: {file: artifact-server-product-spec.html, anchor: activity}
    acceptance:
      behavior: {id: ACT-003-B, description: "Publish, comment, reply, dispatch, and admit through HTTP; read the feed newest first with actor names; observe one entry per thread carrying its newest two replies; filter by type, project, segment, and literal search; walk every page without gaps or duplicates on SQLite, Postgres, and D1; parse every response with the web client's schemas."}
      failure: {id: ACT-003-F, description: "Malformed or extended cursors, out-of-range limits, overlong searches, unknown types or segments, path-shaped or excessive project filters fail with INVALID_INPUT; forged well-formed cursors cannot inject SQL; unknown and other-installation projects return nothing; a thread replied to across a page boundary appears once; hostile comment text stays byte-exact; a demoted administrator loses member and key events on the next request; anonymous and capability-less callers are refused."}
    deployments: *all
    status: behavior_verified
    proof_gap: Local SQLite HTTP evidence, Postgres integration, and D1 repository evidence prove the read model. No team deployment or Cloudflare runtime evidence is recorded.
    depends_on: [ACT-001, AUD-001, PRJ-002, CMT-011]
    evidence:
      - deployment: local
        tests: [ACT-003-B, ACT-003-F]
        result: pass
        run: project/evidence/local-foundation.json
        recorded_at: "<ISO timestamp from the pnpm test run in Step 3>"

  - id: ACT-004
    kind: behavior
    behavior: The activity summary counts conversations that need a person and those with an agent per open thread, open conversations, artifacts in review, and each project's artifacts, open conversations, and latest activity.
    owner: http-api
    source: {file: artifact-server-product-spec.html, anchor: activity}
    acceptance:
      behavior: {id: ACT-004-B, description: "Open, dispatch, and resolve threads across two artifacts and read summary totals and per-project counts that equal the feed's segment entry counts."}
      failure: {id: ACT-004-F, description: "Resolved threads, threads on deleted artifacts, deleted threads, and threads whose dispatch was canceled are never counted as with an agent; unknown project filters return zero counts and no projects."}
    deployments: *all
    status: behavior_verified
    proof_gap: Local SQLite HTTP evidence plus Postgres and D1 repository evidence. No team deployment evidence is recorded.
    depends_on: [ACT-003, DSP-010]
    evidence:
      - deployment: local
        tests: [ACT-004-B, ACT-004-F]
        result: pass
        run: project/evidence/local-foundation.json
        recorded_at: "<ISO timestamp from the pnpm test run in Step 3>"
```

If `ACT-001` is not yet in the ledger (Slice 2 not merged), remove it from `depends_on`. `conformance:validate` rejects unknown IDs.

- [ ] **Step 3: Run the slice gates and record evidence**

Run, in order:

```bash
pnpm test
node -e "const r=require('./project/evidence/local-foundation.json');console.log(new Date(r.startTime).toISOString(), r.numFailedTests)"
```

Expected: `pnpm test` exits 0. The second command prints an ISO time and `0`. Paste that ISO time into both `recorded_at` fields.

```bash
pnpm conformance:validate
pnpm conformance:tests
pnpm check
pnpm smoke
pnpm test:external-storage-runtime
pnpm --dir deploy/cloudflare check
```

Expected: every command exits 0. `conformance:tests` finds `ACT-003-B`, `ACT-003-F`, `ACT-004-B` and `ACT-004-F` in test names.

If any command fails, keep the evidence `result: fail`, stop, and report the failing output. Do not mark `behavior_verified`.

- [ ] **Step 4: Commit**

```bash
git add project/spec/artifact-server-product-spec.html project/spec/conformance.yml \
  project/evidence/local-foundation.json
git commit -m "$(cat <<'EOF'
Attach activity feed and summary evidence to the ledger

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```
## Slice 5 — Navigation and the Activity screen

Spec §4 (Navigation), §5; requirements ACT-005 and NAV-001 (updated).

**Assumes:**
- Slice 1 vendored `apps/web/src/arkcase/review-ui/activity-ui.jsx`, `activity-model.js` and the new components (`Timeline`, `ScrollDock`, `MetricCard`, `AnnotationPin`, `SectionHeading`, `AutoGrid`, `StatusPill`, `Menu`) and re-synced `review-ui.jsx`. At Design `e087280`, `createReviewUI` spreads in `ActivityHeader`, `ActivityFeed` and `ActivityToolbar`, typed in `review-ui.d.ts`.
- Slice 4 delivered `api.listActivity`, `api.activitySummary` and the exported `ActivityEntry`, `ActivitySummary`, `ActivityType` and `ActivitySegment` types in `apps/web/src/api/client.ts`.

**Admin mode is unchanged here.** This slice keeps `ShellMode` and the admin navigation mode for `/review/settings/*`. Slice 7 replaces them with the Admin console. This slice only adds the review-mode Tools → Administration entry and makes the Administration entries administrator-only.

**Projects screen comes later.** Until slice 6, `/review/projects` renders the existing `ProjectSettings` for the selected project. That keeps a real screen behind every new link.

---

### Task 5.1: Activity, Projects and thread routes, plus nav-model groups

**Files:**
- Modify: `apps/web/src/review/review-routes.ts`
- Modify: `apps/web/src/review/review-routes.test.ts`
- Modify: `apps/web/src/review/settings/settings-view.ts`
- Modify: `apps/web/src/review/settings/settings-view.test.ts`
- Modify: `apps/web/src/shell/nav-model.ts`
- Modify: `apps/web/src/shell/nav-model.test.ts`
- Modify: `apps/web/src/shell/review-shell.tsx`
- Modify: `apps/web/src/shell/account-menu.tsx`
- Modify: `apps/web/src/shell/brand.tsx`
- Modify: `apps/web/src/review/settings/settings-screen.tsx`
- Modify: `apps/web/src/review/settings/project-settings.tsx`
- Modify: `apps/web/src/review/review-app.tsx`

**Interfaces:**
- Consumes: `ActivityType` and `ActivitySegment` from `@/api/client` (slice 4).
- Produces, all from `@/review/review-routes`:

```ts
export interface ActivityFilters {
  readonly projects: readonly string[];
  readonly q: string;
  readonly segment: ActivitySegment;   // "all" | "needs_you" | "with_agent"
  readonly types: readonly ActivityType[];
}
export const emptyActivityFilters: ActivityFilters;
export type ReviewRoute =
  | {readonly kind: "activity"; readonly filters: ActivityFilters}
  | {readonly kind: "projects"; readonly projectId: string | null}
  | {readonly kind: "settings"; readonly settings: SettingsRoute}
  | {readonly kind: "workspace"; readonly location: ReviewLocation}
  | {readonly kind: "library"; readonly projectId: string | null};
export function activityHref(filters?: ActivityFilters): string;   // replaces reviewQueueHref
export function readActivityFilters(search: URLSearchParams): ActivityFilters;
export function projectsHref(projectId: string | null): string;    // "/review/projects[?project=]"
// ReviewLocation gains: readonly threadId: string | null  (query key "thread")
```

- [ ] **Step 1: Write the failing route tests.** In `apps/web/src/review/review-routes.test.ts`:
  - Replace the import of `reviewQueueHref` with `activityHref`, `emptyActivityFilters`, `projectsHref` and `readActivityFilters`.
  - Add `threadId: null` to `emptyLocation`.
  - Replace the `parseReviewRoute` "bare /review" test and the "names the queue" test with these:

```ts
describe("activity route", () => {
  it("ACT-005: bare /review is Activity, and its filters round-trip through the URL", () => {
    expect(routeOf("/review")).toEqual({kind: "activity", filters: emptyActivityFilters});
    expect(routeOf("/review/")).toEqual({kind: "activity", filters: emptyActivityFilters});
    expect(routeOf("/review?view=focus")).toEqual({kind: "activity", filters: emptyActivityFilters});
    const filters = {projects: ["prj_a", "prj b"], q: "totals", segment: "needs_you", types: ["comments", "versions"]} as const;
    const href = activityHref(filters);
    expect(href).toBe("/review?segment=needs_you&projects=prj_a&projects=prj+b&type=comments&type=versions&q=totals");
    expect(routeOf(href)).toEqual({kind: "activity", filters});
    expect(activityHref()).toBe("/review");
    expect(activityHref(emptyActivityFilters)).toBe("/review");
  });

  it("ACT-005: unknown segments and types are dropped, and the search is trimmed to 100 characters", () => {
    const filters = readActivityFilters(new URLSearchParams(
      `segment=everything&type=comments&type=secrets&type=comments&q=${"x".repeat(140)}`,
    ));
    expect(filters.segment).toBe("all");
    expect(filters.types).toEqual(["comments"]);
    expect(filters.q).toHaveLength(100);
  });

  it("keeps a project-only URL on the workspace, never on Activity", () => {
    expect(routeOf("/review?project=prj_default&segment=needs_you")).toEqual({
      kind: "workspace",
      location: {...emptyLocation, projectId: "prj_default"},
    });
  });
});

describe("projects route", () => {
  it("ACT-005: /review/projects names its selected project", () => {
    expect(projectsHref(null)).toBe("/review/projects");
    expect(projectsHref("prj a")).toBe("/review/projects?project=prj+a");
    expect(routeOf("/review/projects")).toEqual({kind: "projects", projectId: null});
    expect(routeOf("/review/projects/?project=prj_a")).toEqual({kind: "projects", projectId: "prj_a"});
    expect(routeOf("/review/projects?project=")).toEqual({kind: "projects", projectId: null});
  });
});

describe("thread deep link", () => {
  it("ACT-005: a workspace URL carries the thread to select after every other parameter", () => {
    const location: ReviewLocation = {...emptyLocation, artifactId: "art_1", projectId: "prj_1", threadId: "thr_9", versionId: "ver_1"};
    expect(workspaceHref(location)).toBe("/review?project=prj_1&artifact=art_1&version=ver_1&thread=thr_9");
    expect(readReviewLocation(new URL(workspaceHref(location), origin).searchParams)).toEqual(location);
  });
});
```

  Then update the remaining tests that build a `ReviewLocation` literal to include `threadId: null`, and change every `reviewQueueHref()` in this file to `activityHref()`.

- [ ] **Step 2: Write the failing redirect and settings tests.** In `apps/web/src/review/settings/settings-view.test.ts`, change the import to `activityHref, parseReviewRoute, projectsHref`. Replace the `ADM-006-B: the retired projects list …` test with:

```ts
  it("ADM-006-B: old project settings URLs replace themselves with the Projects screen", () => {
    for (const path of ["/review/settings", "/review/settings/", "/review/settings/projects"]) {
      expect(canonicalReviewRoute(parseReviewRoute(reviewUrl(path)))).toEqual({
        replaceWith: projectsHref(null),
        route: {kind: "projects", projectId: null},
      });
    }
    expect(canonicalReviewRoute(parseReviewRoute(reviewUrl("/review/settings/projects/prj_default")))).toEqual({
      replaceWith: projectsHref("prj_default"),
      route: {kind: "projects", projectId: "prj_default"},
    });
    const library = parseReviewRoute(reviewUrl("/review/library?project=prj_default"));
    expect(canonicalReviewRoute(library)).toEqual({replaceWith: null, route: library});
  });
```

  In the `resolveSettingsView` test, change the expected projects redirect to `{href: projectsHref(null), kind: "redirect"}`.

- [ ] **Step 3: Write the failing navigation tests.** In `apps/web/src/shell/nav-model.test.ts`, rename `queueActive` to `activityActive` and add `projectsActive: false` in `reviewInput`. Replace the first three `shellNavItems in review mode` tests with:

```ts
  it("ACT-005: lists Activity, Projects and the design library, then project folders, New project and administrator Tools", () => {
    expect(shellNavItems(reviewInput)).toEqual([
      {group: "Review", icon: "bi-activity", id: "activity", label: "Activity", link: "/review"},
      {icon: "bi-folder2-open", id: "projects", label: "Projects", link: "/review/projects"},
      {icon: "bi-collection", id: "library", label: "Design library", link: "/review/library?project=prj_b"},
      {group: "Projects", icon: "bi-folder2", id: "project:prj_b", label: "Beta", link: "/review/projects?project=prj_b"},
      {icon: "bi-folder2", id: "project:prj_default", label: "Default", link: "/review/projects?project=prj_default"},
      {icon: "bi-archive", id: "project:prj_old", label: "Zeta", link: "/review/projects?project=prj_old"},
      {icon: "bi-plus-lg", id: NEW_PROJECT_NAV_ID, label: "New project"},
      {group: "Tools", icon: "bi-gear", id: "administration", label: "Administration", link: "/review/settings/members"},
    ]);
  });

  it("ACT-005: gives a non-administrator MCP & WebMCP in Tools instead of Administration", () => {
    const items = shellNavItems({...reviewInput, canCreateProjects: false, isAdministrator: false});
    expect(items.map((item) => item.label)).toEqual(["Activity", "Projects", "Design library", "Beta", "Default", "Zeta", "MCP & WebMCP"]);
    expect(items.at(-1)).toEqual({group: "Tools", icon: "bi-plug", id: "mcp", label: "MCP & WebMCP", link: "/review/settings/mcp"});
  });

  it("starts the Projects group with New project when there are no projects", () => {
    expect(shellNavItems({...reviewInput, projects: []}).slice(3)).toEqual([
      {group: "Projects", icon: "bi-plus-lg", id: NEW_PROJECT_NAV_ID, label: "New project"},
      {group: "Tools", icon: "bi-gear", id: "administration", label: "Administration", link: "/review/settings/members"},
    ]);
  });
```

  Replace the first three `shellActiveLink` expectations with:

```ts
    expect(shellActiveLink({...reviewInput, activityActive: true})).toBe("/review");
    expect(shellActiveLink({...reviewInput, projectsActive: true})).toBe("/review/projects");
    expect(shellActiveLink({...reviewInput, activeProjectId: "prj_default", projectsActive: true}))
      .toBe("/review/projects?project=prj_default");
    expect(shellActiveLink({...reviewInput, activeProjectId: "prj_default", libraryActive: true})).toBe("/review/library?project=prj_default");
    expect(shellActiveLink({...reviewInput, activeProjectId: "prj_default"}))
      .toBe("/review/projects?project=prj_default");
```

  Leave the administration-mode tests unchanged; slice 7 owns them.

- [ ] **Step 4: Run the tests to confirm they fail.**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review/review-routes.test.ts src/review/settings/settings-view.test.ts src/shell/nav-model.test.ts`
Expected: FAIL with `activityHref` is not exported, and the route kind `"queue"` does not equal `"activity"`.

- [ ] **Step 5: Implement the routes.** In `apps/web/src/review/review-routes.ts`:

```ts
import type {ActivitySegment, ActivityType} from "@/api/client";

/**
 * The Activity feed's filters, all carried in the bare /review URL.
 * The project filter uses `projects=`, never `project=`: a `/review?project=` URL is the workspace.
 */
export interface ActivityFilters {
  readonly projects: readonly string[];
  readonly q: string;
  readonly segment: ActivitySegment;
  readonly types: readonly ActivityType[];
}

export const emptyActivityFilters: ActivityFilters = {projects: [], q: "", segment: "all", types: []};

const activitySegments: readonly ActivitySegment[] = ["all", "needs_you", "with_agent"];
const activityTypes: readonly ActivityType[] = ["comments", "versions", "agents", "access", "admin"];
/** The server's own search limit; a longer value would only be refused. */
const activitySearchLimit = 100;
const projectsPathname = "/review/projects";

/** Read the feed filters from a query string, dropping values the server does not accept. */
export function readActivityFilters(search: URLSearchParams): ActivityFilters {
  const segment = search.get("segment");
  const types = [...new Set(search.getAll("type"))]
    .filter((type): type is ActivityType => (activityTypes as readonly string[]).includes(type));
  return {
    projects: [...new Set(search.getAll("projects").filter((id) => id !== ""))],
    q: (search.get("q") ?? "").trim().slice(0, activitySearchLimit),
    segment: activitySegments.find((candidate) => candidate === segment) ?? "all",
    types,
  };
}

/** The Activity feed's canonical URL: bare /review, with only the filters that narrow it. */
export function activityHref(filters: ActivityFilters = emptyActivityFilters): string {
  const search = new URLSearchParams();
  if (filters.segment !== "all") search.set("segment", filters.segment);
  for (const project of filters.projects) search.append("projects", project);
  for (const type of filters.types) search.append("type", type);
  if (filters.q !== "") search.set("q", filters.q);
  return search.size === 0 ? "/review" : `/review?${search}`;
}

/** The Projects screen, optionally with one project selected. */
export function projectsHref(projectId: string | null): string {
  return projectId === null || projectId === ""
    ? projectsPathname
    : `${projectsPathname}?${new URLSearchParams({project: projectId})}`;
}
```

  Then make these changes in the same file:
  - Replace the `ReviewRoute` union with the one in **Produces**.
  - Delete `reviewQueueHref`. Replace its uses in `workspaceHref` and `reviewReturnHref` with `activityHref()`.
  - In `parseReviewRoute`, add this before the library branch:

```ts
  if (url.pathname === projectsPathname || url.pathname === `${projectsPathname}/`) {
    const projectId = url.searchParams.get("project");
    return {kind: "projects", projectId: projectId === null || projectId === "" ? null : projectId};
  }
```

  - Change the final return of `parseReviewRoute` to:

```ts
  return location.projectId === null && location.artifactId === null
    ? {kind: "activity", filters: readActivityFilters(url.searchParams)}
    : {kind: "workspace", location};
```

  - Add `readonly threadId: string | null;` to `ReviewLocation`, documented as "The conversation to select once the version's threads load."
  - Add `threadId: search.get("thread"),` to `readReviewLocation`.
  - In `workspaceHref`, after the `path` line and before `view`, add `if (location.threadId !== null) search.set("thread", location.threadId);`.
  - Add `threadId: null` to `projectWorkspaceHref`'s literal.

- [ ] **Step 6: Point the old project settings URLs at Projects.** In `apps/web/src/review/settings/settings-view.ts`:

```ts
import {projectsHref, type ReviewRoute, type SettingsRoute} from "../review-routes.ts";

/** Old project settings bookmarks land on the Projects screen with a replaced history entry. */
export function canonicalReviewRoute(route: ReviewRoute): CanonicalReviewRoute {
  if (route.kind === "settings" && route.settings.kind === "projects") {
    return {replaceWith: projectsHref(null), route: {kind: "projects", projectId: null}};
  }
  if (route.kind === "settings" && route.settings.kind === "project") {
    const projectId = route.settings.projectId;
    return {replaceWith: projectsHref(projectId), route: {kind: "projects", projectId}};
  }
  return {replaceWith: null, route};
}
```

  In `resolveSettingsView`, the `projects` case returns `{href: projectsHref(null), kind: "redirect"}`. Keep the `project` case unchanged; it is now unreachable from URLs, but `SettingsView` still models it until slice 6 deletes it.

- [ ] **Step 7: Implement the navigation model.** In `apps/web/src/shell/nav-model.ts`:
  - Change the import to `activityHref, libraryHref, projectsHref, type SettingsRoute`.
  - In `ShellNavInput`, replace `queueActive` with `readonly activityActive: boolean;` and add `readonly projectsActive: boolean;`.
  - Replace `reviewItems` and the review branch of `shellActiveLink` with:

```ts
export function shellNavItems(input: ShellNavInput): NavItem[] {
  return input.mode === "admin"
    ? administrationItems(input.isAdministrator, input.returnHref)
    : reviewItems(input, libraryProjectId(input));
}

// inside shellActiveLink, replacing the review-mode lines:
  if (input.activityActive) return activityHref();
  if (input.libraryActive) return libraryHref(libraryProjectId(input));
  if (input.projectsActive && input.activeProjectId === null) return projectsHref(null);
  return input.activeProjectId === null ? "" : projectsHref(input.activeProjectId);

function reviewItems(input: ShellNavInput, libraryProject: string | null): NavItem[] {
  const items: NavItem[] = [
    {group: "Review", icon: "bi-activity", id: "activity", label: "Activity", link: activityHref()},
    {icon: "bi-folder2-open", id: "projects", label: "Projects", link: projectsHref(null)},
    {icon: "bi-collection", id: "library", label: "Design library", link: libraryHref(libraryProject)},
  ];
  const firstProjectIndex = items.length;
  for (const project of orderedProjects(input.projects)) {
    const item: NavItem = {
      icon: project.archivedAt === null ? "bi-folder2" : "bi-archive",
      id: `project:${project.id}`,
      label: project.name,
      link: projectsHref(project.id),
    };
    if (items.length === firstProjectIndex) item.group = "Projects";
    items.push(item);
  }
  if (input.canCreateProjects) {
    const create: NavItem = {icon: "bi-plus-lg", id: NEW_PROJECT_NAV_ID, label: "New project"};
    if (items.length === firstProjectIndex) create.group = "Projects";
    items.push(create);
  }
  // Non-administrators keep their only route to the MCP & WebMCP setup screen.
  items.push(input.isAdministrator
    ? {group: "Tools", icon: "bi-gear", id: "administration", label: "Administration", link: administrationHref(true)}
    : {group: "Tools", icon: "bi-plug", id: "mcp", label: "MCP & WebMCP", link: administrationHref(false)});
  return items;
}
```

  `projectWorkspaceHref` is no longer imported here. It stays exported from `review-routes.ts` for the Projects screen's "Open latest artifact".

- [ ] **Step 8: Wire the shell, the brand and the account menu.**

  In `apps/web/src/shell/review-shell.tsx`:
  - Set `activeProjectId` to `route.kind === "workspace" ? route.location.projectId : route.kind === "library" || route.kind === "projects" ? route.projectId : null`.
  - Replace `queueActive: route.kind === "queue"` with `activityActive: route.kind === "activity"` and `projectsActive: route.kind === "projects"`.
  - In `settingsTitles`, change `projects: "Review queue"` to `projects: "Projects"`.
  - In `routeTitle`, replace the queue line with:

```ts
  if (route.kind === "activity") return "Activity";
  if (route.kind === "projects") return projectName(route.projectId) === null ? "Projects" : `Projects · ${projectName(route.projectId)}`;
```

  In the `CreateProjectModal` `onCreated`, change the `navigateReview(...)` target to `projectsHref(project.id)` and update the imports to match.

  In `apps/web/src/shell/brand.tsx`, replace both `reviewQueueHref()` calls with `activityHref()`, and change the import to match.

  In `apps/web/src/shell/account-menu.tsx`:
  - Replace the `reviewQueueHref` import and its call (the sign-out redirect at line 177) with `activityHref`.
  - The review-mode branch currently always adds "Administration" (icon `bi-sliders`). Make it follow the navigation rule, so a non-administrator keeps a route to MCP setup. Replace the review-mode item with:

```tsx
      : isInstallationAdministrator(principal)
        ? {icon: "bi-gear", label: "Administration", onClick: () => navigateReview(administrationHref(true))}
        : {icon: "bi-plug", label: "MCP & WebMCP", onClick: () => navigateReview(administrationHref(false))},
```

    Slice 7 (Task 7.2) removes the `mode === "admin"` "Back to review" branch. This rule stays.

  In `apps/web/src/review/settings/settings-screen.tsx` and `apps/web/src/review/settings/project-settings.tsx`, replace `reviewQueueHref` with `activityHref` (the "Back" actions of the not-found states).

- [ ] **Step 9: Render the new route kinds in the application.** In `apps/web/src/review/review-app.tsx`, replace the `route.kind === "queue"` branch with:

```tsx
      ) : route.kind === "activity" ? (
        <ReviewQueueScreen projects={projects} />
      ) : route.kind === "projects" ? (
        <InterimProjectsScreen
          onProjectsChanged={loadProjects}
          projectId={route.projectId}
          projects={projects}
          session={session}
        />
```

  Add this function at the bottom of the file, with `ProjectSettings` imported from `./settings/project-settings.tsx` and `canManageProjects` from `@/shell/nav-model`:

```tsx
/** Slice 5's Projects route: the selected (else first active) project's settings; slice 6 docks the list beside it. */
function InterimProjectsScreen({onProjectsChanged, projectId, projects, session}: {
  readonly onProjectsChanged: () => Promise<readonly Project[]>;
  readonly projectId: string | null;
  readonly projects: readonly Project[];
  readonly session: Session;
}) {
  const selected = projectId ?? projects.find((project) => project.archivedAt === null)?.id ?? projects[0]?.id ?? null;
  if (selected === null) {
    return <SurfaceState count={0} emptyBody="Create a project to publish into." emptyIcon="bi-folder2-open"
      emptyTitle="No projects yet" noun="projects" phase="ready" titleLevel={1} />;
  }
  return (
    <ProjectSettings
      canManage={canManageProjects(session.principal)}
      gitHistory={session.capabilities.gitHistory}
      key={selected}
      onProjectsChanged={onProjectsChanged}
      projectId={selected}
      projects={projects}
    />
  );
}
```

  The Activity screen replaces `ReviewQueueScreen` in Task 5.3.

- [ ] **Step 10: Run the unit tests and the typecheck.**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review/review-routes.test.ts src/review/settings/settings-view.test.ts src/shell/nav-model.test.ts && pnpm typecheck`
Expected: PASS.
- `pnpm typecheck` lists any `ReviewLocation` literal still missing `threadId`. Add `threadId: null` to each one it names; they are in `review-app.tsx` and `apps/web/src/review/workspace/*`.
- It also lists any remaining `reviewQueueHref` import. Replace each with `activityHref`.

- [ ] **Step 11: Commit.**

```bash
git add apps/web/src/review/review-routes.ts apps/web/src/review/review-routes.test.ts apps/web/src/review/settings apps/web/src/shell apps/web/src/review/review-app.tsx apps/web/src/review/workspace
git commit -m "Name Activity, Projects and thread routes and regroup the navigation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5.2: Quick Search under the lock-up

**Files:**
- Modify: `apps/web/src/shell/review-shell.tsx`
- Test: `tests/browser/shell-navigation.spec.ts`

**Interfaces:**
- Consumes: the slice-1 re-synced `LeftNav` props `header` (boolean) and `search` (ReactNode), from Design `e087280`.
- Produces: none.

- [ ] **Step 1: Write the failing browser assertion.** In `tests/browser/shell-navigation.spec.ts`, in the `NAV-001-B: left navigation, …` test, after `const nav = page.getByRole("navigation", {name: "Review and projects"});`, add:

```ts
      const quickSearch = page.getByRole("button", {name: "Search everything"}).filter({hasText: "Quick Search"});
      await expect(quickSearch).toBeVisible();
      await expect(quickSearch).toHaveAttribute("aria-keyshortcuts", "Meta+K Control+K /");
      await quickSearch.click();
      await expect(page.getByRole("combobox", {name: "Search"})).toBeVisible();
      await page.keyboard.press("Escape");
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `pnpm build && pnpm exec playwright test tests/browser/shell-navigation.spec.ts --project=chromium -g "NAV-001-B: left navigation"`
Expected: FAIL. No button with the text "Quick Search" exists, because the search control is the navy icon in the brand row.

- [ ] **Step 3: Move search into the `search` slot.** In `apps/web/src/shell/review-shell.tsx`:
  - The `brand` prop becomes `<ArtifactServerBrand showProduct={false} />` only.
  - Add `header={false}` to the `LeftNav`.
  - Add the `search` prop:

```tsx
      search={onOpenPalette === undefined ? undefined : (
        <Button
          aria-keyshortcuts="Meta+K Control+K /"
          aria-label="Search everything"
          block
          icon="bi-search"
          onClick={onOpenPalette}
          outline
          size="sm"
          style={{background: "var(--surface-card, #fff)", color: "var(--text-secondary, #5a6268)", fontWeight: 400, justifyContent: "flex-start"}}
          variant="secondary"
        >
          Quick Search
        </Button>
      )}
```

  Remove `paletteButton("navy")` and keep `searchRail={paletteButton("ghost")}`. Simplify `paletteButton` to the ghost tone only: delete the `tone` parameter and use `placement="right"` and `variant="ghost"`. Import `Button` from `@/arkcase`.

- [ ] **Step 4: Run it to confirm it passes.**

Run: `pnpm build && pnpm exec playwright test tests/browser/shell-navigation.spec.ts tests/browser/command-palette.spec.ts --project=chromium`
Expected: PASS. If `command-palette.spec.ts` located the palette by the navy icon button, select it with `page.getByRole("button", {name: "Search everything"}).first()` instead.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/shell/review-shell.tsx tests/browser/shell-navigation.spec.ts tests/browser/command-palette.spec.ts
git commit -m "Put Quick Search under the navigation lock-up

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5.3: The activity adapter, feed hooks and Activity screen

**Files:**
- Create: `apps/web/src/review/activity/activity-adapter.ts`
- Create: `apps/web/src/review/activity/activity-adapter.test.ts`
- Create: `apps/web/src/review/activity/activity-pages.ts`
- Create: `apps/web/src/review/activity/activity-pages.test.ts`
- Create: `apps/web/src/review/activity/use-activity-feed.ts`
- Create: `apps/web/src/review/activity/use-activity-summary.ts`
- Create: `apps/web/src/review/activity/activity-feed-panel.tsx`
- Create: `apps/web/src/review/activity/activity-feed-section.tsx`
- Create: `apps/web/src/review/activity/activity-screen.tsx`
- Modify: `apps/web/src/review/review-app.tsx`
- Test: `tests/browser/activity.spec.ts`

**Interfaces:**
- Consumes:
  - `api.listActivity`, `api.activitySummary`, `ActivityEntry` and `ActivitySummary` (slice 4).
  - `ActivityFilters`, `activityHref` and `workspaceHref` (Task 5.1).
  - From the vendored model: `mergeBursts`, `groupByDay`, `sortEvents` and `usDateTime` from `@/ui/activity-model` (Task 1.2); `ActivityEvent` from `@/ui/review-ui` (Task 1.2).
- Produces (slice 6 reuses these for the per-project Activity section):

```ts
// activity-adapter.ts
export type FeedEvent = ActivityEvent & {readonly entry: ActivityEntry};
export function toFeedEvents(entries: readonly ActivityEntry[]): FeedEvent[];
export function mergedFeed(events: readonly FeedEvent[]): FeedEvent[];         // sortEvents then mergeBursts
export function feedGroups(events: readonly FeedEvent[], now: number): ReturnType<typeof groupByDay>;
// activity-pages.ts
export function appendPage(loaded: readonly ActivityEntry[], next: readonly ActivityEntry[]): ActivityEntry[];
export function refreshFirstPage(loaded: readonly ActivityEntry[], first: readonly ActivityEntry[]): ActivityEntry[];
// use-activity-feed.ts
export interface ActivityFeedState {
  readonly entries: readonly ActivityEntry[];
  readonly hasMore: boolean;
  readonly phase: "loading" | "ready" | "failed";
  readonly insertLocal: (entry: ActivityEntry) => void;
  readonly loadOlder: () => void;
  readonly reload: () => void;
  readonly replaceThread: (threadId: string, thread: NonNullable<ActivityEntry["thread"]>) => void;
}
export function useActivityFeed(filters: ActivityFilters): ActivityFeedState;
// use-activity-summary.ts
export function useActivitySummary(projects: readonly string[]): {phase: "loading" | "ready" | "failed"; summary: ActivitySummary | null; reload: () => void};
// activity-feed-panel.tsx — the feed body with inline Reply/Resolve, folding and thumbnails
export function ActivityFeedPanel(props: {readonly feed: ActivityFeedState; readonly filtered: boolean; readonly label: string;
  readonly onClearFilters: () => void; readonly principalId: string; readonly renderThumbnail?: (event: FeedEvent) => React.ReactNode;
  readonly stickyTop: number}): JSX.Element;
// activity-feed-section.tsx — one feed's loading, failure, empty and loaded states
export function ActivityFeedBody(props: {readonly feed: ActivityFeedState; readonly filtered: boolean; readonly label: string;
  readonly onClearFilters: () => void; readonly onRetry: () => void; readonly principalId: string; readonly stickyTop: number}): JSX.Element;
// A self-loading feed for one project (or every project when projectId is null). Slice 6 mounts it in project details.
export function ActivityFeedSection(props: {readonly principalId: string; readonly projectId: string | null}): JSX.Element;
// activity-thumbnail.tsx (Task 5.4)
export function ActivityThumbnail(props: {readonly event: FeedEvent}): JSX.Element;
// activity-screen.tsx
export function ActivityScreen(props: {readonly filters: ActivityFilters; readonly projects: readonly Project[]; readonly session: Session}): JSX.Element;
```

- [ ] **Step 1: Write the failing adapter tests.** These are the prototype's 15 model cases (`~/Dev/Design/tests/models/artifacts-activity.test.mjs`) restated against API-shaped entries. Filtering, paging and the Needs-you rule run on the server, so the cases that exercised them in the prototype here prove that the adapter preserves the server's decision. Create `apps/web/src/review/activity/activity-adapter.test.ts`:

```ts
import {describe, expect, it} from "vitest";

import type {ActivityEntry} from "@/api/client";
import {dayKey, dayLabel, usDate, usDateTime, usTime} from "@/ui/activity-model";

import {feedGroups, mergedFeed, toFeedEvents} from "./activity-adapter";
import {appendPage} from "./activity-pages";

const at = (day: number, hour: number, minute = 0): string => new Date(2026, 8, day, hour, minute).toISOString();
const base = {
  actor: {kind: "human", name: "Dana Okonkwo"},
  artifact: {archived: false, id: "art_a", name: "Inspector study"},
  project: {id: "prj_a", name: "Claims"},
  versionNumber: 3,
} as const;
const comment = (id: string, author: string, createdAt: string, body: string) => ({author: {kind: "human" as const, name: author}, body, createdAt, id});
const threadEntry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  ...base, at: at(30, 11, 20), id: "act_t1", kind: "thread", verb: "replied",
  thread: {anchor: null, id: "thr_1", isResolved: false, opener: comment("thr_1", "Dana Okonkwo", at(30, 10, 56), "First line.\nSecond line."),
    path: "index.html", replies: [comment("rep_1", "Claude", at(30, 11, 20), "Done.")], replyCount: 1, state: "needs_you", versionId: "ver_3"},
  ...over,
} as ActivityEntry);
const version = (id: string, n: number, actor: string, iso: string, artifactId = "art_a"): ActivityEntry => ({
  ...base, actor: {kind: "service", name: actor}, artifact: {...base.artifact, id: artifactId}, at: iso, id, kind: "version", verb: "published", versionNumber: n,
} as ActivityEntry);

describe("toFeedEvents", () => {
  it("ACT-005: maps one event per entry kind, newest first as the server ordered them", () => {
    const events = toFeedEvents([
      threadEntry(),
      {...base, at: at(30, 10), excerpt: "Agreed.", id: "act_r", kind: "resolution", threadId: "thr_2", verb: "resolved"} as ActivityEntry,
      version("act_v", 3, "Claude", at(30, 9)),
      {...base, agent: {dispatchState: "delivered", name: "Codex", threadIds: ["thr_1"]}, at: at(30, 8), id: "act_g", kind: "agent", verb: "sent"} as ActivityEntry,
      {...base, access: {from: "account_required", to: "public_link"}, at: at(30, 7), id: "act_a", kind: "access", verb: "enabled"} as ActivityEntry,
      {...base, artifact: null, at: at(30, 6), id: "act_m", kind: "admin", project: null, subject: {id: "mem_1", name: "Aaron Whitlock"}, verb: "admitted", versionNumber: null} as ActivityEntry,
      {...base, at: at(30, 5), id: "act_d", kind: "thread_deleted", threadId: "thr_3", verb: "deleted"} as ActivityEntry,
    ]);
    expect(events.map((event) => event.type)).toEqual(["comment", "resolution", "version", "agent", "access", "admin", "admin"]);
    expect(events.every((event, index) => index === 0 || event.at <= events[index - 1]!.at)).toBe(true);
  });

  it("ACT-005: a replied thread is one event at its newest reply, by the replier, keyed by thread", () => {
    const [event] = toFeedEvents([threadEntry({actor: {kind: "agent", name: "Claude"}})]);
    expect(event).toMatchObject({actor: "Claude", id: "comment:thr_1", type: "comment", verb: "replied on"});
    expect(event!.at).toBe(Date.parse(at(30, 11, 20)));
    expect(event!.thread).toMatchObject({author: "Dana Okonkwo", body: "First line.\nSecond line.", isResolved: false, key: "thr_1"});
    expect(event!.excerpt).toBe("First line.");
  });

  it("ACT-005: resolution, agent, access and admin events carry their own fields", () => {
    const [resolution, agent, access, admin, deleted] = toFeedEvents([
      {...base, at: at(30, 10), excerpt: "Agreed: stands down.", id: "act_r", kind: "resolution", threadId: "thr_2", verb: "resolved"} as ActivityEntry,
      {...base, agent: {dispatchState: "delivered", name: "Codex", threadIds: ["thr_1"]}, artifact: {...base.artifact, archived: true}, at: at(30, 8), id: "act_g", kind: "agent", verb: "sent"} as ActivityEntry,
      {...base, access: {from: null, to: "public_link"}, at: at(30, 7), id: "act_a", kind: "access", verb: "enabled"} as ActivityEntry,
      {...base, artifact: null, at: at(30, 6), id: "act_k", kind: "admin", project: null, subject: {id: "key_1", name: "CI publisher"}, verb: "revoked", versionNumber: null} as ActivityEntry,
      {...base, at: at(30, 5), id: "act_d", kind: "thread_deleted", threadId: "thr_3", verb: "deleted"} as ActivityEntry,
    ]);
    expect([resolution!.verb, resolution!.excerpt, resolution!.needsYou]).toEqual(["resolved a conversation on", "Agreed: stands down.", false]);
    expect([agent!.agent, agent!.state, agent!.withAgent, agent!.archived]).toEqual(["Codex", "Delivered", true, true]);
    expect([access!.from, access!.to]).toEqual(["—", "Public link"]);
    expect([admin!.adminOnly, admin!.verb, admin!.detail, admin!.icon]).toEqual([true, "revoked the API key", "CI publisher", "bi-key"]);
    expect([deleted!.verb, deleted!.detail, deleted!.icon, deleted!.adminOnly]).toEqual(["deleted a conversation on", "Inspector study", "bi-trash", false]);
  });

  it("ACT-005: a thread's state decides Your turn and With an agent; resolved threads show neither", () => {
    const [needs, held, resolved] = toFeedEvents([
      threadEntry(),
      threadEntry({id: "act_t2", thread: {...threadEntry().thread!, id: "thr_2", state: "with_agent"}}),
      threadEntry({id: "act_t3", thread: {...threadEntry().thread!, id: "thr_3", isResolved: true, state: "resolved"}}),
    ]);
    expect([needs!.needsYou, needs!.withAgent]).toEqual([true, false]);
    expect([held!.needsYou, held!.withAgent]).toEqual([false, true]);
    expect([resolved!.needsYou, resolved!.withAgent]).toEqual([false, false]);
  });

  it("ACT-005: an unknown actor reads Unknown and an unreadable time sorts last", () => {
    const events = mergedFeed(toFeedEvents([
      {...version("act_x", 2, "Claude", "not a time"), actor: {kind: null, name: null}} as ActivityEntry,
      version("act_y", 1, "Claude", at(29, 9), "art_b"),
    ]));
    expect(events.map((event) => event.entry.id)).toEqual(["act_y", "act_x"]);
    expect(events[1]!.actor).toBe("Unknown");
    expect(Number.isNaN(events[1]!.at)).toBe(true);
  });

  it("ACT-005: comment and reply instants are carried for display in US format", () => {
    const [event] = toFeedEvents([threadEntry()]);
    expect(event!.thread!.atMs).toBe(Date.parse(at(30, 10, 56)));
    expect(usDateTime(event!.thread!.replies[0]!.atMs)).toBe("09/30/2026 11:20 AM");
  });
});

describe("mergedFeed", () => {
  it("ACT-005: consecutive versions by one publisher on one artifact merge; anything between breaks the burst", () => {
    const merged = mergedFeed(toFeedEvents([
      version("v7", 7, "Claude", at(30, 7)), version("x", 2, "Claude", at(30, 6, 30), "art_b"), version("v6", 6, "Claude", at(30, 6)),
      version("v5", 5, "Claude", at(30, 5)), version("v4", 4, "Codex", at(30, 4)),
      threadEntry({at: at(30, 3, 30), id: "c"}), version("v3", 3, "Codex", at(30, 3)), version("v2", 2, "Codex", at(30, 2)),
    ]));
    const onA = merged.filter((event) => event.artifactId === "art_a");
    expect(onA.map((event) => [event.type, event.version, event.firstVersion, event.count])).toEqual([
      ["version", 7, 5, 3], ["version", 4, 4, 1], ["comment", 3, undefined, undefined], ["version", 3, 2, 2],
    ]);
    expect(mergedFeed([])).toEqual([]);
  });

  it("ACT-005: a burst split across a page boundary merges once the older page loads", () => {
    const first = [version("v9", 9, "Claude", at(30, 9)), version("v8", 8, "Claude", at(30, 8))];
    const second = [version("v7", 7, "Claude", at(30, 7))];
    expect(mergedFeed(toFeedEvents(first))).toHaveLength(1);
    const both = mergedFeed(toFeedEvents(appendPage(first, second)));
    expect(both.map((event) => [event.version, event.firstVersion, event.count])).toEqual([[9, 7, 3]]);
  });

  it("ACT-005: a locally inserted reply sorts above server events", () => {
    const local = threadEntry({at: new Date(2026, 9, 1, 8).toISOString(), id: "local:rep_9"});
    const events = mergedFeed(toFeedEvents([version("v1", 1, "Claude", at(30, 9)), local]));
    expect(events[0]!.entry.id).toBe("local:rep_9");
  });
});

describe("day groups and formats", () => {
  it("ACT-005: day groups label today, yesterday and older days; undated events close the list", () => {
    const now = new Date(2026, 8, 30, 15, 0).getTime();
    const groups = feedGroups(toFeedEvents([
      version("1", 4, "A", at(30, 9), "a1"), version("2", 3, "B", at(30, 8), "a2"), version("3", 2, "C", at(29, 23), "a3"),
      version("4", 1, "D", at(14, 10), "a4"), version("5", 1, "E", "", "a5"),
    ]), now);
    expect(groups.map((group) => [group.label, group.events.length])).toEqual([["Today", 2], ["Yesterday", 1], ["Mon 09/14/2026", 1], ["Undated", 1]]);
    expect(dayKey(new Date(2026, 8, 14, 10).getTime())).toBe("2026-09-14");
    expect(dayLabel("2026-04-14", now)).toBe("Tue 04/14/2026");
  });

  it("ACT-005: US formatters print full dates and a 12-hour clock", () => {
    const local = (h: number, m: number) => new Date(2026, 3, 4, h, m).getTime();
    expect(usDate(local(9, 5))).toBe("04/04/2026");
    expect(usTime(local(13, 10))).toBe("1:10 PM");
    expect(usTime(local(0, 5))).toBe("12:05 AM");
    expect(usTime(local(12, 0))).toBe("12:00 PM");
    expect(usDateTime(local(23, 59))).toBe("04/04/2026 11:59 PM");
    expect([usDate(Number.NaN), usTime(Number.NaN), usDateTime(Number.NaN)]).toEqual(["", "", ""]);
  });
});
```

  Create `apps/web/src/review/activity/activity-pages.test.ts`:

```ts
import {describe, expect, it} from "vitest";

import type {ActivityEntry} from "@/api/client";

import {appendPage, refreshFirstPage} from "./activity-pages";

const thread = (id: string, threadId: string, iso: string): ActivityEntry => ({
  actor: {kind: "human", name: "Dana"}, artifact: {archived: false, id: "art", name: "A"}, at: iso, id, kind: "thread",
  project: {id: "prj", name: "P"}, verb: "replied", versionNumber: 1,
  thread: {anchor: null, id: threadId, isResolved: false, opener: {author: {kind: "human", name: "Dana"}, body: "b", createdAt: iso, id: threadId},
    path: null, replies: [], replyCount: 0, state: "needs_you", versionId: "ver"},
} as ActivityEntry);

describe("feed pages", () => {
  it("ACT-005: an older page never repeats a thread already shown nearer the top", () => {
    const first = [thread("act_2", "thr_a", "2026-09-30T10:00:00.000Z")];
    const older = [thread("act_1", "thr_a", "2026-09-29T10:00:00.000Z"), thread("act_0", "thr_b", "2026-09-28T10:00:00.000Z")];
    expect(appendPage(first, older).map((entry) => entry.id)).toEqual(["act_2", "act_0"]);
  });

  it("ACT-005: a refreshed first page replaces what it covers and keeps loaded older entries", () => {
    const loaded = [thread("act_2", "thr_a", "2026-09-30T10:00:00.000Z"), thread("act_0", "thr_b", "2026-09-28T10:00:00.000Z")];
    const first = [thread("act_3", "thr_b", "2026-10-01T09:00:00.000Z"), thread("act_2", "thr_a", "2026-09-30T10:00:00.000Z")];
    expect(refreshFirstPage(loaded, first).map((entry) => entry.id)).toEqual(["act_3", "act_2"]);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail.**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review/activity`
Expected: FAIL with "Cannot find module './activity-adapter'".

- [ ] **Step 3: Implement the adapter.** Create `apps/web/src/review/activity/activity-adapter.ts`:

```ts
import type {ActivityEntry} from "@/api/client";
import {groupByDay, mergeBursts, sortEvents} from "@/ui/activity-model";
import type {ActivityEvent} from "@/ui/review-ui";

/** One vendored-model event plus the API entry it came from (for Open, Reply and thumbnails). */
export type FeedEvent = ActivityEvent & {readonly entry: ActivityEntry};

const unknownActor = "Unknown";
const notRecorded = "—";
const accessLabels = {account_required: "Account required", public_link: "Public link"} as const;
const dispatchLabels = {canceled: "Canceled", claimed: "Claimed", delivered: "Delivered", failed: "Failed", queued: "Queued"} as const;
const activeDispatch = new Set(["queued", "claimed", "delivered"]);
const adminWords: Record<string, {readonly icon: string; readonly verb: string}> = {
  admitted: {icon: "bi-person-plus", verb: "admitted"},
  archived: {icon: "bi-archive", verb: "archived the project"},
  created: {icon: "bi-folder-plus", verb: "created the project"},
  deactivated: {icon: "bi-person-dash", verb: "deactivated"},
  issued: {icon: "bi-key", verb: "issued the API key"},
  revoked: {icon: "bi-key", verb: "revoked the API key"},
  rotated: {icon: "bi-arrow-repeat", verb: "rotated the API key"},
  unarchived: {icon: "bi-folder2-open", verb: "unarchived the project"},
};

const instant = (iso: string): number => {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) || !/^\d{4}-\d{2}-\d{2}T/u.test(iso) ? Number.NaN : parsed;
};
const firstLine = (text: string): string => text.split("\n")[0] ?? "";

function about(entry: ActivityEntry) {
  return {
    actor: entry.actor.name ?? unknownActor,
    adminOnly: false,
    archived: entry.artifact?.archived ?? false,
    artifactId: entry.artifact?.id,
    artifactName: entry.artifact?.name,
    at: instant(entry.at),
    entry,
    needsYou: false,
    projectId: entry.project?.id,
    projectName: entry.project?.name,
    version: entry.versionNumber ?? undefined,
    withAgent: false,
  };
}

function toFeedEvent(entry: ActivityEntry): FeedEvent {
  const shared = about(entry);
  switch (entry.kind) {
    case "thread": {
      const thread = entry.thread!;
      const shown = (record: typeof thread.opener) => ({author: record.author.name, at: record.createdAt, atMs: instant(record.createdAt), body: record.body, id: record.id});
      return {
        ...shared, excerpt: firstLine(thread.opener.body), id: `comment:${thread.id}`,
        needsYou: thread.state === "needs_you",
        thread: {...shown(thread.opener), isResolved: thread.isResolved, key: thread.id, path: thread.path ?? undefined, replies: thread.replies.map(shown)},
        type: "comment", verb: entry.verb === "replied" ? "replied on" : "commented on", withAgent: thread.state === "with_agent",
      };
    }
    case "version":
      return {...shared, fromVersion: entry.versionNumber !== null && entry.versionNumber > 1 ? entry.versionNumber - 1 : null,
        id: `version:${entry.id}`, type: "version", verb: entry.verb === "restored" ? "restored" : "published"};
    case "resolution":
      return {...shared, excerpt: entry.excerpt ?? "", id: `resolution:${entry.id}`, type: "resolution", verb: `${entry.verb} a conversation on`};
    case "thread_deleted":
      return {...shared, detail: entry.artifact?.name ?? notRecorded, icon: "bi-trash", id: `deleted:${entry.id}`, type: "admin", verb: "deleted a conversation on"};
    case "agent": {
      const agent = entry.agent!;
      return {...shared, agent: agent.name, id: `agent:${entry.id}`, state: dispatchLabels[agent.dispatchState],
        type: "agent", verb: entry.verb === "answered" ? "answered conversations on" : "sent conversations on", withAgent: activeDispatch.has(agent.dispatchState)};
    }
    case "access":
      return {...shared, from: entry.access?.from === null || entry.access === undefined ? notRecorded : accessLabels[entry.access.from],
        id: `access:${entry.id}`, to: entry.access === undefined ? notRecorded : accessLabels[entry.access.to], type: "access", verb: "changed access on"};
    case "admin": {
      const words = adminWords[entry.verb] ?? {icon: "bi-gear", verb: entry.verb};
      const adminOnly = entry.verb !== "created" && entry.verb !== "archived" && entry.verb !== "unarchived";
      return {...shared, adminOnly, detail: entry.subject?.name ?? notRecorded, icon: words.icon, id: `admin:${entry.id}`, type: "admin", verb: words.verb};
    }
  }
}

/** Map API entries to the vendored feed's events, keeping the server's newest-first order. */
export function toFeedEvents(entries: readonly ActivityEntry[]): FeedEvent[] {
  return entries.map(toFeedEvent);
}

/** Newest first (unreadable times last), then consecutive version bursts merged. */
export function mergedFeed(events: readonly FeedEvent[]): FeedEvent[] {
  return mergeBursts(sortEvents(events)) as FeedEvent[];
}

/** The merged feed grouped under day headers, exactly as the vendored feed renders it. */
export function feedGroups(events: readonly FeedEvent[], now: number): ReturnType<typeof groupByDay> {
  return groupByDay(mergedFeed(events), now);
}
```

  If TypeScript reports that the vendored `.d.ts` `ActivityEvent.thread` has no `atMs`, `path` or reply `atMs`, intersect locally rather than editing the vendored file: `thread?: ActivityEvent["thread"] & {atMs: number; path?: string; replies: Array<{atMs: number}>}`. Slice 1's typings come from Design and must not be edited by hand.

- [ ] **Step 4: Implement page merging.** Create `apps/web/src/review/activity/activity-pages.ts`:

```ts
import type {ActivityEntry} from "@/api/client";

const threadOf = (entry: ActivityEntry): string | null => entry.kind === "thread" ? entry.thread?.id ?? null : null;

/** Append an older page, dropping entries (by id) or threads already shown nearer the top. */
export function appendPage(loaded: readonly ActivityEntry[], next: readonly ActivityEntry[]): ActivityEntry[] {
  const ids = new Set(loaded.map((entry) => entry.id));
  const threads = new Set(loaded.map(threadOf).filter((id): id is string => id !== null));
  const out = [...loaded];
  for (const entry of next) {
    const thread = threadOf(entry);
    if (ids.has(entry.id) || (thread !== null && threads.has(thread))) continue;
    ids.add(entry.id);
    if (thread !== null) threads.add(thread);
    out.push(entry);
  }
  return out;
}

/** Put a re-read first page on top; keep older loaded entries the new page does not supersede. */
export function refreshFirstPage(loaded: readonly ActivityEntry[], first: readonly ActivityEntry[]): ActivityEntry[] {
  const oldest = first.at(-1)?.at;
  const older = oldest === undefined ? [] : loaded.filter((entry) => entry.at < oldest);
  return appendPage(first, older);
}
```

- [ ] **Step 5: Run the adapter and page tests.**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review/activity`
Expected: PASS (13 tests).

- [ ] **Step 6: Implement the hooks.** Create `apps/web/src/review/activity/use-activity-feed.ts`:

```ts
import {useCallback, useEffect, useRef, useState} from "react";

import {api, type ActivityEntry} from "@/api/client";
import type {ActivityFilters} from "@/review/review-routes";

import {appendPage, refreshFirstPage} from "./activity-pages";

const pageSize = 30;

export interface ActivityFeedState {
  readonly entries: readonly ActivityEntry[];
  readonly hasMore: boolean;
  readonly phase: "loading" | "ready" | "failed";
  readonly insertLocal: (entry: ActivityEntry) => void;
  readonly loadOlder: () => void;
  readonly reload: () => void;
  /** Swap a thread entry's snapshot (full replies after hydration, a new reply, a resolve). */
  readonly replaceThread: (threadId: string, thread: NonNullable<ActivityEntry["thread"]>) => void;
}

/** One filtered feed: first page, cursor paging, re-read on focus, own mutations shown at once. */
export function useActivityFeed(filters: ActivityFilters): ActivityFeedState {
  const [entries, setEntries] = useState<readonly ActivityEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const generation = useRef(0);
  const key = JSON.stringify(filters);
  const request = useCallback((next: string | null) => api.listActivity({
    cursor: next, limit: pageSize, projects: [...filters.projects], q: filters.q, segment: filters.segment, types: [...filters.types],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the filters' value identity
  }), [key]);

  const loadFirst = useCallback((mode: "replace" | "refresh") => {
    const mine = ++generation.current;
    if (mode === "replace") setPhase("loading");
    request(null).then((page) => {
      if (generation.current !== mine) return;
      setEntries((current) => mode === "replace" ? page.items : refreshFirstPage(current, page.items));
      if (mode === "replace") setCursor(page.nextCursor);
      setPhase("ready");
    }, () => {
      // A failed background re-read keeps what is on screen.
      if (generation.current === mine && mode === "replace") setPhase("failed");
    });
  }, [request]);

  useEffect(() => loadFirst("replace"), [loadFirst]);
  useEffect(() => {
    const refresh = (): void => loadFirst("refresh");
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [loadFirst]);

  const loadOlder = useCallback(() => {
    if (cursor === null) return;
    const mine = generation.current;
    request(cursor).then((page) => {
      if (generation.current !== mine) return;
      setEntries((current) => appendPage(current, page.items));
      setCursor(page.nextCursor);
    }, () => undefined);
  }, [cursor, request]);

  const insertLocal = useCallback((entry: ActivityEntry) => {
    setEntries((current) => appendPage([entry], current.filter((existing) =>
      !(existing.kind === "thread" && entry.kind === "thread" && existing.thread?.id === entry.thread?.id))));
  }, []);
  const replaceThread = useCallback((threadId: string, thread: NonNullable<ActivityEntry["thread"]>) => {
    setEntries((current) => current.map((entry) => entry.kind === "thread" && entry.thread?.id === threadId ? {...entry, thread} : entry));
  }, []);

  return {entries, hasMore: cursor !== null, insertLocal, loadOlder, phase, reload: () => loadFirst("refresh"), replaceThread};
}
```

  Create `apps/web/src/review/activity/use-activity-summary.ts`:

```ts
import {useCallback, useEffect, useRef, useState} from "react";

import {api, type ActivitySummary} from "@/api/client";

/** The counts behind the nav badge, metric cards and project rows; a failure never blocks the feed. */
export function useActivitySummary(projects: readonly string[]) {
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const generation = useRef(0);
  const key = projects.join("\u0000");
  const reload = useCallback(() => {
    const mine = ++generation.current;
    api.activitySummary(key === "" ? [] : key.split("\u0000")).then((next) => {
      if (generation.current !== mine) return;
      setSummary(next);
      setPhase("ready");
    }, () => {
      if (generation.current === mine) setPhase("failed");
    });
  }, [key]);
  useEffect(() => {
    reload();
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
  return {phase, reload, summary};
}
```

- [ ] **Step 7: Confirm the vendored activity components are exposed.** Task 1.2 Step 5 already built them in `apps/web/src/ui/review-ui.ts`. Run `grep -n "ActivityFeed\|ActivityHeader\|ActivityToolbar\|ActivityEvent" apps/web/src/ui/review-ui.ts`. Expected: the destructured export includes `ActivityFeed`, `ActivityHeader` and `ActivityToolbar`, and the type re-export includes `ActivityEvent`. If any is missing, Task 1.2 is not merged; stop.

- [ ] **Step 8: Write the feed panel.** Create `apps/web/src/review/activity/activity-feed-panel.tsx`. It holds everything the Activity screen and slice 6's per-project section share.

```tsx
import {useEffect, useMemo, useState} from "react";

import {api, type ActivityEntry} from "@/api/client";
import {CommentComposer} from "@/components/comments/comment-composer";
import {useCommentDraft} from "@/components/comments/comment-drafts";
import {maximumCommentBodyCharacters} from "@/components/comments/comment-limits";
import {createRequestLimiter} from "@/lib/request-limiter";
import {readStored, writeStored} from "@/lib/safe-storage";
import {navigateReview, workspaceHref} from "@/review/review-routes";
import {ActivityFeed} from "@/ui/review-ui";
import {useToasts} from "@/ui/toasts";

import {type FeedEvent, mergedFeed, toFeedEvents} from "./activity-adapter";
import type {ActivityFeedState} from "./use-activity-feed";

const expandedKey = "activity-expanded-threads";
const hydrate = createRequestLimiter(4);

function readExpanded(): string[] {
  try {
    const parsed: unknown = JSON.parse(readStored("session", expandedKey) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function ReplyComposer({entry, onDone, onPosted, principalId}: {
  readonly entry: ActivityEntry; readonly onDone: () => void; readonly onPosted: (entry: ActivityEntry) => void; readonly principalId: string;
}) {
  const thread = entry.thread!;
  const toasts = useToasts();
  const draft = useCommentDraft({artifactId: entry.artifact!.id, principalId, threadId: thread.id, versionId: null});
  return (
    <CommentComposer
      autoFocus cancelLabel="Cancel" draftRestored={draft.restored} initialBody={draft.initialBody}
      label={`Reply on ${entry.artifact!.name}`} maximumCharacters={maximumCommentBodyCharacters}
      onBodyChange={draft.onBodyChange} onCancel={onDone} onDiscardDraft={draft.onDiscard}
      onSubmit={async (body, idempotencyKey) => {
        try {
          const {reply} = await api.createCommentReply(entry.project!.id, entry.artifact!.id, thread.id, body, idempotencyKey);
          draft.onPosted();
          const shown = {author: {kind: reply.author.principalKind, name: reply.author.displayName}, body: reply.body, createdAt: reply.createdAt, id: reply.id};
          onPosted({...entry, actor: {kind: reply.author.principalKind, name: reply.author.displayName}, at: reply.createdAt,
            id: `local:${reply.id}`, thread: {...thread, replies: [...thread.replies, shown], replyCount: thread.replyCount + 1}, verb: "replied"});
          onDone();
          return true;
        } catch {
          toasts.push({message: "Your reply is kept as a draft. Try again.", title: "Reply not posted", variant: "danger"});
          return false;
        }
      }}
      submitLabel="Reply"
    />
  );
}

/** The feed body shared by Activity and a project's Activity section. */
export function ActivityFeedPanel({feed, filtered, label, onClearFilters, principalId, renderThumbnail, stickyTop}: {
  readonly feed: ActivityFeedState; readonly filtered: boolean; readonly label: string; readonly onClearFilters: () => void;
  readonly principalId: string; readonly renderThumbnail?: (event: FeedEvent) => React.ReactNode; readonly stickyTop: number;
}) {
  const toasts = useToasts();
  const [expanded, setExpanded] = useState<string[]>(readExpanded);
  const [replying, setReplying] = useState<string | null>(null);
  const events = useMemo(() => mergedFeed(toFeedEvents(feed.entries)), [feed.entries]);
  const byThread = useMemo(() => new Map(feed.entries.filter((entry) => entry.kind === "thread").map((entry) => [entry.thread!.id, entry])), [feed.entries]);

  // The snapshot holds the newest two replies; fetch the rest so "Show N earlier replies" can fold them.
  useEffect(() => {
    let current = true;
    for (const entry of byThread.values()) {
      const thread = entry.thread!;
      if (thread.replyCount <= thread.replies.length) continue;
      void hydrate(() => api.comment(entry.project!.id, entry.artifact!.id, thread.id)).then((details) => {
        if (!current) return;
        feed.replaceThread(thread.id, {...thread, replies: details.replies.map((reply) => ({
          author: {kind: reply.author.principalKind, name: reply.author.displayName}, body: reply.body, createdAt: reply.createdAt, id: reply.id,
        }))});
      }, () => undefined);
    }
    return () => {
      current = false;
    };
  }, [byThread, feed]);

  const open = (event: FeedEvent): void => {
    const entry = event.entry;
    if (entry.artifact === null || entry.project === null) return;
    navigateReview(workspaceHref({
      artifactId: entry.artifact.id, path: entry.thread?.path ?? null, projectId: entry.project.id,
      threadId: entry.thread?.id ?? entry.threadId ?? null, versionId: entry.thread?.versionId ?? null, view: null,
    }));
  };
  const resolve = async (threadKey: string, next: boolean): Promise<void> => {
    const entry = byThread.get(threadKey);
    if (entry === undefined) return;
    try {
      const saved = await api.updateComment(entry.project!.id, entry.artifact!.id, threadKey, {state: next ? "resolved" : "open"});
      feed.replaceThread(threadKey, {...entry.thread!, isResolved: saved.state === "resolved", state: saved.state === "resolved" ? "resolved" : "needs_you"});
      feed.reload();
    } catch {
      toasts.push({message: "The conversation was not changed. Try again.", title: next ? "Not resolved" : "Not reopened", variant: "danger"});
    }
  };

  return (
    <ActivityFeed
      events={events}
      expandedIds={expanded}
      filtered={filtered}
      hasMore={feed.hasMore}
      label={label}
      now={Date.now()}
      onClearFilters={onClearFilters}
      onOpen={open}
      onReply={(threadKey) => setReplying((current) => current === threadKey ? null : threadKey)}
      onResolve={(threadKey, next) => void resolve(threadKey, next)}
      onShowOlder={feed.loadOlder}
      onToggleReplies={(threadKey, isOpen) => setExpanded((current) => {
        const next = isOpen ? [...new Set([...current, threadKey])] : current.filter((id) => id !== threadKey);
        writeStored("session", expandedKey, JSON.stringify(next));
        return next;
      })}
      remaining={0}
      renderReplyComposer={(threadKey) => {
        const entry = byThread.get(threadKey);
        return replying !== threadKey || entry === undefined ? null : (
          <ReplyComposer entry={entry} onDone={() => setReplying(null)} onPosted={(local) => {
            feed.insertLocal(local);
            feed.reload();
          }} principalId={principalId} />
        );
      }}
      renderThumbnail={renderThumbnail as ((event: unknown) => React.ReactNode) | undefined}
      stickyTop={stickyTop}
    />
  );
}
```

  "Show older" passes `remaining={0}` because the server pages by cursor and reports no total. Task 1.4 already changed the vendored `activity-ui.jsx` upstream to print plain "Show older" when `remaining` is `0`, so nothing more is needed here. Never edit the vendored copy.

- [ ] **Step 8b: Write the shared feed states and the self-loading section.** Create `apps/web/src/review/activity/activity-feed-section.tsx`. The Activity screen renders `ActivityFeedBody` for its URL-driven feed. Slice 6 mounts `ActivityFeedSection` in a project's details. Both get the same loading, failure, empty and "Show older" behaviour.

```tsx
import {useMemo} from "react";

import {SurfaceState} from "@/arkcase";
import {emptyActivityFilters, type ActivityFilters} from "@/review/review-routes";

import {ActivityFeedPanel} from "./activity-feed-panel";
import {type ActivityFeedState, useActivityFeed} from "./use-activity-feed";

/** One feed's loading, failure, empty and loaded states. The empty state comes from the vendored feed. */
export function ActivityFeedBody({feed, filtered, label, onClearFilters, onRetry, principalId, stickyTop}: {
  readonly feed: ActivityFeedState; readonly filtered: boolean; readonly label: string; readonly onClearFilters: () => void;
  readonly onRetry: () => void; readonly principalId: string; readonly stickyTop: number;
}) {
  if (feed.phase === "loading") {
    return <SurfaceState loadingTitle="Loading activity" noun="events" phase="loading" skeleton={4} />;
  }
  if (feed.phase === "failed") {
    return (
      <SurfaceState failedBody="Activity could not be read." failedTitle="Activity could not load" noun="events"
        onRetry={onRetry} phase="failed" />
    );
  }
  return (
    <ActivityFeedPanel
      feed={feed} filtered={filtered} label={label} onClearFilters={onClearFilters}
      principalId={principalId} stickyTop={stickyTop}
    />
  );
}

/** The feed narrowed to one project, or every project when `projectId` is null. Its filters are not in the URL. */
export function ActivityFeedSection({principalId, projectId}: {readonly principalId: string; readonly projectId: string | null}) {
  const filters = useMemo<ActivityFilters>(
    () => ({...emptyActivityFilters, projects: projectId === null ? [] : [projectId]}),
    [projectId],
  );
  const feed = useActivityFeed(filters);
  return (
    <ActivityFeedBody
      feed={feed} filtered={false} label={projectId === null ? "Activity" : "Project activity"}
      onClearFilters={() => undefined} onRetry={feed.reload} principalId={principalId} stickyTop={0}
    />
  );
}
```

  `useActivityFeed` keys its loads on the filter values, so the memoized `filters` keeps a re-render from reloading. The section's behaviour is proven where it is first mounted: slice 6's `ACT-006-B` browser test (Task 6.6) checks that a project's Activity shows its own artifact and none from another project.

- [ ] **Step 9: Write the Activity screen.** Create `apps/web/src/review/activity/activity-screen.tsx`:

```tsx
import {useEffect, useState, type CSSProperties} from "react";

import type {Project, Session} from "@/api/client";
import {Button, Popover} from "@/arkcase";
import {activityHref, navigateReview, type ActivityFilters} from "@/review/review-routes";
import {ActivityHeader, ActivityToolbar} from "@/ui/review-ui";
import {CopyableCode} from "@/ui/copyable-code";

import {ActivityFeedBody} from "./activity-feed-section";
import {useActivityFeed} from "./use-activity-feed";
import {useActivitySummary} from "./use-activity-summary";

const screenStyle = {margin: "0 auto", maxWidth: 1180, padding: "20px 20px 48px", width: "100%"} satisfies CSSProperties;
const segmentIds = {"All": "all", "Needs you": "needs_you", "With an agent": "with_agent"} as const;
const segmentLabels = {all: "All", needs_you: "Needs you", with_agent: "With an agent"} as const;
const searchDebounceMilliseconds = 250;

/** Everything that happened across the installation, newest first, with what needs you one click away. */
export function ActivityScreen({filters, projects, session}: {
  readonly filters: ActivityFilters; readonly projects: readonly Project[]; readonly session: Session;
}) {
  const feed = useActivityFeed(filters);
  const {phase: summaryPhase, reload: reloadSummary, summary} = useActivitySummary([]);
  const [query, setQuery] = useState(filters.q);
  const [dock, setDock] = useState(0);
  const [publishOpen, setPublishOpen] = useState(false);
  const change = (next: Partial<ActivityFilters>): void => navigateReview(activityHref({...filters, ...next}), {replace: true});
  useEffect(() => setQuery(filters.q), [filters.q]);
  useEffect(() => {
    if (query.trim() === filters.q) return undefined;
    const timer = setTimeout(() => change({q: query.trim().slice(0, 100)}), searchDebounceMilliseconds);
    return () => clearTimeout(timer);
  });
  const filtered = filters.segment !== "all" || filters.projects.length > 0 || filters.types.length > 0 || filters.q !== "";
  const count = (value: number | undefined): string => summaryPhase === "ready" && value !== undefined ? String(value) : "—";
  const artifactCount = summary?.projects.reduce((total, project) => total + project.artifactCount, 0);
  const command = "artifactserver publish ./dist";

  return (
    <section aria-label="Activity" style={screenStyle}>
      <ActivityHeader
        action={(
          <Popover label="Publish artifact" onOpenChange={setPublishOpen} open={publishOpen} placement="bottom-end"
            trigger={<Button icon="bi-upload" variant="primary">Publish artifact</Button>}>
            <CopyableCode code={command} copiedLabel="Publish command copied" copyLabel="Copy publish command" tone="navy" />
          </Popover>
        )}
        metrics={[
          {id: "needs", label: "Needs you", onClick: () => change({segment: filters.segment === "needs_you" ? "all" : "needs_you"}), pressed: filters.segment === "needs_you", value: count(summary?.needsYou)},
          {id: "agent", label: "With an agent", onClick: () => change({segment: filters.segment === "with_agent" ? "all" : "with_agent"}), pressed: filters.segment === "with_agent", value: count(summary?.withAgent)},
          {id: "open", label: "Open conversations", value: count(summary?.openConversations)},
          {id: "review", label: "Artifacts in review", value: count(summary?.artifactsInReview)},
        ]}
        summary={`${projects.length} ${projects.length === 1 ? "project" : "projects"} · ${artifactCount === undefined ? "—" : artifactCount} artifacts`}
        title="Activity"
      />
      <ActivityToolbar
        counts={summary === null ? {} : {"Needs you": summary.needsYou, "With an agent": summary.withAgent}}
        onHeight={setDock}
        onProjects={(ids) => change({projects: ids})}
        onQuery={setQuery}
        onSegment={(label) => change({segment: segmentIds[label as keyof typeof segmentIds] ?? "all"})}
        onTypes={(ids) => change({types: ids as ActivityFilters["types"]})}
        projects={projects.map((project) => ({id: project.id, name: project.name}))}
        query={query}
        segment={segmentLabels[filters.segment]}
        selectedProjects={[...filters.projects]}
        types={filters.types.filter((type) => type !== "admin") as Array<"comments" | "versions" | "agents" | "access">}
      />
      <ActivityFeedBody
        feed={feed} filtered={filtered} label="Activity"
        onClearFilters={() => navigateReview(activityHref(), {replace: true})}
        onRetry={() => { feed.reload(); reloadSummary(); }}
        principalId={session.principal.id}
        stickyTop={dock}
      />
    </section>
  );
}
```

  Thumbnails are wired once, in `ActivityFeedBody`, by Task 5.4, so the screen and the project section both get them. The vendored toolbar's Types menu lists the prototype's four types, so `admin` stays URL-only.

- [ ] **Step 10: Render Activity.** In `apps/web/src/review/review-app.tsx`, replace `<ReviewQueueScreen projects={projects} />` in the `activity` branch with `<ActivityScreen filters={route.filters} projects={projects} session={session} />`, imported from `./activity/activity-screen.tsx`. Leave the `ReviewQueueScreen` import in place until Task 5.6 deletes the queue.

- [ ] **Step 11: Write the failing browser spec, including the hostile body case.** Create `tests/browser/activity.spec.ts`:

```ts
import {expect, test} from "@playwright/test";

import {ApiClient, dispatchCreationSchema} from "../support/agent-dispatch.js";
import {publishNew, publishVersion, type PublishResponse} from "../support/publishing.js";
import {localLogin, startBrowserFixture, stopBrowserFixture, type BrowserFixture} from "./browser-fixture.js";
import {createReplyOverApi, createThreadOverApi} from "./comment-api.js";

const key = (name: string): string => `activity-spec-${name}-key`;

async function publish(fixture: BrowserFixture, name: string, keyName: string, projectId = "prj_default"): Promise<PublishResponse> {
  return (await publishNew(fixture.server, fixture.installation, {
    accessSetting: "account_required",
    content: `<!doctype html><html lang="en"><head><title>${name}</title></head><body><h1 id="title">${name}</h1></body></html>`,
    idempotencyKey: key(keyName), mediaType: "text/html; charset=utf-8", name, path: "index.html", projectId,
  })).body;
}

async function thread(fixture: BrowserFixture, published: PublishResponse, body: string, keyName: string): Promise<string> {
  return (await createThreadOverApi(fixture, {
    artifactId: published.artifact.id, body, idempotencyKey: key(keyName), path: "index.html",
    projectId: published.artifact.projectId, versionId: published.version.id,
  })).id;
}

test.describe("Activity", () => {
  test("ACT-005-B: the feed shows versions, bursts and conversations under day headers, folds long threads, replies and resolves inline, filters through the URL, and opens the thread", async ({browser}) => {
    test.setTimeout(120_000);
    const fixture = await startBrowserFixture(browser);
    try {
      const burst = await publish(fixture, "Activity burst fixture", "burst-1");
      let previous = burst.version.id;
      for (const n of [2, 3]) {
        previous = (await publishVersion(fixture.server, fixture.installation, {
          artifactId: burst.artifact.id, content: `<!doctype html><html lang="en"><title>v${n}</title><h1>v${n}</h1></html>`,
          expectedCurrentVersionId: previous, idempotencyKey: key(`burst-${n}`),
        })).body.version.id;
      }
      const talked = await publish(fixture, "Activity conversation fixture", "talk");
      const threadId = await thread(fixture, talked, "Tighten the headline.", "talk-thread");
      for (const n of [1, 2, 3, 4, 5]) {
        await createReplyOverApi(fixture, {artifactId: talked.artifact.id, body: `Reply number ${n}.`, idempotencyKey: key(`reply-${n}`), projectId: talked.artifact.projectId, threadId});
      }

      await localLogin(fixture);
      const page = fixture.page;
      await page.goto(`${fixture.server.baseUrl}/review`);
      await expect(page.getByRole("heading", {exact: true, level: 1, name: "Activity"})).toBeVisible();
      await expect(page.getByRole("heading", {exact: true, level: 2, name: "Today"})).toBeVisible();
      await expect(page.getByText(/published v1–v3 of Activity burst fixture/u)).toBeVisible();
      await expect(page.locator("[data-activity-feed]")).toContainText(/\d{1,2}:\d{2} (AM|PM)/u);

      const conversation = page.getByRole("region", {name: "Conversation on Activity conversation fixture"}).or(
        page.getByLabel("Conversation on Activity conversation fixture"));
      await expect(conversation.getByText("Reply number 5.")).toBeVisible();
      await expect(conversation.getByText("Reply number 1.")).toHaveCount(0);
      await conversation.getByRole("button", {name: "Show 3 earlier replies"}).click();
      await expect(conversation.getByText("Reply number 1.")).toBeVisible();

      await conversation.getByRole("button", {name: "Reply"}).first().click();
      await page.getByRole("textbox", {name: "Reply on Activity conversation fixture"}).fill("Inline from Activity.");
      await page.getByRole("button", {exact: true, name: "Reply"}).last().click();
      await expect(conversation.getByText("Inline from Activity.")).toBeVisible();

      await page.getByRole("radio", {name: /Needs you/u}).click();
      await expect(page).toHaveURL(/\/review\?segment=needs_you$/u);
      await expect(page.getByText(/Activity burst fixture/u)).toHaveCount(0);
      await page.getByRole("searchbox", {name: "Search activity"}).fill("headline");
      await expect(page).toHaveURL(/q=headline/u);
      await page.goBack();
      await expect(page).toHaveURL(/\/review\?segment=needs_you$/u);
      await page.getByRole("radio", {name: /^All/u}).click();

      await conversation.getByRole("button", {name: "Resolve"}).first().click();
      await expect(page.getByText(/resolved a conversation on Activity conversation fixture/u)).toBeVisible();

      await page.getByRole("button", {name: "Open Activity conversation fixture in review"}).first().click();
      await expect(page).toHaveURL(new RegExp(`artifact=${talked.artifact.id}`, "u"));
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ACT-005-B: the Publish artifact popover offers the CLI command and the metric cards switch the segment", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publish(fixture, "Activity metric fixture", "metric");
      await thread(fixture, published, "Count me.", "metric-thread");
      await localLogin(fixture);
      const page = fixture.page;
      await page.goto(`${fixture.server.baseUrl}/review`);
      await page.getByRole("button", {name: "Publish artifact"}).click();
      await expect(page.getByRole("dialog", {name: "Publish artifact"}).getByText("artifactserver publish ./dist")).toBeVisible();
      await page.keyboard.press("Escape");
      await page.getByRole("button", {name: /Needs you/u}).first().click();
      await expect(page).toHaveURL(/segment=needs_you/u);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ACT-005-F: a hostile comment body renders as inert text inside its card and stays searchable", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publish(fixture, "Activity hostile fixture", "hostile");
      const hostile = `‮evil‬​<img src=x onerror="window.__pwned=1">${"W".repeat(10_000 - 64)}`;
      await thread(fixture, published, hostile.slice(0, 8_192), "hostile-thread");
      await localLogin(fixture);
      const page = fixture.page;
      await page.goto(`${fixture.server.baseUrl}/review`);
      const card = page.getByLabel("Conversation on Activity hostile fixture");
      await expect(card).toBeVisible();
      expect(await page.evaluate(() => (window as {__pwned?: number}).__pwned)).toBeUndefined();
      await expect(card.locator("img")).toHaveCount(0);
      const width = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(width).toBeLessThanOrEqual(0);
      await page.getByRole("searchbox", {name: "Search activity"}).fill("onerror");
      await expect(page.getByLabel("Conversation on Activity hostile fixture")).toBeVisible();
      await page.getByRole("searchbox", {name: "Search activity"}).fill("%_\\");
      await expect(page.getByText("Nothing matches these filters")).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ACT-005-F: a failed feed read offers Retry, and a failed summary leaves the feed working", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await publish(fixture, "Activity retry fixture", "retry");
      await localLogin(fixture);
      const page = fixture.page;
      const fail = {body: JSON.stringify({error: {code: "INTERNAL_ERROR", message: "Storage is unavailable."}}), contentType: "application/json", status: 500};
      await page.route("**/api/v1/activity/summary**", (route) => route.fulfill(fail));
      await page.route(/\/api\/v1\/activity\?/u, (route) => route.fulfill(fail));
      await page.goto(`${fixture.server.baseUrl}/review`);
      await expect(page.getByText("Activity could not load")).toBeVisible();
      await page.unroute(/\/api\/v1\/activity\?/u);
      await page.getByRole("button", {name: "Retry"}).click();
      await expect(page.getByText(/published v1 of Activity retry fixture/u)).toBeVisible();
      await expect(page.getByRole("button", {name: /Needs you/u}).first()).toContainText("—");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ACT-005-F: the agent segment shows only threads held by an active send", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const owner = new ApiClient(fixture.server, fixture.installation.apiToken);
      const agent = await owner.registerAgent({agentSessionId: "activity-session", connectionKey: "activity-connection-key", displayName: "solo", workingDirectory: "/work/solo"});
      const held = await publish(fixture, "Activity held fixture", "held");
      const heldThread = await thread(fixture, held, "Agent, take this.", "held-thread");
      const response = await owner.sendDispatch({agentId: agent.id, idempotencyKey: key("held-send"), projectId: "prj_default", threadIds: [heldThread]});
      expect(dispatchCreationSchema.parse(await response.json()).dispatch.state).toBe("queued");
      const free = await publish(fixture, "Activity free fixture", "free");
      await thread(fixture, free, "Still mine.", "free-thread");
      await localLogin(fixture);
      await fixture.page.goto(`${fixture.server.baseUrl}/review?segment=with_agent`);
      await expect(fixture.page.getByLabel("Conversation on Activity held fixture")).toBeVisible();
      await expect(fixture.page.getByLabel("Conversation on Activity free fixture")).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
```

  `createReplyOverApi`'s parameter names come from `tests/browser/comment-api.ts:52`. Match them exactly; that file exports `artifactId`, `body`, `idempotencyKey`, `projectId` and `threadId`.

- [ ] **Step 12: Run the browser spec to confirm it fails, implement until it passes, then run it again.**

Run: `pnpm build && pnpm exec playwright test tests/browser/activity.spec.ts --project=chromium`
Expected on the first run: FAIL on the "Activity" heading if Step 10 is not wired. After Steps 7–10, the expected result is PASS for all five tests.

- [ ] **Step 13: Commit.**

```bash
git add apps/web/src/review/activity apps/web/src/review/review-app.tsx tests/browser/activity.spec.ts
git commit -m "Show the installation activity feed in place of the review queue

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5.4: Lazy conversation thumbnails

**Files:**
- Create: `apps/web/src/review/activity/activity-thumbnail.tsx`
- Create: `apps/web/src/review/activity/thumbnail-plan.ts`
- Create: `apps/web/src/review/activity/thumbnail-plan.test.ts`
- Modify: `apps/web/src/review/activity/activity-feed-section.tsx`
- Modify, only if `thread.versionId` and `thread.path` are absent: the slice-4 activity wire mapping in `src/http`, plus `apps/web/src/api/client.ts`
- Test: `tests/browser/activity.spec.ts`

**Interfaces:**
- Consumes:
  - The wire `thread.versionId` (string) and `thread.path` (string or null). Slice 4 must emit both from `ActivityThreadSnapshot.opener.versionId` and `.path`. Step 1 verifies this.
  - `api.version`, `api.versionFile` and `api.previewLease`.
  - `reviewAnchorSchema` and `frameMessageSchema` from `@/review-frame/protocol`; `arkcaseFrameTokens` and `frameIsLight` from `@/theme/frame-theme`.
- Produces:
  - `ActivityThumbnail({event}: {event: FeedEvent})`.
  - `thumbnailPlan(entry: ActivityEntry, entryPath: string | null): {kind: "tile"; reason: "not-html" | "no-anchor" | "no-artifact"} | {kind: "frame"; path: string}`.

- [ ] **Step 1: Confirm the wire carries the version and path.**

Run: `grep -rn "versionId" src/http | grep -i activity; grep -n "versionId" apps/web/src/api/client.ts | grep -i activity`

Expected: both the server mapping and the zod `activityEntrySchema.thread` include `versionId` and `path`.

If either is missing, add both:
- Server: in the activity wire mapping, write `versionId: snapshot.opener.versionId, path: snapshot.opener.path`.
- Client: in the zod `thread` object, add `versionId: z.string(), path: z.string().nullable()`.
- Server test: in slice 4's ACT-003-B HTTP test, add `expect(entry.thread).toMatchObject({path: "index.html", versionId: published.version.id})`.

Commit that change separately with the message "Carry each feed thread's version and path".

- [ ] **Step 2: Write the failing plan tests.** Create `apps/web/src/review/activity/thumbnail-plan.test.ts`:

```ts
import {describe, expect, it} from "vitest";

import type {ActivityEntry} from "@/api/client";

import {thumbnailPlan} from "./thumbnail-plan";

const anchor = {htmlAnchor: {point: {x: 0.5, y: 0.5}, selector: "#title", tagName: "H1"}, originalText: "Title"};
const entry = (over: {path?: string | null; anchor?: unknown; artifact?: null}): ActivityEntry => ({
  actor: {kind: "human", name: "Dana"}, artifact: over.artifact === null ? null : {archived: false, id: "art", name: "A"},
  at: "2026-09-30T10:00:00.000Z", id: "act", kind: "thread", project: {id: "prj", name: "P"}, verb: "commented", versionNumber: 1,
  thread: {anchor: "anchor" in over ? over.anchor : anchor, id: "thr", isResolved: false,
    opener: {author: {kind: "human", name: "Dana"}, body: "b", createdAt: "2026-09-30T10:00:00.000Z", id: "thr"},
    path: over.path === undefined ? "index.html" : over.path, replies: [], replyCount: 0, state: "needs_you", versionId: "ver"},
} as ActivityEntry);

describe("thumbnailPlan", () => {
  it("ACT-005: an anchored HTML page renders in the review frame", () => {
    expect(thumbnailPlan(entry({}), null)).toEqual({kind: "frame", path: "index.html"});
    expect(thumbnailPlan(entry({path: null}), "docs/Index.HTM")).toEqual({kind: "frame", path: "docs/Index.HTM"});
  });

  it("ACT-005: a non-HTML entry, a missing or unreadable anchor, or a missing artifact shows the file tile", () => {
    expect(thumbnailPlan(entry({path: "report.pdf"}), null)).toEqual({kind: "tile", reason: "not-html"});
    expect(thumbnailPlan(entry({path: null}), "image.png")).toEqual({kind: "tile", reason: "not-html"});
    expect(thumbnailPlan(entry({anchor: null}), null)).toEqual({kind: "tile", reason: "no-anchor"});
    expect(thumbnailPlan(entry({anchor: {kind: "page"}}), null)).toEqual({kind: "tile", reason: "no-anchor"});
    expect(thumbnailPlan(entry({artifact: null}), null)).toEqual({kind: "tile", reason: "no-artifact"});
  });
});
```

- [ ] **Step 3: Run the tests to confirm they fail.**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review/activity/thumbnail-plan.test.ts`
Expected: FAIL with "Cannot find module './thumbnail-plan'".

- [ ] **Step 4: Implement the plan.** Create `apps/web/src/review/activity/thumbnail-plan.ts`:

```ts
import type {ActivityEntry} from "@/api/client";
import {reviewAnchorSchema} from "@/review-frame/protocol";

export type ThumbnailPlan =
  | {readonly kind: "frame"; readonly path: string}
  | {readonly kind: "tile"; readonly reason: "not-html" | "no-anchor" | "no-artifact"};

/** Decide, before any request, whether a conversation's screen can be drawn at all. */
export function thumbnailPlan(entry: ActivityEntry, entryPath: string | null): ThumbnailPlan {
  const thread = entry.thread;
  if (thread === undefined || entry.artifact === null || entry.project === null) return {kind: "tile", reason: "no-artifact"};
  const path = thread.path ?? entryPath;
  if (path === null || !/\.html?$/iu.test(path)) return {kind: "tile", reason: "not-html"};
  const anchor = reviewAnchorSchema.safeParse(thread.anchor);
  if (!anchor.success || anchor.data.htmlAnchor === null) return {kind: "tile", reason: "no-anchor"};
  return {kind: "frame", path};
}
```

- [ ] **Step 5: Run the plan tests.**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review/activity/thumbnail-plan.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Implement the thumbnail.** Create `apps/web/src/review/activity/activity-thumbnail.tsx`. The vendored feed scales whatever this renders from 800 px to 0.2 inside an `aria-hidden` box, and the 800 × 500 frame fills its 160 × 100 window.

```tsx
import {useEffect, useRef, useState, type CSSProperties} from "react";

import {api} from "@/api/client";
import {createRequestLimiter} from "@/lib/request-limiter";
import {frameMessageSchema, reviewProtocolVersion, type HostMessage} from "@/review-frame/protocol";
import {arkcaseFrameTokens, frameIsLight} from "@/theme/frame-theme";

import type {FeedEvent} from "./activity-adapter";
import {thumbnailPlan} from "./thumbnail-plan";

/** At most four conversation screens load at once, across the whole feed. */
const loadSlot = createRequestLimiter(4);
const frameReadyTimeoutMilliseconds = 10_000;
const frameStyle = {border: 0, display: "block", height: 500, width: 800} satisfies CSSProperties;
const tileStyle = {alignItems: "center", background: "var(--surface-muted, #f1f5f7)", color: "var(--text-secondary, #5a6268)",
  display: "flex", fontSize: 160, height: 500, justifyContent: "center", width: 800} satisfies CSSProperties;

type Loaded = {readonly baseHref: string; readonly entryPath: string; readonly html: string};

/** The file-type tile shown before loading, for non-HTML entries, unplaceable anchors and failures. */
function FileTile({reason}: {readonly reason: string}) {
  return <div data-thumbnail="tile" data-thumbnail-reason={reason} style={tileStyle}><i aria-hidden="true" className="bi bi-file-earmark-richtext" /></div>;
}

export function ActivityThumbnail({event}: {readonly event: FeedEvent}) {
  const entry = event.entry;
  const thread = entry.thread;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [near, setNear] = useState(false);
  const [state, setState] = useState<{kind: "idle" | "tile"; reason: string} | {kind: "frame"; loaded: Loaded}>({kind: "idle", reason: "waiting"});

  useEffect(() => {
    const root = rootRef.current;
    if (root === null || near) return undefined;
    const observer = new IntersectionObserver((records) => {
      if (records.some((record) => record.isIntersecting)) setNear(true);
    }, {rootMargin: "200px"});
    observer.observe(root);
    return () => observer.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near || thread === undefined || entry.artifact === null || entry.project === null) return undefined;
    let current = true;
    const projectId = entry.project.id;
    const artifactId = entry.artifact.id;
    const versionId = thread.versionId;
    void loadSlot(async () => {
      const entryPath = thread.path ?? (await api.version(projectId, artifactId, versionId)).entryPath;
      const plan = thumbnailPlan(entry, entryPath);
      if (plan.kind === "tile") {
        if (current) setState({kind: "tile", reason: plan.reason});
        return;
      }
      const [html, lease] = await Promise.all([api.versionFile(projectId, artifactId, versionId, plan.path), api.previewLease(projectId, artifactId, versionId)]);
      // An exact-version lease only: any other version is never drawn as this conversation's screen.
      if (lease.versionId !== versionId) throw new Error("lease version mismatch");
      const base = new URL(plan.path.split("/").map(encodeURIComponent).join("/"), lease.baseUrl);
      if (current) setState({kind: "frame", loaded: {baseHref: new URL(".", base).toString(), entryPath: plan.path, html}});
      // Hold the slot until the frame has been initialised (or gives up).
      await new Promise<void>((resolve) => {
        const done = (): void => resolve();
        setTimeout(done, frameReadyTimeoutMilliseconds);
        frameRef.current?.addEventListener("load", () => setTimeout(done, 500), {once: true});
      });
    }).catch(() => {
      if (current) setState({kind: "tile", reason: "failed"});
    });
    return () => {
      current = false;
    };
  }, [entry, near, thread]);

  useEffect(() => {
    if (state.kind !== "frame" || thread === undefined) return undefined;
    const post = (message: HostMessage): void => frameRef.current?.contentWindow?.postMessage(message, window.location.origin);
    const onMessage = (message: MessageEvent<unknown>): void => {
      if (message.source !== frameRef.current?.contentWindow || message.origin !== window.location.origin) return;
      const parsed = frameMessageSchema.safeParse(message.data);
      if (!parsed.success) return;
      if (parsed.data.type === "as-review-ready") {
        post({annotateModeActive: false, annotations: [{anchor: thread.anchor as never, body: thread.opener.body,
          state: thread.isResolved ? "resolved" : "open", threadId: thread.id}],
          baseHref: state.loaded.baseHref, entryPath: state.loaded.entryPath, html: state.loaded.html, isLight: frameIsLight(),
          readOnly: true, themeTokens: arkcaseFrameTokens(), type: "as-review-init", v: reviewProtocolVersion});
        post({threadId: thread.id, type: "as-review-focus", v: reviewProtocolVersion});
      }
      // The frame could not place this thread's anchor on the page: never show a misplaced pin.
      if (parsed.data.type === "as-review-unanchored" && parsed.data.threadIds.includes(thread.id)) setState({kind: "tile", reason: "unanchored"});
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [state, thread]);

  return (
    <div ref={rootRef} data-thumbnail-for={thread?.id}>
      {state.kind === "frame"
        ? <iframe data-thumbnail="frame" ref={frameRef} src="/review-frame" style={frameStyle} tabIndex={-1} title={`Screen of ${event.artifactName ?? "artifact"}`} />
        : <FileTile reason={state.reason} />}
    </div>
  );
}
```

- [ ] **Step 7: Use it in every feed.** In `apps/web/src/review/activity/activity-feed-section.tsx`, import `ActivityThumbnail` from `./activity-thumbnail` and pass `renderThumbnail={(event) => <ActivityThumbnail event={event} />}` to the `ActivityFeedPanel` inside `ActivityFeedBody`. The Activity screen and slice 6's project section both render through `ActivityFeedBody`, so both get thumbnails.

- [ ] **Step 8: Write the failing browser cases.** Append to `tests/browser/activity.spec.ts`. The `anchor` field must match the parameter that `createThreadOverApi` accepts in `tests/browser/comment-api.ts:79`. If that helper has no `anchor` field, add `readonly anchor?: unknown` to its input type and send it in the JSON body; the server stores the anchor unread.

```ts
test.describe("Activity thumbnails", () => {
  const anchorFor = (selector: string) => ({htmlAnchor: {point: {x: 0.5, y: 0.5}, selector, tagName: "H1"}, originalText: "Title"});

  test("ACT-005-B: an anchored conversation draws its exact version in the review frame, lazily and at most four at a time", async ({browser}) => {
    test.setTimeout(120_000);
    const fixture = await startBrowserFixture(browser);
    try {
      for (const n of [1, 2, 3, 4, 5, 6]) {
        const published = await publish(fixture, `Activity thumb ${n}`, `thumb-${n}`);
        await createThreadOverApi(fixture, {anchor: anchorFor("#title"), artifactId: published.artifact.id, body: `Pin ${n}`,
          idempotencyKey: key(`thumb-thread-${n}`), path: "index.html", projectId: "prj_default", versionId: published.version.id});
      }
      await localLogin(fixture);
      const page = fixture.page;
      let inFlight = 0;
      let peak = 0;
      page.on("request", (request) => {
        if (request.url().includes("/preview-leases")) peak = Math.max(peak, ++inFlight);
      });
      page.on("requestfinished", (request) => {
        if (request.url().includes("/preview-leases")) inFlight -= 1;
      });
      await page.goto(`${fixture.server.baseUrl}/review?type=comments`);
      await expect(page.locator("[data-thumbnail='frame']").first()).toBeVisible();
      expect(peak).toBeLessThanOrEqual(4);
      const frame = page.frameLocator("[data-thumbnail='frame']").first();
      await expect(frame.getByRole("heading", {name: /Activity thumb/u})).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ACT-005-F: an anchor the page does not contain, and a non-HTML entry, show the file tile instead of a misplaced pin", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const html = await publish(fixture, "Activity lost anchor", "lost");
      await createThreadOverApi(fixture, {anchor: anchorFor("#not-on-this-page"), artifactId: html.artifact.id, body: "Where did it go?",
        idempotencyKey: key("lost-thread"), path: "index.html", projectId: "prj_default", versionId: html.version.id});
      const text = (await publishNew(fixture.server, fixture.installation, {accessSetting: "account_required", content: "plain notes",
        idempotencyKey: key("notes"), mediaType: "text/plain; charset=utf-8", name: "Activity notes", path: "notes.txt", projectId: "prj_default"})).body;
      await createThreadOverApi(fixture, {anchor: anchorFor("#title"), artifactId: text.artifact.id, body: "On a text file.",
        idempotencyKey: key("notes-thread"), path: "notes.txt", projectId: "prj_default", versionId: text.version.id});
      await localLogin(fixture);
      const page = fixture.page;
      await page.goto(`${fixture.server.baseUrl}/review?type=comments`);
      const lost = page.locator(`[data-thumbnail-for] >> nth=0`);
      await expect(page.locator("[data-thumbnail='tile'][data-thumbnail-reason='unanchored']")).toHaveCount(1);
      await expect(page.locator("[data-thumbnail='tile'][data-thumbnail-reason='not-html']")).toHaveCount(1);
      await expect(page.locator("[data-thumbnail='frame']")).toHaveCount(0);
      await expect(lost).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
```

- [ ] **Step 9: Run them to confirm they fail, then pass.**

Run: `pnpm build && pnpm exec playwright test tests/browser/activity.spec.ts --project=chromium -g "thumbnails"`
Expected: FAIL before Step 7, because no `[data-thumbnail]` element exists. Expected after Step 7: PASS.

If the frame never reports `as-review-unanchored` for a missing selector, the first assertion times out. In that case read `apps/web/src/review-frame/review-frame.tsx:170-180` (`handleUnanchored`) and confirm it runs after the init paint. Do not loosen the assertion.

- [ ] **Step 10: Run the CSP and sandbox suites.** Thumbnails add `/review-frame` iframes to a new screen.

Run: `pnpm exec playwright test tests/browser/csp-clean.spec.ts tests/browser/review-sandbox.spec.ts --project=chromium`
Expected: PASS.

- [ ] **Step 11: Commit.**

```bash
git add apps/web/src/review/activity tests/browser/activity.spec.ts tests/browser/comment-api.ts
git commit -m "Draw each conversation's exact screen as a lazy feed thumbnail

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5.5: Open selects the conversation in the workspace

**Files:**
- Modify: `apps/web/src/review/review-app.tsx` (in `ArtifactReview`, beside `selectAnnotation`, near line 910)
- Test: `tests/browser/activity.spec.ts`

**Interfaces:**
- Consumes: `ReviewLocation.threadId` (Task 5.1); `comments.threads`, `selectAnnotation` and `writeReviewHistory` (existing).
- Produces: none.

- [ ] **Step 1: Write the failing assertion.** In `tests/browser/activity.spec.ts`, at the end of the first test, after the URL assertion, add:

```ts
      await expect(page).toHaveURL(new RegExp(`thread=${threadId}`, "u"));
      const comments = page.getByRole("tab", {name: /Comments/u});
      await expect(comments).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("article").filter({hasText: "Tighten the headline."}).first()).toHaveAttribute("aria-current", "true");
      await expect(page).not.toHaveURL(/thread=/u);
```

  If the selected thread in the Comments view exposes its selection with a different attribute, use that attribute. Find it with `grep -n "aria-current\|aria-selected\|data-selected" apps/web/src/review/workspace/comments-tab.tsx`.

- [ ] **Step 2: Run it to confirm it fails.**

Run: `pnpm build && pnpm exec playwright test tests/browser/activity.spec.ts --project=chromium -g "ACT-005-B: the feed shows"`
Expected: FAIL on the Comments tab not being selected.

- [ ] **Step 3: Select the requested thread once its threads load.** In `ArtifactReview`, after the `selectAnnotation` definition, add:

```tsx
  // An Activity "Open" names one conversation: select it once this version's threads arrive, then drop it from the URL.
  const requestedThreadRef = useRef(currentReviewLocation().threadId);
  useEffect(() => {
    const requested = requestedThreadRef.current;
    if (requested === null || !comments.threads.some((thread) => thread.id === requested)) return;
    requestedThreadRef.current = null;
    selectAnnotation(requested);
    writeReviewHistory(workspaceHref({...currentReviewLocation(), threadId: null}), "replace");
  });
```

  Import `workspaceHref` and `writeReviewHistory` from `./review-routes.ts` if they are not already imported.

- [ ] **Step 4: Run it to confirm it passes.**

Run: `pnpm build && pnpm exec playwright test tests/browser/activity.spec.ts --project=chromium`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/review/review-app.tsx tests/browser/activity.spec.ts
git commit -m "Select the conversation an Activity link names

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5.6: Retire the review queue and move the shared walks to Activity

**Files:**
- Delete: `apps/web/src/review/queue/queue-model.ts`
- Delete: `apps/web/src/review/queue/queue-model.test.ts`
- Delete: `apps/web/src/review/queue/review-queue-screen.tsx`
- Delete: `apps/web/src/review/queue/use-review-queue.ts`
- Delete: `tests/browser/review-queue.spec.ts`
- Modify: `apps/web/src/review/review-app.tsx`
- Modify: `tests/browser/shell-navigation.spec.ts`
- Modify: `tests/browser/ux-continuity.spec.ts`
- Modify: `tests/browser/accessibility.spec.ts`
- Modify: `tests/browser/csp-clean.spec.ts`

**Interfaces:**
- Consumes: Tasks 5.1–5.5.
- Produces: none.

- [ ] **Step 1: Prove parity before deleting.** `review-queue.spec.ts` covers four queue behaviours. Each must have a counterpart in `activity.spec.ts`:

| Queue behaviour | Activity counterpart |
|---|---|
| groups sends and conversations | the agent segment test |
| filter and Clear | the hostile test reaches "Nothing matches these filters" |
| empty installation | covered in Step 3 |
| failed read with Retry | the failed-feed test |

  The queue's per-project partial failure has no counterpart, because the feed is one request. Its sixty-project bound becomes the server's `limit` (slice 4, ACT-003-F). Record this mapping in the commit message body.

- [ ] **Step 2: Delete the queue files** listed above, and remove the `ReviewQueueScreen` import from `review-app.tsx`.

Run: `git rm apps/web/src/review/queue/*.ts apps/web/src/review/queue/*.tsx tests/browser/review-queue.spec.ts && pnpm typecheck && pnpm lint`
Expected: PASS. A remaining import of `queue/` would fail typecheck here; `lib/request-limiter.ts` stays, since `activity-feed-panel.tsx` uses it.

- [ ] **Step 3: Move the shared walks to Activity.**
  - **`tests/browser/shell-navigation.spec.ts`**
    - Replace every `name: "Review queue"` link and heading with `"Activity"`, and `toHaveTitle(/Review queue/u)` with `toHaveTitle(/Activity/u)`.
    - Change the folder click `nav.getByRole("link", {name: "Navigation second project"})` to expect `/review/projects?project=` in the URL, and assert the heading `Project settings` is visible instead of the artifact search box.
    - The admin-mode "Back to review" steps stay until slice 7.
    - Append this test:

```ts
  test("NAV-001-B: Activity, Projects and a project folder change screens in place and restore Activity filters through history", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await localLogin(fixture);
      const page = fixture.page;
      await page.evaluate(() => { (window as {__sameDocument?: boolean}).__sameDocument = true; });
      const nav = page.getByRole("navigation", {name: "Review and projects"});
      await nav.getByRole("link", {name: "Activity"}).click();
      await page.getByRole("radio", {name: /Needs you/u}).click();
      await nav.getByRole("link", {exact: true, name: "Projects"}).click();
      await expect(page).toHaveURL(/\/review\/projects$/u);
      await page.goBack();
      await expect(page).toHaveURL(/segment=needs_you/u);
      await expect(page.getByRole("radio", {name: /Needs you/u})).toBeChecked();
      expect(await page.evaluate(() => (window as {__sameDocument?: boolean}).__sameDocument)).toBe(true);
      await page.goto(`${fixture.server.baseUrl}/review/settings/projects/prj_default`);
      await expect(page).toHaveURL(/\/review\/projects\?project=prj_default$/u);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
```

  - **`tests/browser/ux-continuity.spec.ts`:**
    - Replace `"Review queue"` headings and links with `"Activity"`.
    - In `NAV-001-B: the review queue stays on screen while it refreshes …`, retitle it to `NAV-001-B: Activity stays on screen while it re-reads and when the reviewer returns to it`.
    - Change its row locator from the queue button to `page.getByText(/published v1 of/u).first()`.
  - **`tests/browser/accessibility.spec.ts`:**
    - Change `"Nothing to review yet"` to `"No activity yet"`, and its audit label to `"empty activity"`.
    - The empty install is published-free, so the feed shows its empty state.
    - Change `page.getByRole("button", {name: /Accessibility fixture/u})` to `page.getByLabel("Conversation on Accessibility fixture")`, and its audit label to `"activity"`.
    - After that audit, add:

```ts
      await page.getByRole("button", {name: "Publish artifact"}).click();
      await expect(page.getByRole("dialog", {name: "Publish artifact"})).toBeVisible();
      await audit("publish artifact popover");
      await page.keyboard.press("Escape");
```

  - **`tests/browser/csp-clean.spec.ts`:**
    - Rename the `the review queue raises no CSP violation in ${mode} mode` loop to `ACT-005-F: Activity and its thumbnails raise no CSP violation in ${mode} mode`.
    - Assert the heading `Activity` and `fixture.page.getByLabel("Conversation on CSP queue fixture")` instead of the queue button.
    - Before reading violations, add `await expect(fixture.page.locator("[data-thumbnail]").first()).toBeVisible();`.

- [ ] **Step 4: Run the full Chromium browser suite.**

Run: `pnpm test:web`
Expected: PASS. `project/evidence/browser.json` is rewritten and includes `ACT-005-B` and `ACT-005-F` test titles.

- [ ] **Step 5: Commit.**

```bash
git add -A apps/web/src/review tests/browser
git commit -m "Retire the review queue now that Activity covers it

Queue groups map to the Activity segments; filter, empty and Retry cases
moved to activity.spec.ts; per-project partial failure has no counterpart
because the feed is one bounded request.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5.7: Cross-engine proof, ledger and evidence

**Files:**
- Modify: `tests/browser/critical-engines.spec.ts`
- Modify: `project/spec/single-application-administration-spec.md` (new `## Activity screen` section after `## Screen transitions`)
- Modify: `project/spec/conformance.yml` (new ACT-005, updated NAV-001)

**Interfaces:**
- Consumes: Tasks 5.1–5.6.
- Produces: the ledger entry `ACT-005` with local browser evidence.

- [ ] **Step 1: Add the critical-engine case.** Thumbnails touch Review sandboxing and exact-version leases, so `AGENTS.md` requires the cross-engine matrix. In `tests/browser/critical-engines.spec.ts`, inside the `@critical` describe block, add the following, reusing that file's existing imports and helpers. If `createThreadOverApi` is not imported there yet, add it from `./comment-api.js`.

```ts
  test("ACT-005-B ACT-005-F: an Activity thumbnail draws the thread's exact private version inside the review frame @critical", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = (await publishNew(fixture.server, fixture.installation, {accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Engine thumb</title><h1 id=\"title\">Engine thumb version one</h1></html>",
        idempotencyKey: "critical-activity-thumb-v1", mediaType: "text/html; charset=utf-8", name: "Engine thumb", path: "index.html"})).body;
      await createThreadOverApi(fixture, {anchor: {htmlAnchor: {point: {x: 0.5, y: 0.5}, selector: "#title", tagName: "H1"}, originalText: "Engine thumb"},
        artifactId: first.artifact.id, body: "On version one.", idempotencyKey: "critical-activity-thumb-thread", path: "index.html", versionId: first.version.id});
      await publishVersion(fixture.server, fixture.installation, {artifactId: first.artifact.id,
        content: "<!doctype html><html lang=\"en\"><title>Engine thumb</title><h1 id=\"title\">Engine thumb version two</h1></html>",
        expectedCurrentVersionId: first.version.id, idempotencyKey: "critical-activity-thumb-v2"});
      await localLogin(fixture);
      await fixture.page.goto(`${fixture.server.baseUrl}/review?type=comments`);
      const frame = fixture.page.frameLocator("[data-thumbnail='frame']").first();
      await expect(frame.getByRole("heading", {name: "Engine thumb version one"})).toBeVisible();
      await expect(frame.getByRole("heading", {name: "Engine thumb version two"})).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
```

- [ ] **Step 2: Run the matrix.** Install the engines once with `pnpm exec playwright install firefox webkit`, then:

Run: `BROWSER_CRITICAL_ENGINES=all pnpm test:web`
Expected: PASS on chromium, firefox and webkit for every `@critical` test, including the new one.

If Firefox or WebKit fails, keep the failing run's `project/evidence/browser.json` and fix the cause. Do not tag around it.

- [ ] **Step 3: Write the requirement source.** In `project/spec/single-application-administration-spec.md`, after the `## Screen transitions` section, add:

```markdown
## Activity screen

Bare `/review` is Activity: every recorded action across the installation, newest first, under sticky day headers. Its segment (All, Needs you, With an agent), project, type and search filters live in the URL, so links and history restore them. A conversation is one entry that moves to the top on each reply; more than three replies fold behind "Show N earlier replies". Reply and Resolve act in place; Open goes to the workspace with the conversation selected. Consecutive versions by one publisher on one artifact merge into one entry. Each conversation's header shows its exact version drawn in the review frame, loaded only near the viewport and at most four at a time; a page that is not HTML, or an anchor the page cannot place, shows a file tile. Project folders and old project settings URLs open `/review/projects`.
```

- [ ] **Step 4: Add ACT-005 and update NAV-001.** In `project/spec/conformance.yml`, directly after the NAV-001 entry, add the block below. Copy `recorded_at` from `environment.capturedAt` in the freshly written `project/evidence/browser.json`.

```yaml
  - id: ACT-005
    kind: behavior
    behavior: The Activity screen replaces the review queue with the installation's reverse-chronological feed, filtered through the URL, with folded conversations, inline Reply and Resolve, merged version bursts, US dates and lazy sandboxed thumbnails of each conversation's exact version.
    owner: web-application
    source: {file: single-application-administration-spec.md, anchor: activity-screen}
    acceptance:
      behavior: {id: ACT-005-B, description: "Open bare /review and see versions, bursts and conversations under Today/Yesterday/date headers with 12-hour times; fold and expand a long thread; reply and resolve inline; switch segment, project, type and search and restore them through history; open a conversation in the workspace with it selected; see an anchored conversation's exact version drawn in the review frame, loading at most four at once."}
      failure: {id: ACT-005-F, description: "A hostile comment body renders as inert text without overflow and stays searchable; unknown filters are dropped; a failed feed read offers Retry and a failed summary leaves the feed working; an unplaceable anchor or non-HTML entry shows a file tile; a thumbnail never draws another version or escapes the review frame or the application CSP; an older page never repeats a thread."}
    deployments: *all
    status: behavior_verified
    proof_gap: Local Chromium evidence proves the feed, filters, inline actions, thumbnails and failure states; Firefox and WebKit prove the exact-version thumbnail in the critical-engine matrix. No team deployment is recorded.
    depends_on: [ACT-003, ACT-004, NAV-001, CMT-014, CMT-016]
    evidence:
      - deployment: local
        tests: [ACT-005-B, ACT-005-F]
        result: pass
        run: project/evidence/browser.json
        recorded_at: "<environment.capturedAt from project/evidence/browser.json>"
```

  Update NAV-001 as follows:
  - **`behavior` description:** begin with "Move between Activity, Projects, a project folder, a project's workspace, …" in place of "Move between the queue, a project's workspace, …". Replace "the catalog, queue, and Comments view keep" with "the catalog, Activity, and Comments view keep".
  - **`proof_gap`:** append "Activity filters restore through history in place."
  - **`evidence`:** replace its `recorded_at` with the same new `capturedAt`.

- [ ] **Step 5: Validate the ledger and the test names.**

Run: `pnpm conformance:validate && pnpm conformance:tests`
Expected: PASS. `conformance:validate` finds passing `ACT-005-B` and `ACT-005-F` titles in `project/evidence/browser.json`, from `activity.spec.ts`, `critical-engines.spec.ts` and `csp-clean.spec.ts`. `conformance:tests` scans only `*.test.ts` titles. No unit test claims an `ACT-005-B` or `ACT-005-F` ID: they use the bare `ACT-005:` prefix, because each ID may be claimed by at most one `*.test.ts` title.

- [ ] **Step 6: Run the slice gate.**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add tests/browser/critical-engines.spec.ts project/spec/single-application-administration-spec.md project/spec/conformance.yml project/evidence/browser.json
git commit -m "Record Activity screen evidence across the critical engines

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5.8: Roll the design library up across every project

The prototype's library now spans every project (Design `27f7c87`: one `libraryLoads.all` load, title "Design library", lede "Every design gallery across all projects, following each artifact’s current version."). The server's library still reads one project and names it in the URL. This task makes `/review/library` the single, project-less library. An old `/review/library?project=<id>` link still loads it; the parameter is ignored.

**Files:**
- Modify: `apps/web/src/review/review-routes.ts` (`libraryHref`, the `library` route kind, `parseReviewRoute`)
- Modify: `apps/web/src/review/review-routes.test.ts` (the `design library route` describe)
- Modify: `apps/web/src/review/library/design-library.ts` (`LibrarySource` gains `projectId`, `projectName`)
- Modify: `apps/web/src/review/library/design-library.test.ts`
- Modify: `apps/web/src/review/library/use-design-library.ts`
- Modify: `apps/web/src/review/library/design-library-screen.tsx`
- Modify: `apps/web/src/review/review-app.tsx` (the `library` branch)
- Modify: `apps/web/src/shell/nav-model.ts`, `apps/web/src/shell/nav-model.test.ts`, `apps/web/src/shell/review-shell.tsx`
- Modify: `tests/browser/design-library.spec.ts`, `tests/browser/critical-engines.spec.ts:234-235`, `tests/browser/shell-navigation.spec.ts:80-81`, `tests/browser/ux-continuity.spec.ts:122`
- Modify: `project/spec/conformance.yml` (DSN-005), `project/spec/artifact-server-product-spec.html:3984`

**Interfaces:**
- Consumes: Task 5.1's `ReviewRoute` union, `reviewItems(input, libraryProject)`, `shellActiveLink` and `activeProjectId` wiring; Task 1.3's `usTime` import in `design-library-screen.tsx`.
- Produces:

```ts
// review-routes.ts
export function libraryHref(): string;                        // always "/review/library"
type ReviewRoute = … | {readonly kind: "library"};             // no projectId
// design-library.ts
export interface LibrarySource { readonly artifactId: string; readonly artifactName: string; readonly indexTitle: string;
  readonly items: readonly GalleryIndexItem[]; readonly projectId: string; readonly projectName: string; readonly versionId: string }
// use-design-library.ts
export interface LibraryProject { readonly id: string; readonly name: string }
export function useDesignLibrary(projects: readonly LibraryProject[]): DesignLibraryHandle;
// design-library-screen.tsx
export function DesignLibraryScreen(props: {readonly projects: readonly Project[]}): JSX.Element;
// nav-model.ts: reviewItems(input: ShellNavInput) — the library link is libraryHref(); libraryProjectId is deleted
```

- [ ] **Step 1: Write the failing route and navigation tests**

In `apps/web/src/review/review-routes.test.ts`, replace the whole `describe("design library route", …)` block with:

```ts
describe("design library route", () => {
  it("DSN-005: one library spans every project, and pre-rollup project links still load it", () => {
    expect(libraryHref()).toBe("/review/library");
    expect(routeOf("/review/library")).toEqual({kind: "library"});
    expect(routeOf("/review/library/?project=")).toEqual({kind: "library"});
    expect(routeOf("/review/library?project=prj_default")).toEqual({kind: "library"});
  });
});
```

In `apps/web/src/shell/nav-model.test.ts` (as Task 5.1 left it):
- In the `ACT-005-B: lists Activity, Projects and the design library, …` expectation, change the library row's link from `"/review/library?project=prj_b"` to `"/review/library"`.
- Replace `expect(shellActiveLink({...reviewInput, activeProjectId: "prj_default", libraryActive: true})).toBe("/review/library?project=prj_default");` with:

```ts
    expect(shellActiveLink({...reviewInput, libraryActive: true})).toBe("/review/library");
    expect(shellActiveLink({...reviewInput, activeProjectId: "prj_default", libraryActive: true})).toBe("/review/library");
```

In `apps/web/src/review/library/design-library.test.ts`, add `projectId` and `projectName` to both fixture sources: `projectId: "prj_comp", projectName: "Compensation"` on `art_a`, and `projectId: "prj_claims", projectName: "Claims"` on `art_b`. The expectations stay as they are: tiles key by artifact, which is unique across the installation.

- [ ] **Step 2: Run them to confirm they fail**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review/review-routes.test.ts src/shell/nav-model.test.ts src/review/library/design-library.test.ts`

Expected: FAIL. TypeScript rejects `libraryHref()` without its `projectId` argument and the unknown `projectId`/`projectName` keys on `LibrarySource`. `routeOf("/review/library?project=prj_default")` still carries `projectId`, and the nav link still carries `?project=prj_b`.

- [ ] **Step 3: Make the route project-less**

In `apps/web/src/review/review-routes.ts`:
- In the `ReviewRoute` union, replace `| {readonly kind: "library"; readonly projectId: string | null}` with `| {readonly kind: "library"}`.
- Replace `libraryHref` with:

```ts
/** The design library: every gallery across all projects, following current versions. */
export function libraryHref(): string {
  return libraryPathname;
}
```

- In `parseReviewRoute`, replace the library branch body with:

```ts
  if (url.pathname === libraryPathname || url.pathname === `${libraryPathname}/`) {
    // A pre-rollup `?project=` link still loads; the library always spans every project.
    return {kind: "library"};
  }
```

In `apps/web/src/review/library/design-library.ts`, add two members to `LibrarySource`, in alphabetical order after `items`:

```ts
  readonly projectId: string;
  readonly projectName: string;
```

- [ ] **Step 4: Load every project's galleries**

In `apps/web/src/review/library/use-design-library.ts`:
- Replace the doc comment on `maximumArtifactPages` with `/** A bounded moving view: the first artifact pages across every project, read four at a time. */`. Keep the value 20; it now bounds the whole library.
- Add after the constants:

```ts
/** One project the library reads. */
export interface LibraryProject {
  readonly id: string;
  readonly name: string;
}

const emptyLibrary = (): LoadedLibrary => ({failures: [], loadedAt: new Date(), scanned: 0, sources: [], truncated: false});
```

- Replace `loadLibrary` with:

```ts
/**
 * Read every project's galleries; null once `wanted` turns false. The screen can
 * be left in place, so an abandoned read stops issuing requests instead of
 * finishing hundreds nobody will see.
 */
async function loadLibrary(projects: readonly LibraryProject[], wanted: () => boolean): Promise<LoadedLibrary | null> {
  const artifacts: {readonly id: string; readonly name: string; readonly project: LibraryProject}[] = [];
  let pages = 0;
  let truncated = false;
  for (const project of projects) {
    let cursor: string | null = null;
    do {
      if (pages >= maximumArtifactPages) {
        truncated = true;
        break;
      }
      // eslint-disable-next-line no-await-in-loop -- each page names the next cursor
      const page = await api.artifacts(project.id, cursor, []);
      if (!wanted()) return null;
      artifacts.push(...page.artifacts.map(({artifact}) => ({id: artifact.id, name: artifact.name, project})));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    if (truncated) break;
  }
  const limit = createRequestLimiter(concurrentReads);
  const failures: string[] = [];
  const read = await Promise.all(artifacts.map((artifact) => limit(async (): Promise<LibrarySource | null> => {
    if (!wanted()) return null;
    const projectId = artifact.project.id;
    try {
      const details = await api.artifact(projectId, artifact.id);
      const entry = previewIndexEntry(details.current.manifest);
      if (entry === null) return null;
      if (entry.size > maximumPreviewIndexBytes) {
        failures.push(artifact.name);
        return null;
      }
      const versionId = details.current.version.id;
      const parsed = parsePreviewIndex(
        await api.versionFile(projectId, artifact.id, versionId, previewIndexPath),
        details.current.manifest.entries,
      );
      if (parsed.status !== "ready") {
        failures.push(artifact.name);
        return null;
      }
      return {
        artifactId: artifact.id, artifactName: artifact.name, indexTitle: parsed.title, items: parsed.items,
        projectId, projectName: artifact.project.name, versionId,
      };
    } catch {
      failures.push(artifact.name);
      return null;
    }
  })));
  if (!wanted()) return null;
  return {
    failures: failures.toSorted((left, right) => left.localeCompare(right)),
    loadedAt: new Date(),
    scanned: artifacts.length,
    sources: read.filter((source) => source !== null)
      .toSorted((left, right) => left.projectName.localeCompare(right.projectName) || left.artifactName.localeCompare(right.artifactName)),
    truncated,
  };
}
```

- Replace `useDesignLibrary` with the version below. It keeps the session cache and Refresh behaviour, keyed by the set of project IDs rather than by one project. Add `useRef` to the `react` import.

```ts
/** Load every project's galleries once per session; `refresh` re-reads current versions. */
export function useDesignLibrary(projects: readonly LibraryProject[]): DesignLibraryHandle {
  const key = projects.map((project) => project.id).join("\u001f");
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<LibraryState>(() => {
    const cached = loadedLibraries.get(key);
    return cached === undefined ? {status: "loading"} : {status: "ready", library: cached};
  });
  useEffect(() => {
    if (key === "") {
      setState({status: "ready", library: emptyLibrary()});
      return undefined;
    }
    const cached = loadedLibraries.get(key);
    if (cached !== undefined && revision === 0) {
      setState({status: "ready", library: cached});
      return undefined;
    }
    let current = true;
    // Refresh keeps the galleries on screen and swaps them when the re-read lands.
    setState((shown) => shown.status === "ready" ? {...shown, refresh: "running"} : {status: "loading"});
    void (async () => {
      try {
        const library = await loadLibrary(projectsRef.current, () => current);
        if (library === null) return;
        loadedLibraries.set(key, library);
        setState({status: "ready", library});
      } catch (caught) {
        if (!current) return;
        const message = caught instanceof Error ? caught.message : "The design library could not be read.";
        setState((shown) => shown.status === "ready" ? {...shown, refresh: "failed"} : {status: "failed", message});
      }
    })();
    return () => {
      current = false;
    };
  }, [key, revision]);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return {refresh, state};
}
```

- [ ] **Step 5: One library screen**

In `apps/web/src/review/library/design-library-screen.tsx`:
- Change the imports from `../review-routes.ts` to `{libraryHref, navigateReview, workspaceHref}`. `writeReviewHistory` is no longer needed. Change the `react` import to `{useState, type CSSProperties}`.
- Replace `DesignLibraryScreen` and the `ProjectDesignLibrary` signature and head with:

```tsx
/**
 * Every design gallery across all projects, following each artifact's current version.
 * It is a moving view, not a frozen collection: tiles open the exact version that
 * was current when the library loaded, and Refresh re-reads current versions.
 */
export function DesignLibraryScreen({projects}: {readonly projects: readonly Project[]}) {
  const announce = useAnnounce();
  const phone = isPhoneWidth(useViewportWidth());
  const {refresh, state} = useDesignLibrary(projects);
  const [, setRevision] = useState(0);
```

  Keep the body that followed in `ProjectDesignLibrary` (loading, failed, empty and gallery states), with these edits:
  - Empty body: ``emptyBody={`None of the ${library.scanned} artifacts has a design gallery. Publish a design export to add one.`}``.
  - Replace every `viewStates.get(project.id)` and `viewStates.set(project.id, …)` with the key `"all"`.
  - `exactHref`: use `projectId: source.projectId` in place of `projectId: project.id`.
  - `media`: `api.versionMediaUrl(source.projectId, source.artifactId, source.versionId, path)`.
  - `description="Every design gallery across all projects, following each artifact’s current version."`
  - `hrefFor={(id) => exactHref(id) ?? libraryHref()}`
  - ``key={`all:${library.loadedAt.getTime()}`}``
  - `title="Design library"`
- Delete the old project-resolution code, the "Project unavailable" state and the now-unused `ProjectDesignLibrary` wrapper.

In `apps/web/src/review/review-app.tsx`, change the library branch to `<DesignLibraryScreen projects={projects} />`.

- [ ] **Step 6: Navigation follows the single library**

In `apps/web/src/shell/nav-model.ts`:
- Delete `libraryProjectId`.
- Change `shellNavItems`'s review call to `reviewItems(input)`, and `reviewItems`'s signature to `function reviewItems(input: ShellNavInput): NavItem[]`. Its library row becomes `{icon: "bi-collection", id: "library", label: "Design library", link: libraryHref()}`.
- In `shellActiveLink`, change the library line to `if (input.libraryActive) return libraryHref();`.
- Change the `libraryActive` doc comment to `/** The design library is open. */`.

In `apps/web/src/shell/review-shell.tsx`:
- Set `activeProjectId` to `route.kind === "workspace" ? route.location.projectId : route.kind === "projects" ? route.projectId : null`.
- In `routeTitle`, replace the library branch with `if (route.kind === "library") return "Design library";`.

- [ ] **Step 7: Run the unit tests and typecheck**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review/review-routes.test.ts src/shell/nav-model.test.ts src/review/library/design-library.test.ts && pnpm typecheck && pnpm lint`

Expected: PASS. Typecheck reports no remaining `route.projectId` read on a `library` route and no `libraryHref(` call with an argument.

- [ ] **Step 8: Write the failing browser proof for the roll-up**

In `tests/browser/design-library.spec.ts`:
- Add `import {ApiClient} from "../support/agent-dispatch.js";`.
- Rename the B test to `"DSN-005-B: the design library gathers every current gallery across all projects and opens exact pages"`.
- After the `broken` publish, publish one more gallery into a second project:

```ts
    const portal = path.join(directory, "portal");
    await writePreviewSourceFixture(portal);
    await writeFile(path.join(portal, "artifactserver.previews.json"), JSON.stringify({...previewSourceFixture(), title: "Claimant Portal"}));
    const owner = new ApiClient(fixture.server, fixture.installation.apiToken);
    const portalProjectId = await owner.createProject("Portal project", "design-library-portal-project");
    const portalCommand = {inputPath: portal, idempotencyKey: randomUUID(), projectId: portalProjectId, target: named("Claimant Portal")};
    await Effect.runPromise(publishPath(
      {serverOrigin: fixture.server.baseUrl, apiToken: Redacted.make(fixture.installation.apiToken)},
      portalCommand,
    ).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(NodeFileSystem.layer)));
```

- Replace the URL, region, heading and count expectations after `page.getByRole("link", {name: "Design library"}).click();` with:

```ts
    await expect(page).toHaveURL(/\/review\/library$/u);
    const library = page.getByRole("region", {name: "Design library gallery"});
    await expect(library.getByRole("heading", {name: "Design library", level: 2})).toBeVisible();
    await expect(library.getByText(/^12 previews/u)).toBeVisible();
    await expect(library.getByText(/^3 galleries · current versions as of/u)).toBeVisible();
```

- After the two existing `Prototypes · … · Prototypes` region expectations, add:

```ts
    // The second project's gallery appears in the same library.
    await expect(library.getByRole("region", {name: "Prototypes · Claimant Portal · Prototypes"})).toBeVisible();
```

- Keep `toHaveCount(4)` for `"portal studio"`: search matches every term, and "Claimant Portal" has no "studio". Change the `"examiner"` count from 2 to 3, one Examiner App per gallery. If the rendered count differs, the fixture's tile set is the authority: pin the exact rendered number once, and never loosen it to `toBeGreaterThan`.
- In the empty-library test, rename it `"DSN-005: an installation with no galleries explains how they appear"`, change its URL expectation to `/\/review\/library$/u`, and add after it:

```ts
    // A pre-rollup project link still opens the one library.
    await fixture.page.goto(`${fixture.server.baseUrl}/review/library?project=prj_default`);
    await expect(fixture.page.getByRole("heading", {name: "No design galleries yet"})).toBeVisible();
```

In `tests/browser/critical-engines.spec.ts:234-235`, change the URL to `/review/library` and the region name to `"Design library gallery"`.

In `tests/browser/shell-navigation.spec.ts:80-81`, change the expectation to `await expect(page).toHaveURL(/\/review\/library$/u);`.

In `tests/browser/ux-continuity.spec.ts:122`, change the expectation to `await expect(page).toHaveURL(/\/review\/library$/u);`.

- [ ] **Step 9: Run the browser proof, then the cross-engine library path**

Run:

```bash
pnpm build && pnpm exec playwright test tests/browser/design-library.spec.ts tests/browser/shell-navigation.spec.ts tests/browser/ux-continuity.spec.ts --project=chromium
BROWSER_CRITICAL_ENGINES=all pnpm test:web
```

Expected: every test passes. If a count differs from the values in Step 8, read the rendered library and correct the pinned number once, keeping it exact. The full run rewrites `project/evidence/browser.json`.

- [ ] **Step 10: Update DSN-005 and the product prose**

In `project/spec/conformance.yml`, DSN-005:
- **`behavior`:** "The design library gathers every readable current-version gallery across all projects into one searchable moving view grouped by kind and gallery, opens each preview as an exact artifact, version and path, refreshes on request, and names galleries it cannot read."
- **`DSN-005-B` description:** replace "see galleries from several artifacts grouped per gallery" with "see galleries from several artifacts in several projects grouped per gallery", and "show an empty state for projects without galleries" with "show an empty state when no artifact has a gallery; a pre-rollup project link still opens the library".
- **The `DSN-005-B` evidence item:** `run: project/evidence/browser.json`, with `recorded_at` set to `environment.capturedAt` from that file.

In `project/spec/artifact-server-product-spec.html:3984`, change "gathers every readable gallery in one project" to "gathers every readable gallery across all projects".

Run: `pnpm conformance:validate && pnpm conformance:tests`

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/review apps/web/src/shell tests/browser/design-library.spec.ts tests/browser/critical-engines.spec.ts \
  tests/browser/shell-navigation.spec.ts tests/browser/ux-continuity.spec.ts project/spec/conformance.yml \
  project/spec/artifact-server-product-spec.html project/evidence/browser.json
git commit -m "Roll the design library up across every project

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
## Slices 6–8 — Projects, Admin console, copy and final evidence

These slices build on slices 1–5. Before starting Task 6.1, confirm each item below exists. If one is missing, stop and finish the owning slice first; do not stub it.

**Vendored components.** `DataGrid`, `SideNav`, `Breadcrumb`, `MetricCard`, `ScrollDock`, `Timeline`, `SectionHeading`, `SlideOver`, `Tooltip`, `IconButton` and `Menu` are exported from `@/arkcase`. Check:

```bash
grep -E "export \{(DataGrid|SideNav|Breadcrumb|SlideOver|Tooltip|IconButton|Menu)\b" apps/web/src/arkcase/index.ts
```

**Activity model.** The vendored model is at `apps/web/src/arkcase/review-ui/activity-model.js`. It exports `usDate(ms)`, `usTime(ms)` and `usDateTime(ms)`, which return `MM/DD/YYYY`, `h:mm AM/PM` and both together, and Task 1's typing makes it importable from TypeScript.

**Activity API and feed (slices 4–5).**
- `api.activitySummary(projects?)` returns `ActivitySummary`; the shape is in the header.
- `ActivityFeedSection({principalId, projectId}: {principalId: string; projectId: string | null})` is exported from `apps/web/src/review/activity/activity-feed-section.tsx` (slice 5, Task 5.3 Step 8b). It renders the vendored feed with its own loading, failure, empty and "Show older" states. There is no session context in `apps/web`, so the caller passes the principal ID, which inline Reply drafts are keyed by.
- The navigation (Task 5.1) gives the Review group a **Projects** item and makes project folders link to `/review/projects?project=<id>`. Its Tools item and the account-menu entry are **Administration** for administrators and **MCP & WebMCP** (`/review/settings/mcp`) for everyone else. Slice 5 still swaps to the old administration item set on `/review/settings/*`; Task 7.2 retires that mode and "Back to review".

**Admin API fields (slice 3).** Slice 3 already parses these in `apps/web/src/api/client.ts`:

| Schema | Fields |
|---|---|
| `memberSchema` | `lastActiveAt: string \| null`, `admittedAt: string`, `admittedBy: {name: string} \| null`, `admittedHow: "manual" \| "automatic" \| "owner" \| null` (null = admitted before slice 3) |
| `apiKeySchema` | `lastUsedAt: string \| null`, `ownerName: string`, `status: "active" \| "revoked" \| "expired"`, `revokedBy: {name: string} \| null` (`revokedAt` already exists) |
| `publicLinkItemSchema` | `madePublicAt: string \| null`, `madePublicBy: {name: string} \| null` |

**Who owns what across the slice boundary.**
- Slice 6 owns the `projects` route kind, `projectsHref()`, the redirect of the retired project-settings URLs, and the Projects screen.
- If Task 5.x already added the `projects` kind to `ReviewRoute` with exactly the shape in the header (`{kind: "projects"; projectId: string | null}`) and a `projectsHref(projectId: string | null): string` helper, Task 6.1 keeps them and only adds the missing tests and redirects. Step 3 of Task 6.1 says exactly where.

**Rules every task in this section follows.**
- No `.test.ts` title may claim a conformance ID that another `.test.ts` already claims; `pnpm conformance:tests` enforces one claim per ID. The browser specs (`*.spec.ts`) carry `ACT-006-B/F` and `ADM-008-B/F`, and the web unit tests here carry no new IDs.
- `apps/web` has no DOM test environment, and its vitest config only includes `src/**/*.test.ts`. Pure modules get vitest unit tests. React composition is proved by the Playwright specs in Tasks 6.6, 7.7 and 8.1.
- Browser specs run against a production build: `pnpm build && pnpm exec playwright test <spec> --project=chromium`.

---

### Task 6.1: Route the Projects screen and retire the project-settings URLs

**Files:**
- Modify: `apps/web/src/review/review-routes.ts` (`ReviewRoute` union, `parseReviewRoute`, remove `projectSettingsHref`)
- Modify: `apps/web/src/review/settings/settings-view.ts`
- Modify: `apps/web/src/review/settings/settings-screen.tsx`
- Modify: `apps/web/src/shell/review-shell.tsx` (`settingsTitles`, `routeTitle`)
- Modify: `apps/web/src/review/review-app.tsx:59,1107` (import and `settingsHref`)
- Modify: `src/http/create-http-app.ts` (`/projects` legacy redirect)
- Modify: `tests/release/local-package.test.ts:223`
- Test: `apps/web/src/review/review-routes.test.ts`, `apps/web/src/review/settings/settings-view.test.ts`

**Interfaces:**
- Consumes: `ReviewRoute`, `parseReviewRoute`, `navigateReview` and `writeReviewHistory` from `review-routes.ts`.
- Produces:
  - `projectsHref(projectId: string | null): string`, which returns `/review/projects` or `/review/projects?project=<id>`.
  - `ReviewRoute` member `{readonly kind: "projects"; readonly projectId: string | null}`.
  - `canonicalReviewRoute` maps `/review/settings`, `/review/settings/projects` and `/review/settings/projects/:id` to that route and replaces the history entry.

- [ ] **Step 1: Write the failing route tests**

Append to `apps/web/src/review/review-routes.test.ts`, and add `projectsHref` to that file's existing `@/review/review-routes` import:

```ts
describe("projects route", () => {
  const at = (path: string): URL => new URL(path, "https://artifacts.example.test");

  it("parses the Projects screen with and without a selected project", () => {
    expect(parseReviewRoute(at("/review/projects"))).toEqual({kind: "projects", projectId: null});
    expect(parseReviewRoute(at("/review/projects/"))).toEqual({kind: "projects", projectId: null});
    expect(parseReviewRoute(at("/review/projects?project="))).toEqual({kind: "projects", projectId: null});
    expect(parseReviewRoute(at("/review/projects?project=prj_alpha")))
      .toEqual({kind: "projects", projectId: "prj_alpha"});
  });

  it("builds canonical Projects URLs that round-trip through the parser", () => {
    expect(projectsHref(null)).toBe("/review/projects");
    expect(projectsHref("")).toBe("/review/projects");
    expect(projectsHref("prj a&b")).toBe("/review/projects?project=prj+a%26b");
    expect(parseReviewRoute(at(projectsHref("prj a&b")))).toEqual({kind: "projects", projectId: "prj a&b"});
  });
});
```

Replace the first and third tests of `apps/web/src/review/settings/settings-view.test.ts`. Keep their IDs, which already belong to this file, and add `projectsHref` to the `@/review/review-routes` import:

```ts
  it("ADM-006-B: retired project-settings URLs replace themselves with the Projects screen", () => {
    for (const path of ["/review/settings", "/review/settings/", "/review/settings/projects"]) {
      expect(canonicalReviewRoute(parseReviewRoute(reviewUrl(path)))).toEqual({
        replaceWith: projectsHref(null),
        route: {kind: "projects", projectId: null},
      });
    }
    expect(canonicalReviewRoute(parseReviewRoute(reviewUrl("/review/settings/projects/prj_default"))))
      .toEqual({
        replaceWith: projectsHref("prj_default"),
        route: {kind: "projects", projectId: "prj_default"},
      });
    const members = parseReviewRoute(reviewUrl("/review/settings/members"));
    expect(canonicalReviewRoute(members)).toEqual({replaceWith: null, route: members});
  });
```

```ts
  it("ADM-006-F: direct unauthorized settings routes resolve to forbidden states, not empty data", () => {
    const member = settingsAccess(principal({}));
    for (const kind of ["members", "apiKeys", "publicLinks"] as const) {
      expect(resolveSettingsView({kind}, member)).toEqual({kind: "administratorPermission"});
    }
    const delegated = settingsAccess(principal({
      authorizedByPrincipalId: "prn_owner",
      capabilities: ["project:manage"],
      membershipRole: "administrator",
    }));
    expect(delegated).toEqual({administrator: false, canManageProjects: true});
    expect(resolveSettingsView({kind: "members"}, delegated))
      .toEqual({kind: "administratorPermission"});
    const administrator = settingsAccess(principal({membershipRole: "administrator"}));
    expect(resolveSettingsView({kind: "publicLinks"}, administrator)).toEqual({kind: "publicLinks"});
    expect(resolveSettingsView({kind: "notFound"}, administrator)).toEqual({kind: "notFound"});
    expect(resolveSettingsView({kind: "projects"}, administrator))
      .toEqual({href: projectsHref(null), kind: "redirect"});
    expect(resolveSettingsView({kind: "project", projectId: "prj_default"}, member))
      .toEqual({href: projectsHref("prj_default"), kind: "redirect"});
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review/review-routes.test.ts src/review/settings/settings-view.test.ts`

Expected: FAIL. If Task 5.x did not add the helper, the error is `projectsHref is not exported`; otherwise the failure is the `canonicalReviewRoute` expectation, which still returns the review queue.

- [ ] **Step 3: Implement the route**

In `apps/web/src/review/review-routes.ts`:

- If `{readonly kind: "projects"; readonly projectId: string | null}` is not already a member of `ReviewRoute`, add it:

```ts
export type ReviewRoute =
  | {readonly kind: "queue"}
  | {readonly kind: "settings"; readonly settings: SettingsRoute}
  | {readonly kind: "workspace"; readonly location: ReviewLocation}
  | {readonly kind: "library"; readonly projectId: string | null}
  | {readonly kind: "projects"; readonly projectId: string | null};
```

  Keep the first member's name as Task 5.x left it (`activity` after slice 5).

- If `projectsHref` does not exist, add it below `libraryHref`:

```ts
const projectsPathname = "/review/projects";

/** The Projects screen, with one project selected when named. */
export function projectsHref(projectId: string | null): string {
  return projectId === null || projectId === ""
    ? projectsPathname
    : `${projectsPathname}?${new URLSearchParams({project: projectId})}`;
}
```

- In `parseReviewRoute`, directly after the `isSettingsPath` branch, add the branch below if it is missing:

```ts
  if (url.pathname === projectsPathname || url.pathname === `${projectsPathname}/`) {
    const projectId = url.searchParams.get("project");
    return {kind: "projects", projectId: projectId === null || projectId === "" ? null : projectId};
  }
```

- Delete `projectSettingsHref`. In `apps/web/src/review/review-app.tsx`, replace the `projectSettingsHref` import with `projectsHref`, and change line 1107 to:

```tsx
            settingsHref={selectedProject === null ? null : projectsHref(selectedProject.id)}
```

Replace `canonicalReviewRoute` and the two retired cases of `resolveSettingsView` in `apps/web/src/review/settings/settings-view.ts`. Change its route import to `import {projectsHref, type ReviewRoute, type SettingsRoute} from "../review-routes.ts";`:

```ts
/** The one screen or state a settings URL shows for this principal. */
export type SettingsView =
  | {readonly kind: "administratorPermission"}
  | {readonly kind: "apiKeys"}
  | {readonly kind: "mcp"; readonly administrator: boolean}
  | {readonly kind: "members"}
  | {readonly kind: "notFound"}
  | {readonly kind: "publicLinks"}
  | {readonly kind: "redirect"; readonly href: string};

/** Retired project-settings URLs land on the Projects screen with a replaced history entry. */
export function canonicalReviewRoute(route: ReviewRoute): CanonicalReviewRoute {
  if (route.kind !== "settings") return {replaceWith: null, route};
  if (route.settings.kind === "projects") {
    return {replaceWith: projectsHref(null), route: {kind: "projects", projectId: null}};
  }
  if (route.settings.kind === "project") {
    const {projectId} = route.settings;
    return {replaceWith: projectsHref(projectId), route: {kind: "projects", projectId}};
  }
  return {replaceWith: null, route};
}

/** Map one settings route to its screen, or to the permission state that replaces it. */
export function resolveSettingsView(route: SettingsRoute, access: SettingsAccess): SettingsView {
  switch (route.kind) {
    case "projects":
      return {href: projectsHref(null), kind: "redirect"};
    case "project":
      return {href: projectsHref(route.projectId), kind: "redirect"};
    case "notFound":
      return {kind: "notFound"};
    case "mcp":
    case "webmcp":
      return {administrator: access.administrator, kind: "mcp"};
    case "members":
      return access.administrator ? {kind: "members"} : {kind: "administratorPermission"};
    case "apiKeys":
      return access.administrator ? {kind: "apiKeys"} : {kind: "administratorPermission"};
    case "publicLinks":
      break;
  }
  return access.administrator ? {kind: "publicLinks"} : {kind: "administratorPermission"};
}
```

Make these changes in `apps/web/src/review/settings/settings-screen.tsx`:

- Delete the `"projectPermission"` case and the `"project"` case, and remove the `ProjectSettings` import.
- Remove the `onProjectsChanged`, `projects` and `session.capabilities` uses that only served the project case, but keep the props in the interface; Task 7.2 rewrites this file.
- Change the redirect's loading title to `"Opening projects"`.
- In `SettingsState`, change the action to `actionLabel="Open activity"` with `onAction={() => navigateReview("/review")}`, and drop the now-unused `reviewQueueHref` import.

Make these changes in `apps/web/src/shell/review-shell.tsx`:

- Change `settingsTitles.project` and `settingsTitles.projects` to `"Projects"`.
- Add this branch at the top of `routeTitle`, after `projectName`:

```ts
  if (route.kind === "projects") {
    const name = projectName(route.projectId);
    return name === null ? "Projects" : `Projects · ${name}`;
  }
```

In `src/http/create-http-app.ts`, change the legacy `/projects` redirect so it lands on the screen in one hop:

```ts
  app.on(["GET", "HEAD"], "/projects", (context) =>
    redirectWithRequestQuery(context, "/review/projects"));
```

Then change line 223 of `tests/release/local-package.test.ts` to:

```ts
        ["/projects?source=legacy", "/review/projects?source=legacy"],
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review/review-routes.test.ts src/review/settings/settings-view.test.ts && pnpm typecheck`

Expected: PASS for both files, and the typecheck exits 0.

`review-app.tsx` does not render a `projects` route until Task 6.5, so the exhaustive render switch in `review-app.tsx` falls through to `ArtifactReview` for now. That is acceptable for one commit and fixed in Task 6.5.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/review/review-routes.ts apps/web/src/review/review-routes.test.ts \
  apps/web/src/review/settings/settings-view.ts apps/web/src/review/settings/settings-view.test.ts \
  apps/web/src/review/settings/settings-screen.tsx apps/web/src/shell/review-shell.tsx \
  apps/web/src/review/review-app.tsx src/http/create-http-app.ts tests/release/local-package.test.ts
git commit -m "Route retired project settings URLs to the Projects screen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6.2: Project list model

**Files:**
- Create: `apps/web/src/review/projects/projects-model.ts`
- Test: `apps/web/src/review/projects/projects-model.test.ts`

**Interfaces:**
- Consumes: `Project` from `@/api/client`; `usDate` from `@/ui/activity-model` (Task 1.2).
- Produces:

```ts
export interface ProjectSummaryCounts { readonly artifactCount: number; readonly id: string; readonly lastActivityAt: string | null; readonly unresolved: number }
export interface ProjectRow { readonly archived: boolean; readonly artifactCount: number | null; readonly id: string; readonly lastActivityAt: string | null; readonly name: string; readonly unresolved: number }
export function projectRows(projects: readonly Project[], summaries: readonly ProjectSummaryCounts[] | null, query: string): ProjectRow[]
export function projectRowMeta(row: ProjectRow): string | null
export function projectListFooter(shown: number, total: number, query: string): string
export function initialProjectId(projects: readonly Project[], requested: string | null): string | null
export const projectListPanelId = "project-list";
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/review/projects/projects-model.test.ts
import type {Project} from "@/api/client";
import {
  initialProjectId,
  projectListFooter,
  projectRowMeta,
  projectRows,
} from "@/review/projects/projects-model";
import {describe, expect, it} from "vitest";

function project(id: string, name: string, archivedAt: string | null = null): Project {
  return {archivedAt, createdAt: "2026-09-01T12:00:00.000Z", id, installationId: "ins_test", name};
}

const projects = [
  project("prj_old", "Records Retention", "2026-09-20T12:00:00.000Z"),
  project("prj_default", "Default"),
  project("prj_claims", "ArkCase Claims Workstation"),
];

describe("project list model", () => {
  it("lists active projects before archived ones, keeping server order inside each group", () => {
    expect(projectRows(projects, null, "").map((row) => row.id))
      .toEqual(["prj_default", "prj_claims", "prj_old"]);
  });

  it("joins summary counts and leaves counts unknown when the summary is missing", () => {
    const rows = projectRows(projects, [
      {artifactCount: 3, id: "prj_claims", lastActivityAt: "2026-09-30T16:05:00.000Z", unresolved: 2},
    ], "");
    expect(rows.find((row) => row.id === "prj_claims")).toMatchObject({artifactCount: 3, unresolved: 2});
    expect(rows.find((row) => row.id === "prj_default")).toMatchObject({artifactCount: null, unresolved: 0});
    expect(projectRows(projects, null, "")[0]).toMatchObject({artifactCount: null, unresolved: 0});
  });

  it("filters by a case-insensitive, trimmed name substring", () => {
    expect(projectRows(projects, null, "  CLAIMS ").map((row) => row.id)).toEqual(["prj_claims"]);
    expect(projectRows(projects, null, "zzz")).toEqual([]);
  });

  it("prints counts and the last activity date in US form, or nothing when counts are unknown", () => {
    const base = {archived: false, id: "prj_a", name: "A", unresolved: 0};
    expect(projectRowMeta({...base, artifactCount: 1, lastActivityAt: "2026-09-30T16:05:00"}))
      .toBe("1 artifact · 09/30/2026");
    expect(projectRowMeta({...base, artifactCount: 4, lastActivityAt: null})).toBe("4 artifacts");
    expect(projectRowMeta({...base, artifactCount: null, lastActivityAt: null})).toBeNull();
    expect(projectRowMeta({...base, artifactCount: 2, lastActivityAt: "not a date"})).toBe("2 artifacts");
  });

  it("states the footer as a filtered fraction or a plain total", () => {
    expect(projectListFooter(1, 3, "claims")).toBe("1 of 3");
    expect(projectListFooter(3, 3, " ")).toBe("3 projects");
    expect(projectListFooter(1, 1, "")).toBe("1 project");
  });

  it("selects the requested project even when unknown, else the first active, else the first", () => {
    expect(initialProjectId(projects, "prj_claims")).toBe("prj_claims");
    expect(initialProjectId(projects, "prj_missing")).toBe("prj_missing");
    expect(initialProjectId(projects, null)).toBe("prj_default");
    expect(initialProjectId([projects[0] as Project], null)).toBe("prj_old");
    expect(initialProjectId([], null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review/projects/projects-model.test.ts`

Expected: FAIL with `Failed to resolve import "@/review/projects/projects-model"`.

- [ ] **Step 3: Implement the model**

```ts
// apps/web/src/review/projects/projects-model.ts
import type {Project} from "@/api/client";
import {usDate} from "@/ui/activity-model";

/** The project list pane's remembered pin and width, under the review panel store. */
export const projectListPanelId = "project-list";

/** One project's counts from `GET /api/v1/activity/summary`. */
export interface ProjectSummaryCounts {
  readonly artifactCount: number;
  readonly id: string;
  readonly lastActivityAt: string | null;
  readonly unresolved: number;
}

/** One row of the Projects list; counts are null when the summary did not load. */
export interface ProjectRow {
  readonly archived: boolean;
  readonly artifactCount: number | null;
  readonly id: string;
  readonly lastActivityAt: string | null;
  readonly name: string;
  readonly unresolved: number;
}

/** Active projects first, then archived, each group in server order, filtered by name. */
export function projectRows(
  projects: readonly Project[],
  summaries: readonly ProjectSummaryCounts[] | null,
  query: string,
): ProjectRow[] {
  const needle = query.trim().toLocaleLowerCase();
  const counts = new Map((summaries ?? []).map((summary) => [summary.id, summary]));
  return projects
    .filter((project) => needle === "" || project.name.toLocaleLowerCase().includes(needle))
    .toSorted((left, right) => Number(left.archivedAt !== null) - Number(right.archivedAt !== null))
    .map((project) => {
      const summary = counts.get(project.id);
      return {
        archived: project.archivedAt !== null,
        artifactCount: summary?.artifactCount ?? null,
        id: project.id,
        lastActivityAt: summary?.lastActivityAt ?? null,
        name: project.name,
        unresolved: summary?.unresolved ?? 0,
      };
    });
}

/** "N artifacts · MM/DD/YYYY", or null when counts are unknown. */
export function projectRowMeta(row: ProjectRow): string | null {
  if (row.artifactCount === null) return null;
  const count = `${row.artifactCount} ${row.artifactCount === 1 ? "artifact" : "artifacts"}`;
  const instant = row.lastActivityAt === null ? Number.NaN : Date.parse(row.lastActivityAt);
  return Number.isNaN(instant) ? count : `${count} · ${usDate(instant)}`;
}

/** The pane footer: "x of y" while searching, otherwise the total. */
export function projectListFooter(shown: number, total: number, query: string): string {
  if (query.trim() !== "") return `${shown} of ${total}`;
  return `${total} ${total === 1 ? "project" : "projects"}`;
}

/**
 * The project the screen shows. A named project is kept even when unknown, so
 * the detail can say it was not found instead of silently showing another.
 */
export function initialProjectId(projects: readonly Project[], requested: string | null): string | null {
  if (requested !== null) return requested;
  return projects.find((project) => project.archivedAt === null)?.id ?? projects[0]?.id ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review/projects/projects-model.test.ts`

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/review/projects/projects-model.ts apps/web/src/review/projects/projects-model.test.ts
git commit -m "Order, count and filter the Projects list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6.3: Project summaries and the docked project list pane

**Files:**
- Create: `apps/web/src/review/projects/use-project-summaries.ts`
- Create: `apps/web/src/review/projects/project-list-panel.tsx`

**Interfaces:**
- Consumes: `api.activitySummary` (slice 4); the `ProjectRow`, `projectRowMeta` and `projectListFooter` exports from Task 6.2; `Panel`, `RailHeader`, `SelectableRow`, `StatusPill`, `CountBadge`, `SurfaceState` and `Button` from `@/arkcase`; and `catalogWidth` from `../workspace/workspace-layout.ts`.
- Produces:

```ts
export interface ProjectSummaries { readonly failed: boolean; readonly items: readonly ProjectSummaryCounts[] | null; readonly reload: () => void }
export function useProjectSummaries(projectsKey: string): ProjectSummaries
export interface ProjectListPanelProps {
  canPin: boolean; onAdd: () => void; onAnnounce: (text: string) => void; onPeekChange: (peeking: boolean) => void;
  onPinChange: (pinned: boolean) => void; onQueryChange: (query: string) => void; onSelect: (projectId: string) => void;
  onSheetClose: () => void; onWidthChange: (width: number | null) => void; peeking: boolean; pinned: boolean;
  query: string; rows: readonly ProjectRow[]; selectedId: string | null; sheet: boolean; total: number; width: number | null;
}
export function ProjectListPanel(props: ProjectListPanelProps): JSX.Element
```

Neither module is pure, and `apps/web` has no DOM test runner. Task 6.6's `ACT-006-B` and `ACT-006-F` browser specs prove both. This task's gate is the typecheck plus lint.

- [ ] **Step 1: Write the summaries hook**

```ts
// apps/web/src/review/projects/use-project-summaries.ts
import {useCallback, useEffect, useState} from "react";

import {api} from "@/api/client";

import type {ProjectSummaryCounts} from "./projects-model.ts";

/** Per-project counts for the Projects list; `items` stays null until the first answer. */
export interface ProjectSummaries {
  readonly failed: boolean;
  readonly items: readonly ProjectSummaryCounts[] | null;
  readonly reload: () => void;
}

/**
 * Reads the installation activity summary on mount, whenever the project set
 * changes (`projectsKey`), and when the window regains focus. A failure keeps
 * the last good counts; the list still renders every project by name.
 */
export function useProjectSummaries(projectsKey: string): ProjectSummaries {
  const [items, setItems] = useState<readonly ProjectSummaryCounts[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    let current = true;
    void (async (): Promise<void> => {
      try {
        const summary = await api.activitySummary();
        if (!current) return;
        setItems(summary.projects);
        setFailed(false);
      } catch {
        if (current) setFailed(true);
      }
    })();
    return () => {
      current = false;
    };
  }, [generation, projectsKey]);

  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  return {failed, items, reload};
}
```

- [ ] **Step 2: Write the pane**

This follows `review/workspace/artifact-list-panel.tsx` and the prototype's `projectListPane` (`~/Dev/Design/arkcase-artifacts/project/App.dc.html:2408-2440`).

```tsx
// apps/web/src/review/projects/project-list-panel.tsx
import type {CSSProperties} from "react";

import {Button, CountBadge, Panel, RailHeader, SelectableRow, StatusPill, SurfaceState} from "@/arkcase";

import {catalogWidth} from "../workspace/workspace-layout.ts";
import {projectListFooter, projectRowMeta, type ProjectRow} from "./projects-model.ts";

export interface ProjectListPanelProps {
  readonly canPin: boolean;
  readonly onAdd: () => void;
  readonly onAnnounce: (text: string) => void;
  readonly onPeekChange: (peeking: boolean) => void;
  readonly onPinChange: (pinned: boolean) => void;
  readonly onQueryChange: (query: string) => void;
  readonly onSelect: (projectId: string) => void;
  readonly onSheetClose: () => void;
  readonly onWidthChange: (width: number | null) => void;
  readonly peeking: boolean;
  readonly pinned: boolean;
  readonly query: string;
  readonly rows: readonly ProjectRow[];
  readonly selectedId: string | null;
  readonly sheet: boolean;
  readonly total: number;
  readonly width: number | null;
}

/** The Projects list: the artifact catalog's Panel, header and rows, one row per project. */
export function ProjectListPanel({
  canPin,
  onAdd,
  onAnnounce,
  onPeekChange,
  onPinChange,
  onQueryChange,
  onSelect,
  onSheetClose,
  onWidthChange,
  peeking,
  pinned,
  query,
  rows,
  selectedId,
  sheet,
  total,
  width,
}: ProjectListPanelProps) {
  const header = (
    <>
      {sheet ? (
        <div style={sheetBackStyle}>
          <Button icon="bi-chevron-left" onClick={onSheetClose} size="sm" variant="link">Back</Button>
        </div>
      ) : null}
      <RailHeader
        addLabel="New project"
        headingLevel={2}
        onAdd={onAdd}
        onQuery={(event) => onQueryChange(event.currentTarget.value)}
        onQueryKeyDown={(event) => {
          if (event.key !== "Escape" || query === "") return;
          event.stopPropagation();
          onQueryChange("");
        }}
        query={query}
        queryLabel="Search projects"
        queryPlaceholder="Search projects"
        title="Projects"
      />
    </>
  );
  return (
    <Panel
      bodyStyle={{display: "flex", flexDirection: "column"}}
      canPin={canPin}
      count={total}
      countLabel={`${total} ${total === 1 ? "project" : "projects"}`}
      footerMeta={projectListFooter(rows.length, total, query)}
      header={header}
      icon="bi-folder2-open"
      id="project-list"
      maxWidth={catalogWidth.maximum}
      minWidth={catalogWidth.minimum}
      name="project list"
      onAnnounce={onAnnounce}
      onPeekChange={onPeekChange}
      onPinChange={onPinChange}
      onWidthChange={onWidthChange}
      peeking={peeking}
      pinned={pinned}
      railLabel="Projects"
      resizable
      sheet={sheet}
      width={width ?? catalogWidth.defaultWidth}
    >
      {({closePeek}) => (rows.length === 0 ? (
        <SurfaceState
          count={0}
          density="inline"
          filterBody="No project matches the search."
          filtered
          noun="projects"
          onClear={() => onQueryChange("")}
          phase="ready"
        />
      ) : (
        <ul aria-label="Projects" style={listStyle}>
          {rows.map((row) => {
            const meta = projectRowMeta(row);
            return (
              <li key={row.id}>
                <SelectableRow
                  as="button"
                  onSelect={() => {
                    closePeek();
                    onSelect(row.id);
                  }}
                  padding="11px 12px"
                  selected={row.id === selectedId}
                  style={rowStyle}
                >
                  <span style={rowTitleStyle}>
                    <strong style={rowNameStyle}>{row.name}</strong>
                    {row.archived ? <StatusPill label="Archived" tone="neutral" /> : null}
                  </span>
                  <span style={rowMetaStyle}>
                    {row.unresolved > 0
                      ? <CountBadge count={`${row.unresolved} unresolved`} mono={false} tone="primary" />
                      : null}
                    {meta === null ? null : <span>{meta}</span>}
                  </span>
                </SelectableRow>
              </li>
            );
          })}
        </ul>
      ))}
    </Panel>
  );
}

const sheetBackStyle: CSSProperties = {background: "var(--surface-secondary, #F8F9FA)", flex: "none", padding: "4px 8px 0"};
const listStyle: CSSProperties = {listStyle: "none", margin: 0, padding: 0};
const rowStyle: CSSProperties = {
  borderBottom: "1px solid var(--list-divider, #E9ECEF)",
  display: "flex",
  flexDirection: "column",
  minHeight: 44,
  textAlign: "left",
  width: "100%",
};
const rowTitleStyle: CSSProperties = {alignItems: "baseline", display: "flex", gap: 8};
const rowNameStyle: CSSProperties = {flex: "1 1 auto", fontSize: 14, fontWeight: 600, lineHeight: 1.35, minWidth: 0};
const rowMetaStyle: CSSProperties = {
  alignItems: "center",
  color: "var(--text-secondary, #5A6268)",
  display: "flex",
  flexWrap: "wrap",
  fontSize: 12,
  gap: 8,
  marginTop: 5,
};
```

If the vendored `CountBadge.d.ts` rejects `mono` or a string `count`, use whatever it declares at the synced commit. Keep the visible text exactly `N unresolved`; Task 6.6 asserts it.

- [ ] **Step 3: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`

Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/review/projects/use-project-summaries.ts apps/web/src/review/projects/project-list-panel.tsx
git commit -m "Add the docked Projects list with activity counts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6.4: Project detail with activity, latest-artifact action and scrolling head

**Files:**
- Modify: `apps/web/src/review/settings/project-settings.tsx`
- Modify: `apps/web/src/review/settings/empty-project.tsx:30`

**Interfaces:**
- Consumes: `ActivityFeedSection` (slice 5) and `projectsHref` (Task 6.1).
- Produces: the new `ProjectSettings` props below.

```ts
export interface ProjectSettingsProps {
  readonly artifactCount: number | null;   // from the summary; null = unknown
  readonly canManage: boolean;
  readonly gitHistory: DeploymentCapabilities["gitHistory"];
  readonly headActions?: ReactNode;          // the phone "Projects" button
  readonly principalId: string;              // the signed-in principal, for inline Reply drafts in the Activity section
  readonly onProjectsChanged: () => Promise<readonly Project[]>;
  readonly projectId: string;
  readonly projects: readonly Project[];
}
```

- [ ] **Step 1: Change the not-found state**

Replace the not-found branch with the code below and drop the `reviewQueueHref` import:

```tsx
  if (project === null) {
    return (
      <PageScaffold head="scroll" maxWidth="none" title="Project not found">
        <SurfaceState
          actionIcon="bi-arrow-left"
          actionLabel="Open projects"
          count={0}
          emptyBody="No project in this installation has this ID."
          emptyIcon="bi-question-circle"
          emptyTitle="Project not found"
          noun="projects"
          onAction={() => navigateReview(projectsHref(null))}
          phase="ready"
          titleLevel={3}
          variant="dashed"
        />
      </PageScaffold>
    );
  }
```

- [ ] **Step 2: Scroll the head, and replace "Open artifacts" with "Open latest artifact"**

1. Add `artifactCount`, `headActions` and `principalId` to the destructured props.
2. Change the main `PageScaffold` opening to:

```tsx
    <PageScaffold
      actions={(
        <>
          {headActions}
          {artifactCount === 0 ? null : (
            <Button
              href={`/review?project=${encodeURIComponent(project.id)}`}
              icon="bi-box-arrow-up-right"
              outline
              size="sm"
              variant="secondary"
            >
              Open latest artifact
            </Button>
          )}
        </>
      )}
      head="scroll"
      maxWidth="none"
      meta={archived
        ? "This project is archived. Existing artifacts and immutable versions remain readable."
        : "Manage this project's name, lifecycle, and optional history."}
      title={project.name}
    >
```

   The workspace opens a project on its newest artifact. The catalog's default sort is `newest` (`use-artifact-catalog.ts`), so the plain project URL is the latest artifact.

3. Add the Activity panel after the "Artifacts in this project" panel and before the archive `Modal`:

```tsx
      <AdminPanel label="Activity" padded={false} subtitle="newest first">
        <ActivityFeedSection principalId={principalId} projectId={project.id} />
      </AdminPanel>
```

4. Add the imports:

```tsx
import type {ReactNode} from "react";
import {ActivityFeedSection} from "../activity/activity-feed-section.tsx";
import {navigateReview, projectsHref} from "../review-routes.ts";
```

- [ ] **Step 3: Change the empty-project copy**

In `apps/web/src/review/settings/empty-project.tsx`, change the active-project `emptyBody` to:

```tsx
        emptyBody="Publish a file or folder to create version 1."
```

- [ ] **Step 4: Typecheck, lint and the web unit tests**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @artifact-server/web test`

Expected: all exit 0. `ProjectSettings` has no caller until Task 6.5, so the typecheck reports no missing-prop error. If an older caller remains, it is `settings-screen.tsx`, which Task 6.1 already removed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/review/settings/project-settings.tsx apps/web/src/review/settings/empty-project.tsx
git commit -m "Show project activity and open the latest artifact from project details

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6.5: Compose the Projects screen and render its route

**Files:**
- Create: `apps/web/src/review/projects/projects-screen.tsx`
- Modify: `apps/web/src/review/review-app.tsx` (render switch near line 314, and `mainStyle` at line 307)

**Interfaces:**
- Consumes:
  - Tasks 6.2–6.4.
  - `usePanelPreference` from `../workspace/panel-preferences.ts`.
  - `useViewportWidth` from `../workspace/use-viewport-size.ts`.
  - `isPhoneWidth` and `workspaceBudget` from `../workspace/workspace-layout.ts`.
  - `CreateProjectModal` from `@/shell/create-project-modal`.
  - `settingsAccess` from `../settings/settings-view.ts`.
  - `useAnnounce` from `@/ui/announcer`.
- Produces: `ProjectsScreen(props: {onCreateProject: (name: string) => Promise<Project>; onProjectsChanged: () => Promise<readonly Project[]>; projectId: string | null; projects: readonly Project[]; session: Session})`.

- [ ] **Step 1: Write the screen**

```tsx
// apps/web/src/review/projects/projects-screen.tsx
import {useEffect, useState, type CSSProperties} from "react";

import type {Project, Session} from "@/api/client";
import {Button, PageScaffold, SurfaceState} from "@/arkcase";
import {CreateProjectModal} from "@/shell/create-project-modal";
import {useAnnounce} from "@/ui/announcer";

import {navigateReview, projectsHref, writeReviewHistory} from "../review-routes.ts";
import {ProjectSettings} from "../settings/project-settings.tsx";
import {settingsAccess} from "../settings/settings-view.ts";
import {usePanelPreference} from "../workspace/panel-preferences.ts";
import {useViewportWidth} from "../workspace/use-viewport-size.ts";
import {isPhoneWidth, workspaceBudget} from "../workspace/workspace-layout.ts";
import {ProjectListPanel} from "./project-list-panel.tsx";
import {initialProjectId, projectListPanelId, projectRows} from "./projects-model.ts";
import {useProjectSummaries} from "./use-project-summaries.ts";

export interface ProjectsScreenProps {
  readonly onCreateProject: (name: string) => Promise<Project>;
  readonly onProjectsChanged: () => Promise<readonly Project[]>;
  readonly projectId: string | null;
  readonly projects: readonly Project[];
  readonly session: Session;
}

/** Projects: the project list docked beside the selected project's details. */
export function ProjectsScreen({onCreateProject, onProjectsChanged, projectId, projects, session}: ProjectsScreenProps) {
  const announce = useAnnounce();
  const viewportWidth = useViewportWidth();
  const phone = isPhoneWidth(viewportWidth);
  const preference = usePanelPreference(projectListPanelId);
  const [peeking, setPeeking] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(phone && projectId === null);
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const summaries = useProjectSummaries(projects.map((project) => project.id).join(","));
  const rows = projectRows(projects, summaries.items, query);
  const selectedId = initialProjectId(projects, projectId);
  const selectedRow = rows.find((row) => row.id === selectedId) ?? null;
  const selectedKnown = projects.some((project) => project.id === selectedId);
  // A search that hides the selection closes its detail; focus stays in the search field.
  const filteredOut = selectedKnown && selectedRow === null;
  const access = settingsAccess(session.principal);

  useEffect(() => {
    if (projectId === null && selectedId !== null) {
      writeReviewHistory(projectsHref(selectedId), "replace");
    }
  }, [projectId, selectedId]);

  const select = (id: string): void => {
    setSheetOpen(false);
    navigateReview(projectsHref(id), {replace: true});
    const name = projects.find((project) => project.id === id)?.name;
    if (name !== undefined) announce(`${name} opened.`);
  };

  const listButton = phone ? (
    <Button icon="bi-folder2-open" onClick={() => setSheetOpen(true)} outline size="sm" variant="secondary">
      Projects
    </Button>
  ) : null;

  const detail = selectedId === null ? (
    <PageScaffold head="scroll" maxWidth="none" title="Projects">
      <SurfaceState
        actionIcon="bi-plus-lg"
        actionLabel="New project"
        count={0}
        emptyBody="Create a project to publish artifacts into it."
        emptyIcon="bi-folder2-open"
        emptyTitle="No projects yet"
        noun="projects"
        onAction={() => setCreateOpen(true)}
        phase="ready"
        titleLevel={3}
        variant="dashed"
      />
    </PageScaffold>
  ) : filteredOut ? (
    <PageScaffold actions={listButton} head="scroll" maxWidth="none" title="Projects">
      <SurfaceState
        count={0}
        emptyBody="The selected project is hidden by the search. Choose a project from the list or clear the search."
        emptyIcon="bi-search"
        emptyTitle="No project selected"
        noun="projects"
        phase="ready"
        titleLevel={3}
        variant="dashed"
      />
    </PageScaffold>
  ) : (
    <ProjectSettings
      artifactCount={selectedRow?.artifactCount ?? null}
      canManage={access.canManageProjects}
      gitHistory={session.capabilities.gitHistory}
      headActions={listButton}
      // One project's dialogs, estimate and pages never carry over to another.
      key={selectedId}
      onProjectsChanged={async () => {
        const loaded = await onProjectsChanged();
        summaries.reload();
        return loaded;
      }}
      principalId={session.principal.id}
      projectId={selectedId}
      projects={projects}
    />
  );

  return (
    <div style={screenStyle}>
      {phone && !sheetOpen ? null : (
        <aside aria-label="Project list" style={listLandmarkStyle}>
          <ProjectListPanel
            canPin={viewportWidth >= workspaceBudget.catalogAlone}
            onAdd={() => setCreateOpen(true)}
            onAnnounce={announce}
            onPeekChange={setPeeking}
            onPinChange={(pinned) => {
              preference.setPinned(pinned);
              setPeeking(false);
            }}
            onQueryChange={setQuery}
            onSelect={select}
            onSheetClose={() => setSheetOpen(false)}
            onWidthChange={preference.setWidth}
            peeking={peeking}
            pinned={preference.pinned}
            query={query}
            rows={rows}
            selectedId={selectedId}
            sheet={phone}
            total={projects.length}
            width={preference.width}
          />
        </aside>
      )}
      <div aria-label="Project details" role="region" style={detailStyle}>{detail}</div>
      <CreateProjectModal
        onClose={() => setCreateOpen(false)}
        onCreate={onCreateProject}
        onCreated={(project) => {
          setCreateOpen(false);
          navigateReview(projectsHref(project.id));
        }}
        open={createOpen}
      />
    </div>
  );
}

const screenStyle: CSSProperties = {display: "flex", flex: "1 1 auto", minHeight: 0, minWidth: 0};
const listLandmarkStyle: CSSProperties = {display: "flex", flex: "none", minHeight: 0};
const detailStyle: CSSProperties = {display: "flex", flex: "1 1 auto", flexDirection: "column", minHeight: 0, minWidth: 0};
```

- [ ] **Step 2: Render the route**

In `apps/web/src/review/review-app.tsx`, import `ProjectsScreen` from `./projects/projects-screen.tsx`. Then make these two changes:

1. Add `projects` to the overflow-hidden kinds in `mainStyle`:

```tsx
      mainStyle={route.kind === "workspace" || route.kind === "library" || route.kind === "projects"
        ? {overflow: "hidden"}
        : {overflowY: "auto"}}
```

2. Add a branch before the library branch of the render switch:

```tsx
      ) : route.kind === "projects" ? (
        <ProjectsScreen
          onCreateProject={createProject}
          onProjectsChanged={loadProjects}
          projectId={route.projectId}
          projects={projects}
          session={session}
        />
```

- [ ] **Step 3: Typecheck, lint, test and build**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @artifact-server/web test && pnpm --filter @artifact-server/web build`

Expected: all exit 0.

- [ ] **Step 4: Smoke the route by hand**

Run `pnpm dev`, which starts the server and the Vite web app (`scripts/run-web-development.ts`), and sign in through the printed local URL. Open `/review/projects`. The URL becomes `/review/projects?project=prj_default`, the list shows "Projects" with one row, and the detail shows "Default" with the Activity panel. Stop the process.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/review/projects/projects-screen.tsx apps/web/src/review/review-app.tsx
git commit -m "Open Projects as a docked list beside project details

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6.6: Prove the Projects screen (ACT-006) and retarget project-settings proof

**Files:**
- Create: `tests/browser/projects.spec.ts`
- Modify: `tests/browser/review-helpers.ts:88-94` (`openSettings("project")`)
- Modify: `tests/browser/frontend-mvp.spec.ts:424-430,1318-1418,1420-1460`
- Modify: `tests/browser/csp-clean.spec.ts:273-275`
- Modify: `tests/browser/capture-frontend-mvp.ts:95`
- Modify: `project/spec/single-application-administration-spec.md` (Information architecture, Navigation, Project settings)
- Modify: `project/spec/conformance.yml` (new `ACT-006`, revised `ADM-002`)

**Interfaces:**
- Consumes: the `startBrowserFixture`, `stopBrowserFixture` and `localLogin` helpers from `./browser-fixture.js`; `publishNew` from `../support/publishing.js`; `createThreadOverApi` from `./comment-api.js`; `apiHeaders` from `../support/runtime-harness.js`; and `waitForSettledPaint` from `./review-helpers.js`.
- Produces: browser proof `ACT-006-B` and `ACT-006-F`, and the ledger entry `ACT-006` (status `implementing`; Task 8.3 attaches evidence).

- [ ] **Step 1: Write the failing spec**

```ts
// tests/browser/projects.spec.ts
import {AxeBuilder} from "@axe-core/playwright";
import {expect, test} from "@playwright/test";
import {z} from "zod";

import {apiHeaders} from "../support/runtime-harness.js";
import {publishNew} from "../support/publishing.js";
import {localLogin, startBrowserFixture, stopBrowserFixture, type BrowserFixture} from "./browser-fixture.js";
import {createThreadOverApi} from "./comment-api.js";
import {waitForSettledPaint} from "./review-helpers.js";

async function createProject(fixture: BrowserFixture, name: string, key: string): Promise<string> {
  const response = await fetch(`${fixture.server.baseUrl}/api/v1/projects`, {
    body: JSON.stringify({name}),
    headers: apiHeaders(fixture.installation, key),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return z.object({project: z.object({id: z.string()})}).parse(await response.json()).project.id;
}

async function archiveProject(fixture: BrowserFixture, projectId: string): Promise<void> {
  const response = await fetch(`${fixture.server.baseUrl}/api/v1/projects/${projectId}/archive`, {
    headers: apiHeaders(fixture.installation, `archive-${projectId}`),
    method: "POST",
  });
  expect(response.ok).toBe(true);
}

test.describe("Projects screen", () => {
  test("ACT-006-B: projects list with counts beside their details and activity, folders and legacy URLs open it", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const alphaId = await createProject(fixture, "Projects alpha", "projects-alpha");
      const archivedId = await createProject(fixture, "Projects archived", "projects-archived");
      await archiveProject(fixture, archivedId);
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Alpha page</title><h1>Alpha page</h1></html>",
        idempotencyKey: "projects-alpha-artifact",
        mediaType: "text/html; charset=utf-8",
        name: "Alpha page",
        path: "index.html",
        projectId: alphaId,
      });
      await createThreadOverApi(fixture, {
        artifactId: published.body.artifact.id,
        body: "Who owns this page?",
        idempotencyKey: "projects-alpha-thread",
        projectId: alphaId,
        versionId: published.body.version.id,
      });
      // A second project's artifact must never reach Alpha's Activity section.
      await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Default page</title><h1>Default page</h1></html>",
        idempotencyKey: "projects-default-artifact",
        mediaType: "text/html; charset=utf-8",
        name: "Default page",
        path: "index.html",
        projectId: "prj_default",
      });

      await localLogin(fixture);
      const page = fixture.page;

      // Bare /review/projects selects the first active project in place.
      await page.goto(`${fixture.server.baseUrl}/review/projects`);
      await expect(page).toHaveURL(/\/review\/projects\?project=prj_default$/u);
      const list = page.getByRole("complementary", {name: "Project list"});
      await expect(list.getByRole("heading", {name: "Projects"})).toBeVisible();
      const alphaRow = list.getByRole("button", {name: /Projects alpha/u});
      await expect(alphaRow).toContainText("1 unresolved");
      await expect(alphaRow).toContainText(/1 artifact · \d{2}\/\d{2}\/\d{4}/u);
      await expect(list.getByRole("button", {name: /Projects archived/u})).toContainText("Archived");
      await expect(list.getByText("3 projects", {exact: true})).toBeVisible();

      // Selecting a row replaces the URL and shows its details, artifacts and activity.
      await alphaRow.click();
      await expect(page).toHaveURL(new RegExp(`/review/projects\\?project=${alphaId}$`, "u"));
      const details = page.getByRole("region", {name: "Project details"});
      await expect(details.getByRole("heading", {name: "Projects alpha"})).toBeVisible();
      await expect(details.getByRole("region", {name: "Project identity"})).toBeVisible();
      await expect(details.getByRole("region", {name: "Artifacts in this project"}).getByText("Alpha page")).toBeVisible();
      await expect(details.getByRole("region", {name: "Activity"}).getByText("Alpha page").first()).toBeVisible();
      await expect(details.getByRole("region", {name: "Activity"}).getByText("Default page")).toHaveCount(0);
      await expect(details.getByRole("link", {name: "Open latest artifact"}))
        .toHaveAttribute("href", `/review?project=${alphaId}`);
      await waitForSettledPaint(page);
      expect((await new AxeBuilder({page}).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);

      // Search narrows the list; the footer states the fraction.
      await page.getByLabel("Search projects").fill("archived");
      await expect(list.getByText("1 of 3", {exact: true})).toBeVisible();
      await page.getByLabel("Search projects").fill("");

      // A navigation folder opens the Projects screen with that project selected.
      await page.goto(`${fixture.server.baseUrl}/review`);
      await page.getByRole("navigation", {name: "Review and projects"})
        .getByRole("link", {exact: true, name: "Projects alpha"}).click();
      await expect(page).toHaveURL(new RegExp(`/review/projects\\?project=${alphaId}$`, "u"));

      // New project opens the created project's details.
      await list.getByRole("button", {name: "New project"}).click();
      const dialog = page.getByRole("dialog", {name: "New project"});
      await dialog.getByRole("textbox").fill("Projects created here");
      await dialog.getByRole("button", {name: "Create project"}).click();
      await expect(page.getByRole("region", {name: "Project details"})
        .getByRole("heading", {name: "Projects created here"})).toBeVisible();
      await expect(page).toHaveURL(/\/review\/projects\?project=prj_/u);

      // Retired URLs replace themselves with the Projects screen.
      await page.goto(`${fixture.server.baseUrl}/review/settings/projects/${alphaId}`);
      await expect(page).toHaveURL(new RegExp(`/review/projects\\?project=${alphaId}$`, "u"));
      await page.goto(`${fixture.server.baseUrl}/projects`);
      await expect(page).toHaveURL(/\/review\/projects\?project=prj_default$/u);

      // On a phone the list is a sheet opened from the page head.
      await page.setViewportSize({height: 800, width: 390});
      await expect(page.getByRole("complementary", {name: "Project list"})).toHaveCount(0);
      await page.getByRole("button", {exact: true, name: "Projects"}).click();
      await page.getByRole("complementary", {name: "Project list"})
        .getByRole("button", {name: /Projects alpha/u}).click();
      await expect(page.getByRole("complementary", {name: "Project list"})).toHaveCount(0);
      await expect(page.getByRole("heading", {name: "Projects alpha"})).toBeVisible();
      await expect.poll(() => page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ACT-006-F: hidden, unknown and uncounted projects fail visibly, and no invented panel appears", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await createProject(fixture, "Visible project", "projects-visible");
      await localLogin(fixture);
      const page = fixture.page;

      await page.goto(`${fixture.server.baseUrl}/review/projects?project=prj_default`);
      const details = page.getByRole("region", {name: "Project details"});
      await expect(details.getByRole("heading", {name: "Default"})).toBeVisible();
      for (const invented of ["Publishing defaults", "Access and membership"]) {
        await expect(page.getByRole("region", {name: invented})).toHaveCount(0);
      }
      await expect(page.getByText("Copy all artifact URLs")).toHaveCount(0);

      // A search that hides the selection closes its detail and keeps focus in the list.
      const search = page.getByLabel("Search projects");
      await search.fill("zzz-no-match");
      await expect(details.getByRole("heading", {name: "Default"})).toHaveCount(0);
      await expect(details.getByText("No project selected")).toBeVisible();
      await expect(page.getByText("No project matches the search.")).toBeVisible();
      await expect(search).toBeFocused();
      await search.fill("");
      await expect(details.getByRole("heading", {name: "Default"})).toBeVisible();

      // An unknown project is named as not found instead of showing another one.
      await page.goto(`${fixture.server.baseUrl}/review/projects?project=prj_missing`);
      await expect(details.getByRole("heading", {name: "Project not found"}).first()).toBeVisible();
      await details.getByRole("button", {name: "Open projects"}).click();
      await expect(page).toHaveURL(/\/review\/projects\?project=prj_default$/u);

      // When the summary fails, every project is still listed by name, without counts.
      await page.route("**/api/v1/activity/summary**", (route) => route.fulfill({
        body: JSON.stringify({error: {code: "INTERNAL_ERROR", message: "Summary unavailable."}}),
        contentType: "application/json",
        status: 500,
      }));
      await page.reload();
      const list = page.getByRole("complementary", {name: "Project list"});
      await expect(list.getByRole("button", {name: /Visible project/u})).toBeVisible();
      await expect(list.getByText(/unresolved/u)).toHaveCount(0);
      await expect(details.getByRole("heading", {name: "Default"})).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
```

- [ ] **Step 2: Run it to verify the new spec runs**

Run: `pnpm build && pnpm exec playwright test tests/browser/projects.spec.ts --project=chromium`

Expected: PASS for both tests when Tasks 6.1–6.5 and slice 5's folders are in place. A failure points at a real gap; fix the product code, not the assertion.

- [ ] **Step 3: Retarget the existing project-settings proof**

1. In `tests/browser/review-helpers.ts`, change the `project` branch of `openSettings`:

```ts
  const pathname = section === "project"
    ? `/review/projects?project=${encodeURIComponent(current.searchParams.get("project") ?? "prj_default")}`
    : `/review/settings/${section}`;
```

   The `project` value would otherwise feed `new URL(pathname, origin)` with a query string. That is valid, so no other change is needed.

2. In `tests/browser/frontend-mvp.spec.ts:424-430`, the catalog's "Project settings" link now lands on the Projects screen. Replace the URL expectation with:

```ts
      await fixture.page.getByRole("link", {name: "Project settings"}).click();
      await expect(fixture.page).toHaveURL(new RegExp(`/review/projects\\?project=${project.id}$`, "u"));
```

   If the `administrationNavigation` / "Back to review" assertions that follow are still present, delete them. Project settings now open on the Projects screen, which is not a settings route, so the administration navigation never appears here. Task 7.7 retargets the remaining admin-mode walks. Keep the brand-link assertion.

3. In the `ADM-002-B ADM-002-F ADM-006-B ADM-006-F` test (`frontend-mvp.spec.ts:1318`):
   - Replace the "projects list is gone" block with:

```ts
      // Retired project-settings routes replace themselves with the Projects screen.
      const historyLength = await fixture.page.evaluate(() => window.history.length);
      await fixture.page.goto(`${fixture.server.baseUrl}/projects`);
      await expect(fixture.page).toHaveURL(/\/review\/projects\?project=prj_default$/u);
      expect(await fixture.page.evaluate(() => window.history.length)).toBe(historyLength + 1);
      await fixture.page.goto(`${fixture.server.baseUrl}/review/settings`);
      await expect(fixture.page).toHaveURL(/\/review\/projects\?project=prj_default$/u);

      await fixture.page.goto(`${fixture.server.baseUrl}/review/projects?project=prj_default`);
```

   - Delete the `administrationNavigation` "Back to review" assertion.
   - Change `fixture.page.getByRole("link", {name: "Open artifacts"})` to `fixture.page.getByRole("link", {name: "Open latest artifact"})`.

   That artifact link only exists while the project has an artifact. This test publishes `Isolation fixture` into `prj_default` first, so it is present.

4. In the `ADM-002-B ADM-006-B` empty-project test (`frontend-mvp.spec.ts:1420`):
   - Change `/review/settings/projects/${project.id}` to `/review/projects?project=${project.id}`.
   - Add after the heading assertion:

```ts
      await expect(fixture.page.getByRole("link", {name: "Open latest artifact"})).toHaveCount(0);
```

5. In `tests/browser/csp-clean.spec.ts:273`, change the visit to `await visit("/review/projects?project=prj_default");`. `visit` sets `theme` with `searchParams.set`, so the existing query string survives.

6. In `tests/browser/capture-frontend-mvp.ts:95`, change the URL to `${server.baseUrl}/review/projects?project=prj_default&theme=default`.

- [ ] **Step 4: Update the administration spec and the ledger**

In `project/spec/single-application-administration-spec.md`:

1. In the **Information architecture** table, replace the two project rows with:

```md
| `/review/projects` | List active and archived projects beside the selected project's details: identity, lifecycle, optional Git history, artifacts, and activity; create a project. | Admitted users; changing a project requires an admitted human or `project:manage`. |
```

2. Replace the sentence "`/review/settings` redirects to `/review/settings/projects`." with:

```md
`/review/settings`, `/review/settings/projects`, and `/review/settings/projects/:projectId`
replace themselves with `/review/projects` (selecting the named project).
```

3. Rename `### Project list` to `### Projects screen {#projects-screen}` and replace its body with:

```md
The Projects screen docks the project list beside the selected project's details,
the way the artifact catalog docks beside an artifact. The list shows each
project's name, an Archived pill, its unresolved-conversation count, and its
artifact count with the date of its latest activity; it searches by name and
states "x of y" while searching. Below 768 px the list is a sheet opened from the
page head. Navigation project folders open this screen with that project selected.

Selecting a project replaces the URL (`?project=`) without adding history. A named
project that does not exist is reported as not found. A search that hides the
selected project closes its details. When activity counts cannot load, every
project is still listed by name.

Creating a project uses the existing name contract and opens the new project.
```

In `project/spec/conformance.yml`:

1. Replace the `behavior`, `acceptance` and `source` of `ADM-002`, leaving `status`, `proof_gap`, `depends_on` and `evidence` unchanged:

```yaml
    behavior: The Projects screen lists active and archived projects beside one project's surface for rename, archive, unarchive, and capability-gated optional Git history with estimate confirmation before enablement.
    owner: web-application
    source: {file: single-application-administration-spec.md, anchor: projects-screen}
    acceptance:
      behavior: {id: ADM-002-B, description: "Create and rename a project, archive and unarchive it, return to it in Review, and—when an optional Git provider is available—review an estimate before enabling and later disabling Git history while the displayed state follows the server result."}
      failure: {id: ADM-002-F, description: "A failed create or rename preserves the entered name, archive cannot erase reads or immutable history, unavailable Git cannot be enabled, enablement without estimate confirmation is refused, and the interface never invents project ACLs or exposes provider secrets and internals."}
```

2. Insert `ACT-006` directly after `ADM-002`:

```yaml
  - id: ACT-006
    kind: behavior
    behavior: The Projects screen docks a searchable project list with archived state, unresolved-conversation and artifact counts, and latest activity beside the selected project's identity, lifecycle, optional Git history, artifacts, and project-filtered activity; navigation folders and retired project-settings URLs open it.
    owner: web-application
    source: {file: single-application-administration-spec.md, anchor: projects-screen}
    acceptance:
      behavior: {id: ACT-006-B, description: "Open Projects, observe active-before-archived rows with unresolved and artifact counts and US-dated latest activity, select a project and see its details, artifacts, activity, and latest-artifact action, search with an x-of-y footer, create a project, open the screen from a navigation folder and from retired settings URLs, and use the list as a sheet on a phone without horizontal overflow."}
      failure: {id: ACT-006-F, description: "A search that hides the selection closes its details and keeps focus in the list, an unknown project is reported as not found rather than replaced, a failed summary still lists every project by name without counts, and no Publishing defaults, project membership, or copy-all-URLs panel is invented."}
    deployments: *all
    status: implementing
    proof_gap: Local browser evidence is attached by the final slice; team deployments remain unrecorded.
    depends_on: [ACT-004, ADM-002, NAV-001]
    evidence: []
```

   Slice 4 adds `ACT-004`. If `pnpm conformance:validate` reports it unknown, slice 4 is incomplete; finish it rather than dropping the dependency.

- [ ] **Step 5: Run the affected proof and the gate**

Run: `pnpm check && pnpm exec playwright test tests/browser/projects.spec.ts tests/browser/frontend-mvp.spec.ts tests/browser/csp-clean.spec.ts tests/browser/accessibility.spec.ts --project=chromium`

Expected: `pnpm check` exits 0, including `conformance:validate` and `conformance:tests`, and every listed spec passes.

- [ ] **Step 6: Commit**

```bash
git add tests/browser/projects.spec.ts tests/browser/review-helpers.ts tests/browser/frontend-mvp.spec.ts \
  tests/browser/csp-clean.spec.ts tests/browser/capture-frontend-mvp.ts \
  project/spec/single-application-administration-spec.md project/spec/conformance.yml
git commit -m "Prove the Projects screen and retarget project settings proof

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7.1: Administration areas, record selection and admin field labels

**Files:**
- Create: `apps/web/src/review/settings/admin-areas.ts`
- Create: `apps/web/src/review/settings/use-selected-record.ts`
- Test: `apps/web/src/review/settings/admin-areas.test.ts`

**Interfaces:**
- Consumes: `usDate` and `usDateTime` from `@/ui/activity-model` (Task 1.2); `writeReviewHistory` and `REVIEW_LOCATION_EVENT` from `../review-routes.ts`.
- Produces:

```ts
export type AdminAreaId = "members" | "apiKeys" | "publicLinks" | "mcp";
export interface AdminArea { readonly administratorOnly: boolean; readonly group: string; readonly href: string; readonly icon: string; readonly id: AdminAreaId; readonly label: string; readonly lede: string }
export const adminAreas: readonly AdminArea[];
export function visibleAdminAreas(administrator: boolean): readonly AdminArea[];
export function adminAreaById(id: AdminAreaId): AdminArea;
export function readSelectedRecord(search: string): string | null;
export function selectedRecordHref(location: {readonly pathname: string; readonly search: string}, id: string | null): string;
export function admittedLabel(member: {readonly admittedBy: {readonly name: string} | null; readonly admittedHow: "automatic" | "manual" | "owner" | null}): string;
export function dateOrDash(iso: string | null): string;
export function dateTimeOrDash(iso: string | null): string;
export type KeyStatus = "active" | "expired" | "revoked";
export function keyStatusLabel(status: KeyStatus): "Active" | "Expired" | "Revoked";
export function keyStatusTone(status: KeyStatus): "neutral" | "success" | "warning";
export const adminMenuPanelId = "admin-areas";
// use-selected-record.ts
export function useSelectedRecord(): readonly [string | null, (id: string | null) => void];
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/review/settings/admin-areas.test.ts
import {
  adminAreaById,
  admittedLabel,
  dateOrDash,
  dateTimeOrDash,
  keyStatusLabel,
  keyStatusTone,
  readSelectedRecord,
  selectedRecordHref,
  visibleAdminAreas,
} from "@/review/settings/admin-areas";
import {describe, expect, it} from "vitest";

describe("administration areas", () => {
  it("groups the four areas for administrators and leaves only MCP for everyone else", () => {
    expect(visibleAdminAreas(true).map((area) => [area.group, area.label])).toEqual([
      ["People and access", "Members"],
      ["People and access", "API keys"],
      ["Sharing", "Public links"],
      ["Integrations", "MCP & WebMCP"],
    ]);
    expect(visibleAdminAreas(false).map((area) => area.id)).toEqual(["mcp"]);
    expect(adminAreaById("apiKeys").href).toBe("/review/settings/api-keys");
  });

  it("reads and writes the selected record without disturbing other query values", () => {
    expect(readSelectedRecord("?selected=mbr_1")).toBe("mbr_1");
    expect(readSelectedRecord("?selected=")).toBeNull();
    expect(readSelectedRecord("")).toBeNull();
    const location = {pathname: "/review/settings/members", search: "?theme=dark"};
    expect(selectedRecordHref(location, "mbr 1")).toBe("/review/settings/members?theme=dark&selected=mbr+1");
    expect(selectedRecordHref({...location, search: "?theme=dark&selected=mbr_1"}, null))
      .toBe("/review/settings/members?theme=dark");
    expect(selectedRecordHref({pathname: "/review/settings/members", search: "?selected=a"}, null))
      .toBe("/review/settings/members");
  });

  it("names how a member was admitted without inventing an admitter", () => {
    expect(admittedLabel({admittedBy: null, admittedHow: "automatic"})).toBe("Automatic");
    expect(admittedLabel({admittedBy: null, admittedHow: "owner"})).toBe("Installation owner");
    expect(admittedLabel({admittedBy: {name: "Dana Okonkwo"}, admittedHow: "manual"})).toBe("Dana Okonkwo");
    expect(admittedLabel({admittedBy: null, admittedHow: "manual"})).toBe("—");
    expect(admittedLabel({admittedBy: null, admittedHow: null})).toBe("—");
  });

  it("prints US dates and a 12-hour clock, and a dash for absent or unparsable values", () => {
    expect(dateOrDash("2026-09-30T16:05:00")).toBe("09/30/2026");
    expect(dateTimeOrDash("2026-09-30T16:05:00")).toMatch(/^09\/30\/2026.*4:05 PM$/u);
    expect(dateOrDash(null)).toBe("—");
    expect(dateTimeOrDash("never")).toBe("—");
  });

  it("labels and tones key status", () => {
    expect([keyStatusLabel("active"), keyStatusTone("active")]).toEqual(["Active", "success"]);
    expect([keyStatusLabel("expired"), keyStatusTone("expired")]).toEqual(["Expired", "warning"]);
    expect([keyStatusLabel("revoked"), keyStatusTone("revoked")]).toEqual(["Revoked", "neutral"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review/settings/admin-areas.test.ts`

Expected: FAIL with `Failed to resolve import "@/review/settings/admin-areas"`.

- [ ] **Step 3: Implement the areas module and the selection hook**

The ledes come from the prototype (`App.dc.html:2805-2810`).

```ts
// apps/web/src/review/settings/admin-areas.ts
import {usDate, usDateTime} from "@/ui/activity-model";

/** The administration menu's remembered pin and width, under the review panel store. */
export const adminMenuPanelId = "admin-areas";

export type AdminAreaId = "apiKeys" | "mcp" | "members" | "publicLinks";

/** One administration area: its menu row, route, and one-line lede. */
export interface AdminArea {
  readonly administratorOnly: boolean;
  readonly group: string;
  readonly href: string;
  readonly icon: string;
  readonly id: AdminAreaId;
  readonly label: string;
  readonly lede: string;
}

export const adminAreas: readonly AdminArea[] = [
  {
    administratorOnly: true,
    group: "People and access",
    href: "/review/settings/members",
    icon: "bi-people",
    id: "members",
    label: "Members",
    lede: "Members can open every project in this installation.",
  },
  {
    administratorOnly: true,
    group: "People and access",
    href: "/review/settings/api-keys",
    icon: "bi-key",
    id: "apiKeys",
    label: "API keys",
    lede: "Keys let agents and automation act with the capabilities you grant.",
  },
  {
    administratorOnly: true,
    group: "Sharing",
    href: "/review/settings/public-links",
    icon: "bi-link-45deg",
    id: "publicLinks",
    label: "Public links",
    lede: "Artifacts anyone with the link can open at their current version.",
  },
  {
    administratorOnly: false,
    group: "Integrations",
    href: "/review/settings/mcp",
    icon: "bi-plug",
    id: "mcp",
    label: "MCP & WebMCP",
    lede: "Connect AI clients to projects, artifacts, versions and comments.",
  },
];

/** The areas this principal may open; hidden areas are still refused by the server. */
export function visibleAdminAreas(administrator: boolean): readonly AdminArea[] {
  return adminAreas.filter((area) => administrator || !area.administratorOnly);
}

export function adminAreaById(id: AdminAreaId): AdminArea {
  const area = adminAreas.find((candidate) => candidate.id === id);
  if (area === undefined) throw new Error(`Unknown administration area ${id}.`);
  return area;
}

const selectedParameter = "selected";

/** The record whose detail pane a URL reopens, or null. */
export function readSelectedRecord(search: string): string | null {
  const value = new URLSearchParams(search).get(selectedParameter);
  return value === null || value === "" ? null : value;
}

/** The same screen's URL with `?selected=` set to `id`, or removed for null. */
export function selectedRecordHref(
  location: {readonly pathname: string; readonly search: string},
  id: string | null,
): string {
  const search = new URLSearchParams(location.search);
  if (id === null) search.delete(selectedParameter);
  else search.set(selectedParameter, id);
  return search.size === 0 ? location.pathname : `${location.pathname}?${search}`;
}

/** "Automatic", "Installation owner", the admitter's name, or a dash when unrecorded. */
export function admittedLabel(member: {
  readonly admittedBy: {readonly name: string} | null;
  readonly admittedHow: "automatic" | "manual" | "owner" | null;
}): string {
  if (member.admittedHow === "automatic") return "Automatic";
  if (member.admittedHow === "owner") return "Installation owner";
  return member.admittedBy?.name ?? "—";
}

function instantOf(iso: string | null): number {
  return iso === null ? Number.NaN : Date.parse(iso);
}

/** MM/DD/YYYY in local time, or a dash. */
export function dateOrDash(iso: string | null): string {
  const instant = instantOf(iso);
  return Number.isNaN(instant) ? "—" : usDate(instant);
}

/** MM/DD/YYYY h:mm AM/PM in local time, or a dash. */
export function dateTimeOrDash(iso: string | null): string {
  const instant = instantOf(iso);
  return Number.isNaN(instant) ? "—" : usDateTime(instant);
}

export type KeyStatus = "active" | "expired" | "revoked";

export function keyStatusLabel(status: KeyStatus): "Active" | "Expired" | "Revoked" {
  return status === "active" ? "Active" : status === "expired" ? "Expired" : "Revoked";
}

export function keyStatusTone(status: KeyStatus): "neutral" | "success" | "warning" {
  return status === "active" ? "success" : status === "expired" ? "warning" : "neutral";
}
```

```ts
// apps/web/src/review/settings/use-selected-record.ts
import {useCallback, useEffect, useState} from "react";

import {REVIEW_LOCATION_EVENT, writeReviewHistory} from "../review-routes.ts";
import {readSelectedRecord, selectedRecordHref} from "./admin-areas.ts";

/**
 * The record a detail pane shows, kept in `?selected=` so a refresh or a
 * shared link reopens it. Selecting replaces the history entry.
 */
export function useSelectedRecord(): readonly [string | null, (id: string | null) => void] {
  const [selected, setSelected] = useState(() => readSelectedRecord(window.location.search));
  useEffect(() => {
    const follow = (): void => setSelected(readSelectedRecord(window.location.search));
    window.addEventListener("popstate", follow);
    window.addEventListener(REVIEW_LOCATION_EVENT, follow);
    return () => {
      window.removeEventListener("popstate", follow);
      window.removeEventListener(REVIEW_LOCATION_EVENT, follow);
    };
  }, []);
  const select = useCallback((id: string | null): void => {
    writeReviewHistory(selectedRecordHref(window.location, id), "replace");
  }, []);
  return [selected, select] as const;
}
```

- [ ] **Step 4: Run the test and the typecheck**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review/settings/admin-areas.test.ts && pnpm typecheck`

Expected: PASS, 5 tests; the typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/review/settings/admin-areas.ts apps/web/src/review/settings/admin-areas.test.ts \
  apps/web/src/review/settings/use-selected-record.ts
git commit -m "Define administration areas, deep-linked selection and admin labels

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7.2: The Admin console frame

**Files:**
- Create: `apps/web/src/review/settings/admin-console.tsx`
- Modify: `apps/web/src/review/settings/admin-parts.tsx` (add `AddRecordButton` and `RowActionsMenu`)
- Modify: `apps/web/src/review/settings/settings-screen.tsx`
- Modify: `apps/web/src/shell/nav-model.ts`, `apps/web/src/shell/nav-model.test.ts`, `apps/web/src/shell/review-shell.tsx`, `apps/web/src/shell/account-menu.tsx` (retire the admin navigation mode)

**Interfaces:**
- Consumes: Task 7.1; `SideNav`, `Breadcrumb`, `SectionHeading`, `Select`, `Tooltip`, `IconButton` and `Menu` (with the `MenuItem` type) from `@/arkcase`; `usePanelPreference`, `useViewportWidth` and `isPhoneWidth`; `useAnnounce`; `navigateReview`.
- Produces:

```ts
export interface AdminConsoleProps { readonly administrator: boolean; readonly area: AdminAreaId; readonly children: ReactNode; readonly inspector?: ReactNode }
export function AdminConsole(props: AdminConsoleProps): JSX.Element
export function useAdminInspectorFullscreen(): boolean          // true below 900 px
// admin-parts.tsx
export function AddRecordButton(props: {readonly label: string; readonly onClick: () => void}): JSX.Element
export function RowActionsMenu(props: {readonly items: readonly MenuItem[]; readonly label: string}): JSX.Element
// settings-screen.tsx: SettingsScreenProps becomes {readonly route: SettingsRoute; readonly session: Session}
// nav-model.ts: ShellMode, ShellNavInput.mode and ShellNavInput.returnHref are deleted; the main navigation
// always shows the review items, and on /review/settings/* the Tools item (Administration, or MCP & WebMCP) is current.
// account-menu.tsx: AccountMenuProps becomes {readonly rail: boolean; readonly session: Session}
```

- [ ] **Step 1: Add the shared admin controls**

Append to `apps/web/src/review/settings/admin-parts.tsx`, adding `IconButton`, `Menu`, `Tooltip` and `type MenuItem` to its `@/arkcase` import:

```tsx
/** The round "+" in a list panel's cap that starts the area's create flow. */
export function AddRecordButton({label, onClick}: {readonly label: string; readonly onClick: () => void}) {
  return (
    <Tooltip label={label} placement="bottom">
      <IconButton ariaLabel={label} icon="bi-plus-lg" onClick={onClick} shape="circle" size="sm" variant="primary" />
    </Tooltip>
  );
}

/** A row's kebab and its verbs; destructive verbs still confirm in their own dialog. */
export function RowActionsMenu({items, label}: {readonly items: readonly MenuItem[]; readonly label: string}) {
  const [open, setOpen] = useState(false);
  return (
    <span style={rowMenuAnchorStyle}>
      <IconButton
        ariaLabel={label}
        expanded={open}
        hasPopup="menu"
        icon="bi-three-dots-vertical"
        onClick={() => setOpen((current) => !current)}
        size="sm"
        variant="ghost"
      />
      <Menu align="end" items={[...items]} label={label} onClose={() => setOpen(false)} open={open} width={200} />
    </span>
  );
}

const rowMenuAnchorStyle: CSSProperties = {display: "inline-flex", position: "relative"};
```

- [ ] **Step 2: Write the console frame**

This follows the prototype's `adminNav`, `adminHead` and body regions (`App.dc.html:194-207, 2824-2845`).

```tsx
// apps/web/src/review/settings/admin-console.tsx
import type {CSSProperties, ReactNode} from "react";

import {Breadcrumb, SectionHeading, Select, SideNav} from "@/arkcase";
import {useAnnounce} from "@/ui/announcer";

import {navigateReview} from "../review-routes.ts";
import {usePanelPreference} from "../workspace/panel-preferences.ts";
import {useViewportWidth} from "../workspace/use-viewport-size.ts";
import {isPhoneWidth} from "../workspace/workspace-layout.ts";
import {adminAreaById, adminMenuPanelId, visibleAdminAreas, type AdminAreaId} from "./admin-areas.ts";

const inspectorStackWidth = 900;

/** True where the 360 px detail pane cannot sit beside the list and stacks over it. */
export function useAdminInspectorFullscreen(): boolean {
  return useViewportWidth() < inspectorStackWidth;
}

export interface AdminConsoleProps {
  readonly administrator: boolean;
  readonly area: AdminAreaId;
  readonly children: ReactNode;
  readonly inspector?: ReactNode;
}

/**
 * The Admin Console pattern: an area menu, a breadcrumb heading, the area's
 * scrolling content, and an optional docked detail pane beside it.
 */
export function AdminConsole({administrator, area, children, inspector}: AdminConsoleProps) {
  const announce = useAnnounce();
  const phone = isPhoneWidth(useViewportWidth());
  const preference = usePanelPreference(adminMenuPanelId);
  const areas = visibleAdminAreas(administrator);
  const current = adminAreaById(area);
  const rootLabel = administrator ? "Administration" : "Settings";
  const firstArea = areas[0] ?? current;

  const menu = areas.length < 2 || phone ? null : (
    <SideNav
      activeLink={current.href}
      header={(
        <div style={menuHeaderStyle}>
          <SectionHeading
            level={2}
            size="md"
            title={(
              <span style={menuTitleStyle}>
                <i aria-hidden="true" className="bi bi-gear" style={{fontSize: "var(--icon-md, 20px)"}} />
                Administration
              </span>
            )}
          />
        </div>
      )}
      items={areas.map((candidate) => ({
        group: candidate.group,
        icon: candidate.icon,
        id: candidate.id,
        label: candidate.label,
        link: candidate.href,
      }))}
      maxWidth={340}
      minWidth={184}
      mode={preference.pinned ? "expanded" : "peek"}
      onAnnounce={announce}
      onPinChange={(next) => {
        preference.setPinned(next);
        announce(next ? "Administration menu pinned." : "Administration menu unpinned to the rail.");
      }}
      onSelect={(item) => {
        if (item.link !== undefined) navigateReview(item.link);
      }}
      onWidthChange={preference.setWidth}
      pinLabelVisible={false}
      pinName="the administration menu"
      pinned={preference.pinned}
      resizable
      title="Administration areas"
      width={preference.width ?? 224}
    />
  );

  return (
    <div data-admin-console="" style={consoleStyle}>
      {menu}
      <div style={columnStyle}>
        <div data-admin-head="" style={headStyle}>
          <SectionHeading
            eyebrow={<Breadcrumb items={[{href: firstArea.href, label: rootLabel}, current.label]} />}
            level={1}
            size="md"
            stackBelow={560}
            subtitle={current.lede}
            title={current.label}
          />
          {phone && areas.length > 1 ? (
            <Select
              label="Administration area"
              onChange={(event) => {
                const next = areas.find((candidate) => candidate.id === event.currentTarget.value);
                if (next !== undefined) navigateReview(next.href);
              }}
              options={areas.map((candidate) => ({label: candidate.label, value: candidate.id}))}
              size="sm"
              value={current.id}
            />
          ) : null}
        </div>
        <div style={rowStyle}>
          <div aria-label={current.label} data-admin-content="" role="region" style={scrollStyle} tabIndex={-1}>
            <div style={contentStyle}>{children}</div>
          </div>
          {inspector}
        </div>
      </div>
    </div>
  );
}

const consoleStyle: CSSProperties = {display: "flex", flex: "1 1 auto", minHeight: 0, minWidth: 0};
const columnStyle: CSSProperties = {display: "flex", flex: "1 1 auto", flexDirection: "column", minHeight: 0, minWidth: 0};
const headStyle: CSSProperties = {
  background: "var(--surface-card, #fff)",
  borderBottom: "1px solid var(--border-color, #DEE2E6)",
  display: "flex",
  flex: "none",
  flexDirection: "column",
  gap: 8,
  padding: "8px 16px 8px 14px",
};
const rowStyle: CSSProperties = {display: "flex", flex: "1 1 auto", minHeight: 0, position: "relative"};
const scrollStyle: CSSProperties = {
  background: "var(--surface-canvas, #F1F5F7)",
  flex: "1 1 auto",
  minHeight: 0,
  minWidth: 0,
  overflow: "auto",
};
const contentStyle: CSSProperties = {display: "flex", flexDirection: "column", gap: 16, maxWidth: 1360, padding: "16px 20px 28px"};
const menuHeaderStyle: CSSProperties = {
  background: "var(--surface-secondary, #F8F9FA)",
  borderBottom: "1px solid var(--border-color-strong, #CED4DA)",
  flex: "none",
  padding: "12px 14px 10px",
};
const menuTitleStyle: CSSProperties = {alignItems: "center", display: "inline-flex", gap: 10};
```

- [ ] **Step 3: Route the settings screens through the console**

Replace `apps/web/src/review/settings/settings-screen.tsx` with the version below. The area screens gain their props in Tasks 7.3–7.6; until then this file passes only what they already accept, so `MembersScreen`, `ApiKeysScreen` and `PublicLinksScreen` are called without props:

```tsx
import {useEffect} from "react";

import type {Session} from "@/api/client";
import {PageScaffold, SurfaceState} from "@/arkcase";
import {navigateReview, type SettingsRoute} from "../review-routes.ts";
import {ApiKeysScreen} from "./api-keys-screen.tsx";
import {McpWebmcpScreen} from "./mcp-webmcp-screen.tsx";
import {MembersScreen} from "./members-screen.tsx";
import {PublicLinksScreen} from "./public-links-screen.tsx";
import {resolveSettingsView, settingsAccess} from "./settings-view.ts";

export interface SettingsScreenProps {
  readonly route: SettingsRoute;
  readonly session: Session;
}

/** Route one canonical settings URL to its administration area or its permission state. */
export function SettingsScreen({route, session}: SettingsScreenProps) {
  const view = resolveSettingsView(route, settingsAccess(session.principal));
  switch (view.kind) {
    case "redirect":
      return <SettingsRedirect href={view.href} />;
    case "notFound":
      return <SettingsState body="This Artifact Server settings route does not exist." icon="bi-question-circle" title="Page not found" />;
    case "administratorPermission":
      return (
        <SettingsState
          body="Only an installation administrator can manage members, API keys, and public links."
          icon="bi-shield-lock"
          title="Administrator permission required"
        />
      );
    case "members":
      return <MembersScreen />;
    case "apiKeys":
      return <ApiKeysScreen />;
    case "publicLinks":
      return <PublicLinksScreen />;
    case "mcp":
      break;
  }
  return <McpWebmcpScreen administrator={view.administrator} />;
}

/** Only reachable if a caller skipped `canonicalReviewRoute`. */
function SettingsRedirect({href}: {readonly href: string}) {
  useEffect(() => {
    navigateReview(href, {replace: true});
  }, [href]);
  return <SurfaceState loadingStyle="spinner" loadingTitle="Opening projects" noun="projects" phase="loading" />;
}

function SettingsState({body, icon, title}: {readonly body: string; readonly icon: string; readonly title: string}) {
  return (
    <PageScaffold title="Administration">
      <SurfaceState
        actionIcon="bi-arrow-left"
        actionLabel="Open activity"
        count={0}
        emptyBody={body}
        emptyIcon={icon}
        emptyTitle={title}
        noun="settings"
        onAction={() => navigateReview("/review")}
        phase="ready"
        titleLevel={3}
        variant="dashed"
      />
    </PageScaffold>
  );
}
```

In `apps/web/src/review/review-app.tsx`, change the settings branch to `<SettingsScreen route={route.settings} session={session} />`.

- [ ] **Step 4: Write the failing navigation test for the retired admin mode**

Slice 5 kept `ShellMode` so that `/review/settings/*` still swapped the main navigation to the old administration item set, with "Back to review". The console's area menu replaces that set. The main navigation now always shows the review items, and its Tools item is current on settings screens. For an administrator that item is Administration; for anyone else it is MCP & WebMCP, so non-administrators keep their route to MCP setup.

In `apps/web/src/shell/nav-model.test.ts`:
- Delete the whole `describe("shellNavItems in administration mode", …)` block.
- Remove the `mode` and `returnHref` keys from `reviewInput`.
- Delete every `shellActiveLink` expectation that passes `mode: "admin"`.
- Append:

```ts
describe("settings routes keep the review navigation", () => {
  it("never swaps item sets, and marks the Tools item current on settings screens", () => {
    const onKeys = {...reviewInput, activeSettings: "apiKeys" as const};
    expect(shellNavItems(onKeys)).toEqual(shellNavItems(reviewInput));
    expect(shellActiveLink(onKeys)).toBe("/review/settings/members");
    expect(shellActiveLink({...reviewInput, activeSettings: "webmcp" as const})).toBe("/review/settings/members");
  });

  it("marks MCP & WebMCP current for a non-administrator on the MCP screen", () => {
    const member = {...reviewInput, activeSettings: "mcp" as const, canCreateProjects: false, isAdministrator: false};
    expect(shellNavItems(member).at(-1)).toEqual({group: "Tools", icon: "bi-plug", id: "mcp", label: "MCP & WebMCP", link: "/review/settings/mcp"});
    expect(shellActiveLink(member)).toBe("/review/settings/mcp");
  });
});
```

Run: `pnpm --filter @artifact-server/web exec vitest run src/shell/nav-model.test.ts`

Expected: FAIL. TypeScript reports `mode` and `returnHref` missing from `reviewInput`, or the first test receives the administration item set for `activeSettings: "apiKeys"`.

- [ ] **Step 5: Retire the admin navigation mode**

In `apps/web/src/shell/nav-model.ts`:
- Delete `export type ShellMode`, the `mode` and `returnHref` members of `ShellNavInput`, and the `administrationItems` function.
- Make `shellNavItems` return the review branch only. Keep exactly the `reviewItems(…)` call it already makes for review mode:

```ts
/** The navigation rows; `link` values are real hrefs. The item set never changes with the screen. */
export function shellNavItems(input: ShellNavInput): NavItem[] {
  return reviewItems(/* the same arguments as the existing review-mode call */);
}
```

  Write the actual argument list from the current file. After Task 5.8 that is `reviewItems(input)`; before it, `reviewItems(input, libraryProjectId(input))`.
- Replace the `if (input.mode === "admin") { switch … }` block at the top of `shellActiveLink` with:

```ts
  if (input.activeSettings !== null && input.activeSettings !== "projects" && input.activeSettings !== "project") {
    // Every administration area lives under the one Tools item.
    return administrationHref(input.isAdministrator);
  }
```

  If Task 6.1 already deleted the `project` and `projects` settings kinds, drop those two comparisons; `pnpm typecheck` reports them.

In `apps/web/src/shell/review-shell.tsx`:
- Delete `const mode = …`, and the `mode` and `returnHref` entries of `navInput`.
- Set `const navTitle = "Review and projects";`, and give `MobileNavDrawer` `title="Review"`.
- Change the three `<AccountMenu mode={mode} … />` uses to `<AccountMenu … />` without `mode`.
- Remove the `reviewReturnHref`, `REVIEW_RETURN_URL_KEY` and `readStored` imports if nothing else in the file uses them.

In `apps/web/src/shell/account-menu.tsx`:
- Remove `mode` from `AccountMenuProps` and from the destructured props, and drop the `type ShellMode` import.
- Replace the `mode === "admin" ? {…"Back to review"…} : …` first item with the review-mode rule that Task 5.1 wrote, now unconditional:

```tsx
    isInstallationAdministrator(principal)
      ? {icon: "bi-gear", label: "Administration", onClick: () => navigateReview(administrationHref(true))}
      : {icon: "bi-plug", label: "MCP & WebMCP", onClick: () => navigateReview(administrationHref(false))},
```

- Remove the `reviewReturnHref`, `REVIEW_RETURN_URL_KEY` and `readStored` imports if they are now unused.

Then run `git grep -n "REVIEW_RETURN_URL_KEY\|reviewReturnHref" apps/web/src`. If the only remaining hits are the constant, the helper and the code that writes the return URL, nothing reads it any more: delete all three and their unit test cases.

- [ ] **Step 6: Typecheck, lint and test**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @artifact-server/web test`

Expected: all exit 0, including the two new navigation tests. `AdminConsole` is unused until Task 7.3; Oxlint does not flag unused exports.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/review/settings/admin-console.tsx apps/web/src/review/settings/admin-parts.tsx \
  apps/web/src/review/settings/settings-screen.tsx apps/web/src/review/review-app.tsx apps/web/src/shell apps/web/src/review/review-routes.ts
git commit -m "Add the Admin console frame and keep one navigation on every screen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7.3: Members in the console

**Files:**
- Modify: `apps/web/src/review/settings/members-screen.tsx`

**Interfaces:**
- Consumes: `AdminConsole`, `useAdminInspectorFullscreen` (Task 7.2); `AddRecordButton` (Task 7.2); `useSelectedRecord`, `admittedLabel`, `dateOrDash` and `dateTimeOrDash` (Task 7.1); `DataGrid` and `type GridColumn` from `@/arkcase`; `memberSchema` fields from slice 3.
- Produces: `MembersScreen()`, with no props, always administrator.

- [ ] **Step 1: Measure the bundle before the first DataGrid use**

Run: `pnpm --filter @artifact-server/web build && node -e 'const fs=require("fs");const d="apps/web/dist/assets";console.log(fs.readdirSync(d).filter(f=>f.endsWith(".js")).reduce((n,f)=>n+fs.statSync(d+"/"+f).size,0))'`

Expected: one byte count. Write it in this task's commit message as `bundle before DataGrid: <n> bytes`.

- [ ] **Step 2: Replace the screen body**

Keep the existing state, the `load`, `admit` and `deactivate` functions, `roleOptions`, and both `Modal`s exactly as they are. Make these changes:

1. Delete the `columns: LedgerColumn<InstallationMember>[]` array and the `PageScaffold`.
2. Add the row type and the columns:

```tsx
interface MemberRow {
  readonly email: string;
  readonly id: string;
  readonly lastActive: string;
  readonly member: InstallationMember;
  readonly name: string;
  readonly role: string;
  readonly status: "Active" | "Inactive";
}
```

   Inside `MembersScreen`, before `return`:

```tsx
  const [selectedId, selectRecord] = useSelectedRecord();
  const fullscreen = useAdminInspectorFullscreen();
  const rows: MemberRow[] = members.map((member) => ({
    email: member.email,
    id: member.id,
    lastActive: dateOrDash(member.lastActiveAt),
    member,
    name: member.displayName,
    role: member.role === "administrator" ? "Administrator" : "Member",
    status: member.status === "active" ? "Active" : "Inactive",
  }));
  const statusPill = (status: MemberRow["status"]) => (
    <StatusPill label={status} tone={status === "Active" ? "success" : "neutral"} />
  );
  const columns: GridColumn<MemberRow>[] = [
    {field: "name", headerName: "Member", onCellClick: (row) => selectRecord(row.id), width: 220},
    {field: "email", headerName: "Email", type: "contact", width: 260},
    {field: "role", headerName: "Role", width: 140},
    {cellRenderer: (value: MemberRow["status"]) => statusPill(value), field: "status", headerName: "Status", width: 120},
    {field: "lastActive", headerName: "Last active", type: "date", width: 130},
  ];
  const selected = members.find((member) => member.id === selectedId) ?? null;
  const inspector = selected === null ? null : (
    <SlideOver
      footer={selected.status === "active" ? (
        <Button danger icon="bi-person-dash" onClick={() => setDeactivating(selected)} outline size="sm" variant="secondary">
          Deactivate
        </Button>
      ) : null}
      fullscreen={fullscreen}
      onClose={() => selectRecord(null)}
      subtitle={selected.email}
      title={selected.displayName}
      titleMeta={statusPill(selected.status === "active" ? "Active" : "Inactive")}
      width={360}
    >
      <FieldGrid
        columns={1}
        fields={[
          {label: "Role", value: selected.role === "administrator" ? "Administrator" : "Member"},
          {label: "Admitted", mono: true, value: dateTimeOrDash(selected.admittedAt)},
          {label: "Admitted by", value: admittedLabel(selected)},
          {label: "Last active", mono: true, value: dateTimeOrDash(selected.lastActiveAt)},
        ]}
      />
    </SlideOver>
  );
```

3. Replace the returned tree:

```tsx
  return (
    <AdminConsole administrator area="members" inspector={inspector}>
      {error === null || admitOpen || deactivating !== null
        ? null
        : <RequestFailure error={error} onRetry={() => void load()} />}
      {loading && members.length === 0 ? (
        <SurfaceState loadingTitle="Loading members" noun="members" phase="loading" skeleton={3} />
      ) : (
        <RecordPanel
          actions={<AddRecordButton label="Admit member" onClick={() => setAdmitOpen(true)} />}
          capAlign="center"
          label="Members"
          metaWrap
          subtitle={`${members.length} members · ${activeCount} active`}
        >
          <DataGrid
            ariaLabel="Members"
            columns={columns}
            quickFilter
            rowActions={(row: MemberRow) => row.member.status === "active"
              ? [{danger: true, icon: "bi-person-dash", label: "Deactivate", onClick: () => setDeactivating(row.member)}]
              : null}
            rowActionsLabel={(row: MemberRow) => `Actions for ${row.name}`}
            rows={rows}
            selectable={false}
            statusBar={false}
          />
        </RecordPanel>
      )}
      {/* the existing admit Modal and deactivate Modal, unchanged */}
    </AdminConsole>
  );
```

4. Set the imports to:

```tsx
import {api, type InstallationMember} from "@/api/client";
import {
  Button, DataGrid, FieldGrid, Input, Modal, RecordPanel, Select, SlideOver, StatusPill, SurfaceState,
  type GridColumn,
} from "@/arkcase";
import {AddRecordButton, AdminStack, nativeInputAttributes, RequestFailure} from "./admin-parts.tsx";
import {AdminConsole, useAdminInspectorFullscreen} from "./admin-console.tsx";
import {admittedLabel, dateOrDash, dateTimeOrDash} from "./admin-areas.ts";
import {useSelectedRecord} from "./use-selected-record.ts";
```

   If `@/arkcase` does not re-export `GridColumn`, import it with `import type {GridColumn} from "@/arkcase/components/grid/DataGrid.jsx";`.

5. Change the admit modal's subtitle so it states the rule without the removed rationale: `subtitle="Admit one person to this installation. Every active member can open every project."`.

6. A deactivation that succeeds from the detail pane leaves the pane open on the now-inactive member. `load()` refreshes `members`, so its pill reads Inactive and the footer disappears.

- [ ] **Step 3: Measure the bundle again and apply the 25% stop**

Run the Step 1 command again.

- If the total exceeds the slice-1 baseline by more than 25%, stop and report the numbers. Then replace `DataGrid` with the existing `Ledger` from `admin-parts.tsx`, using columns Member (`IdentityCell` with a link-styled `Button` that calls `selectRecord`), Email, Role, Status and Last active, plus an `action` column rendering `<RowActionsMenu label={`Actions for ${member.displayName}`} items={[...]} />`. Use the same fallback in Task 7.4.
- Otherwise record `bundle after DataGrid: <n> bytes`.

- [ ] **Step 4: Typecheck, lint and build**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @artifact-server/web build`

Expected: all exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/review/settings/members-screen.tsx
git commit -m "Show members in the Admin console grid with a detail pane

bundle before DataGrid: <n> bytes; after: <m> bytes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7.4: API keys in the console

**Files:**
- Modify: `apps/web/src/review/settings/api-keys-screen.tsx`

**Interfaces:**
- Consumes: the same as Task 7.3, plus `keyStatusLabel`, `keyStatusTone` and `type KeyStatus` (Task 7.1), and `apiKeySchema` fields from slice 3 (`status`, `ownerName`, `lastUsedAt`, `revokedBy`).
- Produces: `ApiKeysScreen()`, with no props.

- [ ] **Step 1: Replace the ledger and page frame**

Keep the `capabilities` list, `formatDatetimeLocalMinimum`, the state, the `load`, `issue`, `rotate` and `revoke` functions, the issue `Modal`, `SecretModal` and the revoke `Modal` unchanged. Make these changes:

1. Delete the `columns: LedgerColumn<ManagedApiKey>[]` array and the `PageScaffold`.
2. Add, inside `ApiKeysScreen`:

```tsx
  const [selectedId, selectRecord] = useSelectedRecord();
  const fullscreen = useAdminInspectorFullscreen();
  const capabilityLabel = new Map(capabilities.map((capability) => [capability.value, capability.label]));
  interface KeyRow {
    readonly apiKey: ManagedApiKey;
    readonly capabilityCount: number;
    readonly expires: string;
    readonly id: string;
    readonly lastUsed: string;
    readonly name: string;
    readonly owner: string;
    readonly status: KeyStatus;
  }
  const rows: KeyRow[] = apiKeys.map((apiKey) => ({
    apiKey,
    capabilityCount: apiKey.capabilities.length,
    expires: dateOrDash(apiKey.expiresAt),
    id: apiKey.id,
    lastUsed: dateOrDash(apiKey.lastUsedAt),
    name: apiKey.name,
    owner: apiKey.ownerName,
    status: apiKey.status,
  }));
  const statusPill = (status: KeyStatus) => <StatusPill label={keyStatusLabel(status)} tone={keyStatusTone(status)} />;
  const columns: GridColumn<KeyRow>[] = [
    {
      cellRenderer: (_value: string, row: KeyRow) => (
        <span style={keyCellStyle}>
          <span>{row.name}</span>
          <span style={prefixStyle}>{row.apiKey.prefix}</span>
        </span>
      ),
      field: "name",
      headerName: "Key",
      onCellClick: (row) => selectRecord(row.id),
      width: 240,
    },
    {field: "owner", headerName: "Owner", width: 170},
    {field: "capabilityCount", headerName: "Capabilities", type: "count", width: 120},
    {field: "lastUsed", headerName: "Last used", type: "date", width: 120},
    {field: "expires", headerName: "Expires", type: "date", width: 120},
    {cellRenderer: (value: KeyStatus) => statusPill(value), field: "status", headerName: "Status", width: 110},
  ];
  const activeCount = apiKeys.filter((apiKey) => apiKey.status === "active").length;
  const selected = apiKeys.find((apiKey) => apiKey.id === selectedId) ?? null;
  const inspector = selected === null ? null : (
    <SlideOver
      footer={selected.status === "active" ? (
        <Button danger icon="bi-x-circle" onClick={() => setRevoking(selected)} outline size="sm" variant="secondary">
          Revoke
        </Button>
      ) : null}
      fullscreen={fullscreen}
      onClose={() => selectRecord(null)}
      subtitle={selected.ownerName}
      title={selected.name}
      titleMeta={statusPill(selected.status)}
      width={360}
    >
      <div style={detailStackStyle}>
        <FieldGrid
          columns={1}
          fields={[
            {label: "Prefix", mono: true, value: selected.prefix},
            {label: "Created", mono: true, value: dateTimeOrDash(selected.createdAt)},
            {label: "Last used", mono: true, value: dateTimeOrDash(selected.lastUsedAt)},
            {label: "Expires", mono: true, value: dateTimeOrDash(selected.expiresAt)},
            ...(selected.revokedAt === null ? [] : [{
              label: "Revoked",
              value: `${dateTimeOrDash(selected.revokedAt)} by ${selected.revokedBy?.name ?? "Unknown"}`,
            }]),
          ]}
        />
        <div aria-label="Capabilities" role="list" style={tagListStyle}>
          {selected.capabilities.map((capability) => (
            <span key={capability} role="listitem"><Tag>{capabilityLabel.get(capability) ?? capability}</Tag></span>
          ))}
        </div>
      </div>
    </SlideOver>
  );
```

   `KeyRow` is declared inside the component only so it sits beside its use. Hoist it to module scope if Oxlint's rules require type declarations at the top level.

3. Replace the returned tree's frame with the version below. The issue `Modal`, `SecretModal` and revoke `Modal` stay as children, unchanged:

```tsx
    <AdminConsole administrator area="apiKeys" inspector={inspector}>
      {error === null || issueOpen || revoking !== null
        ? null
        : <RequestFailure error={error} onRetry={() => void load()} />}
      {loading && apiKeys.length === 0 ? (
        <SurfaceState loadingTitle="Loading API keys" noun="API keys" phase="loading" skeleton={3} />
      ) : (
        <RecordPanel
          actions={<AddRecordButton label="Issue API key" onClick={() => setIssueOpen(true)} />}
          capAlign="center"
          label="API keys"
          metaWrap
          subtitle={`${apiKeys.length} keys · ${activeCount} active`}
        >
          <DataGrid
            ariaLabel="API keys"
            columns={columns}
            empty={(
              <SurfaceState
                count={0}
                density="inline"
                emptyBody="Issue a scoped key for automation or a compatible self-hosted MCP client."
                emptyIcon="bi-key"
                emptyTitle="No API keys"
                noun="API keys"
                phase="ready"
              />
            )}
            quickFilter
            rowActions={(row: KeyRow) => row.status === "active" ? [
              {icon: "bi-arrow-repeat", label: "Rotate", onClick: () => void rotate(row.id)},
              {danger: true, icon: "bi-x-circle", label: "Revoke", onClick: () => setRevoking(row.apiKey)},
            ] : null}
            rowActionsLabel={(row: KeyRow) => `Actions for ${row.name}`}
            rows={rows}
            selectable={false}
            statusBar={false}
          />
        </RecordPanel>
      )}
      {/* issue Modal, SecretModal, revoke Modal — unchanged */}
    </AdminConsole>
```

4. Add the styles:

```tsx
const keyCellStyle: CSSProperties = {display: "inline-flex", flexDirection: "column", lineHeight: 1.3, minWidth: 0};
const prefixStyle: CSSProperties = {color: "var(--text-secondary, #5a6268)", fontFamily: "var(--font-data, monospace)", fontSize: 12};
const detailStackStyle: CSSProperties = {display: "flex", flexDirection: "column", gap: 14};
```

5. Update the imports. Drop `PageScaffold`, `Ledger`, `IdentityCell`, `AdminPanel`, `LedgerColumn` and `formatTimestamp`. Add `DataGrid`, `FieldGrid`, `RecordPanel`, `SlideOver` and `type GridColumn` from `@/arkcase`, plus `AddRecordButton`, `AdminConsole` with `useAdminInspectorFullscreen`, `useSelectedRecord`, and `dateOrDash`, `dateTimeOrDash`, `keyStatusLabel`, `keyStatusTone` and `type KeyStatus`.

6. The issue `Modal`'s subtitle stays. Remove the old page `meta` and its "Secrets are never shown again." rationale; `SecretModal` already states that.

- [ ] **Step 2: Typecheck, lint and build**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @artifact-server/web build`

Expected: all exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/review/settings/api-keys-screen.tsx
git commit -m "Show API keys in the Admin console with status, last use and a detail pane

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7.5: Public links in the console

**Files:**
- Modify: `apps/web/src/review/settings/public-links-screen.tsx`

**Interfaces:**
- Consumes: `AdminConsole` and `RowActionsMenu` (Task 7.2); `dateOrDash` (Task 7.1); `publicLinkItemSchema` fields `madePublicAt` and `madePublicBy` (slice 3).
- Produces: `PublicLinksScreen()`, with no props.

ADM-005 requires paging, a bounded multi-select and partial-success retry. DataGrid's row checkboxes are all named "Select row", so this area keeps the accessible `Ledger` with per-row "Select <artifact>" checkboxes. Only its frame, columns and row verbs change.

- [ ] **Step 1: Re-frame and re-column the screen**

1. Replace both early-return `PageScaffold title="Public links"` wrappers (loading and failed) with `<AdminConsole administrator area="publicLinks">…</AdminConsole>`, keeping their `SurfaceState` children.

2. In `columns`, keep the `select` column. Replace the `artifact`, `link` and `actions` columns with:

```tsx
    {
      align: "left",
      cell: (item) => ({
        value: (
          <IdentityCell
            badge={item.project.archivedAt === null ? null : <StatusPill label="Archived" tone="neutral" />}
            detail={item.project.name}
            primary={(
              <Button flush href={artifactReviewHref(item.project.id, item.artifact.id)} size="sm" style={ledgerLinkStyle} variant="link">
                {item.artifact.name}
              </Button>
            )}
          />
        ),
      }),
      key: "artifact",
      kind: "field",
      label: "Artifact",
      width: "minmax(0, 1fr)",
    },
    {
      align: "right",
      cell: (item) => ({mono: true, value: `v${item.currentVersion.number}`}),
      key: "version",
      kind: "field",
      label: "Version",
      width: "80px",
    },
    {
      align: "left",
      cell: (item) => ({
        value: (
          <span style={linkCellStyle}>
            <Button flush href={item.links.public} size="sm" style={publicUrlStyle} target="_blank" title={item.links.public} variant="link">
              {item.links.public}
            </Button>
            <CopyAction label={`Copy link to ${item.artifact.name}`} text={item.links.public} />
          </span>
        ),
      }),
      key: "link",
      kind: "field",
      label: "Link",
      width: "minmax(0, 1.4fr)",
    },
    {
      align: "left",
      cell: (item) => ({
        value: (
          <IdentityCell
            detail={item.madePublicBy?.name ?? "—"}
            detailMono={false}
            primary={<span style={{fontFamily: "var(--font-data, monospace)", fontWeight: 400}}>{dateOrDash(item.madePublicAt)}</span>}
          />
        ),
      }),
      key: "madePublic",
      kind: "field",
      label: "Made public",
      width: "150px",
    },
    {
      align: "right",
      cell: (item) => ({
        value: (
          <RowActionsMenu
            items={[{danger: true, disabled: pending, icon: "bi-lock", label: "Make private", onClick: () => setConfirmation([item])}]}
            label={`Actions for ${item.artifact.name}`}
          />
        ),
      }),
      key: "actions",
      kind: "action",
      label: "",
      width: "56px",
    },
```

   Project appears as the artifact cell's detail line, as it does today, so the ledger stays inside narrow widths. The ledger is named "Public links inventory".

3. Replace the main `PageScaffold` with `<AdminConsole administrator area="publicLinks">`. Keep its children in order:
   - `RequestFailure`, the notice `Alert` and the failures `Alert`;
   - the empty `SurfaceState`;
   - the bulk-selection `AdminPanel`;
   - the inventory;
   - the pagination `nav`;
   - the confirmation `Modal`.

   Change the inventory `AdminPanel` to `<AdminPanel actions={reloadButton} label="Public links" padded={false} subtitle={`${loadedItems.length} loaded`}>`, where:

```tsx
  const reloadButton = (
    <Button icon="bi-arrow-counterclockwise" onClick={() => void loadFirstPage()} outline size="sm" variant="secondary">
      Reload
    </Button>
  );
```

   Remove the old page `meta`; the area lede states the purpose.

4. Add `const linkCellStyle: CSSProperties = {alignItems: "center", display: "inline-flex", gap: 6, minWidth: 0};` and update the imports. Add `AdminConsole`, `RowActionsMenu` and `dateOrDash`, and drop `PageScaffold`. Keep `AdminActions` if the bulk panel still uses it.

- [ ] **Step 2: Typecheck, lint and build**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @artifact-server/web build`

Expected: all exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/review/settings/public-links-screen.tsx
git commit -m "Show public links in the Admin console with when and by whom they were made public

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7.6: MCP & WebMCP in the console

**Files:**
- Modify: `apps/web/src/review/webmcp.tsx` (export `webmcpToolNames`)
- Modify: `apps/web/src/review/settings/mcp-webmcp-screen.tsx`
- Test: `apps/web/src/review/webmcp-tool-names.test.ts`

**Interfaces:**
- Consumes: `AdminConsole` (Task 7.2).
- Produces: `webmcpToolNames(): readonly string[]` in `webmcp.tsx`.

The prototype's tool-group table has no server source: MCP tools are registered at runtime in `src/mcp/artifact-mcp-server.ts`, and no endpoint lists them. Following the spec's "omit what the server cannot back", the table is not built, and Task 8.2 records this in `docs/claude-design.md`. The WebMCP tool tags are real, because the browser registers them, so they are shown.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/review/webmcp-tool-names.test.ts
import {webmcpToolNames} from "@/review/webmcp";
import {describe, expect, it} from "vitest";

describe("WebMCP tool names", () => {
  it("lists exactly the review tools the browser registers, in registration order", () => {
    expect(webmcpToolNames()).toEqual([
      "artifact_server_get_view",
      "artifact_server_list_artifacts",
      "artifact_server_comment",
      "artifact_server_reply",
      "artifact_server_open",
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review/webmcp-tool-names.test.ts`

Expected: FAIL with `webmcpToolNames is not a function` or an import error.

- [ ] **Step 3: Export the names from the registration source**

Add below `reviewTools` in `apps/web/src/review/webmcp.tsx`:

```ts
const inertBindings: WebmcpBindings = {
  getSnapshot: () => ({
    artifact: null,
    loading: true,
    projectId: "",
    projectName: null,
    replies: new Map(),
    threads: [],
    version: null,
  }),
  openArtifact: () => undefined,
  reloadComments: async () => undefined,
};

/** The names of the review tools this browser registers, read from the same definitions. */
export function webmcpToolNames(): readonly string[] {
  return reviewTools({current: inertBindings}).map((tool) => tool.name);
}
```

If `WebmcpSnapshot` has fields beyond those at `webmcp.tsx:119-130` when you reach this task, fill them with their empty values so the object satisfies the type.

- [ ] **Step 4: Re-frame the screen**

In `apps/web/src/review/settings/mcp-webmcp-screen.tsx`:

1. Replace `<PageScaffold meta=… title="MCP & WebMCP">` with `<AdminConsole administrator={administrator} area="mcp">`.
2. Rename the second panel's label from `"Team or remote server"` to `"Remote server"`; keep its subtitle and content.
3. Keep "Check the connection" and "Artifact Server skill"; both are real commands.
4. In `WebmcpPreference`, append after the second `AdminNote`:

```tsx
        <AdminActions>
          {webmcpToolNames().map((name) => <Tag key={name}>{name}</Tag>)}
        </AdminActions>
```

5. Update the imports: drop `PageScaffold`, add `AdminConsole` from `./admin-console.tsx`, and add `webmcpToolNames` to the `../webmcp.tsx` import.

- [ ] **Step 5: Run the test, typecheck, lint and build**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review/webmcp-tool-names.test.ts && pnpm typecheck && pnpm lint && pnpm --filter @artifact-server/web build`

Expected: PASS, then all exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/review/webmcp.tsx apps/web/src/review/webmcp-tool-names.test.ts \
  apps/web/src/review/settings/mcp-webmcp-screen.tsx
git commit -m "Show MCP & WebMCP in the Admin console with the browser's tool names

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7.7: Prove the Admin console (ADM-008) and retarget administration proof

**Files:**
- Create: `tests/browser/admin-console.spec.ts`
- Modify: `tests/browser/frontend-mvp.spec.ts:1151-1194` (members and keys part of the `ADM-003…ADM-007` test), `:1210-1316` (`ADM-005`)
- Modify: `tests/browser/csp-clean.spec.ts:281-309`
- Modify: `tests/browser/shell-navigation.spec.ts` (any `settings/members` heading-level assertion; the admin-mode "Back to review" walk)
- Modify: `tests/browser/frontend-mvp.spec.ts:510-514` (account-menu "Back to review")
- Modify: `project/spec/single-application-administration-spec.md` (Installation settings)
- Modify: `project/spec/conformance.yml` (new `ADM-008`; revised `ADM-003`, `ADM-004` and `ADM-005` behavior text)

**Interfaces:**
- Consumes: `signInAdministrator` and `issueApiKey` from `../support/agent-dispatch.js`; `publishNew`; the browser-fixture helpers.
- Produces: browser proof `ADM-008-B` and `ADM-008-F`, and ledger entry `ADM-008` (status `implementing`).

- [ ] **Step 1: Write the spec**

```ts
// tests/browser/admin-console.spec.ts
import {AxeBuilder} from "@axe-core/playwright";
import {expect, test, type Page} from "@playwright/test";

import {issueApiKey, signInAdministrator} from "../support/agent-dispatch.js";
import {publishNew} from "../support/publishing.js";
import {localLogin, startBrowserFixture, stopBrowserFixture} from "./browser-fixture.js";
import {waitForSettledPaint} from "./review-helpers.js";

async function noWcagViolations(page: Page): Promise<void> {
  await waitForSettledPaint(page);
  expect((await new AxeBuilder({page}).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
}

test.describe("Admin console", () => {
  test("ADM-008-B: administrators work members, keys and public links through areas, grids, detail panes and confirmations", async ({browser}) => {
    test.setTimeout(120_000);
    const fixture = await startBrowserFixture(browser);
    try {
      await publishNew(fixture.server, fixture.installation, {
        accessSetting: "public_link",
        content: "console public bytes",
        idempotencyKey: "admin-console-public",
        name: "Console public link",
      });
      await localLogin(fixture);
      const page = fixture.page;

      // The account menu opens the console on Members.
      await page.getByRole("button", {name: /^Account menu/u}).click();
      await page.getByRole("menuitem", {name: "Administration"}).click();
      await expect(page).toHaveURL(/\/review\/settings\/members$/u);
      await expect(page.getByRole("heading", {level: 1, name: "Members"})).toBeVisible();
      await expect(page.getByText("Members can open every project in this installation.")).toBeVisible();
      const areas = page.getByRole("navigation", {name: "Administration areas"});
      for (const label of ["Members", "API keys", "Public links", "MCP & WebMCP"]) {
        await expect(areas.getByRole("link", {exact: true, name: label})).toBeVisible();
      }
      await noWcagViolations(page);

      // Admit through the cap's "+", open the detail, and deep-link it.
      await page.getByRole("button", {name: "Admit member"}).click();
      await page.getByLabel("Display name").fill("Console member");
      await page.getByLabel("Email").fill("console-member@example.test");
      await page.getByRole("button", {exact: true, name: "Admit member"}).last().click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const grid = page.getByRole("grid", {name: "Members"});
      await grid.getByRole("button", {name: "Console member"}).click();
      await expect(page).toHaveURL(/\/review\/settings\/members\?selected=/u);
      const detail = page.getByRole("complementary").or(page.getByRole("dialog")).filter({hasText: "console-member@example.test"});
      await expect(detail.getByText("Admitted by")).toBeVisible();
      await expect(detail.getByText("Last active")).toBeVisible();
      await expect(detail).toContainText(/\d{2}\/\d{2}\/\d{4}/u);
      await page.reload();
      await expect(page.getByText("console-member@example.test").last()).toBeVisible();
      await expect(page.getByText("Admitted by")).toBeVisible();

      // Destructive verbs live in the row menu and confirm in a danger dialog.
      await grid.getByRole("button", {name: "Actions for Console member"}).click();
      await page.getByRole("menuitem", {name: "Deactivate"}).click();
      await page.getByRole("button", {name: "Deactivate member"}).click();
      await expect(page.getByRole("dialog", {name: "Deactivate member"})).toHaveCount(0);
      await expect(grid.getByRole("row").filter({hasText: "Console member"}).getByText("Inactive")).toBeVisible();

      // API keys: issue, see last use after the key is used, open its capabilities, revoke.
      await areas.getByRole("link", {exact: true, name: "API keys"}).click();
      await expect(page).toHaveURL(/\/review\/settings\/api-keys$/u);
      await page.getByRole("button", {name: "Issue API key"}).click();
      const issue = page.getByRole("dialog", {name: "Issue API key"});
      await issue.getByRole("textbox", {exact: true, name: "Name"}).fill("Console key");
      await issue.getByLabel("Expires at", {exact: true}).fill("2099-01-01T00:00");
      await issue.getByRole("checkbox", {name: /Read artifacts/u}).click();
      await issue.getByRole("button", {exact: true, name: "Issue API key"}).click();
      const secret = (await page.getByRole("region", {name: "API key secret"}).textContent()) ?? "";
      expect(secret).toMatch(/^as_key_/u);
      await page.getByRole("button", {name: "I stored it"}).click();
      expect((await fetch(`${fixture.server.baseUrl}/api/v1/projects`, {
        headers: {Authorization: `Bearer ${secret}`},
      })).status).toBe(200);
      await page.reload();
      const keys = page.getByRole("grid", {name: "API keys"});
      const keyRow = keys.getByRole("row").filter({hasText: "Console key"});
      await expect(keyRow).toContainText(/\d{2}\/\d{2}\/\d{4}/u);
      await keyRow.getByRole("button", {name: "Console key"}).click();
      await expect(page.getByRole("list", {name: "Capabilities"}).getByText("Read artifacts")).toBeVisible();
      await keys.getByRole("button", {name: "Actions for Console key"}).click();
      await page.getByRole("menuitem", {name: "Revoke"}).click();
      await page.getByRole("button", {name: "Revoke API key"}).click();
      await expect(keyRow.getByText("Revoked")).toBeVisible();
      await expect(page.getByText(/Revoked.* by /u)).toBeVisible();
      await noWcagViolations(page);

      // Public links: made-public date, then Make private from the row menu.
      await areas.getByRole("link", {exact: true, name: "Public links"}).click();
      const inventory = page.getByRole("table", {name: "Public links inventory"});
      const linkRow = inventory.getByRole("row").filter({hasText: "Console public link"});
      await expect(linkRow).toContainText(/\d{2}\/\d{2}\/\d{4}/u);
      await linkRow.getByRole("button", {name: "Actions for Console public link"}).click();
      await page.getByRole("menuitem", {name: "Make private"}).click();
      await page.getByRole("button", {exact: true, name: "Make private"}).last().click();
      await expect(linkRow).toHaveCount(0);

      // MCP & WebMCP shows the real browser tool names.
      await areas.getByRole("link", {exact: true, name: "MCP & WebMCP"}).click();
      await expect(page.getByText("artifact_server_get_view", {exact: true})).toBeVisible();

      // The area menu's pin persists across a reload.
      await page.getByRole("button", {name: /Unpin the administration menu/u}).click();
      await page.reload();
      await expect(page.getByRole("button", {name: /Pin the administration menu|Expand menu/u}).first()).toBeVisible();

      // Phones choose the area from a Select in the head.
      await page.setViewportSize({height: 800, width: 390});
      await page.getByLabel("Administration area").selectOption({label: "API keys"});
      await expect(page).toHaveURL(/\/review\/settings\/api-keys$/u);
      await expect.poll(() => page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ADM-008-F: non-administrators get no console entry, the server refuses admin reads, and confirmations cannot be skipped", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await localLogin(fixture);
      const page = fixture.page;

      // An unknown deep-linked record opens no pane and raises no error.
      await page.goto(`${fixture.server.baseUrl}/review/settings/members?selected=mbr_missing`);
      await expect(page.getByRole("heading", {level: 1, name: "Members"})).toBeVisible();
      await expect(page.getByText("Admitted by")).toHaveCount(0);

      // Cancelling a destructive confirmation changes nothing.
      const grid = page.getByRole("grid", {name: "Members"});
      await page.getByRole("button", {name: "Admit member"}).click();
      await page.getByLabel("Display name").fill("Kept member");
      await page.getByLabel("Email").fill("kept-member@example.test");
      await page.getByRole("button", {exact: true, name: "Admit member"}).last().click();
      await grid.getByRole("button", {name: "Actions for Kept member"}).click();
      await page.getByRole("menuitem", {name: "Deactivate"}).click();
      await page.getByRole("dialog", {name: "Deactivate member"}).getByRole("button", {name: "Cancel"}).click();
      await expect(grid.getByRole("row").filter({hasText: "Kept member"}).getByText("Active", {exact: true})).toBeVisible();

      // The server refuses member administration to a non-administrator key.
      const cookies = await signInAdministrator(fixture.server, fixture.installation);
      const reader = await issueApiKey(fixture.server, cookies, ["artifact:read"], "Console reader");
      for (const path of ["/api/v1/members", "/api/v1/api-keys", "/api/v1/administration/public-links"]) {
        expect((await fetch(`${fixture.server.baseUrl}${path}`, {headers: {Authorization: `Bearer ${reader}`}})).status)
          .toBe(403);
      }

      // A member session sees no administration entry and a forbidden state on direct URLs.
      await page.route("**/api/v1/session", async (route) => {
        const response = await route.fetch();
        const body = await response.json() as {principal: {membershipRole: string}};
        body.principal.membershipRole = "member";
        await route.fulfill({json: body, response});
      });
      await page.goto(`${fixture.server.baseUrl}/review`);
      const memberNav = page.getByRole("navigation", {name: "Review and projects"});
      await expect(memberNav.getByRole("link", {name: "Administration"})).toHaveCount(0);
      // Non-administrators keep their route to MCP setup, in the navigation and the account menu.
      await expect(memberNav.getByRole("link", {name: "MCP & WebMCP"})).toHaveAttribute("href", "/review/settings/mcp");
      await page.getByRole("button", {name: /^Account menu/u}).click();
      await expect(page.getByRole("menuitem", {name: "Administration"})).toHaveCount(0);
      await expect(page.getByRole("menuitem", {name: "MCP & WebMCP"})).toBeVisible();
      await page.keyboard.press("Escape");
      for (const path of ["members", "api-keys", "public-links"]) {
        await page.goto(`${fixture.server.baseUrl}/review/settings/${path}`);
        await expect(page.getByRole("heading", {name: "Administrator permission required"})).toBeVisible();
      }
      await page.goto(`${fixture.server.baseUrl}/review/settings/mcp`);
      await expect(page.getByRole("heading", {level: 1, name: "MCP & WebMCP"})).toBeVisible();
      await expect(page.getByRole("navigation", {name: "Administration areas"})).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
```

`DataGrid` renders `role="grid"` named by `ariaLabel`. If the vendored grid uses `role="table"`, use that role. Pick the selector from the rendered DOM; never loosen it to `locator("div")`.

- [ ] **Step 2: Run the spec**

Run: `pnpm build && pnpm exec playwright test tests/browser/admin-console.spec.ts --project=chromium`

Expected: PASS for both tests. A failure is a product gap; fix the product code.

- [ ] **Step 3: Retarget the existing administration proof**

1. In the `ADM-003…ADM-007` test (`frontend-mvp.spec.ts:1151-1194`):
   - Replace `memberRow.getByRole("button", {name: "Deactivate"}).click()` with:

```ts
      await fixture.page.getByRole("button", {name: "Actions for Frontend member"}).click();
      await fixture.page.getByRole("menuitem", {name: "Deactivate"}).click();
```

   - Change `memberRow.getByText("inactive", {exact: true})` to `memberRow.getByText("Inactive", {exact: true})`.
   - Keep `getByRole("link", {name: "API keys"})`; it is now the area-menu link.
   - Replace `keyRow.getByText("comment:write", {exact: true})` with opening the detail and checking the tag:

```ts
      await keyRow.getByRole("button", {name: "Browser workflow key"}).click();
      await expect(fixture.page.getByRole("list", {name: "Capabilities"}).getByText("Manage comments")).toBeVisible();
      await fixture.page.getByRole("button", {name: "Actions for Browser workflow key"}).first().click();
      await fixture.page.getByRole("menuitem", {name: "Rotate"}).click();
```

     Then delete the old `keyRow.getByRole("button", {name: "Rotate"}).click();` line.

   - The `browserStorage` expectation (`localStorageKeys: []`) still holds: nothing pins or resizes the area menu in this test, and preferences are written only on change.

2. In the `ADM-005` test (`frontend-mvp.spec.ts:1210-1316`):
   - Change the heading check to `getByRole("heading", {level: 1, name: "Public links"})`.
   - Change `getByRole("region", {exact: true, name: "Public links"}).locator("[data-page-body]")` to `getByRole("region", {exact: true, name: "Public links"}).and(fixture.page.locator("[data-admin-content]"))`.
   - Replace the phone assertions `firstRow.getByRole("link", {name: "Open"})` and `firstRow.getByRole("button", {name: "Make private"})` with `firstRow.getByRole("button", {name: "Actions for First public link"})` visible.
   - Replace the single make-private click with:

```ts
      await otherRow.getByRole("button", {name: "Actions for Cross-project public link"}).click();
      await fixture.page.getByRole("menuitem", {name: "Make private"}).click();
      await fixture.page.getByRole("button", {name: "Make private", exact: true}).last().click();
```

   - Add, after the first axe check:

```ts
      await expect(firstRow).toContainText(/\d{2}\/\d{2}\/\d{4}/u);
```

3. In `tests/browser/csp-clean.spec.ts:281-309`:
   - Members: change the heading level to 1, and open the row menu before Deactivate:

```ts
        await page.getByRole("button", {name: /^Actions for /u}).first().click();
        await page.getByRole("menuitem", {name: "Deactivate"}).click();
        await cancelDialog("Deactivate member");
```

     The first member row is the local owner, and the server refuses its deactivation only on confirm, so the dialog still opens.

   - API keys: replace the revoke click with `page.getByRole("button", {name: "Actions for CSP key"}).click()`, then `page.getByRole("menuitem", {name: "Revoke"}).click()`.
   - Public links: replace the make-private click with `page.getByRole("button", {name: "Actions for CSP public link"}).click()`, then `page.getByRole("menuitem", {name: "Make private"}).click()`.
   - MCP: change both MCP heading checks to `level: 1`.

4. Run `grep -n "level: 2, name: \"\(Members\|API keys\|Public links\|MCP & WebMCP\)\"" tests/browser/*.ts` and change each hit to `level: 1`.

5. Retarget the walks that used the retired admin navigation mode (Task 7.2). On `/review/settings/*` the main navigation is still "Review and projects"; there is no "Administration" navigation and no "Back to review".
   - In `tests/browser/shell-navigation.spec.ts`, in the `NAV-001-B: left navigation` walk, replace everything from `const adminNav = page.getByRole("navigation", {name: "Administration"});` through the `page.goForward()` block's `await expectSameDocument(page);` with the code below. Task 5.6 already renamed this walk's "Review queue" steps to Activity.

```ts
      await expect(page.getByRole("navigation", {name: "Administration areas"})).toBeVisible();
      await expectSameDocument(page);

      // The review navigation stays on settings screens; its Activity link leaves in place.
      await nav.getByRole("link", {name: "Activity"}).click();
      await expect(page.getByRole("heading", {exact: true, level: 1, name: "Activity"})).toBeVisible();
      await expectSameDocument(page);

      await page.goBack();
      await expect(page).toHaveURL(/\/review\/settings\/members$/u);
      await page.goBack();
      await expect(page.getByRole("heading", {exact: true, level: 1, name: "Activity"})).toBeVisible();
      await page.goForward();
      await expect(page).toHaveURL(/\/review\/settings\/members$/u);
      await expectSameDocument(page);
```

   - In `tests/browser/frontend-mvp.spec.ts:510-514`, replace:

```ts
      await expect(page.getByRole("navigation", {name: "Administration"})).toBeVisible();
      await page.getByRole("button", {name: /^Account menu: /u}).click();
      await accountMenu.getByRole("menuitem", {name: "Back to review"}).click();
      await expect(page).toHaveURL(/\/review\?project=prj_default/u);
```

     with:

```ts
      await expect(page.getByRole("navigation", {name: "Administration areas"})).toBeVisible();
      await page.getByRole("navigation", {name: "Review and projects"}).getByRole("link", {name: "Activity"}).click();
      await expect(page).toHaveURL(`${fixture.server.baseUrl}/review`);
```

   - Run `grep -n "Back to review\|name: \"Administration\"})" tests/browser/*.ts`. Expected: no hits except `menuitem`/`link` lookups named "Administration" that open the console.

- [ ] **Step 4: Update the administration spec and the ledger**

In `project/spec/single-application-administration-spec.md`, insert before `### Members`:

```md
### Administration console {#administration-console}

Installation settings share one console. An area menu groups **People and
access** (Members, API keys), **Sharing** (Public links) and **Integrations**
(MCP & WebMCP); it can be pinned to the side or unpinned to a rail, and resized.
Below 768 px it becomes an area selector in the page head. The head names the
area under an `Administration` breadcrumb with a one-line description.

Members and API keys list in a sortable, filterable grid. Selecting a record's
name opens a detail pane beside the grid (it stacks over the grid below 900 px)
and writes `?selected=` so a refresh or a shared link reopens it. Every row verb
lives in that row's actions menu; destructive verbs — deactivate, revoke, make
private — always confirm in a danger dialog.

Members show role, status, admission date, who admitted them ("Automatic",
"Installation owner", or a name) and when they were last active. API keys show
owner, capability count and tags, prefix, created, last used, expiry, status
(active, revoked, expired) and who revoked them. Public links show when and by
whom each artifact was made public. A non-administrator sees only MCP & WebMCP,
and no administration entry in navigation or the account menu.
```

In `project/spec/conformance.yml`:

1. Insert `ADM-008` after `ADM-007`:

```yaml
  - id: ADM-008
    kind: security
    behavior: Installation administration is one console with a pinnable, resizable grouped area menu, breadcrumb headings, filterable grids whose records open deep-linked detail panes, row-menu verbs, and danger confirmation for every destructive action, offered only to administrators.
    owner: web-application
    source: {file: single-application-administration-spec.md, anchor: administration-console}
    acceptance:
      behavior: {id: ADM-008-B, description: "As an administrator, open the console from the account menu, move between grouped areas, admit and deactivate a member through the grid, detail pane, and row menu, reopen a detail from its URL, issue, use, inspect, and revoke an API key and see its last use and revoker, make a public link private from its row menu after seeing when it was made public, see the browser's WebMCP tool names, keep the menu's pin across a reload, and choose areas from the head on a phone."}
      failure: {id: ADM-008-F, description: "A non-administrator sees no administration entry and a forbidden state on direct member, key, and public-link URLs, the server refuses those reads to a non-administrator key, a cancelled destructive confirmation changes nothing, and an unknown deep-linked record opens no pane."}
    deployments: *all
    status: implementing
    proof_gap: Local browser evidence is attached by the final slice; team deployments remain unrecorded.
    depends_on: [ADM-003, ADM-004, ADM-005, ADM-006, ACT-007]
    evidence: []
```

   Slice 3 adds `ACT-007`.

2. Append one clause to each `behavior` and nothing else:
   - `ADM-003`: `, showing each member's admitter and last activity`
   - `ADM-004`: `, showing each key's owner, last use, status, and revoker`
   - `ADM-005`: `, showing when and by whom each link was made public`

   Their acceptance IDs and evidence stay.

- [ ] **Step 5: Run the affected proof and the gate**

Run: `pnpm check && pnpm exec playwright test tests/browser/admin-console.spec.ts tests/browser/frontend-mvp.spec.ts tests/browser/csp-clean.spec.ts tests/browser/accessibility.spec.ts tests/browser/shell-navigation.spec.ts --project=chromium`

Expected: `pnpm check` exits 0 and every listed spec passes.

- [ ] **Step 6: Commit**

```bash
git add tests/browser/admin-console.spec.ts tests/browser/frontend-mvp.spec.ts tests/browser/csp-clean.spec.ts \
  tests/browser/shell-navigation.spec.ts project/spec/single-application-administration-spec.md project/spec/conformance.yml
git commit -m "Prove the Admin console and retarget administration proof

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8.1: Copy rule walk across the new screens

**Files:**
- Create: `tests/browser/copy-rule.spec.ts`

**Interfaces:**
- Consumes: the browser-fixture helpers; `publishNew`; `createThreadOverApi`.
- Produces: a browser test that fails if any forbidden phrase renders on Activity, Projects or any Admin console area.

`apps/web` has no DOM test environment, so this is the copy test the spec asks for. It reads rendered text, which is what a person sees, and it also checks accessible names and titles.

- [ ] **Step 1: Write the walk**

```ts
// tests/browser/copy-rule.spec.ts
import {expect, test, type Page} from "@playwright/test";

import {publishNew} from "../support/publishing.js";
import {localLogin, startBrowserFixture, stopBrowserFixture} from "./browser-fixture.js";
import {createThreadOverApi} from "./comment-api.js";

const forbidden = /prototype|fixture|demo|local example|browser-local|unavailable in/iu;

async function renderedCopy(page: Page): Promise<string> {
  return page.evaluate(() => {
    const labelled = [...document.querySelectorAll("[aria-label],[title],[placeholder]")]
      .flatMap((element) => ["aria-label", "title", "placeholder"]
        .map((name) => element.getAttribute(name) ?? ""));
    return [document.body.innerText, ...labelled].join("\n");
  });
}

test("new screens render no prototype annotation or disclaimer copy", async ({browser}) => {
  test.setTimeout(120_000);
  const fixture = await startBrowserFixture(browser);
  try {
    const published = await publishNew(fixture.server, fixture.installation, {
      accessSetting: "public_link",
      content: "<!doctype html><html lang=\"en\"><title>Copy walk</title><h1>Copy walk</h1></html>",
      idempotencyKey: "copy-walk-artifact",
      mediaType: "text/html; charset=utf-8",
      name: "Copy walk",
      path: "index.html",
    });
    await createThreadOverApi(fixture, {
      artifactId: published.body.artifact.id,
      body: "Check the heading.",
      idempotencyKey: "copy-walk-thread",
      versionId: published.body.version.id,
    });
    await localLogin(fixture);
    const page = fixture.page;
    const screens: readonly [string, string][] = [
      ["/review", "Activity"],
      ["/review/projects?project=prj_default", "Default"],
      ["/review/settings/members", "Members"],
      ["/review/settings/api-keys", "API keys"],
      ["/review/settings/public-links", "Public links"],
      ["/review/settings/mcp", "MCP & WebMCP"],
    ];
    const offenders: string[] = [];
    for (const [path, heading] of screens) {
      await page.goto(`${fixture.server.baseUrl}${path}`);
      await expect(page.getByRole("heading", {exact: true, name: heading}).first()).toBeVisible();
      const copy = await renderedCopy(page);
      for (const line of copy.split("\n")) {
        if (forbidden.test(line)) offenders.push(`${path}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  } finally {
    await stopBrowserFixture(fixture);
  }
});
```

The artifact is named "Copy walk" and its comment body is ordinary text, so artifact or comment content cannot trip the check. If a slice-5 control renders an unavoidable word such as "fixture" from user data, rename the test data; never widen the allowlist.

- [ ] **Step 2: Run it**

Run: `pnpm build && pnpm exec playwright test tests/browser/copy-rule.spec.ts --project=chromium`

Expected: PASS. If it fails, remove the offending copy from the product screen. The list prints each path and line.

- [ ] **Step 3: Commit**

```bash
git add tests/browser/copy-rule.spec.ts
git commit -m "Fail the build when new screens render prototype or disclaimer copy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8.2: Product spec prose and docs

**Files:**
- Modify: `project/spec/artifact-server-product-spec.html` (the `#activity` section, plus the table-of-contents links at lines ~1626 and ~1648)
- Modify: `docs/claude-design.md`
- Modify: `NEXT-STEPS.md`

**Interfaces:**
- Consumes: the `#activity` section anchor that slice 2 created for `ACT-001`…`ACT-005`, if it exists.
- Produces: product prose for the Projects screen and Admin console inside `#activity`, and porting notes.

- [ ] **Step 1: Add or extend the Activity section**

Run: `grep -n 'id="activity"' project/spec/artifact-server-product-spec.html`

- **If it prints a line** (slice 2 created the section): append the two `<p>` elements below as the section's last children.
- **If it prints nothing:** insert the whole section before `<section class="section" id="decisions"`, and add `<li><a href="#activity">Activity and projects</a></li>` before the `#decisions` entry at line ~1626, and `<a href="#activity">Activity and projects</a>` before the `#decisions` link at line ~1648.

```html
        <section class="section" id="activity" aria-labelledby="activity-title">
          <div class="section-heading">
            <span class="section-label">Review experience</span>
            <h2 id="activity-title">Activity, projects, and administration</h2>
          </div>
          <p>Activity is the application's landing screen: one reverse-chronological feed of everything recorded across the installation's projects—conversations started and answered, versions published and restored, conversations resolved and reopened, work sent to and answered by agents, public links enabled and disabled, and, for administrators, members and keys. Every entry comes from the immutable action log; nothing is inferred, and an actor the log never recorded is shown as unknown. A conversation is one entry that moves to the top when it is answered; long conversations fold to the opening comment and the newest replies. Consecutive publications by one actor on one artifact merge into one entry. The feed filters by project, type, and text, pages backwards, and separates what needs a person from what is with an agent.</p>
          <p>Projects lists every project, active before archived, with its unresolved conversations, artifact count, and latest activity, docked beside the selected project's identity, lifecycle, optional Git history, artifacts, and that project's activity. Navigation folders open it, and retired project-settings addresses lead to it.</p>
          <p>Installation administration is one console. A grouped area menu leads to Members, API keys, Public links, and MCP &amp; WebMCP; records open deep-linkable detail panes; every destructive action confirms first. Members show who admitted them and when they were last active, keys show their last use and who revoked them, and public links show when and by whom they were made public. Public-link view counts and link expiry are not recorded.</p>
        </section>
```

In the "extend" case, append only the second and third `<p>` elements.

- [ ] **Step 2: Record the porting notes**

Append to `docs/claude-design.md`:

```md
## Activity, Projects and Administration

The Activity feed, Projects screen and Admin console follow the ArkCase Artifacts
prototype at Design `e087280` (`arkcase-artifacts/project/App.dc.html`,
`workspace/projects/arkcase-artifacts/`). The vendored activity model and feed
come through `scripts/sync-arkcase-ds.mjs`; the server supplies every entry from
the action log (`GET /api/v1/activity`, `GET /api/v1/activity/summary`).

Where the prototype shows something the server cannot back, the control is
omitted rather than shown disabled:

- Project "Publishing defaults" and "Access and membership" panels — no project
  defaults or project membership exist; projects use installation membership.
- The MCP tool-group table — MCP tools are registered at runtime and no endpoint
  lists them. The WebMCP tool names are shown because the browser registers them.
- Public-link view counts and expiry, member role changes, a member's recent
  activity list, and the expiring-soon key pill.
- Web upload publishing — "Publish artifact" shows the `artifactserver publish`
  command.

Public links keep their accessible per-row selection, paging and partial-success
retry (ADM-005) inside the console instead of the prototype's single-row grid.
```

- [ ] **Step 3: Record what remains open**

In `NEXT-STEPS.md`:

1. Change the "Updated" line at the top to `Updated October 1, 2026.`.
2. Add one row at the end of the **Work order** table:

```md
| 11 | Activity, Projects and Admin console follow-ups | Record team-deployment browser evidence for ACT-005, ACT-006 and ADM-008; decide whether an MCP tool catalog endpoint should back a tool-group table. | Team deployment access; product decision for the catalog. | 1–3 days |
```

- [ ] **Step 4: Validate the ledger and the site**

Run: `pnpm conformance:validate && pnpm verify:site`

Expected: both exit 0. `conformance:validate` accepts every `#activity` anchor.

- [ ] **Step 5: Commit**

```bash
git add project/spec/artifact-server-product-spec.html docs/claude-design.md NEXT-STEPS.md
git commit -m "Describe Activity, Projects and the Admin console and record porting gaps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8.3: Final gates and evidence

**Files:**
- Modify: `project/spec/conformance.yml` (evidence, status and `proof_gap` for every requirement this work touched)
- Modify: `project/evidence/*.json` (regenerated by the gates; never hand-edited)

**Interfaces:**
- Consumes: every slice.
- Produces: green `pnpm verify:iteration` and `BROWSER_CRITICAL_ENGINES=all pnpm test:web`, and attached evidence.

- [ ] **Step 1: Install the browser engines once**

Run: `pnpm exec playwright install firefox webkit`

Expected: both engines are installed or already up to date.

- [ ] **Step 2: Run the cross-engine browser matrix**

Run: `BROWSER_CRITICAL_ENGINES=all pnpm test:web`

Expected: exit 0, and `project/evidence/browser.json` has `"success":true` and `"numFailedTests":0`. If it fails, keep the failed `browser.json`, fix the cause, and run again. Never edit the evidence file.

- [ ] **Step 3: Run the canonical gate**

Run: `pnpm verify:iteration`

Expected: exit 0. It runs check, the browser suite, the Pulumi tests, object storage, the external-storage runtime, coverage, the local package (including the updated `/projects` redirect), perf baseline and capacity, compose, helm and OIDC. Any failure is fixed at its cause before continuing. Do not lower a threshold or skip a stage.

- [ ] **Step 4: Attach browser evidence**

Print the run timestamp the ledger records:

```bash
node -e 'console.log(new Date(require("./project/evidence/browser.json").startTime).toISOString())'
```

For each of `ACT-005`, `ACT-006`, `ADM-002`, `ADM-003`, `ADM-004`, `ADM-005`, `ADM-006`, `ADM-008` and `NAV-001`:

1. Confirm that `project/evidence/browser.json` has a passed assertion whose `title` contains both its `-B` and `-F` IDs:

```bash
node -e 'const r=require("./project/evidence/browser.json");const t=r.testResults.flatMap(s=>s.assertionResults).filter(a=>a.status==="passed").map(a=>a.title).join("\n");for(const id of process.argv.slice(1)){for(const k of["B","F"]){const x=`${id}-${k}`;console.log(x,t.includes(x)?"pass":"MISSING")}}' ACT-005 ACT-006 ADM-002 ADM-003 ADM-004 ADM-005 ADM-006 ADM-008 NAV-001
```

   Expected: every line ends `pass`. A `MISSING` line means that requirement gets no new evidence; report it, and do not attach.

2. For each `pass` pair, set or replace its `local` evidence record:

```yaml
    evidence:
      - deployment: local
        tests: [ACT-006-B, ACT-006-F]
        result: pass
        run: project/evidence/browser.json
        recorded_at: "<the ISO timestamp printed above>"
```

3. Move `ACT-006` and `ADM-008` from `implementing` to `behavior_verified`, and set their `proof_gap` to:

   `Local Chromium browser evidence proves the behavior and failure cases; Firefox and WebKit cover only the critical-engine slice, and team deployments are not recorded.`

   Leave every other requirement's status as the evidence supports. A requirement whose only evidence is local stays `behavior_verified`, never `verified`.

The evidence for `ACT-001` to `ACT-004` and `ACT-007` was attached by slices 2–4. Refresh each one's `recorded_at` only if this run re-executed its named tests. Their evidence files are `project/evidence/local-foundation.json` or the file each slice named.

- [ ] **Step 5: Validate and commit the evidence**

Run: `pnpm conformance:validate && pnpm conformance:tests`

Expected: both exit 0.

```bash
git add project/spec/conformance.yml project/evidence
git commit -m "Attach fresh verification evidence for Activity, Projects and the Admin console

Recorded by pnpm verify:iteration and BROWSER_CRITICAL_ENGINES=all pnpm test:web.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Report what is still specified but not proved**

Run:

```bash
ruby -ryaml -e 'y=YAML.safe_load(File.read("project/spec/conformance.yml"),aliases:true); y["requirements"].select{|r| r["id"]=~/^(ACT|ADM|NAV)-/ && r["status"]!="verified"}.each{|r| puts "#{r["id"]} #{r["status"]}: #{r["proof_gap"]}"}'
```

Copy its output verbatim into the hand-off message. This follows `AGENTS.md` "Before handing off work".
