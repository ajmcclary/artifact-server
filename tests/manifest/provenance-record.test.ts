import {describe, expect, test} from "vitest";

import type {ManifestEntry} from "../../src/core/model.js";
import {
  readProvenanceRecord,
  type ProvenanceOutcome,
} from "../../src/manifest/provenance-record.js";

type JsonValue = boolean | number | string | null | readonly JsonValue[] | JsonObject;
interface JsonObject {
  readonly [key: string]: JsonValue;
}

const digest = (character: string): string => character.repeat(64);
const commit = (character: string): string => character.repeat(40);
const entry = (path: string, sha256: string): ManifestEntry => ({
  disposition: "inline",
  mediaType: "text/html; charset=utf-8",
  path,
  sha256,
  size: 10,
});
const entries = [
  entry("project/Prototype - Form Builder.dc.html", digest("a")),
  entry("project/support.js", digest("b")),
  entry("artifactserver.views.json", digest("c")),
  entry("artifactserver.provenance.json", digest("d")),
];

function record(overrides: JsonObject = {}) {
  return {
    build: {
      dsRevision: commit("3"),
      lockfileSha256: digest("4"),
      recipe: "publish-all",
      recipeRevision: commit("2"),
      renderer: {name: "dc-support", sha256: digest("5")},
      toolchain: {node: "v24.15.0", npm: "11.6.0"},
    },
    coverage: {dependencyEdges: "partial", externalVariability: [], notes: "Fixture edges are listed; DS edges are target-wide."},
    format: "artifact-server.source-provenance",
    inputs: [{path: "arkcase-forms/project/Prototype - Form Builder.dc.html", sha256: digest("6")}],
    outputs: [
      {
        path: "project/Prototype - Form Builder.dc.html",
        sha256: digest("a"),
        sources: [{line: 1, path: "arkcase-forms/project/Prototype - Form Builder.dc.html"}],
      },
      {path: "artifactserver.views.json", sha256: digest("c"), sources: []},
    ],
    source: {
      commit: commit("1"),
      descriptorId: "arkcase-forms",
      dirty: false,
      repository: "https://github.com/example/Design",
    },
    version: 1,
    ...overrides,
  };
}

const text = (value: JsonValue): string => JSON.stringify(value);

function expectInvalid(outcome: ProvenanceOutcome, fragment: RegExp): void {
  expect(outcome.status).toBe("invalid");
  if (outcome.status !== "invalid") return;
  expect(outcome.diagnostic).toMatch(fragment);
}

describe("source provenance validation", () => {
  test("verifies matching outputs and reports coverage without counting the record itself", () => {
    const outcome = readProvenanceRecord(text(record()), entries);
    expect(outcome.status).toBe("verified");
    if (outcome.status !== "verified") return;
    expect(outcome.coverage).toEqual({
      declaredOutputs: 2,
      dependencyEdges: "partial",
      externalVariability: [],
      manifestFiles: 3,
    });
    expect(outcome.record.source.commit).toBe(commit("1"));
  });

  test("reports a missing record as not-recorded", () => {
    expect(readProvenanceRecord(null, entries)).toEqual({status: "not-recorded"});
  });

  test("reports changed and missing outputs as a mismatch with their paths", () => {
    const outcome = readProvenanceRecord(text(record({
      outputs: [
        {path: "project/Prototype - Form Builder.dc.html", sha256: digest("f"), sources: []},
        {path: "project/removed.js", sha256: digest("a"), sources: []},
        {path: "project/support.js", sha256: digest("b"), sources: []},
      ],
    })), entries);
    expect(outcome.status).toBe("mismatch");
    if (outcome.status !== "mismatch") return;
    expect(outcome.mismatches).toEqual([
      {path: "project/Prototype - Form Builder.dc.html", reason: "digest"},
      {path: "project/removed.js", reason: "missing"},
    ]);
    expect(outcome.mismatchCount).toBe(2);
    expect(outcome.coverage.declaredOutputs).toBe(2);
  });

  test("reports a dirty build as recorded", () => {
    const outcome = readProvenanceRecord(text(record({
      source: {commit: commit("1"), descriptorId: "arkcase-forms", dirty: true, repository: "https://github.com/example/Design"},
    })), entries);
    expect(outcome.status).toBe("verified");
    if (outcome.status !== "verified") return;
    expect(outcome.record.source.dirty).toBe(true);
  });

  test("reports an unknown version", () => {
    expect(readProvenanceRecord(text({format: "artifact-server.source-provenance", version: 9}), entries))
      .toEqual({status: "unsupported-version", version: 9});
  });

  test.each([
    ["malformed JSON", "{", /JSON/u],
    ["an unknown field", text(record({extra: 1})), /extra/u],
    ["a short commit", text(record({source: {commit: "abc", descriptorId: "a", dirty: false, repository: "https://github.com/example/Design"}})), /commit/u],
    ["an http repository", text(record({source: {commit: commit("1"), descriptorId: "a", dirty: false, repository: "http://github.com/example/Design"}})), /repository/u],
    ["a repository with credentials", text(record({source: {commit: commit("1"), descriptorId: "a", dirty: false, repository: "https://user:token@github.com/example/Design"}})), /repository/u],
    ["a repository with a query", text(record({source: {commit: commit("1"), descriptorId: "a", dirty: false, repository: "https://github.com/example/Design?token=x"}})), /repository/u],
    ["an escaping output path", text(record({outputs: [{path: "../x.html", sha256: digest("a"), sources: []}]})), /path/iu],
    ["an escaping input path", text(record({inputs: [{path: "../secrets", sha256: digest("a")}]})), /input/u],
    ["an escaping source path", text(record({outputs: [{path: "project/support.js", sha256: digest("b"), sources: [{path: "/etc/passwd"}]}]})), /source/u],
    ["a duplicate output", text(record({outputs: [{path: "project/support.js", sha256: digest("b"), sources: []}, {path: "project/support.js", sha256: digest("b"), sources: []}]})), /more than once/u],
    ["no outputs", text(record({outputs: []})), /outputs/u],
    ["an unknown dependency claim", text(record({coverage: {dependencyEdges: "most", externalVariability: []}})), /dependencyEdges/u],
    ["a control character in notes", text(record({coverage: {dependencyEdges: "none", externalVariability: [], notes: "a\u0000b"}})), /notes/u],
  ])("rejects %s", (_name, value, fragment) => {
    expect.hasAssertions();
    expectInvalid(readProvenanceRecord(value, entries), fragment);
  });

  test("rejects more than 5,000 outputs", () => {
    expect.hasAssertions();
    const outputs = Array.from({length: 5_001}, (_, index) => ({path: `f${index}.js`, sha256: digest("a"), sources: []}));
    expectInvalid(readProvenanceRecord(text(record({outputs})), entries), /outputs/u);
  });
});

describe("provenance coverage", () => {
  test("counts only declared outputs present in the manifest, never the record itself", () => {
    const outcome = readProvenanceRecord(text(record({
      outputs: [
        {path: "artifactserver.provenance.json", sha256: digest("d"), sources: []},
        {path: "project/Prototype - Form Builder.dc.html", sha256: digest("a"), sources: []},
        {path: "project/support.js", sha256: digest("b"), sources: []},
        {path: "project/removed.js", sha256: digest("e"), sources: []},
      ],
    })), entries);
    expect(outcome.status).toBe("mismatch");
    if (outcome.status !== "mismatch") return;
    expect(outcome.coverage.declaredOutputs).toBe(2);
    expect(outcome.coverage.manifestFiles).toBe(3);
  });
});
