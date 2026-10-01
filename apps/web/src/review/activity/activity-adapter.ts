import type {ActivityEntry} from "@/api/client";

type WireComment = NonNullable<ActivityEntry["thread"]>["opener"];
import {type ActivityDayGroup, groupByDay, mergeBursts, sortEvents} from "@/ui/activity-model";
import type {ActivityEvent} from "@/ui/review-ui";

/** One vendored-model event plus the API entry it came from (for Open, Reply and thumbnails). */
export type FeedEvent = ActivityEvent & {readonly entry: ActivityEntry};

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

const shown = (record: WireComment) => ({at: record.createdAt, author: record.author.name, body: record.body, id: record.id});

function toFeedEvent(entry: ActivityEntry): FeedEvent {
  const shared = about(entry);
  switch (entry.kind) {
    case "thread": {
      const thread = entry.thread;
      if (thread === undefined) return {...shared, id: `comment:${entry.id}`, type: "comment", verb: "commented on"};
      return {
        ...shared, excerpt: firstLine(thread.opener.body), id: `comment:${thread.id}`,
        needsYou: thread.state === "needs_you",
        thread: {...shown(thread.opener), isResolved: thread.isResolved, key: thread.id, replies: thread.replies.map(shown)},
        type: "comment", verb: entry.verb === "replied" ? "replied on" : "commented on", withAgent: thread.state === "with_agent",
      };
    }
    case "version":
      return {...shared, fromVersion: entry.versionNumber !== null && entry.versionNumber > 1 ? entry.versionNumber - 1 : null,
        id: `version:${entry.id}`, type: "version", verb: entry.verb === "restored" ? "restored" : "published"};
    case "resolution":
      return {...shared, excerpt: entry.excerpt ?? "", id: `resolution:${entry.id}`, type: "resolution", verb: `${entry.verb} a conversation on`};
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

/** The merged feed grouped under day headers, exactly as the vendored feed renders it. */
export function feedGroups(events: readonly FeedEvent[], now: number): ActivityDayGroup<FeedEvent>[] {
  return groupByDay(mergedFeed(events), now);
}
