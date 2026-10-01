// One reverse-chronological activity timeline derived from review records. Pure: no React,
// no clock reads. Artifact Server keeps no unified activity log, so every event here is
// read from a record the server does hold: versions, threads, dispatches, access, members, keys.

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const pad = (n) => String(n).padStart(2, '0');

/** Epoch ms for an ISO string, `MM/DD HH:mm` (local, in `year`) or `MM/DD/YYYY` (local noon); NaN when unreadable. */
export function instantOf(value, year) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const s = value.trim();
  let m = /^(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/.exec(s);
  if (m) return new Date(year, +m[1] - 1, +m[2], +m[3], +m[4]).getTime();
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (m) return new Date(+m[3], +m[1] - 1, +m[2], 12, 0).getTime();
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return NaN;
  const t = Date.parse(s);
  return Number.isNaN(t) ? NaN : t;
}

/** Local wall clock, `HH:mm`. */
export function clock(ms) {
  const d = new Date(ms);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/* US display formats, in local time: MM/DD/YYYY and a 12-hour clock. Unreadable instants print nothing. */
export function usDate(ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return '';
  const d = new Date(ms);
  return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + '/' + d.getFullYear();
}
export function usTime(ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return '';
  const d = new Date(ms);
  const h = d.getHours();
  return ((h % 12) || 12) + ':' + pad(d.getMinutes()) + ' ' + (h < 12 ? 'AM' : 'PM');
}
export function usDateTime(ms) {
  return usDate(ms) && usDate(ms) + ' ' + usTime(ms);
}

const ROTATION = ['Claude', 'Dana Okonkwo', 'Codex'];

/**
 * Every version of an artifact, newest first. Fixture versions step back from the artifact's
 * `updated` date; the newest three belong to its publisher (so agent bursts read as bursts),
 * older ones rotate. Session versions (`published`) are placed above with their own times.
 */
export function versionHistory(artifact, { year, published = [] } = {}) {
  const latest = instantOf(artifact.updated, year) - 2 * HOUR;
  const out = [];
  for (let n = artifact.versions; n >= 1; n--) {
    const back = artifact.versions - n;
    out.push({ n, at: latest - back * 2 * DAY - (back % 3) * 3 * HOUR, by: back < 3 ? artifact.by : ROTATION[(back + 1) % 3] });
  }
  return published.slice().sort((x, y) => y.n - x.n).concat(out);
}

const firstLine = (text) => String(text || '').split('\n')[0];

function recordInstant(record, year) {
  return instantOf(record.at != null ? record.at : record.when, year);
}

/** Newest first; unreadable instants last; ties broken by id so order never flickers. */
export function sortEvents(events) {
  return events.slice().sort((x, y) => {
    const xn = Number.isNaN(x.at); const yn = Number.isNaN(y.at);
    if (xn !== yn) return xn ? 1 : -1;
    if (!xn && x.at !== y.at) return y.at - x.at;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });
}

export function buildEvents({ artifacts, threadsFor, versionsFor, dispatches = {}, accessLog = [], adminLog = [], groupOf, year }) {
  const events = [];
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  const about = (a) => ({ artifactId: a.id, artifactName: a.name, projectId: a.projectId, projectName: a.projectName, archived: !!a.archived });
  artifacts.forEach((a) => {
    const group = groupOf(a.id);
    threadsFor(a).forEach((t) => {
      const replies = t.replies || [];
      const stamps = [recordInstant(t, year)].concat(replies.map((r) => recordInstant(r, year)));
      const readable = stamps.filter((x) => !Number.isNaN(x));
      const at = readable.length ? Math.max(...readable) : NaN;
      const latest = replies.length ? replies[replies.length - 1] : t;
      const shown = { ...t, atMs: stamps[0], replies: replies.map((r, i) => ({ ...r, atMs: stamps[i + 1] })) };
      events.push({
        id: 'comment:' + t.key, type: 'comment', at, actor: latest.author, verb: replies.length ? 'replied on' : 'commented on',
        ...about(a), version: t.version, thread: shown, excerpt: firstLine(t.body),
        needsYou: !t.isResolved && group === 'Needs you', withAgent: !t.isResolved && group === 'With an agent', adminOnly: false,
      });
      if (t.isResolved && t.resolvedAt) {
        events.push({
          id: 'resolution:' + t.key, type: 'resolution', at: instantOf(t.resolvedAt, year), actor: t.resolvedBy || t.author,
          verb: 'resolved a conversation on', ...about(a), version: t.version, thread: t, excerpt: firstLine(t.body),
          needsYou: false, withAgent: false, adminOnly: false,
        });
      }
    });
    versionsFor(a).forEach((v) => {
      events.push({
        id: 'version:' + a.id + ':' + v.n, type: 'version', at: instantOf(v.at, year), actor: v.by, verb: 'published',
        ...about(a), version: v.n, fromVersion: v.n > 1 ? v.n - 1 : null, needsYou: false, withAgent: false, adminOnly: false,
      });
    });
    const d = dispatches[a.id];
    if (d) {
      const agent = (d.recipients && d.recipients.join(', ')) || String(d.state).split(' ').pop();
      events.push({
        id: 'agent:' + a.id, type: 'agent', at: instantOf(d.at, year), actor: d.by || 'Dana Okonkwo', verb: 'sent conversations on',
        ...about(a), agent, state: d.state, needsYou: false, withAgent: true, adminOnly: false,
      });
    }
  });
  accessLog.forEach((entry, i) => {
    const a = byId.get(entry.artifactId);
    if (!a) return;
    events.push({
      id: 'access:' + entry.artifactId + ':' + i, type: 'access', at: instantOf(entry.at, year), actor: entry.by, verb: 'changed access on',
      ...about(a), from: entry.from, to: entry.to, needsYou: false, withAgent: false, adminOnly: false,
    });
  });
  adminLog.forEach((entry) => {
    events.push({
      id: 'admin:' + entry.id, type: 'admin', at: instantOf(entry.at, year), actor: entry.actor, verb: entry.verb,
      detail: entry.detail, icon: entry.icon, needsYou: false, withAgent: false, adminOnly: true,
    });
  });
  return sortEvents(events);
}

export const TYPE_FILTERS = [
  { id: 'comments', label: 'Comments', types: ['comment', 'resolution'] },
  { id: 'versions', label: 'Versions', types: ['version'] },
  { id: 'agents', label: 'Agents', types: ['agent'] },
  { id: 'access', label: 'Access', types: ['access', 'admin'] },
];
export const SEGMENTS = ['All', 'Needs you', 'With an agent'];
export const PAGE_SIZE = 30;

/**
 * Consecutive version events by one publisher on one artifact — with nothing else on that
 * artifact between them — become one event spanning `firstVersion`…`version`, at the newest time.
 * Expects newest-first input.
 */
export function mergeBursts(events) {
  const out = [];
  const lastFor = new Map();
  events.forEach((e) => {
    const index = e.artifactId ? lastFor.get(e.artifactId) : undefined;
    const prev = index === undefined ? null : out[index];
    if (e.type === 'version' && prev && prev.type === 'version' && prev.actor === e.actor) {
      out[index] = { ...prev, firstVersion: Math.min(prev.firstVersion, e.version), count: prev.count + 1, fromVersion: e.fromVersion };
      return;
    }
    if (e.artifactId) lastFor.set(e.artifactId, out.length);
    out.push(e.type === 'version' ? { ...e, firstVersion: e.version, count: 1 } : e);
  });
  return out;
}

const searchText = (e) => [e.actor, e.artifactName, e.projectName, e.artifactId, e.detail, e.agent,
  e.thread && e.thread.body, ...((e.thread && e.thread.replies) || []).map((r) => r.body)].filter(Boolean).join(' ').toLowerCase();

export function filterEvents(events, { segment = 'All', projects = [], types = [], query = '', isAdmin = true } = {}) {
  const typeSet = types.length ? new Set(TYPE_FILTERS.filter((f) => types.includes(f.id)).flatMap((f) => f.types)) : null;
  const q = query.trim().toLowerCase();
  return events.filter((e) => (isAdmin || !e.adminOnly)
    && (segment !== 'Needs you' || e.needsYou)
    && (segment !== 'With an agent' || e.withAgent)
    && (!projects.length || projects.includes(e.projectId))
    && (!typeSet || typeSet.has(e.type))
    && (!q || searchText(e).includes(q)));
}

export function segmentCounts(events, { isAdmin = true } = {}) {
  const out = {};
  SEGMENTS.forEach((segment) => { out[segment] = filterEvents(events, { segment, isAdmin }).length; });
  return out;
}

export function dayKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function dayLabel(key, now) {
  if (key === dayKey(now)) return 'Today';
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (key === dayKey(y.getTime())) return 'Yesterday';
  const [Y, M, D] = key.split('-').map(Number);
  return WEEKDAYS[new Date(Y, M - 1, D).getDay()] + ' ' + pad(M) + '/' + pad(D) + '/' + Y;
}

export function groupByDay(events, now) {
  const groups = [];
  events.forEach((e) => {
    const key = Number.isNaN(e.at) ? 'undated' : dayKey(e.at);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, label: key === 'undated' ? 'Undated' : dayLabel(key, now), events: [] };
      groups.push(group);
    }
    group.events.push(e);
  });
  return groups;
}

export function pageEvents(events, limit = PAGE_SIZE) {
  return { visible: events.slice(0, limit), hasMore: events.length > limit, remaining: Math.max(0, events.length - limit) };
}
