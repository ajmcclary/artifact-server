import {createHash} from "node:crypto";
import {
  access,
  constants,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {z} from "zod";

import {captureMeasurementContext} from "../project/performance/measurement-context.ts";

const defaultReportPath = "test-results/browser/playwright-report.json";
const defaultEvidencePath = "project/evidence/browser.json";
const defaultConfigPath = "playwright.config.ts";

const resultSchema = z.object({
  duration: z.number().nonnegative(),
  errors: z.array(z.object({message: z.string().optional()}).loose()),
  status: z.string(),
}).loose();

const testSchema = z.object({
  results: z.array(resultSchema),
  status: z.string(),
}).loose();

const specSchema = z.object({
  file: z.string(),
  ok: z.boolean(),
  tests: z.array(testSchema),
  title: z.string(),
}).loose();

interface PlaywrightSuite {
  readonly file: string;
  readonly specs: readonly z.infer<typeof specSchema>[];
  readonly suites: readonly PlaywrightSuite[];
  readonly title: string;
}

const suiteSchema: z.ZodType<PlaywrightSuite> = z.lazy(() => z.object({
  file: z.string(),
  specs: z.array(specSchema).default([]),
  suites: z.array(suiteSchema).default([]),
  title: z.string(),
}).loose());

const configSchema = z.object({
  projects: z.array(z.object({name: z.string()}).loose()).default([]),
  version: z.string(),
}).loose();

const statsSchema = z.object({
  duration: z.number().nonnegative(),
  expected: z.number().int().nonnegative(),
  flaky: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  startTime: z.iso.datetime(),
  unexpected: z.number().int().nonnegative(),
}).loose();

const reportSchema = z.object({
  config: configSchema,
  errors: z.array(z.unknown()),
  stats: statsSchema,
  suites: z.array(suiteSchema),
}).loose();

type Report = z.infer<typeof reportSchema>;

interface EvidenceAssertion {
  readonly ancestorTitles: readonly string[];
  readonly attempts: number;
  readonly duration: number;
  readonly failureMessages: readonly string[];
  readonly fullName: string;
  readonly status: "failed" | "passed" | "pending";
  readonly title: string;
}

interface EvidenceTestResult {
  readonly assertionResults: readonly EvidenceAssertion[];
  readonly endTime: number;
  readonly message: string;
  readonly name: string;
  readonly startTime: number;
  readonly status: "passed" | "failed";
}

interface EvidenceEnvironment {
  readonly arch: string;
  readonly availableParallelism: number;
  readonly capturedAt: string;
  readonly commit: string;
  readonly configDigest: string;
  readonly cpu: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>> | null;
  readonly engine: string;
  readonly lockfileDigest: string;
  readonly node: string;
  readonly operatingSystem: string;
  readonly platform: string;
  readonly temporaryFilesystem: string;
  readonly workingTreeDirty: boolean;
}

interface BrowserEvidence {
  readonly configDigest: string;
  readonly engine: string;
  readonly environment: EvidenceEnvironment;
  readonly evidenceError: string | null;
  readonly numFailedTestSuites: number;
  readonly numFailedTests: number;
  readonly numFlakyTests: number;
  readonly numPassedTestSuites: number;
  readonly numPassedTests: number;
  readonly numPendingTestSuites: number;
  readonly numPendingTests: number;
  readonly numTodoTests: number;
  readonly numTotalTestSuites: number;
  readonly numTotalTests: number;
  readonly startTime: number;
  readonly success: boolean;
  readonly testResults: readonly EvidenceTestResult[];
}

interface FinalizerInputs {
  readonly configPath: string;
  readonly evidencePath: string;
  readonly playwrightExitCode: number;
  readonly reportPath: string;
}

function readInputs(): FinalizerInputs {
  const rawExitCode = process.env["PLAYWRIGHT_EXIT_CODE"] ?? "0";
  const parsedExitCode = z.coerce.number().int().safeParse(rawExitCode);
  const playwrightExitCode = parsedExitCode.success ? parsedExitCode.data : 0;

  return {
    configPath: process.env["PLAYWRIGHT_CONFIG_PATH"] ?? defaultConfigPath,
    evidencePath: process.env["BROWSER_EVIDENCE_PATH"] ?? defaultEvidencePath,
    playwrightExitCode,
    reportPath: process.env["BROWSER_REPORT_PATH"] ?? defaultReportPath,
  };
}

async function readConfigDigest(configPath: string): Promise<string> {
  try {
    const content = await readFile(configPath, "utf8");
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return "unavailable";
  }
}

function readEngine(report: Report | null): string {
  if (report === null) return "unknown";
  const projectNames = report.config.projects
    .map((project) => project.name)
    .filter((name) => name.length > 0);
  const uniqueNames = [...new Set(projectNames.length > 0 ? projectNames : ["chromium"])];
  return `${uniqueNames.join("+")}@${report.config.version}`;
}

async function rotateExistingEvidence(evidencePath: string): Promise<void> {
  try {
    await access(evidencePath, constants.F_OK);
  } catch {
    return;
  }

  const previousPath = path.join(path.dirname(evidencePath), "browser.previous.json");
  await rename(evidencePath, previousPath);
}

function collectAssertions(
  suite: PlaywrightSuite,
  ancestors: readonly string[],
  byFile: Map<string, EvidenceAssertion[]>,
): void {
  const nextAncestors = suite.title === suite.file
    ? ancestors
    : [...ancestors, suite.title];

  for (const spec of suite.specs) {
    const results = spec.tests.flatMap((test) => test.results);
    const attempts = results.length;
    const passed = spec.ok && spec.tests.every((test) => test.status === "expected");
    const pending = spec.tests.every((test) => test.status === "skipped");
    const assertions = byFile.get(spec.file) ?? [];
    assertions.push({
      ancestorTitles: nextAncestors,
      attempts,
      duration: results.reduce((total, result) => total + result.duration, 0),
      failureMessages: results.flatMap((result) =>
        result.errors.flatMap((error) => error.message ?? [])
      ),
      fullName: [...nextAncestors, spec.title].join(" "),
      status: pending ? "pending" : passed ? "passed" : "failed",
      title: spec.title,
    });
    byFile.set(spec.file, assertions);
  }

  for (const child of suite.suites) {
    collectAssertions(child, nextAncestors, byFile);
  }
}

function buildEvidenceFromReport(
  report: Report,
  environment: EvidenceEnvironment,
): BrowserEvidence {
  const assertionsByFile = new Map<string, EvidenceAssertion[]>();
  for (const suite of report.suites) {
    collectAssertions(suite, [], assertionsByFile);
  }

  const testResults: EvidenceTestResult[] = [...assertionsByFile].map(([file, assertionResults]) => ({
    assertionResults,
    endTime: Date.parse(report.stats.startTime) + report.stats.duration,
    message: "",
    name: path.resolve("tests/browser", file),
    startTime: Date.parse(report.stats.startTime),
    status: assertionResults.every((assertion) => assertion.status === "passed")
      ? "passed"
      : "failed",
  }));

  const passedSuites = testResults.filter((result) => result.status === "passed").length;
  const reportSuccess = report.errors.length === 0 && report.stats.unexpected === 0;

  return {
    configDigest: environment.configDigest,
    engine: environment.engine,
    environment,
    evidenceError: null,
    numFailedTestSuites: testResults.length - passedSuites,
    numFailedTests: report.stats.unexpected,
    numFlakyTests: report.stats.flaky,
    numPassedTestSuites: passedSuites,
    numPassedTests: report.stats.expected,
    numPendingTestSuites: 0,
    numPendingTests: report.stats.skipped,
    numTodoTests: 0,
    numTotalTestSuites: testResults.length,
    numTotalTests: report.stats.expected + report.stats.unexpected + report.stats.skipped,
    startTime: Date.parse(report.stats.startTime),
    success: reportSuccess,
    testResults,
  };
}

function buildFailingEvidence(
  environment: EvidenceEnvironment,
  evidenceError: string,
): BrowserEvidence {
  const now = Date.now();
  return {
    configDigest: environment.configDigest,
    engine: environment.engine,
    environment,
    evidenceError,
    numFailedTestSuites: 0,
    numFailedTests: 0,
    numFlakyTests: 0,
    numPassedTestSuites: 0,
    numPassedTests: 0,
    numPendingTestSuites: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTestSuites: 0,
    numTotalTests: 0,
    startTime: now,
    success: false,
    testResults: [],
  };
}

async function parseReport(reportPath: string): Promise<{readonly report: Report; readonly error: null} | {readonly report: null; readonly error: string}> {
  let content: string;
  try {
    content = await readFile(reportPath, "utf8");
  } catch {
    return {report: null, error: `Browser report not found at ${reportPath}`};
  }

  if (content.trim().length === 0) {
    return {report: null, error: `Browser report at ${reportPath} is empty`};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {report: null, error: `Browser report at ${reportPath} is truncated or invalid JSON`};
  }

  const result = reportSchema.safeParse(parsed);
  if (!result.success) {
    return {
      report: null,
      error: `Browser report at ${reportPath} failed validation: ${result.error.message}`,
    };
  }

  return {report: result.data, error: null};
}

async function finalizeEvidence(inputs: FinalizerInputs): Promise<boolean> {
  const [measurementContext, configDigest] = await Promise.all([
    captureMeasurementContext(),
    readConfigDigest(inputs.configPath),
  ]);

  const parsed = await parseReport(inputs.reportPath);
  const engine = readEngine(parsed.report);

  const environment: EvidenceEnvironment = {
    ...measurementContext,
    configDigest,
    engine,
  };

  const evidence = parsed.report !== null
    ? buildEvidenceFromReport(parsed.report, environment)
    : buildFailingEvidence(environment, parsed.error);

  const effectiveSuccess = evidence.success && inputs.playwrightExitCode === 0;
  const finalEvidence: BrowserEvidence = {
    ...evidence,
    evidenceError:
      parsed.report !== null && inputs.playwrightExitCode !== 0
        ? `Playwright exited with code ${inputs.playwrightExitCode}`
        : evidence.evidenceError,
    success: effectiveSuccess,
  };

  await rotateExistingEvidence(inputs.evidencePath);
  await writeFile(inputs.evidencePath, `${JSON.stringify(finalEvidence)}\n`, "utf8");

  return effectiveSuccess;
}

async function main(): Promise<void> {
  const inputs = readInputs();
  const success = await finalizeEvidence(inputs);
  process.exit(success ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`Browser evidence finalization failed: ${String(error)}\n`);
  process.exit(1);
});
