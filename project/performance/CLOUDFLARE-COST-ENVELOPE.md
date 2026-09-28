# Cloudflare cost envelope (T08)

Status September 26, 2026 — account plan, lifecycle and runtime probes bounded;
isolated API RTT and the cheap deterministic D1 limits measured live; the
remaining production-usage facts are disclosed-unknown because the account has
no production workload. Official pricing and limits are current as of 2026-09-22
and taken from Cloudflare's own pages. The R2 allowance and overage values were
also confirmed in the account dashboard on 2026-09-23. Local workload facts are
measured on this machine (Apple M1 Max, darwin arm64, Node 24.15.0, commit
`867fb70`). The approved account is Workers Free with R2 activated.

## Completed workload worksheet

| Fact | Measured or pinned value | How recorded |
| --- | --- | --- |
| Provider account / plan | Workers Free; R2 active at $0/month base | dashboard observation, 2026-09-23 |
| Region(s) | Workers global; D1/R2 placement not separately inspected | live probe did not isolate placement |
| Measured RTT to provider API (ms) | isolated 2026-09-26, 50 samples per leg, this machine, Node 24.15.0: Cloudflare REST API p50 203.7 / p95 265.2; D1 query API p50 84.5 / p95 102.6; R2 S3 ListObjectsV2 p50 90.3 / p95 117.4 | `project/evidence/cloudflare-api-rtt.json` |
| Proxy / CDN / tunnel topology | local loopback only | local baseline harness |
| Publication size distribution (bytes) | 40 × 16 KiB publications; file-client 48 × 4 KiB directory + one 2 MiB file | `project/evidence/local-performance-baseline.json` |
| Files per publication distribution | 1-file and 48-file fixtures measured; 3,301-version Git backlog probed on local D1 | local baselines + `project/evidence/git-history-d1-backlog.json` |
| Retained bytes (total / per project) | 15,540,592 bytes across 291 files in the bounded local baseline; on the live account 0 bytes (0 D1 databases, one R2 bucket with 0 objects) as of 2026-09-26 | `project/evidence/local-performance-baseline.json` `storage`; `project/evidence/cloudflare-api-rtt.json` `inventory` |
| Backup count and frequency | disclosed-unknown — the account is probe-only with no production workload or backup schedule; recorded per the T24 default ("use synthetic/local fixtures and disclose unknown production capacity/cost", NEXT-STEPS.md) | operator/account state, 2026-09-26 |
| Visible review hours per day | disclosed-unknown — no production workload exists on the account; recorded per the T24 default | operator/account state, 2026-09-26 |
| Mutation rate (publications / hour) | disclosed-unknown — no production workload exists on the account; recorded per the T24 default | operator/account state, 2026-09-26 |
| Concurrent client count | measured synthetic 1/10/25/50/100 users | `project/evidence/local-capacity-baseline.json` |
| Durability setting (replicas, sync) | provider-managed; no size control in the current stack | `deploy/cloudflare/FINDINGS.md` |
| Database pool size | n/a — D1 is not connection-pooled; 6 simultaneous D1 connections per Worker invocation | D1 limits, see below |
| Fixture identity (hash / command) | `pnpm perf:baseline`, `pnpm perf:capacity` defaults | evidence `configuration` blocks |
| Warm vs cold state | 3 warmup publications, then measured | baseline `configuration.warmupPublications` |

## Official limits and pricing, dated 2026-09-22

All values below are from Cloudflare's official pages, fetched 2026-09-22. The
cloudflare.com plans/pricing pages do not list developer-product units; the
developers.cloudflare.com pages are authoritative here.

### Workers

- Free: 100,000 requests/day, then hard fail with Error 1027 (fail mode is
  configurable); 10 ms CPU per invocation; 50 subrequests per invocation.
- Paid: $5/month minimum per account, including 10 million requests/month and
  30 million CPU-ms/month; overage $0.30 per million requests and $0.02 per
  million CPU-ms. Default 30 s CPU per invocation, configurable to 5 min;
  default 10,000 subrequests, configurable to 10,000,000.
- Six simultaneous outgoing connections per request on both plans; extras queue.
- Request body size is a Cloudflare site-plan limit, not a Workers-plan limit:
  Free/Pro 100 MB, Business 200 MB, Enterprise up to 5 GB self-serve.
- No enforced response body limit; no egress charge.

Sources: https://developers.cloudflare.com/workers/platform/pricing/,
https://developers.cloudflare.com/workers/platform/limits/

### D1

- Free: 5 million rows read/day, 100,000 rows written/day, 5 GB total storage,
  10 databases, 500 MB max per database; all hard-fail at their caps.
- Paid: 25 billion rows read/month then $0.001 per million; 50 million rows
  written/month then $1.00 per million; 5 GB storage included then $0.75/GB-month;
  50,000 databases, 10 GB max per database, 1 TB max account storage.
- Both plans: 100 bound parameters per statement, 100,000-byte statement limit,
  2 MB max row, 30-second query limit, 50 (Free) / 1,000 (Paid) queries per
  Worker invocation, 6 simultaneous D1 connections per invocation.
- No published numeric max-rows-per-query cap; the limits page only warns that
  "hundreds of thousands of rows" in one query can exceed execution limits.
- Egress free.

Sources: https://developers.cloudflare.com/d1/platform/pricing/,
https://developers.cloudflare.com/d1/platform/limits/

#### Measured local D1 batch behavior (2026-09-26)

A bounded local Wrangler-D1 probe (`deploy/cloudflare/tests/d1-final-batch-limits.test.ts`, `ARTIFACT_SERVER_D1_FINAL_BATCH_LIMITS=1`) found no `database.batch()` statement ceiling up to at least 632 statements carrying 10,000 manifest rows. Wall times on this machine were roughly 170 ms for a 632-statement final-commit batch and 68 ms for the equivalent two-statement `INSERT ... SELECT` plus `DELETE` prepared-manifest path. The local binding did not enforce the documented Workers per-invocation query limit; a batch of 5,000 trivial statements succeeded locally. These are binding-only measurements and do not establish live Worker CPU or plan enforcement.

### R2

- Free tier: 10 GB-month storage, 1 million Class A operations/month, 10 million
  Class B operations/month.
- Standard: $0.015/GB-month, $4.50 per million Class A, $0.36 per million
  Class B. Infrequent Access: $0.01/GB-month, $9.00/million Class A,
  $0.90/million Class B, $0.01/GB retrieval, 30-day minimum storage duration.
- Egress to the Internet is free for both classes.
- DeleteObject, DeleteBucket, and AbortMultipartUpload are explicitly free.
- Limits: 5 TiB max object; 5 GiB single-part upload; multipart up to 10,000
  parts and 4.995 TiB.
- No published hard monthly cap; usage past the free tier is billed per unit.

Sources: https://developers.cloudflare.com/r2/pricing/,
https://developers.cloudflare.com/r2/platform/limits/

## Request and operation model

### Review polling, with duration stated

The Review client polls on a 7,000 ms interval, only while the tab is visible;
a hidden tab polls nothing and re-asks once on return
(`apps/web/src/components/comments/comment-poll.ts`). Up to four loops share
that interval per tab: the agents list (on whenever a project is selected),
the comments list (on whenever an artifact and version are selected,
revision-short-circuited since T06), the sent list (only in the sent view),
and linked-file details (local deployments only). A typical reading tab
therefore costs one loop — about 514 requests/hour — and a tab with an
artifact open for review about two loops, ~1,029 requests/hour.

Eight visible tabs left open for 24 hours at one loop each: 8 × 24 × 514 ≈
98,700 requests/day — under the Free 100,000/day cap by roughly 1 percent, so
one poll retry or a second open surface per tab tips the account into Error
1027 hard failures for the rest of the day. The same eight tabs over an
eight-hour workday: ≈ 32,900 requests/day at one loop, ≈ 65,800 at two loops —
both inside the Free cap. On Workers Paid, 8 tabs × 24 h × 2 loops ≈ 197,500
requests/day ≈ 5.9 million/month, inside the 10 million included.

### Publication path per file

The staged flow (`src/application/staged-upload.ts`,
`deploy/cloudflare/src/r2-object-storage.ts`) costs per file:

- one Worker request and one R2 Class A PutObject at upload;
- one R2 Class B GetObject and one R2 Class A PutObject at commit
  (`storeFiles` in `src/application/publish-artifact.ts` opens staging and
  writes the content-addressed blob at concurrency 4);
- staging removal is a DeleteObject — free to bill, but still Worker CPU and
  execution work to enumerate and delete.

So roughly 2 Class A + 1 Class B per file per publication. The 40-publication
local baseline at 48 files per directory fixture implies about 3,840 Class A
operations per such day — far inside the 1 million/month free tier. D1 writes
per version are one version row, one action row, one idempotency row, the
current-pointer update, and one manifest row per file; the D1 repository
chunks manifest inserts so no statement exceeds the 100 bound-parameter limit
(`deploy/cloudflare/src/d1-artifact-repository.ts`).

### Staging growth

Uncommitted staging bytes accumulate in R2 until commit or the expired-staging
cleanup runs; they bill at $0.015/GB-month for as long as they persist. The
product path never uses multipart uploads today, so the 5 GiB single-part
upload cap is the operative ceiling for a single staged object on Cloudflare.
Abandoned multipart aborts are free-billed operations where they do occur.

## Supported envelope and rejected assumptions

- A light team's real review workload (a few reviewers, an eight-hour workday
  of visible tabs) fits Workers Free with headroom; sustained 24-hour
  multi-tab review does not and requires Workers Paid at the $5/month minimum.
- On Workers Paid, the measured synthetic envelope (100 concurrent browse
  users locally at 77.5 journeys/second p95 2,704 ms) is a Node/SQLite
  same-machine result, not a Workers result. Local D1 execution — including
  the 3,301-version Git-history backlog probe (claim passes ~40–65 ms on
  `git-history-d1-backlog.json`) — does not establish deployed Worker CPU,
  subrequest, or account limits.
- The many-file assumption is rejected on this evidence: a 3,301-file
  publication costs one plan request, 3,301 upload requests, and one commit
  request (~3,303 Worker requests), ~6,600 Class A operations, and ~3,300 D1
  rows per version, and D1's 500 MB (Free) / 10 GB (Paid)
  per-database cap binds total manifest history. Nothing in this report
  qualifies that shape on a live Worker.
- Hard-failure versus overage behavior is now partially observed
  (2026-09-26, `project/evidence/cloudflare-api-rtt.json`): D1 rejects a 101st
  bound parameter (HTTP 400, code 7500, "variable number must be between ?1
  and ?100") and a 100,500-byte statement (HTTP 400, code 7500,
  "statement too long: SQLITE_TOOBIG"), matching the documented 100-parameter
  and 100,000-byte limits. The documented 2 MB row limit did **not** reject a
  2,100,000-byte single-row insert through the D1 REST query API — one
  observation on one date, not a new documented limit. Deliberately
  unobserved: the Workers Free 100,000 requests/day cap (Error 1027) and the
  D1 daily row caps, because hitting them would burn the shared account's
  daily free allowance; R2 has no hard monthly cap, only per-unit billing.

## Live account result and remaining measurements

The approved account lifecycle probe ran on 2026-09-23. It matched the exact
account, created the expected Worker/D1/R2 resources, repeated the deployment
without drift, retained then removed the exact D1/R2 resources, destroyed the
Worker, and left the non-probe inventories unchanged. The durable summary is
`project/evidence/cloudflare-account-probe.json`.

A separate runtime-stage attempt deployed and cleaned the same bounded shape,
but `/health`, `/ready`, the unauthenticated list and upload request all returned
HTTP 503. That attempt does not refresh the older runtime qualification. The
Cloudflare Artifacts qualification also stopped at namespace health with zero
repositories and zero operations.

On 2026-09-26 a bounded, read-mostly measurement run
(`deploy/cloudflare/scripts/measure-api-rtt.mjs`, evidence
`project/evidence/cloudflare-api-rtt.json` and
`deploy/cloudflare/evidence/api-rtt-2026-09-26T18-38-03-542Z.json`) resolved the
remaining measurable account facts: isolated per-call RTT (50 samples per leg
after 3 warm-ups, this machine, Node 24.15.0 — Cloudflare REST API
p50 203.7 / p95 265.2 ms, D1 query API
p50 84.5 / p95 102.6 ms, R2 S3 ListObjectsV2 p50 90.3 / p95 117.4 ms), a
read-only retained-bytes inventory (0 D1 databases, one R2 bucket
`artifact-server-qual-r2-20260925` with 0 objects and 0 bytes), and the cheap
deterministic D1 limits (101st bound parameter and 100,500-byte statement both
rejected as documented; the documented 2 MB row limit did not reject a
2,100,000-byte row — a single honest deviation, recorded). The run created and
deleted one `probe-d1-rtt-20260926` database (deletion verified by re-listing),
performed about 170 API calls and no Worker invocations, and stayed far inside
every free allowance. Backup count/frequency, visible review hours, and
mutation rates have no production source — the account is probe-only — and are
recorded in the worksheet as disclosed-unknown per the T24 default in
NEXT-STEPS.md rather than left as open questions.

On 2026-09-25 two bounded live runs stayed inside this envelope. The R2
sealed-promotion probe (`project/evidence/r2-s3-promotion-probe.json`) ran tens
of Class A/B operations and a few MiB of transient bytes against the dedicated
`artifact-server-qual-r2-20260925` bucket and returned it to zero objects; its
verdict is that R2's S3-compatible `CopyObject` does not enforce the
sealed-promotion preconditions, so the adapter keeps the verified-stream path
and the per-file operation profile above is unchanged. The corrected
runtime-stage account probe
(`deploy/cloudflare/evidence/account-probe-2026-09-25T22-22-35-066Z.json`,
summarized in `project/evidence/cloudflare-runtime.json`) deployed, qualified
(health/ready/auth/upload/commit/replay/list all expected statuses), destroyed,
and cleaned its exact `probe-` resources, refreshing the runtime qualification
with a WorkOS browser-login provider configured; request counts were the
bounded probe set only, far under the Free daily request cap.

## T09 multi-pass probe (run 2026-09-28, passed)

Account snapshot re-confirmed by the operator on 2026-09-28: Workers Free,
R2 active at $0/month base, allowances and overage behavior unchanged from
the dated values above. The operator explicitly authorized this specific
probe shape on 2026-09-28. The run
(`deploy/cloudflare/evidence/account-probe-2026-09-28T14-21-43-151Z.json`,
summarized in `project/evidence/cloudflare-runtime.json`) passed: the
12-file upload produced two live `202 preparing` responses (installed 5,
then 10 of 12) before one atomic `201` commit, the idempotent replay
returned `200` with the same version id, the artifact listed, and all
lifecycle checks (exact resource creation, no-drift repeat deploy, destroy,
probe-resource deletion, unchanged non-probe inventories) passed. The
observed footprint matched the estimate below — about 30 Worker requests
and a few dozen D1 rows and R2 operations over 91 seconds, far inside the
free envelope.

The next proposed live run extends the 2026-09-25 runtime-stage probe with a
multi-pass publication: a 12-file upload against the production
`filesPerPass: 5` budget, expecting at least two `202 preparing` responses
before the atomic `201` commit, an idempotent `200` replay naming the same
version, and the artifact present in the authenticated list. The exact probe
code is validated locally against the real Worker bundle
(`deploy/cloudflare/tests/account-probe-runtime.test.ts`, which drives
`qualifyRuntime` from `deploy/cloudflare/scripts/account-probe.mjs` through
`unstable_dev`).

Estimated footprint of the extended probe, worst case:

- ~30 Worker requests (health polling, readiness, the unauthenticated check,
  one single-file and one 12-file staged upload, three commit attempts, two
  replays, two lists) against the 100,000/day Free cap.
- Well under 100 D1 rows written (two versions, 13 manifest rows, prepared
  entries, idempotency/action rows) against the 100,000 rows/day Free cap.
- Roughly 26 R2 Class A operations (staging puts plus content-addressed blob
  puts) and 13 Class B (commit-time staging reads); staging deletes are
  free-billed. All far inside the 1M Class A / 10M Class B monthly allowance.
- Probe-only `probe-` D1/R2/Worker resources are created and destroyed by the
  probe itself; retained bytes return to zero.

The pre-run requirements (dated dashboard re-confirmation, recorded snapshot,
explicit authorization for this specific probe shape) were met on 2026-09-28
and the run passed, as recorded above. Any future live run needs its own
fresh snapshot and authorization.

## T15 MCP Worker probe (pre-run snapshot, 2026-09-28)

The operator authorized the bounded T15 Worker MCP qualification in this task.
The selected account was checked by matching its SHA-256 account ID hash to the
September 28 runtime evidence (`76a11419…1ac85`, full value in
`project/evidence/cloudflare-runtime.json`). The Cloudflare dashboard's
Subscriptions page shows Workers Free active and R2 Paid active; the latter
has $0 base and usage-based overage. Billable usage for September 23–28 shows
$0.00 cost, 210 R2 Class A operations of the first 1 million included, 79
Class B operations of the first 10 million included, and 0 GB-months of the
first 10 GB-months included. The Workers account home showed 100 Worker
invocations in its last-24-hour tile; this is not a full daily allowance
measurement. [Workers Free limits](https://developers.cloudflare.com/workers/platform/limits/)
remain 100,000 requests/day and 50 subrequests/invocation, with hard failure
at the daily cap. [D1 Free pricing](https://developers.cloudflare.com/d1/platform/pricing/)
remains 5 million rows read/day, 100,000 rows written/day and 5 GB total,
with query failure on cap. [R2 Standard pricing](https://developers.cloudflare.com/r2/pricing/)
remains 1 million Class A, 10 million Class B and 10 GB-months included;
overage is $4.50/million Class A, $0.36/million Class B and $0.015/GB-month.
No plan change is requested.

The probe reuses the exact private runtime-stage configuration and `probe-`
resource lifecycle. It adds MCP discovery, catalog, capability, authorization,
unavailable linked-file, one-file version publication with upload-plan and
committed replay, compact/full reads and two one-item version pages, plus
hostile input checks. The added MCP leg is bounded at under 30 Worker
requests, fewer than 30 D1 rows written and fewer than 5 R2 Class A/B
operations; the complete account probe remains under 100 Worker requests,
150 D1 rows written, 35 Class A and 20 Class B operations. This is far below
the observed remaining allowance. The probe's exact-resource teardown is
part of this authorized run; non-probe resources must stay unchanged.

The first attempt on 2026-09-28 stopped before plan or deployment. Wrangler
matched the intended account, but `alchemy state ls` could not verify the
previous stage because the `default` Alchemy profile currently has no
Cloudflare provider. The retained full local failure record is
`deploy/cloudflare/evidence/account-probe-2026-09-28T15-28-00-751Z.json`
(redacted repository summary: `project/evidence/cloudflare-mcp-live-attempt.json`);
no resources were created and no metered runtime work occurred. Resume only
after the named profile is reconnected and a fresh `probe-runtime-` stage is
selected and verified absent.
