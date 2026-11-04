import {execFile} from "node:child_process";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {promisify} from "node:util";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

const run = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const validator = path.join(repositoryRoot, "scripts/validate-conformance.rb");

const validatorExitSchema = z.object({
  code: z.number().int(),
  stderr: z.string(),
  stdout: z.string(),
});

interface ValidatorResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

async function validate(
  ledger: string,
  ...options: readonly string[]
): Promise<ValidatorResult> {
  try {
    const {stderr, stdout} = await run("ruby", [validator, ledger, ...options], {
      cwd: repositoryRoot,
      // The ledger and specification are UTF-8 regardless of the caller's locale.
      env: {...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8"},
    });
    return {exitCode: 0, stderr, stdout};
  } catch (error) {
    // execFile rejects with the exit code and captured output when the
    // validator exits non-zero; anything else is an unexpected failure.
    const failure = validatorExitSchema.safeParse(error);
    if (!failure.success) throw error;
    return {
      exitCode: failure.data.code,
      stderr: failure.data.stderr,
      stdout: failure.data.stdout,
    };
  }
}

interface FixtureRequirement {
  readonly deployments?: string;
  readonly dependsOn?: string;
  readonly evidence?: string;
  readonly failure?: string | null;
  readonly id: string;
  readonly status: string;
}

/**
 * A minimal two-deployment ledger whose source document and evidence report
 * live beside it, so each hostile variant differs from a valid ledger by one
 * deliberate defect.
 */
function fixtureLedger(requirements: readonly FixtureRequirement[]): string {
  const rows = requirements.map((requirement) => {
    const failure = requirement.failure === null
      ? ""
      : `\n      failure: ${requirement.failure ?? `{id: ${requirement.id}-F, description: "Reject the hostile case."}`}`;
    return `  - id: ${requirement.id}
    kind: behavior
    behavior: The fixture behaves.
    owner: product-core
    source: {file: spec.html, anchor: top}
    acceptance:
      behavior: {id: ${requirement.id}-B, description: "Prove the normal case."}${failure}
    deployments: ${requirement.deployments ?? "[local, single_server]"}
    status: ${requirement.status}
    proof_gap: Fixture gap.
    depends_on: ${requirement.dependsOn ?? "[]"}
    evidence: ${requirement.evidence ?? "[]"}`;
  });
  return `version: 1
product: Validator fixture
updated: "2026-11-04"
evidence_root: "."
source: {product_spec: spec.html}
deployment_sets:
  all: [local, single_server]
allowed_statuses: [specified, implementing, behavior_verified, verified, blocked, not_applicable]
status_contract: {}
evidence_contract:
  required_fields: [deployment, tests, result, run, recorded_at]
  allowed_results: [pass, fail]
allowed_kinds: [behavior]
allowed_modules: [product-core]
required_source_sections:
  top: [${requirements[0]?.id ?? "FIX-001"}]
requirements:
${rows.join("\n\n")}
`;
}

function evidence(
  tests: string,
  overrides: {readonly deployment?: string; readonly recordedAt?: string | null; readonly result?: string; readonly run?: string} = {},
): string {
  const recordedAt = overrides.recordedAt === null
    ? ""
    : `\n        recorded_at: "${overrides.recordedAt ?? "2026-11-04T00:00:00.000Z"}"`;
  return `
      - deployment: ${overrides.deployment ?? "local"}
        tests: ${tests}
        result: ${overrides.result ?? "pass"}
        run: ${overrides.run ?? "report.json"}${recordedAt}`;
}

function assertion(title: string, status: string) {
  return {ancestorTitles: [], fullName: title, status, title};
}

function vitestReport(
  passed: readonly string[],
  failed: readonly string[] = [],
): string {
  return JSON.stringify({
    numFailedTests: failed.length,
    numPassedTests: passed.length,
    success: failed.length === 0,
    testResults: [{
      assertionResults: [
        ...passed.map((title) => assertion(title, "passed")),
        ...failed.map((title) => assertion(title, "failed")),
      ],
    }],
  });
}

const passingReport = vitestReport([
  "FIX-001-B: normal",
  "FIX-001-F: hostile",
  "FIX-002-B: normal",
]);
const failingReport = vitestReport(["FIX-001-B: normal"], ["FIX-001-F: hostile"]);

describe("the conformance validator", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "rel-006-ledger-"));
    await writeFile(
      path.join(directory, "spec.html"),
      '<!doctype html><section id="top">Fixture</section>',
    );
    await writeFile(
      path.join(directory, "report.json"),
      passingReport,
    );
    await writeFile(path.join(directory, "failed-report.json"), failingReport);
  });

  afterEach(async () => {
    await rm(directory, {force: true, recursive: true});
  });

  async function validateFixture(
    requirements: readonly FixtureRequirement[],
    ...options: readonly string[]
  ): Promise<ValidatorResult> {
    const ledger = path.join(directory, "ledger.yml");
    await writeFile(ledger, fixtureLedger(requirements));
    return validate(ledger, ...options);
  }

  test("REL-006-B: validates the ledger and computes per-deployment evidence coverage for a release", async () => {
    // FIX-001 is proved on local only; FIX-002 has local behavior proof only.
    const requirements: readonly FixtureRequirement[] = [
      {evidence: evidence("[FIX-001-B, FIX-001-F]"), id: "FIX-001", status: "behavior_verified"},
      {evidence: evidence("[FIX-002-B]"), id: "FIX-002", status: "behavior_verified"},
    ];
    const report = await validateFixture(requirements, "--report");
    expect(report.exitCode).toBe(0);
    expect(report.stdout).toContain("Valid conformance ledger: 2 requirements, 4 tests, 2 deployments.");
    expect(report.stdout).toContain("Requirement status");
    expect(report.stdout).toContain("Deployment proof coverage");
    expect(report.stdout).toMatch(/^ {2}behavior_verified +2$/mu);
    expect(report.stdout).toMatch(/^ {2}local +1\/2 +50\.00%$/mu);
    expect(report.stdout).toMatch(/^ {2}single_server +0\/2 +0\.00%$/mu);

    // The release gate names exactly the requirement that lacks complete proof.
    const gate = await validateFixture(requirements, "--require-verified", "local");
    expect(gate.exitCode).toBe(3);
    expect(gate.stderr).toContain("Deployment local is not conformant: 1 requirements lack complete passing evidence.");
    expect(gate.stderr).toContain("- FIX-002: missing FIX-002-F");
    expect(gate.stderr).not.toContain("FIX-001:");

    // A deployment whose every requirement is proved passes the gate.
    const proved = await validateFixture(
      [{
        deployments: "[local]",
        evidence: evidence("[FIX-001-B, FIX-001-F]"),
        id: "FIX-001",
        status: "verified",
      }],
      "--require-verified",
      "local",
    );
    expect(proved.exitCode).toBe(0);
  });

  test("REL-006-F: rejects missing tests and deployments, malformed evidence, unresolved dependencies, and unproved verified status", async () => {
    const valid: FixtureRequirement = {
      evidence: evidence("[FIX-001-B]"),
      id: "FIX-001",
      status: "behavior_verified",
    };
    expect((await validateFixture([valid])).exitCode).toBe(0);

    const hostile: ReadonlyArray<readonly [FixtureRequirement[], string]> = [
      // Missing acceptance test.
      [[{...valid, failure: null}], "FIX-001: acceptance.failure must be a mapping"],
      [[{...valid, failure: "{id: FIX-001-X, description: \"Wrong.\"}"}], "FIX-001: failure test ID must be FIX-001-F"],
      [[{...valid, evidence: evidence("[]")}], "FIX-001.evidence[0]: tests must be a non-empty list"],
      // Missing or unknown deployments.
      [[{...valid, deployments: "[]"}], "FIX-001: deployments must be a non-empty list"],
      [[{...valid, deployments: "[local, mars]"}], "FIX-001: unknown deployments: mars"],
      [[{...valid, evidence: evidence("[FIX-001-B]", {deployment: "mars"})}], "FIX-001.evidence[0]: deployment is not applicable to FIX-001"],
      // Malformed evidence.
      [[{...valid, evidence: evidence("[FIX-001-B]", {recordedAt: null})}], 'FIX-001.evidence[0]: missing "recorded_at"'],
      [[{...valid, evidence: evidence("[FIX-001-B]", {result: "maybe"})}], 'FIX-001.evidence[0]: unknown result "maybe"'],
      [[{...valid, evidence: evidence("[FIX-002-B]")}], "FIX-001.evidence[0]: contains tests owned by another requirement: FIX-002-B"],
      [[{...valid, evidence: evidence("[FIX-001-B]", {run: "absent.json"})}], "FIX-001.evidence[0]: local evidence file does not exist: absent.json"],
      [[{...valid, evidence: evidence("[FIX-001-B, FIX-001-F]", {run: "failed-report.json"})}], "FIX-001.evidence[0]: passing evidence report records 1 failed test(s)"],
      [[{...valid, id: "FIX-003", evidence: evidence("[FIX-003-B]")}], "FIX-003.evidence[0]: evidence report does not contain passing results for FIX-003-B"],
      // Unresolved dependencies.
      [[{...valid, dependsOn: "[FIX-404]"}], 'FIX-001: unknown dependency "FIX-404"'],
      [[{...valid, dependsOn: "[FIX-002]"}, {dependsOn: "[FIX-001]", id: "FIX-002", status: "specified"}], "dependency cycle"],
      // Status without the proof it claims.
      [[{...valid, status: "verified", evidence: evidence("[FIX-001-B, FIX-001-F]")}], "FIX-001: verified but single_server lacks passing evidence for FIX-001-B, FIX-001-F"],
      [[{...valid, evidence: "[]"}], "FIX-001: behavior_verified requires passing behavior-test evidence"],
      [[{...valid, status: "implementing"}], "FIX-001: implementing has passing behavior-test evidence"],
    ];
    const outcomes = await Promise.all(hostile.map(async ([requirements, expected], index) => {
      const variant = path.join(directory, `variant-${index}`);
      await mkdir(variant);
      await writeFile(path.join(variant, "spec.html"), '<!doctype html><section id="top">Fixture</section>');
      await Promise.all([
        writeFile(path.join(variant, "report.json"), passingReport),
        writeFile(path.join(variant, "failed-report.json"), failingReport),
      ]);
      const ledger = path.join(variant, "ledger.yml");
      await writeFile(ledger, fixtureLedger(requirements));
      const result = await validate(ledger);
      return {
        expected,
        exitCode: result.exitCode,
        reported: result.stderr.includes(expected),
      };
    }));
    expect(outcomes).toEqual(hostile.map(([, expected]) => ({
      expected,
      exitCode: 1,
      reported: true,
    })));

    const unknownGate = await validateFixture([valid], "--require-verified", "mars");
    expect(unknownGate.exitCode).toBe(2);
    expect(unknownGate.stderr).toContain("Unknown deployment for --require-verified: mars");
  });
});
