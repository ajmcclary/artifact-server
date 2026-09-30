import {useCallback, useEffect, useState} from "react";

import {api} from "@/api/client";
import {createRequestLimiter} from "@/lib/request-limiter";

import {
  maximumPreviewIndexBytes,
  parsePreviewIndex,
  previewIndexEntry,
  previewIndexPath,
} from "../workspace/design-gallery.ts";
import type {LibrarySource} from "./design-library.ts";

/** A bounded moving view: the first pages of a project's artifacts, read four at a time. */
const maximumArtifactPages = 20;
const concurrentReads = 4;

export interface LoadedLibrary {
  readonly failures: readonly string[];
  readonly loadedAt: Date;
  readonly scanned: number;
  readonly sources: readonly LibrarySource[];
  readonly truncated: boolean;
}

export type LibraryState =
  | {readonly status: "loading"}
  | {readonly status: "failed"; readonly message: string}
  | {
    readonly status: "ready";
    readonly library: LoadedLibrary;
    /** A re-read running, or failed, while this library stays on screen. */
    readonly refresh?: "failed" | "running";
  };

// Kept for the session so browser Back returns to the same moving view without refetching.
const loadedLibraries = new Map<string, LoadedLibrary>();

/**
 * Read one project's galleries; null once `wanted` turns false. The screen can
 * be left in place now, so an abandoned read stops issuing requests instead of
 * finishing hundreds nobody will see.
 */
async function loadLibrary(projectId: string, wanted: () => boolean): Promise<LoadedLibrary | null> {
  const artifacts: {readonly id: string; readonly name: string}[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    // eslint-disable-next-line no-await-in-loop -- each page names the next cursor
    const page = await api.artifacts(projectId, cursor, []);
    if (!wanted()) return null;
    artifacts.push(...page.artifacts.map(({artifact}) => ({id: artifact.id, name: artifact.name})));
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor !== null && pages < maximumArtifactPages);
  const limit = createRequestLimiter(concurrentReads);
  const failures: string[] = [];
  const read = await Promise.all(artifacts.map((artifact) => limit(async (): Promise<LibrarySource | null> => {
    if (!wanted()) return null;
    try {
      const details = await api.artifact(projectId, artifact.id);
      const entry = previewIndexEntry(details.current.manifest);
      if (entry === null) return null;
      if (entry.size > maximumPreviewIndexBytes) {
        failures.push(artifact.name);
        return null;
      }
      const versionId = details.current.version.id;
      const parsed = parsePreviewIndex(
        await api.versionFile(projectId, artifact.id, versionId, previewIndexPath),
        details.current.manifest.entries,
      );
      if (parsed.status !== "ready") {
        failures.push(artifact.name);
        return null;
      }
      return {artifactId: artifact.id, artifactName: artifact.name, indexTitle: parsed.title, items: parsed.items, versionId};
    } catch {
      failures.push(artifact.name);
      return null;
    }
  })));
  if (!wanted()) return null;
  return {
    failures: failures.toSorted((left, right) => left.localeCompare(right)),
    loadedAt: new Date(),
    scanned: artifacts.length,
    sources: read.filter((source) => source !== null)
      .toSorted((left, right) => left.artifactName.localeCompare(right.artifactName)),
    truncated: cursor !== null,
  };
}

export interface DesignLibraryHandle {
  /** Re-read every artifact's current version. */
  readonly refresh: () => void;
  readonly state: LibraryState;
}

/** Load one project's galleries once per session; `refresh` re-reads current versions. */
export function useDesignLibrary(projectId: string | null): DesignLibraryHandle {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<LibraryState>(() => {
    const cached = projectId === null ? undefined : loadedLibraries.get(projectId);
    return cached === undefined ? {status: "loading"} : {status: "ready", library: cached};
  });
  useEffect(() => {
    if (projectId === null) return undefined;
    const cached = loadedLibraries.get(projectId);
    if (cached !== undefined && revision === 0) {
      setState({status: "ready", library: cached});
      return undefined;
    }
    let current = true;
    // Refresh keeps the galleries on screen and swaps them when the re-read lands.
    setState((shown) => shown.status === "ready" ? {...shown, refresh: "running"} : {status: "loading"});
    void (async () => {
      try {
        const library = await loadLibrary(projectId, () => current);
        if (library === null) return;
        loadedLibraries.set(projectId, library);
        setState({status: "ready", library});
      } catch (caught) {
        if (!current) return;
        const message = caught instanceof Error ? caught.message : "The design library could not be read.";
        setState((shown) => shown.status === "ready" ? {...shown, refresh: "failed"} : {status: "failed", message});
      }
    })();
    return () => {
      current = false;
    };
  }, [projectId, revision]);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return {refresh, state};
}
