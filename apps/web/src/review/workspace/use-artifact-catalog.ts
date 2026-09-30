import {useCallback, useDeferredValue, useEffect, useRef, useState} from "react";

import {api, type ArtifactPage} from "@/api/client";

import type {CatalogCommentFilter, CatalogRefreshState, CatalogSort} from "./workspace-types.ts";

type CatalogItem = ArtifactPage["artifacts"][number];
type CatalogArtifact = CatalogItem["artifact"];
type LoadResult = "failed" | "loaded" | "skipped";

const refreshConfirmationMilliseconds = 1_600;

/** One project's artifact catalog: its pages, search, filters, sort, and refresh state. */
export interface ArtifactCatalog {
  readonly commentFilter: CatalogCommentFilter;
  readonly error: Error | null;
  /** Search text, comment filter, or tag filters narrow the list. */
  readonly filtered: boolean;
  readonly items: readonly CatalogItem[];
  readonly knownTags: readonly string[];
  /** A page is being read. Rows already listed stay until it lands. */
  readonly loading: boolean;
  readonly nextCursor: string | null;
  readonly query: string;
  /** The first page is being re-read; the rows shown belong to the previous search or filter. */
  readonly rereading: boolean;
  readonly refreshState: CatalogRefreshState;
  readonly sort: CatalogSort;
  readonly tagFilters: readonly string[];
  /** Add tags seen elsewhere (an open record, an edit) to the filter choices. */
  readonly learnTags: (tags: readonly string[]) => void;
  readonly loadMore: () => void;
  /** The reviewer's Refresh: re-read the first page and announce it. */
  readonly refresh: () => void;
  /** Re-read the first page without announcing, after a change made here. */
  readonly reload: () => void;
  readonly removeArtifact: (artifactId: string) => void;
  readonly replaceArtifact: (artifact: CatalogArtifact) => void;
  readonly setCommentFilter: (filter: CatalogCommentFilter) => void;
  readonly setQuery: (query: string) => void;
  readonly setSort: (sort: CatalogSort) => void;
  readonly setTagFilters: (tags: readonly string[]) => void;
}

function mergedTags(current: readonly string[], tags: Iterable<string>): readonly string[] {
  const next = new Set(current);
  let grew = false;
  for (const tag of tags) {
    if (!next.has(tag)) {
      next.add(tag);
      grew = true;
    }
  }
  return grew ? [...next].toSorted() : current;
}

/**
 * Read one project's catalog. Changing search, filters, or sort re-reads the
 * first page while the rows already listed stay on screen, so the list never
 * collapses to empty and back. A response that a newer read has superseded is
 * dropped. `onFirstPage` receives every first page that lands, so the
 * workspace can open the first artifact when none is selected.
 */
export function useArtifactCatalog(
  projectId: string,
  options: {
    readonly announce: (message: string) => void;
    readonly onFirstPage: (artifacts: readonly CatalogItem[]) => void;
  },
): ArtifactCatalog {
  const [items, setItems] = useState<readonly CatalogItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const searchQuery = useDeferredValue(query.trim());
  const [commentFilter, setCommentFilter] = useState<CatalogCommentFilter>("all");
  const [tagFilters, setTagFilters] = useState<readonly string[]>([]);
  const [knownTags, setKnownTags] = useState<readonly string[]>([]);
  const [sort, setSort] = useState<CatalogSort>("newest");
  const [loading, setLoading] = useState(true);
  const [rereading, setRereading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [refreshState, setRefreshState] = useState<CatalogRefreshState>("idle");
  const generationRef = useRef(0);
  const confirmationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const load = useCallback(async (cursor: string | null): Promise<LoadResult> => {
    if (projectId === "") return "skipped";
    const generation = ++generationRef.current;
    setLoading(true);
    setRereading(cursor === null);
    setError(null);
    try {
      const page = await api.artifacts(projectId, cursor, tagFilters, searchQuery, {
        comments: commentFilter,
        sort,
      });
      if (generation !== generationRef.current) return "skipped";
      setKnownTags((current) => mergedTags(current, page.artifacts.flatMap(({artifact}) => artifact.tags)));
      setItems((current) => cursor === null ? page.artifacts : [...current, ...page.artifacts]);
      setNextCursor(page.nextCursor);
      if (cursor === null) optionsRef.current.onFirstPage(page.artifacts);
      return "loaded";
    } catch (caught) {
      if (generation === generationRef.current) {
        setError(caught instanceof Error ? caught : new Error("Artifact list failed."));
      }
      return "failed";
    } finally {
      if (generation === generationRef.current) {
        setLoading(false);
        setRereading(false);
      }
    }
  }, [commentFilter, projectId, searchQuery, sort, tagFilters]);

  const clearConfirmation = useCallback((): void => {
    if (confirmationTimerRef.current !== null) {
      clearTimeout(confirmationTimerRef.current);
      confirmationTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    clearConfirmation();
    setRefreshState("idle");
    void load(null);
  }, [clearConfirmation, load]);

  useEffect(() => clearConfirmation, [clearConfirmation]);

  const refresh = useCallback((): void => {
    if (loading) return;
    clearConfirmation();
    setRefreshState("loading");
    const {announce} = optionsRef.current;
    announce("Refreshing artifact catalog.");
    void (async () => {
      if (await load(null) !== "loaded") {
        setRefreshState("idle");
        return;
      }
      setRefreshState("complete");
      announce("Artifact catalog refreshed.");
      confirmationTimerRef.current = setTimeout(() => {
        confirmationTimerRef.current = null;
        setRefreshState("idle");
      }, refreshConfirmationMilliseconds);
    })();
  }, [clearConfirmation, load, loading]);

  return {
    commentFilter,
    error,
    filtered: searchQuery !== "" || commentFilter !== "all" || tagFilters.length > 0,
    items,
    knownTags,
    learnTags: useCallback((tags: readonly string[]) => {
      setKnownTags((current) => mergedTags(current, tags));
    }, []),
    loading,
    loadMore: () => void load(nextCursor),
    nextCursor,
    query,
    refresh,
    refreshState,
    rereading,
    reload: () => void load(null),
    removeArtifact: useCallback((artifactId: string) => {
      setItems((current) => current.filter(({artifact}) => artifact.id !== artifactId));
    }, []),
    replaceArtifact: useCallback((artifact: CatalogArtifact) => {
      setItems((current) => current.map((item) => item.artifact.id === artifact.id ? {...item, artifact} : item));
    }, []),
    setCommentFilter,
    setQuery,
    setSort,
    setTagFilters,
    sort,
    tagFilters,
  };
}
