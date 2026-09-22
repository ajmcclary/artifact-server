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
| Cleanup bounds uploads, not file operations | One expired upload may contain many files. Successful staging remains retained, and general blob GC remains disabled. | T10/T25 |
| Worker/D1 limits differ from Node/Postgres | Already-implemented R2/assets/Cron do not prove a free-tier many-file envelope. Qualify actual query, parameter, object-operation and CPU limits before chunked preparation. | T08/T09 |

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

## Baseline policy
- `pnpm verify:iteration` is the required end-of-iteration gate. It includes correctness, a coverage report, conformance checks, and the default bounded baseline. Coverage percentage is not a test-design target.
- `pnpm smoke` catches broken behavior and gross regressions with deliberately loose machine-timing limits.
- `pnpm perf:baseline` records diagnostics and reports investigation warnings without failing on normal laptop variance.
- `pnpm verify:external-storage-performance` runs the real compiled two-process Postgres and S3-compatible path and records provider startup separately from application latency.
- Aggregate workload limits prevent command-line flags from accidentally creating a stress test.
- Set tighter regression budgets only after repeated runs on a controlled runner establish normal variance.
- Run the same behavior on local disk, every blob driver, Postgres, Kubernetes, and Cloudflare as those adapters are implemented.
