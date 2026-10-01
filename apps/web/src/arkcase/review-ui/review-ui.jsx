import { filterGallery, filterPages, galleryKind, groupGallery } from './page-model.js';
import { createActivityUI } from './activity-ui.jsx';
import { createThumbnailUI } from './placeholder-ui.jsx';
import { createLibraryUI } from './library-ui.jsx';

// The host supplies its existing React runtime and ArkCase exports; no duplicated primitives.
export function createReviewUI(React, DS) {
  const { Button, Popover, Input, GroupBand, SurfaceState, SegmentedControl, TreeView, LinkRow, StatusPill,
    Breadcrumb, CrumbMenu, SearchableList, RowActions, LoadMore, IconButton, Eyebrow, MentionComposer, MentionText, visuallyHiddenStyle } = DS;
  const secondary = { fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5A6268)', overflowWrap: 'anywhere' };
  const code = { ...secondary, fontFamily: 'var(--font-data, monospace)', userSelect: 'text' };
  const { GalleryThumbnail } = createThumbnailUI(React);
  /* A page as a picker row: its name over its path, the default page named. */
  const pageItem = (page, group) => ({ id: page.path, group: group ?? page.group,
    title: <span style={{ fontWeight: 600, color: 'var(--text-strong, #111827)' }}>{page.name}{page.isDefault
      ? <span style={{ fontWeight: 400, color: 'var(--text-secondary, #5A6268)' }}> · Default page</span> : null}</span>,
    description: <span style={{ fontFamily: 'var(--font-data, monospace)', color: 'var(--text-data, #495057)' }}>{page.path}</span>,
    ariaLabel: `Open page ${page.name}${page.isDefault ? ' · Default page' : ''}` });

  /* The default-page picker: inline in publishing (with the Automatic choice), or behind an
     outline trigger that opens a Popover (a viewport sheet on a phone). */
  function PagePicker({ pages, value, onSelect, open, onOpenChange, query, onQueryChange, limit = 50,
    onLoadMore, phone = false, inline = false, automatic = false, label = 'Pages', onAnnounce }) {
    const matches = filterPages(pages, query);
    const wrapRef = React.useRef(null);
    React.useEffect(() => {
      if (!open || inline || phone) return undefined;
      const id = setTimeout(() => wrapRef.current?.querySelector('input[type="search"]')?.focus(), 0);
      return () => clearTimeout(id);
    }, [open, inline, phone]);
    const choose = (path) => {
      onSelect(path);
      if (!inline) { onOpenChange(false); setTimeout(() => wrapRef.current?.querySelector('button')?.focus(), 0); }
    };
    const content = <SearchableList label={`${label} list`} noun="pages" searchLabel={inline ? 'Find a default page' : 'Find a page'}
      touch={phone} query={query} onQueryChange={onQueryChange} items={matches.map((page) => pageItem(page))} total={pages.length}
      pinned={automatic ? [{ id: '', title: 'Automatic', ariaLabel: 'Use Automatic default page' }] : []}
      selected={automatic && !value ? '' : value} onSelect={(id) => choose(id)} limit={limit} onLoadMore={onLoadMore}
      loadMoreLabel="Load more pages" countLabel={(shown, _total, matching) => `${shown} of ${matching} matching pages shown`}
      emptyTitle="No matching pages" emptyBody="Search by name, path or group." maxHeight={inline ? 200 : 'min(55vh, 420px)'}
      onAnnounce={onAnnounce} />;
    if (inline) return <section aria-label={label}>{content}</section>;
    const selected = pages.find((page) => page.path === value);
    if (!pages.length) return null;
    if (pages.length === 1) return <span style={secondary} aria-label="Selected page">{selected?.name || pages[0].name} · 1 page</span>;
    /* The shared outline Button, like the version and Share triggers beside it, so the
       toolbar keeps one height, hairline, type size and hover/open treatment. */
    const trigger = <Button variant="secondary" outline size="sm" iconRight="bi-chevron-down"
      aria-label={`${label} · ${selected?.name || 'Choose a page'} · ${pages.length} pages`}
      expanded={!!open} hasPopup="dialog"
      style={{ minWidth: 0, maxWidth: phone ? '100%' : 240, minHeight: phone ? 44 : undefined }}>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {phone ? '' : label + ' · '}{selected?.name || 'Choose'} · {pages.length}
      </span>
    </Button>;
    return <span ref={wrapRef} data-page-picker="" style={{ display: 'inline-flex', minWidth: 0, maxWidth: '100%' }}>
      <Popover label="Pages" sheetTitle="Pages" presentation={phone ? 'sheet' : 'popover'} initialFocus='input[type="search"]'
        open={open} onOpenChange={onOpenChange} trigger={trigger} width={380}
        contentStyle={{ padding: 0 }} zIndex={1200}>{content}</Popover>
    </span>;
  }

  /* `compact` sets each URL on one truncated line (the full address stays in its title and
     in the copy), for a dense panel such as Details. */
  function ArtifactLinks({ rows, onCopy, copyAll, title, note = 'Example URLs · browser-local prototype', compact = false }) {
    const line = compact ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', overflowWrap: 'normal' } : null;
    return <section aria-label={title} style={{ display: 'flex', flexDirection: 'column', gap: compact ? 2 : 10 }}>
      {note && <div style={secondary}>{note}</div>}
      {copyAll && rows.length > 0 && onCopy(rows.map((row) => row.url).join('\n'), copyAll)}
      {rows.map((row) => <div key={`${row.label}:${row.url}`} style={{ padding: compact ? '6px 0' : '10px 0', borderBottom: compact ? 0 : '1px solid var(--list-divider, #E9ECEF)',
        ...(compact ? { display: 'flex', alignItems: 'flex-start', gap: 8 } : null) }}>
        <div style={compact ? { flex: '1 1 auto', minWidth: 0 } : { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 600, ...(compact ? { fontSize: 'var(--font-size-dense, 13px)', color: 'var(--text-strong, #111827)' } : null) }}>{row.label}</div>
          {!compact && onCopy(row.url, `Copy ${row.label}`)}
          {compact && <>
            {row.path && <div style={{ ...code, ...line }} title={row.path}>{row.path}</div>}
            <div style={{ ...code, color: 'var(--text-link, #0079A8)', marginTop: 2, ...line }} title={row.url}>{row.url}</div>
            {row.description && <div style={{ ...secondary, marginTop: 2 }}>{row.description}</div>}
          </>}
        </div>
        {compact && <span style={{ flex: 'none' }}>{onCopy(row.url, `Copy ${row.label}`)}</span>}
        {!compact && row.path && <div style={code}>{row.path}</div>}
        {!compact && <div style={{ ...code, color: 'var(--text-link, #0079A8)', marginTop: 4 }}>{row.url}</div>}
        {!compact && row.description && <div style={{ ...secondary, marginTop: 4 }}>{row.description}</div>}
      </div>)}
    </section>;
  }
  /* The version's files as a real tree: folders expand and collapse, every row keeps one
     chevron column so icons line up at each level, and sizes (or a folder's file count) sit
     in a fixed right-aligned column. The folders holding `selected` open themselves, so a
     page chosen elsewhere never hides its row. */
  const FILE_ICONS = { html: 'bi-filetype-html', htm: 'bi-filetype-html', css: 'bi-filetype-css', json: 'bi-filetype-json',
    svg: 'bi-filetype-svg', png: 'bi-file-earmark-image', jpg: 'bi-file-earmark-image', jpeg: 'bi-file-earmark-image',
    gif: 'bi-file-earmark-image', webp: 'bi-file-earmark-image', md: 'bi-file-earmark-text', txt: 'bi-file-earmark-text' };
  const fileIcon = (name) => FILE_ICONS[String(name).split('.').pop().toLowerCase()] || 'bi-file-earmark';
  const folderIds = (path) => String(path || '').split('/').slice(0, -1).map((_, i, all) => 'dir:' + all.slice(0, i + 1).join('/') + '/');
  function fileTree(files, open) {
    const root = [];
    const dirs = new Map();
    const dirOf = (id, label, parent) => {
      if (dirs.has(id)) return dirs.get(id);
      const node = { id, label, children: [], leaves: 0 };
      dirs.set(id, node);
      parent.push(node);
      return node;
    };
    files.forEach((file) => {
      const parts = String(file.name).split('/');
      let into = root;
      const chain = [];
      parts.slice(0, -1).forEach((part, i) => {
        const dir = dirOf('dir:' + parts.slice(0, i + 1).join('/') + '/', part + '/', into);
        chain.push(dir);
        into = dir.children;
      });
      chain.forEach((dir) => { dir.leaves += 1; });
      into.push({ id: 'file:' + file.name, label: parts[parts.length - 1], icon: file.icon || fileIcon(file.name), file,
        meta: file.size != null ? String(file.size) : undefined,
        badge: file.role && file.role !== 'Selected' ? { value: file.role, tone: 'neutral' } : undefined });
    });
    const finish = (nodes) => nodes.map((node) => (node.file ? node : {
      id: node.id, label: node.label, icon: open.includes(node.id) ? 'bi-folder2-open' : 'bi-folder2',
      meta: node.leaves + (node.leaves === 1 ? ' file' : ' files'), children: finish(node.children),
    }));
    /* Top-level files first, then folders, as the inventory reads. */
    const done = finish(root);
    return done.filter((node) => node.file).concat(done.filter((node) => !node.file));
  }
  function FileGroups({ files, label, selected }) {
    const [open, setOpen] = React.useState(() => {
      const top = files.length <= 12 ? [...new Set(files.map((file) => folderIds(file.name)[0]).filter(Boolean))] : [];
      return [...new Set(top.concat(folderIds(selected)))];
    });
    React.useEffect(() => {
      const need = folderIds(selected);
      if (need.some((id) => !open.includes(id))) setOpen((prev) => [...new Set(prev.concat(need))]);
    }, [selected]);
    const nodes = fileTree(files, open);
    return <section aria-label={label}>
      <TreeView label={label} nodes={nodes} expanded={open} onExpandedChange={setOpen} metaWidth={64}
        selected={selected ? 'file:' + selected : null}
        onSelect={(node) => { if (node.file && node.file.onSelect) node.file.onSelect(); }} />
    </section>;
  }
  /* One control for where the reader is: the version and the page. Its menu lists the newest
     versions (and the one shown, when it is older) with a way to every version, then the
     pages; an inventory too long to scan gets the page search. The host may add a footer,
     e.g. the notice that the linked source changed. */
  function VersionPageMenu({ label, ariaLabel, open, onOpenChange, versions, version, onSelectVersion, versionLimit = 4,
    allVersionsLabel, onAllVersions, pages, page, onSelectPage, query = '', onQueryChange, limit = 50, onLoadMore,
    searchFrom = 9, footer, phone = false, onAnnounce }) {
    const newest = versions.slice(0, versionLimit);
    const shownRow = versions.find((v) => v.n === version);
    const versionRows = shownRow && !newest.includes(shownRow) ? newest.concat([shownRow]) : newest;
    const searchable = pages.length >= searchFrom;
    const matches = searchable ? filterPages(pages, query) : pages;
    /* Designer groups (Templates, Actions…) head the list once there are more than the
       plain page and artboard folders; a long inventory is always grouped. */
    const grouped = searchable || new Set(pages.map((item) => item.group)).size > 2;
    const datum = { fontFamily: 'var(--font-data, monospace)', fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-data, #495057)' };
    return <CrumbMenu label={label} ariaLabel={ariaLabel} title="Version and page" open={open} onOpenChange={onOpenChange}
      presentation={phone ? 'sheet' : 'popover'} width={340} focusSelector='[data-version-row] [aria-current="true"]'>
      {({ close }) => <>
        <section aria-label="Version" data-version-row="" style={{ display: 'flex', flexDirection: 'column', gap: 1, padding: '6px 6px 0' }}>
          <Eyebrow as="h3" style={{ margin: 0, padding: '6px 8px 4px' }}>Version</Eyebrow>
          {versionRows.map((v) => <LinkRow key={v.n} density="compact" tone="body" selected={v.n === version}
            title={<span style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
              <span style={{ ...datum, fontSize: 'var(--font-size-dense, 13px)', fontWeight: 600, color: 'var(--text-strong, #111827)', minWidth: 28 }}>v{v.n}</span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text-secondary, #5A6268)' }}>
                <span style={datum}>{v.date}</span> · {v.by}{v.current ? ' · Current' : ''}</span>
            </span>}
            onSelect={() => { onSelectVersion(v.n); close(); }} />)}
          {onAllVersions && <Button variant="link" size="xs" onClick={() => { onAllVersions(); onOpenChange(false); }}
            style={{ alignSelf: 'flex-start', margin: '4px 6px' }}>{allVersionsLabel}</Button>}
        </section>
        <SearchableList label="Page" noun="pages" searchLabel="Find a page" touch={phone} searchable={searchable}
          query={query} onQueryChange={onQueryChange} items={matches.map((item) => pageItem(item))} total={pages.length}
          grouped={grouped} stickyGroups={false} selected={page} onSelect={(id) => { onSelectPage(id); close(); }}
          limit={searchable ? limit : undefined} onLoadMore={onLoadMore} loadMoreLabel="Load more pages"
          countLabel={(shown, _total, matching) => `${shown} of ${matching} matching pages shown`}
          emptyTitle="No matching pages" emptyBody="Search by name, path or group." maxHeight={searchable ? 'min(40vh, 320px)' : 'none'}
          onAnnounce={onAnnounce} after={footer} />
      </>}
    </CrumbMenu>;
  }
  /* The breadcrumb that heads the Review toolbar: the artifact name (only while the artifact
     list is collapsed; the docked list already names it), then the version and page crumbs,
     each a CrumbMenu. The name is always the page's h1: hidden but still announced while the
     list shows it. */
  function ArtifactBreadcrumb({ name, showName = true, nameMaxWidth = 260, crumbs = [], label = 'Breadcrumb' }) {
    const heading = <h1 title={name} style={showName ? { margin: 0, padding: '0 6px', minWidth: 0, maxWidth: nameMaxWidth,
      fontFamily: 'var(--font-heading, "Source Serif 4", Georgia, serif)', fontWeight: 600, fontSize: 'var(--font-size-md, 16px)', lineHeight: 1.2,
      color: 'var(--text-strong, #111827)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : visuallyHiddenStyle}>{name}</h1>;
    return <>
      {showName ? null : heading}
      <Breadcrumb variant="controls" label={label}
        items={[showName ? { node: heading, shrink: true } : null].concat(crumbs.filter(Boolean).map((crumb) => ({ node: crumb })))} />
    </>;
  }
  const filterVersions = (versions, query) => {
    const q = query.trim().toLocaleLowerCase();
    return q ? versions.filter((v) => `v${v.n} ${v.by} ${v.date}`.toLocaleLowerCase().includes(q)) : versions;
  };
  /* The version crumb. Its menu finds a version by number, author or date in one scrolling
     list (the current one tagged, the shown one checked), counts what matches and leads to
     the Versions panel for the full history. The host may add a footer, e.g. the notice that
     the linked source changed. */
  function VersionMenu({ label, ariaLabel, open, onOpenChange, versions, version, onSelectVersion, query = '', onQueryChange,
    onOpenPanel, panelLabel = 'Open Versions Panel', footer, phone = false, onAnnounce }) {
    const matches = filterVersions(versions, query);
    const datum = { fontFamily: 'var(--font-data, monospace)', fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-data, #495057)' };
    return <CrumbMenu label={label} ariaLabel={ariaLabel} title="Choose a version" open={open} onOpenChange={onOpenChange}
      presentation={phone ? 'sheet' : 'popover'} width={320} maxWidth={120}
      focusSelector='[data-searchable-list-rows] [aria-current="true"]'>
      {({ close }) => <SearchableList label="Versions" noun="versions" searchLabel="Find a version" searchPlaceholder="Number, author or date"
        touch={phone} query={query} onQueryChange={(q) => onQueryChange?.(q)} total={versions.length} maxHeight={phone ? 'none' : 252}
        items={matches.map((v) => ({ id: String(v.n),
          title: <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span style={{ ...datum, fontSize: 'var(--font-size-dense, 13px)', fontWeight: 600, color: 'var(--text-strong, #111827)', minWidth: 28 }}>v{v.n}</span>
            <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.by}</span>
            {v.current && <StatusPill tone="primary" label="Current" />}
          </span>,
          description: <span style={{ ...datum, display: 'block', paddingLeft: 38 }}>{v.date}</span> }))}
        selected={String(version)} onSelect={(id) => { onSelectVersion(Number(id)); close(); }}
        emptyTitle="No matching versions" emptyBody="Search by number, author or date."
        footer={onOpenPanel && <Button variant="link" size="xs" flush onClick={() => { onOpenPanel(); onOpenChange(false); }}>{panelLabel}</Button>}
        after={footer ? <div style={{ flex: 'none', padding: '0 12px 12px' }}>{footer}</div> : null}
        onAnnounce={onAnnounce} />}
    </CrumbMenu>;
  }
  /* The page crumb. Its menu finds a page by name or path; the default page heads the list,
     then each folder or designer group under a header that stays put while the list scrolls.
     A long inventory renders its first `limit` matches and loads more on request. A version
     with a gallery pins a Gallery row above the list, whatever the search, selected while the
     gallery is shown. */
  function PageMenu({ label, ariaLabel, open, onOpenChange, pages, page, onSelectPage, query = '', onQueryChange,
    limit = 50, onLoadMore, searchFrom = 2, phone = false, onAnnounce, gallery }) {
    const galleryShown = !!gallery && page == null;
    const searchable = pages.length >= searchFrom;
    const matches = searchable ? filterPages(pages, query) : pages;
    const groupOf = (item) => (item.isDefault ? 'Default page' : item.group);
    /* The default page heads the list; the other groups keep their first-seen order. */
    const ordered = matches.filter((item) => item.isDefault).concat(matches.filter((item) => !item.isDefault));
    /* A folder group reads as a path ("project/"); a designer group keeps its name. */
    const groupLabel = (group) => (group !== 'Default page' && pages.some((item) => item.group === group)
      && pages.filter((item) => item.group === group).every((item) => item.path.startsWith(group + '/')) ? group + '/' : group);
    const strong = { fontWeight: 600, color: 'var(--text-strong, #111827)' };
    return <CrumbMenu label={label} ariaLabel={ariaLabel} title="Choose a page" open={open} onOpenChange={onOpenChange} current
      presentation={phone ? 'sheet' : 'popover'} width={340}
      focusSelector='[data-searchable-list-pinned] [aria-current="true"], [data-searchable-list-rows] [aria-current="true"]'>
      {({ close }) => <SearchableList label="Pages" noun="pages" searchLabel="Find a page" searchPlaceholder="Name or path"
        touch={phone} searchable={searchable} query={query} onQueryChange={(q) => onQueryChange?.(q)} total={pages.length}
        pinned={gallery ? [{ id: '\u0000gallery', icon: 'bi-grid-3x3-gap', title: <span style={strong}>Gallery</span>,
          description: gallery.description ? <span style={secondary}>{gallery.description}</span> : undefined }] : []}
        items={ordered.map((item) => ({ ...pageItem(item, groupOf(item)), title: <span style={strong}>{item.name}</span>, ariaLabel: undefined }))}
        grouped groupLabel={groupLabel} selected={galleryShown ? '\u0000gallery' : page}
        onSelect={(id) => { if (id === '\u0000gallery') gallery.onOpen(); else onSelectPage(id); close(); }}
        limit={limit} onLoadMore={onLoadMore} loadMoreLabel="Load more pages" maxHeight={phone ? 'none' : 'min(50vh, 320px)'}
        emptyTitle="No matching pages" emptyBody="Search by name, path or group." onAnnounce={onAnnounce} />}
    </CrumbMenu>;
  }
  /* The version history in the inspector: each row previews its version, the one shown is
     selected, and Preview and More appear on hover or focus (RowActions). More's menu floats
     over the rows below rather than pushing them down. */
  function VersionList({ versions, shown, onPreview, menuItems, label = 'Versions', remaining = 0, olderLabel, onShowOlder, phone = false }) {
    return <section aria-label={label}>
      {versions.map((v) => <RowActions key={v.n} always={phone} menuLabel={`More actions for v${v.n}`} items={menuItems(v)}
        persistent={v.current ? <StatusPill tone="primary" label="Current" /> : null}
        quick={v.n !== shown ? <IconButton icon="bi-eye" size="xs" ariaLabel={`Preview v${v.n}`} onClick={() => onPreview(v.n)} /> : null}>
        {(actions) => <LinkRow tone="body" selected={v.n === shown} rail
          title={<span style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <span style={{ minWidth: 28, fontFamily: 'var(--font-data, monospace)', fontSize: 'var(--font-size-sm, 14px)', fontWeight: 600, color: 'var(--text-strong, #111827)' }}>v{v.n}</span>
            <span>{v.by}</span></span>}
          description={<span style={{ display: 'block', paddingLeft: 40, fontFamily: 'var(--font-data, monospace)', color: 'var(--text-data, #495057)' }}>{v.when}</span>}
          onSelect={() => onPreview(v.n)} actions={actions} />}
      </RowActions>)}
      <div style={{ padding: '0 8px' }}>
        <LoadMore shown={versions.length} total={versions.length + remaining} label={olderLabel || `Show ${remaining} Older`} onLoadMore={onShowOlder} />
      </div>
    </section>;
  }
  /* The design gallery replaces a generated catalog's nested preview stage. Tiles are
     native links (or buttons without `hrefFor`) that ask the host to open the original
     file as the exact selected page; the gallery never renders a live preview itself.
     A missing or broken thumbnail becomes the kind's full-bleed placeholder sketch, so a
     tile never depends on image bytes to be useful. */
  const galleryId = (item) => item.id ?? item.path;
  const plainClick = (event) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  function GalleryTile({ item, href, onOpen, list }) {
    const kind = galleryKind(item.kind);
    const [hover, setHover] = React.useState(false);
    const Element = href ? 'a' : 'button';
    const activate = (event) => { if (href && !plainClick(event)) return; event.preventDefault(); onOpen(galleryId(item)); };
    const frame = { position: 'relative', flex: 'none', overflow: 'hidden', background: 'var(--surface-tertiary, #E9ECEF)',
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
      {/* The meta line already names the viewport, so the thumbnail drops its size chip. */}
      <div style={frame}><GalleryThumbnail item={item} compact={list} chip={false} /></div>
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
  return { PagePicker, ArtifactLinks, FileGroups, VersionPageMenu, ArtifactBreadcrumb, VersionMenu, PageMenu, VersionList, MentionComposer, MentionText, DesignGallery, ...createActivityUI(React, DS), ...createLibraryUI(React, DS) };
}
