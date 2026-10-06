import {spawn} from "node:child_process";
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
  reserveLoopbackPort,
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
import {probeHostDatabaseLatency} from "./delivery/host-probe.js";
import {writeSyntheticPrototype} from "./delivery/synthetic-prototype.js";
import {captureMeasurementContext} from "./measurement-context.js";

const viewport = {height: 1000, width: 1680} as const;
const signInTimeoutMilliseconds = 300_000;
const sessionCheckTimeoutMilliseconds = 15_000;
const signInPollMilliseconds = 2_000;
const chromeExecutable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

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
  // Production builds variants in the background; the harness measures that behavior.
  const server = await startTestServer(installation, {contentVariantBuilds: "background"});
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
    // Sample after the publish-queued builds finish, as a reviewer opening later would.
    await server.drainContentVariants();
    const application = new URL(server.baseUrl);
    const prototypeUrl = new URL("/review", application);
    prototypeUrl.searchParams.set("project", "prj_default");
    prototypeUrl.searchParams.set("artifact", published.artifact.id);
    prototypeUrl.searchParams.set("path", "prototype.html");
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

/** Retries until a just-launched Chrome accepts a DevTools connection. */
async function connectToChrome(port: number, deadline: number): Promise<Browser> {
  try {
    return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  } catch (error) {
    if (performance.now() >= deadline) throw error;
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
    return connectToChrome(port, deadline);
  }
}

/** Polls the application's session endpoint until the person in the window has signed in. */
async function waitForSignedIn(context: BrowserContext, application: URL, deadline: number): Promise<void> {
  const response = await context.request.get(new URL("/api/v1/session", application).toString());
  if (response.ok()) return;
  if (performance.now() >= deadline) throw new Error("Sign-in did not complete within 5 minutes.");
  await new Promise((resolve) => {
    setTimeout(resolve, signInPollMilliseconds);
  });
  await waitForSignedIn(context, application, deadline);
}

function belongsTo(application: URL, cookieDomain: string): boolean {
  const domain = cookieDomain.replace(/^\./u, "");
  return application.hostname === domain || application.hostname.endsWith(`.${domain}`);
}

/**
 * Sign-in pages refuse automated browsers, so the person signs in through an
 * ordinary Chrome window on a private profile. Only after the session exists
 * does the harness read that profile's application cookies over DevTools.
 */
async function ensureHostedSession(browser: Browser, application: URL, statePath: string): Promise<void> {
  if (await sessionStillValid(browser, application, statePath)) return;
  const profile = path.join(path.dirname(statePath), "chrome-sign-in-profile");
  await mkdir(profile, {mode: 0o700, recursive: true});
  const port = await reserveLoopbackPort();
  const chrome = spawn(chromeExecutable, [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    new URL("/review", application).toString(),
  ], {stdio: "ignore"});
  try {
    process.stdout.write("Sign in to the hosted server in the Chrome window that opened. Waiting up to 5 minutes.\n");
    const deadline = performance.now() + signInTimeoutMilliseconds;
    const connected = await connectToChrome(port, performance.now() + 15_000);
    try {
      const [context] = connected.contexts();
      if (context === undefined) throw new Error("Chrome exposed no browser context.");
      await waitForSignedIn(context, application, deadline);
      const state = await context.storageState();
      await writePrivateFile(statePath, JSON.stringify({
        cookies: state.cookies.filter((cookie) => belongsTo(application, cookie.domain)),
        origins: state.origins.filter((origin) => origin.origin === application.origin),
      }));
    } finally {
      await connected.close();
    }
  } finally {
    chrome.kill();
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
      const hostProbe = () => probeHostDatabaseLatency(target.origins.applicationOrigin);
      // eslint-disable-next-line no-await-in-loop -- the cold open must finish before the warm one
      const coldObservation = await measureSample(page, recorder, monitor, {hostProbe, index, journey, measureLocalCpu, navigation: "goto", url});
      // eslint-disable-next-line no-await-in-loop -- the warm open reuses the cold open's cache
      const warmObservation = await measureSample(page, recorder, monitor, {
        hostProbe,
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
