# Forms review pilot contract — design

Date: 2026-10-06
Status: approved (written spec reviewed 2026-10-06)
Source: [HANDOFF.md](../../../HANDOFF.md) Task 2, [PLAN.md](../../../PLAN.md) steps 2–4, [NEXT.md](../../../NEXT.md) "Second milestone: Forms review prerequisites", and the brainstorming conversation of 2026-10-06.

## Intent

A reviewer opens ArkCase Forms scenario 5, annotates the minimum-length field in its Validation inspector, and anyone reopening that comment lands in the same scenario on the same field. When that state cannot be rebuilt, the review says so. An agent handed the comment can find the exact authored source and build inputs behind what was reviewed.

This document is the contract between the producer (Design, `~/Dev/Design`) and the consumer (Artifact Server). Neither side implements anything until the owner approves it. After approval, both sides build against it in parallel.

### What the owner decided

- **The pilot runs in the annotate frame.** The existing `srcdoc` review frame, protocol and annotation surface are extended. Annotation inside the interactive (content-origin) frame remains PLAN.md step 4.
- **Versioning.** Host ↔ review frame messages are added under protocol `v: 1`. The review frame ↔ page adapter channel carries its own `pageVersion`, negotiated at hello, because adapters are frozen inside immutable published versions.
- **Missing provenance blocks only the later editing pilot.** Review, annotation and scenario restore never depend on provenance. Without it, agent handoff is inspection-only.
- **The views document is validated on read (approach A).** The server reads the producer's file from the exact version, validates it against that version's manifest, and caches the outcome per version. There is no publish-time derived index. Publish-time derivation (approach B) was rejected because only the CLI would run it and earlier versions would never gain views.

### Success criteria (NEXT.md acceptance)

1. Forms scenario 5 opens the Validation inspector reproducibly, from the scenario picker and from a `scenario=5` link.
2. An annotation on its minimum-length field reopens to scenario 5 with its marker on that field.
3. When the scenario or region cannot be restored, the thread says "Location unavailable" with the reason, and no marker is placed by guesswork.
4. An agent can identify the authored repository, commit, source paths and build inputs behind the reviewed output, and see whether the published bytes match what the producer declared, without editing generated mirrors.

DSN-007 to DSN-011 below each have passing normal and hostile tests with evidence attached to the ledger. `pnpm verify:iteration` and the cross-engine critical browser matrix pass.

### Findings this design rests on

- The review protocol exists only in annotate mode. Interactive preview is a bare content-origin iframe with no message channel (`apps/web/src/review/workspace/preview-canvas.tsx`).
- The annotate frame's content security policy allows scripts only from the application and the configured content hosts. This is deliberate: the lease host must stay the only remote script source (`reviewFrameContentSecurityPolicy` in `src/http/create-http-app.ts`). The Form Builder loads React from cdnjs and unpkg, so today it cannot boot there. ExtractionKit fails the same way (`project/performance/FINDINGS.md`, "October 2026 ExtractionKit deferred data tiers").
- Design's portable runtime already resolves its React URLs through `window.__resources`, and exposes `__dcSetProps` / `runtime.setProps`. The Form Builder switches scenario when its `scenario` prop changes (`componentDidUpdate` → `go`).
- The descriptor `workspace/projects/descriptors/arkcase-forms.js` already maps the Storybook `scenario`, `direction` and `notes` controls to the props `scenario`, `chromeRtl` and `showNotes`.
- The descriptor's `review.scenarios` are test journeys (`forms-palette-insert`), not designed states. This document calls `FORMS_SCENARIOS` entries **designed scenarios** and the descriptor's `review.scenarios` **journeys**.
- The server stores comment anchors as opaque JSON up to `maximumCommentAnchorBytes` (16,384), validating only a top-level `point`. The thread update API can replace an anchor. The web client never sends an anchor back. The installed zod (4.4) strips unknown keys in `z.object`.
- Every manifest entry carries a SHA-256, so declared outputs can be checked byte for byte.

## 1. The views document

### File and format

Design publishes `artifactserver.views.json` at the publication root, next to `artifactserver.previews.json`. The preview source and its strict index (DSN-003, DSN-004) are not changed.

```json
{
  "format": "artifact-server.views",
  "version": 1,
  "views": [
    {
      "viewId": "arkcase-forms/form-builder",
      "path": "project/Prototype - Form Builder.dc.html",
      "label": "ArkCase Forms · Form Builder",
      "sourceRef": {"path": "arkcase-forms/project/Prototype - Form Builder.dc.html"},
      "defaultScenarioId": "1a",
      "scenarios": [
        {"scenarioId": "5", "label": "Inspector · Validation", "props": {"scenario": "5"}}
      ],
      "parameters": [
        {"name": "direction", "prop": "chromeRtl", "default": "ltr",
         "values": [{"value": "ltr", "propValue": false}, {"value": "rtl", "propValue": true}]},
        {"name": "notes", "prop": "showNotes", "default": true,
         "values": [{"value": true, "propValue": true}, {"value": false, "propValue": false}]}
      ]
    }
  ]
}
```

Design generates the file with a new `build:views` step from the descriptors and `workspace/projects/manifest.js`, and `check:source` fails when the published file is stale. Nobody edits it by hand, and no second inventory is kept.

### Validation (version 1)

Parsing is strict, like the preview index: excess properties are errors and every error is reported.

| Field | Rule |
|---|---|
| `format`, `version` | Exactly `artifact-server.views` and an integer. Version 1 is the only supported version. |
| `views` | 1–200 entries. |
| `viewId` | `^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$`, at most 128 characters, unique in the document. |
| `path` | A normalized manifest path of an HTML entry in this version. At most one view per path. |
| `label` | Single-line display text, no control or format characters, at most 200 characters. |
| `sourceRef` | `{path, line?}`. A relative path with no `..` segment, at most 1,024 characters; `line` is a positive integer. |
| `scenarios` | 1–200 entries. `scenarioId` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$` and is unique within the view. `label` follows the label rule. |
| `props` | 1–16 keys matching `^[A-Za-z_][A-Za-z0-9_]{0,63}$`. Values are strings of at most 256 characters, finite numbers or booleans. |
| `defaultScenarioId` | Names one of the view's scenarios. |
| `parameters` | 0–8 entries with unique `name` and `prop`. Each has 2–16 `values` with unique `value`, and a `default` that is one of them. A parameter's `prop` must not appear in any scenario's `props`. |

### Consumption

On the first request for a version's views, the server reads `artifactserver.views.json` from that exact version and validates it against that version's manifest. The outcome is a pure function of the version's bytes and the document's declared format version:

- `valid`, with the parsed views
- `absent`, when no file exists
- `unsupported-version`
- `invalid`, with a bounded diagnostic listing the failing fields

The server may compute the outcome at most once per version per process and may persist it; versions are immutable, so the outcome never changes. A version whose document is valid under a supported format version is never later rejected by a newer validator.

Any outcome other than `valid` leaves the version reviewed exactly as it is today: no scenario picker, no restore, and anchors captured without a `view` block. The diagnostic is shown only to people who can manage the artifact.

The views are readable at `GET /api/v1/artifacts/{artifactId}/versions/{versionId}/views?projectId=…` with the same authorization as reading the version. The file never selects a storage location: `path` is checked against the manifest and resolved only through the version's existing file routes.

Artifact Server publishes the version 1 rules as a JSON Schema in `docs/`. Design's `check:source` validates the generated file against that schema, to catch producer mistakes before publication.

## 2. Identity rules

| Identity | Defined by | Stability |
|---|---|---|
| `viewId` | `<descriptorId>/<entry>`, from the descriptor id and the entry's kebab-cased export name. | Stable for as long as the artboard exists. |
| `scenarioId` | Exactly the `FORMS_SCENARIOS` id (`5`, `10c`, `R`). | Stable across versions. The artboard's own `SC` list must keep matching `FORMS_SCENARIOS`; Design's checks already require that. |
| `regionId` | A `data-review-region` attribute rendered by the artboard on panels, fields and component instances. Dotted lowercase segments matching `^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$`, at most 128 characters (for example `inspector.validation.min-length`). | Stable for as long as the region exists. Regions are discovered at runtime and are not listed in the views document. |
| `sourceRef` | `{path, line?}` relative to the authored repository. | Describes one version; the commit comes from provenance (section 6). |

The artboard also renders `data-review-scenario="<scenarioId>"` on its root element, reflecting the scenario actually on screen.

A region id that appears more than once in one rendered scenario is **ambiguous**. Capture never records it, and reopen treats it as unavailable.

**When an id disappears.** A comment stays on the version it was written on, so that version always still contains the ids its anchors name. A producer may retire an id but must never reuse it for a different view, scenario or region. In this pilot, nothing assumes that the same id on two versions means the same thing. Placing a comment on another version is out of scope.

## 3. Scenario restoration

### Host ↔ review frame (protocol `v: 1`, additive)

| Direction | Message | Fields |
|---|---|---|
| Host → frame | `as-review-restore` | `requestId`, `viewId`, `scenarioId`, `props` (the scenario's `props` merged with the requested parameters' `propValue`s) |
| Host → frame | `as-review-capture` | `requestId`, `props` (the prop names the view declares) |
| Frame → host | `as-review-view-state` | `requestId` (or `null` for an unprompted report), `outcome` (`restored`, `failed`, `unsupported`), `reason` (`timeout`, `scenario-mismatch`, `no-adapter`, `adapter-error`, optional), `state` (or `null`) |

Both sides ship in one web build, and each already drops message types it does not recognize, so no version bump is needed. Message schemas are added to `apps/web/src/review-frame/protocol.ts`.

### Review frame ↔ page adapter (`pageVersion: 1`)

| Direction | Message | Fields |
|---|---|---|
| Page → frame | `as-page-hello` | `pageVersion` (highest supported), `capabilities` (`restore`, `capture`) |
| Frame → page | `as-page-welcome` | `pageVersion` (the lower of the two sides' highest versions) |
| Frame → page | `as-page-restore` | `requestId`, `props` |
| Page → frame | `as-page-restored` | `requestId`, `ok`, `reason` (optional), `state` |
| Frame → page | `as-page-capture` | `requestId`, `props` (names) |
| Page → frame | `as-page-state` | `requestId` (or `null` when the page reports a change on its own), `state` |

`state` is `{pageVersion, scenarioId, props, viewport: {width, height}, theme, locale, direction}`:

- `scenarioId` is read from `data-review-scenario`, or is `null` when the marker is missing.
- `props` holds the current values of the requested prop names.
- `theme` is `light` or `dark`.
- `locale` is the document's `lang`, or `null`.
- `direction` is the root element's computed direction.

The host maps `props` back to parameter values using the views document. The page never sees `viewId` or labels.

### The adapter (Design)

The adapter lives once, in canonical `arkcase/project/dc-support/support.js`, and `sync:support` copies it to every project.

- **Hello.** After boot, it sends `as-page-hello` to `window.parent`. It listens only for messages whose `source` is `window.parent`.
- **Restore.** It applies `props` with `runtime.setProps(rootName, props)`. It answers `ok: true` only after `data-review-scenario` equals the requested scenario and two animation frames have passed. After 5 seconds it answers `ok: false, reason: "timeout"`.
- **Capture.** It answers from the live page.
- **Changes.** It reports every change of `data-review-scenario` as an unprompted `as-page-state`, at most once per animation frame.
- **Failure handling.** It never throws into the page; adapter errors become `ok: false, reason: "adapter-error"`.

### Trust

- The review frame accepts page messages only when `event.source` is its own sandbox window, after schema validation, with strings capped at 256 characters and at most 16 props.
- The host sends `as-review-restore` only for a `viewId` and `scenarioId` in the version's `valid` views document, built from that document's own `props`.
- Page-reported state is evidence, not authority. A restore whose confirmed `scenarioId` differs from the request is `failed` with `scenario-mismatch`. A captured `scenarioId` outside the views document is treated as no scenario.

### Ordering and absence

On open, the host first restores the scenario named by the URL or by the thread being opened. When neither names one, it sends `as-review-capture` instead, to learn which scenario is on screen. It sends the annotations only after `as-review-view-state` arrives, so markers are located in the known state. This is the "ready waits for restoration" rule.

A reviewer can also change scenario from inside the page, through the artboard's own ScenarioBar. The adapter watches `data-review-scenario` and sends an unprompted `as-page-state` (`requestId: null`) whenever it changes. The frame relays it as `as-review-view-state` with `requestId: null`, and the host re-sends the annotations so that markers follow the scenario on screen.

If no `as-page-hello` arrives within 3 seconds of the sandbox's load, the outcome is `unsupported` with reason `no-adapter`. The review then behaves exactly as today and the scenario controls stay hidden.

### Review UI

- When the open path has a `valid` view, the toolbar shows a scenario picker listing the designed scenarios by label.
- Choosing one restores it and writes `scenario=<scenarioId>` into the review URL. `workspaceHref` places it after `path`. The view is implied by the path, since there is at most one view per path. The existing `view=focus` parameter keeps its meaning.
- A failed restore keeps the current page and says "Couldn't open scenario 5" with the reason. It never shows a different state silently.

### Design-side prerequisite

The Form Builder must boot in the annotate sandbox using only scripts in its own publication. Design ships React and ReactDOM inside the publication and points `window.__resources` at those copies before `support.js` loads them. The artboard's head `<script>` tags must not depend on a public CDN either. The annotate frame's content security policy does not change.

## 4. Anchor extension

### Stored shape

`reviewAnchorSchema` keeps `htmlAnchor`, `htmlAdditionalTargets` and `originalText` unchanged; they are the fallback location. One optional block is added:

```json
"view": {
  "viewFormat": 1,
  "viewId": "arkcase-forms/form-builder",
  "scenarioId": "5",
  "regionId": "inspector.validation.min-length",
  "regionLabel": "Minimum length",
  "state": {
    "viewport": {"width": 1440, "height": 900},
    "theme": "light", "locale": "en", "direction": "ltr",
    "parameters": {"direction": "ltr", "notes": true}
  }
}
```

- `regionId` and `regionLabel` are optional.
- `regionLabel` comes from the region element's accessible name or text. It is capped at 64 characters, with bidirectional overrides, zero-width characters and control characters removed.
- The whole anchor stays within 16,384 bytes. The server keeps treating it as opaque.

### Compatibility

- A reader built before this change parses the anchor with today's `z.object`, which drops `view`. That anchor then behaves exactly as an anchor does today. No such reader writes anchors back.
- The web client's anchor read path becomes a loose parse that preserves unknown keys. Only the `view` block is validated strictly; an invalid `view` block is treated as absent, not as a broken anchor.
- New rule for every client of the thread update API: a client that replaces an anchor must preserve fields it does not recognize. The API documentation states it, and DSN-009-F tests it on the web client and MCP.

### Capture

When a reviewer submits an annotation, the review frame requests capture and then builds the anchor:

1. `scenarioId` is recorded only if the page reported it and it is in the version's `valid` views document. Otherwise the anchor has no `view` block at all.
2. The region is the target element's nearest ancestor-or-self carrying `data-review-region`. It is recorded only if exactly one element in the document carries that id.
3. `state.parameters` maps captured props back to declared parameter values. Undeclared props are not stored.

### Reopen

For each thread on the open version, in order:

1. **No `view` block:** it is placed exactly as today.
2. **A different scenario from the one on screen:** it is listed as "In scenario 5 · Open" without a marker. This is not a failure.
3. **Opening it:** the host restores its scenario and parameters. If restore is `failed` or `unsupported`, the thread shows **"Location unavailable: scenario 5 couldn't be opened"** with the reason.
4. **With a `regionId`:** the frame looks for that id among the page's region markers. If exactly one element matches, the marker is placed there; the stored `point`, if any, is applied relative to that element. If none or several match, the thread shows **"Location unavailable: the region isn't on the page"**. The CSS selector is not tried: it was captured in this same state, so falling back to it would be a guess.
5. **Without a `regionId`:** the existing selector and text-quote placement runs inside the restored scenario.

`as-review-unanchored` gains an optional `reasons` map from thread id to `region-missing` or `region-ambiguous`. Restore failures are already known to the host from `as-review-view-state`.

Threads stay on their original version. The existing "follow a comment to its version" behavior opens that version, then restores.

## 5. Agent context

Comment bundles delivered through the agent bridge gain, per comment, a `location` object with:

- `viewId`
- `scenarioId` and its label
- `regionId` and `regionLabel`
- `sourceRef`

Each bundle's version also gets a `provenance` summary: outcome, repository, commit, `dirty`, and coverage.

Every text field passes through the existing bridge sanitizer (bidirectional overrides and zero-width characters stripped). The MCP read of a version returns its views outcome and provenance outcome. The adapters in `integrations/` render the new fields as follow-up input only, per the bridge protocol.

## 6. Source provenance

### File and format

Design publishes `artifactserver.provenance.json` at the publication root, generated by a new `build:provenance` step at build and publish time:

```json
{
  "format": "artifact-server.source-provenance",
  "version": 1,
  "source": {"repository": "https://github.com/<owner>/Design", "commit": "<40 hex>",
             "dirty": false, "descriptorId": "arkcase-forms"},
  "build": {"recipe": "publish-all", "recipeRevision": "<40 hex>",
            "lockfileSha256": "<64 hex>", "toolchain": {"node": "v24.15.0", "npm": "11.6.0"},
            "dsRevision": "<40 hex>", "renderer": {"name": "dc-support", "sha256": "<64 hex>"}},
  "inputs": [{"path": "arkcase-forms/project/Prototype - Form Builder.dc.html", "sha256": "<64 hex>"}],
  "outputs": [{"path": "project/Prototype - Form Builder.dc.html", "sha256": "<64 hex>",
               "sources": [{"path": "arkcase-forms/project/Prototype - Form Builder.dc.html"}]}],
  "coverage": {"dependencyEdges": "partial", "externalVariability": [], "notes": "…"}
}
```

- `dirty` is `true` when any uncommitted file fed the build.
- `dependencyEdges` is `complete`, `partial` or `none`. Producers that cannot enumerate every edge say so, and conservative target-wide invalidation stays their responsibility.
- The record never contains the version's manifest digest, Artifact Server version id or mirror commit. Those identities are recorded by the server and by the history mirror. The three stay distinct: the **authored commit** (this record), the **mirror commit** (published-history service), and the **Artifact Server version and manifest digest**.

### Validation

Validation is strict, with bounded sizes:

- at most 5,000 inputs and 5,000 outputs
- paths: relative, no `..`, at most 1,024 characters
- commits: 40 hex characters; digests: 64 hex characters
- the repository: an `https` URL with no credentials or query

Like views, the record is read from the exact version on first request and cached per version. The outcome is one of:

- `verified`: every declared output exists in the manifest with the same SHA-256
- `mismatch`: lists the differing or missing paths, bounded
- `invalid`: with a diagnostic
- `unsupported-version`
- `not-recorded`

`verified` and `mismatch` also report coverage: how many of the manifest's files the record declares, the dependency-edge claim, and any external variability. Partial coverage is never presented as complete. `dirty: true` is shown as "built from uncommitted changes" alongside the byte outcome.

The record is readable at `GET /api/v1/artifacts/{artifactId}/versions/{versionId}/provenance?projectId=…`, through MCP, and in the review's Details panel.

### Access and handoff

The record is a pointer, not a credential. Agents fetch source with their own access to the authored repository and verify file digests against `inputs`. Without a `verified` or `mismatch` record, the agent handoff is explicitly inspection-only. Missing provenance never affects review, annotation or scenario restore. Whether it blocks the later editing pilot is that pilot's gate, as decided above.

## 7. Conformance

New ledger entries in `project/spec/conformance.yml`, all `status: specified`, with the prose in a new product-spec section anchored `design-review-views`:

| ID | Behavior | Normal (`-B`) | Hostile (`-F`) |
|---|---|---|---|
| DSN-007 | A version's views document is validated against its own manifest on read, cached per version, and served with its outcome. | A valid Forms document yields its view, 23 designed scenarios and parameters; repeated reads return the same outcome; versions without the file are `absent`. | Malformed JSON, unknown fields or versions, duplicate or malformed ids, non-HTML, missing or escaping paths, two views on one path, out-of-range sizes, control characters, non-primitive props, and parameter/scenario prop overlap each yield `invalid` or `unsupported-version`, and the version stays reviewable as today. |
| DSN-008 | The review restores a designed scenario through the frame and page adapter, and reports the outcome. | The picker and a `scenario=5` link open the Validation inspector; capture returns scenario, props, viewport, theme, locale and direction; markers are located after restore. | A page without an adapter is `unsupported`; a slow page times out; a page confirming a different scenario is `failed`; messages from another window, oversized fields, and scenarios not in the views document are ignored; an adapter error never breaks the page. |
| DSN-009 | Anchors carry view, scenario and region identity and reopen to that state, or say "Location unavailable". | An annotation on the minimum-length field in scenario 5 reopens there with its marker on that field; a thread from another scenario is listed with an Open action; anchors without `view` behave as before. | A failed restore and a missing or duplicated region each show "Location unavailable" with the reason and place no marker; an invalid `view` block is treated as absent; replacing an anchor through the web client and MCP preserves unknown fields; a region label carrying bidi or zero-width characters is stored stripped. |
| DSN-010 | A version's source-provenance record is validated against its manifest, cached per version, and reported with its coverage. | A matching record is `verified` with declared-file coverage; `dirty` and partial dependency edges are reported as such; the three identities are shown separately. | Changed or missing outputs yield `mismatch` with the paths; malformed, escaping, over-limit or credential-bearing records yield `invalid`; an absent record is `not-recorded`; none of these affects review or annotation. |
| DSN-011 | Agents receive the view location and provenance with each comment. | A bundle for the scenario 5 comment carries view, scenario, region, `sourceRef` and the provenance summary; MCP returns both outcomes for the version. | Hostile region labels and source paths reach the agent sanitized; a version without views or provenance yields a bundle without those fields and an inspection-only handoff. |

Dependencies:

- DSN-007 depends on MAN-001.
- DSN-008 depends on DSN-007, CMT-014 (the opaque-origin annotation sandbox), CMT-018 (exact-version preview leases), CMT-022 (the annotate/interactive switch), and the Design-side prerequisite.
- DSN-009 depends on DSN-008, CMT-003 (opaque bounded anchors) and CMT-016 (exact review URLs).
- DSN-010 depends on MAN-001.
- DSN-011 depends on DSN-009, DSN-010, DSP-011 (follow-up bundle rendering) and BRP-002 (the sanitized mailbox bundle).

Evidence for the acceptance journey is recorded against a hosted Forms version published after both sides land. Changing the review sandbox requires `BROWSER_CRITICAL_ENGINES=all pnpm test:web`.

## 8. Who builds what

| Design (producer) | Artifact Server (consumer) |
|---|---|
| `build:views` and `build:provenance`, wired into `check:source`, validated against the published JSON Schema | Views and provenance validators, per-version caching, API and MCP reads |
| `data-review-region` on Form Builder panels, fields and component instances; `data-review-scenario` on its root | Protocol messages in `protocol.ts` and the frame ↔ page relay in the review frame |
| The page adapter in canonical `support.js`, synchronized with `sync:support` | Anchor capture, the reopen order and the two "Location unavailable" states |
| React shipped inside the publication, resolved through `window.__resources` | Scenario picker, `scenario=` URL state, provenance in Details, bundle fields |

Both sides can start once this spec is approved: Design's `check:source` needs only the JSON Schema, and Artifact Server's tests use fixture publications that carry the two files and a fixture page with the adapter.

## Out of scope

- Annotation inside the interactive frame, and the native React adapter (PLAN.md steps 3 and 4).
- Placing a comment on a version other than its own, with or without confidence scores.
- Listing regions in the views document, or validating a region id before it is rendered.
- Captured visual evidence (screenshots) on anchors.
- The candidate publication model (NEXT.md, "Candidate publication and acceptance"). The pilot does not need it.
- The server fetching authored source on an agent's behalf.
- Any change to the annotate frame's content security policy, to the preview source or index, or to DSN-003/DSN-004.
