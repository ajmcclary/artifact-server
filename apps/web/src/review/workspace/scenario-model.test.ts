import {describe, expect, test} from "vitest";

import type {ReviewView} from "../../api/views.ts";
import type {PageState} from "../../review-frame/page-protocol.ts";
import {
  annotationsForScenario,
  captureProps,
  parametersFromProps,
  reduceViewState,
  restorePropsFor,
  sanitizeLabel,
  threadPlacement,
  viewAnchorFrom,
  viewForPath,
} from "./scenario-model.ts";

const view: ReviewView = {
  defaultScenarioId: "1",
  label: "Fixture",
  parameters: [{default: "ltr", name: "direction", prop: "chromeRtl", values: [{propValue: false, value: "ltr"}, {propValue: true, value: "rtl"}]}],
  path: "honest.html",
  scenarios: [
    {label: "Library", props: {scenario: "1"}, scenarioId: "1"},
    {label: "Inspector · Validation", props: {scenario: "5"}, scenarioId: "5"},
  ],
  sourceRef: {line: 12, path: "fixture/honest.html"},
  viewId: "fixture/honest",
};
const state = (scenarioId: string | null, chromeRtl = false): PageState => ({
  direction: chromeRtl ? "rtl" : "ltr",
  locale: "en",
  pageVersion: 1,
  props: {chromeRtl, scenario: scenarioId ?? ""},
  scenarioId,
  theme: "light",
  viewport: {height: 900, width: 1440},
});

describe("scenario model", () => {
  test("finds the view for the open path only when the outcome is valid", () => {
    expect(viewForPath({status: "valid", views: [view]}, "honest.html")).toBe(view);
    expect(viewForPath({status: "valid", views: [view]}, "other.html")).toBeNull();
    expect(viewForPath({diagnostic: "x", status: "invalid"}, "honest.html")).toBeNull();
  });

  test("merges scenario props with parameter props and rejects unknown scenarios", () => {
    expect(restorePropsFor(view, "5", {direction: "rtl"})).toEqual({chromeRtl: true, scenario: "5"});
    expect(restorePropsFor(view, "5", {})).toEqual({chromeRtl: false, scenario: "5"});
    expect(restorePropsFor(view, "99", {})).toBeNull();
    expect(captureProps(view)).toEqual(["scenario", "chromeRtl"]);
    expect(parametersFromProps(view, {chromeRtl: true, scenario: "5"})).toEqual({direction: "rtl"});
  });

  test("builds a view anchor only for a scenario the views document declares", () => {
    const anchor = viewAnchorFrom(view, {region: {label: "Minimum‮ length​", regionId: "inspector.min", tagName: "label"}, state: state("5")});
    expect(anchor).toEqual({
      regionId: "inspector.min",
      regionLabel: "Minimum length",
      scenarioId: "5",
      scenarioLabel: "Inspector · Validation",
      sourceRef: {line: 12, path: "fixture/honest.html"},
      state: {direction: "ltr", locale: "en", parameters: {direction: "ltr"}, theme: "light", viewport: {height: 900, width: 1440}},
      viewFormat: 1,
      viewId: "fixture/honest",
    });
    expect(viewAnchorFrom(view, {region: null, state: state("42")})).toBeUndefined();
    expect(viewAnchorFrom(view, {region: null, state: null})).toBeUndefined();
    expect(viewAnchorFrom(view, undefined)).toBeUndefined();
  });

  test("sanitizes and bounds labels", () => {
    expect(sanitizeLabel("  a\u0007b⁦c​d  ", 64)).toBe("abcd");
    expect(sanitizeLabel("x".repeat(100), 64)).toHaveLength(64);
  });

  test("places threads of the scenario on screen and lists the others", () => {
    const inFive = {htmlAnchor: null, originalText: "", view: viewAnchorFrom(view, {region: null, state: state("5")})};
    expect(threadPlacement(inFive, view, "5")).toEqual({kind: "place"});
    expect(threadPlacement(inFive, view, "1")).toEqual({kind: "other-scenario", scenarioId: "5", scenarioLabel: "Inspector · Validation"});
    expect(threadPlacement({htmlAnchor: null, originalText: ""}, view, "1")).toEqual({kind: "place"});
    expect(threadPlacement(inFive, null, null)).toEqual({kind: "place"});
    const annotations = [
      {anchor: inFive, body: "five", state: "open" as const, threadId: "t5"},
      {anchor: null, body: "page", state: "open" as const, threadId: "tp"},
    ];
    expect(annotationsForScenario(annotations, view, "1").map((annotation) => annotation.threadId)).toEqual(["tp"]);
  });

  test("lets only the latest restore set the scenario on screen", () => {
    const restoring = {reason: null, requestId: "r2", scenarioId: null, status: "restoring" as const};
    const stale = reduceViewState(restoring, {outcome: "restored", requestId: "r1", state: state("5"), type: "as-review-view-state", v: 1}, view);
    expect(stale).toBe(restoring);
    const done = reduceViewState(restoring, {outcome: "restored", requestId: "r2", state: state("1"), type: "as-review-view-state", v: 1}, view);
    expect(done).toEqual({reason: null, requestId: null, scenarioId: "1", status: "ready"});
    const failed = reduceViewState(restoring, {outcome: "failed", reason: "timeout", requestId: "r2", state: null, type: "as-review-view-state", v: 1}, view);
    expect(failed).toEqual({reason: "timeout", requestId: null, scenarioId: null, status: "failed"});
    const moved = reduceViewState(done, {outcome: "restored", requestId: null, state: state("5"), type: "as-review-view-state", v: 1}, view);
    expect(moved.scenarioId).toBe("5");
    const unknown = reduceViewState(done, {outcome: "restored", requestId: null, state: state("42"), type: "as-review-view-state", v: 1}, view);
    expect(unknown.scenarioId).toBeNull();
  });
});

describe("view state while a restore is pending", () => {
  test("keeps waiting for the restore reply when the page reports a change on its own", () => {
    const restoring = {reason: null, requestId: "r1", scenarioId: "1", status: "restoring" as const};
    const reported = reduceViewState(restoring, {outcome: "restored", requestId: null, state: state("5"), type: "as-review-view-state", v: 1}, view);
    expect(reported).toEqual({reason: null, requestId: "r1", scenarioId: "5", status: "restoring"});
    const mismatch = reduceViewState(reported, {outcome: "failed", reason: "scenario-mismatch", requestId: "r1", state: state("5"), type: "as-review-view-state", v: 1}, view);
    expect(mismatch).toEqual({reason: "scenario-mismatch", requestId: null, scenarioId: "5", status: "failed"});
  });
});

describe("annotations without a known view", () => {
  test("drop their view block so the frame never places them by region", () => {
    const located = viewAnchorFrom(view, {region: {label: "Min", regionId: "inspector.min", tagName: "label"}, state: state("5")});
    const annotations = [{anchor: {htmlAnchor: null, originalText: "", view: located}, body: "b", state: "open" as const, threadId: "t"}];
    expect(annotationsForScenario(annotations, null, null)[0]?.anchor?.view).toBeUndefined();
    const otherView = {...view, viewId: "fixture/other"};
    expect(annotationsForScenario(annotations, otherView, "5")[0]?.anchor?.view).toBeUndefined();
    expect(annotationsForScenario(annotations, view, "5")[0]?.anchor?.view?.regionId).toBe("inspector.min");
  });
});
