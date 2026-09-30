import { filterGallery, filterPages, galleryKind, groupGallery } from './page-model.js';

// The host supplies its existing React runtime and ArkCase exports; no duplicated primitives.
export function createReviewUI(React, DS) {
  const { Button, Popover, Input, GroupBand, SelectableRow, Modal, SurfaceState, Disclosure, FileList, SegmentedControl } = DS;
  const secondary = { fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5A6268)', overflowWrap: 'anywhere' };
  const code = { ...secondary, fontFamily: 'var(--font-data, monospace)', userSelect: 'text' };

  function PagePicker({ pages, value, onSelect, open, onOpenChange, query, onQueryChange, limit = 50,
    onLoadMore, phone = false, inline = false, automatic = false, label = 'Pages', onAnnounce }) {
    const matches = filterPages(pages, query);
    const visible = matches.slice(0, limit);
    const groups = [...new Set(visible.map((page) => page.group))];
    const searchRef = React.useRef(null);
    const triggerRef = React.useRef(null);
    React.useEffect(() => { if (open && !inline) searchRef.current?.focus(); }, [open, inline]);
    const choose = (path) => {
      onSelect(path);
      if (!inline) { onOpenChange(false); triggerRef.current?.querySelector('button')?.focus(); }
    };
    const content = <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, gap: 8 }}>
      <Input label={inline ? 'Find a default page' : 'Find a page'} icon="bi-search" type="search" touch={phone}
        inputRef={searchRef} value={query} onChange={(e) => {
          onQueryChange(e.target.value);
          onAnnounce?.(`${filterPages(pages, e.target.value).length} matching pages.`);
        }} />
      <div aria-label={`${label} list`} style={{ overflowY: 'auto', maxHeight: inline ? 200 : 'min(55vh, 420px)' }}>
        {automatic && <SelectableRow as="button" selected={!value} label="Use Automatic default page" onSelect={() => choose('')}>Automatic</SelectableRow>}
        {groups.map((group) => <section key={group}>
          <GroupBand label={group} count={matches.filter((page) => page.group === group).length} />
          {visible.filter((page) => page.group === group).map((page) => <SelectableRow as="button" key={page.path}
            label={`Open page ${page.name}${page.isDefault ? ' · Default page' : ''}`} selected={page.path === value}
            onSelect={() => choose(page.path)} style={{ minHeight: 44 }}>
            <div style={{ fontWeight: 600 }}>{page.name}{page.isDefault ? ' · Default page' : ''}</div>
            <div style={code}>{page.path}</div>
          </SelectableRow>)}
        </section>)}
        {!matches.length && <SurfaceState phase="ready" count={0} noun="pages" density="inline"
          emptyTitle="No matching pages" emptyBody="Search by name, path or group." />}
      </div>
      {matches.length > visible.length && <Button variant="secondary" outline size="sm" onClick={onLoadMore}>Load more pages</Button>}
      <div style={secondary}>{visible.length} of {matches.length} matching pages shown</div>
    </div>;
    if (inline) return <section aria-label={label}>{content}</section>;
    const selected = pages.find((page) => page.path === value);
    if (!pages.length) return null;
    if (pages.length === 1) return <span style={secondary} aria-label="Selected page">{selected?.name || pages[0].name} · 1 page</span>;
    /* The shared outline Button, like the version and Share triggers beside it, so the
       toolbar keeps one height, hairline, type size and hover/open treatment. */
    const trigger = <Button variant="secondary" outline size="sm" iconRight="bi-chevron-down"
      aria-label={`${label} · ${selected?.name || 'Choose a page'} · ${pages.length} pages`}
      expanded={!!open} hasPopup="dialog" onClick={phone ? () => onOpenChange(true) : undefined}
      style={{ minWidth: 0, maxWidth: phone ? '100%' : 240, minHeight: phone ? 44 : undefined }}>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {phone ? '' : label + ' · '}{selected?.name || 'Choose'} · {pages.length}
      </span>
    </Button>;
    return <span ref={triggerRef} style={{ display: 'inline-flex', minWidth: 0, maxWidth: '100%' }}>
      {phone ? <>{trigger}{open && <Modal open title="Pages" size="viewport" initialFocus={searchRef}
        onClose={() => onOpenChange(false)}>{content}</Modal>}</>
        : <Popover label="Pages" open={open} onOpenChange={onOpenChange} trigger={trigger} width={380}
          contentStyle={{ padding: 12 }} zIndex={1200}>{content}</Popover>}
    </span>;
  }

  function ArtifactLinks({ rows, onCopy, copyAll, title, note = 'Example URLs · browser-local prototype' }) {
    return <section aria-label={title} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={secondary}>{note}</div>
      {copyAll && rows.length > 0 && onCopy(rows.map((row) => row.url).join('\n'), copyAll)}
      {rows.map((row) => <div key={`${row.label}:${row.url}`} style={{ padding: '10px 0', borderBottom: '1px solid var(--list-divider, #E9ECEF)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 600 }}>{row.label}</span>{onCopy(row.url, `Copy ${row.label}`)}
        </div>
        {row.path && <div style={code}>{row.path}</div>}
        <div style={{ ...code, color: 'var(--text-link, #0079A8)', marginTop: 4 }}>{row.url}</div>
        {row.description && <div style={{ ...secondary, marginTop: 4 }}>{row.description}</div>}
      </div>)}
    </section>;
  }
  /* Top-level files stay in view; each folder collapses behind a Disclosure so supporting
     assets and project internals stay out of the way until asked for. The folder holding
     `selected` opens itself, so choosing a page from elsewhere never hides its row. */
  const folderOf = (name) => (String(name).includes('/') ? String(name).split('/')[0] : '');
  function FileGroups({ files, label, selected }) {
    const root = files.filter((file) => !folderOf(file.name));
    const folders = [...new Set(files.map((file) => folderOf(file.name)).filter(Boolean))];
    const selectedFolder = folderOf(selected || '');
    const [open, setOpen] = React.useState(() => new Set(selectedFolder ? [selectedFolder] : []));
    React.useEffect(() => {
      if (selectedFolder) setOpen((prev) => (prev.has(selectedFolder) ? prev : new Set(prev).add(selectedFolder)));
    }, [selectedFolder]);
    const toggle = (folder, next) => setOpen((prev) => {
      const set = new Set(prev);
      if (next) set.add(folder); else set.delete(folder);
      return set;
    });
    return <section aria-label={label}>
      {root.length > 0 && <FileList label={folders.length ? 'Top-level files' : label} files={root} style={{ paddingLeft: 10 }} />}
      {folders.map((folder) => {
        const inside = files.filter((file) => folderOf(file.name) === folder);
        return <Disclosure key={folder} density="compact" title={folder + '/'} open={open.has(folder)}
          onToggle={(next) => toggle(folder, next)}
          leading={<i className="bi bi-folder" aria-hidden="true" style={{ fontSize: 'var(--icon-xs, 14px)' }} />}
          trailing={inside.length}>
          <FileList label={'Files in ' + folder} style={{ paddingLeft: 36 }}
            files={inside.map((file) => ({ ...file, name: file.name.slice(folder.length + 1) }))} />
        </Disclosure>;
      })}
    </section>;
  }
  /* The design gallery replaces a generated catalog's nested preview stage. Tiles are
     native links (or buttons without `hrefFor`) that ask the host to open the original
     file as the exact selected page; the gallery never renders a live preview itself.
     A missing or broken thumbnail becomes a placeholder drawn at the declared viewport's
     proportions, so a tile never depends on image bytes to be useful. */
  const galleryId = (item) => item.id ?? item.path;
  const plainClick = (event) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  function GalleryThumbnail({ item, compact }) {
    const [failed, setFailed] = React.useState(false);
    const kind = galleryKind(item.kind);
    const { width, height } = item.viewport;
    if (item.thumbnailUrl && !failed) return <img src={item.thumbnailUrl} alt="" loading="lazy" decoding="async"
      data-gallery-thumbnail="image" onError={() => setFailed(true)}
      style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top left' }} />;
    const wide = width / height >= 1.6;
    return <div aria-hidden="true" data-gallery-thumbnail="placeholder" style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
      <div style={{ aspectRatio: `${width} / ${height}`, width: wide ? '80%' : 'auto', height: wide ? 'auto' : '76%', maxWidth: '80%', maxHeight: '76%',
        boxSizing: 'border-box', border: '1px dashed var(--border-color-strong, #ADB5BD)', borderRadius: 'var(--radius-sm, 4px)',
        background: 'var(--surface-card, #fff)', color: 'var(--text-secondary, #5A6268)', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: compact ? 0 : 6, overflow: 'hidden' }}>
        <i className={`bi ${kind.icon}`} style={{ fontSize: compact ? 'var(--icon-xs, 14px)' : 'var(--icon-lg, 24px)' }} />
        {!compact && <span style={{ ...code, fontSize: 'var(--font-size-label, 11px)' }}>{width} × {height}</span>}
      </div>
    </div>;
  }
  function GalleryTile({ item, href, onOpen, list }) {
    const kind = galleryKind(item.kind);
    const [hover, setHover] = React.useState(false);
    const Element = href ? 'a' : 'button';
    const activate = (event) => { if (href && !plainClick(event)) return; event.preventDefault(); onOpen(galleryId(item)); };
    const frame = { flex: 'none', overflow: 'hidden', background: 'var(--surface-tertiary, #E9ECEF)',
      borderRadius: list ? 'var(--radius-sm, 4px)' : 0, ...(list ? { width: 96, height: 60 } : { aspectRatio: '16 / 10' }) };
    const meta = <div style={{ ...secondary, display: 'flex', flexWrap: 'wrap', gap: '2px 8px', alignItems: 'center' }}>
      <span><i className={`bi ${kind.icon}`} aria-hidden="true" style={{ marginRight: 4 }} />{kind.singular}</span>
      <span style={{ fontFamily: 'var(--font-data, monospace)' }}>{item.viewport.width} × {item.viewport.height}</span>
      {!item.thumbnailUrl && <span>No thumbnail</span>}
      {!list && item.related?.length > 0 && <span>{item.related.length} {item.related.length === 1 ? 'guide' : 'guides'}</span>}
      {item.context && <span style={{ overflowWrap: 'anywhere' }}>{item.context}</span>}
    </div>;
    return <Element {...(href ? { href } : { type: 'button' })} onClick={activate} data-gallery-path={galleryId(item)}
      aria-label={`Open ${item.title} · ${kind.singular} · ${item.section}${item.context ? ` · ${item.context}` : ''}`}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', flexDirection: list ? 'row' : 'column', alignItems: list ? 'center' : 'stretch', gap: list ? 12 : 0,
        minWidth: 0, width: '100%', boxSizing: 'border-box', padding: list ? 8 : 0, textAlign: 'left', font: 'inherit', color: 'inherit',
        textDecoration: 'none', cursor: 'pointer', overflow: 'hidden', background: 'var(--surface-card, #fff)',
        border: `1px solid ${hover ? 'var(--border-color-strong, #ADB5BD)' : 'var(--border-color, #DEE2E6)'}`,
        borderRadius: 'var(--radius-md, 6px)', boxShadow: hover ? 'var(--shadow-sm, 0 1px 2px rgba(0,0,0,.08))' : 'none' }}>
      <div style={frame}><GalleryThumbnail item={item} compact={list} /></div>
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 4, padding: list ? 0 : '10px 12px 12px' }}>
        <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{item.title}</div>
        {item.description && <div style={{ ...secondary, display: '-webkit-box', WebkitLineClamp: list ? 1 : 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{item.description}</div>}
        {meta}
        {list && <div style={{ ...code, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.path}</div>}
      </div>
    </Element>;
  }
  /* Related guides sit beside a tile, never inside its link, so each stays its own target. */
  function RelatedLinks({ item, hrefFor, onOpen }) {
    return <nav aria-label={`Guides for ${item.title}`} style={{ ...secondary, display: 'flex', flexWrap: 'wrap', gap: '2px 10px', paddingLeft: 116 }}>
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
  function DesignGallery({ title, description, coverUrl, items, query, onQueryChange, kind = 'all', onKindChange,
    view = 'grid', onViewChange, onOpen, hrefFor, focusPath, scrollTop = 0, onScroll, onAnnounce, notice, phone = false }) {
    const rootRef = React.useRef(null);
    const matches = filterGallery(items, query, kind);
    const groups = groupGallery(matches);
    const kinds = groupGallery(items);
    const list = view === 'list';
    React.useLayoutEffect(() => {
      const root = rootRef.current;
      if (!root) return;
      root.scrollTop = scrollTop;
      if (focusPath) Array.from(root.querySelectorAll('[data-gallery-path]'))
        .find((tile) => tile.getAttribute('data-gallery-path') === focusPath)?.focus({ preventScroll: scrollTop > 0 });
      // Restore once per mount; later prop changes come from this gallery's own scrolling.
    }, []);
    const announce = (nextQuery, nextKind) => onAnnounce?.(`${filterGallery(items, nextQuery, nextKind).length} matching previews.`);
    return <section ref={rootRef} aria-label={`${title} gallery`} onScroll={(event) => onScroll?.(event.currentTarget.scrollTop)}
      style={{ height: '100%', overflowY: 'auto', boxSizing: 'border-box', padding: phone ? '16px 16px 32px' : '24px 28px 40px',
        background: 'var(--surface-body, #F8F9FA)', color: 'var(--text-body, #212529)' }}>
      <header style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16 }}>
        {coverUrl && !phone && <img src={coverUrl} alt="" style={{ flex: 'none', width: 120, aspectRatio: '16 / 10', objectFit: 'cover',
          borderRadius: 'var(--radius-md, 6px)', border: '1px solid var(--border-color, #DEE2E6)' }} />}
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontFamily: 'var(--font-heading, serif)', fontSize: 'var(--font-size-xl, 20px)', overflowWrap: 'anywhere' }}>{title}</h2>
          {description && <p style={{ ...secondary, fontSize: 'var(--font-size-sm, 14px)', margin: '4px 0 0' }}>{description}</p>}
          <p style={{ ...secondary, margin: '4px 0 0' }}>{items.length} {items.length === 1 ? 'preview' : 'previews'} · each opens as its own exact page</p>
        </div>
      </header>
      {notice}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', marginBottom: 16 }}>
        <div style={{ flex: '1 1 240px', maxWidth: 420 }}>
          <Input label="Find a preview" icon="bi-search" type="search" touch={phone} value={query}
            onChange={(event) => { onQueryChange(event.target.value); announce(event.target.value, kind); }} />
        </div>
        <SegmentedControl label="Gallery layout" size="sm" mode="radio" value={view} onChange={onViewChange}
          options={[{ id: 'grid', icon: 'bi-grid-3x3-gap', label: 'Grid' }, { id: 'list', icon: 'bi-list-ul', label: 'List' }]} />
      </div>
      {kinds.length > 1 && <SegmentedControl label="Preview kind" variant="chip" wrap value={kind}
        onChange={(next) => { onKindChange(next); announce(query, next); }} style={{ marginBottom: 16 }}
        options={[{ id: 'all', label: 'All', count: items.length }, ...kinds.map((group) => ({ id: group.id, label: group.label, count: group.count }))]} />}
      {groups.map((group) => <section key={group.id} aria-labelledby={`gallery-kind-${group.id}`} style={{ marginBottom: 24 }}>
        <h3 id={`gallery-kind-${group.id}`} style={{ margin: '0 0 8px', fontSize: 'var(--font-size-lg, 18px)', fontFamily: 'var(--font-heading, serif)' }}>
          {group.label} <span style={{ ...code, fontSize: 'var(--font-size-sm, 14px)' }}>{group.count}</span></h3>
        {group.sections.map(({ section, items: inSection }) => <section key={section} aria-label={`${group.label} · ${section}`} style={{ marginBottom: 12 }}>
          {(group.sections.length > 1 || section !== group.label) && <GroupBand label={section} count={inSection.length} />}
          <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'grid', gap: list ? 8 : 14,
            gridTemplateColumns: list ? 'minmax(0, 1fr)' : 'repeat(auto-fill, minmax(min(100%, 232px), 1fr))' }}>
            {inSection.map((item) => <li key={galleryId(item)} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <GalleryTile item={item} list={list} href={hrefFor?.(galleryId(item))} onOpen={onOpen} />
              {list && item.related?.length > 0 && <RelatedLinks item={item} hrefFor={hrefFor} onOpen={onOpen} />}</li>)}
          </ul>
        </section>)}
      </section>)}
      {!matches.length && <SurfaceState phase="ready" count={0} noun="previews" filtered density="inline"
        emptyTitle="No matching previews" filterBody="Search by title, section, description or path."
        onClear={() => { onQueryChange(''); onKindChange('all'); announce('', 'all'); }} />}
    </section>;
  }
  return { PagePicker, ArtifactLinks, FileGroups, DesignGallery };
}
