import {useCallback, useEffect, useState} from "react";

import {
  api,
  type AgentDispatch,
  type ArtifactPage,
  type Project,
} from "@/api/client";

import {createRequestLimiter, type RequestLimiter} from "@/lib/request-limiter";

import {
  dispatchesByArtifact,
  groupQueue,
  isActiveDispatch,
  QUEUE_REQUEST_CONCURRENCY,
  type CarriedThreads,
  type QueueEntry,
} from "./queue-model";

/** Sends read per project: the listing is newest first and the server caps a page at 100. */
const queueDispatchPageSize = 100;
/** Dispatched threads read per artifact, at the same server cap. */
const carriedThreadPageSize = 100;

export type ReviewQueuePhase = "failed" | "loading" | "ready";

/** The queue as the screen reads it. */
export interface ReviewQueue {
  readonly entries: readonly QueueEntry[];
  readonly phase: ReviewQueuePhase;
  readonly refresh: () => void;
  /** The last read failed while an earlier queue stays on screen. */
  readonly refreshFailed: boolean;
  /** A re-read is running while the earlier queue stays on screen. */
  readonly refreshing: boolean;
  /** True when some project held more artifacts or sends than its first pages. */
  readonly truncated: boolean;
  /** Projects whose listings failed; their artifacts are missing from `entries`. */
  readonly unreadable: readonly Project[];
}

interface LoadedQueue {
  readonly entries: readonly QueueEntry[];
  readonly truncated: boolean;
  readonly unreadable: readonly Project[];
}

class AbandonedQueueLoad extends Error {}

interface ProjectQueueData {
  readonly carried: readonly CarriedThreads[];
  readonly dispatches: readonly AgentDispatch[];
  readonly page: ArtifactPage;
  readonly project: Project;
  readonly truncated: boolean;
}

async function loadProjectQueue(project: Project, ask: RequestLimiter): Promise<ProjectQueueData> {
  const [page, sends] = await Promise.all([
    ask(() => api.artifacts(project.id, null, [], "", {comments: "with", sort: "comments"})),
    ask(() => api.agentDispatches(project.id, {
      agentId: null,
      cursor: null,
      limit: queueDispatchPageSize,
      state: null,
    })),
  ]);
  // A send names threads, not artifacts. Only an artifact on this page can
  // hold a carried thread, and the per-artifact listing runs only when the
  // project has a send in flight.
  const carried = sends.items.some(isActiveDispatch)
    ? await Promise.all(page.artifacts.map(({artifact}) => ask(async () => {
      const threads = await api.comments(project.id, artifact.id, {
        cursor: null,
        dispatched: "only",
        limit: carriedThreadPageSize,
        revision: null,
        since: null,
        state: null,
        versionId: null,
      });
      return {
        artifactId: artifact.id,
        projectId: project.id,
        threadIds: threads.items.map((thread) => thread.id),
      };
    })))
    : [];
  return {
    carried,
    dispatches: sends.items,
    page,
    project,
    truncated: page.nextCursor !== null || sends.nextCursor !== null,
  };
}

/**
 * Every listing of one load shares a single bound, whatever its kind, and a
 * load that is no longer current stops before its next request. A project
 * whose listings fail is reported instead of failing the whole queue.
 */
async function loadReviewQueue(projects: readonly Project[], isCurrent: () => boolean): Promise<LoadedQueue> {
  const limit = createRequestLimiter(QUEUE_REQUEST_CONCURRENCY);
  const ask: RequestLimiter = (task) => limit(async () => {
    if (!isCurrent()) throw new AbandonedQueueLoad();
    return task();
  });
  const settled = await Promise.allSettled(projects.map((project) => loadProjectQueue(project, ask)));
  const loaded = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const unreadable = projects.filter((_, index) => settled[index]?.status === "rejected");
  if (projects.length > 0 && loaded.length === 0) throw new Error("No project's queue could be read.");
  return {
    entries: groupQueue({
      dispatches: dispatchesByArtifact(
        loaded.flatMap((data) => data.dispatches),
        loaded.flatMap((data) => data.carried),
      ),
      pages: new Map(loaded.map((data) => [data.project.id, data.page] as const)),
      projects: loaded.map((data) => data.project),
    }),
    truncated: loaded.some((data) => data.truncated),
    unreadable,
  };
}

/**
 * The queue last read for one set of projects. Returning to the queue shows
 * it at once and re-reads underneath, instead of starting from a spinner.
 * Sign-out loads a new document, so it never outlives the signed-in person.
 */
let lastQueue: {readonly key: string; readonly queue: LoadedQueue} | null = null;

function projectsKey(projects: readonly Project[]): string {
  return projects.map((project) => project.id).join("\n");
}

/** Load the queue for every readable project; `refresh` re-reads it with the earlier queue still shown. */
export function useReviewQueue(projects: readonly Project[]): ReviewQueue {
  const key = projectsKey(projects);
  const [generation, setGeneration] = useState(0);
  const [loaded, setLoaded] = useState<LoadedQueue | null>(
    () => lastQueue?.key === key ? lastQueue.queue : null,
  );
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let current = true;
    setRefreshing(true);
    void (async () => {
      try {
        const next = await loadReviewQueue(projects, () => current);
        if (!current) return;
        lastQueue = {key: projectsKey(projects), queue: next};
        setLoaded(next);
        setFailed(false);
      } catch {
        if (current) setFailed(true);
      } finally {
        if (current) setRefreshing(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [generation, projects]);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  const phase: ReviewQueuePhase = loaded !== null ? "ready" : failed ? "failed" : "loading";
  return {
    entries: loaded?.entries ?? [],
    phase,
    refresh,
    refreshFailed: loaded !== null && failed,
    refreshing: loaded !== null && refreshing,
    truncated: loaded?.truncated ?? false,
    unreadable: loaded?.unreadable ?? [],
  };
}
