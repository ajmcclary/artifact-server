# Delivery Baseline and Streaming Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure how the Library and a large prototype reach the browser, locally and on `artifacts.backend.app`, then serve eligible version content br/gzip-compressed through a streaming path, and prove the change with before/after evidence.

**Architecture:** A Playwright runner (`pnpm perf:delivery`) captures browser exchanges and turns them into a report built only from allowlisted fields. Raw HAR files stay in a `0700` directory outside the repository. On the server, `serveStoredVersionContent` pipes the blob stream through a `ContentEncoder` port when the request is an eligible full GET or HEAD. The Node runtimes inject a `node:zlib` implementation; Workers injects nothing. Ranges stay on the identity representation.

**Tech Stack:** TypeScript on Node 24.15, Hono with `@hono/node-server`, `node:zlib` and web streams, `@playwright/test` 1.62 (library mode, Chromium), Vitest, Zod, Commander, Effect (only for the existing publish client).

**Spec:** `docs/superpowers/specs/2026-10-05-delivery-baseline-and-streaming-compression-design.md`

## Global Constraints

- Branch: `delivery-compression`. Never push, merge, run `image.yml`, or touch `~/Workspace` without the user's explicit approval in Task 10.
- No changes in `~/Dev/Design`. No changes under `deploy/cloudflare/`. No live Cloudflare runs.
- No module mocks (`anti-slop/no-module-mocking`). Tests use a real HTTP server (`startTestServer`), temporary disk storage, and a temporary SQLite database.
- Each conformance test ID (`CNT-010-B`, `CNT-010-F`) appears in exactly one test title (`scripts/check-conformance-test-ids.rb`). Other new tests start with `foundation:`.
- Lint is strict (`oxlint --type-aware --type-check --deny-warnings`). Do not use inline object types for parameters (`anti-slop/no-object-parameters`; declare a named interface). No runtime `typeof`, no `Record<string, unknown>`, no `shape` in symbol names, a safety comment on every type assertion, no non-null assertions, no floating promises. An intentional sequential `await` in a loop needs `// eslint-disable-next-line no-await-in-loop -- <reason>`, as `apps/web/src/review/library/use-design-library.ts` does.
- Before writing any Effect code (only Task 3's publish call), read `node_modules/effect/AGENTS.md` completely.
- Compression values: Brotli quality 4, gzip level 6, minimum entry size 1024 bytes (inclusive), compressible media types `application/javascript`, `application/json`, `image/svg+xml`, `text/css`, `text/html`, `text/javascript`.
- Encoded responses: `Content-Encoding` set; `Content-Length` and `Accept-Ranges` removed; `ETag: W/"<sha256>"`; `Vary: Accept-Encoding`; `Cache-Control` unchanged. A 304 never carries `Content-Encoding`.
- Test bounds: a disconnect after the first chunk of a 64 MiB entry reads fewer than 8 MiB from storage. Twenty concurrent full reads of a 64 MiB entry grow `heapUsed + external + arrayBuffers` by less than 256 MiB.
- Harness: prototype-ready means the interactive iframe's `load` event plus 500 ms with no content requests in flight. The ready deadline is 120 seconds. The default is 5 samples. Raw output goes under `~/.local/state/artifact-server/delivery/`, with directories `0700` and files `0600`, and never resolves inside the repository.
- Commit messages end with a blank line and then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

These are the inputs most likely to break behavior that a person relies on, where the spec doesn't spell out the case. Each has a test in the task named.

1. **A client revalidates an identity copy it cached earlier, but now sends `Accept-Encoding: gzip`.** The 304 must not carry `Content-Encoding`, or the cache relabels identity bytes as gzip and the page breaks. The test is in Task 8.
2. **Unusual `Accept-Encoding` spellings** (` GZIP `, `br;q=0.0`, `*`). Codings are matched case-insensitively, `q=0.0` refuses a coding, and a bare `*` stays identity. The test is in Task 8.
3. **An entry exactly at the 1024-byte threshold, and one byte below it.** 1024 bytes is compressed; 1023 bytes is served identity. The test is in Task 8.
4. **Every sample in a journey times out** (for example, the hosted session expires mid-run). The report is still built, with null statistics and the timeout count, and doesn't throw. The test is in Task 1.
5. **A captured exchange whose URL is malformed or not HTTP** (`data:`, `blob:`). It is classified `other` with template `/:unparseable` or `/:path`, without throwing and without leaking the raw URL. The test is in Task 1.

---

## File map

| File | Responsibility |
|---|---|
| `project/performance/delivery/delivery-report.ts` (new) | Route classification, path templates, header allowlist, per-sample and per-journey summaries, statistics, report assembly, leak detection, Markdown table |
| `project/performance/delivery/private-output.ts` (new) | Resolving and creating private raw-output directories outside the repo, `0600` file writes |
| `project/performance/delivery/synthetic-prototype.ts` (new) | Deterministic ExtractionKit-shaped fixture writer |
| `project/performance/delivery/browser-capture.ts` (new) | Playwright exchange recorder, content-network quiet monitor, one-sample measurement |
| `project/performance/run-delivery-baseline.ts` (new) | CLI: targets, sign-in, journeys, report writing |
| `tests/tooling/delivery-report.test.ts` (new) | Report builder tests |
| `tests/tooling/delivery-private-output.test.ts` (new) | Private output tests |
| `src/http/content-encoding.ts` (new) | Shared negotiation, compressible types, `Vary` helper, `ContentEncoder` port |
| `src/http/node-content-encoder.ts` (new) | `node:zlib` `ContentEncoder` |
| `src/http/node-response-compression.ts` (modify) | Use shared negotiation; update the invariant comment |
| `src/storage/observed-blob-store.ts` (new) | Observation decorator for blob reads, a test seam |
| `src/local/create-local-runtime.ts` (modify) | `blobReadObserver` seam and `contentEncoder` composition |
| `src/external-storage/create-external-storage-runtime.ts` (modify) | `contentEncoder` composition |
| `src/http/create-http-app.ts` (modify) | `HttpAppDependencies.contentEncoder`; coding selection in `serveStoredVersionContent` |
| `tests/support/runtime-harness.ts` (modify) | Pass `blobReadObserver` through `startTestServer` |
| `tests/http/content-delivery-compression.test.ts` (new) | CNT-010 and foundation tests |
| `tests/http/node-response-compression.test.ts` (modify) | Remove the superseded "never compressed" test |
| `project/spec/conformance.yml`, `project/spec/artifact-server-product-spec.html` (modify) | CNT-010 and its product sentence |
| `project/performance/FINDINGS.md` (modify) | "Browser delivery" section |
| `package.json` (modify) | `perf:delivery` script |

---

### Task 1: Delivery report builder

**Files:**
- Create: `project/performance/delivery/delivery-report.ts`
- Test: `tests/tooling/delivery-report.test.ts`

**Interfaces:**
- Consumes: `MeasurementContext` from `project/performance/measurement-context.ts`.
- Produces (used by Tasks 3, 4, and 10):
  - `type RouteClass = "app-shell" | "api" | "bootstrap" | "preview-lease" | "version-content" | "external-cdn" | "other"`
  - `interface DeliveryOrigins { applicationOrigin: string; contentDomain: string }`
  - `interface CapturedExchange { decodedBytes: number | null; requestHeaders: Readonly<Record<string, string>>; responseHeaders: Readonly<Record<string, string>>; status: number; transferBytes: number; url: string }`
  - `interface SampleObservation { exchanges; firstContentfulPaintMilliseconds: number | null; index: number; localProcessCpuMilliseconds: number | null; readyMilliseconds: number | null }`
  - `classifyRoute(url: URL, origins: DeliveryOrigins): RouteClass`
  - `isContentRoute(routeClass: RouteClass): boolean`
  - `pathTemplate(url: URL, routeClass: RouteClass): string`
  - `summarizeSample(observation: SampleObservation, origins: DeliveryOrigins): SampleSummary`
  - `summarizeJourney(journey: JourneyName, cache: CacheState, samples: readonly SampleSummary[]): JourneySummary`
  - `statistics(values: readonly number[]): Statistics | null`
  - `detectWebBuild(exchanges: readonly CapturedExchange[], origins: DeliveryOrigins): string | null`
  - `sensitiveValues(exchanges: readonly CapturedExchange[], origins: DeliveryOrigins): ReadonlySet<string>`
  - `leakedValues(serialized: string, values: ReadonlySet<string>): readonly string[]`
  - `buildDeliveryReport(input: DeliveryReportInput): DeliveryReport`
  - `formatJourneyTable(report: DeliveryReport): string`

- [ ] **Step 1: Write the failing tests**

Create `tests/tooling/delivery-report.test.ts`:

```ts
import {describe, expect, test} from "vitest";

import {
  buildDeliveryReport,
  classifyRoute,
  detectWebBuild,
  formatJourneyTable,
  leakedValues,
  pathTemplate,
  sensitiveValues,
  statistics,
  summarizeJourney,
  summarizeSample,
  type CapturedExchange,
  type DeliveryOrigins,
  type SampleObservation,
} from "../../project/performance/delivery/delivery-report.js";
import type {MeasurementContext} from "../../project/performance/measurement-context.js";

const origins: DeliveryOrigins = {
  applicationOrigin: "https://artifacts.example.test",
  contentDomain: "frontend.example.test",
};
const leaseHost = `review-${"a1".repeat(28)}.frontend.example.test`;
const context: MeasurementContext = {
  arch: "arm64",
  availableParallelism: 8,
  capturedAt: "2026-10-05T00:00:00.000Z",
  commit: "0".repeat(40),
  cpu: "test cpu",
  details: null,
  lockfileDigest: "test-lockfile",
  node: "v24.15.0",
  operatingSystem: "test os",
  platform: "darwin",
  temporaryFilesystem: "apfs",
  workingTreeDirty: false,
};

function exchange(url: string, responseHeaders: Readonly<Record<string, string>>): CapturedExchange {
  return {
    decodedBytes: 4096,
    requestHeaders: {
      authorization: "Bearer tok-secret-authorization",
      cookie: "artifact_session=sess-secret-cookie-value",
    },
    responseHeaders,
    status: 200,
    transferBytes: 1024,
    url,
  };
}

const hostileExchanges: readonly CapturedExchange[] = [
  exchange(`https://${leaseHost}/merger-plans/board-deck.html`, {
    "cache-control": "private, no-store",
    "content-encoding": "br",
    "server-timing": 'db;desc="desc-secret-timing";dur=12.5',
    "set-cookie": "__Host-artifact_content=lease-secret-session; Path=/; HttpOnly",
    vary: "Accept-Encoding",
  }),
  exchange(
    "https://ver-1.frontend.example.test/merger-plans/board-deck.html?__artifact_bootstrap=boot-secret-bootstrap-token",
    {"cache-control": "private, no-store"},
  ),
  exchange(
    "https://artifacts.example.test/api/v1/artifacts/art_secret1/versions/ver_secret2/files/merger-plans/board-deck.html",
    {"cache-control": "private, no-store", "content-type": "text/html"},
  ),
  exchange("https://artifacts.example.test/assets/review-AbC123xy.js", {"content-encoding": "br"}),
];

function observation(index: number, readyMilliseconds: number | null): SampleObservation {
  return {
    exchanges: hostileExchanges,
    firstContentfulPaintMilliseconds: readyMilliseconds === null ? null : 100,
    index,
    localProcessCpuMilliseconds: null,
    readyMilliseconds,
  };
}

describe("delivery report", () => {
  test("foundation: a hostile capture yields a report with no credentials, capability hosts, or private paths", () => {
    const samples = [summarizeSample(observation(0, 900), origins)];
    const report = buildDeliveryReport({
      browserVersion: "130.0.0.0",
      context,
      deploymentRevision: null,
      journeys: [summarizeJourney("prototype", "cold", samples)],
      label: "before",
      samplesPerJourney: 1,
      target: "hosted",
      webBuild: detectWebBuild(hostileExchanges, origins),
    });
    const serialized = JSON.stringify(report);
    for (const secret of [
      "sess-secret-cookie-value",
      "tok-secret-authorization",
      "boot-secret-bootstrap-token",
      "lease-secret-session",
      "desc-secret-timing",
      "merger-plans",
      "board-deck",
      "art_secret1",
      "ver_secret2",
      leaseHost,
      "frontend.example.test",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    const values = sensitiveValues(hostileExchanges, origins);
    expect(values).toContain(leaseHost);
    expect(values).toContain("boot-secret-bootstrap-token");
    expect(values).toContain("sess-secret-cookie-value");
    expect(values).toContain("lease-secret-session");
    expect(leakedValues(serialized, values)).toEqual([]);
    expect(leakedValues(`{"host":"${leaseHost}"}`, values)).toEqual([leaseHost]);

    const lease = report.journeys[0]?.samples[0]?.routes.find((route) => route.routeClass === "preview-lease");
    expect(lease?.contentEncoding).toEqual(["br"]);
    expect(lease?.cacheControl).toEqual(["no-store", "private"]);
    expect(lease?.serverTiming).toEqual(["db;dur=12.5"]);
    expect(lease?.pathTemplates).toEqual(["/:path.html"]);
    expect(report.webBuild).toBe("review-AbC123xy.js");
    expect(report.representativeCompression).toBe(true);
  });

  test("foundation: routes are classified by origin, content domain, lease label, and bootstrap parameter", () => {
    const classify = (url: string) => classifyRoute(new URL(url), origins);
    expect(classify("https://artifacts.example.test/review/library")).toBe("app-shell");
    expect(classify("https://artifacts.example.test/api/v1/projects")).toBe("api");
    expect(classify(`https://${leaseHost}/index.html`)).toBe("preview-lease");
    expect(classify("https://ver-1.frontend.example.test/index.html")).toBe("version-content");
    expect(classify("https://ver-1.frontend.example.test/?__artifact_bootstrap=x")).toBe("bootstrap");
    expect(classify("https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js")).toBe("external-cdn");
    expect(classify("data:text/plain,hello")).toBe("other");
  });

  test("foundation: path templates keep only route vocabulary and file extensions", () => {
    const template = (url: string) => {
      const parsed = new URL(url);
      return pathTemplate(parsed, classifyRoute(parsed, origins));
    };
    expect(template("https://artifacts.example.test/api/v1/artifacts/art_1/versions/ver_2/files/secret/plan.html"))
      .toBe("/api/v1/artifacts/:segment/versions/:segment/files/:segment/:segment");
    expect(template("https://artifacts.example.test/review/library")).toBe("/review/library");
    expect(template("https://artifacts.example.test/assets/review-AbC123xy.js")).toBe("/assets/:file.js");
    expect(template(`https://${leaseHost}/data/ek-data-viewer.js`)).toBe("/:path.js");
    expect(template(`https://${leaseHost}/`)).toBe("/:path");
  });

  test("foundation: statistics report median, minimum, and maximum", () => {
    expect(statistics([3, 1, 2])).toEqual({maximum: 3, median: 2, minimum: 1});
    expect(statistics([4, 1, 3, 2])).toEqual({maximum: 4, median: 2.5, minimum: 1});
    expect(statistics([])).toBeNull();
  });

  test("foundation: journeys aggregate ready times over ready samples and bytes over every sample", () => {
    const ready = summarizeSample(observation(0, 900), origins);
    const timedOut = summarizeSample(observation(1, null), origins);
    const journey = summarizeJourney("prototype", "cold", [ready, timedOut]);
    expect(timedOut.outcome).toBe("timeout");
    expect(journey.timeouts).toBe(1);
    expect(journey.aggregate.readyMilliseconds).toEqual({maximum: 900, median: 900, minimum: 900});
    expect(journey.aggregate.transferBytes).toEqual({maximum: 4096, median: 4096, minimum: 4096});
    expect(journey.aggregate.requests?.median).toBe(4);
  });

  test("foundation: a journey whose samples all time out still produces a report", () => {
    const journey = summarizeJourney("library", "warm", [
      summarizeSample(observation(0, null), origins),
      summarizeSample(observation(1, null), origins),
    ]);
    expect(journey.timeouts).toBe(2);
    expect(journey.aggregate.readyMilliseconds).toBeNull();
    expect(journey.aggregate.firstContentfulPaintMilliseconds).toBeNull();
  });

  test("foundation: malformed and non-HTTP exchange URLs are classified without leaking them", () => {
    const summary = summarizeSample({
      exchanges: [
        exchange("not a url secret-malformed-value", {}),
        exchange("blob:https://artifacts.example.test/secret-blob-id", {}),
      ],
      firstContentfulPaintMilliseconds: null,
      index: 0,
      localProcessCpuMilliseconds: null,
      readyMilliseconds: 10,
    }, origins);
    expect(summary.routes.map((route) => route.routeClass)).toEqual(["other"]);
    expect(summary.routes[0]?.pathTemplates).toEqual(["/:path", "/:unparseable"]);
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  test("foundation: the journey table names each journey with medians and the lease encoding", () => {
    const report = buildDeliveryReport({
      browserVersion: "130.0.0.0",
      context,
      deploymentRevision: null,
      journeys: [summarizeJourney("prototype", "cold", [summarizeSample(observation(0, 900), origins)])],
      label: "after",
      samplesPerJourney: 1,
      target: "local",
      webBuild: null,
    });
    const table = formatJourneyTable(report).split("\n");
    expect(table[0]).toBe("| Journey | Cache | Ready | First paint | Requests | Transferred | Decoded | Lease encoding | Timeouts |");
    expect(table[2]).toBe("| prototype | cold | 900 ms (900 ms–900 ms) | 100 ms (100 ms–100 ms) | 4 (4–4) | 4.0 KiB (4.0 KiB–4.0 KiB) | 16.0 KiB (16.0 KiB–16.0 KiB) | br | 0 |");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/tooling/delivery-report.test.ts`
Expected: FAIL, because `project/performance/delivery/delivery-report.js` cannot be resolved.

- [ ] **Step 3: Implement the report builder**

Create `project/performance/delivery/delivery-report.ts`:

```ts
import path from "node:path";

import type {MeasurementContext} from "../measurement-context.js";

export const routeClasses = [
  "app-shell",
  "api",
  "bootstrap",
  "preview-lease",
  "version-content",
  "external-cdn",
  "other",
] as const;

export type RouteClass = (typeof routeClasses)[number];
export type JourneyName = "library" | "prototype";
export type CacheState = "cold" | "warm";

/** The application origin and content domain one run measures. */
export interface DeliveryOrigins {
  readonly applicationOrigin: string;
  readonly contentDomain: string;
}

/** One finished browser exchange exactly as captured; never written to the repository. */
export interface CapturedExchange {
  readonly decodedBytes: number | null;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly status: number;
  readonly transferBytes: number;
  readonly url: string;
}

/** What one sample observed before it is reduced to allowlisted fields. */
export interface SampleObservation {
  readonly exchanges: readonly CapturedExchange[];
  readonly firstContentfulPaintMilliseconds: number | null;
  readonly index: number;
  readonly localProcessCpuMilliseconds: number | null;
  /** Null when the journey's ready signal did not arrive before its deadline. */
  readonly readyMilliseconds: number | null;
}

export interface RouteSummary {
  readonly cacheControl: readonly string[];
  readonly contentEncoding: readonly string[];
  readonly decodedBytes: number;
  readonly decodedBytesUnavailable: number;
  readonly pathTemplates: readonly string[];
  readonly requests: number;
  readonly routeClass: RouteClass;
  readonly serverTiming: readonly string[];
  readonly statuses: readonly number[];
  readonly transferBytes: number;
  readonly vary: readonly string[];
}

export interface SampleSummary {
  readonly firstContentfulPaintMilliseconds: number | null;
  readonly index: number;
  readonly localProcessCpuMilliseconds: number | null;
  readonly outcome: "ready" | "timeout";
  readonly readyMilliseconds: number | null;
  readonly routes: readonly RouteSummary[];
}

export interface Statistics {
  readonly maximum: number;
  readonly median: number;
  readonly minimum: number;
}

export interface JourneyAggregate {
  readonly decodedBytes: Statistics | null;
  readonly firstContentfulPaintMilliseconds: Statistics | null;
  readonly localProcessCpuMilliseconds: Statistics | null;
  readonly readyMilliseconds: Statistics | null;
  readonly requests: Statistics | null;
  readonly transferBytes: Statistics | null;
}

export interface JourneySummary {
  readonly aggregate: JourneyAggregate;
  readonly cache: CacheState;
  readonly journey: JourneyName;
  readonly samples: readonly SampleSummary[];
  readonly timeouts: number;
}

export interface DeliveryReportInput {
  readonly browserVersion: string;
  readonly context: MeasurementContext;
  readonly deploymentRevision: string | null;
  readonly journeys: readonly JourneySummary[];
  readonly label: string;
  readonly samplesPerJourney: number;
  readonly target: "hosted" | "local";
  readonly webBuild: string | null;
}

export interface DeliveryReport {
  readonly browser: {readonly name: "chromium"; readonly version: string};
  readonly context: MeasurementContext;
  readonly deploymentRevision: string | null;
  readonly format: "artifact-server.delivery-baseline";
  readonly formatVersion: 1;
  readonly journeys: readonly JourneySummary[];
  readonly label: string;
  readonly network: "unthrottled";
  /** Only hosted runs measure real fixtures; the local fixture is synthetic. */
  readonly representativeCompression: boolean;
  readonly samplesPerJourney: number;
  readonly target: "hosted" | "local";
  readonly webBuild: string | null;
}

const bootstrapParameter = "__artifact_bootstrap";
const leaseLabel = /^review-[a-z0-9_-]{56}$/u;
const safeExtension = /^\.[a-z0-9]{1,8}$/u;
const cacheDirective = /^[a-z-]{1,40}(?:=\d{1,10})?$/u;
const codingToken = /^[a-z0-9-]{1,20}$/u;
const varyToken = /^(?:\*|[a-z0-9-]{1,40})$/u;
const timingName = /^[a-z0-9_-]{1,40}$/u;
const webBuildAsset = /^\/assets\/(review-[A-Za-z0-9_-]{4,40}\.js)$/u;
const minimumSensitiveLength = 8;

/** Route words that may appear in a committed API template; every other segment is replaced. */
const apiVocabulary: ReadonlySet<string> = new Set([
  "actions", "activity", "administration", "agent-dispatches", "agents", "api", "api-keys",
  "archive", "artifacts", "batch", "cancel", "capture", "claims", "comments", "comparisons",
  "content-sessions", "deactivate", "disconnect", "facets", "file", "files", "git-history",
  "link", "live-sessions", "logout", "manifest", "media", "members", "preview-leases",
  "projects", "public-links", "replies", "revoke", "rotate", "session", "source", "summary",
  "threads", "unarchive", "uploads", "v1", "versions",
]);

/** Application routes that may appear in a committed template. */
const appShellVocabulary: ReadonlySet<string> = new Set([
  "activity", "admin", "auth", "callback", "context", "health", "library", "local",
  "local-owner", "login", "projects", "ready", "review", "review-frame", "settings",
]);

export function classifyRoute(url: URL, origins: DeliveryOrigins): RouteClass {
  if (url.protocol !== "https:" && url.protocol !== "http:") return "other";
  if (url.searchParams.has(bootstrapParameter)) return "bootstrap";
  if (url.origin === origins.applicationOrigin) {
    return url.pathname === "/api" || url.pathname.startsWith("/api/") ? "api" : "app-shell";
  }
  const hostname = url.hostname.toLowerCase();
  const domain = origins.contentDomain.toLowerCase();
  if (hostname.endsWith(`.${domain}`)) {
    const label = hostname.slice(0, -(domain.length + 1)).split(".")[0] ?? "";
    return leaseLabel.test(label) ? "preview-lease" : "version-content";
  }
  return "external-cdn";
}

/** Content routes are the ones prototype readiness waits on. */
export function isContentRoute(routeClass: RouteClass): boolean {
  return routeClass === "preview-lease"
    || routeClass === "version-content"
    || routeClass === "bootstrap";
}

export function pathTemplate(url: URL, routeClass: RouteClass): string {
  if (routeClass === "api") return templateFromVocabulary(url.pathname, apiVocabulary);
  if (routeClass === "app-shell") {
    return url.pathname.startsWith("/assets/")
      ? `/assets/:file${extensionOf(url.pathname)}`
      : templateFromVocabulary(url.pathname, appShellVocabulary);
  }
  return `/:path${extensionOf(url.pathname)}`;
}

function templateFromVocabulary(pathname: string, vocabulary: ReadonlySet<string>): string {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  return `/${segments.map((segment) => vocabulary.has(segment) ? segment : ":segment").join("/")}`;
}

function extensionOf(pathname: string): string {
  const extension = path.posix.extname(pathname).toLowerCase();
  return safeExtension.test(extension) ? extension : "";
}

function headerTokens(value: string | undefined, pattern: RegExp): readonly string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => pattern.test(token));
}

function serverTimingTokens(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return value.split(",").flatMap((metric) => {
    const [rawName = "", ...parameters] = metric.split(";");
    const name = rawName.trim().toLowerCase();
    if (!timingName.test(name)) return [];
    const duration = parameters
      .map((parameter) => parameter.trim().toLowerCase())
      .find((parameter) => parameter.startsWith("dur="));
    const milliseconds = duration === undefined ? Number.NaN : Number(duration.slice(4));
    return [Number.isFinite(milliseconds) ? `${name};dur=${milliseconds}` : name];
  });
}

interface RouteAccumulator {
  readonly cacheControl: Set<string>;
  readonly contentEncoding: Set<string>;
  decodedBytes: number;
  decodedBytesUnavailable: number;
  readonly pathTemplates: Set<string>;
  requests: number;
  readonly serverTiming: Set<string>;
  readonly statuses: Set<number>;
  transferBytes: number;
  readonly vary: Set<string>;
}

function emptyAccumulator(): RouteAccumulator {
  return {
    cacheControl: new Set(),
    contentEncoding: new Set(),
    decodedBytes: 0,
    decodedBytesUnavailable: 0,
    pathTemplates: new Set(),
    requests: 0,
    serverTiming: new Set(),
    statuses: new Set(),
    transferBytes: 0,
    vary: new Set(),
  };
}

function sorted(values: Iterable<string>): readonly string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function roundMilliseconds(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

export function summarizeSample(observation: SampleObservation, origins: DeliveryOrigins): SampleSummary {
  const routes = new Map<RouteClass, RouteAccumulator>();
  for (const exchange of observation.exchanges) {
    const url = URL.canParse(exchange.url) ? new URL(exchange.url) : null;
    const routeClass = url === null ? "other" : classifyRoute(url, origins);
    const accumulator = routes.get(routeClass) ?? emptyAccumulator();
    routes.set(routeClass, accumulator);
    accumulator.requests += 1;
    accumulator.transferBytes += exchange.transferBytes;
    if (exchange.decodedBytes === null) accumulator.decodedBytesUnavailable += 1;
    else accumulator.decodedBytes += exchange.decodedBytes;
    accumulator.pathTemplates.add(url === null ? "/:unparseable" : pathTemplate(url, routeClass));
    accumulator.statuses.add(exchange.status);
    const headers = exchange.responseHeaders;
    for (const token of headerTokens(headers["cache-control"], cacheDirective)) accumulator.cacheControl.add(token);
    for (const token of headerTokens(headers["content-encoding"], codingToken)) accumulator.contentEncoding.add(token);
    for (const token of headerTokens(headers.vary, varyToken)) accumulator.vary.add(token);
    for (const token of serverTimingTokens(headers["server-timing"])) accumulator.serverTiming.add(token);
  }
  return {
    firstContentfulPaintMilliseconds: roundMilliseconds(observation.firstContentfulPaintMilliseconds),
    index: observation.index,
    localProcessCpuMilliseconds: roundMilliseconds(observation.localProcessCpuMilliseconds),
    outcome: observation.readyMilliseconds === null ? "timeout" : "ready",
    readyMilliseconds: roundMilliseconds(observation.readyMilliseconds),
    routes: routeClasses.flatMap((routeClass): RouteSummary[] => {
      const accumulator = routes.get(routeClass);
      if (accumulator === undefined) return [];
      return [{
        cacheControl: sorted(accumulator.cacheControl),
        contentEncoding: sorted(accumulator.contentEncoding),
        decodedBytes: accumulator.decodedBytes,
        decodedBytesUnavailable: accumulator.decodedBytesUnavailable,
        pathTemplates: sorted(accumulator.pathTemplates),
        requests: accumulator.requests,
        routeClass,
        serverTiming: sorted(accumulator.serverTiming),
        statuses: [...accumulator.statuses].sort((left, right) => left - right),
        transferBytes: accumulator.transferBytes,
        vary: sorted(accumulator.vary),
      }];
    }),
  };
}

export function statistics(values: readonly number[]): Statistics | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const median = ordered.length % 2 === 0
    ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
    : ordered[middle] ?? 0;
  return {maximum: ordered.at(-1) ?? 0, median, minimum: ordered[0] ?? 0};
}

function present(values: readonly (number | null)[]): readonly number[] {
  return values.flatMap((value) => value === null ? [] : [value]);
}

function sampleTotal(sample: SampleSummary, field: "decodedBytes" | "requests" | "transferBytes"): number {
  return sample.routes.reduce((total, route) => total + route[field], 0);
}

export function summarizeJourney(
  journey: JourneyName,
  cache: CacheState,
  samples: readonly SampleSummary[],
): JourneySummary {
  return {
    aggregate: {
      decodedBytes: statistics(samples.map((sample) => sampleTotal(sample, "decodedBytes"))),
      firstContentfulPaintMilliseconds: statistics(present(samples.map((sample) => sample.firstContentfulPaintMilliseconds))),
      localProcessCpuMilliseconds: statistics(present(samples.map((sample) => sample.localProcessCpuMilliseconds))),
      readyMilliseconds: statistics(present(samples.map((sample) => sample.readyMilliseconds))),
      requests: statistics(samples.map((sample) => sampleTotal(sample, "requests"))),
      transferBytes: statistics(samples.map((sample) => sampleTotal(sample, "transferBytes"))),
    },
    cache,
    journey,
    samples,
    timeouts: samples.filter((sample) => sample.outcome === "timeout").length,
  };
}

/** The served review bundle filename identifies the deployed web build. */
export function detectWebBuild(exchanges: readonly CapturedExchange[], origins: DeliveryOrigins): string | null {
  for (const exchange of exchanges) {
    if (!URL.canParse(exchange.url)) continue;
    const url = new URL(exchange.url);
    if (url.origin !== origins.applicationOrigin) continue;
    const match = webBuildAsset.exec(url.pathname);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

function cookieValues(header: string | undefined): readonly string[] {
  if (header === undefined) return [];
  return header.split(/[;,]/u).flatMap((pair) => {
    const separator = pair.indexOf("=");
    return separator === -1 ? [] : [pair.slice(separator + 1).trim()];
  });
}

function safelyDecoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Every capability-bearing value one run saw; none may appear in a committed report. */
export function sensitiveValues(
  exchanges: readonly CapturedExchange[],
  origins: DeliveryOrigins,
): ReadonlySet<string> {
  const values = new Set<string>();
  const add = (value: string) => {
    if (value.length >= minimumSensitiveLength) values.add(value);
  };
  for (const exchange of exchanges) {
    add(exchange.requestHeaders.authorization ?? "");
    for (const value of cookieValues(exchange.requestHeaders.cookie)) add(value);
    for (const value of cookieValues(exchange.responseHeaders["set-cookie"])) add(value);
    if (!URL.canParse(exchange.url)) continue;
    const url = new URL(exchange.url);
    const routeClass = classifyRoute(url, origins);
    for (const value of url.searchParams.values()) add(value);
    if (isContentRoute(routeClass)) add(url.hostname);
    if (routeClass === "app-shell" && url.pathname.startsWith("/assets/")) continue;
    const vocabulary = routeClass === "api" ? apiVocabulary : routeClass === "app-shell" ? appShellVocabulary : null;
    for (const segment of url.pathname.split("/")) {
      const decoded = safelyDecoded(segment);
      if (vocabulary === null || !vocabulary.has(decoded)) add(decoded);
    }
  }
  return values;
}

export function leakedValues(serialized: string, values: ReadonlySet<string>): readonly string[] {
  return [...values].filter((value) => serialized.includes(value));
}

export function buildDeliveryReport(input: DeliveryReportInput): DeliveryReport {
  return {
    browser: {name: "chromium", version: input.browserVersion},
    context: input.context,
    deploymentRevision: input.deploymentRevision,
    format: "artifact-server.delivery-baseline",
    formatVersion: 1,
    journeys: input.journeys,
    label: input.label,
    network: "unthrottled",
    representativeCompression: input.target === "hosted",
    samplesPerJourney: input.samplesPerJourney,
    target: input.target,
    webBuild: input.webBuild,
  };
}

type StatisticUnit = "bytes" | "count" | "milliseconds";

function formatValue(value: number, unit: StatisticUnit): string {
  if (unit === "milliseconds") return `${Math.round(value)} ms`;
  if (unit === "count") return String(Math.round(value));
  return value >= 1_048_576 ? `${(value / 1_048_576).toFixed(2)} MiB` : `${(value / 1_024).toFixed(1)} KiB`;
}

function formatStatistics(value: Statistics | null, unit: StatisticUnit): string {
  if (value === null) return "n/a";
  return `${formatValue(value.median, unit)} (${formatValue(value.minimum, unit)}–${formatValue(value.maximum, unit)})`;
}

/** A Markdown table for FINDINGS.md: medians with ranges, and the lease encodings seen. */
export function formatJourneyTable(report: DeliveryReport): string {
  const rows = report.journeys.map((journey) => {
    const encodings = new Set(journey.samples
      .flatMap((sample) => sample.routes)
      .filter((route) => route.routeClass === "preview-lease")
      .flatMap((route) => route.contentEncoding));
    const aggregate = journey.aggregate;
    return [
      journey.journey,
      journey.cache,
      formatStatistics(aggregate.readyMilliseconds, "milliseconds"),
      formatStatistics(aggregate.firstContentfulPaintMilliseconds, "milliseconds"),
      formatStatistics(aggregate.requests, "count"),
      formatStatistics(aggregate.transferBytes, "bytes"),
      formatStatistics(aggregate.decodedBytes, "bytes"),
      encodings.size === 0 ? "identity" : sorted(encodings).join(", "),
      String(journey.timeouts),
    ].join(" | ");
  });
  return [
    "| Journey | Cache | Ready | First paint | Requests | Transferred | Decoded | Lease encoding | Timeouts |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row} |`),
  ].join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/tooling/delivery-report.test.ts`
Expected: PASS (8 tests). If the table test fails on byte formatting, recompute: four exchanges × 1024 transfer bytes = 4096 = "4.0 KiB"; four × 4096 decoded bytes = 16384 = "16.0 KiB". Fix the code, not the expectation.

- [ ] **Step 5: Lint and typecheck**

Run: `pnpm exec oxlint --type-aware --type-check --deny-warnings project/performance/delivery tests/tooling/delivery-report.test.ts`
Expected: no diagnostics. Fix any rule hit by restructuring, never by disabling the rule.

- [ ] **Step 6: Commit**

```bash
git add project/performance/delivery/delivery-report.ts tests/tooling/delivery-report.test.ts
git commit -m "Add the sanitized delivery report builder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Private raw-output directory

**Files:**
- Create: `project/performance/delivery/private-output.ts`
- Test: `tests/tooling/delivery-private-output.test.ts`

**Interfaces:**
- Produces (used by Task 3):
  - `defaultDeliveryStateRoot: string` (`~/.local/state/artifact-server/delivery`)
  - `class PrivateOutputRejected extends Error`
  - `preparePrivateRunDirectory(stateRoot: string, runId: string): Promise<PreparedPrivateRun>` where `interface PreparedPrivateRun { runDirectory: string; stateRoot: string }` (both resolved absolute paths)
  - `writePrivateFile(filePath: string, contents: string): Promise<void>`, which writes with mode `0600`
  - `restrictPrivateTree(directory: string): Promise<void>`, which sets every file below the directory to `0600` and every directory to `0700`

- [ ] **Step 1: Write the failing tests**

Create `tests/tooling/delivery-private-output.test.ts`:

```ts
import {existsSync} from "node:fs";
import {mkdir, mkdtemp, rm, stat, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  preparePrivateRunDirectory,
  PrivateOutputRejected,
  restrictPrivateTree,
  writePrivateFile,
} from "../../project/performance/delivery/private-output.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

async function mode(target: string): Promise<number> {
  return (await stat(target)).mode & 0o777;
}

describe("delivery private output", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "delivery-private-output-"));
  });

  afterEach(async () => {
    await rm(scratch, {force: true, recursive: true});
  });

  test("foundation: a raw-output root inside the repository is rejected before anything is created", async () => {
    const inside = path.join(repositoryRoot, "project", "evidence", "raw-delivery-captures");
    await expect(preparePrivateRunDirectory(inside, "run-1")).rejects.toBeInstanceOf(PrivateOutputRejected);
    await expect(preparePrivateRunDirectory(repositoryRoot, "run-1")).rejects.toBeInstanceOf(PrivateOutputRejected);
    expect(existsSync(inside)).toBe(false);
  });

  test("foundation: a symbolic link that leads into the repository is rejected", async () => {
    const link = path.join(scratch, "looks-private");
    await symlink(repositoryRoot, link);
    await expect(preparePrivateRunDirectory(path.join(link, "captures"), "run-1"))
      .rejects.toBeInstanceOf(PrivateOutputRejected);
    expect(existsSync(path.join(repositoryRoot, "captures"))).toBe(false);
  });

  test("foundation: a run identifier cannot escape its state root", async () => {
    await expect(preparePrivateRunDirectory(path.join(scratch, "state"), "../escape"))
      .rejects.toBeInstanceOf(PrivateOutputRejected);
  });

  test("foundation: private directories are 0700 and private files are 0600", async () => {
    const prepared = await preparePrivateRunDirectory(path.join(scratch, "state"), "run-1");
    expect(await mode(prepared.stateRoot)).toBe(0o700);
    expect(await mode(prepared.runDirectory)).toBe(0o700);
    const session = path.join(prepared.stateRoot, "hosted-session.json");
    await writePrivateFile(session, "{}");
    expect(await mode(session)).toBe(0o600);

    const har = path.join(prepared.runDirectory, "library-0.har");
    await writeFile(har, "{}", {mode: 0o644});
    await mkdir(path.join(prepared.runDirectory, "nested"), {mode: 0o755});
    await restrictPrivateTree(prepared.runDirectory);
    expect(await mode(har)).toBe(0o600);
    expect(await mode(path.join(prepared.runDirectory, "nested"))).toBe(0o700);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/tooling/delivery-private-output.test.ts`
Expected: FAIL, because the module cannot be resolved.

- [ ] **Step 3: Implement private output**

Create `project/performance/delivery/private-output.ts`:

```ts
import {chmod, mkdir, readdir, realpath, writeFile} from "node:fs/promises";
import {homedir} from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const runIdentifier = /^[A-Za-z0-9_-]{1,80}$/u;

export const defaultDeliveryStateRoot = path.join(
  homedir(),
  ".local",
  "state",
  "artifact-server",
  "delivery",
);

/** Raw captures hold cookies and capability hostnames; they never enter the repository. */
export class PrivateOutputRejected extends Error {}

export interface PreparedPrivateRun {
  readonly runDirectory: string;
  readonly stateRoot: string;
}

/** Resolve through the deepest existing ancestor so a symbolic link cannot hide the repository. */
async function resolveThroughExistingAncestor(
  target: string,
  pending: readonly string[] = [],
): Promise<string> {
  try {
    return path.join(await realpath(target), ...pending);
  } catch (error) {
    const parent = path.dirname(target);
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!missing || parent === target) throw error;
    return resolveThroughExistingAncestor(parent, [path.basename(target), ...pending]);
  }
}

export async function preparePrivateRunDirectory(
  stateRoot: string,
  runId: string,
): Promise<PreparedPrivateRun> {
  if (!runIdentifier.test(runId)) {
    throw new PrivateOutputRejected("The run identifier must be a plain name.");
  }
  const resolvedRoot = await resolveThroughExistingAncestor(path.resolve(stateRoot));
  const repository = await realpath(repositoryRoot);
  const relative = path.relative(repository, resolvedRoot);
  const outside = relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);
  if (!outside) {
    throw new PrivateOutputRejected(
      `Raw delivery captures must stay outside the repository; ${stateRoot} resolves inside it.`,
    );
  }
  const runDirectory = path.join(resolvedRoot, runId);
  await mkdir(runDirectory, {mode: 0o700, recursive: true});
  await chmod(resolvedRoot, 0o700);
  await chmod(runDirectory, 0o700);
  return {runDirectory, stateRoot: resolvedRoot};
}

export async function writePrivateFile(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, {mode: 0o600});
  // writeFile applies the mode only when it creates the file.
  await chmod(filePath, 0o600);
}

/** Playwright writes HAR files with default permissions; tighten them after a context closes. */
export async function restrictPrivateTree(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  const entries = await readdir(directory, {withFileTypes: true});
  await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? restrictPrivateTree(target) : chmod(target, 0o600);
  }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/tooling/delivery-private-output.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint**

Run: `pnpm exec oxlint --type-aware --type-check --deny-warnings project/performance/delivery tests/tooling/delivery-private-output.test.ts`
Expected: no diagnostics.

- [ ] **Step 6: Commit**

```bash
git add project/performance/delivery/private-output.ts tests/tooling/delivery-private-output.test.ts
git commit -m "Keep raw delivery captures in private storage outside the repository

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Synthetic fixture, browser capture, and runner

**Files:**
- Create: `project/performance/delivery/synthetic-prototype.ts`
- Create: `project/performance/delivery/browser-capture.ts`
- Create: `project/performance/run-delivery-baseline.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: everything from Tasks 1 and 2; `startTestServer`, `createTestInstallation`, and `removeTestInstallation` from `tests/support/runtime-harness.ts`; `publishPath` from `src/client/file-publication-client.ts`; `captureMeasurementContext` from `project/performance/measurement-context.ts`.
- Produces: `writeSyntheticPrototype(directory: string): Promise<void>`; `class ExchangeRecorder`; `class ContentNetworkMonitor`; `measureSample(page: Page, recorder: ExchangeRecorder, monitor: ContentNetworkMonitor, request: SampleRequest): Promise<SampleObservation>`; the CLI `pnpm perf:delivery`.

This task is verified by running the harness end to end (Step 6), not by unit tests. Its pure logic is already covered in Tasks 1 and 2.

- [ ] **Step 1: Read the Effect guide**

Read `node_modules/effect/AGENTS.md` completely. The only Effect code here is the `publishPath` call, copied from `tests/browser/design-library.spec.ts:18-24`.

- [ ] **Step 2: Write the synthetic fixture**

Create `project/performance/delivery/synthetic-prototype.ts`:

```ts
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

/**
 * Sizes follow the ExtractionKit files named in PLAN.md: the DS bundle, the icon
 * CSS and three eagerly loaded data scripts. The text is seeded and JSON-like, so
 * it compresses like code but not like the real fixtures.
 */
const bundleBytes = 1_740_000;
const iconBytes = 1_040_000;
const dataFiles = [
  {bytes: 6_500_000, path: "data/ek-data-design-record.js"},
  {bytes: 3_900_000, path: "data/ek-data-viewer.js"},
  {bytes: 2_600_000, path: "data/ek-data-record.js"},
] as const;

const words = [
  "claim", "record", "field", "review", "status", "panel", "viewer", "extract",
  "amount", "party", "address", "court", "filing", "docket", "exhibit", "invoice",
  "signature", "page", "region", "anchor", "summary", "detail", "history", "owner",
  "assignee", "due", "date", "total", "balance", "payment", "schedule", "notice",
  "evidence", "witness", "hearing", "motion", "order", "appeal", "judgment", "lien",
  "policy", "carrier", "injury", "employer", "benefit", "medical", "wage", "award",
] as const;
const statuses = ["awaiting-review", "accepted", "rejected", "needs-source"] as const;
const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Mulberry32: a small deterministic generator so every run publishes identical bytes. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(values: readonly T[], random: () => number): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) throw new Error("The fixture vocabulary is empty.");
  return value;
}

function generateText(targetBytes: number, prelude: string, line: (index: number) => string): string {
  const parts = [prelude];
  let length = prelude.length;
  for (let index = 0; length < targetBytes; index += 1) {
    const next = line(index);
    parts.push(next);
    length += next.length;
  }
  return parts.join("");
}

function base64Run(random: () => number): string {
  const length = 48 + Math.floor(random() * 72);
  return Array.from({length}, () => pick([...base64Alphabet], random)).join("");
}

export async function writeSyntheticPrototype(directory: string): Promise<void> {
  const random = seededRandom(0x5e_ed);
  const word = () => pick(words, random);
  await mkdir(path.join(directory, "tokens"), {recursive: true});
  await mkdir(path.join(directory, "data"), {recursive: true});
  const bundle = generateText(bundleBytes, "window.SyntheticDs = {};\n", (index) =>
    `window.SyntheticDs.c${index} = function (props) { return "<div class=\\"ds-${word()}-${word()}\\" data-tone=\\"" + props.tone + "\\">" + props.${word()} + "</div>"; };\n`);
  const icons = generateText(iconBytes, "", (index) =>
    `.icon-${word()}-${index}{mask-image:url("data:image/svg+xml;base64,${base64Run(random)}")}\n`);
  await writeFile(path.join(directory, "ds-bundle.js"), bundle);
  await writeFile(path.join(directory, "tokens/icons.css"), icons);
  for (const file of dataFiles) {
    const rows = generateText(file.bytes, "window.SyntheticRows = window.SyntheticRows || [];\n", (index) =>
      `window.SyntheticRows.push({"id":"r${index}","field":"${word()}","status":"${pick(statuses, random)}","confidence":${random().toFixed(3)},"value":"${word()} ${word()} ${word()}"});\n`);
    // eslint-disable-next-line no-await-in-loop -- one file at a time bounds the fixture's memory
    await writeFile(path.join(directory, file.path), rows);
  }
  const scripts = ["ds-bundle.js", ...dataFiles.map((file) => file.path)]
    .map((source) => `<script src="${source}"></script>`)
    .join("");
  await writeFile(
    path.join(directory, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic prototype</title><link rel="stylesheet" href="tokens/icons.css"></head><body><main>Synthetic prototype</main>${scripts}</body></html>`,
  );
  await writeFile(path.join(directory, "artifactserver.previews.json"), JSON.stringify({
    description: "Shaped like ExtractionKit for delivery measurement.",
    format: "artifact-server.preview-source",
    items: [{
      description: "One entry loading a bundle, icon CSS and eager data.",
      kind: "prototype",
      path: "index.html",
      section: "Prototypes",
      title: "Synthetic prototype",
      viewport: {height: 900, width: 1440},
    }],
    title: "Synthetic delivery prototype",
    version: 2,
  }, null, 2));
}
```

- [ ] **Step 3: Write the browser capture module**

Create `project/performance/delivery/browser-capture.ts`:

```ts
import {errors, type BrowserContext, type Page, type Request} from "@playwright/test";

import type {CapturedExchange, JourneyName, SampleObservation} from "./delivery-report.js";

const readyTimeoutMilliseconds = 120_000;
const contentQuietMilliseconds = 500;
const quietPollMilliseconds = 50;
const interactivePreview = 'iframe[title^="Interactive preview: "]';

/** Records every finished exchange in one browser context, including iframe requests. */
export class ExchangeRecorder {
  readonly #exchanges: CapturedExchange[] = [];
  readonly #pending = new Set<Promise<void>>();

  constructor(context: BrowserContext) {
    context.on("requestfinished", (request) => {
      // An exchange still recording when its context closes is dropped; every sample drains first.
      const recording = this.#record(request)
        .catch(() => undefined)
        .finally(() => this.#pending.delete(recording));
      this.#pending.add(recording);
    });
  }

  async #record(request: Request): Promise<void> {
    const response = await request.response();
    if (response === null) return;
    const [sizes, requestHeaders, responseHeaders] = await Promise.all([
      request.sizes(),
      request.allHeaders(),
      response.allHeaders(),
    ]);
    let decodedBytes: number | null;
    try {
      decodedBytes = (await response.body()).byteLength;
    } catch {
      // Redirects and evicted no-store bodies have no readable body.
      decodedBytes = null;
    }
    this.#exchanges.push({
      decodedBytes,
      requestHeaders,
      responseHeaders,
      status: response.status(),
      transferBytes: sizes.responseBodySize,
      url: request.url(),
    });
  }

  /** Returns everything recorded since the last drain, after pending recordings settle. */
  async drain(): Promise<readonly CapturedExchange[]> {
    await Promise.all(this.#pending);
    return this.#exchanges.splice(0);
  }
}

/** Counts content requests in flight so readiness can wait for the preview to go quiet. */
export class ContentNetworkMonitor {
  #inFlight = 0;
  #lastActivity = performance.now();
  readonly #isContent: (url: URL) => boolean;

  constructor(context: BrowserContext, isContent: (url: URL) => boolean) {
    this.#isContent = isContent;
    context.on("request", (request) => this.#adjust(request, 1));
    context.on("requestfinished", (request) => this.#adjust(request, -1));
    context.on("requestfailed", (request) => this.#adjust(request, -1));
  }

  matches(url: URL): boolean {
    return this.#isContent(url);
  }

  #adjust(request: Request, change: number): void {
    if (!URL.canParse(request.url()) || !this.#isContent(new URL(request.url()))) return;
    this.#inFlight = Math.max(0, this.#inFlight + change);
    this.#lastActivity = performance.now();
  }

  waitForQuiet(deadline: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const now = performance.now();
        if (this.#inFlight === 0 && now - this.#lastActivity >= contentQuietMilliseconds) {
          clearInterval(timer);
          resolve(true);
        } else if (now >= deadline) {
          clearInterval(timer);
          resolve(false);
        }
      }, quietPollMilliseconds);
    });
  }
}

export interface SampleRequest {
  readonly index: number;
  readonly journey: JourneyName;
  readonly measureLocalCpu: boolean;
  readonly navigation: "goto" | "reload";
  readonly url: URL;
}

function remaining(deadline: number): number {
  return Math.max(1, Math.round(deadline - performance.now()));
}

async function untilTimeout(work: Promise<boolean>): Promise<boolean> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof errors.TimeoutError) return false;
    throw error;
  }
}

function libraryReady(page: Page, deadline: number): Promise<boolean> {
  return untilTimeout(page
    .getByRole("region", {exact: true, name: "Library"})
    .locator("a[data-gallery-path]")
    .first()
    .waitFor({state: "visible", timeout: remaining(deadline)})
    .then(() => true));
}

async function prototypeReady(page: Page, monitor: ContentNetworkMonitor, deadline: number): Promise<boolean> {
  return untilTimeout((async () => {
    const element = await page.waitForSelector(interactivePreview, {state: "attached", timeout: remaining(deadline)});
    const frame = await element.contentFrame();
    if (frame === null) return false;
    await frame.waitForURL((url) => monitor.matches(url), {timeout: remaining(deadline), waitUntil: "load"});
    return monitor.waitForQuiet(deadline);
  })());
}

function firstContentfulPaint(page: Page): Promise<number | null> {
  return page.evaluate(() => performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null);
}

export async function measureSample(
  page: Page,
  recorder: ExchangeRecorder,
  monitor: ContentNetworkMonitor,
  request: SampleRequest,
): Promise<SampleObservation> {
  await recorder.drain();
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  const deadline = started + readyTimeoutMilliseconds;
  if (request.navigation === "reload") await page.reload({waitUntil: "commit"});
  else await page.goto(request.url.toString(), {waitUntil: "commit"});
  const ready = request.journey === "library"
    ? await libraryReady(page, deadline)
    : await prototypeReady(page, monitor, deadline);
  const readyMilliseconds = ready ? performance.now() - started : null;
  const cpu = process.cpuUsage(cpuBefore);
  return {
    exchanges: await recorder.drain(),
    firstContentfulPaintMilliseconds: await firstContentfulPaint(page),
    index: request.index,
    localProcessCpuMilliseconds: request.measureLocalCpu ? (cpu.user + cpu.system) / 1_000 : null,
    readyMilliseconds,
  };
}
```

- [ ] **Step 4: Write the runner**

Create `project/performance/run-delivery-baseline.ts`:

```ts
import {randomUUID} from "node:crypto";
import {existsSync} from "node:fs";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {chromium, type Browser, type BrowserContext, type BrowserContextOptions} from "@playwright/test";
import {Command} from "commander";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {z} from "zod";

import {publishPath} from "../../src/client/file-publication-client.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
} from "../../tests/support/runtime-harness.js";
import {ContentNetworkMonitor, ExchangeRecorder, measureSample} from "./delivery/browser-capture.js";
import {
  buildDeliveryReport,
  classifyRoute,
  detectWebBuild,
  formatJourneyTable,
  isContentRoute,
  leakedValues,
  sensitiveValues,
  summarizeJourney,
  summarizeSample,
  type CapturedExchange,
  type DeliveryOrigins,
  type JourneyName,
  type JourneySummary,
  type SampleSummary,
} from "./delivery/delivery-report.js";
import {
  defaultDeliveryStateRoot,
  preparePrivateRunDirectory,
  restrictPrivateTree,
  writePrivateFile,
} from "./delivery/private-output.js";
import {writeSyntheticPrototype} from "./delivery/synthetic-prototype.js";
import {captureMeasurementContext} from "./measurement-context.js";

const viewport = {height: 1000, width: 1680} as const;
const signInTimeoutMilliseconds = 300_000;
const sessionCheckTimeoutMilliseconds = 15_000;

const optionsSchema = z.object({
  contentDomain: z.string().min(1).optional(),
  deploymentRevision: z.string().min(1).optional(),
  label: z.string().regex(/^[a-z0-9-]{1,40}$/u),
  output: z.string().min(1).optional(),
  prototypeUrl: z.url().optional(),
  samples: z.coerce.number().int().min(1).max(20),
  stateRoot: z.string().min(1),
  target: z.string().min(1),
});

type RunnerOptions = z.infer<typeof optionsSchema>;

interface DeliveryTarget {
  readonly close: () => Promise<void>;
  readonly kind: "hosted" | "local";
  readonly libraryUrl: URL;
  readonly origins: DeliveryOrigins;
  readonly prototypeUrl: URL;
  /** Prepares a fresh context's session without loading an application page. */
  readonly signIn: (context: BrowserContext) => Promise<void>;
  readonly storageStatePath: string | null;
}

const program = new Command()
  .name("delivery-baseline")
  .description("Measure Library and prototype delivery in Chromium without committing private data.")
  .requiredOption("--label <label>", "run label such as before or after (lowercase, digits, hyphens)")
  .option("--target <target>", "local, or the https origin of a hosted server", "local")
  .option("--samples <count>", "samples per journey (maximum 20)", "5")
  .option("--deployment-revision <digest>", "image digest recorded with the run")
  .option("--prototype-url <url>", "hosted Review URL of the prototype to open")
  .option("--content-domain <domain>", "hosted content domain, such as frontend.app")
  .option("--state-root <directory>", "private session and raw capture directory", defaultDeliveryStateRoot)
  .option("--output <path>", "sanitized report path");

async function startLocalTarget(): Promise<DeliveryTarget> {
  const installation = await createTestInstallation();
  const server = await startTestServer(installation);
  const fixture = await mkdtemp(path.join(tmpdir(), "delivery-baseline-fixture-"));
  try {
    await writeSyntheticPrototype(fixture);
    const published = await Effect.runPromise(publishPath(
      {apiToken: Redacted.make(installation.apiToken), serverOrigin: server.baseUrl},
      {
        idempotencyKey: randomUUID(),
        inputPath: fixture,
        projectId: "prj_default",
        target: {accessSetting: "account_required", kind: "new_artifact", name: "Synthetic delivery prototype", tags: []},
      },
    ).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(NodeFileSystem.layer)));
    const application = new URL(server.baseUrl);
    const prototypeUrl = new URL("/review", application);
    prototypeUrl.searchParams.set("project", "prj_default");
    prototypeUrl.searchParams.set("artifact", published.artifact.id);
    prototypeUrl.searchParams.set("path", "index.html");
    return {
      close: async () => {
        await server.stop();
        await removeTestInstallation(installation);
        await rm(fixture, {force: true, recursive: true});
      },
      kind: "local",
      libraryUrl: new URL("/review/library", application),
      origins: {applicationOrigin: application.origin, contentDomain: "localhost"},
      prototypeUrl,
      signIn: async (context) => {
        // The local-owner exchange accepts only a same-origin fetch from loopback.
        const response = await context.request.post(new URL("/auth/local-owner", application).toString(), {
          headers: {"Origin": application.origin, "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin"},
        });
        if (response.status() !== 204) {
          throw new Error(`Local-owner sign-in returned ${response.status()}.`);
        }
      },
      storageStatePath: null,
    };
  } catch (error) {
    await server.stop();
    await removeTestInstallation(installation);
    await rm(fixture, {force: true, recursive: true});
    throw error;
  }
}

async function sessionStillValid(browser: Browser, application: URL, statePath: string): Promise<boolean> {
  if (!existsSync(statePath)) return false;
  const context = await browser.newContext({storageState: statePath, viewport});
  try {
    const page = await context.newPage();
    await page.goto(new URL("/review", application).toString());
    const signedIn = await page
      .getByRole("link", {name: "Artifact Server"})
      .waitFor({state: "visible", timeout: sessionCheckTimeoutMilliseconds})
      .then(() => true, () => false);
    return signedIn && new URL(page.url()).origin === application.origin;
  } finally {
    await context.close();
  }
}

async function ensureHostedSession(browser: Browser, application: URL, statePath: string): Promise<void> {
  if (await sessionStillValid(browser, application, statePath)) return;
  const headed = await chromium.launch({headless: false});
  try {
    const context = await headed.newContext({viewport});
    const page = await context.newPage();
    await page.goto(new URL("/review", application).toString());
    process.stdout.write("Sign in to the hosted server in the opened browser window. Waiting up to 5 minutes.\n");
    await page.getByRole("link", {name: "Artifact Server"}).waitFor({state: "visible", timeout: signInTimeoutMilliseconds});
    if (new URL(page.url()).origin !== application.origin) {
      throw new Error("Sign-in did not return to the measured server.");
    }
    await writePrivateFile(statePath, JSON.stringify(await context.storageState()));
  } finally {
    await headed.close();
  }
}

function hostedTarget(options: RunnerOptions, statePath: string): DeliveryTarget {
  const application = new URL(options.target);
  if (application.protocol !== "https:") throw new Error("A hosted target must be an https origin.");
  if (options.prototypeUrl === undefined || options.contentDomain === undefined) {
    throw new Error("A hosted run needs --prototype-url and --content-domain.");
  }
  const prototypeUrl = new URL(options.prototypeUrl);
  if (prototypeUrl.origin !== application.origin) {
    throw new Error("The prototype URL must belong to the hosted target.");
  }
  return {
    close: () => Promise.resolve(),
    kind: "hosted",
    libraryUrl: new URL("/review/library", application),
    origins: {applicationOrigin: application.origin, contentDomain: options.contentDomain},
    prototypeUrl,
    signIn: () => Promise.resolve(),
    storageStatePath: statePath,
  };
}

interface JourneyResult {
  readonly cold: JourneySummary;
  readonly exchanges: readonly CapturedExchange[];
  readonly warm: JourneySummary;
}

async function measureJourney(
  browser: Browser,
  target: DeliveryTarget,
  journey: JourneyName,
  samples: number,
  runDirectory: string,
): Promise<JourneyResult> {
  const cold: SampleSummary[] = [];
  const warm: SampleSummary[] = [];
  const exchanges: CapturedExchange[] = [];
  const url = journey === "library" ? target.libraryUrl : target.prototypeUrl;
  for (let index = 0; index < samples; index += 1) {
    const base: BrowserContextOptions = {
      recordHar: {content: "omit", path: path.join(runDirectory, `${journey}-${index}.har`)},
      viewport,
    };
    // eslint-disable-next-line no-await-in-loop -- samples must not overlap or share a cache
    const context = await browser.newContext(target.storageStatePath === null
      ? base
      : {...base, storageState: target.storageStatePath});
    try {
      // eslint-disable-next-line no-await-in-loop -- each sample signs in its own context
      await target.signIn(context);
      const recorder = new ExchangeRecorder(context);
      const monitor = new ContentNetworkMonitor(context, (candidate) => isContentRoute(classifyRoute(candidate, target.origins)));
      // eslint-disable-next-line no-await-in-loop -- one page per sample context
      const page = await context.newPage();
      const measureLocalCpu = target.kind === "local";
      // eslint-disable-next-line no-await-in-loop -- the cold open must finish before the warm one
      const coldObservation = await measureSample(page, recorder, monitor, {index, journey, measureLocalCpu, navigation: "goto", url});
      // eslint-disable-next-line no-await-in-loop -- the warm open reuses the cold open's cache
      const warmObservation = await measureSample(page, recorder, monitor, {
        index,
        journey,
        measureLocalCpu,
        navigation: journey === "library" ? "reload" : "goto",
        url,
      });
      cold.push(summarizeSample(coldObservation, target.origins));
      warm.push(summarizeSample(warmObservation, target.origins));
      exchanges.push(...coldObservation.exchanges, ...warmObservation.exchanges);
    } finally {
      // eslint-disable-next-line no-await-in-loop -- closing writes the HAR before the next sample
      await context.close();
    }
  }
  return {
    cold: summarizeJourney(journey, "cold", cold),
    exchanges,
    warm: summarizeJourney(journey, "warm", warm),
  };
}

async function main(): Promise<void> {
  program.parse();
  const options = optionsSchema.parse(program.opts());
  const date = new Date().toISOString().slice(0, 10);
  const kind = options.target === "local" ? "local" : "hosted";
  const prepared = await preparePrivateRunDirectory(
    options.stateRoot,
    `${date}-${kind}-${options.label}-${randomUUID().slice(0, 8)}`,
  );
  const browser = await chromium.launch();
  const target = kind === "local"
    ? await startLocalTarget()
    : hostedTarget(options, path.join(prepared.stateRoot, "hosted-session.json"));
  try {
    if (target.kind === "hosted" && target.storageStatePath !== null) {
      await ensureHostedSession(browser, new URL(target.origins.applicationOrigin), target.storageStatePath);
    }
    const library = await measureJourney(browser, target, "library", options.samples, prepared.runDirectory);
    const prototype = await measureJourney(browser, target, "prototype", options.samples, prepared.runDirectory);
    const exchanges = [...library.exchanges, ...prototype.exchanges];
    const report = buildDeliveryReport({
      browserVersion: browser.version(),
      context: await captureMeasurementContext({label: options.label, target: kind}),
      deploymentRevision: options.deploymentRevision ?? null,
      journeys: [library.cold, library.warm, prototype.cold, prototype.warm],
      label: options.label,
      samplesPerJourney: options.samples,
      target: kind,
      webBuild: detectWebBuild(exchanges, target.origins),
    });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    const leaks = leakedValues(serialized, sensitiveValues(exchanges, target.origins));
    if (leaks.length > 0) {
      // Never print the values themselves.
      throw new Error(`Refusing to write a report containing ${leaks.length} captured sensitive value(s).`);
    }
    const output = path.resolve(options.output ?? `project/evidence/delivery-baseline-${date}-${kind}-${options.label}.json`);
    await mkdir(path.dirname(output), {recursive: true});
    await writeFile(output, serialized, "utf8");
    process.stdout.write(`${formatJourneyTable(report)}\n\nReport: ${output}\nRaw captures: ${prepared.runDirectory}\n`);
  } finally {
    await browser.close();
    await target.close();
    await restrictPrivateTree(prepared.runDirectory);
  }
}

void main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
```

Add the script to `package.json` next to `perf:capacity`:

```json
    "perf:delivery": "node --import tsx project/performance/run-delivery-baseline.ts",
```

- [ ] **Step 5: Lint and typecheck**

Run: `pnpm exec oxlint --type-aware --type-check --deny-warnings project/performance && pnpm typecheck`
Expected: no diagnostics. Likely fixes:
- If `publishPath`'s command type differs, match `tests/browser/design-library.spec.ts:18-24` exactly.
- If `captureMeasurementContext` rejects the details object, pass a `MeasurementDetails` record of strings.
- If `program.opts()` needs a cast, parse it with the schema (already done) and give any assertion a safety comment.

- [ ] **Step 6: Smoke-run the harness locally**

Run:
```bash
pnpm build
pnpm perf:delivery --label smoke --samples 1 --output "$TMPDIR/delivery-smoke.json"
```
Expected:
- The run finishes and prints a table with four rows (library cold/warm, prototype cold/warm), all with `Timeouts` = 0.
- Prototype cold "Transferred" is at least 13 MiB, and "Lease encoding" is `identity`. This is the pre-compression baseline.
- `ls -l ~/.local/state/artifact-server/delivery/` shows the run directory as `drwx------` and the HAR files as `-rw-------`.

If a journey times out:
- Library: check that `a[data-gallery-path]` renders for the synthetic gallery. If the publish client needs `cover`, add `"cover"` with a small PNG written by the fixture.
- Prototype: open the printed raw HAR's request list and confirm the lease host matches `review-<56 chars>.localhost`.
- Fix the harness, not the server.

Do not commit the smoke output.

- [ ] **Step 7: Commit**

```bash
git add project/performance/delivery/synthetic-prototype.ts project/performance/delivery/browser-capture.ts project/performance/run-delivery-baseline.ts package.json
git commit -m "Add the browser delivery baseline runner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Capture the before evidence (user checkpoint)

**Files:**
- Create: `project/evidence/delivery-baseline-2026-10-05-local-before.json` (generated; use the actual run date)
- Create: `project/evidence/delivery-baseline-<date>-hosted-before.json` (generated)

**Interfaces:**
- Consumes: `pnpm perf:delivery` from Task 3.
- Produces: the before reports and a private `perf:baseline` before report that Tasks 9 and 10 compare against.

- [ ] **Step 1: Local before run**

Run: `pnpm build && pnpm perf:delivery --label before`
Expected: the report is written to `project/evidence/delivery-baseline-<date>-local-before.json` and all four journeys have `Timeouts` 0.

- [ ] **Step 2: Local `perf:baseline` before run (private)**

Run: `pnpm perf:baseline --output "$HOME/.local/state/artifact-server/delivery/perf-baseline-before.json"`
Expected: the summary prints. Keep the file for the Task 9 comparison. Do not commit it.

- [ ] **Step 3: Ask the user for the hosted inputs**

Stop and ask the user:

> "The hosted before run is next. Please open ExtractionKit from the Library on artifacts.backend.app and paste its Review URL (without a `version` parameter, so we measure the current version). A Chromium window will open for you to sign in once."

Do not continue until the user replies.

- [ ] **Step 4: Hosted before run**

Run (with the user's URL):
```bash
pnpm perf:delivery --target https://artifacts.backend.app --content-domain frontend.app \
  --prototype-url '<the pasted Review URL>' --label before
```
Expected: a headed Chromium opens for the user's sign-in, then the samples run headlessly. The report is written to `project/evidence/delivery-baseline-<date>-hosted-before.json`. If the run refuses to write because of a leak, stop and report it to the user; never loosen the check.

- [ ] **Step 5: Privacy check of committed evidence**

Run:
```bash
grep -n -i -E 'cookie|authorization|bearer|__artifact_bootstrap|review-[a-z0-9_-]{20,}|frontend\.app|token' project/evidence/delivery-baseline-*.json || echo "clean"
```
Expected: `clean`. If anything else matches, investigate the builder (Task 1). Do not edit the report by hand.

- [ ] **Step 6: Commit**

```bash
git add project/evidence/delivery-baseline-*-before.json
git commit -m "Record local and hosted delivery baselines before compression

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Share content-encoding negotiation

**Files:**
- Create: `src/http/content-encoding.ts`
- Modify: `src/http/node-response-compression.ts`

**Interfaces:**
- Produces (used by Tasks 7 and 8):
  - `type ContentCoding = "br" | "gzip"`
  - `interface ContentEncoder { encode(body: ReadableStream<Uint8Array>, coding: ContentCoding, sizeHint: number): ReadableStream<Uint8Array> }`
  - `const minimumCompressedBodyBytes = 1024`
  - `isCompressibleMediaType(contentType: string | null): boolean`
  - `negotiateContentCoding(acceptEncoding: string | null): ContentCoding | null`
  - `appendAcceptEncodingVary(headers: Headers): void`

This is a refactor guarded by the existing tests. No behavior changes.

- [ ] **Step 1: Confirm the guard passes before the change**

Run: `pnpm vitest run tests/http/node-response-compression.test.ts`
Expected: PASS.

- [ ] **Step 2: Create the shared module**

Create `src/http/content-encoding.ts`:

```ts
/** A content coding Artifact Server produces at the Node origin. */
export type ContentCoding = "br" | "gzip";

/**
 * Streams one stored representation through a content coding. Node runtimes
 * supply an implementation; the Workers runtime leaves it absent because its
 * edge compresses responses.
 */
export interface ContentEncoder {
  encode(
    body: ReadableStream<Uint8Array>,
    coding: ContentCoding,
    sizeHint: number,
  ): ReadableStream<Uint8Array>;
}

/** Media types worth compressing at the Node origin. */
const compressibleMediaTypes: ReadonlySet<string> = new Set([
  "application/javascript",
  "application/json",
  "image/svg+xml",
  "text/css",
  "text/html",
  "text/javascript",
]);

/** Smaller bodies gain too little to justify the coding overhead. */
export const minimumCompressedBodyBytes = 1024;

export function isCompressibleMediaType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mediaType = contentType.split(";")[0]?.trim().toLocaleLowerCase("en-US");
  return mediaType !== undefined && compressibleMediaTypes.has(mediaType);
}

/** Prefer Brotli, then gzip; a missing header, identity only, or q=0 selects neither. */
export function negotiateContentCoding(acceptEncoding: string | null): ContentCoding | null {
  if (acceptEncoding === null) return null;
  let brotliAllowed = false;
  let gzipAllowed = false;
  for (const candidate of acceptEncoding.split(",")) {
    const [name = "", ...parameters] = candidate.trim().split(";");
    const coding = name.trim().toLocaleLowerCase("en-US");
    if (coding !== "br" && coding !== "gzip") continue;
    if (acceptQuality(parameters) === 0) continue;
    if (coding === "br") brotliAllowed = true;
    else gzipAllowed = true;
  }
  if (brotliAllowed) return "br";
  return gzipAllowed ? "gzip" : null;
}

function acceptQuality(parameters: ReadonlyArray<string>): number {
  for (const parameter of parameters) {
    const [key = "", value = ""] = parameter.split("=");
    if (key.trim().toLocaleLowerCase("en-US") !== "q") continue;
    const quality = Number(value.trim());
    return Number.isFinite(quality) ? quality : 1;
  }
  return 1;
}

/** Add `Accept-Encoding` to `Vary` unless it, or `*`, is already there. */
export function appendAcceptEncodingVary(headers: Headers): void {
  const existing = headers.get("Vary");
  if (
    existing !== null
    && (existing.trim() === "*" || existing
      .toLocaleLowerCase("en-US")
      .split(",")
      .some((member) => member.trim() === "accept-encoding"))
  ) {
    return;
  }
  headers.set("Vary", existing === null ? "Accept-Encoding" : `${existing}, Accept-Encoding`);
}
```

- [ ] **Step 3: Make the wrapper use it**

In `src/http/node-response-compression.ts`:
- Delete `compressibleMediaTypes`, `minimumCompressedBodyBytes`, `hasCompressibleMediaType`, `negotiateEncoding`, and `acceptQuality`.
- Import from `./content-encoding.js`.
- Replace `hasCompressibleMediaType(response.headers)` with `isCompressibleMediaType(response.headers.get("Content-Type"))`, and `negotiateEncoding(...)` with `negotiateContentCoding(...)`.
- Replace `withAppendedVary` with:

```ts
function withAppendedVary(response: Response): Response {
  const headers = new Headers(response.headers);
  appendAcceptEncodingVary(headers);
  if (headers.get("Vary") === response.headers.get("Vary")) return response;
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
```

Replace the file's top doc comment (above the old `compressibleMediaTypes`) with:

```ts
/**
 * Compresses the application's own in-memory responses (JSON, the HTML shell,
 * and memoized assets) by buffering them. Version content never reaches the
 * buffering path: `serveStoredVersionContent` either streams it through a
 * `ContentEncoder` (and sets `Content-Encoding`) or serves identity bytes with
 * `Accept-Ranges: bytes`, and both are passed through untouched here. The
 * Cloudflare Workers deployment receives edge compression instead of this
 * wrapper, which is why it wraps the Node request listener rather than living
 * inside the shared HTTP app.
 */
```

Also replace the inline comment `// Every compressible body here is an in-memory string or memoized asset; ...` with:
`// Only in-memory application responses reach this point; version content is either already encoded or rangeable.`

- [ ] **Step 4: Run the guard again**

Run: `pnpm vitest run tests/http/node-response-compression.test.ts && pnpm exec oxlint --type-aware --type-check --deny-warnings src/http`
Expected: PASS, and no diagnostics.

- [ ] **Step 5: Commit**

```bash
git add src/http/content-encoding.ts src/http/node-response-compression.ts
git commit -m "Share content-encoding negotiation between compression paths

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Blob read observation seam

**Files:**
- Create: `src/storage/observed-blob-store.ts`
- Modify: `src/local/create-local-runtime.ts` (`LocalRuntimeConfig`; `appDependenciesWithoutOAuth` near line 322)
- Modify: `tests/support/runtime-harness.ts` (`startTestServer` options)
- Test: `tests/http/content-delivery-compression.test.ts` (new; it grows in Tasks 7 and 8)

**Interfaces:**
- Consumes: `BlobStore`, `OpenedBlob`, and `OpenedBlobRange` from `src/core/ports.ts`.
- Produces (used by Task 8):
  - `interface BlobReadObserver { readonly bytesRead: (byteLength: number) => void }`
  - `observeBlobReads(blobs: BlobStore, observer: BlobReadObserver): BlobStore`
  - `LocalRuntimeConfig.blobReadObserver?: BlobReadObserver`
  - `startTestServer(installation, {blobReadObserver})`

- [ ] **Step 1: Write the failing test file**

Create `tests/http/content-delivery-compression.test.ts`:

```ts
import {createHash} from "node:crypto";
import {request} from "node:http";
import {brotliDecompressSync, gunzipSync} from "node:zlib";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const encoder = new TextEncoder();
const scriptPath = "assets/rows.js";
const scriptBytes = encoder.encode(`export const rows = [\n${
  Array.from({length: 400}, (_, index) => `  {"id": "row-${index}", "status": "awaiting-review"},`).join("\n")
}\n];\n`);
const scriptDigest = createHash("sha256").update(scriptBytes).digest("hex");

const leaseResponseSchema = z.object({baseUrl: z.url()});
const bootstrapResponseSchema = z.object({bootstrapUrl: z.url()});

function siteFiles(extra: readonly TestSiteFile[] = []): readonly TestSiteFile[] {
  return [
    {bytes: encoder.encode("<!doctype html><title>Compression</title>"), mediaType: "text/html; charset=utf-8", path: "index.html"},
    {bytes: scriptBytes, mediaType: "text/javascript; charset=utf-8", path: scriptPath},
    ...extra,
  ];
}

describe("streaming content-delivery compression", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let blobBytesRead = 0;

  beforeEach(async () => {
    installation = await createTestInstallation();
    blobBytesRead = 0;
    server = await startTestServer(installation, {
      blobReadObserver: {bytesRead: (byteLength) => {
        blobBytesRead += byteLength;
      }},
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function publishSite(
    accessSetting: "account_required" | "public_link",
    idempotencyKey: string,
    extra: readonly TestSiteFile[] = [],
  ): Promise<PublishResponse> {
    const files = siteFiles(extra);
    const upload = await createStagedUpload(server, installation, "index.html", files);
    await uploadEveryStagedFile(installation, upload.body, files);
    const committed = await commitStagedUpload(installation, upload.body, idempotencyKey, {
      accessSetting,
      kind: "new_artifact",
      name: `Compression ${idempotencyKey}`,
      tags: [],
    });
    expect(committed.response.status).toBe(201);
    return committed.body;
  }

  async function issuePreviewLease(published: PublishResponse): Promise<string> {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/preview-leases?projectId=${published.artifact.projectId}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}, method: "POST"},
    );
    expect(response.status).toBe(201);
    return leaseResponseSchema.parse(await response.json()).baseUrl;
  }

  test("foundation: the blob read observer counts a full identity read", async () => {
    const published = await publishSite("public_link", "observer-full-read");
    const response = await fetchVersion(server, new URL(scriptPath, published.links.version).toString());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(blobBytesRead).toBe(scriptBytes.byteLength);
  });
});
```

Check `tests/support/publishing.ts` for the exported names `PublishResponse` and `commitStagedUpload`'s return type. If the response type is exported under another name, import that name; don't redeclare it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/http/content-delivery-compression.test.ts`
Expected: FAIL, with a type error or `blobBytesRead` equal to 0, because `startTestServer` doesn't accept `blobReadObserver` yet.

- [ ] **Step 3: Implement the observation decorator**

Create `src/storage/observed-blob-store.ts`:

```ts
import type {BlobStore} from "../core/ports.js";

/** Observation seam for content-delivery tests; never parsed from the environment. */
export interface BlobReadObserver {
  readonly bytesRead: (byteLength: number) => void;
}

/** Pull-through counting keeps the source's backpressure: nothing is read ahead of demand. */
function countedStream(
  body: ReadableStream<Uint8Array>,
  observer: BlobReadObserver,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    cancel: (reason) => reader.cancel(reason),
    pull: async (controller) => {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      observer.bytesRead(next.value.byteLength);
      controller.enqueue(next.value);
    },
  }, {highWaterMark: 0});
}

export function observeBlobReads(blobs: BlobStore, observer: BlobReadObserver): BlobStore {
  const observed: BlobStore = {
    inspect: (sha256) => blobs.inspect(sha256),
    open: async (sha256) => {
      const opened = await blobs.open(sha256);
      return {...opened, body: countedStream(opened.body, observer)};
    },
    openRange: async (sha256, range) => {
      const opened = await blobs.openRange(sha256, range);
      return {...opened, body: countedStream(opened.body, observer)};
    },
    put: (write) => blobs.put(write),
  };
  const promote = blobs.promote;
  return promote === undefined
    ? observed
    : {...observed, promote: (source) => promote.call(blobs, source)};
}
```

- [ ] **Step 4: Wire the seam**

In `src/local/create-local-runtime.ts`:
- Add `import {observeBlobReads, type BlobReadObserver} from "../storage/observed-blob-store.js";`
- In `LocalRuntimeConfig`, after `linkedCaptureHooks`, add:

```ts
  /** Observation seam for content-delivery tests; never parsed from the environment. */
  readonly blobReadObserver?: BlobReadObserver;
```

- In `appDependenciesWithoutOAuth` (about line 322), replace `blobs,` with:

```ts
      blobs: config.blobReadObserver === undefined
        ? blobs
        : observeBlobReads(blobs, config.blobReadObserver),
```

In `tests/support/runtime-harness.ts`:
- Import `type BlobReadObserver` from `../../src/storage/observed-blob-store.js`.
- Add `readonly blobReadObserver?: BlobReadObserver;` to the `startTestServer` options (alphabetical position, after `autoAdmitEmailDomains`).
- After `let config: LocalServerConfig = baseConfig;`, add:

```ts
  if (options.blobReadObserver !== undefined) {
    config = {...config, blobReadObserver: options.blobReadObserver};
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run tests/http/content-delivery-compression.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Lint and commit**

Run: `pnpm exec oxlint --type-aware --type-check --deny-warnings src/storage src/local tests/support tests/http/content-delivery-compression.test.ts`
Expected: no diagnostics.

```bash
git add src/storage/observed-blob-store.ts src/local/create-local-runtime.ts tests/support/runtime-harness.ts tests/http/content-delivery-compression.test.ts
git commit -m "Add a blob read observation seam for delivery tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Stream-compress eligible version content (CNT-010-B)

**Files:**
- Create: `src/http/node-content-encoder.ts`
- Modify: `src/http/create-http-app.ts` (`HttpAppDependencies` at about line 509; `serveStoredVersionContent` at about line 3782)
- Modify: `src/local/create-local-runtime.ts` and `src/external-storage/create-external-storage-runtime.ts` (inject the encoder)
- Modify: `tests/http/node-response-compression.test.ts` (remove the superseded test)
- Test: `tests/http/content-delivery-compression.test.ts`

**Interfaces:**
- Consumes: `ContentEncoder`, `ContentCoding`, `negotiateContentCoding`, `isCompressibleMediaType`, `minimumCompressedBodyBytes`, and `appendAcceptEncodingVary` from Task 5.
- Produces: `nodeContentEncoder: ContentEncoder`; `HttpAppDependencies.contentEncoder?: ContentEncoder`.

- [ ] **Step 1: Write the failing CNT-010-B test**

Add these helpers inside the `describe` block of `tests/http/content-delivery-compression.test.ts`, after `issuePreviewLease`:

```ts
  async function openContentSession(published: PublishResponse): Promise<{readonly cookie: string; readonly origin: string}> {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/content-sessions`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}, method: "POST"},
    );
    expect(response.status).toBe(201);
    const issued = bootstrapResponseSchema.parse(await response.json());
    const exchange = await fetchVersion(server, issued.bootstrapUrl);
    const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
    if (cookie === undefined) throw new Error("The content session set no cookie.");
    return {cookie, origin: new URL(issued.bootstrapUrl).origin};
  }

  function decode(coding: string | null, bytes: ArrayBuffer): Uint8Array {
    const buffer = Buffer.from(bytes);
    if (coding === "br") return new Uint8Array(brotliDecompressSync(buffer));
    if (coding === "gzip") return new Uint8Array(gunzipSync(buffer));
    return new Uint8Array(buffer);
  }
```

Add the test:

```ts
  test("CNT-010-B: eligible full content responses stream br or gzip and decode to the stored bytes", async () => {
    const privateSite = await publishSite("account_required", "cnt-010-b-private");
    const publicSite = await publishSite("public_link", "cnt-010-b-public");
    const session = await openContentSession(privateSite);
    const targets = [
      {cookie: null, url: new URL(scriptPath, await issuePreviewLease(privateSite)).toString()},
      {cookie: null, url: new URL(scriptPath, publicSite.links.version).toString()},
      {cookie: session.cookie, url: new URL(scriptPath, session.origin).toString()},
    ];
    for (const target of targets) {
      const base: Record<string, string> = target.cookie === null ? {} : {Cookie: target.cookie};
      for (const coding of ["br", "gzip"] as const) {
        // eslint-disable-next-line no-await-in-loop -- each request is asserted on its own
        const encoded = await fetchVersion(server, target.url, "GET", {...base, "Accept-Encoding": coding});
        expect(encoded.status).toBe(200);
        expect(encoded.headers.get("content-encoding")).toBe(coding);
        expect(encoded.headers.get("etag")).toBe(`W/"${scriptDigest}"`);
        expect(encoded.headers.get("vary")).toContain("Accept-Encoding");
        expect(encoded.headers.get("content-length")).toBeNull();
        expect(encoded.headers.get("accept-ranges")).toBeNull();
        // Chunked transfer proves the buffering wrapper did not re-materialize the body.
        expect(encoded.headers.get("transfer-encoding")).toBe("chunked");
        // eslint-disable-next-line no-await-in-loop -- the body belongs to this response
        expect(decode(coding, await encoded.arrayBuffer())).toEqual(scriptBytes);

        // eslint-disable-next-line no-await-in-loop -- HEAD must mirror the GET just made
        const head = await fetchVersion(server, target.url, "HEAD", {...base, "Accept-Encoding": coding});
        expect(head.status).toBe(200);
        expect(head.headers.get("content-encoding")).toBe(coding);
        expect(head.headers.get("etag")).toBe(`W/"${scriptDigest}"`);
        expect(head.headers.get("content-length")).toBeNull();
        expect(head.headers.get("accept-ranges")).toBeNull();
      }

      // eslint-disable-next-line no-await-in-loop -- identity is asserted after both codings
      const identity = await fetchVersion(server, target.url, "GET", base);
      expect(identity.headers.get("content-encoding")).toBeNull();
      expect(identity.headers.get("accept-ranges")).toBe("bytes");
      expect(identity.headers.get("etag")).toBe(`"${scriptDigest}"`);
      expect(identity.headers.get("vary")).toContain("Accept-Encoding");
      // eslint-disable-next-line no-await-in-loop -- the body belongs to this response
      expect(new Uint8Array(await identity.arrayBuffer())).toEqual(scriptBytes);

      // eslint-disable-next-line no-await-in-loop -- revalidation follows the full reads
      const revalidated = await fetchVersion(server, target.url, "GET", {
        ...base,
        "Accept-Encoding": "gzip",
        "If-None-Match": `W/"${scriptDigest}"`,
      });
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get("vary")).toContain("Accept-Encoding");
      expect(revalidated.headers.get("content-encoding")).toBeNull();
    }
  }, 60_000);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/http/content-delivery-compression.test.ts -t "CNT-010-B"`
Expected: FAIL at `expect(encoded.headers.get("content-encoding")).toBe(coding)`, because it receives `null`.

- [ ] **Step 3: Implement the Node encoder**

Create `src/http/node-content-encoder.ts`:

```ts
import {Duplex} from "node:stream";
import {constants, createBrotliCompress, createGzip} from "node:zlib";

import type {ContentEncoder} from "./content-encoding.js";

/** Brotli 4 and gzip 6 keep per-open CPU modest while streaming; see FINDINGS "Browser delivery". */
const brotliQuality = 4;
const gzipLevel = 6;

export const nodeContentEncoder: ContentEncoder = {
  encode(body, coding, sizeHint) {
    const compressor = coding === "br"
      ? createBrotliCompress({
        params: {
          [constants.BROTLI_PARAM_QUALITY]: brotliQuality,
          [constants.BROTLI_PARAM_SIZE_HINT]: sizeHint,
        },
      })
      : createGzip({level: gzipLevel});
    // pipeThrough takes backpressure from the socket and cancels the blob read
    // when the client disconnects; a storage error aborts the encoded stream.
    return body.pipeThrough(Duplex.toWeb(compressor));
  },
};
```

If TypeScript rejects `Duplex.toWeb(...)` as a `ReadableWritablePair<Uint8Array, Uint8Array>`, assign it to `const pair: ReadableWritablePair<Uint8Array, Uint8Array>` with a `// SAFETY:` comment explaining that zlib streams carry Buffers, which are `Uint8Array`s.

- [ ] **Step 4: Select the coding in `serveStoredVersionContent`**

In `src/http/create-http-app.ts`:

1. Add imports:

```ts
import {
  appendAcceptEncodingVary,
  type ContentCoding,
  type ContentEncoder,
  isCompressibleMediaType,
  minimumCompressedBodyBytes,
  negotiateContentCoding,
} from "./content-encoding.js";
```

2. Add to `HttpAppDependencies` (alphabetical, after `contentDomain`):

```ts
  /**
   * Streams eligible version content through a content coding. Node runtimes
   * supply one; the Workers runtime leaves it absent because its edge compresses.
   */
  readonly contentEncoder?: ContentEncoder;
```

3. In `serveStoredVersionContent`, directly after `const strongEtag = ...;` and before the `etagMatches` check, add:

```ts
  const coding = selectContentCoding(
    context.req.raw.headers,
    content.entry,
    headers,
    dependencies.contentEncoder,
  );
```

4. In the 304 branch, add `headers.delete("Content-Encoding");` next to `headers.delete("Content-Length");`. A stored identity copy must not be relabeled as encoded.

5. Replace the final full-response block:

```ts
  const blob = await dependencies.blobs.open(content.entry.sha256);
  if (blob.size !== content.entry.size) {
    await blob.body.cancel();
    assertBlobSize(blob.size, content.entry.size, content.entry.sha256);
  }
  return new Response(blob.body, {
    headers,
    status: 200,
  });
```

with:

```ts
  const blob = await dependencies.blobs.open(content.entry.sha256);
  if (blob.size !== content.entry.size) {
    await blob.body.cancel();
    assertBlobSize(blob.size, content.entry.size, content.entry.sha256);
  }
  const body = coding === null || dependencies.contentEncoder === undefined
    ? blob.body
    : dependencies.contentEncoder.encode(blob.body, coding, content.entry.size);
  return new Response(body, {
    headers,
    status: 200,
  });
```

6. Add this function after `serveStoredVersionContent`:

```ts
/**
 * Chooses the coding for one version-content response and shapes its headers.
 * Ranges stay on the identity representation: a request naming a range is never
 * encoded, and an encoded response stops advertising ranges. Callers serve only
 * GET and HEAD, and HEAD reports what the matching GET would send.
 */
function selectContentCoding(
  requestHeaders: Headers,
  entry: ManifestEntry,
  headers: Headers,
  encoder: ContentEncoder | undefined,
): ContentCoding | null {
  if (
    encoder === undefined
    || entry.size < minimumCompressedBodyBytes
    || !isCompressibleMediaType(entry.mediaType)
  ) {
    return null;
  }
  appendAcceptEncodingVary(headers);
  if (requestHeaders.has("range")) return null;
  const coding = negotiateContentCoding(requestHeaders.get("accept-encoding"));
  if (coding === null) return null;
  headers.set("Content-Encoding", coding);
  headers.delete("Content-Length");
  headers.delete("Accept-Ranges");
  headers.set("ETag", `W/"${entry.sha256}"`);
  return coding;
}
```

The existing HEAD branch and range logic need no other change. With a coding selected there is no `Range` header, so `decideByteRange` returns `full`, and the HEAD branch returns the shaped headers.

- [ ] **Step 5: Inject the encoder in both Node runtimes**

In `src/local/create-local-runtime.ts`, import `{nodeContentEncoder} from "../http/node-content-encoder.js"` and add `contentEncoder: nodeContentEncoder,` to `appDependenciesWithoutOAuth` after `contentDomain`.

In `src/external-storage/create-external-storage-runtime.ts`, add the same import and add `contentEncoder: nodeContentEncoder,` to the `appDependenciesWithoutOAuth` object (about line 235) after `contentDomain`.

Do not touch `deploy/cloudflare/src/worker.ts`.

- [ ] **Step 6: Remove the superseded test**

In `tests/http/node-response-compression.test.ts`, delete the whole test `"foundation: range-capable content responses are never compressed"` (about lines 187–222). Its full-response half asserted the old behavior. Its range half is covered by CNT-010-F in Task 8. Remove any imports or fixtures left unused.

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run tests/http/content-delivery-compression.test.ts tests/http/node-response-compression.test.ts`
Expected: PASS.

Then run the full suite: `pnpm test`
Expected: PASS. If a test fails because content is now compressed (for example, a test that sends `Accept-Encoding` and compares raw bytes), decide whether it was asserting old behavior. If so, update it to decode, and say so in the commit message. If it reveals a real defect (ranges, 304, HEAD), fix the code.

- [ ] **Step 8: Lint and commit**

Run: `pnpm lint && pnpm typecheck`
Expected: no diagnostics.

```bash
git add src/http/node-content-encoder.ts src/http/create-http-app.ts src/local/create-local-runtime.ts src/external-storage/create-external-storage-runtime.ts tests/http/content-delivery-compression.test.ts tests/http/node-response-compression.test.ts
git commit -m "Stream-compress eligible version content at the Node origin

Full GET and HEAD responses for compressible entries of at least 1 KiB are
encoded br or gzip through a streaming zlib transform when the client accepts
it. Range requests, refusals, and binary types stay identity with ranges.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Identity fallbacks, disconnects, and bounded memory (CNT-010-F)

**Files:**
- Test: `tests/http/content-delivery-compression.test.ts`
- Modify: `src/http/create-http-app.ts` or `src/http/node-content-encoder.ts` only if a test exposes a defect

**Interfaces:**
- Consumes: the `blobReadObserver` from Task 6 and the behavior from Task 7.

- [ ] **Step 1: Add the CNT-010-F test**

Add these fixtures at the top of the file, after `scriptDigest`:

```ts
const binaryBytes = new Uint8Array(4096).map((_, index) => index % 251);
const thresholdBytes = encoder.encode("x".repeat(1024));
const belowThresholdBytes = encoder.encode("x".repeat(1023));
```

Add the test inside the `describe`:

```ts
  test("CNT-010-F: ranges, refusals, small and binary entries stay identity with ranges intact", async () => {
    const published = await publishSite("account_required", "cnt-010-f", [
      {bytes: binaryBytes, mediaType: "application/octet-stream", path: "assets/blob.bin"},
      {bytes: thresholdBytes, mediaType: "text/javascript", path: "assets/threshold.js"},
      {bytes: belowThresholdBytes, mediaType: "text/javascript", path: "assets/below.js"},
    ]);
    const lease = await issuePreviewLease(published);
    const at = (entryPath: string) => new URL(entryPath, lease).toString();
    const size = scriptBytes.byteLength;

    const partial = await fetchVersion(server, at(scriptPath), "GET", {"Accept-Encoding": "gzip", Range: "bytes=0-9"});
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-encoding")).toBeNull();
    expect(partial.headers.get("content-range")).toBe(`bytes 0-9/${size}`);
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(scriptBytes.slice(0, 10));

    const weakIfRange = await fetchVersion(server, at(scriptPath), "GET", {
      "Accept-Encoding": "gzip",
      "If-Range": `W/"${scriptDigest}"`,
      Range: "bytes=0-9",
    });
    expect(weakIfRange.status).toBe(200);
    expect(weakIfRange.headers.get("content-encoding")).toBeNull();
    expect(weakIfRange.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await weakIfRange.arrayBuffer())).toEqual(scriptBytes);

    const unsatisfiable = await fetchVersion(server, at(scriptPath), "GET", {"Accept-Encoding": "gzip", Range: `bytes=${size + 10}-`});
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe(`bytes */${size}`);

    for (const refusal of ["identity", "br;q=0, gzip;q=0", "br;q=0.0, gzip;q=0.000", "*"]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is asserted on its own
      const refused = await fetchVersion(server, at(scriptPath), "GET", {"Accept-Encoding": refusal});
      expect(refused.headers.get("content-encoding"), refusal).toBeNull();
      expect(refused.headers.get("accept-ranges"), refusal).toBe("bytes");
    }

    const spelled = await fetchVersion(server, at(scriptPath), "GET", {"Accept-Encoding": " GZIP "});
    expect(spelled.headers.get("content-encoding")).toBe("gzip");

    const binary = await fetchVersion(server, at("assets/blob.bin"), "GET", {"Accept-Encoding": "gzip"});
    expect(binary.headers.get("content-encoding")).toBeNull();
    expect(binary.headers.get("accept-ranges")).toBe("bytes");
    expect(binary.headers.get("vary")).toBeNull();
    expect(new Uint8Array(await binary.arrayBuffer())).toEqual(binaryBytes);

    const threshold = await fetchVersion(server, at("assets/threshold.js"), "GET", {"Accept-Encoding": "gzip"});
    expect(threshold.headers.get("content-encoding")).toBe("gzip");
    const below = await fetchVersion(server, at("assets/below.js"), "GET", {"Accept-Encoding": "gzip"});
    expect(below.headers.get("content-encoding")).toBeNull();
    expect(below.headers.get("accept-ranges")).toBe("bytes");

    // A cache holding the identity copy revalidates with a strong tag while accepting gzip.
    const identityRevalidation = await fetchVersion(server, at(scriptPath), "GET", {
      "Accept-Encoding": "gzip",
      "If-None-Match": `"${scriptDigest}"`,
    });
    expect(identityRevalidation.status).toBe(304);
    expect(identityRevalidation.headers.get("content-encoding")).toBeNull();
  }, 60_000);
```

- [ ] **Step 2: Run it**

Run: `pnpm vitest run tests/http/content-delivery-compression.test.ts -t "CNT-010-F"`
Expected: PASS. If an assertion fails, the code is wrong; fix `selectContentCoding` or the 304 branch, not the assertion. The likeliest failure is the `*` refusal. `*` is not `br`/`gzip`, so `negotiateContentCoding` ignores it and returns null, which is correct.

- [ ] **Step 3: Add the disconnect and memory tests**

Add a large-entry fixture and a streaming helper at the top of the file:

```ts
import {randomBytes} from "node:crypto";

const largeEntryPath = "assets/large.js";
/** Base64 text: still text/javascript, but close to incompressible, so socket buffers hold few source bytes. */
const largeBytes = encoder.encode(`const payload = "${randomBytes(48 * 1_048_576).toString("base64")}";\n`);
const disconnectReadBound = 8 * 1_048_576;
const concurrentReadMemoryBound = 256 * 1_048_576;

interface StreamOutcome {
  readonly bytes: number;
  readonly coding: string | null;
}

/** Streams one response, counting bytes without keeping them; optionally abandons it after the first chunk. */
function streamVersion(
  server: RunningTestServer,
  url: string,
  acceptEncoding: string,
  abandonAfterFirstChunk: boolean,
): Promise<StreamOutcome> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const outgoing = request({
      headers: ["Host", `${target.hostname}:${server.port}`, "Accept-Encoding", acceptEncoding],
      hostname: "127.0.0.1",
      method: "GET",
      path: `${target.pathname}${target.search}`,
      port: server.port,
    }, (incoming) => {
      const coding = incoming.headers["content-encoding"] ?? null;
      let bytes = 0;
      incoming.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (abandonAfterFirstChunk) {
          outgoing.destroy();
          resolve({bytes, coding});
        }
      });
      incoming.on("end", () => resolve({bytes, coding}));
      incoming.on("error", (error) => {
        if (!abandonAfterFirstChunk) reject(error);
      });
    });
    outgoing.on("error", (error) => {
      if (!abandonAfterFirstChunk) reject(error);
    });
    outgoing.end();
  });
}

/** Resolves once `read` stops changing for `quietMilliseconds`, or rejects after `limitMilliseconds`. */
function settled(read: () => number, quietMilliseconds: number, limitMilliseconds: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let last = read();
    let stableSince = performance.now();
    const started = stableSince;
    const timer = setInterval(() => {
      const now = performance.now();
      const current = read();
      if (current !== last) {
        last = current;
        stableSince = now;
      } else if (now - stableSince >= quietMilliseconds) {
        clearInterval(timer);
        resolve(current);
      }
      if (now - started > limitMilliseconds) {
        clearInterval(timer);
        reject(new Error("The storage read never settled."));
      }
    }, 25);
  });
}

function trackedMemory(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.external + usage.arrayBuffers;
}
```

Merge the `randomBytes` import into the existing `node:crypto` import line. If `anti-slop/no-object-parameters` objects to the `request({...})` options literal, it won't: that is a call argument, not a parameter declaration.

Add the two tests inside the `describe`:

```ts
  test("foundation: a client that disconnects after the first encoded chunk stops the storage read", async () => {
    const published = await publishSite("account_required", "disconnect", [
      {bytes: largeBytes, mediaType: "text/javascript", path: largeEntryPath},
    ]);
    const url = new URL(largeEntryPath, await issuePreviewLease(published)).toString();
    blobBytesRead = 0;
    const outcome = await streamVersion(server, url, "gzip", true);
    expect(outcome.coding).toBe("gzip");
    const read = await settled(() => blobBytesRead, 300, 10_000);
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(disconnectReadBound);

    const healthy = await fetchVersion(server, new URL(scriptPath, url).toString());
    expect(healthy.status).toBe(200);
  }, 120_000);

  test("foundation: twenty concurrent encoded reads of a 64 MiB entry stay within the memory bound", async () => {
    const published = await publishSite("account_required", "concurrent-memory", [
      {bytes: largeBytes, mediaType: "text/javascript", path: largeEntryPath},
    ]);
    const url = new URL(largeEntryPath, await issuePreviewLease(published)).toString();
    const baseline = trackedMemory();
    let peak = baseline;
    const sampler = setInterval(() => {
      peak = Math.max(peak, trackedMemory());
    }, 25);
    try {
      const outcomes = await Promise.all(Array.from({length: 20}, () => streamVersion(server, url, "gzip", false)));
      for (const outcome of outcomes) {
        expect(outcome.coding).toBe("gzip");
        expect(outcome.bytes).toBeGreaterThan(0);
      }
    } finally {
      clearInterval(sampler);
    }
    expect(peak - baseline).toBeLessThan(concurrentReadMemoryBound);
  }, 180_000);
```

Note the baseline already includes `largeBytes` (about 64 MiB) held by the test module. The bound measures growth from there.

- [ ] **Step 4: Run them**

Run: `pnpm vitest run tests/http/content-delivery-compression.test.ts`
Expected: PASS (4 tests).

If the disconnect test reads the whole entry, cancellation isn't propagating. Use superpowers:systematic-debugging. Confirm whether `@hono/node-server` cancels the response stream on client close, whether `pipeThrough` cancels the source, and whether `Duplex.toWeb`'s readable cancel destroys the compressor. Fix it in `node-content-encoder.ts`, for example by wrapping the readable so `cancel` calls `compressor.destroy()` and cancels `body`, rather than loosening the bound.

If the memory test exceeds the bound, find what is buffering before anything else. The outer wrapper must not buffer: encoded responses carry `Content-Encoding`.

- [ ] **Step 5: Lint and commit**

Run: `pnpm exec oxlint --type-aware --type-check --deny-warnings tests/http/content-delivery-compression.test.ts src/http`
Expected: no diagnostics.

```bash
git add tests/http/content-delivery-compression.test.ts src/http
git commit -m "Prove identity fallbacks, disconnect cancellation, and bounded memory

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Ledger, product sentence, local after evidence, full gate

**Files:**
- Modify: `project/spec/artifact-server-product-spec.html` (about line 2740)
- Modify: `project/spec/conformance.yml` (after CNT-009, about line 1370)
- Create: `project/evidence/delivery-baseline-<date>-local-after.json` (generated)
- Modify: `project/evidence/local-foundation.json`, `project/evidence/local-performance-baseline.json` (regenerated by the gates)

- [ ] **Step 1: Product sentence**

In `project/spec/artifact-server-product-spec.html`, change:

```html
                  download disposition. Media supports byte ranges.
```

to:

```html
                  download disposition. Media supports byte ranges. Eligible text responses are
                  compressed when the browser accepts it; byte-range requests always receive the
                  uncompressed bytes.
```

- [ ] **Step 2: Add CNT-010 to the ledger**

Insert after the CNT-009 entry in `project/spec/conformance.yml`, matching its indentation:

```yaml
  - id: CNT-010
    kind: behavior
    behavior: Eligible full content responses are compressed when the client accepts it, without buffering the artifact, while range requests and refusals stay on the identity representation.
    owner: content-delivery
    source: {file: artifact-server-product-spec.html, anchor: architecture}
    acceptance:
      behavior: {id: CNT-010-B, description: "Serve an eligible full GET as br or gzip that decodes to the exact stored bytes, with consistent HEAD, 304, Vary, and weak validator behavior."}
      failure: {id: CNT-010-F, description: "Range, If-Range, identity or q=0 refusals, and non-compressible types are served identity with ranges intact; a disconnect stops the storage read; concurrent large reads stay within the memory bound."}
    deployments: *all
    status: implementing
    proof_gap: Cloudflare relies on edge compression and needs its own live qualification, which this work does not authorize. Team-deployment conformance runs are unrecorded.
    depends_on: [CNT-008]
    evidence: []
```

Run: `pnpm conformance:validate && pnpm conformance:tests`
Expected: both pass. CNT-010-B and CNT-010-F each map to one test.

- [ ] **Step 3: `perf:baseline` after, compared**

Run: `pnpm perf:baseline`
Compare its printed read p95 and ops/s with `~/.local/state/artifact-server/delivery/perf-baseline-before.json` from Task 4. This baseline reads payloads without `Accept-Encoding`, so a regression above about 10% points to added overhead in the identity path. If that happens, investigate before going further.

- [ ] **Step 4: `pnpm smoke`**

Run: `pnpm smoke`
Expected: PASS.

- [ ] **Step 5: Local after delivery run**

Run: `pnpm build && pnpm perf:delivery --label after`
Expected: the prototype rows show "Lease encoding" `br`, and prototype cold "Transferred" is well below its before value. Note the prototype `localProcessCpuMilliseconds` medians, before and after, from the two reports' `aggregate` fields.

- [ ] **Step 6: Full gate**

Run: `pnpm verify:iteration`
Expected: PASS. This regenerates `project/evidence/local-foundation.json`. It needs Docker for the object-storage, external-storage, compose, Helm, and OIDC stages. If any stage fails, stop and report the failing command and its output to the user. Don't mark anything verified.

- [ ] **Step 7: Record local evidence**

When `project/evidence/local-foundation.json` shows CNT-010-B and CNT-010-F passing, set CNT-010 to `behavior_verified` and add:

```yaml
    status: behavior_verified
    proof_gap: Local conformance tests prove streaming compression and identity fallbacks. Cloudflare relies on edge compression and needs its own live qualification, which this work does not authorize. Team-deployment conformance runs are unrecorded; the hosted delivery observation is recorded in project/performance/FINDINGS.md.
    evidence:
      - deployment: local
        tests: [CNT-010-B, CNT-010-F]
        result: pass
        run: project/evidence/local-foundation.json
        recorded_at: "<the report's run time, ISO 8601 UTC>"
```

Run: `pnpm conformance:validate`
Expected: PASS.

- [ ] **Step 8: Privacy check and commit**

Run the Task 4 Step 5 grep over `project/evidence/delivery-baseline-*.json`.
Expected: `clean`.

```bash
git add project/spec project/evidence
git commit -m "Specify and verify CNT-010 streaming content compression locally

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Deploy gate, hosted after evidence, FINDINGS

**Files:**
- Modify: `project/performance/FINDINGS.md`
- Create: `project/evidence/delivery-baseline-<date>-hosted-after.json` (generated)
- External (only after approval): GitHub `main`, the `image.yml` workflow, `~/Workspace` pins

- [ ] **Step 1: STOP for deploy approval**

Report to the user: the local before/after table (from `formatJourneyTable` output), the `verify:iteration` result, and the exact deploy steps below. Ask:

> "Local evidence is in. May I merge `delivery-compression` to `main`, push, build the image, and update the Workspace GitOps pins to deploy to artifacts.backend.app?"

Do nothing outward-facing until the user says yes.

- [ ] **Step 2: Deploy (after approval)**

Follow the memory note `deploy-artifacts-backend-app` exactly:
1. `git checkout main && git merge --ff-only delivery-compression && git push origin main`
2. `gh workflow run image.yml --ref main`. Wait for the run, then read the digest only from the "Print digest" step: `gh run view <id> --log | grep "Print digest" | grep -o 'digest=sha256:[0-9a-f]*'`.
3. In `~/Workspace` (branch `master`), update `deployments/argocd/application-artifact-server.yaml` (`targetRevision` = full `main` SHA, `image.digest`) and `deployments/clusters/vps/artifact-server/helm-values.yaml` (`digest`). Commit `Deploy streaming content compression` and push.
4. Verify with `KUBECONFIG=~/.kube/backend-app.yaml` that all four `app.kubernetes.io/component=server` pods run the new digest (compare counts numerically), and that `/review` serves the `review-*.js` filename that `pnpm build` wrote to `dist/web/assets/`.

If the rollout fails, revert the Workspace pin commit, push, and tell the user.

- [ ] **Step 3: Hosted after run**

Run:
```bash
pnpm perf:delivery --target https://artifacts.backend.app --content-domain frontend.app \
  --prototype-url '<the same Review URL as Task 4>' --label after --deployment-revision '<digest>'
```
Expected: prototype "Lease encoding" is `br`. If it is `identity` or shows two codings, Traefik or another proxy is altering content responses. Record that as a finding; do not patch it here.

- [ ] **Step 4: Write the FINDINGS section**

Append to `project/performance/FINDINGS.md`:

```markdown
## October 2026 browser delivery and streaming compression (CNT-010)

Measured with `pnpm perf:delivery` (Chromium <version>, unthrottled, <samples> samples per journey) on <machine> and against artifacts.backend.app (web build `<review-*.js>`, image `<digest>`). Raw HAR files stayed in private storage; the committed reports contain only route classes, path templates, allowlisted headers, and numbers.

### Local (synthetic ExtractionKit-shaped fixture; compression ratio not representative)

Before:

<paste formatJourneyTable output from delivery-baseline-<date>-local-before.json>

After:

<paste formatJourneyTable output from delivery-baseline-<date>-local-after.json>

Per-open harness CPU for the prototype cold journey: <before median> ms before, <after median> ms after. The difference approximates per-open Brotli 4 cost for about 16 MB of text and decides whether precompressed variants are worth their storage lifecycle.

### Hosted (artifacts.backend.app, real ExtractionKit)

Before:

<paste table>

After:

<paste table>

### What this shows and what it does not

- <State the measured transfer and ready-time change plainly, including if it is small or none.>
- <State whether content responses arrived encoded end to end through Traefik.>
- <Name the remaining cost: per-open leases and `no-store` still force a full transfer on every open; that is the separate cache/lease contract decision in PLAN.md step 0.>
```

Fill every placeholder from the actual reports. Write no claim that the numbers don't support.

To print a table from a saved report, run:
```bash
node --import tsx -e 'import {readFileSync} from "node:fs"; import {formatJourneyTable} from "./project/performance/delivery/delivery-report.ts"; console.log(formatJourneyTable(JSON.parse(readFileSync(process.argv[1], "utf8"))))' project/evidence/<report>.json
```

- [ ] **Step 5: Privacy check, commit, push**

Run the Task 4 Step 5 grep over all `delivery-baseline-*.json`.
Expected: `clean`.

```bash
git add project/performance/FINDINGS.md project/evidence/delivery-baseline-*-hosted-after.json
git commit -m "Record hosted delivery evidence after streaming compression

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin main
```

The push to `main` is covered by the Step 1 approval because it ships evidence for the same deploy. If the user approved only the deploy, ask before pushing.

- [ ] **Step 6: Report**

Tell the user:
- The hosted before/after headline.
- Whether Traefik passes encoding through.
- The CNT-010 status: `behavior_verified` locally, with Cloudflare and team-deployment conformance runs still unproved.
- That the cache/lease decision and the preview catalog remain open.
