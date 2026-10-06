import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  activityFacetsSchema,
  activityPageSchema,
  activityQueryString,
  type ActivityFacets,
  type ActivityPageResponse,
} from "../../apps/web/src/api/activity-contract.js";
import {ApiClient, issueApiKey, MutableClock, signInAdministrator} from "../support/agent-dispatch.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).strict(),
}).strict();

async function readJson<Schema extends z.ZodType>(
  client: ApiClient,
  pathname: string,
  schema: Schema,
): Promise<z.infer<Schema>> {
  const response = await client.fetch(pathname);
  expect(response.status).toBe(200);
  return schema.parse(await response.json());
}

/** Every entry the feed holds for a query ("" or "?…"), walking two-entry pages. */
async function walk(client: ApiClient, query: string, cursor: string | null = null): Promise<ActivityPageResponse["items"]> {
  const params = new URLSearchParams(query.replace(/^\?/u, ""));
  params.set("limit", "2");
  if (cursor !== null) params.set("cursor", cursor);
  const page = await readJson(client, `/api/v1/activity?${params}`, activityPageSchema);
  return page.nextCursor === null ? page.items : [...page.items, ...await walk(client, query, page.nextCursor)];
}

const facets = (client: ApiClient, query = ""): Promise<ActivityFacets> =>
  readJson(client, `/api/v1/activity/facets${query}`, activityFacetsSchema);

describe("activity people filter and counts", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let clock: MutableClock;
  let local: ApiClient;
  let rosa: ApiClient;
  let administrator: Awaited<ReturnType<typeof signInAdministrator>>;

  beforeEach(async () => {
    installation = await createTestInstallation();
    clock = new MutableClock("2026-10-01T12:00:00.000Z");
    server = await startTestServer(installation, {clock});
    local = new ApiClient(server, installation.apiToken);
    administrator = await signInAdministrator(server, installation);
    rosa = new ApiClient(
      server,
      await issueApiKey(server, administrator, ["artifact:read", "comment:write"], "Rosa Santoro"),
    );
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function publish(name: string): Promise<PublishResponse> {
    clock.advance(1_000);
    return (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: `<p>${name}</p>`,
      idempotencyKey: `people-${name.toLowerCase().replaceAll(" ", "-")}`,
      name,
    })).body;
  }

  async function reply(client: ApiClient, published: PublishResponse, threadId: string, body: string): Promise<void> {
    clock.advance(1_000);
    const response = await client.fetch(
      `/api/v1/artifacts/${published.artifact.id}/comments/${threadId}/replies?projectId=${published.artifact.projectId}`,
      {body: JSON.stringify({body}), idempotencyKey: `people-reply-${body.length}-${threadId}`, method: "POST"},
    );
    expect(response.status).toBe(201);
  }

  test("ACT-008-B: the feed narrows to the people chosen, and the filter row counts everyone, every entry and the matches", async () => {
    expect.hasAssertions();
    const stage = await publish("Stage bar");
    const inspector = await publish("Inspector study");
    clock.advance(1_000);
    await rosa.openThread(stage, "Rosa opens this.", "people-rosa-thread");
    clock.advance(1_000);
    const handed = await local.openThread(inspector, "Local opens this.", "people-local-thread");
    // The newest reply decides whose conversation it is now, as the feed dates it.
    await reply(rosa, inspector, handed.id, "Rosa answers last.");
    clock.advance(1_000);
    await local.openThread(stage, "Local keeps this one.", "people-local-kept");

    const everyone = await facets(local);
    const byName = new Map(everyone.people.map((person) => [person.name, person]));
    expect([...byName.keys()].toSorted()).toEqual(["Local", "Rosa Santoro"]);
    expect(byName.get("Rosa Santoro")).toMatchObject({count: 2, kind: "service"});
    expect(byName.get("Local")).toMatchObject({count: 3, kind: "service"});
    // Most active first.
    expect(everyone.people.map((person) => person.name)).toEqual(["Local", "Rosa Santoro"]);
    expect(everyone.total).toBe((await walk(local, "")).length);
    expect(everyone.matching).toBe(everyone.total);

    const rosaId = byName.get("Rosa Santoro")?.id ?? "";
    const rosaQuery = activityQueryString({people: [rosaId]});
    expect(rosaQuery).toBe(`?person=${encodeURIComponent(rosaId)}`);
    const rosaEntries = await walk(local, rosaQuery);
    expect(rosaEntries.map((entry) => [entry.kind, entry.actor.name, entry.thread?.opener.body])).toEqual([
      ["thread", "Rosa Santoro", "Local opens this."],
      ["thread", "Rosa Santoro", "Rosa opens this."],
    ]);
    const narrowed = await facets(local, rosaQuery);
    expect([narrowed.matching, narrowed.total]).toEqual([rosaEntries.length, everyone.total]);
    // Other filters never change who the menu offers or how many entries each has.
    expect(narrowed.people).toEqual(everyone.people);

    const both = activityQueryString({people: [rosaId, byName.get("Local")?.id ?? ""], types: ["versions"]});
    const versions = await walk(local, both);
    expect(versions.map((entry) => [entry.kind, entry.artifact?.name])).toEqual([
      ["version", "Inspector study"],
      ["version", "Stage bar"],
    ]);
    expect((await facets(local, both)).matching).toBe(2);

    // One person with a type: Rosa published nothing, so her versions are none.
    const rosaVersions = activityQueryString({people: [rosaId], types: ["versions"]});
    expect(await walk(local, rosaVersions)).toEqual([]);
    const rosaVersionCounts = await facets(local, rosaVersions);
    expect([rosaVersionCounts.matching, rosaVersionCounts.total]).toEqual([0, everyone.total]);
    expect(rosaVersionCounts.people).toEqual(everyone.people);
  });

  test("ACT-008: an administrator's own administration counts for them alone; a member never sees it", async () => {
    expect.hasAssertions();
    await publish("Visibility seed");
    const asAdministrator = await fetch(`${server.baseUrl}/api/v1/activity/facets`, {headers: {Cookie: administrator.header}});
    expect(asAdministrator.status).toBe(200);
    const adminView = activityFacetsSchema.parse(await asAdministrator.json());
    const issuer = adminView.people.find((person) => person.kind === "human");
    // Issuing Rosa's key is the administrator's only action, and only administrators read it.
    const issued = await fetch(`${server.baseUrl}/api/v1/activity?person=${issuer?.id ?? ""}`, {headers: {Cookie: administrator.header}});
    const issuedEntries = activityPageSchema.parse(await issued.json()).items;
    expect(issuedEntries.map((entry) => [entry.kind, entry.verb, entry.subject?.name])).toEqual([["admin", "issued", "Rosa Santoro"]]);
    expect(issuer?.count).toBe(issuedEntries.length);
    const memberView = await facets(local);
    expect(memberView.people.some((person) => person.id === issuer?.id)).toBe(false);
    expect(memberView.total).toBeLessThanOrEqual(adminView.total - issuedEntries.length);
    expect(await walk(local, `?person=${issuer?.id ?? ""}`)).toEqual([]);
  });

  test("ACT-008-F: unknown people match nothing without disclosing anyone, and hostile people filters are refused", async () => {
    expect.hasAssertions();
    await publish("Hostile seed");
    expect(await walk(local, "?person=member_never_admitted")).toEqual([]);
    const unknown = await facets(local, "?person=member_never_admitted");
    expect(unknown.matching).toBe(0);
    expect(unknown.total).toBeGreaterThan(0);

    const hostile = [
      `?person=${encodeURIComponent("../../etc")}`,
      `?person=${encodeURIComponent("x' OR '1'='1")}`,
      "?person=",
      `?${Array.from({length: 51}, (_, index) => `person=member_${index}`).join("&")}`,
    ];
    const answers = await Promise.all(hostile.flatMap((query) => [
      local.fetch(`/api/v1/activity${query}`),
      local.fetch(`/api/v1/activity/facets${query}`),
    ]));
    const bodies = await Promise.all(answers.map(async (response) => ({
      code: failureSchema.parse(await response.json()).error.code,
      status: response.status,
    })));
    expect(bodies).toEqual(answers.map(() => ({code: "INVALID_INPUT", status: 422})));
  });

  test("ACT-008: anonymous and capability-less callers cannot read the counts", async () => {
    expect.hasAssertions();
    expect((await fetch(`${server.baseUrl}/api/v1/activity/facets`)).status).toBe(401);
    const connectOnly = new ApiClient(server, await issueApiKey(server, administrator, ["agent:connect"], "Connect only"));
    expect((await connectOnly.fetch("/api/v1/activity/facets")).status).toBe(403);
  });
});
