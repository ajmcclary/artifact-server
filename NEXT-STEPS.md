# Next steps

Updated September 18, 2026. This is the implementation backlog resulting from
the [engineering dossier intake](./project/research/immutable-artifact-engineering-2026-09-17/README.md)
and [repository reconciliation](./project/research/immutable-artifact-engineering-2026-09-17/RECONCILIATION.md).
The code inspected was `572e28f4beef971b94c9864408f5c067ad499ba1`.

The research and this plan do not mean the features below are implemented.
All T01–T27 tasks are open. Task IDs are planning identifiers, not new
conformance IDs. The [ledger](./project/spec/conformance.yml) remains the index
of product promises and proof; [AGENTS.md](./AGENTS.md) remains binding.

Keep TypeScript/Effect, narrow provider ports, immutable versions, explicit
publish conflicts, application-owned authorization, local-only linked files,
and follow-up-only bridges. Preserve existing binary publication, ranges,
compression, MCP HTTP, R2, assets, and Cron rather than implementing them again.
Use existing infrastructure or verified ongoing free allowances; no paid
subscription, live deployment, or destructive cleanup is authorized by this plan.

## Work order

| Rank | Task | Expected result | Dependencies | Effort |
| --- | --- | --- | --- | --- |
| 1 | T03 Git order and bounded reconciliation | Correct an observed GIT-008 failure without affecting primary publication. | Existing probe; add focused regression first. | 5–8 days |
| 2 | T02 Create-only immutable writes | Close S3/GCS provider parity gap and prove concurrent reuse. | T01 for performance claims, not for correctness work. | 3–5 days |
| 3 | T01 Measurement and evidence baseline | Attribute transfer, SQL, CPU and memory before choosing optimizations. | None. | 2–4 days |
| 4 | T04 Batch final Postgres manifest insertion | Remove sequential per-file SQL while preserving one atomic commit. | T01. | 2–4 days |
| 5 | T05 Publication reconciliation and file resume | Recover lost responses and interrupted transfers without duplicate versions. | Retention semantics in T24; T02. | 4–7 days |
| 6 | T06 Review revision and authoritative refetch | Remove deleted/dispatched records on other clients reliably. | T01; snapshot contract. | 3–6 days |
| 7 | T07 Browser evidence and critical engine matrix | Produce fresh failure evidence and durable isolation/convergence proof. | None for finalization; T06 for convergence cases. | 3–6 days |
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

## Correctness and measurement

### T01 Establish attributable and comparable measurements

- **Current:** [performance harnesses](./project/performance/README.md) measure
  bounded local and two-process workloads. Prior Node 26.5 observations include
  204 ms max event-loop delay and about 708 MiB peak capacity RSS; these do not
  establish a leak or regression against Node 24.15. Historical numbers belong
  to different runs and machines.
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
  provider concurrency proof, real process crash timing, and controlled
  large-backlog measurements.
- **Backlog progress, September 18:** a dedicated opt-in 3,301-version SQLite
  diagnostic found 3,062 ms median idle claims with a deep history and 107 ms
  with many one-version artifacts. Bounded reconciliation now selects one
  earliest unmapped version per artifact without repeating the predecessor
  scan; an installation/version job index supports that lookup across SQLite,
  Postgres and D1. The same 30-pass local fixture measured 2.60 ms and 7.31 ms
  medians. A D1 binding regression and local HTTP test preserve cross-artifact
  fairness and per-artifact order. These are single paired local observations;
  provider-specific large-backlog and controlled repeated baselines remain open.
- **Backlog iteration checks:** `pnpm verify:iteration`, `pnpm smoke`, and
  `pnpm verify:external-storage-performance` passed on Node 24.15.0. The
  external-storage baseline reported no investigation warnings. The opt-in
  Git fixture is separate from the canonical timing gates.
- **September 18 checks:** `pnpm verify:iteration`, `pnpm smoke`, and
  `pnpm verify:external-storage-performance` passed on Node 24.15.0. The
  external-storage baseline reported no investigation warnings. No controlled
  before/after Git history workload was run, so no speed claim is made.
- **September 17 checks:** Following the ownership changes,
  `pnpm verify:iteration`, `pnpm smoke`, and
  `pnpm verify:external-storage-performance` passed on Node 24.15.0. The
  external-storage baseline reported no investigation warnings. There is no
  same-environment pre-change measurement, so this change makes no speed claim.
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

## Storage, platform and transport experiments

### T08 Establish actual Cloudflare and provider cost envelopes

- **Do:** inventory the selected account plan and actual publication sizes/counts,
  retained bytes, backups, visible review hours, mutation rates and client usage.
  Measure Worker CPU/subrequests/body limits, D1 query/row/index/storage costs,
  R2 operation classes and staging/multipart growth. Separate Workers+D1+R2 from
  Node+Postgres+R2. Record hard failures versus overage behavior and capability
  reporting. Use current official pricing, not a free-trial assumption.
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
