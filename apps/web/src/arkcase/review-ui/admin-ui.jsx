/* Administration's pure renderings, inside the App's AdminConsole: the list panel each area uses,
   the DataGrids of members, invites, API keys and public links with their row menus, the docked
   SlideOvers for a selected member or key, and the MCP & WebMCP area. The App owns the session
   records, the confirmations and the forms; these take records, status readers and callbacks. */
export function createAdminUI(React, DS) {
  const { Button, IconButton, Tooltip, RecordPanel, DataGrid, StatusPill, SlideOver, FieldGrid, Tag, SurfaceState, Switch } = DS;
  const data = 'var(--font-data, Source Code Pro, ui-monospace, monospace)';
  const pill = (status) => <StatusPill tone={status === 'Active' ? 'success' : status === 'Expired' ? 'warning' : 'neutral'} label={status} />;
  const grid = { quickFilter: true, selectable: false, statusBar: false };

  /* A list panel: the area's records under a heading, with an optional round add button. */
  function AdminListPanel({ label, subtitle, add, children }) {
    return <RecordPanel label={label} subtitle={subtitle} capAlign="center" metaWrap
      actions={add ? <Tooltip label={add.label} placement="bottom">
        <IconButton icon="bi-plus-lg" variant="primary" size="sm" shape="circle" ariaLabel={add.label} onClick={add.onClick} />
      </Tooltip> : null}>{children}</RecordPanel>;
  }

  /* `projectsOf` (optional) summarizes the projects a member can open, e.g. "All · administrator" or "3 of 5". */
  function MembersGrid({ members, statusOf, onSelect, onDeactivate, projectsOf }) {
    return <DataGrid ariaLabel="Members" {...grid}
      columns={[
        { field: 'name', headerName: 'Member', width: 200, onCellClick: (row) => onSelect(row.id) },
        { field: 'email', headerName: 'Email', type: 'contact', width: 260 },
        { field: 'role', headerName: 'Role', width: 140 },
        ...(projectsOf ? [{ field: 'projects', headerName: 'Projects', width: 170 }] : []),
        { field: 'status', headerName: 'Status', width: 120, cellRenderer: pill },
        { field: 'lastActive', headerName: 'Last active', width: 130, dataFont: true },
      ]}
      rows={members.map((m) => ({ id: m.email, name: m.name, email: m.email, role: m.role, projects: projectsOf ? projectsOf(m) : undefined,
        status: statusOf(m), lastActive: m.lastActive || '—', member: m }))}
      rowActions={(row) => row.status === 'Active' ? [{ label: 'Deactivate', icon: 'bi-x-circle', danger: true, onClick: () => onDeactivate(row.member) }] : null}
      rowActionsLabel={(row) => 'Actions for ' + row.name} />;
  }
  /* `grants` and `explainer` (optional) are the host's grant list and "Why can they?" for this member. */
  function MemberInspector({ member, status, onClose, onDeactivate, grants, explainer }) {
    const heading = (text) => <h3 style={{ margin: 0, fontSize: 'var(--font-size-label, 11px)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text-secondary, #5A6268)' }}>{text}</h3>;
    return <SlideOver title={member.name} subtitle={member.email} titleMeta={pill(status)} width={360} onClose={onClose}
      footer={status === 'Active' ? <Button size="sm" variant="danger" outline icon="bi-x-circle" onClick={onDeactivate}>{'Deactivate'}</Button> : null}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <FieldGrid columns={1} fields={[
          { label: 'Role', value: member.role }, { label: 'Admitted', value: member.admitted, mono: true },
          { label: 'Admitted by', value: member.admittedBy }, { label: 'Last active', value: member.lastActive, mono: true },
        ]} />
        {grants ? <section aria-label="Project access" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{heading('Project access')}{grants}</section> : null}
        {explainer ? <section aria-label="Why can they?" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{heading('Why can they?')}{explainer}</section> : null}
      </div>
    </SlideOver>;
  }

  /* Invites: status is derived by the host — revoked, used up, expired, or active. */
  const INVITE_TONES = { Active: 'success', Expired: 'neutral', Revoked: 'danger', Used: 'primary' };
  function InvitesGrid({ invites, statusOf, onRevoke }) {
    return <DataGrid ariaLabel="Invites" {...grid}
      columns={[
        { field: 'label', headerName: 'Invite', width: 260 },
        { field: 'role', headerName: 'Role', width: 140 },
        { field: 'createdBy', headerName: 'Created by', width: 180 },
        { field: 'uses', headerName: 'Uses', type: 'count', width: 110 },
        { field: 'expires', headerName: 'Expires', type: 'date', width: 130 },
        { field: 'status', headerName: 'Status', width: 120, cellRenderer: (v) => <StatusPill tone={INVITE_TONES[v]} label={v} /> },
      ]}
      rows={invites.map((i) => ({ id: i.id, label: i.email || 'Anyone with the link', role: i.role, createdBy: i.createdBy,
        uses: i.useCount + ' of ' + i.maxUses, expires: i.expires, status: statusOf(i), invite: i }))}
      rowActions={(row) => row.status === 'Active' ? [{ label: 'Revoke', icon: 'bi-x-circle', danger: true, onClick: () => onRevoke(row.invite) }] : null}
      rowActionsLabel={(row) => 'Actions for ' + row.label} />;
  }

  function KeysGrid({ keys, statusOf, onSelect, onRevoke }) {
    return <DataGrid ariaLabel="API keys" {...grid}
      columns={[
        { field: 'name', headerName: 'Key', width: 240, onCellClick: (row) => onSelect(row.id) },
        { field: 'owner', headerName: 'Owner', width: 170 },
        { field: 'caps', headerName: 'Capabilities', type: 'count', width: 120 },
        { field: 'lastUsed', headerName: 'Last used', width: 120, dataFont: true },
        { field: 'expires', headerName: 'Expires', width: 120, dataFont: true },
        { field: 'status', headerName: 'Status', width: 110, cellRenderer: pill },
      ]}
      rows={keys.map((k) => ({ id: k.id, name: k.name, owner: k.owner, caps: k.capabilities.length, lastUsed: k.lastUsed || '—', expires: k.expires, status: statusOf(k), key: k }))}
      rowActions={(row) => row.status === 'Active' ? [{ label: 'Revoke', icon: 'bi-x-circle', danger: true, onClick: () => onRevoke(row.key) }] : null}
      rowActionsLabel={(row) => 'Actions for ' + row.name} />;
  }
  /* `capabilityLabels` maps a capability value to its label; unknown values print as they are. */
  function KeyInspector({ apiKey, status, capabilityLabels, onClose, onRevoke }) {
    return <SlideOver title={apiKey.name} subtitle={apiKey.owner} titleMeta={pill(status)} width={360} onClose={onClose}
      footer={status === 'Active' ? <Button size="sm" variant="danger" outline icon="bi-x-circle" onClick={onRevoke}>{'Revoke'}</Button> : null}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <FieldGrid columns={1} fields={[
          { label: 'Created', value: apiKey.created, mono: true }, { label: 'Last used', value: apiKey.lastUsed, mono: true },
          { label: 'Expires', value: apiKey.expires, mono: true },
        ]} />
        <div role="list" aria-label="Capabilities" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {apiKey.capabilities.map((c) => <span role="listitem" key={c}><Tag>{capabilityLabels[c] || c}</Tag></span>)}
        </div>
      </div>
    </SlideOver>;
  }

  /* Public links: `versionOf` and `urlOf` read the host's records; `renderCopy` is its copy button. */
  function PublicLinksGrid({ artifacts, versionOf, urlOf, renderCopy, onOpen, onMakePrivate }) {
    return <DataGrid ariaLabel="Public links" {...grid}
      empty={<SurfaceState phase="ready" count={0} noun="public links" density="inline" emptyIcon="bi-lock"
        emptyTitle="No public links" emptyBody="No active artifact in this installation currently allows public-link access." />}
      columns={[
        { field: 'name', headerName: 'Artifact', width: 220, onCellClick: (row) => onOpen(row) },
        { field: 'project', headerName: 'Project', width: 200 },
        { field: 'access', headerName: 'Access', width: 200 },
        { field: 'version', headerName: 'Version', width: 90, dataFont: true },
        { field: 'url', headerName: 'Link', width: 360, cellRenderer: (url, row) => <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ fontFamily: data, fontSize: 'var(--font-size-xs, 12px)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{url}</span>
          {renderCopy(url, row)}
        </span> },
      ]}
      rows={artifacts.map((a) => ({ id: a.id, name: a.name, project: a.projectName, access: 'Public link \u00b7 current version', version: 'v' + versionOf(a), url: urlOf(a), artifact: a }))}
      rowActions={(row) => [{ label: 'Make private', icon: 'bi-lock', danger: true, onClick: () => onMakePrivate(row.artifact) }]}
      rowActionsLabel={(row) => 'Actions for ' + row.name} />;
  }

  /* MCP & WebMCP: the local and remote connections (the host's command wells), the tool groups
     (the host's ledger) and the browser-provided review tools. */
  function McpArea({ connectWell, remoteWell, clients, toolLedger, webmcpTools }) {
    const note = (text) => <p style={{ margin: 0, fontSize: 'var(--font-size-dense, 13px)', lineHeight: 1.5, color: 'var(--text-secondary, #5A6268)', textWrap: 'pretty' }}>{text}</p>;
    const tags = (list) => <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{list.map((t) => <Tag key={t}>{t}</Tag>)}</div>;
    return <>
      <RecordPanel key="local" label="Local installation" subtitle="server and client on one computer" padded>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {connectWell}
          {note('Detects Codex, Claude Code, Cursor or VS Code, updates the client configuration and verifies the connection.')}
          {tags(clients)}
        </div>
      </RecordPanel>
      <RecordPanel key="remote" label="Remote server" subtitle="one endpoint, browser sign-in" padded>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {remoteWell}
          {note('Add this address in the client’s MCP settings. The client opens the configured identity provider when it connects.')}
        </div>
      </RecordPanel>
      <RecordPanel key="tools" label="Tool groups" subtitle="26 tools, one endpoint">{toolLedger}</RecordPanel>
      <RecordPanel key="webmcp" label="WebMCP" subtitle="browser-provided review tools" padded>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Switch label="Let an agent running in this browser operate Review" defaultChecked />
          {tags(webmcpTools)}
        </div>
      </RecordPanel>
    </>;
  }

  return { AdminListPanel, MembersGrid, MemberInspector, InvitesGrid, KeysGrid, KeyInspector, PublicLinksGrid, McpArea };
}
