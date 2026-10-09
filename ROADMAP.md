# Roadmap

Updated October 9, 2026. This is the one place for open work, waiting owner
decisions and the current deployment. It replaces `NEXT.md`, `NEXT-STEPS.md`,
`PLAN.md` and `HANDOFF.md`, which are kept verbatim in
[docs/archive/planning-2026-10-08/](docs/archive/planning-2026-10-08/README.md)
with their full progress logs and closed tasks.

[AGENTS.md](AGENTS.md) is binding and overrides anything here. The
[conformance ledger](project/spec/conformance.yml) is the authority for
requirement status and proof gaps; [FINDINGS.md](project/performance/FINDINGS.md)
is the performance risk register. When an item here closes, delete it, attach
its evidence to the ledger, and leave the history to Git.

Task IDs (T03, T10, …) are the planning identifiers from the archived backlog,
kept so older evidence and ledger text still resolve. They are not conformance IDs.

## Current deployment

artifacts.backend.app runs image
`sha256:319c1d7e9ac12fdf496d65c87332060bdc54e0f638e56bdd36d838c89917411c`
(Artifact Server `27fd3a0`, Workspace `9ffbf00ac`, deployed October 9); all four
server pods run it and Argo reports Synced and Healthy. The Design checkout
(`~/Dev/Design`) is at `5704154`. Recheck both before relying on this.

`pnpm verify:iteration` passed on October 9 on the private-team branch, whose
code matches `main` apart from the image workflow and ledger. The unit stage
needed reruns past two load-timeout flakes in process-spawning CLI tests
(`lifecycle-cli` "foundation" and `local-cli` "credential-free URL"); every
later stage then passed in one run. The home-runner CI gate on `bb3269d` passed
on rerun after a first attempt in which the whole unit stage ran about twice as
slowly as usual.

Deploying follows GitOps: take the digest only from `image.yml`'s "Print digest"
step, then pin it in `~/Workspace` at
`deployments/argocd/application-artifact-server.yaml` and
`deployments/clusters/vps/artifact-server/helm-values.yaml`. Argo reverts a
direct `kubectl` change. Since `27fd3a0`, `image.yml` pulls BuildKit, the
Dockerfile frontend and the Node base through `mirror.gcr.io` (same digests),
because Docker Hub 429s and an outage failed four GitHub-hosted builds.

### Closed since late September

Details are in the archive and the ledger.

- **Private-team deployment proof (October 9).** AUTH-025 and AUTH-027 now pass
  on compact Compose, two-replica external-storage Compose and two-replica Helm
  against a real Keycloak over TLS
  (`tests/release/private-team-access.test.ts`). AUTH-027 is the ledger's first
  `verified` row; a deactivated member is refused at once by the handling
  replica and within the 30-second cache bound (about 31 s observed) by the
  other. AUTH-025 is `behavior_verified`; its gaps are below under T16.
  Compose (`compose.identity-ca.yaml`) and Helm
  (`identity.trustedCertificateAuthorities`) can now trust a private
  identity-provider CA. Private-team startup refuses
  `ARTIFACT_SERVER_LOCAL_BOOTSTRAP_TOKEN`, and `compact-backup.sh` restarts the
  existing container so operator overlays survive a backup.
- **Staging cleanup claim (October 9).** Concurrent cleanup passes no longer
  claim the same expired upload; an interrupted pass releases its claim, and a
  crashed one goes stale after one settle delay. This fixed an intermittent
  Windows `EPERM` failure in PUB-009-B.
- **Delivery.** Stored Brotli variants (CNT-011) and reusable 12-hour private
  preview leases (CNT-012). ExtractionKit's data tiers load on demand (Design).
- **Library.** One authorized server request (DSN-006). Hosted cold open went
  from 22–33 s to 5.4 s.
- **Forms review pilot.** Views, scenario restore, region anchors, provenance
  and bundle location (DSN-007 … DSN-011). On October 8 the hosted suite passed
  22/22 on Forms v17 in Chromium and WebKit
  (`project/evidence/hosted-design-review-2026-10-08T1455Z.json`).
- **Review.** Every page opens live in Interactive preview, and the pencil is
  the one Annotate switch. Annotate reopens the scenario reached on the live
  page. Contract amendments 1–9 are in
  [the pilot contract](docs/superpowers/specs/2026-10-06-forms-review-pilot-contract-design.md).
- **Hosted bundle delivery (DSN-011-B).** On October 8 a dedicated agent
  principal received a hosted Forms comment through an MCP mailbox and a
  native bridge with the same location line; the suite passed 23/23 with one
  intended WebKit skip (`project/evidence/hosted-design-review-2026-10-08T1741Z.json`).
- **Authorization and CLI.** A caller without read or manage authority can no
  longer tell real artifacts from missing ones (MCP-009), and CLI renewal
  reports an unavailable server instead of a revoked grant (CLI-001).
- **Uploads.** Interrupted bodies are resumable `UPLOAD_INTERRUPTED`, CLI
  retries are added, and exported telemetry is redacted (PUB-021, PUB-022).
- **Invite links,** and the Activity, Projects and Admin console.
- **Backlog.** T01, T02, T04–T09, T12, T13, T17 and T18 are closed, and T10's
  uncommitted-cleanup slice is done. Their remaining live-provider gaps are
  collected [below](#live-provider-gaps-left-by-closed-tasks).

## Waiting on owner decisions

| # | Decision | Context |
|---|---|---|
| 1 | **Restore on the live page?** Forms answers `as-page-restore` in Interactive preview, so Review could restore a scenario without reloading into Annotate. | Review would have to post to the live page, which CMT-022 forbids. It needs a spec amendment, journeys, and a rule for pages that never answer. Until then, Forms' default-on-load handling of `?scenario=` is fine. |
| 2 | **Browser `auth login` 404 (CLI-001).** | No production entry point sets `apiOAuthResource` (ADR 0028 left it unset on purpose). The CLI points to `--api-key-stdin`, but `docs/cli.md` still describes a browser login. |
| 3 | **Cloudflare Artifacts Gate 3:** deployment authorization for production configuration. | See [Published Git history](#published-git-history-cloudflare-artifacts). |
| 4 | **MCP tool catalog endpoint** to back an admin tool-group table. | Activity, Projects and Admin follow-up. |
| 5 | **Reject unknown hosts in the application too?** A request that reaches a replica directly with a foreign `Host` is served the same installation, with that host reflected into response links. | The spec makes the ingress reject other hosts, and the backend listener must not be public, so this is defense in depth. MCP already answers only for the management host. Recorded in AUTH-025's proof gap. |

### Product choices (T24)

Record a decision only when a task needs one. Until then, keep the safe default.

| Choice | Safe default | Unlocks |
|---|---|---|
| Retry/idempotency lifetime and failed-operation semantics | Keep successful replay. No successful-staging reclamation and no perpetual negative result. | T10, T25 |
| Permanent Git predecessor failure and its visible status | Stop that artifact's later copies and keep primary publication available. Specify any new status before using it. | T03 |
| Private/offline and permanently-public access | Keep no-store/private and current-only public access. No permanently-public class. | T21, frozen releases |
| WorkOS roles, SCIM and audit retention | App membership and audit stay the authority. No project ACL and no new paid dependency. | T16 |
| Cross-device drafts | Keep device-local scoped drafts. | Later draft feature |
| Moving project view vs frozen collection | A moving view may compose authorized records. Frozen shares need their own versioned manifest and lifecycle. | T19 |
| Workload, retention, provider account and recovery objectives | Use synthetic fixtures and disclose unknown production capacity and cost. | T25 |

## Published Git history (Cloudflare Artifacts)

The goal is to let a member or agent clone the exact publication under review:
deterministic commits, exact-version tags, and pointer records for excluded
bytes. Keep one private repository per artifact and copy asynchronously after
primary publication is durable. The mirror is supplementary history, not a
backup. Reference: [Git-history spec](project/spec/git-history-spec.md),
[ADR 0026](project/spec/decisions/0026-cloudflare-artifacts-configurable-git-handoff.md),
[integration guide](docs/cloudflare-artifacts.md).

**Done:** Gates 1–2. On October 6 the bounded Node/Postgres product suite passed
9/9 at `2b25347` against `artifact-server-test-qualification` and left the
namespace empty ([report](project/evidence/cloudflare-artifacts-node-postgres-qualification-2026-10-06T1419Z.json)).

| Gate | Work | Exit evidence |
|---|---|---|
| 3. Production configuration | After deployment authorization, provision the mounted secret and provider configuration through GitOps. Inspect project settings first and keep the pilot off. | Deployed source, image and configuration identity. Provider available, primary readiness and publication unchanged. |
| 4. Estimate and pilot | Refresh the publication inventory (all eleven were in `prj_default` on October 5). Prefer a dedicated Forms pilot project. Get a fresh estimate, set explicit copy and storage bounds, and get project-administrator enablement. | Project identity, estimate, copy policy, logical budget and enablement recorded. Other projects untouched. |
| 5. Exact-version handoff | Mirror bounded history plus a new publication, then clone with a short-lived read token. Verify tag, parent order, manifest identity, bytes and pointers. Verify writes are refused and that publication survives a mirror failure. | Version ↔ commit/tag mapping, read-only clone results, pause procedure. |

- **Production configuration:** provider `cloudflare-artifacts`, account
  `ee625e5e88a18eea4402075704d78f9f`, namespace `artifact-server-production`,
  and `ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE` pointing to a
  mounted secret. Keep the 10 MiB/file and 50 MiB/version bounds unless they
  are reviewed. Never create mirror repositories by hand.
- **Credentials:** `~/.config/artifact-server/cloudflare-artifacts/{production,qualification}.token`
  (directory `0700`, files `0600`). Each is limited to Artifacts Read/Write on
  this account. The **qualification token expires October 12** and the
  production token November 4, 2026. Name who rotates them before enablement.
- **Cost:** billing starts October 14, 2026 and requires Workers Paid. The plan
  includes 10,000 operations/month and 1 GB; beyond that it is $0.15 per 1,000
  operations and $0.50 per GB-month. Refresh allowance and overage behavior
  before every live run and record it in the
  [cost envelope](project/performance/CLOUDFLARE-COST-ENVELOPE.md).
- **Pause:** turn off the project's Git-history setting or disable the provider
  (GIT-009 keeps repositories and mappings). Remote purge is a separately
  authorized operation. Never sweep a namespace or account.
- **T03 remaining:** live D1 multi-worker proof on a deployed Worker, controlled
  repeated live backlog measurements, the Workers-binding path on this account,
  and deployment-specific production evidence. The Workers-binding path needs
  Wrangler ≥ 4.145.0; `deploy/cloudflare` pins 4.123.0. Keep the Node REST/Git
  and Workers-binding/D1 results separate.

## Review-to-change workflow

The target journey: open Forms scenario 5, annotate its field, send
source-aware feedback, propose an authored-source commit, build it, publish it
as a candidate version, review it, then explicitly accept
the source and/or promote the exact output. The views, review SDK and
provenance contracts this depends on are done (DSN-007 … DSN-011). What remains:

- **Candidate versions (decided October 8).** A candidate is a staged version
  of the same artifact that does not move current; promotion repoints current
  to that exact version. Candidates are not mirrored to Git, promotion requires
  current to still equal the candidate's base, only a human can promote, and
  rejected candidates are kept but hidden. Next: add the proposed CND-001 …
  CND-006 to the ledger with their tests, then implement across SQLite,
  Postgres and D1 ([design](docs/superpowers/specs/2026-10-08-candidate-versions-design.md)).

- **Agent delivery.** Extend the existing
  [dispatch](project/spec/agent-dispatch-spec.md) and
  [bridge](docs/agent-bridge-protocol.md) contracts with versioned
  source, scenario and region context, workspace identity and candidate links.
  Do not create a parallel mailbox. Keep delivery, addressed comments,
  successful builds and human acceptance distinct: a passing build is not
  acceptance.
- **Writable workspaces (later).** Define source authorization, the exact base
  commit, scoped write credentials, lifetime and cleanup, and how changes return
  to canonical source. Use a namespace separate from published history. Agents
  must never rewrite the mirror's `main` or its exact-version tags.
- **Automated builds.** Use existing CI first. Before enabling, specify and
  test:
  - Build the event's exact commit with pinned dependencies.
  - Deduplicate on a durable build/publication identity.
  - Never let a late build advance newer accepted state.
  - Filter triggers so mirror pushes never loop.
  - Keep untrusted builds out of the serving process, with scoped publication
    credentials.
  - Link build evidence back to the originating feedback.
- **Stale handling.** Carry the base source commit, base version, candidate
  identity and build result through the workflow. Use conditional checks, never
  a silent overwrite. Define retention of rejected or superseded candidates and
  their comments.

## Design platform

These are the remaining steps of the October 5 architecture plan. Steps 0–3
(delivery baseline, server-side Library, ExtractionKit data split, Forms
views/SDK) are done.

- **Native React pilot (`arkcase`, Ideas).** Evaluate composition, component
  inspection, authoring overhead and annotation integration on their own merits.
  Admit modules only through the reviewed DS sync
  ([sync contract](apps/web/src/arkcase/README.md)). An upload that declares
  itself React never executes in the app. Native modules use the host's React 19,
  while legacy React 18 previews stay in isolated documents. Exercise themes,
  portals, viewport (an iframe gives a real viewport; a `<div>` does not) and
  historical fallback. An old version must never render with today's DS.
- **Frozen public releases.** Record the T24 access/revocation decision and
  conformance IDs first. AUTH-004 currently limits public links to the current
  version. Releases need an immutable URL, an optional moving "latest", and
  headers that decision supports. Already-downloaded copies cannot be recalled.
- **Performance targets not yet met.** The plan's targets are a first Library
  page within 1 s and prototype ready within 2 s; the hosted Library is 5.4 s.
  For ExtractionKit, the only recommended next step is a main-thread profile of
  the first Runs render evaluating `ek-data-design-record.js`. Do not split it by
  hand without that evidence (FINDINGS.md, "ExtractionKit deferred data tiers").
- **Deferred.** Cross-artifact shared-asset deduplication waits until
  measurements show per-artifact DS copies still cost enough. A digest is not an
  access grant.
- **Design-side cleanups.** The DS generator still has `minify: false` (1.74 →
  1.01 MB in an experiment). NYCourts' `AGENTS.md` says Design's publish groups
  include `court-of-claims`; that is stale, so correct it separately. NY Courts
  has no preview index, so it still needs its fragment routes registered as views.

## Engineering backlog

### Gates

| Gate | Required work |
|---|---|
| V | `pnpm verify:iteration` and `git diff --check` |
| P | Same-environment `pnpm perf:baseline` before/after; `pnpm perf:capacity` for concurrency/memory |
| H | `pnpm smoke` after HTTP, publication, SQLite, blob, restart or cleanup changes |
| O | `pnpm verify:object-storage` for remote blob/staging changes |
| E | `pnpm verify:external-storage-runtime` for Postgres/composition/config/migration/backup changes |
| X | `pnpm verify:external-storage-performance` for external publish/read/query/pool changes |
| B | `pnpm test:web` with current-run browser evidence and engine/build/deployment identity |
| L | Opt-in live provider/host suites; check account cost first. An emulator pass is not live qualification. |

Close a task only when its normal and hostile outcomes are demonstrated and its
remaining deployment gaps are recorded. A single local green run never promotes
a requirement to `verified`.

### Open tasks

**T10 Staging lifecycle (remaining).** Uncommitted cleanup is bounded and
claim-fenced, the claim is exclusive between live passes, and OPS-006-B passes
locally. Still to do: specify
successful-staging reclamation (decided with T24, separate from replay, backups
and active preparations), amend PUB-009/OPS-006, abort abandoned multipart work
through the adapter, and rerun OPS-006-B on cloudflare, aws and gcp when those
are next qualified. Never age-delete immutable blobs. *Gates* V/H/O/E/X plus the
Cloudflare runtime suite.

**T11 Signed and resumable large-file transfers.** Compare app-origin transfer
with native signed PUT/multipart or GCS resumable staging. Never forward app
bearer tokens or allow arbitrary redirects. Seal exact staged generations and
prove full SHA-256. Done when interrupted, expired, reused, tampered and
cross-project URLs cannot mutate committed bytes or select storage keys, and the
size/RTT threshold comes from controlled results. Do not reintroduce inline
base64. *Contracts* PUB-001/002/003/012/014, MCP-007/008, plus new IDs.

**T14 Authorized content reuse and bounded metadata reads.** Measure
repeated-byte ratio and catalog growth before adding transfer suppression or
indexes. Reuse must derive only from content the caller may already inspect,
and foreign digest existence must stay concealed in response shape and timing.
Profile catalog counts, substring search, manifest lookup and pool waits.
*Contracts* PRJ-002, AUTH-008/009/017, PUB-003/004.

**T15 MCP (remaining).** Bounded results (MCP-021 … MCP-025), local Worker
`/mcp`, and Claude Code / Codex workflows are done. Still open:
- Rerun the live Worker MCP probe after the workers.dev Host fix. The first paid
  run failed with 403 instead of 401. The retry needs a fresh preflight and
  authorization against the under-250 request / under-1,000 D1 row envelope
  ([preflight](project/evidence/cloudflare-mcp-retry-preflight-2026-09-28.json)).
- Qualify Cursor model calls and VS Code Copilot when those products are
  available.

**T16 Identity lifecycle.** The production WorkOS inventory, Codex CIMD PKCE
login/logout/reconnect, Keycloak `pnpm test:oidc` 4/4, and packaged
private-team access and cross-replica deactivation (AUTH-025/027) are done
([matrix](project/evidence/identity-qualification-matrix.json)). Still open:
- AUTH-025: a WorkOS-configured packaged startup (OIDC evidence cannot stand in
  for it); on Helm the local bootstrap credential is only shown unconfigurable
  through the chart, not refused by the process; and decision 5 above.
- Approval-gated: key rotation, provider-side revocation, server API-key
  rotation, and re-qualifying the August 16 client rows at current versions.
*Contracts* AUTH-001/008/017/019–029, MCP-010–013/017–019, GATE-005.

**T19 Design navigation (remaining).**
- Frozen shareable collections (T24).
- Optional theme/phone thumbnail variants.
- Versions rows show saved time because the API names publishers only by
  principal ID.
- Composer mentions wait on server notifications.
- At narrow desktop widths with the docked title, the Library bar can wrap to
  two rows.
- The artifact gallery's date read is not bounded by comment count the way the
  Library's is.
- Activity's Open control crowds the card at 390px.
- No physical iPhone Safari run yet.

**T20 Infrastructure previews.** Add scoped Pulumi previews with sanitized
diffs, provider/runtime versions and retained failure artifacts. Untrusted
changes must never obtain apply credentials. The AWS and GCS accounts lack the
deploy permissions, state backend and secrets provider that the full stacks
need, so `pnpm test:aws-pulumi` and `pnpm test:gcp-pulumi` stay unrun.
*Contracts* DEP-003/008/009/012/016/021.

**T21 Cache, compression, range and archive (remaining).** CNT-003/004/006 need
deployment qualification. AUTH-007 has no CDN purge API. CNT-003 and AUTH-016
need recorded external-storage evidence. Any new cache class needs an explicit
policy before headers change. Profile repeated archive requests before
materializing ZIPs (CRC-32 is the measured archive cost). Multi-range stays
deferred.

**T27 Linked files (remaining).** LNK-005 waits on the undecided GATE-014
attachment feature. LNK-001 and LNK-007 need route-level absence proof on
deployed AWS and GCP instances.

**CLI credential storage (CLI-001, remaining).** macOS now seals credentials
behind a short Keychain key. On October 8 a 6,038-character credential
round-tripped through the real login Keychain by hand, and the hosted agent
key moved to the CLI profile `~/.config/artifact-server/hosted-agent`; set
`ARTIFACT_SERVER_HOSTED_AGENT_PROFILE_DATA` to it for the hosted suite. Never
probe `security` on the owner's machine without approval. Still open: Windows
Credential Manager's 2,560-byte blob limit (about 1,280 characters, likely too
small for an OAuth grant), and `auth status` still showing an unreachable
server as `invalid`.

**Activity, Projects and Admin.** Record team-deployment browser evidence for
ACT-005, ACT-006 and ADM-008.

**CI.**
- The macOS portability job reaches its 12-minute limit in "Verify portable
  code paths" on every recent run, so macOS has had no complete CI run. Find
  the slow step before raising the limit.
- The home-runner Linux gate can run about twice as slowly as usual (October 9,
  first attempt on `bb3269d`). Check `kubectl top node` and Music Intelligence
  training before rerunning.
- The Helm stage now creates a second kind cluster for the private-team suite
  (about 2 extra minutes).

**Private-team proof follow-ups (from the October 9 review, minor).**
- The Helm driver's `kubectl port-forward` omits `--context`, and its
  `discovery_failed` check passes if log retrieval returns nothing.
- The Helm driver leaves the Postgres container's anonymous volume behind.
- `scripts/with-private-team-identity.sh` keeps polling after Ctrl-C, and its
  port choice can race.
- The chart reads `trustedCertificateAuthorities.configMapName` without a guard
  on one line (a `null` value gives a nil-pointer render error), and its README
  should say that a CA change needs a rollout.
- The Helm private-team pods can share a node under `ScheduleAnyway`; the driver
  fails safely but can flake.
- The new `ARTIFACT_SERVER_LOCAL_BOOTSTRAP_TOKEN` refusal is in no operator doc.

### Live-provider gaps left by closed tasks

Each closed task recorded these gaps rather than being blocked by them.

- **T01:** results come from single-machine local or disposable-provider runs,
  with no controlled CI runner.
- **T04:** no managed-Postgres qualification and no lock-duration probe. PUB-005
  stays `specified`.
- **T05:** Workers mid-publication resume with per-file `verified` flags is
  unproven; the SIGKILL resume suite is Node-only.
- **T06:** deployed-team HTTP evidence and hot-project polling cost are
  unrecorded.
- **T08:** retained bytes, backup cadence, review hours, mutation rates,
  isolated API RTT, and observed hard-limit/overage behavior are unmeasured.
- **T09:** the remaining proof gaps stay on PUB-019 and PUB-020.
- **T12:** live Azure is unqualified, so `promote` stays withheld there.
- **T13:** the binary small-file batch stays opt-in and unadopted.
- **T18:**
  - A client disconnect does not interrupt in-flight SQL.
  - Postgres SQL spans are not exported.
  - Inbound `traceparent` is not honored.

### Conditional work

Start these only when their trigger holds. They are not automatic expansion.

- **T22 Durable feed or SSE:** only if measured revision/refetch costs are
  insufficient. It needs transactional events, cursors, restore epochs and
  ongoing authorization.
- **T23 Richer Git handoff:** after T03 and history profiling, plus a concrete
  user need. Order: review-to-PR association, then a push-only private remote,
  then explicit commit import. No public-link Git authority and no silent merge.
- **T25 Committed-blob GC:** design only after recovery prerequisites exist.
  Keep automatic GC disabled. No bucket age-deletion shortcut.
- **T26 Native helper:** only after a measured end-to-end gain of at least 10%,
  including IPC, startup and packaging. Otherwise reject it explicitly.

## Next for Design

Nothing here needs a schema re-pin. Forms v17 passed hosted, so no Design change
is needed for it.

- Keep posting unprompted `as-page-state` to `window.parent` with `"*"`; Review's
  live-scenario carryover depends on it.
- Annotate owns page clicks by design. The reviewer turns the pencil off to use
  page controls.
- If the `style-src` refusal reappears in Safari, log `securitypolicyviolation`
  events (document, `effectiveDirective`, `sourceFile`). It did not reproduce
  under Chromium or WebKit.
