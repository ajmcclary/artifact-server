import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  activityPageSchema,
  activityQueryString,
  activitySummarySchema,
} from "../../apps/web/src/api/activity-contract.js";
import {ApiClient, MutableClock} from "../support/agent-dispatch.js";
import {publishNew} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

describe("web activity contract", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let clock: MutableClock;

  beforeEach(async () => {
    installation = await createTestInstallation();
    clock = new MutableClock("2026-10-01T12:00:00.000Z");
    server = await startTestServer(installation, {clock});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("ACT-003: the web schemas parse real feed and summary responses", async () => {
    expect.hasAssertions();
    const reader = new ApiClient(server, installation.apiToken);
    const published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<p>contract</p>",
      idempotencyKey: "contract-publish",
      name: "Contract target",
    })).body;
    clock.advance(1_000);
    await reader.openThread(published, "Contract note", "contract-thread-key");

    const query = activityQueryString({
      projects: [published.artifact.projectId],
      segment: "all",
      types: ["comments", "versions"],
    });
    expect(query).toBe(
      `?project=${published.artifact.projectId}&type=comments&type=versions&segment=all`,
    );
    const page = activityPageSchema.parse(
      await (await reader.fetch(`/api/v1/activity${query}`)).json(),
    );
    expect(page.items.map((entry) => entry.kind)).toEqual(["thread", "version"]);

    const summary = activitySummarySchema.parse(
      await (await reader.fetch("/api/v1/activity/summary")).json(),
    );
    expect(summary.needsYou).toBe(1);
  });
});
