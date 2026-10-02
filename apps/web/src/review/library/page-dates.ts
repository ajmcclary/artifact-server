import {api, type CommentThread, type CommentThreadPage, type Manifest, type Version} from "@/api/client";
import type {RequestLimiter} from "@/lib/request-limiter";

import {galleryDates, historyWindow, threadActivity, type HistoryVersion, type PageDates} from "./design-library.ts";

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

// Version manifests are immutable, so a version's page digests are read once per session.
const manifestDigests = new Map<string, ReadonlyMap<string, string>>();
// A thread's replies cannot change without moving its updatedAt, so that pair keys them.
const replyTimes = new Map<string, readonly string[]>();

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

/** One artifact's pages as of one of its versions. */
export interface DatedVersion {
  readonly artifactId: string;
  /** The artifact's thread count when the caller already knows it; 0 skips reading comments. */
  readonly commentCount: number | null;
  readonly manifest: Manifest;
  readonly paths: readonly string[];
  readonly projectId: string;
  readonly version: Version;
}

/** Every thread on this artifact, up to the comment page bound. */
async function readThreads(limit: RequestLimiter, projectId: string, artifactId: string, wanted: () => boolean): Promise<CommentThread[]> {
  const threads: CommentThread[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maximumCommentPages; page += 1) {
    const after: string | null = cursor;
    // eslint-disable-next-line no-await-in-loop -- each page names the next cursor
    const read: CommentThreadPage = await limit(() => api.comments(projectId, artifactId, {
      cursor: after, dispatched: "include", limit: commentPageSize, revision: null, since: null, state: null, versionId: null,
    }));
    threads.push(...read.items);
    cursor = read.nextCursor;
    if (cursor === null || !wanted()) break;
  }
  return threads;
}

/**
 * Created and last-activity dates for an artifact's pages as of one version, from server
 * records: each kept version's manifest up to that version, and every comment and reply on
 * a page in those versions. The Library dates each gallery at its current version and an
 * artifact's gallery dates the version being viewed, both through this one read. Null once
 * `wanted` turns false.
 */
export async function pageDatesFor(
  limit: RequestLimiter,
  {artifactId, commentCount, manifest, paths, projectId, version: shown}: DatedVersion,
  wanted: () => boolean,
): Promise<ReadonlyMap<string, PageDates> | null> {
  remember(manifestDigests, `${artifactId}\u001f${shown.id}`, digestsOf(manifest), maximumCachedManifests);
  const listed = await limit(() => api.versions(projectId, artifactId));
  if (!wanted()) return null;
  const readable = listed.map(({version}) => version)
    .filter((version) => version.number <= shown.number)
    .toSorted((left, right) => left.number - right.number);
  const history = await Promise.all(historyWindow(readable, maximumHistoryVersions).map(async (version): Promise<HistoryVersion> => {
    const key = `${artifactId}\u001f${version.id}`;
    const files = manifestDigests.get(key)
      ?? remember(manifestDigests, key, digestsOf((await limit(() => api.version(projectId, artifactId, version.id))).manifest), maximumCachedManifests);
    return {at: Date.parse(version.createdAt), files, number: version.number};
  }));
  if (!wanted()) return null;
  const pages = new Set(paths);
  const versions = new Set(readable.map((version) => version.id));
  const threads = commentCount === 0
    ? []
    : (await readThreads(limit, projectId, artifactId, wanted))
      .filter((thread) => thread.path !== null && pages.has(thread.path) && versions.has(thread.versionId));
  if (!wanted()) return null;
  const replied = threads.filter((thread) => thread.replyCount > 0)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, maximumReplyReads);
  const replies = new Map(await Promise.all(replied.map(async (thread) => {
    const key = `${thread.id}\u001f${thread.updatedAt}`;
    const times = replyTimes.get(key) ?? remember(replyTimes, key,
      (await limit(() => api.comment(projectId, artifactId, thread.id))).replies.map((reply) => reply.createdAt),
      maximumCachedReplies);
    return [thread.id, times] as const;
  })));
  if (!wanted()) return null;
  return galleryDates(
    history,
    [...pages],
    threads.map((thread) => threadActivity(thread, replies.get(thread.id) ?? null)),
    Date.parse(shown.createdAt),
  );
}
