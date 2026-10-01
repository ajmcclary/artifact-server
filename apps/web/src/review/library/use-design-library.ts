import {useCallback, useEffect, useRef, useState} from "react";

import {api, type CommentThread, type CommentThreadPage, type Manifest, type Version} from "@/api/client";
import {createRequestLimiter, type RequestLimiter} from "@/lib/request-limiter";

import {
  maximumPreviewIndexBytes,
  parsePreviewIndex,
  previewIndexEntry,
  previewIndexPath,
  type GalleryIndexItem,
} from "../workspace/design-gallery.ts";
import {
  galleryDates,
  historyWindow,
  threadActivity,
  type HistoryVersion,
  type LibrarySource,
  type PageDates,
} from "./design-library.ts";

/** A bounded moving view: the first artifact pages across every project, read four at a time. */
const maximumArtifactPages = 20;
const concurrentReads = 4;
/**
 * Dates read at most this many manifests per gallery: the first version and the
 * newest ones (see `historyWindow`). Longer histories attribute a page created or
 * changed inside the skipped gap to the first kept version after it.
 */
const maximumHistoryVersions = 40;
/** Comment pages read per gallery; threads past them do not count toward activity. */
const maximumCommentPages = 5;
const commentPageSize = 100;
/** Threads whose replies are read exactly; the rest use their `updatedAt`, which every reply touches. */
const maximumReplyReads = 40;
const maximumCachedManifests = 4_000;
const maximumCachedReplies = 4_000;

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
// Version manifests are immutable, so a version's page digests are read once per session.
const manifestDigests = new Map<string, ReadonlyMap<string, string>>();
// A thread's replies cannot change without moving its updatedAt, so that pair keys them.
const replyTimes = new Map<string, readonly string[]>();

const byName = (left: string, right: string) => left.localeCompare(right);

function remember<V>(cache: Map<string, V>, key: string, value: V, capacity: number): V {
  if (!cache.has(key) && cache.size >= capacity) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
  cache.set(key, value);
  return value;
}

const digestsOf = (manifest: Manifest): ReadonlyMap<string, string> =>
  new Map(manifest.entries.map((entry) => [entry.path, entry.sha256]));

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

/** Every thread on this artifact, up to the comment page bound. */
async function readThreads(limit: RequestLimiter, artifact: ListedArtifact, wanted: () => boolean): Promise<CommentThread[]> {
  const threads: CommentThread[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maximumCommentPages; page += 1) {
    const after: string | null = cursor;
    // eslint-disable-next-line no-await-in-loop -- each page names the next cursor
    const read: CommentThreadPage = await limit(() => api.comments(artifact.project.id, artifact.id, {
      cursor: after, dispatched: "include", limit: commentPageSize, revision: null, since: null, state: null, versionId: null,
    }));
    threads.push(...read.items);
    cursor = read.nextCursor;
    if (cursor === null || !wanted()) break;
  }
  return threads;
}

/**
 * Dates for one gallery's pages from server records: each kept version's manifest and
 * every comment and reply on a page, both limited to versions up to the current one.
 */
async function readDates(
  limit: RequestLimiter,
  gallery: FoundGallery,
  currentManifest: Manifest,
  wanted: () => boolean,
): Promise<ReadonlyMap<string, PageDates> | null> {
  const {artifact, current} = gallery;
  const projectId = artifact.project.id;
  remember(manifestDigests, `${artifact.id}\u001f${current.id}`, digestsOf(currentManifest), maximumCachedManifests);
  const listed = await limit(() => api.versions(projectId, artifact.id));
  if (!wanted()) return null;
  const readable = listed.map(({version}) => version)
    .filter((version) => version.number <= current.number)
    .toSorted((left, right) => left.number - right.number);
  const history = await Promise.all(historyWindow(readable, maximumHistoryVersions).map(async (version): Promise<HistoryVersion> => {
    const key = `${artifact.id}\u001f${version.id}`;
    const files = manifestDigests.get(key)
      ?? remember(manifestDigests, key, digestsOf((await limit(() => api.version(projectId, artifact.id, version.id))).manifest), maximumCachedManifests);
    return {at: Date.parse(version.createdAt), files, number: version.number};
  }));
  if (!wanted()) return null;
  const paths = new Set(gallery.items.map((item) => item.path));
  const versions = new Set(readable.map((version) => version.id));
  const threads = artifact.commentCount === 0
    ? []
    : (await readThreads(limit, artifact, wanted))
      .filter((thread) => thread.path !== null && paths.has(thread.path) && versions.has(thread.versionId));
  if (!wanted()) return null;
  const replied = threads.filter((thread) => thread.replyCount > 0)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, maximumReplyReads);
  const replies = new Map(await Promise.all(replied.map(async (thread) => {
    const key = `${thread.id}\u001f${thread.updatedAt}`;
    const times = replyTimes.get(key) ?? remember(replyTimes, key,
      (await limit(() => api.comment(projectId, artifact.id, thread.id))).replies.map((reply) => reply.createdAt),
      maximumCachedReplies);
    return [thread.id, times] as const;
  })));
  if (!wanted()) return null;
  return galleryDates(
    history,
    [...paths],
    threads.map((thread) => threadActivity(thread, replies.get(thread.id) ?? null)),
    Date.parse(current.createdAt),
  );
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
      dates = await readDates(limit, gallery, found.manifest, wanted);
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
        const message = caught instanceof Error ? caught.message : "The design library could not be read.";
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
