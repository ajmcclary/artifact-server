import {useCallback, useEffect, useRef, useState} from "react";

import {api, type ArtifactAction, type ArtifactComparison} from "@/api/client";

/** One artifact's activity log, read when the Activity view first opens. */
export interface ArtifactActivity {
  readonly actions: readonly ArtifactAction[];
  readonly error: Error | null;
  readonly loadMore: () => void;
  readonly loading: boolean;
  readonly nextCursor: string | null;
}

/**
 * Read an artifact's activity once `open` turns true, once per artifact: an
 * empty or failed history is not re-requested on its own (the view offers
 * Load more, and reopening another artifact starts over). A page that lands
 * after the reviewer moved to another artifact is dropped.
 */
export function useArtifactActivity(projectId: string, artifactId: string | null, open: boolean): ArtifactActivity {
  const [actions, setActions] = useState<readonly ArtifactAction[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [requested, setRequested] = useState(false);
  const artifactRef = useRef(artifactId);
  artifactRef.current = artifactId;

  useEffect(() => {
    setActions([]);
    setNextCursor(null);
    setError(null);
    setRequested(false);
  }, [artifactId]);

  const load = useCallback(async (cursor: string | null): Promise<void> => {
    if (artifactId === null || projectId === "") return;
    setLoading(true);
    setError(null);
    try {
      const page = await api.actions(projectId, artifactId, cursor);
      if (artifactRef.current !== artifactId) return;
      setActions((current) => cursor === null ? page.actions : [...current, ...page.actions]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (artifactRef.current !== artifactId) return;
      setError(caught instanceof Error ? caught : new Error("Activity loading failed."));
    } finally {
      setLoading(false);
    }
  }, [artifactId, projectId]);

  useEffect(() => {
    if (!open || requested) return;
    setRequested(true);
    void load(null);
  }, [load, open, requested]);

  return {actions, error, loadMore: () => void load(nextCursor), loading, nextCursor};
}

/** A comparison between two versions of one artifact. */
export interface VersionComparison {
  readonly compare: (fromVersionId: string, toVersionId: string) => Promise<void>;
  readonly comparison: ArtifactComparison | null;
  readonly error: Error | null;
  readonly loading: boolean;
}

/** Compare two versions of the open artifact; switching artifacts clears it and drops a late answer. */
export function useVersionComparison(projectId: string, artifactId: string | null): VersionComparison {
  const [comparison, setComparison] = useState<ArtifactComparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const artifactRef = useRef(artifactId);
  artifactRef.current = artifactId;

  useEffect(() => {
    setComparison(null);
    setError(null);
  }, [artifactId]);

  const compare = useCallback(async (fromVersionId: string, toVersionId: string): Promise<void> => {
    if (artifactId === null || fromVersionId === toVersionId) return;
    setLoading(true);
    setError(null);
    try {
      const compared = await api.comparison(projectId, artifactId, fromVersionId, toVersionId);
      if (artifactRef.current === artifactId) setComparison(compared);
    } catch (caught) {
      if (artifactRef.current === artifactId) {
        setError(caught instanceof Error ? caught : new Error("Version comparison failed."));
      }
    } finally {
      setLoading(false);
    }
  }, [artifactId, projectId]);

  return {compare, comparison, error, loading};
}
