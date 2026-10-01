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
          verb: 'resolved a conversation on', ...about(a), version: t.version, thread: shown, excerpt: firstLine(t.body),
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

/* The events an entry stands for: a burst's items, an artifact group's events, or the event itself. */
export function membersOf(e) {
  if (e.kind === 'burst') return e.items;
  if (e.kind === 'artifact') return e.events;
  return [e];
}

/**
 * Narrows events or grouped entries. A group matches when any event it holds matches, so a
 * person, project, type or search hit anywhere in a burst or an artifact's day keeps the entry.
 */
export function filterEvents(events, { segment = 'All', people = [], projects = [], types = [], query = '', isAdmin = true } = {}) {
  const typeSet = types.length ? new Set(TYPE_FILTERS.filter((f) => types.includes(f.id)).flatMap((f) => f.types)) : null;
  const q = query.trim().toLowerCase();
  const any = (e, test) => membersOf(e).some(test);
  return events.filter((e) => (isAdmin || !e.adminOnly)
    && (segment !== 'Needs you' || e.needsYou)
    && (segment !== 'With an agent' || e.withAgent)
    && (!people.length || any(e, (m) => people.includes(m.actor)))
    && (!projects.length || any(e, (m) => projects.includes(m.projectId)))
    && (!typeSet || any(e, (m) => typeSet.has(m.type)))
    && (!q || any(e, (m) => searchText(m).includes(q))));
}

/**
 * Everyone the people filter offers, with how many entries each appears in: active members,
 * then any other person the entries name, then the agents. `self` marks the signed-in reviewer.
 */
export function peopleOf(events, { members = [], agents = [], self = null, isAdmin = true } = {}) {
  const count = (name) => filterEvents(events, { people: [name], isAdmin }).length;
  const agentNames = agents.map((a) => a.name);
  const humans = members.filter((m) => !m.status || m.status === 'Active').map((m) => m.name);
  const seen = new Set();
  events.forEach((e) => membersOf(e).forEach((m) => { if (m.actor) seen.add(m.actor); }));
  const others = [...seen].filter((n) => !humans.includes(n) && !agentNames.includes(n)).sort();
  const person = (name, agent) => ({ id: name, name, agent, count: count(name), ...(name === self ? { self: true } : {}) });
  return humans.concat(others).map((n) => person(n, false)).concat(agentNames.map((n) => person(n, true)));
}

export const BURST_WINDOW = 30 * 60 * 1000;
const BURST_TYPES = ['version', 'access'];
const weight = (e) => e.count || 1;

function burstOf(items) {
  const first = items[0];
  const projects = [];
  items.forEach((i) => {
    let p = projects.find((x) => x.id === i.projectId);
    if (!p) { p = { id: i.projectId, name: i.projectName, count: 0 }; projects.push(p); }
    p.count += weight(i);
  });
  return {
    id: 'burst:' + first.id, kind: 'burst', type: first.type, actor: first.actor, verb: first.verb, items, projects,
    count: items.reduce((n, i) => n + weight(i), 0), at: first.at, firstAt: items[items.length - 1].at,
    archived: items.every((i) => i.archived), needsYou: items.some((i) => i.needsYou), withAgent: items.some((i) => i.withAgent),
    adminOnly: items.every((i) => i.adminOnly),
  };
}

/**
 * Consecutive version or access events (newest first) by one actor, on any artifacts in any
 * projects, within `windowMs` of the newest and on its day, collapse into one burst. A run of
 * one stays the event it was. Apply after `mergeBursts`.
 */
export function groupBursts(events, { windowMs = BURST_WINDOW } = {}) {
  const out = [];
  let run = null;
  const close = () => {
    if (run) out.push(run.length > 1 ? burstOf(run) : run[0]);
    run = null;
  };
  events.forEach((e) => {
    const burstable = BURST_TYPES.includes(e.type) && !Number.isNaN(e.at);
    const lead = run && run[0];
    if (lead && burstable && e.type === lead.type && e.actor === lead.actor
      && lead.at - e.at <= windowMs && dayKey(e.at) === dayKey(lead.at)) {
      run.push(e);
      return;
    }
    close();
    if (burstable) run = [e];
    else out.push(e);
  });
  close();
  return out;
}

const THREAD_TYPES = ['comment', 'resolution'];

/**
 * Within one day (newest first), every comment, resolution and agent event on an artifact
 * that has a conversation that day becomes one entry at the newest one's place: its actors
 * (newest first), one thread per conversation, and the agent hand-off as `agent`. An agent
 * event on an artifact with no conversation that day stays its own entry.
 */
export function groupByArtifact(dayEvents) {
  const talked = new Set(dayEvents.filter((e) => e.artifactId && THREAD_TYPES.includes(e.type)).map((e) => e.artifactId));
  const groups = new Map();
  const out = [];
  dayEvents.forEach((e) => {
    if (!talked.has(e.artifactId) || !(THREAD_TYPES.includes(e.type) || e.type === 'agent')) { out.push(e); return; }
    let g = groups.get(e.artifactId);
    if (!g) {
      g = {
        id: 'artifact:' + e.artifactId + ':' + (Number.isNaN(e.at) ? 'undated' : dayKey(e.at)), kind: 'artifact', type: 'comment',
        artifactId: e.artifactId, artifactName: e.artifactName, projectId: e.projectId, projectName: e.projectName, archived: e.archived,
        actors: [], threads: [], agent: null, events: [], at: e.at, needsYou: false, withAgent: false, adminOnly: false,
      };
      groups.set(e.artifactId, g);
      out.push(g);
    }
    g.events.push(e);
    if (!g.actors.includes(e.actor)) g.actors.push(e.actor);
    if (e.type === 'agent') { if (!g.agent) g.agent = e; }
    else if (!g.threads.some((t) => t.thread.key === e.thread.key)) g.threads.push(e);
    g.needsYou = g.needsYou || !!e.needsYou;
    g.withAgent = g.withAgent || !!e.withAgent;
  });
  return out;
}

/** The feed's entries: bursts collapsed, then each day's conversations grouped by artifact. Newest first. */
export function groupEntries(events, { windowMs = BURST_WINDOW } = {}) {
  const out = [];
  let day = [];
  let key = null;
  groupBursts(events, { windowMs }).forEach((e) => {
    const k = Number.isNaN(e.at) ? 'undated' : dayKey(e.at);
    if (k !== key) { out.push(...groupByArtifact(day)); day = []; key = k; }
    day.push(e);
  });
  out.push(...groupByArtifact(day));
  return out;
}

const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
const versionSpan = (e) => (e.count > 1 ? 'v' + e.firstVersion + '–v' + e.version : 'v' + e.version);

/** A version event's change in the data face: `v4 → v5`, `v5–v7`, or `v1 · new`. */
export function versionChange(e) {
  if (e.count > 1) return versionSpan(e);
  return e.fromVersion ? 'v' + e.fromVersion + ' → v' + e.version : 'v' + e.version + ' · new';
}

/** "A and B", or "A, B and 2 more". */
export function listPreview(names, shown = 2) {
  if (names.length <= shown) return names.join(' and ');
  return names.slice(0, shown).join(', ') + ' and ' + (names.length - shown) + ' more';
}

/** A clock span on one day: `10:00–10:12 AM`, `11:50 AM–12:10 PM`, or one time when they agree. */
export function timeRange(from, to) {
  const a = usTime(from); const b = usTime(to);
  if (!a || !b || a === b) return b || a;
  const [ta, pa] = a.split(' '); const [, pb] = b.split(' ');
  return pa === pb ? ta + '–' + b : a + '–' + b;
}

/** A byline's time: the clock alone on the entry's own day, the full date and time otherwise. */
export function bylineTime(ms, entryAt) {
  if (Number.isNaN(ms) || Number.isNaN(entryAt) || dayKey(ms) !== dayKey(entryAt)) return usDateTime(ms);
  return usTime(ms);
}

/**
 * An entry's title as typed parts, so no whole string is bolded: `actor`, `verb` (connectives
 * too), `code` (version spans and counts), `name` (the artifact, a link) and `plain` objects.
 */
export function sentenceOf(e) {
  const P = (kind, text) => ({ kind, text });
  const where = (projects) => (projects.length > 1
    ? [P('verb', 'across'), P('plain', plural(projects.length, 'project', 'projects'))]
    : [P('verb', 'in'), P('plain', projects[0].name)]);
  if (e.kind === 'burst') {
    if (e.type === 'version') return [P('actor', e.actor), P('verb', 'published'), P('code', plural(e.count, 'version', 'versions')), ...where(e.projects)];
    const artifacts = new Set(e.items.map((i) => i.artifactId)).size;
    return [P('actor', e.actor), P('verb', 'changed access on'), P('code', plural(artifacts, 'artifact', 'artifacts')), ...where(e.projects)];
  }
  if (e.kind === 'artifact') {
    const talk = e.events.filter((m) => THREAD_TYPES.includes(m.type));
    const names = [];
    talk.forEach((m) => { if (!names.includes(m.actor)) names.push(m.actor); });
    const who = names.length === 1 ? [P('actor', names[0])]
      : names.length === 2 ? [P('actor', names[0]), P('verb', 'and'), P('actor', names[1])]
        : [P('actor', names[0]), P('verb', 'and'), P('plain', plural(names.length - 1, 'other', 'others'))];
    const verb = talk.length === 1 ? talk[0].verb
      : talk.every((m) => m.type === 'resolution') ? 'resolved conversations on' : 'commented on';
    return [...who, P('verb', verb), P('name', e.artifactName)];
  }
  if (e.type === 'version') return [P('actor', e.actor), P('verb', 'published'), P('code', versionSpan(e)), P('verb', 'of'), P('name', e.artifactName)];
  if (e.type === 'agent') return [P('actor', e.actor), P('verb', e.verb), P('name', e.artifactName), P('verb', 'to'), P('actor', e.agent)];
  if (e.type === 'admin') return [P('actor', e.actor), P('verb', e.verb), P('plain', e.detail)];
  return [P('actor', e.actor), P('verb', e.verb), P('name', e.artifactName)];
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
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function relativeDay(key, now) {
  if (key === dayKey(now)) return 'Today';
  const y = new Date(now); y.setDate(y.getDate() - 1);
  return key === dayKey(y.getTime()) ? 'Yesterday' : null;
}
export function dayLabel(key, now) {
  const near = relativeDay(key, now);
  if (near) return near;
  const [Y, M, D] = key.split('-').map(Number);
  return WEEKDAYS[new Date(Y, M - 1, D).getDay()] + ' ' + pad(M) + '/' + pad(D) + '/' + Y;
}

/** A day cap's two halves: `Today`, `Yesterday` or the weekday's name, and `MM/DD/YYYY`. */
export function dayParts(key, now) {
  if (key === 'undated') return { weekday: 'Undated', date: '' };
  const [Y, M, D] = key.split('-').map(Number);
  return { weekday: relativeDay(key, now) || WEEKDAY_NAMES[new Date(Y, M - 1, D).getDay()], date: pad(M) + '/' + pad(D) + '/' + Y };
}

export function groupByDay(events, now) {
  const groups = [];
  events.forEach((e) => {
    const key = Number.isNaN(e.at) ? 'undated' : dayKey(e.at);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, label: key === 'undated' ? 'Undated' : dayLabel(key, now), ...dayParts(key, now), events: [] };
      groups.push(group);
    }
    group.events.push(e);
  });
  return groups;
}

export function pageEvents(events, limit = PAGE_SIZE) {
  return { visible: events.slice(0, limit), hasMore: events.length > limit, remaining: Math.max(0, events.length - limit) };
}
