import {Schema} from "effect";

import type {ManifestEntry} from "../core/model.js";
import {parseManifestPath} from "./create-manifest.js";

/**
 * Producer views document published at a design version's root. Review reads
 * it as untrusted data from the exact version; it never selects storage.
 */
export const viewsDocumentPath = "artifactserver.views.json";
export const viewsDocumentFormat = "artifact-server.views";
export const viewsDocumentVersions = [1] as const;
export const maximumViewsDocumentBytes = 1_048_576;
const maximumDiagnosticCharacters = 2_000;

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
  reportInput: false,
} as const;

const label = Schema.String.check(
  Schema.isPattern(/^(?=.*\S)[^\p{Cc}\p{Cf}]+$/u),
  Schema.isMaxLength(200),
);
const viewIdSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u),
  Schema.isMaxLength(128),
);
const scenarioIdSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u),
);
const propNameSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u),
);
const propValueSchema = Schema.Union([
  Schema.String.check(Schema.isMaxLength(256)),
  Schema.Finite,
  Schema.Boolean,
]);
const propsSchema = Schema.Record(propNameSchema, propValueSchema).check(
  Schema.isPropertiesLengthBetween(1, 16),
);
const sourceRefSchema = Schema.Struct({
  line: Schema.optional(Schema.Int.check(Schema.isBetween({maximum: 10_000_000, minimum: 1}))),
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
});
const scenarioSchema = Schema.Struct({
  label,
  props: propsSchema,
  scenarioId: scenarioIdSchema,
});
const parameterSchema = Schema.Struct({
  default: propValueSchema,
  name: propNameSchema,
  prop: propNameSchema,
  values: Schema.Array(Schema.Struct({propValue: propValueSchema, value: propValueSchema}))
    .check(Schema.isMinLength(2), Schema.isMaxLength(16)),
});
const viewSchema = Schema.Struct({
  defaultScenarioId: scenarioIdSchema,
  label,
  parameters: Schema.Array(parameterSchema).check(Schema.isMaxLength(8)),
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  scenarios: Schema.Array(scenarioSchema).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  sourceRef: sourceRefSchema,
  viewId: viewIdSchema,
});
const headerSchema = Schema.Struct({
  format: Schema.Literal(viewsDocumentFormat),
  version: Schema.Int,
});

/** Version 1 of the views document, strict: unknown fields are errors. */
export const viewsDocumentSchema = Schema.Struct({
  format: Schema.Literal(viewsDocumentFormat),
  version: Schema.Literals(viewsDocumentVersions),
  views: Schema.Array(viewSchema).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

export type ViewsDocument = typeof viewsDocumentSchema.Type;
export type ReviewView = ViewsDocument["views"][number];
export type ReviewScenario = ReviewView["scenarios"][number];
export type ReviewParameter = ReviewView["parameters"][number];

export type ViewsOutcome =
  | {readonly status: "valid"; readonly views: readonly ReviewView[]}
  | {readonly status: "absent"}
  | {readonly status: "unsupported-version"; readonly version: number}
  | {readonly status: "invalid"; readonly diagnostic: string};

class ViewsDocumentRejected extends Error {}

/** An invalid outcome whose diagnostic is bounded for display. */
export function invalidViewsDocument(diagnostic: string): ViewsOutcome {
  return {diagnostic: diagnostic.slice(0, maximumDiagnosticCharacters), status: "invalid"};
}

/**
 * Validate one version's views document against that version's manifest.
 * `null` text means the version publishes no views document.
 */
export function readViewsDocument(
  text: string | null,
  entries: readonly ManifestEntry[],
): ViewsOutcome {
  if (text === null) return {status: "absent"};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalidViewsDocument("The views document is not valid JSON.");
  }
  try {
    const header = Schema.decodeUnknownSync(headerSchema)(value);
    if (!viewsDocumentVersions.some((version) => version === header.version)) {
      return {status: "unsupported-version", version: header.version};
    }
    const parsed = Schema.decodeUnknownSync(viewsDocumentSchema)(value, strictParseOptions);
    return {status: "valid", views: checkedViews(parsed.views, entries)};
  } catch (error) {
    return invalidViewsDocument(error instanceof Error ? error.message : String(error));
  }
}

function checkedViews(
  views: readonly ReviewView[],
  entries: readonly ManifestEntry[],
): readonly ReviewView[] {
  const htmlPaths = new Set(
    entries.filter((entry) => /\.html?$/iu.test(entry.path)).map((entry) => entry.path),
  );
  const viewIds = new Set<string>();
  const paths = new Set<string>();
  for (const view of views) {
    if (viewIds.has(view.viewId)) {
      throw new ViewsDocumentRejected(`View ${JSON.stringify(view.viewId)} is declared more than once.`);
    }
    viewIds.add(view.viewId);
    // Validate before lookup: a normalized '..' would conceal an escaping reference.
    const viewPath = parseManifestPath(view.path);
    if (viewPath !== view.path || !htmlPaths.has(viewPath)) {
      throw new ViewsDocumentRejected(
        `View ${JSON.stringify(view.viewId)} names ${JSON.stringify(view.path)}, which is not a published HTML file.`,
      );
    }
    if (paths.has(viewPath)) {
      throw new ViewsDocumentRejected(`More than one view names ${JSON.stringify(viewPath)}.`);
    }
    paths.add(viewPath);
    requireRelativeSourcePath(view.viewId, view.sourceRef.path);
    checkScenarios(view);
    checkParameters(view);
  }
  return views;
}

function requireRelativeSourcePath(viewId: string, candidate: string): void {
  const segments = candidate.split("/");
  if (
    candidate.startsWith("/") ||
    candidate.includes("\\") ||
    candidate.includes("\0") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new ViewsDocumentRejected(
      `View ${JSON.stringify(viewId)} has a sourceRef path that is not a plain relative path.`,
    );
  }
}

function checkScenarios(view: ReviewView): void {
  const seen = new Set<string>();
  for (const scenario of view.scenarios) {
    if (seen.has(scenario.scenarioId)) {
      throw new ViewsDocumentRejected(
        `View ${JSON.stringify(view.viewId)} declares scenario ${JSON.stringify(scenario.scenarioId)} more than once.`,
      );
    }
    seen.add(scenario.scenarioId);
  }
  if (!seen.has(view.defaultScenarioId)) {
    throw new ViewsDocumentRejected(
      `View ${JSON.stringify(view.viewId)} has a defaultScenarioId that names no scenario.`,
    );
  }
}

function checkParameters(view: ReviewView): void {
  const names = new Set<string>();
  const props = new Set<string>();
  for (const parameter of view.parameters) {
    if (names.has(parameter.name) || props.has(parameter.prop)) {
      throw new ViewsDocumentRejected(
        `View ${JSON.stringify(view.viewId)} declares parameter ${JSON.stringify(parameter.name)} more than once.`,
      );
    }
    names.add(parameter.name);
    props.add(parameter.prop);
    const values = new Set<string>();
    for (const option of parameter.values) {
      const key = JSON.stringify(option.value);
      if (values.has(key)) {
        throw new ViewsDocumentRejected(
          `Parameter ${JSON.stringify(parameter.name)} lists value ${key} more than once.`,
        );
      }
      values.add(key);
    }
    if (!values.has(JSON.stringify(parameter.default))) {
      throw new ViewsDocumentRejected(
        `Parameter ${JSON.stringify(parameter.name)} has a default that is not one of its values.`,
      );
    }
  }
  for (const scenario of view.scenarios) {
    for (const prop of Object.keys(scenario.props)) {
      if (props.has(prop)) {
        throw new ViewsDocumentRejected(
          `Scenario ${JSON.stringify(scenario.scenarioId)} sets ${JSON.stringify(prop)}, which a parameter controls.`,
        );
      }
    }
  }
}
