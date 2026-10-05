# Precompressed Content Variants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compress each eligible version-content blob once with Brotli, store the result as an ordinary blob found through a small index table, and serve it on every later open, so that opening a prototype spends no CPU on compression.

**Architecture:** A `ContentVariants` service owns an in-process build queue, a lookup cache, and the backfill. It depends on narrow ports: `BlobStore` (existing), `ContentVariantIndex` (new; SQLite and Postgres implementations), and `ContentVariantCompressor` (new; a `node:zlib` implementation). `serveStoredVersionContent` asks the service for a stored variant: a hit is served as `br` with a real `Content-Length`; a miss is served as identity and queues a build. Publishing queues builds through an optional observer, and a maintenance command backfills current versions. The streaming encoder from CNT-010 is removed.

**Tech Stack:** TypeScript on Node 24.15, Hono, `node:zlib`, `node:sqlite`, Effect SQL for Postgres, Vitest, Commander, Zod.

**Spec:** `docs/superpowers/specs/2026-10-05-precompressed-content-variants-design.md`

## Global Constraints

- Work on `main` in the shared checkout; another agent commits `NEXT.md` on `main`. Never switch branches, never stage `NEXT.md`, and stage only exact paths (`git add <path>`, never `-A` or `.`).
- Never push, build images, touch `~/Workspace`, or `kubectl exec` without the user's explicit approval at Task 9.
- No module mocks. Tests use real HTTP servers (`startTestServer`), temporary disk storage, temporary SQLite, and Docker Postgres where named.
- Each conformance test ID (`CNT-010-B`, `CNT-010-F`, `CNT-011-B`, `CNT-011-F`) appears in exactly one test title; other new tests start with `foundation:`.
- Lint is strict (`oxlint --type-aware --type-check --deny-warnings`): no inline object types on function parameters, no runtime `typeof`, no `Record<string, unknown>`, no `shape` in symbol names, no unsafe or chained type assertions, `toSorted()` instead of `sort()`, bracket access for index signatures, no floating promises. A deliberately sequential `await` in a loop gets `// eslint-disable-next-line no-await-in-loop -- <reason>`.
- Encoder settings: Brotli quality 9, `BROTLI_PARAM_LGWIN` 22, encoder id `br-q9-w22-v1`, coding `br` only.
- Eligibility: media type in {`application/javascript`, `application/json`, `image/svg+xml`, `text/css`, `text/html`, `text/javascript`} and size ≥ 1,024 bytes.
- Builder limits: source ≤ 64 MiB (67,108,864 bytes); keep a variant only if it is ≤ 90% of the source size; one build per process at a time; queue ≤ 1,000 keys (drop the oldest); positive cache ≤ 10,000 mappings; negative cache 30,000 ms per source digest.
- Variant rows are scoped to the installation (`installation_id`), as every product table is (AUTH-017).
- Runtimes under test default to `contentVariantBuilds: "manual"`; production defaults to `"background"`. The option is never read from the environment.
- Commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A client that accepts gzip but not br.** It gets identity bytes (never a stored br body). The test is in Task 6 (CNT-010-F).
2. **A HEAD request for an entry whose variant exists.** HEAD reports `Content-Encoding: br` and the variant's `Content-Length` without reading the variant body. The test is in Task 6 (CNT-010-B).
3. **The same bytes published in two artifacts.** One variant serves both, and the backfill counts the second as `skipped`. The test is in Task 7 (CNT-011-B).
4. **A variant blob deleted from storage after its mapping was recorded.** The request is served identity and the next drain rewrites the blob. The test is in Task 6 (CNT-010-F).
5. **Two installations sharing one Postgres database.** One installation's mapping is invisible to the other. The test is in Task 3.

---

## File map

| File | Responsibility |
|---|---|
| `src/core/content-variants.ts` (new) | Variant types, `ContentVariantIndex` and `ContentVariantCompressor` ports, `PublishedContentObserver`, `ContentVariantConflict`, eligibility, encoder constants |
| `src/http/content-encoding.ts` (modify) | `Accept-Encoding` negotiation and `Vary` helper only; eligibility moves to core; `ContentEncoder` removed |
| `src/http/node-response-compression.ts` (modify) | Import eligibility from core |
| `src/http/node-content-encoder.ts` (delete) | Streaming encoder, replaced |
| `src/http/node-variant-compressor.ts` (new) | `node:zlib` Brotli compressor into memory with an output limit |
| `src/application/content-variants.ts` (new) | `ContentVariants` service: lookup cache, queue, builds, backfill, publish observer |
| `src/application/current-version-entries.ts` (new) | Async iteration over every project's current-version manifest entries |
| `src/storage/sqlite-content-variant-index.ts` (new) | SQLite index |
| `src/storage/postgres-content-variant-index.ts` (new) | Postgres index |
| `src/storage/sqlite-artifact-repository.ts`, `src/storage/sqlite-schema.ts` (modify) | `content_variants` table; schema version 20 |
| `src/storage/postgres-migrations.ts` (modify) | Migration 20 |
| `src/http/create-http-app.ts` (modify) | `contentVariants` dependency; variant selection in `serveStoredVersionContent` |
| `src/application/publish-artifact.ts`, `src/local/create-local-application-layer.ts` (modify) | Publish observer |
| `src/local/create-local-runtime.ts`, `src/local/start-local-server.ts`, `src/external-storage/create-external-storage-runtime.ts` (modify) | Composition, `drainContentVariants`, `buildContentVariants` |
| `src/cli/lifecycle-commands.ts` (modify) | `maintenance build-content-variants` |
| `tests/support/runtime-harness.ts` (modify) | `contentVariantBuilds` option; drain and build pass-through |
| Tests (new) | `tests/storage/sqlite-content-variant-index.test.ts`, `tests/integration/postgres-content-variant-index.test.ts`, `tests/http/node-variant-compressor.test.ts`, `tests/application/content-variants.test.ts`, `tests/http/content-variant-builds.test.ts` |
| `tests/http/content-delivery-compression.test.ts` (rewrite) | CNT-010 |
| Ledger, product spec, FINDINGS, evidence (modify) | CNT-010/011 and evidence |

---

### Task 1: Capture the local "before" delivery run

**Files:**
- Create: `project/evidence/delivery-baseline-<date>-local-before-variants.json` (generated)

This must run on today's streaming code, before Task 6 changes serving.

- [ ] **Step 1: Build and run**

Run: `pnpm build && pnpm perf:delivery --label before-variants`
Expected: four journeys with `Timeouts` 0; prototype rows show "Lease encoding" `br` (today's streaming encoder).

- [ ] **Step 2: Privacy check**

Run: `grep -n -i -E 'cookie|authorization|bearer|__artifact_bootstrap|review-[a-z0-9_-]{20,}|frontend\.app|token' project/evidence/delivery-baseline-*.json || echo clean`
Expected: `clean`.

- [ ] **Step 3: Commit**

```bash
git add project/evidence/delivery-baseline-*-local-before-variants.json
git commit -m "Record the local delivery baseline before precompressed variants

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Core variant types and the SQLite index

**Files:**
- Create: `src/core/content-variants.ts`
- Create: `src/storage/sqlite-content-variant-index.ts`
- Modify: `src/storage/sqlite-schema.ts:9` (`requiredSqliteSchemaVersion` 19 → 20)
- Modify: `src/storage/sqlite-artifact-repository.ts` (`#migrate`, before its final `PRAGMA user_version` at about line 5820)
- Modify: `src/http/content-encoding.ts`, `src/http/node-response-compression.ts` (eligibility moves to core)
- Test: `tests/storage/sqlite-content-variant-index.test.ts`

**Interfaces:**
- Produces:
  - `type ContentVariantCoding = "br"`
  - `interface ContentVariantKey { coding: ContentVariantCoding; encoderId: string; sourceSha256: string }`
  - `interface ContentVariantMapping extends ContentVariantKey { variantSha256: string; variantSize: number }`
  - `interface ContentVariantIndex { find(key): Promise<ContentVariantMapping | null>; record(mapping): Promise<void> }`
  - `interface ContentVariantCompressor { compress(body: ReadableStream<Uint8Array>, outputLimitBytes: number): Promise<Uint8Array | null> }`
  - `interface PublishedContentObserver { readonly versionPublished: (entries: readonly ManifestEntry[]) => void }`
  - `class ContentVariantConflict extends Error`
  - `brotliVariantEncoderId = "br-q9-w22-v1"`, `maximumVariantSourceBytes`, `maximumVariantSizeRatio = 0.9`, `minimumCompressedBodyBytes = 1024`
  - `isCompressibleMediaType(contentType: string | null): boolean`, `isVariantEligible(mediaType: string, size: number): boolean`
  - `class SqliteContentVariantIndex implements ContentVariantIndex { constructor(databasePath: string, installationId: string, clock: Clock); close(): void }`

- [ ] **Step 1: Write the failing test**

Create `tests/storage/sqlite-content-variant-index.test.ts`:

```ts
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  brotliVariantEncoderId,
  ContentVariantConflict,
  type ContentVariantMapping,
} from "../../src/core/content-variants.js";
import {SystemClock} from "../../src/core/system.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteContentVariantIndex} from "../../src/storage/sqlite-content-variant-index.js";

const sourceSha256 = "a".repeat(64);
const mapping: ContentVariantMapping = {
  coding: "br",
  encoderId: brotliVariantEncoderId,
  sourceSha256,
  variantSha256: "b".repeat(64),
  variantSize: 1234,
};

describe("SQLite content variant index", () => {
  let directory: string;
  let databasePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "sqlite-variant-index-"));
    databasePath = path.join(directory, "artifact-server.db");
    // The artifact repository owns the compact schema and creates the table.
    new SqliteArtifactRepository(databasePath, "installation-a").close();
  });

  afterEach(async () => {
    await rm(directory, {force: true, recursive: true});
  });

  test("foundation: the SQLite variant index records, finds, and rejects conflicting mappings", async () => {
    const index = new SqliteContentVariantIndex(databasePath, "installation-a", new SystemClock());
    try {
      expect(await index.find(mapping)).toBeNull();
      await index.record(mapping);
      await index.record(mapping);
      expect(await index.find(mapping)).toEqual(mapping);
      await expect(index.record({...mapping, variantSha256: "c".repeat(64)}))
        .rejects.toBeInstanceOf(ContentVariantConflict);
      expect(await index.find({...mapping, encoderId: "br-q11-w24-v2"})).toBeNull();
    } finally {
      index.close();
    }
  });

  test("foundation: SQLite variant mappings survive reopening and stay within their installation", async () => {
    const first = new SqliteContentVariantIndex(databasePath, "installation-a", new SystemClock());
    await first.record(mapping);
    first.close();
    const reopened = new SqliteContentVariantIndex(databasePath, "installation-a", new SystemClock());
    const other = new SqliteContentVariantIndex(databasePath, "installation-b", new SystemClock());
    try {
      expect(await reopened.find(mapping)).toEqual(mapping);
      expect(await other.find(mapping)).toBeNull();
    } finally {
      reopened.close();
      other.close();
    }
  });
});
```

If `SystemClock` lives elsewhere, import it from where `src/local/create-local-runtime.ts` imports it. If `SqliteArtifactRepository` has no `close()`, use the method it has for releasing its handle (see `src/storage/sqlite-artifact-repository.ts:1368`).

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/storage/sqlite-content-variant-index.test.ts`
Expected: FAIL, because `src/core/content-variants.js` cannot be resolved.

- [ ] **Step 3: Create the core module**

Create `src/core/content-variants.ts`:

```ts
import type {ManifestEntry} from "./model.js";

/** The only coding stored as a variant; clients without Brotli get identity bytes. */
export type ContentVariantCoding = "br";

/** Brotli quality 9 with a 4 MiB window; a settings change introduces a new id. */
export const brotliVariantEncoderId = "br-q9-w22-v1";

/** Sources larger than this are never compressed into variants. */
export const maximumVariantSourceBytes = 64 * 1_048_576;

/** A variant is kept only when it is at most this share of its source. */
export const maximumVariantSizeRatio = 0.9;

/** Smaller bodies gain too little to justify a coding. */
export const minimumCompressedBodyBytes = 1_024;

const compressibleMediaTypes: ReadonlySet<string> = new Set([
  "application/javascript",
  "application/json",
  "image/svg+xml",
  "text/css",
  "text/html",
  "text/javascript",
]);

export function isCompressibleMediaType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mediaType = contentType.split(";")[0]?.trim().toLocaleLowerCase("en-US");
  return mediaType !== undefined && compressibleMediaTypes.has(mediaType);
}

/** Whether one manifest entry may be served from a compressed variant. */
export function isVariantEligible(mediaType: string, size: number): boolean {
  return size >= minimumCompressedBodyBytes && isCompressibleMediaType(mediaType);
}

/** Identifies one compressed rendering of a stored blob. */
export interface ContentVariantKey {
  readonly coding: ContentVariantCoding;
  readonly encoderId: string;
  readonly sourceSha256: string;
}

/** A stored compressed rendering; the variant itself is an ordinary content-addressed blob. */
export interface ContentVariantMapping extends ContentVariantKey {
  readonly variantSha256: string;
  readonly variantSize: number;
}

/** Finds and records compressed renderings for one installation. */
export interface ContentVariantIndex {
  find(key: ContentVariantKey): Promise<ContentVariantMapping | null>;
  /** Idempotent: an identical mapping is accepted; a different one rejects with ContentVariantConflict. */
  record(mapping: ContentVariantMapping): Promise<void>;
}

/** Compresses a whole source into memory once. */
export interface ContentVariantCompressor {
  /** Resolves with the compressed bytes, or null once the output would exceed the limit. */
  compress(body: ReadableStream<Uint8Array>, outputLimitBytes: number): Promise<Uint8Array | null>;
}

/** Notified after a commit creates a version; must never throw into publication. */
export interface PublishedContentObserver {
  readonly versionPublished: (entries: readonly ManifestEntry[]) => void;
}

/** A different variant is already recorded for the same source, coding, and encoder. */
export class ContentVariantConflict extends Error {
  constructor(key: ContentVariantKey) {
    super(`A different ${key.coding} variant is already recorded for ${key.sourceSha256} (${key.encoderId}).`);
    this.name = "ContentVariantConflict";
  }
}
```

- [ ] **Step 4: Move eligibility out of the HTTP module**

In `src/http/content-encoding.ts`:
- Delete `compressibleMediaTypes`, `minimumCompressedBodyBytes`, `isCompressibleMediaType`, and the `ContentEncoder` interface (its only user is removed in Task 6; leave `ContentEncoder` in place until then if `create-http-app.ts` still imports it, and delete it in Task 6 Step 5).
- Keep `ContentCoding`, `negotiateContentCoding`, `acceptQuality`, and `appendAcceptEncodingVary`.

In `src/http/node-response-compression.ts`, import `isCompressibleMediaType` and `minimumCompressedBodyBytes` from `../core/content-variants.js` instead of `./content-encoding.js`. Make the same import change in `src/http/create-http-app.ts` for those two names.

- [ ] **Step 5: Create the SQLite table and index**

In `src/storage/sqlite-schema.ts`, set `requiredSqliteSchemaVersion = 20`.

In `src/storage/sqlite-artifact-repository.ts`, add this call in `#migrate` immediately before the final ``this.#database.exec(`PRAGMA user_version = ${requiredSqliteSchemaVersion};`);``:

```ts
    this.#addContentVariantsTableIfMissing();
```

and add the method next to the other `#add...IfMissing` methods:

```ts
  #addContentVariantsTableIfMissing(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS content_variants (
        installation_id TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        coding TEXT NOT NULL CHECK (coding = 'br'),
        encoder_id TEXT NOT NULL,
        variant_sha256 TEXT NOT NULL,
        variant_size INTEGER NOT NULL CHECK (variant_size >= 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY (installation_id, source_sha256, coding, encoder_id)
      ) STRICT;
    `);
  }
```

Create `src/storage/sqlite-content-variant-index.ts`:

```ts
import {DatabaseSync} from "node:sqlite";

import {z} from "zod";

import {
  ContentVariantConflict,
  type ContentVariantIndex,
  type ContentVariantKey,
  type ContentVariantMapping,
} from "../core/content-variants.js";
import type {Clock} from "../core/ports.js";

const mappingRowSchema = z.object({
  variant_sha256: z.string(),
  variant_size: z.number().int().nonnegative(),
});

/** SQLite variant index sharing the compact installation database. */
export class SqliteContentVariantIndex implements ContentVariantIndex {
  readonly #clock: Clock;
  readonly #database: DatabaseSync;
  readonly #installationId: string;

  constructor(databasePath: string, installationId: string, clock: Clock) {
    this.#clock = clock;
    this.#installationId = installationId;
    this.#database = new DatabaseSync(databasePath, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      open: true,
      timeout: 5_000,
    });
  }

  async find(key: ContentVariantKey): Promise<ContentVariantMapping | null> {
    const row = this.#database.prepare(`
      SELECT variant_sha256, variant_size FROM content_variants
      WHERE installation_id = ? AND source_sha256 = ? AND coding = ? AND encoder_id = ?
    `).get(this.#installationId, key.sourceSha256, key.coding, key.encoderId);
    if (row === undefined) return null;
    const parsed = mappingRowSchema.parse(row);
    return {
      coding: key.coding,
      encoderId: key.encoderId,
      sourceSha256: key.sourceSha256,
      variantSha256: parsed.variant_sha256,
      variantSize: parsed.variant_size,
    };
  }

  async record(mapping: ContentVariantMapping): Promise<void> {
    this.#database.prepare(`
      INSERT INTO content_variants
        (installation_id, source_sha256, coding, encoder_id, variant_sha256, variant_size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (installation_id, source_sha256, coding, encoder_id) DO NOTHING
    `).run(
      this.#installationId,
      mapping.sourceSha256,
      mapping.coding,
      mapping.encoderId,
      mapping.variantSha256,
      mapping.variantSize,
      this.#clock.now().toISOString(),
    );
    const stored = await this.find(mapping);
    if (
      stored === null
      || stored.variantSha256 !== mapping.variantSha256
      || stored.variantSize !== mapping.variantSize
    ) {
      throw new ContentVariantConflict(mapping);
    }
  }

  close(): void {
    this.#database.close();
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run tests/storage/sqlite-content-variant-index.test.ts tests/http/node-response-compression.test.ts tests/http/content-delivery-compression.test.ts`
Expected: PASS. Then run `pnpm test > "$TMPDIR/variants-t2.log" 2>&1; tail -5 "$TMPDIR/variants-t2.log"`. Expected: all pass. A test that asserts schema version 19 must be updated to 20, because the version legitimately moved; say so in the commit. Restore regenerated evidence afterwards with `git checkout -- project/evidence/local-foundation.json project/evidence/storage-shutdown.json`.

- [ ] **Step 7: Lint and commit**

Run: `pnpm exec oxlint --type-aware --type-check --deny-warnings src/core src/storage src/http tests/storage`
Expected: no diagnostics.

```bash
git add src/core/content-variants.ts src/storage/sqlite-content-variant-index.ts src/storage/sqlite-schema.ts src/storage/sqlite-artifact-repository.ts src/http/content-encoding.ts src/http/node-response-compression.ts src/http/create-http-app.ts tests/storage/sqlite-content-variant-index.test.ts
git commit -m "Add the content variant index and its SQLite table

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Postgres index and migration 20

**Files:**
- Create: `src/storage/postgres-content-variant-index.ts`
- Modify: `src/storage/postgres-migrations.ts` (new migration, loader entry, `requiredPostgresSchemaVersion` 20, expected history)
- Modify: `tests/configs/vitest.external-storage.config.ts` (include the new test)
- Test: `tests/integration/postgres-content-variant-index.test.ts`

**Interfaces:**
- Consumes: Task 2's types.
- Produces: `class PostgresContentVariantIndex implements ContentVariantIndex { constructor(database: PostgresDatabase, installationId: string, clock: Clock) }`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/postgres-content-variant-index.test.ts`:

```ts
import {randomUUID} from "node:crypto";

import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  brotliVariantEncoderId,
  ContentVariantConflict,
  type ContentVariantMapping,
} from "../../src/core/content-variants.js";
import {SystemClock} from "../../src/core/system.js";
import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresContentVariantIndex} from "../../src/storage/postgres-content-variant-index.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";

function readDatabaseUrl(): string {
  const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  if (databaseUrl === undefined) {
    throw new Error("Run this test through pnpm test:external-storage-runtime.");
  }
  return databaseUrl;
}

const mapping: ContentVariantMapping = {
  coding: "br",
  encoderId: brotliVariantEncoderId,
  sourceSha256: "a".repeat(64),
  variantSha256: "b".repeat(64),
  variantSize: 1234,
};

describe("Postgres content variant index", () => {
  const scratch = `artifact_content_variants_${randomUUID().replaceAll("-", "")}`;
  let maintenance: PostgresDatabase;
  let database: PostgresDatabase;
  let installationA: string;
  let installationB: string;

  beforeEach(async () => {
    maintenance = await PostgresDatabase.inspect({url: Redacted.make(readDatabaseUrl())});
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`CREATE DATABASE ${scratch}`);
    }));
    const scratchUrl = new URL(readDatabaseUrl());
    scratchUrl.pathname = `/${scratch}`;
    database = await PostgresDatabase.open({url: Redacted.make(scratchUrl.toString())}, "apply");
    installationA = `test-variants-a-${randomUUID()}`;
    installationB = `test-variants-b-${randomUUID()}`;
    // Opening the repository registers each installation row the index references.
    await PostgresArtifactRepository.open(database, installationA);
    await PostgresArtifactRepository.open(database, installationB);
  });

  afterEach(async () => {
    await database.close();
    await maintenance.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    }));
    await maintenance.close();
  });

  test("foundation: the Postgres variant index records idempotently, rejects conflicts, and isolates installations", async () => {
    const indexA = new PostgresContentVariantIndex(database, installationA, new SystemClock());
    const indexB = new PostgresContentVariantIndex(database, installationB, new SystemClock());
    expect(await indexA.find(mapping)).toBeNull();
    await indexA.record(mapping);
    await indexA.record(mapping);
    expect(await indexA.find(mapping)).toEqual(mapping);
    await expect(indexA.record({...mapping, variantSize: 99})).rejects.toBeInstanceOf(ContentVariantConflict);
    expect(await indexB.find(mapping)).toBeNull();
  });
});
```

Add `"tests/integration/postgres-content-variant-index.test.ts",` to the `include` list in `tests/configs/vitest.external-storage.config.ts`.

- [ ] **Step 2: Run it to verify it fails**

Run: `bash scripts/with-external-storage-test-providers.sh pnpm exec vitest run --config tests/configs/vitest.external-storage.config.ts tests/integration/postgres-content-variant-index.test.ts`
Expected: FAIL, because `postgres-content-variant-index.js` cannot be resolved. If the wrapper needs different arguments, read its usage line and the `test:external-storage-runtime` script in `package.json`.

- [ ] **Step 3: Add migration 20**

In `src/storage/postgres-migrations.ts`, after `addMemberAdmissionAndActivity`:

```ts
const addContentVariants = Effect.gen(function*() {
  const sql = yield* SqlClient;
  yield* sql.unsafe(`CREATE TABLE content_variants (
    installation_id TEXT NOT NULL REFERENCES artifact_installations(id),
    source_sha256 TEXT NOT NULL,
    coding TEXT NOT NULL CHECK (coding = 'br'),
    encoder_id TEXT NOT NULL,
    variant_sha256 TEXT NOT NULL,
    variant_size BIGINT NOT NULL CHECK (variant_size >= 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY (installation_id, source_sha256, coding, encoder_id)
  )`);
});
```

Add `"0020_content_variants": addContentVariants,` to `migrationLoader`, set `requiredPostgresSchemaVersion = 20`, and append `{migration_id: 20, name: "content_variants"}` to the expected history list after migration 19.

- [ ] **Step 4: Implement the Postgres index**

Create `src/storage/postgres-content-variant-index.ts`:

```ts
import {Effect} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {z} from "zod";

import {
  ContentVariantConflict,
  type ContentVariantIndex,
  type ContentVariantKey,
  type ContentVariantMapping,
} from "../core/content-variants.js";
import type {Clock} from "../core/ports.js";
import type {PostgresDatabase} from "./postgres-database.js";

const mappingRowSchema = z.object({
  variant_sha256: z.string(),
  // BIGINT arrives as a string from the driver.
  variant_size: z.coerce.number().int().nonnegative(),
});

/** Postgres variant index for stateless external-storage processes. */
export class PostgresContentVariantIndex implements ContentVariantIndex {
  readonly #clock: Clock;
  readonly #database: PostgresDatabase;
  readonly #installationId: string;

  constructor(database: PostgresDatabase, installationId: string, clock: Clock) {
    this.#clock = clock;
    this.#database = database;
    this.#installationId = installationId;
  }

  async find(key: ContentVariantKey): Promise<ContentVariantMapping | null> {
    const installationId = this.#installationId;
    const rows = await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql<{readonly variant_sha256: string; readonly variant_size: string}>`
        SELECT variant_sha256, variant_size FROM content_variants
        WHERE installation_id = ${installationId}
          AND source_sha256 = ${key.sourceSha256}
          AND coding = ${key.coding}
          AND encoder_id = ${key.encoderId}
      `.withoutTransform;
    }));
    const row = rows[0];
    if (row === undefined) return null;
    const parsed = mappingRowSchema.parse(row);
    return {
      coding: key.coding,
      encoderId: key.encoderId,
      sourceSha256: key.sourceSha256,
      variantSha256: parsed.variant_sha256,
      variantSize: parsed.variant_size,
    };
  }

  async record(mapping: ContentVariantMapping): Promise<void> {
    const installationId = this.#installationId;
    const createdAt = this.#clock.now().toISOString();
    await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql`
        INSERT INTO content_variants
          (installation_id, source_sha256, coding, encoder_id, variant_sha256, variant_size, created_at)
        VALUES (${installationId}, ${mapping.sourceSha256}, ${mapping.coding}, ${mapping.encoderId},
          ${mapping.variantSha256}, ${mapping.variantSize}, ${createdAt})
        ON CONFLICT (installation_id, source_sha256, coding, encoder_id) DO NOTHING
      `;
    }));
    const stored = await this.find(mapping);
    if (
      stored === null
      || stored.variantSha256 !== mapping.variantSha256
      || stored.variantSize !== mapping.variantSize
    ) {
      throw new ContentVariantConflict(mapping);
    }
  }
}
```

- [ ] **Step 5: Run the test and the migration checks**

Run: `bash scripts/with-external-storage-test-providers.sh pnpm exec vitest run --config tests/configs/vitest.external-storage.config.ts tests/integration/postgres-content-variant-index.test.ts tests/integration/postgres-activity-log-migration.test.ts`
Expected: PASS. A failure on the expected-history check means the new entry is missing from the list in `postgres-migrations.ts`.

- [ ] **Step 6: Lint and commit**

Run: `pnpm exec oxlint --type-aware --type-check --deny-warnings src/storage tests/integration/postgres-content-variant-index.test.ts`
Expected: no diagnostics.

```bash
git add src/storage/postgres-content-variant-index.ts src/storage/postgres-migrations.ts tests/configs/vitest.external-storage.config.ts tests/integration/postgres-content-variant-index.test.ts
git commit -m "Add the Postgres content variant index and migration 20

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Node Brotli variant compressor

**Files:**
- Create: `src/http/node-variant-compressor.ts`
- Test: `tests/http/node-variant-compressor.test.ts`

**Interfaces:**
- Consumes: `ContentVariantCompressor` (Task 2).
- Produces: `nodeBrotliVariantCompressor: ContentVariantCompressor`.

- [ ] **Step 1: Write the failing test**

Create `tests/http/node-variant-compressor.test.ts`:

```ts
import {randomBytes} from "node:crypto";
import {brotliDecompressSync} from "node:zlib";

import {describe, expect, test} from "vitest";

import {nodeBrotliVariantCompressor} from "../../src/http/node-variant-compressor.js";

interface TrackedSource {
  readonly cancelled: () => boolean;
  readonly stream: ReadableStream<Uint8Array>;
}

/** A real stream over fixed chunks that records whether its consumer cancelled it. */
function trackedSource(chunks: readonly Uint8Array[]): TrackedSource {
  let index = 0;
  let wasCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel: () => {
      wasCancelled = true;
    },
    pull: (controller) => {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  });
  return {cancelled: () => wasCancelled, stream};
}

describe("node Brotli variant compressor", () => {
  test("foundation: compresses a source into Brotli that decodes to the exact bytes", async () => {
    const text = new TextEncoder().encode(
      Array.from({length: 4_000}, (_, index) => `{"id":"row-${index}","status":"awaiting-review"}`).join("\n"),
    );
    const chunks = Array.from({length: 8}, (_, index) =>
      text.slice(index * (text.byteLength / 8), (index + 1) * (text.byteLength / 8)));
    const compressed = await nodeBrotliVariantCompressor.compress(trackedSource(chunks).stream, text.byteLength);
    expect(compressed).not.toBeNull();
    expect(compressed?.byteLength).toBeLessThan(text.byteLength / 4);
    expect(new Uint8Array(brotliDecompressSync(compressed ?? new Uint8Array()))).toEqual(text);
  });

  test("foundation: stops and cancels the source once the output passes the limit", async () => {
    const chunks = Array.from({length: 64}, () => new Uint8Array(randomBytes(64 * 1_024)));
    const source = trackedSource(chunks);
    const compressed = await nodeBrotliVariantCompressor.compress(source.stream, 256 * 1_024);
    expect(compressed).toBeNull();
    expect(source.cancelled()).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/http/node-variant-compressor.test.ts`
Expected: FAIL, because the module cannot be resolved.

- [ ] **Step 3: Implement the compressor**

Create `src/http/node-variant-compressor.ts`:

```ts
import {constants, createBrotliCompress} from "node:zlib";

import type {ContentVariantCompressor} from "../core/content-variants.js";

/** One-time background builds can afford quality 9 and a 4 MiB window. */
const brotliQuality = 9;
const brotliWindowBits = 22;

function writeChunk(compressor: ReturnType<typeof createBrotliCompress>, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    compressor.write(chunk, (error) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}

/** Compresses a whole source into memory, abandoning it once the output passes the limit. */
export const nodeBrotliVariantCompressor: ContentVariantCompressor = {
  async compress(body, outputLimitBytes) {
    const compressor = createBrotliCompress({
      params: {
        [constants.BROTLI_PARAM_QUALITY]: brotliQuality,
        [constants.BROTLI_PARAM_LGWIN]: brotliWindowBits,
      },
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let exceeded = false;
    const finished = new Promise<void>((resolve, reject) => {
      compressor.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > outputLimitBytes) {
          exceeded = true;
          compressor.destroy();
          resolve();
          return;
        }
        chunks.push(chunk);
      });
      compressor.once("end", resolve);
      compressor.once("error", reject);
    });
    const reader = body.getReader();
    try {
      for (;;) {
        if (exceeded) {
          await reader.cancel();
          break;
        }
        // eslint-disable-next-line no-await-in-loop -- one chunk at a time keeps memory bounded
        const next = await reader.read();
        if (next.done) {
          compressor.end();
          break;
        }
        // eslint-disable-next-line no-await-in-loop -- zlib must accept a chunk before the next read
        await writeChunk(compressor, next.value);
      }
      await finished;
    } catch (error) {
      compressor.destroy();
      await reader.cancel().catch(() => undefined);
      // Writing into a compressor destroyed for exceeding the limit is the expected stop.
      if (exceeded) return null;
      throw error;
    }
    return exceeded ? null : Buffer.concat(chunks);
  },
};
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/http/node-variant-compressor.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Lint and commit**

Run: `pnpm exec oxlint --type-aware --type-check --deny-warnings src/http tests/http/node-variant-compressor.test.ts`
Expected: no diagnostics.

```bash
git add src/http/node-variant-compressor.ts tests/http/node-variant-compressor.test.ts
git commit -m "Add a bounded in-memory Brotli compressor for content variants

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The ContentVariants service (CNT-011-F)

**Files:**
- Create: `src/application/content-variants.ts`
- Test: `tests/application/content-variants.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 4; `BlobStore` and `ManifestEntry`.
- Produces (used by Tasks 6 and 7):
  - `type ContentVariantBuildOutcome = "built" | "failed" | "not_beneficial" | "skipped" | "too_large"`
  - `interface ContentVariantBuildEvent { durationMilliseconds: number; error: string | null; outcome: ContentVariantBuildOutcome; sourceSha256: string; sourceSize: number; variantSize: number | null }`
  - `interface ContentVariantBackfillReport { built: number; examined: number; failed: number; not_beneficial: number; skipped: number; too_large: number }`
  - `interface ContentVariantSource { sha256: string; size: number; mediaType: string }` (structurally satisfied by `ManifestEntry`)
  - `interface ContentVariantDelivery { find(sourceSha256: string): Promise<ContentVariantMapping | null>; schedule(sourceSha256: string, sourceSize: number): void; reportUnusable(mapping: ContentVariantMapping): void; reportLookupFailure(error: unknown): void }` (the HTTP-facing slice)
  - `interface ContentVariantDependencies { blobs: Pick<BlobStore, "open" | "put">; compressor: ContentVariantCompressor; index: ContentVariantIndex; log: (event: ContentVariantBuildEvent) => void; mode: "background" | "manual"; monotonicNow?: () => number }`
  - `class ContentVariants implements ContentVariantDelivery, PublishedContentObserver { constructor(dependencies); drain(): Promise<void>; build(source: ContentVariantSource): Promise<ContentVariantBuildOutcome>; backfill(sources: AsyncIterable<ContentVariantSource>, limit: number): Promise<ContentVariantBackfillReport>; close(): Promise<void> }`

- [ ] **Step 1: Write the failing tests**

Create `tests/application/content-variants.test.ts`:

```ts
import {createHash, randomBytes} from "node:crypto";
import {mkdtemp, rm, stat, unlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {brotliDecompressSync} from "node:zlib";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  ContentVariants,
  type ContentVariantBuildEvent,
} from "../../src/application/content-variants.js";
import {
  brotliVariantEncoderId,
  ContentVariantConflict,
  maximumVariantSourceBytes,
} from "../../src/core/content-variants.js";
import {SystemClock} from "../../src/core/system.js";
import {nodeBrotliVariantCompressor} from "../../src/http/node-variant-compressor.js";
import {LocalBlobStore} from "../../src/storage/local-blob-store.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteContentVariantIndex} from "../../src/storage/sqlite-content-variant-index.js";

interface StoredSource {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly sha256: string;
  readonly size: number;
}

const compressibleText = new TextEncoder().encode(
  Array.from({length: 20_000}, (_, index) => `window.rows.push({"id":"r${index}","field":"amount"});`).join("\n"),
);

describe("ContentVariants", () => {
  let directory: string;
  let blobRoot: string;
  let blobs: LocalBlobStore;
  let index: SqliteContentVariantIndex;
  let events: ContentVariantBuildEvent[];
  let clock: number;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "content-variants-"));
    blobRoot = path.join(directory, "blobs");
    const databasePath = path.join(directory, "artifact-server.db");
    new SqliteArtifactRepository(databasePath, "installation-a").close();
    blobs = new LocalBlobStore(blobRoot);
    index = new SqliteContentVariantIndex(databasePath, "installation-a", new SystemClock());
    events = [];
    clock = 0;
  });

  afterEach(async () => {
    index.close();
    await rm(directory, {force: true, recursive: true});
  });

  function variants(): ContentVariants {
    return new ContentVariants({
      blobs,
      compressor: nodeBrotliVariantCompressor,
      index,
      log: (event) => events.push(event),
      mode: "manual",
      monotonicNow: () => clock,
    });
  }

  async function store(bytes: Uint8Array, mediaType = "text/javascript"): Promise<StoredSource> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await blobs.put({
      body: new ReadableStream({start: (controller) => {
        controller.enqueue(bytes);
        controller.close();
      }}),
      sha256,
      size: bytes.byteLength,
    });
    return {bytes, mediaType, sha256, size: bytes.byteLength};
  }

  async function readBlob(sha256: string): Promise<Uint8Array> {
    const opened = await blobs.open(sha256);
    return new Uint8Array(await new Response(opened.body).arrayBuffer());
  }

  test("foundation: a scheduled source becomes a stored Brotli blob after a drain", async () => {
    const service = variants();
    const source = await store(compressibleText);
    expect(await service.find(source.sha256)).toBeNull();
    service.schedule(source.sha256, source.size);
    await service.drain();
    clock += 30_001;
    const mapping = await service.find(source.sha256);
    expect(mapping?.encoderId).toBe(brotliVariantEncoderId);
    const variant = await readBlob(mapping?.variantSha256 ?? "");
    expect(variant.byteLength).toBe(mapping?.variantSize);
    expect(new Uint8Array(brotliDecompressSync(variant))).toEqual(compressibleText);
    expect(events.map((event) => event.outcome)).toEqual(["built"]);
  });

  test("foundation: a miss stays cached for 30 seconds unless this process built the variant", async () => {
    const service = variants();
    const source = await store(compressibleText);
    expect(await service.find(source.sha256)).toBeNull();
    // Another process records the mapping; this process still trusts its recent miss.
    const builder = variants();
    expect(await builder.build(source)).toBe("built");
    expect(await service.find(source.sha256)).toBeNull();
    clock += 30_001;
    expect(await service.find(source.sha256)).not.toBeNull();
  });

  test("foundation: an unusable variant is rebuilt even though its mapping exists", async () => {
    const service = variants();
    const source = await store(compressibleText);
    expect(await service.build(source)).toBe("built");
    const mapping = await service.find(source.sha256);
    if (mapping === null) throw new Error("The variant was not recorded.");
    const variantPath = path.join(blobRoot, mapping.variantSha256.slice(0, 2), mapping.variantSha256);
    await unlink(variantPath);
    service.reportUnusable(mapping);
    await service.drain();
    expect((await stat(variantPath)).size).toBe(mapping.variantSize);
  });

  test("foundation: the backfill builds each digest once and counts every outcome", async () => {
    const service = variants();
    const compressible = await store(compressibleText);
    const incompressible = await store(new Uint8Array(randomBytes(64 * 1_024)));
    const small = await store(new TextEncoder().encode("tiny"));
    async function* sources() {
      yield compressible;
      yield compressible;
      yield incompressible;
      yield small;
      yield {mediaType: "text/javascript", sha256: "f".repeat(64), size: maximumVariantSourceBytes + 1};
      yield {mediaType: "image/png", sha256: "e".repeat(64), size: 4_096};
    }
    expect(await service.backfill(sources(), 100)).toEqual({
      built: 1,
      examined: 3,
      failed: 0,
      not_beneficial: 1,
      skipped: 0,
      too_large: 1,
    });
    const second = await service.backfill(sources(), 100);
    expect(second.built).toBe(0);
    expect(second.skipped).toBe(1);
  });

  test("CNT-011-F: incompressible and oversized sources store nothing, conflicts are rejected, and a 60 MiB build stays within memory", async () => {
    const service = variants();
    const incompressible = await store(new Uint8Array(randomBytes(256 * 1_024)));
    expect(await service.build(incompressible)).toBe("not_beneficial");
    clock += 30_001;
    expect(await service.find(incompressible.sha256)).toBeNull();

    expect(await service.build({mediaType: "text/javascript", sha256: "f".repeat(64), size: maximumVariantSourceBytes + 1}))
      .toBe("too_large");

    const compressible = await store(compressibleText);
    expect(await service.build(compressible)).toBe("built");
    clock += 30_001;
    const mapping = await service.find(compressible.sha256);
    if (mapping === null) throw new Error("The variant was not recorded.");
    await expect(index.record({...mapping, variantSha256: "c".repeat(64)})).rejects.toBeInstanceOf(ContentVariantConflict);

    const large = await store(new TextEncoder().encode(
      `const payload = "${randomBytes(45 * 1_048_576).toString("base64")}";\n`,
    ));
    const residentBaseline = process.memoryUsage().rss;
    let residentPeak = residentBaseline;
    const sampler = setInterval(() => {
      residentPeak = Math.max(residentPeak, process.memoryUsage().rss);
    }, 25);
    try {
      expect(await service.build(large)).toBe("built");
    } finally {
      clearInterval(sampler);
    }
    expect(residentPeak - residentBaseline).toBeLessThan(256 * 1_048_576);
  }, 180_000);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/application/content-variants.test.ts`
Expected: FAIL, because `src/application/content-variants.js` cannot be resolved.

- [ ] **Step 3: Implement the service**

Create `src/application/content-variants.ts`:

```ts
import {createHash} from "node:crypto";

import {
  brotliVariantEncoderId,
  type ContentVariantCompressor,
  type ContentVariantIndex,
  type ContentVariantMapping,
  isVariantEligible,
  maximumVariantSizeRatio,
  maximumVariantSourceBytes,
  type PublishedContentObserver,
} from "../core/content-variants.js";
import type {ManifestEntry} from "../core/model.js";
import type {BlobStore} from "../core/ports.js";

const maximumQueuedSources = 1_000;
const maximumCachedMappings = 10_000;
const missCacheMilliseconds = 30_000;

export type ContentVariantBuildOutcome = "built" | "failed" | "not_beneficial" | "skipped" | "too_large";

export interface ContentVariantBuildEvent {
  readonly durationMilliseconds: number;
  readonly error: string | null;
  readonly outcome: ContentVariantBuildOutcome;
  readonly sourceSha256: string;
  readonly sourceSize: number;
  readonly variantSize: number | null;
}

export interface ContentVariantBackfillReport {
  readonly built: number;
  readonly examined: number;
  readonly failed: number;
  readonly not_beneficial: number;
  readonly skipped: number;
  readonly too_large: number;
}

/** The fields of a manifest entry a build needs. */
export interface ContentVariantSource {
  readonly mediaType: string;
  readonly sha256: string;
  readonly size: number;
}

/** What the HTTP delivery path needs from the variant service. */
export interface ContentVariantDelivery {
  find(sourceSha256: string): Promise<ContentVariantMapping | null>;
  reportLookupFailure(error: unknown): void;
  reportUnusable(mapping: ContentVariantMapping): void;
  schedule(sourceSha256: string, sourceSize: number): void;
}

export interface ContentVariantDependencies {
  readonly blobs: Pick<BlobStore, "open" | "put">;
  readonly compressor: ContentVariantCompressor;
  readonly index: ContentVariantIndex;
  readonly log: (event: ContentVariantBuildEvent) => void;
  /** "manual" builds only on drain() or backfill(); tests use it for determinism. */
  readonly mode: "background" | "manual";
  /** Monotonic milliseconds for the miss cache; defaults to performance.now. */
  readonly monotonicNow?: () => number;
}

interface QueuedSource {
  readonly forceRebuild: boolean;
  readonly size: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Builds, finds, and backfills stored Brotli variants of eligible content. */
export class ContentVariants implements ContentVariantDelivery, PublishedContentObserver {
  readonly #dependencies: ContentVariantDependencies;
  readonly #mappings = new Map<string, ContentVariantMapping>();
  readonly #misses = new Map<string, number>();
  readonly #notBeneficial = new Set<string>();
  readonly #now: () => number;
  readonly #queue = new Map<string, QueuedSource>();
  #closed = false;
  #running: Promise<void> | null = null;

  constructor(dependencies: ContentVariantDependencies) {
    this.#dependencies = dependencies;
    this.#now = dependencies.monotonicNow ?? (() => performance.now());
  }

  readonly versionPublished = (entries: readonly ManifestEntry[]): void => {
    for (const entry of entries) {
      if (isVariantEligible(entry.mediaType, entry.size)) this.schedule(entry.sha256, entry.size);
    }
  };

  async find(sourceSha256: string): Promise<ContentVariantMapping | null> {
    const cached = this.#mappings.get(sourceSha256);
    if (cached !== undefined) return cached;
    const missUntil = this.#misses.get(sourceSha256);
    if (missUntil !== undefined && missUntil > this.#now()) return null;
    const found = await this.#dependencies.index.find({
      coding: "br",
      encoderId: brotliVariantEncoderId,
      sourceSha256,
    });
    if (found === null) {
      this.#misses.set(sourceSha256, this.#now() + missCacheMilliseconds);
      return null;
    }
    this.#remember(found);
    return found;
  }

  schedule(sourceSha256: string, sourceSize: number): void {
    this.#enqueue(sourceSha256, {forceRebuild: false, size: sourceSize});
  }

  reportUnusable(mapping: ContentVariantMapping): void {
    this.#mappings.delete(mapping.sourceSha256);
    this.#misses.set(mapping.sourceSha256, this.#now() + missCacheMilliseconds);
    this.#enqueue(mapping.sourceSha256, {forceRebuild: true, size: Number.NaN});
  }

  reportLookupFailure(error: unknown): void {
    this.#dependencies.log({
      durationMilliseconds: 0,
      error: errorText(error),
      outcome: "failed",
      sourceSha256: "",
      sourceSize: 0,
      variantSize: null,
    });
  }

  /** Runs every queued build to completion. */
  async drain(): Promise<void> {
    if (this.#running !== null) await this.#running;
    await this.#runQueue();
  }

  async build(source: ContentVariantSource): Promise<ContentVariantBuildOutcome> {
    return this.#build(source.sha256, source.size, false);
  }

  async backfill(
    sources: AsyncIterable<ContentVariantSource>,
    limit: number,
  ): Promise<ContentVariantBackfillReport> {
    const counts = {built: 0, examined: 0, failed: 0, not_beneficial: 0, skipped: 0, too_large: 0};
    const seen = new Set<string>();
    for await (const source of sources) {
      if (counts.examined >= limit) break;
      if (!isVariantEligible(source.mediaType, source.size) || seen.has(source.sha256)) continue;
      seen.add(source.sha256);
      counts.examined += 1;
      // eslint-disable-next-line no-await-in-loop -- the backfill builds one variant at a time
      const outcome = await this.#build(source.sha256, source.size, false);
      counts[outcome] += 1;
    }
    return counts;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#queue.clear();
    if (this.#running !== null) await this.#running;
  }

  #remember(mapping: ContentVariantMapping): void {
    this.#misses.delete(mapping.sourceSha256);
    this.#mappings.delete(mapping.sourceSha256);
    this.#mappings.set(mapping.sourceSha256, mapping);
    if (this.#mappings.size > maximumCachedMappings) {
      const oldest = this.#mappings.keys().next().value;
      if (oldest !== undefined) this.#mappings.delete(oldest);
    }
  }

  #enqueue(sourceSha256: string, queued: QueuedSource): void {
    if (this.#closed || this.#notBeneficial.has(sourceSha256)) return;
    const existing = this.#queue.get(sourceSha256);
    if (existing !== undefined && (existing.forceRebuild || !queued.forceRebuild)) return;
    this.#queue.delete(sourceSha256);
    this.#queue.set(sourceSha256, queued);
    if (this.#queue.size > maximumQueuedSources) {
      const oldest = this.#queue.keys().next().value;
      if (oldest !== undefined) this.#queue.delete(oldest);
    }
    if (this.#dependencies.mode === "background" && this.#running === null) {
      this.#running = this.#runQueue().finally(() => {
        this.#running = null;
      });
    }
  }

  async #runQueue(): Promise<void> {
    for (;;) {
      const next = this.#queue.entries().next().value;
      if (next === undefined || this.#closed) return;
      const [sourceSha256, queued] = next;
      this.#queue.delete(sourceSha256);
      // eslint-disable-next-line no-await-in-loop -- one build per process at a time
      await this.#build(sourceSha256, queued.size, queued.forceRebuild);
    }
  }

  async #build(
    sourceSha256: string,
    declaredSize: number,
    forceRebuild: boolean,
  ): Promise<ContentVariantBuildOutcome> {
    const started = this.#now();
    const finish = (
      outcome: ContentVariantBuildOutcome,
      variantSize: number | null,
      error: string | null,
    ): ContentVariantBuildOutcome => {
      this.#dependencies.log({
        durationMilliseconds: this.#now() - started,
        error,
        outcome,
        sourceSha256,
        sourceSize: declaredSize,
        variantSize,
      });
      return outcome;
    };
    try {
      const key = {coding: "br", encoderId: brotliVariantEncoderId, sourceSha256} as const;
      if (!forceRebuild) {
        const existing = await this.#dependencies.index.find(key);
        if (existing !== null) {
          this.#remember(existing);
          return finish("skipped", existing.variantSize, null);
        }
      }
      if (this.#notBeneficial.has(sourceSha256)) return finish("not_beneficial", null, null);
      if (declaredSize > maximumVariantSourceBytes) return finish("too_large", null, null);
      const source = await this.#dependencies.blobs.open(sourceSha256);
      if (source.size > maximumVariantSourceBytes) {
        await source.body.cancel();
        return finish("too_large", null, null);
      }
      const limit = Math.floor(source.size * maximumVariantSizeRatio);
      const compressed = await this.#dependencies.compressor.compress(source.body, limit);
      if (compressed === null) {
        this.#notBeneficial.add(sourceSha256);
        return finish("not_beneficial", null, null);
      }
      const variantSha256 = createHash("sha256").update(compressed).digest("hex");
      await this.#dependencies.blobs.put({
        body: streamOf(compressed),
        sha256: variantSha256,
        size: compressed.byteLength,
      });
      const mapping: ContentVariantMapping = {...key, variantSha256, variantSize: compressed.byteLength};
      await this.#dependencies.index.record(mapping);
      this.#remember(mapping);
      return finish("built", compressed.byteLength, null);
    } catch (error) {
      return finish("failed", null, errorText(error));
    }
  }
}
```

Notes for the implementer:
- `reportUnusable` queues with an unknown size (`NaN`). `#build` then reads the real size from `blobs.open`, and `NaN > maximumVariantSourceBytes` is false, so the declared-size shortcut is skipped.
- `counts[outcome] += 1` requires the counts object's keys to match `ContentVariantBuildOutcome` exactly. If the type checker rejects the indexed write, build the counts with an explicit `switch`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/application/content-variants.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint and commit**

Run: `pnpm exec oxlint --type-aware --type-check --deny-warnings src/application/content-variants.ts tests/application`
Expected: no diagnostics.

```bash
git add src/application/content-variants.ts tests/application/content-variants.test.ts
git commit -m "Add the content variant builder, lookup cache, and backfill

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Serve stored variants (CNT-010) and remove the streaming encoder

**Files:**
- Modify: `src/http/create-http-app.ts` (`HttpAppDependencies`; `serveStoredVersionContent`; delete `selectContentCoding`)
- Delete: `src/http/node-content-encoder.ts`
- Modify: `src/http/content-encoding.ts` (delete `ContentEncoder`)
- Modify: `src/local/create-local-runtime.ts`, `src/local/start-local-server.ts`, `src/external-storage/create-external-storage-runtime.ts` (composition and drain)
- Modify: `tests/support/runtime-harness.ts` (`contentVariantBuilds` option, `drainContentVariants`)
- Rewrite: `tests/http/content-delivery-compression.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - `HttpAppDependencies.contentVariants?: ContentVariantDelivery`
  - `LocalRuntimeConfig.contentVariantBuilds?: "background" | "manual"`
  - `LocalRuntime.drainContentVariants(): Promise<void>`, and the same on `RunningLocalServer` and `RunningTestServer`
  - `startTestServer(installation, {contentVariantBuilds})`, defaulting to `"manual"`

- [ ] **Step 1: Rewrite the CNT-010 tests (failing)**

Replace `tests/http/content-delivery-compression.test.ts` with:

```ts
import {createHash} from "node:crypto";
import {readdir, unlink} from "node:fs/promises";
import path from "node:path";
import {brotliDecompressSync} from "node:zlib";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const encoder = new TextEncoder();
const scriptPath = "assets/rows.js";
const scriptBytes = encoder.encode(`export const rows = [\n${
  Array.from({length: 400}, (_, index) => `  {"id": "row-${index}", "status": "awaiting-review"},`).join("\n")
}\n];\n`);
const scriptDigest = createHash("sha256").update(scriptBytes).digest("hex");
const binaryBytes = new Uint8Array(4096).map((_, index) => index % 251);
const belowThresholdBytes = encoder.encode("x".repeat(1023));

const leaseResponseSchema = z.object({baseUrl: z.url()});
const bootstrapResponseSchema = z.object({bootstrapUrl: z.url()});

function decodeBrotli(bytes: ArrayBuffer): Uint8Array {
  return new Uint8Array(brotliDecompressSync(Buffer.from(bytes)));
}

function siteFiles(extra: readonly TestSiteFile[] = []): readonly TestSiteFile[] {
  return [
    {bytes: encoder.encode("<!doctype html><title>Compression</title>"), mediaType: "text/html; charset=utf-8", path: "index.html"},
    {bytes: scriptBytes, mediaType: "text/javascript; charset=utf-8", path: scriptPath},
    ...extra,
  ];
}

describe("stored content variants", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let blobBytesRead = 0;

  beforeEach(async () => {
    installation = await createTestInstallation();
    blobBytesRead = 0;
    server = await startTestServer(installation, {
      blobReadObserver: {
        bytesRead: (byteLength) => {
          blobBytesRead += byteLength;
        },
        streamClosed: () => undefined,
      },
      contentVariantBuilds: "manual",
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function publishSite(
    accessSetting: "account_required" | "public_link",
    idempotencyKey: string,
    extra: readonly TestSiteFile[] = [],
  ): Promise<PublishResponse> {
    const files = siteFiles(extra);
    const upload = await createStagedUpload(server, installation, "index.html", files);
    await uploadEveryStagedFile(installation, upload.body, files);
    const committed = await commitStagedUpload(installation, upload.body, idempotencyKey, {
      accessSetting,
      kind: "new_artifact",
      name: `Variants ${idempotencyKey}`,
      tags: [],
    });
    expect(committed.response.status).toBe(201);
    return committed.body;
  }

  async function issuePreviewLease(published: PublishResponse): Promise<string> {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/preview-leases?projectId=${published.artifact.projectId}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}, method: "POST"},
    );
    expect(response.status).toBe(201);
    return leaseResponseSchema.parse(await response.json()).baseUrl;
  }

  async function openContentSession(published: PublishResponse): Promise<{readonly cookie: string; readonly origin: string}> {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/content-sessions`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}, method: "POST"},
    );
    expect(response.status).toBe(201);
    const issued = bootstrapResponseSchema.parse(await response.json());
    const exchange = await fetchVersion(server, issued.bootstrapUrl);
    const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
    if (cookie === undefined) throw new Error("The content session set no cookie.");
    return {cookie, origin: new URL(issued.bootstrapUrl).origin};
  }

  test("foundation: the blob read observer counts a full identity read", async () => {
    const published = await publishSite("public_link", "observer-full-read");
    const response = await fetchVersion(server, new URL(scriptPath, published.links.version).toString());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(blobBytesRead).toBe(scriptBytes.byteLength);
  });

  test("CNT-010-B: eligible content is identity before its variant exists and stored br afterwards", async () => {
    const privateSite = await publishSite("account_required", "cnt-010-b-private");
    const publicSite = await publishSite("public_link", "cnt-010-b-public");
    const session = await openContentSession(privateSite);
    const targets = [
      {cookie: null, url: new URL(scriptPath, await issuePreviewLease(privateSite)).toString()},
      {cookie: null, url: new URL(scriptPath, publicSite.links.version).toString()},
      {cookie: session.cookie, url: new URL(scriptPath, session.origin).toString()},
    ];
    for (const target of targets) {
      const base: Record<string, string> = target.cookie === null ? {} : {Cookie: target.cookie};
      // eslint-disable-next-line no-await-in-loop -- the miss must precede the drain
      const miss = await fetchVersion(server, target.url, "GET", {...base, "Accept-Encoding": "br"});
      expect(miss.status).toBe(200);
      expect(miss.headers.get("content-encoding")).toBeNull();
      expect(miss.headers.get("accept-ranges")).toBe("bytes");
      expect(miss.headers.get("etag")).toBe(`"${scriptDigest}"`);
      expect(miss.headers.get("vary")).toContain("Accept-Encoding");
      // eslint-disable-next-line no-await-in-loop -- the body belongs to this response
      expect(new Uint8Array(await miss.arrayBuffer())).toEqual(scriptBytes);
    }
    await server.drainContentVariants();
    for (const target of targets) {
      const base: Record<string, string> = target.cookie === null ? {} : {Cookie: target.cookie};
      // eslint-disable-next-line no-await-in-loop -- each request is asserted on its own
      const hit = await fetchVersion(server, target.url, "GET", {...base, "Accept-Encoding": "gzip, br"});
      expect(hit.status).toBe(200);
      expect(hit.headers.get("content-encoding")).toBe("br");
      expect(hit.headers.get("accept-ranges")).toBeNull();
      expect(hit.headers.get("etag")).toBe(`W/"${scriptDigest}"`);
      expect(hit.headers.get("vary")).toContain("Accept-Encoding");
      // eslint-disable-next-line no-await-in-loop -- the body belongs to this response
      const body = await hit.arrayBuffer();
      expect(hit.headers.get("content-length")).toBe(String(body.byteLength));
      expect(decodeBrotli(body)).toEqual(scriptBytes);

      // eslint-disable-next-line no-await-in-loop -- HEAD mirrors the GET just made
      const head = await fetchVersion(server, target.url, "HEAD", {...base, "Accept-Encoding": "br"});
      expect(head.headers.get("content-encoding")).toBe("br");
      expect(head.headers.get("content-length")).toBe(String(body.byteLength));
      expect(head.headers.get("etag")).toBe(`W/"${scriptDigest}"`);

      // eslint-disable-next-line no-await-in-loop -- revalidation follows the reads
      const revalidated = await fetchVersion(server, target.url, "GET", {
        ...base,
        "Accept-Encoding": "br",
        "If-None-Match": `W/"${scriptDigest}"`,
      });
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get("etag")).toBe(`W/"${scriptDigest}"`);
      expect(revalidated.headers.get("content-encoding")).toBeNull();
    }
  }, 60_000);

  test("CNT-010-F: ranges, refusals, small, binary, and unusable variants are served identity", async () => {
    const published = await publishSite("account_required", "cnt-010-f-identity-fallbacks", [
      {bytes: binaryBytes, mediaType: "application/octet-stream", path: "assets/blob.bin"},
      {bytes: belowThresholdBytes, mediaType: "text/javascript", path: "assets/below.js"},
    ]);
    const lease = await issuePreviewLease(published);
    const at = (entryPath: string) => new URL(entryPath, lease).toString();
    const size = scriptBytes.byteLength;
    await fetchVersion(server, at(scriptPath), "GET", {"Accept-Encoding": "br"});
    await server.drainContentVariants();

    const partial = await fetchVersion(server, at(scriptPath), "GET", {"Accept-Encoding": "br", Range: "bytes=0-9"});
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-encoding")).toBeNull();
    expect(partial.headers.get("content-range")).toBe(`bytes 0-9/${size}`);

    const weakIfRange = await fetchVersion(server, at(scriptPath), "GET", {
      "Accept-Encoding": "br",
      "If-Range": `W/"${scriptDigest}"`,
      Range: "bytes=0-9",
    });
    expect(weakIfRange.status).toBe(200);
    expect(weakIfRange.headers.get("content-encoding")).toBeNull();
    expect(new Uint8Array(await weakIfRange.arrayBuffer())).toEqual(scriptBytes);

    for (const refusal of ["gzip", "identity", "br;q=0, gzip", "br;q=0.0", "*"]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is asserted on its own
      const refused = await fetchVersion(server, at(scriptPath), "GET", {"Accept-Encoding": refusal});
      expect({
        acceptRanges: refused.headers.get("accept-ranges"),
        contentEncoding: refused.headers.get("content-encoding"),
        refusal,
      }).toEqual({acceptRanges: "bytes", contentEncoding: null, refusal});
    }

    const identityRevalidation = await fetchVersion(server, at(scriptPath), "GET", {
      "Accept-Encoding": "br",
      "If-None-Match": `"${scriptDigest}"`,
    });
    expect(identityRevalidation.status).toBe(304);
    expect(identityRevalidation.headers.get("etag")).toBe(`"${scriptDigest}"`);
    expect(identityRevalidation.headers.get("content-encoding")).toBeNull();

    for (const entryPath of ["assets/blob.bin", "assets/below.js"]) {
      // eslint-disable-next-line no-await-in-loop -- read once to queue, then confirm nothing was stored
      await fetchVersion(server, at(entryPath), "GET", {"Accept-Encoding": "br"});
    }
    await server.drainContentVariants();
    for (const entryPath of ["assets/blob.bin", "assets/below.js"]) {
      // eslint-disable-next-line no-await-in-loop -- each entry is asserted on its own
      const ineligible = await fetchVersion(server, at(entryPath), "GET", {"Accept-Encoding": "br"});
      expect(ineligible.headers.get("content-encoding")).toBeNull();
      expect(ineligible.headers.get("accept-ranges")).toBe("bytes");
    }

    const hit = await fetchVersion(server, at(scriptPath), "GET", {"Accept-Encoding": "br"});
    const variantBytes = new Uint8Array(await hit.arrayBuffer());
    const variantDigest = createHash("sha256").update(variantBytes).digest("hex");
    const blobRoot = path.join(installation.dataDirectory, "blobs");
    const variantPath = path.join(blobRoot, variantDigest.slice(0, 2), variantDigest);
    expect(await readdir(path.dirname(variantPath))).toContain(variantDigest);
    await unlink(variantPath);
    const unusable = await fetchVersion(server, at(scriptPath), "GET", {"Accept-Encoding": "br"});
    expect(unusable.status).toBe(200);
    expect(unusable.headers.get("content-encoding")).toBeNull();
    expect(new Uint8Array(await unusable.arrayBuffer())).toEqual(scriptBytes);
    await server.drainContentVariants();
    expect(await readdir(path.dirname(variantPath))).toContain(variantDigest);
  }, 60_000);
});
```

Add the option and the drain to the harness first, so the test fails on behavior rather than compilation. In `tests/support/runtime-harness.ts`:
- Add `readonly contentVariantBuilds?: "background" | "manual";` to the `startTestServer` options.
- Pass `contentVariantBuilds: options.contentVariantBuilds ?? "manual"` into the `baseConfig`.
- Add `drainContentVariants(): Promise<void>` to `RunningTestServer`, delegating to the started local server's `drainContentVariants()`.

In `src/local/create-local-runtime.ts`, add `readonly contentVariantBuilds?: "background" | "manual";` (with a doc comment saying it is never read from the environment) to `LocalRuntimeConfig`, and `drainContentVariants(): Promise<void>` to `LocalRuntime`, returning `Promise.resolve()` for now. In `src/local/start-local-server.ts`, expose `drainContentVariants: () => runtime.drainContentVariants()` on `RunningLocalServer`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/http/content-delivery-compression.test.ts`
Expected: the CNT-010-B test fails at the first miss, receiving `br` from the streaming encoder. Make sure it fails on that behavior rather than compilation.

- [ ] **Step 3: Select stored variants in `serveStoredVersionContent`**

In `src/http/create-http-app.ts`:

1. Imports: remove `ContentCoding` and `ContentEncoder` from the `./content-encoding.js` import, keeping `appendAcceptEncodingVary` and `negotiateContentCoding`. Add:

```ts
import type {ContentVariantDelivery} from "../application/content-variants.js";
import {isVariantEligible} from "../core/content-variants.js";
```

2. In `HttpAppDependencies`, replace the `contentEncoder` field and its comment with:

```ts
  /**
   * Finds stored Brotli variants of eligible version content. Node runtimes
   * supply it; the Workers runtime leaves it absent because its edge compresses.
   */
  readonly contentVariants?: ContentVariantDelivery;
```

3. Replace `serveStoredVersionContent` from `const strongEtag` down to the end of the 304 branch with:

```ts
  const strongEtag = `"${content.entry.sha256}"`;
  const variants = dependencies.contentVariants;
  const eligible = variants !== undefined
    && isVariantEligible(content.entry.mediaType, content.entry.size);
  if (eligible) appendAcceptEncodingVary(headers);
  const ifNoneMatch = context.req.header("if-none-match");
  if (etagMatches(ifNoneMatch, strongEtag)) {
    headers.delete("Content-Length");
    // Echo the validator the client holds; a 304 never relabels a cached copy's coding.
    const heldTags = (ifNoneMatch ?? "").split(",").map((tag) => tag.trim());
    if (heldTags.includes(`W/${strongEtag}`) && !heldTags.includes(strongEtag)) {
      headers.set("ETag", `W/${strongEtag}`);
    }
    return new Response(null, {headers, status: 304});
  }

  if (eligible && context.req.header("range") === undefined) {
    const variant = await openStoredVariant(context, content.entry, variants, dependencies.blobs);
    if (variant !== null) {
      headers.set("Content-Encoding", "br");
      headers.set("Content-Length", String(variant.size));
      headers.delete("Accept-Ranges");
      headers.set("ETag", `W/${strongEtag}`);
      return new Response(variant.body, {headers, status: 200});
    }
  }
```

The rest of the function (range decision, 416, HEAD, partial, full identity) stays, except the final full response: delete the `const body = coding === null ...` lines and return `new Response(blob.body, {headers, status: 200})`.

4. Delete `selectContentCoding`. Add after `serveStoredVersionContent`:

```ts
interface StoredVariantBody {
  /** Null for HEAD: the size was verified without reading the body. */
  readonly body: ReadableStream<Uint8Array> | null;
  readonly size: number;
}

/**
 * Opens the stored Brotli variant for one eligible entry, or returns null so
 * the caller serves identity. A miss queues a build; an unusable variant is
 * reported for rebuilding. Nothing here fails the request.
 */
async function openStoredVariant(
  context: Context<HttpEnvironment>,
  entry: ManifestEntry,
  variants: ContentVariantDelivery,
  blobs: BlobStore,
): Promise<StoredVariantBody | null> {
  const span = context.get("requestSpan");
  if (negotiateContentCoding(context.req.header("accept-encoding") ?? null) !== "br") {
    span.attribute("content.variant", "ineligible");
    return null;
  }
  let mapping: ContentVariantMapping | null;
  try {
    mapping = await variants.find(entry.sha256);
  } catch (error) {
    variants.reportLookupFailure(error);
    span.attribute("content.variant", "error");
    return null;
  }
  if (mapping === null) {
    variants.schedule(entry.sha256, entry.size);
    span.attribute("content.variant", "miss");
    return null;
  }
  try {
    if (context.req.method === "HEAD") {
      const stored = await blobs.inspect(mapping.variantSha256);
      if (stored.size !== mapping.variantSize) throw new Error("The stored variant has the wrong size.");
      span.attribute("content.variant", "hit");
      return {body: null, size: stored.size};
    }
    const opened = await blobs.open(mapping.variantSha256);
    if (opened.size !== mapping.variantSize) {
      await opened.body.cancel();
      throw new Error("The stored variant has the wrong size.");
    }
    span.attribute("content.variant", "hit");
    return {body: opened.body, size: opened.size};
  } catch {
    variants.reportUnusable(mapping);
    span.attribute("content.variant", "error");
    return null;
  }
}
```

Import `ContentVariantMapping` as a type from `../core/content-variants.js` and `BlobStore` and `ManifestEntry` if they are not already imported.

5. Delete `src/http/node-content-encoder.ts` and the `ContentEncoder` interface in `src/http/content-encoding.ts`.

- [ ] **Step 4: Compose the service in both Node runtimes**

In `src/local/create-local-runtime.ts`:

```ts
import {ContentVariants} from "../application/content-variants.js";
import {nodeBrotliVariantCompressor} from "../http/node-variant-compressor.js";
import {SqliteContentVariantIndex} from "../storage/sqlite-content-variant-index.js";
```

Remove the `nodeContentEncoder` import and the `contentEncoder: nodeContentEncoder,` line. After `applicationRuntime` exists and before `appDependenciesWithoutOAuth`:

```ts
    const contentVariantIndex = new SqliteContentVariantIndex(databasePath, installationId, runtimeClock);
    const contentVariants = new ContentVariants({
      blobs,
      compressor: nodeBrotliVariantCompressor,
      index: contentVariantIndex,
      log: (event) => {
        applicationRuntime.runFork(Effect.logInfo("Content variant build finished.").pipe(
          Effect.annotateLogs({
            content_variant_duration_ms: Math.round(event.durationMilliseconds),
            content_variant_error: event.error ?? "",
            content_variant_outcome: event.outcome,
            content_variant_source_bytes: event.sourceSize,
            content_variant_source_sha256: event.sourceSha256,
            content_variant_variant_bytes: event.variantSize ?? -1,
          }),
        ));
      },
      mode: config.contentVariantBuilds ?? "background",
    });
```

Add `contentVariants,` to `appDependenciesWithoutOAuth`. In the returned runtime, implement `drainContentVariants: () => contentVariants.drain()`. In `close`, before `applicationRuntime.dispose()`:

```ts
        await contentVariants.close();
        contentVariantIndex.close();
```

Use the variable names `create-local-runtime.ts` actually uses for the database path, installation id, and clock (`databasePath`, `installationId`, and `runtimeClock` at about lines 148–152). Import `Effect` from `effect` if it isn't already imported.

In `src/external-storage/create-external-storage-runtime.ts`, do the same with `new PostgresContentVariantIndex(database, config.installationId, runtimeClock)`, the `mode` fixed to `"background"`, `contentVariants,` in `appDependenciesWithoutOAuth`, and `await contentVariants.close()` in `close` before disposing the runtime. Remove its `nodeContentEncoder` import and line.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run tests/http/content-delivery-compression.test.ts tests/http/node-response-compression.test.ts`
Expected: PASS (3 tests in the rewritten file). If `context.get("requestSpan")` is undefined for content-host requests, read the request middleware in `create-http-app.ts` near line 700 and use the same span access the middleware guarantees; never drop the attribute silently.

Then run the full suite: `pnpm test > "$TMPDIR/variants-t6.log" 2>&1; grep -E "Test Files |Tests " "$TMPDIR/variants-t6.log"`
Expected: all pass. Restore regenerated evidence with `git checkout -- project/evidence/local-foundation.json project/evidence/storage-shutdown.json`.

- [ ] **Step 6: Lint, typecheck, commit**

Run: `pnpm lint && pnpm typecheck`
Expected: exit 0.

```bash
git rm src/http/node-content-encoder.ts
git add src/http/create-http-app.ts src/http/content-encoding.ts src/local/create-local-runtime.ts src/local/start-local-server.ts src/external-storage/create-external-storage-runtime.ts tests/support/runtime-harness.ts tests/http/content-delivery-compression.test.ts
git commit -m "Serve stored Brotli variants and stop compressing per request

A hit serves the stored variant with a real Content-Length; a miss serves
identity bytes and queues a background build. The streaming encoder is removed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Publish trigger, backfill, and the maintenance command (CNT-011-B)

**Files:**
- Create: `src/application/current-version-entries.ts`
- Modify: `src/application/publish-artifact.ts` (`PublishArtifactDependencies.publishedContent`; notify after both commits)
- Modify: `src/local/create-local-application-layer.ts` (`ApplicationAdapters.publishedContent` into `publishDependencies`)
- Modify: `src/local/create-local-runtime.ts`, `src/local/start-local-server.ts`, `src/external-storage/create-external-storage-runtime.ts` (pass the observer; `buildContentVariants`)
- Modify: `src/cli/lifecycle-commands.ts` (`maintenance build-content-variants`)
- Modify: `tests/support/runtime-harness.ts` (`buildContentVariants` pass-through)
- Test: `tests/http/content-variant-builds.test.ts`

**Interfaces:**
- Consumes: `ContentVariants.versionPublished`, `backfill`, and `ContentVariantBackfillReport` (Task 5).
- Produces:
  - `currentVersionEntries(catalog: CurrentVersionCatalog): AsyncGenerator<ManifestEntry>`
  - `LocalRuntime.buildContentVariants(limit: number): Promise<ContentVariantBackfillReport>`, and the same on `ExternalStorageRuntime`, `RunningLocalServer`, and `RunningTestServer`

- [ ] **Step 1: Write the failing test**

Create `tests/http/content-variant-builds.test.ts`:

```ts
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const encoder = new TextEncoder();

function script(label: string): Uint8Array {
  return encoder.encode(Array.from({length: 600}, (_, index) => `window.${label}.push({"row": ${index}});`).join("\n"));
}

describe("content variant builds", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;

  beforeEach(async () => {
    installation = await createTestInstallation();
  });

  afterEach(async () => {
    await server?.stop();
    server = null;
    await removeTestInstallation(installation);
  });

  async function publish(running: RunningTestServer, key: string, files: readonly TestSiteFile[]): Promise<PublishResponse> {
    const upload = await createStagedUpload(running, installation, "index.html", files);
    await uploadEveryStagedFile(installation, upload.body, files);
    const committed = await commitStagedUpload(installation, upload.body, key, {
      accessSetting: "public_link",
      kind: "new_artifact",
      name: `Builds ${key}`,
      tags: [],
    });
    expect(committed.response.status).toBe(201);
    return committed.body;
  }

  function site(label: string): readonly TestSiteFile[] {
    return [
      {bytes: encoder.encode("<!doctype html><title>Builds</title>"), mediaType: "text/html", path: "index.html"},
      {bytes: script(label), mediaType: "text/javascript", path: "app.js"},
      {bytes: script("shared"), mediaType: "text/javascript", path: "shared.js"},
    ];
  }

  async function encodingOf(running: RunningTestServer, published: PublishResponse, entryPath: string): Promise<string | null> {
    const response = await fetchVersion(
      running,
      new URL(entryPath, published.links.version).toString(),
      "GET",
      {"Accept-Encoding": "br"},
    );
    return response.headers.get("content-encoding");
  }

  test("CNT-011-B: publishing builds variants, the backfill counts each digest once, and mappings survive restart", async () => {
    const background = await startTestServer(installation, {contentVariantBuilds: "background"});
    server = background;
    const first = await publish(background, "cnt-011-b-background-site", site("first"));
    await expect.poll(() => encodingOf(background, first, "app.js"), {interval: 100, timeout: 10_000}).toBe("br");
    await background.stop();

    const manual = await startTestServer(installation, {contentVariantBuilds: "manual"});
    server = manual;
    expect(await encodingOf(manual, first, "app.js")).toBe("br");
    const second = await publish(manual, "cnt-011-b-manual-site-two", site("second"));
    const report = await manual.buildContentVariants(1_000);
    expect(report).toMatchObject({built: 1, failed: 0});
    expect(report.skipped).toBe(2);
    expect(await encodingOf(manual, second, "app.js")).toBe("br");
    expect(await encodingOf(manual, second, "shared.js")).toBe("br");
    const again = await manual.buildContentVariants(1_000);
    expect(again).toMatchObject({built: 0, failed: 0, skipped: 3});
  }, 60_000);
});
```

The counts follow from the fixtures. After the background publish, `first/app.js` and `shared.js` are built. The backfill then sees `first/app.js` (skipped), `shared.js` (skipped, same digest in both sites), and `second/app.js` (built). The second run skips all three. `index.html` is under 1 KiB and isn't examined.

Add to `tests/support/runtime-harness.ts`: `buildContentVariants(limit: number): Promise<ContentVariantBackfillReport>` on `RunningTestServer`, delegating to the server.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/http/content-variant-builds.test.ts`
Expected: FAIL. Either the type check fails because `buildContentVariants` is missing, or the poll times out because nothing is built on publish.

- [ ] **Step 3: Notify after publication commits**

In `src/application/publish-artifact.ts`:

```ts
import type {PublishedContentObserver} from "../core/content-variants.js";
```

Add `readonly publishedContent?: PublishedContentObserver;` to `PublishArtifactDependencies`. In `publishPreparedNew`, replace `return yield* dependencies.repository.commitNewArtifact({...});` with:

```ts
    const published = yield* dependencies.repository.commitNewArtifact({
      // ...the existing fields, unchanged...
    });
    notifyPublished(dependencies, published, command.manifest);
    return published;
```

Do the same around `commitVersion` in `publishPreparedVersion`. Add the helper at module level:

```ts
/** Queue follow-up work for a newly committed version; never fails publication. */
function notifyPublished(
  dependencies: PublishArtifactDependencies,
  published: PublishedVersion,
  manifest: CanonicalManifest,
): void {
  if (published.replayed) return;
  try {
    dependencies.publishedContent?.versionPublished(manifest.entries);
  } catch {
    // The observer only queues optional work; publication has already committed.
  }
}
```

In `src/local/create-local-application-layer.ts`, add `readonly publishedContent?: PublishedContentObserver;` to `ApplicationAdapters` and include it in `publishDependencies`:

```ts
    ...(adapters.publishedContent === undefined ? {} : {publishedContent: adapters.publishedContent}),
```

If `anti-slop/no-conditional-empty-object-spread` rejects that spread, build `publishDependencies` first and then assign it with `Object.assign` when present, as `create-local-runtime.ts` does for `gitHistoryProvider`.

In both runtimes, construct `contentVariants` before `applicationAdapters` and add `publishedContent: contentVariants` to the adapters. In `create-local-runtime.ts` that means moving the `ContentVariants` construction from Task 6 earlier, before `applicationAdapters` (about line 245). Its `log` callback needs `applicationRuntime`, which doesn't exist yet at that point. Use a `let logRuntime: ApplicationRuntime | null = null` that the callback checks, and assign it once `applicationRuntime` is created.

- [ ] **Step 4: Current-version iteration and the runtime method**

Create `src/application/current-version-entries.ts`:

```ts
import type {ManifestEntry} from "../core/model.js";
import type {ArtifactRepository, PageCursor, ProjectRepository} from "../core/ports.js";

/** The repository reads the backfill needs. */
export type CurrentVersionCatalog = Pick<ProjectRepository, "listProjects">
  & Pick<ArtifactRepository, "findVersionRecord" | "listArtifacts">;

const artifactPageSize = 100;

/** Every manifest entry of every project's current versions, one artifact at a time. */
export async function* currentVersionEntries(
  catalog: CurrentVersionCatalog,
): AsyncGenerator<ManifestEntry> {
  for (const project of await catalog.listProjects()) {
    let cursor: PageCursor | null = null;
    do {
      // eslint-disable-next-line no-await-in-loop -- each page names the next cursor
      const page = await catalog.listArtifacts({
        comments: "all",
        cursor,
        limit: artifactPageSize,
        projectId: project.id,
        sort: "newest",
        tags: [],
      });
      for (const artifact of page.items) {
        // eslint-disable-next-line no-await-in-loop -- versions are read one artifact at a time
        const current = await catalog.findVersionRecord(project.id, artifact.id, artifact.currentVersionId);
        if (current !== null) yield* current.manifest.entries;
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  }
}
```

If `PageCursor` is exported from `model.ts` rather than `ports.ts`, import it from there. If `listArtifacts` caps `limit` below 100, use the cap.

In both runtimes, add to the runtime interface and the returned object:

```ts
      buildContentVariants: (limit) => contentVariants.backfill(currentVersionEntries(repository), limit),
```

Use each runtime's repository variable. Add `buildContentVariants(limit: number): Promise<ContentVariantBackfillReport>` to `LocalRuntime` and `ExternalStorageRuntime`. Expose it on `RunningLocalServer` in `start-local-server.ts`.

- [ ] **Step 5: The maintenance command**

In `src/cli/lifecycle-commands.ts`, inside `configureMaintenance`, after `cleanup-staging`:

```ts
  maintenance
    .command("build-content-variants")
    .description("Build stored Brotli variants for every current version's eligible files.")
    .requiredOption("--once", "run one bounded pass and exit")
    .option("--limit <count>", "maximum distinct files to examine", "100000")
    .addOption(modeOption())
    .addOption(dataOption())
    .addOption(hostOption())
    .addOption(portOption())
    .action(async (options: CleanupStagingOptions) => {
      const configuration = await lifecycleConfiguration(options);
      const runtime = configuration.deploymentMode === "compact"
        ? await createLocalRuntime({...compactMaintenanceConfig(configuration), contentVariantBuilds: "manual"})
        : await createExternalStorageRuntime(externalMaintenanceConfig(configuration));
      try {
        const report = await runtime.buildContentVariants(parseVariantLimit(options.limit));
        console.log(JSON.stringify(report, null, 2));
        if (report.failed > 0) process.exitCode = 2;
      } finally {
        await runtime.close();
      }
    });
```

and at module level:

```ts
function parseVariantLimit(value: string): number {
  return z.coerce.number().int().min(1).max(1_000_000).parse(value);
}
```

Import `z` from `zod` if it isn't already imported. `CleanupStagingOptions` has the same flags; if its name reads wrongly here, rename it to a shared `MaintenanceOptions` in the same file. If `compactMaintenanceConfig` returns a type that can't take the spread, add the field the way the file sets other optional runtime fields.

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run tests/http/content-variant-builds.test.ts tests/http/content-delivery-compression.test.ts tests/application/content-variants.test.ts`
Expected: PASS.

Smoke-test the command against a scratch compact installation:

```bash
SCRATCH=$(mktemp -d) && node --import tsx src/cli/main.ts init --admin-email admin@example.test --data "$SCRATCH" && node --import tsx src/cli/main.ts maintenance build-content-variants --once --mode compact --data "$SCRATCH"; rm -rf "$SCRATCH"
```

Expected: a JSON report with all counts 0 and exit code 0. If `init` takes different flags, follow `configureInitialization` in the same file.

Then run the full suite, `pnpm test`. Expected: all pass. Restore regenerated evidence as in Task 2.

- [ ] **Step 7: Lint, typecheck, commit**

Run: `pnpm lint && pnpm typecheck && pnpm conformance:tests`
Expected: exit 0. `conformance:tests` fails on unknown IDs until Task 8 adds CNT-011; if so, run it again after Task 8 and note it in the Task 7 commit message.

```bash
git add src/application/current-version-entries.ts src/application/publish-artifact.ts src/local/create-local-application-layer.ts src/local/create-local-runtime.ts src/local/start-local-server.ts src/external-storage/create-external-storage-runtime.ts src/cli/lifecycle-commands.ts tests/support/runtime-harness.ts tests/http/content-variant-builds.test.ts
git commit -m "Build content variants after publish and add the backfill command

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Ledger, product sentence, gates, and the local "after" run

**Files:**
- Modify: `project/spec/artifact-server-product-spec.html` (the CNT-010 sentence, about line 2740)
- Modify: `project/spec/conformance.yml` (CNT-010 rewording; CNT-011)
- Create or modify: evidence regenerated by the gates; `project/evidence/delivery-baseline-<date>-local-after-variants.json`

- [ ] **Step 1: Product sentence**

Replace:

```html
                  download disposition. Media supports byte ranges. Eligible text responses are
                  compressed when the browser accepts it; byte-range requests always receive the
                  uncompressed bytes.
```

with:

```html
                  download disposition. Media supports byte ranges. Eligible text responses are
                  served from a stored Brotli copy when one exists and the browser accepts it;
                  byte-range requests always receive the uncompressed bytes.
```

- [ ] **Step 2: Ledger**

In `project/spec/conformance.yml`:
- Replace CNT-010's `behavior`, both acceptance descriptions, `status`, and `evidence` with the spec's CNT-010 block. Use `status: implementing` and `evidence: []`, and keep `proof_gap` naming Cloudflare and team deployments.
- Insert the spec's CNT-011 block after CNT-010, separated by one blank line on each side.

Run: `pnpm conformance:validate && pnpm conformance:tests`
Expected: both pass.

- [ ] **Step 3: Gates**

Run `pnpm smoke`. Expected: PASS.

Then run `pnpm verify:iteration > "$TMPDIR/variants-verify.log" 2>&1; echo $?` in the background and wait for it. Expected: exit 0. It needs Docker and includes the Postgres suite with the new test. If any stage fails, stop and report the command and its output tail.

- [ ] **Step 4: Record evidence**

When `project/evidence/local-foundation.json` shows CNT-010-B, CNT-010-F, CNT-011-B, and CNT-011-F passing:
- Set CNT-010 and CNT-011 to `behavior_verified`.
- Add a `local` evidence record to each, with `run: project/evidence/local-foundation.json` and `recorded_at` taken from the report's `startTime` converted to ISO 8601 UTC.
- Run `pnpm conformance:validate`. Expected: PASS.

- [ ] **Step 5: Local after run**

Run: `pnpm build && pnpm perf:delivery --label after-variants`
Expected: four journeys with `Timeouts` 0. On a fresh local server, publishing queues builds before the harness opens the prototype, so "Lease encoding" should read `br` and harness CPU per open should be lower than Task 1's run. Record both medians from the two reports' `localProcessCpuMilliseconds` aggregates for FINDINGS.

- [ ] **Step 6: Privacy check and commit**

Run the Task 1 privacy grep. Expected: `clean`.

```bash
git add project/spec/artifact-server-product-spec.html project/spec/conformance.yml project/evidence
git commit -m "Specify CNT-010 for stored variants, add CNT-011, and record local evidence

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Check with `git status --short` that `NEXT.md` wasn't staged; `project/evidence` must contain only regenerated reports.

---

### Task 9: Deploy gate, production backfill, hosted evidence, FINDINGS

**Files:**
- Modify: `project/performance/FINDINGS.md`
- Create: `project/evidence/delivery-baseline-<date>-hosted-after-variants.json` (generated)
- External, only after approval: GitHub `main`, `image.yml`, `~/Workspace` pins, `kubectl exec`

- [ ] **Step 1: STOP for approval**

Report to the user:
- the local before and after tables;
- the `verify:iteration` result;
- the exact deploy and backfill commands from Steps 2–3.

Ask whether to push `main`, build and deploy the image, and run the production backfill once. Do nothing outward-facing until the user says yes.

- [ ] **Step 2: Deploy (after approval)**

Follow the memory note `deploy-artifacts-backend-app`:
1. `git fetch origin`; confirm `origin/main` is an ancestor of `main` (another agent may have pushed `NEXT.md`); then `git push origin main`.
2. `gh workflow run image.yml --ref main`, wait for the run, and read the digest only from the "Print digest" step. Cross-check it with `docker buildx imagetools inspect ghcr.io/ajmcclary/artifact-server:<full sha>`.
3. In `~/Workspace`, update `targetRevision` and `image.digest` in `deployments/argocd/application-artifact-server.yaml`, and `digest` in `deployments/clusters/vps/artifact-server/helm-values.yaml`. Commit `Deploy Artifact Server precompressed content variants`, push, and annotate both Argo applications with `argocd.argoproj.io/refresh=normal`.
4. Wait until exactly four `app.kubernetes.io/component=server` pods are ready on the new digest, no old pod remains, and Argo reports `Synced Healthy`. The migration hook applies Postgres migration 20.

Rollback: revert the Workspace pin commit and push.

- [ ] **Step 3: Production backfill**

```bash
POD=$(KUBECONFIG=~/.kube/backend-app.yaml kubectl -n artifact-server get pods -l app.kubernetes.io/component=server -o jsonpath='{.items[0].metadata.name}')
KUBECONFIG=~/.kube/backend-app.yaml kubectl -n artifact-server exec "$POD" -- node dist/cli/main.js maintenance build-content-variants --once --mode external-storage
```

Expected: a JSON report with `failed: 0`. Save it privately to `~/.local/state/artifact-server/delivery/backfill-<date>.json`; it holds only counts. If the command says the port is invalid, add `--port 8080`. The cleanup CronJob notes that Kubernetes service-link variables can collide with `ARTIFACT_SERVER_PORT`.

- [ ] **Step 4: Hosted after run**

Run, with the ExtractionKit prototype URL used for the earlier hosted runs (project `prj_default`, artifact `art_a58bac0d-e1b1-401d-a548-eb26614bfcd8`, path `project/Prototype - ExtractionKit.dc.html`):

```bash
U=$(python3 -c 'import urllib.parse;print("https://artifacts.backend.app/review?"+urllib.parse.urlencode({"project":"prj_default","artifact":"art_a58bac0d-e1b1-401d-a548-eb26614bfcd8","path":"project/Prototype - ExtractionKit.dc.html"}))')
pnpm perf:delivery --target https://artifacts.backend.app --content-domain frontend.app --prototype-url "$U" --label after-variants --deployment-revision '<digest>'
```

Expected: prototype "Lease encoding" `br`, transfer at or below about 3.7 MiB, and the cold ready median compared with 14.3 s (pre-compression) and 17.9 s (streaming). If the saved session has expired, the harness opens Chrome for a sign-in; tell the user before running.

- [ ] **Step 5: FINDINGS**

Append a section `## October 2026 precompressed content variants (CNT-011)` to `project/performance/FINDINGS.md`. It contains:
- The local before/after tables and harness CPU per open.
- The hosted after table next to the earlier hosted before and streaming tables.
- The backfill counts.
- A "What this shows and what it does not" list. State plainly whether the success criteria were met (cold ready median below 14.3 s; transfer ≤ 3.7 MiB; no compression CPU on opens). Name remaining costs: new lease origins per open and `no-store` still force a full transfer.

Render the tables with:

```bash
node --import tsx -e 'import {readFileSync} from "node:fs"; import {formatJourneyTable} from "./project/performance/delivery/delivery-report.ts"; console.log(formatJourneyTable(JSON.parse(readFileSync(process.argv[1], "utf8"))))' <report.json>
```

Also update CNT-010's and CNT-011's `proof_gap` to name the hosted observation recorded in FINDINGS.

- [ ] **Step 6: Privacy check, commit, push**

Run the Task 1 privacy grep. Expected: `clean`.

```bash
git add project/performance/FINDINGS.md project/spec/conformance.yml project/evidence/delivery-baseline-*-hosted-after-variants.json
git commit -m "Record hosted evidence for precompressed content variants

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git fetch origin && git merge-base --is-ancestor origin/main main && git push origin main
```

- [ ] **Step 7: Report**

Tell the user:
- the hosted before, streaming, and variants headline numbers, and whether the success criteria were met;
- the backfill counts;
- CNT-010 and CNT-011 status and their remaining proof gaps.
