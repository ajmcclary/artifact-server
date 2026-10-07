# Handoff: Artifact Server after the Forms review pilot close-out

Written October 7, 2026 (updated after Design's `1632239` handoff). artifacts.backend.app runs image `sha256:e5b19d0e160bec5fc311c73f9d905d66cb83dbca688d718643fc32571383f47a` (Artifact Server `7a5fc6c`, Workspace `543140cf3`), which includes the two changes under "What closed since the October 7 morning deploy". Design (`~/Dev/Design`) is at `1632239`. Recheck both before relying on anything below.

Read [AGENTS.md](AGENTS.md) first; its rules override anything here.

## What closed since the October 7 morning deploy

Both changes are deployed: all four server pods run the new digest, Argo reports Synced and Healthy at `7a5fc6c`, and the served `protocol` chunk accepts `high-contrast`.

**Exported trace spans no longer carry the staging path (PUB-021).** Effect's OTLP tracer renders a failed span's whole `cause` chain into its `exception.stacktrace`, so a staging failure exported the raw provider error, including the staged file's path, which contains the upload's storage token (a write key). Staging and blob storage failures and interrupted uploads are now built from `redactedFailureCause` (`src/observability/failure-cause-summary.ts`): each level's name, code and redacted message, three levels deep, with no stack frames or other properties. In `tests/http/staged-upload-transport.test.ts`, the PUB-021-F test (an interrupted body) and the genuine-storage-failure test read every signal a loopback OTLP collector receives and prove that no exported log, span or metric carries the storage token; the storage-failure test also checks the upload ID and the data directory. The PUB-021 proof gap is updated. Repository failures (`ArtifactRepositoryFailure`, `IdentityRepositoryFailure`) still export their raw driver error in spans; the same helper would close that.

**`high-contrast` is a page theme (contract amendment 7).** `state.theme` accepts `light`, `dark` or `high-contrast` in page messages and in a stored anchor's `view.state`: `apps/web/src/review-frame/page-protocol.ts` (`pageThemeSchema`, reused by `protocol.ts`), `src/mcp/dispatch-bundle-message.ts`, and the `@plannotator/agent-bridge` patch. It stays additive under `pageVersion 1`. The pinned JSON schemas (`views.v1`, `source-provenance.v1`) have no theme field and are unchanged, so Design does not re-pin. artifacts.backend.app now accepts it, so Design can send it. A server older than `7a5fc6c` drops a page state carrying it, and a restore in high contrast there reads as "didn't confirm it in time".

**Reported by Design (`1632239`), live from Forms v14.** `support.js` sends `reason: "superseded"` for a replaced restore (amendment 1), and Design's runtime no longer fetches `location.href` on `about:` pages, so the `about:srcdoc` CSP violation on Forms is gone. Forms is v15 (`art_743d037f-dba7-4051-ad8f-4eda916a9661`). `arkcase` republished without retries: the stuck upload completed as v17, and it is now v19. All eleven Design targets are published from Design `202d647`, including a new `arkcase-training` artifact (`art_521dc055-c674-48c3-a3b4-00ad578b3f00`).

## What closed earlier on October 7

**Forms review pilot hosted proof (DSN-007 … DSN-010).** `pnpm qualify:hosted:design-review` (`tests/hosted/`) drives the deployed server with the operator's existing CLI profile. It publishes one disposable artifact, deletes it with its comments afterwards, and registers no agent. Its evidence, `project/evidence/hosted-design-review-2026-10-07T1544Z.json`, is attached to DSN-007 … DSN-010 as `kubernetes` behavior and failure proof. The four requirements stay `behavior_verified`: single_server, cloudflare, aws and gcp have no evidence, and each proof gap names what is left.

**Upload failure behind the `arkcase` publish (PUB-021, PUB-022).** Production logs showed two causes:
- Node's default 300 s request timeout cut a slow upload body, although the staged write deadline is 10 minutes.
- Every interrupted body was mislabelled `StagingStorageFailure`, and the CLI turned every transport error into "could not be reached".

Now:
- The servers give a write its whole deadline.
- An interrupted body is `UPLOAD_INTERRUPTED` (408, resumable), with a redacted cause in the log.
- The CLI retries transient PUT and batch failures 4 times with jittered backoff, and names the file, the elapsed time and the transport code.

Design's `publish-all.sh` uses this repository's `dist/` CLI, so its runs get the retries. `arkcase` has since been republished (see above).

**Scenario restore reliability (DSN-008).**
- The hello window now opens at the sandbox's `load`, as the contract always said, with a 20 s cap.
- A late hello still receives the requested scenario.
- A superseded restore ends silently, and `pageVersion 1` gains an additive `superseded` reason.
- A page that may prefer Interactive waits for its views before choosing a mode.
- A failed `/views` read is retried.
- Failures are told in words.
- Back and forward follow `scenario=`.

These are recorded in the contract spec's "Amendments after the hosted pilot".

**Deferred minor findings.** All five listed on the Artifact Server side are fixed. The bundle's view-block check now matches the web's, and control characters no longer reach agents. The `runClientCommand` exit-vs-close race is fixed too.

## Still open

1. **DSN-011 hosted bundle delivery.** An owner decision between a dedicated agent principal and a live native bridge. The MCP mailbox's connection key is derived from the principal, so the operator's key can hold only one mailbox; a native bridge registers under its own key (a hash of hostname and working directory) and would not rename it. Options, costs and a recommendation: [docs/superpowers/plans/2026-10-07-hosted-dsn-011-and-forms-adapter.md](docs/superpowers/plans/2026-10-07-hosted-dsn-011-and-forms-adapter.md).
2. **Forms itself is not driven by an automated run.** DSN-008/009 hosted proof uses the fixture adapter, and Design's Forms adapter is covered only by Design's manual Safari checks. The same plan copies a pinned Forms version into the suite's disposable artifact; nothing hosted has run.
3. **Repository failures export their raw driver error in trace spans** (see PUB-021 above).
4. **For Design**, in its next `support.js` sync: report `high-contrast` from `data-theme="high-contrast"` instead of folding it into `light`.
5. **Open owner decisions** carried from the October 6 handoff: the browser `auth login` 404, the batch upload owner query parameter, not-found vs denied, CLI renewal errors, and Cloudflare Artifacts Gate 3. They are unchanged by this work.

## Decided

The review's in-frame toggle starts in Interact mode on every page, including designed pages. Reviewers click around before commenting. Only the preview-mode choice (Interactive preview vs Annotate) was a bug.

## Deploying

artifacts.backend.app follows GitOps:
- `image.yml` publishes a digest. Take it only from the workflow's "Print digest" step.
- `~/Workspace` pins it in `deployments/argocd/application-artifact-server.yaml` and `deployments/clusters/vps/artifact-server/helm-values.yaml`.
- A direct `kubectl` change is reverted by Argo.
