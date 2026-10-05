// Alias-free on purpose: the server's equivalence test imports this module from the repository root.

/** When a page was first listed and when it was last active, as epoch milliseconds. */
export interface PageDates {
  readonly activityAt: number;
  readonly createdAt: number;
}

/** One version's manifest, reduced to its page digests. */
export interface HistoryVersion {
  /** When the version was published, as epoch milliseconds. */
  readonly at: number;
  /** Path to SHA-256 digest for every file the manifest lists. */
  readonly files: ReadonlyMap<string, string>;
  readonly number: number;
}

/** One comment or reply on a page, as epoch milliseconds. A null path is a whole-version comment. */
export interface PageComment {
  readonly at: number;
  readonly path: string | null;
}

/**
 * The versions whose manifests a bounded read keeps: every version when the history
 * fits, otherwise the first and the newest `limit - 1`. The first keeps "created"
 * exact for pages present from the start; the newest keep "last changed" exact for
 * pages edited recently. A page first listed, or last changed, inside the skipped
 * gap is attributed to the first kept version after it, never to an earlier one.
 */
export function historyWindow<T>(ascending: readonly T[], limit: number): readonly T[] {
  if (limit < 2 || ascending.length <= limit) return ascending.slice(0, Math.max(limit, 0));
  return [...ascending.slice(0, 1), ...ascending.slice(ascending.length - (limit - 1))];
}

/**
 * The time one thread contributes to its page's activity: the later of its own
 * creation and its newest reply. `replyTimes` is null when the replies were not
 * read; a thread that has replies then falls back to its `updatedAt`, which every
 * reply touches, so the page is never shown as quieter than it is.
 */
export function threadActivity(
  thread: {readonly createdAt: string; readonly path: string | null; readonly replyCount: number; readonly updatedAt: string},
  replyTimes: readonly string[] | null,
): PageComment {
  const times = [thread.createdAt, ...(replyTimes ?? (thread.replyCount > 0 ? [thread.updatedAt] : []))]
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  return {at: times.length === 0 ? Number.NaN : Math.max(...times), path: thread.path};
}

/**
 * Created and last-activity dates for each gallery page, read from version manifests
 * and comments rather than from the preview index.
 *
 * - `createdAt` is the publication time of the first version whose manifest lists the page.
 *   A page that was removed and later re-added keeps its original creation.
 * - The last change is the latest version where the page's digest differs from the
 *   version before it. Re-adding a removed page counts as a change, even with identical bytes.
 * - `activityAt` is the later of that change and the newest comment or reply on the page.
 *   Whole-version comments (null path) belong to no single page.
 *
 * A page no kept version lists falls back to `fallbackAt` (the current version's time).
 */
export function galleryDates(
  history: readonly HistoryVersion[],
  paths: readonly string[],
  comments: readonly PageComment[],
  fallbackAt: number,
): ReadonlyMap<string, PageDates> {
  const ordered = history.toSorted((left, right) => left.number - right.number);
  const newestComment = new Map<string, number>();
  for (const comment of comments) {
    if (comment.path === null || !Number.isFinite(comment.at)) continue;
    newestComment.set(comment.path, Math.max(newestComment.get(comment.path) ?? comment.at, comment.at));
  }
  const dates = new Map<string, PageDates>();
  for (const path of paths) {
    let createdAt: number | null = null;
    let changedAt: number | null = null;
    let previous: string | undefined;
    for (const version of ordered) {
      const digest = version.files.get(path);
      if (digest !== undefined) {
        createdAt ??= version.at;
        if (digest !== previous) changedAt = version.at;
      }
      previous = digest;
    }
    const changed = changedAt ?? fallbackAt;
    const commented = newestComment.get(path);
    dates.set(path, {
      activityAt: commented === undefined ? changed : Math.max(changed, commented),
      createdAt: createdAt ?? fallbackAt,
    });
  }
  return dates;
}
