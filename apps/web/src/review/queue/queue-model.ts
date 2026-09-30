import type {
  AgentDispatch,
  AgentDispatchState,
  ArtifactPage,
  Project,
} from "@/api/client";
import {accessSettingLabel} from "@/lib/presentation";

/** Why an artifact is in the review queue. */
export type QueueGroup = "agent" | "conversations";
/** One queue tab: every group, or one of them. */
export type QueueFilter = "all" | QueueGroup;
/** One artifact row of a project's first catalog page. */
export type QueueArtifact = ArtifactPage["artifacts"][number];

/** The tab order the queue screen draws. */
export const queueFilters = ["all", "agent", "conversations"] as const satisfies readonly QueueFilter[];

/** One queued artifact and the reason it is queued. */
export interface QueueEntry {
  /** The newest queued, claimed or delivered send holding this artifact's threads. */
  readonly activeDispatch: AgentDispatch | null;
  readonly artifact: QueueArtifact;
  readonly group: QueueGroup;
  readonly project: Project;
}

/** Everything the queue is derived from; nothing here is fetched. */
export interface QueueSources {
  /** Sends in any state, keyed by `queueKey(projectId, artifactId)`. */
  readonly dispatches: ReadonlyMap<string, readonly AgentDispatch[]>;
  /** Each project's first `{comments: "with", sort: "comments"}` page, keyed by project id. */
  readonly pages: ReadonlyMap<string, ArtifactPage>;
  readonly projects: readonly Project[];
}

/** The threads one artifact lists with `dispatched: "only"`: each is held by some send. */
export interface CarriedThreads {
  readonly artifactId: string;
  readonly projectId: string;
  readonly threadIds: readonly string[];
}

/** Row counts per queue tab. */
export interface QueueCounts {
  readonly agent: number;
  readonly all: number;
  readonly conversations: number;
}

/** The text one queue row shows. */
export interface QueueRowCopy {
  readonly meta: readonly string[];
  readonly sentence: string;
  readonly state: string;
  readonly tone: "neutral" | "running";
}

const activeDispatchStates = new Set<AgentDispatchState>(["claimed", "delivered", "queued"]);

const dispatchStateLabels = {
  addressed: "Addressed",
  canceled: "Canceled",
  claimed: "Claimed",
  delivered: "Delivered",
  failed: "Failed",
  queued: "Queued",
} satisfies Record<AgentDispatchState, string>;

/** True while a send is still on its way to, or held by, its agent. */
export function isActiveDispatch(dispatch: AgentDispatch): boolean {
  return activeDispatchStates.has(dispatch.state);
}

/** The key the queue uses for one artifact across projects. */
export function queueKey(projectId: string, artifactId: string): string {
  return `${projectId}/${artifactId}`;
}

/** "1 conversation", "3 conversations". */
export function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** The artifact id short enough for a row; the copy action copies the full id. */
export function shortArtifactId(artifactId: string): string {
  return artifactId.startsWith("art_") ? artifactId.slice(0, 12) : artifactId.slice(0, 8);
}

/**
 * Attach sends to artifacts through the threads they carry. A send lists its
 * thread ids and a carried thread belongs to exactly one artifact, so the
 * intersection names the artifact; sends and threads of different projects
 * never match.
 */
export function dispatchesByArtifact(
  dispatches: readonly AgentDispatch[],
  carried: readonly CarriedThreads[],
): ReadonlyMap<string, readonly AgentDispatch[]> {
  const byThread = new Map<string, AgentDispatch[]>();
  for (const dispatch of dispatches) {
    for (const threadId of dispatch.threadIds) {
      const key = `${dispatch.projectId}/${threadId}`;
      const listed = byThread.get(key);
      if (listed === undefined) byThread.set(key, [dispatch]);
      else listed.push(dispatch);
    }
  }
  const byArtifact = new Map<string, readonly AgentDispatch[]>();
  for (const artifact of carried) {
    const found = new Map<string, AgentDispatch>();
    for (const threadId of artifact.threadIds) {
      for (const dispatch of byThread.get(`${artifact.projectId}/${threadId}`) ?? []) {
        found.set(dispatch.id, dispatch);
      }
    }
    if (found.size > 0) {
      byArtifact.set(queueKey(artifact.projectId, artifact.artifactId), [...found.values()]);
    }
  }
  return byArtifact;
}

function newestActive(dispatches: readonly AgentDispatch[]): AgentDispatch | null {
  let newest: AgentDispatch | null = null;
  for (const dispatch of dispatches) {
    if (!isActiveDispatch(dispatch)) continue;
    if (
      newest === null
      || dispatch.updatedAt > newest.updatedAt
      || (dispatch.updatedAt === newest.updatedAt && dispatch.id > newest.id)
    ) {
      newest = dispatch;
    }
  }
  return newest;
}

function compareEntries(left: QueueEntry, right: QueueEntry): number {
  if (left.group !== right.group) return left.group === "agent" ? -1 : 1;
  if (left.activeDispatch !== null && right.activeDispatch !== null) {
    const bySend = right.activeDispatch.updatedAt.localeCompare(left.activeDispatch.updatedAt);
    if (bySend !== 0) return bySend;
  }
  return right.artifact.commentCount - left.artifact.commentCount
    || left.artifact.artifact.name.localeCompare(right.artifact.artifact.name)
    || left.artifact.artifact.id.localeCompare(right.artifact.artifact.id);
}

/**
 * Group the artifacts of every project's first page. An active send wins over
 * conversations; an artifact with neither is not queued.
 */
export function groupQueue(input: QueueSources): QueueEntry[] {
  const entries: QueueEntry[] = [];
  for (const project of input.projects) {
    const page = input.pages.get(project.id);
    if (page === undefined) continue;
    for (const artifact of page.artifacts) {
      const activeDispatch = newestActive(
        input.dispatches.get(queueKey(project.id, artifact.artifact.id)) ?? [],
      );
      if (activeDispatch !== null) {
        entries.push({activeDispatch, artifact, group: "agent", project});
      } else if (artifact.commentCount > 0) {
        entries.push({activeDispatch: null, artifact, group: "conversations", project});
      }
    }
  }
  return entries.toSorted(compareEntries);
}

/** Keep one tab's entries whose artifact name, project name or artifact id contains the query. */
export function filterQueue(
  entries: readonly QueueEntry[],
  filter: QueueFilter,
  query: string,
): readonly QueueEntry[] {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) =>
    (filter === "all" || entry.group === filter)
    && (needle === "" || [
      entry.artifact.artifact.name,
      entry.project.name,
      entry.artifact.artifact.id,
    ].some((value) => value.toLowerCase().includes(needle)))
  );
}

/** Count entries per tab. */
export function queueCounts(entries: readonly QueueEntry[]): QueueCounts {
  const agent = entries.filter((entry) => entry.group === "agent").length;
  return {agent, all: entries.length, conversations: entries.length - agent};
}

/**
 * The row's state and sentence. `commentCount` counts resolved threads too,
 * so the copy states what is recorded and never that anything waits on the reader.
 */
export function describeQueueEntry(entry: QueueEntry): QueueRowCopy {
  const meta = [
    entry.project.name,
    accessSettingLabel(entry.artifact.artifact.accessSetting),
    pluralize(entry.artifact.versionCount, "version", "versions"),
  ];
  if (entry.project.archivedAt !== null) meta.push("Archived project");
  const dispatch = entry.activeDispatch;
  if (dispatch !== null) {
    const state = dispatchStateLabels[dispatch.state];
    return {
      meta,
      sentence: `${state} for ${dispatch.agentDisplayName}; ${pluralize(dispatch.threadIds.length, "conversation", "conversations")} travelled with the send.`,
      state,
      tone: "running",
    };
  }
  const conversations = pluralize(entry.artifact.commentCount, "conversation", "conversations");
  return {
    meta,
    sentence: `${conversations} recorded, open or resolved.`,
    state: conversations,
    tone: "neutral",
  };
}

/** Listings one queue load keeps in flight across every project and request kind. */
export const QUEUE_REQUEST_CONCURRENCY = 4;
