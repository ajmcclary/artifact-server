# Cloudflare Artifacts integration: next steps

Date: October 5, 2026

Status: Architecture guidance and setup handoff. Cloudflare account access is available. Namespace creation is being verified in the dashboard; provider qualification and production enablement are separate steps.

## Direction

Cloudflare Artifacts adds a foundation for Git history, agent workspaces, and automated builds. Its largest opportunity for this architecture is connecting review feedback to reproducible design changes and new previews.

Cloudflare announced open beta on October 1, 2026. The repository's closed-beta wording is outdated. See the [Cloudflare changelog](https://developers.cloudflare.com/artifacts/platform/changelog/).

Artifacts is managed, Git-compatible storage. Repositories can be created programmatically, cloned with ordinary Git tools, forked, inspected by file and commit, and accessed with repository-scoped credentials. Cloudflare manages repository replication and availability; Artifact Server supplies the surrounding authorization and workflow. See [How Artifacts works](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/).

## Architectural responsibilities

| Part | Responsibility |
|---|---|
| Design repository | Canonical shared components, project sources, contracts, scenarios, and build recipes |
| Cloudflare Artifacts | Published Git history and, later, isolated repositories for proposed agent changes |
| Build pipeline | Compile exact source revisions into native modules and portable distributions |
| Artifact Server | Immutable publications, library indexing, review, annotations, permissions, and release selection |
| Existing object storage | Published assets, large fixtures, images, documents, and other binaries |

The current Kubernetes/PostgreSQL/S3 deployment can use Artifacts through REST and Git. Adopting Artifacts does not require moving Artifact Server onto Workers.

## Immediate benefit: published-design Git handoff

The fork already implements the initial integration:

- Project administrators opt into Git history.
- Each artifact gets its own private repository.
- Published versions map to deterministic commits and exact-version tags.
- Mirroring runs asynchronously, so a Cloudflare failure does not block primary publication.
- Members and agents can obtain short-lived, read-only clone access.
- Large or excluded files become pointers to primary storage records.

Agents can inspect the precise files associated with a reviewed version, compare changes using Git, and correlate their work with Artifact Server's version identity. See the [Git-history specification](project/spec/git-history-spec.md) and [ADR 0026](project/spec/decisions/0026-cloudflare-artifacts-configurable-git-handoff.md).

The mirror is supplementary history, not a complete backup. Comments, permissions, database records, and pointer-backed binaries still require the existing backup process.

## Larger benefit: review-to-change workflow

1. A reviewer annotates a particular view, scenario, and region—for example, Forms → Validation scenario → Minimum-length field.
2. Artifact Server records the exact version, region, source revision, and pinned DS revision.
3. An agent receives an isolated working repository or fork with the required authored sources.
4. The agent proposes a change and pushes a commit.
5. A build checks that exact commit, generates thumbnails and review metadata, and compiles portable/native outputs.
6. Artifact Server publishes a candidate version for review.
7. Acceptance explicitly advances the appropriate publication or source branch.

Cloudflare supports repository forks and push events. The current Artifact Server integration exposes server-written history and read-only handoff; writable agent workspaces would be a new capability. See the [repository model](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/) and [event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/).

Keep writable workspaces separate from published-history repositories. Agents must not rewrite the mirror's server-owned branch or version tags. A clone of a compiled publication is not necessarily an editable source project: the workspace must include, or securely retrieve, authored sources and build inputs.

## Native and portable outputs

Artifacts can hold the exact inputs from which both outputs are generated:

- Native React modules for admitted first-party components.
- Portable compiled applications for isolated previews and public releases.
- Scenario/view metadata, dependency information, and source mappings.
- Build provenance connecting the source commit, DS revision, renderer, and resulting Artifact Server version.

Cloudflare tooling can trigger builds from repository pushes. Workers Builds supports production deployment and previews for other branches; custom Workflows can run checks and builds in isolated runners. A custom pipeline could publish resulting files through Artifact Server's normal API. That publication step is future integration work. See [Build and deploy Artifacts repositories](https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/).

Preserve the current publication pipeline while evaluating this. GitHub and existing CI can remain the canonical source and build path; Artifacts can first serve published history and temporary workspaces.

## Performance fit

Artifacts can improve agent and build startup. ArtifactFS mounts a repository and retrieves file contents as tools read them, avoiding a full initial clone for large repositories. It is intended for sandboxes, containers, and VMs; ordinary Git cloning remains simpler for smaller projects. See [ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/).

Artifacts does not automatically fix browser library loading, compression, eager fixture loading, or annotation rendering. Those changes in [PLAN.md](PLAN.md) remain necessary. User-facing performance benefits would come through optimized outputs produced by the build pipeline.

Native admission, runtime compatibility, historical fidelity, and isolated portable rendering remain Artifact Server responsibilities. Storing a React module in Artifacts does not grant it permission to execute inside the authenticated UI.

## Integration track for the implementing agent

Add Cloudflare Artifacts alongside the current plan. Preserve the database/blob-store publication authority and keep mirroring asynchronous. First verify the existing REST/Git integration against the newly accessible account in a dedicated qualification namespace, then enable one selected pilot project after estimating the copy volume. Preserve the one-repository-per-artifact mirror model and read-only clone handoff.

Later, evaluate separate writable agent workspaces and commit-triggered builds. Build from exact source commits with pinned DS/runtime dependencies, then publish candidate versions through Artifact Server's normal guarded publication API. Keep published mirrors separate from editable workspaces, make event processing idempotent, and prevent publish/mirror/build feedback loops.

The older integration guide contains stale ordering warnings; [T03](NEXT-STEPS.md) records subsequent local repairs. Account access makes live qualification possible but does not establish that qualification has passed. Existing recorded live evidence is from a different account and older source revision.

The first functional pilot should be Forms: it has clear scenarios and annotation targets for exact-version clone handoff now and the annotation-to-agent-to-preview workflow later. Git-history enablement currently applies to a whole Artifact Server project, not one artifact. Since all eleven publications share `prj_default`, obtain a project-wide estimate before enablement; use an isolated pilot project if only Forms should be copied. Do not move existing artifacts or enable all history merely to make a single-artifact pilot convenient.

## Costs

As documented October 5, Artifacts billing begins October 14, 2026 and requires Workers Paid. It includes 10,000 operations/month and 1 GB storage; additional usage is listed at $0.15 per 1,000 operations and $0.50 per GB-month. Builds and supporting services have separate costs. Refresh account allowance and overage behavior before a live suite. See [pricing](https://developers.cloudflare.com/artifacts/platform/pricing/) and [limits](https://developers.cloudflare.com/artifacts/platform/limits/).

## Setup and operational handoff

Use the existing checkout at `~/artifact-server`; there is no separate `~/artifacts-server` checkout. The background implementation is using branch `delivery-compression`. Commit only this document on that active branch without switching the background agent's checkout; it can follow that branch into main with the implementation.

Account ID: `ee625e5e88a18eea4402075704d78f9f`.

| Resource | Intended use | Status |
|---|---|---|
| `artifact-server-production` namespace | Derived private Git history for this installation | Pending dashboard verification |
| `artifact-server-test-qualification` namespace | Exact, run-prefixed repositories for bounded live qualification | Pending dashboard verification |
| Separate writable workspace namespace | Future editable agent forks and build triggers | Deferred until that capability is designed |
| Dedicated Artifacts control-plane credential | Node REST/Git integration | Pending secure provisioning or existing credential verification |
| Provider configuration and mounted secret | Current Kubernetes/Node deployment | Not enabled by namespace creation |
| Project Git-history setting | Administrator opt-in after estimate and qualification | Not enabled by namespace creation |

The dashboard namespace form exposes only the name and no jurisdiction selector. Record the actual resulting jurisdiction if it is displayed; do not claim a US/EU restriction that was not selected and verified.

Next operational steps:

1. Verify both namespace names in the dashboard. Keep production and qualification separate.
2. Provision or verify an account-scoped API credential with only the Artifacts permissions the Node provider requires, restricted to this account. Repository-scoped tokens are issued later for clone/push handoff. Store credentials outside Git and chat; raw token environment configuration is rejected by this fork.
3. Configure the deployment through its normal GitOps path: provider `cloudflare-artifacts`, the account above, namespace `artifact-server-production`, and `ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE` pointing to a mounted secret. Use existing 10 MiB/file and 50 MiB/version copy bounds and an explicit logical storage budget chosen from the estimate. Namespace creation alone does not deploy or start mirroring.
4. Review current API/tooling compatibility before qualification. The checkout pins Wrangler 4.123.0; current documentation calls for 4.145.0 or later for the newer Workers binding types and Blob-returning remote methods. A Node-only pilot need not adopt those methods, but the Workers-binding qualification should check the supported API shape.
5. After reviewing the account allowance and an exact bounded test envelope, run qualification only in `artifact-server-test-qualification`. Preserve failed evidence and clean up only the exact run's repositories. Record REST/Git, ordering/recovery, and Workers-binding results separately.
6. Obtain the intended project's estimate, explicitly enable it, verify exact commit/tag mappings and read-only clone, and record the production verification boundary.

Do not create artifact mirror repositories by hand: the service creates them lazily with its own artifact identities and recorded mappings. Do not configure build triggers on the production mirror as part of initial setup.
