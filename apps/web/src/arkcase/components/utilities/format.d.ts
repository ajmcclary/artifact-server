/** Anything `fmt.instant` reads: epoch ms, a Date, an ISO timestamp, `MM/DD/YYYY`, `YYYY-MM-DD` or `MM/DD HH:MM` (with `year`). */
export type FmtInstant = number | Date | string | null | undefined;

/** One recency bucket from `fmt.dateBucket`. */
export interface FmtDateBucket {
  /** Stable key: `upcoming`, `today`, `yesterday`, `week`, `last-week`, `month-YYYY-M` or `undated`. */
  key: string;
  /** The bucket's heading: "Upcoming", "Today", "Yesterday", "Earlier this week", "Last week", "September 2026" or "Undated". */
  label: string;
  /** The bucket's first instant in epoch ms (local midnight; `-Infinity` for Undated), for ordering buckets. */
  start: number;
}

/**
 * The display formats the design system states: MM/DD/YYYY, HH:MM:SS UTC, the HH:MM clock, m:ss elapsed, digests, bytes.
 * Null in, null out. `date`, `time`, `dateTime`, `clock` and `duration` read UTC; the `local*` members, `instant`,
 * `dayKey`, `relativeDay`, `dateBucket` and `timeRange` read the runtime's local time zone (the reader's wall clock).
 */
export interface Fmt {
  /** ISO timestamp → MM/DD/YYYY (UTC). */
  date(iso: string | null | undefined): string | null;
  /** ISO timestamp → HH:MM:SS UTC. */
  time(iso: string | null | undefined): string | null;
  /** date + ' ' + time. */
  dateTime(iso: string | null | undefined): string | null;
  /** ISO timestamp → HH:MM (UTC), the wall clock a list row prints. */
  clock(iso: string | null | undefined): string | null;
  /** Seconds → m:ss, or h:mm past an hour. */
  elapsed(seconds: number | null | undefined): string | null;
  /** sha256:e52cbe98…4d36d6a — head and tail a reader can match against a run directory. */
  digest(s: string | null | undefined, head?: number, tail?: number): string | null;
  /** Binary units: 500 B, 2.0 KB (÷1024), 5.00 MB. */
  bytes(n: number | null | undefined): string | null;
  /** 0.123 → '12.3%'. */
  pct(x: number | null | undefined, digits?: number): string | null;
  num(x: number | string | null | undefined, digits?: number): string | null;
  /** The count and its noun: '1 case', '3 cases', '3 people' (`many` defaults to `one` + 's'). */
  plural(n: number, one: string, many?: string): string;
  /** Two ISO timestamps → '42 s' or '3 min 4 s'. */
  duration(a: string | null | undefined, b: string | null | undefined): string | null;
  /** snake_or-kebab → 'Snake or kebab'. */
  title(s: string | null | undefined): string;
  /**
   * Epoch ms (local time zone), or NaN when unreadable. Numbers and Dates pass through; a full ISO timestamp keeps its
   * own offset (local wall time without one; `YYYY-MM-DD HH:MM:SS` with a space reads as the `T` form); a date-only
   * `MM/DD/YYYY` or `YYYY-MM-DD` reads as that local day at `hour` (default 0); `MM/DD HH:MM` reads as local wall time
   * in `year` (NaN without one). A day or clock that does not exist (`02/30/2026`, `2026-13-45`) is NaN, never rolled
   * over, so the `local*` members return such a string unchanged. Free text is NaN.
   */
  instant(value: FmtInstant, options?: { year?: number; hour?: number }): number;
  /** Local MM/DD/YYYY. Absent, NaN or ±Infinity → null; an unreadable string comes back as given. */
  localDate(value: FmtInstant): string | null;
  /** Local 12-hour clock '9:05 AM', or with `hour12: false` the 24-hour '09:05'. */
  localTime(value: FmtInstant, options?: { hour12?: boolean }): string | null;
  /** Local '09/24/2026 2:05 PM'. */
  localDateTime(value: FmtInstant): string | null;
  /** The local calendar day an instant falls on, 'YYYY-MM-DD'; null when unreadable. */
  dayKey(value: FmtInstant): string | null;
  /** 'Today' or 'Yesterday' against `now` in local days, else null. Accepts an instant or a `dayKey`. */
  relativeDay(value: FmtInstant, now?: number | Date): 'Today' | 'Yesterday' | null;
  /** Upcoming (a local day after `now`'s), Today (any time on `now`'s day), Yesterday, Earlier this week (weeks start Monday), Last week, then the month; Undated when unreadable. */
  dateBucket(value: FmtInstant, now?: number | Date): FmtDateBucket;
  /** A local clock span on one day: '10:00–10:12 AM', '11:50 AM–12:10 PM', or one time when they agree. */
  timeRange(from: FmtInstant, to: FmtInstant): string | null;
  /** 'A', 'A and B', 'A, B and C', or past `shown` (default 2) 'A, B and 2 more'. */
  listPreview(names: readonly string[] | null | undefined, shown?: number): string;
}

export const fmt: Fmt;
