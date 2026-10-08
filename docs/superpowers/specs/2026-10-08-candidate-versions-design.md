# Candidate versions — design

Date: 2026-10-08
Status: approved (owner answered the four questions on 2026-10-08, all as recommended). Records ROADMAP decision 3. The CND requirement IDs below are proposed and enter the ledger with their tests.

## Intent

Let a build publish a version that someone can review before it becomes what the artifact shows. Today a publish advances `currentVersionId` in the same transaction, so the only way to review a change is after everyone already sees it.

The review-to-change journey needs that step. Forms scenario 5 is annotated, an agent proposes and builds a change, the build publishes a candidate, a person reviews it, and then accepts the source and/or promotes the exact output. Source acceptance and output promotion stay distinct actions. This design covers only the output side.

### Decision: a staged version on the same artifact

A candidate is an ordinary immutable version of the artifact that is committed without moving current. Promotion repoints current to that exact version.

The alternative was a separate candidate artifact. It was rejected because promotion would have to copy bytes into a **new version ID**. Comments, provenance and the reviewed bytes would then sit on a different record from what was promoted. It would also need an artifact-kind filter in every listing, a cross-artifact compare, and a repository per candidate in the Git mirror.

What the staged version gets for free:
- Compare works because both versions are on one artifact.
- Comments stay anchored to the candidate's version ID.
- Provenance (DSN-010) stays per version.
- Preview leases (CNT-012) are already per version.
- Public links (AUTH-004) and the Library both read only current, so a candidate cannot leak through either.
- The conditional `expectedCurrentVersionId` write that publish and restore already use protects against late builds.

## Model

- **Schema.** `versions` gains `state`: `mainline | candidate | promoted | rejected | superseded`. Every existing row is `mainline`. A candidate also records `base_version_id`: the version that was current when the build started.
- **Numbering.** Candidates take numbers from the artifact's one sequence, so a candidate is "version 7" in bundles and the UI. A rejected candidate leaves a gap in the mainline numbers, and that is acceptable.
- **Stage.** `publish` with `stage: true` commits the version like any other. It checks that the given base is still current, and refuses with `PublishConflict` otherwise. It does not update `current_version_id`. The replay identity gains `stage`, so a staged publish and an ordinary publish of the same bytes are different operations.
- **Promote.** A new operation, separate from restore, with its own action kind and idempotency operation. It succeeds only when:
  - the version is a `candidate`, and
  - current still equals the candidate's `base_version_id`.

  When current has moved, promotion is refused with `CANDIDATE_STALE` and nothing changes. On success current is set to the candidate's own ID, so the promoted version is byte- and ID-identical to the reviewed one, and its state becomes `promoted`. Other open candidates on the same base become stale, since current moved; they are not rejected automatically.
- **Reject.** An explicit action sets a candidate to `rejected`. A candidate that loses to another on the same base can be marked `superseded`. Both are terminal. Their bytes, comments and provenance are kept: no version is ever deleted, and committed-blob GC stays deferred under T25.
- **Restore.** Unchanged. It may target `mainline` or `promoted` versions only, never a candidate, so restore cannot be used to get around review.

## Surfaces

| Surface | Behavior |
|---|---|
| Versions list (HTTP, MCP, web) | The default list shows mainline and promoted versions. Candidates appear under a filter or a badge, with their state and base. |
| Review | A candidate opens by its exact-version link with a "Candidate · based on version N" banner, plus Promote and Reject for those allowed. |
| Compare | Unchanged. "Candidate vs its base" is the default comparison offered. |
| Comments | Unchanged: anchored to the candidate's version ID. A linked artifact's comment capture never commits onto a candidate. |
| Public link, Library, gallery | Unchanged, since they read current. |
| Agent dispatch | A bundle names the candidate's state and base version, so the agent knows it is commenting on unaccepted output. |
| Git mirror | See question 1. |

## Requirements (proposed IDs)

| ID | Kind | Behavior |
|---|---|---|
| CND-001 | behavior | A staged publish creates an immutable candidate version that does not move current. The stable link, public link, Library and default versions list are unchanged. |
| CND-002 | behavior | Promotion repoints current to the candidate's own version ID with no new version. It is idempotent and audited as its own action. |
| CND-003 | security | Promotion is refused when current no longer equals the candidate's base. A late build can never advance past newer accepted state. |
| CND-004 | security | Only a direct human principal with publication authority can promote. A service key or agent, delegated or not, can stage and comment but never promote. |
| CND-005 | behavior | Reject and supersede are terminal and keep the candidate's bytes, comments and provenance. Restore never targets a candidate. |
| CND-006 | behavior | Candidates are not mirrored; a version is mirrored when it becomes mainline or is promoted, with the previous mirrored version as its parent. A rejected candidate never becomes an ancestor on `main`. |

Each gets `-B`/`-F` acceptance in the usual shape. Amendments:
- VER-001 must say "each intentional publish creates a new immutable version; only a mainline publish or a promotion moves current".
- The Git-history spec's parent rule (`git-history-spec.md` lines 85 and 111: parent = previous version by number) becomes "parent = the previous mainline-or-promoted version".
- `git-history-mirror.ts`'s `predecessor-unavailable` check (lines 348–357) follows that rule.

## Cost

- **Schema:** the `state` and `base_version_id` columns, plus new CHECK values for action kinds and idempotency operations, in SQLite, Postgres and D1.
- **Commit:** a staged variant of `#applyVersionCommit` / `commitVersion` / D1.
- **Promote:** about restore's size, plus the base check.
- **Lists:** filtering and state in the versions list and its MCP tool.
- **Mirror:** the parent rule.
- **Review:** the banner and the Promote/Reject controls.
- **Dispatch:** the bundle fields.

No change to content delivery, public access, the Library, compare or comments storage.

## Owner decisions (2026-10-08)

1. **Git mirror.** Decided: candidates are not mirrored. A version is mirrored when it becomes mainline or is promoted, and its parent is the previous mirrored version. Under the strict base rule mainline numbers only increase, so the order stays linear. The alternative is to mirror candidates under `refs/candidates/<versionId>` so an agent can clone them, which costs operations and storage.
2. **Stale rule.** Decided: strict. Promote only when current equals the candidate's base. The alternative is to let promotion go through whenever the caller's `expectedCurrentVersionId` matches, even after current has moved past the base. That is faster for a reviewer, but it can silently discard an accepted change made in between.
3. **Who promotes.** Decided: only a direct human principal with publication authority. Service keys and agents, delegated or not, can stage and comment but never promote. A passing build is not acceptance. The alternative is a capability (`artifact:promote`) that can be granted to keys, which would allow fully automated promotion later.
4. **Rejected candidates.** Decided: keep them indefinitely with their comments, hidden from the default list, until T25 defines committed-blob GC. The alternative is a retention window, which needs version deletion, something the product does not have.
