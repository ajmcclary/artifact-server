# Precompressed content variants — design

Date: 2026-10-05
Status: approved in conversation; awaiting written-spec review
Source: [FINDINGS "October 2026 browser delivery and streaming compression"](../../../project/performance/FINDINGS.md) and the CNT-010 follow-up (option 2) in [the delivery baseline spec](2026-10-05-delivery-baseline-and-streaming-compression-design.md).

## Intent

Make large prototypes such as ExtractionKit open faster on the hosted deployment. Streaming compression (CNT-010) cut ExtractionKit's transfer from 18.7 MiB to 3.7 MiB, but prototype ready time did not improve: each open compresses about 30 files at once at roughly 0.5 MB/s of input per stream, which is slower than the network. Compress each eligible file once, store the result, and serve the stored variant on every later open.

### What the user decided

- Store variants as ordinary content-addressed blobs and find them through a small index table (approach 1), not as a new object kind in every storage adapter.
- When no variant exists yet, serve uncompressed bytes and build the variant in the background. Do not compress on the request path.
- Build variants after each publish, on a read miss, and through a one-off backfill command for every current version.

### Success criteria

- The hosted ExtractionKit prototype's cold ready median improves on the 14.3 s pre-compression baseline (`project/evidence/delivery-baseline-2026-10-05-hosted-before.json`).
- Prototype transfer stays at or below about 3.7 MiB.
- Opening a prototype spends no CPU on compression.
- CNT-010 and CNT-011 pass locally, and `pnpm verify:iteration` passes.

### Assumptions

- Blobs are content-addressed and never deleted (the `BlobStore` port has no delete), so variants need no deletion either.
- Variants are derived data: a restore that loses them only causes misses and rebuilds.
- Production browsers accept `br` over HTTPS, so Brotli-only variants cover them.

## Components

### `ContentVariantIndex` port

A narrow port in `src/core/content-variants.ts`, beside the variant types, eligibility, and encoder constants it needs:

```ts
interface ContentVariantKey {
  readonly coding: "br";
  readonly encoderId: string;
  readonly sourceSha256: string;
}

interface ContentVariantMapping extends ContentVariantKey {
  readonly variantSha256: string;
  readonly variantSize: number;
}

interface ContentVariantIndex {
  find(key: ContentVariantKey): Promise<ContentVariantMapping | null>;
  /** Idempotent: an identical mapping is accepted; a conflicting one is rejected. */
  record(mapping: ContentVariantMapping): Promise<void>;
}
```

Implementations:

- SQLite (compact runtime): table `content_variants` added in the next `user_version` migration.
- Postgres (external-storage runtime): the same table in migration 20.
- D1 and the Workers runtime do not compose it.

Table `content_variants`: `installation_id`, `source_sha256`, `coding`, `encoder_id`, `variant_sha256`, `variant_size`, `created_at`, with primary key (`installation_id`, `source_sha256`, `coding`, `encoder_id`). Rows are installation-scoped, as every product table is (AUTH-017), so one installation cannot observe another's variants in a shared Postgres database. They are not project-scoped: a variant is a pure function of bytes already content-addressed in the installation's blob store, and serving it still requires the caller to be authorized for the source entry.

### Encoder identity

`encoderId` names the exact settings, starting with `br-q9-w22-v1` (Brotli quality 9, `BROTLI_PARAM_LGWIN` 22, a 4 MiB window). Changing settings introduces a new `encoderId`; existing rows remain valid for their own id and are simply no longer looked up.

### `ContentVariantBuilder`

An application service that turns a source digest into a stored variant.

- **Queue:** in-process and bounded. It runs one build at a time per process, deduplicates by key, and holds at most 1,000 pending keys, dropping the oldest when full. It is not durable: a later read miss or a backfill run queues the work again.
- **Build steps:**
  1. Return if `index.find` already has the mapping.
  2. Skip if the source is larger than 64 MiB.
  3. Open the source blob and Brotli-compress it into memory. Abort as soon as the output exceeds 90% of the source size.
  4. If the output is not at least 10% smaller than the source, record nothing and remember the source in an in-process "not beneficial" set.
  5. Otherwise `blobs.put` the output as an ordinary blob, which verifies its digest and size and is create-only, then `index.record` the mapping.
  6. Clear the source's negative lookup cache entry in this process.
- **Failures:** log the source digest and the error, then drop the job. There are no retry loops.
- **Test seam:** a runtime option `contentVariantBuilds: "background" | "manual"`, never read from the environment. In manual mode, queued builds run only on an explicit drain or through the backfill command.

### Triggers

1. **After publish:** the publication service notifies an optional observer port after every successful commit that creates a version, outside the commit transaction. Moving the current pointer to an existing version creates nothing and queues nothing; that version's entries were queued when it was published. Local linked-file captures create versions through a separate service and rely on the read-miss trigger. The observer queues every eligible entry of the new version. Publishing never waits for builds.
2. **On read miss:** `serveStoredVersionContent` queues the entry it served as identity.
3. **Backfill:** `artifact-server maintenance build-content-variants --once [--limit N]` walks every project's current versions, builds eligible entries synchronously in the foreground, and prints a JSON report with `built`, `skipped` (already mapped), `not_beneficial`, `too_large`, and `failed` counts. It exits with code 2 when any build failed. It follows the existing `maintenance cleanup-staging` command and runs for both compact and external-storage configurations.

An entry is **eligible** when its media type is in the compressible set (`application/javascript`, `application/json`, `image/svg+xml`, `text/css`, `text/html`, `text/javascript`) and it is at least 1,024 bytes.

## Serving path

`serveStoredVersionContent` changes only in the Node runtimes, which compose the index and builder.

1. **Eligibility:** GET or HEAD, no `Range` header, an eligible entry.
2. **Coding:** the client must accept `br` (case-insensitive; `q=0` refuses). Clients that accept only gzip, only `identity`, or nothing get identity bytes.
3. **Lookup:** `index.find({sourceSha256, coding: "br", encoderId})`.
   - Positive results are cached in-process, up to 10,000 mappings. They never go stale because mappings are immutable.
   - Misses are cached for 30 s per source digest. A build completed in the same process clears its entry immediately; other processes see the variant within 30 s.
4. **Hit:** open the variant blob and check its size against the mapping before setting any headers. Respond with:
   - `Content-Encoding: br` and `Content-Length` equal to the variant size;
   - no `Accept-Ranges`;
   - `ETag: W/"<source sha256>"`;
   - `Vary: Accept-Encoding`;
   - the unchanged `Cache-Control`.
   HEAD returns the same headers with no body.
5. **Miss:** respond exactly as identity content does today — strong `ETag`, `Accept-Ranges: bytes`, `Content-Length`, and `Vary: Accept-Encoding` — and queue a build.
6. **304:** no lookup. Respond with `Vary: Accept-Encoding` and an `ETag` in the form the client sent (weak if its `If-None-Match` was weak, strong otherwise). Never send `Content-Encoding` on a 304.
7. **Ranges and `If-Range`:** unchanged; always the identity representation.

Every eligible response therefore carries `Vary: Accept-Encoding` whether it is a hit or a miss. Every version-content response carries either `Content-Encoding` with a known `Content-Length`, or `Accept-Ranges: bytes`, so the buffering wrapper in `node-response-compression.ts` never buffers it.

The streaming encoder (`src/http/node-content-encoder.ts`), its `ContentEncoder` port, and its runtime composition are removed. The shared negotiation in `src/http/content-encoding.ts` stays.

## Failure handling

None of these fail the request:

| Condition | Response | Follow-up |
|---|---|---|
| `index.find` throws (database error) | Identity | Log the error |
| Mapping exists but its blob is missing or the wrong size | Identity | Log; queue a rebuild. The rebuild's create-only `put` matches or rewrites the blob, and recording the identical mapping is a no-op |
| Build fails | Unaffected | Log the source digest and error; drop the job |
| Two processes build the same variant | Unaffected | Identical bytes; one write wins and the identical record is a no-op |

## Resource bounds

- Requests never compress. A hit costs one indexed query, often avoided by the cache, plus one blob read.
- One build per process at a time.
- A build holds at most about 58 MiB of compressed output (90% of the 64 MiB maximum source) plus Brotli quality-9 native state of roughly 20–30 MiB.

## Observability

- A `content.variant` attribute on the existing request span: `hit`, `miss`, `ineligible`, or `error`.
- One log line per finished build with source size, variant size, outcome, and duration.

## Conformance and product spec

Adjust the CNT-010 sentence in the `architecture` section of `project/spec/artifact-server-product-spec.html`: eligible text responses are served from a stored Brotli copy when one exists and the browser accepts it, and byte-range requests always receive the uncompressed bytes.

Reword CNT-010 and set its status back to `implementing` until new evidence is attached:

```yaml
  - id: CNT-010
    behavior: Eligible full content responses are served from a stored Brotli variant when one exists and the client accepts it, and otherwise as identity, while range requests and refusals always stay on the identity representation.
    acceptance:
      behavior: {id: CNT-010-B, description: "Serve an eligible full GET as identity before its variant exists and as stored br with a real Content-Length afterwards, decoding to the exact stored bytes, with consistent HEAD, 304, Vary, and weak validator behavior."}
      failure: {id: CNT-010-F, description: "Range, If-Range, gzip-only, identity or q=0 refusals, small and non-compressible entries are served identity with ranges intact; a 304 never carries Content-Encoding; a mapped variant whose blob is missing is served identity and rebuilt."}
```

Add CNT-011 after CNT-010:

```yaml
  - id: CNT-011
    kind: behavior
    behavior: Compressed content variants are derived once per source digest and encoder, after publish, on a read miss, or by the backfill command, and are stored only when they save at least 10 percent.
    owner: content-delivery
    source: {file: artifact-server-product-spec.html, anchor: architecture}
    acceptance:
      behavior: {id: CNT-011-B, description: "Publish and observe stored br variants within a bounded wait; run the backfill and see built counts, then all skipped on a second run; variant mappings survive a restart."}
      failure: {id: CNT-011-F, description: "Incompressible text stores no variant and stays identity; a source over 64 MiB is skipped; a conflicting mapping is rejected; building a 60 MiB entry stays within the resident memory bound."}
    deployments: *all
    status: implementing
    proof_gap: Cloudflare relies on edge compression and does not compose variants. Team-deployment conformance runs are unrecorded.
    depends_on: [CNT-010]
    evidence: []
```

## Tests

All tests use a real HTTP server, temporary disk storage, a temporary SQLite database, and no module mocks. Runtimes under test use `contentVariantBuilds: "manual"` unless the test is about the background trigger.

- **CNT-010-B:** a miss returns identity; after a drain, the same request returns `br` with `Content-Length` equal to the variant size, decoding to the exact stored bytes. HEAD matches GET, the ETag is weak, and `Vary` is present. Cover preview leases, public current versions, and private content sessions.
- **CNT-010-F:** ranges and `If-Range` are identity; gzip-only, `identity`, and `br;q=0` requests are identity; a 304 never carries `Content-Encoding`; 1,023-byte and binary entries are identity; deleting a mapped variant's blob file from the temporary disk store yields an identity response and a rebuild on the next drain.
- **CNT-011-B:** in background mode, publishing leads to `br` hits within a bounded poll; the backfill reports `built` counts and a second run reports everything `skipped`; mappings survive a server restart.
- **CNT-011-F:** an eligible entry of random bytes stores no variant and stays identity; a source over 64 MiB reports `too_large`; recording a conflicting mapping is rejected; resident memory growth while building a 60 MiB entry stays under 256 MiB.
- **Postgres:** the Postgres `ContentVariantIndex` (find, idempotent record, conflict rejection) runs in the existing Docker Postgres suite (`pnpm test:external-storage-runtime`), and migration 20 passes the existing migration-history checks.
- **Removed:** the streaming-encoder tests (Brotli and gzip streaming, disconnect cancellation, concurrent streaming memory). The blob-read observer seam stays for the builder tests.

## Evidence and rollout

1. Local `perf:delivery` before (today's streaming code) and after.
2. `pnpm smoke` and `pnpm verify:iteration`.
3. **Stop for the user's explicit deploy approval.** Then build the image, update both Workspace pins, and verify all four server pods run the new digest.
4. Run the backfill once on production by `kubectl exec`-ing `artifact-server maintenance build-content-variants --once` in one server pod, after confirming the image ships the CLI entry point. This is a one-off command, not a resource change, so Argo does not revert it. Record the JSON report.
5. Hosted `perf:delivery` after, compared with the pre-compression baseline (14.3 s, 18.7 MiB) and the streaming run (`delivery-baseline-2026-10-05-hosted-after.json`). Update FINDINGS.

## Out of scope

- gzip variants; clients without `br` get identity.
- Workers and Cloudflare changes.
- Range requests over encoded bytes.
- Cache-Control and preview-lease policy.
- The Library catalog (PLAN.md step 1).
- Deleting variants; blobs are never deleted today.
