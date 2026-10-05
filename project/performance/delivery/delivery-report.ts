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
  return [...values].toSorted((left, right) => left.localeCompare(right));
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
    for (const token of headerTokens(headers["vary"], varyToken)) accumulator.vary.add(token);
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
        statuses: [...accumulator.statuses].toSorted((left, right) => left - right),
        transferBytes: accumulator.transferBytes,
        vary: sorted(accumulator.vary),
      }];
    }),
  };
}

export function statistics(values: readonly number[]): Statistics | null {
  if (values.length === 0) return null;
  const ordered = [...values].toSorted((left, right) => left - right);
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
    add(exchange.requestHeaders["authorization"] ?? "");
    for (const value of cookieValues(exchange.requestHeaders["cookie"])) add(value);
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
