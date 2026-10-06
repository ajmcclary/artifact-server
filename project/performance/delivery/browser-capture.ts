import {errors, type BrowserContext, type Page, type Request} from "@playwright/test";

import type {CapturedExchange, JourneyName, SampleObservation} from "./delivery-report.js";

const readyTimeoutMilliseconds = 120_000;
const contentQuietMilliseconds = 500;
const quietPollMilliseconds = 50;
/** Review shows a prototype either interactively or inside the annotation frame. */
const previewFrames = 'iframe[title^="Interactive preview: "], iframe[src="/review-frame"]';

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
      // Playwright reports -1 for a body served from the browser cache: nothing crossed the network.
      transferBytes: Math.max(0, sizes.responseBodySize),
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
  #startedSinceReset = 0;
  readonly #isContent: (url: URL) => boolean;

  constructor(context: BrowserContext, isContent: (url: URL) => boolean) {
    this.#isContent = isContent;
    context.on("request", (request) => this.#adjust(request, 1));
    context.on("requestfinished", (request) => this.#adjust(request, -1));
    context.on("requestfailed", (request) => this.#adjust(request, -1));
  }

  /** Starts a new sample: readiness needs at least one content request of its own. */
  reset(): void {
    this.#startedSinceReset = 0;
  }

  #adjust(request: Request, change: number): void {
    if (!URL.canParse(request.url()) || !this.#isContent(new URL(request.url()))) return;
    if (change > 0) this.#startedSinceReset += 1;
    this.#inFlight = Math.max(0, this.#inFlight + change);
    this.#lastActivity = performance.now();
  }

  waitForQuiet(deadline: number): Promise<boolean> {
    return new Promise((resolve) => {
      const check = () => {
        const now = performance.now();
        const quiet = this.#startedSinceReset > 0
          && this.#inFlight === 0
          && now - this.#lastActivity >= contentQuietMilliseconds;
        if (quiet || now >= deadline) resolve(quiet);
        else setTimeout(check, quietPollMilliseconds);
      };
      check();
    });
  }
}

export interface SampleRequest {
  /** Measures host contention just before the sample, outside the browser's capture. */
  readonly hostProbe: () => Promise<number | null>;
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
    await page.waitForSelector(previewFrames, {state: "attached", timeout: remaining(deadline)});
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
  const hostDatabaseMilliseconds = await request.hostProbe();
  await recorder.drain();
  monitor.reset();
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
    hostDatabaseMilliseconds,
    index: request.index,
    localProcessCpuMilliseconds: request.measureLocalCpu ? (cpu.user + cpu.system) / 1_000 : null,
    readyMilliseconds,
  };
}
