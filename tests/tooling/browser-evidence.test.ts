import {createHash, randomUUID} from "node:crypto";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterAll, beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const finalizerScript = path.join(repositoryRoot, "scripts", "write-browser-evidence.ts");

const assertionSchema = z.object({
  ancestorTitles: z.array(z.string()),
  attempts: z.number().int().nonnegative(),
  duration: z.number().nonnegative(),
  failureMessages: z.array(z.string()),
  fullName: z.string(),
  status: z.enum(["failed", "passed", "pending"]),
  title: z.string(),
});

const evidenceSchema = z.object({
  configDigest: z.string(),
  engine: z.string(),
  environment: z.object({
    arch: z.string(),
    availableParallelism: z.number().int(),
    capturedAt: z.string(),
    commit: z.string(),
    configDigest: z.string(),
    cpu: z.string(),
    details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).nullable(),
    engine: z.string(),
    lockfileDigest: z.string(),
    node: z.string(),
    operatingSystem: z.string(),
    platform: z.string(),
    temporaryFilesystem: z.string(),
    workingTreeDirty: z.boolean(),
  }),
  evidenceError: z.string().nullable(),
  numFailedTestSuites: z.number().int().nonnegative(),
  numFailedTests: z.number().int().nonnegative(),
  numFlakyTests: z.number().int().nonnegative(),
  numPassedTestSuites: z.number().int().nonnegative(),
  numPassedTests: z.number().int().nonnegative(),
  numPendingTestSuites: z.number().int().nonnegative(),
  numPendingTests: z.number().int().nonnegative(),
  numTodoTests: z.number().int().nonnegative(),
  numTotalTestSuites: z.number().int().nonnegative(),
  numTotalTests: z.number().int().nonnegative(),
  startTime: z.number(),
  success: z.boolean(),
  testResults: z.array(z.object({
    assertionResults: z.array(assertionSchema),
    endTime: z.number(),
    message: z.string(),
    name: z.string(),
    startTime: z.number(),
    status: z.enum(["passed", "failed"]),
  })),
});

type BrowserEvidence = z.infer<typeof evidenceSchema>;

interface FinalizerResult {
  readonly evidence: BrowserEvidence | null;
  readonly exitCode: number;
  readonly previous: RawEvidence | null;
}

interface RawEvidence {
  readonly success: boolean;
}

interface ReportFixtureOptions {
  readonly expected: number;
  readonly flaky: number;
  readonly ok: boolean;
  readonly skipped: number;
  readonly status: "expected" | "unexpected";
  readonly unexpected: number;
}

interface PlaywrightResultFixture {
  readonly duration: number;
  readonly errors: readonly {readonly message?: string}[];
  readonly status: string;
}

interface PlaywrightTestFixture {
  readonly results: readonly PlaywrightResultFixture[];
  readonly status: string;
}

interface PlaywrightSpecFixture {
  readonly file: string;
  readonly ok: boolean;
  readonly tests: readonly PlaywrightTestFixture[];
  readonly title: string;
}

interface PlaywrightSuiteFixture {
  readonly file: string;
  readonly specs: readonly PlaywrightSpecFixture[];
  readonly suites: readonly PlaywrightSuiteFixture[];
  readonly title: string;
}

interface PlaywrightReportFixture {
  readonly config: {
    readonly projects: readonly {readonly name: string}[];
    readonly version: string;
  };
  readonly errors: readonly unknown[];
  readonly stats: {
    readonly duration: number;
    readonly expected: number;
    readonly flaky: number;
    readonly skipped: number;
    readonly startTime: string;
    readonly unexpected: number;
  };
  readonly suites: readonly PlaywrightSuiteFixture[];
}

const playwrightVersion = "1.62.1";

function buildReport(options: ReportFixtureOptions): PlaywrightReportFixture {
  const resultStatus = options.ok ? "passed" : "failed";
  return {
    config: {
      projects: [{name: "chromium"}],
      version: playwrightVersion,
    },
    errors: [],
    stats: {
      duration: 100,
      expected: options.expected,
      flaky: options.flaky,
      skipped: options.skipped,
      startTime: "2026-09-21T12:00:00.000Z",
      unexpected: options.unexpected,
    },
    suites: [
      {
        file: "fixture.spec.ts",
        specs: [
          {
            file: "fixture.spec.ts",
            ok: options.ok,
            tests: [
              {
                results: [
                  {
                    duration: 10,
                    errors: options.ok ? [] : [{message: "assertion failed"}],
                    status: resultStatus,
                  },
                ],
                status: options.status,
              },
            ],
            title: "fixture test",
          },
        ],
        suites: [],
        title: "fixture.spec.ts",
      },
    ],
  };
}

async function configDigest(): Promise<string> {
  const configPath = path.join(repositoryRoot, "playwright.config.ts");
  const content = await readFile(configPath, "utf8");
  return createHash("sha256").update(content).digest("hex");
}

async function runFinalizer(
  directory: string,
  options: {
    readonly exitCode?: number;
    readonly report?: PlaywrightReportFixture;
  } = {},
): Promise<FinalizerResult> {
  const reportPath = path.join(directory, "playwright-report.json");
  const evidencePath = path.join(directory, "browser.json");

  if (options.report !== undefined) {
    await writeFile(reportPath, `${JSON.stringify(options.report)}\n`, "utf8");
  }

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", finalizerScript],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          BROWSER_EVIDENCE_PATH: evidencePath,
          BROWSER_REPORT_PATH: reportPath,
          PLAYWRIGHT_CONFIG_PATH: path.join(repositoryRoot, "playwright.config.ts"),
          PLAYWRIGHT_EXIT_CODE: String(options.exitCode ?? 0),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const output: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });

  const evidence = await readEvidence(evidencePath);
  const previous = await readRawEvidence(path.join(directory, "browser.previous.json"));
  return {evidence, exitCode, previous};
}

async function readEvidence(filePath: string): Promise<BrowserEvidence | null> {
  try {
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    return evidenceSchema.parse(parsed);
  } catch {
    return null;
  }
}

const rawEvidenceSchema = z.object({success: z.boolean()});

async function readRawEvidence(filePath: string): Promise<RawEvidence | null> {
  try {
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    return rawEvidenceSchema.parse(parsed);
  } catch {
    return null;
  }
}

describe("browser evidence finalizer", () => {
  let fixtureDirectory: string;

  beforeAll(async () => {
    fixtureDirectory = await mkdtemp(path.join(tmpdir(), "artifact-server-browser-evidence-"));
  });

  afterAll(async () => {
    await rm(fixtureDirectory, {force: true, recursive: true});
  });

  async function makeCaseDirectory(): Promise<string> {
    const directory = path.join(fixtureDirectory, randomUUID());
    await mkdir(directory, {recursive: true});
    return directory;
  }

  test("GATE-016-F: a missing or truncated report writes failing evidence and exits non-zero", async () => {
    const missingDirectory = await makeCaseDirectory();
    const missing = await runFinalizer(missingDirectory);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.evidence).not.toBeNull();
    expect(missing.evidence?.success).toBe(false);
    expect(missing.evidence?.evidenceError).toMatch(/not found/i);

    const truncatedDirectory = await makeCaseDirectory();
    await writeFile(
      path.join(truncatedDirectory, "playwright-report.json"),
      '{"config": {',
      "utf8",
    );
    const truncated = await runFinalizer(truncatedDirectory);
    expect(truncated.exitCode).not.toBe(0);
    expect(truncated.evidence?.success).toBe(false);
    expect(truncated.evidence?.evidenceError).toMatch(/truncated|invalid JSON/i);
  });

  test("GATE-016-B: a failing or interrupted run writes failing evidence, preserves the prior run, and exits non-zero", async () => {
    const failedDirectory = await makeCaseDirectory();
    const priorEvidence = {success: true, testResults: []};
    await writeFile(
      path.join(failedDirectory, "browser.json"),
      `${JSON.stringify(priorEvidence)}\n`,
      "utf8",
    );

    const failed = await runFinalizer(failedDirectory, {
      report: buildReport({expected: 0, ok: false, skipped: 0, status: "unexpected", unexpected: 1, flaky: 0}),
    });
    expect(failed.exitCode).not.toBe(0);
    expect(failed.evidence?.success).toBe(false);
    expect(failed.evidence?.numFailedTests).toBe(1);
    expect(failed.previous?.success).toBe(true);

    const injectedDirectory = await makeCaseDirectory();
    const injected = await runFinalizer(injectedDirectory, {
      exitCode: 1,
      report: buildReport({expected: 1, ok: true, skipped: 0, status: "expected", unexpected: 0, flaky: 0}),
    });
    expect(injected.exitCode).not.toBe(0);
    expect(injected.evidence?.success).toBe(false);
    expect(injected.evidence?.evidenceError).toMatch(/exited with code 1/i);

    const cleanDirectory = await makeCaseDirectory();
    const cleanPrior = {success: false, testResults: []};
    await writeFile(
      path.join(cleanDirectory, "browser.json"),
      `${JSON.stringify(cleanPrior)}\n`,
      "utf8",
    );

    const clean = await runFinalizer(cleanDirectory, {
      report: buildReport({expected: 1, ok: true, skipped: 0, status: "expected", unexpected: 0, flaky: 0}),
    });
    expect(clean.exitCode).toBe(0);
    expect(clean.evidence?.success).toBe(true);
    expect(clean.evidence?.engine).toBe(`chromium@${playwrightVersion}`);
    expect(clean.evidence?.configDigest).toBe(await configDigest());
    expect(clean.evidence?.environment.commit).toMatch(/^[0-9a-f]{40}|unavailable$/);
    expect(clean.evidence?.numFlakyTests).toBe(0);
    expect(clean.evidence?.testResults[0]?.assertionResults[0]?.attempts).toBe(1);
    expect(clean.previous?.success).toBe(false);
  });
});
