import { z } from "zod";

const accessSettingSchema = z.enum(["account_required", "public_link"]);
const principalKindSchema = z.enum(["human", "service"]);
const dispatchStateSchema = z.enum([
  "addressed",
  "canceled",
  "claimed",
  "delivered",
  "failed",
  "queued",
]);

export const activityTypes = ["comments", "versions", "agents", "access", "admin"] as const;
export const activitySegments = ["all", "needs_you", "with_agent"] as const;
export type ActivityType = (typeof activityTypes)[number];
export type ActivitySegment = (typeof activitySegments)[number];

const wireCommentSchema = z.object({
  author: z.object({ kind: principalKindSchema, name: z.string() }),
  body: z.string(),
  createdAt: z.string(),
  id: z.string(),
});

export const activityEntrySchema = z.object({
  access: z.object({ from: accessSettingSchema.nullable(), to: accessSettingSchema }).optional(),
  actor: z.object({ kind: principalKindSchema.nullable(), name: z.string().nullable() }),
  agent: z.object({
    dispatchState: dispatchStateSchema,
    name: z.string(),
    threadIds: z.array(z.string()),
  }).optional(),
  artifact: z.object({ archived: z.boolean(), id: z.string(), name: z.string() }).nullable(),
  at: z.string(),
  excerpt: z.string().optional(),
  id: z.string(),
  kind: z.enum(["thread", "version", "resolution", "thread_deleted", "agent", "access", "admin"]),
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
  subject: z.object({ id: z.string(), name: z.string().nullable() }).optional(),
  thread: z.object({
    anchor: z.json().nullable(),
    id: z.string(),
    isResolved: z.boolean(),
    opener: wireCommentSchema,
    path: z.string().nullable(),
    replies: z.array(wireCommentSchema),
    replyCount: z.number().int().nonnegative(),
    state: z.enum(["needs_you", "with_agent", "resolved"]),
    versionId: z.string(),
  }).optional(),
  threadId: z.string().optional(),
  verb: z.string(),
  versionNumber: z.number().int().positive().nullable(),
});

export const activityPageSchema = z.object({
  items: z.array(activityEntrySchema),
  nextCursor: z.string().nullable(),
});

export const activitySummarySchema = z.object({
  artifactsInReview: z.number().int().nonnegative(),
  needsYou: z.number().int().nonnegative(),
  openConversations: z.number().int().nonnegative(),
  projects: z.array(z.object({
    artifactCount: z.number().int().nonnegative(),
    id: z.string(),
    lastActivityAt: z.string().nullable(),
    unresolved: z.number().int().nonnegative(),
  })),
  withAgent: z.number().int().nonnegative(),
});

/** Counts behind the Activity filter row, in feed entries (one per conversation). */
export const activityFacetsSchema = z.object({
  /** Entries matching the request's filters. */
  matching: z.number().int().nonnegative(),
  /** Everyone with a visible entry, whatever else is filtered; most active first. */
  people: z.array(z.object({
    count: z.number().int().nonnegative(),
    id: z.string(),
    kind: principalKindSchema,
    name: z.string(),
  })),
  /** Every visible entry, whatever is filtered. */
  total: z.number().int().nonnegative(),
});

export type ActivityEntry = z.infer<typeof activityEntrySchema>;
export type ActivityFacets = z.infer<typeof activityFacetsSchema>;
export type ActivityPageResponse = z.infer<typeof activityPageSchema>;
export type ActivitySummary = z.infer<typeof activitySummarySchema>;

export interface ActivityListParams {
  readonly cursor?: string | null;
  readonly limit?: number;
  /** Principal IDs whose entries to keep; empty keeps everyone. */
  readonly people?: readonly string[];
  readonly projects?: readonly string[];
  readonly q?: string;
  readonly segment?: ActivitySegment;
  readonly types?: readonly ActivityType[];
}

/** Serialize feed parameters in a stable order; empty values are omitted. */
export function activityQueryString(params: ActivityListParams): string {
  const search = new URLSearchParams();
  for (const project of params.projects ?? []) search.append("project", project);
  for (const type of params.types ?? []) search.append("type", type);
  for (const person of params.people ?? []) search.append("person", person);
  if (params.segment !== undefined) search.set("segment", params.segment);
  const q = params.q?.trim() ?? "";
  if (q !== "") search.set("q", q);
  if (params.cursor !== undefined && params.cursor !== null) search.set("cursor", params.cursor);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  const serialized = search.toString();
  return serialized === "" ? "" : `?${serialized}`;
}
