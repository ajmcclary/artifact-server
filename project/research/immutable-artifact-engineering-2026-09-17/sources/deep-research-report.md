# Engineering Decision Dossier for Immutable Web-Artifact Publishing, Review, and Sharing

## Decisions and evidence boundary

**Research date:** September 17, 2026, America/New_York.

This dossier treats the architecture, measurements, and observations in the prompt as **supplied evidence**, not as independently reproduced facts. No repository, production system, unpublished benchmark data, cloud account, or earlier conversation was available. I did not execute provider load tests or local application benchmarks. Public claims below are grounded primarily in normative specifications and current provider/runtime documentation; recommendations derived from the supplied observations are labeled as engineering inferences or hypotheses.

The most important current-version anchors are: MCP specification **2026-07-28**; Node.js **26.9.0 current** and **24.21.0 LTS** on the Node site at research time; PostgreSQL **18.6** as the current PostgreSQL 18 maintenance release; SQLite **3.53.4**; Cloudflare documentation updated through August 2026; and Effect **4.0 still a release candidate**, meaning an existing Effect 3 application should not migrate merely in pursuit of speculative performance. citeturn14search8turn25search3turn4search0turn4search1turn27view2

**Evidence labels used below**

| Label | Meaning |
|---|---|
| **Normative** | Protocol/RFC requirement. |
| **Provider-documented** | Current official provider behavior or limit. |
| **Maintainer-documented** | Runtime/SDK/project documentation. |
| **Supplied** | Observation or measurement from the prompt; not independently reproduced. |
| **Inference** | Engineering conclusion derived from the preceding evidence. |
| **Experiment required** | Public documentation cannot settle the local question. |
| **Owner decision required** | Correct answer depends on product semantics rather than engineering evidence alone. |

### Decision summary

The architecture does **not** need a new storage model, transport protocol, Git-first redesign, distributed filesystem synchronizer, or native-language rewrite. The largest near-term gains come from removing repeated work and serial round trips while tightening storage preconditions and retry semantics.

| Area | Decision now | Why |
|---|---|---|
| Publication database path | **Batch final Postgres manifest insertion first.** | The supplied 3,301-file run spent 201.571 s of 523.94 s in commit. That is about **38.5% of total wall time**, so commit-stage improvements have enough Amdahl headroom to matter. Saving roughly 52.4 s—about **26% of that commit stage**—would produce a 10% whole-run improvement. This is a hypothesis until controlled measurement. |
| Retry behavior | **Add operation reconciliation and file-level resume before adding a new upload protocol.** | The operation is already idempotent, but supplied evidence says retry creates a new plan and retransfers completed bytes. The smallest improvement is to make the existing operation discover committed/completed file state. |
| Small WAN files | **Prototype bounded binary batching, but only as a transfer representation.** | Thousands of small requests amplify RTT, provider operations, and per-request overhead. The authoritative representation must remain individual manifest entries and content-addressed blobs. |
| Large WAN files | **Add provider-native signed/resumable staging selectively.** | R2 supports reusable expiring presigned S3 URLs; GCS offers resumable sessions; S3 multipart is independently resumable. These avoid proxying large bytes through the app, but have materially different checksum and precondition semantics. citeturn26search7turn0search6turn1search5 |
| Immutable installation | **Require destination create-only semantics everywhere.** | AWS S3 supports conditional writes for `PutObject` and multipart completion; GCS supports `ifGenerationMatch=0`; R2 supports conditional `PutObject`. R2's destination-conditional `CopyObject` extension is beta and explicitly not atomic with its source condition, so it should not become a correctness foundation yet. citeturn0search0turn0search4turn2search0turn26search3 |
| Promotion by copy | **Use only where both source identity and destination creation can be proven.** | GCS has the cleanest documented generation-precondition model. AWS CopyObject destination-create-only semantics were not established by the primary material inspected here. R2's extension is beta. |
| CAS reuse | **Permit same-project authorized reuse; conceal cross-project existence.** | Returning “already exists, skip upload” for a globally shared hash creates a content-existence oracle. Physical cross-project deduplication can remain an implementation detail without a client-visible probe. |
| Local promotion | **Prefer portable create-only installation over plain `rename`.** | Plain replacement-style rename does not express the required “create only if absent” contract. A hard link is not safe until all writable handles/paths to the staged inode are closed and eliminated. |
| HTTP delivery | **Keep rangeable artifact bodies uncompressed dynamically.** | Range offsets apply to the selected representation; validators and content codings complicate range reuse. Current separation between compressed control/UI responses and identity-coded rangeable artifact streams is sound. RFC 9110/9111 govern range and validator behavior. citeturn3search0turn3search1 |
| Shared CDN caching | **Do not shared-cache current-only public artifact bodies under the existing authorization contract.** | The bytes are immutable but authorization is not. A cached anonymous response could remain accessible after the version stops being current or visibility is revoked unless every hit re-enters an authorization/currentness check. RFC 9111's `private` directive prohibits shared-cache storage. citeturn3search1turn3search4 |
| Review consistency | **Add a transactional project revision plus authoritative refetch before adding SSE/WebSockets.** | This immediately fixes deletion/dispatch convergence without a durable event platform. SSE is only a transport; it does not solve commit ordering, replay, or lost wakeups. |
| Durable feed | **Defer until revision/refetch proves insufficient.** | Then introduce transactional outbox/cursor semantics, with notification/SSE only as wake mechanisms. |
| Git | **Repair the push-only derived mirror rather than expand it.** | Add per-artifact serialization, deterministic predecessor checking, fencing, bounded reconciliation, and remote-state reconciliation. Continuous bidirectional sync and Git-as-primary-storage conflict with the non-authoritative Git constraint. |
| MCP | **Adopt/qualify the 2026-07-28 stateless core; keep durable subscriptions disabled until shared event state exists.** | The July 2026 MCP release makes statelessness a core design direction. The official TypeScript v2 SDK implements the new generation but may require explicit version negotiation in compatibility scenarios. citeturn14search8turn14search7turn14search9 |
| WorkOS | **Keep authorization application-owned. Use WorkOS for identity/provisioning, not as the project ACL model.** | AuthKit's first 1M monthly active users are currently free; Enterprise SSO and Directory Sync are $125/connection/month at the first tier; custom domain is $99/month. RBAC is listed among included AuthKit capabilities, but mirroring WorkOS roles into product authorization would change the current authorization model. citeturn17view0 |
| Cloudflare | **Cloudflare Free is useful for light installations but is not “free unlimited hosting.”** | Workers Free is constrained by request/CPU/subrequest limits; D1 Free has 5M rows read/day, 100k rows written/day and 50 D1 queries per Worker invocation; R2 provides 10 GB-month, 1M Class A and 10M Class B operations per month. citeturn9view0turn9view1turn10view7 |
| Cloudflare many-file commit | **Move expensive verification/promotion before the final small metadata transaction and make preparation chunk-resumable.** | A 3,301-object operation cannot fit a single invocation if every object requires a service operation under Cloudflare's per-invocation limits; visibility can still remain atomic because preparatory blobs are non-visible until final metadata commit. citeturn10view0turn10view1 |
| Cloudflare Artifacts | **Do not adopt as a production dependency.** | Cloudflare Artifacts is a distinct Git-speaking product, in **closed beta**, unavailable on Workers Free, with its own operation/storage pricing. It is unrelated to the browser-artifact concept in this system. citeturn12search26turn13view0turn13view1 |
| Pulumi | **Keep Pulumi as operator tooling. OSS CLI/Automation API are enough for CI previews and ephemeral test orchestration.** | Pulumi's CLI/engine/Automation API are open source; hosted drift detection, TTL stacks, advanced governance, etc. have separate plan boundaries. citeturn21search1turn21search2turn23view0 |
| Native helper | **Do not add one yet.** | Existing evidence cannot distinguish hashing, CRC/archive JS, Git pack behavior, DB boundaries, allocator RSS, or repeated I/O as the dominant CPU/memory cost. |
| Browser qualification | **Make a small Chromium/Firefox/WebKit critical-path matrix persistent and make evidence generation failure-safe.** | Playwright directly supports all three engines, auto-waiting, traces, network/console evidence and isolated contexts. citeturn27view0 |
| Claude Design exports | **Treat public Claude Design capability as real but export-directory conventions as non-contractual unless documented.** | Anthropic documents Claude Design as a product launched in April 2026 and exposes Design/Design System help material; no stable public export schema was established by the evidence inspected. citeturn25search4turn27view1 |

The biggest corrections to assumptions are therefore:

1. **“Content immutable” does not mean “authorization cacheable forever.”** Under the stated current-only anonymous-access contract, a normal shared CDN cache cannot safely serve protected bytes after the governing authorization state changes. citeturn3search1turn3search4
2. **Multipart/provider checksums are not interchangeable with the application's full-file SHA-256.** AWS distinguishes full-object and composite checksums, and multipart SHA-256 is composite rather than a direct full-object SHA-256; R2's S3 compatibility table likewise reports SHA-256 composite but not full-object. citeturn1search1turn26search4
3. **“S3 compatible” is not a correctness contract.** R2 adds its own beta conditional-copy destination headers, explicitly with non-atomic source/destination condition timing, illustrating why each adapter requires capability qualification. citeturn26search3turn26search4
4. **SSE is not the consistency fix.** A revision/refetch or durable log is the consistency primitive; SSE/WebSockets merely change wakeup/transport behavior.
5. **Cloudflare's free quotas directly shape architecture.** Seven-second polling alone can consume almost an entire Workers Free daily request budget with a small number of continually visible tabs.
6. **The latest MCP baseline has moved.** The 2026-07-28 release is explicitly stateless at its core; existing support should be qualified against that revision rather than treated only as a legacy Streamable HTTP implementation. citeturn14search8turn24search3
7. **Cloudflare Artifacts is neither R2 nor this product's “artifacts.”** It is a separate, closed-beta Git-oriented service with paid-plan boundaries. citeturn12search26turn13view0

## Publication, storage, delivery, and cost decisions

**Decision record: publication pipeline**

The baseline is fundamentally sound: client-side walk/hash → upload plan → binary staging → size/SHA-256 verification → immutable blob installation → one atomic metadata transaction. The right optimization target is therefore **work around that invariant**, not weakening it.

A publication should conceptually become:

`prepare operation → discover reusable authorized files → transfer missing bytes → verify/seal each staging object → install immutable blobs in resumable chunks → final small DB transaction → replay result forever by idempotency key`

The preparatory stages may create race-left immutable blobs. That is acceptable because blobs have no user-visible meaning until referenced by an atomically committed manifest. The final transaction must still create the version/manifest, durable idempotency result and action record and perform the expected-current conditional pointer update together.

### Publication decision records

| Decision | Baseline / alternatives | Recommended choice | Benefit hypothesis and evidence | Complexity / reversal condition |
|---|---|---|---|---|
| **PUB-DB — manifest SQL** | Per-file inserts in final Postgres transaction; batch insert; bulk-copy mechanism | **Batch manifest rows**, sized conservatively by parameter limits; keep one transaction. | On the supplied 3,301-file run, commit is ~38.5% of total. To improve whole-run time by 10%, this change or changes within the same stage must save ~52.4 s, ~26% of supplied commit time. Plausible, not proven. | Low. Reverse only if instrumented SQL time is insignificant or batching increases lock/serialization cost. |
| **PUB-RETRY — recovery** | New plan/retransfer; plan reuse; operation reconciliation | **Lookup by operation/idempotency key first; return committed result immediately; otherwise resume verified files.** | Near-zero-byte retry after lost response is achievable if commit already happened; partially completed transfer saves roughly the fraction of already verified bytes and requests. | Low–medium. Must preserve the original result and stale-current outcome. |
| **PUB-SMALL — small files** | One PUT/file; bounded binary batch; archive upload | **Experiment with bounded binary batches only for staging transport.** | Most relevant to 1k/3,301-file WAN workloads. It reduces HTTP/TLS/request overhead, but not client hashing or final manifest cardinality. | Medium. Reject if parsing/debatching CPU or failure granularity erases ≥10% gain. |
| **PUB-LARGE — large files** | App-origin upload; presigned PUT; multipart/resumable; tus | **Provider-native signed/resumable upload above a measured threshold.** | R2 presigned URLs can grant scoped PUT without handing out credentials; S3 multipart and GCS resumable sessions allow interrupted large uploads to continue. citeturn26search7turn1search5turn0search6 | Medium–high across providers. Defer tus unless a measured cross-provider requirement remains after native resumability. |
| **PUB-PROMOTE — staging→CAS** | GET/re-hash/PUT; provider copy; local copy/link/rename | **Use copy only with proven source sealing + destination create-only. Keep stream verification as portable fallback.** | Saves a network read/write leg and possibly a hashing pass. GCS has generation preconditions suited to this. R2 conditional-copy destination extension remains beta. citeturn0search4turn0search2turn26search3 | Medium. Reverse per adapter if qualification cannot prove both sides of the race. |
| **PUB-DEDUP — existing CAS** | Always upload; global “exists” response; scoped reuse | **Skip upload only for blobs already referenced by a project/installation scope the caller may inspect.** | Repeat-version workloads could approach transfer savings proportional to reused bytes. Avoids global hash-existence oracle. | Medium metadata index. Global reuse may still happen internally after upload. |
| **PUB-COMP — transfer compression** | Identity transfer; gzip/Brotli source; precompressed batch | **Do not make compression a baseline upload feature. Measure text-heavy WAN fixtures first.** | Compression helps only when bandwidth is material and bytes compress well; it adds decompression/hash CPU and complicates provider-native direct upload. | Medium. Adopt only with ≥10% end-to-end benefit in target fixture. |
| **PUB-CONC — concurrency** | Current four; larger/smaller provider/client/DB concurrency | **Make concurrency a benchmark parameter, not a default increase.** | Four may be too low on high-RTT S3 or already too high under Worker/DB constraints. No public documentation can identify the optimum. | Low. Tune independently for client uploads, blob promotion and DB work. |

**Amdahl interpretation of the supplied 3,301-file run.** With 201.571 seconds reported in commit out of 523.94 seconds total, eliminating the entire reported commit stage could improve total elapsed time by at most about **38.5%**. Halving it would improve total time by about **19.2%**. Therefore batched manifest insertion is worth measuring immediately; a change confined to a stage occupying, for example, only 5% of a workload cannot produce a 10% whole-workload improvement even with infinite local speedup. These calculations use supplied timings, not a controlled benchmark.

**Retry reconciliation should precede tus.** Native provider resumability solves interrupted byte transfer; it does not solve “the publication committed but the client lost the response.” The latter is already an application transaction/idempotency concern. The retry entrypoint should therefore query the idempotency record before allocating a fresh upload plan. If the operation committed, it returns the exact original result without requiring staging objects to still exist.

**Successful staging reclamation is safe only after commit replay no longer depends on staging.** Persist the idempotency result and committed version identity separately from staged data; then successful staging may be deleted after a short recovery grace. Unreferenced immutable blobs require a separate GC process.

### Storage-provider compatibility matrix

| Capability | Local filesystem | AWS S3 | Cloudflare R2 | Google Cloud Storage |
|---|---|---|---|---|
| **Create-only immutable destination** | Use an exclusive-create primitive or equivalent no-replace installation; plain replacement-style rename is insufficient. | Conditional writes using `If-None-Match` are documented for `PutObject`; conditional completion is available for multipart. citeturn0search0turn1search5 | Workers `put(..., {onlyIf})` and S3-compatible conditional `PutObject` are documented. citeturn2search0turn26search4 | `ifGenerationMatch=0` means create only when no live object exists. citeturn0search4 |
| **Source sealing** | Close all writable handles; remove writable staging aliases before inode reuse. | Copy-source conditions can bind a copy to source state; exact safe design must be provider-qualified. | S3 CopyObject source conditions supported; R2 object versions are also available through native APIs. citeturn26search3turn2search0 | Source generation preconditions provide explicit immutable generation identity. citeturn0search2turn0search4 |
| **Server-side promotion/copy** | Rename/link/copy primitives, but portability and no-replace semantics differ. | Copy exists, but the inspected material did **not** establish a destination create-only CopyObject contract equivalent to conditional PutObject: **qualification required**. | CopyObject exists. R2-specific destination conditions are **beta** and source/destination checks are documented as non-atomic relative to each other. citeturn26search3 | Rewrite/copy supports source and destination generation conditions. citeturn0search4turn0search9 |
| **Provider checksum that equals app full SHA-256** | App can calculate canonical SHA-256 itself. | Single-part provided SHA-256 can be validated; multipart SHA-256 is composite rather than the application's ordinary whole-object SHA-256. citeturn1search1 | Native binding can verify supplied SHA-256 for put; S3 multipart table lists SHA-256 as composite, not full-object. citeturn2search0turn26search4 | Native integrity mechanisms emphasize CRC32C/MD5; do not substitute them for canonical SHA-256. citeturn0search6 |
| **ETag as full SHA-256** | Not applicable. | **No.** Multipart ETags are not a generic full-object cryptographic hash. citeturn1search1turn1search5 | **No generic guarantee.** R2 checksum modes differ by upload type. citeturn26search4 | Generation is identity, not SHA-256. |
| **Resumable upload** | Application chunk/temp-file scheme if needed; generally unnecessary locally. | Multipart upload with independently uploaded parts; incomplete sessions require abort/lifecycle cleanup. citeturn1search5 | Multipart supported; native documentation states incomplete multipart uploads are eventually aborted automatically. citeturn2search0 | Resumable upload sessions; only a completed object becomes visible and sessions have finite lifetime. citeturn0search6 |
| **Browser direct signed upload** | Not useful. | Presigned S3 upload is the standard adapter path. | S3-compatible presigned PUT supported; URL can be reused until expiration and browser use requires CORS. citeturn26search7turn26search5 | Signed URLs/resumable initiation require a GCS-specific adapter and qualification. |
| **Ranges** | Application controls range reader. | Supported object GET range. | `GetObject` Range supported in S3 API and native R2 reads. citeturn26search4turn2search0 | Supported object reads; retain application HTTP semantics at the gateway. |
| **Cancellation** | Abort read/write and clean temporary path. | Abort request; multipart session persists until explicit abort/lifecycle. citeturn1search5 | Abort request; unfinished multipart lifecycle is provider-managed, but application staging records still need expiration. citeturn2search0 | Stop request; resumable session remains until its provider expiry. citeturn0search6 |
| **Recommended promotion strategy** | Portable create-only install + fsync discipline; hard-link fast path only after strict seal. | Conditional final PUT baseline; copy fast path only after adapter-specific proof. | Native conditional PUT baseline; do **not** make beta conditional CopyObject a required correctness primitive. | Conditional copy/rewrite using source generation + `ifGenerationMatch=0` is the strongest documented candidate. |

A **hard-link optimization must be rejected** whenever any process may still write the staged inode. Creating another pathname does not freeze the inode. A safe implementation must close all writable handles, prevent any subsequent staging mutation and remove mutable aliases before considering link-based installation. Because that proof is subtle and the existing local figures are already sub-second for the 48-file fixture, local hard-link work should rank below WAN/SQL improvements.

**S3-compatible adapters need capability tests, not a boolean `isS3Compatible`.** R2 is a concrete counterexample: it supports much of the S3 object API while adding destination-copy condition headers that AWS does not define in the same form, and that feature is explicitly beta. citeturn26search3turn26search4

### Size and SHA-256 proof

The canonical correctness rule should stay simple:

1. The client declares exact logical size and SHA-256.
2. The server must obtain trustworthy evidence that the staged bytes have exactly those values.
3. An object is not eligible for immutable installation until that evidence is durable and tied to the exact staged generation/version being promoted.
4. Provider-native checksums may eliminate a second server hashing pass **only if** the adapter can prove they are the application's ordinary whole-file SHA-256 for the exact final bytes.
5. ETags are concurrency/object-identity tokens when documented as such; they are **not** a portable content hash.

AWS explicitly distinguishes full-object from composite checksums and documents that multipart SHA-256 belongs to the composite category; R2 similarly publishes a checksum capability table where full-object SHA-256 is unavailable on its S3-compatible multipart path. citeturn1search1turn26search4

That makes **“trust the multipart SHA-256 and skip application verification” a rejected generic design**.

### Safe content-addressed reuse

A globally shared content-addressed store is compatible with installation-level authorization only if physical deduplication is not exposed as authorization metadata.

Recommended rule:

> An upload plan may suppress transfer only when the server can establish that the declared content has already been referenced within an authorization scope whose existence the caller is entitled to learn.

Thus an authorized user can efficiently republish unchanged files inside the same installation/project, but cannot ask another project, “does SHA-256 X exist?” Cross-project physical dedupe may still occur **after receiving the bytes** or internally during install, with indistinguishable client responses.

This is stronger than simply hiding a `/blob/exists` endpoint: different plan sizes, omitted upload URLs, timing and response fields can themselves become the existence oracle.

### Cleanup and garbage collection

Keep three lifecycles distinct:

| Object class | Safe cleanup rule |
|---|---|
| Expired, uncommitted staging | Delete after upload expiration, provided no live promotion worker still owns/leases it. |
| Successful staging | Delete after commit replay is independent of staging plus a short operational grace period. |
| Committed referenced blobs | Never age-delete. Reachability is authoritative. |
| Race-left/unreferenced immutable blobs | Mark from authoritative manifests + active staging/promotions; sweep only objects remaining unreferenced after a grace interval and preferably a second mark epoch. |
| Incomplete multipart/provider sessions | Abort explicitly during cleanup even where a provider eventually auto-aborts them, because they can incur operations/storage meanwhile. |
| Backups | Include DB, content blobs and the restore procedure needed to verify every restored manifest reference before serving traffic. |

A database restore to an older point while object storage contains extra blobs is recoverable; a database that references missing object bytes is not. Restoration should therefore run a manifest/blob integrity verifier and refuse “healthy” readiness for missing referenced content.

### HTTP delivery decision

The current GET/HEAD/ETag/conditional/single-range implementation is already close to the right minimum. Do **not** add multiple ranges, dynamic compression of rangeable artifacts or CDN caching merely for feature completeness.

RFC 9110 defines the semantics of `Range`, `206 Partial Content`, `416 Range Not Satisfiable` and validators; RFC 9111 governs cache reuse and shared/private behavior. Multiple ranges are useful only if a real browser/tool client needs them. citeturn3search0turn3search1

For encoded representations:

- `Vary: Accept-Encoding` is required when representation selection depends on that request field.
- Distinct encoded bytes need representation-correct validators.
- Range offsets apply to the chosen representation.
- Combining cached partial responses requires compatible strong validators. citeturn3search0turn3search18

Therefore the current choice to compress eligible control/UI responses but exclude rangeable artifact streams is a **keep** decision.

### Cache-policy matrix

| Resource/access class | Browser cache | Shared proxy/CDN | Recommended headers/behavior |
|---|---|---|---|
| Hashed static application JS/CSS with no user data | Yes, aggressive | Yes | `public, max-age=31536000, immutable`; content-hashed filename. |
| Authenticated control/API responses | Only where explicitly safe | No | Usually `private, no-store` for sensitive responses; validators may be used on non-sensitive metadata if policy permits. |
| Moving artifact link | Minimal | No | Re-evaluate current version and authorization on every navigation or use a very short policy explicitly accepted by product. |
| Exact **historical** artifact | Authenticated only | No | `private`; gateway authorization before read. |
| Exact version that is anonymously visible **only while current** | A browser may retain only according to explicitly chosen logout/revocation semantics | **No shared storage** | The currentness/visibility check must precede serving bytes. |
| Review comments/actions | No or private validated | No | Authorization-sensitive and mutable. |
| Generated archive of protected version | Same as source version | No | Never use shared public cache merely because archive bytes are deterministic. |
| Future “public forever” immutable version class | Yes | Yes | Could use long-lived public immutable cache, but this is a **new product policy**, not the current contract. |

RFC 9111 states that `private` prevents shared caches from storing a response, while `no-store` prevents storage more broadly. A response to an authenticated request requires explicit cache semantics before ordinary shared reuse is allowed. citeturn3search1turn3search4

Cloudflare's Cache API can explicitly cache R2-backed responses, but that capability does not relax this application's authorization requirement. The R2 example itself illustrates application code doing a cache lookup before object retrieval; doing that for authorization-sensitive content would be wrong unless the cache key or preceding logic re-establishes current authorization. citeturn26search9

**Purge is not a substitute for authorization.** Purge has propagation/failure dimensions; the invariant says public access **must stop** when visibility changes or the version ceases current. Correctness therefore cannot depend on every old edge copy being purged before an attacker requests it. Cache purging can optimize a future “permanently public” class but should not guard revocation.

Service workers should similarly be prohibited from retaining protected artifact responses beyond the server's authorization contract. Cache only the application shell/static resources unless an explicit offline-private-content design is later approved.

### Streaming archives

Implement archives as a **derived streaming representation**, not a new source of truth. A ZIP implementation should:

- stream entry data without buffering the whole archive;
- use ZIP64 where classic ZIP limits are exceeded;
- compute per-entry CRC32 as required by ZIP;
- respond to cancellation by halting upstream blob reads;
- use stable path ordering and normalized timestamps/permissions if reproducible byte identity is promised;
- preserve saved paths exactly and never rewrite content;
- inherit version authorization;
- avoid shared-cache storage for protected archives.

Do not materialize/cost-cache archives until download repetition is measured. If materialization later pays off, key the derived object by exact version ID plus archive-format/options version and keep it non-authoritative.

### Cost model for publication

For `F` files, total logical bytes `B`, fresh bytes `Bfresh`, retry-completed fraction `q`, batch size `k`, and upload concurrency `Cu`:

\[
\text{client transfer bytes} \approx B_{\text{fresh}}
\]

on a successful first attempt, but a non-resuming retry can add approximately `q × Bfresh` again. File-level reconciliation removes most of that retransmission.

Current supplied S3 small-file flow implies roughly, per fresh file:

`staging PUT + HEAD + staging GET + immutable PUT + HEAD`

or about **five object requests** before considering listing/cleanup/database work. That is a supplied implementation observation, not a statement about required S3 semantics.

A safe promotion-copy fast path can reduce the application data path from:

`client → staging; staging → server; server → CAS`

toward:

`client → staging; provider-internal staging → CAS`

but only after canonical integrity and source sealing are established.

For manifest SQL, `F` one-row insert round trips become roughly `ceil(F / batch_rows)` batched statements. The affected quantity is mainly DB round trips and transaction duration; it does not reduce hashing or WAN transfer.

For small-file binary batches, file transfer requests can similarly move from `F` toward roughly `ceil(F/k)`, while authoritative manifest cardinality remains `F`.

## Consistency, Git, MCP, and identity decisions

**Decision record: review synchronization**

Timestamp polling should be retired as the correctness cursor, but polling itself need not be retired first.

Wall-clock timestamps are unsuitable as a complete change cursor because transactions can begin and commit out of timestamp order and multiple mutations can share a timestamp resolution. Likewise, allocating an ID before commit does not make numerical ID order equal commit order. The browser needs either an authoritative state reconciliation signal or a commit-ordered durable log.

**Recommended first step: a transactional per-project revision.**

Every transaction that can change a visible review projection increments `project.review_revision` in the same transaction. This should include comment creation/edit/deletion, dispatch status, visibility-affecting state and membership/access changes where they alter what the viewer may see.

Browser behavior:

1. Remember the last complete snapshot and revision `r`.
2. Poll a cheap endpoint returning authorized project revision.
3. If unchanged, do nothing.
4. If changed, refetch the authoritative affected collection or project review snapshot.
5. Replace/reconcile—not merely append/merge—so deletions disappear.
6. Periodically perform a full authoritative reconciliation as a safety mechanism.

This introduces one serialized write to the project's revision row per review-changing transaction. That is a potential hot row in a very high-write project and must be measured. It is still substantially smaller in scope than adding a durable event service before one is needed.

| Mechanism | Deletions converge? | Commit ordering solved? | Reconnect replay? | Multi-replica | Cost/complexity | Decision |
|---|---:|---:|---:|---:|---|---|
| Timestamp polling | No, not reliably | No | Partial | Yes | Low | Replace as correctness mechanism. |
| Revision + authoritative refetch | **Yes** | Does not need event ordering | Snapshot-based | **Yes**, DB is authority | Low | **Implement first.** |
| Revision + DB wake hint | Yes | Same as above | Snapshot-based | Yes if hints treated as lossy | Low–medium | Optional latency improvement. |
| Transactional outbox | Yes | Yes if revision/event order is assigned transactionally | Yes within retention | Yes | Medium | Add only when incremental events pay off. |
| Cursor-based durable feed | Yes | Yes | Yes | Yes | Medium–high | Later stage. |
| SSE without durable state | No | No | No | Lost events possible | Medium | **Reject as consistency fix.** |
| WebSocket without durable state | No | No | No | Same | Higher | Reject until two-way realtime need exists. |

**Database implementation matrix**

| Property | SQLite | PostgreSQL | D1 |
|---|---|---|---|
| Revision increment | Row update in same SQLite transaction. | `UPDATE ... RETURNING`, same transaction. | Row update in same D1 transaction/batch. |
| Primary contention risk | Single-writer nature makes extra writes visible under high mutation rate. | Row-level serialization on hot project. | D1 databases process queries serially; added writes consume free write quota. citeturn9view0turn9view1 |
| Wake hint | In-process condition/watcher; SQLite data/WAL hooks are not a cross-replica durable feed. SQLite exposes `data_version` for detecting changes from other connections. citeturn4search1 | LISTEN/NOTIFY can be a wake hint; durable DB state remains authority. | Poll revision unless introducing another Cloudflare service. |
| Durable outbox | Table in same transaction. | Table in same transaction; efficient worker claims possible. | Table in same DB; watch query/write quotas carefully. |
| Claim semantics | Conditional row update / transaction. | Row lock/CAS. `SKIP LOCKED` is useful for queue-like row selection but produces an intentionally inconsistent view and does **not** by itself serialize jobs that happen to share an artifact key. citeturn6search0 | Conditional row update, bounded batches. |
| Restore cursor | Persist feed epoch; change epoch after point-in-time restore when old cursors may collide. | Same. | Same. |

If a durable log is added, use a cursor like `(feed_epoch, project_revision, ordinal)` rather than a wall-clock timestamp. On retention expiry or an unknown/old epoch, return an explicit “resnapshot required” response instead of inventing missing history.

**Slow consumers:** do not buffer an unbounded event queue per connection. A durable consumer holds only its last acknowledged cursor; server memory queues have a small cap. On overflow/disconnect the client resumes from the durable cursor. If events have expired, the server requires a snapshot.

**Authorization during long-lived connections:** authorization must be re-evaluated on each event/refetch and periodically on a connection. A socket established while authorized is not a lifetime capability.

**Drafts:** leave review drafts device-local unless cross-device drafts become an explicit product feature. Synchronizing drafts introduces conflict/merge/privacy semantics that are unrelated to fixing committed-comment consistency.

**Linked files:** continue treating them as local observation only. A local watcher is not evidence of a safe distributed filesystem protocol.

### Git decision record

The supplied eight-version probe is enough to identify a queue-ordering design flaw but not enough to characterize throughput. If jobs with the same scheduling timestamp are secondarily ordered by a hashed ID, “version 8 claimed before version 1” is an expected consequence of the queue ordering rule, not evidence of random database behavior.

The repair should move the unit of serialization from **job row** to **artifact mirror state**.

Recommended state:

`artifact_id, remote_ref, next_expected_version, lease_owner, lease_until, fencing_token, last_served_at, blocked_reason`

A worker claims the artifact state transactionally, increments the fencing token, then processes **only the next eligible version**. A later worker with a newer fence makes the earlier worker's acknowledgement invalid. Remote state must be inspected before and after push because a DB fence cannot physically stop a stale process that already holds provider credentials.

Strict ordering means a retry-delayed failed predecessor blocks later versions **for that artifact only**. It must not block publications or other artifacts. After repeated permanent failure the mirror becomes visibly “blocked”; silently skipping a predecessor would violate strict version ordering.

Reconciliation should not insert every missing history job in a foreground enablement transaction. Store a desired high-water mark and let a background reconciler page through artifacts/versions in bounded batches. Alternate old-backfill work with new-current work to prevent starvation.

| Git option | Recommendation | Conflict/provenance model | Cost/operational effect | Architectural fit |
|---|---|---|---|---|
| Explicit review ↔ PR/commit association | **Later, useful** | Store explicit relation. Do not infer source lines from preview coordinates. | Low | Strong. |
| Push-only private mirror | **Keep and repair** | Product version remains authority; mirror can be recreated. | Moderate Git/provider/storage cost. | **Best current fit.** |
| Explicit immutable Git-commit import | **Reasonable future feature** | A user selects a commit; its tree is copied into a normal immutable publication. Force-push later does not alter imported bytes. | Moderate | Good if import is explicit. |
| Continuous bidirectional sync | **Defer/reject by default** | Requires conflict rules, loop suppression, deletion/force-push policy and provenance reconciliation. | High | Poor. |
| Git as blob/storage authority | **Reject** | Git outage/corruption becomes artifact availability issue. | High | Conflicts with non-authoritative Git constraint. |

A deterministic version→Git mapping greatly simplifies recovery. The mirror adapter should generate the same logical Git tree/commit for a given version and predecessor rather than allowing retry timestamps or nondeterministic metadata to create different commits. If a remote update succeeds and the acknowledgement is lost, retry should **inspect remote state first**, recognize the already-materialized mapping and repair only missing derived metadata.

A branch update, tag update and local job acknowledgement form separate failure boundaries. Failure injection must explicitly cover a crash after each one.

The current fresh in-memory clone strategy should be benchmarked against growing history before selecting a replacement. The supplied per-version copy limit does not bound accumulated Git pack/history/memory size. Do not infer a problem from repository age alone; measure 10, 100, 1,000 and several-thousand-version histories.

### MCP decision record

The current stable MCP specification is **2026-07-28**, whose release introduced a stateless core. The official TypeScript SDK v2 is the current stable major generation for that specification, although compatibility/version-negotiation behavior means an implementation should record the exact package semver and negotiated protocol version during qualification rather than assuming “SDK v2” always means the new revision is on the wire. citeturn14search8turn14search7turn14search9

Recommended server contract:

- stateless request handling wherever the operation itself does not require a session;
- compact list/history projections and paginated manifests;
- binary uploads via HTTPS/provider staging, never base64/raw file content in MCP JSON;
- application bearer token stays at the application server;
- server returns a scoped upload instruction/presigned staging URL;
- structured conflict/idempotency/integrity/expiry errors;
- operation lookup so cancellation or response loss cannot produce false completion;
- only report an asynchronous action/bridge delivery complete after downstream host acceptance.

The MCP authorization work requires **resource-bound** tokens. Current MCP authorization guidance requires clients to request tokens for the resource and the protected resource to validate the intended resource/audience; WorkOS's current AuthKit MCP documentation supports resource-indicator/audience-bound tokens and OAuth discovery. citeturn14search0turn19search1turn19search11

The server should therefore expose protected-resource discovery, validate issuer/signature/expiry/audience/resource exactly, support PKCE-compatible authorization flows and handle key rotation through current authorization-server metadata/JWKS. Dynamic client registration or client-ID metadata behavior is a compatibility concern, not an excuse to weaken audience checking.

**Browser OIDC does not prove MCP OAuth interoperability.** Generic OIDC is sufficient to authenticate a human browser session, but an MCP client also needs compatible OAuth discovery/client registration, PKCE/resource handling and token audience semantics. Treat those as separate qualification gates.

Current WorkOS documentation demonstrates Streamable HTTP/OAuth setup for, among others, Claude Code, ChatGPT, Codex CLI, OpenCode, Cursor and VS Code against WorkOS's own MCP service. That is useful compatibility evidence, but it does **not** qualify this application's MCP endpoint or Pi/omp bridges. citeturn15search1

| Client/host | Public evidence | Decision |
|---|---|---|
| Claude Code remote MCP | Publicly documented; Anthropic supports remote MCP and external-event channel behavior. citeturn25search0 | Live qualify exact server/OAuth flow. |
| OpenCode | WorkOS documents connecting OpenCode to its OAuth MCP server. citeturn15search1 | Evidence of general compatibility, still live-test this server. |
| Codex CLI | WorkOS documents OAuth MCP connection steps. citeturn15search1 | Live qualify this server. |
| ChatGPT custom MCP/connector | WorkOS documents its endpoint with ChatGPT. citeturn15search1 | Separate qualification; do not infer from coding clients. |
| Pi | No sufficiently authoritative current compatibility evidence established in this research. | **Experiment required.** |
| omp | No sufficiently authoritative current compatibility evidence established. | **Experiment required.** |
| Claude Code Channels bridge behavior | Anthropic documents MCP servers acting as external-event channels. citeturn25search0 | Mock tests are insufficient; host acceptance/dormancy/failure must be live-qualified. |

Adding a durable MCP subscription mechanism **before** a shared event/replay service would reverse the dependency. First create the consistency primitive; then, if there is value, expose it through MCP/SSE.

### Bridge delivery

Keep the supplied bridge invariants exactly. Replace tight idle database long-polling with a wake hint where each runtime supports one, but retain a bounded polling fallback so a missed notification cannot strand work.

A safe state machine is:

`pending → leased(fence) → host_accepted → acknowledged`

An exception during host integration returns the item to retry after jittered backoff bounded to the required 1–30 seconds. “Sent socket bytes,” “created a promise,” or “host adapter returned before acceptance” is not acknowledgement.

At-least-once means a host may receive a duplicate after a crash between host acceptance and DB acknowledgement. Each bridge payload therefore needs a stable delivery ID that the host adapter or bridge boundary can deduplicate where possible.

### WorkOS and authorization

Current public pricing distinguishes production-free AuthKit from enterprise add-ons:

| Capability | Current entitlement as researched | Cost label | Product recommendation |
|---|---|---|---|
| AuthKit/User Management | Up to **1M monthly active users free**; social auth, email/password, magic auth, MFA, email verification and RBAC appear in included capabilities. citeturn17view0 | **Ongoing free production allowance** | Good default WorkOS identity adapter. |
| Enterprise SSO | 1–15 connections: **$125/connection/month**; volume tiers thereafter. Staging can be tried free. citeturn17view0 | **Paid production feature; staging free** | Optional per installation/customer need. |
| Directory Sync / SCIM | 1–15 connections: **$125/connection/month**. citeturn17view0 | **Paid production feature** | Optional provisioning source. |
| Organizations/RBAC | Organizations/auth policies and RBAC are part of AuthKit capability set; precise high-scale contractual limits should be confirmed for the account. citeturn17view0 | **Included capability within AuthKit pricing as publicly listed** | May represent installation membership, but app DB remains authorization authority. |
| Audit Logs base capture/export | Pricing page presents base Audit Logs at $0, with separate retention/stream charges. citeturn17view0 | **Ongoing free base capability, limits not fully established here** | Do not make historical product audit retention dependent on an unclear free allowance. |
| Audit retention | **$99/month per million events stored** in current public pricing. citeturn17view0 | **Paid production feature** | Optional; retain required application audit history independently. |
| SIEM/log stream | **$125/month per SIEM connection**. citeturn17view0 | **Paid production feature** | Enterprise option only. |
| Custom AuthKit/Admin Portal/email domain | **$99/month**. citeturn17view0 | **Paid production feature** | Cosmetic/deployment requirement, not correctness requirement. |
| MCP Auth | Product and standalone integration are publicly documented, but the inspected pricing table does not separately meter it. citeturn19search1turn19search3 | **Unverified entitlement** | Confirm production pricing before making it mandatory. |
| Cross App Access | WorkOS documentation labels it early access. citeturn19search1 | **Preview/early access** | Do not make baseline requirement. |

The application should store its own durable user identity, membership status, role/capabilities at mutation time and historical actor identity. WorkOS can authenticate and provision; a WorkOS organization or role should not silently become a project ACL because the product currently has installation-level membership and application-owned authorization.

**No public self-sign-up by default:** admission must be an application policy. Even if AuthKit can create a valid identity, the application may keep it unadmitted pending invitation/provisioning.

**Verified-email admission:** use it only if an installation owner explicitly enables that policy; “verified email” answers identity control, not authorization.

**Last administrator:** enforce in the same application transaction that would deactivate/demote/remove the last admin. Provider webhooks cannot be the sole enforcement boundary.

**Deactivation latency:** the stated 30-second cross-process credential-cache bound is a product security parameter. Event/webhook invalidation can reduce average latency, but correctness should retain the hard TTL/recheck bound.

WorkOS webhooks retry failed deliveries with exponential backoff for up to three days. Receivers therefore must verify authenticity, deduplicate by event identity, tolerate duplicate/out-of-order state updates and run periodic reconciliation against provider state. citeturn20search0

Do not apply role events blindly. Convert provider events into a desired identity/provisioning state, then enforce the application's last-admin and membership rules transactionally.

## Cloud, deployment, runtime, browser, design, and operating-cost decisions

### Cloudflare viability

Cloudflare Free is technically viable for a **small/light installation**, but the architecture must be intentionally chunked and must not equate R2's free storage with a free full application.

Current documented free allowances/limits relevant here include:

| Component | Free-plan facts relevant to this system | Exhaustion / implication |
|---|---|---|
| Workers requests | Cloudflare's public developer-plan material lists **100,000 requests/day** on the free developer platform. citeturn11search1 | Request-heavy polling can consume this before meaningful artifact traffic. |
| Workers CPU | Free HTTP/Cron CPU budget is documented at roughly **10 ms** per invocation. citeturn10view0turn10view1 | CPU-heavy rehash/dearchive loops are unsuitable for one huge request. |
| Worker memory | **128 MB/isolate**. citeturn10view0turn10view1 | Bound batch buffers and archive buffers. |
| Worker incoming body | Free/Pro body-size limit is **100 MB**. citeturn10view0turn10view1 | Large browser uploads should bypass Worker body ingress through signed object upload. |
| Subrequests | Free generic subrequests and internal-service subrequest ceilings are bounded per invocation; even the larger internal-service ceiling is below 3,301 operations. citeturn10view1 | Many-file prepare must be chunked. |
| D1 reads | **5M rows/day Free**. citeturn9view0 | Poll endpoints must avoid scanning large review tables. |
| D1 writes | **100k rows/day Free**. citeturn9view0 | Per-file/per-poll write amplification matters. |
| D1 queries/invocation | **50** on Workers Free. citeturn9view1 | A one-query-per-file final commit cannot support thousands of files. Batch SQL. |
| D1 storage | **5 GB total/account**, Free; individual Free DB documented at **500 MB**. citeturn9view0turn9view1 | Manifests/comments/indexes can become the limit before R2. |
| R2 Standard storage | **10 GB-month/month free**. citeturn10view7 | Include retained blobs, staging, orphan grace, backups/versioning in forecast. |
| R2 Class A | **1M/month free**. citeturn10view7 | Writes/list/mutation-heavy publication consumes it. |
| R2 Class B | **10M/month free**. citeturn10view7 | GET/HEAD/review delivery consumes it. |
| R2 egress | Internet egress from R2 has no separate egress charge in the pricing model cited. citeturn10view7 | Request/compute/database cost still remains. |
| Cron | Free plan allows a small bounded number of cron triggers; current Workers limits page lists five per account. citeturn10view0 | Consolidate maintenance and page cleanup jobs. |
| Static assets | Free limits include up to 20,000 files per asset version and 25 MiB/file in the cited limits. citeturn10view1 | Suitable for application UI assets, not arbitrary published artifacts. |
| Cloudflare Access | Public pricing advertises a free allowance for small teams, but Access is an additional access boundary, not a substitute for application identity/authorization. citeturn11search1 | Optional defense-in-depth/admin boundary. |
| Cloudflare Artifacts | Closed beta, not Workers Free. Workers Paid pricing starts with limited included operations/storage and usage charges. citeturn12search26turn13view0 | **Exclude from baseline.** |

**Seven-second polling equation**

For `T` continuously visible tabs:

\[
\text{poll requests/day} = T \times \frac{86,400}{7}
\approx T \times 12,343
\]

So:

| Visible tabs | Poll requests/day at 7 s |
|---:|---:|
| 1 | ~12,343 |
| 4 | ~49,371 |
| 8 | ~98,743 |
| 10 | ~123,429 |
| 20 | ~246,857 |

Eight continuously visible tabs therefore consume approximately **98.7% of a 100,000-request/day Workers Free allowance** before ordinary UI, artifact, MCP or API traffic. That makes revision-aware backoff/visibility suspension or event-driven wakeup economically meaningful even if seven-second polling is technically correct. The Free request allowance comes from Cloudflare's current public plan material. citeturn11search1

A minimal polling repair should therefore:

- poll only while the review surface is visible/active;
- poll the lightweight revision rather than full collections;
- increase interval after sustained idleness;
- immediately refetch on local user activity/focus restoration;
- retain periodic authoritative reconciliation.

Do not make background timer frequency itself a correctness assumption; browsers throttle hidden tabs.

**Can a 3,301-file commit fit one Free Worker invocation? No under the supplied per-object design.** Even if every file required only one service operation, 3,301 exceeds Cloudflare's documented per-invocation service/subrequest ceilings, before adding D1 calls; the current supplied cloud path requires more than one operation per fresh file. D1 Free also permits only 50 D1 queries per invocation. citeturn10view1turn9view1

The solution is **not** to weaken atomic publication. Perform resumable preparation before the final visibility transaction:

`chunk verify/install blobs → record preparation state → ... → final bounded D1 transaction`

Only the final transaction exposes the version/current pointer.

Cleanup also needs `max_objects/max_operations/max_cpu` bounds, not merely “N uploads per cron run.” One expired upload containing thousands of files must not monopolize a Worker invocation.

**R2 S3 API versus Workers binding.** The native binding documents conditional `put` and strong write consistency; the S3 endpoint supports presigned URLs and broad S3 compatibility, but its checksum matrix and extensions differ from AWS. Browser presigned use needs an R2 CORS policy. citeturn2search0turn26search4turn26search7turn26search5

R2's S3 `CopyObject` destination conditions (`cf-copy-destination-if-*`) are an R2-specific **beta**, and Cloudflare explicitly warns that source and destination conditions are not evaluated atomically with respect to each other. Keep that out of the invariant-bearing common storage contract until both beta status and race behavior become acceptable. citeturn26search3

**Node+Postgres+R2 and Workers+D1+R2 should not receive identical tuning.**

Node can use longer-lived DB pools, larger CPU budgets, conventional multipart SDKs and app-managed concurrency. Workers must optimize invocation CPU, service calls and D1 query counts. The business/storage port may remain common, but adapter-specific prepare chunk sizes, presigning and promotion strategies are justified by invariant A.

### Cloudflare request-cost scenario

Using the supplied S3-like five-operation fresh-file sequence merely as a scenario, a 3,301-file publication would perform roughly **16,505 object operations** if R2 used an analogous pattern. If two are write-class operations and three read/head-class, that would be roughly 6,602 write-class and 9,903 read-class requests per publication. Against the current 1M Class A/10M Class B monthly free allowances, write operations would become the tighter R2 request quota at roughly 151 such completely fresh publications/month before cleanup/listing/retries/other traffic. This is **not** a forecast of the current R2 adapter; it illustrates why eliminating redundant operations matters. R2 free allowances are provider-documented. citeturn10view7

### Cloudflare static-first routing

Serve content-hashed application UI assets directly as static assets wherever they contain no installation/user-specific data. Route protected API/artifact requests Worker-first so authentication/currentness checks cannot be bypassed. Do not bind a public R2 bucket/custom domain directly to private/current-only artifact keys.

### Pulumi decision record

Pulumi itself does not create “free AWS/GCP infrastructure.” Separate IaC-tool fees from provider infrastructure.

Current Pulumi boundaries are unusually favorable for the requested operator model:

- the CLI, deployment engine, SDKs and provider ecosystem are open source;
- DIY state can use local filesystem, object storage or PostgreSQL;
- Automation API is part of the open-source IaC offering and drives the Pulumi engine/CLI;
- hosted Pulumi Cloud Free supports one user, managed state, Deployments, basic ESC, unlimited projects/stacks/environments/updates/history and up to 500 workflow minutes;
- Free ESC currently allows 25 secrets and 10k relevant API calls/month;
- Essentials is $40/month; Pro is $400/month;
- Pro includes hosted drift detection/remediation and time-to-live stacks;
- self-hosting Pulumi Cloud is an Enterprise capability. citeturn21search1turn21search2turn23view0

| Use | Choice | Cost label |
|---|---|---|
| Local/operator CLI with file/S3/GCS/Postgres state | **Use** | **Free/open-source software requiring whatever infrastructure backs state.** |
| CI `pulumi preview` | **Use existing CI runner**, scope credentials tightly | No additional Pulumi service fee with DIY state; CI/provider costs remain. |
| Automation API to create ephemeral Postgres/MinIO integration environments | **Useful outside product runtime** | Open-source API; compute/runner cost separate. citeturn21search1 |
| Pulumi Cloud Free for a single operator | Optional | **Ongoing free production allowance**, 1 user/500 workflow minutes/basic ESC. citeturn23view0 |
| ESC beyond Free | Optional | Paid after free secret/API allowance; Essentials currently $0.50/managed secret/month and $0.10/10k calls after relevant allowance. citeturn23view0 |
| Hosted drift detection/TTL | Do not assume Free | **Pro paid capability**, currently $400/month base. citeturn23view0 |
| “Product deploy button powered secretly by Automation API” | **Reject** | Conflicts with operator-tooling constraint. |

A secret-safe CI preview should use the minimum cloud read credentials needed to evaluate the stack, avoid printing Pulumi secret outputs, redact provider request traces and upload only a sanitized summary/diff artifact. Destructive `up` remains an explicit operator-controlled deployment step.

Partial ephemeral-stack failure requires a `finally` cleanup path plus a separately runnable janitor keyed by test-stack age/tags. Since IaC systems can themselves partially succeed, cleanup must tolerate resources that exist although the orchestration process crashed.

### Node, TypeScript, Effect and native helpers

Current Node documentation advertises built-in hashing, streaming, compression and worker-thread primitives; Node's site currently lists v26.9.0 as current and v24.21.0 as LTS. citeturn25search3

Effect currently advertises structured concurrency, interruption, resource cleanup and tracing, while **Effect 4.0 is still labeled a Release Candidate**. That is a reason to record the application's actual Effect version before making runtime-architecture recommendations. citeturn27view2

The supplied multiple-`ManagedRuntime`/Promise-boundary observation deserves an instrumentation task, not an immediate rewrite. Verify:

- does cancellation of the application fiber abort a queued/running Postgres operation where possible?
- does span context cross the Promise bridge?
- are scoped DB resources associated with the expected parent lifetime?
- how much wall/CPU time is actually attributable to the bridge?
- does a single Layer/runtime construction model simplify these guarantees without changing behavior?

The supplied 204 ms maximum event-loop delay, ~15.5 ms p95 delay and ~708 MiB peak RSS **do not demonstrate a language bottleneck or leak**. The retained heap observation is a different metric from RSS; native buffers, database/Git libraries and external memory can make RSS high without retained JS heap growth.

Native-helper decision rule:

\[
\text{potential whole-workload gain}
\le f \times r
\]

where `f` is the fraction of end-to-end time spent in the replaceable component and `r` is the fraction of that component eliminated. If a helper only halves the cost of a component, the component needs to occupy at least **20%** of total wall time to make a 10% whole-workload improvement possible before IPC/startup costs. A hypothetical 4× component speedup needs the component to account for roughly **13.3%** of total time.

Adopt a Go/Rust/Swift helper only if profiles show all of these:

1. ≥10% achievable end-to-end gain on an important fixture, not merely a microbenchmark.
2. Material event-loop or RSS benefit that Worker Threads/native Node primitives cannot obtain more cheaply.
3. IPC, process startup and extra copies measured and included.
4. amd64 and arm64 packaging tested.
5. offline/self-host packaging remains practical.
6. helper crash/isolation behavior is better than an in-process implementation.
7. a pure Node implementation remains available where appropriate—or the feature is absent on Workers, which cannot depend on spawned native helpers.

Worker Threads are the first experiment for CPU-heavy JavaScript processing such as archive CRC/compression. They are not a remedy for provider latency or excessive SQL/object round trips.

### Browser qualification

The current Chromium gate plus ad-hoc Firefox/WebKit checks is not a durable three-engine qualification policy. Playwright directly supports Chromium, Firefox and WebKit, browser contexts, automatic waits/assertions and trace capture including DOM snapshots, network, console and screenshots. citeturn27view0

Use a **small critical matrix**, not necessarily the entire test suite:

| Critical flow | Chromium | Firefox | WebKit |
|---|---:|---:|---:|
| Exact immutable version loads | Every gate | Every gate/release gate | Every gate/release gate |
| Opaque annotation mode isolation | Yes | Yes | Yes |
| Interactive preview isolation | Yes | Yes | Yes |
| Public current vs historical auth | Yes | Yes | Yes |
| Two-context comment create/delete/dispatch convergence | Yes | Yes | Yes |
| Logout/deactivation/credential expiry | Yes | Yes | Yes |
| Range/conditional delivery from browser | Yes | Critical subset | Critical subset |
| Draft timing/local-only semantics | Yes | Yes | Yes |
| Full cosmetic catalogue | Main engine | Targeted | Targeted |

Playwright's auto-waiting/web-first assertions support the requirement to avoid fixed sleeps that mask timing defects. citeturn27view0

**Fix evidence normalization before expanding the matrix.** The report-producing wrapper must run in a `finally`-equivalent path and atomically create a record for *this run* even if browser launch, tests or artifact copying fail. Every result bundle should carry:

`run_id, git SHA, build/container identity, deployment URL/environment, test-config hash, Playwright package version, browser engine+build, OS/image, start/end timestamps, exit status`

Never leave an old normalized “pass” bundle in the current output path after a failed new run.

Keep trace/screenshot/network/console data long enough to diagnose release-gating failures, but use dedicated low-privilege test credentials and redact cookies, bearer tokens, signed URLs and private file bodies before long-term artifact upload. Playwright traces contain enough page/network detail that treating them as inherently non-secret is unsafe. The trace tooling's documented richness is precisely why retention needs redaction. citeturn27view0

Mock host tests can establish bridge state-machine behavior; they cannot establish that Claude Code/Pi/omp/OpenCode actually accepts a follow-up, applies current auth semantics or goes dormant correctly. Maintain a small live-host qualification procedure.

### Claude Design and catalog decisions

Anthropic launched **Claude Design** as an Anthropic Labs product on April 17, 2026, and current Help Center navigation exposes specific Claude Design and design-system setup documentation. citeturn25search4turn27view1

What public evidence **does not** establish here is a permanent, versioned contract for any particular exported directory/manifest convention. Therefore:

- do not hard-code undocumented Claude-generated directory structures as a stable API;
- capability-detect/import files conservatively;
- give this system's generated catalog its **own explicit, versioned schema**;
- preserve original saved paths;
- preserve declared card viewport dimensions and define a deterministic fallback;
- keep templates grouped distinctly;
- use supplied thumbnails when available rather than re-rendering every card;
- make optional generated thumbnails derived data keyed by source version + renderer version + viewport parameters;
- report unresolved external fonts/scripts/images rather than silently fetching/rewriting them into the saved artifact;
- retain application/content-origin isolation.

For missing external dependencies, exact-version preview should display the saved artifact as saved. The server must not secretly vendor, rebuild or rewrite remote assets. A catalog may diagnose “external resource unavailable” and present the original URL/path metadata.

For nested previews, the safe annotation UX is an **outer-application action that selects the exact original file/version and opens annotation mode there**. Do not put an app-authorized annotation bridge inside untrusted nested interactive content.

A multi-artifact project page should default to a **moving view** and clearly say it is not immutable. If users need a citable frozen project state, add a separate “collection snapshot” object containing exact artifact/version IDs. That requires a new acceptance contract; do not make a moving page appear immutable.

Keyboard navigation, visible focus, escape/back semantics, browser-history stability and `prefers-reduced-motion` behavior should be in the catalog browser acceptance matrix.

## Uncertainty register and validation program

### Uncertainty register

| ID | Question / why it matters | Evidence and current conclusion | Confidence | Status / smallest next action / closure criterion |
|---|---|---|---|---|
| **U-PUB-01** | Does batching final Postgres manifest inserts improve 3,301-file E2E by ≥10%? | Supplied commit is ~38.5% of total, giving enough headroom. | Medium | **Experiment required.** Instrument current per-row SQL, then batch 50/100/250/500. Closed when paired runs show stable effect and no transaction/correctness regression. |
| **U-PUB-02** | What batch size minimizes WAN small-file overhead? | Request amplification strongly suggests potential; no controlled stage data exists. | Low | **Experiment required.** Sweep bounded binary transfer sizes. Close with ≥10% paired gain and bounded memory/error recovery. |
| **U-PUB-03** | When should signed upload replace app-origin upload? | Provider APIs support it; benefit depends on bandwidth/CPU/topology. citeturn26search7turn0search6 | Medium | **Experiment required.** Compare 2 MiB, 100 MiB, 1 GiB if supported. Threshold where gain exceeds complexity becomes policy. |
| **U-PUB-04** | Can AWS S3 staging→CAS copy satisfy destination create-only invariant? | Inspected AWS material established conditional writes for PutObject/multipart, not the needed CopyObject destination proof. | Low | **Blocked by evidence / provider qualification.** Write a targeted AWS integration test and inspect current CopyObject API docs before enabling. |
| **U-PUB-05** | Can R2 conditional copy be a baseline primitive? | Provider says destination condition is beta and not atomic with source condition. citeturn26search3 | High | **Answered: no for baseline.** Reconsider only when feature is stable and race contract is adequate. |
| **U-PUB-06** | Can GCS use generation-bound server-side promotion safely? | Source/destination generation conditions are documented. citeturn0search2turn0search4 | High | **Conditionally answered: yes**, subject to integration tests proving SHA-256 workflow/retry semantics. |
| **U-PUB-07** | Can provider checksum eliminate server SHA-256 pass? | Multipart SHA-256 is not universally ordinary full-object SHA-256. citeturn1search1turn26search4 | High | **Answered generically: no.** Enable only adapter/mode-specific proof. |
| **U-PUB-08** | Safe local hard-link promotion? | Unsafe while writable alias/handle exists. | High | **Conditionally answered.** Only after a seal protocol is proved; benchmark must justify complexity. |
| **U-PUB-09** | How long may successful staging/idempotency records be retained? | Replay can be staging-independent; policy lifetime not supplied. | Medium | **Owner decision required.** Specify retry/idempotency retention and compliance storage policy. |
| **U-PUB-10** | What GC grace is sufficient? | Requires backup/replication/long-running-operation facts not supplied. | Low | **Owner/ops input required.** Measure max operation/restore lag; choose grace > worst credible lag and verify with two-pass mark/sweep. |
| **U-HTTP-01** | Add multipart byte ranges? | Current single-range already covers common delivery; no client requirement supplied. | High | **Explicitly deferred.** Add only when a real client fails or measurable benefit emerges. |
| **U-HTTP-02** | Shared-cache current-public bytes? | Conflicts with revocable/current-only anonymous authorization. citeturn3search1turn3search4 | High | **Answered: reject.** Reopen only if product creates a permanently-public access class. |
| **U-HTTP-03** | Browser cache after logout? | Security/product policy not specified. | Medium | **Owner decision required.** Decide whether previously downloaded protected bytes may remain available through normal browser cache after logout; choose `no-store` if not. |
| **U-SYNC-01** | Is revision+refetch enough? | It solves known merge/deletion failure with minimal architecture. | High | **Conditionally answered: implement first.** Add durable feed only if measured traffic/latency becomes inadequate. |
| **U-SYNC-02** | Will per-project revision become a write hotspot? | Depends on review mutation rate; Postgres/D1 serialize relevant row/DB work. | Medium | **Experiment required.** Concurrent commenter benchmark. Close if lock wait remains below agreed SLO. |
| **U-SYNC-03** | Cross-device draft synchronization? | Not required for committed consistency. | High | **Owner decision required / deferred.** Keep local until explicit feature demand. |
| **U-GIT-01** | Can current Git adapter enforce remote compare-before-update safely? | Adapter/provider implementation details unavailable. | Low | **Experiment required.** Simulate two workers and stale lease against test remote. |
| **U-GIT-02** | How fast does in-memory clone memory/latency grow? | Supplied concern but no history-size profile. | Low | **Experiment required.** 10/100/1k/5k versions and large-file variants. |
| **U-GIT-03** | What to do with permanently failed predecessor? | Strict ordering precludes silent bypass. | High | **Owner decision required.** Recommended default: mark mirror blocked, alert, primary unaffected. |
| **U-MCP-01** | Exact negotiated MCP revision/package semver in implementation? | Stable spec is 2026-07-28; SDK v2 current, but repo version unknown. citeturn14search8turn14search7 | High on standard, low locally | **Local fact required.** Record package lock and wire negotiation. |
| **U-MCP-02** | Pi/omp remote MCP/OAuth/bridge behavior? | Authoritative evidence insufficient. | Low | **Live qualification required.** Dedicated sandbox acceptance test. |
| **U-MCP-03** | Does per-request server/catalog construction materially cost CPU? | No applicable measurement available. | Low | **Experiment required.** Instrument construction separately; cache only if ≥5–10% material and safe. |
| **U-ID-01** | Is WorkOS MCP Auth included in current production AuthKit allowance? | Public docs show feature; inspected pricing does not separately price it. citeturn19search1turn17view0 | Low | **Unverified entitlement.** Confirm contract/dashboard before making it required. |
| **U-ID-02** | WorkOS Audit Logs free retention details? | Base is shown at $0, storage and SIEM explicitly metered. citeturn17view0 | Medium | **Conditionally answered.** Do not depend on unspecified retention; use app-owned audit history. |
| **U-CF-01** | Can target workload stay within Cloudflare Free? | Limits known, workload unknown. citeturn9view0turn10view7 | Medium | **Owner/measurement required.** Supply DAU/tabs/publishes/storage. Evaluate equations below. |
| **U-CF-02** | Can 3,301-file commit run in one Free Worker request? | Per-invocation limits are lower than file count. citeturn10view1turn9view1 | High | **Answered: no for one-operation-per-file design.** Build chunked prepare/finalize. |
| **U-CF-03** | Use Cloudflare Artifacts? | Closed beta and not Workers Free. citeturn12search26turn13view0 | High | **Answered: exclude baseline.** Reassess after GA only if Git-mirror economics warrant it. |
| **U-PUL-01** | Does paid Pulumi drift/TTL provide enough payoff? | Pro currently $400/mo; CLI refresh/CI can cover small operations. citeturn23view0turn21search5 | High | **Answered for now: no baseline paid dependency.** |
| **U-RUNTIME-01** | Does ManagedRuntime/Promise boundary lose cancellation/tracing? | Architecture observation supplied; exact code/version unavailable. | Low | **Local code/instrumentation required.** Interrupt DB operation and inspect parent/child spans. |
| **U-RUNTIME-02** | Is a native helper justified? | No component profile demonstrates ≥10% E2E opportunity. | High | **Answered: reject now.** Reopen only after CPU profile meets decision rule. |
| **U-BROW-01** | Which exact engine versions are supported? | Playwright supports three engines; product browser-support policy absent. citeturn27view0 | Medium | **Owner decision required.** Define support window; CI records exact Playwright browser builds. |
| **U-DESIGN-01** | Are Claude Design export directory schemas stable APIs? | Product and Design docs exist; stable export schema not established. citeturn25search4turn27view1 | High | **Answered: treat as undocumented conventions.** |
| **U-DESIGN-02** | Moving project view or immutable project snapshot? | Both are valid but semantically distinct. | High | **Owner decision required.** Recommended moving view + optional explicit snapshot collection. |

### Benchmark program

The benchmark should answer **specific decision questions**, not publish one global “performance number.”

Record for every run:

`git SHA, runtime version, Effect version, provider SDK version, DB version, OS/kernel/container, CPU model/count, RAM, filesystem, region/zone, client↔server/provider RTT, TLS/proxy topology, object-store settings, DB durability settings, pool size, test fixture hash, cache/warm state`

Do not compare Node 24/M1-local to Node 26/MinIO/Postgres and call the difference a regression. The supplied numbers are useful baselines only when their environments are reproduced.

**Fixtures**

| Fixture | Shape/purpose |
|---|---|
| Tiny single | 1 × 1 KiB text; exposes fixed transaction/request overhead. |
| Medium single | 1 × 2 MiB incompressible plus 1 × 2 MiB compressible text; connects to supplied fixture. |
| Large | 100 MiB and, where environment permits, 1 GiB; tests signed/resumable/multipart threshold. |
| Small directory | ≈48 files, same bytes/path shape as existing gate where possible. |
| Medium directory | ≈1,000 files with log-normal size distribution plus intentionally many 1–16 KiB objects. |
| Large directory | exactly 3,301 files matching the observed problematic cardinality, with fresh and repeat-byte forms. |
| Large catalog | 10k/50k version/file metadata entries for pagination and manifest-loading tests. |
| Repeated version | 90%, 99% unchanged bytes to quantify CAS reuse. |
| Git histories | 10/100/1k/5k versions, with small and large cumulative repositories. |
| Archive | 48/1k/3,301 files, compressible/incompressible, >classic-ZIP-boundary fixture where practical. |
| Competing writers | Two and 10 simultaneous publishers to same artifact with same and different expected-current values. |
| Review load | 2/10/50 browser contexts creating/deleting/dispatching comments across replicas. |

For publication, compare at least:

- current baseline;
- batched final SQL only;
- retry reconciliation only;
- bounded small-file batch only;
- signed upload only;
- safe server-side promotion where supported;
- same-project CAS reuse;
- combinations only after isolated effects are known.

**Sample design**

For very slow 3,301-file WAN runs, target at least **10–20 independent paired repetitions per variant** if cost permits, randomized A/B order, with enough total executions to estimate median robustly. Do not report p99 from ten runs. For short local operations, run dozens to hundreds of independent top-level operations, but avoid treating thousands of requests nested inside one publication as independent samples.

Report p95 only with enough independent observations that the percentile is meaningful; p99 needs substantially more. A three-sample maximum must remain a three-sample maximum.

Paired comparison:

\[
\Delta_i=\frac{T_{baseline,i}-T_{candidate,i}}{T_{baseline,i}}
\]

Randomize candidate/baseline order within matched environment blocks. Report median paired improvement and confidence interval/bootstrap interval. Require both:

1. point estimate ≥10% on the named target workload; and
2. uncertainty sufficiently narrow that ordinary environmental noise does not plausibly explain the claimed gain.

For high-cost cloud fixtures where enough repetitions are not affordable, label the result exploratory rather than manufacturing a p95.

**Measurements**

At client:

- walk/stat time;
- SHA-256 CPU and elapsed time;
- bytes read locally;
- plan latency;
- upload bytes/retries;
- per-file/batch queue wait and transfer latency;
- client RSS/heap/CPU.

At application server:

- complete E2E;
- plan DB time;
- staging validation;
- SHA time;
- provider I/O wait;
- promotion time;
- final transaction duration;
- event-loop utilization/delay histogram;
- process CPU;
- RSS;
- heap used/retained after GC-controlled settling where appropriate;
- Node external/array-buffer memory;
- cancellation count.

At database:

- SQL statement count;
- cumulative query time;
- final transaction duration;
- row-lock wait;
- pool acquisition wait;
- rows affected;
- WAL/log bytes where available;
- D1 query and row-read/write counts.

At object storage:

- operation count by API;
- status/retry count;
- bytes client→store;
- bytes app→store;
- bytes store→app;
- multipart parts/aborted parts;
- staging age;
- orphan count.

A benchmark is invalid if the candidate changes durability settings, omits integrity verification, changes auth boundaries or silently lowers assertions.

### Failure-injection matrix

| Injection point | Expected durable state | Retry expectation | Pass assertion |
|---|---|---|---|
| Client dies after plan, before upload | Expiring plan only | Reconcile/reuse or safely make new plan under same operation | No visible version. |
| Halfway through file PUT | Incomplete provider/temp data only | Resume multipart/session or retransmit file | No committed blob/version until full SHA/size verified. |
| After staging PUT, before verification record | Staging bytes may exist | Re-head/re-read and verify | Never trust “object exists” alone. |
| After verification, before CAS install | Verified staging durable | Resume install without re-upload from client | Final blob exactly expected hash. |
| Two installers race same digest | One immutable object wins | Loser treats create-precondition failure as dedupe only after verifying identity | Original bytes never replaced. |
| Source modified during copy attempt | Source condition fails | Re-verify current staged generation or fail plan | No wrong digest installed. |
| Blob install succeeds, process dies before DB commit | Orphan blob exists, no version | Retry reuses blob; GC eventually handles if abandoned | Version invisible until transaction. |
| During manifest DB transaction | Full rollback | Retry finalizes original operation | No partial manifest/current pointer. |
| Stale expected-current | All prepared bytes may exist; DB rejects pointer/version publication according to transaction design | Same operation returns same conflict | Never overwrites newer current pointer. |
| DB commit succeeds, HTTP response lost | Version/idempotency result committed | Retry lookup returns exact original result without requiring staging | Same version ID/result. |
| Successful staging deleted before retry | Committed version/result remain | Retry succeeds from idempotency row | No dependency on staging. |
| GC races active prepare | Active lease/reference protects object | GC skips | No referenced/preparing object disappears. |
| Provider outage mid-prepare | Partial staging/CAS possible | Bounded retries; operation remains resumable | Primary DB never references missing blob. |
| Browser auth revoked while preview open | Existing DOM may remain; subsequent protected server reads fail | Re-auth/lock UI | Server grants no new protected bytes. |
| Comment deleted by another replica | Project revision changes | Other clients authoritative-refetch | Deleted record disappears. |
| SSE/wake hint deliberately dropped | Durable revision/outbox remains | Poll/reconnect discovers change | No consistency dependence on notification. |
| Git worker lease expires mid-copy | Possible local temp state | New worker fences old acknowledgement | Only expected next mirror version is recognized. |
| Git branch update succeeds, process dies before tag/ack | Remote partial derived state | Retry inspects remote and idempotently repairs missing side effects | No duplicate/divergent version mapping. |
| Old Git worker resumes after new fence | Old process may still attempt provider call | Remote predecessor/CAS check blocks harmful update; DB ack blocked by fence | Mirror order intact. |
| Bridge host accepts, process dies before DB ack | Duplicate may be redelivered | Stable delivery ID permits at-least-once semantics | Never falsely mark undelivered item delivered. |
| Browser test crashes before normalization | Raw partial logs possible | Normalizer finalizer emits failed-current-run record | No stale older “pass” presented as current evidence. |

## Contract impact and roadmap

### Contract-impact matrix

Legend: **P** preserves current behavior; **E** expands behavior with acceptance criteria; **C** conflicts and is rejected.

| Recommendation | A | B | C | D | E | F | G | H | I | J | K | L | M | N | Impact |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Batch Postgres manifest inserts | P | P | P | P | P | P | P | P | – | – | – | P | – | P | Internal optimization. |
| File-level retry reconciliation | P | P | P | **Strengthens** | P | P | P | P | – | – | – | P | – | P | Correctness + efficiency. |
| Bounded binary small-file batches | P | P | P | P | **P** | P | P | P | – | – | – | P | – | P | New transfer representation only. |
| Provider-native signed staging | P | P | P | P | P | **Must strengthen** | P | P | – | – | – | P | – | P | E; scoped staging capability required. |
| Conditional immutable writes | P | **Strengthens** | P | P | P | P | P | P | – | – | – | P | – | P | Correctness repair. |
| Safe server-side promotion | P | P | P | P | P | P | P | P | – | – | – | P | – | P | Adapter capability, not common assumption. |
| Global client-visible CAS “exists” | – | – | – | – | – | **C** | – | – | – | – | – | – | – | – | Reject cross-project oracle. |
| Shared CDN caching current-only public artifacts | – | – | – | – | – | – | – | **C** | – | – | – | – | – | – | Reject. |
| Revision + authoritative refetch | P | P | P | P | – | P | P | P | – | – | P | P | – | P | Repairs multi-client consistency. |
| Durable outbox later | P | P | P | P | – | P | P | P | P | – | P | P | – | P | E; only if justified. |
| Git per-artifact fencing | P | P | P | P | – | P | P | P | – | **Strengthens** | – | P | – | P | Correctness repair. |
| Bidirectional Git sync | – | – | – | – | – | – | – | – | – | **C** | – | – | – | – | Reject default. |
| Git primary storage | C | B/C | C | – | – | – | – | – | – | **C** | – | – | – | – | Reject. |
| MCP signed upload instructions | P | P | P | P | **P** | P | P | P | – | – | – | P | – | P | E at protocol surface; bytes remain binary. |
| WorkOS role as product ACL | **C** | – | – | – | – | F/C | – | – | – | – | – | – | – | – | Reject unless owner deliberately changes auth model. |
| Chunked Cloudflare prepare + final D1 commit | P | P | **P** | P | P | P | P | P | – | – | – | P | – | P | Needed for Worker limits. |
| Native helper now | – | – | – | – | – | – | – | – | – | – | – | – | – | N | Deferred pending evidence. |
| Three-engine critical browser gate | – | – | – | – | – | – | – | – | – | – | **Strengthens** | – | – | **Strengthens** | Qualification expansion. |
| Nested annotation bridge into interactive artifact | – | – | – | – | – | – | – | – | – | – | **C** | – | – | – | Reject. |
| Pulumi inside product lifecycle | A/C | – | – | – | – | – | – | – | – | – | – | – | **C** | – | Reject. |

### Proposed acceptance statements

These are new proposed statements, not claimed existing repository requirement IDs.

**Publication batching**

> Given any manifest supported by the previous publication path, batched metadata insertion produces the identical canonical manifest/version identity and visibility result. A crash at any statement boundary leaves either no publication or the complete publication, never a partially visible manifest.

**Operation reconciliation**

> Retrying a publication with the same durable operation identity after any client/server response loss returns the original committed result without requiring retransmission of files already proven durable; if the original operation ended in stale-current conflict, every retry returns that conflict.

**Immutable object creation**

> Installation of a blob at a content-addressed destination never replaces pre-existing bytes. A concurrent attempt either creates the absent object or observes a create-precondition conflict and validates/reuses the existing immutable object.

**Signed staging**

> A signed upload credential grants access only to an application-generated staging object/session for the authorized operation, expires within the configured bound, does not contain or forward the application's bearer token, and cannot select tenant IDs, bucket names or final content locations from client input.

**Review revision**

> Any committed mutation that changes the authorized review projection changes its project revision in the same transaction. A client that observes a different revision and completes the authoritative reconciliation converges to the server state, including deletions and dispatch removals.

**Durable feed, if later added**

> Reconnecting with a retained cursor yields every authorized event after that cursor at least once and in defined project revision order, or returns an explicit cursor-expired/epoch-mismatch response requiring an authoritative snapshot.

**Git mirror**

> For each artifact, a mirror never acknowledges version `n+1` before version `n`; a stale worker cannot acknowledge or overwrite work after losing its fencing lease; any remote success followed by local response loss is recovered by inspecting remote state rather than creating a divergent mapping.

**Cloudflare prepare/finalize**

> A single publication may prepare immutable blobs over multiple Worker invocations, but none becomes a visible version until one final bounded D1 transaction atomically records the complete manifest/version/action/idempotency result and expected-current update.

**Browser evidence**

> Every browser-gate invocation produces a uniquely identified current-run result even if setup, browser launch, test execution or artifact collection fails. A previous run's normalized report is never presented as evidence for a later failed invocation.

**Design preview**

> Interactive nested content cannot call an application-authorized annotation API. Annotating a nested item always transitions through trusted application UI to the exact original file and version.

### Ranked top-ten roadmap

| Rank | Work | Category | User/correctness value | Perf potential | Evidence | Effort / ops | Free-tier fit | Dependencies |
|---:|---|---|---|---|---|---|---|---|
| **1** | Conditional create-only immutable writes + provider conformance tests | Immediate correctness | Very high | Neutral | High | Medium | Strong | None |
| **2** | Batch final Postgres manifest insertion with stage metrics | Low-risk improvement | High for many-file publishes | **Potential ≥10% on 3,301 fixture** | Medium | Low–medium | Strong | Benchmark instrumentation |
| **3** | Idempotent operation lookup + file-level resume/reconciliation | Correctness/UX | Very high on failures | Potentially huge on retries | High architectural confidence | Medium | Strong | Persistent file completion state |
| **4** | Project revision + authoritative review reconciliation | Immediate correctness | Very high | Reduces wasteful polling payloads | High | Medium | **Improves Cloudflare Free viability** | Schema change |
| **5** | Git per-artifact state/ordering/fence + bounded reconciliation | Immediate correctness | High for Git users | May reduce clone/queue waste | Medium | Medium–high | No extra service required | Git failure tests |
| **6** | Chunked Cloudflare prepare/finalize and object-count-bounded cleanup | Platform correctness | High for Workers deployment | Enables otherwise-impossible many-file workload | High | High | Essential for Free viability | Blob prep state |
| **7** | Failure-safe browser evidence + critical three-engine matrix | Qualification | High release confidence | Neutral | High | Medium | CI cost dependent | Support policy |
| **8** | Signed provider-native upload experiment for large files | Measurement-first | High on WAN/large files | Plausible ≥10% for bandwidth/app-proxy-bound workload | Medium | Medium–high | R2 allowance friendly; provider-specific | Storage capability model |
| **9** | Bounded binary small-file batch experiment + authorized same-project CAS reuse | Measurement-first | Faster many-file publish | Plausible ≥10% at high RTT/repeated bytes | Medium/low | Medium–high | Reduces request usage | Resume groundwork |
| **10** | Durable outbox/SSE, archive materialization, native helper, richer Git import | Deferred extensions | Conditional | Unknown | Low today | High | Variable | Only after preceding measurements |

**Explicitly not on the first-ten implementation path:** continuous bidirectional Git sync, Git-as-primary, shared CDN cache for current-only public artifacts, an application-level Pulumi wrapper, a new serialization protocol for MCP, automatic server builds, distributed linked-file sync, or a native-language rewrite.

### First thirty days

Concentrate on evidence and correctness:

1. Add stage-level publication telemetry and object/SQL counters.
2. Add provider create-only conformance tests for local, AWS S3, R2 and GCS.
3. Batch Postgres manifest insertion behind the existing DB port.
4. Make idempotency lookup the first retry action.
5. Change browser review correctness from timestamp merge to revision + authoritative replacement.
6. Make browser evidence normalization failure-safe.
7. Add Git test fixtures reproducing same-timestamp ordering and stale worker scenarios.

No new service is necessary.

### First sixty days

With the first measurements:

1. Complete file-level resume/completed-plan reconciliation.
2. Make Cloudflare prepare/finalize chunkable and maintenance bounded by operation/object count.
3. Implement Git artifact-level claiming/fencing and bounded historical reconciliation.
4. Establish the critical Chromium/Firefox/WebKit matrix.
5. Qualify latest MCP 2026-07-28 behavior and WorkOS/generic-OIDC flows against actual clients.
6. Run provider-native signed-upload experiments.
7. Add same-project authorized CAS reuse if repeated-byte workloads justify it.

### First ninety days

Only adopt measured winners:

1. Enable signed/resumable provider staging above empirically selected thresholds.
2. Add bounded binary small-file batches if the 1k/3,301 WAN fixtures show repeatable ≥10% E2E benefit.
3. Add safe provider-copy promotion only for adapters whose source/destination race semantics pass failure tests.
4. Decide whether revision/refetch is sufficient or a transactional outbox/SSE layer is justified.
5. Select Git clone strategy from history-growth benchmarks.
6. Decide archive materialization from measured repeat downloads.
7. Reconsider a native helper only if CPU profiles satisfy the Amdahl decision threshold.

## Final handoff and source register

### Local facts still required

| Needed input | Cheapest safe way to obtain it | Decision unlocked |
|---|---|---|
| Exact `package-lock`/pnpm lock versions for Node, Effect, DB/storage SDKs, MCP SDK, Playwright | Capture dependency lock + `node --version`; no upgrade required | Reproducible qualification and compatibility matrices. |
| Exact Postgres version/config, pool topology and RTT in VPS/S3 case | `SELECT version()`, pool metrics, DB hostname RTT; read-only | Whether batching or pool tuning dominates. |
| SQL trace of 3,301-file commit | Instrument statement count/time without logging values | Confirms manifest insertion bottleneck. |
| Per-stage timing for same run | Span plan/upload/verify/install/final transaction | Determines ≥10% headroom. |
| Provider operation log/count | SDK middleware/provider metrics; redact object keys/tokens | Quantifies HEAD/GET/PUT amplification. |
| Bytes on client→app, client→store, app→store legs | Application counters/provider metrics, not packet capture containing private data | Signed-upload value. |
| Repeated-byte ratio in real publications | Offline aggregate of digest references; no content inspection | CAS-reuse ROI. |
| File-size distribution | Aggregate histogram only | Small-batch/multipart thresholds. |
| Real retry rate and percent completed at failure | Operation-state telemetry | Resume ROI. |
| Staging and orphan object age/size distribution | Read-only listing by app-generated prefix | GC economics/grace. |
| Backup cadence/object-store restore RPO | Operator config | Safe GC grace/restore verifier requirements. |
| Cloudflare expected DAU, concurrent visible review tabs, publications/day, files/publication, retained GB | Operator workload worksheet | Whether Free is sustainable. |
| D1 query/row counts by endpoint | D1 analytics/local counters | Polling/feed and batching feasibility. |
| Review mutation rate per hottest project | DB aggregate | Revision-row contention risk. |
| Current authorization cache implementation and invalidation path | Code/config inspection | Whether 30 s bound is actually enforced under replica failure. |
| WorkOS production account entitlements | Dashboard/contract read-only check | MCP Auth/Audit entitlement; do not infer from marketing. |
| Generic OIDC provider(s) targeted | Installation configuration | OIDC/MCP OAuth compatibility scope. |
| Current MCP negotiated versions from Claude Code/OpenCode/Codex/Pi/omp | Sandboxed handshake/log, no production writes | Client qualification matrix. |
| Git provider and remote branch/tag policies | Test repository configuration | Remote CAS/fencing strategy. |
| Git repo size at 10/100/1k/current versions | Clone/fetch benchmark in disposable repo | In-memory adapter decision. |
| Effect runtime construction/cancellation path | One injected cancellation with trace IDs | Whether Promise/ManagedRuntime bridge loses structured cancellation/tracing. |
| CPU profile of 3,301 publish/archive/Git | Node CPU profile in isolated fixture | Native helper/Worker Thread decision. |
| RSS breakdown incl. external/array buffers | `process.memoryUsage()` + OS RSS sampled over workload | Distinguishes JS retention from buffers/native Git/etc. |
| Exact browser support policy | Product owner decision | Which Firefox/WebKit failures gate releases. |
| Example Claude Design/Design System/Project exports that users actually rely on | Sanitized sample directories supplied locally | Import compatibility without pretending undocumented schema is public. |
| Browser-cache-after-logout expectation | Product/security owner decision | `private,no-cache` versus `no-store`. |
| Permanent-public artifact use case | Product owner decision | Whether a CDN-cacheable immutable public class should exist. |
| Frozen multi-artifact project-share need | Product owner decision | Whether collection snapshots are worth implementing. |

The cheapest general method is **measurement through existing ports and disposable integration fixtures**, not production load testing. Provider race semantics should be tested against private test buckets/repos only; client compatibility should use sandbox accounts; benchmark fixtures should contain synthetic bytes.

### Vendor cost formulas

Use these rather than “free” assertions.

**Cloudflare Workers**

\[
R_{\text{daily}}
=
R_{\text{UI}}
+R_{\text{API}}
+R_{\text{poll}}
+R_{\text{artifact gateway}}
+R_{\text{MCP}}
\]

with:

\[
R_{\text{poll}}\approx 12,343 \times \text{continuously-visible tabs/day}
\]

Compare to the current public Free request allowance and separately verify CPU/subrequest limits because staying below request quota does not imply successful execution. citeturn11search1turn10view1

**R2**

\[
GB_{\text{stored}}
=
GB_{\text{reachable blobs}}
+GB_{\text{active staging}}
+GB_{\text{GC grace}}
+GB_{\text{multipart leftovers}}
+GB_{\text{derived archives/thumbnails}}
+GB_{\text{backup copies in R2, if any}}
\]

\[
A=
\text{writes}+\text{deletes}+\text{lists}+\text{multipart mutations}+\ldots
\]

\[
B=
\text{reads}+\text{heads}+\ldots
\]

Compare monthly usage to 10 GB-month, 1M Class A and 10M Class B Free Standard allowances. citeturn10view7

**D1**

\[
W_{\text{daily}}
=
W_{\text{publication metadata}}
+W_{\text{review}}
+W_{\text{revisions}}
+W_{\text{jobs}}
+W_{\text{staging state}}
\]

\[
R_{\text{rows,daily}}
=
\sum_{\text{queries}} \text{rows scanned/read}
\]

Compare to current Free 100k rows written/day and 5M rows read/day, plus database-storage and per-invocation query limits. citeturn9view0turn9view1

**WorkOS**

\[
C_{\text{WorkOS}}
=
C_{\text{AuthKit excess MAU}}
+125\times N_{\text{SSO connections, first tier}}
+125\times N_{\text{Directory connections, first tier}}
+99\times N_{\text{custom domains}}
+99\times N_{\text{million audit events retained}}
+125\times N_{\text{SIEM streams}}
+\text{other contracted features}
\]

This is illustrative at currently published first-tier list prices; volume discounts/contract terms alter it. citeturn17view0

**Pulumi**

For OSS/DIY:

\[
C_{\text{Pulumi software}}=0
\]

but:

\[
C_{\text{deployment}}
=
C_{\text{state storage}}
+C_{\text{CI runners}}
+C_{\text{AWS/GCP/Kubernetes resources}}
+C_{\text{logs/backups}}
\]

For hosted plans, current list pricing is Free $0/one user, Essentials $40/month and Pro $400/month before additional usage; ESC, workflow and resource usage have their own units. citeturn23view0

### Source register

The register below records the principal primary sources used. All were checked September 17, 2026 unless otherwise stated.

| Source | Publisher / version or date | Direct URL | Claims supported / limitation |
|---|---|---|---|
| HTTP Semantics, RFC 9110 | IETF/RFC Editor | `https://www.rfc-editor.org/rfc/rfc9110` | Conditional requests, validators, Range/206/416. Normative HTTP semantics; not provider implementation. citeturn3search0 |
| HTTP Caching, RFC 9111 | IETF/RFC Editor | `https://www.rfc-editor.org/rfc/rfc9111` | Shared/private/no-store/authenticated-cache rules. Normative; does not define product auth policy. citeturn3search1turn3search4 |
| S3 conditional writes | Amazon Web Services | `https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html` | `If-None-Match`/`If-Match` conditional-write behavior. Copy-destination semantics still require separate qualification. citeturn0search0 |
| Checking object integrity for S3 uploads | Amazon Web Services | `https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html` | Full-object versus composite checksums; multipart implications. citeturn1search1 |
| S3 multipart upload documentation | Amazon Web Services | `https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html` | Multipart completion/resume/cleanup model. Exact recommended size is guidance, not a product threshold. citeturn1search5 |
| R2 Workers API | Cloudflare, current 2026 docs | `https://developers.cloudflare.com/r2/api/workers/workers-api-reference/` | Native `put`, conditional operations, checksums, multipart/object semantics. citeturn2search0 |
| R2 S3 API compatibility | Cloudflare, updated Jul. 31, 2026 | `https://developers.cloudflare.com/r2/api/s3/api/` | Exact R2 S3 features/checksum matrix; demonstrates compatibility differences. citeturn26search4 |
| R2 S3 extensions | Cloudflare, updated Jun. 8, 2026 | `https://developers.cloudflare.com/r2/api/s3/extensions/` | Beta destination-conditional CopyObject and non-atomic relationship to source conditions. citeturn26search3 |
| R2 presigned URLs | Cloudflare, updated Aug. 22, 2026 | `https://developers.cloudflare.com/r2/api/s3/presigned-urls/` | Scoped expiring S3-signed access and reusable URL behavior. citeturn26search7 |
| R2 CORS | Cloudflare, updated Jul. 31, 2026 | `https://developers.cloudflare.com/r2/buckets/cors/` | Browser presigned-upload CORS requirements. citeturn26search5 |
| R2 Cache API example | Cloudflare, updated Apr. 21, 2026 | `https://developers.cloudflare.com/r2/examples/cache-api/` | R2→Workers Cache API mechanics; does not solve authorization. citeturn26search9 |
| Cloudflare D1 pricing | Cloudflare, updated Apr. 21, 2026 | `https://developers.cloudflare.com/d1/platform/pricing/` | Free row-read/write and storage allowances. citeturn9view0 |
| Cloudflare D1 limits | Cloudflare, updated Apr. 21, 2026 | `https://developers.cloudflare.com/d1/platform/limits/` | Query/invocation, DB size and execution constraints. citeturn9view1 |
| Cloudflare Workers limits | Cloudflare, 2026 docs | `https://developers.cloudflare.com/workers/platform/limits/` | CPU, memory, body, subrequest, static asset and Cron constraints. citeturn10view0turn10view1 |
| Cloudflare Workers/R2 pricing | Cloudflare, updated Aug. 28, 2026 | `https://developers.cloudflare.com/workers/platform/pricing/` | Current developer-platform/R2 allowance context. citeturn10view7 |
| Cloudflare Artifacts docs | Cloudflare, updated May 2026 | `https://developers.cloudflare.com/artifacts/` | Separate Git-oriented closed-beta product. Not browser artifacts or R2. citeturn12search26 |
| Cloudflare Artifacts pricing | Cloudflare, Apr. 2026 docs | `https://developers.cloudflare.com/artifacts/platform/pricing/` | Paid-plan operation/storage model; closed-beta context. citeturn13view0 |
| GCS resumable uploads | Google Cloud | `https://cloud.google.com/storage/docs/resumable-uploads` | Session resumability/completion semantics; does not provide app SHA-256 by itself. citeturn0search6 |
| GCS object API/preconditions | Google Cloud, July 2026 ref | `https://cloud.google.com/storage/docs/request-preconditions` | Generation matching/create-only model. citeturn0search4turn0search9 |
| SQLite pragmas/data version | SQLite project, current 3.53.x docs | `https://sqlite.org/pragma.html#pragma_data_version` | `data_version` change indication. Not a durable distributed event log. citeturn4search1 |
| PostgreSQL SELECT locking | PostgreSQL Global Development Group, PostgreSQL 18 | `https://www.postgresql.org/docs/current/sql-select.html` | `SKIP LOCKED` semantics and queue-like use limitation. citeturn6search0 |
| MCP 2026-07-28 documentation | Model Context Protocol / LF Projects | `https://modelcontextprotocol.io/docs/2026-07-28/getting-started/intro` | Current protocol generation and architecture. citeturn27view3turn24search3 |
| MCP 2026-07-28 release | MCP maintainers, Jul. 28, 2026 | `https://blog.modelcontextprotocol.io/` | Stateless protocol-core release context. Blog should not replace normative spec for conformance. citeturn24search3 |
| MCP TypeScript SDK | MCP maintainers | `https://github.com/modelcontextprotocol/typescript-sdk` | SDK v2 implementation/migration behavior. Exact application package version remains local evidence. citeturn14search7turn14search9 |
| WorkOS pricing | WorkOS, checked Sep. 17, 2026 | `https://workos.com/pricing` | AuthKit MAU, SSO, Directory Sync, Audit, custom-domain pricing and staging distinction. Contract overrides list prices. citeturn17view0 |
| WorkOS AuthKit for MCP | WorkOS | `https://workos.com/docs/authkit/mcp` | OAuth/MCP integration, resource indicators and standalone option. Pricing not fully stated here. citeturn19search1 |
| WorkOS MCP server/client examples | WorkOS | `https://workos.com/docs/mcp` | Vendor-documented compatibility with multiple current clients. Qualifies WorkOS's server, not this application. citeturn15search1 |
| Pulumi pricing | Pulumi Corp., checked Sep. 17, 2026 | `https://www.pulumi.com/pricing/` | Free/Essentials/Pro plan boundaries, workflow minutes, ESC units, hosted features. citeturn23view0 |
| Pulumi Automation API | Pulumi Corp. | `https://www.pulumi.com/docs/iac/concepts/automation-api/` | Automation API is open-source IaC functionality and drives the engine/CLI. citeturn21search1 |
| Pulumi Cloud vs OSS | Pulumi Corp. | `https://www.pulumi.com/docs/iac/guides/basics/pulumi-cloud-vs-oss/` | DIY backends versus managed Cloud feature boundaries. citeturn21search2 |
| Pulumi state/backends | Pulumi Corp. | `https://www.pulumi.com/docs/iac/concepts/state-and-backends/` | DIY state, managed state, refresh/drift distinctions. citeturn21search5 |
| Node.js documentation/home | OpenJS Foundation / Node.js, Sep. 2026 | `https://nodejs.org/` | Current/LTS releases and built-in hash/stream/worker capabilities. Homepage examples do not establish application bottlenecks. citeturn25search3 |
| Effect documentation | Effectful Technologies, Effect 4.0 RC at check date | `https://effect.website/` | Structured concurrency, tracing/interruption and current RC status. Does not prove local runtime-boundary behavior. citeturn27view2 |
| Playwright | Microsoft / Playwright, checked Sep. 17, 2026 | `https://playwright.dev/` | Chromium/Firefox/WebKit, browser contexts, auto-wait, trace/network/console capabilities. Exact bundled browser revisions must be recorded locally. citeturn27view0 |
| Claude Code MCP | Anthropic, current 2026 docs | `https://docs.anthropic.com/en/docs/claude-code/mcp` | Claude Code MCP and external-event/channel capabilities. Live host behavior still needs qualification. citeturn25search0 |
| Claude Help Center / Claude Design | Anthropic, checked Sep. 17, 2026 | `https://support.claude.com/en/` | Public existence of Claude Design, Design System docs and other artifact/project surfaces. Does not establish an undocumented export schema as a stable API. citeturn25search4turn27view1 |

**Final engineering disposition:** preserve the existing architecture and strengthen the places where its abstractions already expose the right seam. The immediate implementation case is strongest for batched Postgres manifest writes, create-only blob installation, retry reconciliation, project revisions, Git artifact-level fencing, chunked Cloudflare preparation and durable browser-test evidence. Signed uploads, provider-side promotion, small-file transfer batches, durable feeds and alternative runtimes should remain **measured optimizations**, not architectural assumptions. Shared-CDN caching of current-only public content, Git as authority, bidirectional synchronization, hidden IaC orchestration, application-origin annotation bridges into untrusted previews and an unprofiled native rewrite are inconsistent with either the stated invariants or the available evidence.