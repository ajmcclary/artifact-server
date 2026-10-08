# Handoff: Artifact Server after the Forms review pilot close-out

Written October 7, 2026, and updated after the late deploys. artifacts.backend.app runs image `sha256:6b4edff2864b65ac5993d7a802c1d13a19262cda6f4ab03550f1318baafa9d26` (Artifact Server `fcc8cc4`, Workspace `3297cbb2d`): all four server pods run it, Argo reports Synced and Healthy, and the served `review-BIBlQIRE.js` matches the local build. It carries the live-first Review with one Annotate switch, the live scenario carryover, repository failure redaction in spans, and the batch upload owner check. Design (`~/Dev/Design`) is at `5abcad7`. Recheck both before relying on anything below.

Read [AGENTS.md](AGENTS.md) first; its rules override anything here.

## Review never opens in Annotate (October 7, late, deployed from `a44e55e`)

The owner's rule: no screen ever starts in Annotate, because the annotation surface locks the page. Its opaque-origin sandbox and CSP block browser storage, links to the version's other files and scripts from other origins. That is why Forms v16's ScenarioBar and the ArkCase Training site's Get Started, Glossary and Downloads links did nothing. Since `e5159bb`, a page with designed views had been forced onto that surface.

- Every HTML page now opens live in Interactive preview on its content origin: plain, designed, scenario links and comment links alike (`preview-canvas.tsx`: the surface follows the switch).
- The toolbar pencil is the one switch (`AnnotateToggle`, `annotateToggleLabel` in `review-toolbar.tsx`). On mounts the annotation surface armed; off or Escape returns to the live page. The "Interactive preview | Annotate" segmented control and the in-frame Interact state are gone.
- Annotate belongs to the exact artifact, version and page it was turned on for (`annotatingScreen` in `review-app.tsx`). Any other screen arrives live.
- Explicit actions turn it on: Show in the artifact, a comment's Open scenario N, and choosing from the scenario picker, since only the annotation surface can restore a scenario.
- A reader who may not comment gets the same switch, labeled "Show comments on the page".
- The two surfaces are keyed iframes. Reusing one element navigated it, adding a history entry that Back replayed inside the frame; a gallery Back hung on it.
- The spec (`artifact-comments-spec.md` §9, the product spec's Review note) and the CMT-022 ledger text say this now. CMT-022-B gains a journey proving a designed page, a scenario link and a comment link all open live with Annotate off. The hosted Forms suite gains a check that Forms opens live and that its ScenarioBar works there.

The trade-off the owner chose: turning Annotate on reloads the page into the sandbox, so state reached by clicking around is lost unless it is a designed scenario the page can restore.

**Annotate reopens the scenario reached on the live page (owner approved relaxing CMT-022's no-bridge rule).** Review listens, read-only, to the Interactive preview frame: an unprompted `as-page-state` naming a scenario its views declare, from that frame's own content origin, becomes the requested scenario (`liveScenarioFrom` in `scenario-model.ts`, the listener in `preview-canvas.tsx`). The picker and URL follow the live page, and Annotate restores that scenario. Review never posts to the live page, so a scenario link still opens the live page at its default; turning Annotate on restores the linked scenario. Leaving Annotate clears what the sandbox had confirmed (`clearOnScreen`). Forms' adapter already posts to `window.parent` with `"*"`; Design was asked to keep that.

## Design's reply (`5abcad7`): Forms v17 re-pinned (October 7, late, not deployed; suite only)

Design answered the "Next for Design" list in its `HANDOFF.md` ("Next for Artifact Server"):
- **Unprompted live reports, confirmed.** Canonical `arkcase/project/dc-support/support.js` installs `installReviewAdapter` from `init()`. It posts to `window.parent` with `"*"` whenever the page has a parent, and a scenario-marker change posts `as-page-state` with `requestId: null`. Only scenario changes are reported, and the unprompted `state.props` is `{}`. A Design journey locks this in for a live page in a cross-origin frame.
- **The sandbox ScenarioBar defect was wider, and Forms v17 fixes it** (`ver_5307bd25-2457-4aa2-8638-6ee4d3679396`, from `8c2edea`, clean, provenance verified). A srcdoc page compiles its parser-lowercased template, so every imported component lost its camelCase props (`onChange`, `fieldDefs`, `ariaLabel`). v17's `ds-bundle.js` carries `window.__dcPropNames` and `support.js` restores them.
- **No eval probe on `about:` pages** in v17.

The hosted Forms suite now pins v17 (`tests/hosted/forms-review.hosted.spec.ts`):
- **The `test.fail` ScenarioBar test could never pass on any Forms after `7b1c407`.** The armed annotation surface owns page clicks in pinpoint mode (`@plannotator/ui` `bridge-script.ts`: "Suppress the page's own behavior … we're annotating"). In the v17 rehearsal, Next opened the comment composer, and the page stayed on its scenario, without or with a restore, while `__fb.go()` worked. Design's own sandbox harness has no overlay, which is why its journey passes. The test is replaced by one that restores scenario 6 on the annotation surface and checks that its rule editor draws "Add Condition" and the "Review Required" field picker, which v16 drew empty there. The ScenarioBar itself is proved on the live page (CMT-022-B).
- **The CSP check is now strict:** no frame may report any violation. The eval-fallback allowance is gone, because v17 reported none, live or sandboxed.
- **Local rehearsal:** 16/16 (8 per engine, Chromium and WebKit) against a local server with v17 read read-only from hosted. It used a temporary harness that is not committed: plain-http localhost refuses the `__Host-` CSRF cookie in Chromium. **Nothing hosted has run.**

**Two corrections from Design, both owner decisions here, not adopted:**
- **Forms' live page answers `as-page-restore` from its parent in Interactive preview** (restore to 5 → `as-page-restored ok:true`). The picker, "Open scenario N" and "Show in the artifact" could restore on the live page instead of reloading into Annotate, so a reviewer would keep the live page. That means Review posting into the live page, which CMT-022 still forbids. The owner relaxed only the read-only listener.
- **Forms ignores `?scenario=` in its URL.** That matches what Review does today: a scenario link opens the live page at its default, and turning Annotate on restores the linked scenario. Live restore would make a scenario link show its scenario without Annotate.

## What closed since the October 7 morning deploy

Both changes are deployed: all four server pods run the new digest, Argo reports Synced and Healthy at `7a5fc6c`, and the served `protocol` chunk accepts `high-contrast`.

**Exported trace spans no longer carry the staging path (PUB-021).** Effect's OTLP tracer renders a failed span's whole `cause` chain into its `exception.stacktrace`, so a staging failure exported the raw provider error, including the staged file's path, which contains the upload's storage token (a write key). Staging and blob storage failures and interrupted uploads are now built from `redactedFailureCause` (`src/observability/failure-cause-summary.ts`): each level's name, code and redacted message, three levels deep, with no stack frames or other properties. In `tests/http/staged-upload-transport.test.ts`, the PUB-021-F test (an interrupted body) and the genuine-storage-failure test read every signal a loopback OTLP collector receives and prove that no exported log, span or metric carries the storage token; the storage-failure test also checks the upload ID and the data directory. The PUB-021 proof gap is updated. Repository failures (`ArtifactRepositoryFailure`, `IdentityRepositoryFailure`) now carry the same redacted copy; `tests/http/repository-failure-telemetry.test.ts` proves it with a locked SQLite database.

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

## Since Design's `bda4eba` report (October 7 evening, deployed from `2404da6`)

**A restore sets the scenario, not the theme (contract amendment 8).** The page protocol is unchanged, and the review frame never posts Design's `arkcase:theme`. Theme, viewport, locale and direction in a stored `view.state` describe the reviewer's surroundings: a reviewer's theme can be an accessibility setting. So that a reopened comment never shows another theme silently, a thread whose view block (for the view on screen) stored `dark` or `high-contrast` now says "Made in the dark theme" or "Made in high contrast" (`capturedThemeText` in `apps/web/src/review/workspace/scenario-model.ts`, shown by `ThreadLocation` in `comments-tab.tsx`). The scenario fixture now reports `high-contrast` while the browser prefers more contrast, and a DSN-009-B journey captures in high contrast and reopens without it. A `theme` field on `as-page-restore` would stay additive if owners later want restores to apply it.

**The hosted suite drives Forms itself** (`tests/hosted/forms-review.hosted.spec.ts`, `tests/hosted/pinned-copy.ts`). It reads Forms v16 (`ver_c4301bda…`, pinned, never "current"), checks every file's SHA-256 against the source manifest, and publishes the bytes as its own disposable artifact. It then checks a small Forms table (scenario 5, region `inspector.validation.min-length` "Min length", 6 after 5) against the views document, failing with "re-pin Forms" on a mismatch. On the copy it proves, in Chromium and WebKit:
- views `valid` and provenance `verified` on real Design output;
- the picker and a `scenario=` link;
- rapid picker changes with no failure;
- a cold context's hello;
- a region comment captured in high contrast (through `emulateMedia({contrast: "more"})`, the reviewer's own route) that stores `view.state.theme: "high-contrast"` and reopens in its scenario saying "Made in high contrast";
- no content security policy violation in any frame except Forms' deliberate `eval` probe. The check reads `securitypolicyviolation` events, so it names the document and directive. An injected inline `<style>` was confirmed to fail it.

The hostile cases stay on the fixture. A local rehearsal (the same spec against a local server, with Forms read from hosted) passed 7/7 in both engines. **Nothing hosted has run.**

**Forms' ScenarioBar did nothing in an opaque-origin sandbox** (Forms v16). Design fixed the cause in v17; see "Design's reply" above for why the suite no longer clicks it on the annotation surface.

**The `style-src` refusal from Design's v16 check does not reproduce.** Hosted Forms v16, opened read-only in Chromium and WebKit with a listener in every frame, shows only Forms' `script-src eval` probe (`support.js:848`, its `new Function` attempt before the inline fallback). Every stylesheet comes from an allowed origin. The review frame and the sandbox both allow inline styles, and only the top-level application (`style-src 'self'`) refuses them; the app adopts its runtime styles as constructable sheets. The likely source is something in that Safari session (an extension or automation overlay) adding an inline `<style>` to the top document. Design can confirm by logging `securitypolicyviolation` events in Safari.

## Still open

1. **Hosted run of the Forms suite.** The suite pins Forms v17 and rehearsed 16/16 locally; the run itself needs the owner's approval. Run `ARTIFACT_SERVER_HOSTED_REVISION=<digest> pnpm qualify:hosted:design-review`, then attach the evidence to DSN-007 … DSN-010 and update DSN-009's proof gap, which still says Forms is covered only by Design's manual check.
2. **Restore on the live page?** Design's correction above: Forms answers `as-page-restore` in Interactive preview, so Review could restore a scenario without reloading into Annotate. That needs the owner to relax CMT-022 further (Review posting to the live page), plus a spec amendment, journeys and a rule for pages that never answer.
3. **DSN-011 hosted bundle delivery.** An owner decision between a dedicated agent principal (recommended) and a live native bridge. See [docs/superpowers/plans/2026-10-07-hosted-dsn-011-and-forms-adapter.md](docs/superpowers/plans/2026-10-07-hosted-dsn-011-and-forms-adapter.md). If it lands, the dispatch can use the Forms suite's comment.
4. **Open owner decisions from October 6, rechecked against the code on October 7 and unchanged:**
   - **Browser `auth login` 404 (CLI-001).** No production entry point sets `apiOAuthResource`, and ADR 0028 left it unset on purpose. The CLI already says to use `--api-key-stdin`; `docs/cli.md` still describes a browser login.
   - **Not-found vs denied (MCP-009).** Reads look up the artifact before checking read permission. A service principal with project access but no read permission therefore sees 404 for a missing artifact and 403 for an existing one.
   - **CLI renewal errors (CLI-001).** `refreshCliOAuthCredential` maps every failure, including a network failure or a 5xx, to `credential_revoked`. It is only reachable where the API OAuth resource is wired.
   - **Cloudflare Artifacts Gate 3.** Production configuration needs deployment authorization.

## Next for Design

Design is at `5abcad7`. Nothing here needs a schema re-pin.

1. **v17 is re-pinned and its fixes hold here.** On Artifact Server's annotation surface, scenario 6's rule editor draws in full, and no frame reports a CSP violation, live or sandboxed. No Design change is needed.
2. **Annotate owns page clicks.** The armed surface suppresses a page click in pinpoint mode to place a comment, so no page control (the ScenarioBar included) works while annotating. That is by design: the reviewer turns the pencil off to use the page. Design's sandbox journeys stay the proof of the fix itself.
3. **Keep posting unprompted `as-page-state` to `window.parent` with `"*"`.** Review's live-scenario carryover depends on it.
4. **Live restore is not adopted yet** (owner decision, "Still open" item 2). Until it is, Review never posts to the live page, and Forms' default-on-load behavior for `?scenario=` is fine.
5. **The `style-src` refusal** did not reproduce under Chromium or WebKit on hosted v16. If it appears again in Safari, log `securitypolicyviolation` events (document, `effectiveDirective`, `sourceFile`) to name the frame.

## Decided

Review never opens a page in Annotate, in any circumstance (owner, October 7). Pages open live in Interactive preview, and the pencil is the one switch to the annotation surface. This replaces the earlier note that designed pages should open on the Annotate surface.

A restore sets the scenario, not the theme (contract amendment 8).

## Deploying

artifacts.backend.app follows GitOps:
- `image.yml` publishes a digest. Take it only from the workflow's "Print digest" step.
- `~/Workspace` pins it in `deployments/argocd/application-artifact-server.yaml` and `deployments/clusters/vps/artifact-server/helm-values.yaml`.
- A direct `kubectl` change is reverted by Argo.
