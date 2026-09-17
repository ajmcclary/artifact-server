# Research reconciliation with Artifact Server

This integration checks the supplied dossier against code commit
`572e28f4beef971b94c9864408f5c067ad499ba1` and selected primary documentation on
September 17, 2026. It distinguishes existing behavior, implementation work,
experiments, policy decisions, and corrections. The [source manifest](./source-manifest.json)
preserves originals; [NEXT-STEPS.md](../../../NEXT-STEPS.md) assigns work.

## Present implementation and disposition

| Area | Repository evidence | Disposition |
| --- | --- | --- |
| Runtime and MCP | [package.json](../../../package.json): Effect `4.0.0-rc.110`, MCP client/server `2.0.0`, Playwright `1.62.1`; Node requires `>=24.12.0`. [MCP adapter](../../../src/mcp/create-mcp-http-adapter.ts) already uses stateless compatibility and zero subscriptions. | No Effect 3 migration or new stateless-MCP implementation is needed. Record exact resolved/wire versions in qualification, T01/T15. The research's latest-version statements do not authorize upgrades. |
| Staged upload | [file client](../../../src/client/file-publication-client.ts), [staged service](../../../src/application/staged-upload.ts), [HTTP routes](../../../src/http/create-http-app.ts). | Same-origin scoped binary PUTs exist; provider-native signed URLs and file-level resume do not. T05/T11. |
| Earlier upload fix | [Postgres repository](../../../src/storage/postgres-artifact-repository.ts), `createStagedUpload` and `findStagedUploadFileSlot`. | Plan rows are already batched and PUT reads one slot. Do not redo the old whole-manifest-per-PUT repair. |
| Final commit SQL | Same repository, `#insertVersion`. | Still inserts each manifest entry separately in the transaction. T04 measures and batches this; it cannot directly accelerate SQLite `perf:baseline`. |
| Immutable installation | [S3](../../../src/storage/s3-object-storage.ts), [GCS](../../../src/storage/gcs-object-storage.ts), [R2](../../../deploy/cloudflare/src/r2-object-storage.ts). | S3/GCS lack destination create-only conditions; R2 already has one. T02 preserves SHA/size checks and adds race proof. Existing bad-declaration tests preserve bytes; this is not a demonstrated corruption exploit. |
| Git reconciliation | Postgres/SQLite `storeProjectGitHistorySetting` and `claimGitHistoryJob`; [D1 repository](../../../deploy/cloudflare/src/d1-artifact-repository.ts); [mirror](../../../src/git-history/git-history-mirror.ts). | Foreground enablement is unbounded; equal-time jobs sort by ID, not version. Prior local probe confirms incorrect order. T03 repairs this before extending providers. |
| Review convergence | [comment poll](../../../apps/web/src/components/comments/comment-poll.ts), [comment UI](../../../apps/web/src/review/review-comments.tsx). | Seven-second visible polling merges records and cannot reliably remove filtered/deleted records. T06 adds revision plus authoritative reconciliation before considering T22 feeds. |
| Delivery | [HTTP app](../../../src/http/create-http-app.ts), [range parser](../../../src/http/byte-range.ts), [compression](../../../src/http/node-response-compression.ts). | Ranges, ETags, streaming, and control/UI compression exist. Retain private no-store and public revalidation. T21 qualifies representation/authorization behavior. |
| Cleanup | [cleanup service](../../../src/application/expired-staging-cleanup.ts). | Only expired uncommitted staging is selected; per-upload file work is not bounded. T10 bounds work; successful staging reclamation needs replay independence and an explicit contract change. |
| Cloudflare | [Worker](../../../deploy/cloudflare/src/worker.ts), [stack](../../../deploy/cloudflare/src/stack.ts). | D1/R2, assets and Cron already exist. T08 qualifies actual plan limits before T09 designs chunked preparation. No claim of a free many-file envelope. |
| Identity | [WorkOS adapter](../../../src/identity/workos-identity-provider.ts), [bearer verifier](../../../src/identity/workos-mcp-bearer-verifier.ts), [OIDC verifier](../../../src/identity/oidc-mcp-bearer-verifier.ts). | WorkOS/OIDC and exact-resource MCP verification exist. T16 covers account entitlements and client/replica lifecycle gaps, without changing membership. |
| Browser evidence | [scripts](../../../package.json), [writer](../../../scripts/write-browser-evidence.ts), [config](../../../playwright.config.ts), [CI](../../../.github/workflows/ci.yml). | Normalization runs only after browser success, default engine is Chromium, and full-gate upload lacks a failure override. T07 repairs evidence lifecycle and adds a critical engine matrix. |
| Design exports | [generator](../../../src/manifest/claude-design.ts), [guide](../../../docs/claude-design.md). | Detection, grouped catalog, entry precedence, original bytes, and bounded viewports already exist. T19 improves navigation and qualification, not a new export importer from scratch. |
| Effect runtime | [database runtime](../../../src/storage/postgres-database.ts), [external composition](../../../src/external-storage/create-external-storage-runtime.ts). | Separate SQL/application runtimes remain. T18 first measures cancellation and trace continuity; do not promise a speedup. |
| Linked files | [local source engine](../../../src/local/linked-source-engine.ts), [linked policy](../../../src/application/linked-artifacts.ts), LNK ledger proof gaps. | Keep local-only roots and in-sync/implicit-capture semantics. T27 closes genuine mid-read drift, concurrency and remote-capability absence proof. |

## Corrections and qualifications

1. **S3 conditional copy is documented.** The dossier's U-PUB-04 evidence gap is
   partly closed by AWS's [October 29, 2025 announcement](https://aws.amazon.com/about-aws/whats-new/2025/10/amazon-s3-conditional-write-functionality-copy-operations/):
   CopyObject supports destination conditions. This does not prove our pinned
   SDK path, source sealing, mismatch handling, or provider races. T12 remains
   an adapter qualification experiment, not an enabled optimization.
2. **R2 copy is not the portable promotion contract.** Its
   [extensions documentation](https://developers.cloudflare.com/r2/api/s3/extensions/)
   marks destination copy conditions beta and explains that source and destination
   checks occur at different times. Keep conditional verified writes as the
   baseline; do not infer corruption or a safe sealed-source protocol solely
   from that timing note. T12 must prove the full operation.
3. **R2 deletes are not Class A billing.** The dossier's generic cost formula
   includes deletes among Class A work. [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
   lists DeleteObject, DeleteBucket and AbortMultipartUpload as free operations.
   They still consume operational time and may affect invocation limits. T08
   must separate billed operations from executed operations.
4. **Current Pulumi names agree with the dossier.** The freshly inspected
   [pricing page](https://www.pulumi.com/pricing/) uses Free, Essentials, Pro,
   Enterprise; the earlier local review's Individual/Team/Enterprise labels
   are not the current plan names. Free lists one user, 25 secrets, 10K monthly
   relevant secret API calls and 500 workflow minutes. T20 uses current account
   entitlement and OSS/DIY options; no paid plan is authorized by this import.
5. **Bridge refusal is not automatically retried.** The dossier's generic
   exception/retry and delivery-dedup suggestions cannot replace
   [citizenship rules](../../../docs/agent-bridge-protocol.md#citizenship-rules).
   Asynchronous host refusal fails the dispatch; invalidated synchronous host
   handles stop the loop; uncertain acknowledgement relies on lease recovery.
   Do not suppress a redelivery using an unproved local dedup record. T17
   preserves DSP-011–013 and the actual dispatch states.
6. **Git fairness cannot overtake a predecessor.** Schedule fairly across
   artifacts; never let a newer version of the same artifact pass its missing,
   failed, or retry-delayed predecessor. DB fencing alone cannot prevent a stale
   holder from issuing a remote Git write. T03 needs remote ref/predecessor
   comparison and stale-worker tests as well as durable local ownership.
7. **Revision/refetch needs snapshot proof.** A counter alone does not prove
   convergence across multi-page reads. T06 must read a coherent revision and
   snapshot, or check revision before/after and retry within bounds. Installation
   membership changes need installation-level authorization invalidation; do
   not fan out every deactivation into project revisions as the sole auth bound.
8. **Successful replay and negative outcomes differ.** Preserve existing
   successful idempotent results. The dossier additionally proposes permanently
   replaying a stale-current conflict and replaying results forever. Those are
   unadopted retention/negative-result policies. T05 must define semantics before
   schema changes; a new operation still needs a fresh explicit expected version.
9. **Blob preparation does not make manifest cardinality disappear.** A final
   D1 transaction still has to atomically expose a complete manifest/version,
   action, idempotency result and pointer. T09 must measure D1 query, parameter,
   statement-size and execution limits, and propose any preparatory manifest
   representation explicitly. Do not split a visible manifest across commits.
10. **Cache policy is already partly decided.** Private raw content and preview
    leases use no-store; public raw content requires revalidation. No blind
    edge-cache hit may bypass currentness/authorization. The dossier's broad ban
    on any shared caching is stricter than AUTH-016's possible current-public
    caching; this import enables neither. Retain current policy until T21 proves
    an allowed design. A server cannot erase a downloaded copy or reliably
    prohibit hostile artifact JavaScript from retaining bytes already received.
11. **Global GC is not an implementation task yet.** The dossier describes
    candidate mark/sweep designs. PUB-009 and OPS-006/007 still prohibit automatic
    committed/race-left blob reclamation until backup-aware concurrency/recovery
    proof exists. T10 addresses uncommitted work first; T25 remains gated design.
12. **Research labels do not qualify deployments.** “Free/light installation,”
    latest runtime versions, provider examples, and client compatibility against
    a vendor's own MCP service do not prove this installation or adapter. Existing
    Pi/OpenCode live observations must be read alongside exact host versions and
    scope in the [staging report](../STAGING-E2E-REPORT-2026-08-27.md). Do not erase
    existing evidence because the external researcher lacked the repo; omp and
    remaining hostile-host cases still require live qualification.

## All research uncertainties mapped to work

Statuses here describe the integration decision, not implementation completion.

| Source ID | Repository disposition | Next task |
| --- | --- | --- |
| U-PUB-01 | Final insertion loop confirmed; ≥10% gain unmeasured. | T01, T04 |
| U-PUB-02 | Batching is an experiment after retry groundwork. | T13 |
| U-PUB-03 | Native signed transfer is absent; choose threshold from measurements. | T11 |
| U-PUB-04 | AWS documentation gap closed; sealed-source adapter proof remains open. | T12 |
| U-PUB-05 | R2 beta/timing limitations confirmed; no baseline dependency. | T12 |
| U-PUB-06 | GCS promotion is a candidate, not verified repo behavior. | T02, T12 |
| U-PUB-07 | Whole-file SHA-256 remains authoritative; qualify modes separately. | T02, T11, T12 |
| U-PUB-08 | Mutable staging aliases rule out naive link promotion. | T12 |
| U-PUB-09 | Keep current retention until replay is independent and policy specified. | T05, T10, T24 |
| U-PUB-10 | No automatic committed/race-left blob GC. | T25 |
| U-HTTP-01 | Multi-range support deferred absent a real client requirement. | T21 |
| U-HTTP-02 | Keep authorization before bytes; no blanket immutable public cache. | T21, T24 |
| U-HTTP-03 | Current private no-store remains; broader offline policy deferred. | T21, T24 |
| U-SYNC-01 | Revision plus authoritative reconciliation is the first candidate. | T06 |
| U-SYNC-02 | Measure hottest-project lock and write costs. | T01, T06 |
| U-SYNC-03 | Device-local drafts remain; cross-device product choice deferred. | T24 |
| U-GIT-01 | Job-row locking is insufficient proof; artifact/remote race tests needed. | T03 |
| U-GIT-02 | Full memory clone observed; history-growth profile missing. | T18, T23 |
| U-GIT-03 | Preserve strict order and non-authoritative primary behavior; new blocked state requires spec. | T03, T24 |
| U-MCP-01 | Package versions known; record negotiated client versions in qualification. | T15, T16 |
| U-MCP-02 | Preserve existing Pi evidence; omp and remaining host cases open. | T17 |
| U-MCP-03 | Fresh per-request server exists; CPU attribution missing. | T01, T15 |
| U-ID-01 | Account-specific production MCP entitlement not established. | T16 |
| U-ID-02 | Application audit remains authority; provider retention is not assumed free. | T16, T24 |
| U-CF-01 | Workload/account/plan qualification required. | T08 |
| U-CF-02 | Current per-file work is not a qualified free many-file envelope. | T08, T09 |
| U-CF-03 | Optional existing provider retained; no mandatory/new paid dependency. | T08, T23 |
| U-PUL-01 | No paid drift/TTL baseline; OSS preview and local fixtures first. | T20 |
| U-RUNTIME-01 | Multiple runtime boundary confirmed; interruption/trace proof pending. | T18 |
| U-RUNTIME-02 | No native helper decision without profile and end-to-end result. | T18, T26 |
| U-BROW-01 | Chromium default confirmed; support policy/matrix expansion open. | T07, T24 |
| U-DESIGN-01 | Observed export conventions supported; no promised vendor schema. | T19 |
| U-DESIGN-02 | Moving view is current-safe default; frozen collection is a new feature. | T19, T24 |

## Evidence needed before promotion

Use the dossier's benchmark and failure-injection sections as input to T01–T27,
not as executed results. Keep file-count experiments bounded and separate from
the canonical gate: the current external harness caps directory files at 128;
1,000/3,301-file experiments need a dedicated opt-in harness, explicit byte/time
limits, and synthetic input. Never raise ordinary gate caps merely to fit a
research fixture. Three file-client samples describe three observations, not a
reliable tail percentile. Re-run equivalent workloads on the same runtime,
machine, provider, durability, cache state and fixture digest before attributing
a speedup. Hash/source matches prove import fidelity, not citation accuracy,
performance improvement, or release conformance.
