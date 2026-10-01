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

/** Put a re-read first page on top; keep older loaded entries the new page does not supersede. */
export function refreshFirstPage(loaded: readonly ActivityEntry[], first: readonly ActivityEntry[]): ActivityEntry[] {
  const oldest = first.at(-1)?.at;
  const older = oldest === undefined ? [] : loaded.filter((entry) => entry.at < oldest);
  return appendPage(first, older);
}
