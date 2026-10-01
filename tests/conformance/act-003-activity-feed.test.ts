import {Effect, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {BearerCredentialVerifier} from "../../src/application/authentication.js";
import {AuthenticationRequired} from "../../src/core/errors.js";
import {membershipRoles, principalKinds, type MembershipRole} from "../../src/core/identity.js";
import {ApiClient, issueApiKey, MutableClock, signInAdministrator} from "../support/agent-dispatch.js";
import {publishNew, publishVersion, type PublishResponse} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const wireCommentSchema = z.object({
  author: z.object({
    kind: z.enum(["human", "service"]),
    name: z.string(),
  }).strict(),
  body: z.string(),
  createdAt: z.iso.datetime(),
  id: z.string(),
}).strict();
const entrySchema = z.object({
  access: z.object({
    from: z.enum(["account_required", "public_link"]).nullable(),
    to: z.enum(["account_required", "public_link"]),
  }).strict().optional(),
  actor: z.object({
    kind: z.enum(["human", "service"]).nullable(),
    name: z.string().nullable(),
  }).strict(),
  agent: z.object({
    dispatchState: z.string(),
    name: z.string(),
    threadIds: z.array(z.string()),
  }).strict().optional(),
  artifact: z.object({
    archived: z.boolean(),
    id: z.string(),
    name: z.string(),
  }).strict().nullable(),
  at: z.iso.datetime(),
  excerpt: z.string().optional(),
  id: z.string(),
  kind: z.enum([
    "thread",
    "version",
    "resolution",
    "thread_deleted",
    "agent",
    "access",
    "admin",
  ]),
  project: z.object({id: z.string(), name: z.string()}).strict().nullable(),
  subject: z.object({id: z.string(), name: z.string().nullable()}).strict()
    .optional(),
  thread: z.object({
    anchor: z.unknown(),
    id: z.string(),
    isResolved: z.boolean(),
    opener: wireCommentSchema,
    replies: z.array(wireCommentSchema),
    replyCount: z.number().int().nonnegative(),
    state: z.enum(["needs_you", "with_agent", "resolved"]),
  }).strict().optional(),
  threadId: z.string().optional(),
  verb: z.string(),
  versionNumber: z.number().int().positive().nullable(),
}).strict();
export const activityPageSchema = z.object({
  items: z.array(entrySchema),
  nextCursor: z.string().nullable(),
}).strict();
export type ActivityPageBody = z.infer<typeof activityPageSchema>;

describe("installation activity feed", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let clock: MutableClock;
  let reader: ApiClient;

  beforeEach(async () => {
    installation = await createTestInstallation();
    clock = new MutableClock("2026-10-01T12:00:00.000Z");
    server = await startTestServer(installation, {clock});
    reader = new ApiClient(server, installation.apiToken);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("ACT-003-B: the feed lists publishes and conversations newest first with actor names", async () => {
    expect.hasAssertions();
    const published = await publish("feed-first-publish-key", "Stage bar walkthrough");
    clock.advance(1_000);
    await reader.openThread(
      published,
      "The stage bar overlaps the header.",
      "feed-first-thread",
    );
    clock.advance(1_000);

    const page = await readFeed(reader, "");
    const visible = page.items.filter((entry) => entry.kind !== "admin");

    expect(visible.map((entry) => [entry.kind, entry.verb, entry.artifact?.name]))
      .toEqual([
        ["thread", "commented", "Stage bar walkthrough"],
        ["version", "published", "Stage bar walkthrough"],
      ]);
    expect(visible[0]?.actor).toEqual({kind: "service", name: "Local"});
    expect(visible[0]?.thread?.opener.body).toBe("The stage bar overlaps the header.");
    expect(visible[0]?.thread?.state).toBe("needs_you");
    expect(visible[1]?.versionNumber).toBe(1);
    expect(visible[1]?.project).toEqual({
      id: published.artifact.projectId,
      name: expect.any(String),
    });
    expect(page.nextCursor).toBeNull();
  });

  test("ACT-003: a thread is one entry dated by its newest reply and carries its newest two replies", async () => {
    expect.hasAssertions();
    const published = await publish("feed-fold", "Inspector docking study");
    clock.advance(1_000);
    const thread = await reader.openThread(published, "Opening note", "feed-fold-thread");
    await inSequence(["first", "second", "third"], async (body, index) => {
      clock.advance(1_000);
      await reply(published, thread.id, body, `feed-fold-reply-${index}`);
    });
    clock.advance(1_000);
    await publishVersion(server, installation, {
      artifactId: published.artifact.id,
      content: "<p>v2</p>",
      expectedCurrentVersionId: published.version.id,
      idempotencyKey: "feed-fold-version-2",
      projectId: published.artifact.projectId,
    });
    clock.advance(1_000);
    await reply(published, thread.id, "fourth", "feed-fold-reply-3");

    const entries = (await readFeed(reader, "?type=comments&type=versions")).items;

    expect(entries.map((entry) => entry.kind)).toEqual(["thread", "version", "version"]);
    const folded = entries[0];
    expect(folded?.verb).toBe("replied");
    expect(folded?.thread?.replyCount).toBe(4);
    expect(folded?.thread?.replies.map((comment) => comment.body)).toEqual(["third", "fourth"]);
    expect(entries.filter((entry) => entry.thread?.id === thread.id)).toHaveLength(1);
  });

  test("ACT-003: type and project filters narrow the feed", async () => {
    expect.hasAssertions();
    const first = await publish("feed-filter-a", "Claims workstation");
    const otherProjectId = await reader.createProject("Records retention", "feed-filter-project");
    clock.advance(1_000);
    const second = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<p>Retention</p>",
      idempotencyKey: "feed-filter-b-publication",
      name: "Retention schedule",
      projectId: otherProjectId,
    })).body;
    clock.advance(1_000);
    await reader.openThread(first, "Check the claim totals.", "feed-filter-thread");

    const versionsOnly = await readFeed(reader, "?type=versions");
    expect(versionsOnly.items.map((entry) => entry.kind)).toEqual(["version", "version"]);

    const scoped = await readFeed(reader, `?project=${otherProjectId}`);
    expect(scoped.items.filter((entry) => entry.kind !== "admin")
      .map((entry) => entry.artifact?.id)).toEqual([second.artifact.id]);

    const unknown = await readFeed(reader, "?project=prj_does_not_exist");
    expect(unknown).toEqual({items: [], nextCursor: null});
  });

  test("ACT-003: segments split open threads by whether an active dispatch holds them", async () => {
    expect.hasAssertions();
    const administrator = await signInAdministrator(server, installation);
    const agentToken = await issueApiKey(
      server,
      administrator,
      ["agent:connect", "artifact:read", "comment:write"],
      "Codex bridge",
    );
    const agent = new ApiClient(server, agentToken);
    const registered = await agent.registerAgent({
      connectionKey: "feed-segment-agent",
      displayName: "Codex",
      workingDirectory: "/work",
    });
    const published = await publish("feed-segment", "Stage bar walkthrough");
    clock.advance(1_000);
    const held = await reader.openThread(published, "Send me to Codex", "feed-segment-held");
    clock.advance(1_000);
    const waiting = await reader.openThread(published, "Waiting on a person", "feed-segment-wait");
    clock.advance(1_000);
    const sent = await reader.sendDispatch({
      agentId: registered.id,
      idempotencyKey: "feed-segment-dispatch",
      projectId: published.artifact.projectId,
      threadIds: [held.id],
    });
    expect(sent.status).toBe(201);

    const needsYou = await readFeed(reader, "?segment=needs_you");
    expect(needsYou.items.map((entry) => entry.thread?.id)).toEqual([waiting.id]);
    expect(needsYou.items[0]?.thread?.state).toBe("needs_you");

    const withAgent = await readFeed(reader, "?segment=with_agent");
    expect(withAgent.items.map((entry) => entry.kind)).toEqual(["agent", "thread"]);
    expect(withAgent.items[0]?.agent).toEqual({
      dispatchState: "queued",
      name: "Codex",
      threadIds: [held.id],
    });
    expect(withAgent.items[1]?.thread?.id).toBe(held.id);
    expect(withAgent.items[1]?.thread?.state).toBe("with_agent");
  });

  test("ACT-003: search matches actor, artifact, project and comment text literally", async () => {
    expect.hasAssertions();
    const published = await publish("feed-search", "Quarterly revenue");
    clock.advance(1_000);
    await reader.openThread(published, "Axis label reads 100%_off", "feed-search-thread");

    const byName = await readFeed(reader, "?q=quarterly&type=comments&type=versions");
    expect(byName.items.map((entry) => entry.kind)).toEqual(["thread", "version"]);
    expect(byName.items.every((entry) => entry.artifact?.name === "Quarterly revenue"))
      .toBe(true);
    expect((await readFeed(reader, `?q=${encodeURIComponent("100%_off")}`)).items
      .map((entry) => entry.kind)).toEqual(["thread"]);
    expect((await readFeed(reader, `?q=${encodeURIComponent("%")}`)).items
      .map((entry) => entry.kind)).toEqual(["thread"]);
    expect((await readFeed(reader, "?q=local")).items.length).toBeGreaterThan(0);
    expect((await readFeed(reader, "?q=nothing-matches-this")).items).toEqual([]);
  });

  test("ACT-003: pages walk the feed without gaps or duplicates", async () => {
    expect.hasAssertions();
    await inSequence([0, 1, 2, 3, 4], async (index) => {
      clock.advance(1_000);
      await publish(`feed-page-${index}`, `Artifact ${index}`);
    });
    const seen: string[] = [];
    // Follow cursors page by page until the feed reports no further page.
    const walk = async (query: string, remaining: number): Promise<void> => {
      const page = await readFeed(reader, query);
      seen.push(...page.items.map((entry) => entry.id));
      if (page.nextCursor === null || remaining <= 1) return;
      await walk(`?type=versions&limit=2&cursor=${page.nextCursor}`, remaining - 1);
    };
    await walk("?type=versions&limit=2", 4);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  test("ACT-003-F: a thread replied to across a page boundary appears exactly once", async () => {
    expect.hasAssertions();
    const published = await publish("feed-boundary", "Boundary study");
    const threads: {readonly id: string}[] = [];
    await inSequence(["A", "B", "C", "D"], async (name) => {
      clock.advance(1_000);
      threads.push(await reader.openThread(published, `Thread ${name}`, `feed-boundary-thread-${name}`));
    });
    const [threadA, threadB, threadC, threadD] = threads;
    const firstPage = await readFeed(reader, "?type=comments&limit=2");
    expect(firstPage.items.map((entry) => entry.thread?.id)).toEqual([threadD?.id, threadC?.id]);

    clock.advance(1_000);
    await reply(published, threadC?.id ?? "", "moves C to the top", "feed-boundary-reply-c");
    clock.advance(1_000);
    await reply(published, threadA?.id ?? "", "moves A to the top", "feed-boundary-reply-a");

    const secondPage = await readFeed(
      reader,
      `?type=comments&limit=2&cursor=${firstPage.nextCursor ?? ""}`,
    );
    expect(secondPage.items.map((entry) => entry.thread?.id)).toEqual([threadB?.id]);
    const staleTraversal = [...firstPage.items, ...secondPage.items]
      .map((entry) => entry.thread?.id);
    expect(new Set(staleTraversal).size).toBe(staleTraversal.length);

    const fresh = await readFeed(reader, "?type=comments&limit=10");
    expect(fresh.items.map((entry) => entry.thread?.id))
      .toEqual([threadA?.id, threadC?.id, threadD?.id, threadB?.id]);
  });

  test("ACT-003: hostile comment text stays byte-exact, searchable and well-formed", async () => {
    expect.hasAssertions();
    const published = await publish("feed-hostile-text", "Hostile text");
    const hostile = `‮evil‬ zero​width ' OR 1=1 -- `.padEnd(8_192, "x");
    clock.advance(1_000);
    await reader.openThread(published, hostile, "feed-hostile-thread");
    const oversized = await reader.fetch(
      `/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/comments` +
        `?projectId=${published.artifact.projectId}`,
      {
        body: JSON.stringify({body: "y".repeat(10_000), path: "index.html"}),
        idempotencyKey: "feed-hostile-oversized",
        method: "POST",
      },
    );
    expect(oversized.status).toBe(422);

    const page = await readFeed(reader, `?q=${encodeURIComponent("' OR 1=1 --")}`);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.thread?.opener.body).toBe(hostile);
    const everything = await readFeed(reader, "?type=comments");
    expect(everything.items).toHaveLength(1);
  });

  async function reply(
    published: PublishResponse,
    threadId: string,
    body: string,
    key: string,
  ): Promise<void> {
    const response = await reader.fetch(
      `/api/v1/artifacts/${published.artifact.id}/comments/${threadId}/replies` +
        `?projectId=${published.artifact.projectId}`,
      {body: JSON.stringify({body}), idempotencyKey: key, method: "POST"},
    );
    expect(response.status).toBe(201);
  }

  async function publish(key: string, name: string): Promise<PublishResponse> {
    return (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: `<p>${name}</p>`,
      idempotencyKey: `${key}-publication`,
      name,
    })).body;
  }
});

/** Run `step` for each item strictly in order: feed timestamps depend on it. */
async function inSequence<Item>(
  items: readonly Item[],
  step: (item: Item, index: number) => Promise<void>,
): Promise<void> {
  await items.reduce<Promise<void>>(
    (previous, item, index) => previous.then(() => step(item, index)),
    Promise.resolve(),
  );
}

/** Read one feed page with the given query string ("" or "?…"). */
export async function readFeed(
  client: ApiClient,
  query: string,
): Promise<ActivityPageBody> {
  const response = await client.fetch(`/api/v1/activity${query}`);
  expect(response.status).toBe(200);
  return activityPageSchema.parse(await response.json());
}

describe("activity visibility", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let role: MembershipRole;
  let active: boolean;
  const roleToken = "activity-visibility-flippable-administrator";

  beforeEach(async () => {
    installation = await createTestInstallation();
    role = membershipRoles.administrator;
    active = true;
    server = await startTestServer(installation, {
      externalApiBearerVerifier: flippableVerifier(),
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("ACT-003: administrators see member and key events with subject names; members do not", async () => {
    expect.hasAssertions();
    const administrator = await signInAdministrator(server, installation);
    const admitted = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({displayName: "Rosa Santoro", email: "rosa@example.test"}),
      headers: cookieHeaders(server, administrator),
      method: "POST",
    });
    expect(admitted.status).toBe(201);

    const adminView = await fetch(`${server.baseUrl}/api/v1/activity?type=admin`, {
      headers: {Cookie: administrator.header},
    });
    expect(adminView.status).toBe(200);
    const adminPage = activityPageSchema.parse(await adminView.json());
    expect(adminPage.items.find((entry) => entry.verb === "admitted")?.subject?.name)
      .toBe("Rosa Santoro");

    const memberPage = await readFeed(new ApiClient(server, installation.apiToken), "?type=admin");
    expect(memberPage.items.some((entry) =>
      entry.verb === "admitted" || entry.verb === "issued"
    )).toBe(false);
  });

  test("ACT-003: an administrator demoted mid-session stops seeing member and key events on the next request", async () => {
    expect.hasAssertions();
    const administrator = await signInAdministrator(server, installation);
    await issueApiKey(server, administrator, ["artifact:read"], "Reader key");
    const flipping = new ApiClient(server, roleToken);

    const before = await readFeed(flipping, "?type=admin");
    expect(before.items.some((entry) => entry.verb === "issued")).toBe(true);

    role = membershipRoles.member;
    const after = await readFeed(flipping, "?type=admin");
    expect(after.items.some((entry) => entry.verb === "issued")).toBe(false);

    active = false;
    const refused = await flipping.fetch("/api/v1/activity");
    expect(refused.status).toBe(401);
  });

  function flippableVerifier(): BearerCredentialVerifier {
    return {
      verify: (credential) => Effect.suspend(() => {
        if (Redacted.value(credential) !== roleToken || !active) {
          return Effect.fail(new AuthenticationRequired({
            message: "The activity credential is invalid.",
          }));
        }
        return Effect.succeed({
          authorizedByPrincipalId: null,
          capabilities: [],
          displayName: "Marc Delacroix",
          id: "member_flippable",
          installationId: "local",
          kind: principalKinds.human,
          membershipRole: role,
        });
      }),
    };
  }
});

function cookieHeaders(
  server: RunningTestServer,
  cookies: {readonly csrf: string; readonly header: string},
): Headers {
  return new Headers({
    "Content-Type": "application/json",
    Cookie: cookies.header,
    Origin: server.baseUrl,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": cookies.csrf,
  });
}
