# Server-side Library — design

Date: 2026-10-05
Status: approved in conversation; awaiting written-spec review
Source: [PLAN.md step 1](../../../PLAN.md) and the hosted Library measurements in [FINDINGS](../../../project/performance/FINDINGS.md).

## Intent

Make the Library open fast. On artifacts.backend.app, the first Library tile appears 20–35 seconds after a cold open, after about 230 requests. The browser assembles the Library itself, and most of that time goes to dating each tile: in the October 5 hosted capture, 131 historical version-detail reads took 74 seconds of request time behind a four-wide limiter, plus version lists, preview indexes, and artifact details. No tile renders until every gallery is dated, because the default view groups and sorts by date.

### What the user decided

- Build an on-demand server endpoint (approach 1): one authorized request, dates computed in SQL, preview indexes cached per immutable version. No persistent projection table and no backfill.
- A persistent projection (PLAN.md's "rebuildable projection") stays the upgrade path if an installation grows to thousands of galleries.

### Success criteria

- Hosted cold Library-ready (first tile visible, measured by `pnpm perf:delivery`) under 2 seconds, against 33 s, 22 s, and 26 s in the October 5 hosted runs.
- The Library screen makes one Library request and no per-gallery version, manifest, preview-index, or comment reads.
- Every existing DSN-005 behavior is unchanged, and the new DSN-006 tests pass.

### Assumptions

- Today's scale is 11 artifacts, 154 versions, and about 400 previews. On-demand SQL is milliseconds at this size.
- `manifest_entries` holds every version's manifest rows in SQLite, Postgres, and D1, and D1 accepts the same SQL as SQLite, including window functions.

## Endpoint

`GET /api/v1/library`, authenticated like the other `/api/v1` routes.

It covers every artifact in every project the caller can read: the same set the browser assembles today from the caller's project list. An artifact contributes a gallery when its current version's manifest contains `artifact-server-previews/index.json`.

Response:

```ts
interface LibraryResponse {
  readonly galleries: readonly LibraryGallery[];
  /** Server time the response was assembled, ISO 8601. */
  readonly generatedAt: string;
  /** True when the artifact cap was reached; the Library shows a partial view. */
  readonly truncated: boolean;
  /** Artifacts whose preview index exists but cannot be read, by artifact name. */
  readonly unreadable: readonly string[];
}

interface LibraryGallery {
  readonly artifactId: string;
  readonly artifactName: string;
  readonly indexTitle: string;
  readonly items: readonly LibraryGalleryItem[];
  readonly projectId: string;
  readonly projectName: string;
  /** The current version when the response was assembled; tiles open this exact version. */
  readonly versionId: string;
}

interface LibraryGalleryItem {
  /** ISO 8601: the later of the page's last change and its newest comment or reply. */
  readonly activityAt: string;
  /** ISO 8601: when the first version listing the page was published. */
  readonly createdAt: string;
  readonly description: string;
  readonly kind: string;
  readonly path: string;
  readonly related: readonly {readonly path: string; readonly title: string}[];
  readonly section: string;
  readonly thumbnailPath: string | null;
  readonly title: string;
  readonly viewport: {readonly height: number; readonly width: number};
}
```

There is no pagination. The screen already groups, searches, and filters the full list in the browser. The endpoint examines at most 2,000 artifacts (today's loader reads 20 pages of 100) and sets `truncated` when it stops early.

## Server components

### `LibraryCatalogService`

An application service.

1. Authorize the principal and list the projects it can read, in the order the client's project list uses.
2. List each project's active artifacts and their current versions.
3. For each current version whose manifest contains the preview index entry:
   - read and parse the index blob with the server-side preview-index parser in `src/manifest/preview-index.ts`, validating item paths against the manifest exactly as the client does;
   - record the artifact as unreadable when the blob is missing, larger than the existing maximum preview-index size, or invalid.
4. Ask `LibraryDatesStore` for page dates for every readable gallery in one call.
5. Assemble the response.

### Parsed-index cache

Parsed preview indexes are cached in memory by version id in a bounded LRU of 1,000 versions. A version's bytes never change, so a cached entry never goes stale; only a newly current version costs a blob read.

### `LibraryDatesStore` port

```ts
interface LibraryDatesRequest {
  readonly artifactId: string;
  readonly currentVersionNumber: number;
  readonly paths: readonly string[];
}

/** Raw dates for one page; the service derives activity and applies the fallback. */
interface LibraryPageDates {
  readonly artifactId: string;
  readonly changedAt: string;
  readonly commentedAt: string | null;
  readonly createdAt: string;
  readonly path: string;
}

interface LibraryDatesStore {
  pageDates(requests: readonly LibraryDatesRequest[]): Promise<readonly LibraryPageDates[]>;
}
```

It is a `libraryPageDates` method on the SQLite, Postgres, and D1 artifact repositories. SQLite and D1 share their SQL text and take the requests as one JSON parameter, because D1 caps bound parameters.

## Date semantics

For each requested path, over the artifact's versions numbered up to its current version. These keep the meaning of today's client `galleryDates`, but use every version instead of a 40-version window, and every reply instead of the `updatedAt` approximation:

- **created**: the publication time of the first version whose manifest lists the path. A page removed and later re-added keeps its original creation.
- **changed**: the publication time of the latest version that lists the path where the path was absent from the immediately preceding version or had a different digest. Re-adding counts as a change, even with identical bytes.
- **activity**: the later of "changed" and the newest comment or reply on that path, in any of those versions. Whole-version comments (null path) belong to no page.
- **fallback**: a path that no considered manifest lists gets the current version's publication time for all three dates.

### SQL

One statement per concern, each covering every requested artifact:

1. Rank each artifact's versions by `number`, keeping those at or below the current number.
2. Join `manifest_entries` for the requested paths.
3. Over (artifact, path) ordered by rank, take `LAG(rank)` and `LAG(sha256)`. A row is a change when there is no previous row, the previous rank is not `rank - 1`, or the digest differs.
4. Aggregate the minimum publication time (created) and the maximum flagged publication time (changed).
5. A second aggregate returns the newest of thread `created_at` and reply `created_at` per (artifact, path), over threads on those versions.

Times are compared as the ISO 8601 strings they are stored as.

## Client

- `useDesignLibrary` replaces its fan-out with one `api.library()` call and maps each gallery into the existing `LibrarySource` shape. Dates are parsed to epoch milliseconds, and `unreadable` maps to today's failure list.
- The screen, grouping, search, filters, view-state memory, exact-version tile links, thumbnails (through the existing `media` route), Refresh, and back navigation are unchanged.
- `page-dates.ts` stays: an artifact's own gallery view still dates the version being viewed.

## Failure handling

- **An unreadable index** (missing blob, oversized, or invalid) names that artifact in `unreadable`; the rest of the Library loads.
- **A database or storage error** fails the request with the standard error shape. The screen shows its existing failure state and Refresh.
- **Authorization runs before any read.** Project access in this product is installation-wide: a principal that may list artifacts reads every project in its installation, as the artifact list does today. A principal without `artifact:read` (and not a direct human) is refused before any read, and another installation's projects never appear because every repository query is installation-scoped.

## Conformance

DSN-005 keeps its wording. Add DSN-006 after it:

```yaml
  - id: DSN-006
    kind: behavior
    behavior: The Library is assembled by one authorized server request that returns every readable gallery with page dates computed from full version and comment history.
    owner: web-application
    source: {file: artifact-server-product-spec.html, anchor: claude-design-exports}
    acceptance:
      behavior: {id: DSN-006-B, description: "One Library request returns galleries from several projects with dates equal to the reference algorithm over full history, and the Library screen issues no per-gallery version, manifest, index, or comment reads."}
      failure: {id: DSN-006-F, description: "An artifact with a missing or invalid preview index is named as unreadable while the rest load; a caller without artifact read capability is refused and learns nothing; an unauthenticated request is rejected."}
    deployments: *all
    status: implementing
    proof_gap: Team-deployment conformance runs are unrecorded.
    depends_on: [DSN-005]
    evidence: []
```

Add one sentence to the product spec's Claude Design exports section: the Library is assembled on the server in one request.

## Tests

All tests use real servers and databases and no module mocks.

- **Equivalence:** randomized version histories published through a real server, with additions, removals, re-adds, digest changes, and comments with replies. The endpoint's dates must equal the client's pure `galleryDates`, run on the same records with an unlimited history window and exact reply times.
- **DSN-006-B:** one request returns galleries from two projects with correct dates, kinds, thumbnail paths, and current version ids. In the browser, the Library screen issues exactly one `/api/v1/library` request and no per-gallery reads.
- **DSN-006-F:** a missing or invalid index is named in `unreadable`; a caller without `artifact:read` gets 403 and no artifact names; an unauthenticated request gets 401.
- **Postgres:** the dates query in the Docker Postgres suite.
- **D1:** the dates query in `check:cloudflare`.
- **Regression:** the existing DSN-005-B browser journey passes unchanged.

## Evidence and rollout

1. Local `pnpm perf:delivery` before and after.
2. `pnpm smoke` and `pnpm verify:iteration`.
3. **Stop for the user's explicit deploy approval.** There is no migration, so a plain image rollback works.
4. Hosted `pnpm perf:delivery` after, compared with the October 5 hosted Library runs. Update FINDINGS.

## Out of scope

- A persistent preview projection and cursor pagination.
- Views and scenarios (PLAN.md step 3).
- Any visual change to the Library.
- Changes to the artifact gallery view's own dating.
