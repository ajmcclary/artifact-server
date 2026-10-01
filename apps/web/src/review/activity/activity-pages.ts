import type {ActivityEntry} from "@/api/client";

const threadOf = (entry: ActivityEntry): string | null => entry.kind === "thread" ? entry.thread?.id ?? null : null;

/** Append an older page, dropping entries (by id) or threads already shown nearer the top. */
export function appendPage(loaded: readonly ActivityEntry[], next: readonly ActivityEntry[]): ActivityEntry[] {
  const ids = new Set(loaded.map((entry) => entry.id));
  const threads = new Set(loaded.map(threadOf).filter((id): id is string => id !== null));
  const out = [...loaded];
  for (const entry of next) {
    const thread = threadOf(entry);
    if (ids.has(entry.id) || (thread !== null && threads.has(thread))) continue;
    ids.add(entry.id);
    if (thread !== null) threads.add(thread);
    out.push(entry);
  }
  return out;
}

/** Loaded entries and the cursor that continues below them. */
export interface FeedPages {
  readonly cursor: string | null;
  readonly entries: readonly ActivityEntry[];
}

/**
 * Put a re-read first page on top. When it reaches the loaded entries, keep the older ones and
 * their cursor; when more than a page happened since, start over from the new page and its
 * cursor, so the events in between are paged to rather than silently skipped.
 */
export function refreshFirstPage(
  loaded: FeedPages,
  first: {readonly items: readonly ActivityEntry[]; readonly nextCursor: string | null},
): FeedPages {
  if (first.nextCursor === null) return {cursor: null, entries: [...first.items]};
  const oldest = first.items.at(-1)?.at;
  const newestLoaded = loaded.entries[0]?.at;
  if (oldest === undefined || newestLoaded === undefined || oldest > newestLoaded) {
    return {cursor: first.nextCursor, entries: [...first.items]};
  }
  return {cursor: loaded.cursor, entries: appendPage(first.items, loaded.entries.filter((entry) => entry.at < oldest))};
}
