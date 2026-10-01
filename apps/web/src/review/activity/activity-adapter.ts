import type {ActivityEntry} from "@/api/client";
import {reviewAnchorSchema} from "@/review-frame/protocol";
import {type ActivityDayGroup, type ActivityEntryOf, groupByDay, groupEntries, mergeBursts, sortEvents} from "@/ui/activity-model";
import type {ActivityArtifactGroup, ActivityEntry as OpenedEntry, ActivityEvent} from "@/ui/review-ui";

type WireComment = NonNullable<ActivityEntry["thread"]>["opener"];
type VendoredThread = NonNullable<ActivityEvent["thread"]>;

/**
 * A conversation as the vendored card reads it: the declared shape plus the instants its
 * bylines print, the version it is on and its page (null for the whole version).
 */
type FeedThread = VendoredThread & {
  readonly atMs: number;
  readonly path: string | null;
  readonly replies: (VendoredThread["replies"][number] & {readonly atMs: number})[];
  readonly version?: number;
};

/** One vendored-model event plus the API entry it came from (for Open, Reply and thumbnails). */
export type FeedEvent = ActivityEvent & {readonly entry: ActivityEntry; readonly thread?: FeedThread};

/** One feed row: an event, one actor's burst, or an artifact's day of conversations. */
export type FeedEntry = ActivityEntryOf<FeedEvent>;

const unknownActor = "Unknown";
const notRecorded = "—";
const accessLabels = {account_required: "Account required", public_link: "Public link"} as const;
const dispatchLabels = {addressed: "Answered", canceled: "Canceled", claimed: "Claimed", delivered: "Delivered", failed: "Failed", queued: "Queued"} as const;
const activeDispatch = new Set(["queued", "claimed", "delivered"]);
const adminWords = new Map<string, {readonly icon: string; readonly verb: string}>([
  ["admitted", {icon: "bi-person-plus", verb: "admitted"}],
  ["archived", {icon: "bi-archive", verb: "archived the project"}],
  ["created", {icon: "bi-folder-plus", verb: "created the project"}],
  ["deactivated", {icon: "bi-person-dash", verb: "deactivated"}],
  ["issued", {icon: "bi-key", verb: "issued the API key"}],
  ["revoked", {icon: "bi-key", verb: "revoked the API key"}],
  ["rotated", {icon: "bi-arrow-repeat", verb: "rotated the API key"}],
  ["unarchived", {icon: "bi-folder2-open", verb: "unarchived the project"}],
]);

const instant = (iso: string): number => {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) || !/^\d{4}-\d{2}-\d{2}T/u.test(iso) ? Number.NaN : parsed;
};
const firstLine = (text: string): string => text.split("\n")[0] ?? "";

/** The fields every event shares, plus the artifact, project and version facts the entry records. */
type SharedFields = Pick<ActivityEvent,
  "actor" | "adminOnly" | "archived" | "artifactId" | "artifactName" | "at" | "needsYou"
  | "projectId" | "projectName" | "version" | "withAgent"> & {readonly entry: ActivityEntry};

function about(entry: ActivityEntry): SharedFields {
  const fields: SharedFields = {
    actor: entry.actor.name ?? unknownActor,
    adminOnly: false,
    archived: entry.artifact?.archived ?? false,
    at: instant(entry.at),
    entry,
    needsYou: false,
    withAgent: false,
  };
  if (entry.artifact !== null) {
    fields.artifactId = entry.artifact.id;
    fields.artifactName = entry.artifact.name;
  }
  if (entry.project !== null) {
    fields.projectId = entry.project.id;
    fields.projectName = entry.project.name;
  }
  if (entry.versionNumber !== null) fields.version = entry.versionNumber;
  return fields;
}

const shown = (record: WireComment) => ({at: record.createdAt, atMs: instant(record.createdAt), author: record.author.name, body: record.body, id: record.id});

function feedThread(entry: ActivityEntry, thread: NonNullable<ActivityEntry["thread"]>): FeedThread {
  const base = {...shown(thread.opener), isResolved: thread.isResolved, key: thread.id, path: thread.path, replies: thread.replies.map(shown)};
  return entry.versionNumber === null ? base : {...base, version: entry.versionNumber};
}

/** A conversation entry whose conversation is gone still shows, as a plain line naming the artifact. */
function withoutConversation(shared: SharedFields, entry: ActivityEntry, icon: string, verb: string): FeedEvent {
  return {...shared, detail: entry.artifact?.name ?? notRecorded, icon, id: `gone:${entry.id}`, type: "admin", verb};
}

function toFeedEvent(entry: ActivityEntry): FeedEvent {
  const shared = about(entry);
  switch (entry.kind) {
    case "thread": {
      const thread = entry.thread;
      if (thread === undefined) return withoutConversation(shared, entry, "bi-chat-left-text", "commented on");
      return {
        ...shared, excerpt: firstLine(thread.opener.body), id: `comment:${thread.id}`,
        needsYou: thread.state === "needs_you",
        thread: feedThread(entry, thread),
        type: "comment", verb: entry.verb === "replied" ? "replied on" : "commented on", withAgent: thread.state === "with_agent",
      };
    }
    case "version":
      return {...shared, fromVersion: entry.versionNumber !== null && entry.versionNumber > 1 ? entry.versionNumber - 1 : null,
        id: `version:${entry.id}`, type: "version", verb: entry.verb === "restored" ? "restored" : "published"};
    case "resolution": {
      // The vendored card draws a resolution inside its conversation, so it needs the thread.
      const verb = `${entry.verb} a conversation on`;
      if (entry.thread === undefined) return withoutConversation(shared, entry, "bi-check2-circle", verb);
      return {...shared, excerpt: entry.excerpt ?? firstLine(entry.thread.opener.body), id: `resolution:${entry.id}`,
        thread: feedThread(entry, entry.thread), type: "resolution", verb};
    }
    case "thread_deleted":
      return {...shared, detail: entry.artifact?.name ?? notRecorded, icon: "bi-trash", id: `deleted:${entry.id}`, type: "admin", verb: "deleted a conversation on"};
    case "agent": {
      const agent = entry.agent;
      if (agent === undefined) return {...shared, id: `agent:${entry.id}`, type: "agent", verb: "sent conversations on"};
      return {...shared, agent: agent.name, id: `agent:${entry.id}`, state: dispatchLabels[agent.dispatchState],
        type: "agent", verb: entry.verb === "answered" ? "answered conversations on" : "sent conversations on", withAgent: activeDispatch.has(agent.dispatchState)};
    }
    case "access":
      return {...shared, from: entry.access?.from === null || entry.access === undefined ? notRecorded : accessLabels[entry.access.from],
        id: `access:${entry.id}`, to: entry.access === undefined ? notRecorded : accessLabels[entry.access.to], type: "access", verb: "changed access on"};
    // An entry kind this client does not know yet still shows, as an administration line.
    case "admin":
    default: {
      const words = adminWords.get(entry.verb) ?? {icon: "bi-gear", verb: entry.verb};
      const adminOnly = entry.verb !== "created" && entry.verb !== "archived" && entry.verb !== "unarchived";
      return {...shared, adminOnly, detail: entry.subject?.name ?? notRecorded, icon: words.icon, id: `admin:${entry.id}`, type: "admin", verb: words.verb};
    }
  }
}

/** Map API entries to the vendored feed's events, keeping the server's newest-first order. */
export function toFeedEvents(entries: readonly ActivityEntry[]): FeedEvent[] {
  return entries.map(toFeedEvent);
}

/** Newest first (unreadable times last), then consecutive version bursts merged. */
export function mergedFeed(events: readonly FeedEvent[]): FeedEvent[] {
  return mergeBursts(sortEvents(events));
}

/**
 * The feed's rows from already merged events (`mergedFeed`): bursts and each day's conversations
 * per artifact grouped. Merging twice would reset each merged span's count, so this never merges.
 */
export function feedEntries(merged: readonly FeedEvent[]): FeedEntry[] {
  return groupEntries(merged);
}

/** Where Open goes: an artifact, and the conversation to select in it when there is one. */
export interface OpenTarget {
  readonly artifactId: string;
  readonly path: string | null;
  readonly projectId: string;
  readonly threadId: string | null;
  readonly versionId: string | null;
}

/**
 * The event an entry opens: a burst's newest item (the feed opens each item itself), an artifact
 * group's newest conversation, or the event. The vendored feed hands back the objects it was
 * given, so the event is recovered by id from the events the host passed.
 */
function eventToOpen(entry: OpenedEntry, byEvent: ReadonlyMap<string, FeedEvent>): FeedEvent | undefined {
  if ("kind" in entry && entry.kind === "burst") return entry.items[0] === undefined ? undefined : byEvent.get(entry.items[0].id);
  if ("kind" in entry && entry.kind === "artifact") {
    const newest = entry.threads[0] ?? entry.events[0];
    return newest === undefined ? undefined : byEvent.get(newest.id);
  }
  return byEvent.get(entry.id);
}

/** The workspace location an entry opens, or null when it names no artifact. */
export function openTarget(entry: OpenedEntry, byEvent: ReadonlyMap<string, FeedEvent>): OpenTarget | null {
  const api = eventToOpen(entry, byEvent)?.entry;
  if (api === undefined || api.artifact === null || api.project === null) return null;
  return {
    artifactId: api.artifact.id, path: api.thread?.path ?? null, projectId: api.project.id,
    threadId: api.thread?.id ?? api.threadId ?? null, versionId: api.thread?.versionId ?? null,
  };
}

const placesPin = (entry: ActivityEntry): boolean => {
  const anchor = reviewAnchorSchema.safeParse(entry.thread?.anchor);
  return anchor.success && anchor.data.htmlAnchor !== null;
};

/**
 * The conversation an artifact card's thumbnail draws: its newest one with a pin on the page,
 * else its newest one, whose exact version is then drawn without a pin.
 */
export function thumbnailEntry(group: ActivityArtifactGroup, byEvent: ReadonlyMap<string, FeedEvent>): ActivityEntry | null {
  const entries = group.threads.flatMap((thread) => byEvent.get(thread.id)?.entry ?? []).filter((entry) => entry.thread !== undefined);
  return entries.find(placesPin) ?? entries[0] ?? null;
}

/** The merged feed grouped under day headers, exactly as the vendored feed renders it. */
export function feedGroups(events: readonly FeedEvent[], now: number): ActivityDayGroup<FeedEvent>[] {
  return groupByDay(mergedFeed(events), now);
}
