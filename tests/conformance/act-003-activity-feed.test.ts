import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {ApiClient, MutableClock} from "../support/agent-dispatch.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
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

  async function publish(key: string, name: string): Promise<PublishResponse> {
    return (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: `<p>${name}</p>`,
      idempotencyKey: key,
      name,
    })).body;
  }
});

/** Read one feed page with the given query string ("" or "?…"). */
export async function readFeed(
  client: ApiClient,
  query: string,
): Promise<ActivityPageBody> {
  const response = await client.fetch(`/api/v1/activity${query}`);
  expect(response.status).toBe(200);
  return activityPageSchema.parse(await response.json());
}
