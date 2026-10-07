import {describe, expect, test} from "vitest";

import {pageMessageSchema} from "./page-protocol.ts";
import {frameMessageSchema, hostMessageSchema, reviewAnchorSchema} from "./protocol.ts";

const state = {
  direction: "ltr",
  locale: "en",
  pageVersion: 1,
  props: {chromeRtl: false, scenario: "5"},
  scenarioId: "5",
  theme: "light",
  viewport: {height: 900, width: 1440},
};
const view = {
  regionId: "inspector.validation.min-length",
  regionLabel: "Minimum length",
  scenarioId: "5",
  scenarioLabel: "Inspector · Validation",
  sourceRef: {path: "arkcase-forms/project/Prototype - Form Builder.dc.html"},
  state: {direction: "ltr", locale: "en", parameters: {direction: "ltr"}, theme: "light", viewport: {height: 900, width: 1440}},
  viewFormat: 1,
  viewId: "arkcase-forms/form-builder",
};

describe("review anchor", () => {
  test("keeps a valid view block and unknown keys", () => {
    const parsed = reviewAnchorSchema.parse({htmlAnchor: null, future: {kept: true}, originalText: "x", view});
    expect(parsed.view?.regionId).toBe("inspector.validation.min-length");
    expect(parsed).toHaveProperty("future", {kept: true});
  });

  test("treats an invalid view block as absent without dropping the anchor", () => {
    const parsed = reviewAnchorSchema.parse({htmlAnchor: null, originalText: "x", view: {...view, regionId: "Not Valid"}});
    expect(parsed.view).toBeUndefined();
    expect(parsed.originalText).toBe("x");
  });

  test("parses an anchor written before views existed", () => {
    expect(reviewAnchorSchema.parse({htmlAnchor: null, originalText: "legacy"}).view).toBeUndefined();
  });
});

describe("host and frame messages", () => {
  test("accepts restore, capture and view-state under v1", () => {
    expect(hostMessageSchema.parse({props: {scenario: "5"}, requestId: "r1", scenarioId: "5", type: "as-review-restore", v: 1, viewId: "arkcase-forms/form-builder"}).type)
      .toBe("as-review-restore");
    expect(hostMessageSchema.parse({props: ["scenario"], requestId: "r2", type: "as-review-capture", v: 1}).type)
      .toBe("as-review-capture");
    expect(frameMessageSchema.parse({outcome: "restored", requestId: null, state, type: "as-review-view-state", v: 1}).type)
      .toBe("as-review-view-state");
  });

  test("carries capture on submit and reasons on unanchored", () => {
    const submit = frameMessageSchema.parse({
      anchor: null,
      body: "b",
      capture: {region: {label: "Minimum length", regionId: "inspector.validation.min-length", tagName: "label"}, state},
      originalText: "",
      type: "as-review-submit",
      v: 1,
    });
    expect(submit.type === "as-review-submit" && submit.capture?.region?.tagName).toBe("label");
    const unanchored = frameMessageSchema.parse({reasons: {t1: "region-missing"}, threadIds: ["t1"], type: "as-review-unanchored", v: 1});
    expect(unanchored.type === "as-review-unanchored" && unanchored.reasons).toEqual({t1: "region-missing"});
  });

  test("rejects a restore with too many props", () => {
    const props = Object.fromEntries(Array.from({length: 17}, (_, index) => [`p${index}`, index]));
    expect(hostMessageSchema.safeParse({props, requestId: "r", scenarioId: "5", type: "as-review-restore", v: 1, viewId: "a/b"}).success)
      .toBe(false);
  });
});

describe("page messages", () => {
  test("accepts hello, restored, state, region and regions", () => {
    const messages = [
      {capabilities: ["restore", "capture", "regions"], pageVersion: 1, type: "as-page-hello"},
      {ok: true, requestId: "r", state, type: "as-page-restored"},
      {requestId: null, state, type: "as-page-state"},
      {region: null, reason: "ambiguous", requestId: "r", type: "as-page-region"},
      {requestId: "r", results: [{count: 1, regionId: "a.b", tagName: "label"}], type: "as-page-regions"},
    ];
    expect(messages.map((message) => [message.type, pageMessageSchema.safeParse(message).success]))
      .toEqual(messages.map((message) => [message.type, true]));
  });

  test("accepts each page theme under pageVersion 1 and rejects an unknown one", () => {
    for (const theme of ["light", "dark", "high-contrast"]) {
      expect(pageMessageSchema.safeParse({requestId: null, state: {...state, theme}, type: "as-page-state"}).success)
        .toBe(true);
      const anchor = reviewAnchorSchema.parse({htmlAnchor: null, originalText: "x", view: {...view, state: {...view.state, theme}}});
      expect(anchor.view?.state.theme).toBe(theme);
    }
    expect(pageMessageSchema.safeParse({requestId: null, state: {...state, theme: "sepia"}, type: "as-page-state"}).success)
      .toBe(false);
    expect(reviewAnchorSchema.parse({htmlAnchor: null, originalText: "x", view: {...view, state: {...view.state, theme: "sepia"}}}).view)
      .toBeUndefined();
  });

  test.each([
    ["an oversized label", {region: {label: "x".repeat(257), regionId: "a", tagName: "div"}, requestId: "r", type: "as-page-region"}],
    ["a malformed region id", {region: {label: "x", regionId: "A B", tagName: "div"}, requestId: "r", type: "as-page-region"}],
    ["too many region results", {requestId: "r", results: Array.from({length: 65}, () => ({count: 0, regionId: "a", tagName: null})), type: "as-page-regions"}],
    ["an unknown capability", {capabilities: ["teleport"], pageVersion: 1, type: "as-page-hello"}],
    ["a plannotator bridge message", {type: "plannotator-bridge-ready"}],
  ])("rejects %s", (_name, message) => {
    expect(pageMessageSchema.safeParse(message).success).toBe(false);
  });
});
