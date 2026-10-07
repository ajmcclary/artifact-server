# Forms review experience (scenarios, region anchors, bundles) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the annotate frame, a reviewer opens a designed scenario, annotates a marked region, and reopens that comment to the same scenario and region, or sees "Location unavailable" with the reason. Agents receive the comment's location in their bundle.

**Architecture:** Two message channels. The host ↔ review frame channel gains restore, capture and view-state messages under protocol `v: 1`. A new review frame ↔ page channel (`pageVersion: 1`) carries hello, restore, capture and region queries to a cooperating adapter inside the opaque-origin `srcdoc` sandbox. The review frame relays and never reads the page's document. The host owns the views document (from Plan A's `/views` route), builds the anchor's `view` block, filters comments to the scenario on screen, and holds them back until the page confirms its state. Plannotator learns `data-review-region` as a stable identity attribute through the existing package patch. Bundles render a location line from the anchor alone, identically in the patched `@plannotator/agent-bridge` and the server's mailbox mirror.

**Tech Stack:** React 19 and zod 4 in `apps/web`, `@plannotator/ui` (patched), `@plannotator/agent-bridge` (patched), Playwright browser specs, vitest.

**Spec:** `docs/superpowers/specs/2026-10-06-forms-review-pilot-contract-design.md` (sections 3, 4, 5 and 7, including "Amendments made while planning"). Plan A (`docs/superpowers/plans/2026-10-06-design-review-documents.md`) must be complete first: this plan consumes its `/views` and `/provenance` routes and its ledger entries.

## Global Constraints

- Read `AGENTS.md` and `node_modules/effect/AGENTS.md` before writing code.
- No module mocks. Browser behavior is proven in Playwright against a real server (`startBrowserFixture`). Pure modules get vitest tests next to them (`apps/web/src/**/*.test.ts`, run with `pnpm --filter @artifact-server/web test`).
- Test titles carry requirement ids (`DSN-008-B: …`). Browser specs may repeat an id in a `@critical` cross-engine test, as existing specs do.
- The annotate frame's content security policy does not change. Page messages are accepted only from the sandbox's own window with origin `"null"`, after schema validation.
- Strings from the page are capped at 256 characters, props at 16 keys, region ids per query at 64. `regionLabel` is stored at most 64 characters with bidirectional overrides, zero-width and control characters removed.
- Timings: hello wait 3 seconds after the sandbox's document starts; restore budget 5 seconds on the page; the frame's reply wait 6 seconds.
- Copy, verbatim:
  - "Couldn't open scenario {scenarioId}" (toolbar status after a failed restore, followed by the reason in parentheses)
  - "Location unavailable: scenario {scenarioId} couldn't be opened"
  - "Location unavailable: the region isn't on the page"
  - "In scenario {scenarioId} · {scenarioLabel}" with an "Open" button
- Anchors without a `view` block behave exactly as today.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0176RtcKJPmhiiSHHmBTiJSZ
  ```

## Review Focus

1. **The page reloads mid-session.** A new `as-review-init` (version switch) reloads the sandbox. The page channel must forget the old handshake, so a reply from the old document can never satisfy a request made to the new one. Test in Task 2.
2. **Two restores in quick succession.** A reviewer picks scenario 5, then 6, before 5 confirms. Only the latest request may set the on-screen scenario; the earlier reply is ignored. Test in Task 4.
3. **A comment on a page with views but no adapter.** The anchor gets no `view` block (no guessed scenario), and the review behaves as today. Test in Task 9.
4. **A hostile page answering requests it was never asked.** An `as-page-restored` with an unknown `requestId`, or an unprompted `as-page-region`, is ignored. Test in Task 2.
5. **Interact sub-mode inside the annotate frame.** Clicking a control in the page that changes scenario must move markers with it, without the reviewer re-opening anything. Test in Task 9.

---

### Task 1: Protocol schemas for both channels and the anchor `view` block

**Files:**
- Create: `apps/web/src/review-frame/page-protocol.ts`
- Modify: `apps/web/src/review-frame/protocol.ts`
- Test: `apps/web/src/review-frame/protocol.test.ts`

**Interfaces:**
- Produces, in `page-protocol.ts`:
  - `pageProtocolVersion = 1`
  - `pagePropsSchema`, `type PageProps = Record<string, string | number | boolean>`
  - `pageStateSchema`, `type PageState = {pageVersion, scenarioId: string | null, props: PageProps, viewport: {width, height}, theme: "light" | "dark", locale: string | null, direction: "ltr" | "rtl"}`
  - `pageRegionSchema`, `type PageRegion = {regionId, label, tagName}`
  - `pageMessageSchema` (page → frame union), `type PageMessage`
  - `type FrameToPageMessage` (frame → page union; not validated, the frame builds it)
  - `regionIdSchema`, `scenarioIdSchema`, `propNameSchema`
- Produces, in `protocol.ts`:
  - `viewAnchorSchema`, `type ViewAnchor`
  - `reviewAnchorSchema` gains `view?: ViewAnchor` (an invalid block parses as absent) and becomes loose (unknown keys survive)
  - host messages `as-review-restore {requestId, viewId, scenarioId, props}` and `as-review-capture {requestId, props: string[]}`
  - frame message `as-review-view-state {requestId: string | null, outcome: "restored" | "failed" | "unsupported", reason?: "timeout" | "scenario-mismatch" | "no-adapter" | "adapter-error", state: PageState | null}`
  - `as-review-submit` gains `capture?: {state: PageState | null, region: PageRegion | null}`
  - `as-review-unanchored` gains `reasons?: Record<threadId, "region-missing" | "region-ambiguous">`
  - `type ViewStateMessage = Extract<FrameMessage, {type: "as-review-view-state"}>`, `type UnanchoredReason`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/review-frame/protocol.test.ts`:

```ts
import {describe, expect, test} from "vitest";

import {pageMessageSchema} from "./page-protocol.ts";
import {frameMessageSchema, hostMessageSchema, reviewAnchorSchema} from "./protocol.ts";

const state = {
  direction: "ltr",
  locale: "en",
  pageVersion: 1,
  props: {chromeRtl: false, scenario: "5"},
  scenarioId: "5",
  theme: "light",
  viewport: {height: 900, width: 1440},
};
const view = {
  regionId: "inspector.validation.min-length",
  regionLabel: "Minimum length",
  scenarioId: "5",
  scenarioLabel: "Inspector · Validation",
  sourceRef: {path: "arkcase-forms/project/Prototype - Form Builder.dc.html"},
  state: {direction: "ltr", locale: "en", parameters: {direction: "ltr"}, theme: "light", viewport: {height: 900, width: 1440}},
  viewFormat: 1,
  viewId: "arkcase-forms/form-builder",
};

describe("review anchor", () => {
  test("keeps a valid view block and unknown keys", () => {
    const parsed = reviewAnchorSchema.parse({htmlAnchor: null, future: {kept: true}, originalText: "x", view});
    expect(parsed.view?.regionId).toBe("inspector.validation.min-length");
    expect((parsed as Record<string, unknown>)["future"]).toEqual({kept: true});
  });

  test("treats an invalid view block as absent without dropping the anchor", () => {
    const parsed = reviewAnchorSchema.parse({htmlAnchor: null, originalText: "x", view: {...view, regionId: "Not Valid"}});
    expect(parsed.view).toBeUndefined();
    expect(parsed.originalText).toBe("x");
  });

  test("parses an anchor written before views existed", () => {
    expect(reviewAnchorSchema.parse({htmlAnchor: null, originalText: "legacy"}).view).toBeUndefined();
  });
});

describe("host and frame messages", () => {
  test("accepts restore, capture and view-state under v1", () => {
    expect(hostMessageSchema.parse({props: {scenario: "5"}, requestId: "r1", scenarioId: "5", type: "as-review-restore", v: 1, viewId: "arkcase-forms/form-builder"}).type)
      .toBe("as-review-restore");
    expect(hostMessageSchema.parse({props: ["scenario"], requestId: "r2", type: "as-review-capture", v: 1}).type)
      .toBe("as-review-capture");
    expect(frameMessageSchema.parse({outcome: "restored", requestId: null, state, type: "as-review-view-state", v: 1}).type)
      .toBe("as-review-view-state");
  });

  test("carries capture on submit and reasons on unanchored", () => {
    const submit = frameMessageSchema.parse({
      anchor: null,
      body: "b",
      capture: {region: {label: "Minimum length", regionId: "inspector.validation.min-length", tagName: "label"}, state},
      originalText: "",
      type: "as-review-submit",
      v: 1,
    });
    expect(submit.type === "as-review-submit" && submit.capture?.region?.tagName).toBe("label");
    const unanchored = frameMessageSchema.parse({reasons: {t1: "region-missing"}, threadIds: ["t1"], type: "as-review-unanchored", v: 1});
    expect(unanchored.type === "as-review-unanchored" && unanchored.reasons).toEqual({t1: "region-missing"});
  });

  test("rejects a restore with too many props", () => {
    const props = Object.fromEntries(Array.from({length: 17}, (_, index) => [`p${index}`, index]));
    expect(hostMessageSchema.safeParse({props, requestId: "r", scenarioId: "5", type: "as-review-restore", v: 1, viewId: "a/b"}).success)
      .toBe(false);
  });
});

describe("page messages", () => {
  test("accepts hello, restored, state, region and regions", () => {
    for (const message of [
      {capabilities: ["restore", "capture", "regions"], pageVersion: 1, type: "as-page-hello"},
      {ok: true, requestId: "r", state, type: "as-page-restored"},
      {requestId: null, state, type: "as-page-state"},
      {region: null, reason: "ambiguous", requestId: "r", type: "as-page-region"},
      {requestId: "r", results: [{count: 1, regionId: "a.b", tagName: "label"}], type: "as-page-regions"},
    ]) {
      expect(pageMessageSchema.safeParse(message).success, message.type).toBe(true);
    }
  });

  test.each([
    ["an oversized label", {region: {label: "x".repeat(257), regionId: "a", tagName: "div"}, requestId: "r", type: "as-page-region"}],
    ["a malformed region id", {region: {label: "x", regionId: "A B", tagName: "div"}, requestId: "r", type: "as-page-region"}],
    ["too many region results", {requestId: "r", results: Array.from({length: 65}, () => ({count: 0, regionId: "a", tagName: null})), type: "as-page-regions"}],
    ["an unknown capability", {capabilities: ["teleport"], pageVersion: 1, type: "as-page-hello"}],
    ["a plannotator bridge message", {type: "plannotator-bridge-ready"}],
  ])("rejects %s", (_name, message) => {
    expect(pageMessageSchema.safeParse(message).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review-frame/protocol.test.ts`
Expected: FAIL with `Failed to resolve import "./page-protocol.ts"`.

- [ ] **Step 3: Write the page protocol**

Create `apps/web/src/review-frame/page-protocol.ts`:

```ts
import {z} from "zod";

/**
 * The review frame ↔ page adapter channel. The page runs in an opaque-origin
 * `srcdoc` sandbox inside the review frame and is untrusted: every message it
 * sends is validated here, and the frame never reads its document.
 */
export const pageProtocolVersion = 1;

export const scenarioIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u);
export const regionIdSchema = z.string().max(128).regex(/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/u);
export const propNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u);
const requestIdSchema = z.string().min(1).max(64);
const propValueSchema = z.union([z.string().max(256), z.number().finite(), z.boolean()]);

export const pagePropsSchema = z.record(propNameSchema, propValueSchema)
  .refine((props) => Object.keys(props).length <= 16, "At most 16 props.");
export type PageProps = z.infer<typeof pagePropsSchema>;

export const pageStateSchema = z.object({
  direction: z.enum(["ltr", "rtl"]),
  locale: z.string().max(64).nullable(),
  pageVersion: z.number().int().min(1).max(1_000),
  props: pagePropsSchema,
  scenarioId: scenarioIdSchema.nullable(),
  theme: z.enum(["light", "dark"]),
  viewport: z.object({
    height: z.number().int().min(0).max(100_000),
    width: z.number().int().min(0).max(100_000),
  }).strict(),
}).strict();
export type PageState = z.infer<typeof pageStateSchema>;

export const pageRegionSchema = z.object({
  label: z.string().max(256),
  regionId: regionIdSchema,
  tagName: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
}).strict();
export type PageRegion = z.infer<typeof pageRegionSchema>;

/** Every message a page adapter may send to the review frame. */
export const pageMessageSchema = z.discriminatedUnion("type", [
  z.object({
    capabilities: z.array(z.enum(["capture", "regions", "restore"])).max(8),
    pageVersion: z.number().int().min(1).max(1_000),
    type: z.literal("as-page-hello"),
  }).strict(),
  z.object({
    ok: z.boolean(),
    reason: z.enum(["adapter-error", "timeout"]).optional(),
    requestId: requestIdSchema,
    state: pageStateSchema.nullable(),
    type: z.literal("as-page-restored"),
  }).strict(),
  z.object({
    requestId: requestIdSchema.nullable(),
    state: pageStateSchema,
    type: z.literal("as-page-state"),
  }).strict(),
  z.object({
    reason: z.enum(["ambiguous", "none"]).optional(),
    region: pageRegionSchema.nullable(),
    requestId: requestIdSchema,
    type: z.literal("as-page-region"),
  }).strict(),
  z.object({
    requestId: requestIdSchema,
    results: z.array(z.object({
      count: z.number().int().min(0).max(10_000),
      regionId: regionIdSchema,
      tagName: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u).nullable(),
    }).strict()).max(64),
    type: z.literal("as-page-regions"),
  }).strict(),
]);
export type PageMessage = z.infer<typeof pageMessageSchema>;

/** Every message the review frame sends to a page adapter. */
export type FrameToPageMessage =
  | {readonly pageVersion: number; readonly type: "as-page-welcome"}
  | {readonly props: PageProps; readonly requestId: string; readonly type: "as-page-restore"}
  | {readonly props: readonly string[]; readonly requestId: string; readonly type: "as-page-capture"}
  | {readonly requestId: string; readonly selector: string; readonly type: "as-page-region-at"}
  | {readonly regionIds: readonly string[]; readonly requestId: string; readonly type: "as-page-region-find"};
```

- [ ] **Step 4: Extend the host ↔ frame protocol**

In `apps/web/src/review-frame/protocol.ts`, add the import:

```ts
import {
  pagePropsSchema,
  pageRegionSchema,
  pageStateSchema,
  propNameSchema,
  regionIdSchema,
  scenarioIdSchema,
} from "./page-protocol.ts";
```

Replace the `reviewAnchorSchema` declaration with:

```ts
const parameterValueSchema = z.union([z.string().max(256), z.number().finite(), z.boolean()]);

/**
 * Where on a designed page a comment was made. Copied from the version's
 * validated views document and the page's confirmed state at capture time,
 * so the anchor describes its own location without another lookup.
 */
export const viewAnchorSchema = z.object({
  regionId: regionIdSchema.optional(),
  regionLabel: z.string().max(64).optional(),
  scenarioId: scenarioIdSchema,
  scenarioLabel: z.string().max(200),
  sourceRef: z.object({
    line: z.number().int().min(1).optional(),
    path: z.string().min(1).max(1_024),
  }).strict(),
  state: z.object({
    direction: z.enum(["ltr", "rtl"]),
    locale: z.string().max(64).nullable(),
    parameters: z.record(propNameSchema, parameterValueSchema),
    theme: z.enum(["light", "dark"]),
    viewport: z.object({
      height: z.number().int().min(0).max(100_000),
      width: z.number().int().min(0).max(100_000),
    }).strict(),
  }).strict(),
  viewFormat: z.literal(1),
  viewId: z.string().min(1).max(128),
}).strict();

export type ViewAnchor = z.infer<typeof viewAnchorSchema>;

/**
 * The anchor shape this client stores on a comment thread. The server treats
 * it as opaque, so the frame is its only reader: anything it does not
 * recognise (a whole-file `{kind: "page"}` anchor, an anchor written by a
 * future client) becomes `null` and the thread simply gets no page marker,
 * which is the same fail-closed outcome the bridge's own anchor builder uses.
 * The parse is loose so a later field survives a read, and an invalid `view`
 * block reads as absent rather than breaking the whole anchor.
 */
export const reviewAnchorSchema = z.object({
  htmlAdditionalTargets: z.array(htmlAnnotationTargetSchema).max(16).optional(),
  htmlAnchor: htmlElementAnchorSchema.nullable(),
  originalText: z.string().max(10_000),
  view: viewAnchorSchema.optional().catch(undefined),
}).loose();
```

Add these members to `hostMessageSchema`'s array:

```ts
  z.object({
    props: pagePropsSchema,
    requestId: z.string().min(1).max(64),
    scenarioId: scenarioIdSchema,
    type: z.literal("as-review-restore"),
    v: versionSchema,
    viewId: z.string().min(1).max(128),
  }),
  z.object({
    props: z.array(propNameSchema).max(16),
    requestId: z.string().min(1).max(64),
    type: z.literal("as-review-capture"),
    v: versionSchema,
  }),
```

In `frameMessageSchema`, replace the `as-review-submit` and `as-review-unanchored` members and add `as-review-view-state`:

```ts
  z.object({
    anchor: optionalAnchorSchema,
    body: z.string(),
    capture: z.object({
      region: pageRegionSchema.nullable(),
      state: pageStateSchema.nullable(),
    }).strict().optional(),
    originalText: z.string(),
    type: z.literal("as-review-submit"),
    v: versionSchema,
  }),
```

```ts
  z.object({
    reasons: z.record(z.string(), z.enum(["region-ambiguous", "region-missing"])).optional(),
    threadIds: z.array(z.string()),
    type: z.literal("as-review-unanchored"),
    v: versionSchema,
  }),
  z.object({
    outcome: z.enum(["failed", "restored", "unsupported"]),
    reason: z.enum(["adapter-error", "no-adapter", "scenario-mismatch", "timeout"]).optional(),
    requestId: z.string().min(1).max(64).nullable(),
    state: pageStateSchema.nullable(),
    type: z.literal("as-review-view-state"),
    v: versionSchema,
  }),
```

At the end of the type exports add:

```ts
export type ViewStateMessage = Extract<FrameMessage, {type: "as-review-view-state"}>;
export type UnanchoredReason = "region-ambiguous" | "region-missing";
export type RestoreRequest = Extract<HostMessage, {type: "as-review-restore"}>;
export type CaptureRequest = Extract<HostMessage, {type: "as-review-capture"}>;
```

- [ ] **Step 5: Run the tests and the web typecheck**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review-frame/protocol.test.ts && pnpm --filter @artifact-server/web typecheck`
Expected: PASS. The `.loose()` anchor type gains an index signature; if `review-frame.tsx`'s `toAnnotation` or `activity/` readers fail to typecheck, fix them by reading named fields only, never by casting to `any`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/review-frame/page-protocol.ts apps/web/src/review-frame/protocol.ts apps/web/src/review-frame/protocol.test.ts
git commit -m "Define the page adapter channel and view-aware review anchors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0176RtcKJPmhiiSHHmBTiJSZ"
```

---

### Task 2: The review frame's page channel

**Files:**
- Create: `apps/web/src/review-frame/page-channel.ts`
- Test: `apps/web/src/review-frame/page-channel.test.ts`

**Interfaces:**
- Consumes: `PageMessage`, `FrameToPageMessage`, `PageProps`, `PageState`, `PageRegion`, `pageProtocolVersion` (Task 1).
- Produces:
  - `type RestoreResult = {outcome: "restored"; state: PageState} | {outcome: "failed"; reason: "adapter-error" | "scenario-mismatch" | "timeout"; state: PageState | null} | {outcome: "unsupported"; reason: "no-adapter"}`
  - `type RegionAnswer = {region: PageRegion} | {region: null; reason: "ambiguous" | "none" | "unsupported"}`
  - `interface PageChannel { receive(message: PageMessage): void; reset(): void; restore(props: PageProps, scenarioId: string): Promise<RestoreResult>; capture(props: readonly string[]): Promise<PageState | null>; regionAt(selector: string): Promise<RegionAnswer>; findRegions(regionIds: readonly string[]): Promise<ReadonlyMap<string, {count: number; tagName: string | null}> | null>; supports(): boolean | null }`
  - `createPageChannel(options: {post(message: FrameToPageMessage): void; onUnpromptedState(state: PageState): void; schedule?(callback: () => void, milliseconds: number): () => void; nextRequestId?(): string; helloTimeoutMilliseconds?: number; replyTimeoutMilliseconds?: number}): PageChannel`

`findRegions` answers `null` when the page has no adapter or did not reply in time, so the caller can tell "no answer" from "zero matches". `supports()` is `null` while waiting for hello, then `true` or `false`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/review-frame/page-channel.test.ts`:

```ts
import {describe, expect, test} from "vitest";

import {createPageChannel} from "./page-channel.ts";
import type {FrameToPageMessage, PageState} from "./page-protocol.ts";

function harness() {
  const posted: FrameToPageMessage[] = [];
  const unprompted: PageState[] = [];
  const timers: {callback: () => void; at: number; cancelled: boolean}[] = [];
  let now = 0;
  let next = 0;
  const channel = createPageChannel({
    nextRequestId: () => `r${++next}`,
    onUnpromptedState: (state) => unprompted.push(state),
    post: (message) => posted.push(message),
    schedule: (callback, milliseconds) => {
      const timer = {at: now + milliseconds, callback, cancelled: false};
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  const advance = (milliseconds: number) => {
    now += milliseconds;
    for (const timer of timers.filter((candidate) => !candidate.cancelled && candidate.at <= now)) {
      timer.cancelled = true;
      timer.callback();
    }
  };
  return {advance, channel, posted, unprompted};
}

const state = (scenarioId: string | null): PageState => ({
  direction: "ltr",
  locale: null,
  pageVersion: 1,
  props: {scenario: scenarioId ?? "none"},
  scenarioId,
  theme: "light",
  viewport: {height: 900, width: 1440},
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const hello = {capabilities: ["capture", "regions", "restore"], pageVersion: 3, type: "as-page-hello"} as const;

describe("page channel", () => {
  test("negotiates the lower version and restores after hello", async () => {
    const {channel, posted} = harness();
    const restoring = channel.restore({scenario: "5"}, "5");
    channel.receive(hello);
    await flush();
    expect(posted[0]).toEqual({pageVersion: 1, type: "as-page-welcome"});
    expect(posted[1]).toEqual({props: {scenario: "5"}, requestId: "r1", type: "as-page-restore"});
    channel.receive({ok: true, requestId: "r1", state: state("5"), type: "as-page-restored"});
    expect(await restoring).toEqual({outcome: "restored", state: state("5")});
  });

  test("reports a page that confirms another scenario as a mismatch", async () => {
    const {channel} = harness();
    channel.receive(hello);
    const restoring = channel.restore({scenario: "5"}, "5");
    await flush();
    channel.receive({ok: true, requestId: "r1", state: state("6"), type: "as-page-restored"});
    expect(await restoring).toEqual({outcome: "failed", reason: "scenario-mismatch", state: state("6")});
  });

  test("reports no adapter after the hello wait", async () => {
    const {advance, channel} = harness();
    const restoring = channel.restore({scenario: "5"}, "5");
    advance(3_000);
    expect(await restoring).toEqual({outcome: "unsupported", reason: "no-adapter"});
    expect(channel.supports()).toBe(false);
    expect(await channel.findRegions(["a"])).toBeNull();
  });

  test("times out a restore the page never answers", async () => {
    const {advance, channel} = harness();
    channel.receive(hello);
    const restoring = channel.restore({scenario: "5"}, "5");
    await flush();
    advance(6_000);
    expect(await restoring).toEqual({outcome: "failed", reason: "timeout", state: null});
  });

  test("ignores replies to unknown requests and relays unprompted state", async () => {
    const {channel, unprompted} = harness();
    channel.receive(hello);
    channel.receive({ok: true, requestId: "never-asked", state: state("5"), type: "as-page-restored"});
    channel.receive({region: null, reason: "none", requestId: "never-asked", type: "as-page-region"});
    channel.receive({requestId: null, state: state("6"), type: "as-page-state"});
    expect(unprompted).toEqual([state("6")]);
  });

  test("forgets the old document on reset", async () => {
    const {advance, channel} = harness();
    channel.receive(hello);
    const before = channel.capture(["scenario"]);
    await flush();
    channel.reset();
    channel.receive({requestId: "r1", state: state("5"), type: "as-page-state"});
    expect(await before).toBeNull();
    expect(channel.supports()).toBeNull();
    advance(3_000);
    expect(channel.supports()).toBe(false);
  });

  test("answers region queries", async () => {
    const {channel} = harness();
    channel.receive(hello);
    const at = channel.regionAt("label[data-review-region=\"a.b\"]");
    const find = channel.findRegions(["a.b", "gone"]);
    await flush();
    channel.receive({region: {label: "Minimum length", regionId: "a.b", tagName: "label"}, requestId: "r1", type: "as-page-region"});
    channel.receive({requestId: "r2", results: [{count: 1, regionId: "a.b", tagName: "label"}, {count: 0, regionId: "gone", tagName: null}], type: "as-page-regions"});
    expect(await at).toEqual({region: {label: "Minimum length", regionId: "a.b", tagName: "label"}});
    expect(await find).toEqual(new Map([["a.b", {count: 1, tagName: "label"}], ["gone", {count: 0, tagName: null}]]));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review-frame/page-channel.test.ts`
Expected: FAIL with `Failed to resolve import "./page-channel.ts"`.

- [ ] **Step 3: Implement the channel**

Create `apps/web/src/review-frame/page-channel.ts`:

```ts
import {
  pageProtocolVersion,
  type FrameToPageMessage,
  type PageMessage,
  type PageProps,
  type PageRegion,
  type PageState,
} from "./page-protocol.ts";

export type RestoreResult =
  | {readonly outcome: "restored"; readonly state: PageState}
  | {
    readonly outcome: "failed";
    readonly reason: "adapter-error" | "scenario-mismatch" | "timeout";
    readonly state: PageState | null;
  }
  | {readonly outcome: "unsupported"; readonly reason: "no-adapter"};

export type RegionAnswer =
  | {readonly region: PageRegion}
  | {readonly reason: "ambiguous" | "none" | "unsupported"; readonly region: null};

export type RegionCounts = ReadonlyMap<string, {readonly count: number; readonly tagName: string | null}>;

export interface PageChannel {
  readonly capture: (props: readonly string[]) => Promise<PageState | null>;
  readonly findRegions: (regionIds: readonly string[]) => Promise<RegionCounts | null>;
  readonly receive: (message: PageMessage) => void;
  readonly regionAt: (selector: string) => Promise<RegionAnswer>;
  /** The sandbox document was replaced: forget its handshake and pending replies. */
  readonly reset: () => void;
  readonly restore: (props: PageProps, scenarioId: string) => Promise<RestoreResult>;
  /** `null` while waiting for hello, then whether this page has an adapter. */
  readonly supports: () => boolean | null;
}

export interface PageChannelOptions {
  readonly helloTimeoutMilliseconds?: number;
  readonly nextRequestId?: () => string;
  readonly onUnpromptedState: (state: PageState) => void;
  readonly post: (message: FrameToPageMessage) => void;
  readonly replyTimeoutMilliseconds?: number;
  readonly schedule?: (callback: () => void, milliseconds: number) => () => void;
}

type Pending = (message: PageMessage | null) => void;

const defaultSchedule = (callback: () => void, milliseconds: number): (() => void) => {
  const handle = setTimeout(callback, milliseconds);
  return () => clearTimeout(handle);
};

/** One page adapter session inside the review frame's sandbox. */
export function createPageChannel(options: PageChannelOptions): PageChannel {
  const schedule = options.schedule ?? defaultSchedule;
  const nextRequestId = options.nextRequestId ?? (() => crypto.randomUUID());
  const helloTimeout = options.helloTimeoutMilliseconds ?? 3_000;
  const replyTimeout = options.replyTimeoutMilliseconds ?? 6_000;
  let supported: boolean | null = null;
  let waiters: ((supported: boolean) => void)[] = [];
  let pending = new Map<string, Pending>();
  let cancelHelloWait = schedule(() => settleHello(false), helloTimeout);

  function settleHello(value: boolean): void {
    if (supported !== null) return;
    supported = value;
    cancelHelloWait();
    const ready = waiters;
    waiters = [];
    for (const waiter of ready) waiter(value);
  }

  function ready(): Promise<boolean> {
    if (supported !== null) return Promise.resolve(supported);
    return new Promise((resolve) => waiters.push(resolve));
  }

  /** Send one request and wait for its reply, or `null` on timeout or reset. */
  async function ask(build: (requestId: string) => FrameToPageMessage): Promise<PageMessage | null> {
    if (!await ready()) return null;
    const requestId = nextRequestId();
    const owner = pending;
    return new Promise((resolve) => {
      const cancel = schedule(() => {
        if (owner.delete(requestId)) resolve(null);
      }, replyTimeout);
      owner.set(requestId, (message) => {
        cancel();
        resolve(message);
      });
      options.post(build(requestId));
    });
  }

  return {
    capture: async (props) => {
      const reply = await ask((requestId) => ({props, requestId, type: "as-page-capture"}));
      return reply?.type === "as-page-state" ? reply.state : null;
    },
    findRegions: async (regionIds) => {
      const reply = await ask((requestId) => ({regionIds, requestId, type: "as-page-region-find"}));
      if (reply?.type !== "as-page-regions") return null;
      return new Map(reply.results.map((result) => [result.regionId, {count: result.count, tagName: result.tagName}]));
    },
    receive: (message) => {
      if (message.type === "as-page-hello") {
        if (supported === null) {
          options.post({pageVersion: Math.min(message.pageVersion, pageProtocolVersion), type: "as-page-welcome"});
          settleHello(true);
        }
        return;
      }
      if (message.type === "as-page-state" && message.requestId === null) {
        options.onUnpromptedState(message.state);
        return;
      }
      const requestId = message.requestId;
      if (requestId === null) return;
      const resolve = pending.get(requestId);
      if (resolve === undefined) return;
      pending.delete(requestId);
      resolve(message);
    },
    regionAt: async (selector) => {
      const reply = await ask((requestId) => ({requestId, selector, type: "as-page-region-at"}));
      if (reply?.type !== "as-page-region") return {reason: supported === false ? "unsupported" : "none", region: null};
      return reply.region === null ? {reason: reply.reason ?? "none", region: null} : {region: reply.region};
    },
    reset: () => {
      const abandoned = pending;
      pending = new Map();
      for (const resolve of abandoned.values()) resolve(null);
      const blocked = waiters;
      waiters = [];
      supported = null;
      cancelHelloWait();
      cancelHelloWait = schedule(() => settleHello(false), helloTimeout);
      // Callers waiting on the old document's hello must wait for the new one.
      waiters.push(...blocked);
    },
    restore: async (props, scenarioId) => {
      if (!await ready()) return {outcome: "unsupported", reason: "no-adapter"};
      const reply = await ask((requestId) => ({props, requestId, type: "as-page-restore"}));
      if (reply === null) return {outcome: "failed", reason: "timeout", state: null};
      if (reply.type !== "as-page-restored") return {outcome: "failed", reason: "adapter-error", state: null};
      if (!reply.ok) return {outcome: "failed", reason: reply.reason ?? "adapter-error", state: reply.state};
      if (reply.state?.scenarioId !== scenarioId) {
        return {outcome: "failed", reason: "scenario-mismatch", state: reply.state};
      }
      return {outcome: "restored", state: reply.state};
    },
    supports: () => supported,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review-frame/page-channel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/review-frame/page-channel.ts apps/web/src/review-frame/page-channel.test.ts
git commit -m "Relay restore, capture and region queries to a page adapter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0176RtcKJPmhiiSHHmBTiJSZ"
```

---

### Task 3: Plannotator learns `data-review-region` as a stable identity

**Files:**
- Modify: `patches/@plannotator__ui@0.31.0.patch` (regenerated by `pnpm patch-commit`)

**Interfaces:**
- Produces: in the sandbox bridge, `ANCHOR_IDENTITY_ATTRS` and `STABLE_IDENTITY_ATTRS` both list `data-review-region` immediately after `data-annotate`. A selector `tag[data-review-region="id"]` therefore resolves by uniqueness alone, and a click on a region element is captured with that selector.

- [ ] **Step 1: Open the package for patching**

Run: `pnpm patch @plannotator/ui@0.31.0`
Expected: pnpm prints a temporary directory containing the package with the existing patch applied. Call it `$PATCH_DIR`.

- [ ] **Step 2: Add the attribute to both identity lists**

In `$PATCH_DIR/components/html-viewer/bridge-script.ts`, change:

```js
  var ANCHOR_IDENTITY_ATTRS = ['data-annotate', 'data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa', 'aria-label', 'name', 'role', 'href', 'alt'];
```

to:

```js
  var ANCHOR_IDENTITY_ATTRS = ['data-annotate', 'data-review-region', 'data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa', 'aria-label', 'name', 'role', 'href', 'alt'];
```

and:

```js
  var STABLE_IDENTITY_ATTRS = ['data-annotate', 'data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa'];
```

to:

```js
  var STABLE_IDENTITY_ATTRS = ['data-annotate', 'data-review-region', 'data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa'];
```

- [ ] **Step 3: Commit the patch and reinstall**

Run: `pnpm patch-commit "$PATCH_DIR" && pnpm install --frozen-lockfile`
Expected: `patches/@plannotator__ui@0.31.0.patch` now contains both hunks plus the existing HtmlViewer hunk, and install succeeds.

- [ ] **Step 4: Confirm the installed copy carries the change**

Run: `grep -c "data-review-region" apps/web/node_modules/@plannotator/ui/components/html-viewer/bridge-script.ts`
Expected: `2`.

- [ ] **Step 5: Run the existing sandbox browser spec**

Run: `pnpm test:web -- tests/browser/review-sandbox.spec.ts`
Expected: PASS (no behavior change for pages without the attribute).

- [ ] **Step 6: Commit**

```bash
git add patches/@plannotator__ui@0.31.0.patch pnpm-lock.yaml
git commit -m "Treat data-review-region as a stable annotation identity

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0176RtcKJPmhiiSHHmBTiJSZ"
```

---

### Task 4: Host-side scenario model

**Files:**
- Create: `apps/web/src/api/views.ts`
- Create: `apps/web/src/review/workspace/scenario-model.ts`
- Test: `apps/web/src/review/workspace/scenario-model.test.ts`

**Interfaces:**
- Consumes: `ViewAnchor`, `ReviewAnchor`, `ReviewAnnotation`, `UnanchoredReason` (Task 1); `PageRegion`, `PageState`, `PageProps` (Task 1).
- Produces, in `apps/web/src/api/views.ts`:
  - `viewsOutcomeSchema`, `type ViewsOutcome`, `type ReviewView`, `type ReviewScenario` (zod mirrors of Plan A's outcome)
  - `provenanceOutcomeSchema`, `type ProvenanceOutcome`
- Produces, in `scenario-model.ts`:
  - `viewForPath(outcome: ViewsOutcome | null, path: string | null): ReviewView | null`
  - `restorePropsFor(view: ReviewView, scenarioId: string, parameters: Readonly<Record<string, ParameterValue>>): PageProps | null`
  - `captureProps(view: ReviewView): readonly string[]`
  - `parametersFromProps(view: ReviewView, props: PageProps): Record<string, ParameterValue>`
  - `viewAnchorFrom(view: ReviewView, capture: {state: PageState | null; region: PageRegion | null} | undefined): ViewAnchor | undefined`
  - `sanitizeLabel(text: string, maximum: number): string`
  - `type ThreadPlacement = {kind: "place"} | {kind: "other-scenario"; scenarioId: string; scenarioLabel: string}`
  - `threadPlacement(anchor: ReviewAnchor | null, view: ReviewView | null, onScreenScenarioId: string | null): ThreadPlacement`
  - `annotationsForScenario(annotations: readonly ReviewAnnotation[], view: ReviewView | null, onScreenScenarioId: string | null): ReviewAnnotation[]`
  - `type ScenarioStatus = {status: "idle" | "restoring" | "ready" | "unsupported" | "failed"; scenarioId: string | null; reason: string | null; requestId: string | null}`
  - `reduceViewState(current: ScenarioStatus, message: ViewStateMessage, view: ReviewView): ScenarioStatus`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/review/workspace/scenario-model.test.ts`:

```ts
import {describe, expect, test} from "vitest";

import type {ReviewView} from "../../api/views.ts";
import type {PageState} from "../../review-frame/page-protocol.ts";
import {
  annotationsForScenario,
  captureProps,
  parametersFromProps,
  reduceViewState,
  restorePropsFor,
  sanitizeLabel,
  threadPlacement,
  viewAnchorFrom,
  viewForPath,
} from "./scenario-model.ts";

const view: ReviewView = {
  defaultScenarioId: "1",
  label: "Fixture",
  parameters: [{default: "ltr", name: "direction", prop: "chromeRtl", values: [{propValue: false, value: "ltr"}, {propValue: true, value: "rtl"}]}],
  path: "honest.html",
  scenarios: [
    {label: "Library", props: {scenario: "1"}, scenarioId: "1"},
    {label: "Inspector · Validation", props: {scenario: "5"}, scenarioId: "5"},
  ],
  sourceRef: {line: 12, path: "fixture/honest.html"},
  viewId: "fixture/honest",
};
const state = (scenarioId: string | null, chromeRtl = false): PageState => ({
  direction: chromeRtl ? "rtl" : "ltr",
  locale: "en",
  pageVersion: 1,
  props: {chromeRtl, scenario: scenarioId ?? ""},
  scenarioId,
  theme: "light",
  viewport: {height: 900, width: 1440},
});

describe("scenario model", () => {
  test("finds the view for the open path only when the outcome is valid", () => {
    expect(viewForPath({status: "valid", views: [view]}, "honest.html")).toBe(view);
    expect(viewForPath({status: "valid", views: [view]}, "other.html")).toBeNull();
    expect(viewForPath({diagnostic: "x", status: "invalid"}, "honest.html")).toBeNull();
  });

  test("merges scenario props with parameter props and rejects unknown scenarios", () => {
    expect(restorePropsFor(view, "5", {direction: "rtl"})).toEqual({chromeRtl: true, scenario: "5"});
    expect(restorePropsFor(view, "5", {})).toEqual({chromeRtl: false, scenario: "5"});
    expect(restorePropsFor(view, "99", {})).toBeNull();
    expect(captureProps(view)).toEqual(["scenario", "chromeRtl"]);
    expect(parametersFromProps(view, {chromeRtl: true, scenario: "5"})).toEqual({direction: "rtl"});
  });

  test("builds a view anchor only for a scenario the views document declares", () => {
    const anchor = viewAnchorFrom(view, {region: {label: "Minimum‮ length​", regionId: "inspector.min", tagName: "label"}, state: state("5")});
    expect(anchor).toEqual({
      regionId: "inspector.min",
      regionLabel: "Minimum length",
      scenarioId: "5",
      scenarioLabel: "Inspector · Validation",
      sourceRef: {line: 12, path: "fixture/honest.html"},
      state: {direction: "ltr", locale: "en", parameters: {direction: "ltr"}, theme: "light", viewport: {height: 900, width: 1440}},
      viewFormat: 1,
      viewId: "fixture/honest",
    });
    expect(viewAnchorFrom(view, {region: null, state: state("42")})).toBeUndefined();
    expect(viewAnchorFrom(view, {region: null, state: null})).toBeUndefined();
    expect(viewAnchorFrom(view, undefined)).toBeUndefined();
  });

  test("sanitizes and bounds labels", () => {
    expect(sanitizeLabel("  a\u0007b⁦c​d  ", 64)).toBe("abcd");
    expect(sanitizeLabel("x".repeat(100), 64)).toHaveLength(64);
  });

  test("places threads of the scenario on screen and lists the others", () => {
    const inFive = {htmlAnchor: null, originalText: "", view: viewAnchorFrom(view, {region: null, state: state("5")})};
    expect(threadPlacement(inFive, view, "5")).toEqual({kind: "place"});
    expect(threadPlacement(inFive, view, "1")).toEqual({kind: "other-scenario", scenarioId: "5", scenarioLabel: "Inspector · Validation"});
    expect(threadPlacement({htmlAnchor: null, originalText: ""}, view, "1")).toEqual({kind: "place"});
    expect(threadPlacement(inFive, null, null)).toEqual({kind: "place"});
    const annotations = [
      {anchor: inFive, body: "five", state: "open" as const, threadId: "t5"},
      {anchor: null, body: "page", state: "open" as const, threadId: "tp"},
    ];
    expect(annotationsForScenario(annotations, view, "1").map((annotation) => annotation.threadId)).toEqual(["tp"]);
  });

  test("lets only the latest restore set the scenario on screen", () => {
    const restoring = {reason: null, requestId: "r2", scenarioId: null, status: "restoring" as const};
    const stale = reduceViewState(restoring, {outcome: "restored", requestId: "r1", state: state("5"), type: "as-review-view-state", v: 1}, view);
    expect(stale).toBe(restoring);
    const done = reduceViewState(restoring, {outcome: "restored", requestId: "r2", state: state("1"), type: "as-review-view-state", v: 1}, view);
    expect(done).toEqual({reason: null, requestId: null, scenarioId: "1", status: "ready"});
    const failed = reduceViewState(restoring, {outcome: "failed", reason: "timeout", requestId: "r2", state: null, type: "as-review-view-state", v: 1}, view);
    expect(failed).toEqual({reason: "timeout", requestId: null, scenarioId: null, status: "failed"});
    const moved = reduceViewState(done, {outcome: "restored", requestId: null, state: state("5"), type: "as-review-view-state", v: 1}, view);
    expect(moved.scenarioId).toBe("5");
    const unknown = reduceViewState(done, {outcome: "restored", requestId: null, state: state("42"), type: "as-review-view-state", v: 1}, view);
    expect(unknown.scenarioId).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review/workspace/scenario-model.test.ts`
Expected: FAIL with `Failed to resolve import "../../api/views.ts"`.

- [ ] **Step 3: Write the API outcome schemas**

Create `apps/web/src/api/views.ts`:

```ts
import {z} from "zod";

/** Client mirrors of the server's per-version views and provenance outcomes. */
const propValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const reviewScenarioSchema = z.object({
  label: z.string(),
  props: z.record(z.string(), propValueSchema),
  scenarioId: z.string(),
}).strict();

export const reviewViewSchema = z.object({
  defaultScenarioId: z.string(),
  label: z.string(),
  parameters: z.array(z.object({
    default: propValueSchema,
    name: z.string(),
    prop: z.string(),
    values: z.array(z.object({propValue: propValueSchema, value: propValueSchema}).strict()),
  }).strict()),
  path: z.string(),
  scenarios: z.array(reviewScenarioSchema),
  sourceRef: z.object({line: z.number().int().optional(), path: z.string()}).strict(),
  viewId: z.string(),
}).strict();

export const viewsOutcomeSchema = z.discriminatedUnion("status", [
  z.object({status: z.literal("valid"), views: z.array(reviewViewSchema)}).strict(),
  z.object({status: z.literal("absent")}).strict(),
  z.object({status: z.literal("unsupported-version"), version: z.number()}).strict(),
  z.object({diagnostic: z.string(), status: z.literal("invalid")}).strict(),
]);

const coverageSchema = z.object({
  declaredOutputs: z.number(),
  dependencyEdges: z.enum(["complete", "none", "partial"]),
  externalVariability: z.array(z.string()),
  manifestFiles: z.number(),
}).strict();
const provenanceRecordSchema = z.object({
  source: z.object({
    commit: z.string(),
    descriptorId: z.string(),
    dirty: z.boolean(),
    repository: z.string(),
  }).strict(),
}).loose();

export const provenanceOutcomeSchema = z.discriminatedUnion("status", [
  z.object({coverage: coverageSchema, record: provenanceRecordSchema, status: z.literal("verified")}).strict(),
  z.object({
    coverage: coverageSchema,
    mismatchCount: z.number(),
    mismatches: z.array(z.object({path: z.string(), reason: z.enum(["digest", "missing"])}).strict()),
    record: provenanceRecordSchema,
    status: z.literal("mismatch"),
  }).strict(),
  z.object({diagnostic: z.string(), status: z.literal("invalid")}).strict(),
  z.object({status: z.literal("unsupported-version"), version: z.number()}).strict(),
  z.object({status: z.literal("not-recorded")}).strict(),
]);

export type ViewsOutcome = z.infer<typeof viewsOutcomeSchema>;
export type ReviewView = z.infer<typeof reviewViewSchema>;
export type ReviewScenario = z.infer<typeof reviewScenarioSchema>;
export type ProvenanceOutcome = z.infer<typeof provenanceOutcomeSchema>;
```

- [ ] **Step 4: Write the scenario model**

Create `apps/web/src/review/workspace/scenario-model.ts`:

```ts
import type {ReviewView, ViewsOutcome} from "../../api/views.ts";
import type {PageProps, PageRegion, PageState} from "../../review-frame/page-protocol.ts";
import type {
  ReviewAnchor,
  ReviewAnnotation,
  ViewAnchor,
  ViewStateMessage,
} from "../../review-frame/protocol.ts";

export type ParameterValue = string | number | boolean;

export type ThreadPlacement =
  | {readonly kind: "place"}
  | {readonly kind: "other-scenario"; readonly scenarioId: string; readonly scenarioLabel: string};

export interface ScenarioStatus {
  readonly reason: string | null;
  /** The restore or capture this state is waiting on; only its reply may settle it. */
  readonly requestId: string | null;
  readonly scenarioId: string | null;
  readonly status: "failed" | "idle" | "ready" | "restoring" | "unsupported";
}

const invisibleOrControl = /[\p{Cc}\p{Cf}]/gu;

/** The valid view whose page is open, or null. */
export function viewForPath(outcome: ViewsOutcome | null, path: string | null): ReviewView | null {
  if (outcome?.status !== "valid" || path === null) return null;
  return outcome.views.find((view) => view.path === path) ?? null;
}

/** The props that reproduce one declared scenario with the given parameters. */
export function restorePropsFor(
  view: ReviewView,
  scenarioId: string,
  parameters: Readonly<Record<string, ParameterValue>>,
): PageProps | null {
  const scenario = view.scenarios.find((candidate) => candidate.scenarioId === scenarioId);
  if (scenario === undefined) return null;
  const props: Record<string, ParameterValue> = {...scenario.props};
  for (const parameter of view.parameters) {
    const chosen = parameters[parameter.name] ?? parameter.default;
    const option = parameter.values.find((candidate) => candidate.value === chosen)
      ?? parameter.values.find((candidate) => candidate.value === parameter.default);
    if (option !== undefined) props[parameter.prop] = option.propValue;
  }
  return props;
}

/** Every prop name the view declares, scenario props first. */
export function captureProps(view: ReviewView): readonly string[] {
  const names = new Set<string>();
  for (const scenario of view.scenarios) for (const name of Object.keys(scenario.props)) names.add(name);
  for (const parameter of view.parameters) names.add(parameter.prop);
  return [...names];
}

/** Map captured prop values back to the view's declared parameter values. */
export function parametersFromProps(view: ReviewView, props: PageProps): Record<string, ParameterValue> {
  const parameters: Record<string, ParameterValue> = {};
  for (const parameter of view.parameters) {
    const option = parameter.values.find((candidate) => candidate.propValue === props[parameter.prop]);
    if (option !== undefined) parameters[parameter.name] = option.value;
  }
  return parameters;
}

/** Strip control, format (bidi and zero-width) characters, collapse spaces and bound. */
export function sanitizeLabel(text: string, maximum: number): string {
  return text.replace(invisibleOrControl, "").replace(/\s+/gu, " ").trim().slice(0, maximum);
}

/** The stored view block, or undefined when the page did not confirm a declared scenario. */
export function viewAnchorFrom(
  view: ReviewView,
  capture: {readonly region: PageRegion | null; readonly state: PageState | null} | undefined,
): ViewAnchor | undefined {
  const state = capture?.state ?? null;
  if (state === null || state.scenarioId === null) return undefined;
  const scenario = view.scenarios.find((candidate) => candidate.scenarioId === state.scenarioId);
  if (scenario === undefined) return undefined;
  const anchor: ViewAnchor = {
    scenarioId: scenario.scenarioId,
    scenarioLabel: sanitizeLabel(scenario.label, 200),
    sourceRef: view.sourceRef,
    state: {
      direction: state.direction,
      locale: state.locale,
      parameters: parametersFromProps(view, state.props),
      theme: state.theme,
      viewport: state.viewport,
    },
    viewFormat: 1,
    viewId: view.viewId,
  };
  const region = capture?.region ?? null;
  if (region === null) return anchor;
  const label = sanitizeLabel(region.label, 64);
  return label === ""
    ? {...anchor, regionId: region.regionId}
    : {...anchor, regionId: region.regionId, regionLabel: label};
}

/** Whether a thread belongs on the page as it is now. */
export function threadPlacement(
  anchor: ReviewAnchor | null,
  view: ReviewView | null,
  onScreenScenarioId: string | null,
): ThreadPlacement {
  const located = anchor?.view;
  if (view === null || located === undefined || located.viewId !== view.viewId) return {kind: "place"};
  if (located.scenarioId === onScreenScenarioId) return {kind: "place"};
  return {kind: "other-scenario", scenarioId: located.scenarioId, scenarioLabel: located.scenarioLabel};
}

/** The annotations the frame should place for the scenario on screen. */
export function annotationsForScenario(
  annotations: readonly ReviewAnnotation[],
  view: ReviewView | null,
  onScreenScenarioId: string | null,
): ReviewAnnotation[] {
  return annotations.filter((annotation) =>
    threadPlacement(annotation.anchor, view, onScreenScenarioId).kind === "place"
  );
}

/** Settle the on-screen scenario from one frame report; stale replies change nothing. */
export function reduceViewState(
  current: ScenarioStatus,
  message: ViewStateMessage,
  view: ReviewView,
): ScenarioStatus {
  if (message.requestId !== null && message.requestId !== current.requestId) return current;
  const confirmed = message.state?.scenarioId ?? null;
  const declared = confirmed !== null && view.scenarios.some((scenario) => scenario.scenarioId === confirmed)
    ? confirmed
    : null;
  if (message.outcome === "restored") {
    return {reason: null, requestId: null, scenarioId: declared, status: "ready"};
  }
  if (message.outcome === "unsupported") {
    return {reason: message.reason ?? "no-adapter", requestId: null, scenarioId: null, status: "unsupported"};
  }
  return {reason: message.reason ?? "adapter-error", requestId: null, scenarioId: declared, status: "failed"};
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @artifact-server/web exec vitest run src/review/workspace/scenario-model.test.ts && pnpm --filter @artifact-server/web typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/api/views.ts apps/web/src/review/workspace/scenario-model.ts apps/web/src/review/workspace/scenario-model.test.ts
git commit -m "Model designed scenarios, view anchors and thread placement

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0176RtcKJPmhiiSHHmBTiJSZ"
```

---

### Task 5: The review frame relays scenarios, captures context and resolves regions

**Files:**
- Modify: `apps/web/src/review-frame/review-frame.tsx`

**Interfaces:**
- Consumes: `createPageChannel` (Task 2); `pageMessageSchema` (Task 1); the new host and frame messages (Task 1).
- Produces (observable over postMessage):
  - On `as-review-restore`: one `as-review-view-state` with the same `requestId`.
  - On `as-review-capture`: one `as-review-view-state` with outcome `restored` and the page's state, or `unsupported` with reason `no-adapter`.
  - Unprompted page state: `as-review-view-state` with `requestId: null`.
  - `as-review-submit` carries `capture` when the page has an adapter.
  - Annotations whose anchor names a `regionId` are placed through `<tagName>[data-review-region="<id>"]` when exactly one element carries it, otherwise excluded and reported in `as-review-unanchored.reasons`.

This task is proven by the browser specs in Task 9; the units it composes are tested in Tasks 1, 2 and 4.

- [ ] **Step 1: Add the page channel and its listener**

In `apps/web/src/review-frame/review-frame.tsx`, add imports:

```ts
import { createPageChannel, type PageChannel } from "./page-channel.ts";
import { pageMessageSchema } from "./page-protocol.ts";
```

and extend the `./protocol.ts` import with `type UnanchoredReason`.

Below `applyTheme`, add:

```ts
/** The sandboxed artifact document's window, which only Plannotator creates. */
function pageWindow(): Window | null {
  return document.querySelector<HTMLIFrameElement>("iframe[srcdoc]")?.contentWindow ?? null;
}

/** A thread anchored to a region is placed by that region's own identity selector. */
function regionAnnotation(
  annotation: Annotation,
  regionId: string,
  tagName: string,
): Annotation {
  const point = annotation.htmlAnchor?.point;
  const regionAnchor = {
    selector: `${tagName}[data-review-region="${regionId}"]`,
    tagName,
    ...(point === undefined ? {} : {point}),
  };
  const {htmlAdditionalTargets: _targets, ...rest} = annotation;
  return {...rest, htmlAnchor: regionAnchor};
}
```

Inside `ReviewFrame`, after `const paintedIdsRef = …`, add:

```ts
  const channelRef = useRef<PageChannel | null>(null);
  const capturePropsRef = useRef<readonly string[]>([]);
  const viewerUnanchoredRef = useRef<readonly string[]>([]);
  const regionFailuresRef = useRef<ReadonlyMap<string, UnanchoredReason>>(new Map());
  const annotationGenerationRef = useRef(0);

  const reportUnanchored = useCallback((): void => {
    const failures = regionFailuresRef.current;
    const threadIds = [...new Set([...viewerUnanchoredRef.current, ...failures.keys()])];
    send(failures.size === 0
      ? {threadIds, type: "as-review-unanchored", v: reviewProtocolVersion}
      : {reasons: Object.fromEntries(failures), threadIds, type: "as-review-unanchored", v: reviewProtocolVersion});
  }, [send]);
```

Note that `reportUnanchored` uses `send`, so place it after `send` is declared.

Add a second effect (after the host-message effect) that owns the page channel:

```ts
  useEffect(() => {
    const channel = createPageChannel({
      onUnpromptedState: (state) => {
        send({outcome: "restored", requestId: null, state, type: "as-review-view-state", v: reviewProtocolVersion});
      },
      post: (message) => {
        // The sandbox's origin is opaque ("null"), so no narrower target exists.
        pageWindow()?.postMessage(message, "*");
      },
    });
    channelRef.current = channel;
    const onPageMessage = (event: MessageEvent<unknown>): void => {
      const page = pageWindow();
      if (page === null || event.source !== page || event.origin !== "null") return;
      const parsed = pageMessageSchema.safeParse(event.data);
      if (parsed.success) channel.receive(parsed.data);
    };
    window.addEventListener("message", onPageMessage);
    return () => {
      window.removeEventListener("message", onPageMessage);
      channel.reset();
      channelRef.current = null;
    };
  }, [send]);
```

- [ ] **Step 2: Resolve region anchors before the viewer sees them**

Add inside `ReviewFrame`:

```ts
  const applyAnnotations = useCallback(async (reviews: readonly ReviewAnnotation[]): Promise<Annotation[]> => {
    const generation = ++annotationGenerationRef.current;
    const regionIds = [...new Set(reviews.flatMap((review) => review.anchor?.view?.regionId ?? []))];
    const failures = new Map<string, UnanchoredReason>();
    let placed = reviews.map(toAnnotation);
    if (regionIds.length > 0) {
      const counts = await channelRef.current?.findRegions(regionIds.slice(0, 64)) ?? null;
      if (generation !== annotationGenerationRef.current) return [];
      placed = reviews.flatMap((review) => {
        const regionId = review.anchor?.view?.regionId;
        const annotation = toAnnotation(review);
        if (regionId === undefined) return [annotation];
        const found = counts?.get(regionId);
        if (found !== undefined && found.count === 1 && found.tagName !== null) {
          return [regionAnnotation(annotation, regionId, found.tagName)];
        }
        failures.set(review.threadId, (found?.count ?? 0) > 1 ? "region-ambiguous" : "region-missing");
        return [];
      });
    }
    regionFailuresRef.current = failures;
    reportUnanchored();
    return placed;
  }, [reportUnanchored]);
```

- [ ] **Step 3: Route the new host messages**

In the host-message `onMessage` handler, replace the `as-review-init` and `as-review-annotations` branches, and add two branches before the final `setSelectedThreadId(message.threadId);`.

The init branch keeps today's behavior for anchors without regions: the viewer paints them when its bridge reports ready, and `paintedIdsRef` is seeded so the reconcile effect does not paint them twice. Only when some anchor names a region does init paint nothing and wait for the adapter's answer. (For a page with a valid view the host sends `annotations: []` at init anyway, and sends the real set once the scenario is confirmed.)

```ts
      if (message.type === "as-review-init") {
        applyTheme(message);
        channelRef.current?.reset();
        regionFailuresRef.current = new Map();
        viewerUnanchoredRef.current = [];
        const hasRegions = message.annotations.some((annotation) => annotation.anchor?.view?.regionId !== undefined);
        if (!hasRegions) {
          paintedIdsRef.current = new Set(message.annotations.map((annotation) => annotation.threadId));
          setSession(sessionFrom(message));
          return;
        }
        paintedIdsRef.current = new Set();
        setSession({...sessionFrom(message), annotations: []});
        void applyAnnotations(message.annotations).then((annotations) => {
          setSession((current) => current === null ? current : {...current, annotations});
        });
        return;
      }
      if (message.type === "as-review-annotations") {
        void applyAnnotations(message.annotations).then((annotations) => {
          setSession((current) => current === null ? current : {...current, annotations});
        });
        return;
      }
      if (message.type === "as-review-restore") {
        capturePropsRef.current = Object.keys(message.props);
        const channel = channelRef.current;
        void (channel === null
          ? Promise.resolve({outcome: "unsupported", reason: "no-adapter"} as const)
          : channel.restore(message.props, message.scenarioId)
        ).then((result) => {
          send(result.outcome === "restored"
            ? {outcome: "restored", requestId: message.requestId, state: result.state, type: "as-review-view-state", v: reviewProtocolVersion}
            : result.outcome === "failed"
              ? {outcome: "failed", reason: result.reason, requestId: message.requestId, state: result.state, type: "as-review-view-state", v: reviewProtocolVersion}
              : {outcome: "unsupported", reason: "no-adapter", requestId: message.requestId, state: null, type: "as-review-view-state", v: reviewProtocolVersion});
        });
        return;
      }
      if (message.type === "as-review-capture") {
        capturePropsRef.current = message.props;
        void (channelRef.current?.capture(message.props) ?? Promise.resolve(null)).then((state) => {
          send(state === null
            ? {outcome: "unsupported", reason: "no-adapter", requestId: message.requestId, state: null, type: "as-review-view-state", v: reviewProtocolVersion}
            : {outcome: "restored", requestId: message.requestId, state, type: "as-review-view-state", v: reviewProtocolVersion});
        });
        return;
      }
```

Add `applyAnnotations` to that effect's dependency list (`[send, applyAnnotations]`).

- [ ] **Step 4: Capture page context on submit and merge unanchored reports**

Replace `handleAdd` with:

```ts
  const handleAdd = useCallback((annotation: Annotation): void => {
    setSession((current) =>
      current === null
        ? current
        : {...current, annotations: [...current.annotations, annotation]}
    );
    const anchor = reviewAnchorFrom(
      annotation.originalText,
      annotation.htmlAnchor,
      annotation.htmlAdditionalTargets,
    );
    const channel = channelRef.current;
    const selector = annotation.htmlAnchor?.selector;
    void (async () => {
      const capture = channel === null || channel.supports() !== true
        ? undefined
        : await Promise.all([
          channel.capture(capturePropsRef.current),
          selector === undefined ? Promise.resolve(null) : channel.regionAt(selector).then((answer) => answer.region),
        ]).then(([state, region]) => ({region, state}));
      send({
        anchor,
        body: annotation.text ?? "",
        ...(capture === undefined ? {} : {capture}),
        originalText: annotation.originalText,
        type: "as-review-submit",
        v: reviewProtocolVersion,
      });
    })();
  }, [send]);
```

Replace `handleUnanchored` with:

```ts
  const handleUnanchored = useCallback((threadIds: string[]): void => {
    viewerUnanchoredRef.current = threadIds;
    reportUnanchored();
  }, [reportUnanchored]);
```

- [ ] **Step 5: Typecheck, lint and run the web unit tests**

Run: `pnpm --filter @artifact-server/web typecheck && pnpm lint && pnpm --filter @artifact-server/web test`
Expected: PASS. Oxlint may flag the unused `_targets` binding; if so, build the region annotation with an explicit field list instead of rest-destructuring.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/review-frame/review-frame.tsx
git commit -m "Relay scenario restore and region anchors through the review frame

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0176RtcKJPmhiiSHHmBTiJSZ"
```

---

### Task 6: Host scenario session, preview integration and URL state

**Files:**
- Modify: `apps/web/src/api/client.ts` (two methods in `export const api`)
- Create: `apps/web/src/review/workspace/scenario-session.tsx`
- Modify: `apps/web/src/review/workspace/preview-canvas.tsx` (`HtmlPreview`, lines ~496-790)
- Modify: `apps/web/src/review/review-routes.ts` (`ReviewLocation`, `readReviewLocation`, `workspaceHref`)
- Modify: `apps/web/src/review/review-routes.test.ts`
- Modify: `apps/web/src/review/review-comments.tsx` (unanchored reasons)
- Modify: `apps/web/src/review/review-app.tsx` (provider, URL sync, popstate restore, submit)

**Interfaces:**
- Consumes: `viewsOutcomeSchema`, `provenanceOutcomeSchema` (Task 4 `api/views.ts`); every `scenario-model.ts` export (Task 4); the protocol messages (Task 1).
- Produces:
  - `api.versionViews(projectId, artifactId, versionId): Promise<ViewsOutcome>` and `api.versionProvenance(...): Promise<ProvenanceOutcome>`
  - `ScenarioSessionProvider` and `useScenarioSession(): ScenarioSession` where `ScenarioSession = {view: ReviewView | null; outcome: ViewsOutcome | null; onScreen: ScenarioStatus; requested: {scenarioId: string; parameters: Record<string, ParameterValue>; revision: number} | null; requestScenario(scenarioId: string, parameters?: Record<string, ParameterValue>): void; beginRequest(requestId: string): void; report(message: ViewStateMessage): void}`
  - `ReviewLocation.scenarioId?: string | null`, read from and written to `scenario=`
  - `ReviewCommentSession.unanchoredReasons: ReadonlyMap<string, UnanchoredReason>`; `updateUnanchored(threadIds, reasons?)`
  - `HtmlPreview` defaults to Annotate when the open path has a valid view.

- [ ] **Step 1: Write the failing route test**

In `apps/web/src/review/review-routes.test.ts`, add:

```ts
test("round-trips a designed scenario after the path", () => {
  const href = workspaceHref({...emptyLocation, artifactId: "art_1", path: "project/builder.html", projectId: "prj_default", scenarioId: "5", versionId: "ver_1"});
  expect(href).toBe("/review?project=prj_default&artifact=art_1&version=ver_1&path=project%2Fbuilder.html&scenario=5");
  expect(readReviewLocation(new URL(`https://example.test${href}`).searchParams).scenarioId).toBe("5");
  expect(readReviewLocation(new URLSearchParams("artifact=a")).scenarioId).toBeNull();
});
```

Run: `pnpm --filter @artifact-server/web exec vitest run src/review/review-routes.test.ts`
Expected: FAIL; the href lacks `&scenario=5`.

- [ ] **Step 2: Add `scenarioId` to review locations**

In `apps/web/src/review/review-routes.ts`, add to `ReviewLocation`:

```ts
  /** A designed scenario of the open page's view; optional so other navigation drops it. */
  readonly scenarioId?: string | null;
```

In `readReviewLocation`'s returned object add `scenarioId: search.get("scenario"),`. In `workspaceHref`, after the `path` line, add:

```ts
  if (location.scenarioId !== null && location.scenarioId !== undefined) search.set("scenario", location.scenarioId);
```

Run the route tests again. Expected: PASS. If the existing round-trip tests compare `readReviewLocation` output with `toEqual` against literals without `scenarioId`, add `scenarioId: null` to those literals.

- [ ] **Step 3: Add the API methods**

In `apps/web/src/api/client.ts`, import `provenanceOutcomeSchema` and `viewsOutcomeSchema` from `./views.ts`, and add to `api` next to `versionFile`:

```ts
  versionViews: (projectId: string, artifactId: string, versionId: string) =>
    request(
      viewsOutcomeSchema,
      `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/views?${projectQuery(projectId)}`,
    ),
  versionProvenance: (projectId: string, artifactId: string, versionId: string) =>
    request(
      provenanceOutcomeSchema,
      `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/provenance?${projectQuery(projectId)}`,
    ),
```

If `request` requires an `init` argument, pass `{}` as the third argument, matching the nearest existing GET call.

- [ ] **Step 4: Write the scenario session context**

Create `apps/web/src/review/workspace/scenario-session.tsx`:

```tsx
import {createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode} from "react";

import {api} from "../../api/client.ts";
import type {ReviewView, ViewsOutcome} from "../../api/views.ts";
import type {ViewStateMessage} from "../../review-frame/protocol.ts";
import {
  reduceViewState,
  viewForPath,
  type ParameterValue,
  type ScenarioStatus,
} from "./scenario-model.ts";

export interface ScenarioRequestState {
  readonly parameters: Readonly<Record<string, ParameterValue>>;
  /** Bumped by every request, so asking for the same scenario again restores again. */
  readonly revision: number;
  readonly scenarioId: string;
}

export interface ScenarioSession {
  readonly beginRequest: (requestId: string) => void;
  readonly onScreen: ScenarioStatus;
  readonly outcome: ViewsOutcome | null;
  readonly report: (message: ViewStateMessage) => void;
  readonly requestScenario: (scenarioId: string, parameters?: Readonly<Record<string, ParameterValue>>) => void;
  readonly requested: ScenarioRequestState | null;
  readonly view: ReviewView | null;
}

const idle: ScenarioStatus = {reason: null, requestId: null, scenarioId: null, status: "idle"};

const noScenarios: ScenarioSession = {
  beginRequest: () => undefined,
  onScreen: idle,
  outcome: null,
  report: () => undefined,
  requestScenario: () => undefined,
  requested: null,
  view: null,
};

const ScenarioSessionContext = createContext<ScenarioSession>(noScenarios);

/** The open page's designed scenarios, what is on screen, and what was asked for. */
export function useScenarioSession(): ScenarioSession {
  return useContext(ScenarioSessionContext);
}

export function ScenarioSessionProvider({
  artifactId,
  children,
  initialScenarioId,
  path,
  projectId,
  versionId,
}: {
  readonly artifactId: string | null;
  readonly children: ReactNode;
  readonly initialScenarioId: string | null;
  readonly path: string | null;
  readonly projectId: string;
  readonly versionId: string | null;
}) {
  const [loaded, setLoaded] = useState<{readonly outcome: ViewsOutcome; readonly versionId: string} | null>(null);
  const [onScreen, setOnScreen] = useState<ScenarioStatus>(idle);
  const [requested, setRequested] = useState<ScenarioRequestState | null>(
    initialScenarioId === null ? null : {parameters: {}, revision: 1, scenarioId: initialScenarioId},
  );

  useEffect(() => {
    if (artifactId === null || versionId === null || projectId === "") return undefined;
    let current = true;
    // Outcomes are per immutable version, so one read per version suffices.
    void api.versionViews(projectId, artifactId, versionId).then(
      (outcome) => {
        if (current) setLoaded({outcome, versionId});
      },
      () => {
        if (current) setLoaded({outcome: {diagnostic: "Views could not be read.", status: "invalid"}, versionId});
      },
    );
    return () => {
      current = false;
    };
  }, [artifactId, projectId, versionId]);

  const outcome = loaded !== null && loaded.versionId === versionId ? loaded.outcome : null;
  const view = viewForPath(outcome, path);

  useEffect(() => {
    // A new page or version starts unknown; the preview captures or restores it.
    setOnScreen(idle);
  }, [path, versionId]);

  const requestScenario = useCallback((scenarioId: string, parameters: Readonly<Record<string, ParameterValue>> = {}) => {
    setRequested((previous) => ({parameters, revision: (previous?.revision ?? 0) + 1, scenarioId}));
  }, []);
  const beginRequest = useCallback((requestId: string) => {
    setOnScreen((current) => ({...current, reason: null, requestId, status: "restoring"}));
  }, []);
  const report = useCallback((message: ViewStateMessage) => {
    if (view === null) return;
    setOnScreen((current) => reduceViewState(current, message, view));
  }, [view]);

  const value = useMemo<ScenarioSession>(() => ({
    beginRequest,
    onScreen,
    outcome,
    report,
    requestScenario,
    requested,
    view,
  }), [beginRequest, onScreen, outcome, report, requestScenario, requested, view]);
  return <ScenarioSessionContext.Provider value={value}>{children}</ScenarioSessionContext.Provider>;
}
```

- [ ] **Step 5: Integrate the preview**

In `apps/web/src/review/workspace/preview-canvas.tsx` `HtmlPreview`:

1. Add imports: `useScenarioSession` from `./scenario-session.tsx`; `annotationsForScenario`, `captureProps`, `restorePropsFor` from `./scenario-model.ts`.
2. Change the `onUnanchoredChange` prop type to `(threadIds: readonly string[], reasons: Readonly<Record<string, UnanchoredReason>>) => void` and the call in the message handler to `onUnanchoredChange(message.threadIds, message.reasons ?? {});`. Update the same prop type in `ReviewPreview` and `PreviewCanvas`.
3. Change the `onSubmitAnnotation` call in the submit branch so the anchor carries the view block:

```ts
      void (async () => {
        const view = scenario.view;
        const located = view === null ? undefined : viewAnchorFrom(view, message.capture);
        const anchor = message.anchor === null || located === undefined
          ? message.anchor
          : {...message.anchor, view: located};
        const saved = await onSubmitAnnotation(message.body, anchor, entry.path);
        if (!saved) postToFrame({annotations: [...annotations], type: "as-review-annotations", v: reviewProtocolVersion});
      })();
```

(import `viewAnchorFrom` too, and keep the rest of the branch as it is).

4. At the top of the component body add:

```ts
  const scenario = useScenarioSession();
  const placed = useMemo(
    () => annotationsForScenario(annotations, scenario.view, scenario.onScreen.scenarioId),
    [annotations, scenario.onScreen.scenarioId, scenario.view],
  );
  const holdAnnotations = scenario.view !== null
    && (scenario.onScreen.status === "idle" || scenario.onScreen.status === "restoring");
```

5. Change the mode default so a page with a valid view opens in Annotate:

```ts
  const mode = chosenMode ?? (previewDocument?.prefersInteractive === true && scenario.view === null
    ? "interactive"
    : "annotate");
```

6. In the message handler, add before the submit fall-through:

```ts
      if (message.type === "as-review-view-state") {
        scenario.report(message);
        return;
      }
```

and add `scenario` to the effect's dependency list.

7. In the init effect, send no annotations for a page with a view (`annotations: scenario.view === null ? [...annotations] : []`), then ask for the state:

```ts
    if (scenario.view !== null) {
      const requestId = crypto.randomUUID();
      scenario.beginRequest(requestId);
      const props = scenario.requested === null
        ? null
        : restorePropsFor(scenario.view, scenario.requested.scenarioId, scenario.requested.parameters);
      postToFrame(props === null || scenario.requested === null
        ? {props: [...captureProps(scenario.view)], requestId, type: "as-review-capture", v: reviewProtocolVersion}
        : {props, requestId, scenarioId: scenario.requested.scenarioId, type: "as-review-restore", v: reviewProtocolVersion, viewId: scenario.view.viewId});
    }
```

Add `scenario.view`, `scenario.requested` and `scenario.beginRequest` to the init effect's dependency list; `initialisedRef` still keeps it to one run per frame.

8. Add an effect that restores when the reviewer asks for another scenario after init:

```ts
  const requestedRevision = scenario.requested?.revision ?? 0;
  useEffect(() => {
    const view = scenario.view;
    const wanted = scenario.requested;
    if (!initialisedRef.current || view === null || wanted === null) return;
    const props = restorePropsFor(view, wanted.scenarioId, wanted.parameters);
    if (props === null) return;
    const requestId = crypto.randomUUID();
    scenario.beginRequest(requestId);
    postToFrame({props, requestId, scenarioId: wanted.scenarioId, type: "as-review-restore", v: reviewProtocolVersion, viewId: view.viewId});
    // Only a new request revision restores; on-screen changes must not loop back here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedRevision, postToFrame]);
```

If Oxlint's `react-hooks/exhaustive-deps` is not configured, drop the disable comment; never weaken the rule globally.

9. Replace the annotations effect so it waits for the scenario and sends only the threads that belong on screen:

```ts
  useEffect(() => {
    if (!initialisedRef.current || holdAnnotations) return;
    postToFrame({
      annotations: placed,
      type: "as-review-annotations",
      v: reviewProtocolVersion,
    });
  }, [holdAnnotations, placed, postToFrame]);
```

- [ ] **Step 6: Carry unanchored reasons in the comment session**

In `apps/web/src/review/review-comments.tsx`:

```ts
  readonly unanchoredReasons: ReadonlyMap<string, UnanchoredReason>;
  readonly updateUnanchored: (
    threadIds: readonly string[],
    reasons?: Readonly<Record<string, UnanchoredReason>>,
  ) => void;
```

with state `const [unanchoredReasons, setUnanchoredReasons] = useState<ReadonlyMap<string, UnanchoredReason>>(new Map());`, an `updateUnanchored` callback that sets both `setUnanchoredIds(threadIds)` and `setUnanchoredReasons(new Map(Object.entries(reasons ?? {})))`, and both values in the returned object. Reset `unanchoredReasons` wherever `setUnanchoredIds([])` is called today.

- [ ] **Step 7: Provide the session and sync the URL**

In `apps/web/src/review/review-app.tsx`:

1. Wrap the workspace's returned element (the element that contains both `ReviewToolbar`/`PreviewCanvas` and the inspector with `CommentsTab`) in:

```tsx
    <ScenarioSessionProvider
      artifactId={selectedArtifactId}
      initialScenarioId={initialLocation.scenarioId ?? null}
      path={selectedPath ?? selectedVersion?.manifest.entryPath ?? null}
      projectId={projectId}
      versionId={selectedVersionId}
    >
      …existing element…
    </ScenarioSessionProvider>
```

2. The URL-sync effect must know the scenario on screen, but `review-app.tsx`'s component is the provider's parent. Add a child component inside the provider that writes the parameter:

```tsx
/** Keeps `scenario=` in the review URL in step with the scenario on screen. */
function ScenarioUrlSync({focusMode, path, projectId, artifactId, versionId}: {
  readonly artifactId: string | null;
  readonly focusMode: boolean;
  readonly path: string | null;
  readonly projectId: string;
  readonly versionId: string | null;
}) {
  const scenario = useScenarioSession();
  const scenarioId = scenario.view === null ? null : scenario.onScreen.scenarioId ?? scenario.requested?.scenarioId ?? null;
  useEffect(() => {
    writeReviewHistory(workspaceHref({
      artifactId,
      path,
      projectId,
      scenarioId,
      threadId: null,
      versionId,
      view: focusMode ? "focus" : null,
    }), "replace");
  }, [artifactId, focusMode, path, projectId, scenarioId, versionId]);
  return null;
}
```

Render `<ScenarioUrlSync artifactId={selectedArtifactId} focusMode={focusMode} path={selectedPath} projectId={projectId} versionId={selectedVersionId} />` as the provider's first child, and delete the existing URL-sync `useEffect` (lines ~574-584) that it replaces.

3. Thread unanchored reasons: `onUnanchoredChange={comments.updateUnanchored}` already matches the new signature.

- [ ] **Step 8: Typecheck, lint and run unit tests**

Run: `pnpm --filter @artifact-server/web typecheck && pnpm lint && pnpm --filter @artifact-server/web test`
Expected: PASS.

- [ ] **Step 9: Run the existing review browser specs**

Run: `pnpm test:web -- tests/browser/cmt-015-focus-mode.spec.ts tests/browser/review-sandbox.spec.ts tests/browser/cmt-016-exact-review-url.spec.ts`
Expected: PASS. (If the exact-URL spec has another file name, run `ls tests/browser | grep -i url` and use it.) Pages without views must behave exactly as before.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/review/workspace/scenario-session.tsx apps/web/src/review/workspace/preview-canvas.tsx \
  apps/web/src/review/review-routes.ts apps/web/src/review/review-routes.test.ts apps/web/src/review/review-comments.tsx apps/web/src/review/review-app.tsx
git commit -m "Restore designed scenarios before placing comments in Review

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0176RtcKJPmhiiSHHmBTiJSZ"
```

---

### Task 7: Scenario picker, comment locations and provenance in Details

**Files:**
- Modify: `apps/web/src/review/workspace/review-toolbar.tsx` (props and markup after the annotate toggle, line ~333)
- Modify: `apps/web/src/review/review-app.tsx` (pass the picker and provenance)
- Modify: `apps/web/src/review/workspace/comments-tab.tsx` (`ThreadBody`, line ~402)
- Modify: `apps/web/src/review/workspace/details-tab.tsx`

**Interfaces:**
- Consumes: `useScenarioSession` (Task 6), `threadPlacement` (Task 4), `reviewAnchorSchema` (Task 1), `api.versionProvenance` and `ProvenanceOutcome` (Task 6, Task 4).
- Produces: a `Select` labelled "Designed scenario" in the toolbar; per-thread location copy with an "Open" button; a "Source" section in Details.

- [ ] **Step 1: Add the scenario picker to the toolbar**

In `review-toolbar.tsx`, import `useScenarioSession` from `./scenario-session.tsx` and `Select` from `@/arkcase` (if not already imported). Inside `ReviewToolbar`, before the returned JSX:

```tsx
  const scenario = useScenarioSession();
  const scenarioPicker = scenario.view === null ? null : (
    <>
      <Select
        aria-label="Designed scenario"
        fit="selected"
        onChange={(event) => scenario.requestScenario(event.currentTarget.value)}
        options={scenario.view.scenarios.map((option) => ({
          label: `${option.scenarioId} · ${option.label}`,
          value: option.scenarioId,
        }))}
        placeholder="Scenario"
        size="viewer"
        value={scenario.onScreen.scenarioId ?? scenario.requested?.scenarioId ?? ""}
      />
      {scenario.onScreen.status === "failed" || scenario.onScreen.status === "unsupported" ? (
        <span role="status" style={scenarioStatusStyle}>
          {`Couldn't open scenario ${scenario.requested?.scenarioId ?? ""} (${scenario.onScreen.reason ?? "unknown"})`}
        </span>
      ) : null}
    </>
  );
```

with `const scenarioStatusStyle = {color: "var(--text-danger)", fontSize: 12, whiteSpace: "nowrap"} satisfies CSSProperties;` at module level. Render `{scenarioPicker}` immediately after the annotate `IconButton` block and before `<ToolbarSpacer />`.

- [ ] **Step 2: Show each thread's location**

In `comments-tab.tsx`, import `useScenarioSession`, `threadPlacement` and `reviewAnchorSchema`. Extend `ThreadBodyProps` with `readonly unanchoredReason: UnanchoredReason | null;` and pass `unanchoredReason={session.unanchoredReasons.get(thread.id) ?? null}` where `ThreadBody` is rendered. Replace the line

```tsx
      {unanchored ? <p style={metaStyle}>Location unavailable in this version</p> : null}
```

with:

```tsx
      <ThreadLocation thread={thread} unanchored={unanchored} unanchoredReason={unanchoredReason} />
```

and add:

```tsx
/** Where a thread is on the page now: placed, in another scenario, or unavailable. */
function ThreadLocation({thread, unanchored, unanchoredReason}: {
  readonly thread: ReviewThread;
  readonly unanchored: boolean;
  readonly unanchoredReason: UnanchoredReason | null;
}) {
  const scenario = useScenarioSession();
  const parsed = reviewAnchorSchema.safeParse(thread.anchor);
  const anchor = parsed.success ? parsed.data : null;
  const placement = threadPlacement(anchor, scenario.view, scenario.onScreen.scenarioId);
  const wanted = anchor?.view?.scenarioId ?? null;
  if (
    wanted !== null &&
    scenario.requested?.scenarioId === wanted &&
    (scenario.onScreen.status === "failed" || scenario.onScreen.status === "unsupported")
  ) {
    return <p style={metaStyle}>{`Location unavailable: scenario ${wanted} couldn't be opened`}</p>;
  }
  if (placement.kind === "other-scenario") {
    return (
      <p style={metaStyle}>
        {`In scenario ${placement.scenarioId} · ${placement.scenarioLabel}`}{" "}
        <Button onClick={() => scenario.requestScenario(placement.scenarioId, anchor?.view?.state.parameters ?? {})} outline size="xs" variant="secondary">
          Open
        </Button>
      </p>
    );
  }
  if (unanchoredReason !== null) return <p style={metaStyle}>Location unavailable: the region isn't on the page</p>;
  return unanchored ? <p style={metaStyle}>Location unavailable in this version</p> : null;
}
```

`ThreadBody` passes `thread`, `unanchored` and `unanchoredReason` through. Clicking "Open" also selects the thread: wrap the onClick as `() => { scenario.requestScenario(...); }`; selection already happens because the click is inside the selectable list item.

- [ ] **Step 3: Show provenance in Details**

In `details-tab.tsx`, add `readonly provenance: ProvenanceOutcome | null;` to `DetailsTabProps`, accept it in `DetailsTab`, and insert before the "Identifiers" section:

```tsx
      {provenance === null || provenance.status === "not-recorded" ? (
        <PanelSection title="Source">
          <p style={noteStyle}>Source not recorded. Agents can inspect this version but not edit its source.</p>
        </PanelSection>
      ) : provenance.status === "invalid" || provenance.status === "unsupported-version" ? (
        <PanelSection title="Source">
          <p style={noteStyle}>
            {provenance.status === "invalid"
              ? `The source record is invalid: ${provenance.diagnostic}`
              : `The source record uses unsupported version ${provenance.version}.`}
          </p>
        </PanelSection>
      ) : (
        <PanelSection title="Source">
          <FieldGrid
            fields={[
              {
                label: "Check",
                value: <StatusPill label={provenance.status === "verified" ? "Verified" : `Mismatch · ${provenance.mismatchCount}`} tone={provenance.status === "verified" ? "primary" : "danger"} />,
              },
              {label: "Repository", mono: true, value: provenance.record.source.repository},
              {label: "Authored commit", mono: true, note: provenance.record.source.dirty ? "Built from uncommitted changes." : undefined, value: provenance.record.source.commit},
              {label: "Manifest", mono: true, value: version.manifest.digest},
              {
                label: "Coverage",
                value: `${provenance.coverage.declaredOutputs} of ${provenance.coverage.manifestFiles} files declared · dependency edges ${provenance.coverage.dependencyEdges}`,
              },
            ]}
            labelWidth={labelWidth}
            layout="inline"
          />
          {provenance.status === "mismatch" ? (
            <p style={noteStyle}>{`Differs from the record: ${provenance.mismatches.slice(0, 5).map((item) => item.path).join(", ")}`}</p>
          ) : null}
        </PanelSection>
      )}
```

If `StatusPill` has no `danger` tone, use the tone its type declares for errors. If `FieldGrid` fields have no `note` key, put the dirty note in a `<p style={noteStyle}>` below the grid.

In `review-app.tsx`, load provenance per version:

```ts
  const [provenance, setProvenance] = useState<{readonly outcome: ProvenanceOutcome; readonly versionId: string} | null>(null);
  useEffect(() => {
    if (selectedArtifactId === null || selectedVersionId === null) return undefined;
    let current = true;
    void api.versionProvenance(projectId, selectedArtifactId, selectedVersionId).then((outcome) => {
      if (current) setProvenance({outcome, versionId: selectedVersionId});
    }, () => undefined);
    return () => {
      current = false;
    };
  }, [projectId, selectedArtifactId, selectedVersionId]);
```

and pass `provenance={provenance?.versionId === selectedVersionId ? provenance.outcome : null}` to `DetailsTab`.

- [ ] **Step 4: Typecheck, lint, unit tests**

Run: `pnpm --filter @artifact-server/web typecheck && pnpm lint && pnpm --filter @artifact-server/web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/review/workspace/review-toolbar.tsx apps/web/src/review/workspace/comments-tab.tsx apps/web/src/review/workspace/details-tab.tsx apps/web/src/review/review-app.tsx
git commit -m "Pick designed scenarios, show comment locations and source provenance

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0176RtcKJPmhiiSHHmBTiJSZ"
```

---

### Task 8: Location lines in agent bundles

**Files:**
- Modify: `src/mcp/dispatch-bundle-message.ts`
- Modify: `src/mcp/artifact-mcp-server.ts` (mailbox item assembly, line ~2209)
- Modify: `patches/@plannotator__agent-bridge@0.1.1.patch` (regenerated)
- Modify: `project/spec/agent-dispatch-spec.md` (recorded shape, lines ~198-212)
- Test: `tests/conformance/dsn-011-bundle-location.test.ts`

**Interfaces:**
- Produces, identically in `src/mcp/dispatch-bundle-message.ts` and the patched `@plannotator/agent-bridge` `index.ts`:
  - `bundleLocationLine(anchor: unknown): string | null`
  - `BundleItem.location?: string | null` (optional, so existing constructors compile unchanged)
  - `renderBundleMessage` prints `   {location}` on its own line after the item header when `location` is a non-empty string.

- [ ] **Step 1: Write the failing tests**

Create `tests/conformance/dsn-011-bundle-location.test.ts`:

```ts
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  bundleLocationLine as packageLocationLine,
  renderBundleMessage as packageRender,
} from "@plannotator/agent-bridge";
import {
  bundleLocationLine,
  renderBundleMessage,
} from "../../src/mcp/dispatch-bundle-message.js";
import {ApiClient, dispatchCreationSchema} from "../support/agent-dispatch.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const protocolVersion = "2026-07-28";
const view = (overrides: Record<string, unknown> = {}) => ({
  regionId: "inspector.validation.min-length",
  regionLabel: "Minimum length",
  scenarioId: "5",
  scenarioLabel: "Inspector · Validation",
  sourceRef: {line: 412, path: "arkcase-forms/project/Prototype - Form Builder.dc.html"},
  state: {direction: "ltr", locale: "en", parameters: {}, theme: "light", viewport: {height: 900, width: 1440}},
  viewFormat: 1,
  viewId: "arkcase-forms/form-builder",
  ...overrides,
});
const expectedLine = "at Inspector · Validation (scenario 5) · region inspector.validation.min-length \"Minimum length\" · source arkcase-forms/project/Prototype - Form Builder.dc.html:412";
const claimSchema = z.object({claimed: z.object({message: z.string()}).loose().nullable()}).loose();
const toolCallResultSchema = z.object({
  result: z.object({isError: z.boolean().optional(), structuredContent: z.unknown()}).loose(),
}).loose();

describe("DSN-011 bundle location", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Forms</title>",
      idempotencyKey: "dsn-011-publish",
      name: "Forms",
    })).body;
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
            [CLIENT_INFO_META_KEY]: {name: "dsn-011-test", version: "1"},
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

  async function openThread(anchor: unknown, key: string): Promise<string> {
    const response = await client.fetch(
      `/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/comments?projectId=${published.artifact.projectId}`,
      {body: JSON.stringify({anchor, body: "Raise the minimum length to 4.", path: "index.html"}), idempotencyKey: key, method: "POST"},
    );
    expect(response.status).toBe(201);
    return z.object({thread: z.object({id: z.string()}).loose()}).loose().parse(await response.json()).thread.id;
  }

  test("DSN-011-B: native and mailbox renders carry the same location line", async () => {
    expect.hasAssertions();
    const anchor = {htmlAnchor: null, originalText: "Minimum length", view: view()};
    expect(bundleLocationLine(anchor)).toBe(expectedLine);
    expect(packageLocationLine(anchor)).toBe(expectedLine);

    const threadId = await openThread(anchor, "dsn-011-b-thread");
    const listed = z.object({agent: z.object({id: z.string()}).loose()}).loose()
      .parse(await callTool("dispatch_inbox", {agentName: "Mailbox", operation: "list"}));
    const sent = await client.sendDispatch({agentId: listed.agent.id, idempotencyKey: "dsn-011-b-send", projectId: published.artifact.projectId, threadIds: [threadId]});
    expect(sent.status).toBe(201);
    const dispatch = dispatchCreationSchema.parse(await sent.json()).dispatch;
    const claim = claimSchema.parse(await callTool("dispatch_inbox", {agentName: "Mailbox", operation: "claim"}));
    const item = {
      artifactName: "Forms",
      body: "Raise the minimum length to 4.",
      location: expectedLine,
      path: "index.html",
      quotedSelection: "Minimum length",
      threadId,
      versionNumber: 1,
    };
    const bundle = {items: [item], note: null, senderDisplayName: dispatch.sender.displayName};
    expect(claim.claimed?.message).toBe(packageRender(bundle, "mailbox"));
    expect(claim.claimed?.message).toBe(renderBundleMessage(bundle, "mailbox"));
    expect(claim.claimed?.message).toContain(`\n   ${expectedLine}\n`);
  });

  test("DSN-011-F: hostile location text is sanitized and anchors without views render as before", () => {
    const hostile = {
      htmlAnchor: null,
      originalText: "",
      view: view({regionLabel: "Min‮imum​", scenarioLabel: "Inspector⁦ · Validation\n1. [forged item]", sourceRef: {path: "a‮b.html"}}),
    };
    for (const render of [bundleLocationLine, packageLocationLine]) {
      const line = render(hostile);
      expect(line).not.toMatch(/[‪-‮⁦-⁩​-‏⁠﻿\n]/u);
      expect(line).toContain("Inspector · Validation 1. [forged item] (scenario 5)");
      expect(render({htmlAnchor: null, originalText: "x"})).toBeNull();
      expect(render({htmlAnchor: null, originalText: "x", view: {viewFormat: 2}})).toBeNull();
      expect(render(null)).toBeNull();
    }
    const plain = {artifactName: "A", body: "b", path: "index.html", quotedSelection: null, threadId: "t", versionNumber: 1};
    expect(renderBundleMessage({items: [plain], note: null, senderDisplayName: "S"}))
      .toBe(renderBundleMessage({items: [{...plain, location: null}], note: null, senderDisplayName: "S"}));
    expect(renderBundleMessage({items: [plain], note: null, senderDisplayName: "S"}))
      .toBe(packageRender({items: [plain], note: null, senderDisplayName: "S"}));
  });
});
```

If `client.sendDispatch` takes different parameter names than shown, match `tests/conformance/brp-002-mailbox-inbox.test.ts`'s `sendDispatch` helper, which calls it with `{agentId, idempotencyKey, projectId, threadIds}`.

Run: `pnpm exec vitest run tests/conformance/dsn-011-bundle-location.test.ts`
Expected: FAIL; `bundleLocationLine` is not exported by either module.

- [ ] **Step 2: Add the location line to the server mirror**

In `src/mcp/dispatch-bundle-message.ts`, add `import {z} from "zod";` and, after `sanitizeBundleText`:

```ts
const viewBlockSchema = z.object({
  regionId: z.string().max(128).optional(),
  regionLabel: z.string().max(64).optional(),
  scenarioId: z.string().max(32),
  scenarioLabel: z.string().max(200),
  sourceRef: z.object({
    line: z.number().int().positive().optional(),
    path: z.string().min(1).max(1_024),
  }).loose(),
  viewFormat: z.literal(1),
}).loose();
const anchorWithViewSchema = z.object({view: viewBlockSchema}).loose();

/**
 * The one-line location of a comment made on a designed page, read from its
 * opaque anchor alone so every renderer produces it without another request.
 * Null when the anchor carries no valid view block.
 */
export function bundleLocationLine(anchor: unknown): string | null {
  const parsed = anchorWithViewSchema.safeParse(anchor);
  if (!parsed.success) return null;
  const view = parsed.data.view;
  const parts = [`at ${view.scenarioLabel} (scenario ${view.scenarioId})`];
  if (view.regionId !== undefined) {
    parts.push(view.regionLabel === undefined ? `region ${view.regionId}` : `region ${view.regionId} "${view.regionLabel}"`);
  }
  parts.push(`source ${view.sourceRef.path}${view.sourceRef.line === undefined ? "" : `:${view.sourceRef.line}`}`);
  return sanitizeBundleText(parts.join(" · ")).replace(/\s+/gu, " ").trim();
}
```

Add to `BundleItem`:

```ts
  /** The comment's designed-page location, when its anchor has one. */
  readonly location?: string | null;
```

In `renderBundleMessage`, after `lines.push(\`${index + 1}. ${place}${quoted}\`);` add:

```ts
    const location = item.location === undefined || item.location === null
      ? ""
      : sanitizeBundleText(item.location).replace(/\s+/gu, " ").trim();
    if (location !== "") lines.push(`   ${location}`);
```

- [ ] **Step 3: Fill the location in mailbox bundles**

In `src/mcp/artifact-mcp-server.ts`, import `bundleLocationLine` from `./dispatch-bundle-message.js` alongside the existing imports from that module, and in the `items.push({ … })` of `assembleMailboxBundle` add:

```ts
        location: bundleLocationLine(thread.anchor),
```

- [ ] **Step 4: Patch the bridge package with the same code**

Run: `pnpm patch @plannotator/agent-bridge@0.1.1` and note the printed directory as `$PATCH_DIR`. In `$PATCH_DIR/index.ts`:

1. Add the same `viewBlockSchema`, `anchorWithViewSchema` and exported `bundleLocationLine` from Step 2 after the package's `sanitizeBundleText` (the package already imports `z`).
2. Add `readonly location?: string | null;` to its `BundleItem`.
3. Add the same three-line `location` block to its `renderBundleMessage`.
4. In `fetchBundle`'s `items.push({ … })` add `location: bundleLocationLine(details.thread.anchor),`.

Run: `pnpm patch-commit "$PATCH_DIR" && pnpm install --frozen-lockfile`
Expected: the patch file now holds the earlier sanitization hunks plus these, and install succeeds.

- [ ] **Step 5: Update the recorded shape**

In `project/spec/agent-dispatch-spec.md`, change the bundle template item to:

```
1. [{artifact name} · version {number} · {path}] {quoted selection, when the anchor has originalText}
   at {scenario label} (scenario {scenarioId}) · region {regionId} "{region label}" · source {source path}[:{line}]   ← only when the anchor has a valid view block; absent parts are left out
   {thread body}
   (thread {threadId})
```

- [ ] **Step 6: Run the bundle tests**

Run: `pnpm exec vitest run tests/conformance/dsn-011-bundle-location.test.ts tests/conformance/brp-002-mailbox-inbox.test.ts tests/conformance/dsp-011-bridge-bundle-render.test.ts tests/client/pi-bridge-core.test.ts tests/client/bridge-core-sanitization.test.ts tests/conformance/brp-001-extracted-bridge-core.test.ts`
Expected: PASS. BRP-001-F checks the package's module graph; the patch adds no import.

- [ ] **Step 7: Typecheck the integrations**

Run: `pnpm typecheck`
Expected: PASS (the Pi, omp, OpenCode and Claude channel adapters compile against the patched package).

- [ ] **Step 8: Commit**

```bash
git add src/mcp/dispatch-bundle-message.ts src/mcp/artifact-mcp-server.ts patches/@plannotator__agent-bridge@0.1.1.patch pnpm-lock.yaml \
  project/spec/agent-dispatch-spec.md tests/conformance/dsn-011-bundle-location.test.ts
git commit -m "Render a comment's designed-page location in agent bundles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0176RtcKJPmhiiSHHmBTiJSZ"
```

---

### Task 9: Browser proof with a fixture adapter

**Files:**
- Create: `tests/browser/scenario-fixture.ts`
- Create: `tests/browser/dsn-008-scenario-restore.spec.ts`
- Create: `tests/browser/dsn-009-view-anchors.spec.ts`
- Create: `tests/conformance/dsn-009-anchor-preservation.test.ts`
- Modify: `tests/browser/critical-engines.spec.ts` (one test)

**Interfaces:**
- Consumes: everything above; `startBrowserFixture`, `stopBrowserFixture`, `localLogin` (`tests/browser/browser-fixture.ts`); `annotationFrame`, `previewFrame`, `openInspectorTab`, `reviewHref` (`tests/browser/review-helpers.ts`); `createThreadOverApi` (`tests/browser/comment-api.ts`); `createStagedUpload`, `uploadEveryStagedFile`, `commitStagedUpload`, `TestSiteFile` (`tests/support/publishing.ts`).
- Produces: `publishScenarioFixture(fixture): Promise<PublishResponse>`, a four-page artifact whose views document declares `fixture/honest` (`honest.html`, scenarios `1`, `5`, `6`), `fixture/silent`, `fixture/liar` and `fixture/no-adapter`.

- [ ] **Step 1: Write the fixture publication**

Create `tests/browser/scenario-fixture.ts`:

```ts
import type {BrowserFixture} from "./browser-fixture.js";
import {
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";

/**
 * A page adapter written to the pageVersion 1 contract. Behaviors: honest
 * (restores and confirms), silent (never answers a restore), liar (confirms a
 * different scenario), no-adapter (never says hello).
 */
const adapterScript = `
(function () {
  var labels = {"1": "Library", "5": "Validation", "6": "Logic"};
  var behavior = document.documentElement.getAttribute("data-fixture-behavior");
  var current = "1";
  var root = document.getElementById("root");
  function render() {
    root.setAttribute("data-review-scenario", current);
    if (current === "5") {
      root.innerHTML = '<section data-review-region="inspector.validation"><h2>Validation</h2>' +
        '<label data-review-region="inspector.validation.min-length">Minimum length <input value="3"></label></section>' +
        '<p data-review-region="duplicate.note">First note</p><p data-review-region="duplicate.note">Second note</p>';
    } else {
      root.innerHTML = '<section data-review-region="screen"><h2>' + labels[current] + '</h2>' +
        '<button id="go-logic" type="button">Open Logic</button></section>';
      document.getElementById("go-logic").onclick = function () { setScenario("6", null); };
    }
  }
  function state() {
    return {
      direction: getComputedStyle(document.documentElement).direction === "rtl" ? "rtl" : "ltr",
      locale: document.documentElement.lang || null,
      pageVersion: 1,
      props: {scenario: current},
      scenarioId: root.getAttribute("data-review-scenario"),
      theme: "light",
      viewport: {height: innerHeight, width: innerWidth}
    };
  }
  function post(message) { parent.postMessage(message, "*"); }
  function afterPaint(callback) { requestAnimationFrame(function () { requestAnimationFrame(callback); }); }
  function setScenario(id, requestId) {
    current = labels[id] ? id : current;
    render();
    afterPaint(function () {
      if (requestId === null) post({requestId: null, state: state(), type: "as-page-state"});
      else post({ok: true, requestId: requestId, state: state(), type: "as-page-restored"});
    });
  }
  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var m = event.data;
    if (!m || typeof m.type !== "string") return;
    if (m.type === "as-page-restore") {
      if (behavior === "silent") return;
      setScenario(behavior === "liar" ? "6" : String(m.props.scenario), m.requestId);
    } else if (m.type === "as-page-capture") {
      post({requestId: m.requestId, state: state(), type: "as-page-state"});
    } else if (m.type === "as-page-region-at") {
      var element = null;
      try { element = document.querySelector(m.selector); } catch (error) { element = null; }
      var region = element && element.closest("[data-review-region]");
      if (!region) { post({reason: "none", region: null, requestId: m.requestId, type: "as-page-region"}); return; }
      var id = region.getAttribute("data-review-region");
      var count = document.querySelectorAll('[data-review-region="' + id + '"]').length;
      post(count === 1
        ? {region: {label: (region.textContent || "").trim().slice(0, 256), regionId: id, tagName: region.tagName.toLowerCase()}, requestId: m.requestId, type: "as-page-region"}
        : {reason: "ambiguous", region: null, requestId: m.requestId, type: "as-page-region"});
    } else if (m.type === "as-page-region-find") {
      post({requestId: m.requestId, type: "as-page-regions", results: m.regionIds.map(function (regionId) {
        var found = document.querySelectorAll('[data-review-region="' + regionId + '"]');
        return {count: found.length, regionId: regionId, tagName: found.length === 1 ? found[0].tagName.toLowerCase() : null};
      })});
    }
  });
  render();
  if (behavior !== "no-adapter") post({capabilities: ["capture", "regions", "restore"], pageVersion: 1, type: "as-page-hello"});
})();
`;

const encoder = new TextEncoder();

function page(path: string, behavior: string): TestSiteFile {
  return {
    bytes: encoder.encode(`<!doctype html><html lang="en" data-fixture-behavior="${behavior}"><head><meta charset="utf-8"><title>${behavior}</title></head><body><main id="root"></main><script>${adapterScript}</script></body></html>`),
    mediaType: "text/html; charset=utf-8",
    path,
  };
}

function view(viewId: string, path: string) {
  return {
    defaultScenarioId: "1",
    label: `Fixture ${viewId}`,
    parameters: [],
    path,
    scenarios: [
      {label: "Library", props: {scenario: "1"}, scenarioId: "1"},
      {label: "Inspector · Validation", props: {scenario: "5"}, scenarioId: "5"},
      {label: "Logic", props: {scenario: "6"}, scenarioId: "6"},
    ],
    sourceRef: {line: 7, path: `fixture/${path}`},
    viewId,
  };
}

export async function publishScenarioFixture(fixture: BrowserFixture, key: string): Promise<PublishResponse> {
  const files: TestSiteFile[] = [
    page("honest.html", "honest"),
    page("silent.html", "silent"),
    page("liar.html", "liar"),
    page("no-adapter.html", "no-adapter"),
    {
      bytes: encoder.encode(JSON.stringify({
        format: "artifact-server.views",
        version: 1,
        views: [
          view("fixture/honest", "honest.html"),
          view("fixture/silent", "silent.html"),
          view("fixture/liar", "liar.html"),
          view("fixture/no-adapter", "no-adapter.html"),
        ],
      })),
      mediaType: "application/json",
      path: "artifactserver.views.json",
    },
  ];
  const upload = await createStagedUpload(fixture.server, fixture.installation, "honest.html", files);
  await uploadEveryStagedFile(fixture.installation, upload.body, files);
  return (await commitStagedUpload(fixture.installation, upload.body, key, {
    accessSetting: "account_required",
    kind: "new_artifact",
    name: "Scenario fixture",
    tags: [],
  })).body;
}
```

- [ ] **Step 2: Write the scenario restore spec**

Create `tests/browser/dsn-008-scenario-restore.spec.ts`:

```ts
import {expect, test} from "@playwright/test";

import {localLogin, startBrowserFixture, stopBrowserFixture, type BrowserFixture} from "./browser-fixture.js";
import {annotationFrame, previewFrame, reviewHref} from "./review-helpers.js";
import {publishScenarioFixture} from "./scenario-fixture.js";

let fixture: BrowserFixture;

test.beforeEach(async ({browser}) => {
  fixture = await startBrowserFixture(browser);
  await localLogin(fixture);
});

test.afterEach(async () => {
  await stopBrowserFixture(fixture);
});

function scenarioUrl(published: Awaited<ReturnType<typeof publishScenarioFixture>>, path: string, scenario?: string): string {
  const href = reviewHref(fixture.server.baseUrl, {artifactId: published.artifact.id, path, versionId: published.version.id});
  return scenario === undefined ? href : `${href}&scenario=${scenario}`;
}

test("DSN-008-B: the picker and a scenario link open a designed scenario that the page confirms", async () => {
  const published = await publishScenarioFixture(fixture, "dsn-008-b");
  const {page} = fixture;
  await page.goto(scenarioUrl(published, "honest.html"));
  const picker = page.getByRole("combobox", {name: "Designed scenario"});
  await expect(picker).toHaveValue("1");
  await expect(previewFrame(page).getByRole("heading", {name: "Library"})).toBeVisible();

  await picker.selectOption("5");
  await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible();
  await expect(page).toHaveURL(/[?&]scenario=5(?:&|$)/u);

  await page.goto(scenarioUrl(published, "honest.html", "5"));
  await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible();
  await expect(picker).toHaveValue("5");

  // A scenario changed from inside the page moves the picker with it.
  await page.goto(scenarioUrl(published, "honest.html", "1"));
  await previewFrame(page).getByRole("button", {name: "Open Logic"}).click();
  await expect(previewFrame(page).getByRole("heading", {name: "Logic"})).toBeVisible();
  await expect(picker).toHaveValue("6");
  await expect(annotationFrame(page).locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
});

test("DSN-008-F: a page without an adapter, a silent page and a lying page never change silently", async () => {
  const published = await publishScenarioFixture(fixture, "dsn-008-f");
  const {page} = fixture;

  await page.goto(scenarioUrl(published, "no-adapter.html", "5"));
  await expect(page.getByRole("status").filter({hasText: "Couldn't open scenario 5 (no-adapter)"})).toBeVisible({timeout: 10_000});
  await expect(previewFrame(page).getByRole("heading", {name: "Library"})).toBeVisible();

  await page.goto(scenarioUrl(published, "silent.html", "5"));
  await expect(page.getByRole("status").filter({hasText: "Couldn't open scenario 5 (timeout)"})).toBeVisible({timeout: 15_000});
  await expect(previewFrame(page).getByRole("heading", {name: "Library"})).toBeVisible();

  await page.goto(scenarioUrl(published, "liar.html", "5"));
  await expect(page.getByRole("status").filter({hasText: "Couldn't open scenario 5 (scenario-mismatch)"})).toBeVisible({timeout: 10_000});
});
```

- [ ] **Step 3: Write the view anchor spec**

Create `tests/browser/dsn-009-view-anchors.spec.ts`:

```ts
import {expect, test} from "@playwright/test";
import {z} from "zod";

import {createThreadOverApi} from "./comment-api.js";
import {localLogin, startBrowserFixture, stopBrowserFixture, type BrowserFixture} from "./browser-fixture.js";
import {annotationFrame, openInspectorTab, previewFrame, reviewHref} from "./review-helpers.js";
import {publishScenarioFixture} from "./scenario-fixture.js";

let fixture: BrowserFixture;

test.beforeEach(async ({browser}) => {
  fixture = await startBrowserFixture(browser);
  await localLogin(fixture);
});

test.afterEach(async () => {
  await stopBrowserFixture(fixture);
});

const storedAnchorSchema = z.object({
  threads: z.array(z.object({anchor: z.unknown(), body: z.string(), id: z.string()}).loose()),
}).loose();

function viewAnchor(scenarioId: string, scenarioLabel: string, regionId?: string) {
  return {
    htmlAnchor: null,
    originalText: "",
    view: {
      ...(regionId === undefined ? {} : {regionId}),
      scenarioId,
      scenarioLabel,
      sourceRef: {line: 7, path: "fixture/honest.html"},
      state: {direction: "ltr", locale: "en", parameters: {}, theme: "light", viewport: {height: 900, width: 1440}},
      viewFormat: 1,
      viewId: "fixture/honest",
    },
  };
}

test("DSN-009-B: a region comment in a designed scenario reopens there, and other scenarios are listed", async () => {
  const published = await publishScenarioFixture(fixture, "dsn-009-b");
  const {page} = fixture;
  const ids = {artifactId: published.artifact.id, versionId: published.version.id};
  await createThreadOverApi(fixture, {...ids, anchor: viewAnchor("6", "Logic"), body: "Logic needs a second rule.", idempotencyKey: "dsn-009-b-logic", path: "honest.html"});

  await page.goto(`${reviewHref(fixture.server.baseUrl, {...ids, path: "honest.html"})}&scenario=5`);
  await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible();
  await page.getByRole("button", {name: /^Interact mode:/u}).click();
  await previewFrame(page).getByText("Minimum length").click();
  const composer = annotationFrame(page).getByPlaceholder("Add a comment...");
  await composer.fill("Raise the minimum length to 4.");
  await annotationFrame(page).getByRole("button", {name: "Save"}).click();

  const listing = await fetch(
    `${fixture.server.baseUrl}/api/v1/artifacts/${ids.artifactId}/comments?projectId=${published.artifact.projectId}&versionId=${ids.versionId}&limit=100`,
    {headers: {Authorization: `Bearer ${fixture.installation.apiToken}`}},
  );
  const threads = storedAnchorSchema.parse(await listing.json()).threads;
  const created = threads.find((thread) => thread.body === "Raise the minimum length to 4.");
  expect(created?.anchor).toMatchObject({
    view: {
      regionId: "inspector.validation.min-length",
      regionLabel: "Minimum length",
      scenarioId: "5",
      scenarioLabel: "Inspector · Validation",
      sourceRef: {line: 7, path: "fixture/honest.html"},
      state: {direction: "ltr", locale: "en", theme: "light"},
      viewId: "fixture/honest",
    },
  });

  // Reopen from the default scenario: the comment is listed in scenario 5 and opens there.
  await page.goto(reviewHref(fixture.server.baseUrl, {...ids, path: "honest.html"}));
  await openInspectorTab(page, "Comments");
  const thread = page.getByRole("article").filter({hasText: "Raise the minimum length to 4."});
  await expect(thread.getByText("In scenario 5 · Inspector · Validation")).toBeVisible();
  await thread.getByRole("button", {name: "Open"}).click();
  await expect(previewFrame(page).getByRole("heading", {name: "Validation"})).toBeVisible();
  await expect(thread.getByText(/^In scenario 5/u)).toHaveCount(0);
  await expect(thread.getByText(/^Location unavailable/u)).toHaveCount(0);

  // The scenario 6 comment follows the page when it moves to Logic from inside.
  const logic = page.getByRole("article").filter({hasText: "Logic needs a second rule."});
  await expect(logic.getByText("In scenario 6 · Logic")).toBeVisible();
  await page.goto(`${reviewHref(fixture.server.baseUrl, {...ids, path: "honest.html"})}&scenario=1`);
  await openInspectorTab(page, "Comments");
  await previewFrame(page).getByRole("button", {name: "Open Logic"}).click();
  await expect(page.getByRole("article").filter({hasText: "Logic needs a second rule."}).getByText(/^In scenario 6/u)).toHaveCount(0);
});

test("DSN-009-F: a failed restore and a missing or duplicated region say the location is unavailable", async () => {
  const published = await publishScenarioFixture(fixture, "dsn-009-f");
  const {page} = fixture;
  const ids = {artifactId: published.artifact.id, versionId: published.version.id};
  await createThreadOverApi(fixture, {...ids, anchor: viewAnchor("5", "Inspector · Validation", "gone.region"), body: "Missing region.", idempotencyKey: "dsn-009-f-missing", path: "honest.html"});
  await createThreadOverApi(fixture, {...ids, anchor: viewAnchor("5", "Inspector · Validation", "duplicate.note"), body: "Duplicated region.", idempotencyKey: "dsn-009-f-duplicate", path: "honest.html"});
  await createThreadOverApi(fixture, {...ids, anchor: {...viewAnchor("5", "Inspector · Validation"), view: {viewFormat: 1, viewId: 42}}, body: "Broken view block.", idempotencyKey: "dsn-009-f-broken", path: "honest.html"});

  await page.goto(`${reviewHref(fixture.server.baseUrl, {...ids, path: "honest.html"})}&scenario=5`);
  await openInspectorTab(page, "Comments");
  for (const body of ["Missing region.", "Duplicated region."]) {
    await expect(page.getByRole("article").filter({hasText: body}).getByText("Location unavailable: the region isn't on the page")).toBeVisible();
  }
  // An invalid view block reads as absent: the comment is placed like any legacy anchor.
  await expect(page.getByRole("article").filter({hasText: "Broken view block."}).getByText(/^In scenario/u)).toHaveCount(0);

  const liar = {artifactId: ids.artifactId, versionId: ids.versionId};
  await createThreadOverApi(fixture, {...liar, anchor: {...viewAnchor("5", "Inspector · Validation"), view: {...viewAnchor("5", "Inspector · Validation").view, viewId: "fixture/liar"}}, body: "Liar comment.", idempotencyKey: "dsn-009-f-liar", path: "liar.html"});
  await page.goto(`${reviewHref(fixture.server.baseUrl, {...liar, path: "liar.html"})}&scenario=5`);
  await openInspectorTab(page, "Comments");
  await expect(page.getByRole("article").filter({hasText: "Liar comment."}).getByText("Location unavailable: scenario 5 couldn't be opened")).toBeVisible({timeout: 10_000});
});
```

If `createThreadOverApi`'s options name differs (for example `anchor` must be JSON), adjust to its signature in `tests/browser/comment-api.ts:79`. If the comments listing route needs other query parameters, copy them from `loadAllThreads` in `apps/web/src/review/review-comments.tsx`.

- [ ] **Step 4: Prove anchor fields survive replacement**

Create `tests/conformance/dsn-009-anchor-preservation.test.ts`. It creates one thread with an anchor carrying a `view` block and an unknown `future` field, replaces the anchor through `PATCH /api/v1/artifacts/:artifactId/comments/:threadId` and through the MCP `comment_update` tool, and reads both back unchanged. Use the `publishNew`, `apiHeaders` and MCP-call patterns from `tests/conformance/cmt-003-anchor-opacity.test.ts` and `tests/conformance/dsn-011-version-context.test.ts`:

```ts
test("DSN-009-F: anchor replacement over HTTP and MCP keeps view blocks and unknown fields", async () => {
  expect.hasAssertions();
  const anchor = {
    future: {kept: true},
    htmlAnchor: null,
    originalText: "Minimum length",
    view: {scenarioId: "5", scenarioLabel: "Inspector · Validation", sourceRef: {path: "a.html"}, state: {direction: "ltr", locale: null, parameters: {}, theme: "light", viewport: {height: 1, width: 1}}, viewFormat: 1, viewId: "a/b"},
  };
  const threadId = await createThread({anchor, body: "x", path: "index.html"});
  const replaced = {...anchor, future: {kept: "again"}};
  expect((await patchThread(threadId, {anchor: replaced})).status).toBe(200);
  expect((await readThread(threadId)).anchor).toEqual(replaced);
  await callTool("comment_update", {anchor, artifactId, projectId, threadId});
  expect((await readThread(threadId)).anchor).toEqual(anchor);
});
```

Write `createThread`, `patchThread`, `readThread` and `callTool` as small functions in the file, copying the request shapes from `cmt-003-anchor-opacity.test.ts` (`createThread`, `patchThread`) and the MCP call from `dsn-011-version-context.test.ts`. The DSN-009-F browser test above and this vitest share the id; `scripts/check-conformance-test-ids.rb` scans only `*.test.ts`, so this is the single scanned claim.

Run: `pnpm exec vitest run tests/conformance/dsn-009-anchor-preservation.test.ts`
Expected: PASS. The server already treats anchors as opaque, so this test pins existing behavior that the spec now depends on.

Then state the client rule next to the anchor rule in `project/spec/artifact-comments-spec.md` (the paragraph beginning "Anchor rule, copied from Workspaces", near line 90), by appending:

```markdown
A client that replaces a thread's anchor must send back every field it read, including fields it does not recognize. The design review `view` block (DSN-009) is one such field: dropping it silently detaches a comment from its designed scenario and region.
```

- [ ] **Step 5: Add the cross-engine critical check**

In `tests/browser/critical-engines.spec.ts`, inside `test.describe("critical engine review paths @critical", …)`, add (importing `publishScenarioFixture` and `previewFrame`):

```ts
  test("DSN-008-B DSN-009-B: a designed scenario restores inside the opaque-origin sandbox @critical", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await localLogin(fixture);
      const published = await publishScenarioFixture(fixture, "critical-dsn-008");
      await fixture.page.goto(`${reviewHref(fixture.server.baseUrl, {artifactId: published.artifact.id, path: "honest.html", versionId: published.version.id})}&scenario=5`);
      await expect(previewFrame(fixture.page).getByRole("heading", {name: "Validation"})).toBeVisible();
      await expect(fixture.page.getByRole("combobox", {name: "Designed scenario"})).toHaveValue("5");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
```

- [ ] **Step 6: Run the browser specs in Chromium, then all engines**

Run: `pnpm test:web -- tests/browser/dsn-008-scenario-restore.spec.ts tests/browser/dsn-009-view-anchors.spec.ts`
Expected: PASS.

Run: `pnpm exec playwright install firefox webkit && BROWSER_CRITICAL_ENGINES=all pnpm test:web`
Expected: PASS in Chromium, Firefox and WebKit.

- [ ] **Step 7: Commit**

```bash
git add tests/browser/scenario-fixture.ts tests/browser/dsn-008-scenario-restore.spec.ts tests/browser/dsn-009-view-anchors.spec.ts \
  tests/browser/critical-engines.spec.ts tests/conformance/dsn-009-anchor-preservation.test.ts project/spec/artifact-comments-spec.md
git commit -m "Prove scenario restore and region anchors in the browser

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0176RtcKJPmhiiSHHmBTiJSZ"
```

---

### Task 10: Evidence, ledger and gates

**Files:**
- Create (generated): `project/evidence/design-review-experience-<date>.json`
- Modify: `project/spec/conformance.yml` (DSN-007 … DSN-011)

**Interfaces:**
- Produces: DSN-008, DSN-009 and DSN-011 at `implementing` with local evidence; DSN-007 and DSN-010 gain their review-UI proof. None reaches `behavior_verified` until Design publishes the Forms version and the acceptance journey passes on artifacts.backend.app.

- [ ] **Step 1: Record the vitest evidence**

Run:

```bash
pnpm exec vitest run tests/conformance/dsn-009-anchor-preservation.test.ts tests/conformance/dsn-011-bundle-location.test.ts \
  --reporter=default --reporter=json --outputFile.json=project/evidence/design-review-experience-$(date -u +%F).json
```

Expected: PASS and the report is written.

- [ ] **Step 2: Attach evidence and proof gaps**

For DSN-008, DSN-009 and DSN-011 set `status: implementing`, add `proof_gap: Local Chromium, Firefox and WebKit journeys pass against a fixture adapter. The Forms publication from Design and the hosted acceptance journey remain unrecorded.`, and add evidence records:

- DSN-008: `tests: [DSN-008-B, DSN-008-F]`, `run: project/evidence/browser.json`
- DSN-009: `tests: [DSN-009-B, DSN-009-F]`, two records: `run: project/evidence/browser.json` and `run: project/evidence/design-review-experience-<date>.json`
- DSN-011: `tests: [DSN-011-B, DSN-011-F]`, `run: project/evidence/design-review-experience-<date>.json`

Each record uses `deployment: local`, `result: pass`, and `recorded_at` from that report's start time.

Run: `pnpm conformance:validate && pnpm conformance:tests`
Expected: PASS. If the validator cannot find the browser ids in `browser.json`, run `pnpm test:web` once more to refresh it and check that the spec titles start with the ids.

- [ ] **Step 3: Run the iteration gate**

Run: `pnpm verify:iteration`
Expected: exit 0. Commit only the files this plan created or changed; leave unrelated refreshed evidence unstaged.

- [ ] **Step 4: Commit**

```bash
git add project/evidence/design-review-experience-*.json project/evidence/browser.json project/spec/conformance.yml
git commit -m "Attach design review experience evidence (DSN-008, DSN-009, DSN-011)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0176RtcKJPmhiiSHHmBTiJSZ"
```

## After both plans: the pilot acceptance (needs Design)

Not part of this plan's tasks; record it as the next handoff:

1. Design implements its five items (listed at the end of Plan A), publishes Forms, and the review opens scenario 5 in Annotate.
2. Run the four NEXT.md acceptance checks on artifacts.backend.app against that version, after deploying an image with both plans: scenario 5 opens the Validation inspector from the picker and a link; an annotation on the minimum-length field reopens there; a forced failure says "Location unavailable"; `artifact_version_context` returns `verified` provenance naming Design's commit.
3. Record hosted evidence, then move DSN-007 … DSN-011 to `behavior_verified`.
