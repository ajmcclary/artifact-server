import {useCallback, useEffect, useRef, useState} from "react";

import {api, type ActivityEntry} from "@/api/client";
import type {ActivityFilters} from "@/review/review-routes";

import {appendPage, refreshFirstPage} from "./activity-pages";

const pageSize = 30;

export interface ActivityFeedState {
  readonly entries: readonly ActivityEntry[];
  readonly hasMore: boolean;
  readonly phase: "loading" | "ready" | "failed";
  readonly insertLocal: (entry: ActivityEntry) => void;
  readonly loadOlder: () => void;
  readonly reload: () => void;
  /** Swap a thread entry's snapshot (full replies after hydration, a new reply, a resolve). */
  readonly replaceThread: (threadId: string, thread: NonNullable<ActivityEntry["thread"]>) => void;
}

/** One filtered feed: first page, cursor paging, re-read on focus, own mutations shown at once. */
export function useActivityFeed(filters: ActivityFilters): ActivityFeedState {
  const [entries, setEntries] = useState<readonly ActivityEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const generation = useRef(0);
  const key = JSON.stringify(filters);
  const request = useCallback((next: string | null) => api.listActivity({
    cursor: next, limit: pageSize, projects: [...filters.projects], q: filters.q, segment: filters.segment, types: [...filters.types],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the filters' value identity
  }), [key]);

  const loadFirst = useCallback((mode: "replace" | "refresh") => {
    const mine = ++generation.current;
    if (mode === "replace") setPhase("loading");
    void (async () => {
      try {
        const page = await request(null);
        if (generation.current !== mine) return;
        setEntries((current) => mode === "replace" ? page.items : refreshFirstPage(current, page.items));
        if (mode === "replace") setCursor(page.nextCursor);
        setPhase("ready");
      } catch {
        // A failed background re-read keeps what is on screen.
        if (generation.current === mine && mode === "replace") setPhase("failed");
      }
    })();
  }, [request]);

  useEffect(() => loadFirst("replace"), [loadFirst]);
  useEffect(() => {
    const refresh = (): void => loadFirst("refresh");
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [loadFirst]);

  const loadOlder = useCallback(() => {
    if (cursor === null) return;
    const mine = generation.current;
    void (async () => {
      try {
        const page = await request(cursor);
        if (generation.current !== mine) return;
        setEntries((current) => appendPage(current, page.items));
        setCursor(page.nextCursor);
      } catch {
        // "Show older" stays available; the next press retries.
      }
    })();
  }, [cursor, request]);

  const insertLocal = useCallback((entry: ActivityEntry) => {
    setEntries((current) => appendPage([entry], current.filter((existing) =>
      !(existing.kind === "thread" && entry.kind === "thread" && existing.thread?.id === entry.thread?.id))));
  }, []);
  const replaceThread = useCallback((threadId: string, thread: NonNullable<ActivityEntry["thread"]>) => {
    setEntries((current) => current.map((entry) => entry.kind === "thread" && entry.thread?.id === threadId ? {...entry, thread} : entry));
  }, []);

  return {entries, hasMore: cursor !== null, insertLocal, loadOlder, phase, reload: () => loadFirst("refresh"), replaceThread};
}
