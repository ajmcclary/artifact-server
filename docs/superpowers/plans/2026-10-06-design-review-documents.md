# Design review documents (views and provenance) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Artifact Server reads a version's `artifactserver.views.json` and `artifactserver.provenance.json`, validates each against that version's own manifest, caches the outcome per immutable version, and serves the outcomes over HTTP and MCP.

**Architecture:** Two pure validators in `src/manifest/` turn document text plus the version's manifest entries into an outcome value. A small application-layer reader, `createVersionDocuments`, opens the bytes through the existing `BlobStore` port and keeps a bounded per-process cache keyed by version id. `createHttpApp` builds one reader from `dependencies.blobs`, registers two read routes, and passes the reader to the MCP adapter, so the local, external-storage and Cloudflare runtimes need no wiring changes. Authorization is the existing `ArtifactManagementService.getVersion` check.

**Tech Stack:** TypeScript, Effect v4 `Schema` (validators), Hono routes in `src/http/create-http-app.ts`, the MCP SDK tool registry in `src/mcp/artifact-mcp-server.ts`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-06-forms-review-pilot-contract-design.md` (sections 1, 2, 6 and 7, plus the planning amendments). This is Plan A of two. Plan B (`docs/superpowers/plans/2026-10-06-forms-review-experience.md`) builds the review protocol, anchors, UI and bundles on top of it.

## Global Constraints

- Read `AGENTS.md` and `node_modules/effect/AGENTS.md` before writing code. Validate untrusted data with `Schema`, never hand-written predicates.
- No module mocks. HTTP behavior is tested through `startTestServer` with a real temporary installation (SQLite plus disk blobs).
- Test titles carry requirement ids: `test("DSN-007-B: …")`. At most one test may claim each id (`scripts/check-conformance-test-ids.rb`).
- The preview source, preview index, DSN-003 and DSN-004 are not changed.
- A file never selects a storage location: every path in either document is checked against the version's manifest, and bytes are opened only by the manifest entry's `sha256`.
- Views document: `artifactserver.views.json`, format `artifact-server.views`, version `1`, at most 1 MiB.
- Provenance record: `artifactserver.provenance.json`, format `artifact-server.source-provenance`, version `1`, at most 4 MiB.
- Views outcomes: `valid`, `absent`, `unsupported-version`, `invalid`. Provenance outcomes: `verified`, `mismatch`, `invalid`, `unsupported-version`, `not-recorded`.
- An outcome is a pure function of the version's bytes. A storage failure is an error (HTTP 500), never an `invalid` outcome, and is never cached.
- Diagnostics are at most 2,000 characters.
- Do not weaken TypeScript, Oxlint or anti-slop rules.
- End every commit message with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0176RtcKJPmhiiSHHmBTiJSZ
  ```

## Review Focus

1. **A document that is valid JSON but the wrong encoding.** A UTF-16 or Latin-1 file must yield `invalid` ("not UTF-8"), not a 500. Test in Task 4.
2. **The manifest entry lies about size.** A blob whose stored size differs from the manifest is a storage fault: the request fails with 500, and the next request retries instead of serving a cached failure. Test in Task 4.
3. **Concurrent first reads of the same version.** Two simultaneous requests open the blob once and get the same outcome. Test in Task 4.
4. **A views document naming a path that differs only by case or normalization from a published file.** It must be `invalid`, never matched loosely. Test in Task 2.
5. **A provenance record that declares the record file itself, or the views document, as an output.** Allowed, and checked by digest like any other output; the record's own coverage denominator excludes the record file. Test in Task 3.

---

### Task 1: Ledger entries and product-spec section

**Files:**
- Modify: `project/spec/artifact-server-product-spec.html` (two table-of-contents links near lines 1626 and 1648; a new section after the `claude-design-exports` section, which ends near line 4015)
- Modify: `project/spec/conformance.yml` (five entries after DSN-006, near line 1167; the `updated:` field at line 3)

**Interfaces:**
- Produces: ledger ids DSN-007 … DSN-011 with acceptance ids `DSN-00N-B` and `DSN-00N-F`, and the product-spec anchor `design-review-views`. Later tasks and Plan B name tests with these ids.

- [ ] **Step 1: Confirm the validator rejects an unknown anchor**

Add only the DSN-007 entry from Step 3 first, then run:

```bash
pnpm conformance:validate
```

Expected: FAIL with `source anchor #design-review-views does not exist in artifact-server-product-spec.html`.

- [ ] **Step 2: Add the product-spec section and its navigation links**

In `project/spec/artifact-server-product-spec.html`, after the desktop link `<li><a href="#claude-design-exports">Claude Design exports</a></li>` add:

```html
<li><a href="#design-review-views">Design review views</a></li>
```

After the mobile link `<a href="#claude-design-exports">Claude Design exports</a>` add:

```html
<a href="#design-review-views">Design review views</a>
```

Insert this section immediately before `<section class="section" id="decisions" aria-labelledby="decisions-title">`:

```html
        <section class="section" id="design-review-views" aria-labelledby="design-review-views-title">
          <div class="section-heading">
            <span class="section-label">Review states</span>
            <h2 id="design-review-views-title">Design review views</h2>
          </div>
          <p>A design publication may carry a views document, <code>artifactserver.views.json</code>, generated by its producer from the same descriptors that drive its catalog. It names each reviewable view, its designed scenarios and the parameters that reproduce them. Artifact Server reads it from the exact version, validates it against that version's manifest and keeps the outcome for that immutable version. A missing, unsupported or invalid document leaves the version reviewable exactly as before.</p>
          <p>Review opens a designed scenario through a cooperating page adapter and waits for the page to confirm it before placing comments. A comment made on such a page records its view, scenario and, when the page marks one, its region. Reopening the comment restores that state. When the scenario cannot be restored, or the region is missing or ambiguous, the comment says its location is unavailable instead of guessing.</p>
          <p>A publication may also carry a source-provenance record, <code>artifactserver.provenance.json</code>, naming the authored repository, commit, build inputs and the authored sources of each output. Artifact Server checks every declared output against the version's manifest digests and reports the result with its coverage. The record is a pointer, not an access grant. Its absence never affects review or annotation; agent handoff for such a version is inspection-only.</p>
        </section>

```

- [ ] **Step 3: Add the five ledger entries**

In `project/spec/conformance.yml`, set `updated: "2026-10-06"` (unchanged if already that date) and insert after the DSN-006 entry, with one blank line between entries:

```yaml
  - id: DSN-007
    kind: behavior
    behavior: A version's producer views document is validated against that version's own manifest on read, kept per immutable version, and served with its outcome, while an absent, unsupported or invalid document leaves the version reviewable as before.
    owner: http-api
    source: {file: artifact-server-product-spec.html, anchor: design-review-views}
    acceptance:
      behavior: {id: DSN-007-B, description: "Publish a views document naming a published HTML page with designed scenarios and parameters; read it over HTTP and MCP as valid with every view, scenario and parameter; repeated reads return the same outcome; a version without the file reports absent."}
      failure: {id: DSN-007-F, description: "Report malformed JSON, non-UTF-8 bytes, oversized files, unknown fields, unsupported versions, malformed or duplicate ids, non-HTML, missing, escaping or case-mismatched paths, two views on one path, out-of-range sizes, control characters, non-primitive props, unknown default scenarios and parameter props reused by scenarios as invalid or unsupported-version, without failing the version's other reads; never cache a storage failure."}
    deployments: *all
    status: specified
    depends_on: [MAN-001]
    evidence: []

  - id: DSN-008
    kind: behavior
    behavior: Review restores a designed scenario through the annotation frame and a cooperating page adapter, waits for the page to confirm it before placing comments, and reports restored, failed or unsupported without changing the page silently.
    owner: web-application
    source: {file: artifact-server-product-spec.html, anchor: design-review-views}
    acceptance:
      behavior: {id: DSN-008-B, description: "Open a designed scenario from the scenario picker and from a scenario link; the page confirms it; capture returns scenario, props, viewport, theme, locale and direction; comment markers are placed after restoration and follow a scenario changed from inside the page."}
      failure: {id: DSN-008-F, description: "Report a page without an adapter as unsupported, a page that never confirms as timed out, and a page confirming another scenario as failed; ignore page messages from other windows, oversized or malformed messages and scenarios outside the views document; keep the page as it was after any failure."}
    deployments: *all
    status: specified
    depends_on: [DSN-007, CMT-014, CMT-018, CMT-022]
    evidence: []

  - id: DSN-009
    kind: behavior
    behavior: A comment anchor made on a page with views records its view, scenario, scenario label, source reference and, when the page marks one uniquely, its region; reopening restores that state or says the location is unavailable, and anchors without views behave as before.
    owner: web-application
    source: {file: artifact-server-product-spec.html, anchor: design-review-views}
    acceptance:
      behavior: {id: DSN-009-B, description: "Annotate a marked field in a designed scenario and reopen it to that scenario with its marker on that field; list a comment from another scenario with an Open action; place an anchor without a view block exactly as before."}
      failure: {id: DSN-009-F, description: "Show location unavailable with its reason, and place no marker, after a failed restore and for a missing or duplicated region; treat an invalid view block as absent; preserve unknown anchor fields through web and MCP anchor replacement; store region labels stripped of bidirectional and zero-width characters."}
    deployments: *all
    status: specified
    depends_on: [DSN-008, CMT-003, CMT-016]
    evidence: []

  - id: DSN-010
    kind: behavior
    behavior: A version's source-provenance record is validated against that version's manifest digests on read, kept per immutable version, and reported with its coverage while authored commit, mirror commit and Artifact Server version stay distinct, and its absence never affects review.
    owner: http-api
    source: {file: artifact-server-product-spec.html, anchor: design-review-views}
    acceptance:
      behavior: {id: DSN-010-B, description: "Publish a record whose outputs match the manifest and read it over HTTP and MCP as verified with declared-file coverage, the dependency-edge claim and external variability; report dirty builds and partial edges as such; a version without a record reports not-recorded."}
      failure: {id: DSN-010-F, description: "Report changed and missing outputs as mismatch with their paths; report malformed, escaping, over-limit, duplicate-output and credential-bearing records as invalid and unknown versions as unsupported-version; none of these affects the version's other reads."}
    deployments: *all
    status: specified
    depends_on: [MAN-001]
    evidence: []

  - id: DSN-011
    kind: behavior
    behavior: Agents receive each comment's view location in its dispatch bundle, rendered identically by the native bridge and the mailbox, and read a version's views and provenance outcomes through MCP.
    owner: agent-dispatch
    source: {file: artifact-server-product-spec.html, anchor: design-review-views}
    acceptance:
      behavior: {id: DSN-011-B, description: "A bundle for a comment anchored in a designed scenario carries its location line in both the native and mailbox renders, byte for byte; artifact_version_context returns the version's views and provenance outcomes."}
      failure: {id: DSN-011-F, description: "Hostile scenario labels, region labels and source paths reach the agent sanitized; a comment without a valid view block renders exactly as before."}
    deployments: *all
    status: specified
    depends_on: [DSN-009, DSN-010, DSP-011, BRP-002]
    evidence: []
```

- [ ] **Step 4: Validate the ledger and test ids**

Run:

```bash
pnpm conformance:validate && pnpm conformance:tests
```

Expected: both PASS (the report lists DSN-007 … DSN-011 as `specified`).

- [ ] **Step 5: Commit**

```bash
git add project/spec/artifact-server-product-spec.html project/spec/conformance.yml
git commit -m "Specify design review views and provenance (DSN-007 to DSN-011)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0176RtcKJPmhiiSHHmBTiJSZ"
```

---

### Task 2: Views document validator

**Files:**
- Create: `src/manifest/views-document.ts`
- Test: `tests/manifest/views-document.test.ts`

**Interfaces:**
- Consumes: `ManifestEntry` from `src/core/model.ts` (`{disposition, mediaType, path, sha256, size}`); `parseManifestPath(candidate: string): string` from `src/manifest/create-manifest.ts` (throws on an invalid path).
- Produces:
  - `viewsDocumentPath = "artifactserver.views.json"`, `viewsDocumentFormat`, `viewsDocumentVersions = [1]`, `maximumViewsDocumentBytes = 1_048_576`
  - `viewsDocumentSchema` (Effect `Schema`), and the types `ViewsDocument`, `ReviewView`, `ReviewScenario`, `ReviewParameter`
  - `type ViewsOutcome = {status: "valid"; views: readonly ReviewView[]} | {status: "absent"} | {status: "unsupported-version"; version: number} | {status: "invalid"; diagnostic: string}`
  - `readViewsDocument(text: string | null, entries: readonly ManifestEntry[]): ViewsOutcome`
  - `invalidViewsDocument(diagnostic: string): ViewsOutcome` (bounds the diagnostic to 2,000 characters)

- [ ] **Step 1: Write the failing tests**

Create `tests/manifest/views-document.test.ts`:

```ts
import {describe, expect, test} from "vitest";

import type {ManifestEntry} from "../../src/core/model.js";
import {
  readViewsDocument,
  type ViewsOutcome,
} from "../../src/manifest/views-document.js";

const entry = (path: string): ManifestEntry => ({
  disposition: "inline",
  mediaType: path.endsWith(".json") ? "application/json" : "text/html; charset=utf-8",
  path,
  sha256: "a".repeat(64),
  size: 10,
});
const entries = [
  entry("project/Prototype - Form Builder.dc.html"),
  entry("project/other.html"),
  entry("project/data.js"),
  entry("artifactserver.views.json"),
];

function formsView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    defaultScenarioId: "1a",
    label: "ArkCase Forms · Form Builder",
    parameters: [
      {
        default: "ltr",
        name: "direction",
        prop: "chromeRtl",
        values: [{propValue: false, value: "ltr"}, {propValue: true, value: "rtl"}],
      },
      {
        default: true,
        name: "notes",
        prop: "showNotes",
        values: [{propValue: true, value: true}, {propValue: false, value: false}],
      },
    ],
    path: "project/Prototype - Form Builder.dc.html",
    scenarios: [
      {label: "Forms library · Populated table", props: {scenario: "1a"}, scenarioId: "1a"},
      {label: "Inspector · Validation", props: {scenario: "5"}, scenarioId: "5"},
      {label: "Rationale · Decisions, tokens, mapping", props: {scenario: "R"}, scenarioId: "R"},
    ],
    sourceRef: {path: "arkcase-forms/project/Prototype - Form Builder.dc.html"},
    viewId: "arkcase-forms/form-builder",
    ...overrides,
  };
}

function document(views: readonly unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({format: "artifact-server.views", version: 1, views, ...extra});
}

function expectInvalid(outcome: ViewsOutcome, fragment: RegExp): void {
  expect(outcome.status).toBe("invalid");
  if (outcome.status !== "invalid") return;
  expect(outcome.diagnostic).toMatch(fragment);
  expect(outcome.diagnostic.length).toBeLessThanOrEqual(2_000);
}

describe("views document validation", () => {
  test("accepts the Forms view with scenarios and parameters", () => {
    const outcome = readViewsDocument(document([formsView()]), entries);
    expect(outcome.status).toBe("valid");
    if (outcome.status !== "valid") return;
    expect(outcome.views).toHaveLength(1);
    expect(outcome.views[0]?.scenarios.map((scenario) => scenario.scenarioId)).toEqual(["1a", "5", "R"]);
    expect(outcome.views[0]?.parameters.map((parameter) => parameter.name)).toEqual(["direction", "notes"]);
  });

  test("reports a missing document as absent", () => {
    expect(readViewsDocument(null, entries)).toEqual({status: "absent"});
  });

  test("reports an unknown version without decoding the body", () => {
    expect(readViewsDocument(JSON.stringify({format: "artifact-server.views", version: 2, views: "anything"}), entries))
      .toEqual({status: "unsupported-version", version: 2});
  });

  test.each([
    ["malformed JSON", "{", /JSON/u],
    ["a wrong format", JSON.stringify({format: "artifact-server.preview-source", version: 1, views: []}), /format/u],
    ["an unknown top-level field", document([formsView()], {extra: true}), /extra/u],
    ["an unknown view field", document([formsView({colour: "red"})]), /colour/u],
    ["no views", document([]), /views/u],
    ["an uppercase view id", document([formsView({viewId: "Forms/builder"})]), /viewId/u],
    ["a view id without a slash", document([formsView({viewId: "forms-builder"})]), /viewId/u],
    ["a label with a control character", document([formsView({label: "Forms\u0007"})]), /label/u],
    ["a scenario id with a space", document([formsView({scenarios: [{label: "A", props: {scenario: "1 a"}, scenarioId: "1 a"}], defaultScenarioId: "1 a"})]), /scenarioId/u],
    ["an object prop value", document([formsView({scenarios: [{label: "A", props: {scenario: {nested: true}}, scenarioId: "1a"}]})]), /props|scenario/u],
    ["empty props", document([formsView({scenarios: [{label: "A", props: {}, scenarioId: "1a"}]})]), /props/u],
    ["a sourceRef with a zero line", document([formsView({sourceRef: {line: 0, path: "a.html"}})]), /line/u],
  ])("rejects %s", (_name, text, fragment) => {
    expectInvalid(readViewsDocument(text, entries), fragment);
  });

  test.each([
    ["a path that is not published", formsView({path: "project/missing.html"}), /not a published HTML file/u],
    ["a path that differs only by case", formsView({path: "project/prototype - form builder.dc.html"}), /not a published HTML file/u],
    ["a published non-HTML path", formsView({path: "project/data.js"}), /not a published HTML file/u],
    ["an escaping path", formsView({path: "../project/other.html"}), /path/iu],
    ["an escaping sourceRef", formsView({sourceRef: {path: "../secrets.txt"}}), /sourceRef/u],
    ["an absolute sourceRef", formsView({sourceRef: {path: "/etc/passwd"}}), /sourceRef/u],
    ["an unknown default scenario", formsView({defaultScenarioId: "99"}), /defaultScenarioId/u],
    ["duplicate scenario ids", formsView({scenarios: [{label: "A", props: {scenario: "5"}, scenarioId: "5"}, {label: "B", props: {scenario: "5"}, scenarioId: "5"}], defaultScenarioId: "5"}), /more than once/u],
    ["a parameter prop reused by a scenario", formsView({scenarios: [{label: "A", props: {chromeRtl: true, scenario: "1a"}, scenarioId: "1a"}]}), /chromeRtl/u],
    ["a parameter default that is not a value", formsView({parameters: [{default: "auto", name: "direction", prop: "chromeRtl", values: [{propValue: false, value: "ltr"}, {propValue: true, value: "rtl"}]}]}), /default/u],
    ["duplicate parameter values", formsView({parameters: [{default: "ltr", name: "direction", prop: "chromeRtl", values: [{propValue: false, value: "ltr"}, {propValue: true, value: "ltr"}]}]}), /more than once/u],
  ])("rejects %s", (_name, view, fragment) => {
    expectInvalid(readViewsDocument(document([view]), entries), fragment);
  });

  test("rejects two views with one id and two views on one path", () => {
    expectInvalid(
      readViewsDocument(document([formsView(), formsView({path: "project/other.html"})]), entries),
      /declared more than once/u,
    );
    expectInvalid(
      readViewsDocument(document([formsView(), formsView({viewId: "arkcase-forms/second"})]), entries),
      /more than one view/u,
    );
  });

  test("rejects more than 200 scenarios in one view", () => {
    const scenarios = Array.from({length: 201}, (_, index) => ({
      label: `Scenario ${index}`,
      props: {scenario: `s${index}`},
      scenarioId: `s${index}`,
    }));
    expectInvalid(
      readViewsDocument(document([formsView({defaultScenarioId: "s0", scenarios})]), entries),
      /scenarios/u,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/manifest/views-document.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/manifest/views-document.js"`.

- [ ] **Step 3: Implement the validator**

Create `src/manifest/views-document.ts`:

```ts
import {Schema} from "effect";

import type {ManifestEntry} from "../core/model.js";
import {parseManifestPath} from "./create-manifest.js";

/**
 * Producer views document published at a design version's root. Review reads
 * it as untrusted data from the exact version; it never selects storage.
 */
export const viewsDocumentPath = "artifactserver.views.json";
export const viewsDocumentFormat = "artifact-server.views";
export const viewsDocumentVersions = [1] as const;
export const maximumViewsDocumentBytes = 1_048_576;
const maximumDiagnosticCharacters = 2_000;

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
  reportInput: false,
} as const;

const label = Schema.String.check(
  Schema.isPattern(/^(?=.*\S)[^\p{Cc}\p{Cf}]+$/u),
  Schema.isMaxLength(200),
);
const viewIdSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u),
  Schema.isMaxLength(128),
);
const scenarioIdSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u),
);
const propNameSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u),
);
const propValueSchema = Schema.Union([
  Schema.String.check(Schema.isMaxLength(256)),
  Schema.Finite,
  Schema.Boolean,
]);
const propsSchema = Schema.Record(propNameSchema, propValueSchema).check(
  Schema.isPropertiesLengthBetween(1, 16),
);
const sourceRefSchema = Schema.Struct({
  line: Schema.optional(Schema.Int.check(Schema.isBetween({maximum: 10_000_000, minimum: 1}))),
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
});
const scenarioSchema = Schema.Struct({
  label,
  props: propsSchema,
  scenarioId: scenarioIdSchema,
});
const parameterSchema = Schema.Struct({
  default: propValueSchema,
  name: propNameSchema,
  prop: propNameSchema,
  values: Schema.Array(Schema.Struct({propValue: propValueSchema, value: propValueSchema}))
    .check(Schema.isMinLength(2), Schema.isMaxLength(16)),
});
const viewSchema = Schema.Struct({
  defaultScenarioId: scenarioIdSchema,
  label,
  parameters: Schema.Array(parameterSchema).check(Schema.isMaxLength(8)),
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  scenarios: Schema.Array(scenarioSchema).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  sourceRef: sourceRefSchema,
  viewId: viewIdSchema,
});
const headerSchema = Schema.Struct({
  format: Schema.Literal(viewsDocumentFormat),
  version: Schema.Int,
});

/** Version 1 of the views document, strict: unknown fields are errors. */
export const viewsDocumentSchema = Schema.Struct({
  format: Schema.Literal(viewsDocumentFormat),
  version: Schema.Literals(viewsDocumentVersions),
  views: Schema.Array(viewSchema).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

export type ViewsDocument = typeof viewsDocumentSchema.Type;
export type ReviewView = ViewsDocument["views"][number];
export type ReviewScenario = ReviewView["scenarios"][number];
export type ReviewParameter = ReviewView["parameters"][number];

export type ViewsOutcome =
  | {readonly status: "valid"; readonly views: readonly ReviewView[]}
  | {readonly status: "absent"}
  | {readonly status: "unsupported-version"; readonly version: number}
  | {readonly status: "invalid"; readonly diagnostic: string};

class ViewsDocumentRejected extends Error {}

/** An invalid outcome whose diagnostic is bounded for display. */
export function invalidViewsDocument(diagnostic: string): ViewsOutcome {
  return {diagnostic: diagnostic.slice(0, maximumDiagnosticCharacters), status: "invalid"};
}

/**
 * Validate one version's views document against that version's manifest.
 * `null` text means the version publishes no views document.
 */
export function readViewsDocument(
  text: string | null,
  entries: readonly ManifestEntry[],
): ViewsOutcome {
  if (text === null) return {status: "absent"};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalidViewsDocument("The views document is not valid JSON.");
  }
  try {
    const header = Schema.decodeUnknownSync(headerSchema)(value);
    if (!viewsDocumentVersions.some((version) => version === header.version)) {
      return {status: "unsupported-version", version: header.version};
    }
    const parsed = Schema.decodeUnknownSync(viewsDocumentSchema)(value, strictParseOptions);
    return {status: "valid", views: checkedViews(parsed.views, entries)};
  } catch (error) {
    return invalidViewsDocument(error instanceof Error ? error.message : String(error));
  }
}

function checkedViews(
  views: readonly ReviewView[],
  entries: readonly ManifestEntry[],
): readonly ReviewView[] {
  const htmlPaths = new Set(
    entries.filter((entry) => /\.html?$/iu.test(entry.path)).map((entry) => entry.path),
  );
  const viewIds = new Set<string>();
  const paths = new Set<string>();
  for (const view of views) {
    if (viewIds.has(view.viewId)) {
      throw new ViewsDocumentRejected(`View ${JSON.stringify(view.viewId)} is declared more than once.`);
    }
    viewIds.add(view.viewId);
    // Validate before lookup: a normalized '..' would conceal an escaping reference.
    const viewPath = parseManifestPath(view.path);
    if (viewPath !== view.path || !htmlPaths.has(viewPath)) {
      throw new ViewsDocumentRejected(
        `View ${JSON.stringify(view.viewId)} names ${JSON.stringify(view.path)}, which is not a published HTML file.`,
      );
    }
    if (paths.has(viewPath)) {
      throw new ViewsDocumentRejected(`More than one view names ${JSON.stringify(viewPath)}.`);
    }
    paths.add(viewPath);
    requireRelativeSourcePath(view.viewId, view.sourceRef.path);
    checkScenarios(view);
    checkParameters(view);
  }
  return views;
}

function requireRelativeSourcePath(viewId: string, candidate: string): void {
  const segments = candidate.split("/");
  if (
    candidate.startsWith("/") ||
    candidate.includes("\\") ||
    candidate.includes("\0") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new ViewsDocumentRejected(
      `View ${JSON.stringify(viewId)} has a sourceRef path that is not a plain relative path.`,
    );
  }
}

function checkScenarios(view: ReviewView): void {
  const seen = new Set<string>();
  for (const scenario of view.scenarios) {
    if (seen.has(scenario.scenarioId)) {
      throw new ViewsDocumentRejected(
        `View ${JSON.stringify(view.viewId)} declares scenario ${JSON.stringify(scenario.scenarioId)} more than once.`,
      );
    }
    seen.add(scenario.scenarioId);
  }
  if (!seen.has(view.defaultScenarioId)) {
    throw new ViewsDocumentRejected(
      `View ${JSON.stringify(view.viewId)} has a defaultScenarioId that names no scenario.`,
    );
  }
}

function checkParameters(view: ReviewView): void {
  const names = new Set<string>();
  const props = new Set<string>();
  for (const parameter of view.parameters) {
    if (names.has(parameter.name) || props.has(parameter.prop)) {
      throw new ViewsDocumentRejected(
        `View ${JSON.stringify(view.viewId)} declares parameter ${JSON.stringify(parameter.name)} more than once.`,
      );
    }
    names.add(parameter.name);
    props.add(parameter.prop);
    const values = new Set<string>();
    for (const option of parameter.values) {
      const key = JSON.stringify(option.value);
      if (values.has(key)) {
        throw new ViewsDocumentRejected(
          `Parameter ${JSON.stringify(parameter.name)} lists value ${key} more than once.`,
        );
      }
      values.add(key);
    }
    if (!values.has(JSON.stringify(parameter.default))) {
      throw new ViewsDocumentRejected(
        `Parameter ${JSON.stringify(parameter.name)} has a default that is not one of its values.`,
      );
    }
  }
  for (const scenario of view.scenarios) {
    for (const prop of Object.keys(scenario.props)) {
      if (props.has(prop)) {
        throw new ViewsDocumentRejected(
          `Scenario ${JSON.stringify(scenario.scenarioId)} sets ${JSON.stringify(prop)}, which a parameter controls.`,
        );
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/manifest/views-document.test.ts`
Expected: PASS. If a schema-level rejection's message does not contain the expected field name (for example `props`), print `outcome.diagnostic` once to see Effect's wording and tighten the test's regular expression to the field name that message actually contains, never loosen it to `/./u`.

- [ ] **Step 5: Lint and typecheck**

Run: `pnpm lint && pnpm exec tsc -p tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/manifest/views-document.ts tests/manifest/views-document.test.ts
git commit -m "Validate design views documents against the version manifest

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0176RtcKJPmhiiSHHmBTiJSZ"
```

---

### Task 3: Source-provenance validator

**Files:**
- Create: `src/manifest/provenance-record.ts`
- Test: `tests/manifest/provenance-record.test.ts`

**Interfaces:**
- Consumes: `ManifestEntry`, `parseManifestPath` (as in Task 2).
- Produces:
  - `provenanceRecordPath = "artifactserver.provenance.json"`, `provenanceRecordFormat`, `provenanceRecordVersions = [1]`, `maximumProvenanceRecordBytes = 4_194_304`
  - `provenanceRecordSchema`, type `ProvenanceRecord`
  - `type ProvenanceCoverage = {declaredOutputs: number; manifestFiles: number; dependencyEdges: "complete" | "partial" | "none"; externalVariability: readonly string[]}`
  - `type ProvenanceMismatch = {path: string; reason: "missing" | "digest"}`
  - `type ProvenanceOutcome = {status: "verified"; record: ProvenanceRecord; coverage: ProvenanceCoverage} | {status: "mismatch"; record: ProvenanceRecord; coverage: ProvenanceCoverage; mismatches: readonly ProvenanceMismatch[]; mismatchCount: number} | {status: "invalid"; diagnostic: string} | {status: "unsupported-version"; version: number} | {status: "not-recorded"}`
  - `readProvenanceRecord(text: string | null, entries: readonly ManifestEntry[]): ProvenanceOutcome`
  - `invalidProvenanceRecord(diagnostic: string): ProvenanceOutcome`

- [ ] **Step 1: Write the failing tests**

Create `tests/manifest/provenance-record.test.ts`:

```ts
import {describe, expect, test} from "vitest";

import type {ManifestEntry} from "../../src/core/model.js";
import {
  readProvenanceRecord,
  type ProvenanceOutcome,
} from "../../src/manifest/provenance-record.js";

const digest = (character: string): string => character.repeat(64);
const commit = (character: string): string => character.repeat(40);
const entry = (path: string, sha256: string): ManifestEntry => ({
  disposition: "inline",
  mediaType: "text/html; charset=utf-8",
  path,
  sha256,
  size: 10,
});
const entries = [
  entry("project/Prototype - Form Builder.dc.html", digest("a")),
  entry("project/support.js", digest("b")),
  entry("artifactserver.views.json", digest("c")),
  entry("artifactserver.provenance.json", digest("d")),
];

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    build: {
      dsRevision: commit("3"),
      lockfileSha256: digest("4"),
      recipe: "publish-all",
      recipeRevision: commit("2"),
      renderer: {name: "dc-support", sha256: digest("5")},
      toolchain: {node: "v24.15.0", npm: "11.6.0"},
    },
    coverage: {dependencyEdges: "partial", externalVariability: [], notes: "Fixture edges are listed; DS edges are target-wide."},
    format: "artifact-server.source-provenance",
    inputs: [{path: "arkcase-forms/project/Prototype - Form Builder.dc.html", sha256: digest("6")}],
    outputs: [
      {
        path: "project/Prototype - Form Builder.dc.html",
        sha256: digest("a"),
        sources: [{line: 1, path: "arkcase-forms/project/Prototype - Form Builder.dc.html"}],
      },
      {path: "artifactserver.views.json", sha256: digest("c"), sources: []},
    ],
    source: {
      commit: commit("1"),
      descriptorId: "arkcase-forms",
      dirty: false,
      repository: "https://github.com/example/Design",
    },
    version: 1,
    ...overrides,
  };
}

const text = (value: unknown): string => JSON.stringify(value);

function expectInvalid(outcome: ProvenanceOutcome, fragment: RegExp): void {
  expect(outcome.status).toBe("invalid");
  if (outcome.status !== "invalid") return;
  expect(outcome.diagnostic).toMatch(fragment);
}

describe("source provenance validation", () => {
  test("verifies matching outputs and reports coverage without counting the record itself", () => {
    const outcome = readProvenanceRecord(text(record()), entries);
    expect(outcome.status).toBe("verified");
    if (outcome.status !== "verified") return;
    expect(outcome.coverage).toEqual({
      declaredOutputs: 2,
      dependencyEdges: "partial",
      externalVariability: [],
      manifestFiles: 3,
    });
    expect(outcome.record.source.commit).toBe(commit("1"));
  });

  test("reports a missing record as not-recorded", () => {
    expect(readProvenanceRecord(null, entries)).toEqual({status: "not-recorded"});
  });

  test("reports changed and missing outputs as a mismatch with their paths", () => {
    const outcome = readProvenanceRecord(text(record({
      outputs: [
        {path: "project/Prototype - Form Builder.dc.html", sha256: digest("f"), sources: []},
        {path: "project/removed.js", sha256: digest("a"), sources: []},
        {path: "project/support.js", sha256: digest("b"), sources: []},
      ],
    })), entries);
    expect(outcome.status).toBe("mismatch");
    if (outcome.status !== "mismatch") return;
    expect(outcome.mismatches).toEqual([
      {path: "project/Prototype - Form Builder.dc.html", reason: "digest"},
      {path: "project/removed.js", reason: "missing"},
    ]);
    expect(outcome.mismatchCount).toBe(2);
    expect(outcome.coverage.declaredOutputs).toBe(3);
  });

  test("reports a dirty build as recorded", () => {
    const outcome = readProvenanceRecord(text(record({
      source: {commit: commit("1"), descriptorId: "arkcase-forms", dirty: true, repository: "https://github.com/example/Design"},
    })), entries);
    expect(outcome.status).toBe("verified");
    if (outcome.status !== "verified") return;
    expect(outcome.record.source.dirty).toBe(true);
  });

  test("reports an unknown version", () => {
    expect(readProvenanceRecord(text({format: "artifact-server.source-provenance", version: 9}), entries))
      .toEqual({status: "unsupported-version", version: 9});
  });

  test.each([
    ["malformed JSON", "{", /JSON/u],
    ["an unknown field", text(record({extra: 1})), /extra/u],
    ["a short commit", text(record({source: {commit: "abc", descriptorId: "a", dirty: false, repository: "https://github.com/example/Design"}})), /commit/u],
    ["an http repository", text(record({source: {commit: commit("1"), descriptorId: "a", dirty: false, repository: "http://github.com/example/Design"}})), /repository/u],
    ["a repository with credentials", text(record({source: {commit: commit("1"), descriptorId: "a", dirty: false, repository: "https://user:token@github.com/example/Design"}})), /repository/u],
    ["a repository with a query", text(record({source: {commit: commit("1"), descriptorId: "a", dirty: false, repository: "https://github.com/example/Design?token=x"}})), /repository/u],
    ["an escaping output path", text(record({outputs: [{path: "../x.html", sha256: digest("a"), sources: []}]})), /path/iu],
    ["an escaping input path", text(record({inputs: [{path: "../secrets", sha256: digest("a")}]})), /input/u],
    ["an escaping source path", text(record({outputs: [{path: "project/support.js", sha256: digest("b"), sources: [{path: "/etc/passwd"}]}]})), /source/u],
    ["a duplicate output", text(record({outputs: [{path: "project/support.js", sha256: digest("b"), sources: []}, {path: "project/support.js", sha256: digest("b"), sources: []}]})), /more than once/u],
    ["no outputs", text(record({outputs: []})), /outputs/u],
    ["an unknown dependency claim", text(record({coverage: {dependencyEdges: "most", externalVariability: []}})), /dependencyEdges/u],
    ["a control character in notes", text(record({coverage: {dependencyEdges: "none", externalVariability: [], notes: "a\u0000b"}})), /notes/u],
  ])("rejects %s", (_name, value, fragment) => {
    expectInvalid(readProvenanceRecord(value, entries), fragment);
  });

  test("rejects more than 5,000 outputs", () => {
    const outputs = Array.from({length: 5_001}, (_, index) => ({path: `f${index}.js`, sha256: digest("a"), sources: []}));
    expectInvalid(readProvenanceRecord(text(record({outputs})), entries), /outputs/u);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/manifest/provenance-record.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/manifest/provenance-record.js"`.

- [ ] **Step 3: Implement the validator**

Create `src/manifest/provenance-record.ts`:

```ts
import {Schema} from "effect";

import type {ManifestEntry} from "../core/model.js";
import {parseManifestPath} from "./create-manifest.js";

/**
 * Producer source-provenance record published at a version's root. It is a
 * pointer to authored source, never an access grant, and it never names the
 * version's own manifest digest or mirror commit.
 */
export const provenanceRecordPath = "artifactserver.provenance.json";
export const provenanceRecordFormat = "artifact-server.source-provenance";
export const provenanceRecordVersions = [1] as const;
export const maximumProvenanceRecordBytes = 4_194_304;
const maximumDiagnosticCharacters = 2_000;
const maximumReportedMismatches = 100;

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
  reportInput: false,
} as const;

const commitSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const sha256Schema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const pathSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024));
const plainText = (maximum: number) => Schema.String.check(
  Schema.isPattern(/^[^\p{Cc}\p{Cf}]*$/u),
  Schema.isMaxLength(maximum),
);
const sourceLocationSchema = Schema.Struct({
  line: Schema.optional(Schema.Int.check(Schema.isBetween({maximum: 10_000_000, minimum: 1}))),
  path: pathSchema,
});
const headerSchema = Schema.Struct({
  format: Schema.Literal(provenanceRecordFormat),
  version: Schema.Int,
});

/** Version 1 of the source-provenance record, strict: unknown fields are errors. */
export const provenanceRecordSchema = Schema.Struct({
  build: Schema.Struct({
    dsRevision: commitSchema,
    lockfileSha256: sha256Schema,
    recipe: plainText(128),
    recipeRevision: commitSchema,
    renderer: Schema.Struct({name: plainText(64), sha256: sha256Schema}),
    toolchain: Schema.Record(
      Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/u)),
      plainText(64),
    ).check(Schema.isPropertiesLengthBetween(1, 8)),
  }),
  coverage: Schema.Struct({
    dependencyEdges: Schema.Literals(["complete", "partial", "none"]),
    externalVariability: Schema.Array(plainText(200)).check(Schema.isMaxLength(32)),
    notes: Schema.optional(plainText(2_000)),
  }),
  format: Schema.Literal(provenanceRecordFormat),
  inputs: Schema.Array(Schema.Struct({path: pathSchema, sha256: sha256Schema}))
    .check(Schema.isMaxLength(5_000)),
  outputs: Schema.Array(Schema.Struct({
    path: pathSchema,
    sha256: sha256Schema,
    sources: Schema.Array(sourceLocationSchema).check(Schema.isMaxLength(64)),
  })).check(Schema.isMinLength(1), Schema.isMaxLength(5_000)),
  source: Schema.Struct({
    commit: commitSchema,
    descriptorId: plainText(128),
    dirty: Schema.Boolean,
    repository: Schema.String.check(Schema.isMaxLength(512)),
  }),
  version: Schema.Literals(provenanceRecordVersions),
});

export type ProvenanceRecord = typeof provenanceRecordSchema.Type;

export interface ProvenanceCoverage {
  readonly declaredOutputs: number;
  readonly dependencyEdges: ProvenanceRecord["coverage"]["dependencyEdges"];
  readonly externalVariability: readonly string[];
  readonly manifestFiles: number;
}

export interface ProvenanceMismatch {
  readonly path: string;
  readonly reason: "digest" | "missing";
}

export type ProvenanceOutcome =
  | {
    readonly coverage: ProvenanceCoverage;
    readonly record: ProvenanceRecord;
    readonly status: "verified";
  }
  | {
    readonly coverage: ProvenanceCoverage;
    readonly mismatchCount: number;
    readonly mismatches: readonly ProvenanceMismatch[];
    readonly record: ProvenanceRecord;
    readonly status: "mismatch";
  }
  | {readonly diagnostic: string; readonly status: "invalid"}
  | {readonly status: "unsupported-version"; readonly version: number}
  | {readonly status: "not-recorded"};

class ProvenanceRecordRejected extends Error {}

/** An invalid outcome whose diagnostic is bounded for display. */
export function invalidProvenanceRecord(diagnostic: string): ProvenanceOutcome {
  return {diagnostic: diagnostic.slice(0, maximumDiagnosticCharacters), status: "invalid"};
}

/**
 * Validate one version's provenance record and compare every declared output
 * with that version's manifest digests. `null` text means no record.
 */
export function readProvenanceRecord(
  text: string | null,
  entries: readonly ManifestEntry[],
): ProvenanceOutcome {
  if (text === null) return {status: "not-recorded"};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalidProvenanceRecord("The provenance record is not valid JSON.");
  }
  try {
    const header = Schema.decodeUnknownSync(headerSchema)(value);
    if (!provenanceRecordVersions.some((version) => version === header.version)) {
      return {status: "unsupported-version", version: header.version};
    }
    const record = Schema.decodeUnknownSync(provenanceRecordSchema)(value, strictParseOptions);
    checkRecord(record);
    return compareWithManifest(record, entries);
  } catch (error) {
    return invalidProvenanceRecord(error instanceof Error ? error.message : String(error));
  }
}

function checkRecord(record: ProvenanceRecord): void {
  requireRepositoryUrl(record.source.repository);
  for (const input of record.inputs) requireAuthoredPath("input", input.path);
  const seen = new Set<string>();
  for (const output of record.outputs) {
    const outputPath = parseManifestPath(output.path);
    if (outputPath !== output.path) {
      throw new ProvenanceRecordRejected(`Output ${JSON.stringify(output.path)} is not a normalized published path.`);
    }
    if (seen.has(outputPath)) {
      throw new ProvenanceRecordRejected(`Output ${JSON.stringify(outputPath)} is declared more than once.`);
    }
    seen.add(outputPath);
    for (const source of output.sources) requireAuthoredPath("source", source.path);
  }
}

function requireRepositoryUrl(candidate: string): void {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new ProvenanceRecordRejected("The source repository is not a URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ProvenanceRecordRejected(
      "The source repository must be an https URL without credentials, query or fragment.",
    );
  }
}

function requireAuthoredPath(kind: "input" | "source", candidate: string): void {
  const segments = candidate.split("/");
  if (
    candidate.startsWith("/") ||
    candidate.includes("\\") ||
    candidate.includes("\0") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new ProvenanceRecordRejected(`The ${kind} path ${JSON.stringify(candidate)} is not a plain relative path.`);
  }
}

function compareWithManifest(
  record: ProvenanceRecord,
  entries: readonly ManifestEntry[],
): ProvenanceOutcome {
  const digests = new Map(entries.map((entry) => [entry.path, entry.sha256]));
  const mismatches: ProvenanceMismatch[] = [];
  for (const output of record.outputs) {
    const published = digests.get(output.path);
    if (published === undefined) mismatches.push({path: output.path, reason: "missing"});
    else if (published !== output.sha256) mismatches.push({path: output.path, reason: "digest"});
  }
  const coverage: ProvenanceCoverage = {
    declaredOutputs: record.outputs.length,
    dependencyEdges: record.coverage.dependencyEdges,
    externalVariability: record.coverage.externalVariability,
    // The record cannot declare its own digest, so it never counts against coverage.
    manifestFiles: entries.filter((entry) => entry.path !== provenanceRecordPath).length,
  };
  if (mismatches.length === 0) return {coverage, record, status: "verified"};
  return {
    coverage,
    mismatchCount: mismatches.length,
    mismatches: mismatches.slice(0, maximumReportedMismatches),
    record,
    status: "mismatch",
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/manifest/provenance-record.test.ts`
Expected: PASS. As in Task 2, if a schema-level message names the field differently, tighten the regular expression to the field the message actually names.

- [ ] **Step 5: Lint and typecheck**

Run: `pnpm lint && pnpm exec tsc -p tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/manifest/provenance-record.ts tests/manifest/provenance-record.test.ts
git commit -m "Validate source-provenance records against manifest digests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0176RtcKJPmhiiSHHmBTiJSZ"
```

---

### Task 4: Per-version document reader

**Files:**
- Create: `src/application/version-documents.ts`
- Test: `tests/application/version-documents.test.ts`

**Interfaces:**
- Consumes: `readViewsDocument`, `invalidViewsDocument`, `viewsDocumentPath`, `maximumViewsDocumentBytes` (Task 2); `readProvenanceRecord`, `invalidProvenanceRecord`, `provenanceRecordPath`, `maximumProvenanceRecordBytes` (Task 3); `ArtifactVersion` and `ManifestEntry` from `src/core/model.ts`; `BlobStore` from `src/core/ports.ts` (`open(sha256): Promise<{body: ReadableStream<Uint8Array>; size: number}>`).
- Produces:
  - `interface VersionDocuments { views(saved: ArtifactVersion): Promise<ViewsOutcome>; provenance(saved: ArtifactVersion): Promise<ProvenanceOutcome> }`
  - `interface VersionDocumentsDependencies { readonly blobs: Pick<BlobStore, "open">; readonly maximumCachedOutcomes?: number }` (default 1,024)
  - `createVersionDocuments(dependencies: VersionDocumentsDependencies): VersionDocuments`

The cache stores the in-flight promise, so concurrent first reads share one blob open. A rejected promise (a storage fault) is removed so the next read retries. A fake `open` function is used in this unit test; it is a port double, not a module mock.

- [ ] **Step 1: Write the failing tests**

Create `tests/application/version-documents.test.ts`:

```ts
import {createHash} from "node:crypto";

import {describe, expect, test} from "vitest";

import {createVersionDocuments} from "../../src/application/version-documents.js";
import type {ArtifactVersion, ManifestEntry} from "../../src/core/model.js";

const viewsText = JSON.stringify({
  format: "artifact-server.views",
  version: 1,
  views: [{
    defaultScenarioId: "1",
    label: "Page",
    parameters: [],
    path: "index.html",
    scenarios: [{label: "One", props: {scenario: "1"}, scenarioId: "1"}],
    sourceRef: {path: "src/index.html"},
    viewId: "fixture/page",
  }],
});

interface StoredBlob {
  readonly bytes: Uint8Array;
}

function fixture(files: Record<string, Uint8Array>, overrides: Partial<Record<string, number>> = {}) {
  const blobs = new Map<string, StoredBlob>();
  const entries: ManifestEntry[] = Object.entries(files).map(([path, bytes]) => {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    blobs.set(sha256, {bytes});
    return {
      disposition: "inline",
      mediaType: path.endsWith(".json") ? "application/json" : "text/html; charset=utf-8",
      path,
      sha256,
      size: overrides[path] ?? bytes.byteLength,
    };
  });
  let opens = 0;
  let failNext = false;
  const open = (sha256: string) => {
    opens += 1;
    if (failNext) {
      failNext = false;
      return Promise.reject(new Error("blob store unavailable"));
    }
    const stored = blobs.get(sha256);
    if (stored === undefined) return Promise.reject(new Error("missing blob"));
    return Promise.resolve({body: new Response(stored.bytes).body!, size: stored.bytes.byteLength});
  };
  const saved = {
    manifest: {digest: "d".repeat(64), entries, entryPath: "index.html", routingMode: "static", serialized: "{}"},
    version: {id: "ver_fixture"},
  } as unknown as ArtifactVersion;
  return {
    failNextOpen: () => {
      failNext = true;
    },
    open,
    opens: () => opens,
    saved,
  };
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("version document reader", () => {
  test("reads, validates and caches a version's views once", async () => {
    const {open, opens, saved} = fixture({"artifactserver.views.json": utf8(viewsText), "index.html": utf8("<p>x</p>")});
    const documents = createVersionDocuments({blobs: {open}});
    const [first, second] = await Promise.all([documents.views(saved), documents.views(saved)]);
    expect(first.status).toBe("valid");
    expect(second).toBe(first);
    expect(await documents.views(saved)).toBe(first);
    expect(opens()).toBe(1);
  });

  test("reports absent views and a not-recorded provenance without opening blobs", async () => {
    const {open, opens, saved} = fixture({"index.html": utf8("<p>x</p>")});
    const documents = createVersionDocuments({blobs: {open}});
    expect(await documents.views(saved)).toEqual({status: "absent"});
    expect(await documents.provenance(saved)).toEqual({status: "not-recorded"});
    expect(opens()).toBe(0);
  });

  test("reports non-UTF-8 bytes as invalid", async () => {
    const latin1 = new Uint8Array([0x7b, 0xe9, 0x7d]);
    const {open, saved} = fixture({"artifactserver.views.json": latin1, "index.html": utf8("<p>x</p>")});
    const outcome = await createVersionDocuments({blobs: {open}}).views(saved);
    expect(outcome).toEqual({diagnostic: "The views document is not UTF-8 text.", status: "invalid"});
  });

  test("reports an oversized document as invalid without opening it", async () => {
    const {open, opens, saved} = fixture(
      {"artifactserver.views.json": utf8(viewsText), "index.html": utf8("<p>x</p>")},
      {"artifactserver.views.json": 1_048_577},
    );
    const outcome = await createVersionDocuments({blobs: {open}}).views(saved);
    expect(outcome).toEqual({diagnostic: "The views document is larger than 1 MiB.", status: "invalid"});
    expect(opens()).toBe(0);
  });

  test("fails on a stored size that differs from the manifest and retries on the next read", async () => {
    const {open, opens, saved} = fixture(
      {"artifactserver.views.json": utf8(viewsText), "index.html": utf8("<p>x</p>")},
      {"artifactserver.views.json": viewsText.length + 1},
    );
    const documents = createVersionDocuments({blobs: {open}});
    await expect(documents.views(saved)).rejects.toThrow(/manifest declares/u);
    await expect(documents.views(saved)).rejects.toThrow(/manifest declares/u);
    expect(opens()).toBe(2);
  });

  test("never caches a storage failure", async () => {
    const {failNextOpen, open, saved} = fixture({"artifactserver.views.json": utf8(viewsText), "index.html": utf8("<p>x</p>")});
    const documents = createVersionDocuments({blobs: {open}});
    failNextOpen();
    await expect(documents.views(saved)).rejects.toThrow("blob store unavailable");
    expect((await documents.views(saved)).status).toBe("valid");
  });

  test("evicts the least recently used outcome past the bound", async () => {
    const {open, opens, saved} = fixture({"artifactserver.views.json": utf8(viewsText), "index.html": utf8("<p>x</p>")});
    const other = {...saved, version: {id: "ver_other"}} as ArtifactVersion;
    const documents = createVersionDocuments({blobs: {open}, maximumCachedOutcomes: 1});
    await documents.views(saved);
    await documents.views(other);
    await documents.views(saved);
    expect(opens()).toBe(3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/application/version-documents.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/application/version-documents.js"`.

- [ ] **Step 3: Implement the reader**

Create `src/application/version-documents.ts`:

```ts
import type {ArtifactVersion, ManifestEntry} from "../core/model.js";
import type {BlobStore} from "../core/ports.js";
import {
  invalidProvenanceRecord,
  maximumProvenanceRecordBytes,
  provenanceRecordPath,
  readProvenanceRecord,
  type ProvenanceOutcome,
} from "../manifest/provenance-record.js";
import {
  invalidViewsDocument,
  maximumViewsDocumentBytes,
  readViewsDocument,
  viewsDocumentPath,
  type ViewsOutcome,
} from "../manifest/views-document.js";

/** Reads a version's producer documents once and keeps each outcome per version. */
export interface VersionDocuments {
  readonly provenance: (saved: ArtifactVersion) => Promise<ProvenanceOutcome>;
  readonly views: (saved: ArtifactVersion) => Promise<ViewsOutcome>;
}

export interface VersionDocumentsDependencies {
  readonly blobs: Pick<BlobStore, "open">;
  /** Outcomes kept per process; versions are immutable, so only memory bounds this. */
  readonly maximumCachedOutcomes?: number;
}

const defaultMaximumCachedOutcomes = 1_024;

type DocumentText =
  | {readonly kind: "absent"}
  | {readonly kind: "oversized"}
  | {readonly kind: "not-utf8"}
  | {readonly kind: "text"; readonly text: string};

/** Build the reader over the deployment's blob store. */
export function createVersionDocuments(
  dependencies: VersionDocumentsDependencies,
): VersionDocuments {
  const limit = dependencies.maximumCachedOutcomes ?? defaultMaximumCachedOutcomes;
  const outcomes = new Map<string, Promise<unknown>>();

  function cached<Outcome>(key: string, load: () => Promise<Outcome>): Promise<Outcome> {
    const existing = outcomes.get(key) as Promise<Outcome> | undefined;
    if (existing !== undefined) {
      outcomes.delete(key);
      outcomes.set(key, existing);
      return existing;
    }
    const loading = load();
    outcomes.set(key, loading);
    // A storage fault is not a property of the version: forget it so the next read retries.
    loading.catch(() => {
      if (outcomes.get(key) === loading) outcomes.delete(key);
    });
    while (outcomes.size > limit) {
      const oldest = outcomes.keys().next().value;
      if (oldest === undefined) break;
      outcomes.delete(oldest);
    }
    return loading;
  }

  async function documentText(
    saved: ArtifactVersion,
    path: string,
    maximumBytes: number,
  ): Promise<DocumentText> {
    const entry = saved.manifest.entries.find((candidate) => candidate.path === path);
    if (entry === undefined) return {kind: "absent"};
    if (entry.size > maximumBytes) return {kind: "oversized"};
    const bytes = await readEntryBytes(dependencies.blobs, entry);
    try {
      return {kind: "text", text: new TextDecoder("utf-8", {fatal: true}).decode(bytes)};
    } catch {
      return {kind: "not-utf8"};
    }
  }

  return {
    provenance: (saved) => cached(`provenance:${saved.version.id}`, async () => {
      const read = await documentText(saved, provenanceRecordPath, maximumProvenanceRecordBytes);
      switch (read.kind) {
        case "absent":
          return readProvenanceRecord(null, saved.manifest.entries);
        case "oversized":
          return invalidProvenanceRecord("The provenance record is larger than 4 MiB.");
        case "not-utf8":
          return invalidProvenanceRecord("The provenance record is not UTF-8 text.");
        case "text":
          return readProvenanceRecord(read.text, saved.manifest.entries);
      }
    }),
    views: (saved) => cached(`views:${saved.version.id}`, async () => {
      const read = await documentText(saved, viewsDocumentPath, maximumViewsDocumentBytes);
      switch (read.kind) {
        case "absent":
          return readViewsDocument(null, saved.manifest.entries);
        case "oversized":
          return invalidViewsDocument("The views document is larger than 1 MiB.");
        case "not-utf8":
          return invalidViewsDocument("The views document is not UTF-8 text.");
        case "text":
          return readViewsDocument(read.text, saved.manifest.entries);
      }
    }),
  };
}

async function readEntryBytes(
  blobs: Pick<BlobStore, "open">,
  entry: ManifestEntry,
): Promise<Uint8Array> {
  const blob = await blobs.open(entry.sha256);
  const bytes = new Uint8Array(await new Response(blob.body).arrayBuffer());
  if (bytes.byteLength !== entry.size) {
    throw new Error(
      `Stored blob ${entry.sha256} has ${bytes.byteLength} bytes; the manifest declares ${entry.size}.`,
    );
  }
  return bytes;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/application/version-documents.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and typecheck**

Run: `pnpm lint && pnpm exec tsc -p tsconfig.json --noEmit`
Expected: PASS. If Oxlint flags `as Promise<Outcome> | undefined`, replace the map with two typed maps (`Map<string, Promise<ViewsOutcome>>` and `Map<string, Promise<ProvenanceOutcome>>`) sharing one eviction helper, rather than adding a suppression.

- [ ] **Step 6: Commit**

```bash
git add src/application/version-documents.ts tests/application/version-documents.test.ts
git commit -m "Read and keep each version's views and provenance outcomes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0176RtcKJPmhiiSHHmBTiJSZ"
```

---

### Task 5: HTTP routes and published JSON Schemas

**Files:**
- Modify: `src/http/create-http-app.ts` (build the reader near the MCP adapter construction at line ~640; add two routes after the `/versions/:versionId/file` route at line ~2044)
- Create: `scripts/write-design-document-schemas.ts`
- Create (generated): `docs/schemas/artifact-server.views.v1.schema.json`, `docs/schemas/artifact-server.source-provenance.v1.schema.json`
- Modify: `package.json` (one script)
- Test: `tests/conformance/dsn-007-views-document.test.ts`, `tests/conformance/dsn-010-source-provenance.test.ts`, `tests/manifest/design-document-schemas.test.ts`

**Interfaces:**
- Consumes: `createVersionDocuments` (Task 4); `viewsDocumentSchema` (Task 2); `provenanceRecordSchema` (Task 3); `ArtifactManagementService.getVersion({artifactId, principal, projectId, versionId})`; `runHttpApplicationEffect`; `requestedProjectId`.
- Produces:
  - `GET /api/v1/artifacts/{artifactId}/versions/{versionId}/views?projectId=…` returning `200` with a `ViewsOutcome` body
  - `GET /api/v1/artifacts/{artifactId}/versions/{versionId}/provenance?projectId=…` returning `200` with a `ProvenanceOutcome` body
  - Both answer `404 VERSION_NOT_FOUND` / `ARTIFACT_NOT_FOUND` and `403 AUTHORIZATION_DENIED` exactly as `/file` does.
  - The constant `versionDocuments` inside `createHttpApp`, passed to the MCP adapter in Task 6.

- [ ] **Step 1: Write the failing conformance tests**

Create `tests/conformance/dsn-007-views-document.test.ts`:

```ts
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";

const encoder = new TextEncoder();
const viewsOutcomeSchema = z.discriminatedUnion("status", [
  z.object({status: z.literal("valid"), views: z.array(z.object({
    parameters: z.array(z.object({name: z.string()}).loose()),
    scenarios: z.array(z.object({label: z.string(), scenarioId: z.string()}).loose()),
    viewId: z.string(),
  }).loose())}).strict(),
  z.object({status: z.literal("absent")}).strict(),
  z.object({status: z.literal("unsupported-version"), version: z.number()}).strict(),
  z.object({diagnostic: z.string().max(2_000), status: z.literal("invalid")}).strict(),
]);
const failureSchema = z.object({error: z.object({code: z.string(), message: z.string()}).strict()}).strict();

const page: TestSiteFile = {
  bytes: encoder.encode("<!doctype html><title>Builder</title><main data-review-scenario=\"1a\"></main>"),
  mediaType: "text/html; charset=utf-8",
  path: "project/builder.html",
};

function viewsFile(value: unknown): TestSiteFile {
  return {
    bytes: typeof value === "string" ? encoder.encode(value) : encoder.encode(JSON.stringify(value)),
    mediaType: "application/json",
    path: "artifactserver.views.json",
  };
}

const formsViews = {
  format: "artifact-server.views",
  version: 1,
  views: [{
    defaultScenarioId: "1a",
    label: "ArkCase Forms · Form Builder",
    parameters: [{
      default: "ltr",
      name: "direction",
      prop: "chromeRtl",
      values: [{propValue: false, value: "ltr"}, {propValue: true, value: "rtl"}],
    }],
    path: "project/builder.html",
    scenarios: [
      {label: "Forms library · Populated table", props: {scenario: "1a"}, scenarioId: "1a"},
      {label: "Inspector · Validation", props: {scenario: "5"}, scenarioId: "5"},
    ],
    sourceRef: {path: "arkcase-forms/project/Prototype - Form Builder.dc.html"},
    viewId: "arkcase-forms/form-builder",
  }],
};

describe("DSN-007 design views document", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function publish(files: readonly TestSiteFile[], key: string): Promise<PublishResponse> {
    const upload = await createStagedUpload(server, installation, "project/builder.html", files);
    await uploadEveryStagedFile(installation, upload.body, files);
    return (await commitStagedUpload(installation, upload.body, key, {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: "Forms",
      tags: [],
    })).body;
  }

  async function readViews(published: PublishResponse, versionId = published.version.id): Promise<Response> {
    return fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${versionId}/views?projectId=${published.artifact.projectId}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
  }

  test("DSN-007-B: serves a valid views document, repeats the same outcome and reports absent views", async () => {
    expect.hasAssertions();
    const published = await publish([page, viewsFile(formsViews)], "dsn-007-b-valid");
    const first = await readViews(published);
    expect(first.status).toBe(200);
    const outcome = viewsOutcomeSchema.parse(await first.json());
    expect(outcome.status).toBe("valid");
    if (outcome.status !== "valid") return;
    expect(outcome.views[0]?.viewId).toBe("arkcase-forms/form-builder");
    expect(outcome.views[0]?.scenarios.map((scenario) => scenario.scenarioId)).toEqual(["1a", "5"]);
    expect(outcome.views[0]?.parameters.map((parameter) => parameter.name)).toEqual(["direction"]);
    expect(viewsOutcomeSchema.parse(await (await readViews(published)).json())).toEqual(outcome);

    const plain = await publish([page], "dsn-007-b-absent");
    expect(viewsOutcomeSchema.parse(await (await readViews(plain)).json())).toEqual({status: "absent"});
  });

  test("DSN-007-F: reports hostile views documents as invalid or unsupported while the version stays readable", async () => {
    expect.hasAssertions();
    const cases: readonly [string, TestSiteFile, "invalid" | "unsupported-version"][] = [
      ["malformed", viewsFile("{"), "invalid"],
      ["not utf-8", {...viewsFile(""), bytes: new Uint8Array([0x7b, 0xe9, 0x7d])}, "invalid"],
      ["unknown version", viewsFile({format: "artifact-server.views", version: 2, views: []}), "unsupported-version"],
      ["unknown field", viewsFile({...formsViews, extra: true}), "invalid"],
      ["missing path", viewsFile({...formsViews, views: [{...formsViews.views[0], path: "project/missing.html"}]}), "invalid"],
      ["case-mismatched path", viewsFile({...formsViews, views: [{...formsViews.views[0], path: "project/Builder.html"}]}), "invalid"],
      ["escaping sourceRef", viewsFile({...formsViews, views: [{...formsViews.views[0], sourceRef: {path: "../x"}}]}), "invalid"],
      ["object prop", viewsFile({...formsViews, views: [{...formsViews.views[0], scenarios: [{label: "A", props: {scenario: {}}, scenarioId: "1a"}]}]}), "invalid"],
    ];
    for (const [name, file, status] of cases) {
      const published = await publish([page, file], `dsn-007-f-${name.replaceAll(" ", "-")}`);
      const response = await readViews(published);
      expect(response.status, name).toBe(200);
      expect(viewsOutcomeSchema.parse(await response.json()).status, name).toBe(status);
      const entry = await fetch(
        `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/file?${new URLSearchParams({path: "project/builder.html", projectId: published.artifact.projectId})}`,
        {headers: {Authorization: `Bearer ${installation.apiToken}`}},
      );
      expect(entry.status, name).toBe(200);
    }
    const published = await publish([page, viewsFile(formsViews)], "dsn-007-f-unknown-version-id");
    const unknown = await readViews(published, "ver_00000000-0000-4000-8000-000000000000");
    expect(unknown.status).toBe(404);
    expect(failureSchema.parse(await unknown.json()).error.code).toBe("VERSION_NOT_FOUND");
  });
});
```

Create `tests/conformance/dsn-010-source-provenance.test.ts`:

```ts
import {createHash} from "node:crypto";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";

const encoder = new TextEncoder();
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const outcomeSchema = z.object({
  coverage: z.object({
    declaredOutputs: z.number(),
    dependencyEdges: z.enum(["complete", "partial", "none"]),
    externalVariability: z.array(z.string()),
    manifestFiles: z.number(),
  }).strict().optional(),
  diagnostic: z.string().optional(),
  mismatchCount: z.number().optional(),
  mismatches: z.array(z.object({path: z.string(), reason: z.enum(["digest", "missing"])}).strict()).optional(),
  record: z.object({source: z.object({commit: z.string(), dirty: z.boolean()}).loose()}).loose().optional(),
  status: z.enum(["verified", "mismatch", "invalid", "unsupported-version", "not-recorded"]),
  version: z.number().optional(),
}).strict();

const page: TestSiteFile = {
  bytes: encoder.encode("<!doctype html><title>Builder</title>"),
  mediaType: "text/html; charset=utf-8",
  path: "index.html",
};
const script: TestSiteFile = {
  bytes: encoder.encode("window.ready = true;"),
  mediaType: "text/javascript",
  path: "support.js",
};

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    build: {
      dsRevision: "3".repeat(40),
      lockfileSha256: "4".repeat(64),
      recipe: "publish-all",
      recipeRevision: "2".repeat(40),
      renderer: {name: "dc-support", sha256: sha256(script.bytes)},
      toolchain: {node: "v24.15.0"},
    },
    coverage: {dependencyEdges: "partial", externalVariability: ["cdn react"]},
    format: "artifact-server.source-provenance",
    inputs: [{path: "arkcase-forms/project/index.html", sha256: "6".repeat(64)}],
    outputs: [
      {path: "index.html", sha256: sha256(page.bytes), sources: [{path: "arkcase-forms/project/index.html"}]},
      {path: "support.js", sha256: sha256(script.bytes), sources: []},
    ],
    source: {commit: "1".repeat(40), descriptorId: "arkcase-forms", dirty: true, repository: "https://github.com/example/Design"},
    version: 1,
    ...overrides,
  };
}

function recordFile(value: unknown): TestSiteFile {
  return {
    bytes: encoder.encode(typeof value === "string" ? value : JSON.stringify(value)),
    mediaType: "application/json",
    path: "artifactserver.provenance.json",
  };
}

describe("DSN-010 source provenance", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function publish(files: readonly TestSiteFile[], key: string): Promise<PublishResponse> {
    const upload = await createStagedUpload(server, installation, "index.html", files);
    await uploadEveryStagedFile(installation, upload.body, files);
    return (await commitStagedUpload(installation, upload.body, key, {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: "Forms",
      tags: [],
    })).body;
  }

  async function readProvenance(published: PublishResponse): Promise<z.infer<typeof outcomeSchema>> {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/provenance?projectId=${published.artifact.projectId}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(response.status).toBe(200);
    return outcomeSchema.parse(await response.json());
  }

  test("DSN-010-B: verifies a matching record with its coverage and reports a missing record", async () => {
    expect.hasAssertions();
    const verified = await readProvenance(await publish([page, script, recordFile(record())], "dsn-010-b-verified"));
    expect(verified.status).toBe("verified");
    expect(verified.coverage).toEqual({
      declaredOutputs: 2,
      dependencyEdges: "partial",
      externalVariability: ["cdn react"],
      manifestFiles: 2,
    });
    expect(verified.record?.source).toMatchObject({commit: "1".repeat(40), dirty: true});
    expect(await readProvenance(await publish([page], "dsn-010-b-absent"))).toEqual({status: "not-recorded"});
  });

  test("DSN-010-F: reports mismatches, invalid and unsupported records without affecting other reads", async () => {
    expect.hasAssertions();
    const mismatch = await readProvenance(await publish([page, script, recordFile(record({
      outputs: [
        {path: "index.html", sha256: "f".repeat(64), sources: []},
        {path: "removed.js", sha256: "a".repeat(64), sources: []},
      ],
    }))], "dsn-010-f-mismatch"));
    expect(mismatch.status).toBe("mismatch");
    expect(mismatch.mismatches).toEqual([
      {path: "index.html", reason: "digest"},
      {path: "removed.js", reason: "missing"},
    ]);

    const hostile: readonly [string, unknown, string][] = [
      ["malformed", "{", "invalid"],
      ["escaping output", record({outputs: [{path: "../x", sha256: "a".repeat(64), sources: []}]}), "invalid"],
      ["credential url", record({source: {commit: "1".repeat(40), descriptorId: "a", dirty: false, repository: "https://u:p@example.com/r"}}), "invalid"],
      ["duplicate output", record({outputs: [{path: "index.html", sha256: sha256(page.bytes), sources: []}, {path: "index.html", sha256: sha256(page.bytes), sources: []}]}), "invalid"],
      ["unknown version", {format: "artifact-server.source-provenance", version: 2}, "unsupported-version"],
    ];
    for (const [name, value, status] of hostile) {
      const published = await publish([page, script, recordFile(value)], `dsn-010-f-${name.replaceAll(" ", "-")}`);
      expect((await readProvenance(published)).status, name).toBe(status);
      const views = await fetch(
        `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/views?projectId=${published.artifact.projectId}`,
        {headers: {Authorization: `Bearer ${installation.apiToken}`}},
      );
      expect(await views.json(), name).toEqual({status: "absent"});
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/conformance/dsn-007-views-document.test.ts tests/conformance/dsn-010-source-provenance.test.ts`
Expected: FAIL. The views and provenance reads return 404, because no such route exists.

- [ ] **Step 3: Build the reader and register the routes**

In `src/http/create-http-app.ts`, add the imports:

```ts
import {createVersionDocuments} from "../application/version-documents.js";
```

Immediately before `const mcp = createMcpHttpAdapter({` (line ~640), add:

```ts
  // Views and provenance outcomes are pure functions of immutable version
  // bytes, so one reader per process serves every request and the MCP adapter.
  const versionDocuments = createVersionDocuments({blobs: dependencies.blobs});
```

After the `/api/v1/artifacts/:artifactId/versions/:versionId/file` route, add:

```ts
  app.get(
    "/api/v1/artifacts/:artifactId/versions/:versionId/views",
    async (context) => {
      const saved = await runHttpApplicationEffect(
        context,
        dependencies,
        ArtifactManagementService.use((management) =>
          management.getVersion({
            artifactId: context.req.param("artifactId"),
            principal: context.get("principal"),
            projectId: requestedProjectId(context),
            versionId: context.req.param("versionId"),
          })
        ),
      );
      return context.json(await versionDocuments.views(saved));
    },
  );

  app.get(
    "/api/v1/artifacts/:artifactId/versions/:versionId/provenance",
    async (context) => {
      const saved = await runHttpApplicationEffect(
        context,
        dependencies,
        ArtifactManagementService.use((management) =>
          management.getVersion({
            artifactId: context.req.param("artifactId"),
            principal: context.get("principal"),
            projectId: requestedProjectId(context),
            versionId: context.req.param("versionId"),
          })
        ),
      );
      return context.json(await versionDocuments.provenance(saved));
    },
  );
```

- [ ] **Step 4: Run the conformance tests to verify they pass**

Run: `pnpm exec vitest run tests/conformance/dsn-007-views-document.test.ts tests/conformance/dsn-010-source-provenance.test.ts`
Expected: PASS. If the route's JSON body fails `context.json`'s type for the readonly union, return `context.json({...outcome})` instead; do not cast to `any`.

- [ ] **Step 5: Write the failing schema-sync test**

Create `tests/manifest/design-document-schemas.test.ts`:

```ts
import {readFile} from "node:fs/promises";

import {describe, expect, test} from "vitest";

import {designDocumentSchemas} from "../../scripts/write-design-document-schemas.js";

describe("published design document schemas", () => {
  test("match the validators they are generated from", async () => {
    for (const [path, schema] of Object.entries(designDocumentSchemas())) {
      const committed: unknown = JSON.parse(await readFile(path, "utf8"));
      expect(committed, path).toEqual(schema);
    }
  });
});
```

Run: `pnpm exec vitest run tests/manifest/design-document-schemas.test.ts`
Expected: FAIL with `Failed to resolve import "../../scripts/write-design-document-schemas.js"`.

- [ ] **Step 6: Write the schema generator and generate the files**

Create `scripts/write-design-document-schemas.ts`:

```ts
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {Schema} from "effect";

import {provenanceRecordSchema} from "../src/manifest/provenance-record.js";
import {viewsDocumentSchema} from "../src/manifest/views-document.js";

/**
 * JSON Schemas a producer such as Design checks its generated documents
 * against before publishing. Semantic rules (paths published in the version,
 * unique ids, digest matches) are enforced by Artifact Server on read.
 */
export function designDocumentSchemas(): Record<string, unknown> {
  return {
    "docs/schemas/artifact-server.source-provenance.v1.schema.json":
      jsonSchema(provenanceRecordSchema, "artifact-server.source-provenance.v1"),
    "docs/schemas/artifact-server.views.v1.schema.json":
      jsonSchema(viewsDocumentSchema, "artifact-server.views.v1"),
  };
}

function jsonSchema(schema: Schema.Constraint, id: string): unknown {
  const document = Schema.toJsonSchemaDocument(schema);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://artifact-server.dev/schemas/${id}.schema.json`,
    ...document.schema,
    ...(Object.keys(document.definitions).length === 0 ? {} : {$defs: document.definitions}),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [file, schema] of Object.entries(designDocumentSchemas())) {
    await mkdir(path.dirname(file), {recursive: true});
    await writeFile(file, `${JSON.stringify(schema, null, 2)}\n`);
  }
}
```

In `package.json` `scripts`, add next to the other generators:

```json
"schemas:design-documents": "node --import tsx scripts/write-design-document-schemas.ts",
```

Run: `pnpm schemas:design-documents && pnpm exec vitest run tests/manifest/design-document-schemas.test.ts`
Expected: two files appear under `docs/schemas/`, and the test PASSES. If `Schema.Constraint` is not the exported name of the schema type `toJsonSchemaDocument` accepts, use the parameter type from its declaration in `node_modules/effect/dist/Schema.d.ts` (`export declare function toJsonSchemaDocument(schema: …`).

- [ ] **Step 7: Check the generated schema's shape**

Run:

```bash
node -e 'const s = require("./docs/schemas/artifact-server.views.v1.schema.json"); console.log(s.$schema, Object.keys(s.properties ?? {}).sort())'
```

Expected: `https://json-schema.org/draft/2020-12/schema [ 'format', 'version', 'views' ]`.

- [ ] **Step 8: Lint, typecheck and run the suite slice**

Run: `pnpm lint && pnpm exec tsc -p tsconfig.json --noEmit && pnpm exec vitest run tests/manifest tests/application/version-documents.test.ts tests/conformance/dsn-007-views-document.test.ts tests/conformance/dsn-010-source-provenance.test.ts tests/conformance/cmt-013-version-file-route.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/http/create-http-app.ts scripts/write-design-document-schemas.ts docs/schemas package.json \
  tests/conformance/dsn-007-views-document.test.ts tests/conformance/dsn-010-source-provenance.test.ts \
  tests/manifest/design-document-schemas.test.ts
git commit -m "Serve version views and provenance outcomes over HTTP

Publish the version 1 JSON Schemas so producers can check their
generated documents before publication.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0176RtcKJPmhiiSHHmBTiJSZ"
```

---

### Task 6: MCP `artifact_version_context`

**Files:**
- Modify: `src/mcp/create-mcp-http-adapter.ts` (dependency field and pass-through, lines ~60-100)
- Modify: `src/mcp/artifact-mcp-server.ts` (dependency field at line ~392; tool registration right after `artifact_version_list`, which ends near line 1190)
- Modify: `src/http/create-http-app.ts` (pass `versionDocuments` to `createMcpHttpAdapter`)
- Modify: `skills/artifact-server/references/artifact-operations.md` (one line after `artifact_version_list`)
- Modify: `tests/conformance/mcp-modern-http.test.ts` (tool list near line 241)
- Test: `tests/conformance/dsn-011-version-context.test.ts`

**Interfaces:**
- Consumes: `VersionDocuments` (Task 4), the `versionDocuments` constant in `createHttpApp` (Task 5).
- Produces: MCP tool `artifact_version_context` with input `{artifactId, projectId?, versionId}` and structured output `{artifactId, provenance: ProvenanceOutcome, versionId, views: ViewsOutcome}`. Plan B's DSN-011-B test also asserts the bundle half of DSN-011, so this task's test claims no DSN id (the MCP read is asserted under an untitled-id test to keep DSN-011-B for the bundle journey).

- [ ] **Step 1: Write the failing test**

Create `tests/conformance/dsn-011-version-context.test.ts`:

```ts
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  commitStagedUpload,
  createStagedUpload,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";

const protocolVersion = "2026-07-28";
const encoder = new TextEncoder();
const toolCallResultSchema = z.object({
  jsonrpc: z.literal("2.0"),
  result: z.object({
    content: z.array(z.object({text: z.string(), type: z.literal("text")})),
    isError: z.boolean().optional(),
    structuredContent: z.unknown(),
  }).loose(),
}).loose();
const contextSchema = z.object({
  artifactId: z.string(),
  provenance: z.object({status: z.string()}).loose(),
  versionId: z.string(),
  views: z.object({status: z.string()}).loose(),
}).strict();

describe("artifact_version_context", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function callTool(name: string, parameters: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${server.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: crypto.randomUUID(),
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: {name: "artifact-server-test", version: "1"},
            [PROTOCOL_VERSION_META_KEY]: protocolVersion,
          },
          arguments: parameters,
          name,
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": protocolVersion,
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
    const result = toolCallResultSchema.parse(await response.json()).result;
    expect(result.isError ?? false).toBe(false);
    return result.structuredContent;
  }

  test("returns a version's views and provenance outcomes", async () => {
    expect.hasAssertions();
    const files: readonly TestSiteFile[] = [
      {bytes: encoder.encode("<!doctype html><title>x</title>"), mediaType: "text/html; charset=utf-8", path: "index.html"},
      {
        bytes: encoder.encode(JSON.stringify({
          format: "artifact-server.views",
          version: 1,
          views: [{
            defaultScenarioId: "1",
            label: "Page",
            parameters: [],
            path: "index.html",
            scenarios: [{label: "One", props: {scenario: "1"}, scenarioId: "1"}],
            sourceRef: {path: "src/index.html"},
            viewId: "fixture/page",
          }],
        })),
        mediaType: "application/json",
        path: "artifactserver.views.json",
      },
    ];
    const upload = await createStagedUpload(server, installation, "index.html", files);
    await uploadEveryStagedFile(installation, upload.body, files);
    const published = (await commitStagedUpload(installation, upload.body, "dsn-011-context", {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: "Context",
      tags: [],
    })).body;
    const context = contextSchema.parse(await callTool("artifact_version_context", {
      artifactId: published.artifact.id,
      projectId: published.artifact.projectId,
      versionId: published.version.id,
    }));
    expect(context.views.status).toBe("valid");
    expect(context.provenance).toEqual({status: "not-recorded"});
    expect(context.versionId).toBe(published.version.id);
  });
});
```

Run: `pnpm exec vitest run tests/conformance/dsn-011-version-context.test.ts`
Expected: FAIL; the tool call returns an error result for the unknown tool, so `expect(result.isError ?? false).toBe(false)` fails.

- [ ] **Step 2: Thread the reader through the MCP dependencies**

In `src/mcp/create-mcp-http-adapter.ts`, add to `McpHttpAdapterDependencies`:

```ts
  /** Per-version views and provenance outcomes shared with the HTTP routes. */
  readonly versionDocuments: VersionDocuments;
```

and in the `serverDependencies` object literal inside `createMcpHttpAdapter`:

```ts
        versionDocuments: dependencies.versionDocuments,
```

with the import:

```ts
import type {VersionDocuments} from "../application/version-documents.js";
```

In `src/mcp/artifact-mcp-server.ts`, add the same field to `ArtifactMcpServerDependencies`:

```ts
  /** Per-version views and provenance outcomes shared with the HTTP routes. */
  readonly versionDocuments: VersionDocuments;
```

with the same import. In `src/http/create-http-app.ts`, add `versionDocuments,` to the object passed to `createMcpHttpAdapter({`.

- [ ] **Step 3: Register the tool after `artifact_version_list`**

In `src/mcp/artifact-mcp-server.ts`, immediately after the `artifact_version_list` registration's closing `);`, add:

```ts
  registerNudgedTool(
    "artifact_version_context",
    {
      title: "Read a version's review views and source provenance",
      description:
        "Return the validated views document (the designed scenarios a review can open) and the validated source-provenance record for one exact immutable version. Views are valid, absent, unsupported-version or invalid; provenance is verified, mismatch, invalid, unsupported-version or not-recorded, with coverage when verified or mismatched. Provenance names the authored repository and commit behind the published bytes; it is a pointer, not an access grant.",
      inputSchema: z.object({
        artifactId: artifactIdSchema,
        projectId: optionalProjectIdSchema,
        versionId: versionIdSchema,
      }).strict(),
      outputSchema: z.object({
        artifactId: z.string(),
        provenance: z.object({status: z.string()}).loose(),
        versionId: z.string(),
        views: z.object({status: z.string()}).loose(),
      }).strict(),
      annotations: readOnlyAnnotations,
    },
    async ({artifactId, projectId, versionId}) => toolResult(async () => {
      const saved = await runMcpApplicationEffect(
        dependencies,
        ArtifactManagementService.use((management) =>
          management.getVersion({
            artifactId,
            principal: identity.principal,
            projectId,
            versionId,
          })
        ),
      );
      const [views, provenance] = await Promise.all([
        dependencies.versionDocuments.views(saved),
        dependencies.versionDocuments.provenance(saved),
      ]);
      return {artifactId, provenance, versionId, views};
    }),
  );
```

- [ ] **Step 4: Update the tool inventory and the agent skill reference**

In `tests/conformance/mcp-modern-http.test.ts`, insert `"artifact_version_context",` after `"artifact_version_list",` in the expected tool list.

In `skills/artifact-server/references/artifact-operations.md`, after the line `- \`artifact_version_list\`: list immutable versions newest first.` add:

```markdown
- `artifact_version_context`: read one version's validated views document and source-provenance record with their outcomes. Use it to find the designed scenarios behind a comment and the authored repository and commit behind the published bytes.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/conformance/dsn-011-version-context.test.ts tests/conformance/mcp-modern-http.test.ts tests/conformance/skl-artifact-server-skill.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/create-mcp-http-adapter.ts src/mcp/artifact-mcp-server.ts src/http/create-http-app.ts \
  skills/artifact-server/references/artifact-operations.md tests/conformance/mcp-modern-http.test.ts \
  tests/conformance/dsn-011-version-context.test.ts
git commit -m "Expose version views and provenance to agents over MCP

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0176RtcKJPmhiiSHHmBTiJSZ"
```

---

### Task 7: Evidence, ledger status and the iteration gate

**Files:**
- Create (generated): `project/evidence/design-review-documents-2026-10-06.json` (use the actual run date in the name and below)
- Modify: `project/spec/conformance.yml` (DSN-007 and DSN-010)

**Interfaces:**
- Consumes: the DSN-007 and DSN-010 tests from Task 5.
- Produces: DSN-007 and DSN-010 at `status: implementing` with local evidence. They cannot be `behavior_verified` until Plan B proves the review falls back for invalid documents in the UI.

- [ ] **Step 1: Record the evidence report**

Run:

```bash
pnpm exec vitest run tests/conformance/dsn-007-views-document.test.ts tests/conformance/dsn-010-source-provenance.test.ts \
  --reporter=default --reporter=json --outputFile.json=project/evidence/design-review-documents-2026-10-06.json
```

Expected: 4 tests PASS and the JSON report is written.

- [ ] **Step 2: Attach the evidence**

In `project/spec/conformance.yml`, change DSN-007 and DSN-010 from:

```yaml
    status: specified
```

to (DSN-007 shown; DSN-010 is the same with its own ids and proof gap):

```yaml
    status: implementing
    proof_gap: Server validation, per-version caching and HTTP/MCP reads pass locally. Review UI fallback and the hosted Forms publication land with the review-experience plan.
```

and replace `evidence: []` with:

```yaml
    evidence:
      - deployment: local
        tests: [DSN-007-B, DSN-007-F]
        result: pass
        run: project/evidence/design-review-documents-2026-10-06.json
        recorded_at: "<the report's startTime as an ISO-8601 UTC string>"
```

For DSN-010 use `tests: [DSN-010-B, DSN-010-F]` and the proof gap `Server validation, per-version caching and HTTP/MCP reads pass locally. The Details panel and Design's generated record land with the review-experience plan.`

Run: `pnpm conformance:validate && pnpm conformance:tests`
Expected: PASS.

- [ ] **Step 3: Run the iteration gate**

Run: `pnpm verify:iteration`
Expected: exit 0. The gate refreshes many files under `project/evidence/`; commit only the files this plan created or changed.

- [ ] **Step 4: Commit**

```bash
git add project/evidence/design-review-documents-2026-10-06.json project/spec/conformance.yml
git commit -m "Attach design review document evidence (DSN-007, DSN-010)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0176RtcKJPmhiiSHHmBTiJSZ"
```

## Design-side work this plan unblocks (in `~/Dev/Design`, planned there)

These belong to Design and follow Design's own `AGENTS.md`. Write their plan in Design once Task 5's JSON Schemas are committed.

1. **`build:views`** generates `artifactserver.views.json` for each project with a descriptor `configurations` mapping. The Forms view: `viewId` `arkcase-forms/form-builder`, one scenario per `FORMS_SCENARIOS` entry with `props: {scenario: <id>}`, the `direction` and `notes` parameters from the descriptor `mapping`, `defaultScenarioId` from `defaults`. Wire it into `check:source` (fail when stale) and validate the output against `~/artifact-server/docs/schemas/artifact-server.views.v1.schema.json`.
2. **`build:provenance`** emits `artifactserver.provenance.json` at publish time: the authored commit and `dirty` state, the lockfile digest, toolchain, DS revision, the `support.js` digest, inputs, outputs with their authored sources, and an honest `coverage` claim. It is validated against `artifact-server.source-provenance.v1.schema.json`.
3. **Region and scenario markers** in the Form Builder artboard: `data-review-scenario` on the root, and `data-review-region` on panels, fields and component instances (Plan B).
4. **The page adapter** in canonical `arkcase/project/dc-support/support.js`, synchronized with `sync:support` (Plan B fixes the message contract).
5. **React inside the publication** for the Form Builder, resolved through `window.__resources`, so it boots in the annotate sandbox.
