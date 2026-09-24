# Next steps

Updated September 24, 2026. This is the implementation backlog resulting from
the [engineering dossier intake](./project/research/immutable-artifact-engineering-2026-09-17/README.md)
and [repository reconciliation](./project/research/immutable-artifact-engineering-2026-09-17/RECONCILIATION.md).
The code inspected was `572e28f4beef971b94c9864408f5c067ad499ba1`.

The research and this plan do not mean the features below are implemented.
T02, T04, T06 and T07 are closed with their remaining gaps recorded; all
other T01–T27 tasks are open. Task IDs are planning identifiers, not new
conformance IDs. The [ledger](./project/spec/conformance.yml) remains the index
of product promises and proof; [AGENTS.md](./AGENTS.md) remains binding.

Keep TypeScript/Effect, narrow provider ports, immutable versions, explicit
publish conflicts, application-owned authorization, local-only linked files,
and follow-up-only bridges. Preserve existing binary publication, ranges,
compression, MCP HTTP, R2, assets, and Cron rather than implementing them again.
Use existing infrastructure or verified ongoing free allowances; no paid
subscription, live deployment, or destructive cleanup is authorized by this plan.
The September 23 account work was a separately approved bounded qualification;
it does not authorize future live runs or paid-plan changes.

## Work order

| Rank | Task | Expected result | Dependencies | Effort |
| --- | --- | --- | --- | --- |
| 1 | T03 Git order and bounded reconciliation | Correct an observed GIT-008 failure without affecting primary publication. | Existing probe; add focused regression first. | 5–8 days |
| 2 | T02 Create-only immutable writes (closed September 24) | Close S3/GCS provider parity gap and prove concurrent reuse. | T01 for performance claims, not for correctness work. | 3–5 days |
| 3 | T01 Measurement and evidence baseline | Attribute transfer, SQL, CPU and memory before choosing optimizations. | None. | 2–4 days |
| 4 | T04 Batch final Postgres manifest insertion (closed September 24) | Remove sequential per-file SQL while preserving one atomic commit. | T01. | 2–4 days |
| 5 | T05 Publication reconciliation and file resume | Recover lost responses and interrupted transfers without duplicate versions. | Retention semantics in T24; T02. | 4–7 days |
| 6 | T06 Review revision and authoritative refetch (closed September 24) | Remove deleted/dispatched records on other clients reliably. | T01; snapshot contract. | 3–6 days |
| 7 | T07 Browser evidence and critical engine matrix (closed September 24) | Produce fresh failure evidence and durable isolation/convergence proof. | None for finalization; T06 for convergence cases. | 3–6 days |
| 8 | T08 then T09/T10 Cloudflare limits and bounded work | Establish a supported workload and resumable preparation/maintenance. | T01, T02, T05. | 3–5 days qualification; 5–10 preparation; 3–5 cleanup |
| 9 | T15/T16/T17 MCP and identity/host qualification | Bound agent results and qualify current auth/delivery behavior. | T07 evidence; actual client/account access. | 3–5 days reads; 3–5 auth; 2–4 per host |
| 10 | Select T11, T12 or T13 from measurements | Implement one justified transfer improvement with ≥10% target-workload evidence. | T01, T02, T05; T08 for Workers. | 5–10 days per selected experiment/change |

Effort is an initial engineering estimate including focused tests, not a delivery
promise or all-provider qualification budget. Plan ranks 1–7 first. Work on T19
design ergonomics and T20 infrastructure previews when they can proceed without
delaying correctness work. T22–T26 are conditional work, not automatic expansion.

Suggested sequencing: first 30 days establish measurement, fix Git/writes/SQL,
and make failure evidence reliable; by 60 days complete retry/review consistency,
quota qualification and critical client/browser proof; by 90 days adopt only
measured transfer improvements and decide which deferred features are warranted.
Rescope against actual staffing and provider access rather than treating these
windows as deadlines.

## Verification rules for every task

Use these gate labels in the tasks below:

| Gate | Required work |
| --- | --- |
| V | `pnpm verify:iteration` and `git diff --check`; keep all required tests and strict checks. |
| P | Same-environment `pnpm perf:baseline` before/after; `pnpm perf:capacity` for process concurrency/memory. Run controlled repetitions separately from a loaded full gate. |
| H | `pnpm smoke` after HTTP, publication, SQLite, blob, restart or cleanup changes. |
| O | `pnpm verify:object-storage` for remote blob/staging changes. |
| E | `pnpm verify:external-storage-runtime` for Postgres/composition/configuration/migration/backup changes. |
| X | `pnpm verify:external-storage-performance` for external publish/read/query/pool/concurrency changes. This is separate from V. |
| B | `pnpm test:web` with durable current-run browser evidence; record engine/build/deployment identity. |
| L | Existing opt-in live provider/host suites with dedicated fixtures; emulator success is not live qualification. Check account cost before live work. |

Do not weaken durability, SHA verification, authorization, types, lint or
assertions to obtain faster numbers. Do not write coverage-only tests or use
module mocks. New public behavior needs a specification and allocated acceptance
IDs before being advertised; new IDs suggested below are not already allocated.
Close a task only when its normal and hostile outcomes are demonstrated and its
remaining deployment gaps are explicitly recorded. No automatic `verified`
promotion from research or a single local green run.

The September 23 checkpoint ran `pnpm verify:iteration` successfully after the
setup and documentation changes. Its refreshed evidence covers 388 main tests,
37 Chromium browser tests, 45 Cloudflare-package tests, native object storage,
external storage, coverage, packages, performance, Compose, Helm and Keycloak
OIDC. Live-provider gaps below remain gaps despite that local/provider-emulated
gate.

## Correctness and measurement

### T01 Establish attributable and comparable measurements

- **Current:** [performance harnesses](./project/performance/README.md) measure
  bounded local and two-process workloads. Prior Node 26.5 observations include
  204 ms max event-loop delay and about 708 MiB peak capacity RSS; these do not
  establish a leak or regression against Node 24.15. Historical numbers belong
  to different runs and machines.
- **Progress, September 21:** a shared `project/performance/measurement-context.ts`
  now records commit, working-tree dirty flag, `pnpm-lock.yaml` digest, Node
  version, platform, architecture, CPU model, available parallelism, operating
  system, temporary-filesystem type, and an optional caller-supplied details
  record. The local baseline, server-capacity baseline, external-storage
  baseline, SQLite Git-history backlog, and Postgres Git-history backlog all
  include these fields. The external-storage and Postgres Git-history reports
  record pinned container image references and digests through the details
  record. The local baseline additionally attributes each file-client request
  to `plan`, `staging`, `commit`, or `other` legs and records per-leg request
  count, bytes sent, bytes received, total, p50, p95, mean, and maximum
  milliseconds without logging bodies, tokens, or signed URLs. A
  [workload/account worksheet](./project/performance/WORKLOAD-WORKSHEET.md)
  captures provider plan, region, RTT, proxy topology, sizes, counts, retained
  bytes, backups, review hours, mutation rates, concurrency, durability, pool
  sizes, fixture identity, and warm/cold state. The D1 Git-history harness
  retains its existing environment fields because its tsconfig does not include
  the shared Node-only measurement module.
- **Do:** capture commit, resolved dependencies, runtime, CPU/OS/filesystem,
  provider/container digests, region/RTT, proxy topology, durability, pool size,
  fixture hash, warm/cold state, and client/server scope. Attribute walk/hash,
  plan, staging, verification, installation and final transaction separately.
  Count SQL, lock/pool wait, object APIs, bytes per network leg, retries,
  buffers/external memory and retained heap. Measure Git/archive workloads
  separately. Never log credentials, signed URLs or private bodies.
- **Done when:** repeatable fixture/profiling records answer which stage can
  plausibly save ≥10% end-to-end. Use randomized paired repetitions and report
  uncertainty; three samples do not support a tail claim. Larger 1,000/3,301-file,
  large-file and history-growth tests use a dedicated opt-in bounded harness,
  not relaxed canonical caps. Add a workload/account worksheet for missing
  operating facts. **Gates:** V/P/X, H if instrumentation changes HTTP paths.
  **Contracts:** OPS-009, existing performance requirements. **Cost:** existing
  local providers; live WAN measurements only within an explicit account budget.

### T02 Enforce create-only immutable installation across providers

- **Current:** [S3](./src/storage/s3-object-storage.ts) and
  [GCS](./src/storage/gcs-object-storage.ts) lack destination create-only
  preconditions; [R2](./deploy/cloudflare/src/r2-object-storage.ts) already uses
  a conditional create. Existing bad-declaration tests preserve original bytes.
- **Progress, September 21:** the S3 and GCS blob adapters now match the R2 and
  Azure semantics: a proven existing blob is inspected and reused after the
  caller re-proves its bytes through the stream verifier, and new installations
  are create-only (`If-None-Match: *` at PutObject or CompleteMultipartUpload
  for S3, `ifGenerationMatch: 0` for GCS). A lost S3 create-only race aborts the
  doomed multipart sessions for that key before reuse; staging slots stay
  unconditionally rewritable. New tests cover sequential and concurrent
  identical writes at multipart/resumable scale, a gated-stream create-only
  race loser with no leftover sessions, provider enforcement of the
  precondition against pinned MinIO and fake-gcs-server, and metadata-corrupted
  existing blobs failing closed.
- **Live-provider progress, September 23:** `pnpm verify:aws-s3` passed against
  AWS with a disposable, self-cleaned probe bucket; the JSON reporter is
  [s3-aws-probe.json](./project/evidence/s3-aws-probe.json). A GCS bucket-scoped
  service account also produced the native `ifGenerationMatch: 0` collision
  response, exact readback and cleanup against the configured probe bucket.
  The GCS probe is now repeatable and durable: `pnpm verify:gcs`
  (`scripts/run-gcs-probe.sh`; the bucket-scoped service account creates only
  run-scoped objects under a hashed installation namespace and the test deletes
  them) passed against the configured probe bucket, proving first-write
  create-only generations, collision rejection, resumable-scale exact readback,
  rewritable staging slots, false-size-declaration rejection and cleanup. The
  JSON reporter is [gcs-gcp-probe.json](./project/evidence/gcs-gcp-probe.json).
  Both advertised providers now have attached live create-only evidence.
- **Closed, September 24:** normal and hostile outcomes are demonstrated and
  the remaining gaps are recorded. Identical and conflicting concurrent writes,
  small/multipart boundaries, abort, retry, metadata corruption and
  precondition failures preserve original bytes and IDs across the S3, GCS, R2
  and Azure adapters; a proven existing blob is reused after its bytes are
  re-proved through the stream verifier, with no repeated object-generation
  installation. Live evidence is attached for both advertised remote providers:
  AWS ([s3-aws-probe.json](./project/evidence/s3-aws-probe.json)) and GCS
  ([gcs-gcp-probe.json](./project/evidence/gcs-gcp-probe.json)), each a
  disposable, self-cleaned probe from the separately approved September 23
  account qualification. Gates V/H/O/E/X/P passed at the recorded commits; the
  L gate is the two probe reports. Remaining deployment gaps: none for the
  advertised providers. Sealed-source promotion is separate conditional work
  (T12).
- **Do:** add provider-native create-only behavior behind the blob port, including
  multipart completion and verified reuse of a pre-existing destination. Separate
  immutable-blob semantics from reusable staging slots. Never treat a metadata
  string, ETag, or composite checksum as proof of the ordinary whole-file SHA-256.
- **Done when:** identical and conflicting concurrent writes, small/multipart
  boundaries, abort, retry, metadata corruption and precondition failures preserve
  original bytes and IDs; no repeated object-generation installation is needed
  for a proven existing blob. **Gates:** V/H/O/E/X/P, L per advertised provider.
  **Contracts:** PUB-003/004/006, ARC-004, DEP-011/022. **Cost:** local qualification
  adds no service; provider requests remain separately metered.

### T03 Repair Git order, reconciliation bounds and worker ownership

- **Starting evidence:** the [retained probe](./project/research/immutable-artifact-engineering-2026-09-17/review-evidence/git-order-probe.json)
  claimed version 8 first. SQLite/Postgres enablement inserts all missing jobs
  inside one foreground transaction; D1 has an unbounded insert-select. Claims
  order equal-time jobs by ID. See [mirror](./src/git-history/git-history-mirror.ts)
  and [Postgres repository](./src/storage/postgres-artifact-repository.ts).
- **Progress, September 17:** SQLite, Postgres and D1 now claim only versions
  whose earlier versions have recorded mappings. Enabling a project saves the
  setting without inserting the entire backfill; each worker claim queues at
  most 32 earliest missing versions across artifacts. Budget-limit wake-ups
  also move to bounded worker passes. Focused SQLite tests cover ordered
  eight-version backfill, retry-delayed predecessors, new publication during
  backfill and a 40-artifact queue limit. A two-worker Postgres integration
  test covers ordered claims.
- **Ownership progress, September 17:** claim attempts now fence repository
  recording, budget reservation, mirror/deletion completion and release across
  SQLite, Postgres and D1. The worker renews its 45-second lease every 15
  seconds; a real-time test keeps one owner while a commit runs beyond the
  original lease. SQLite and Postgres takeover tests reject stale writes;
  D1 claim and deletion fencing is exercised against Wrangler's local D1 binding.
  A forced takeover during a paused provider call leaves the successor claimed
  and prevents the old worker from recording a local mapping or releasing it.
- **Remote progress, September 18:** each mirror job reads the recorded prior
  version's commit. The smart-HTTP provider checks the cloned `main` tip and
  the advertised remote OID before a non-force branch push. Exact tags are
  adopted only after their commit parent, version metadata, full file list,
  copied bytes and pointer metadata match; an
  interrupted branch push can repair its missing tag. A disposable bare Git
  remote proves conflicting tags, forged metadata and copied bytes, lost
  branch/tag acknowledgements, a branch advance during push discovery, and
  two divergent concurrent successors. Before branch/tag push, the provider
  renews the durable claim; a real remote push paused during discovery cannot
  proceed after that claim is revoked. T03 remains open for the race between
  this last ownership check and remote ref update, live D1 multi-worker and
  provider concurrency proof, live-provider crash recovery, and controlled
  repeated provider backlog measurements.
- **Live-provider attempt, September 23:** the bounded Cloudflare Artifacts
  qualification authenticated to the approved account but stopped at namespace
  health (`dedicated namespace unavailable`) before creating a repository or
  performing a provider operation. T03's live-provider concurrency and crash
  recovery claims therefore remain open; this is an entitlement/availability
  result, not a passing qualification.
- **Crash progress, September 18:** separate local worker processes are killed
  after a disposable smart-HTTP remote accepts the branch push, both before
  the tag push and after the tag push but before its response. A restarted
  worker reclaims the expired SQLite lease, validates the exact commit,
  repairs or adopts its tag and records one mapping. Live-provider crash
  recovery remains open.
- **Race progress, September 21:** the provider re-asserts the durable claim
  after the final ref update and verifies that remote main and the immutable
  tag both name the pushed commit before reporting success; tag repair
  re-asserts ownership after its push. The disposable smart-HTTP remote gained
  a pre-backend receive-pack hold. New tests cover a claim lost during the
  branch update (the successor adopts the landed commit and repairs the tag),
  a claim lost during the final tag update (failure is reported instead of a
  commit the worker no longer owns), and a foreign branch advance between
  discovery and the ref update (rejected by the remote compare-and-swap, tip
  preserved). Live D1 multi-worker and provider concurrency proof,
  live-provider crash recovery, and controlled repeated provider backlog
  measurements remain open.
- **Backlog progress, September 18:** a dedicated opt-in 3,301-version SQLite
  diagnostic found 3,062 ms median idle claims with a deep history and 107 ms
  with many one-version artifacts. Bounded reconciliation now selects one
  earliest unmapped version per artifact without repeating the predecessor
  scan; an installation/version job index supports that lookup across SQLite,
  Postgres and D1. The same 30-pass local fixture measured 2.60 ms and 7.31 ms
  medians. A D1 binding regression and local HTTP test preserve cross-artifact
  fairness and per-artifact order. These are single paired local observations;
  live-provider backlog and controlled repeated baselines remain open.
- **Provider backlog progress, September 18:** the same opt-in 3,301-version,
  30-pass shapes completed against disposable pinned Postgres and local
  Wrangler D1. Postgres claim medians were 59.57 ms (many artifacts) and
  18.85 ms (deep history), with one 834.25 ms first deep-history pass. D1
  medians were 46.75 ms and 48.84 ms; its fixture setup took about 50–51
  seconds per shape. Reports separate setup from claims and preserve all pass
  samples. These local runs do not qualify managed Postgres, deployed Worker
  limits, full history growth or live Git traffic.
- **Iteration checks, September 18:** `pnpm verify:iteration`, `pnpm smoke`,
  and `pnpm verify:external-storage-performance` passed on Node 24.15.0.
  The external-storage baseline reported no investigation warnings. The
  Postgres and local D1 Git fixtures remain opt-in and outside canonical
  timing gates. The single paired SQLite before/after run does not establish
  a controlled speed claim.
- **Do:** introduce durable bounded reconciliation progress and semantic
  predecessor ordering. Serialize ownership per artifact across processes; prove
  lease renewal/fencing and remote predecessor/ref comparison. Keep optional Git
  unavailable/degraded state separate from primary readiness. Preserve snapshotted
  copy limits and reserved-byte budgets. Schedule fairly across artifacts, never
  by skipping a predecessor inside one artifact.
- **Done when:** test same-time multi-version backfill, retry-delayed predecessors,
  new publishes during backfill, two claimers, disable/re-enable, crash after
  branch/tag push, lost acknowledgements and work exceeding the 45-second lease.
  One version maps to at most one accepted commit; stale owners cannot advance
  remote/local state. Keep unrelated projects untouched and enablement bounded.
  A new permanent-blocked status requires explicit spec/API/UI treatment first.
  **Gates:** V/E/X/P and common provider suite; L for advertised remote behavior.
  **Contracts:** GIT-002/003/008/009/010/014. **Cost:** disposable local remote first;
  no new Cloudflare Artifacts paid-plan dependency.

### T04 Batch final Postgres manifest insertion

- **Current:** `#insertVersion` in the [repository](./src/storage/postgres-artifact-repository.ts)
  performs one insert per entry; upload-plan batching is already implemented.
- **Progress, September 21:** `#insertVersion` now writes manifest entries with
  one bounded `INSERT ... SELECT` over `jsonb_to_recordset` (three parameters
  regardless of entry count — the representation upload-plan batching already
  used), replacing one statement per entry; empty manifests skip the batch
  statement. The single version/manifest/action/idempotency/current-pointer
  transaction and the source-ready checks are unchanged. Exact manifest/bytes,
  conflict and idempotency behavior, and transaction-stage failures remain
  covered by the external-storage runtime suite, which passed against pinned
  Postgres/MinIO along with `pnpm check`, `pnpm smoke`, and the
  external-storage performance baseline (no investigation warnings). A paired
  same-machine observation of the 48-file directory workload moved p95 from
  344.61 ms to 388.18 ms — within single-run noise, so no speed claim is made;
  the reduction from 1 + N statements to 2 per version is structural.
  Controlled repeated measurements of query count, lock duration, and commit
  time on a named workload, and live managed-Postgres qualification, remain
  open.
- **Repetition progress, September 23:** three sequential external-storage
  baseline repetitions on one idle machine (Node 24.15.0, commit `4f21086`,
  `project/evidence/external-storage-baseline-rep{1,2,3}.json`) measured the
  named 48-file directory workload at p95 421.58 / 393.97 / 427.58 ms (median
  421.58, spread about ±4%) with no investigation warnings, holding the
  September 21 paired observation (388.18 ms) within run-to-run noise. Three
  local baseline repetitions
  (`project/evidence/local-baseline-rep{1,2,3}.json`) put the same workload at
  p95 859.81 / 908.60 / 863.38 ms with the commit leg dominating at
  397.12 / 425.12 / 377.44 ms. These bound gross variance but do not support
  tail claims; live managed-Postgres qualification remains open.
- **Managed-Postgres setup, September 23:** a Neon Free PostgreSQL 17 database
  is configured through a pooled TLS URL outside the repository. The connection
  reached migration 14 and passed a real query, transaction, advisory-lock and
  commit check. No controlled live batch/query-count/lock-duration measurement
  has been recorded yet, so T04's managed-provider performance claim remains
  open.
- **Managed-Postgres measurement, September 23:** three sequential
  external-storage baseline repetitions against the managed Neon database and
  the private AWS bucket (Node 24.15.0,
  `project/evidence/external-storage-baseline-neon-rep{1,2,3}.json`) measured
  the named 48-file directory workload at p95 11,034.57 / 12,331.54 /
  10,888.92 ms (median 11,034.57, spread about ±6%), single-file publication
  p95 5,196.08 / 5,096.80 / 4,739.31 ms, concurrent-publish p95 3,156.50 /
  2,691.84 / 2,489.84 ms, and cross-process read p95 under 200 ms. WAN round
  trips dominate every leg — the same workload measures about 400 ms p95
  against local containers — so the batched manifest insert (structurally 2
  statements per version instead of 1 + N) removes N − 2 round trips per
  version at commit time while the staged-to-blob copy leg continues to
  dominate end-to-end time, the same shape the local batch experiment found.
  The investigation warnings in these reports reflect WAN latency against
  thresholds calibrated for local containers, not product regressions; the
  container-based gates still run locally and are unaffected. Per-version
  statement counts are structural (the single `INSERT ... SELECT` over
  `jsonb_to_recordset`), and commit-leg timings are in the reports; a
  dedicated lock-duration probe was not added. The baseline harness now
  accepts managed providers through `ARTIFACT_SERVER_TEST_S3_BUCKET` /
  provider-chain credentials (path-style off, no bucket creation) while
  keeping the container wrapper as the default gate. T04's managed-provider
  performance evidence is now recorded; the ≥10% claim discipline is unchanged
  (no speed claim is made from these runs).
- **Closed, September 24:** normal and hostile outcomes are demonstrated and
  the remaining gaps are recorded. The final manifest insertion is one bounded
  `INSERT ... SELECT` over `jsonb_to_recordset` (three parameters regardless
  of entry count; 2 statements per version instead of 1 + N) inside the
  unchanged single version/manifest/action/idempotency/current-pointer
  transaction with the existing source-ready checks. Exact manifest/bytes,
  conflict/idempotency behavior and transaction-stage failures are covered by
  the external-storage runtime suite against pinned Postgres/MinIO. Controlled
  measurements: three local-container repetitions
  ([external-storage-baseline-rep1.json](./project/evidence/external-storage-baseline-rep1.json),
  [rep2](./project/evidence/external-storage-baseline-rep2.json),
  [rep3](./project/evidence/external-storage-baseline-rep3.json)) and three
  managed Neon repetitions
  ([neon-rep1](./project/evidence/external-storage-baseline-neon-rep1.json),
  [neon-rep2](./project/evidence/external-storage-baseline-neon-rep2.json),
  [neon-rep3](./project/evidence/external-storage-baseline-neon-rep3.json)),
  Node 24.15.0, with per-version statement counts structural and commit-leg
  timings in the reports; no ≥10% speed claim is made. Gates V/H/E/X/P passed
  at the recorded commits. Remaining gaps: a dedicated lock-duration probe was
  not added (recorded, not blocking); PUB-005 stays `specified` in the ledger,
  a pre-existing status this task does not change.
- **Do:** choose a bounded batch representation compatible with query/parameter
  limits. Preserve the single version/manifest/action/idempotency/current-pointer
  transaction and existing source-ready checks.
- **Done when:** compare exact manifest and bytes, conflict/idempotency behavior,
  and failures during each transaction stage. Measure query count, lock duration,
  commit and end-to-end time. Claim ≥10% only on a named measured workload;
  Postgres work does not directly accelerate SQLite metrics. **Gates:** V/H/E/X/P.
  **Contracts:** PUB-005/006/008, PRJ-002/004. **Cost:** existing Postgres/MinIO.

### T05 Reconcile publication operations and resume verified files

- **Current:** [CLI journal](./src/cli/publication-operation-store.ts) preserves
  operation identity, but [file client](./src/client/file-publication-client.ts)
  creates a new upload and sends every file before commit replay.
- **Progress, September 21:** staged uploads can now bind the durable
  publication idempotency key (`staged_uploads.idempotency_key`, partial unique
  index per installation/project/principal) across SQLite, Postgres (migration
  0013), and D1 (schema 11). `POST /api/v1/uploads` accepts an optional
  `Idempotency-Key` header: a committed key returns the recorded publication
  (`200`, `status: "committed"`, `replayed: true`) without staging access; an
  open upload with the same manifest digest returns `status: "resumed"` with
  per-file `verified` flags; a changed manifest under one key is a 409
  `IDEMPOTENCY_CONFLICT`; an expired key-bound upload is removed and recreated;
  a concurrent-create race re-reads and resumes. The file client sends its
  journal key on create, skips verified files on a resumed plan, and returns a
  committed result without any transfer. HTTP tests cover created/resumed/
  committed/conflict/expiry/invalid-key; client tests prove a dropped mid-file
  connection resumes without re-sending verified bytes and a committed key
  performs zero PUTs and no commit POST; SQLite and D1 store tests cover key
  binding, uniqueness, null-key coexistence, cross-principal invisibility, and
  in-place schema upgrades. The process-level CLI crash test (CLI-003-B/F)
  now recovers a lost commit response through the committed lookup without
  re-sending files. PUB-015 specifies the behavior with PUB-015-B/F
  acceptance IDs. Retention semantics are unchanged: no perpetual negative
  results, no successful-staging reclamation. Remaining open: Postgres
  store-level key tests beyond the runtime suite, deployed-runtime resume
  evidence, Cloudflare Worker resume, and MCP-surface recovery (T15).
- **Postgres progress, September 23:** the Postgres store-level key tests are
  now in `tests/integration/postgres-staged-upload-idempotency.test.ts`,
  running in the external-storage suite against pinned Postgres: key binding,
  cross-principal invisibility and coexistence, partial-index uniqueness
  violations (asserted as structured `SqlError` `UniqueViolation` reasons),
  null-key coexistence, and a genuine pre-0013 upgrade — a scratch database
  with the pre-0013 `staged_uploads` schema and migration ledger at version 12
  migrates in place, preserving the legacy row with a null key while new
  key-bound writes enforce uniqueness. The full external-storage runtime
  suite passed with the file included (26 tests, 2 files). Remaining open:
  deployed-runtime resume evidence, Cloudflare Worker resume, and MCP-surface
  recovery (T15).
- **Deployment-prerequisite progress, September 23:** the managed Postgres
  connection is paired with a private, versioned, encrypted AWS bucket and the
  least-privilege `artifact-server-runtime` profile. Native S3 create-only,
  collision, exact-readback and cleanup checks passed; see
  [aws-runtime-storage.json](./project/evidence/aws-runtime-storage.json). The
  end-to-end deployed-runtime resume test has not run. A fresh Cloudflare
  runtime-stage probe deployed and cleaned its Worker/D1/R2 resources but its
  health, readiness, unauthenticated and upload requests returned HTTP 503, so
  it does not close the Worker resume item.
- **Deployed-runtime resume, September 23:** the new opt-in live suite
  `pnpm verify:deployed-runtime-resume`
  (`tests/integration/deployed-runtime-resume.live.test.ts`, support in
  `tests/support/managed-external-storage.ts`) ran the compiled
  external-storage server against the managed Neon database and the private
  AWS bucket through the real HTTP boundary. A SIGKILL mid-publication (16 MiB
  file in flight) recovered on a replacement process with the same installation
  ID: the resumed plan reported the small verified file as `verified: true`
  (not retransmitted), re-sent only the unverified file, committed version 1,
  and served exact bytes for both files with exactly one version on the
  artifact. A dropped commit response (a loopback proxy destroys the first
  commit response after the server processed it) replayed as
  `status: "committed"`, `replayed: true` with the same single version and no
  retransfer. Evidence:
  [deployed-runtime-resume.json](./project/evidence/deployed-runtime-resume.json)
  (2/2 passing at HEAD; three earlier failed attempts — an operator-environment
  provider clash and two test-schema bugs, no product defects — are preserved
  as `deployed-runtime-resume.failed-20260923-*.json`). Remaining open:
  Cloudflare Worker resume (blocked by the runtime 503) and MCP-surface
  recovery (T15).
- **Do:** design an authorized operation lookup before transfer allocation,
  persisted upload/file completion state, renewal/expiry, and recovery after
  a changed local source. Return a committed result without staging access.
  Keep credentials origin-bound and progress reports secret-free. Decide retention
  and negative-result semantics explicitly; do not silently adopt perpetual
  replay or permanent storage of conflicts from the dossier.
- **Done when:** crash after plan, mid-file, after verification, after commit with
  lost response, and after permitted staging cleanup all recover without duplicate
  versions or unnecessary verified-file retransmission. Changed input, another
  principal/project, expired authority and stale expected-version remain safe.
  **Gates:** V/H/O/E/X/P; B for browser-facing recovery. **Contracts:** PUB-001/006/008/012/014,
  MCP-008; allocate operation-status/resume acceptance IDs. **Cost:** existing stores.

### T06 Make committed review changes converge across clients

- **Current:** [timestamp polling](./apps/web/src/components/comments/comment-poll.ts)
  merges changes and leaves removed/filter-excluded threads stale.
- **Progress, September 21:** artifacts now carry a `comment_revision` counter
  incremented inside the same transaction as every listing-visible change
  (thread create/edit/resolve/delete, reply create/edit/delete, bulk clear,
  dispatch link/release) across SQLite (schema 15), Postgres (migration 0014),
  and D1 (schema 12). The comment listing returns `revision` on every page and
  accepts an optional `revision` parameter: a matching revision short-circuits
  to an empty page without reading threads, and a stale revision returns the
  authoritative filtered page, so deletions and dispatch removals converge. The
  web Review poll sends its known revision, no-ops on equality, and otherwise
  replaces the visible list through the same full-reload path; multi-page reads
  pin to the first page's revision and restart on mismatch (bounded retries).
  HTTP conformance tests (CMT-023-B/F) cover short-circuit, delete/dispatch
  convergence, per-artifact isolation, and invalid revisions; store tests cover
  the counter on SQLite and D1; a two-context Chromium test proves create and
  delete converge on both open reviewers without reload. The 30-second AUTH-022
  bound is untouched (revision checks are same-query integer comparisons).
  Remaining open: Postgres revision behavior is covered only through the
  external-storage runtime suite, hot-project contention and polling-cost
  measurements are unrecorded, and Firefox/WebKit convergence runs await T07's
  engine matrix.
- **Measurement progress, September 23:** polling cost and hot-project
  contention are now recorded by a new bounded harness
  (`pnpm perf:comment-polling`,
  `project/evidence/comment-polling-baseline.json`): on a 200-thread artifact
  (local SQLite, Node 24.15.0, commit `4f21086`), matching-revision
  short-circuit polls cost p95 1.07 ms at about 1,296 ops/s, stale-revision
  authoritative pages cost p95 2.49 ms, and a five-second contention phase
  (eight pollers plus one create/delete mutator) completed 529 mutations with
  poll p95 22.54 ms — far below the 7-second visible-tab poll interval. The
  three-engine convergence evidence was refreshed at `4f21086`
  (`project/evidence/browser.json`, 45/45, 0 flaky), so CMT-023-B/F
  convergence now holds on Chromium, Firefox, and WebKit at HEAD. Remaining
  open: Postgres revision behavior beyond the external-storage runtime suite
  and Postgres/deployed polling cost.
- **Managed-provider readiness, September 23:** the Neon PostgreSQL 17
  connection is available for the missing deployed polling-cost run, but only
  connection, transaction and advisory-lock behavior has been checked so far.
  No managed-Postgres polling or contention result is claimed.
- **Managed polling measurement, September 23:** the comment-polling harness
  now shares its phases between local and managed targets
  (`project/performance/comment-polling-shared.ts`), and a new runner
  (`project/performance/run-comment-polling-managed.ts`) drove the same
  200-thread artifact against the compiled external-storage server on the
  managed Neon database plus the private AWS bucket
  ([comment-polling-baseline-neon.json](./project/evidence/comment-polling-baseline-neon.json),
  Node 24.15.0): matching-revision short-circuit polls cost p95 268.12 ms,
  stale-revision authoritative pages p95 405.87 ms, and a five-second
  contention phase (eight pollers plus one create/delete mutator) completed 4
  mutations with poll p95 624.91 ms and mutation p95 1,705.90 ms. WAN round
  trips dominate every leg, but the 7-second visible-tab poll interval still
  fits with ample headroom, and the concurrent revision increments converged
  without error, exercising Postgres revision behavior beyond the
  external-storage runtime suite. The refactored local harness reproduced
  consistent local numbers (short-circuit p95 0.94 ms, stale page p95 2.37 ms,
  627 contention mutations; refreshed
  [comment-polling-baseline.json](./project/evidence/comment-polling-baseline.json)).
  T06's measurement and Postgres-coverage gaps are now closed.
- **Closed, September 24:** normal and hostile outcomes are demonstrated and
  the remaining gaps are recorded. The `comment_revision` counter increments
  inside the same transaction as every listing-visible change across SQLite
  (schema 15), Postgres (migration 0014) and D1 (schema 12); a matching
  revision short-circuits without reading threads and a stale revision returns
  the authoritative filtered page, so deletions and dispatch removals converge.
  Two browser contexts converge after create/delete on Chromium, Firefox and
  WebKit (the September 23 three-engine run recorded 45/45, 0 flaky at
  `4f21086`; [browser.json](./project/evidence/browser.json) is regenerated by
  each browser run, so the file records the latest run rather than retaining
  that artifact). Polling cost and hot-project contention are measured locally and
  against the managed Neon database
  ([comment-polling-baseline.json](./project/evidence/comment-polling-baseline.json),
  [comment-polling-baseline-neon.json](./project/evidence/comment-polling-baseline-neon.json)),
  with ample headroom under the 7-second visible-tab poll interval and
  concurrent revision increments converging without error; Postgres revision
  behavior is exercised beyond the external-storage runtime suite through the
  managed contention run. The 30-second AUTH-022 bound is untouched. Gates
  V/B/E/X/P passed at the recorded commits. Remaining gaps: none recorded.
- **Do:** specify an authorized revision plus authoritative replacement/refetch
  contract. Increment revisions in each relevant mutation transaction across
  SQLite/Postgres/D1. Prove multi-page snapshot consistency through a coherent
  snapshot or bounded revision-before/after retry. Include deletions, dispatch
  removal/reappearance, replies and selected-version transitions. Keep installation
  auth invalidation separate and preserve the 30-second AUTH-022 bound.
- **Done when:** two browser contexts and two processes converge after mutation,
  lost notification, reload, hidden-tab return and concurrent pagination; no
  unauthorized identifiers leak. Measure hot-project contention and polling cost.
  **Gates:** V/B/E/X/P. **Contracts:** CMT-011/012/019/020, DSP-004/009, PRJ-002,
  AUTH-022/027; allocate revision/snapshot acceptance IDs. **Cost:** existing DB;
  no broker/SSE requirement. **Dependencies:** T01, T07 for durable browser proof.

### T07 Make browser evidence failure-safe and qualify critical engines

- **Current:** [test scripts](./package.json) skip normalization when Playwright
  fails; [configuration](./playwright.config.ts) defaults to Chromium. Full CI
  evidence upload also needs failure handling.
- **Do:** finalize a unique current-run result on setup/launch/test/report-copy
  failure, preserve the original exit code, and fail closed on missing/truncated
  reports. Record commit/build, deployment, config hash, engine/build, OS, run
  times and flaky/retry status. Preserve prior runs separately. Redact test
  cookies, signed URLs and private content before uploading traces. Replace
  fixed sleeps with observable assertions. Define a critical Firefox/WebKit
  matrix rather than blindly tripling every cosmetic test.
- **Done when:** inject failures before and after browser launch and no stale
  pass can masquerade as current evidence. Prove exact-version navigation,
  opaque/interact isolation, historical/private assets, logout/lease expiry,
  two-client convergence, downloads/media, drafts and design previews across
  selected engines. **Gates:** V/B plus CI evidence-path checks.
  **Contracts:** CMT-014/016/018/022, AUTH-010–016, GATE-001, relevant PRV/DRF IDs;
  allocate evidence-lifecycle acceptance IDs. **Cost:** existing runner/storage allowance.
- **Matrix progress, September 22:** fixed sleeps in
  `tests/browser/drf-001-draft-durability.spec.ts`,
  `tests/browser/drf-002-draft-isolation.spec.ts` and
  `tests/browser/frontend-mvp.spec.ts` are replaced with observable assertions;
  `scripts/redact-browser-diagnostics.ts` (wired into both browser CI jobs with
  `pnpm redact:browser-diagnostics`) redacts cookies, secret keys, signed-URL
  params and private trace content before upload;
  `tests/browser/critical-engines.spec.ts` pins the 4 critical-engine tests
  (CMT-014/016/018/023) behind per-project `testMatch` gated on
  `BROWSER_CRITICAL_ENGINES` (`--list`: 35 tests/14 files Chromium-only;
  4 tests/1 file with `BROWSER_CRITICAL_ENGINES=firefox --project=firefox`).
  - **Matrix run, September 22:** with Firefox 153.0 and WebKit 26.5 installed
  (`pnpm exec playwright install firefox webkit`), the matrix has now executed
  for real. Firefox and WebKit each pass **4/4** critical tests, and one
  combined pass through the real evidence runner runs **43/43** in 3.6 minutes
  (Chromium 35 across 14 suites, plus the 4-test critical slice on each of
  Firefox and WebKit), recording `project/evidence/browser.json` with
  `success:true`, engine `chromium+firefox+webkit@1.62.1`. The final
  `BROWSER_CRITICAL_ENGINES=all pnpm verify:iteration` then regenerated the
  same three-engine evidence (43/43, 0 failed, 0 flaky, 14/14 suites, exit 0)
  and rotated the prior three-engine artifact into the single retained
  `browser.previous.json` slot — so the earlier Chromium-only artifact is no
  longer on disk, though its Chromium tests are part of the current evidence. The
  opaque-origin sandbox, exact-version pinning, historical asset delivery, and
  two-reviewer convergence hold on Gecko and WebKit, not only Chromium. CI was
  then wired to match: the full-gate job installs all three engines and sets
  `BROWSER_CRITICAL_ENGINES: all`, so its existing `pnpm test:web` step runs the
  whole matrix, while the PR job stays Chromium-only for speed
  (`pnpm check:ci` still verifies all 14 ordered full-gate commands
  unchanged). Remaining open: the CI path itself is wired and locally
  equivalent but unexecuted — no CI run has yet produced the three-engine
  evidence artifact.
- **CI progress, September 23:** the CI path has now executed for real. The
  disabled `CI` workflow was enabled in this fork and a `tier=full` dispatch
  on `main` (`4f21086`, run 35879627083) completed **success** in 32 minutes:
  the Full / Linux iteration gate, macOS portability, and Windows local
  publishing jobs all passed with `BROWSER_CRITICAL_ENGINES=all`, so CI itself
  now runs the three-engine browser matrix and regenerates the evidence
  artifact. The same day, local three-engine evidence was refreshed at
  `4f21086` (`project/evidence/browser.json`: 45/45, 0 failed, 0 flaky,
  15/15 suites, engine `chromium+firefox+webkit@1.62.1`), and the full local
  gate `BROWSER_CRITICAL_ENGINES=all pnpm verify:iteration` passed exit 0.
- **Injection progress, September 22:** the finalizer
  (`scripts/write-browser-evidence.ts`, driven by `scripts/run-browser-evidence.ts`)
  was failure-injected three ways against repo-relative temp evidence paths
  (temp dir removed after; `project/evidence/browser*.json` untouched): missing
  report with exit 42 wrote `success:false` with `"Browser report not found at
  ..."` and engine `unknown`, exiting 1; a truncated report (`'{"config": {'`)
  with exit 0 wrote `success:false` with `"truncated or invalid JSON"`, rotated
  the prior passing evidence to `browser.previous.json` intact, and exited 1;
  a clean report with exit 1 wrote `success:false` with `"Playwright exited
  with code 1"` and exited 1. No stale pass can masquerade as current evidence.
  - **B-gate progress, September 22:** the drf-002 failure was a test bug,
  not an app bug: `expect.poll(...).toEqual([expect.not.stringContaining(":new:")])`
  resolves on an empty array because Jasmine `equals` treats a missing index
  as matching an asymmetric expectation, so the poll resolved before the
  400 ms draft mirror debounce fired (probe showed `ATTEMPTS=[[]]`; sampling
  showed a single `[] → [key]` transition at ~409 ms with no removal). The
  spec now polls `.toHaveLength(1)`; the prefix/`":new:"` assertions are
  unchanged and still prove isolation. drf-002 passes 6/6 isolated and the
  full prebuilt Chromium B gate passes **35/35 across 14 suites**
  (`success:true`, engine `chromium@1.62.1`, commit `720e06b`, `tsc` clean;
  that Chromium-only artifact has since been rotated out of
  `project/evidence/browser.json` by the later three-engine run, which
  includes the same 35 Chromium tests). The V gate and
  Firefox/WebKit execution left open here are closed by the V-gate and
  matrix-run notes below; only CI-path execution remains open.
  - **V-gate progress, September 22:** `pnpm verify:iteration` passed clean
  (exit 0) the same day: full check, `test:web`, AWS/GCP Pulumi, object
  storage, external-storage runtime plus compose suites, coverage,
  local-package, perf baseline plus capacity, compact-compose, Helm, and
  OIDC, with evidence JSON regenerated under `project/evidence/`. One
  gate-internal fix was needed first: the T05 upload-plan response field
  `verified` had no counterpart in the perf capacity baseline's strict file
  schema, failing `perf:capacity` with an unrecognized-keys zod error;
  adding the key to `project/performance/server-capacity-baseline.ts`
  restored exit 0 with no product-code change. The polling change was
  ruled out as the timeout cause — the only timeout-adjacent failure was
  this schema mismatch.
  - **Closed, September 24:** normal and hostile outcomes are demonstrated and
  the remaining gaps are recorded. The evidence finalizer fails closed on a
  missing report, a truncated report, and a nonzero Playwright exit
  (three-way failure injection, prior evidence rotated intact, original exit
  codes preserved); diagnostics are redacted before CI upload; fixed sleeps
  are replaced with observable assertions. The critical-engine matrix
  (CMT-014/016/018/023) passes locally on Chromium, Firefox and WebKit
  (September 23 three-engine run: 45/45, 0 failed, 0 flaky at `4f21086`,
  engine `chromium+firefox+webkit@1.62.1`;
  [browser.json](./project/evidence/browser.json) is regenerated by each
  browser run, so the file records the latest run rather than retaining that
  artifact) and in CI — the
  full-gate dispatch on `main` at `4f21086` (run 35879627083) completed
  successfully with `BROWSER_CRITICAL_ENGINES=all` on the Linux, macOS and
  Windows jobs, so CI itself regenerates the three-engine evidence artifact.
  Remaining gaps: none recorded.

## Storage, platform and transport experiments

### T08 Establish actual Cloudflare and provider cost envelopes

- **Do:** inventory the selected account plan and actual publication sizes/counts,
  retained bytes, backups, visible review hours, mutation rates and client usage.
  Measure Worker CPU/subrequests/body limits, D1 query/row/index/storage costs,
  R2 operation classes and staging/multipart growth. Separate Workers+D1+R2 from
  Node+Postgres+R2. Record hard failures versus overage behavior and capability
  reporting. Use current official pricing, not a free-trial assumption.
- **Progress, September 22:** the read-only slice is done in
  [CLOUDFLARE-COST-ENVELOPE.md](./project/performance/CLOUDFLARE-COST-ENVELOPE.md):
  a completed worksheet separating measured local facts (publication sizes,
  retained bytes, the 1/10/25/50/100-user capacity matrix, and the local-D1
  Git-backlog probe) from official Cloudflare pricing and limits dated
  2026-09-22 (Workers, D1, R2, each with sources). It records the polling
  math with duration stated (7-second visible-tab-only interval; eight tabs
  for 24 hours sit one percent under the Free 100,000 requests/day cap while
  an eight-hour workday fits), the per-file R2 operation profile (~2 Class A
  + 1 Class B per staged file; deletes and multipart aborts free but still
  execution work), and the supported-envelope read: light teams fit Workers
  Free within a workday, sustained 24-hour multi-tab review requires Workers
  Paid, and the 3,301-file publication shape is rejected as unqualified on a
  live Worker.
- **Account progress, September 23:** the approved account is Workers Free and
  R2 is active at a $0/month base. The observed R2 allowance is 10 GB-month,
  1 million Class A operations/month and 10 million Class B operations/month;
  standard-storage overage is $0.015/GB-month, Class A $4.50/million and Class B
  $0.36/million, with zero Internet egress fees. The account probe matched the
  exact account, created the expected Worker/D1/R2 shape, repeated with no drift,
  and cleaned every exact probe resource without changing non-probe inventory.
  [cloudflare-account-probe.json](./project/evidence/cloudflare-account-probe.json)
  records hashes and checks; the worksheet now records the plan. Remaining:
  actual retained bytes, backups, review hours, mutation rates, isolated RTT and
  any observed hard-fail or overage behavior. The current runtime 503 remains a
  separate open item.
- **Done when:** a bounded worksheet and qualification report identify the
  supported envelope and reject unsupported many-file assumptions. R2 deletes
  and aborts are free billed operations but still execution work. Eight visible
  tabs for 24 hours differ from an eight-hour workday; state the duration in
  polling calculations. Preserve private buckets and existing off-by-default Git.
  **Gates:** V and L where available; no unsupported deployment is promoted.
  **Contracts:** DEP-007/011, MCP-003, GIT-007/014. **Dependencies:** T01.
  **Cost:** read-only inventory/local emulation first, live requests within actual allowance.

### T09 Design bounded Cloudflare preparation with atomic final visibility

- **Current:** [publication](./src/application/publish-artifact.ts) installs files
  in one operation; D1/R2 invocation limits are not the same as Node limits.
- **Do:** after T08, design resumable chunked verify/install work with durable
  operation progress and expiration/ownership. Keep the final manifest/version,
  action, idempotency and expected-current result atomic. A large manifest does
  not become small merely because blob work was moved earlier: qualify statement
  bytes, parameter/query counts and D1 transaction limits or specify an invisible
  prepared-manifest representation before implementing it.
- **Done when:** forced per-invocation budgets, restart, concurrent finalize,
  provider outage and source replacement cannot expose partial versions or
  lose a committed replay. **Gates:** V/H/O, Cloudflare runtime suite and L;
  E/X for changed shared composition. **Contracts:** PUB-001/003–008, ARC-004,
  DEP-007; new prepare/finalize IDs. **Dependencies:** T02/T05/T08.
  **Cost:** no new paid orchestrator; reject a design that cannot fit the chosen plan.

### T10 Bound cleanup and separate staging lifecycles

- **Current:** [cleanup](./src/application/expired-staging-cleanup.ts) limits upload
  count but walks all files; successful staging is retained.
- **Do first:** bound uncommitted cleanup by files/operations/time with durable
  continuation, interruption-safe retry and active-write/prepare protection.
  **Do later:** only after T05, specify successful-staging reclamation independent
  of idempotent replay, backups and active preparations. Amend PUB-009/OPS-006
  deliberately for that new lifecycle. Abort abandoned provider multipart work
  through its adapter; do not age-delete immutable blobs.
- **Done when:** a large expired upload resumes over many passes, cleanup racing
  write/finalize is safe, and lost commit responses still replay after any newly
  permitted cleanup. **Gates:** V/H/O/E/X, Cloudflare runtime suite.
  **Contracts:** PUB-009, OPS-003/006/007. **Dependencies:** T08 for Worker budgets;
  T05/T24 for successful staging. **Cost:** existing providers.

### T11 Qualify signed and resumable large-file transfers

- **Do:** compare app-origin binary transfer with native signed PUT/multipart or
  GCS resumable staging. Negotiate trusted upload origins/required headers without
  forwarding application bearer tokens or allowing arbitrary redirects. Seal
  exact staged generations and prove logical size/full SHA-256. Persist sessions,
  expiration/renewal and abort state across clients/replicas. Consider tus only
  if a measured cross-provider requirement remains.
- **Done when:** interrupted, expired, reused, tampered and cross-project URLs
  cannot mutate committed bytes or select storage keys. Choose the size/RTT
  threshold from controlled results including verification and commit time.
  **Gates:** V/H/O/E/X/P/B where browser uploads apply, L per provider.
  **Contracts:** PUB-001/002/003/012/014, MCP-007/008; new signed/resumable IDs.
  **Dependencies:** T01/T02/T05, T08/T09 for Workers. **Cost:** provider allowance;
  incomplete parts and request usage counted.

### T12 Qualify sealed-source promotion per adapter

- **Do:** add a product-named promotion capability only after source sealing,
  destination create-only installation, digest verification and retry semantics
  are specified. Qualify AWS source/version and destination conditions, GCS
  generations, and R2 separately. R2 beta copy extensions are not the common
  correctness foundation. Keep streaming fallback. A local hard-link fast path
  must eliminate all writable handles/aliases and preserve directory durability.
- **Done when:** source replacement, same-digest races, mismatched metadata,
  cancellation, partial copy and lost response preserve bytes and one publication
  result. Demonstrate an applicable measured gain before enabling a fast path.
  **Gates:** V/H/O/E/X/P/L. **Contracts:** PUB-003/004/005/006, ARC-002/004,
  DEP-011/022. **Dependencies:** T01/T02/T05. **Cost:** existing provider operations;
  no claimed gain or cloud entitlement from documentation alone.

### T13 Experiment with bounded binary small-file batches

- **Do:** measure binary staging batches for 48/1,000/3,301-file fixtures with
  fresh and repeated bytes. Bound files, compressed/decompressed bytes, parser
  memory, operation counts, and failure granularity. Keep authoritative per-file
  paths/size/hash; an archive/batch is only a transport representation. No base64.
- **Done when:** malformed, duplicate, escaping, oversized, interrupted and
  partially accepted parts recover correctly and a named workload shows a
  repeatable ≥10% end-to-end gain. **Gates:** V/H/O/E/X/P; B for browser transport.
  **Contracts:** PUB-002–006, path security; new batch/partial-retry IDs.
  **Dependencies:** T01/T02/T05; T08 budgets. **Cost:** existing local infrastructure.
- **Progress, September 22:** the experiment is complete and the verdict is
  **not adopted**. An opt-in batch transport (`{transport: "batch"}`, default
  per-file) carries small files in one binary frame to a new
  `POST /api/v1/uploads/:uploadId/batch` route, reusing the per-file staging
  writes and per-part verified flags; PUB-016-B/F and PUB-017-B are claimed by
  real conformance tests (exact-bytes commit; malformed, duplicate, unknown,
  size-mismatched, and truncated frames verify nothing; truncated-batch resume
  sends only missing parts and commits one version), and every existing PUB
  recovery test still passes. The paired harness
  (`pnpm perf:batch-staging-comparison`,
  `project/evidence/batch-staging-comparison.json`) shows the staging leg about
  75% cheaper but the end-to-end delta **below the 10% bar** — about +7% at
  48 × 4 KiB and about 0% at 1,000 files — because the commit-time staged-to-blob
  copy is unchanged and dominates at scale. An early sequential server loop made
  the batch 16% slower; writing parts at the existing concurrency four restored
  the staging win. The batch stays opt-in and unadopted; promotion is rejected on
  this evidence (its staging win is most relevant to per-call-billed
  Workers/R2/D1 workloads under T08, not this local Node path). Full write-up in
  `project/performance/FINDINGS.md`.

### T14 Evaluate authorized content reuse and bounded metadata reads

- **Do:** measure repeated-byte ratio and catalog growth before adding transfer
  suppression, counters or indexes. Client-visible reuse must derive from content
  the caller may already inspect; installation-wide human membership does not
  imply every service principal has the same authority. Conceal foreign digest
  existence in response shape/timing as well as endpoint names. Profile correlated
  catalog counts, substring search, immutable manifest lookup and pool waits.
- **Done when:** useful reuse/read gains are measured and unauthorized requests
  learn nothing about foreign content; counter/index changes survive concurrent
  mutations and migrations. **Gates:** V/H/E/X/P/O when blob behavior changes.
  **Contracts:** PRJ-002, AUTH-008/009/017, PUB-003/004, artifact list/search.
  **Dependencies:** T01/T02/T05. **Cost:** existing stores; indexes/storage counted.

## Agent workflows, operation and review experience

### T15 Bound MCP results and qualify the existing transport

- **Progress, September 24:** `artifact_capabilities` now reports the detected
  MCP protocol era and wire revision. `artifact_get` accepts an optional
  `projection` argument: `"full"` returns the complete manifest and `"compact"`
  omits `manifest.entries` while keeping `digest`, `entryPath`, `routingMode`,
  and `entryCount`. `artifact_create_upload` accepts an optional
  `idempotencyKey`, replays the same upload plan with `resumed: true` before
  commit, returns the committed publication after commit, and reports
  `IDEMPOTENCY_CONFLICT` when the key is reused with a different manifest.
  `artifact_version_list` now accepts optional `cursor`/`limit` and returns a
  `nextCursor`; omitting both arguments still returns the full list. The page is
  built at the tool layer over the service's full ordered result; a future
  store-level bounded query should replace the in-memory sort/slice. New
  conformance IDs MCP-021, MCP-022, MCP-023, and MCP-024 are behavior-verified
  locally in `project/spec/conformance.yml`. Remaining open: server/catalog
  construction measurement, the live supported-client matrix (L gate), and
  Cloudflare Worker surface qualification.
- **Do:** add compatible compact artifact projections and paged manifest/history
  reads; complete manifests must remain explicitly available. Expose T05 recovery
  through the same services with bounded structured errors. Record SDK and wire
  revision for primary and legacy clients. Measure server/catalog construction
  before optimizing it; never cache a principal-bound server globally. Request
  progress must not imply commit success or create persistent session state.
- **Done when:** large results are bounded without silent truncation, auth matches
  HTTP/browser, conflicts retain expected-version semantics, and current clients
  complete the real workflow. **Gates:** V/H/E/X/P; L client matrix.
  **Contracts:** MCP-001–009/015/020, PUB-013/014; new pagination/recovery IDs.
  **Dependencies:** T01/T05. **Cost:** existing server and client entitlements.

### T16 Qualify identity lifecycle and verify entitlements

- **Setup progress, September 23:** the WorkOS client and API key are stored
  outside the repository, and the configured AuthKit issuer's discovery document
  was checked for authorization-code flow, refresh tokens and S256 PKCE. The
  current environment reports no configured SSO/OIDC connection, and MCP/Audit
  plan entitlements have not been inventoried separately from demo/staging
  behavior. Hosted-provider lifecycle qualification therefore remains open.
- **Do:** qualify WorkOS and configured OIDC discovery, exact-resource audience,
  PKCE/registration, key rotation, refresh, provider revocation, logout and
  cross-replica deactivation. Record actual production MCP/Audit entitlements
  separately from staging and vendor demo compatibility. Preserve app membership,
  last-admin protection, verified-domain rules and the 30-second cache ceiling.
  Retain app-owned audit history. SCIM/SSO/hosted audit retention are not assumed free.
- **Done when:** the named-client/deployment matrix identifies pass, fail and
  untested states with exact versions; no provider role/organization bypasses
  installation policy. Webhook provisioning, if selected later, requires signed
  events, dedup/order/reconciliation and its own acceptance IDs. **Gates:** V/B/E,
  `pnpm test:oidc`, L. **Contracts:** AUTH-001/008/017/019–029,
  MCP-010–013/017–019, GATE-005. **Dependencies:** T07; T24 for policy expansion.
  **Cost:** existing/free account scope only; paid enterprise features deferred.

### T17 Complete live bridge qualification without changing citizenship

- **Structural progress, September 24:** the host-agnostic citizenship cases
  that were previously unproven without live hosts now have structural tests
  driving the packaged bridge core against a real Artifact Server with a
  scripted host surface. Lost acknowledgement and duplicate lease delivery are
  covered in `tests/conformance/dsp-006-claim-lease.test.ts`: a bundle the host
  accepted whose `delivered` report is lost on the network is requeued at lease
  expiry, redelivered identically, and settles `delivered` — never `failed` —
  with the duplicate admission tolerated. The Pi adapter gained loop-level
  coverage (`tests/client/pi-bridge-core.test.ts`): a compaction hold that
  releases delivery only after `session_compact`, and a synchronous host throw
  that ends the claim loop dormant without reporting `delivered` or `failed`
  and without throwing into the host. omp gained the same refusal case, and
  OpenCode now exercises a compaction hold that starts while a delivery is
  pending (`tests/client/opencode-bridge.test.ts`); claude-channel gained a
  missing-configuration case over real stdio (no registration, no push, and an
  honest dormant tool error). All four adapter READMEs now label each behavior
  structural versus live. Backoff/jitter stays covered once for every host by
  `tests/conformance/dsp-012-bridge-fail-open.test.ts`; claude-channel's
  compaction hold is recorded as not applicable (no signal crosses the stdio
  boundary) and its asynchronous notification refusal as not structurally
  separable in that harness, rather than tested with a fake. Remaining open:
  live-host proof of these five behaviors, and the live client matrix.
- **Host progress, September 24:** Pi 0.84.4, OpenCode 1.18.32, omp 18.2.11 and
  Claude Code 2.1.281 each have an opt-in live suite that drives the real host
  against a real Artifact Server with a scripted offline model. Pi passed 3/3
  ([pi-live.json](./project/evidence/pi-live.json)). omp passed 3/3 — round
  trip, FIFO drain, and session rebind against omp 18.2.11
  ([omp-live.json](./project/evidence/omp-live.json), `pnpm test:omp-live`).
  OpenCode passed 3/3 — round trip, FIFO drain, and fail-open against an
  unreachable origin against OpenCode 1.18.32
  ([opencode-live.json](./project/evidence/opencode-live.json),
  `pnpm test:opencode-live`). Claude Code passed its bounded round trip
  (`CLAUDE-LIVE 1`: the channel registers the session, the dispatch is
  `delivered`, the model closes the thread through `artifact_comments`, and
  the dispatch reads `addressed`) against Claude Code 2.1.281 with no metered
  provider usage
  ([claude-live.json](./project/evidence/claude-live.json),
  `pnpm test:claude-live`). Remaining unproven against live hosts: compaction
  holds, host refusal, lost acknowledgement, duplicate lease delivery and the
  1–30-second jitter cap stay structural coverage, labeled as such in each
  adapter README.
- **Do:** reconcile version-specific Pi/OpenCode staging evidence with READMEs;
  qualify omp and remaining Claude Channels/host cases. Cover compaction holds,
  session deletion, host refusal, missing API/configuration, lost acknowledgement,
  duplicate lease delivery and the 1–30-second jitter cap. Async refusal fails
  work; invalidated handles stop the loop. Do not turn them into blind retries or
  suppress uncertain delivery through unproved deduplication.
- **Done when:** real host acceptance and fail-open native behavior are observed,
  with one notice/dormancy where required; structural test coverage is labeled
  separately. Wake hints may later reduce DB reads but retain bounded polling.
  **Gates:** V and L, including `pnpm test:pi-live` where applicable.
  **Contracts:** DSP-005/006/011–013, BRP-001/002.
  **Dependencies:** host availability; T22 only for optional wake transport.
  **Cost:** existing hosts; no new paid broker.

### T18 Profile runtime ownership, archives and Git growth

- **Do:** probe SQL cancellation and span continuity across the separate
  ManagedRuntime/Promise boundary. Measure full-memory Git clones at bounded
  history sizes and streaming ZIP CRC work separately from publish/read. Record
  RSS, heap, external/array buffers, CPU and event-loop time. Only then consolidate
  runtime ownership, use existing native primitives/worker threads, or choose a
  bounded Git workspace strategy.
- **Done when:** interrupted requests release resources, telemetry has the intended
  parent trace, shutdown closes pools once, and selected changes show measurable
  benefit without new durability/cancellation failures. **Gates:** V/H/E/X/P,
  archive and Git common suites. **Contracts:** ARC-001/002, OPS-009/010,
  CMT-021, GIT-002/003/004. **Dependencies:** T01; T03 before changing mirror execution.
  **Cost:** local profiling; native-helper decision remains T26.
- **Progress, September 22:** the four probes are now either measured or
  documented. A new bounded harness `pnpm perf:git-history-clone-memory`
  (`project/performance/run-git-history-clone-memory.ts`) drives one complete
  `commitGitHistoryVersion` clone/commit/push against a disposable local Git
  smart-HTTP remote seeded with N commits and samples peak `process.memoryUsage()`;
  peak heap used grew ~40 MiB (0 commits) to ~54 MiB (200 commits) and array
  buffers ~5 to ~20 MiB — roughly linear, tens of KB per tiny one-file commit,
  confirming the FINDINGS risk that the mirror clones accumulated history in
  memory (evidence `project/evidence/git-history-clone-memory.json`). SQL
  cancellation and span continuity are documented gaps, not regressions: a client
  disconnect does not interrupt the application effect (SQLite is synchronous
  main-thread; Postgres runs on a separate `ManagedRuntime` not tied to the
  request fiber), and Postgres spans are not parented to the request span with no
  inbound `traceparent` extraction. The ZIP archive is already streamed, bounded,
  and cancel-safe with incremental CRC (stored compression, byte-at-a-time CRC
  noted as a future slice-by-4/8 optimization). Full write-up in
  `project/performance/FINDINGS.md`. Remaining: no probe yet proves pool-close-once
  at shutdown or span linkage, and no archive CRC-throughput probe.

### T19 Improve design navigation and exact-file annotation

- **Do:** preserve observed `_ds_manifest.json`/`.dc.html` compatibility and source
  bytes. Add selected-preview history/fragments, return navigation, focus/keyboard
  handling, template metadata/fallbacks and an outer-app exact-file annotation
  handoff. Keep one live preview and no annotation bridge in Interactive mode.
  Use supplied thumbnails first; any optional client-generated bytes must be
  persisted across retries with renderer/viewport/source provenance. Add a catalog
  format version only with compatibility fixtures and new-publication semantics.
- **Done when:** real sanitized flat/nested exports, short/tall viewports,
  missing dependencies, hostile paths/metadata, browser back/forward and three
  engines retain exact identity. Saved versions are never regenerated. Moving
  multi-artifact views stay clearly moving; frozen collections require T24 policy.
  **Gates:** V/B/H if preview routes change. **Contracts:** DSN-001,
  CMT-001/002/014/016–018/022, PRJ-002; new navigation/derived-asset IDs as needed.
  **Dependencies:** T07; safe defaults need no new provider. **Cost:** local fixtures.

### T20 Improve infrastructure previews and secret-safe evidence

- **Account setup, September 23:** bounded AWS S3 and GCS object-storage
  qualifications are available, but neither account has the broader deployment
  permissions, state backend, secrets provider and deploy-time inputs required
  by the full Pulumi stacks. `pnpm test:aws-pulumi` and
  `pnpm test:gcp-pulumi` remain intentionally unrun against these accounts.
- **Do:** add scoped Pulumi previews on relevant changes with sanitized resource
  diffs, exact provider/runtime versions and reliable failure artifact retention.
  Reuse existing disposable Postgres/MinIO fixtures. Evaluate ESC only if its
  bounded free allowance removes actual secret duplication. Automation API stays
  in external operator/test tooling; existing projects/state remain inspectable.
- **Done when:** untrusted changes cannot obtain apply credentials, previews do
  not leak secrets, partial fixture cleanup is recoverable, and no product command
  secretly proxies infrastructure lifecycle. **Gates:** V, AWS/GCP resource tests,
  scoped read-only preview qualification. **Contracts:** DEP-003/008/009/012/016/021.
  **Dependencies:** account/runner/state entitlement check. **Cost:** OSS/DIY or
  current Free allowance; AWS/GCP resources and CI minutes are separate costs.

### T21 Qualify cache, compression, range and archive policy

- **Do:** retain private no-store/public revalidation and authorization before
  every body/304 decision. Test visibility/current-pointer change, historical
  requests, logout/lease expiry, service-worker scope, conditional/range requests,
  encoded validators and cancellation. Optimize public hashed application assets
  only where routing cannot bypass protected/content-host policy. Profile archive
  repeats before materializing derived ZIPs; multi-range is deferred absent a
  real client need. Previously received bytes cannot be remotely recalled.
- **Done when:** no blind CDN hit serves formerly public/private content; ranges,
  compression and archives preserve exact logical bytes and auth. Any new cache
  class has an explicit policy before headers change. **Gates:** V/H/B/O/E/X/P
  as affected, L for edge behavior. **Contracts:** AUTH-004/007/014–016,
  CNT-003–008, CMT-018/021/022. **Dependencies:** T01/T07, T24 for expanded policy.
  **Cost:** existing proxy/edge allowance; no blanket immutable public caching.
- **Progress, September 22:** six conformance/browser test files now claim the
  previously-unclaimed cache/range/archive IDs. `cnt-003-origin-isolation` proves
  the app and content origins use different registrable domains with host-only
  cookies and that a same-domain external-storage configuration is rejected;
  `cnt-004-version-origin` proves two versions get distinct immutable origins
  that each serve their exact bytes and cannot read one another;
  `cnt-008-content-fixture-matrix` proves the full header/conditional/HEAD/range
  matrix plus 405-on-unsupported-methods, 416-on-malformed-ranges, and
  octet-stream+attachment for misleading and unknown files; `auth-007` proves
  public-to-private denial, the "cannot be recalled" warning, and stale-ETag
  revalidation rejection; `auth-016` proves private no-store vs public
  revalidation vs immutable app assets and no private bytes for an unauthenticated
  viewer; and a Chromium `cnt-006-service-worker` spec proves a service worker's
  scope is bounded to its version origin. Ledger result: CNT-008 promoted to
  `behavior_verified`; CNT-003/004/006 and AUTH-007/016 moved from `specified`
  to `implementing` with F-only recorded evidence where `local` is an applicable
  deployment and honest proof_gaps naming the remaining gaps (deployment
  qualification for CNT-003/004/006, no CDN purge API for AUTH-007, external-
  storage recorded evidence for CNT-003/AUTH-016). Full gate
  `BROWSER_CRITICAL_ENGINES=all pnpm verify:iteration` exit 0;
  `pnpm conformance:validate` and `pnpm conformance:tests` clean.

### T27 Close linked-file capture and local-boundary proof gaps

- **Current:** [local source engine](./src/local/linked-source-engine.ts) observes
  descriptor fingerprints and spools verified capture bytes; [linked policy](./src/application/linked-artifacts.ts)
  supports unchanged-source replay and comment-time implicit capture. The ledger
  still names missing genuine mid-read drift and deployment-absence evidence.
- **Do:** use the existing observation hooks and real HTTP/MCP boundaries to
  force source replacement/modification during capture. Exercise concurrent
  capture/comment requests, missing/restored sources, root and symlink escapes,
  stale-current publication, relink hash checks and live-to-captured fallback.
  Verify source paths never leak in refusal bodies and external-storage/Worker
  deployments expose no enabled linked-file capability.
- **Done when:** drift aborts without a partial visible version/thread, successful
  comment anchors name the captured bytes, in-sync behavior is preserved, and
  every applicable local/remote boundary has normal and hostile evidence. This
  work does not add remote filesystem access or cross-device synchronization.
  **Gates:** V/H/B/E and Cloudflare runtime tests as applicable.
  **Contracts:** LNK-001–008, CMT-001/002, PUB-006/008.
  **Dependencies:** T07 for browser evidence. **Effort/cost:** 2–4 days on local
  disposable files and existing providers; no external service.
- **Progress, September 22:** the named proof gaps are closed for the local
  boundary. A test-only observation seam (`linkedCaptureHooks` on the local
  runtime config, never parsed from the environment) now drives a genuine
  mid-read drift through the real HTTP and comment boundaries: LNK-004-F and
  LNK-008-F rewrite the source in place after the engine's first read and prove
  the retryable `SOURCE_DRIFTED` abort leaves no version, no thread, no capture
  action, and an empty capture spool, and that a clean retry then succeeds.
  LNK-002-B now links over MCP (`artifact_link`, stable derived idempotency
  replay) and the CLI (`artifactserver link --server --token-file`); LNK-003-B
  reads freshness through MCP `artifact_get`, which now mirrors the HTTP read by
  decorating linked artifacts with `sourceBinding`. The compact-compose and Helm
  suites and the AWS/GCP Pulumi tests assert the capability-absence shape
  (no advertised capability, 501 `CAPABILITY_UNAVAILABLE` on every linked route,
  no `ARTIFACT_SERVER_LINKED_FILES` in the stack), joining the existing
  Cloudflare worker runtime test. LNK-002/003/004/006/008 are promoted to
  `behavior_verified` with recorded local evidence; LNK-005 stays `implementing`
  because its attachment clause depends on the undecided GATE-014 feature, and
  LNK-001/007 stay `implementing` pending route-level live absence on deployed
  AWS/GCP instances. Full gate `BROWSER_CRITICAL_ENGINES=all pnpm verify:iteration`
  exit 0, `pnpm conformance:validate` clean (behavior_verified 142→147),
  `pnpm conformance:tests` clean (266 IDs, one claim each).

## Conditional work and policy decisions

### T22 Add a durable feed or SSE only if revision/refetch is insufficient

Measure T06 request/latency/lock costs first. A future feed needs transactional
events, defined commit ordering, removals, snapshot boundary, retention, restore
epoch, cursor expiry/reset, duplicate tolerance, bounded consumers and ongoing
authorization. SQLite/Postgres/D1 implement one product port; notifications are
lossy hints. SSE/MCP subscriptions follow shared durable state. WebSockets need
a separate bidirectional use case. **Done when:** dropped hints, cross-replica
reconnect, old epochs, slow clients and revocation converge or explicitly resnapshot.
**Gates:** V/B/E/X/P/L; new feed/transport IDs and MCP-004 treatment. **Effort/cost:**
6–12 days after T06, existing DB first; no automatic paid event service.

### T23 Consider richer Git handoff after repair and history profiling

Rank explicit review-to-PR/commit association first, then a qualified push-only
private-remote adapter, then explicit selected-commit import through publication.
Keep provenance and authorization; preview coordinates are not source diff lines.
No public-link Git authority, arbitrary remote fetch, destructive mirror default,
or silent merge. Continuous bidirectional sync and Git-primary storage remain
outside this plan's baseline. **Done when:** T03/T18 pass and a concrete user need
has new Git/CMT/import contracts and common-provider qualification. **Gates:**
V/E/L and publication gates for import. **Effort/cost:** 3–10 days per bounded
association/adapter feature, existing private remote; no mandatory paid service.

### T24 Resolve product choices without blocking safe repairs

Record a decision when a task needs any of these; until then retain the existing
behavior:

| Choice | Safe current/default direction | Unlocks |
| --- | --- | --- |
| Retry/idempotency lifetime and failed-operation semantics | Preserve successful replay; no successful-staging reclamation or perpetual negative-result promise yet. | T05/T10 |
| Permanent Git predecessor failure and visible status | Stop that artifact's later copies, preserve primary availability; specify any new status before use. | T03 |
| Browser support window | Chromium remains current default; record exact builds for the proposed critical three-engine matrix. | T07 |
| Private/offline and permanently-public access | Keep no-store/private and current-only public authorization. No new permanently-public class. | T21/T22 |
| WorkOS roles, SCIM and audit retention | App membership/audit remain authority; no project ACL or new paid dependency. | T16 |
| Cross-device drafts | Keep device-local scoped drafts. | Possible later draft feature |
| Moving project view versus frozen collection | Moving view may compose existing authorized records; frozen shares need their own versioned manifest/lifecycle. | T19 |
| Workload, retention, provider account and recovery objectives | Use synthetic/local fixtures and disclose unknown production capacity/cost. | T01/T08/T25 |

**Done when:** each selected change has an explicit decision, acceptance criteria,
affected existing IDs and newly allocated IDs where needed. Unselected choices
remain deferred, not silently implemented. Documentation-only decisions use V;
implementation inherits the dependent task's gates.

### T25 Design committed-blob GC only after recovery prerequisites exist

Keep automatic committed/race-left blob GC disabled. A later proposal must account
for all manifests, active preparations/leases, backups/restore points, lag,
tombstones, multipart sessions, grace periods and repeated mark epochs. A source
suggestion of two-pass mark/sweep is not sufficient proof. **Done when:** explicit
scope/retention policy plus replica, crash, restore and active-prepare races prove
no referenced/restorable bytes can be deleted; only then allocate and implement
GC contracts. **Dependencies:** T05/T10/T24. **Gates:** V/H/O/E/X and restore suites.
**Contracts:** OPS-003/006/007, PUB-009. **Effort/cost:** design first; implementation
estimate follows evidence, no bucket age-deletion shortcut.

### T26 Reconsider a native helper only after measured end-to-end benefit

Keep TypeScript/Effect. First remove repeated I/O/SQL and evaluate supported native
Node primitives or bounded worker threads. A helper needs a real workload profile,
≥10% repeatable end-to-end opportunity including IPC/startup/copies, better resource
or failure behavior, amd64/arm64/offline packaging, and a conforming Workers path
or explicit capability absence. CPU fraction bounds possible gain; microbenchmarks
and language rankings do not decide this. **Dependencies:** T01/T18.
**Done when:** a bounded prototype passes correctness/recovery and paired
performance acceptance, or the option is explicitly rejected. **Gates:** V/P/H,
provider/runtime/package gates as affected. **Contracts:** ARC-001/002, DEP-015/019,
OPS-010. **Cost:** free tooling does not eliminate maintenance/packaging cost.

## Closing work

For each completed task, record the change, exact commit and environment, executed
normal/hostile tests, measured result, preserved invariants, and remaining provider
or host gaps. Link the evidence from the task and applicable ledger entries.
Keep vendor prices/limits dated and linked to primary sources. Do not edit the
preserved dossier to hide errors; append corrections to the reconciliation.

The research's 33 uncertainty IDs all map to tasks in the
[reconciliation register](./project/research/immutable-artifact-engineering-2026-09-17/RECONCILIATION.md#all-research-uncertainties-mapped-to-work).
No implementation task is closed by this documentation import.
