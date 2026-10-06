# Handoff: Artifact Server work after the October 6 Design pass

Written October 6, 2026 from a Design session. Artifact Server was at `19fea25` (clean, pushed). Design (`~/Dev/Design`) was at `7992c9b`. Recheck both before relying on anything below.

Read [AGENTS.md](AGENTS.md) first; its rules override anything here. These tasks come from [PLAN.md](PLAN.md) steps 2 and 3 and [NEXT.md](NEXT.md) ("Second milestone: Forms review prerequisites"). Design's side of the same work is in `~/Dev/Design/HANDOFF.md`.

## Task 1 (do first): close PLAN.md step 2 — ExtractionKit after-measurement

### Where it stands

Design has deferred ExtractionKit's data loading. The spec and plan are in Design:

- Spec: `docs/superpowers/specs/2026-10-06-extractionkit-deferred-data-tiers-design.md`
- Plan: `docs/superpowers/plans/2026-10-06-extractionkit-deferred-data-tiers.md`

The code commits are `d40fe74` (the Committed record dataset loads only when it is selected) and `f3095c5` (viewer data loads when a document surface first draws). Regeneration is in `ad2a321`. The owner has republished ExtractionKit to artifacts.backend.app.

Four modules (about 6.8 MB of fixtures, bytes unchanged) left the default open. They load on demand:

| Tier | Modules |
|---|---|
| `record` | `ek-data-record.js`, `ek-data-runs.js` |
| `viewer` | `ek-data-viewer.js`, `ek-data-design-pages.js` |

The "before" evidence is committed: `project/evidence/delivery-baseline-2026-10-06-hosted-before-ek-tiers.json` (`1ddbd7f`). It was captured at 16:25 UTC on image `sha256:82e98bd2993ef6f42b1da998575406b0308d47273ce9fb56b2b70af3ddc0e913`, from Artifact Server `c21a924` with a dirty tree.

Nothing after the publish has been recorded: no hosted spot check, no "after" report, and no FINDINGS.md section. This is Task 5 (steps 4–8) of the Design plan above. Follow it, with the correction below.

### The server has been redeployed since "before"

`~/Workspace/deployments/clusters/vps/artifact-server/helm-values.yaml` now pins `sha256:9a7d5033198515b7d4237afa5b51c47969e4ba3dcc4034adb2d40d67dc218772`. Three deploys followed the "before" run: the viewer navigation fix, the panel refinements and the invite links. A plain after-run would mix server changes with the Design change.

In order of preference:

1. **Measure both ExtractionKit versions back to back on the current image.** Old versions are immutable and still stored. First check whether the review route (or `perf:delivery --prototype-url`) can open a specific version. If it can, record a fresh `before-ek-tiers-rerun` against the prior version and `after-ek-tiers` against the current one, in the same sitting.
2. **If a version can't be pinned,** run only `after-ek-tiers`. State in the finding that the image differs from the "before" run and name both digests. Make no causal claim from that comparison alone.

### Steps

1. **Hosted spot check (plan step 5.4).** Open the ExtractionKit review URL (`artifact=art_a58bac0d-e1b1-401d-a548-eb26614bfcd8`, `path=project/Prototype - ExtractionKit.dc.html`).
   - The Runs list renders.
   - None of the four deferred files is requested on the default open.
   - Account menu → Demo controls → Committed record shows the committed runs.
   - Opening run-2026-0481's document draws the page.
   - Repeat the last two checks in **annotate mode**, whose `srcdoc` with `<base href>` is the risky path for dynamic loading.

   If anything fails, stop and report to Design. Don't measure a broken publication.
2. **Measure.** Five samples per journey, on the same machine and network as "before" (Apple M1 Max, unthrottled, Chromium 151). Use `--deployment-revision` with the digest actually deployed. The command is in the Design plan, step 5.5. Confirm that the four deferred files are absent from the after default open.
3. **Write the finding (plan step 5.6).** Add `## October 2026 ExtractionKit deferred data tiers (Design)` to `project/performance/FINDINGS.md` after the CNT-012 section, in the form of the existing sections:
   - the measurement statement
   - a cold/warm before/after table: ready median and range, FCP, transferred bytes, decoded bytes, requests
   - a paragraph on the change
   - a one-sentence verdict that claims no win from overlapping ranges
   - the follow-up recommendation
4. **Follow-up recommendation.** Report the remaining eager decoded bytes and `ek-data-design-record.js`'s 5.9 MB share of them. Recommend for or against hand-splitting that file, based on whether ready time still tracks decoded bytes.
   - That file is frozen source; its generator was deleted from `~/Dev/ExtractionKit`.
   - Any split happens in Design, as a hand-authored restructuring the owner must approve.
5. **Commit** the evidence and FINDINGS.md here. Push only if the owner asks.

## Task 2: Forms review pilot — PLAN.md step 3, NEXT.md second milestone

This is a two-repo task. **Write the contract before any code.** Nothing on either side implements it yet.

### What exists today

**Design (producer)**

- `workspace/projects/descriptors/arkcase-forms.js` exports `FORMS_SCENARIOS`: 23 `[id, name]` pairs (`1a` … `14`, `R`). Scenario 5 is `Inspector · Validation`.
- The descriptor's `configurations` maps the Storybook `scenario` control to the artboard's `scenario` prop.
- `arkcase-forms/project/Prototype - Form Builder.dc.html` steps through the scenarios with the DS `ScenarioBar` (`value={{ scId }}`, `onChange={{ goScenario }}`). The artboard's `SC` list must match `FORMS_SCENARIOS`.
- **A published page has no way to be told a scenario.** The `scenario` prop is set only through DC props and Storybook. There is no URL parameter or message path an outside host can use to open one.
- There are no region identities in the artboard. Nothing marks "the minimum-length field in scenario 5" as a stable target.
- Previews are published as `artifactserver.previews.json`, generated by `npm run build:previews` from the descriptors.

**Artifact Server (consumer)**

- `apps/web/src/review-frame/protocol.ts` uses `reviewProtocolVersion = 1`.
  - Host → frame: `as-review-init`, `-annotations`, `-theme`, `-annotate-mode`, `-focus`.
  - Frame → host: `as-review-ready`, `-submit`, `-select`, `-annotate-mode-request`, `-unanchored`.
- The stored anchor has three fields: `htmlAnchor`, up to 16 `htmlAdditionalTargets`, and `originalText`.
  - The server treats it as opaque.
  - The frame turns an anchor it doesn't recognise into `null`, which fails closed.
- `src/manifest/preview-index.ts` is strict: HTML paths only, no unknown fields, no duplicate paths. DSN-003-F and DSN-004-F test this. **Do not loosen it.**

### The joint spec should pin

Write it under `docs/superpowers/specs/` here or in Design, and get the owner's review before planning.

1. **Views document.** Pin:
   - its format name, version, and published file name (alongside, not inside, the preview index)
   - how Artifact Server discovers, validates and caches it per immutable version
   - what an unknown or invalid document does: the publication stays reviewable without views

   Design generates it from the descriptors and manifest. A second inventory kept by hand is not allowed.
2. **Identity rules.**
   - `viewId`: per artboard or route.
   - `scenarioId`: from `FORMS_SCENARIOS` ids, stable across versions.
   - `regionId`: emitted by Design as a marker in the artboard (for example a data attribute) on panels, fields and component instances.
   - `sourceRef`: the authored path and location.

   State what happens when an id disappears from a later version.
3. **Scenario restoration.** Define how a cooperating portable page receives "open scenario X" and reports success or failure, and decide between two ways to version that message:
   - a host message added to `protocol.ts` with a version bump, or
   - an additive message under v1.

   The Design side then needs a portable adapter in shared `dc-support/support.js` (synchronized with `sync:support`) or in the artboard. Its pieces:
   - one restore hook (`goScenario`)
   - a capture-view-state reply (version, view, scenario, viewport, theme, locale, direction, notes)
   - a ready signal that waits until restoration finishes
4. **Anchor extension.** Add view, scenario and region to the stored anchor so that older readers still parse it. Check what `z.object` does with unknown keys on read and on re-save. Keep the existing selector and text-quote fields as fallbacks. Add an explicit **"location unavailable"** state for an anchor whose scenario or region can't be restored. Comments stay attached to their original version.
5. **Source-provenance record.** Use the minimum content listed in NEXT.md ("Proposed source-provenance contract"). Keep three identities distinct:
   - the authored commit
   - the mirror commit
   - the Artifact Server version and manifest digest

   The producer records inputs and outputs. Artifact Server checks declared output paths against the immutable manifest. When coverage of dependency edges is incomplete, say so explicitly; don't present it as complete.
6. **Conformance.** Name new requirement IDs in `project/spec/conformance.yml`, with a normal (`-B`) and a hostile (`-F`) case for each, before implementation.

### Acceptance (from NEXT.md)

- Forms scenario 5 opens the Validation inspector reproducibly.
- An annotation on its minimum-length field reopens to that scenario and field.
- When restoration fails, the review says "location unavailable" rather than guessing.
- An agent can find the exact authored source and build inputs behind the reviewed output without editing generated mirrors.

### Who builds what, after the spec is approved

| Design | Artifact Server |
|---|---|
| Views document generator (a new `build:*` step wired into `check:source`) | Views document schema, validation and per-version loading |
| Region markers in the Forms artboard | Protocol extension and anchor storage |
| Portable restore and capture adapter in canonical `support.js` | Review UI: scenario switching, reopen to an anchor, "location unavailable" |
| Provenance record emitted at build/publish | Provenance validation against the manifest |

Producer and consumer can then proceed in parallel against the spec.

### Not yours to decide alone

- **Candidate publication model:** a separate candidate artifact, or a staged version within the artifact (NEXT.md, "Candidate publication and acceptance"). The Forms review pilot doesn't need this. The later review-to-change journey does.
- **Missing provenance:** whether it blocks only the editing pilot. Legacy publications must stay reviewable either way.

## Open decisions carried forward (context, not blockers)

These were waiting on the owner as of the October 6 Design handoff:

1. **Browser `auth login`:** returns 404, because no production entry point wires the API OAuth resource.
2. **Batch upload route:** takes its upload owner from a query parameter.
3. **Not-found vs denied:** distinguishable for a caller without read permission.
4. **CLI renewal errors:** reports any renewal failure as revoked.
5. **Cloudflare Artifacts Gate 3:** production configuration needs deployment authorization.

Recheck these. The invite-link work since then may have touched items 1 and 3.

## Deploying

artifacts.backend.app follows GitOps. `image.yml` publishes a digest, and `~/Workspace` pins it in:

- `deployments/argocd/application-artifact-server.yaml`
- `deployments/clusters/vps/artifact-server/helm-values.yaml`

Take the digest only from the workflow's "Print digest" step. The first `digest=` in the log is an intermediate build digest that does not exist in the registry. A direct `kubectl` change is reverted by Argo.

Design publishes with `./publish-all.sh`, which uses the CLI built from this repo's `dist/`. A local `pnpm build` therefore changes publishing behavior immediately.
