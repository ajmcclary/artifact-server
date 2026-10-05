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
