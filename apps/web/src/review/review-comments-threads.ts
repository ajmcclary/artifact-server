import type { CommentThread, CommentThreadPage } from "@/api/client";

export interface ThreadListingResult {
  readonly threads: readonly CommentThread[];
  readonly revision: number;
}

/**
 * Walk every page of a thread listing, pinning reads to the revision seen on
 * page 1. If a deeper page reports a different revision the listing is
 * inconsistent (a concurrent mutation rewrote the table while we paginated),
 * so the whole walk restarts from page 1. After `maxAttempts` failures the
 * caller gets an error it can surface as "please reload".
 *
 * When `revision` is provided and matches page 1's revision, the server has
 * not changed since the caller last looked, so the walk short-circuits to an
 * empty result carrying the same revision.
 */
export async function loadAllThreadsPaged(
  fetchPage: (cursor: string | null) => Promise<CommentThreadPage>,
  revision: number | null = null,
  maxAttempts = 3,
): Promise<ThreadListingResult> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Each attempt starts fresh at page one; sequential pagination is required
    // because a page's nextCursor is needed before the following page can be
    // fetched.
    // eslint-disable-next-line no-await-in-loop
    const firstPage = await fetchPage(null);
    if (revision !== null && firstPage.revision === revision) {
      return { threads: [], revision: firstPage.revision };
    }
    const pageOneRevision = firstPage.revision;
    const items: CommentThread[] = [...firstPage.items];
    let cursor = firstPage.nextCursor;
    let consistent = true;
    while (cursor !== null) {
      // eslint-disable-next-line no-await-in-loop
      const page = await fetchPage(cursor);
      if (page.revision !== pageOneRevision) {
        consistent = false;
        break;
      }
      items.push(...page.items);
      cursor = page.nextCursor;
    }
    if (consistent) {
      return { threads: items, revision: pageOneRevision };
    }
  }
  throw new Error("Comment listing revisions changed repeatedly; try reloading.");
}
