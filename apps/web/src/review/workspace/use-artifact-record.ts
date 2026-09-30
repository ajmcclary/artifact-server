import {useCallback, useEffect, useRef, useState} from "react";

import {api, type ArtifactDetails, type ArtifactVersion} from "@/api/client";
import {useCommentPoll} from "@/components/comments/comment-poll";

import type {VersionListItem} from "./workspace-types.ts";

const noVersions: readonly VersionListItem[] = [];

/** The open artifact's record: details, version list, and the version on screen. */
export interface ArtifactRecord {
  /** The selected artifact's details; never another artifact's while the next one loads. */
  readonly details: ArtifactDetails | null;
  readonly error: Error | null;
  readonly loading: boolean;
  /** Replace the artifact inside the shown details after an edit made here. */
  readonly patchArtifact: (artifact: ArtifactDetails["artifact"]) => void;
  /**
   * Re-read details and versions after a change made here. The record is
   * shown only if the reviewer is still on that artifact; `shown` says whether.
   */
  readonly reload: () => Promise<{readonly details: ArtifactDetails; readonly shown: boolean} | null>;
  readonly setError: (error: Error | null) => void;
  readonly setLoading: (loading: boolean) => void;
  /** The selected version once resolved; null while it loads or for another artifact. */
  readonly version: ArtifactVersion | null;
  readonly versions: readonly VersionListItem[];
}

/**
 * Read one artifact's record and resolve the selected version. Every answer is
 * tied to the artifact it was asked for, so switching artifacts never shows
 * the previous record and a late answer for it is dropped. Versions are
 * immutable, so refreshing the record (the linked-source poll, an edit) keeps
 * the version on screen; only a different version or a new current version
 * re-resolves it.
 */
export function useArtifactRecord({
  artifactId,
  followLinkedSource,
  onCurrentVersion,
  projectId,
  versionId,
}: {
  readonly artifactId: string | null;
  /** Poll the record while it is bound to a linked source that can change underneath. */
  readonly followLinkedSource: boolean;
  /** The first read of an artifact names its current version, for a selection that has none. */
  readonly onCurrentVersion: (versionId: string) => void;
  readonly projectId: string;
  readonly versionId: string | null;
}): ArtifactRecord {
  const [fetchedDetails, setFetchedDetails] = useState<ArtifactDetails | null>(null);
  const [fetchedVersions, setFetchedVersions] = useState<readonly VersionListItem[]>([]);
  const [fetchedVersion, setFetchedVersion] = useState<ArtifactVersion | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const artifactRef = useRef(artifactId);
  artifactRef.current = artifactId;
  const fetchedVersionRef = useRef(fetchedVersion);
  fetchedVersionRef.current = fetchedVersion;
  const onCurrentVersionRef = useRef(onCurrentVersion);
  onCurrentVersionRef.current = onCurrentVersion;

  const details = fetchedDetails?.artifact.id === artifactId ? fetchedDetails : null;
  const versions = details === null ? noVersions : fetchedVersions;
  const version = details !== null && fetchedVersion?.version.id === versionId ? fetchedVersion : null;

  useEffect(() => {
    if (artifactId === null || projectId === "") return undefined;
    let current = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [loadedDetails, loadedVersions] = await Promise.all([
          api.artifact(projectId, artifactId),
          api.versions(projectId, artifactId),
        ]);
        if (!current) return;
        setFetchedDetails(loadedDetails);
        setFetchedVersions(loadedVersions);
        onCurrentVersionRef.current(loadedDetails.current.version.id);
      } catch (caught) {
        if (!current) return;
        setFetchedDetails(null);
        setFetchedVersions([]);
        setError(caught instanceof Error ? caught : new Error("Artifact details failed."));
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [artifactId, projectId]);

  const recordLoaded = details !== null;
  const recordCurrent = details?.current ?? null;
  const recordCurrentRef = useRef(recordCurrent);
  recordCurrentRef.current = recordCurrent;
  const recordCurrentVersionId = recordCurrent?.version.id ?? null;
  useEffect(() => {
    if (!recordLoaded || artifactId === null || versionId === null) {
      setFetchedVersion(null);
      return undefined;
    }
    const currentVersion = recordCurrentRef.current;
    if (currentVersion !== null && versionId === currentVersion.version.id) {
      setFetchedVersion(currentVersion);
      return undefined;
    }
    if (fetchedVersionRef.current?.version.id === versionId) return undefined;
    let current = true;
    setFetchedVersion(null);
    void (async () => {
      try {
        const loaded = await api.version(projectId, artifactId, versionId);
        if (current) setFetchedVersion(loaded);
      } catch (caught) {
        if (!current) return;
        setError(caught instanceof Error ? caught : new Error("Version loading failed."));
      }
    })();
    return () => {
      current = false;
    };
  }, [artifactId, projectId, recordCurrentVersionId, recordLoaded, versionId]);

  const refreshLinkedSource = useCallback(async (): Promise<void> => {
    if (artifactId === null || projectId === "") return;
    try {
      const refreshed = await api.artifact(projectId, artifactId);
      if (artifactRef.current === artifactId) setFetchedDetails(refreshed);
    } catch {
      // Ambient freshness never replaces the last readable artifact state.
    }
  }, [artifactId, projectId]);
  useCommentPoll(refreshLinkedSource, followLinkedSource && details?.sourceBinding !== undefined);

  const reload = useCallback(async (): Promise<{readonly details: ArtifactDetails; readonly shown: boolean} | null> => {
    if (artifactId === null || projectId === "") return null;
    const [reloaded, reloadedVersions] = await Promise.all([
      api.artifact(projectId, artifactId),
      api.versions(projectId, artifactId),
    ]);
    const shown = artifactRef.current === artifactId;
    if (shown) {
      setFetchedDetails(reloaded);
      setFetchedVersions(reloadedVersions);
    }
    return {details: reloaded, shown};
  }, [artifactId, projectId]);

  const patchArtifact = useCallback((artifact: ArtifactDetails["artifact"]): void => {
    setFetchedDetails((current) => current?.artifact.id === artifact.id ? {...current, artifact} : current);
  }, []);

  return {details, error, loading, patchArtifact, reload, setError, setLoading, version, versions};
}
