# Server-side Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the browser's ~230-request Library assembly with one authorized `GET /api/v1/library` request whose page dates come from SQL over full version and comment history.

**Architecture:**
- A `LibraryCatalogService` (an Effect `Context.Service`, like `ActivityService`) authorizes the caller, lists projects and artifacts, and reads each current version's preview index through a server-side parser that matches the client's.
- It caches parsed indexes per immutable version id and asks a new repository method, `libraryPageDates`, for dates.
- That method is one JSON-parameterized query pair, implemented for SQLite and D1 (shared SQL text) and for Postgres.
- The web client replaces its fan-out with one call and keeps its screen unchanged.

**Tech Stack:** TypeScript, Hono, Effect services, node:sqlite, D1 (wrangler platform proxy in tests), Postgres via Effect SQL, Zod, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-05-server-side-library-design.md`

## Global Constraints

- **Branch and staging:** work on `main` in the shared checkout; another agent commits `NEXT.md` on `main`. Never switch branches, never stage `NEXT.md`, and stage only exact paths.
- **Outward actions:** never push, build images, or touch `~/Workspace` without the user's explicit approval at Task 8.
- **Tests:** no module mocks; use real servers, temporary SQLite, Docker Postgres, and the wrangler D1 proxy.
- **Conformance IDs:** `DSN-006-B` appears in exactly one test title (the browser spec), and so does `DSN-006-F` (the HTTP test). Other new tests start with `foundation:`.
- **Lint rules** (strict oxlint, as before):
  - no inline object types on function parameters, no runtime `typeof`, no `Record<string, unknown>`, no unsafe or chained type assertions, no `unknown` parameters, no floating promises;
  - use `toSorted()` and bracket access for index signatures;
  - mark an intentionally sequential `await` in a loop with `// eslint-disable-next-line no-await-in-loop -- <reason>`.
- **Endpoint and data rules:**
  - the endpoint examines at most 2,000 artifacts and sets `truncated`;
  - the parsed-index cache holds 1,000 versions;
  - the preview index is at most 1,048,576 bytes;
  - the index path is `artifact-server-previews/index.json`.
- **Date semantics are the spec's:** created, changed, activity, and the fallback to the current version's time.
- **Projects:** the Library covers every project `listProjects()` returns, archived ones included, as the client does today.
- **Commit messages** end with:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01K5hnfZ71nzDtacBUUqoY2c
  ```

## Review Focus

1. **A page removed in one version and re-added later with identical bytes.** "Created" stays the original publication; "changed" moves to the re-add. The test is in Task 3.
2. **A comment on a page in an older version, where a newer version no longer lists that page.** The comment does not raise any current tile's activity, because no current tile has that path. The test is in Task 3.
3. **An artifact whose current pointer was moved back to an older version.** Versions numbered above the current one are ignored. The test is in Task 3.
4. **A gallery whose index names a thumbnail of the wrong media type.** The tile keeps working with no thumbnail, exactly as the client parser behaves. The test is in Task 2.
5. **A caller without `artifact:read`.** It gets 403 and learns nothing; an unauthenticated caller gets 401. The test is in Task 5 (DSN-006-F).

---

## File map

| File | Responsibility |
|---|---|
| `src/manifest/preview-index-reader.ts` (new) | Server parser for a version's preview index, matching `apps/web/src/review/workspace/design-gallery.ts` |
| `src/core/library.ts` (new) | Library response types, `LibraryDatesRequest`, `LibraryPageDates`, `LibraryDatesStore` |
| `src/storage/library-dates-sqlite.ts` (new) | SQL text shared by SQLite and D1, plus the result merge |
| `src/storage/sqlite-artifact-repository.ts`, `src/storage/postgres-artifact-repository.ts`, `deploy/cloudflare/src/d1-artifact-repository.ts` (modify) | `libraryPageDates` |
| `src/application/library-catalog.ts` (new) | `LibraryCatalogService` |
| `src/local/create-local-application-layer.ts` (modify) | Repository type gains `LibraryDatesStore`; service layer wiring |
| `src/http/create-http-app.ts` (modify) | `GET /api/v1/library` |
| `apps/web/src/api/client.ts`, `apps/web/src/review/library/use-design-library.ts` (modify) | One call, mapped into `LibrarySource` |
| Tests (new) | `tests/manifest/preview-index-reader.test.ts`, `tests/storage/sqlite-library-dates.test.ts`, `tests/integration/postgres-library-dates.test.ts`, `deploy/cloudflare/tests/d1-library-dates.test.ts`, `tests/http/library-catalog.test.ts`, and a new test in `tests/browser/design-library.spec.ts` |

---

### Task 1: Local "before" Library run

**Files:** Create: `project/evidence/delivery-baseline-<date>-local-before-library.json` (generated)

- [ ] **Step 1:** Run `pnpm build && pnpm perf:delivery --label before-library`.
  Expected: four journeys, `Timeouts` 0.
- [ ] **Step 2:** Run the privacy grep:

  ```bash
  grep -n -i -E 'cookie|authorization|bearer|__artifact_bootstrap|review-[a-z0-9_-]{20,}|frontend\.app|token' project/evidence/delivery-baseline-*.json || echo clean
  ```

  Expected: `clean`.
- [ ] **Step 3:** Commit `project/evidence/delivery-baseline-*-local-before-library.json` with the message "Record the local Library baseline before the server-side Library".

---

### Task 2: Server preview-index reader

**Files:**
- Create: `src/manifest/preview-index-reader.ts`
- Test: `tests/manifest/preview-index-reader.test.ts`

**Interfaces:**
- Produces:
  - `maximumPreviewIndexBytes = 1_048_576`
  - `interface LibraryPreviewItem { description: string; kind: string; path: string; related: readonly LibraryRelatedLink[]; section: string; thumbnailPath: string | null; title: string; viewport: LibraryViewport }`
  - `type PreviewIndexReading = {status: "ready"; title: string; items: readonly LibraryPreviewItem[]} | {status: "invalid"; reason: string}`
  - `readPreviewIndex(text: string, entries: readonly ManifestEntry[]): PreviewIndexReading`

  Also export `LibraryRelatedLink {path: string; title: string}` and `LibraryViewport {height: number; width: number}`.

- [ ] **Step 1: Write the failing parity test**

Create `tests/manifest/preview-index-reader.test.ts`:

```ts
import {describe, expect, test} from "vitest";

import {parsePreviewIndex} from "../../apps/web/src/review/workspace/design-gallery.ts";
import type {ManifestEntry} from "../../src/core/model.js";
import {readPreviewIndex} from "../../src/manifest/preview-index-reader.js";

function entry(path: string, mediaType: string): ManifestEntry {
  return {disposition: "inline", mediaType, path, sha256: "a".repeat(64), size: 10};
}

const entries: readonly ManifestEntry[] = [
  entry("project/App.html", "text/html; charset=utf-8"),
  entry("project/Other.html", "text/html"),
  entry("project/thumb.png", "image/png"),
  entry("project/guide.md", "text/markdown"),
  entry("artifact-server-previews/index.json", "application/json"),
];

const item = {
  description: "",
  kind: "prototype",
  path: "project/App.html",
  section: "Prototypes",
  thumbnail: {mediaType: "image/png", path: "project/thumb.png"},
  title: "App",
  viewport: {height: 900, width: 1440},
};

const cases: readonly {readonly name: string; readonly text: string}[] = [
  {name: "valid version 2", text: JSON.stringify({cover: null, description: "", format: "artifact-server.preview-index", items: [{...item, related: [{path: "project/guide.md", title: "Guide"}, {path: "missing.md", title: "Gone"}]}], origin: "producer", title: "Gallery", version: 2})},
  {name: "valid version 1", text: JSON.stringify({cover: null, description: "", format: "artifact-server.preview-index", items: [item], origin: "producer", title: "Gallery", version: 1})},
  {name: "wrong thumbnail type", text: JSON.stringify({cover: null, description: "", format: "artifact-server.preview-index", items: [{...item, related: [], thumbnail: {mediaType: "image/webp", path: "project/thumb.png"}}], origin: "producer", title: "Gallery", version: 2})},
  {name: "non-HTML page", text: JSON.stringify({cover: null, description: "", format: "artifact-server.preview-index", items: [{...item, path: "project/guide.md", related: []}], origin: "producer", title: "Gallery", version: 2})},
  {name: "duplicate page", text: JSON.stringify({cover: null, description: "", format: "artifact-server.preview-index", items: [{...item, related: []}, {...item, related: []}], origin: "producer", title: "Gallery", version: 2})},
  {name: "unsupported version", text: JSON.stringify({format: "artifact-server.preview-index", version: 3})},
  {name: "not JSON", text: "{nope"},
];

describe("server preview-index reader", () => {
  test.each(cases)("foundation: matches the client parser for $name", ({text}) => {
    const client = parsePreviewIndex(text, entries);
    const server = readPreviewIndex(text, entries);
    expect(server.status).toBe(client.status);
    if (client.status === "ready" && server.status === "ready") {
      expect(server.title).toBe(client.title);
      expect(server.items).toEqual(client.items);
    }
  });
});
```

If importing the client module from a root test fails on its `@/` alias, check that `design-gallery.ts` uses `@/` only in `import type` statements. Esbuild erases those. If a runtime `@/` import exists, add the alias to the root `vitest.config.ts` as `resolve.alias` pointing `@` at `apps/web/src`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/manifest/preview-index-reader.test.ts`
Expected: FAIL, because `preview-index-reader.js` cannot be resolved.

- [ ] **Step 3: Port the parser**

Create `src/manifest/preview-index-reader.ts` by porting `parsePreviewIndex` and its schemas from `apps/web/src/review/workspace/design-gallery.ts` (lines 1–60 and 103–165):
- Keep the same Zod schemas, kinds list, image types, label and description rules, version 1/2 union, header check, error messages, HTML-entry and duplicate rejection, thumbnail resolution, and `usableLinks`.
- Return `{status: "ready", title, items}` with items shaped as `LibraryPreviewItem`, which is the client's `GalleryIndexItem`.
- Replace `mediaTypeEssence` with a local function: `mediaType.split(";")[0]?.trim().toLowerCase() ?? ""`. Read `apps/web/src/review/workspace/page-inventory.ts` to confirm it is equivalent and copy its exact behavior if not.
- Add `/** Mirrors apps/web/src/review/workspace/design-gallery.ts parsePreviewIndex; tests/manifest/preview-index-reader.test.ts proves parity. */` above `readPreviewIndex`.

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run tests/manifest/preview-index-reader.test.ts`
Expected: PASS, 7 cases.

- [ ] **Step 5: Lint and commit**

Run: `pnpm exec oxlint --type-aware --type-check --deny-warnings src/manifest tests/manifest`
Commit both files with the message "Add a server reader for preview indexes that matches the client".

---

### Task 3: Library dates for SQLite (and the shared SQL)

**Files:**
- Create: `src/core/library.ts`
- Create: `src/storage/library-dates-sqlite.ts`
- Modify: `src/storage/sqlite-artifact-repository.ts` (add `libraryPageDates`)
- Test: `tests/storage/sqlite-library-dates.test.ts`

**Interfaces:**
- Produces in `src/core/library.ts`:

```ts
/** One artifact's current version and the preview paths to date. */
export interface LibraryDatesRequest {
  readonly artifactId: string;
  readonly currentVersionNumber: number;
  readonly paths: readonly string[];
}

/** Raw dates for one page; the service derives activity and applies the fallback. */
export interface LibraryPageDates {
  readonly artifactId: string;
  readonly changedAt: string;
  readonly commentedAt: string | null;
  readonly createdAt: string;
  readonly path: string;
}

/** Computes page dates from version and comment history. */
export interface LibraryDatesStore {
  libraryPageDates(requests: readonly LibraryDatesRequest[]): Promise<readonly LibraryPageDates[]>;
}
```

- Produces in `src/storage/library-dates-sqlite.ts`: `sqliteLibraryManifestDatesSql: string`, `sqliteLibraryCommentDatesSql: string`, and `mergeLibraryDates(manifestRows: readonly LibraryManifestRow[], commentRows: readonly LibraryCommentRow[]): LibraryPageDates[]`, with row interfaces `LibraryManifestRow {artifactId; path; createdAt; changedAt}` and `LibraryCommentRow {artifactId; path; commentedAt}`.

- [ ] **Step 1: Write the failing test**

Create `tests/storage/sqlite-library-dates.test.ts`. It publishes through a real local server, writes comments through the HTTP API, then reads dates from the repository opened on the same database:

```ts
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {ApiClient} from "../support/agent-dispatch.js";
import {
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";

const encoder = new TextEncoder();
const versionSchema = z.object({version: z.object({createdAt: z.string(), id: z.string(), number: z.number()})});
const threadSchema = z.object({thread: z.object({createdAt: z.string(), id: z.string()})});
const replySchema = z.object({reply: z.object({createdAt: z.string()})});

function page(pathName: string, body: string): TestSiteFile {
  return {bytes: encoder.encode(`<!doctype html><title>${body}</title>`), mediaType: "text/html", path: pathName};
}

describe("SQLite library dates", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let scratch: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    scratch = await mkdtemp(path.join(tmpdir(), "library-dates-"));
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
    await rm(scratch, {force: true, recursive: true});
  });

  async function publish(
    key: string,
    files: readonly TestSiteFile[],
    previous: PublishResponse | null,
  ): Promise<PublishResponse> {
    const upload = await createStagedUpload(server, installation, files[0]?.path ?? "a.html", files);
    await uploadEveryStagedFile(installation, upload.body, files);
    const target = previous === null
      ? {accessSetting: "account_required", kind: "new_artifact", name: "Dated gallery", tags: []} as const
      : {artifactId: previous.artifact.id, expectedCurrentVersionId: previous.version.id, kind: "new_version"} as const;
    const committed = await commitStagedUpload(installation, upload.body, key, target);
    expect(committed.response.status).toBe(201);
    return committed.body;
  }

  test("foundation: SQLite page dates follow creation, change, re-add, comments, and the current pointer", async () => {
    const owner = new ApiClient(server, installation.apiToken);
    const v1 = await publish("library-dates-version-one", [page("a.html", "a1"), page("b.html", "b1"), page("c.html", "c1")], null);
    const v2 = await publish("library-dates-version-two", [page("a.html", "a1"), page("b.html", "b2")], v1);
    const v3 = await publish("library-dates-version-three", [page("a.html", "a1"), page("b.html", "b2"), page("c.html", "c1")], v2);
    const versionTime = async (published: PublishResponse) => versionSchema.parse(await (await owner.fetch(
      `/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}?projectId=${published.artifact.projectId}`,
    )).json()).version.createdAt;
    const [t1, t2, t3] = [await versionTime(v1), await versionTime(v2), await versionTime(v3)];

    const commentsPath = `/api/v1/artifacts/${v1.artifact.id}/comments?projectId=${v1.artifact.projectId}`;
    const threadResponse = await owner.fetch(commentsPath, {
      body: JSON.stringify({body: "On a.", path: "a.html", versionId: v1.version.id}),
      idempotencyKey: "library-dates-thread-on-a",
      method: "POST",
    });
    expect(threadResponse.status).toBe(201);
    const thread = threadSchema.parse(await threadResponse.json()).thread;
    const replyResponse = await owner.fetch(
      `/api/v1/artifacts/${v1.artifact.id}/comments/${thread.id}/replies?projectId=${v1.artifact.projectId}`,
      {body: JSON.stringify({body: "Reply."}), idempotencyKey: "library-dates-reply-on-a", method: "POST"},
    );
    expect(replyResponse.status).toBe(201);
    const replyAt = replySchema.parse(await replyResponse.json()).reply.createdAt;

    const repository = new SqliteArtifactRepository(path.join(installation.dataDirectory, "artifact-server.db"), "local");
    try {
      const dates = await repository.libraryPageDates([
        {artifactId: v1.artifact.id, currentVersionNumber: 3, paths: ["a.html", "b.html", "c.html", "never.html"]},
      ]);
      const byPath = new Map(dates.map((row) => [row.path, row]));
      expect(byPath.get("a.html")).toMatchObject({changedAt: t1, commentedAt: replyAt, createdAt: t1});
      expect(byPath.get("b.html")).toMatchObject({changedAt: t2, commentedAt: null, createdAt: t1});
      // Removed in version 2 and re-added in version 3 with identical bytes: creation stays, change moves.
      expect(byPath.get("c.html")).toMatchObject({changedAt: t3, commentedAt: null, createdAt: t1});
      expect(byPath.has("never.html")).toBe(false);

      // A current pointer moved back to version 2 ignores version 3.
      const atTwo = await repository.libraryPageDates([
        {artifactId: v1.artifact.id, currentVersionNumber: 2, paths: ["c.html"]},
      ]);
      expect(atTwo[0]).toMatchObject({changedAt: t1, createdAt: t1});
    } finally {
      repository.close();
    }
  });
});
```

Check the comment and reply routes against `src/http/create-http-app.ts` (`/api/v1/artifacts/:artifactId/comments` and its replies route) and the response shapes. Adjust the URLs and schemas to the real ones; don't change the assertions. Also add the review-focus case: a comment on `c.html` in version 1 must not count for a version-2 current pointer when version 2 doesn't list `c.html`. The second assertion block already omits `c.html` comments; add a thread on `c.html` before it and assert `atTwo` is empty for paths version 2 doesn't list.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/storage/sqlite-library-dates.test.ts`
Expected: FAIL, because `libraryPageDates` is not a function.

- [ ] **Step 3: Core types and the shared SQL**

Create `src/core/library.ts` with the Interfaces block above.

Create `src/storage/library-dates-sqlite.ts`:

```ts
import type {LibraryPageDates} from "../core/library.js";

/**
 * Page created/changed times over each artifact's versions up to its current one.
 * ?1 is a JSON array of {artifactId, currentNumber, paths}. A row counts as a change
 * when the path is new, was absent from the previous version, or its digest differs.
 * SQLite and D1 share this text; D1 caps bound parameters, hence one JSON parameter.
 */
export const sqliteLibraryManifestDatesSql = `
  WITH requested AS (
    SELECT json_extract(value, '$.artifactId') AS artifact_id,
           json_extract(value, '$.currentNumber') AS current_number,
           json_extract(value, '$.paths') AS paths
    FROM json_each(?1)
  ),
  wanted AS (
    SELECT requested.artifact_id AS artifact_id, wanted_path.value AS path
    FROM requested, json_each(requested.paths) AS wanted_path
  ),
  ranked AS (
    SELECT version.id AS id, version.artifact_id AS artifact_id, version.created_at AS created_at,
           ROW_NUMBER() OVER (PARTITION BY version.artifact_id ORDER BY version.number) AS rank
    FROM versions AS version
    JOIN requested ON requested.artifact_id = version.artifact_id
    WHERE version.number <= requested.current_number
  ),
  present AS (
    SELECT ranked.artifact_id AS artifact_id, entry.path AS path, ranked.rank AS rank,
           ranked.created_at AS created_at, entry.sha256 AS sha256
    FROM ranked
    JOIN manifest_entries AS entry ON entry.version_id = ranked.id
    JOIN wanted ON wanted.artifact_id = ranked.artifact_id AND wanted.path = entry.path
  ),
  flagged AS (
    SELECT artifact_id, path, created_at,
           CASE WHEN LAG(rank) OVER page IS NULL
                  OR LAG(rank) OVER page <> rank - 1
                  OR LAG(sha256) OVER page <> sha256
                THEN 1 ELSE 0 END AS changed
    FROM present
    WINDOW page AS (PARTITION BY artifact_id, path ORDER BY rank)
  )
  SELECT artifact_id AS artifactId, path,
         MIN(created_at) AS createdAt,
         MAX(CASE WHEN changed = 1 THEN created_at END) AS changedAt
  FROM flagged
  GROUP BY artifact_id, path
`;

/** The newest thread or reply time per page, over threads on the considered versions. */
export const sqliteLibraryCommentDatesSql = `
  WITH requested AS (
    SELECT json_extract(value, '$.artifactId') AS artifact_id,
           json_extract(value, '$.currentNumber') AS current_number,
           json_extract(value, '$.paths') AS paths
    FROM json_each(?1)
  ),
  wanted AS (
    SELECT requested.artifact_id AS artifact_id, wanted_path.value AS path
    FROM requested, json_each(requested.paths) AS wanted_path
  ),
  threads AS (
    SELECT thread.id AS id, thread.artifact_id AS artifact_id, thread.path AS path, thread.created_at AS created_at
    FROM comment_threads AS thread
    JOIN versions AS version ON version.id = thread.version_id
    JOIN requested ON requested.artifact_id = thread.artifact_id
    JOIN wanted ON wanted.artifact_id = thread.artifact_id AND wanted.path = thread.path
    WHERE version.number <= requested.current_number
  ),
  times AS (
    SELECT artifact_id, path, created_at AS at FROM threads
    UNION ALL
    SELECT threads.artifact_id, threads.path, reply.created_at
    FROM comment_replies AS reply JOIN threads ON threads.id = reply.thread_id
  )
  SELECT artifact_id AS artifactId, path, MAX(at) AS commentedAt
  FROM times
  GROUP BY artifact_id, path
`;

export interface LibraryManifestRow {
  readonly artifactId: string;
  readonly changedAt: string;
  readonly createdAt: string;
  readonly path: string;
}

export interface LibraryCommentRow {
  readonly artifactId: string;
  readonly commentedAt: string;
  readonly path: string;
}

/** Join comment activity onto the pages the manifests date. */
export function mergeLibraryDates(
  manifestRows: readonly LibraryManifestRow[],
  commentRows: readonly LibraryCommentRow[],
): LibraryPageDates[] {
  const comments = new Map(commentRows.map((row) => [`${row.artifactId}\u001f${row.path}`, row.commentedAt]));
  return manifestRows.map((row) => ({
    artifactId: row.artifactId,
    changedAt: row.changedAt,
    commentedAt: comments.get(`${row.artifactId}\u001f${row.path}`) ?? null,
    createdAt: row.createdAt,
    path: row.path,
  }));
}

/** The JSON parameter both queries take. */
export function libraryDatesParameter(
  requests: readonly {readonly artifactId: string; readonly currentVersionNumber: number; readonly paths: readonly string[]}[],
): string {
  return JSON.stringify(requests.map((request) => ({
    artifactId: request.artifactId,
    currentNumber: request.currentVersionNumber,
    paths: request.paths,
  })));
}
```

If the anti-slop rule rejects the inline element type in `libraryDatesParameter`, type the parameter as `readonly LibraryDatesRequest[]` imported from `../core/library.js`.

In `src/storage/sqlite-artifact-repository.ts`, add `LibraryDatesStore` to the class's `implements` list and add:

```ts
  libraryPageDates(requests: readonly LibraryDatesRequest[]): Promise<readonly LibraryPageDates[]> {
    if (requests.length === 0) return Promise.resolve([]);
    const parameter = libraryDatesParameter(requests);
    const manifestRows = z.array(z.object({
      artifactId: z.string(),
      changedAt: z.string(),
      createdAt: z.string(),
      path: z.string(),
    })).parse(this.#database.prepare(sqliteLibraryManifestDatesSql).all(parameter));
    const commentRows = z.array(z.object({
      artifactId: z.string(),
      commentedAt: z.string(),
      path: z.string(),
    })).parse(this.#database.prepare(sqliteLibraryCommentDatesSql).all(parameter));
    return Promise.resolve(mergeLibraryDates(manifestRows, commentRows));
  }
```

Confirm the SQLite `versions` columns are `id`, `artifact_id`, `number`, and `created_at`, and the comment tables' columns as used. Adjust names only.

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run tests/storage/sqlite-library-dates.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

Run: `pnpm exec oxlint --type-aware --type-check --deny-warnings src/core src/storage tests/storage`
Commit the four files with the message "Compute Library page dates in SQL for SQLite".

---

### Task 4: Library dates for Postgres and D1

**Files:**
- Modify: `src/storage/postgres-artifact-repository.ts` (add `libraryPageDates`)
- Modify: `deploy/cloudflare/src/d1-artifact-repository.ts` (add `libraryPageDates` to the returned object and its type)
- Test: `tests/integration/postgres-library-dates.test.ts` (add it to `tests/configs/vitest.external-storage.config.ts`)
- Test: `deploy/cloudflare/tests/d1-library-dates.test.ts`

**Interfaces:**
- Consumes: `LibraryDatesRequest`, `LibraryPageDates` (Task 3); `sqliteLibraryManifestDatesSql`, `sqliteLibraryCommentDatesSql`, `mergeLibraryDates`, `libraryDatesParameter` (Task 3).

- [ ] **Step 1: Write the failing tests**

Postgres: create `tests/integration/postgres-library-dates.test.ts`. Use the scratch-database lifecycle from `tests/integration/postgres-version-pagination.test.ts` and its `stagedUploadCommand`, `manifestFixture`, and commit helpers (copy them into this file). Then:
1. Commit three versions of one artifact:
   - v1 lists `a.html`, `b.html`, `c.html`;
   - v2 lists `a.html` and `b.html` with new bytes for `b.html`;
   - v3 lists all three, with `c.html` identical to v1.
2. Create one thread on `a.html` at v1 with `repository.createThread` and one reply with `repository.createReply`, using fixed `createdAt` values later than the versions.
3. Assert that `repository.libraryPageDates([{artifactId, currentVersionNumber: 3, paths: ["a.html", "b.html", "c.html"]}])` gives:
   - `a.html`: created v1, changed v1, commented at the reply time;
   - `b.html`: created v1, changed v2;
   - `c.html`: created v1, changed v3.
4. Assert that a second installation's repository on the same database returns `[]` for the same request.

Name the test `foundation: Postgres page dates follow creation, change, re-add, and comments within one installation`.

D1: create `deploy/cloudflare/tests/d1-library-dates.test.ts` using `openLocalD1`, `migrateD1`, and the staging and commit helpers from `deploy/cloudflare/tests/d1-version-pagination.test.ts` (copy them). Seed the same three-version scenario without comments, and assert the same created and changed times. Name it `foundation: D1 page dates follow creation, change, and re-add`.

Use the exact `CreateCommentThread` and `CreateCommentReply` fields from `src/core/ports.ts:364-446`.

- [ ] **Step 2: Run them to verify they fail**

Run:

```bash
bash scripts/with-external-storage-test-providers.sh pnpm exec vitest run --config tests/configs/vitest.external-storage.config.ts tests/integration/postgres-library-dates.test.ts
pnpm --dir deploy/cloudflare exec vitest run tests/d1-library-dates.test.ts
```

Expected: both FAIL, because `libraryPageDates` is not a function.

- [ ] **Step 3: Implement Postgres**

In `PostgresArtifactRepository`, add `libraryPageDates`. It runs two statements through the class's existing `#database.run(Effect.gen(...))` pattern:

```sql
WITH requested AS (
  SELECT requested.artifact_id, requested.current_number, requested.paths
  FROM jsonb_to_recordset($1::jsonb) AS requested(artifact_id text, current_number int, paths jsonb)
),
wanted AS (
  SELECT requested.artifact_id, wanted_path AS path
  FROM requested, jsonb_array_elements_text(requested.paths) AS wanted_path
),
ranked AS (
  SELECT version.id, version.artifact_id, version.created_at,
         ROW_NUMBER() OVER (PARTITION BY version.artifact_id ORDER BY version.number) AS rank
  FROM versions AS version
  JOIN requested ON requested.artifact_id = version.artifact_id
  WHERE version.installation_id = $2 AND version.number <= requested.current_number
),
present AS (
  SELECT ranked.artifact_id, entry.path, ranked.rank, ranked.created_at, entry.sha256
  FROM ranked
  JOIN manifest_entries AS entry ON entry.installation_id = $2 AND entry.version_id = ranked.id
  JOIN wanted ON wanted.artifact_id = ranked.artifact_id AND wanted.path = entry.path
),
flagged AS (
  SELECT artifact_id, path, created_at,
         CASE WHEN LAG(rank) OVER page IS NULL
                OR LAG(rank) OVER page <> rank - 1
                OR LAG(sha256) OVER page <> sha256
              THEN 1 ELSE 0 END AS changed
  FROM present
  WINDOW page AS (PARTITION BY artifact_id, path ORDER BY rank)
)
SELECT artifact_id AS "artifactId", path, MIN(created_at) AS "createdAt",
       MAX(CASE WHEN changed = 1 THEN created_at END) AS "changedAt"
FROM flagged GROUP BY artifact_id, path
```

The comment statement is the SQLite one translated the same way:
- `jsonb_to_recordset($1::jsonb)` and `jsonb_array_elements_text` replace `json_each`;
- `thread.installation_id = $2` and `version.installation_id = $2` filters are added;
- quoted camel-case aliases are used.

Bind `libraryDatesParameter(requests)` and the repository's installation id. Parse rows with the same Zod schemas as SQLite and return `mergeLibraryDates(...)`. Confirm that `versions`, `comment_threads`, and `comment_replies` carry `installation_id` in `src/storage/postgres-migrations.ts`; drop a filter only where the column doesn't exist and the join is already scoped.

- [ ] **Step 4: Implement D1**

In `deploy/cloudflare/src/d1-artifact-repository.ts`, add to the returned repository:

```ts
    libraryPageDates: async (requests) => {
      if (requests.length === 0) return [];
      const parameter = libraryDatesParameter(requests);
      const [manifest, comments] = await Promise.all([
        database.prepare(sqliteLibraryManifestDatesSql).bind(parameter).all(),
        database.prepare(sqliteLibraryCommentDatesSql).bind(parameter).all(),
      ]);
      return mergeLibraryDates(
        manifestRowsSchema.parse(manifest.results),
        commentRowsSchema.parse(comments.results),
      );
    },
```

Define `manifestRowsSchema` and `commentRowsSchema` as Zod schemas matching Task 3's. Import the SQL module with a `../../../src/storage/library-dates-sqlite.js` path, as the file already imports from `src`. D1 tables are installation-scoped through the database binding; if D1 tables carry `installation_id`, filter on it the way neighbouring queries do.

- [ ] **Step 5: Run the tests**

Run the two commands from Step 2.
Expected: both PASS.

- [ ] **Step 6: Lint, typecheck, commit**

Run: `pnpm exec oxlint --type-aware --type-check --deny-warnings src/storage tests/integration && pnpm check:cloudflare > "$TMPDIR/library-cf.log" 2>&1; echo $?`
Expected: exit 0.

Commit the four source and test files and the config change with the message "Compute Library page dates in SQL for Postgres and D1".

---

### Task 5: `LibraryCatalogService` and `GET /api/v1/library` (DSN-006-F)

**Files:**
- Create: `src/application/library-catalog.ts`
- Modify: `src/core/library.ts` (response types)
- Modify: `src/local/create-local-application-layer.ts` (repository type adds `LibraryDatesStore`; build and merge the service layer)
- Modify: `src/http/create-http-app.ts` (route)
- Test: `tests/http/library-catalog.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces in `src/core/library.ts`: `LibraryResponse`, `LibraryGallery`, and `LibraryGalleryItem` exactly as in the spec's Endpoint section. Items reuse `LibraryPreviewItem` fields plus `createdAt` and `activityAt` ISO strings.
- Produces: `class LibraryCatalogService extends Context.Service<LibraryCatalogService, {readonly read: (principal: Principal) => Effect.Effect<LibraryResponse, LibraryCatalogFailure>}>`, constructed by `LibraryCatalogService.layer(dependencies: LibraryCatalogDependencies)`.
- Produces: `interface LibraryCatalogDependencies`:
  - `findVersionRecord(projectId, artifactId, versionId)`, `listArtifacts(command)`, `listProjects()`, and `pageDates(requests)`, each returning an `Effect` that fails with `ArtifactRepositoryFailure`;
  - `readBlobText(sha256, maximumBytes): Effect<string | null, BlobStorageFailure>`, which returns null when the blob is missing or larger than the limit.

- [ ] **Step 1: Write the failing tests**

Create `tests/http/library-catalog.test.ts`. Reuse the staged `publish` helper pattern from Task 3's test, and the `previewSourceFixture`/`writePreviewSourceFixture` gallery fixtures in `tests/support/claude-design-fixture.ts` through `publishPath`, as `tests/browser/design-library.spec.ts:18-24` does. Use `ApiClient`, `signInAdministrator`, and `issueApiKey` from `tests/support/agent-dispatch.ts`. Include these tests:
1. `foundation: one Library request returns every readable gallery with exact versions and dates`:
   - publish two galleries in two projects, using `owner.createProject` as `design-library.spec.ts` does, plus one plain site with no index;
   - `GET /api/v1/library` returns two galleries sorted by project then artifact name;
   - each has the current `versionId`, `indexTitle`, items with kinds, paths, thumbnail paths, and ISO `createdAt`/`activityAt`;
   - the plain site is absent;
   - `unreadable` is empty and `truncated` is false.
2. `foundation: Library dates equal the client reference over random histories`:
   - for 3 seeds, publish an artifact with 5–8 versions whose page sets and contents vary pseudo-randomly (seeded, as in `project/performance/delivery/synthetic-prototype.ts`), always including the preview index;
   - add 0–3 threads and replies on random pages and versions;
   - read every version's manifest through `GET /api/v1/artifacts/:id/versions/:versionId`, and every thread and reply through the comments API;
   - compute the reference with `galleryDates` and `threadActivity` from `apps/web/src/review/library/design-library.ts`, passing all versions (no window) and exact reply times;
   - assert that each Library item's `Date.parse(createdAt)` and `Date.parse(activityAt)` equal the reference.
3. `DSN-006-F: unreadable galleries are named, capability-less callers learn nothing, and anonymous callers are refused`:
   - an artifact whose index is invalid JSON — publish a directory containing `artifact-server-previews/index.json` with `{nope` as a file, as `design-library.spec.ts`'s "broken" fixture does — appears in `unreadable` by name while the valid gallery still loads;
   - `fetch(/api/v1/library)` without credentials returns 401;
   - an API key with only `agent:connect` gets 403, and its body contains no artifact names.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run tests/http/library-catalog.test.ts`
Expected: FAIL with 404 for `/api/v1/library`.

- [ ] **Step 3: Implement the service**

Create `src/application/library-catalog.ts`. Follow `src/application/activity.ts` for the `Context.Service`/`Layer.effect` shape and the `AuthorizationService` dependency. Behavior:

```ts
const read = Effect.fn("LibraryCatalogService.read")(function*(principal: Principal) {
  yield* authorization.requireArtifactListing(principal);
  const projects = (yield* dependencies.listProjects()).toSorted((left, right) => left.name.localeCompare(right.name));
  const galleries: PendingGallery[] = [];
  const unreadable: string[] = [];
  let examined = 0;
  let truncated = false;
  for (const project of projects) {
    let cursor: PageCursor | null = null;
    do {
      const page = yield* dependencies.listArtifacts({comments: "all", cursor, limit: 100, projectId: project.id, sort: "newest", tags: []});
      for (const artifact of page.items) {
        if (examined >= maximumLibraryArtifacts) {
          truncated = true;
          break;
        }
        examined += 1;
        const version = yield* dependencies.findVersionRecord(project.id, artifact.id, artifact.currentVersionId);
        const indexEntry = version?.manifest.entries.find((entry) => entry.path === previewIndexPath);
        if (version === null || indexEntry === undefined) continue;
        const reading = yield* readIndex(version, indexEntry);
        if (reading.status === "invalid") {
          unreadable.push(artifact.name);
          continue;
        }
        galleries.push({artifact, project, reading, version});
      }
      cursor = truncated ? null : page.nextCursor;
    } while (cursor !== null);
    if (truncated) break;
  }
  const dates = yield* dependencies.pageDates(galleries.map((gallery) => ({
    artifactId: gallery.artifact.id,
    currentVersionNumber: gallery.version.version.number,
    paths: gallery.reading.items.map((item) => item.path),
  })));
  return assembleLibrary(galleries, dates, unreadable, truncated, clock);
});
```

Details:
- `readIndex` reads the parsed-index LRU (a `Map` with insertion-order eviction at 1,000 versions) keyed by version id. On a miss it calls `readBlobText(indexEntry.sha256, maximumPreviewIndexBytes)`; `null` becomes `{status: "invalid", reason: "missing or too large"}`. Then `readPreviewIndex(text, version.manifest.entries)`. Invalid readings are cached too, because the version is immutable.
- `assembleLibrary` maps each item's dates. Created is the row's `createdAt`. Activity is the later of `changedAt` and `commentedAt`, compared as strings. A path with no row uses the version's `createdAt` for both.
- Galleries are sorted by project name then artifact name. `unreadable` is sorted by name. `generatedAt` comes from the application clock.
- `maximumLibraryArtifacts = 2_000`.
- `LibraryCatalogFailure` is `AuthorizationDenied | ArtifactRepositoryFailure | BlobStorageFailure`.

In `src/local/create-local-application-layer.ts`:
- Add `LibraryDatesStore` to the `ApplicationAdapters.repository` intersection type.
- Build `LibraryCatalogService.layer({...})` with `Effect.tryPromise` wrappers around `adapters.repository.listProjects`, `listArtifacts`, `findVersionRecord`, and `libraryPageDates`, using the same `repositoryFailure(...)` helper as the neighbouring wrappers.
- `readBlobText` uses `adapters.blobs.inspect` and `adapters.blobs.open`, returning `null` when inspect reports a size over the limit or a missing blob (catch the not-found case the way other blob reads in the file do), and reading the body as text.
- Merge the layer into the returned application layer, provided with `authorizationLayer`, and add `LibraryCatalogService` to the function's return type.

In `src/http/create-http-app.ts`, next to the activity routes:

```ts
  app.get("/api/v1/library", async (context) => {
    const library = await runHttpApplicationEffect(
      context,
      dependencies,
      LibraryCatalogService.use((catalog) => catalog.read(context.get("principal"))),
    );
    return context.json(library);
  });
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/http/library-catalog.test.ts`
Expected: PASS, 3 tests. If the equivalence test fails, compare against the spec's date semantics. A real difference between the SQL and `galleryDates` (not the window or reply approximation) is a bug in the SQL; fix the SQL, never the reference.

- [ ] **Step 5: Full suite, lint, typecheck, Workers check, commit**

Run:

```bash
pnpm test > "$TMPDIR/library-t5.log" 2>&1; grep -E "Test Files |Tests " "$TMPDIR/library-t5.log"
git checkout -- project/evidence/local-foundation.json project/evidence/storage-shutdown.json
pnpm lint && pnpm typecheck && pnpm check:cloudflare > "$TMPDIR/library-cf.log" 2>&1; echo $?
```

Expected: all pass, exit 0.

Commit the source and test files with the message "Serve the Library from one authorized request".

---

### Task 6: Client uses the endpoint (DSN-006-B)

**Files:**
- Modify: `apps/web/src/api/client.ts` (add `library`)
- Modify: `apps/web/src/review/library/use-design-library.ts` (replace `loadLibrary`'s fan-out)
- Test: `tests/browser/design-library.spec.ts` (new test)

**Interfaces:**
- Consumes: the `LibraryResponse` JSON from Task 5.
- Produces: `api.library(): Promise<LibraryResponseJson>`.

- [ ] **Step 1: Write the failing browser test**

Add to `tests/browser/design-library.spec.ts`:

```ts
test("DSN-006-B: the Library loads in one request with no per-gallery reads", async ({browser}) => {
  const fixture = await startBrowserFixture(browser);
  const directory = await mkdtemp(path.join(tmpdir(), "design-library-one-request-"));
  try {
    const claims = path.join(directory, "claims");
    await writePreviewSourceFixture(claims);
    await publish(fixture, claims, named("Claims Workspace"));
    await localLogin(fixture);
    const apiPaths: string[] = [];
    fixture.page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/v1/")) apiPaths.push(url.pathname);
    });
    await fixture.page.goto(`${fixture.server.baseUrl}/review/library`);
    const library = fixture.page.getByRole("region", {exact: true, name: "Library"});
    await expect(library.locator("a[data-gallery-path]").first()).toBeVisible();
    expect(apiPaths.filter((pathName) => pathName === "/api/v1/library")).toHaveLength(1);
    expect(apiPaths.filter((pathName) => /\/versions(\/|$)|\/comments/u.test(pathName))).toEqual([]);
  } finally {
    await stopBrowserFixture(fixture);
    await rm(directory, {force: true, recursive: true});
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm build && pnpm exec playwright test tests/browser/design-library.spec.ts -g "DSN-006-B"`
Expected: FAIL, with no `/api/v1/library` request, or with per-gallery `versions` reads present. If the repository runs browser specs only through `scripts/run-browser-evidence.ts`, use that script's filter option instead.

- [ ] **Step 3: Client API and loader**

In `apps/web/src/api/client.ts`, add a Zod schema mirroring `LibraryResponse` (`galleries` with `items` carrying `kind` as the same `z.enum` the gallery uses), and:

```ts
  library: () => request(libraryResponseSchema, "/api/v1/library"),
```

In `use-design-library.ts`, replace the body of `loadLibrary` with:

```ts
async function loadLibrary(wanted: () => boolean): Promise<LoadedLibrary | null> {
  const response = await api.library();
  if (!wanted()) return null;
  return {
    failures: response.unreadable,
    loadedAt: new Date(),
    scanned: response.galleries.length,
    sources: response.galleries.map((gallery): LibrarySource => ({
      artifactId: gallery.artifactId,
      artifactName: gallery.artifactName,
      dates: new Map(gallery.items.map((item) => [item.path, {
        activityAt: Date.parse(item.activityAt),
        createdAt: Date.parse(item.createdAt),
      }])),
      indexTitle: gallery.indexTitle,
      items: gallery.items.map(({activityAt: _activity, createdAt: _created, ...item}) => item),
      projectId: gallery.projectId,
      projectName: gallery.projectName,
      versionId: gallery.versionId,
    })),
    truncated: response.truncated,
    undated: [],
  };
}
```

Then:
- Update its caller to `loadLibrary(() => current)`, which no longer takes the project list. Keep the cache keyed by the project ids so a changed project list still reloads.
- Remove imports the new body no longer uses (`createRequestLimiter`, `pageDatesFor`, the preview-index helpers, `galleryDates`). Leave `page-dates.ts` itself in place for the artifact gallery view.
- If `eslint/no-underscore-dangle` or an unused-variable rule rejects the destructuring, map the fields explicitly instead.

- [ ] **Step 4: Run the web tests and the browser specs**

Run:

```bash
pnpm --filter @artifact-server/web test
pnpm build && pnpm exec playwright test tests/browser/design-library.spec.ts
```

Expected: PASS, including the existing DSN-005-B journey and the new DSN-006-B test. Unit tests in `apps/web/src/review/library/design-library.test.ts` exercise the pure date functions and stay green.

- [ ] **Step 5: Lint, typecheck, commit**

Run: `pnpm lint && pnpm typecheck`
Commit the three files with the message "Load the Library from the server in one request".

---

### Task 7: Ledger, product sentence, gates, local "after" run

**Files:**
- Modify: `project/spec/conformance.yml` (DSN-006 after DSN-005, exactly as in the spec)
- Modify: `project/spec/artifact-server-product-spec.html` (one sentence in the `claude-design-exports` section)
- Evidence: regenerated by the gates; `project/evidence/delivery-baseline-<date>-local-after-library.json`

- [ ] **Step 1: Product sentence.** Find the paragraph in the `claude-design-exports` section that describes the Library and append: "The Library is assembled on the server in one request, so it opens without reading each gallery's history in the browser."
- [ ] **Step 2: Ledger.** Insert the spec's DSN-006 block after DSN-005, with one blank line on each side. Run `pnpm conformance:validate && pnpm conformance:tests`. Expected: both pass.
- [ ] **Step 3: Gates.**
  1. Run `pnpm smoke`.
  2. Run `pnpm verify:iteration` in the background, with output to a file, and read its real exit code from that file (record `echo $?` into a file, as the last run did).
  3. If it fails, rerun any single failing test in isolation before concluding anything, and report it.

  Expected: exit 0.
- [ ] **Step 4: Record evidence.**
  - Mark DSN-006 `behavior_verified` with two local evidence records:
    - DSN-006-F from `project/evidence/local-foundation.json`;
    - DSN-006-B from `project/evidence/browser.json`, which records the browser specs.
  - Take each record's `recorded_at` from that report's `startTime` in ISO 8601 UTC.
  - If the validator requires both test IDs to come from one report, record each against its own report as separate evidence entries.

  Run `pnpm conformance:validate`. Expected: PASS.
- [ ] **Step 5: Local after run.** Run `pnpm build && pnpm perf:delivery --label after-library`. Expected: Library journeys `Timeouts` 0 and fewer requests than Task 1.
- [ ] **Step 6:** Run the privacy grep, then commit:
  - `project/spec/conformance.yml`
  - `project/spec/artifact-server-product-spec.html`
  - `project/evidence`

  Use the message "Specify DSN-006 and record local Library evidence". Confirm with `git status --short` that `NEXT.md` is not staged.

---

### Task 8: Deploy gate, hosted evidence, FINDINGS

**Files:**
- Modify: `project/performance/FINDINGS.md`
- Create: `project/evidence/delivery-baseline-<date>-hosted-after-library.json` (generated)
- External, only after approval: GitHub `main`, `image.yml`, `~/Workspace` pins

- [ ] **Step 1: STOP for approval.** Report the local before and after tables, the gate result, and the deploy steps. There is no migration, so rollback is a pin revert. Ask whether to push, build, and deploy.
- [ ] **Step 2: Deploy after approval**, following the memory note `deploy-artifacts-backend-app`:
  1. `git fetch origin`, confirm `origin/main` is an ancestor of `main`, and push.
  2. Run `gh workflow run image.yml --ref main` and read the digest from the "Print digest" step, cross-checked with `docker buildx imagetools inspect`.
  3. Update both Workspace pins, commit `Deploy Artifact Server server-side Library`, push, and refresh both Argo applications.
  4. Wait for exactly four ready `component=server` pods on the digest, and `Synced Healthy`.
- [ ] **Step 3: Hosted after run.**

  ```bash
  U=$(python3 -c 'import urllib.parse;print("https://artifacts.backend.app/review?"+urllib.parse.urlencode({"project":"prj_default","artifact":"art_a58bac0d-e1b1-401d-a548-eb26614bfcd8","path":"project/Prototype - ExtractionKit.dc.html"}))')
  pnpm perf:delivery --target https://artifacts.backend.app --content-domain frontend.app --prototype-url "$U" --label after-library --deployment-revision '<digest>'
  ```

  Expected: Library cold ready median under 2 s. If the saved session has expired, tell the user before the Chrome sign-in opens.
- [ ] **Step 4: FINDINGS.** Append `## October 2026 server-side Library (DSN-006)` to `project/performance/FINDINGS.md`. Include:
  - the local before and after tables;
  - the hosted after table, compared with the three earlier hosted Library cold medians (33 s, 22 s, 26 s);
  - the request counts;
  - a plain statement of whether the under-2-second criterion was met.

  Render the tables with `formatJourneyTable`, as in the variants section. Update DSN-006's `proof_gap` to name the hosted observation.
- [ ] **Step 5:** Run the privacy grep, then commit FINDINGS, the ledger, and the hosted report with the message "Record hosted evidence for the server-side Library". Fetch, confirm fast-forward, and push.
