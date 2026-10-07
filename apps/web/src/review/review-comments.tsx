import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {z} from "zod";

import {
  api,
  type AgentPresence,
  type CommentAnchor,
  type CommentReply,
  type CommentThread,
  type CommentThreadDetails,
  type CommentThreadQuery,
} from "@/api/client";
import {
  useCommentListOwnership,
  useCommentPoll,
} from "@/components/comments/comment-poll";
import {
  loadAllThreadsPaged,
  type ThreadListingResult,
} from "@/review/review-comments-threads";
import {
  reviewAnchorSchema,
  type ReviewAnchor,
  type ReviewAnnotation,
  type UnanchoredReason,
} from "@/review-frame/protocol";

const threadPageSize = 100;
const conversationLoadConcurrency = 6;

export function agentPresenceSummary(agents: readonly AgentPresence[] | null): string {
  if (agents === null) return "Checking presence…";
  const connectedCount = agents.filter((agent) => agent.connected).length;
  const offlineCount = agents.length - connectedCount;
  if (offlineCount === 0) {
    return connectedCount === 0 ? "No agents connected" : `${connectedCount} connected`;
  }
  return `${connectedCount} connected · ${offlineCount} offline`;
}

function threadQuery(
  versionId: string,
  cursor: string | null,
  dispatched: "exclude" | "include" | "only" | null = null,
  revision: number | null = null,
): CommentThreadQuery {
  return {
    cursor,
    dispatched,
    limit: threadPageSize,
    revision,
    since: null,
    state: null,
    versionId,
  };
}

export async function loadAllThreads(
  projectId: string,
  artifactId: string,
  versionId: string,
  dispatched: "exclude" | "include" | "only" | null = null,
  revision: number | null = null,
): Promise<ThreadListingResult> {
  return loadAllThreadsPaged(
    async (cursor) =>
      api.comments(
        projectId,
        artifactId,
        threadQuery(versionId, cursor, dispatched, revision),
      ),
    revision,
  );
}

function toAnnotation(thread: CommentThread): ReviewAnnotation {
  const parsed = reviewAnchorSchema.safeParse(thread.anchor);
  return {
    anchor: parsed.success ? parsed.data : null,
    body: thread.body,
    state: thread.state,
    threadId: thread.id,
  };
}

export async function loadConversations(
  projectId: string,
  artifactId: string,
  threads: readonly CommentThread[],
): Promise<readonly CommentThreadDetails[]> {
  const conversations = new Map<string, CommentThreadDetails>();
  const worker = async (index: number): Promise<void> => {
    const thread = threads[index];
    if (thread === undefined) return;
    const details = await api.comment(projectId, artifactId, thread.id);
    conversations.set(thread.id, details);
    await worker(index + conversationLoadConcurrency);
  };
  await Promise.all(
    Array.from(
      {length: Math.min(conversationLoadConcurrency, threads.length)},
      (_, index) => worker(index),
    ),
  );
  return threads.flatMap((thread) => {
    const details = conversations.get(thread.id);
    return details === undefined ? [] : [details];
  });
}

export interface ReviewCommentSession {
  readonly artifactId: string | null;
  readonly annotations: readonly ReviewAnnotation[];
  readonly changeState: (thread: CommentThread) => Promise<void>;
  readonly createReply: (
    thread: CommentThread,
    body: string,
    idempotencyKey: string,
  ) => Promise<boolean>;
  readonly deleteReply: (reply: CommentReply) => Promise<void>;
  readonly error: Error | null;
  readonly loading: boolean;
  readonly projectId: string;
  readonly reload: () => Promise<void>;
  readonly repliesByThread: ReadonlyMap<string, readonly CommentReply[]>;
  readonly selectedThreadId: string | null;
  readonly selectThread: (threadId: string | null) => void;
  readonly submit: (
    body: string,
    anchor: ReviewAnchor | null,
    path: string | null,
  ) => Promise<boolean>;
  readonly threads: readonly CommentThread[];
  readonly unanchoredIds: readonly string[];
  /** Why the frame left a region-anchored thread unplaced, by thread id. */
  readonly unanchoredReasons: ReadonlyMap<string, UnanchoredReason>;
  readonly updateUnanchored: (
    threadIds: readonly string[],
    reasons?: Readonly<Record<string, UnanchoredReason>>,
  ) => void;
  readonly updateReply: (reply: CommentReply, body: string) => Promise<boolean>;
}

/** Keep one Review version's saved threads and Plannotator projections in sync. */
export function useReviewComments({
  artifactId,
  onVersionChanged,
  projectId,
  versionId,
}: {
  readonly artifactId: string | null;
  readonly onVersionChanged: (versionId: string) => void;
  readonly projectId: string;
  readonly versionId: string | null;
}): ReviewCommentSession {
  const [threads, setThreads] = useState<readonly CommentThread[]>([]);
  const [repliesByThread, setRepliesByThread] = useState<ReadonlyMap<
    string,
    readonly CommentReply[]
  >>(new Map());
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [unanchoredIds, setUnanchoredIds] = useState<readonly string[]>([]);
  const [unanchoredReasons, setUnanchoredReasons] = useState<ReadonlyMap<string, UnanchoredReason>>(new Map());
  const updateUnanchored = useCallback((
    threadIds: readonly string[],
    reasons: Readonly<Record<string, UnanchoredReason>> = {},
  ): void => {
    setUnanchoredIds(threadIds);
    setUnanchoredReasons(new Map(Object.entries(reasons)));
  }, []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const revisionRef = useRef<number | null>(null);
  const reloadGenerationRef = useRef(0);
  const ownership = useCommentListOwnership();
  const active = artifactId !== null && projectId !== "" && versionId !== null;

  const replaceAllThreads = useCallback(async (
    options: {readonly withLoading?: boolean} = {},
  ): Promise<number | null> => {
    const {withLoading = true} = options;
    const generation = reloadGenerationRef.current + 1;
    reloadGenerationRef.current = generation;
    if (artifactId === null || projectId === "" || versionId === null) {
      setThreads([]);
      setRepliesByThread(new Map());
      setSelectedThreadId(null);
      setUnanchoredIds([]);
      setUnanchoredReasons(new Map());
      setError(null);
      return null;
    }
    if (withLoading) {
      setLoading(true);
    }
    setError(null);
    try {
      return await ownership.own(async () => {
        const listed = await loadAllThreads(projectId, artifactId, versionId);
        const conversations = await loadConversations(
          projectId,
          artifactId,
          listed.threads,
        );
        if (reloadGenerationRef.current !== generation) return null;
        setThreads(conversations.map(({thread}) => thread));
        setRepliesByThread(new Map(
          conversations.map(({replies, thread}) => [thread.id, replies]),
        ));
        return listed.revision;
      });
    } catch (caught) {
      if (reloadGenerationRef.current !== generation) return null;
      setError(
        caught instanceof Error ? caught : new Error("Comment loading failed."),
      );
      return null;
    } finally {
      if (withLoading && reloadGenerationRef.current === generation) {
        setLoading(false);
      }
    }
  }, [artifactId, ownership, projectId, versionId]);

  const reload = useCallback(async (): Promise<void> => {
    const revision = await replaceAllThreads({withLoading: true});
    if (revision !== null) {
      revisionRef.current = revision;
    }
  }, [replaceAllThreads]);

  useEffect(() => {
    setThreads([]);
    setRepliesByThread(new Map());
    setSelectedThreadId(null);
    setUnanchoredIds([]);
      setUnanchoredReasons(new Map());
    revisionRef.current = null;
    void reload();
  }, [reload]);

  useEffect(() => {
    if (
      selectedThreadId !== null
      && !threads.some((thread) => thread.id === selectedThreadId)
    ) {
      setSelectedThreadId(null);
    }
  }, [selectedThreadId, threads]);

  const poll = useCallback(async (): Promise<void> => {
    if (artifactId === null || projectId === "" || versionId === null) return;
    const token = ownership.open();
    if (token < 0) return;
    try {
      const page = await api.comments(
        projectId,
        artifactId,
        threadQuery(versionId, null, null, revisionRef.current),
      );
      if (page.revision === revisionRef.current || !ownership.settled(token)) return;
      const revision = await replaceAllThreads({withLoading: false});
      if (revision !== null) {
        revisionRef.current = revision;
      }
    } catch {
      // A failed background refresh leaves the last readable thread set intact.
    }
  }, [artifactId, ownership, projectId, replaceAllThreads, versionId]);

  useCommentPoll(poll, active);

  const submit = useCallback(async (
    body: string,
    anchor: ReviewAnchor | null,
    path: string | null,
  ): Promise<boolean> => {
    if (artifactId === null || projectId === "" || versionId === null) return false;
    setError(null);
    try {
      const storedAnchor: CommentAnchor = z.json().parse(anchor);
      const created = await ownership.own(() =>
        api.createComment(
          projectId,
          artifactId,
          versionId,
          {anchor: storedAnchor, body, path},
          crypto.randomUUID(),
        )
      );
      if (created.thread.versionId !== versionId) {
        onVersionChanged(created.thread.versionId);
      } else {
        await reload();
        setSelectedThreadId(created.thread.id);
      }
      return true;
    } catch (caught) {
      setError(
        caught instanceof Error ? caught : new Error("Comment creation failed."),
      );
      return false;
    }
  }, [artifactId, onVersionChanged, ownership, projectId, reload, versionId]);

  const changeState = useCallback(async (thread: CommentThread): Promise<void> => {
    if (artifactId === null || projectId === "") return;
    setError(null);
    try {
      await ownership.own(() =>
        api.updateComment(projectId, artifactId, thread.id, {
          state: thread.state === "open" ? "resolved" : "open",
        })
      );
      await reload();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught : new Error("Comment state change failed."),
      );
    }
  }, [artifactId, ownership, projectId, reload]);

  const createReply = useCallback(async (
    thread: CommentThread,
    body: string,
    idempotencyKey: string,
  ): Promise<boolean> => {
    if (artifactId === null || projectId === "" || thread.state !== "open") return false;
    setError(null);
    try {
      await ownership.own(() => api.createCommentReply(
        projectId,
        artifactId,
        thread.id,
        body,
        idempotencyKey,
      ));
      await reload();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Reply creation failed."));
      return false;
    }
  }, [artifactId, ownership, projectId, reload]);

  const updateReply = useCallback(async (
    reply: CommentReply,
    body: string,
  ): Promise<boolean> => {
    if (artifactId === null || projectId === "") return false;
    setError(null);
    try {
      await ownership.own(() => api.updateCommentReply(
        projectId,
        artifactId,
        reply.threadId,
        reply.id,
        body,
      ));
      await reload();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Reply edit failed."));
      return false;
    }
  }, [artifactId, ownership, projectId, reload]);

  const deleteReply = useCallback(async (reply: CommentReply): Promise<void> => {
    if (artifactId === null || projectId === "") return;
    setError(null);
    try {
      await ownership.own(() => api.deleteCommentReply(
        projectId,
        artifactId,
        reply.threadId,
        reply.id,
      ));
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Reply deletion failed."));
    }
  }, [artifactId, ownership, projectId, reload]);

  const annotations = useMemo(
    () => threads.filter((thread) => thread.state === "open").map(toAnnotation),
    [threads],
  );

  return {
    annotations,
    artifactId,
    changeState,
    createReply,
    deleteReply,
    error,
    loading,
    projectId,
    reload,
    repliesByThread,
    selectedThreadId,
    selectThread: setSelectedThreadId,
    submit,
    threads,
    unanchoredIds,
    unanchoredReasons,
    updateUnanchored,
    updateReply,
  };
}

