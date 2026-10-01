import { groupByDay, usTime, usDateTime, TYPE_FILTERS, SEGMENTS } from './activity-model.js';

const ICONS = { comment: 'bi-chat-left-text', version: 'bi-upload', resolution: 'bi-check2-circle', agent: 'bi-cpu', access: 'bi-link-45deg' };
const TONES = { comment: 'primary', version: 'neutral', resolution: 'success', agent: 'warning', access: 'neutral', admin: 'neutral' };

const versionSpan = (e) => (e.count > 1 ? `v${e.firstVersion}–v${e.version}` : `v${e.version}`);

// The host supplies its React runtime and ArkCase exports; no duplicated primitives.
export function createActivityUI(React, DS) {
  const { Timeline, CommentThread, StatusPill, Button, SegmentedControl, Input, Menu, SurfaceState,
    SectionHeading, MetricCard, AutoGrid, ScrollDock, GroupBand, AnnotationPin } = DS;
  const data = { fontFamily: 'var(--font-data, "Source Code Pro", monospace)', fontVariantNumeric: 'tabular-nums' };
  const secondary = { fontSize: 'var(--font-size-xs, 0.75rem)', color: 'var(--text-secondary, #5a6268)' };
  const timeOf = (r) => usDateTime(r.atMs) || null;

  /* The title carries the event id so a host or test can find an entry without the
     list item itself being named (Timeline rows are plain list items). */
  function title(e) {
    const name = <strong style={{ fontWeight: 600 }}>{e.artifactName}</strong>;
    let words;
    if (e.type === 'version') words = <>{e.actor} published {versionSpan(e)} of {name}</>;
    else if (e.type === 'admin') words = <>{e.actor} {e.verb} {e.detail}</>;
    else words = <>{e.actor} {e.verb} {name}</>;
    return <span data-event={e.id}>{words}</span>;
  }

  /* The screen a conversation is about, drawn small: the host renders the page, this scales it
     into a fixed frame and places the comment's pin where it was left. */
  function ScreenThumbnail({ event, page, onOpen }) {
    const t = event.thread;
    return <figure aria-label={`Screen of ${event.artifactName}`} style={{ margin: 0, flex: 'none', position: 'relative', width: 160, height: 100,
      overflow: 'hidden', borderRadius: 'var(--radius-sm, 4px)', border: '1px solid var(--border-color, #dee2e6)', background: 'var(--surface-card, #fff)' }}>
      <div aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, width: 800, transform: 'scale(0.2)', transformOrigin: '0 0', pointerEvents: 'none' }}>{page}</div>
      {t.kind === 'point' && t.x != null && <AnnotationPin x={t.x} y={t.y} label={`Comment location on ${event.artifactName}`} onClick={() => onOpen(event)} />}
    </figure>;
  }

  function ActivityFeed({ events, now, hasMore, remaining, onShowOlder, expandedIds = [], onToggleReplies, onOpen, onCompare,
    onReply, onResolve, renderReplyComposer, onClearFilters, filtered, label = 'Activity', stickyTop = 0, renderThumbnail }) {
    const rootRef = React.useRef(null);
    const [bandHeight, setBandHeight] = React.useState(36);
    React.useLayoutEffect(() => {
      const band = rootRef.current && rootRef.current.querySelector('[data-group-band]');
      if (band && Math.abs(band.offsetHeight - bandHeight) > 0.5) setBandHeight(band.offsetHeight);
    });
    if (!events.length) {
      return <SurfaceState phase="ready" count={0} noun="events" emptyIcon="bi-activity"
        emptyTitle={filtered ? 'Nothing matches these filters' : 'No activity yet'}
        emptyBody={filtered ? 'Clear the filters to see every event.' : 'Published versions and conversations appear here.'}
        actionLabel={filtered ? 'Clear filters' : undefined} actionIcon={filtered ? 'bi-x' : undefined} onAction={filtered ? onClearFilters : undefined} />;
    }
    const open = (e) => <Button variant="link" size="xs" icon="bi-box-arrow-up-right" aria-label={`Open ${e.artifactName} in review`} onClick={() => onOpen(e)}>Open</Button>;
    const body = (e) => {
      if (e.type === 'comment') {
        const t = e.thread;
        const comments = [{ id: t.key, author: t.author, time: timeOf(t), text: t.body, resolved: !!t.isResolved,
          replies: (t.replies || []).map((r, i) => ({ id: r.id || t.key + ':r' + i, author: r.author, time: timeOf(r), text: r.body })) }];
        const replies = (t.replies || []).length;
        const facts = [t.version != null ? 'v' + t.version : null, t.path || (t.kind === 'point' ? null : 'Whole version'),
          replies ? replies + (replies === 1 ? ' reply' : ' replies') : null].filter(Boolean).join(' · ');
        /* The card's header is a smart header: at rest it shows the screen and the
           conversation's facts; carried to the top it compacts to one line under the day band. */
        const head = <ScrollDock top={stickyTop + bandHeight} zIndex={2} surface="var(--surface-card, #fff)"
          style={{ borderBottom: '1px solid var(--list-divider, #e9ecef)', borderRadius: 'var(--radius-md, 6px) var(--radius-md, 6px) 0 0' }}>
          {({ docked }) => docked
            ? <div data-conversation-head="docked" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', minWidth: 0 }}>
                <span style={{ flex: '1 1 auto', minWidth: 0, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.artifactName}</span>
                {e.needsYou && <StatusPill tone="warning" label="Your turn" />}
                <span style={{ ...secondary, ...data }}>{facts}</span>
                {open(e)}
              </div>
            : <div data-conversation-head="rest" style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '12px 14px' }}>
                {renderThumbnail && <ScreenThumbnail event={e} page={renderThumbnail(e)} onOpen={onOpen} />}
                <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontWeight: 600 }}>Conversation on {e.artifactName}</span>
                  <span style={{ ...secondary, ...data }}>{[e.projectName, facts].filter(Boolean).join(' · ')}</span>
                </div>
                {open(e)}
              </div>}
        </ScrollDock>;
        return <div style={{ border: '1px solid var(--border-color, #dee2e6)', borderRadius: 'var(--radius-md, 6px)', background: 'var(--surface-card, #fff)', marginTop: 6 }}>
          {head}
          <CommentThread comments={comments} density="compact" visibleReplies={2} expandedIds={expandedIds} onToggleReplies={onToggleReplies}
            onReply={onReply} onResolve={onResolve} renderReplyComposer={renderReplyComposer}
            aria-label={`Conversation on ${e.artifactName}`} />
        </div>;
      }
      if (e.type === 'version') {
        return <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          <span style={{ ...secondary, ...data }}>{e.fromVersion ? `v${e.fromVersion} → v${e.version}` : `v${e.version}`}</span>
          {e.fromVersion && onCompare && <Button variant="link" size="xs" icon="bi-arrow-left-right" onClick={() => onCompare(e)}>Compare</Button>}
          {open(e)}
        </div>;
      }
      if (e.type === 'resolution') return <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 4 }}><span style={secondary}>“{e.excerpt}”</span>{open(e)}</div>;
      if (e.type === 'agent') return <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}><StatusPill tone="warning" label={e.state} />{open(e)}</div>;
      if (e.type === 'access') return <div style={{ ...secondary, marginTop: 4 }}>{e.from} → {e.to}</div>;
      return null;
    };
    const items = (list) => list.map((e) => ({
      id: e.id, marker: 'icon', icon: e.icon || ICONS[e.type] || 'bi-activity', tone: TONES[e.type] || 'neutral',
      title: title(e),
      tag: e.needsYou ? <StatusPill tone="warning" label="Your turn" /> : e.archived ? <StatusPill tone="neutral" label="Archived" /> : undefined,
      meta: <span style={data}>{[e.projectName, e.version != null && e.type !== 'version' ? 'v' + e.version : null, Number.isNaN(e.at) ? null : usTime(e.at)].filter(Boolean).join(' · ')}</span>,
      children: body(e),
    }));
    return <div ref={rootRef} style={{ display: 'flex', flexDirection: 'column', gap: 18 }} data-activity-feed={label}>
      {groupByDay(events, now).map((g) => <section key={g.key} aria-label={g.label}>
        <GroupBand sticky data-group-band="" label={<span role="heading" aria-level={2}>{g.label}</span>} count={g.events.length}
          style={{ top: stickyTop, zIndex: 3, marginBottom: 10, borderRadius: 'var(--radius-sm, 4px)' }} />
        <Timeline as="ul" label={`${label} · ${g.label}`} items={items(g.events)} />
      </section>)}
      {hasMore && <Button variant="secondary" outline size="sm" icon="bi-chevron-down" onClick={onShowOlder} style={{ alignSelf: 'flex-start' }}>
        {remaining > 0 ? `Show older (${remaining})` : 'Show older'}
      </Button>}
    </div>;
  }

  /* The page's heading: a level-1 title with its facts and primary action, then metric tiles
     that double as filter shortcuts. */
  function ActivityHeader({ title = 'Activity', summary, action, metrics = [] }) {
    return <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 6 }}>
      <SectionHeading level={1} size="lg" title={title} subtitle={summary}>{action}</SectionHeading>
      {metrics.length > 0 && <AutoGrid min={180}>
        {metrics.map((m) => <MetricCard key={m.id} label={m.label} value={String(m.value)} size="sm" variant="surface"
          onClick={m.onClick} pressed={m.onClick ? !!m.pressed : undefined} />)}
      </AutoGrid>}
    </div>;
  }

  function ActivityToolbar({ segment, onSegment, counts = {}, projects, selectedProjects, onProjects, types, onTypes, query, onQuery, onHeight }) {
    const [menu, setMenu] = React.useState(null);
    const rowRef = React.useRef(null);
    /* Reports the docked row's height so the day bands and conversation headers pin beneath it. */
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
    const toggle = (list, id) => (list.includes(id) ? list.filter((x) => x !== id) : list.concat(id));
    const projectLabel = selectedProjects.length ? `Projects · ${selectedProjects.length}` : 'All projects';
    const typeLabel = types.length ? `Types · ${types.length}` : 'All types';
    return <ScrollDock surface="var(--surface-canvas, #f1f5f7)" bleed={20} zIndex={4} style={{ paddingTop: 10, paddingBottom: 10, marginBottom: 8 }}>
      <div ref={rowRef} role="toolbar" aria-label="Activity filters" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <SegmentedControl label="Show" mode="radio" value={segment} onChange={onSegment}
        options={SEGMENTS.map((id) => ({ id, label: id, count: id === 'All' ? undefined : counts[id] }))} />
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        <Button variant="secondary" outline size="sm" icon="bi-folder2" iconRight="bi-chevron-down" expanded={menu === 'projects'} hasPopup="menu"
          onClick={() => setMenu(menu === 'projects' ? null : 'projects')}>{projectLabel}</Button>
        <Menu open={menu === 'projects'} onClose={() => setMenu(null)} label="Projects" align="start"
          items={projects.map((p) => ({ type: 'checkbox', label: p.name, checked: selectedProjects.includes(p.id), keepOpen: true,
            onClick: () => onProjects(toggle(selectedProjects, p.id)) }))} />
      </span>
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        <Button variant="secondary" outline size="sm" icon="bi-funnel" iconRight="bi-chevron-down" expanded={menu === 'types'} hasPopup="menu"
          onClick={() => setMenu(menu === 'types' ? null : 'types')}>{typeLabel}</Button>
        <Menu open={menu === 'types'} onClose={() => setMenu(null)} label="Types" align="start"
          items={TYPE_FILTERS.map((f) => ({ type: 'checkbox', label: f.label, checked: types.includes(f.id), keepOpen: true,
            onClick: () => onTypes(toggle(types, f.id)) }))} />
      </span>
      <Input icon="bi-search" size="sm" type="search" placeholder="Search activity" aria-label="Search activity"
        value={query} onChange={(ev) => onQuery(ev.target.value)} style={{ width: 280, maxWidth: '100%', marginLeft: 'auto' }} />
      </div>
    </ScrollDock>;
  }

  return { ActivityHeader, ActivityFeed, ActivityToolbar };
}
