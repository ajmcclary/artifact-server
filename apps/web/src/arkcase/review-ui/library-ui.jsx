import { filterLibrary, groupLibrary, galleryKind, galleryKinds, groupingsFor, librarySorts, defaultSortDir, libraryDateField } from './page-model.js';
import { usDateTime } from './activity-model.js';
import { createThumbnailUI } from './placeholder-ui.jsx';
import { createToolbarUI } from './toolbar-ui.jsx';

/* The Library, laid out like Activity: the heading scrolls away, the shared page toolbar
   docks and leads with the title, and each group's band pins beneath it. The host owns every view choice (search,
   projects, types, grouping, sort, layout, collapsed groups, scroll and the returning tile) so a return
   from an opened page restores them. Tiles render no live preview: a captured thumbnail when
   supplied, otherwise the kind's placeholder sketch.
   `scope="artifact"` is one artifact's gallery in the same design: Section replaces Project
   (grouping and the tile's context) and there is no Projects menu. The review toolbar above
   already names the artifact, so the gallery shows no heading or description and its docked
   bar no title; the group bands take `headingLevel` themselves. */
export function createLibraryUI(React, DS) {
  const { IconButton, SegmentedControl, GroupBand, SurfaceState, SectionHeading } = DS;
  const { GalleryThumbnail, GalleryPlaceholder } = createThumbnailUI(React);
  const { PageToolbar, FilterGroup, FilterMenu, FilterSummary, ToolbarSearch } = createToolbarUI(React, DS);
  const secondary = { fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5A6268)' };
  const data = { fontFamily: 'var(--font-data, "Source Code Pro", monospace)', fontVariantNumeric: 'tabular-nums', color: 'var(--text-data, #495057)' };
  const strong = { fontWeight: 600, color: 'var(--text-strong, #111827)', overflowWrap: 'anywhere' };
  const libraryId = (item) => item.id ?? item.path;
  const plainClick = (event) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  const hidden = DS.visuallyHiddenStyle || { position: 'absolute', width: 1, height: 1, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 };
  /* The order stays in the trigger's accessible name but not on screen, keeping the bar to one
     row; the open menu shows it. */
  const sortLabel = (sortBy, dir) => <>{librarySorts.find((sort) => sort.id === sortBy).label}
    <span style={hidden}>{sortBy === 'name' ? (dir === 'asc' ? ' (A–Z)' : ' (Z–A)') : (dir === 'asc' ? ' (oldest)' : ' (newest)')}</span></>;
  const directions = (sortBy) => (sortBy === 'name' ? [['asc', 'A to Z'], ['desc', 'Z to A']] : [['desc', 'Newest first'], ['asc', 'Oldest first']]);

  const guideCount = (item) => (item.related?.length ? `${item.related.length} ${item.related.length === 1 ? 'guide' : 'guides'}` : null);

  /* A list row's guides link beside it, as their own exact pages; the row itself is one link,
     so they sit under it rather than inside. */
  function RelatedLinks({ item, hrefFor, onOpen, background }) {
    return <nav aria-label={`Guides for ${item.title}`} style={{ ...secondary, display: 'flex', flexWrap: 'wrap', gap: '2px 10px',
      padding: '0 14px 8px 126px', marginTop: -2, background }}>
      {item.related.map((link) => {
        const id = link.id ?? link.path;
        const href = hrefFor?.(id);
        const open = (event) => { if (href && !plainClick(event)) return; event.preventDefault(); onOpen(id); };
        return href
          ? <a key={id} href={href} onClick={open} style={{ color: 'var(--text-link, #0079A8)' }}>{link.title}</a>
          : <button key={id} type="button" onClick={open} style={{ font: 'inherit', color: 'var(--text-link, #0079A8)', background: 'none', border: 0, padding: 0, cursor: 'pointer' }}>{link.title}</button>;
      })}
    </nav>;
  }

  function LibraryTile({ item, href, onOpen, list, context, origin, dateLabel, dateText, zebra, first, phone }) {
    const kind = galleryKind(item.kind);
    const [hover, setHover] = React.useState(false);
    const Element = href ? 'a' : 'button';
    const activate = (event) => { if (href && !plainClick(event)) return; event.preventDefault(); onOpen(libraryId(item)); };
    const common = { ...(href ? { href } : { type: 'button' }), onClick: activate, 'data-gallery-path': libraryId(item),
      'aria-label': `Open ${item.title} · ${kind.singular}${origin ? ` · ${origin}` : ''}`,
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
          {phone && <span style={secondary}>{[kind.singular, context].filter(Boolean).join(' · ')}</span>}
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
          {kindLine}
          {[context, guideCount(item)].filter(Boolean).map((text) => <React.Fragment key={text}>
            <span aria-hidden="true">·</span><span style={{ overflowWrap: 'anywhere' }}>{text}</span></React.Fragment>)}</span>
        {dateText && <span style={{ ...secondary, marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 6, paddingTop: 8, borderTop: '1px solid var(--list-divider, #E9ECEF)' }}>
          <span>{dateLabel}</span><span style={data}>{dateText}</span></span>}
      </span>
    </Element>;
  }

  function DesignLibrary({ title = 'Library', description, items, now, notice, query = '', onQueryChange, types = [], onTypesChange, projects = [], onProjectsChange,
    groupBy = 'date', onGroupByChange, sortBy = 'activity', sortDir, onSortChange, view = 'grid', onViewChange,
    collapsed = [], onCollapsedChange, onRefresh, refreshedAt, onOpen, hrefFor, focusPath, scrollTop = 0, onScroll, onAnnounce, phone = false,
    scope = 'library', headingLevel = 1, coverUrl }) {
    const artifactScope = scope === 'artifact';
    const groupings = groupingsFor(scope);
    const BandHeading = `h${Math.min(artifactScope ? headingLevel : headingLevel + 1, 6)}`;
    const rootRef = React.useRef(null);
    const typesRef = React.useRef(null);
    const [menu, setMenu] = React.useState(null);
    const [dockHeight, setDockHeight] = React.useState(57);
    const dir = sortDir || defaultSortDir(sortBy);
    const matches = filterLibrary(items, query, types, projects);
    const groups = groupLibrary(matches, { groupBy, sortBy, dir, now: now ?? Date.now() });
    const field = libraryDateField(sortBy);
    const filtered = types.length > 0 || projects.length > 0 || query.trim().length > 0;
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
    const announce = (nextQuery, nextTypes, nextProjects) => onAnnounce?.(`${filterLibrary(items, nextQuery, nextTypes, nextProjects).length} matching previews.`);
    const setTypes = (next) => { onTypesChange(next); announce(query, next, projects); };
    const setProjects = (next) => { onProjectsChange?.(next); announce(query, types, next); };
    const clear = () => { onQueryChange(''); onTypesChange([]); onProjectsChange?.([]); announce('', [], []); };
    const counts = {};
    const projectCounts = {};
    items.forEach((item) => {
      counts[item.kind] = (counts[item.kind] || 0) + 1;
      projectCounts[item.project] = (projectCounts[item.project] || 0) + 1;
    });
    const projectNames = Object.keys(projectCounts).sort((a, b) => a.localeCompare(b));
    const menuButton = (id, icon, label) => <FilterMenu open={menu === id} onOpenChange={(next) => setMenu(next ? id : null)} icon={icon} label={label}
      menuLabel={{ group: 'Group by', sort: 'Sort by', projects: 'Projects', types: 'Artifact types' }[id]} minWidth={220} triggerRef={id === 'types' ? typesRef : undefined}
      items={{
        group: [{ heading: 'Group by' }, ...groupings.map((option) => ({ type: 'radio', label: option.label, checked: groupBy === option.id,
          onClick: () => onGroupByChange(option.id) }))],
        sort: [{ heading: 'Sort by' }, ...librarySorts.map((option) => ({ type: 'radio', label: option.label, checked: sortBy === option.id,
          onClick: () => onSortChange(option.id, defaultSortDir(option.id)) })),
        { divider: true }, { heading: 'Order' },
        ...directions(sortBy).map(([id, label]) => ({ type: 'radio', label, checked: dir === id, onClick: () => onSortChange(sortBy, id) }))],
        projects: projectNames.map((name) => ({ type: 'checkbox', label: name, icon: 'bi-folder2', meta: projectCounts[name],
          checked: projects.includes(name), keepOpen: true,
          onClick: () => setProjects(projects.includes(name) ? projects.filter((x) => x !== name) : projects.concat(name)) })),
        types: galleryKinds.filter((kind) => counts[kind.id]).map((kind) => ({ type: 'checkbox', label: kind.label, icon: kind.icon,
          meta: counts[kind.id], checked: types.includes(kind.id), keepOpen: true,
          onClick: () => setTypes(types.includes(kind.id) ? types.filter((id) => id !== kind.id) : types.concat(kind.id)) })),
      }[id]} />;
    const chips = projects.map((name) => ({ key: 'project:' + name, label: name, icon: 'bi-folder2', remove: () => setProjects(projects.filter((x) => x !== name)) }))
      .concat(types.map((id) => { const kind = galleryKind(id); return { key: 'type:' + id, label: kind.label, icon: kind.icon, remove: () => setTypes(types.filter((x) => x !== id)) }; }));
    const groupName = (groupings.find((option) => option.id === groupBy) || groupings[0]).label;

    return <section ref={rootRef} aria-label={artifactScope ? `${title} gallery` : title} onScroll={(event) => onScroll?.(event.currentTarget.scrollTop)}
      style={{ height: '100%', overflowY: 'auto', boxSizing: 'border-box', padding: `0 ${gutter}px 48px`,
        background: 'var(--surface-canvas, #F1F5F7)', color: 'var(--text-body, #212529)' }}>
      {artifactScope
        ? (notice ? <div style={{ padding: '12px 0 4px' }}>{notice}</div> : <div style={{ height: 8 }} />)
        : <header style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '24px 0 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {coverUrl && !phone && <img src={coverUrl} alt="" style={{ flex: 'none', width: 120, aspectRatio: '16 / 10', objectFit: 'cover',
              borderRadius: 'var(--radius-md, 6px)', border: '1px solid var(--border-color, #DEE2E6)' }} />}
            <SectionHeading level={headingLevel} size="lg" title={title} subtitle={description} style={{ minWidth: 0, flex: 1 }} />
          </div>
          {notice}
        </header>}
      <PageToolbar title={artifactScope ? null : title} label={artifactScope ? 'Gallery view' : 'Library view'} gutter={gutter} phone={phone} onHeight={setDockHeight}
        end={<>
          <ToolbarSearch label="Search previews" placeholder="Search previews" value={query}
            onChange={(event) => { onQueryChange(event.target.value); announce(event.target.value, types, projects); }} />
          <SegmentedControl variant="pill" size="sm" mode="radio" label="Layout" value={view} onChange={onViewChange}
            options={[{ id: 'grid', icon: 'bi-grid-3x3-gap', ariaLabel: 'Grid', title: 'Grid' }, { id: 'list', icon: 'bi-list-ul', ariaLabel: 'List', title: 'List' }]} />
          {onRefresh && <IconButton icon="bi-arrow-clockwise" size="sm" ariaLabel="Refresh"
            title={refreshedAt ? `Refresh · read ${refreshedAt}` : 'Refresh'} onClick={onRefresh} />}
        </>}>
        <FilterGroup label="View and filters">
          {menuButton('group', 'bi-layers', `Group: ${groupName}`)}
          {menuButton('sort', 'bi-sort-alpha-down', <>Sort: {sortLabel(sortBy, dir)}</>)}
          {onProjectsChange && menuButton('projects', 'bi-folder2', projects.length ? `Projects · ${projects.length}` : 'All projects')}
          {menuButton('types', 'bi-funnel', types.length ? `Types · ${types.length}` : 'All types')}
        </FilterGroup>
      </PageToolbar>
      <FilterSummary filtered={filtered} status={<>Showing <span style={data}>{matches.length}</span> of <span style={data}>{items.length}</span> previews</>}
        chips={chips} onClear={clear} fallbackRef={typesRef} />
      {!matches.length && <div style={{ marginTop: 24 }}>
        <SurfaceState phase="ready" count={0} noun="previews" emptyIcon="bi-collection" emptyTitle="Nothing matches these filters"
          emptyBody={artifactScope ? 'Clear the search and type filters to see every preview.' : 'Clear the search, project and type filters to see every preview.'} actionLabel="Clear filters" actionIcon="bi-x" onAction={clear} />
      </div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 4 }}>
        {groups.map((group, index) => {
          const open = !collapsed.includes(group.key);
          const id = `library-group-${index}`;
          const toggle = () => onCollapsedChange(open ? collapsed.concat(group.key) : collapsed.filter((key) => key !== group.key));
          /* A tile names where it comes from, unless its band already does. */
          const origin = (item) => (artifactScope ? item.section : item.project);
          const context = (item) => (artifactScope ? (groupBy === 'section' ? null : item.section) : groupBy === 'project' ? item.gallery : item.project);
          const tile = (item, i) => <LibraryTile item={item} list={list} phone={phone} href={hrefFor?.(libraryId(item))} onOpen={onOpen}
            context={context(item)} origin={origin(item)} dateLabel={field === 'createdAt' ? 'Created' : 'Last activity'} dateText={usDateTime(item[field])}
            zebra={i % 2 === 1} first={i === 0} />;
          return <section key={group.key} aria-label={group.label}>
            {/* The heading wraps the band's disclosure button; the wrapper pins, since a sticky
                element only sticks within its parent. */}
            {group.banded && <BandHeading style={{ position: 'sticky', top: dockHeight, zIndex: 3, margin: 0, padding: '10px 0',
              font: 'inherit', background: 'var(--surface-canvas, #F1F5F7)' }}>
              <GroupBand tone="neutral" label={group.label} count={group.items.length} note={group.note || undefined}
                open={open} onToggle={toggle} controls={id} style={{ borderRadius: 'var(--radius-sm, 4px)' }} />
            </BandHeading>}
            {open && <div id={id} style={{ paddingTop: group.banded ? 2 : 8 }}>
              {list
                ? <ul style={{ listStyle: 'none', margin: 0, padding: 0, background: 'var(--surface-card, #fff)', border: '1px solid var(--border-color, #DEE2E6)',
                    borderRadius: 'var(--radius-md, 6px)', boxShadow: 'var(--shadow-card, 0 1px 3px rgba(7,54,82,.1))', overflow: 'hidden' }}>
                    {group.items.map((item, i) => <li key={libraryId(item)}>{tile(item, i)}
                      {item.related?.length > 0 && <RelatedLinks item={item} hrefFor={hrefFor} onOpen={onOpen}
                        background={i % 2 === 1 ? 'var(--surface-secondary, #F8F9FA)' : 'var(--surface-card, #fff)'} />}</li>)}
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

  /* One artifact's gallery: the Library in artifact scope over that version's preview index.
     Hosts that own every view choice pass them as they do to the Library; any left out are
     kept here. The earlier single `kind` / `onKindChange` pair still seeds and reports types. */
  function DesignGallery({ kind, onKindChange, types, onTypesChange, groupBy, onGroupByChange, sortBy, sortDir, onSortChange,
    collapsed, onCollapsedChange, query = '', ...rest }) {
    const [local, setLocal] = React.useState(() => ({ types: kind && kind !== 'all' ? [kind] : [], groupBy: 'type', sortBy: 'name', sortDir: 'asc', collapsed: [] }));
    const set = (patch) => setLocal((current) => ({ ...current, ...patch }));
    return <DesignLibrary scope="artifact" headingLevel={2} {...rest} query={query}
      types={types ?? local.types}
      onTypesChange={(next) => { if (onTypesChange) onTypesChange(next); else set({ types: next }); onKindChange?.(next.length === 1 ? next[0] : 'all'); }}
      groupBy={groupBy ?? local.groupBy} onGroupByChange={onGroupByChange ?? ((next) => set({ groupBy: next }))}
      sortBy={sortBy ?? local.sortBy} sortDir={sortBy ? sortDir : local.sortDir}
      onSortChange={onSortChange ?? ((nextSort, nextDir) => set({ sortBy: nextSort, sortDir: nextDir }))}
      collapsed={collapsed ?? local.collapsed} onCollapsedChange={onCollapsedChange ?? ((next) => set({ collapsed: next }))} />;
  }

  return { DesignLibrary, DesignGallery, GalleryPlaceholder };
}
