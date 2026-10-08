# Bounded, resumable publication preparation

Design record for T09 slice 1 (`docs/archive/planning-2026-10-08/NEXT-STEPS.md`, September 2026). Specifies how
a bounded runtime — the Cloudflare Worker being the forcing case — verifies and
installs a publication's files across multiple resumable passes while keeping
final publication visibility atomic and singular. Specified as PUB-019 and
PUB-020 in `project/spec/conformance.yml`.

## Problem

A commit request today verifies and installs every staged file inside the
commit invocation (`storeFiles` in `src/application/publish-artifact.ts`), then
writes the version, manifest, action, idempotency record, current pointer and
staged-upload seal in one atomic transaction. On a Cloudflare Worker this does
not scale: Workers Free allows 50 subrequests and 10 ms CPU per invocation, D1
allows 50 queries per invocation on Free, and R2 costs roughly 2 Class A + 1
Class B operations per file per publication (see
`project/performance/CLOUDFLARE-COST-ENVELOPE.md`). A publication of more than
a small number of files cannot finish installation inside one bounded
invocation.

## Design

### D1 — Preparation is product behavior

Preparation is an application service behind narrow ports, implemented
identically on SQLite, Postgres and D1. Node runtimes use a high
per-invocation budget and complete preparation inside one commit request, so
existing single-request behavior is unchanged. The Worker uses a small budget
sized to the Free-plan envelope with headroom.

### D2 — Durable state extends the staged upload

The staged upload already binds installation, project, principal, idempotency
key and manifest digest (PUB-015). Preparation adds columns rather than a new
entity graph:

- `staged_uploads`: `preparation_state` (`none | claimed | prepared`),
  `preparation_attempts` (fencing counter), `preparation_lease_expires_at`,
  `prepared_at`, and `cleanup_claimed_at` (nullable) — the durable
  expired-staging cleanup claim that preparation claims exclude.
- `staged_upload_files`: `installed_at` (nullable) — durable per-file
  installation progress.

### D3 — Bounded passes under a fenced claim

Each preparation pass:

1. Claims the preparation with the same fencing shape as the git-history
   mirror worker: conditional update on `(state, attempts)`, 45-second lease,
   15-second renewal, stale owners fail with lease-lost and can neither record
   progress nor finalize.
2. Installs up to the per-invocation budget of uninstalled files: re-verify the
   staged source's size and SHA-256 through the stream verifier, or use the
   adapter's sealed `promote` where proven (PUB-018), falling back to the
   verified stream on any promotion failure. A staged source replaced after
   staging fails closed at re-verification; no progress is recorded for it.
3. Records `installed_at` per file durably before the pass ends, and refreshes
   the upload's `expires_at` (bounded renewal by the owning principal) so
   expired-staging cleanup never races an active preparation. Cleanup
   additionally stamps a durable `cleanup_claimed_at` on an expired upload
   before removing any staging object, and preparation claims refuse
   cleanup-claimed uploads in every store, so even a claim racing the removal
   window cannot be left with rows whose bytes are gone.

Early blob installation is safe: blobs are content-addressed, create-only and
immutable, nothing becomes visible before the final transaction, and orphaned
blobs are intentionally retained (OPS-006).

### D4 — Commit drives preparation; incomplete preparation is explicit

`POST /api/v1/uploads/:uploadId/commit` runs preparation passes until the
manifest is fully installed or the runtime's per-invocation budget is
exhausted. If incomplete, the commit returns `202` with
`status: "preparing"` and progress counts; no version state is visible. The
file client and MCP surface retry the commit with the same idempotency key
until it commits — transparent resume under one operation identity. When
preparation is complete the existing final transaction runs unchanged in
content, with an added all-files-installed assertion alongside the existing
source-ready check. Concurrent finalization of one operation still produces
exactly one version: the conditional staged-upload seal and idempotency insert
fence the loser into a `status: "committed", replayed: true` replay.

### D5 — D1 final-batch qualification decides the manifest representation

Moving blob work earlier does not shrink the final batch's chunked manifest
inserts (100 bound parameters per statement; 16 manifest rows per statement).
Before the D1 implementation is chosen, a bounded local Wrangler-D1 probe
measures the maximum statements per `database.batch` and total transaction
size/time at the 1,000-file scale. If the final batch cannot hold the
qualified workload's manifest, preparation additionally writes an invisible
`prepared_manifest_entries` table (keyed by upload id, never read by any
serving path) and the final batch adds one bounded
`INSERT INTO manifest_entries SELECT ...` plus a delete of the prepared rows.
Read paths stay untouched either way.

Probe outcome (2026-09-26, local Wrangler-D1, `deploy/cloudflare/tests/d1-final-batch-limits.test.ts`, `ARTIFACT_SERVER_D1_FINAL_BATCH_LIMITS=1`):

| Files | Simulated final-batch statements | Chunked manifest statements | Chunked final-batch wall time | Prepared-manifest wall time |
| --- | --- | --- | --- | --- |
| 40 | 10 | 3 | 4.04 ms | 2.48 ms |
| 1,000 | 70 | 63 | 21.58 ms | 7.71 ms |
| 3,301 | 214 | 207 | 47.15 ms | 27.07 ms |
| 10,000 | 632 | 625 | 161.11 ms | 61.40 ms |

The simulated final batch includes the version insert, current-pointer update, action, idempotency, staged-upload seal, mirror job, and mutation-check guard pair, so its statement count is the manifest chunk count plus the constant overhead. The local binding accepted every tested size up to the product's 10,000-file cap: no batch statement ceiling or transaction failure was observed. The local binding also did not enforce the documented Workers per-invocation query limit (50 Free / 1,000 Paid); a batch of 5,000 trivial statements succeeded locally. Live Workers will count each batch statement against that per-invocation limit.

**Recommendation:** Use the invisible `prepared_manifest_entries` representation (option b). Local batch capacity is sufficient for the chunked final batch, but the simulated final batch already exceeds the Workers Free 50-query limit at 1,000 files (~70 statements) and consumes most of the Paid 1,000-query budget at 10,000 files (~632 statements). The prepared-manifest path keeps the final batch near 10 statements regardless of file count and is faster, so it is the safer Cloudflare Worker design. Read paths remain unchanged either way.

**Implementation notes (2026-09-27).** Postgres and D1 commit their manifest entries by `INSERT INTO manifest_entries SELECT ... FROM prepared_manifest_entries` inside the final transaction and delete the prepared rows there; SQLite keeps literal in-memory inserts (no per-invocation query limit applies). Each preparation pass writes only the missing manifest-order prefix slice, bounded by `preparedEntriesPerPass`; stores insert idempotently, so duplicate slices are harmless and a partial write is durable progress (the manifest is immutable per upload). SQLite wraps the ownership check and slice insert in its existing transaction; Postgres wraps them in `sql.withTransaction`; D1 sends one atomic `database.batch` containing a `mutation_checks` guard pair that asserts the upload is open and claimed by this attempt, followed by `INSERT OR IGNORE` chunk statements. A crashed or stale owner cannot delete or overwrite a successor's rows. Finalization is guarded three ways inside the commit: the source-ready assertion requires every file installed and `preparation_state = 'prepared'` (Postgres and D1; SQLite installs inline), the Postgres commit re-counts inserted manifest rows against the manifest and rolls back on mismatch, and the D1 batch carries a `mutation_checks` guard row whose `CHECK (succeeded = 1)` fails the whole batch unless the inserted manifest count equals the manifest exactly — a version with a partial manifest is structurally impossible.

## Failure model and proofs

| Hazard | Rule |
| --- | --- |
| Interruption mid-pass | Per-file progress is durable; a later attempt skips installed files. |
| Process restart | The claim is a database row; any process with the operation key resumes. |
| Stalled owner | Lease expiry makes the preparation reclaimable; the stale owner's fenced writes fail. |
| Concurrent finalize | Conditional seal + idempotency insert: one version, the loser replays. |
| Blob-store outage | The pass fails before progress is recorded for unfinished files; no version exists; retry resumes. |
| Source replacement | Re-verification at install fails closed; no version, no progress for the replaced file. |
| Lost commit response | Idempotent replay returns the committed publication without staging access. |
| Cleanup race | Active preparations refresh upload expiry; cleanup only selects expired uploads (T10 bounds this further). |

## Budgets

- Per-invocation file budget is configuration, sized per runtime: high on Node
  (single-request behavior preserved), small on the Worker. The Worker sets
  `filesPerPass: 5` (`deploy/cloudflare/src/worker.ts:149`): each file
  installation costs roughly 2 R2 operations and 1 D1 query, and the
  prepared-manifest final batch is ~10 statements, so one commit invocation
  stays well inside the Workers Free 50-subrequest / 50-D1-query envelope with
  headroom; multi-pass commits resume through the client's idempotent retry.
- No new orchestrator: coordination reuses store row leases, the existing
  scheduled handler, and client-driven idempotent retry.

## Out of scope

- T10 bounded cleanup (files/operations/time bounds, durable continuation,
  active-prepare protection beyond the expiry-refresh hook).
- Successful-staging reclamation (PUB-009/OPS-006 amendment) — T10/T24.
- Signed/resumable large-file transfers (T11); batch transport adoption (T13,
  unadopted).
