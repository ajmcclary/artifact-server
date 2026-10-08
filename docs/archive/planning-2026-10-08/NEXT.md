# Cloudflare Artifacts integration: next steps

Date: October 5, 2026

Status: Integration plan and dated setup handoff. Namespace and credential access were verified on October 5; current-account provider qualification and production enablement remain separate gates. Writable source workspaces, scenario-aware review, candidate publication, and automated builds require the contracts below before implementation.

## Direction and authority

Use Cloudflare Artifacts first for optional published Git history and exact-version read-only handoff. Develop the richer review-to-change workflow in separately verifiable stages. Keep the existing database/blob-store publication authority, canonical Design sources, and CI build path.

Cloudflare announced open beta on October 1, 2026. The repository's older closed-beta wording is historical. Artifacts provides managed Git-compatible repositories, forks, repository-scoped credentials, and push events; Artifact Server supplies authorization and product workflow. See the [changelog](https://developers.cloudflare.com/artifacts/platform/changelog/) and [repository model](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/).

| Part | Responsibility |
|---|---|
| Design repository | Canonical shared components, project sources, contracts, descriptors, scenarios, and build recipes |
| Cloudflare Artifacts | Derived published Git history and, later, separate repositories for proposed source changes |
| Existing CI/build pipeline | Build exact source revisions with pinned inputs into portable distributions and admitted native modules |
| Artifact Server | Immutable publications, library indexing, annotations, dispatch, permissions, and current-version selection |
| Existing database and object storage | Authoritative publication records, version bytes, binaries, and recovery |

The current Kubernetes/PostgreSQL/S3 deployment can use Artifacts through REST and Git. It does not need to move onto Workers. The mirror is supplementary history, not a complete backup: comments, permissions, database records, and pointer-backed binaries remain part of the existing recovery process.

Use [PLAN.md](PLAN.md) for the broader design-platform direction, the newer linked specs for subsequent implementation decisions, [NEXT-STEPS.md](NEXT-STEPS.md#t03-repair-git-order-reconciliation-bounds-and-worker-ownership) for T03's historical progress and remaining qualification work, and [conformance.yml](../../../project/spec/conformance.yml) for requirement status and proof gaps. This document sequences those tracks; it does not promote conformance status or authorize deployment, paid qualification, project enablement, or source acceptance.

## Current baseline

This is an October 5 repository snapshot, not a live deployment status page. Artifact Server was inspected at `aa18a20`; Design at `5854805`, with concurrent working-tree changes in both repositories. Recheck revisions and evidence before executing a gate.

| Track | Recorded state and next boundary | Source of detail |
|---|---|---|
| Stored content variants | CNT-011 replaces per-request streaming compression with stored Brotli variants. Hosted evidence on source `ad1585a`, image `sha256:c30005b09d6f66d4f6f004ca18aa343437a1dc29a605044c32f07d2516216be1`, records ExtractionKit cold-ready median 14.3 → 8.9 seconds and 3.38 MiB transferred after backfill. This does not establish today's deployed revision or finish payload optimization. | [Variant spec](../../../docs/superpowers/specs/2026-10-05-precompressed-content-variants-design.md), [hosted report](../../../project/evidence/delivery-baseline-2026-10-05-hosted-after-variants.json), [performance findings](../../../project/performance/FINDINGS.md) |
| Server-side Library | Endpoint, SQL dating, and client integration are committed in the inspected checkout. The newer decision is one authorized on-demand request with cached immutable preview indexes, no persistent projection/backfill, and no pagination. DSN-006 remains `implementing`; complete its gates and hosted measurement before claiming deployment success. | [Library spec](../../../docs/superpowers/specs/2026-10-05-server-side-library-design.md), [implementation plan](../../../docs/superpowers/plans/2026-10-05-server-side-library.md) |
| ExtractionKit payload | Splitting eager fixture/data loading remains a separate producer task. Preserve fixture bytes and existing interactions; evaluate cache and lease semantics separately. | [PLAN.md](PLAN.md), [performance findings](../../../project/performance/FINDINGS.md) |
| Published Git history | Provider-neutral mirror, project opt-in, ordered backfill, pointers, and short-lived read-only clone handoff exist. Local repairs and older-account live evidence do not qualify the new account or every deployment. | [Git-history spec](../../../project/spec/git-history-spec.md), [ADR 0026](../../../project/spec/decisions/0026-cloudflare-artifacts-configurable-git-handoff.md), T03 and GIT-008 |
| Forms review | The Design descriptor enumerates 23 scenarios. Stable region/source metadata and scenario restoration through a review SDK are planned capabilities, not established by that enumeration. | [Forms descriptor](../../../../Dev/Design/workspace/projects/descriptors/arkcase-forms.js), [PLAN.md](PLAN.md) |
| Native rendering | Selected source modules already enter through reviewed DS sync. Broader native views remain a pilot with runtime, theme, viewport, and historical-fallback checks. | [Sync contract](../../../apps/web/src/arkcase/README.md), [PLAN.md](PLAN.md) |

Cloudflare storage is not a prerequisite for Library completion, ExtractionKit payload work, or Forms metadata/SDK design. Do not restart the superseded streaming-compression approach or treat PLAN.md's persistent projection as the current Library implementation requirement.

## First milestone: qualify published-history handoff

The immediate result is a member or agent cloning the precise publication under review, with deterministic commits, exact-version tags, and explicit pointer records for excluded bytes. Preserve one private repository per artifact and asynchronous copying after primary publication is durable. Current selection is per project, not per artifact.

Execute these gates in order. Prepare configuration as needed, but qualify the intended provider path before activating it in production.

| Gate | Work | Required exit evidence |
|---|---|---|
| 1. Compatibility and bounded run | Recheck account/namespace access, token expiry, current allowance and overage behavior. Define the exact repositories, operations, bytes, time/retry limits, and cleanup scope for an authorized run. Inspect the adapter against current provider APIs. | Dated account/cost snapshot in the relevant evidence and [cost envelope](../../../project/performance/CLOUDFLARE-COST-ENVELOPE.md); exact tested source/tool versions and run scope. |
| 2. Dedicated qualification | Use only `artifact-server-test-qualification` and exact run-prefixed repositories. Qualify the intended Node/Postgres REST/Git path, including applicable ordering, retry, ownership, crash recovery, budget, and read-only clone cases. Preserve failures and clean up only the run's resources. | Results tied to source revision, account, namespace, runtime/database, bounded workload, requirement IDs, and cleanup outcome. A basic REST/Git pass alone does not close T03. |
| 3. Production configuration | After the applicable qualification and deployment authorization, provision the mounted production secret and provider configuration through the normal GitOps path. Inspect existing project settings before activation; keep the pilot off until its estimate is reviewed. | Deployed source/image/configuration identity, provider availability, unchanged primary readiness/publication behavior, and recorded project settings. |
| 4. Estimate and pilot enablement | Select the project, obtain a fresh estimate covering its existing history, choose explicit copy/storage bounds, and obtain project-administrator enablement. | Recorded project identity, estimate, copy policy, logical budget, and explicit enablement; unrelated projects remain untouched. |
| 5. Exact-version handoff | Mirror bounded historical versions and a new publication, clone using a short-lived read token, and verify the exact tag, parent order, version/manifest identity, copied bytes, and pointer metadata. Verify writes are refused and primary publication remains usable when mirroring fails. | Exact Artifact Server version ↔ mirror commit/tag mapping and scoped read-only clone/recovery results; retained proof gaps and pause procedure. |

**Checkpoint, October 6, 2026.** Gates 1 and 2 are done for the Node/Postgres REST/Git path. Both account tokens verified active (qualification expiry October 12, production November 4); both namespaces resolved with zero repositories. The adapter matches the current REST reference except one compatibility gap, now fixed: Cloudflare refuses repository tokens under 60 seconds, so HTTP and MCP refuse them too. The bounded product suite passed 9/9 at `2b25347` against the qualification namespace and left it empty. See the T03 checkpoint in [NEXT-STEPS.md](NEXT-STEPS.md#t03-repair-git-order-reconciliation-bounds-and-worker-ownership) and the [passing report](../../../project/evidence/cloudflare-artifacts-node-postgres-qualification-2026-10-06T1419Z.json). Billing usage and remaining allowance were not read from the dashboard; the tokens cannot read billing, and the run happened before the October 14 billing start. The Workers-binding path was not run on this account. Gate 3 (production configuration) needs deployment authorization and comes next.

The October 5 publication inventory placed all eleven publications in `prj_default`; refresh that inventory before estimating. Prefer a separately published Forms pilot in a dedicated project if only Forms should be copied. Such a project limits copying; it does not create a new access-control boundary within the installation. Do not move existing artifacts or enable all history for convenience.

Production configuration uses provider `cloudflare-artifacts`, the account in the appendix, namespace `artifact-server-production`, and `ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE` pointing to a mounted secret. Retain the existing 10 MiB/file and 50 MiB/version copy bounds unless separately reviewed, and choose an explicit logical copied-byte budget from the estimate. Namespace creation alone does not deploy configuration or enable projects. Do not create mirror repositories by hand; the service creates them lazily with its own identities and mappings.

Keep Node REST/Git and Workers-binding/D1 results separate. The Node pilot need not adopt new binding methods or wait for an unrelated Workers migration. At this snapshot the checkout pins Wrangler 4.123.0; Cloudflare requires 4.145.0 or later for generating current Artifacts binding types or using Blob-returning remote-binding methods. Review that compatibility before Workers qualification. See the [binding reference](https://developers.cloudflare.com/artifacts/api/workers-binding/).

As qualification progresses, append a current checkpoint to T03 and reconcile the [integration guide](../../../docs/cloudflare-artifacts.md): namespace access is now recorded, while live provider concurrency/recovery and deployment-specific evidence remain separate. Preserve older failed attempts and local repairs as history. Do not erase an earlier failure, mistake older-account evidence for current-account proof, or close all GIT requirements from this pilot alone.

## Second milestone: Forms review prerequisites

Prove the existing history handoff before depending on it for source editing. The richer Forms pilot then needs three compatible contracts, owned by the appropriate repository:

| Contract | Producer and consumer work | Acceptance |
|---|---|---|
| Views and scenarios | Design generates a separately versioned views document from its existing descriptors. Artifact Server validates and consumes stable `viewId`, `scenarioId`, `regionId`, and source references. Preserve the existing strict preview-index schema and IDs. | Forms scenario 5 opens the Validation inspector and identifies the intended minimum-length field reproducibly. |
| Review SDK and anchors | Extend the current annotation protocol compatibly with native and cooperating portable adapters. Preserve exact version, viewport, theme, locale, fixture state, region identity, and fallback location. | Interact, annotate, reopen, and restore that exact state; report location unavailable when restoration or location cannot be established. Original comments remain on their original version. |
| Source provenance | Design emits the versioned provenance record described below; Artifact Server validates declared output references against the immutable manifest. | An agent can identify and obtain the exact authored source and build inputs corresponding to the reviewed output, without editing generated mirrors. |

Reuse [Design's project inventory](../../../../Dev/Design/workspace/projects/manifest.js), the [annotation protocol](../../../apps/web/src/review-frame/protocol.ts), and [comment contracts](../../../project/spec/artifact-comments-spec.md). Do not maintain a competing Forms scenario inventory or assume HTML paths alone identify review states.

### Proposed source-provenance contract

Specify a versioned producer document before implementing consumers. Its minimum content should identify:

- Canonical source repository, exact authored-source commit, project descriptor identity, and authored paths corresponding to published paths/views/regions where known.
- Build recipe and revision, lockfile digest, toolchain/runtime identity, DS revision, renderer identity, and relevant fixture/dependency digests.
- The output paths and rendering inputs used to calculate fingerprints, with explicit incomplete dependency coverage and external variability. Retain conservative target-wide invalidation when complete edges are unavailable.

Keep authored-source commit, derived Git mirror commit, and Artifact Server version/manifest digest distinct. The producer records build inputs and outputs; publication and mirroring then record their resulting identities and link them back to that provenance. Do not require an output to contain its own eventual manifest digest or mirror commit.

Define how authorized agents retrieve source and pointer-backed inputs and verify their digests. A pointer is metadata, not a credential or access grant. Missing source should produce an explicit inspection-only handoff rather than an editable workspace assembled from guesses. Decide whether missing provenance blocks only the editing pilot; legacy publications should remain reviewable.

Follow the existing [DS source/sync boundary](../../../apps/web/src/arkcase/README.md). In Design, change authored components, project sources, contracts, and descriptors, then run their required generators. Do not edit copied `ds-arkcase` trees, generated bundles, or consumer mirrors independently. Generate producer thumbnails from their real inputs; do not substitute visual-test baselines. Reproduction should verify pinned inputs and output manifests and report mismatches, rather than assume a commit alone guarantees byte-identical output.

## Candidate publication and acceptance: decision required

The current publish path creates an immutable version and conditionally advances the artifact's current pointer in one transaction. Calling that result a candidate does not defer its visibility. The proposed review-to-change workflow must choose a candidate model before automatic publication:

| Option | Required definition |
|---|---|
| Separate candidate artifact | Publish proposed output under a distinct artifact identity, record the reviewed base and source provenance, and define how acceptance promotes the reviewed output into the intended artifact while preserving traceability. |
| Staged version within the artifact | Introduce an explicit contract for saving a version without advancing current, its discoverability/access/lifecycle, and a separate conditional promotion operation. This requires product/API/storage/conformance work. |

Neither option is selected by this document. Record the decision and new acceptance IDs in the product specifications before implementing it. Define source acceptance and output promotion as distinct actions: accepting a source change must not silently accept a different rebuild, and promoting a preview must not silently merge a source branch.

Carry the reviewed base source commit, base artifact version, candidate output identity, and build result through the workflow. Define stale-source and stale-current handling using conditional checks; do not silently overwrite newer work. Specify how rejected or superseded candidates are retained or removed and how their comments remain traceable.

After those decisions, the target journey is: open Forms scenario 5 → annotate its field → send source-aware feedback → propose an authored-source commit → validate/build that commit → publish under the chosen candidate contract → review → explicitly accept source and/or promote the exact reviewed output.

## Agent delivery and future writable workspaces

Extend the existing [agent dispatch](../../../project/spec/agent-dispatch-spec.md), [presence/bridge](../../../project/spec/agent-presence-and-bridge-spec.md), and [bridge protocol](../../../docs/agent-bridge-protocol.md) contracts. Reuse registered agents, targeted sends, durable bundles, retry/idempotency behavior, and follow-up delivery at the host's work boundary. Do not interrupt a host session or create a parallel mailbox.

Add versioned source/scenario/region context and, when available, workspace identity and resulting candidate links to that flow. Keep delivery, addressed comments, successful builds, and human acceptance distinct. A passing build is not acceptance; preserve existing dispatch semantics unless explicitly revised.

Writable workspaces are a later capability. Define source authorization, exact base commit, scoped write credentials, workspace lifetime/cleanup, and return-to-canonical-source behavior first. Create them from the required authored sources, separately from published-history repositories. Agents must not rewrite the mirror's server-owned `main` branch or exact-version tags. Cloudflare [forks](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/) and [events](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/) supply infrastructure, not those product contracts.

## Build integration and rendering boundaries

Use existing CI as the initial build executor. Cloudflare-triggered builds are a later option: Workers Builds supplies standard Worker deployments and branch previews; publishing into Artifact Server requires a custom final step through its guarded publication API and the selected candidate contract. See [build and deploy Artifacts repositories](https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/).

Before enabling automatic builds, specify and test:

- Build the event's exact source commit with pinned dependencies, not the branch tip at execution time.
- Deduplicate events and publication retries using a durable build/publication identity; specify handling of failed and superseded runs.
- Prevent late builds from advancing newer accepted source or publication state.
- Filter triggers to intended writable source repositories and branches. Production mirror pushes must not trigger another build/publish/mirror cycle.
- Keep untrusted build execution outside the serving process. Restrict publication credentials to the authorized publication step; source code must not inherit production mirror administration credentials.
- Link build evidence, provenance, and exact candidate identity back to the initiating review feedback.

Generate native React entries and portable distributions from the same authored sources where supported. Native execution still requires reviewed host build/sync admission and compatible React, style, portal, and viewport behavior. An uploaded or Git-stored module does not gain permission to execute inside the authenticated UI. Preserve pinned historical dependencies and isolated portable fallback, including Claude Design exports and incompatible runtimes. Frozen public releases and their access/cache policy remain a separate PLAN.md decision.

ArtifactFS may later reduce checkout startup for large agent/build workspaces by fetching contents as tools read them. Ordinary Git cloning remains adequate for the first bounded pilot; measure before adding another dependency. Neither approach fixes browser payload, annotation rendering, or private-cache semantics. See [ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/).

## Operating limits and pause procedure

As documented October 5, Artifacts billing begins October 14, 2026 and requires Workers Paid. It includes 10,000 operations/month and 1 GB storage; additional usage is listed at $0.15 per 1,000 operations and $0.50 per GB-month. Builds and supporting services have separate costs. Refresh account allowance and overage behavior before every live suite. Logical copied-byte budgets are conservative application controls, not provider billing measurements. See [pricing](https://developers.cloudflare.com/artifacts/platform/pricing/) and [limits](https://developers.cloudflare.com/artifacts/platform/limits/).

Before production enablement, record who will rotate credentials and verify replacement secret mounting. The recorded qualification token expires October 12 and production token November 4, 2026; recheck actual validity before use. Expiry or provider failure should degrade optional history/clone availability while primary publication and readiness remain usable; verify that behavior in qualification.

Pause using the project's Git-history setting or provider disablement as appropriate. Under GIT-009, disablement preserves repositories, coordinates, jobs, and mappings so work can resume; it does not delete remote data or stop storage charges. Remote purge is a separately authorized, planned operation using the existing exact installation/repository controls. Never sweep a namespace or account. Keep primary backups independent of mirror availability, and record production rollback/pause verification with the pilot evidence.

## Appendix: setup snapshot recorded October 5, 2026

The following is retained setup evidence, not a refreshed assertion of current account state. Namespace counts, credential validity, deployment settings, and publication inventory must be reread before operational use.

The setup used the existing checkout at `~/artifact-server`; there is no separate `~/artifacts-server` checkout. The background implementation initially used `delivery-compression`, then moved the checkout to `main` before the setup-status commit. At that checkpoint the document and verified namespace status were committed on main and unrelated implementation changes were preserved.

Account ID: `ee625e5e88a18eea4402075704d78f9f`.

| Resource | Intended use | Status |
|---|---|---|
| `artifact-server-production` namespace | Derived private Git history for this installation | Created and verified; zero repositories |
| `artifact-server-test-qualification` namespace | Exact, run-prefixed repositories for bounded live qualification | Created and verified; zero repositories |
| Separate writable workspace namespace | Future editable agent forks and build triggers | Deferred until that capability is designed |
| `artifact-server-artifacts-production` account API token | Node REST/Git integration; Artifacts Read/Write only; configured expiry November 4, 2026 | Owner created; securely captured; API reports active; production namespace GET passed |
| `artifact-server-artifacts-qualification` account API token | Separate revocable qualification credential; Artifacts Read/Write only; configured expiry October 12, 2026 | Owner created; securely captured; API reports active; qualification namespace GET passed |
| Provider configuration and mounted secret | Current Kubernetes/Node deployment | Not enabled by namespace creation |
| Project Git-history setting | Administrator opt-in after estimate and qualification | Not enabled by namespace creation |

The dashboard namespace form exposed only the name and no jurisdiction selector. No US/EU jurisdiction restriction was selected or verified. The namespace-list screenshot is stored outside the repository at `~/Documents/Codex/2026-10-05/cloudflare-artifacts-setup/namespaces.jpg`.

The owner created both tokens from the reviewed policies in the dashboard. They are restricted to this Cloudflare account and have no DNS, Workers, billing, or other permission groups. Their Artifacts Read/Write policy applies across this account's Artifacts resources; namespace isolation must also be enforced by the application's configured adapter and dedicated qualification namespace. No IP filter was configured. The values were captured from the one-time success dialogs without emitting them in chat or Git, and the dialogs were closed after capture.

Protected local credential files:

- Production: `~/.config/artifact-server/cloudflare-artifacts/production.token`.
- Qualification: `~/.config/artifact-server/cloudflare-artifacts/qualification.token`.

The credential directory has mode `0700`; both token files have mode `0600`. Do not copy their contents into this document, shell arguments, logs, or Git. Use the production file as the source for secure deployment secret provisioning, not as a host path that would automatically exist inside a Kubernetes container. Keep qualification credentials separate from production runtime secrets. Raw token environment configuration is rejected by this fork; repository-scoped tokens for clone/push handoff are issued separately.

Read-only verification returned HTTP 200 and `success: true` for each account-token verify call (`status: active`) and each corresponding namespace GET. These four checks establish credential and namespace access only; they did not create repositories, mirror versions, clone Git history, deploy configuration, or qualify the full provider. The reviewed policy screenshots and secret-free token-list screenshot (`tokens-created.jpg`) are saved outside Git beside the namespace screenshot.
