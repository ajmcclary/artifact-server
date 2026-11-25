import { fmt } from '../components/utilities/format.jsx';
import { catalogPath, maximumTextPreviewBytes, fixtureText, officeDocument, galleryKind, exactPageUrl } from './page-model.js';
import { provenanceNote, annotateToggleLabel } from './scenario-model.js';

/* The Review workspace's pure renderings: the preview's page, Focus's title-bar controls, the
   inspector's panel bodies and Share's screens. The App owns every piece of state and passes
   values and callbacks; nothing here reads the session or writes history. `parts` carries the
   project components these compose (`OfficeViewer`, `ArtifactLinks`, `FileGroups`). */
export function createReviewPaneUI(React, DS, parts) {
  const { Button, IconButton, Eyebrow, SkeletonLines, SurfaceState, CodeBlock, FieldGrid, Toolbar, StatusPill, Avatar,
    PanelSection, Select, Tabs, ChoiceGroup, Input, Alert } = DS;
  const { OfficeViewer, ArtifactLinks, FileGroups } = parts;
  const data = 'var(--font-data, Source Code Pro, ui-monospace, monospace)';
  /* The App's `btn`: a small Button unless the caller sizes it. */
  const btn = (props, label) => <Button size="sm" {...props}>{label}</Button>;

  /* The placeholder page an artifact fixture stands for: eyebrow, title and lead, then a sketched
     body of copy beside a panel, then the closing sentence. The preview draws it large or small;
     the activity feed draws it as a conversation's thumbnail. */
  function PageSketch({ artifact: a, big: large, heading, close }) {
    const big = !!large;
    /* The sketched page's copy and heading depict the artifact's own page: the copy keeps to the
       token scale, the 34/26px display heading is the depicted page's, not product chrome. */
    const copy = { fontSize: big ? 'var(--font-size-md, 16px)' : 'var(--font-size-sm, 14px)', lineHeight: big ? 1.65 : 1.6, color: 'var(--text-emphasis, #374151)', maxWidth: big ? '66ch' : '62ch', textWrap: 'pretty' };
    const gap = big ? 10 : 8;
    const Heading = heading || 'h2';
    return <>
      <Eyebrow>{a.eyebrow}</Eyebrow>
      <Heading style={{ fontFamily: 'var(--font-heading, "Source Serif 4", Georgia, serif)', fontWeight: 600, fontSize: big ? 34 : 26 /* type-scale: document */, marginTop: big ? 10 : 8, lineHeight: 1.25, textWrap: 'pretty' }}>{a.title}</Heading>
      <p style={{ ...copy, margin: (big ? 18 : 14) + 'px 0 0' }}>{a.lead}</p>
      <div style={{ marginTop: big ? 24 : 20, display: 'flex', flexWrap: 'wrap', gap: big ? 16 : 14, border: '1px solid var(--border-color, #DEE2E6)', borderRadius: 5, padding: big ? 16 : 14 }}>
        <SkeletonLines height={big ? 11 : 10} gap={gap} style={{ flex: big ? '1 1 240px' : '1 1 220px' }} />
        <div style={{ flex: big ? '1 1 170px' : '1 1 150px', minWidth: 0, display: 'flex', flexDirection: 'column', gap, padding: big ? 14 : 12, background: 'var(--surface-secondary, #F8F9FA)', borderRadius: 5 }}>
          <Eyebrow size="label">{a.panel}</Eyebrow>
          <SkeletonLines lines={['88%', '70%']} height={big ? 11 : 10} gap={gap} />
        </div>
      </div>
      {close ? <p style={{ ...copy, margin: (big ? 22 : 18) + 'px 0 0' }}>{close}</p> : null}
    </>;
  }

  /* The shown page inside the preview (or, `big`, the raw view's sheet): an unavailable or
     missing path, plain text, a non-HTML asset, the generated catalog, an Office page in its
     family's viewer (with the host's pins as `overlay`), another page, or the default page's
     sketch. Every branch marks its root with `data-artifact-page`. */
  function PreviewPage({ big = false, overlay, path, page, file, error, snapshot, pages, officeItem, artifact, closeLine, onSelectPage, officePart, onOfficePartChange }) {
    if (error || !file) return <div data-artifact-page={path} style={{ padding: 24 }}>
      <SurfaceState phase="ready" count={0} noun="pages" emptyTitle="Page unavailable" titleLevel={2}
        emptyBody={error || 'This path is not included in the selected version.'}
        actionLabel="Open default page" onAction={() => onSelectPage(snapshot.manifest.entryPath)} />
    </div>;
    if (page?.unavailable) return <div data-artifact-page={path} style={{ padding: 24 }}>
      <SurfaceState phase="failed" failedTitle="Preview unavailable" titleLevel={2}
        failedBody="This local fixture represents a page with an unavailable external dependency." />
      <p>{'Preview unavailable: external dependency missing. Choose another page.'}</p>
    </div>;
    /* Guides and other text files render as plain text, never as markup. */
    if (!page && file.mediaType.split(';')[0].trim().toLowerCase().startsWith('text/')) {
      return file.size > maximumTextPreviewBytes
        ? <div data-artifact-page={path} style={{ padding: 24 }}>
          <SurfaceState phase="failed" failedTitle="Text too large" titleLevel={2}
            failedBody="Review shows text files up to 1 MiB. Open the version without review controls to read this file." />
        </div>
        : <CodeBlock data-artifact-page={path} label={'Text of ' + path} tabIndex={0}
          style={{ margin: 0, minHeight: 240, padding: '16px 20px' }}>{fixtureText(snapshot.manifest, path)}</CodeBlock>;
    }
    if (!page) return <div data-artifact-page={path} style={{ padding: 24 }}>
      <h2>{'File preview'}</h2><p>{path}</p><p>{file.mediaType + ' · ' + file.size + ' bytes'}</p>
      <p>{'This asset is included in the immutable manifest. It is not an HTML page.'}</p>
    </div>;
    if (path === catalogPath) return <div data-artifact-page={path} style={{ padding: 24 }}>
      <h2>{'Overview'}</h2><p>{pages.length + ' pages · local example catalog'}</p>
      <p>{'Open a page to review it directly. The catalog is an Interactive preview.'}</p>
      {pages.filter((item) => item.path !== catalogPath).slice(0, 8).map((item) => btn({ key: item.path, variant: 'link', onClick: () => onSelectPage(item.path) }, item.name))}
    </div>;
    /* A Branding Center or report page is a Word, Excel or PowerPoint page: its family's viewer
       draws it, keeping its own page, sheet or slide. */
    if (officeItem) {
      const doc = officeDocument(snapshot.manifest, path) || {};
      // The viewer fills the canvas and scrolls its paper; the host's pins ride on the paper.
      return <div data-artifact-page={path} style={{ flex: '1 1 auto', minHeight: big ? 640 : 0, display: 'flex', flexDirection: 'column' }}>
        <OfficeViewer key={snapshot.version.id + ':' + path} kind={officeItem.kind} title={doc.title || officeItem.title} name={officeItem.title}
          category={doc.category || officeItem.section} layout={doc.id ? doc.id.replace(/^powerpoint-/, '') : undefined} format={doc.format}
          overlay={overlay && overlay.some(Boolean) ? overlay : null} part={officePart} onPartChange={onOfficePartChange} />
      </div>;
    }
    if (path !== 'index.html') return <div data-artifact-page={path} style={{ padding: '26px 30px 32px' }}>
      <Eyebrow>{page.group}</Eyebrow><h2 style={{ fontSize: 'var(--font-size-xl, 24px)' }}>{page.name}</h2>
      <p style={{ fontFamily: data, fontSize: 'var(--font-size-xs, 12px)', overflowWrap: 'anywhere' }}>{path}</p>
      <p style={{ fontSize: 'var(--font-size-sm, 14px)', lineHeight: 1.5 }}>{page.description || 'A page from ' + artifact.name + '. Review it in the same workspace.'}</p>
      <FieldGrid fields={[{ label: 'Version', value: snapshot.version.id, mono: true },
        { label: 'Default page', value: snapshot.manifest.entryPath, mono: true }]} columns={1} />
    </div>;
    return <div data-artifact-page={path} style={big ? null : { padding: '26px 30px 32px' }}>
      <PageSketch artifact={artifact} big={big} heading={big ? 'h1' : 'h2'} close={closeLine} />
    </div>;
  }

  /* ---- Focus: the preview keeps a slim navy title bar. The page (or the gallery), the version,
     then the controls in the server's order — Back to gallery, Comments, Share, Open raw, Exit
     full screen and Hide. Hidden, they fold to one restore button. */
  /* A borderless navy control in the full-screen preview's title bar. */
  const FOCUS_BUTTON = { background: 'transparent', height: 20 };
  const navyIcon = (key, props) => <IconButton key={key} size="xs" variant="navy" style={FOCUS_BUTTON} {...props} />;
  function FocusTitle({ title, version }) {
    return <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
      <span style={{ flex: 'none', color: 'var(--text-on-navy-secondary, rgba(255,255,255,.72))', fontFamily: data }}>{'v' + version}</span>
    </span>;
  }
  function FocusControls({ hidden, returnable, unresolvedCount, commentsOpen, share, onShowControls, onBackToGallery, onToggleComments,
    onOpenRaw, onExit, onHideControls, annotate }) {
    if (hidden) return navyIcon('show', { icon: 'bi-chevron-bar-left', ariaLabel: 'Show viewer controls', keyshortcuts: 'Meta+\\ Control+\\',
      title: 'Show viewer controls (Command/Control + \\)', onClick: onShowControls });
    return <Toolbar label="Artifact viewer controls" variant="navy" gap={4} style={{ background: 'transparent', padding: 0 }}>
      {returnable ? navyIcon('gallery', { icon: 'bi-arrow-left', ariaLabel: 'Back to gallery', title: 'Back to gallery', onClick: onBackToGallery }) : null}
      {annotate ? navyIcon('annotate', { icon: 'bi-pencil-square', pressed: !!annotate.active, ariaLabel: annotateToggleLabel(annotate.canComment, annotate.active),
        title: annotateToggleLabel(annotate.canComment, annotate.active), onClick: annotate.onToggle }) : null}
      {unresolvedCount == null ? null : navyIcon('comments', { icon: 'bi-chat-square-text', ariaLabel: 'Comments', count: unresolvedCount, countLabel: unresolvedCount + ' open threads',
        expanded: !!commentsOpen, 'aria-controls': commentsOpen ? 'review-focus-comments' : undefined,
        keyshortcuts: ']', title: 'Toggle comments (])', onClick: onToggleComments })}
      <span key="share" style={{ display: 'inline-flex' }}>{share}</span>
      {navyIcon('raw', { icon: 'bi-box-arrow-up-right', ariaLabel: 'Open raw in a new window', title: 'Open raw', onClick: onOpenRaw })}
      {/* Exit is the one pressed control: two arrows pointing inward. */}
      <Button key="exit" variant="navy" size="xs" pressed aria-label="Exit full screen" aria-keyshortcuts="F"
        title="Exit full screen (F)" onClick={onExit} style={{ height: 20, padding: 0, width: 24 }}>
        <span aria-hidden="true" style={{ display: 'inline-flex', fontSize: 'var(--icon-xs, 0.75rem)', transform: 'rotate(-45deg) scale(0.65)' }}>
          <i className="bi bi-arrow-right" data-icon-state="active" />
          <i className="bi bi-arrow-left" data-icon-state="active" />
        </span>
      </Button>
      {navyIcon('hide', { icon: 'bi-chevron-bar-right', ariaLabel: 'Hide viewer controls', onClick: onHideControls })}
    </Toolbar>;
  }

  /* ---- Inspector panels ---- */
  /* Comments: the header's agent toggle reveals who is connected and Send all open. */
  const PRESENCE = { Replying: 'working', Idle: 'ready', Disconnected: 'offline' };
  function AgentControls({ open, agents, archived, unresolvedCount, onSendAll }) {
    return <div id="review-agent-controls" hidden={!open}
      style={{ display: open ? 'flex' : 'none', flexDirection: 'column', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--list-divider, #E9ECEF)' }}>
      <section aria-label="Agents" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <strong style={{ fontSize: 'var(--font-size-dense, 13px)', color: 'var(--text-strong, #111827)' }}>{'Agents'}</strong>
          <span style={{ fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5A6268)' }}>
            {agents.map((a) => a.name + ' ' + a.state.toLowerCase()).join(' · ')}</span>
        </div>
        <div role="group" aria-label="Agent presence" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {agents.map((a) => <Avatar key={a.name} name={a.name} initials={a.initials} size={24} status={PRESENCE[a.state] || 'offline'} statusLabel={a.state} />)}
        </div>
      </section>
      {archived ? null : <div style={{ display: 'flex', flexWrap: 'wrap', minWidth: 0 }}>
        {btn({ variant: 'primary', size: 'xs', icon: 'bi-stars', disabled: unresolvedCount === 0, onClick: onSendAll }, 'Send all open (' + unresolvedCount + ')…')}
      </div>}
    </div>;
  }

  /* Details: one scrolling column of sections, each under an 11px heading and separated by a
     full-width rule; two-column label and value rows. */
  function DetailsPanel({ artifact, snapshot, viewVersion, current, historical, published, archived, galleryItem, access, accessOptions,
    onAccessChange, onChangeDefault, onSelectPage, onCopyLink, reviewUrl, latestUrl, onDelete, name, can = {}, provenance }) {
    const section = (title, body, first) => <PanelSection key={title} title={title} divided={!first}>{body}</PanelSection>;
    const rows = (fields) => <FieldGrid layout="inline" labelWidth={104} fields={fields} />;
    const allowed = (key) => can[key] !== false;
    return <div>
      {name ? section('Artifact', <NameEditor {...name} disabled={archived || !allowed('rename')} />, true) : null}
      {section('This Version', rows([
        { label: 'Version', value: <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: data, fontWeight: 600, color: 'var(--text-data, #495057)' }}>{'v' + viewVersion}</span>
          <StatusPill tone={historical ? 'neutral' : 'primary'} label={historical ? 'Preview' : 'Current'} />
        </span>,
        note: historical ? 'Version ' + current + ' is current.' : undefined },
        { label: 'Published', value: <>{published.by}{' · '}<span style={{ fontFamily: data, color: 'var(--text-data, #495057)' }}>{published.when}</span></> },
        { label: 'Default Page', value: <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: data, color: 'var(--text-data, #495057)', overflowWrap: 'anywhere' }}>{snapshot.manifest.entryPath}</span>
          {allowed('publish') ? btn({ variant: 'link', size: 'xs', 'aria-label': 'Change the default page', onClick: onChangeDefault, disabled: archived }, 'Change') : null}
        </span>,
        note: allowed('publish') ? 'Changing it publishes a new version.' : undefined },
      ]), !name)}
      {/* A gallery page says what the producer declared about it, and the files that travel with it. */}
      {galleryItem ? section('This Page', rows([
        { label: 'Kind', value: galleryKind(galleryItem.kind).singular },
        { label: 'Section', value: galleryItem.section },
        { label: 'Viewport', value: galleryItem.viewport.width + ' × ' + galleryItem.viewport.height, mono: true },
        galleryItem.related.length ? { label: 'Related', value: <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {galleryItem.related.map((link) => btn({ key: link.path, variant: 'link', size: 'xs', flush: true, style: { alignSelf: 'flex-start' },
            onClick: () => onSelectPage(link.path) }, link.title))}
        </span>, note: 'Also listed in Files.' } : null,
      ].filter(Boolean))) : null}
      {section('Access', <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {/* An archived project may make an artifact private, never public (only narrowing is allowed). */}
        <Select aria-label="Who can open this artifact" options={accessOptions} value={access} onChange={onAccessChange} size="sm"
          disabled={!allowed('share') || (archived && access !== 'Public link')} />
        <div style={{ fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5A6268)' }}>{access === 'Public link'
          ? 'Anyone with the link can open the current version (v' + current + ').'
          : 'Only people who can open this project can open it.'}{access === 'Public link' ? null : ' Share links reach people without an account.'}</div>
      </div>)}
      {section('Links', <ArtifactLinks title="Links" note={null} compact onCopy={onCopyLink} rows={[
        { label: 'Review · v' + viewVersion, url: reviewUrl, description: 'This version and page, with review and comments.' },
        { label: 'Latest', url: latestUrl, description: 'Moves when a new version is published.' },
        { label: 'Raw', url: snapshot.links.version, description: 'This version without review controls.' },
      ]} />)}
      {section('Hosting', rows([
        { label: 'Routing', value: snapshot.manifest.routingMode },
        { label: 'Git Mirror', value: artifact.mirrored ? 'One commit per version' : 'Off' },
      ]))}
      {section('Source', <SourceRecord record={provenance} />)}
      {section('Identifiers', rows([
        { label: 'Artifact', value: artifact.id, mono: true },
        { label: 'Version', value: snapshot.version.id, mono: true },
      ]))}
      {!allowed('remove') ? null : section('Delete Artifact', <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
        <div style={{ fontSize: 'var(--font-size-xs, 12px)', lineHeight: 1.45, color: 'var(--text-secondary, #5A6268)' }}>{archived
          ? 'The project is archived, so its artifacts cannot be deleted.'
          : 'Deletes all ' + artifact.versions + ' versions and their conversations. Its links stop working. This cannot be undone.'}</div>
        {btn({ variant: 'danger', outline: true, icon: 'bi-trash', disabled: archived, onClick: onDelete }, 'Delete Artifact')}
      </div>)}
    </div>;
  }

  /* The artifact's name, editable in place (Artifact Server 10/16/2026): typing starts an edit, Enter
     or Save name saves, Cancel restores; a refused name shows the server's reason and Reload current
     details keeps the draft. */
  function NameEditor({ value, draft, onDraft, onSave, onCancel, error, onReload, disabled }) {
    const dirty = draft !== value;
    return <form style={{ display: 'flex', flexDirection: 'column', gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (dirty && draft.trim() && draft.trim() !== value) onSave(); }}>
      <Input label="Artifact name" size="sm" value={draft} disabled={disabled} onChange={(e) => onDraft(e && e.target ? e.target.value : e)} />
      {dirty ? <div style={{ display: 'flex', gap: 8 }}>
        <Button size="sm" type="submit" disabled={!draft.trim() || draft.trim() === value}>{'Save name'}</Button>
        <Button size="sm" variant="secondary" outline onClick={onCancel}>{'Cancel'}</Button>
      </div> : null}
      {error ? <><Alert variant="danger">{error}</Alert>
        <div>{btn({ variant: 'link', onClick: onReload }, 'Reload current details')}</div></> : null}
    </form>;
  }

  /* Source provenance (Artifact Server 10/06/2026): the producer's record of where this version came
     from, checked against the manifest. */
  function SourceRecord({ record }) {
    const empty = provenanceNote(record);
    const subtle = { fontSize: 'var(--font-size-xs, 12px)', lineHeight: 1.45, color: 'var(--text-secondary, #5A6268)', margin: 0 };
    if (empty) return <p style={subtle}>{empty}</p>;
    const mismatch = record.status === 'mismatch';
    return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <FieldGrid layout="inline" labelWidth={104} fields={[
        { label: 'Check', value: <StatusPill tone={mismatch ? 'danger' : 'success'} label={mismatch ? 'Mismatch \u00b7 ' + record.mismatches.length : 'Verified'} /> },
        { label: 'Repository', value: record.repository, mono: true },
        { label: 'Authored commit', value: record.commit, mono: true, note: record.dirty ? 'Built from uncommitted changes.' : undefined },
        { label: 'Manifest', value: record.digest, mono: true },
        { label: 'Coverage', value: record.declared + ' of ' + record.files + ' files declared \u00b7 dependency edges ' + record.edges },
      ]} />
      {mismatch ? <p style={subtle}>{'Differs from the record: ' + record.mismatches.slice(0, 5).join(', ')}</p> : null}
    </div>;
  }

  /* Files: Tabs for the file tree and the page URLs. */
  function FilesPanel({ view, onViewChange, files, pages, snapshot, viewVersion, selectedPath, onSelectPage, onCopy }) {
    return <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '4px 12px 0', borderBottom: '1px solid var(--border-color, #DEE2E6)' }}>
        <Tabs tabs={[{ id: 'Files', label: 'Files', count: files.length }, { id: 'Page URLs', label: 'Page URLs', count: pages.length }]}
          active={view} onChange={onViewChange} aria-label="File inventory view" />
      </div>
      {view === 'Page URLs'
        ? <div style={{ padding: '10px 12px' }}><ArtifactLinks title="Page URLs" rows={pages.map((page) => ({ label: page.name, path: page.path,
          url: exactPageUrl(snapshot, page.path), description: page.isDefault ? 'Default page' : undefined }))}
          onCopy={onCopy} copyAll="Copy all page URLs" /></div>
        : <div style={{ padding: '6px 0' }}><FileGroups label={'Files in version ' + viewVersion} selected={selectedPath}
          files={files.map((file) => ({ name: file.path, size: fmt.bytes(file.size),
            role: file.path === snapshot.manifest.entryPath ? 'Default page' : undefined,
            onSelect: () => onSelectPage(file.path) }))} /></div>}
    </div>;
  }
  /* The Files panel's foot names the selected path and its size. */
  function FilesFooter({ path, file }) {
    return <div role="group" aria-label="Selected file" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, fontSize: 'var(--font-size-xs, 12px)' }}>
      <span style={{ color: 'var(--text-secondary, #5A6268)' }}>{'Selected'}</span>
      <code title={path} style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontFamily: data, color: 'var(--text-data, #495057)' }}>{path}</code>
      {file ? <span style={{ flex: 'none', color: 'var(--text-secondary, #5A6268)', fontFamily: data }}>{fmt.bytes(file.size)}</span> : null}
    </div>;
  }

  /* ---- Share: one link, chosen by what it opens, the access it carries, the members row and one
     prompt that hands the review to an agent. Invite People, Invite Link Ready and Connect MCP
     are back-headed screens inside the same popover. The host supplies its copy buttons. */
  const subtle = { fontSize: 'var(--font-size-xs, 12px)', lineHeight: 1.4, margin: 0, color: 'var(--text-secondary, #5A6268)' };
  const strongLine = { fontSize: 'var(--font-size-dense, 13px)', fontWeight: 600, color: 'var(--text-strong, #111827)' };
  function ShareHeader({ title, subtitle, onBack, onClose }) {
    return <header style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
      <IconButton icon="bi-chevron-left" size="sm" ariaLabel="Back to Share" onClick={onBack} />
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <h2 style={{ fontSize: 'var(--font-size-md, 16px)', margin: 0, overflowWrap: 'anywhere' }}>{title}</h2>
        <p style={subtle}>{subtitle}</p>
      </div>
      <IconButton icon="bi-x-lg" size="sm" ariaLabel="Close Share" onClick={onClose} />
    </header>;
  }
  function ShareOverview({ target, onTargetChange, viewVersion, url, copyLink, access, onManageAccess, members, onInvite, copyPrompt, onConnect, onWhy, accessBands, notice }) {
    return <>
      {notice ? <div style={{ padding: '12px 16px 0' }}><Alert variant="neutral" density="compact">{notice}</Alert></div> : null}
      <PanelSection title="Link Opens" headingLevel={2} divided={false} gap={12}>
        <ChoiceGroup label="Link opens" value={target} minColumnWidth={150} onChange={onTargetChange}
          options={[
            { id: 'version', title: 'This version · v' + viewVersion, description: 'Exact version, with review and comments' },
            { id: 'latest', title: 'Latest', description: 'Moves when a new version is published' },
          ]} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Input aria-label="Link" readOnly mono size="sm" icon="bi-link-45deg" title={url}
            value={url.replace(/^https:\/\//, '')} style={{ flex: '1 1 auto', minWidth: 0 }} />
          {copyLink}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 'var(--font-size-dense, 13px)', lineHeight: 1.45, color: 'var(--text-secondary, #5A6268)' }}>
          <i className="bi bi-people" aria-hidden="true" style={{ marginTop: 2 }} />
          <span style={{ flex: '1 1 auto' }}>{access === 'Public link'
            ? 'Anyone with the latest link can open it. People who can open this project can review it.'
            : 'People who can open this project can review it.'}</span>
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flex: 'none' }}>
            {btn({ variant: 'link', size: 'xs', onClick: onManageAccess }, 'Manage Access')}
            {onWhy ? btn({ variant: 'link', size: 'xs', onClick: onWhy }, 'Why can they?') : null}
          </span>
        </div>
      </PanelSection>
      {accessBands}
      {members == null ? null : <PanelSection gap={8} padding="12px 16px">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <i className="bi bi-people" aria-hidden="true" />
          <span style={{ display: 'flex', flex: '1 1 auto', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <span style={strongLine}>{fmt.plural(members, 'member')}</span>
            <span style={subtle}>{'Invite someone with a link they redeem by signing in.'}</span>
          </span>
          {btn({ variant: 'primary', outline: true, icon: 'bi-person-plus', onClick: onInvite }, 'Invite')}
        </div>
      </PanelSection>}
      <PanelSection tone="band" padding="12px 16px 16px">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={strongLine}>{'Review with an AI agent'}</span>
          <span style={subtle}>{'One complete prompt for Claude, Codex, Cursor, GitHub Copilot, Pi or OpenCode.'}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          {copyPrompt}
          {btn({ variant: 'link', iconRight: 'bi-chevron-right', onClick: onConnect }, 'Connect MCP')}
        </div>
      </PanelSection>
    </>;
  }
  /* Connect MCP: the three ways an agent reaches this server; the host supplies the command wells. */
  function ShareConnect({ localWell, remoteWell }) {
    return <>
      <p style={subtle}>{'Choose the connection that matches where Artifact Server is running.'}</p>
      {[
        ['On this computer', 'Recommended for local use', 'Detect a supported client, install its private MCP connection, and verify it without copying a token.', localWell],
        ['Team or remote server', 'MCP', 'Add this server address to the agent. Compatible deployments open browser sign-in; other self-hosted deployments use an administrator-issued scoped key.', remoteWell],
        ['Without MCP', 'HTTP API', 'The review prompt includes an exact authenticated API request for this version. Use a scoped API key from an administrator and never paste it into chat.', null],
      ].map(([title, tag, body, well]) => <section key={title} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <strong style={{ fontSize: 'var(--font-size-dense, 13px)' }}>{title}</strong><span style={subtle}>{tag}</span>
        </div>
        <p style={subtle}>{body}</p>{well}
      </section>)}
    </>;
  }

  return { PageSketch, PreviewPage, FocusTitle, FocusControls, AgentControls, DetailsPanel, NameEditor, SourceRecord, FilesPanel, FilesFooter, ShareHeader, ShareOverview, ShareConnect };
}
