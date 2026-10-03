import { filterPages } from './page-model.js';
import { createActivityUI } from './activity-ui.jsx';
import { createLibraryUI } from './library-ui.jsx';

// The host supplies its existing React runtime and ArkCase exports; no duplicated primitives.
export function createReviewUI(React, DS) {
  const { Button, Popover, TreeView, LinkRow, StatusPill,
    Breadcrumb, CrumbMenu, SearchableList, RowActions, IconButton, Eyebrow, MentionComposer, MentionText, visuallyHiddenStyle } = DS;
  const secondary = { fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5A6268)', overflowWrap: 'anywhere' };
  const code = { ...secondary, fontFamily: 'var(--font-data, monospace)', userSelect: 'text' };
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
  /* The design system's one extension-to-glyph map (FileList's). */
  const fileIcon = (name) => DS.fileTypeIcon(name);
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
  /* Unloaded older versions end the list as one more row of the same card: a chevron in the
     version-number column, what the press reveals, and the range it covers beneath. */
  function OlderVersionsRow({ oldest, remaining, step, label, onShowOlder }) {
    const n = Math.min(step || remaining, remaining);
    const lo = oldest - n;
    const hi = oldest - 1;
    const title = label || `Show ${n} older ${n === 1 ? 'version' : 'versions'}`;
    return <LinkRow tone="link" onSelect={onShowOlder} ariaLabel={title}
      title={<span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ minWidth: 28, display: 'inline-flex', justifyContent: 'center' }}><i className="bi bi-chevron-down" aria-hidden="true" /></span>
        <span>{title}</span></span>}
      description={<span style={{ display: 'block', paddingLeft: 40, fontFamily: 'var(--font-data, monospace)', color: 'var(--text-data, #495057)' }}>
        {lo === hi ? `v${lo}` : `v${lo} – v${hi}`}{remaining > n ? ` · ${remaining} older in all` : ''}</span>} />;
  }

  function VersionList({ versions, shown, onPreview, menuItems, label = 'Versions', remaining = 0, olderStep, olderLabel, onShowOlder, phone = false }) {
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
      {remaining > 0 && <OlderVersionsRow oldest={versions.length ? versions[versions.length - 1].n : remaining + 1}
        remaining={remaining} step={olderStep} label={olderLabel} onShowOlder={onShowOlder} />}
    </section>;
  }
  return { PagePicker, ArtifactLinks, FileGroups, VersionPageMenu, ArtifactBreadcrumb, VersionMenu, PageMenu, VersionList, MentionComposer, MentionText, ...createActivityUI(React, DS), ...createLibraryUI(React, DS) };
}
