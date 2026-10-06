# Performance findings

There is no critical local bottleneck in the measured file sizes, but complete
directory publication has a confirmed per-file scaling cost. This is an
engineering baseline for regression detection, not a production capacity claim.

## September 18 Git history backlog diagnostic

A bounded opt-in SQLite fixture with 3,301 saved versions and 30 claim passes
exposed a repeated historical-scan cost. With one artifact and only its final
version unmapped, the pre-change median idle claim was 3,062 ms. With 3,301
one-version artifacts, the pre-change median was 107 ms while 960 jobs were
queued over the 30 passes. Project enablement itself remained below 1 ms.

The candidate removes a predecessor scan from queue insertion while retaining
the predecessor guard at claim, queues only the earliest unmapped version per
artifact, and indexes jobs by installation and version ID. The same fixture,
Node 24.15.0 and Apple M1 Max measured 2.60 ms median for deep history and
7.31 ms for many artifacts. Exact samples and fixture digests are in the
[before](../evidence/git-history-backlog-before.json) and
[after](../evidence/git-history-backlog-after.json) reports. This is one paired
local diagnostic, not a regression budget or tail-latency claim. History
growth, real Git provider work and controlled repetitions remain open.

The same 3,301-version, 30-pass shapes also completed against disposable
Postgres and local Wrangler D1. Postgres median claim time was 59.57 ms for
many artifacts and 18.85 ms for deep history; the first deep-history claim
took 834.25 ms. Local D1 medians were 46.75 ms and 48.84 ms. The reports
record setup separately: Postgres fixture insertion took 167–212 ms, while
D1 fixture insertion took about 50–51 seconds per shape. See the
[Postgres](../evidence/git-history-postgres-backlog.json) and
[D1](../evidence/git-history-d1-backlog.json) reports for every claim pass.
These are bounded local-provider observations. Deployed D1 limits, managed
Postgres, full history-growth curves, live Git calls and controlled repeated
baselines remain unqualified.

The [September 17 research reconciliation](../research/immutable-artifact-engineering-2026-09-17/RECONCILIATION.md)
and root [next steps](../../NEXT-STEPS.md) separate implemented fixes from open
experiments. Historical timing series below are tied to their recorded machines,
runtimes and workload. They are not interchangeable with the latest JSON report
or proof of a paired improvement. In particular, the retained prior-review
[Node 26.5 local run](../research/immutable-artifact-engineering-2026-09-17/review-evidence/local-performance-baseline.json)
reported 204.079 ms maximum event-loop delay, and its
[capacity run](../research/immutable-artifact-engineering-2026-09-17/review-evidence/local-capacity-baseline.json)
peaked at 742,293,504 bytes RSS with 4,838,272 bytes retained heap growth. Those
investigation warnings warrant controlled profiling, not a language-rewrite or
memory-leak conclusion. Research import does not close them.

The server-only concurrency matrix completed every browse and publication
journey at 1, 10, 25, 50, and 100 concurrent users. Across four standalone
complete runs, the 100-user browse p95 ranged from 847 to 924 ms and sustained
240 to 244 user journeys per second. The 100-user staged-publication p95 ranged
from 1,082 to 1,114 ms and sustained 94 to 96 complete publications per second.
The same matrix, run after every other check in the complete iteration gate,
recorded 1,065 ms browse p95 at 201 journeys per second and 1,162 ms publication
p95 at 95 publications per second. Maximum event-loop delay remained below
108 ms, health checks passed after every stage, and no request failed.

Peak server RSS ranged from 619 to 683 MiB during the complete sustained matrix.
After explicit collection, final live heap grew only 4.7 to 5.6 MiB across the
entire run and settled around 60 to 67 MiB. That result is consistent with
temporary allocation and allocator high-water behavior; it is not evidence of
retained per-user state or a memory leak. It is still operationally meaningful:
one Compact process deliberately serving this exact 100-user burst should not
be placed in a 512 MiB memory
limit. A 1 GiB process allocation provides reasonable headroom for this measured
local workload, but it is not a provider-independent production recommendation.

No application request throttle was added. At the measured ceiling, the server
completed all work, retained throughput, recovered live heap, and kept event-loop
delay bounded. Rejecting or queueing work at an invented threshold would reduce
utility without addressing a confirmed failure. External-storage and managed
provider capacity must be measured separately before Kubernetes or hosted
resource defaults claim the same 100-user envelope.

## Measured baseline

Machine: Apple M5 Max, Node.js 24.15.0, local APFS storage.

| Scenario | Publish p95 | Read p95 | Max event-loop delay | Restart |
| --- | ---: | ---: | ---: | ---: |
| 40 x 16 KiB publishes; 120 reads at concurrency 6 | 10.21 ms | 2.35 ms | 11.11 ms | 4.22 ms |
| 8 x 1 MiB publishes; 24 reads at concurrency 4 | 16.43 ms | 5.04 ms | 12.62 ms | 2.92 ms |

Both runs passed health, restart persistence, current-version delivery, and denial of anonymous access to a previous version. Neither produced an investigation warning. The default machine-readable result is in [`project/evidence/local-performance-baseline.json`](../evidence/local-performance-baseline.json); the bounded 1 MiB diagnostic is in [`project/evidence/local-performance-1mib.json`](../evidence/local-performance-1mib.json).

The shared-authorization and private-content iteration repeated the default
workload three times. Publish p95 ranged from 10.21 to 12.17 ms and public-read
p95 ranged from 3.04 to 5.35 ms. Throughput, restart, event-loop delay, and
memory remained inside the existing variance and produced no investigation
warning. The final machine-readable run is the current baseline file; the
range is recorded here so one unusually fast or slow laptop run is not treated
as a regression budget.

The artifact-lifecycle iteration added bounded artifact-list reads to every
baseline run. Its final default run measured publish p95 at 13.71 ms, public
read p95 at 5.06 ms, comparison p95 at 10.48 ms, artifact-list p95 at 7.34 ms,
and restart at 4.78 ms. No investigation warning fired. These results show no
obvious local regression from the tombstone, action-history, pagination-index,
or migration work; they do not establish shared-database capacity.

The file-first client iteration added the actual user path: filesystem walk,
SHA-256 calculation, upload-plan creation, streamed file uploads, commit, and
retrieval. A 2 MiB file measured 28–41 ms across bounded runs. A 48-file
directory containing 4 KiB files measured 651–936 ms. A focused file-count
curve using 2 KiB files measured 53 ms for 2 files, 210 ms for 12 files, and
936 ms for 48 files. Increasing client upload concurrency from four to eight
did not materially improve the result, so the production setting remains four.

The modern MCP iteration added 20 bounded `server/discover` calls and 20
authenticated `artifact_list` calls at concurrency six. Two consecutive default
runs measured discovery p95 at 27.10–28.00 ms and list p95 at 17.61–19.01 ms.
Both use a fresh protocol server per request and the real application runtime;
no obvious local control-plane bottleneck appeared.

Those runs raised the combined-process RSS high-water mark by 225–260 MiB. An
explicit diagnostic collection after the same default workload returned live
heap slightly below its starting value. Three consecutive MCP-enabled smoke
runs also kept post-collection heap flat while RSS stabilized at 319–324 MiB.
This is allocator high-water, not evidence of per-request retained MCP state.
The harness now uses an explicit collection point and gates retained heap and
external memory rather than treating unreclaimed RSS as a leak.

The observability iteration runs the default local baseline with Effect request
metrics and spans enabled and one-percent normal completion-log sampling. Its
final bounded run measured 46.50 sequential 16 KiB publications per second at
24.79 ms p95, 3,176.90 content reads per second at 2.88 ms p95, MCP discovery at
24.20 ms p95, MCP artifact-list at 34.94 ms p95, the 2 MiB file client at
40.58 ms p95, and the 48-file directory at 879.46 ms p95. After explicit
collection, retained heap grew 12.62 MiB and external memory 0.03 MiB. No
investigation warning fired. A paired run with JSON and OTLP export disabled
measured 23.41 ms publication p95 versus 24.79 ms with deployed observability,
which is inside normal laptop variance. The older approximately 10 ms baseline
predates the file-first, MCP, shared-policy, and observability work, so this phase
does not claim a single cause for that broader difference.

The first two external-storage-runtime baselines used two independent compiled server
processes, one Postgres database, and one MinIO S3-compatible bucket. Providers
became ready in 1,044–1,144 ms; initial server processes became ready in
265–347 ms, and replacements became ready in 187–193 ms. Sixteen 16 KiB
file-first publications at concurrency four measured 89–106 operations per
second with 82–111 ms p95. Eighty cross-process reads at concurrency eight
measured 2,381–2,386 operations per second with 4.64–5.2 ms p95. Authenticated
artifact lists measured 2.89–3.32 ms p95. The repeated 2 MiB single-file path
measured 95–96 ms p95, while the 48-file directory path measured 359–411 ms
p95. Every exact-byte, cross-process, health, and replacement check passed
without an investigation warning.

These numbers prove that no obvious Postgres, S3-adapter, or process-boundary
bottleneck appears in this bounded local-container workload. They do not
predict managed Postgres, AWS S3, Cloudflare R2, cross-region, Kubernetes, or
public-network capacity.

## What the pre-phase review changed

- Blob reads now stream from disk with backpressure. Normal GET requests do not load or fingerprint the complete file.
- Blob writes now consume a stream, verify the declared size and SHA-256 fingerprint, sync the completed file, atomically install it, and sync the containing directory before the database commit.
- HEAD requests inspect metadata without reading the file.
- The local server binds only to IPv4 loopback.
- Request paths are decoded, normalized, and checked against the manifest path rules before lookup.
- Upload-plan request bodies have an explicit bound; malformed JSON returns a client error rather than an internal error.

These fixes remove the obvious read-amplification and crash-durability problems found during the foundation review.

## Remaining limits and risks

### September 17 research follow-up

| Current risk | Code observation and next measurement | Work |
| --- | --- | --- |
| Final Postgres manifest insertion remains per-file | `PostgresArtifactRepository.#insertVersion` issues one insert per entry. Upload-plan batching is already fixed. Attribute final SQL and lock time before claiming a whole-publication gain. | T01/T04 |
| Verified cloud bytes traverse the application again at commit | The publication service opens staging and calls immutable `put`; quantify GET/HEAD/PUT/copy counts and network legs separately. Promotion requires exact source sealing and create-only destination proof. | T02/T12 |
| Retry repeats completed transfers | Durable CLI operation identity does not persist/reconcile file transfer completion. Lost-response recovery must check a committed result before allocating new transfer work. | T05 |
| Concurrent streams/pools multiply across publications and replicas | Measure total buffered bytes, pool wait and provider throttling; do not increase the current concurrency of four or default pool of ten from intuition. | T01/T14 |
| Review polling and conversation reads amplify client traffic | Seven-second visible polling also leaves deleted/filtered-out records stale; revision/refetch must prove coherent multi-page snapshots and hot-project costs. | T06 |
| Git work is not bounded by per-version file-copy limits alone | Enablement enumerates missing history in one foreground operation; claims can be out of version order; the Node provider clones accumulated history in memory. Preserve strict order before optimizing mirror throughput. | T03/T18 |
| Cleanup bounds passes, files and wall-clock time | Bounded reclamation with durable continuation landed September 27, and a durable cleanup claim (September 28) excludes racing preparation claims before any object removal in all three stores. Successful staging remains retained, and general blob GC remains disabled. | T10/T25 |
| Worker/D1 limits differ from Node/Postgres | Already-implemented R2/assets/Cron do not prove a free-tier many-file envelope. Qualify actual query, parameter, object-operation and CPU limits before chunked preparation. | T08/T09 |
| SQLite activity-log migration copies `actions` once at startup | Measured 10/01/2026 on an Apple M1 Max, Node v24.15.0: one startup over a populated schema-17 file with 1,000,000 legacy actions took 12.62 s, against the spec's 30 s stop (`pnpm perf:activity-migration`, `project/evidence/activity-migration-baseline.json`). Within budget; the copy holds one IMMEDIATE transaction, so first startup after upgrade blocks writers for that time. | ACT-002 |

Task definitions and gates are in [NEXT-STEPS.md](../../NEXT-STEPS.md). These are
observations and hypotheses, not completed performance changes. A 201.571-second
commit inside the recorded 523.94-second publication occupies about 38.5% of
the run; halving that whole stage would save about 19.2% overall, but that does
not show which portion is SQL, hashing or provider I/O. Postgres-only changes
cannot directly improve the SQLite local baseline. Larger research fixtures
need a separate opt-in bounded harness rather than increased canonical caps.

### P2: Directory publication cost grows approximately with file count

The client sends one verified upload request per file. Local storage syncs every
staged file durably and records its uploaded state before commit. The measured
2/12/48-file curve looked close to linear over that narrow range, but it missed
a server-side scaling defect at thousands of files: each PUT reloaded the whole
staged manifest before and after marking one file uploaded. The Postgres upload
plan also inserted one file row per query. The VPS S3 cutover exposed this when
a 3,301-file plan took about 24 seconds and completed PUTs still took roughly
1–3 seconds despite successful S3 writes.

The repository now reads only the requested file slot per PUT and inserts the
Postgres plan in one batch. The immutable blob-copy stage runs four independent
writes at a time, and the publication CLI's Undici header/body timeout exceeds
Traefik's 900-second request limits. One fresh-content 3,301-file AWS S3 run
completed in 523.94 seconds: plan 2.513 seconds, all 3,301 PUTs returned 200
with a 262 ms Traefik median and 795 ms p95, and commit returned 201 in
201.571 seconds. This is one VPS/AWS observation, not a capacity budget. The
per-file transport and durable-write cost still matters for very large sites.

Do not weaken integrity checks or filesystem durability to hide this cost. The
next transport investigation should compare a bounded multipart small-file
batch and the separately specified verified local-import helper. Provider-native
signed uploads remain required for cloud deployments. Verification must repeat
the file-count curve and the existing mismatch, restart, and isolation tests.

### Writes favor durability over local write throughput

Local SQLite runs in WAL mode with `synchronous = FULL`, and each new blob syncs both its file and containing directory before its database transaction commits. This is the intended correctness tradeoff for local and one-server deployments. It serializes some write work and does not predict the capacity of Postgres and remote blob providers. Every future provider needs the same workload and failure tests.

### Memory is measured for the combined client and server

The file-client baseline raised combined-process RSS substantially while
post-collection live heap and external memory stayed bounded. Native allocator
high-water behavior therefore dominates the RSS signal. This is not evidence of
a growing live-memory leak, but it is not a server-memory proof either. Before
memory becomes a release gate, measure the compiled server processes separately
across repeated runs and record retained heap, external memory, and RSS after an
explicit settling period.

### Managed-provider and sustained capacity are not measured yet

The external-storage baseline now measures multiple processes against pinned Postgres and
MinIO, but it is deliberately short and bounded. It does not establish a
sustained connection-pool limit, managed-provider tail latency, provider request
cost, multi-node network behavior, or failure behavior under dependency
throttling. AWS S3, Cloudflare R2, managed Postgres, Kubernetes, Windows, and
network filesystems still require their own provider evidence before their
capacity is advertised.

## September 22 bounded small-file batch transport (T13)

A new opt-in batch transport (`{transport: "batch"}` on the file client, default
per-file) carries many small files in one binary frame to
`POST /api/v1/uploads/:uploadId/batch`, reusing the per-file staging writes and
per-part `uploaded_at` flags. The paired comparison harness
(`pnpm perf:batch-staging-comparison`, `project/evidence/batch-staging-comparison.json`)
runs the real file client end to end for both arms on the same fixture.

Result: the batch makes the **staging leg about 75% cheaper** (per-file staged
PUT wall versus one batched frame), but the **end-to-end gain stays below the
10% bar** — about +7% at 48 x 4 KiB and about 0% at 1,000 files on this machine.
The limiter is the commit-time staged-to-blob copy (`assertPublicationSourceReady`
plus `storeFiles`, concurrency four), which is O(files) and unchanged by any
transport representation, and which dominates the total at larger file counts.
An early sequential server loop made the batch 16% **slower**; writing the
accepted parts with the same concurrency four the per-file fan-out already uses
recovered the staging win.

Verdict: **not adopted** (default stays per-file). The staging-leg reduction is
real and would matter most where request and operation counts are billed per
call (the Workers/R2/D1 leg in the T08 cost envelope), not on this local Node
end-to-end path. Do not promote the batch as a default without a workload and
provider where the end-to-end delta clears 10%.

## September 22 runtime ownership, archives, and Git growth (T18)
### Git clone memory

The Git mirror clones the full accumulated history into memfs per job
(`cloudflare-artifacts-git-history-provider.ts` `openWorkspace`). A new bounded
probe (`pnpm perf:git-history-clone-memory`) drives one complete
`commitGitHistoryVersion` call (clone, checkout, commit, push) against a
disposable local Git smart-HTTP remote seeded with N commits, sampling peak
`process.memoryUsage()`. On Apple M1 Max / Node 24.15.0, peak heap used grew from
about 40 MiB (0 commits) to about 54 MiB (200 commits) and peak array buffers
from about 5 MiB to about 20 MiB — roughly linear, on the order of 70 KB/commit
heap and 75 KB/commit array buffers for tiny one-file commits. The 500-commit
sample fell below the 200-commit sample because memory was reclaimed between
measurements, so this is a bounded local diagnostic, not a precise curve. The
risk in `FINDINGS.md` (Git work clones accumulated history in memory) is
confirmed as real and unbounded by memory, only by per-version copy limits:
deep history or large copied files will grow each job's in-memory clone. The
evidence is `project/evidence/git-history-clone-memory.json`.

### SQL cancellation

There is no request-abort-to-SQL cancellation. A client disconnect does not
interrupt the application effect — `runPromise` runs to completion and only the
response is discarded; the sole request-signal use is the comment-poll deadline
check. SQLite runs synchronously on the main thread (`node:sqlite DatabaseSync`);
Postgres runs on a separate `ManagedRuntime` (`postgres-database.ts`) whose
queries are not tied to the request fiber. No leak is expected — the query
finishes and the connection returns to the pool — but a disconnected-then-retried
client can overlap two full commits on one main thread, and no test proves a
pool closes exactly once at shutdown. This is a documented gap, not a measured
regression.

### Span continuity

Request-to-service spans are continuous inside the application runtime
(`create-http-app.ts` `http.request` root span passed as `parent` through
`runHttpApplicationEffect`), but Postgres spans execute on the separate Postgres
runtime and are not parented to the request span, and there is no inbound
`traceparent`/`tracestate` extraction. `tests/integration/observability.test.ts`
asserts signal presence, not linkage. Continuity across the separate
ManagedRuntime/Promise boundary and inbound W3C context propagation remain open.

### Archive (ZIP)

`createVersionArchive` is streamed and bounded: it plans from manifest metadata
without reading blobs, streams each entry with backpressure, and propagates
client disconnect into the generator (`streamFromAsyncIterable` wires `cancel` to
`iterator.return`). CRC-32 is incremental per chunk and allocation-free; entries
use stored compression (no deflate). The byte-at-a-time CRC table lookup is a
plausible CPU hotspot at multi-hundred-MB archives but is correct and not a
defect; a slice-by-4/8 table is a future optimization. No archive CRC/memory
probe exists, but the design already satisfies the bounded-memory requirement.

## September 23 controlled repetitions (T01/T04) and comment polling cost (T06)

### Controlled repetitions

Three sequential repetitions each of the external-storage baseline
(`project/evidence/external-storage-baseline-rep{1,2,3}.json`) and the local
baseline (`project/evidence/local-baseline-rep{1,2,3}.json`) ran back-to-back on
an otherwise idle Apple M1 Max, Node 24.15.0, commit `4f21086`, with no
investigation warnings. External-storage 48-file directory p95 was 421.58 /
393.97 / 427.58 ms (median 421.58, spread about ±4%), publish p95 70.15 /
87.35 / 65.72 ms, and cross-process read p95 36.57 / 37.81 / 31.88 ms. The T04
batched manifest insert (two statements per version instead of 1 + N) therefore
holds its September 21 paired observation (388.18 ms) within run-to-run noise;
no speed claim is made, and live managed-Postgres qualification remains open.
Local 48-file directory p95 was 859.81 / 908.60 / 863.38 ms with the commit leg
at 397.12 / 425.12 / 377.44 ms — the commit-time staged-to-blob copy still
dominates, matching the T13 verdict. Three samples bound gross variance but do
not support tail claims; regression budgets still need a controlled runner.

### Comment polling cost and contention (T06)

A new bounded harness (`pnpm perf:comment-polling`,
`project/evidence/comment-polling-baseline.json`) measures revision polling on
one hot artifact (200 threads, local SQLite): matching-revision short-circuit
polls cost p95 1.07 ms at about 1,296 ops/s, stale-revision authoritative first
pages cost p95 2.49 ms, and a five-second contention phase (eight parallel
pollers while one client creates and deletes threads) completed 529 mutations
with poll p95 22.54 ms and mutation round-trip p95 12.66 ms. The short-circuit
keeps steady-state polling near-constant in thread count; the contention tail
reflects SQLite's single-writer serialization and stays far below the 7-second
visible-tab poll interval. Postgres polling cost and deployed-runtime numbers
remain unmeasured.

## September 24 MCP server construction cost (T15)

A new bounded harness (`pnpm perf:mcp-server-construction`,
`project/evidence/mcp-server-construction-baseline.json`) measures the modern
MCP HTTP boundary at growing catalog sizes. Every request is a fresh stateless
POST, so each sample pays one full `createArtifactMcpServer` construction (31
tools plus one resource, all registered statically) plus bearer authentication
and the named method. On a local SQLite installation (Apple M1 Max, Node
24.15.0, commit `b531db1`, 50 samples per method per size), p95 costs are flat
from 0 to 1,000 artifacts: `server/discover` 14.78 / 12.63 / 17.10 ms,
`tools/list` 20.54 / 17.01 / 21.24 ms, `resources/templates/list` 14.44 /
10.56 / 11.48 ms, and a first-page `artifact_list` call 15.23 / 13.74 /
15.85 ms. Catalog size does not materially affect the per-request construction
or discovery path, so there is no measured case for caching or deferring tool
registration; the per-request ~10–20 ms floor is dominated by authentication
and construction constants, and a principal-bound server must never be cached
globally regardless. Seeding is recorded separately (1,000 artifacts in about
26.6 s through the real publish path). One run at one machine; no tail claim.

## September 24 T18 remaining probes: pool-close-once, span linkage, archive CRC

The three open T18 items from the September 22 write-up are now measured or
proven on a real Apple M1 Max / Node 24.15.0, with full measurement context in
each report.

### Pool-close-once at shutdown

Two real-boundary proofs now establish that storage resources close exactly
once at shutdown:

- **Local SQLite runtime** (`tests/lifecycle/storage-shutdown.test.ts`,
  `project/evidence/storage-shutdown.json`): `node:sqlite` `DatabaseSync`
  refuses a second `close()` and any post-close use with `ERR_INVALID_STATE`,
  so a double-run release finalizer would fail loudly rather than silently
  double-close. Disposing a real `LocalRuntime` twice resolves quietly
  (proving the release finalizer ran exactly once) while a post-shutdown
  request rejects with `ManagedRuntime disposed`. A real server stopped twice
  then restarted on the same data directory reads the published artifact back,
  so the closed database was left consistent.
- **Postgres pool** (`tests/integration/postgres-pool-shutdown.test.ts`,
  `project/evidence/postgres-pool-shutdown.json`, pinned container): one
  `PostgresDatabase` pool shows at least one server-side connection while open,
  `pg_stat_activity` drains to zero after `close()`, a second `close()`
  resolves without reconnecting, and post-close use rejects with
  `ManagedRuntime disposed` instead of leaking a usable pool.

The "no test proves a pool closes exactly once at shutdown" gap is closed. The
remaining `sql-cancellation` gap is unchanged and separate: a client disconnect
does not interrupt an in-flight SQL effect, and SQLite runs synchronously on the
main thread.

### Span linkage across the Postgres runtime boundary

A new opt-in harness (`pnpm perf:observability-span-linkage`,
`project/evidence/observability-span-linkage.json`) drives real authenticated
requests that perform storage work against an in-process server wired to a real
OTLP collector, then records exported span names, trace IDs and parent IDs
exactly as observed. The SQLite arm always runs; the Postgres arm runs under
`scripts/with-external-storage-test-providers.sh`.

Findings, recorded rather than fixed:

- On the main runtime the request span chain is continuous: every request emits
  an `http.request` span, the route span (`POST /api/*`, `GET /api/*`) is
  parented to it, and service spans (`AuthorizationService.*`,
  `ProjectManagementService.*`, `PublishArtifactService.*`, etc.) are parented
  inside the same trace, with no orphan spans.
- Postgres persistence work produces **no exported spans at all**: the captured
  span inventory contains no `sql.*` or query span for either arm. The Postgres
  `ManagedRuntime` is built from `PgClient.layer(...)` alone
  (`src/storage/postgres-database.ts`) without the OTLP exporter layer, so its
  SQL work is invisible to tracing — a stronger statement than the prior
  "not parented to the request span." The earlier "not parented" wording in
  this file over-stated what could be observed; the gap is "not exported."
- An inbound W3C `traceparent` header is not honored: the server starts a fresh
  trace (`inboundTraceparentHonored: false`) rather than continuing the caller's
  trace context. Inbound `traceparent`/`tracestate` extraction remains open.

### Archive CRC-32 throughput

A new bounded harness (`pnpm perf:archive-crc-throughput`,
`project/evidence/archive-crc-throughput.json`) publishes a real 64 MiB
immutable blob and measures the archive route (stored-compression ZIP with
incremental CRC-32 per chunk) against the version file route that streams the
same blob with no CRC or ZIP framing. On this machine the archive streams at
156.2 MiB/s mean (p95 159.3) while the raw file route streams at 804.5 MiB/s
mean (p95 836.0) — an archive/file ratio of about 0.19. The byte-at-a-time
CRC-32 plus ZIP framing is therefore the dominant archive cost, roughly a 5×
penalty over raw streaming, and it is the strongest measured signal so far that
a slice-by-4/8 CRC table (or an equally correct vectorized CRC) is a justified
optimization target when archives reach this size. This is one bounded local
observation, not a tail or production claim.

## September 24 sealed-source promotion: commit-leg and end-to-end measurement (T12)

The T01 attribution named the commit-time staged-to-blob copy as the only
stage with a plausible ≥10% end-to-end opportunity on the 48-file directory
workload. The local sealed promotion (hard-link install with a one-handle
re-hash seal, post-link inode identity check, and create-only `EEXIST`
verified reuse) was measured against it on one Apple M1 Max, Node 24.15.0,
alternating the working tree between the pre-promotion commit and the
promotion working set. Evidence:
`project/evidence/local-baseline-promotion-before.json` and
`local-baseline-promotion-after-rep{1,2,3}.json`.

| Measurement | Before | After (3 reps) | Delta |
| --- | --- | --- | --- |
| 48-file directory p95 | 860.69 ms (September 23 repetitions: 859.81 / 908.60 / 863.38) | 632.30 / 650.56 / 653.61 ms | about −25% end-to-end |
| Commit leg p95 | 436.91 ms (September: 397.12 / 425.12 / 377.44) | 163.72 / 175.03 / 159.87 ms | about −60% |
| Commit leg total | 1,008.6 ms | 253.5 / 265.7 / 235.1 ms | about −75% |
| Staging leg p95 | 46.77 ms | 48.89 / 46.88 / 51.53 ms | unchanged |

Every after sample sits below every before sample on both the directory and
commit-leg metrics, with a separation roughly ten times the within-group
spread — comfortably over the ≥10% bar on this named workload. The remaining
commit-leg time is the seal re-hash and the per-version transaction; the
staged-to-blob byte copy and its second full-file write are gone. The staging
leg is untouched, as designed. These are single-machine paired observations
with no tail claim, and the local adapter is the only promotion path so far:
cloud adapters still take the verified stream fallback, where the same
promotion shape (native server-side copy with create-only destination
conditions) must be qualified per adapter before any claim there.

## Baseline policy
- `pnpm verify:iteration` is the required end-of-iteration gate. It includes correctness, a coverage report, conformance checks, and the default bounded baseline. Coverage percentage is not a test-design target.
- `pnpm smoke` catches broken behavior and gross regressions with deliberately loose machine-timing limits.
- `pnpm perf:baseline` records diagnostics and reports investigation warnings without failing on normal laptop variance.
- `pnpm verify:external-storage-performance` runs the real compiled two-process Postgres and S3-compatible path and records provider startup separately from application latency.
- Aggregate workload limits prevent command-line flags from accidentally creating a stress test.
- Set tighter regression budgets only after repeated runs on a controlled runner establish normal variance.
- Run the same behavior on local disk, every blob driver, Postgres, Kubernetes, and Cloudflare as those adapters are implemented.

## Activity feed read path (2026-10)

- Local SQLite, 100,000 actions (`pnpm perf:activity-feed`, Apple M1 Max, Node v24.15.0): first page p50 1.51 ms / p95 2.15 ms; summary p50 10.08 ms / p95 11.78 ms. Evidence: `project/evidence/activity-feed-baseline.json`. Two reruns on the same machine stayed within 2.14–2.37 ms (first page p95) and 11.05–11.61 ms (summary p95).
- Two-process Postgres/MinIO (`pnpm verify:external-storage-performance`, 16 reads): activityFeed p95 16.223 ms; activitySummary p95 13.424 ms.
- Risk: latest-per-thread folding probes `actions.thread_id` per candidate row; the summary scans open threads per request. Revisit if open threads exceed 10,000 per installation.

## October 2026 browser delivery and streaming compression (CNT-010)

Measured with `pnpm perf:delivery` on October 5, 2026: Chromium 151, unthrottled, five samples per journey, on an Apple M1 Max. Hosted runs used artifacts.backend.app (web build `review-D_MgDfh-.js`) before and after deploying image `sha256:9cbab1600e1102b3092be1f37f24160b2cc5ac1a8869d494dbbdcf1de02fffee` (main `0aac4d3`). The hosted prototype is ExtractionKit's single prototype page. Raw HAR files stayed in private storage; the committed reports in `project/evidence/delivery-baseline-2026-10-05-*.json` contain only route classes, path templates, allowlisted headers, and numbers. Ready means the first Library tile is visible, or the preview frame is attached and its content requests have been quiet for 500 ms.

### Local (synthetic ExtractionKit-shaped fixture; compression ratio not representative)

Before:

| Journey | Cache | Ready | First paint | Requests | Transferred | Decoded | Lease encoding | Timeouts |
|---|---|---|---|---|---|---|---|---|
| library | cold | 139 ms (132 ms–147 ms) | 104 ms (100 ms–112 ms) | 16 (16–16) | 501.0 KiB (501.0 KiB–501.0 KiB) | 1.46 MiB (1.46 MiB–1.46 MiB) | identity | 0 |
| library | warm | 73 ms (72 ms–78 ms) | 64 ms (60 ms–64 ms) | 16 (16–16) | 3.1 KiB (3.1 KiB–3.1 KiB) | 1.30 MiB (1.30 MiB–1.30 MiB) | identity | 0 |
| prototype | cold | 850 ms (841 ms–901 ms) | 120 ms (120 ms–132 ms) | 31 (31–31) | 15.71 MiB (15.71 MiB–15.71 MiB) | 17.45 MiB (17.45 MiB–17.45 MiB) | identity | 0 |
| prototype | warm | 755 ms (732 ms–806 ms) | 92 ms (72 ms–92 ms) | 31 (31–31) | 15.05 MiB (15.05 MiB–15.05 MiB) | 17.29 MiB (17.29 MiB–17.29 MiB) | identity | 0 |

After:

| Journey | Cache | Ready | First paint | Requests | Transferred | Decoded | Lease encoding | Timeouts |
|---|---|---|---|---|---|---|---|---|
| library | cold | 150 ms (137 ms–171 ms) | 112 ms (100 ms–112 ms) | 16 (16–16) | 501.0 KiB (501.0 KiB–501.0 KiB) | 1.46 MiB (1.46 MiB–1.46 MiB) | identity | 0 |
| library | warm | 78 ms (73 ms–142 ms) | 64 ms (60 ms–64 ms) | 16 (16–16) | 3.1 KiB (3.1 KiB–3.1 KiB) | 1.30 MiB (1.30 MiB–1.30 MiB) | identity | 0 |
| prototype | cold | 921 ms (880 ms–976 ms) | 136 ms (124 ms–152 ms) | 31 (31–31) | 2.78 MiB (2.78 MiB–2.78 MiB) | 17.45 MiB (17.45 MiB–17.45 MiB) | br | 0 |
| prototype | warm | 818 ms (797 ms–894 ms) | 80 ms (76 ms–92 ms) | 31 (31–31) | 2.12 MiB (2.12 MiB–2.12 MiB) | 17.29 MiB (17.29 MiB–17.29 MiB) | br | 0 |

Harness CPU per prototype open (server in the same process): 370 ms before and 501 ms after for a cold open, 318 ms and 412 ms warm. The difference, about 100–130 ms per open, approximates Brotli quality-4 cost for about 17 MiB of text. On loopback the transfer is free, so local ready time only pays that cost.

### Hosted (artifacts.backend.app, ExtractionKit prototype)

Before:

| Journey | Cache | Ready | First paint | Requests | Transferred | Decoded | Lease encoding | Timeouts |
|---|---|---|---|---|---|---|---|---|
| library | cold | 33422 ms (24419 ms–77178 ms) | 2660 ms (1680 ms–7180 ms) | 179 (179–180) | 1.91 MiB (1.91 MiB–1.93 MiB) | 6.94 MiB (6.94 MiB–6.96 MiB) | identity | 0 |
| library | warm | 38791 ms (24742 ms–40309 ms) | 992 ms (404 ms–6072 ms) | 181 (180–191) | 1.36 MiB (1.34 MiB–1.44 MiB) | 6.82 MiB (6.80 MiB–6.87 MiB) | identity | 0 |
| prototype | cold | 14270 ms (10533 ms–20035 ms) | 2328 ms (1244 ms–3208 ms) | 83 (50–87) | 18.67 MiB (2.88 MiB–18.77 MiB) | 19.74 MiB (3.96 MiB–19.84 MiB) | identity | 0 |
| prototype | warm | 14015 ms (11865 ms–28737 ms) | 624 ms (316 ms–1116 ms) | 82 (81–87) | 18.04 MiB (18.04 MiB–18.14 MiB) | 19.53 MiB (19.53 MiB–19.64 MiB) | identity | 0 |

After:

| Journey | Cache | Ready | First paint | Requests | Transferred | Decoded | Lease encoding | Timeouts |
|---|---|---|---|---|---|---|---|---|
| library | cold | 22010 ms (20040 ms–30073 ms) | 2852 ms (2308 ms–3748 ms) | 180 (179–181) | 1.93 MiB (1.91 MiB–1.94 MiB) | 6.96 MiB (6.94 MiB–6.97 MiB) | identity | 0 |
| library | warm | 23328 ms (14974 ms–35560 ms) | 2360 ms (980 ms–4236 ms) | 186 (181–204) | 1.38 MiB (1.34 MiB–1.47 MiB) | 6.86 MiB (6.80 MiB–6.92 MiB) | identity | 0 |
| prototype | cold | 17895 ms (12725 ms–18675 ms) | 1292 ms (868 ms–2628 ms) | 82 (81–89) | 3.73 MiB (3.73 MiB–4.00 MiB) | 19.70 MiB (19.70 MiB–19.96 MiB) | br | 0 |
| prototype | warm | 13803 ms (10218 ms–19371 ms) | 444 ms (264 ms–1136 ms) | 85 (68–88) | 3.25 MiB (2.72 MiB–3.41 MiB) | 19.64 MiB (18.24 MiB–19.79 MiB) | br | 0 |

### What this shows and what it does not

- **Transfer fell 80%, but prototype ready time did not improve.** ExtractionKit's prototype transfer dropped from 18.7 MiB to 3.7 MiB cold. Content responses arrived single-encoded as `br` through Traefik; the proxy neither stripped nor re-encoded them. Ready time stayed within noise: cold median 14.3 s before and 17.9 s after, with overlapping ranges (10.5–20.0 s and 12.7–18.7 s); warm 14.0 s and 13.8 s. One before sample reached ready after only 2.9 MiB, so the readiness signal can fire before late data scripts start.
- **Server-side streaming compression is now the prototype's bottleneck on this network.** In the raw captures, `ek-data-design-record.js` (5.9 MB) received in 3.0–3.7 s as identity. Compressed to 0.2 MB, it took 5.7–11.9 s, and `ds-bundle.js` and `ek-data-viewer.js` behaved the same way. Each open requests about 30 content files at once, and they compress at roughly 0.5 MB/s of input per stream. The pods request one CPU with no limit. Likely causes, not yet isolated: one chunk in flight per stream through the pull-through source, the default four-thread libuv pool shared by zlib, and the S3 read path. Local runs read 64 KiB disk chunks and do not reproduce this. Measuring per-chunk timing on the external-storage runtime, and the effect of `UV_THREADPOOL_SIZE`, comes before tuning.
- **The Library's cold median moved from 33 s to 22 s, but compression does not cause it.** Library API responses were already compressed by the buffering wrapper, and the Library loads no lease content. The change reflects variance between hosted sessions (before ranged 24–77 s). The Library remains the slowest journey, at about 180 requests per open, and needs the server-side catalog (PLAN.md step 1), not compression.
- **Every open still transfers and compresses again.** Preview leases are `private, no-store`, and each Review open mints a new lease origin, so a warm open repeats the full transfer and the full compression work. Precompressed variants keyed by digest and coding (deferred approach 2) would remove both the per-open CPU and the throughput ceiling above. Whether the browser can reuse bytes across opens is the separate cache and lease contract decision in PLAN.md step 0.
- **Memory is bounded.** A size hint for large entries gave Brotli a 16 MiB window, and 20 concurrent 64 MiB reads grew resident memory by 577 MiB. With a 1 MiB window and no size hint, the same reads grew it by 153 MiB, against gzip's 17–70 MiB; `tests/http/content-delivery-compression.test.ts` bounds both codings at 256 MiB of resident growth.

## October 2026 precompressed content variants (CNT-011)

Each eligible version-content file is now compressed once with Brotli (quality 9, 4 MiB window, encoder `br-q9-w22-v1`), stored as an ordinary content-addressed blob, and found through the installation-scoped `content_variants` table. A stored variant is served as `br` with a real `Content-Length`; a missing one is served as identity and built in the background. The per-request streaming encoder from CNT-010 was removed. Measured on October 5, 2026 with `pnpm perf:delivery` (Chromium 151, unthrottled, five samples per journey, Apple M1 Max). The hosted run used artifacts.backend.app on image `sha256:c30005b09d6f66d4f6f004ca18aa343437a1dc29a605044c32f07d2516216be1` (main `ad1585a`), after the one-time production backfill.

### Local (synthetic ExtractionKit-shaped fixture)

Before (today's streaming encoder):

| Journey | Cache | Ready | First paint | Requests | Transferred | Decoded | Lease encoding | Timeouts |
|---|---|---|---|---|---|---|---|---|
| library | cold | 141 ms (135 ms–151 ms) | 104 ms (100 ms–116 ms) | 16 (16–16) | 501.0 KiB (501.0 KiB–501.0 KiB) | 1.46 MiB (1.46 MiB–1.46 MiB) | identity | 0 |
| library | warm | 76 ms (72 ms–77 ms) | 64 ms (60 ms–64 ms) | 16 (16–16) | 3.1 KiB (3.1 KiB–3.1 KiB) | 1.30 MiB (1.30 MiB–1.30 MiB) | identity | 0 |
| prototype | cold | 879 ms (867 ms–900 ms) | 124 ms (120 ms–136 ms) | 31 (31–31) | 2.88 MiB (2.88 MiB–2.88 MiB) | 17.45 MiB (17.45 MiB–17.45 MiB) | br | 0 |
| prototype | warm | 818 ms (810 ms–825 ms) | 88 ms (72 ms–96 ms) | 31 (31–31) | 2.23 MiB (2.23 MiB–2.23 MiB) | 17.29 MiB (17.29 MiB–17.29 MiB) | br | 0 |

After (stored variants, built after publish):

| Journey | Cache | Ready | First paint | Requests | Transferred | Decoded | Lease encoding | Timeouts |
|---|---|---|---|---|---|---|---|---|
| library | cold | 139 ms (133 ms–142 ms) | 100 ms (100 ms–108 ms) | 16 (16–16) | 501.0 KiB (501.0 KiB–501.0 KiB) | 1.46 MiB (1.46 MiB–1.46 MiB) | identity | 0 |
| library | warm | 77 ms (72 ms–80 ms) | 64 ms (56 ms–64 ms) | 16 (16–16) | 3.1 KiB (3.1 KiB–3.1 KiB) | 1.30 MiB (1.30 MiB–1.30 MiB) | identity | 0 |
| prototype | cold | 853 ms (847 ms–868 ms) | 124 ms (124 ms–132 ms) | 31 (31–31) | 2.37 MiB (2.37 MiB–2.37 MiB) | 17.45 MiB (17.45 MiB–17.45 MiB) | br | 0 |
| prototype | warm | 767 ms (764 ms–789 ms) | 76 ms (72 ms–80 ms) | 31 (31–31) | 1.72 MiB (1.72 MiB–1.72 MiB) | 17.29 MiB (17.29 MiB–17.29 MiB) | br | 0 |

Harness CPU per prototype open, with the server in the same process: 455 ms before and 331 ms after for a cold open, 416 ms and 294 ms warm. Requests no longer compress, and the one-time quality-9 build cuts transfer from 2.88 MiB to 2.37 MiB cold. On loopback, ready time stays within noise (879 ms and 853 ms).

### Hosted (artifacts.backend.app, ExtractionKit prototype)

After stored variants:

| Journey | Cache | Ready | First paint | Requests | Transferred | Decoded | Lease encoding | Timeouts |
|---|---|---|---|---|---|---|---|---|
| library | cold | 25813 ms (18814 ms–30636 ms) | 1892 ms (1312 ms–4844 ms) | 179 (179–180) | 1.91 MiB (1.91 MiB–1.93 MiB) | 6.94 MiB (6.94 MiB–6.96 MiB) | identity | 0 |
| library | warm | 20220 ms (15986 ms–32842 ms) | 1484 ms (500 ms–4184 ms) | 183 (179–192) | 1.36 MiB (1.34 MiB–1.48 MiB) | 6.81 MiB (6.80 MiB–6.86 MiB) | identity | 0 |
| prototype | cold | 8900 ms (7630 ms–11471 ms) | 1228 ms (664 ms–2832 ms) | 81 (80–87) | 3.38 MiB (3.38 MiB–3.52 MiB) | 19.70 MiB (19.70 MiB–19.84 MiB) | br | 0 |
| prototype | warm | 9737 ms (5878 ms–15008 ms) | 324 ms (180 ms–756 ms) | 81 (80–87) | 2.79 MiB (2.79 MiB–2.94 MiB) | 19.53 MiB (19.53 MiB–19.68 MiB) | br | 0 |

The earlier hosted runs are in the CNT-010 section above: 14.3 s cold and 14.0 s warm before compression (18.7 MiB transferred), and 17.9 s cold and 13.8 s warm with per-request streaming compression (3.7 MiB).

### Production backfill

`artifact-server maintenance build-content-variants --once --mode external-storage`, run once in one server pod after the rollout: 389 distinct eligible files examined, 379 built, 10 skipped (already built by reads since the deploy), 0 not beneficial, 0 too large, 0 failed. The built sources total 38.5 MiB and their variants 6.81 MiB. The pass took about 5 minutes.

### What this shows and what it does not

- **The success criteria are met.** ExtractionKit's cold ready median fell from 14.3 s before compression (and 17.9 s with streaming) to 8.9 s, and the after range (7.6–11.5 s) sits almost entirely below the before range (10.5–20.0 s). Warm opens fell from 14.0 s to 9.7 s. Transfer is 3.38 MiB cold, below the 3.7 MiB streaming result, and requests spend no CPU on compression.
- **Ready time is still about 9 seconds.** About 20 MiB of decoded script and CSS still has to be parsed and run on every open, and every open mints a new lease origin with `no-store` responses, so even a warm open transfers about 2.8 MiB again. Splitting ExtractionKit's eager data scripts (PLAN.md step 2) and the cache and lease contract decision (PLAN.md step 0) are the next levers.
- **The Library is unchanged and remains the slowest journey**, at about 20–26 s median with roughly 180 requests per open. Compression does not touch it; it needs the server-side catalog (PLAN.md step 1).
- **Hosted timings vary widely between sessions.** The Library, which these changes do not affect, measured 33 s, 22 s, and 26 s cold across the three hosted runs. Read single comparisons with that in mind.
- **Rollout and rollback.** Migration 20 runs in the pre-upgrade hook, so the old pods report "schema newer" and go not-ready until the new ones are ready; expect a brief readiness gap, as with migrations 18 and 19. Rolling back the image needs `DELETE FROM artifact_server_postgres_migrations WHERE migration_id = 20;` first. The table itself is harmless to an older image.

## October 2026 server-side Library (DSN-006)

The Library now loads from one authorized `GET /api/v1/library` request. The server reads each current version's preview index (cached per immutable version) and dates every page in SQL over full version and comment history, instead of the browser reading versions, manifests, indexes and comments for every gallery. Measured October 5–6, 2026 with `pnpm perf:delivery` (Chromium 151, unthrottled, five samples per journey, Apple M1 Max). The hosted run used artifacts.backend.app on image `sha256:76f074da9f251094dc956dbbee878a5798141a802faa48640aa71d4b9b499022` (main `ae29947`).

### Local (one synthetic gallery)

Before:

| Journey | Cache | Ready | First paint | Requests | Transferred | Decoded | Lease encoding | Timeouts |
|---|---|---|---|---|---|---|---|---|
| library | cold | 137 ms (135 ms–148 ms) | 100 ms (100 ms–112 ms) | 16 (16–16) | 501.0 KiB (501.0 KiB–501.0 KiB) | 1.46 MiB (1.46 MiB–1.46 MiB) | identity | 0 |
| library | warm | 73 ms (70 ms–75 ms) | 60 ms (60 ms–64 ms) | 16 (16–16) | 3.1 KiB (3.1 KiB–3.1 KiB) | 1.30 MiB (1.30 MiB–1.30 MiB) | identity | 0 |
| prototype | cold | 845 ms (822 ms–856 ms) | 120 ms (120 ms–132 ms) | 31 (31–31) | 2.37 MiB (2.37 MiB–2.37 MiB) | 17.45 MiB (17.45 MiB–17.45 MiB) | br | 0 |
| prototype | warm | 744 ms (720 ms–803 ms) | 84 ms (76 ms–92 ms) | 31 (31–31) | 1.72 MiB (1.72 MiB–1.72 MiB) | 17.29 MiB (17.29 MiB–17.29 MiB) | br | 0 |

After:

| Journey | Cache | Ready | First paint | Requests | Transferred | Decoded | Lease encoding | Timeouts |
|---|---|---|---|---|---|---|---|---|
| library | cold | 143 ms (141 ms–239 ms) | 112 ms (104 ms–124 ms) | 13 (13–13) | 498.6 KiB (498.6 KiB–498.6 KiB) | 1.46 MiB (1.46 MiB–1.46 MiB) | identity | 0 |
| library | warm | 78 ms (76 ms–81 ms) | 64 ms (60 ms–72 ms) | 13 (13–13) | 1.5 KiB (1.5 KiB–1.5 KiB) | 1.29 MiB (1.29 MiB–1.29 MiB) | identity | 0 |
| prototype | cold | 857 ms (847 ms–939 ms) | 136 ms (124 ms–148 ms) | 31 (31–31) | 2.37 MiB (2.37 MiB–2.37 MiB) | 17.45 MiB (17.45 MiB–17.45 MiB) | br | 0 |
| prototype | warm | 763 ms (729 ms–781 ms) | 96 ms (80 ms–96 ms) | 31 (31–31) | 1.72 MiB (1.72 MiB–1.72 MiB) | 17.29 MiB (17.29 MiB–17.29 MiB) | br | 0 |

### Hosted (artifacts.backend.app, 11 artifacts)

After:

| Journey | Cache | Ready | First paint | Requests | Transferred | Decoded | Lease encoding | Timeouts |
|---|---|---|---|---|---|---|---|---|
| library | cold | 5410 ms (4551 ms–11771 ms) | 2068 ms (1964 ms–6408 ms) | 12 (12–13) | 490.8 KiB (490.8 KiB–512.5 KiB) | 1.52 MiB (1.52 MiB–1.54 MiB) | identity | 0 |
| library | warm | 7263 ms (5187 ms–15822 ms) | 3032 ms (1768 ms–8988 ms) | 15 (14–67) | 37.2 KiB (35.6 KiB–347.5 KiB) | 1.40 MiB (1.37 MiB–1.68 MiB) | identity | 0 |
| prototype | cold | 14389 ms (9978 ms–19686 ms) | 2504 ms (1124 ms–2856 ms) | 86 (82–87) | 3.48 MiB (3.38 MiB–3.60 MiB) | 19.80 MiB (19.70 MiB–19.91 MiB) | br | 0 |
| prototype | warm | 11180 ms (7089 ms–11833 ms) | 592 ms (356 ms–764 ms) | 81 (80–87) | 2.79 MiB (2.79 MiB–2.95 MiB) | 19.53 MiB (19.53 MiB–19.69 MiB) | br | 0 |

Earlier hosted Library cold medians, in the CNT-010 and CNT-011 sections above: 33 s, 22 s, and 26 s, at about 180 requests per open.

### What this shows and what it does not

- **The Library got much faster but missed the 2-second target.** The hosted cold Library-ready median fell from 22–33 s to 5.4 s (4.6–11.8 s), and requests per open fell from about 180 to 12. The success criterion was under 2 seconds; it was not met.
- **The Library endpoint itself takes 2.6–4.6 s on the server.** In the raw captures, `/api/v1/library` waited 2.56 s, 4.59 s, and 2.92 s for its first byte. The service reads each artifact's current version and full manifest one after another, and each pod's first request also reads the preview-index blobs. The fix is to read artifacts concurrently, or to fetch every current version's index entry in one query. The final review flagged both as scaling concerns; on production they are already the largest remaining cost.
- **The application shell is slow before the Library starts.** Static scripts and stylesheets waited 1.3–4.5 s for their first byte in the same samples, so the page spends 2–5 s before it can ask for the Library. That is general server or cluster latency, not this change, and is worth investigating separately.
- **Thumbnails still load per tile** through the media route, after the first tiles are visible, at 1–6 s each on this deployment.
- **Dates are now exact.** They come from every version and every reply, not a 40-version window and the reply approximation. The equivalence test proves they match the client's former algorithm over random histories.
- **Hosted timings vary widely between sessions.** Read single comparisons with that in mind.

### Contribution cache and concurrent reads (main `4c7cad2`)

The service now caches what each immutable version contributes to the Library (gallery, no gallery, or invalid index) by version id, so a warm request skips the version, manifest, and index reads. It reads cache misses six at a time and reports `Server-Timing: library;dur=<ms>`. The hosted run used image `sha256:f26abb7f22adff970c47006c75f4f76815f9675da7c9d394c13146814c40be18` on October 6, 2026; evidence is `project/evidence/delivery-baseline-2026-10-06-hosted-after-library-cache.json`.

| Journey | Cache | Ready | First paint | Requests | Transferred | Decoded | Lease encoding | Timeouts |
|---|---|---|---|---|---|---|---|---|
| library | cold | 10489 ms (5446 ms–11455 ms) | 4448 ms (2624 ms–5212 ms) | 13 (12–13) | 512.4 KiB (490.8 KiB–512.5 KiB) | 1.54 MiB (1.52 MiB–1.54 MiB) | identity | 0 |
| library | warm | 6475 ms (4136 ms–11468 ms) | 1760 ms (1168 ms–5584 ms) | 14 (13–24) | 35.6 KiB (14.0 KiB–92.1 KiB) | 1.37 MiB (1.37 MiB–1.46 MiB) | identity | 0 |
| prototype | cold | 13050 ms (8144 ms–18401 ms) | 1688 ms (1116 ms–5168 ms) | 81 (80–88) | 3.38 MiB (3.38 MiB–3.64 MiB) | 19.70 MiB (19.70 MiB–19.96 MiB) | br | 0 |
| prototype | warm | 8211 ms (6734 ms–8923 ms) | 340 ms (284 ms–528 ms) | 81 (80–86) | 2.79 MiB (2.79 MiB–3.01 MiB) | 19.53 MiB (19.53 MiB–19.75 MiB) | br | 0 |

- **The 1-second server target was not met, and this run is slower end to end than the previous one.** `Server-Timing` across the ten Library samples was 363 ms to 6,280 ms. The first request to each of the four pods misses the per-process cache (about 4.3–6.3 s); later hits took 0.36–3.6 s, so even a request that skips every version read spends seconds in the remaining project, artifact, and page-date queries.
- **The deployment is slow below the application.** Pod request logs from the same window show `/ready` at a 1.5 s median, static files at 1.46 s, `/api/v1/projects` at 2.1 s, and media at 2.2 s. Inside the Postgres pod, `select 1` over the local socket took 1–14 ms and a `pg_stat_activity` count 110 ms, where both should take well under a millisecond. Single-thread CPU in a server pod was about half the speed of the measuring laptop and varied ±40% between identical runs. The node reported no CPU steal, 0.4% I/O wait, and 80% idle, while load average sat near 10.8 on 12 cores and Kubernetes workloads used about 1.5 cores. No pod has a CPU limit and the cgroup recorded no throttling.
- **So the next Library gain is not in this service.** The cache removes the per-artifact reads it was designed to remove (locally the endpoint is unchanged at 13 requests and sub-150 ms), but on this host every database round trip and every request costs milliseconds to seconds. That latency needs investigation at the VPS and hypervisor level before further application work can be measured reliably.

### Host CPU contention on the artifacts.backend.app VPS

Investigated October 6, 2026 with read-only commands on the single k3s node (SSD Nodes VPS, KVM, 12 vCPUs reported as Intel Xeon Silver 4216 at 2.1 GHz, Ubuntu 24.04, kernel 6.8.0-85).

- **The same CPU-bound work takes up to four times longer from one run to the next.** Eight identical Python loops on the host took 1,161 ms to 4,820 ms each, and the thread's CPU time matched its wall time in every run. The guest believes its thread ran the whole time; the work itself slowed down. On KVM that is the signature of the hypervisor withholding physical CPU from the guest's vCPUs.
- **The guest cannot see that contention.** `/proc/stat` records zero steal ticks after 202 days of uptime, and the boot log shows kvm-clock without steal-time reporting. Every in-guest metric (`top`, `vmstat`, `kubectl top`, Prometheus node CPU) therefore under-reports contention: the node looks 80% idle while 5 to 13 tasks wait to run on 12 vCPUs, and the kernel's schedstat counters showed an average of 2.3 tasks waiting across a 20-second window.
- **Disk is not the cause.** I/O wait stayed at 0–2% and `select 1`, which does not touch disk, still took milliseconds.
- **This explains the application symptoms.** A request that does milliseconds of local work spends seconds on this host, which matches `/ready` at a 1.5 s median, Postgres `select 1` at 1–14 ms, and the wide session-to-session variance recorded throughout this file. It also explains why the deployment sometimes feels fast: contention changes with the provider's other tenants.
- **Guest-side cost is secondary.** `k3s-server` averages about 85% of one vCPU over 82 days. That is worth reducing, but it cannot account for a fourfold slowdown of unrelated work on an otherwise idle 12-vCPU guest.

Hosted timings on this VPS should be read as an upper bound shaped by provider contention, not as application regressions, until the host has dedicated CPU or measurements record a host-speed canary alongside each sample.
