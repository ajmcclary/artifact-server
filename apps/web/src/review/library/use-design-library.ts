import {useCallback, useEffect, useRef, useState} from "react";

import {api, type Manifest, type Version} from "@/api/client";
import {createRequestLimiter} from "@/lib/request-limiter";

import {
  maximumPreviewIndexBytes,
  parsePreviewIndex,
  previewIndexEntry,
  previewIndexPath,
  type GalleryIndexItem,
} from "../workspace/design-gallery.ts";
import {galleryDates, type LibrarySource, type PageDates} from "./design-library.ts";
import {pageDatesFor} from "./page-dates.ts";

/** A bounded moving view: the first artifact pages across every project, read four at a time. */
const maximumArtifactPages = 20;
const concurrentReads = 4;

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
const byName = (left: string, right: string) => left.localeCompare(right);

interface ListedArtifact {
  readonly commentCount: number;
  readonly id: string;
  readonly name: string;
  readonly project: LibraryProject;
}

interface FoundGallery {
  readonly artifact: ListedArtifact;
  readonly current: Version;
  readonly indexTitle: string;
  readonly items: readonly GalleryIndexItem[];
}

/**
 * Read every project's galleries; null once `wanted` turns false. The screen can
 * be left in place, so an abandoned read stops issuing requests instead of
 * finishing hundreds nobody will see.
 */
async function loadLibrary(projects: readonly LibraryProject[], wanted: () => boolean): Promise<LoadedLibrary | null> {
  const artifacts: ListedArtifact[] = [];
  let pages = 0;
  let truncated = false;
  for (const project of projects) {
    let cursor: string | null = null;
    do {
      if (pages >= maximumArtifactPages) {
        truncated = true;
        break;
      }
      // eslint-disable-next-line no-await-in-loop -- each page names the next cursor
      const page = await api.artifacts(project.id, cursor, []);
      if (!wanted()) return null;
      artifacts.push(...page.artifacts.map(({artifact, commentCount}) => ({commentCount, id: artifact.id, name: artifact.name, project})));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    if (truncated) break;
  }
  // One limiter for the whole read. Every task holds a slot for its own requests only
  // and never waits on another limited task, so the fan-out cannot deadlock.
  const limit = createRequestLimiter(concurrentReads);
  const failures: string[] = [];
  const undated: string[] = [];
  const read = await Promise.all(artifacts.map(async (artifact): Promise<LibrarySource | null> => {
    if (!wanted()) return null;
    const projectId = artifact.project.id;
    let found: {readonly gallery: FoundGallery; readonly manifest: Manifest} | null;
    try {
      found = await limit(async () => {
        const details = await api.artifact(projectId, artifact.id);
        const entry = previewIndexEntry(details.current.manifest);
        if (entry === null) return null;
        if (entry.size > maximumPreviewIndexBytes) throw new Error("The preview index is too large.");
        const current = details.current.version;
        const parsed = parsePreviewIndex(
          await api.versionFile(projectId, artifact.id, current.id, previewIndexPath),
          details.current.manifest.entries,
        );
        if (parsed.status !== "ready") throw new Error("The preview index is unreadable.");
        return {gallery: {artifact, current, indexTitle: parsed.title, items: parsed.items}, manifest: details.current.manifest};
      });
    } catch {
      failures.push(artifact.name);
      return null;
    }
    if (found === null || !wanted()) return null;
    const {gallery} = found;
    let dates: ReadonlyMap<string, PageDates> | null;
    try {
      dates = await pageDatesFor(limit, {
        artifactId: artifact.id,
        commentCount: artifact.commentCount,
        manifest: found.manifest,
        paths: gallery.items.map((item) => item.path),
        projectId,
        version: gallery.current,
      }, wanted);
    } catch {
      // The gallery stays readable; only its dates fall back to the current version.
      undated.push(artifact.name);
      dates = galleryDates([], gallery.items.map((item) => item.path), [], Date.parse(gallery.current.createdAt));
    }
    if (dates === null) return null;
    return {
      artifactId: artifact.id, artifactName: artifact.name, dates, indexTitle: gallery.indexTitle, items: gallery.items,
      projectId, projectName: artifact.project.name, versionId: gallery.current.id,
    };
  }));
  if (!wanted()) return null;
  return {
    failures: failures.toSorted(byName),
    loadedAt: new Date(),
    scanned: artifacts.length,
    sources: read.filter((source) => source !== null)
      .toSorted((left, right) => left.projectName.localeCompare(right.projectName) || left.artifactName.localeCompare(right.artifactName)),
    truncated,
    undated: undated.toSorted(byName),
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
        const library = await loadLibrary(projectsRef.current, () => current);
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
