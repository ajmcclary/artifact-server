import {describe, expect, test} from "vitest";

import type {ManifestEntry} from "../../src/core/model.js";
import {
  readViewsDocument,
  type ViewsOutcome,
} from "../../src/manifest/views-document.js";

type JsonValue = boolean | number | string | null | readonly JsonValue[] | JsonObject;
interface JsonObject {
  readonly [key: string]: JsonValue;
}

const entry = (path: string): ManifestEntry => ({
  disposition: "inline",
  mediaType: path.endsWith(".json") ? "application/json" : "text/html; charset=utf-8",
  path,
  sha256: "a".repeat(64),
  size: 10,
});
const entries = [
  entry("project/Prototype - Form Builder.dc.html"),
  entry("project/other.html"),
  entry("project/data.js"),
  entry("artifactserver.views.json"),
];

function formsView(overrides: JsonObject = {}) {
  return {
    defaultScenarioId: "1a",
    label: "ArkCase Forms · Form Builder",
    parameters: [
      {
        default: "ltr",
        name: "direction",
        prop: "chromeRtl",
        values: [{propValue: false, value: "ltr"}, {propValue: true, value: "rtl"}],
      },
      {
        default: true,
        name: "notes",
        prop: "showNotes",
        values: [{propValue: true, value: true}, {propValue: false, value: false}],
      },
    ],
    path: "project/Prototype - Form Builder.dc.html",
    scenarios: [
      {label: "Forms library · Populated table", props: {scenario: "1a"}, scenarioId: "1a"},
      {label: "Inspector · Validation", props: {scenario: "5"}, scenarioId: "5"},
      {label: "Rationale · Decisions, tokens, mapping", props: {scenario: "R"}, scenarioId: "R"},
    ],
    sourceRef: {path: "arkcase-forms/project/Prototype - Form Builder.dc.html"},
    viewId: "arkcase-forms/form-builder",
    ...overrides,
  };
}

function document(views: readonly unknown[], extra: JsonObject = {}): string {
  return JSON.stringify({format: "artifact-server.views", version: 1, views, ...extra});
}

function expectInvalid(outcome: ViewsOutcome, fragment: RegExp): void {
  expect(outcome.status).toBe("invalid");
  if (outcome.status !== "invalid") return;
  expect(outcome.diagnostic).toMatch(fragment);
  expect(outcome.diagnostic.length).toBeLessThanOrEqual(2_000);
}

describe("views document validation", () => {
  test("accepts the Forms view with scenarios and parameters", () => {
    const outcome = readViewsDocument(document([formsView()]), entries);
    expect(outcome.status).toBe("valid");
    if (outcome.status !== "valid") return;
    expect(outcome.views).toHaveLength(1);
    expect(outcome.views[0]?.scenarios.map((scenario) => scenario.scenarioId)).toEqual(["1a", "5", "R"]);
    expect(outcome.views[0]?.parameters.map((parameter) => parameter.name)).toEqual(["direction", "notes"]);
  });

  test("reports a missing document as absent", () => {
    expect(readViewsDocument(null, entries)).toEqual({status: "absent"});
  });

  test("reports an unknown version without decoding the body", () => {
    expect(readViewsDocument(JSON.stringify({format: "artifact-server.views", version: 2, views: "anything"}), entries))
      .toEqual({status: "unsupported-version", version: 2});
  });

  test.each([
    ["malformed JSON", "{", /JSON/u],
    ["a wrong format", JSON.stringify({format: "artifact-server.preview-source", version: 1, views: []}), /format/u],
    ["an unknown top-level field", document([formsView()], {extra: true}), /extra/u],
    ["an unknown view field", document([formsView({colour: "red"})]), /colour/u],
    ["no views", document([]), /views/u],
    ["an uppercase view id", document([formsView({viewId: "Forms/builder"})]), /viewId/u],
    ["a view id without a slash", document([formsView({viewId: "forms-builder"})]), /viewId/u],
    ["a label with a control character", document([formsView({label: "Forms\u0007"})]), /label/u],
    ["a scenario id with a space", document([formsView({scenarios: [{label: "A", props: {scenario: "1 a"}, scenarioId: "1 a"}], defaultScenarioId: "1 a"})]), /scenarioId/u],
    ["an object prop value", document([formsView({scenarios: [{label: "A", props: {scenario: {nested: true}}, scenarioId: "1a"}]})]), /props|scenario/u],
    ["empty props", document([formsView({scenarios: [{label: "A", props: {}, scenarioId: "1a"}]})]), /props/u],
    ["a sourceRef with a zero line", document([formsView({sourceRef: {line: 0, path: "a.html"}})]), /line/u],
  ])("rejects %s", (_name, text, fragment) => {
    expect.hasAssertions();
    expectInvalid(readViewsDocument(text, entries), fragment);
  });

  test.each([
    ["a path that is not published", formsView({path: "project/missing.html"}), /not a published HTML file/u],
    ["a path that differs only by case", formsView({path: "project/prototype - form builder.dc.html"}), /not a published HTML file/u],
    ["a published non-HTML path", formsView({path: "project/data.js"}), /not a published HTML file/u],
    ["an escaping path", formsView({path: "../project/other.html"}), /path/iu],
    ["an escaping sourceRef", formsView({sourceRef: {path: "../secrets.txt"}}), /sourceRef/u],
    ["an absolute sourceRef", formsView({sourceRef: {path: "/etc/passwd"}}), /sourceRef/u],
    ["an unknown default scenario", formsView({defaultScenarioId: "99"}), /defaultScenarioId/u],
    ["duplicate scenario ids", formsView({scenarios: [{label: "A", props: {scenario: "5"}, scenarioId: "5"}, {label: "B", props: {scenario: "5"}, scenarioId: "5"}], defaultScenarioId: "5"}), /more than once/u],
    ["a parameter prop reused by a scenario", formsView({scenarios: [{label: "A", props: {chromeRtl: true, scenario: "1a"}, scenarioId: "1a"}]}), /chromeRtl/u],
    ["a parameter default that is not a value", formsView({parameters: [{default: "auto", name: "direction", prop: "chromeRtl", values: [{propValue: false, value: "ltr"}, {propValue: true, value: "rtl"}]}]}), /default/u],
    ["duplicate parameter values", formsView({parameters: [{default: "ltr", name: "direction", prop: "chromeRtl", values: [{propValue: false, value: "ltr"}, {propValue: true, value: "ltr"}]}]}), /more than once/u],
  ])("rejects %s", (_name, view, fragment) => {
    expect.hasAssertions();
    expectInvalid(readViewsDocument(document([view]), entries), fragment);
  });

  test("rejects two views with one id and two views on one path", () => {
    expect.hasAssertions();
    expectInvalid(
      readViewsDocument(document([formsView(), formsView({path: "project/other.html"})]), entries),
      /declared more than once/u,
    );
    expectInvalid(
      readViewsDocument(document([formsView(), formsView({viewId: "arkcase-forms/second"})]), entries),
      /More than one view names/u,
    );
  });

  test("rejects more than 200 scenarios in one view", () => {
    expect.hasAssertions();
    const scenarios = Array.from({length: 201}, (_, index) => ({
      label: `Scenario ${index}`,
      props: {scenario: `s${index}`},
      scenarioId: `s${index}`,
    }));
    expectInvalid(
      readViewsDocument(document([formsView({defaultScenarioId: "s0", scenarios})]), entries),
      /scenarios/u,
    );
  });
});
