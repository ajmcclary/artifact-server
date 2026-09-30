import { filterPages } from './page-model.js';

// The host supplies its existing React runtime and ArkCase exports; no duplicated primitives.
export function createReviewUI(React, DS) {
  const { Button, Popover, Input, GroupBand, SelectableRow, Modal, SurfaceState, Disclosure, FileList } = DS;
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
  return { PagePicker, ArtifactLinks, FileGroups };
}
