# Handoff: Artifact Server after the Forms review pilot close-out

Written October 7, 2026. Artifact Server `main` is deployed to artifacts.backend.app on image `sha256:20712096d76b091eac0e36979c1a7dd8117a8f90659dd9c8f067f0faa2179476`. Design (`~/Dev/Design`) was at `2113960`. Recheck both before relying on anything below.

Read [AGENTS.md](AGENTS.md) first; its rules override anything here.

## What closed

**Forms review pilot hosted proof (DSN-007 … DSN-010).** `pnpm qualify:hosted:design-review` (`tests/hosted/`) drives the deployed server with the operator's existing CLI profile. It publishes one disposable artifact, deletes it with its comments afterwards, and registers no agent. Its evidence, `project/evidence/hosted-design-review-2026-10-07T1544Z.json`, is attached to DSN-007 … DSN-010 as `kubernetes` behavior and failure proof. The four requirements stay `behavior_verified`: single_server, cloudflare, aws and gcp have no evidence, and each proof gap names what is left.

**Upload failure behind the `arkcase` publish (PUB-021, PUB-022).** Production logs showed two causes:
- Node's default 300 s request timeout cut a slow upload body, although the staged write deadline is 10 minutes.
- Every interrupted body was mislabelled `StagingStorageFailure`, and the CLI turned every transport error into "could not be reached".

Now:
- The servers give a write its whole deadline.
- An interrupted body is `UPLOAD_INTERRUPTED` (408, resumable), with a redacted cause in the log.
- The CLI retries transient PUT and batch failures 4 times with jittered backoff, and names the file, the elapsed time and the transport code.

Design's `publish-all.sh` uses this repository's `dist/` CLI, so its next run gets the retries. **`arkcase` has not been republished yet.**

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

1. **DSN-011 hosted bundle delivery.** A principal has exactly one mailbox, so the operator's key cannot exercise it without renaming that mailbox. It needs a dedicated agent principal or a live native bridge reading a hosted Forms comment.
2. **Forms itself is not driven by an automated run.** DSN-008/009 hosted proof uses the fixture adapter. Design's Forms adapter is covered only by Design's manual Safari checks on v13.
3. **Republish `arkcase`** with `./publish-all.sh` from Design. If it still fails, the server log now says `UploadInterrupted` with a cause code, and the CLI prints the file and the transport error.
4. **For Design**, in its next `support.js` sync:
   - send `reason: "superseded"` for a replaced restore;
   - report `high-contrast` themes honestly, once the protocol has a value for them;
   - investigate Forms fetching relative to `about:srcdoc`, which the annotate CSP blocks (seen in the console on v13).
5. **Exported trace spans** still carry the raw provider error of a staging failure, including the staging path (PUB-021 proof gap).
6. **Open owner decisions** carried from the October 6 handoff: the browser `auth login` 404, the batch upload owner query parameter, not-found vs denied, CLI renewal errors, and Cloudflare Artifacts Gate 3. They are unchanged by this work.

## Decided

The review's in-frame toggle starts in Interact mode on every page, including designed pages. Reviewers click around before commenting. Only the preview-mode choice (Interactive preview vs Annotate) was a bug.

## Deploying

artifacts.backend.app follows GitOps:
- `image.yml` publishes a digest. Take it only from the workflow's "Print digest" step.
- `~/Workspace` pins it in `deployments/argocd/application-artifact-server.yaml` and `deployments/clusters/vps/artifact-server/helm-values.yaml`.
- A direct `kubectl` change is reverted by Argo.
