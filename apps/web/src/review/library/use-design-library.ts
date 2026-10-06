import {useCallback, useEffect, useRef, useState} from "react";

import {api} from "@/api/client";

import type {LibrarySource} from "./design-library.ts";

/** One project the library reads. */
export interface LibraryProject {
  readonly id: string;
  readonly name: string;
}

const emptyLibrary = (): LoadedLibrary => ({failures: [], loadedAt: new Date(), scanned: 0, sources: [], truncated: false, undated: []});

export interface LoadedLibrary {
  readonly failures: readonly string[];
  readonly loadedAt: Date;
  readonly scanned: number;
  readonly sources: readonly LibrarySource[];
  readonly truncated: boolean;
  /** Galleries whose history could not be read, dated by their current version alone. */
  readonly undated: readonly string[];
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

/** Read the server-assembled Library; null once `wanted` turns false. */
async function loadLibrary(wanted: () => boolean): Promise<LoadedLibrary | null> {
  const response = await api.library();
  if (!wanted()) return null;
  return {
    failures: response.unreadable,
    loadedAt: new Date(),
    scanned: response.examined,
    sources: response.galleries.map((gallery): LibrarySource => ({
      artifactId: gallery.artifactId,
      artifactName: gallery.artifactName,
      dates: new Map(gallery.items.map((item) => [item.path, {
        activityAt: Date.parse(item.activityAt),
        createdAt: Date.parse(item.createdAt),
      }])),
      indexTitle: gallery.indexTitle,
      items: gallery.items.map((item) => ({
        description: item.description,
        kind: item.kind,
        path: item.path,
        related: item.related,
        section: item.section,
        thumbnailPath: item.thumbnailPath,
        title: item.title,
        viewport: item.viewport,
      })),
      projectId: gallery.projectId,
      projectName: gallery.projectName,
      versionId: gallery.versionId,
    })),
    truncated: response.truncated,
    undated: [],
  };
}

export interface DesignLibraryHandle {
  /** Re-read every artifact's current version. */
  readonly refresh: () => void;
  readonly state: LibraryState;
}

/** Load every project's galleries once per session; `refresh` re-reads current versions. */
export function useDesignLibrary(projects: readonly LibraryProject[]): DesignLibraryHandle {
  const key = projects.map((project) => project.id).join("\u001f");
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<LibraryState>(() => {
    const cached = loadedLibraries.get(key);
    return cached === undefined ? {status: "loading"} : {status: "ready", library: cached};
  });
  useEffect(() => {
    if (key === "") {
      setState({status: "ready", library: emptyLibrary()});
      return undefined;
    }
    const cached = loadedLibraries.get(key);
    if (cached !== undefined && revision === 0) {
      setState({status: "ready", library: cached});
      return undefined;
    }
    let current = true;
    // Refresh keeps the galleries on screen and swaps them when the re-read lands.
    setState((shown) => shown.status === "ready" ? {...shown, refresh: "running"} : {status: "loading"});
    void (async () => {
      try {
        const library = await loadLibrary(() => current);
        if (library === null) return;
        loadedLibraries.set(key, library);
        setState({status: "ready", library});
      } catch (caught) {
        if (!current) return;
        const message = caught instanceof Error ? caught.message : "The library could not be read.";
        setState((shown) => shown.status === "ready" ? {...shown, refresh: "failed"} : {status: "failed", message});
      }
    })();
    return () => {
      current = false;
    };
  }, [key, revision]);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return {refresh, state};
}
