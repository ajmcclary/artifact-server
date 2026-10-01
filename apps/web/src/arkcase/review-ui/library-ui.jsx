import { filterLibrary, groupLibrary, galleryKind, galleryKinds, libraryGroupings, librarySorts, defaultSortDir, libraryDateField } from './page-model.js';
import { usDateTime } from './activity-model.js';
import { createThumbnailUI } from './placeholder-ui.jsx';

/* The design library, laid out like Activity: the heading scrolls away, the toolbar docks and
   condenses, and each group's band pins beneath it. The host owns every view choice (search,
   types, grouping, sort, layout, collapsed groups, scroll and the returning tile) so a return
   from an opened page restores them. Tiles render no live preview: a captured thumbnail when
   supplied, otherwise the kind's placeholder sketch. */
export function createLibraryUI(React, DS) {
  const { Button, IconButton, Menu, Input, SegmentedControl, GroupBand, SurfaceState, SectionHeading, ScrollDock } = DS;
  const { GalleryThumbnail, GalleryPlaceholder } = createThumbnailUI(React);
  const secondary = { fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5A6268)' };
  const data = { fontFamily: 'var(--font-data, "Source Code Pro", monospace)', fontVariantNumeric: 'tabular-nums', color: 'var(--text-data, #495057)' };
  const strong = { fontWeight: 600, color: 'var(--text-strong, #111827)', overflowWrap: 'anywhere' };
  const libraryId = (item) => item.id ?? item.path;
  const plainClick = (event) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  const sortLabel = (sortBy, dir) => librarySorts.find((sort) => sort.id === sortBy).label
    + (sortBy === 'name' ? (dir === 'asc' ? ' (A–Z)' : ' (Z–A)') : (dir === 'asc' ? ' (oldest)' : ' (newest)'));
  const directions = (sortBy) => (sortBy === 'name' ? [['asc', 'A to Z'], ['desc', 'Z to A']] : [['desc', 'Newest first'], ['asc', 'Oldest first']]);

  function LibraryTile({ item, href, onOpen, list, context, dateLabel, dateText, zebra, first, phone }) {
    const kind = galleryKind(item.kind);
    const [hover, setHover] = React.useState(false);
    const Element = href ? 'a' : 'button';
    const activate = (event) => { if (href && !plainClick(event)) return; event.preventDefault(); onOpen(libraryId(item)); };
    const common = { ...(href ? { href } : { type: 'button' }), onClick: activate, 'data-gallery-path': libraryId(item),
      'aria-label': `Open ${item.title} · ${kind.singular} · ${item.project}`,
      onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) };
    const reset = { font: 'inherit', color: 'inherit', textAlign: 'left', textDecoration: 'none', cursor: 'pointer', boxSizing: 'border-box', minWidth: 0 };
    const kindLine = <span><i className={`bi ${kind.icon}`} aria-hidden="true" style={{ marginRight: 6 }} />{kind.singular}</span>;
    if (list) {
      const column = (width, style, children) => !phone && <span style={{ flex: 'none', width, fontSize: 13, ...style }}>{children}</span>;
      return <Element {...common} style={{ ...reset, display: 'flex', alignItems: 'center', gap: 16, width: '100%', padding: '8px 14px', border: 0,
        borderTop: first ? 0 : '1px solid var(--list-divider, #E9ECEF)',
        background: hover ? 'var(--tint-primary-hover, rgba(0,121,168,.05))' : zebra ? 'var(--surface-secondary, #F8F9FA)' : 'var(--surface-card, #fff)' }}>
        <span style={{ flex: 'none', position: 'relative', display: 'block', width: 96, height: 60, overflow: 'hidden',
          border: '1px solid var(--border-color, #DEE2E6)', borderRadius: 'var(--radius-sm, 4px)' }}><GalleryThumbnail item={item} compact /></span>
        <span style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={strong}>{item.title}</span>
          {item.description && <span style={{ ...secondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.description}</span>}
          {phone && <span style={secondary}>{kind.singular} · {context}</span>}
        </span>
        {column(150, { color: 'var(--text-secondary, #5A6268)' }, kindLine)}
        {column(96, data, `${item.viewport.width} × ${item.viewport.height}`)}
        {column(200, { color: 'var(--text-secondary, #5A6268)', overflowWrap: 'anywhere' }, context)}
        <span style={{ flex: 'none', width: phone ? 'auto' : 170, textAlign: 'right', fontSize: 13, ...data }}>{dateText}</span>
      </Element>;
    }
    return <Element {...common} style={{ ...reset, display: 'flex', flexDirection: 'column', width: '100%', height: '100%', padding: 0, overflow: 'hidden',
      background: 'var(--surface-card, #fff)', borderRadius: 'var(--radius-md, 6px)',
      border: `1px solid ${hover ? 'var(--border-color-strong, #ADB5BD)' : 'var(--border-color, #DEE2E6)'}`,
      boxShadow: hover ? 'var(--shadow-sm, 0 1px 2px rgba(0,0,0,.08))' : 'none' }}>
      <span style={{ position: 'relative', display: 'block', aspectRatio: '16 / 10', overflow: 'hidden', borderBottom: '1px solid var(--border-color, #DEE2E6)',
        background: 'var(--surface-tertiary, #E9ECEF)' }}><GalleryThumbnail item={item} /></span>
      <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 12px 12px' }}>
        <span style={{ ...strong, fontSize: 'var(--font-size-sm, 14px)' }}>{item.title}</span>
        {item.description && <span style={{ ...secondary, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{item.description}</span>}
        <span style={{ ...secondary, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 8px' }}>
          {kindLine}<span aria-hidden="true">·</span><span style={{ overflowWrap: 'anywhere' }}>{context}</span></span>
        <span style={{ ...secondary, marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 6, paddingTop: 8, borderTop: '1px solid var(--list-divider, #E9ECEF)' }}>
          <span>{dateLabel}</span><span style={data}>{dateText}</span></span>
      </span>
    </Element>;
  }

  function DesignLibrary({ title = 'Design library', description, items, now, notice, query = '', onQueryChange, types = [], onTypesChange,
    groupBy = 'date', onGroupByChange, sortBy = 'activity', sortDir, onSortChange, view = 'grid', onViewChange,
    collapsed = [], onCollapsedChange, onRefresh, refreshedAt, onOpen, hrefFor, focusPath, scrollTop = 0, onScroll, onAnnounce, phone = false }) {
    const rootRef = React.useRef(null);
    const rowRef = React.useRef(null);
    const [menu, setMenu] = React.useState(null);
    const [dockHeight, setDockHeight] = React.useState(52);
    const dir = sortDir || defaultSortDir(sortBy);
    const matches = filterLibrary(items, query, types);
    const groups = groupLibrary(matches, { groupBy, sortBy, dir, now: now ?? Date.now() });
    const field = libraryDateField(sortBy);
    const filtered = types.length > 0 || query.trim().length > 0;
    const list = view === 'list';
    const gutter = phone ? 16 : 20;
    React.useLayoutEffect(() => {
      const root = rootRef.current;
      if (!root) return;
      root.scrollTop = scrollTop;
      if (focusPath) Array.from(root.querySelectorAll('[data-gallery-path]'))
        .find((tile) => tile.getAttribute('data-gallery-path') === focusPath)?.focus({ preventScroll: scrollTop > 0 });
      // Restore once per mount; later prop changes come from this library's own scrolling.
    }, []);
    /* The bands pin directly under the docked toolbar, whatever height it wraps to. */
    React.useLayoutEffect(() => {
      const row = rowRef.current;
      if (!row) return undefined;
      const report = () => setDockHeight(Math.round(row.getBoundingClientRect().height) + 1);
      report();
      if (typeof ResizeObserver === 'undefined') return undefined;
      const observer = new ResizeObserver(report);
      observer.observe(row);
      return () => observer.disconnect();
    }, []);
    const announce = (nextQuery, nextTypes) => onAnnounce?.(`${filterLibrary(items, nextQuery, nextTypes).length} matching previews.`);
    const setTypes = (next) => { onTypesChange(next); announce(query, next); };
    const clear = () => { onQueryChange(''); onTypesChange([]); announce('', []); };
    const counts = {};
    items.forEach((item) => { counts[item.kind] = (counts[item.kind] || 0) + 1; });
    const toggleMenu = (id) => () => setMenu(menu === id ? null : id);
    const menuButton = (id, icon, label) => <span style={{ position: 'relative', display: 'inline-flex' }}>
      <Button variant="secondary" outline size="sm" icon={icon} iconRight="bi-chevron-down" expanded={menu === id} hasPopup="menu"
        onClick={toggleMenu(id)}>{label}</Button>
      <Menu open={menu === id} onClose={() => setMenu(null)} align="start" label={{ group: 'Group by', sort: 'Sort by', types: 'Artifact types' }[id]}
        items={{
          group: [{ heading: 'Group by' }, ...libraryGroupings.map((option) => ({ type: 'radio', label: option.label, checked: groupBy === option.id,
            onClick: () => onGroupByChange(option.id) }))],
          sort: [{ heading: 'Sort by' }, ...librarySorts.map((option) => ({ type: 'radio', label: option.label, checked: sortBy === option.id,
            onClick: () => onSortChange(option.id, defaultSortDir(option.id)) })),
          { divider: true }, { heading: 'Order' },
          ...directions(sortBy).map(([id, label]) => ({ type: 'radio', label, checked: dir === id, onClick: () => onSortChange(sortBy, id) }))],
          types: galleryKinds.filter((kind) => counts[kind.id]).map((kind) => ({ type: 'checkbox', label: kind.label, icon: kind.icon,
            meta: counts[kind.id], checked: types.includes(kind.id), keepOpen: true,
            onClick: () => setTypes(types.includes(kind.id) ? types.filter((id) => id !== kind.id) : types.concat(kind.id)) })),
        }[id]} />
    </span>;
    const groupName = libraryGroupings.find((option) => option.id === groupBy).label;
    const count = filtered ? `${matches.length} of ${items.length}` : `${items.length} ${items.length === 1 ? 'preview' : 'previews'}`;

    return <section ref={rootRef} aria-label={title} onScroll={(event) => onScroll?.(event.currentTarget.scrollTop)}
      style={{ height: '100%', overflowY: 'auto', boxSizing: 'border-box', padding: `0 ${gutter}px 48px`,
        background: 'var(--surface-canvas, #F1F5F7)', color: 'var(--text-body, #212529)' }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '24px 0 12px' }}>
        <SectionHeading level={1} size="lg" title={title} subtitle={description} />
        {notice}
      </header>
      <ScrollDock surface="var(--surface-canvas, #F1F5F7)" bleed={gutter} zIndex={4}
        style={{ borderBottom: '1px solid transparent' }} dockedStyle={{ borderBottom: '1px solid var(--border-color, #DEE2E6)' }}>
        {({ docked }) => <div ref={rowRef} role="toolbar" aria-label="Library view"
          style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, minHeight: 52, padding: phone ? '8px 0' : 0, boxSizing: 'border-box' }}>
          {docked && <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, paddingRight: 10, marginRight: 2, borderRight: '1px solid var(--border-color, #DEE2E6)' }}>
            <span style={{ fontFamily: 'var(--font-heading, "Source Serif 4", serif)', fontWeight: 600, fontSize: 'var(--font-size-md, 16px)', color: 'var(--text-strong, #111827)' }}>{title}</span>
            <span style={{ ...data, fontSize: 'var(--font-size-xs, 12px)' }}>{count}</span>
          </div>}
          {menuButton('group', 'bi-layers', `Group: ${groupName}`)}
          {menuButton('sort', 'bi-sort-alpha-down', `Sort: ${sortLabel(sortBy, dir)}`)}
          {menuButton('types', 'bi-funnel', types.length ? `Types · ${types.length}` : 'All types')}
          {filtered && <Button variant="link" size="xs" icon="bi-x" onClick={clear}>Clear filters</Button>}
          <div style={{ flexGrow: 1 }} />
          <Input icon="bi-search" size="sm" type="search" placeholder="Search previews" aria-label="Search previews" value={query}
            onChange={(event) => { onQueryChange(event.target.value); announce(event.target.value, types); }}
            style={{ width: phone ? '100%' : 260, maxWidth: '100%' }} />
          <SegmentedControl variant="pill" size="sm" mode="radio" label="Layout" value={view} onChange={onViewChange}
            options={[{ id: 'grid', icon: 'bi-grid-3x3-gap', ariaLabel: 'Grid', title: 'Grid' }, { id: 'list', icon: 'bi-list-ul', ariaLabel: 'List', title: 'List' }]} />
          {onRefresh && <IconButton icon="bi-arrow-clockwise" size="sm" ariaLabel="Refresh"
            title={refreshedAt ? `Refresh · read ${refreshedAt}` : 'Refresh'} onClick={onRefresh} />}
        </div>}
      </ScrollDock>
      {!matches.length && <div style={{ marginTop: 24 }}>
        <SurfaceState phase="ready" count={0} noun="previews" emptyIcon="bi-collection" emptyTitle="Nothing matches these filters"
          emptyBody="Clear the search and type filters to see every preview." actionLabel="Clear filters" actionIcon="bi-x" onAction={clear} />
      </div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 4 }}>
        {groups.map((group, index) => {
          const open = !collapsed.includes(group.key);
          const id = `library-group-${index}`;
          const toggle = () => onCollapsedChange(open ? collapsed.concat(group.key) : collapsed.filter((key) => key !== group.key));
          const context = (item) => (groupBy === 'project' ? item.gallery : item.project);
          const tile = (item, i) => <LibraryTile item={item} list={list} phone={phone} href={hrefFor?.(libraryId(item))} onOpen={onOpen}
            context={context(item)} dateLabel={field === 'createdAt' ? 'Created' : 'Last activity'} dateText={usDateTime(item[field])}
            zebra={i % 2 === 1} first={i === 0} />;
          return <section key={group.key} aria-label={group.label}>
            {/* The heading wraps the band's disclosure button; the wrapper pins, since a sticky
                element only sticks within its parent. */}
            {group.banded && <h2 style={{ position: 'sticky', top: dockHeight, zIndex: 3, margin: 0, padding: '10px 0',
              font: 'inherit', background: 'var(--surface-canvas, #F1F5F7)' }}>
              <GroupBand tone="neutral" label={group.label} count={group.items.length} note={group.note || undefined}
                open={open} onToggle={toggle} controls={id} style={{ borderRadius: 'var(--radius-sm, 4px)' }} />
            </h2>}
            {open && <div id={id} style={{ paddingTop: group.banded ? 2 : 8 }}>
              {list
                ? <ul style={{ listStyle: 'none', margin: 0, padding: 0, background: 'var(--surface-card, #fff)', border: '1px solid var(--border-color, #DEE2E6)',
                    borderRadius: 'var(--radius-md, 6px)', boxShadow: 'var(--shadow-card, 0 1px 3px rgba(7,54,82,.1))', overflow: 'hidden' }}>
                    {group.items.map((item, i) => <li key={libraryId(item)}>{tile(item, i)}</li>)}
                  </ul>
                : <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12,
                    gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 256px), 1fr))' }}>
                    {group.items.map((item, i) => <li key={libraryId(item)} style={{ display: 'flex', minWidth: 0 }}>{tile(item, i)}</li>)}
                  </ul>}
            </div>}
          </section>;
        })}
      </div>
    </section>;
  }

  return { DesignLibrary, GalleryPlaceholder };
}
