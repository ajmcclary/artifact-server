/**
 * ArkCase fmt — the display formats the system states in words and every consumer wrote
 * again: MM/DD/YYYY on every display surface (ISO only in inputs and payloads), HH:MM:SS UTC,
 * the HH:MM wall clock a list row prints, m:ss elapsed, the head-and-tail digest a reader can
 * match against a run directory, bytes, percentages and plurals. Promoted verbatim from the
 * ExtractionKit prototype's ek-core.js; null in, null out, so an absent value stays absent.
 *
 * Two clocks, never mixed in one member: `date`, `time`, `dateTime`, `clock` and `duration` read
 * an ISO timestamp in UTC (a record's own time, the same for every reader). The `local*`
 * members, `instant`, `dayKey`, `relativeDay`, `dateBucket` and `timeRange` read the runtime's
 * local time zone (the reader's wall clock: an activity feed, "Today", "Last week"); promoted
 * from the ArkCase Artifacts review prototype, which had four parsers that disagreed.
 */
const pad = (n) => (n < 10 ? '0' + n : String(n));
const absent = (v) => v == null || v === '';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const midnight = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d; };
const daysBefore = (day, n) => { const d = new Date(day); d.setDate(d.getDate() - n); return d; };
/* A real calendar day and wall-clock time: `02/30/2026` or `2026-13-45` is unreadable, never
   rolled over into the next month. Month is 1-based. */
const daysIn = (y, m) => [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const realDay = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
const realClock = (h, mi, sec = 0) => h <= 23 && mi <= 59 && sec <= 59;
/* A local wall-clock instant, or NaN when the day or the clock does not exist on the calendar. */
const localInstant = (y, m, d, h = 0, mi = 0) => (realDay(y, m, d) && realClock(h, mi) ? new Date(y, m - 1, d, h, mi).getTime() : NaN);

export const fmt = {
  date(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return pad(d.getUTCMonth() + 1) + '/' + pad(d.getUTCDate()) + '/' + d.getUTCFullYear();
  },
  time(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + ' UTC';
  },
  dateTime(iso) { return iso ? fmt.date(iso) + ' ' + fmt.time(iso) : null; },
  clock(iso) { const t = fmt.time(iso); return t ? t.slice(0, 5) : null; },
  elapsed(seconds) {
    if (seconds == null || isNaN(seconds) || seconds < 0) return null;
    const s = Math.round(seconds);
    if (s >= 3600) return Math.floor(s / 3600) + ':' + String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  },
  digest(s, head, tail) {
    if (!s) return null;
    const str = String(s);
    const colon = str.indexOf(':');
    const prefix = colon > -1 ? str.slice(0, colon + 1) : '';
    const hex = colon > -1 ? str.slice(colon + 1) : str;
    const h = head || 8; const t = tail || 6;
    return hex.length > h + t + 1 ? prefix + hex.slice(0, h) + '…' + hex.slice(-t) : str;
  },
  bytes(n) {
    if (n == null) return null;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  },
  pct(x, digits) { return x == null ? null : (x * 100).toFixed(digits == null ? 1 : digits) + '%'; },
  num(x, digits) { return x == null ? null : typeof x === 'number' ? (Number.isInteger(x) ? String(x) : x.toFixed(digits == null ? 3 : digits)) : String(x); },
  plural(n, one, many) { return n + ' ' + (n === 1 ? one : many || one + 's'); },
  duration(a, b) {
    if (!a || !b) return null;
    const ms = new Date(b).getTime() - new Date(a).getTime();
    if (isNaN(ms) || ms < 0) return null;
    const s = Math.round(ms / 1000);
    return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s';
  },
  title(s) { return String(s || '').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()); },

  /* ---- Local time: the reader's wall clock. ---- */

  /**
   * Epoch ms for an instant, or NaN when unreadable. Numbers and Dates pass through. Strings:
   * a full ISO timestamp (its own offset, UTC when it ends in Z, local wall time without one;
   * a space may stand for the `T`); a date-only `MM/DD/YYYY` or `YYYY-MM-DD` as that local
   * calendar day at `hour` (default 0, its start); `MM/DD HH:MM` as local wall time in `year`
   * (NaN without one). A day or clock that does not exist (`02/30/2026`, `2026-13-45`, `25:00`)
   * is NaN, never rolled over. Free text ("just now") is NaN.
   */
  instant(value, { year, hour = 0 } = {}) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    if (typeof value !== 'string' || !value.trim()) return NaN;
    const s = value.trim();
    let m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
    if (m) return localInstant(+m[3], +m[1], +m[2], hour);
    m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) return localInstant(+m[1], +m[2], +m[3], hour);
    m = /^(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/.exec(s);
    if (m) return year == null ? NaN : localInstant(year, +m[1], +m[2], +m[3], +m[4]);
    m = /^(\d{4})-(\d{2})-(\d{2})[T ](.+)$/.exec(s);
    if (!m || !realDay(+m[1], +m[2], +m[3])) return NaN;
    const clock = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(m[4]);
    if (clock && !realClock(+clock[1], +clock[2], clock[3] == null ? 0 : +clock[3])) return NaN;
    /* `2026-09-24 10:00:00` is not an ECMAScript date-time string, so engines disagree on it;
       with the `T` it is local wall time everywhere. */
    const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}`);
    return Number.isNaN(t) ? NaN : t;
  },
  /** Local `MM/DD/YYYY`. Absent, NaN or ±Infinity → null; an unreadable string comes back as given. */
  localDate(value) {
    if (absent(value)) return null;
    const ms = fmt.instant(value);
    if (!Number.isFinite(ms)) return typeof value === 'string' ? value : null;
    const d = new Date(ms);
    return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + '/' + d.getFullYear();
  },
  /** Local 12-hour clock, `9:05 AM`; `{ hour12: false }` gives the 24-hour `09:05`. */
  localTime(value, { hour12 = true } = {}) {
    if (absent(value)) return null;
    const ms = fmt.instant(value);
    if (!Number.isFinite(ms)) return typeof value === 'string' ? value : null;
    const d = new Date(ms);
    const h = d.getHours();
    if (!hour12) return pad(h) + ':' + pad(d.getMinutes());
    return ((h % 12) || 12) + ':' + pad(d.getMinutes()) + ' ' + (h < 12 ? 'AM' : 'PM');
  },
  /** localDate + ' ' + localTime: `09/24/2026 2:05 PM`. */
  localDateTime(value) {
    if (absent(value)) return null;
    const ms = fmt.instant(value);
    if (!Number.isFinite(ms)) return typeof value === 'string' ? value : null;
    return fmt.localDate(ms) + ' ' + fmt.localTime(ms);
  },
  /** The local calendar day an instant falls on, `YYYY-MM-DD` (a key for grouping by day); null when unreadable. */
  dayKey(value) {
    const ms = fmt.instant(value);
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  },
  /** `Today` or `Yesterday` against `now` (local days), else null. Takes an instant or a `dayKey`. */
  relativeDay(value, now = Date.now()) {
    const key = fmt.dayKey(value);
    if (!key) return null;
    if (key === fmt.dayKey(now)) return 'Today';
    return key === fmt.dayKey(daysBefore(midnight(fmt.instant(now)), 1).getTime()) ? 'Yesterday' : null;
  },
  /**
   * The recency bucket an instant falls in against `now`, in local days: Upcoming (a later
   * local day than `now`'s), Today (any time on `now`'s day, a few minutes ahead included),
   * Yesterday, Earlier this week (weeks start Monday), Last week, then its month
   * ("September 2026"); Undated when unreadable. `{ key, label, start }`, `start` the bucket's
   * first ms for sorting (Upcoming sorts above Today, newest first).
   */
  dateBucket(value, now = Date.now()) {
    const ms = fmt.instant(value);
    if (!Number.isFinite(ms)) return { key: 'undated', label: 'Undated', start: -Infinity };
    const today = midnight(fmt.instant(now));
    const day = midnight(ms);
    const tomorrow = daysBefore(today, -1);
    const yesterday = daysBefore(today, 1);
    const week = daysBefore(today, (today.getDay() + 6) % 7);
    const lastWeek = daysBefore(week, 7);
    if (day >= tomorrow) return { key: 'upcoming', label: 'Upcoming', start: tomorrow.getTime() };
    if (day >= today) return { key: 'today', label: 'Today', start: today.getTime() };
    if (day >= yesterday) return { key: 'yesterday', label: 'Yesterday', start: yesterday.getTime() };
    if (day >= week) return { key: 'week', label: 'Earlier this week', start: week.getTime() };
    if (day >= lastWeek) return { key: 'last-week', label: 'Last week', start: lastWeek.getTime() };
    const month = new Date(day.getFullYear(), day.getMonth(), 1);
    return { key: `month-${month.getFullYear()}-${month.getMonth() + 1}`, label: `${MONTHS[month.getMonth()]} ${month.getFullYear()}`, start: month.getTime() };
  },
  /** A local clock span on one day: `10:00–10:12 AM`, `11:50 AM–12:10 PM`, or one time when they agree. */
  timeRange(from, to) {
    const a = fmt.localTime(from); const b = fmt.localTime(to);
    if (!a || !b || a === b) return b || a || null;
    const [ta, pa] = a.split(' '); const [, pb] = b.split(' ');
    return pa === pb ? ta + '–' + b : a + '–' + b;
  },
  /** Names as a phrase: `A`, `A and B`, `A, B and C`, or past `shown` `A, B and 2 more`. */
  listPreview(names, shown = 2) {
    const list = (names || []).map(String);
    if (list.length <= 1) return list.join('');
    if (list.length <= shown) return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
    return list.slice(0, shown).join(', ') + ' and ' + (list.length - shown) + ' more';
  },
};
