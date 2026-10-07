import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";

const encoder = new TextEncoder();
const viewsOutcomeSchema = z.discriminatedUnion("status", [
  z.object({status: z.literal("valid"), views: z.array(z.object({
    parameters: z.array(z.object({name: z.string()}).loose()),
    scenarios: z.array(z.object({label: z.string(), scenarioId: z.string()}).loose()),
    viewId: z.string(),
  }).loose())}).strict(),
  z.object({status: z.literal("absent")}).strict(),
  z.object({status: z.literal("unsupported-version"), version: z.number()}).strict(),
  z.object({diagnostic: z.string().max(2_000), status: z.literal("invalid")}).strict(),
]);
const failureSchema = z.object({error: z.object({code: z.string(), message: z.string()}).strict()}).strict();

const page: TestSiteFile = {
  bytes: encoder.encode("<!doctype html><title>Builder</title><main data-review-scenario=\"1a\"></main>"),
  mediaType: "text/html; charset=utf-8",
  path: "project/builder.html",
};

type JsonValue = boolean | number | string | null | readonly JsonValue[] | JsonObject;
interface JsonObject {
  readonly [key: string]: JsonValue;
}

function viewsBytes(bytes: Uint8Array): TestSiteFile {
  return {bytes, mediaType: "application/json", path: "artifactserver.views.json"};
}

function viewsFile(value: JsonValue): TestSiteFile {
  return viewsBytes(encoder.encode(JSON.stringify(value)));
}

const formsViews = {
  format: "artifact-server.views",
  version: 1,
  views: [{
    defaultScenarioId: "1a",
    label: "ArkCase Forms · Form Builder",
    parameters: [{
      default: "ltr",
      name: "direction",
      prop: "chromeRtl",
      values: [{propValue: false, value: "ltr"}, {propValue: true, value: "rtl"}],
    }],
    path: "project/builder.html",
    scenarios: [
      {label: "Forms library · Populated table", props: {scenario: "1a"}, scenarioId: "1a"},
      {label: "Inspector · Validation", props: {scenario: "5"}, scenarioId: "5"},
    ],
    sourceRef: {path: "arkcase-forms/project/Prototype - Form Builder.dc.html"},
    viewId: "arkcase-forms/form-builder",
  }],
};

describe("DSN-007 design views document", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function publish(files: readonly TestSiteFile[], key: string): Promise<PublishResponse> {
    const upload = await createStagedUpload(server, installation, "project/builder.html", files);
    await uploadEveryStagedFile(installation, upload.body, files);
    return (await commitStagedUpload(installation, upload.body, key, {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: "Forms",
      tags: [],
    })).body;
  }

  async function readViews(published: PublishResponse, versionId = published.version.id): Promise<Response> {
    return fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${versionId}/views?projectId=${published.artifact.projectId}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
  }

  test("DSN-007-B: serves a valid views document, repeats the same outcome and reports absent views", async () => {
    expect.hasAssertions();
    const published = await publish([page, viewsFile(formsViews)], "dsn-007-b-valid-views");
    const first = await readViews(published);
    expect(first.status).toBe(200);
    const outcome = viewsOutcomeSchema.parse(await first.json());
    expect(outcome.status).toBe("valid");
    if (outcome.status !== "valid") return;
    expect(outcome.views[0]?.viewId).toBe("arkcase-forms/form-builder");
    expect(outcome.views[0]?.scenarios.map((scenario) => scenario.scenarioId)).toEqual(["1a", "5"]);
    expect(outcome.views[0]?.parameters.map((parameter) => parameter.name)).toEqual(["direction"]);
    expect(viewsOutcomeSchema.parse(await (await readViews(published)).json())).toEqual(outcome);

    const plain = await publish([page], "dsn-007-b-absent");
    expect(viewsOutcomeSchema.parse(await (await readViews(plain)).json())).toEqual({status: "absent"});
  });

  test("DSN-007-F: reports hostile views documents as invalid or unsupported while the version stays readable", async () => {
    expect.hasAssertions();
    const cases: readonly [string, TestSiteFile, "invalid" | "unsupported-version"][] = [
      ["malformed", viewsBytes(encoder.encode("{")), "invalid"],
      ["not utf-8", viewsBytes(new Uint8Array([0x7b, 0xe9, 0x7d])), "invalid"],
      ["unknown version", viewsFile({format: "artifact-server.views", version: 2, views: []}), "unsupported-version"],
      ["unknown field", viewsFile({...formsViews, extra: true}), "invalid"],
      ["missing path", viewsFile({...formsViews, views: [{...formsViews.views[0], path: "project/missing.html"}]}), "invalid"],
      ["case-mismatched path", viewsFile({...formsViews, views: [{...formsViews.views[0], path: "project/Builder.html"}]}), "invalid"],
      ["escaping sourceRef", viewsFile({...formsViews, views: [{...formsViews.views[0], sourceRef: {path: "../x"}}]}), "invalid"],
      ["object prop", viewsFile({...formsViews, views: [{...formsViews.views[0], scenarios: [{label: "A", props: {scenario: {}}, scenarioId: "1a"}]}]}), "invalid"],
    ];
    const observed = await Promise.all(cases.map(async ([name, file]) => {
      const published = await publish([page, file], `dsn-007-f-${name.replaceAll(" ", "-")}`);
      const response = await readViews(published);
      const outcome = viewsOutcomeSchema.parse(await response.json());
      const entry = await fetch(
        `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/file?${new URLSearchParams({path: "project/builder.html", projectId: published.artifact.projectId})}`,
        {headers: {Authorization: `Bearer ${installation.apiToken}`}},
      );
      return {entry: entry.status, name, outcome: outcome.status, views: response.status};
    }));
    expect(observed).toEqual(cases.map(([name, , status]) => ({entry: 200, name, outcome: status, views: 200})));
    const published = await publish([page, viewsFile(formsViews)], "dsn-007-f-unknown-version-id");
    const unknown = await readViews(published, "ver_00000000-0000-4000-8000-000000000000");
    expect(unknown.status).toBe(404);
    expect(failureSchema.parse(await unknown.json()).error.code).toBe("VERSION_NOT_FOUND");
  });
});
