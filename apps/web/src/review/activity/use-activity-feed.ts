import {useCallback, useEffect, useMemo, useRef, useState} from "react";

import {api, type ActivityEntry} from "@/api/client";
import type {ActivityFilters} from "@/review/review-routes";

import {appendPage, refreshFirstPage} from "./activity-pages";

const pageSize = 30;
const rememberedFeeds = 8;

/** The last feed shown for each filter set in this tab, so returning to it never blanks what was known. */
const lastFeeds = new Map<string, {readonly cursor: string | null; readonly entries: readonly ActivityEntry[]}>();

function remember(key: string, cursor: string | null, entries: readonly ActivityEntry[]): void {
  lastFeeds.delete(key);
  lastFeeds.set(key, {cursor, entries});
  const oldest = lastFeeds.keys().next().value;
  if (lastFeeds.size > rememberedFeeds && oldest !== undefined) lastFeeds.delete(oldest);
}

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

/** One filter set's feed; `key` names the filters these entries and this cursor belong to. */
interface FeedState {
  readonly cursor: string | null;
  readonly entries: readonly ActivityEntry[];
  readonly key: string;
  readonly phase: "loading" | "ready" | "failed";
}

function knownFeed(key: string): FeedState {
  const known = lastFeeds.get(key);
  return known === undefined
    ? {cursor: null, entries: [], key, phase: "loading"}
    : {cursor: known.cursor, entries: known.entries, key, phase: "ready"};
}

/** One filtered feed: first page, cursor paging, re-read on focus, own mutations shown at once. */
export function useActivityFeed(filters: ActivityFilters): ActivityFeedState {
  const key = JSON.stringify(filters);
  const [state, setState] = useState<FeedState>(() => knownFeed(key));
  const generation = useRef(0);
  const request = useCallback((next: string | null) => api.listActivity({
    cursor: next, limit: pageSize, projects: [...filters.projects], q: filters.q, segment: filters.segment, types: [...filters.types],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the filters' value identity
  }), [key]);

  const loadFirst = useCallback((mode: "replace" | "refresh") => {
    const mine = ++generation.current;
    if (mode === "replace") setState((current) => ({...current, key, phase: "loading"}));
    void (async () => {
      try {
        const page = await request(null);
        if (generation.current !== mine) return;
        setState((current) => {
          const pages = mode === "replace" || current.key !== key
            ? {cursor: page.nextCursor, entries: page.items}
            : refreshFirstPage(current, page);
          return {...pages, key, phase: "ready"};
        });
      } catch {
        // A failed background re-read keeps what is on screen.
        if (generation.current === mine && mode === "replace") setState((current) => ({...current, key, phase: "failed"}));
      }
    })();
  }, [key, request]);

  // A filter set shown before in this tab appears at once and re-reads underneath; a new one loads.
  useEffect(() => {
    const known = knownFeed(key);
    setState(known);
    loadFirst(known.phase === "ready" ? "refresh" : "replace");
  }, [key, loadFirst]);
  // Only entries read for these filters are remembered under their key.
  useEffect(() => {
    if (state.phase === "ready") remember(state.key, state.cursor, state.entries);
  }, [state]);
  useEffect(() => {
    const refresh = (): void => loadFirst("refresh");
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [loadFirst]);

  const {cursor} = state;
  const loadOlder = useCallback(() => {
    if (cursor === null) return;
    const mine = generation.current;
    void (async () => {
      try {
        const page = await request(cursor);
        if (generation.current !== mine) return;
        setState((current) => current.key === key
          ? {...current, cursor: page.nextCursor, entries: appendPage(current.entries, page.items)}
          : current);
      } catch {
        // "Show older" stays available; the next press retries.
      }
    })();
  }, [cursor, key, request]);

  const insertLocal = useCallback((entry: ActivityEntry) => {
    setState((current) => ({...current, entries: appendPage([entry], current.entries.filter((existing) =>
      !(existing.kind === "thread" && entry.kind === "thread" && existing.thread?.id === entry.thread?.id)))}));
  }, []);
  const replaceThread = useCallback((threadId: string, thread: NonNullable<ActivityEntry["thread"]>) => {
    setState((current) => ({...current, entries: current.entries.map((entry) =>
      entry.kind === "thread" && entry.thread?.id === threadId ? {...entry, thread} : entry)}));
  }, []);
  const reload = useCallback(() => loadFirst("refresh"), [loadFirst]);

  // Until the first read for new filters lands, show nothing from the previous filters.
  const current = state.key === key;
  return useMemo(() => ({
    entries: current ? state.entries : [],
    hasMore: current && state.cursor !== null,
    insertLocal,
    loadOlder,
    phase: current ? state.phase : "loading",
    reload,
    replaceThread,
  }), [current, insertLocal, loadOlder, reload, replaceThread, state]);
}
