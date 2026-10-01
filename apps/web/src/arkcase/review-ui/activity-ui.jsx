import { groupByDay, groupByArtifact, usTime, timeRange, bylineTime, listPreview, sentenceOf, versionChange, TYPE_FILTERS, SEGMENTS } from './activity-model.js';

/* Markers are 32px discs tinted by type. A glyph with an ink of its own is tonal on its tint;
   the others keep the ordinary duotone. */
const MARKERS = {
  comment: { icon: 'bi-chat-left-text', bg: 'var(--pill-primary-bg, #e0f2fe)', fg: 'var(--pill-primary-fg, #0369a1)' },
  resolution: { icon: 'bi-check2-circle', bg: 'var(--pill-success-bg, #dcfce7)', fg: 'var(--pill-success-fg, #15803d)' },
  version: { icon: 'bi-upload', bg: 'var(--surface-navy-subtle, #eaf1f6)' },
  access: { icon: 'bi-link-45deg', bg: 'var(--surface-tertiary, #e9ecef)' },
  agent: { icon: 'bi-cpu', bg: 'var(--pill-warning-bg, #fef3c7)', fg: 'var(--pill-warning-fg, #92400e)' },
  admin: { icon: 'bi-activity', bg: 'var(--surface-tertiary, #e9ecef)' },
};
const TYPE_ICONS = { comments: 'bi-chat-left-text', versions: 'bi-upload', agents: 'bi-cpu', access: 'bi-link-45deg' };

const DATA = { fontFamily: 'var(--font-data, "Source Code Pro", monospace)', fontVariantNumeric: 'tabular-nums' };
const STRONG_RULE = '1px solid var(--border-color-strong, #ced4da)';
const RADIUS = 'var(--radius-md, 5px)';
const TEXT = {
  actor: { fontWeight: 600, color: 'var(--text-strong, #111827)' },
  verb: { fontWeight: 400, color: 'var(--text-secondary, #5a6268)' },
  plain: { fontWeight: 500, color: 'var(--text-emphasis, #374151)' },
  code: { ...DATA, fontSize: 'var(--font-size-dense, 13px)', color: 'var(--text-data, #495057)', background: 'var(--surface-secondary, #f8f9fa)',
    border: '1px solid var(--border-color, #dee2e6)', borderRadius: 4, padding: '0 6px' },
};
const HIDDEN = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 };
const THREAD_TYPES = ['comment', 'resolution'];

const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

// The host supplies its React runtime and ArkCase exports; no duplicated primitives.
export function createActivityUI(React, DS) {
  const { CommentThread, StatusPill, Button, SegmentedControl, Input, Menu, SurfaceState, Avatar,
    MetricCard, AutoGrid, ScrollDock, AnnotationPin, LoadMore } = DS;
  const hidden = DS.visuallyHiddenStyle || HIDDEN;
  const folder = (size = 14) => <i className="bi bi-folder2" aria-hidden="true" style={{ fontSize: size }} />;

  function Marker({ kind, icon, size = 32 }) {
    const m = MARKERS[kind] || MARKERS.admin;
    return <span data-activity-marker={kind} style={{ width: size, height: size, flex: 'none', borderRadius: '50%', display: 'inline-flex', alignItems: 'center',
      justifyContent: 'center', background: m.bg, fontSize: size > 28 ? 16 : 14 }}>
      <i className={'bi ' + (icon || m.icon)} data-icon-tone={m.fg ? 'current' : undefined} style={m.fg ? { color: m.fg } : undefined} />
    </span>;
  }

  /* The title is a sentence of typed parts. The event id rides on it so a host or test can find
     an entry; spaces between parts keep the read-aloud text whole while the gap sets the measure. */
  function Sentence({ entry, onOpen }) {
    return <p data-event={entry.id} style={{ flex: '1 1 auto', minWidth: 0, margin: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'baseline',
      columnGap: 5, rowGap: 2, fontSize: '0.9375rem', lineHeight: 1.45 }}>
      {sentenceOf(entry).map((part, i) => <React.Fragment key={i}>
        {i > 0 ? ' ' : null}
        {part.kind === 'name'
          ? <Button variant="link" flush onClick={() => onOpen(entry)} style={{ fontSize: 'inherit', fontWeight: 600, whiteSpace: 'normal' }}>{part.text}</Button>
          : <span style={TEXT[part.kind]}>{part.text}</span>}
      </React.Fragment>)}
    </p>;
  }

  /* The screen a conversation is about, drawn small: the host renders the page, this scales it
     into a fixed frame and places the comment's pin where it was left. */
  function ScreenThumbnail({ entry, page, onOpen }) {
    const pinned = entry.threads.map((t) => t.thread).find((t) => t.kind === 'point' && t.x != null);
    return <figure aria-label={`Screen of ${entry.artifactName}`} style={{ margin: 0, flex: 'none', position: 'relative', width: 168, height: 104, boxSizing: 'border-box',
      overflow: 'hidden', borderRadius: 4, border: STRONG_RULE, background: 'var(--surface-card, #fff)' }}>
      <div aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, width: 800, transform: 'scale(0.21)', transformOrigin: '0 0', pointerEvents: 'none' }}>{page}</div>
      {pinned && <AnnotationPin x={pinned.x} y={pinned.y} label={`Comment location on ${entry.artifactName}`} onClick={() => onOpen(entry)} />}
    </figure>;
  }

  function ActivityFeed({ events, now, hasMore, remaining, onShowOlder, expandedIds = [], onToggleReplies, openGroups = [], onToggleGroup, onOpen, onCompare,
    onReply, onResolve, renderReplyComposer, onClearFilters, filtered, label = 'Activity', stickyTop = 0, renderThumbnail }) {
    const rootRef = React.useRef(null);
    const [capHeight, setCapHeight] = React.useState(46);
    React.useLayoutEffect(() => {
      const cap = rootRef.current && rootRef.current.querySelector('[data-day-cap]');
      if (cap && Math.abs(cap.offsetHeight - capHeight) > 0.5) setCapHeight(cap.offsetHeight);
    });
    if (!events.length) {
      return <div style={{ background: 'var(--surface-card, #fff)', border: STRONG_RULE, borderRadius: RADIUS }}>
        <SurfaceState phase="ready" count={0} noun="entries" emptyIcon="bi-inbox"
          emptyTitle={filtered ? 'Nothing matches these filters' : 'No activity yet'}
          emptyBody={filtered ? 'Remove a filter or clear them all to see every entry.' : 'Published versions and conversations appear here.'}
          actionLabel={filtered ? 'Clear filters' : undefined} actionIcon={filtered ? 'bi-x' : undefined} onAction={filtered ? onClearFilters : undefined} />
      </div>;
    }
    /* A host may hand over plain events: a lone conversation still gets its card. */
    const entries = events.map((e) => (!e.kind && THREAD_TYPES.includes(e.type) ? groupByArtifact([e])[0] : e));
    const openLink = (e, name = e.artifactName) => <Button variant="link" size="xs" icon="bi-box-arrow-up-right" aria-label={`Open ${name} in review`} onClick={() => onOpen(e)}>Open</Button>;
    const metaRow = (children) => <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginTop: 6 }}>{children}</div>;
    const project = (e) => <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-dense, 13px)', color: 'var(--text-emphasis, #374151)' }}>{folder()}{e.projectName}</span>;

    function burstBody(e) {
      const open = openGroups.includes(e.id);
      const listId = 'activity-group-' + e.id.replace(/[^A-Za-z0-9_-]/g, '-');
      const noun = e.type === 'version' ? plural(e.count, 'version', 'versions') : plural(e.items.length, 'change', 'changes');
      return <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
          {e.projects.map((p) => <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', fontSize: 'var(--font-size-xs, 12px)', fontWeight: 500,
            color: 'var(--text-emphasis, #374151)', background: 'var(--surface-secondary, #f8f9fa)', border: STRONG_RULE, borderRadius: 4 }}>
            {folder(12)}{p.name}<span style={{ ...DATA, fontWeight: 400, color: 'var(--text-data, #495057)' }}>{p.count}</span>
          </span>)}
        </div>
        {open
          ? <ul id={listId} aria-label={`${e.actor}: ${noun}`} style={{ listStyle: 'none', margin: '2px 0 0', padding: '0 0 0 14px', borderLeft: '2px solid var(--border-color-strong, #ced4da)' }}>
              {e.items.map((item) => <li key={item.id} data-group-item={item.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1.2fr) minmax(0, 1fr) 72px auto',
                alignItems: 'center', columnGap: 14, minHeight: 40, borderBottom: '1px solid var(--list-divider, #e9ecef)' }}>
                <span style={{ minWidth: 0 }}><Button variant="link" flush onClick={() => onOpen(item)}
                  style={{ display: 'block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 'var(--font-size-sm, 14px)', fontWeight: 600, textAlign: 'left' }}>{item.artifactName}</Button></span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: 'var(--font-size-dense, 13px)', color: 'var(--text-emphasis, #374151)', whiteSpace: 'nowrap' }}>
                  {folder(13)}<span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.projectName}</span></span>
                <span style={{ ...DATA, fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-data, #495057)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {item.type === 'version' ? versionChange(item) : `${item.from} → ${item.to}`}</span>
                <span style={{ ...DATA, fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5a6268)', textAlign: 'right', whiteSpace: 'nowrap' }}>{usTime(item.at)}</span>
                {openLink(item)}
              </li>)}
            </ul>
          : <p style={{ margin: 0, fontSize: 'var(--font-size-dense, 13px)', color: 'var(--text-data, #495057)' }}>{listPreview(e.items.map((i) => i.artifactName))}</p>}
        <div>
          <Button variant="link" size="xs" icon={open ? 'bi-chevron-up' : 'bi-chevron-down'} expanded={open} aria-controls={open ? listId : undefined}
            onClick={() => onToggleGroup && onToggleGroup(e.id, !open)}>{(open ? 'Hide ' : 'Show ') + noun}</Button>
        </div>
      </div>;
    }

    function artifactCard(e) {
      const newest = e.threads[0].thread;
      const where = ['v' + (newest.version != null ? newest.version : ''), newest.path || (newest.kind === 'point' ? null : 'whole version')]
        .filter((x) => x && x !== 'v').join(' · ');
      const openCount = e.threads.filter((t) => !t.thread.isResolved).length;
      const resolved = e.threads.length - openCount;
      const replies = e.threads.reduce((n, t) => n + (t.thread.replies || []).length, 0);
      const facts = [openCount ? plural(openCount, 'open conversation', 'open conversations') : null, resolved ? resolved + ' resolved' : null,
        replies ? plural(replies, 'reply', 'replies') : null].filter(Boolean).join(' · ');
      const comments = e.threads.map(({ thread: t }) => ({ id: t.key, author: t.author, time: bylineTime(t.atMs, e.at) || null, text: t.body, resolved: !!t.isResolved,
        replies: (t.replies || []).map((r, i) => ({ id: r.id || t.key + ':r' + i, author: r.author, time: bylineTime(r.atMs, e.at) || null, text: r.body })) }));
      /* The card's head is a smart header: at rest it shows the screen and the conversation's
         facts; carried to the top it compacts to one line under the day cap. */
      const head = <ScrollDock top={stickyTop + capHeight} zIndex={2} surface="var(--surface-secondary, #f8f9fa)"
        style={{ borderBottom: '1px solid var(--border-color, #dee2e6)', borderRadius: `${RADIUS} ${RADIUS} 0 0` }}>
        {({ docked }) => docked
          ? <div data-conversation-head="docked" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', minWidth: 0 }}>
              <span style={{ flex: '0 1 auto', minWidth: 0, fontWeight: 600, color: 'var(--text-strong, #111827)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.artifactName}</span>
              <span style={{ flex: '1 1 auto', ...DATA, fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-data, #495057)', whiteSpace: 'nowrap' }}>{where}</span>
              {e.needsYou && <StatusPill tone="warning" label="Your turn" />}
              {openLink(e)}
            </div>
          : <div data-conversation-head="rest" style={{ display: 'grid', gridTemplateColumns: renderThumbnail ? '168px minmax(0, 1fr) auto' : 'minmax(0, 1fr) auto',
              alignItems: 'center', columnGap: 16, padding: '12px 14px' }}>
              {renderThumbnail && <ScreenThumbnail entry={e} page={renderThumbnail(e)} onOpen={onOpen} />}
              <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-dense, 13px)', fontWeight: 500, color: 'var(--text-emphasis, #374151)' }}>{folder()}{e.projectName}</span>
                <span style={{ ...DATA, fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-data, #495057)' }}>{where}</span>
                <span style={{ fontSize: 'var(--font-size-dense, 13px)', color: 'var(--text-secondary, #5a6268)' }}>{facts}</span>
              </div>
              <Button variant="secondary" outline size="sm" icon="bi-box-arrow-up-right" aria-label={`Open ${e.artifactName} in review`} onClick={() => onOpen(e)}>Open</Button>
            </div>}
      </ScrollDock>;
      const agent = e.agent;
      return <div data-artifact-card={e.artifactId} style={{ marginTop: 10, border: STRONG_RULE, borderRadius: RADIUS, background: 'var(--surface-card, #fff)' }}>
        {head}
        <div style={{ padding: '4px 0' }}>
          <CommentThread comments={comments} density="compact" visibleReplies={2} expandedIds={expandedIds} onToggleReplies={onToggleReplies}
            onReply={onReply} onResolve={onResolve} renderReplyComposer={renderReplyComposer} aria-label={`Conversations on ${e.artifactName}`} />
        </div>
        {agent && <div data-agent-handoff="" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '10px 14px', borderTop: '1px solid var(--border-color, #dee2e6)' }}>
          <span aria-hidden="true" style={{ display: 'inline-flex' }}><Marker kind="agent" size={26} /></span>
          <span style={{ fontSize: 'var(--font-size-dense, 13px)' }}>
            <span style={TEXT.actor}>{agent.actor}</span> <span style={TEXT.verb}>handed this artifact to</span> <span style={TEXT.actor}>{agent.agent}</span>
          </span>
          <StatusPill tone="warning" label={agent.state} />
          <span style={{ marginLeft: 'auto', ...DATA, fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5a6268)', whiteSpace: 'nowrap' }}>{usTime(agent.at)}</span>
        </div>}
      </div>;
    }

    const body = (e) => {
      if (e.kind === 'burst') return burstBody(e);
      if (e.kind === 'artifact') return artifactCard(e);
      if (e.type === 'version') {
        return metaRow(<>{project(e)}
          {e.fromVersion && onCompare && <Button variant="link" size="xs" icon="bi-arrow-left-right" onClick={() => onCompare(e)}>{`Compare v${e.fromVersion} → v${e.version}`}</Button>}
          {openLink(e)}</>);
      }
      if (e.type === 'agent') return metaRow(<><StatusPill tone="warning" label={e.state} />{project(e)}{openLink(e)}</>);
      if (e.type === 'access') {
        return metaRow(<>{project(e)}
          <span style={{ ...DATA, fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-data, #495057)' }}>{`${e.from} → ${e.to}`}</span>
          {openLink(e)}</>);
      }
      return null;
    };
    const markerOf = (e) => {
      if (e.kind === 'artifact') return e.threads.every((t) => t.type === 'resolution') ? 'resolution' : 'comment';
      return MARKERS[e.type] ? e.type : 'admin';
    };
    const timeOf = (e) => (e.kind === 'burst' ? timeRange(e.firstAt, e.at) : usTime(e.at));
    const row = (e) => <li key={e.id} data-entry={e.id} style={{ display: 'grid', gridTemplateColumns: '32px minmax(0, 1fr)', columnGap: 14, padding: '0 20px' }}>
      <div aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 14 }}>
        <Marker kind={markerOf(e)} icon={e.type === 'admin' ? e.icon : undefined} />
        <span style={{ flex: '1 1 auto', width: 2, minHeight: 12, marginTop: 4, background: 'var(--border-color-strong, #ced4da)' }} />
      </div>
      <div style={{ minWidth: 0, padding: '16px 0 20px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <Sentence entry={e} onOpen={onOpen} />
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, paddingTop: 2 }}>
            {e.needsYou && <StatusPill tone="warning" label="Your turn" />}
            {!e.needsYou && e.archived && <StatusPill tone="neutral" label="Archived" />}
            <span style={{ ...DATA, fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5a6268)', whiteSpace: 'nowrap' }}>{timeOf(e)}</span>
          </div>
        </div>
        {body(e)}
      </div>
    </li>;

    /* Each day is one panel. Nothing here clips (no overflow), so the cap and the conversation
       heads stay sticky against the page's scroller. */
    return <div ref={rootRef} style={{ display: 'flex', flexDirection: 'column', gap: 20 }} data-activity-feed={label}>
      {groupByDay(entries, now).map((g) => <section key={g.key} aria-label={[g.weekday, g.date].filter(Boolean).join(' ')} data-day={g.key}
        style={{ background: 'var(--surface-card, #fff)', border: STRONG_RULE, borderRadius: RADIUS, boxShadow: 'var(--shadow-card, 0 1px 2px rgba(0,0,0,0.06))' }}>
        <div data-day-cap="" style={{ position: 'sticky', top: stickyTop, zIndex: 3, display: 'flex', alignItems: 'baseline', gap: 10, padding: '12px 20px',
          borderRadius: `${RADIUS} ${RADIUS} 0 0`, background: 'var(--surface-secondary, #f8f9fa)', borderBottom: STRONG_RULE }}>
          <h2 style={{ margin: 0, fontFamily: 'var(--font-heading, "Source Serif 4", serif)', fontSize: 18, fontWeight: 600, lineHeight: 1.2, color: 'var(--text-strong, #111827)' }}>{g.weekday}</h2>
          {g.date && <span style={{ marginLeft: 'auto', ...DATA, fontSize: 'var(--font-size-xs, 12px)', fontWeight: 500, color: 'var(--text-data, #495057)', whiteSpace: 'nowrap' }}>{g.date}</span>}
        </div>
        <ul aria-label={`${label} · ${g.weekday}`} style={{ listStyle: 'none', margin: 0, padding: '6px 0 4px' }}>{g.events.map(row)}</ul>
      </section>)}
      {hasMore && <LoadMore label={remaining > 0 ? `Show older (${remaining})` : 'Show older'} onLoadMore={onShowOlder} style={{ paddingTop: 0 }} />}
    </div>;
  }

  /* The page's heading: the level-1 title and its primary action, then metric tiles that double
     as filter shortcuts. The title carries no summary line. */
  function ActivityHeader({ title = 'Activity', action, metrics = [] }) {
    return <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <h1 style={{ flex: '1 1 auto', minWidth: 0, margin: 0, fontFamily: 'var(--font-heading, "Source Serif 4", serif)', fontSize: 'var(--font-size-3xl, 2rem)',
          fontWeight: 600, lineHeight: 1.2, letterSpacing: '-0.01em', color: 'var(--text-strong, #111827)' }}>{title}</h1>
        {action}
      </div>
      {metrics.length > 0 && <AutoGrid min={180}>
        {metrics.map((m) => <MetricCard key={m.id} label={m.label} value={String(m.value)} size="sm" variant="surface"
          onClick={m.onClick} pressed={m.onClick ? !!m.pressed : undefined} />)}
      </AutoGrid>}
    </div>;
  }

  function ActivityToolbar({ segment, onSegment, counts = {}, people = [], selectedPeople = [], onPeople, projects, selectedProjects, onProjects,
    types, onTypes, typeCounts, query, onQuery, onHeight, shown, total, onClearFilters }) {
    const [menu, setMenu] = React.useState(null);
    const rowRef = React.useRef(null);
    const peopleRef = React.useRef(null);
    const chipsRef = React.useRef(null);
    const pendingFocus = React.useRef(null);
    /* Reports the docked row's height so the day caps and conversation heads pin beneath it. */
    React.useLayoutEffect(() => {
      const el = rowRef.current;
      if (!el || !onHeight) return undefined;
      const report = () => onHeight(Math.round(el.getBoundingClientRect().height) + 20);
      report();
      if (typeof ResizeObserver === 'undefined') return undefined;
      const ro = new ResizeObserver(report);
      ro.observe(el);
      return () => ro.disconnect();
    }, [onHeight]);
    /* A removed chip takes its focus with it: hand focus to the chip now in its place, else to
       Clear filters, else back to the People button. */
    React.useLayoutEffect(() => {
      const want = pendingFocus.current;
      if (want == null) return;
      pendingFocus.current = null;
      const chips = chipsRef.current ? [...chipsRef.current.querySelectorAll('[data-filter-chip], [data-clear-filters]')] : [];
      const target = typeof want === 'number' && chips.length ? chips[Math.min(want, chips.length - 1)] : peopleRef.current && peopleRef.current.querySelector('button');
      if (target) target.focus();
    });
    const toggle = (list, id) => (list.includes(id) ? list.filter((x) => x !== id) : list.concat(id));
    const label = (word, n, all) => (n ? `${word} · ${n}` : all);
    const filtered = segment !== 'All' || selectedPeople.length > 0 || selectedProjects.length > 0 || types.length > 0 || !!String(query || '').trim();
    const avatar = (p) => (Avatar ? <Avatar name={p.name} size={22} {...(p.agent ? { icon: 'bi-cpu' } : {})} /> : undefined);
    const peopleItems = [{ heading: 'People' }]
      .concat(people.filter((p) => !p.agent).map((p) => personItem(p)))
      .concat(people.some((p) => p.agent) ? [{ divider: true }, { heading: 'Agents' }] : [], people.filter((p) => p.agent).map((p) => personItem(p)));
    function personItem(p) {
      return { type: 'checkbox', label: p.name, description: p.self ? 'You' : p.agent ? 'Agent' : undefined, checked: selectedPeople.includes(p.id), keepOpen: true,
        leading: avatar(p), meta: p.count, onClick: () => onPeople(toggle(selectedPeople, p.id)) };
    }
    /* Each filter menu is as wide as its longest row, so names stay on one line: never narrower
       than `minWidth`, never wider than 400px or the viewport less its gutters. */
    const trigger = (id, icon, text, items, minWidth, ref) => <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <Button variant="secondary" outline size="sm" icon={icon} iconRight="bi-chevron-down" expanded={menu === id} hasPopup="menu"
        onClick={() => setMenu(menu === id ? null : id)}>{text}</Button>
      <Menu open={menu === id} onClose={() => setMenu(null)} label={id[0].toUpperCase() + id.slice(1)} align="start" density="comfortable" items={items}
        width="max-content" style={{ minWidth, maxWidth: 'min(400px, calc(100vw - 32px))' }} />
    </span>;
    const chips = selectedPeople.map((id) => { const p = people.find((x) => x.id === id); return { key: 'person:' + id, label: p ? p.name : id, icon: p && p.agent ? 'bi-cpu' : 'bi-person', remove: () => onPeople(selectedPeople.filter((x) => x !== id)) }; })
      .concat(selectedProjects.map((id) => { const p = projects.find((x) => x.id === id); return { key: 'project:' + id, label: p ? p.name : id, icon: 'bi-folder2', remove: () => onProjects(selectedProjects.filter((x) => x !== id)) }; }))
      .concat(types.map((id) => { const f = TYPE_FILTERS.find((x) => x.id === id); return { key: 'type:' + id, label: f ? f.label : id, icon: TYPE_ICONS[id], remove: () => onTypes(types.filter((x) => x !== id)) }; }));
    const counted = typeof shown === 'number' && typeof total === 'number';
    const n = (v) => <span style={{ ...DATA, color: 'var(--text-data, #495057)' }}>{v}</span>;
    return <>
      <ScrollDock surface="var(--surface-canvas, #f1f5f7)" bleed={20} zIndex={4} style={{ paddingTop: 10, paddingBottom: 10 }}>
        <div ref={rowRef} role="toolbar" aria-label="Activity filters" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '12px 14px',
          background: 'var(--surface-card, #fff)', border: STRONG_RULE, borderRadius: RADIUS, boxShadow: 'var(--shadow-card, 0 1px 2px rgba(0,0,0,0.06))' }}>
          <SegmentedControl label="Show" mode="radio" value={segment} onChange={onSegment}
            options={SEGMENTS.map((id) => ({ id, label: id, count: id === 'All' ? undefined : counts[id] }))} />
          <span aria-hidden="true" style={{ width: 1, height: 24, background: 'var(--border-color-strong, #ced4da)' }} />
          {onPeople && trigger('people', 'bi-people', label('People', selectedPeople.length, 'Everyone'), peopleItems, 288, peopleRef)}
          {trigger('projects', 'bi-folder2', label('Projects', selectedProjects.length, 'All projects'),
            projects.map((p) => ({ type: 'checkbox', label: p.name, icon: p.archived ? 'bi-archive' : 'bi-folder2', description: p.archived ? 'Archived' : undefined,
              meta: p.count, checked: selectedProjects.includes(p.id), keepOpen: true, onClick: () => onProjects(toggle(selectedProjects, p.id)) })), 240)}
          {trigger('types', 'bi-funnel', label('Types', types.length, 'All types'),
            TYPE_FILTERS.map((f) => ({ type: 'checkbox', label: f.label, icon: TYPE_ICONS[f.id], meta: typeCounts ? typeCounts[f.id] : undefined, checked: types.includes(f.id), keepOpen: true,
              onClick: () => onTypes(toggle(types, f.id)) })), 220)}
          <Input icon="bi-search" size="sm" type="search" placeholder="Search activity" aria-label="Search activity"
            value={query} onChange={(ev) => onQuery(ev.target.value)} style={{ flex: '1 1 180px', maxWidth: 260, marginLeft: 'auto' }} />
        </div>
      </ScrollDock>
      {/* The count is a live region that stays mounted, so every filter change is spoken; the row
          around it shows only while the feed is narrowed. */}
      {counted && <div ref={chipsRef} data-active-filters={filtered ? 'on' : 'off'} style={filtered
        ? { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, margin: '2px 0 12px' } : { margin: '0 0 8px' }}>
        <span role="status" aria-live="polite" style={filtered ? { fontSize: 'var(--font-size-dense, 13px)', color: 'var(--text-secondary, #5a6268)' } : hidden}>
          {filtered ? <>Showing {n(shown)} of {n(total)} entries</> : `Showing all ${total} entries`}
        </span>
        {filtered && chips.map((c, i) => <Button key={c.key} data-filter-chip="" variant="secondary" outline size="xs" icon={c.icon} iconRight="bi-x-lg" aria-label={`Remove ${c.label} filter`}
          onClick={() => { pendingFocus.current = i; c.remove(); }}>{c.label}</Button>)}
        {filtered && onClearFilters && <Button data-clear-filters="" variant="link" size="xs" onClick={() => { pendingFocus.current = 'trigger'; onClearFilters(); }}>Clear filters</Button>}
      </div>}
    </>;
  }

  return { ActivityHeader, ActivityFeed, ActivityToolbar };
}
