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
