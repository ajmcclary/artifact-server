# Cloudflare cost envelope (T08)

Status September 23, 2026 — account plan and lifecycle probe bounded; current
runtime remains open. Official pricing and limits are current as of 2026-09-22
and taken from Cloudflare's own pages. The R2 allowance and overage values were
also confirmed in the account dashboard on 2026-09-23. Local workload facts are
measured on this machine (Apple M1 Max, darwin arm64, Node 24.15.0, commit
`867fb70`). The approved account is Workers Free with R2 activated.

## Completed workload worksheet

| Fact | Measured or pinned value | How recorded |
| --- | --- | --- |
| Provider account / plan | Workers Free; R2 active at $0/month base | dashboard observation, 2026-09-23 |
| Region(s) | Workers global; D1/R2 placement not separately inspected | live probe did not isolate placement |
| Measured RTT to provider API (ms) | account lifecycle probe completed in 72.194 s end to end; per-call RTT not isolated | `project/evidence/cloudflare-account-probe.json` |
| Proxy / CDN / tunnel topology | local loopback only | local baseline harness |
| Publication size distribution (bytes) | 40 × 16 KiB publications; file-client 48 × 4 KiB directory + one 2 MiB file | `project/evidence/local-performance-baseline.json` |
| Files per publication distribution | 1-file and 48-file fixtures measured; 3,301-version Git backlog probed on local D1 | local baselines + `project/evidence/git-history-d1-backlog.json` |
| Retained bytes (total / per project) | 15,540,592 bytes across 291 files in the bounded local baseline | `project/evidence/local-performance-baseline.json` `storage` |
| Backup count and frequency | unknown | no production workload or backup schedule supplied |
| Visible review hours per day | unknown | blocked on real usage data |
| Mutation rate (publications / hour) | unknown | blocked on real usage data |
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
- Hard-failure versus overage behavior is documented above, not observed: no
  live run has yet hit the Free request cap, the D1 row caps, or Paid overage
  billing.

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
repositories and zero operations. Remaining account facts are actual retained
bytes, backup count/frequency, review hours, mutation rates, isolated API RTT,
and observed hard-limit or overage behavior.

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
