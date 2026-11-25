import { PERMISSIONS, GUEST_PERMISSIONS, ROLES, permissionLabel, roleLabel, SHARE_PRESETS, expiryOptions } from './access-model.js';

/* The permissions model's screens (Artifact Server 10/26/2026, its permissions spec's "Interface
   components"): Settings → Access policy, Project → Access, the permission override checklist, the
   "Why can they?" explainer, Share's People and Links screens with the Create link form, the
   installation's Share links grid, and the guest's banner, name form, ended link page and badge.
   Pure renderings: the App owns every record, draft and callback. */
export function createAccessUI(React, DS) {
  const { Button, IconButton, Select, Switch, Checkbox, Input, ChoiceGroup, Alert, RecordPanel, StatusPill, DataGrid, SurfaceState,
    PanelSection, Tag } = DS;
  const data = 'var(--font-data, Source Code Pro, ui-monospace, monospace)';
  const note = { margin: 0, fontSize: 'var(--font-size-xs, 12px)', lineHeight: 1.45, color: 'var(--text-secondary, #5A6268)', textWrap: 'pretty' };
  const strong = { fontSize: 'var(--font-size-dense, 13px)', fontWeight: 600, color: 'var(--text-strong, #111827)' };
  const stack = (gap) => ({ display: 'flex', flexDirection: 'column', gap });
  const valueOf = (e) => (e && e.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e);
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const MODE_OPTIONS = [{ value: 'open', label: 'Open to all members' }, { value: 'restricted', label: 'Restricted to people listed' }];
  /* `ceiling`: on an archived project only narrowing saves, so roles above it stay listed but disabled. */
  const roleOptions = (from = 0, ceiling = null) => ROLES.slice(from).map((r) => ({ value: r, label: roleLabel(r),
    disabled: ceiling != null && ROLES.indexOf(r) > ROLES.indexOf(ceiling) }));
  const NARROW_HELP = 'An archived project can only lower roles.';

  /* ---- Guest marks ---- */
  /** "Guest" beside a guest author, with the link they came through; never a guest name without it. */
  function GuestBadge({ linkLabel, ended }) {
    return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5A6268)' }}>
      <Tag mono={false} title="Written through a share link by someone without an account">{'Guest'}</Tag>
      {linkLabel ? <span>{'via '}<em style={{ fontStyle: 'normal', fontWeight: 600 }}>{linkLabel}</em>{ended ? ' (link ended)' : ''}</span> : null}
    </span>;
  }

  /** The guest shell's banner: who shared the link and when it ends, the artifact and version, and the preview's platform and theme. */
  function GuestHeader({ creator, expires, artifactName, version, controls }) {
    return <header data-guest-banner="" style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px 16px',
      padding: '8px 16px', background: 'var(--surface-card, #fff)', borderBottom: '1px solid var(--border-color, #DEE2E6)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
        <i className="bi bi-person" aria-hidden="true" style={{ color: 'var(--text-secondary, #5A6268)' }} />
        <span role="status" style={{ fontSize: 'var(--font-size-dense, 13px)', color: 'var(--text-body, #212529)' }}>
          {'Viewing as a guest via a link shared by '}<strong>{creator}</strong>{expires ? ' · Expires ' + expires : ''}</span>
        <span aria-hidden="true" style={{ color: 'var(--border-color-strong, #CED4DA)' }}>{'|'}</span>
        <h1 style={{ margin: 0, fontSize: 'var(--font-size-md, 16px)' }}>{artifactName}</h1>
        <span style={{ ...note, fontFamily: data }}>{'Version ' + version}</span>
      </div>
      <div role="group" aria-label="Preview controls" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{controls}</div>
    </header>;
  }

  /** One readable page for every ended, revoked, rotated, turned-off or unknown link; it never tells them apart. */
  function EndedLink() {
    return <main data-screen-label="Ended link" style={{ minHeight: '100%', display: 'grid', placeItems: 'center', padding: 24, background: 'var(--surface-canvas, #F1F5F7)' }}>
      <section style={{ maxWidth: 440, width: '100%', ...stack(12), padding: 28, background: 'var(--surface-card, #fff)', border: '1px solid var(--border-color, #DEE2E6)', borderRadius: 8 }}>
        <i className="bi bi-link-45deg" aria-hidden="true" style={{ fontSize: 'var(--icon-xl, 2rem)', color: 'var(--text-secondary, #5A6268)' }} />
        <h1 style={{ margin: 0, fontSize: 'var(--font-size-xl, 24px)' }}>{'This link has ended'}</h1>
        <p style={{ margin: 0, fontSize: 'var(--font-size-sm, 14px)', lineHeight: 1.55, color: 'var(--text-body, #212529)' }}>
          {'This link has ended or isn’t valid. Ask the person who shared it for a new one.'}</p>
      </section>
    </main>;
  }

  /** The Guest name dialog's fields; the host's Modal carries the title and Continue. */
  function GuestNameForm({ name, email, onName, onEmail, error }) {
    return <div style={stack(12)}>
      <Input label="Your name, shown next to your comments" required size="sm" value={name} autoFocus onChange={(e) => onName(valueOf(e))} />
      <Input label={'Email (optional) — only members of this workspace can see it'} type="email" size="sm" value={email} onChange={(e) => onEmail(valueOf(e))} />
      {error ? <Alert variant="danger">{error}</Alert> : null}
    </div>;
  }

  /* ---- Why can they? ---- */
  /** Pick a person and an action; the sentence names the deciding layer and the chain lists every layer that applied. */
  function WhyCanThey({ people, person, onPerson, permission, onPermission, sentence, chain, label = 'Why can they?' }) {
    return <section aria-label={label} style={stack(10)}>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        {people ? <Select label="Why can" size="sm" value={person} options={people} onChange={(e) => onPerson(valueOf(e))} /> : null}
        <Select label="Action" size="sm" value={permission} options={PERMISSIONS.map((p) => ({ value: p, label: permissionLabel(p) }))} onChange={(e) => onPermission(valueOf(e))} />
      </div>
      <p role="status" style={{ margin: 0, ...strong, lineHeight: 1.5, textWrap: 'pretty' }}>{sentence}</p>
      {chain && chain.length ? <ol aria-label="How access was decided" style={{ margin: 0, padding: 0, listStyle: 'none', ...stack(6) }}>
        {chain.map((c, i) => <li key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 'var(--font-size-xs, 12px)', lineHeight: 1.45, color: 'var(--text-body, #212529)' }}>
          <span style={{ flex: 'none', minWidth: 64, fontFamily: data, color: 'var(--text-data, #495057)' }}>{c.layer}</span><span>{c.text}</span>
        </li>)}
      </ol> : null}
    </section>;
  }

  /* ---- Permission override ---- */
  const STATE_NOTE = { from_role: 'From the role', added: 'Added to the role', removed: 'Removed from the role', off: 'Not granted', blocked_by_policy: 'Blocked by installation policy' };
  /** The eleven permissions as a checklist: each row's state against the role and, when it cannot change, why. */
  function PermissionChecklist({ name, role, rows, onToggle, onSave, onCancel, dirty }) {
    return <div style={stack(10)}>
      <div>
        <h2 style={{ margin: 0, fontSize: 'var(--font-size-md, 16px)' }}>{'Customize ' + name}</h2>
        <p style={note}>{roleLabel(role) + ', with single permissions added or removed.'}</p>
      </div>
      <div role="group" aria-label={'Permissions for ' + name} style={stack(6)}>
        {rows.map((r) => <Checkbox key={r.permission} label={r.label} meta={r.permission}
          checked={r.state === 'from_role' || r.state === 'added'} disabled={!!r.disabledReason}
          description={r.disabledReason && r.state !== 'blocked_by_policy' ? STATE_NOTE[r.state] + ' · ' + r.disabledReason : STATE_NOTE[r.state]}
          onChange={(e) => onToggle(r.permission, valueOf(e))} />)}
      </div>
      <p style={note}>{'You can only grant permissions you hold on this project yourself.'}</p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button size="sm" variant="secondary" outline onClick={onCancel}>{'Cancel'}</Button>
        <Button size="sm" icon="bi-save" disabled={!dirty} onClick={onSave}>{'Save permissions'}</Button>
      </div>
    </div>;
  }

  /* ---- Project → Access ---- */
  /**
   * Access mode and default role, then the people listed with a role picker each (administrators as
   * locked "Manager (administrator)" rows), the add-person combobox and the explainer. `renderCustomize`
   * is the host's override Popover for a row.
   */
  function ProjectAccessPanel({ mode, defaultRole, savedMode, onMode, onDefaultRole, dirty, onSave, rows, onRole, renderCustomize, onRemove,
    candidates, addMember, addRole, onAddMember, onAddRole, onAdd, canManage, canAdd = canManage, notice, narrowFrom = null, explainer }) {
    const open = mode === 'open';
    // Archived: opening a restricted project and raising a role are listed but cannot be chosen.
    const modeOptions = MODE_OPTIONS.map((o) => ({ ...o, disabled: !!narrowFrom && narrowFrom.mode === 'restricted' && o.value === 'open' }));
    return <div style={stack(14)}>
      {notice ? <Alert variant="neutral" density="compact">{notice}</Alert> : null}
      <RecordPanel label="Access" subtitle="Who can open and change this project" padded
        actions={<StatusPill tone="neutral" label={savedMode === 'restricted' ? 'Restricted' : 'Open'} />}>
        <div style={stack(12)}>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            <Select label="Who can open this project" size="sm" value={mode} options={modeOptions} disabled={!canManage} onChange={(e) => onMode(valueOf(e))}
              helper={narrowFrom && narrowFrom.mode === 'restricted' ? 'An archived project cannot be opened to all members.' : undefined} />
            {open ? <Select label="Role for every member" size="sm" value={defaultRole} options={roleOptions(0, narrowFrom && narrowFrom.mode === 'open' ? narrowFrom.defaultRole : null)}
              disabled={!canManage} onChange={(e) => onDefaultRole(valueOf(e))} helper={narrowFrom ? NARROW_HELP : undefined} />
              : <p style={{ ...note, alignSelf: 'end' }}>{'Only the people listed with a role, and administrators, can open this project.'}</p>}
          </div>
          {canManage ? <div><Button size="sm" icon="bi-save" disabled={!dirty} onClick={onSave}>{'Save access'}</Button></div> : null}
        </div>
      </RecordPanel>
      <RecordPanel label="People" subtitle={open ? 'Everyone else has the role for every member' : 'Listed people and administrators'}>
        <ul aria-label="Project members" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {rows.map((r) => <li key={r.id} data-access-row={r.id} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px 12px', padding: '10px 14px', borderTop: '1px solid var(--list-divider, #E9ECEF)' }}>
            <span style={{ flex: '1 1 200px', minWidth: 0, ...stack(1) }}>
              <span style={strong}>{r.name}</span>
              <span style={{ ...note, fontFamily: data, overflowWrap: 'anywhere' }}>{r.email}</span>
            </span>
            <span style={{ flex: '0 1 200px', minWidth: 160 }}>{r.locked
              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-dense, 13px)' }}><i className="bi bi-lock" aria-hidden="true" />{'Manager (administrator)'}</span>
              : <Select aria-label={r.name + '’s role'} size="sm" value={r.role} options={roleOptions(0, narrowFrom ? r.role : null)} disabled={!canManage} onChange={(e) => onRole(r, valueOf(e))} />}</span>
            <span style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, minWidth: 220, justifyContent: 'flex-end' }}>
              {r.overrides ? <Tag mono={false} title="Single permissions added or removed">{r.overrides}</Tag> : null}
              {!r.locked && canManage ? renderCustomize(r) : null}
              {!r.locked && canManage && r.hasGrant ? <Button size="sm" variant="link" onClick={() => onRemove(r)}>{open ? 'Use default' : 'Remove'}</Button> : null}
            </span>
          </li>)}
        </ul>
        {canManage && canAdd ? <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap', padding: '12px 14px', borderTop: '1px solid var(--list-divider, #E9ECEF)' }}>
          <span style={{ flex: '1 1 220px' }}><Select label="Add a person" size="sm" value={addMember} onChange={(e) => onAddMember(valueOf(e))}
            options={[{ value: '', label: candidates.length ? 'Choose an admitted member' : 'Everyone is listed' }].concat(candidates)} /></span>
          <span style={{ flex: '0 1 160px' }}><Select label="Role" size="sm" value={addRole} options={roleOptions(1)} onChange={(e) => onAddRole(valueOf(e))} /></span>
          <Button size="sm" variant="secondary" outline icon="bi-person-plus" disabled={!addMember} onClick={onAdd}>{'Add'}</Button>
        </div> : null}
      </RecordPanel>
      {explainer ? <RecordPanel label="Why can they?" subtitle="Effective access, layer by layer" padded>{explainer}</RecordPanel> : null}
    </div>;
  }

  /* ---- Settings → Access policy ---- */
  const GUEST_ROWS = [['artifact.view', 'Guests may open artifacts'], ['comment.read', 'Guests may read comments'], ['comment.write', 'Guests may write comments']];
  /** The installation's ceilings. While a draft differs, the footer states how many links and grants saving narrows. */
  function AccessPolicyScreen({ draft, saved, onChange, onSave, onDiscard, narrowing, notice }) {
    const set = (patch) => onChange({ ...draft, ...patch });
    const links = draft.shareLinks;
    const ceiling = draft.members.memberCeiling;
    const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
    const narrows = narrowing && (narrowing.grants || narrowing.shareLinks);
    const narrowText = narrowing ? 'Saving narrows ' + plural(narrowing.grants, 'grant') + ' and ' + plural(narrowing.shareLinks, 'share link') + ' immediately.' : '';
    return <div style={stack(14)}>
      <RecordPanel label="Share links" subtitle="What people without an account can do" padded>
        <div style={stack(12)}>
          <Switch label="Allow share links and public links" checked={links.enabled} onChange={(e) => set({ shareLinks: { ...links, enabled: valueOf(e) } })} />
          {saved.shareLinks.enabled && !links.enabled ? <Alert variant="warning" density="compact">{'Turning this off stops every share link and every public link from opening, including links already posted elsewhere, until you turn it back on.'}</Alert> : null}
          <div role="group" aria-label="What guests may do" style={stack(6)}>
            {GUEST_ROWS.map(([p, label]) => <Checkbox key={p} label={label} meta={p} checked={links.guestPermissionsMax.includes(p)} disabled={p === 'artifact.view' || !links.enabled}
              onChange={(e) => {
                const on = valueOf(e);
                let next = on ? links.guestPermissionsMax.concat(p) : links.guestPermissionsMax.filter((x) => x !== p);
                if (p === 'comment.read' && !on) next = next.filter((x) => x !== 'comment.write');
                if (p === 'comment.write' && on && !next.includes('comment.read')) next = next.concat('comment.read');
                set({ shareLinks: { ...links, guestPermissionsMax: GUEST_PERMISSIONS.filter((x) => next.includes(x)) } });
              }} />)}
          </div>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            <Input label="Longest a link may last, in days (empty for no limit)" size="sm" type="number" mono value={links.maxExpiryDays == null ? '' : String(links.maxExpiryDays)}
              onChange={(e) => { const v = String(valueOf(e)).trim(); const n = Number.parseInt(v, 10); set({ shareLinks: { ...links, maxExpiryDays: v === '' || !(n >= 1) ? null : Math.min(n, 3650) } }); }} />
            <Select label="Who can create share links" size="sm" value={links.linkCreators}
              options={[{ value: 'sharers', label: 'Anyone who can share the artifact' }, { value: 'administrators', label: 'Administrators only' }]}
              onChange={(e) => set({ shareLinks: { ...links, linkCreators: valueOf(e) } })} />
          </div>
        </div>
      </RecordPanel>
      <RecordPanel label="Members" subtitle="The most any member can do, whatever their grants" padded>
        <div style={stack(12)}>
          <Switch label="Limit what members can do" checked={!!ceiling} onChange={(e) => set({ members: { memberCeiling: valueOf(e) ? PERMISSIONS.slice() : null } })} />
          {!ceiling ? <p style={note}>{'Members can hold any permission their project role and grants give them.'}</p>
            : <div role="group" aria-label="What members may do" style={{ display: 'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
              {PERMISSIONS.map((p) => <Checkbox key={p} label={permissionLabel(p)} meta={p} checked={ceiling.includes(p)}
                onChange={(e) => set({ members: { memberCeiling: PERMISSIONS.filter((x) => (x === p ? valueOf(e) : ceiling.includes(x))) } })} />)}
            </div>}
          <div style={{ maxWidth: 320 }}><Select label="New projects start" size="sm" value={draft.projects.defaultMode} options={MODE_OPTIONS}
            onChange={(e) => set({ projects: { defaultMode: valueOf(e) } })} /></div>
        </div>
      </RecordPanel>
      <div role="group" aria-label="Save the policy" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {dirty ? <span style={{ flex: '1 1 240px' }}><Alert variant={narrows ? 'warning' : 'neutral'} density="compact" live="polite">{narrows ? narrowText : 'Saving narrows no existing grant or share link.'}</Alert></span>
          : notice ? <span style={{ flex: '1 1 240px' }}><Alert variant="success" density="compact">{notice}</Alert></span> : <span style={{ flex: '1 1 auto' }} />}
        <Button size="sm" variant="secondary" outline disabled={!dirty} onClick={onDiscard}>{'Discard changes'}</Button>
        <Button size="sm" icon="bi-save" disabled={!dirty} onClick={onSave}>{'Save policy'}</Button>
      </div>
    </div>;
  }

  /* ---- Share: people and links ---- */
  /** Who has access through the project (summarized) and through artifact grants (add or remove). */
  function SharePeople({ projectName, projectSummary, grants, candidates, addMember, addRole, onAddMember, onAddRole, onAdd, onRemove, canEdit, canAdd = canEdit, onOpenProject, addPreview }) {
    return <div style={stack(14)}>
      <section aria-label="Through the project" style={stack(6)}>
        <h3 style={{ margin: 0, fontSize: 'var(--font-size-dense, 13px)' }}>{'Through ' + projectName}</h3>
        <p style={{ ...note, fontSize: 'var(--font-size-dense, 13px)' }}>{projectSummary}</p>
        {onOpenProject ? <div><Button size="xs" variant="link" flush onClick={onOpenProject}>{'Project access'}</Button></div> : null}
      </section>
      <section aria-label="Through this artifact" style={stack(6)}>
        <h3 style={{ margin: 0, fontSize: 'var(--font-size-dense, 13px)' }}>{'Through this artifact'}</h3>
        {grants.length ? <ul style={{ margin: 0, padding: 0, listStyle: 'none', ...stack(4) }}>{grants.map((g) =>
          <li key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: '1 1 auto', minWidth: 0, fontSize: 'var(--font-size-dense, 13px)' }}>{g.name}</span>
            <span style={note}>{roleLabel(g.role)}</span>
            {canEdit ? <IconButton icon="bi-x-lg" size="xs" ariaLabel={'Remove ' + g.name + '’s grant on this artifact'} onClick={() => onRemove(g)} /> : null}
          </li>)}</ul> : <p style={note}>{'Nobody has a grant on this artifact alone.'}</p>}
        {canEdit && canAdd ? <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 140px' }}><Select label="Add a person" size="sm" value={addMember} onChange={(e) => onAddMember(valueOf(e))}
            options={[{ value: '', label: 'Choose a member' }].concat(candidates)} /></span>
          <span style={{ flex: '0 1 120px' }}><Select label="Role" size="sm" value={addRole} options={roleOptions(1)} onChange={(e) => onAddRole(valueOf(e))} /></span>
          <Button size="sm" variant="secondary" outline disabled={!addMember} onClick={onAdd}>{'Add'}</Button>
        </div> : null}
        {canEdit && canAdd && addPreview ? <p role="status" style={{ ...note, fontSize: 'var(--font-size-dense, 13px)' }}>{addPreview}</p> : null}
      </section>
    </div>;
  }

  /** Every link to this artifact: label, summary and its actions; Revoke confirms in place. */
  /* Rotate and Revoke both end guests' sessions, so both confirm in place and say so first (UX-07).
     Each row action names its link, as Copy does (UX-19). */
  function ShareLinksList({ links, ended, renderCopy, onEdit, onRotate, revoking, onRevoke, onConfirmRevoke, onCancelRevoke, onNew, notice, canCreate,
    rotating = null, onConfirmRotate, onCancelRotate,
    createNote = 'Only administrators can create share links on this installation.' }) {
    return <div style={stack(10)}>
      {notice ? <Alert variant="success" density="compact">{notice}</Alert> : null}
      {links.length ? <ul aria-label="Share links" style={{ margin: 0, padding: 0, listStyle: 'none', ...stack(0) }}>{links.map((l, i) =>
        <li key={l.id} data-share-link={l.id} style={{ ...stack(6), padding: '10px 0', borderTop: i ? '1px solid var(--list-divider, #E9ECEF)' : 0 }}>
          <span style={strong}>{l.label}</span>
          <span style={note}>{l.summary}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            {renderCopy(l)}
            <Button size="xs" variant="link" aria-label={'Edit ' + l.label + ' link'} onClick={() => onEdit(l)}>{'Edit'}</Button>
            <Button size="xs" variant="link" aria-label={'Rotate ' + l.label + ' link'} onClick={() => onRotate(l)}>{'Rotate'}</Button>
            <Button size="xs" variant="link" danger aria-label={'Revoke ' + l.label + ' link'} onClick={() => onRevoke(l)}>{'Revoke'}</Button>
          </div>
          {rotating === l.id && onConfirmRotate ? <Alert variant="warning" density="compact" action={[{ label: 'Cancel', variant: 'ghost', onClick: onCancelRotate },
            { label: 'Rotate Link', variant: 'warning', onClick: () => onConfirmRotate(l) }]}>
            {'“' + l.label + '” gets a new address. ' + (l.guestCount ? (l.guestCount === 1 ? 'The 1 guest using it is' : 'The ' + l.guestCount + ' guests using it are') : 'Anyone using it is')
              + ' signed out and needs the new link. Their comments stay.'}</Alert> : null}
          {revoking === l.id ? <Alert variant="warning" density="compact" action={[{ label: 'Cancel', variant: 'ghost', onClick: onCancelRevoke },
            { label: 'Revoke Link', variant: 'danger', onClick: () => onConfirmRevoke(l) }]}>{'People with this link lose access now. Their comments stay.'}</Alert> : null}
        </li>)}</ul> : <p style={note}>{'No active share links open this artifact.'}</p>}
      {ended ? <p style={note}>{ended}</p> : null}
      {canCreate ? <div><Button size="sm" icon="bi-plus-lg" onClick={onNew}>{'New Link'}</Button></div>
        : <p style={note}>{createNote}</p>}
    </div>;
  }

  /** Create (or edit) a link: label, preset, the custom permissions, target, expiry. */
  function ShareLinkForm({ form, onChange, version, maxDays, guestMax, error, editing, onCancel, onSubmit, narrowFrom = null, narrowNote }) {
    const set = (patch) => onChange({ ...form, ...patch });
    const allowsComments = guestMax.includes('comment.read') && guestMax.includes('comment.write');
    /* Archived (`narrowFrom`, the saved link): only choices that reach no further stay available — a
       subset of its permissions, its own target, an expiry no later than its own. */
    const holds = (p) => !narrowFrom || narrowFrom.permissions.includes(p);
    const widensPreset = (p) => !!narrowFrom && p.permissions && p.permissions.some((x) => !holds(x));
    const expiry = expiryOptions(maxDays).filter((o) => !narrowFrom || narrowFrom.daysLeft == null || (o.days != null && o.days <= narrowFrom.daysLeft));
    return <div style={stack(14)}>
      {narrowFrom && narrowNote ? <Alert variant="neutral" density="compact">{narrowNote}</Alert> : null}
      <Input label="Label" required size="sm" placeholder="For example, Client review" value={form.label} onChange={(e) => set({ label: valueOf(e) })} />
      <ChoiceGroup label="Guests can" value={form.preset} minColumnWidth={100} onChange={(id) => { if (id) set({ preset: id }); }}
        options={SHARE_PRESETS.map((p) => ({ id: p.id, title: p.label, disabled: (p.id === 'comment' && !allowsComments) || widensPreset(p),
          description: widensPreset(p) ? 'Would give guests more than this link does'
            : p.id === 'view' ? 'Open this page only' : p.id === 'comment' ? 'Read and write comments' : 'Choose below' }))} />
      {form.preset === 'custom' ? <div role="group" aria-label="Custom guest permissions" style={{ ...stack(6), paddingLeft: 12, borderLeft: '2px solid var(--list-divider, #E9ECEF)' }}>
        <Checkbox label="View this version" checked disabled />
        <Checkbox label="Read comments" checked={form.custom.includes('comment.read')} disabled={!guestMax.includes('comment.read') || !holds('comment.read')}
          onChange={(e) => set({ custom: valueOf(e) ? form.custom.concat('comment.read') : form.custom.filter((p) => p !== 'comment.read' && p !== 'comment.write') })} />
        <Checkbox label="Write comments" checked={form.custom.includes('comment.write')} disabled={!guestMax.includes('comment.write') || !holds('comment.write')}
          onChange={(e) => set({ custom: valueOf(e) ? form.custom.filter((p) => p !== 'comment.write').concat('comment.read', 'comment.write') : form.custom.filter((p) => p !== 'comment.write') })} />
      </div> : null}
      <ChoiceGroup label="Link opens" value={form.target} minColumnWidth={140} onChange={(id) => { if (id) set({ target: id }); }}
        options={[{ id: 'version', title: 'This version', description: 'Version ' + version + ', even after new ones', disabled: !!narrowFrom && narrowFrom.target !== 'version' },
          { id: 'latest', title: 'Latest', description: 'Follows the current version', disabled: !!narrowFrom && narrowFrom.target !== 'latest' }]} />
      <Select label="Expires" size="sm" value={form.expires} options={(editing && form.expires === 'keep' ? [{ value: 'keep', label: 'Keep ' + (form.keepLabel || 'the current expiry') }] : []).concat(expiry)}
        onChange={(e) => set({ expires: valueOf(e) })} />
      {error ? <Alert variant="danger">{error}</Alert> : null}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button size="sm" variant="secondary" outline onClick={onCancel}>{'Cancel'}</Button>
        <Button size="sm" icon={editing ? 'bi-save' : 'bi-link-45deg'} disabled={!form.label.trim()} onClick={onSubmit}>{editing ? 'Save Link' : 'Create Link'}</Button>
      </div>
    </div>;
  }

  /** Share's overview bands for people and links; each opens its screen. */
  function ShareAccessBands({ peopleLine, linkCount, onPeople, onLinks }) {
    const band = (icon, title, sub, label, onClick, key) => <PanelSection key={key} gap={8} padding="12px 16px">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <i className={'bi ' + icon} aria-hidden="true" />
        <span style={{ display: 'flex', flex: '1 1 auto', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={strong}>{title}</span><span style={note}>{sub}</span>
        </span>
        <Button size="sm" variant="primary" outline onClick={onClick}>{label}</Button>
      </div>
    </PanelSection>;
    return <>
      {/* Each action names whom it reaches (UX-13): members of this project, or guests without an account. */}
      {onPeople ? band('bi-person-check', 'People', peopleLine, 'Manage People', onPeople, 'people') : null}
      {onLinks ? band('bi-link-45deg', linkCount ? plural(linkCount, 'guest link') : 'Guest links', 'Guests without an account open and comment through a share link.', 'Manage Guest Links', onLinks, 'links') : null}
    </>;
  }

  /* ---- Settings → Share links ---- */
  const LINK_TONES = { Active: 'success', Expired: 'warning', Revoked: 'neutral' };
  /** The installation's links, selectable for bulk revoke; `statusOf` reads Active, Expired or Revoked. */
  function ShareLinksGrid({ links, statusOf, summaryOf, selectedIds, onSelectionChange, renderCopy, onOpenArtifact, onRevoke }) {
    return <DataGrid ariaLabel="Share links inventory" quickFilter statusBar={false} selectable selection="multiple"
      selectedIds={selectedIds} onSelectionChange={(ids) => onSelectionChange(ids)}
      empty={<SurfaceState phase="ready" count={0} noun="share links" density="inline" emptyIcon="bi-link-45deg"
        emptyTitle="No share links" emptyBody="No active share links. Create one from Share on any artifact." />}
      columns={[
        { field: 'artifact', headerName: 'Artifact', width: 220, onCellClick: (row) => onOpenArtifact(row.link) },
        { field: 'label', headerName: 'Link', width: 200 },
        { field: 'summary', headerName: 'Permissions', width: 320 },
        { field: 'guests', headerName: 'Guests', type: 'count', width: 90 },
        { field: 'createdBy', headerName: 'Created by', width: 170 },
        { field: 'status', headerName: 'Status', width: 110, cellRenderer: (v) => <StatusPill tone={LINK_TONES[v] || 'neutral'} label={v} /> },
        { field: 'copy', headerName: '', width: 56, cellRenderer: (_v, row) => (row.status === 'Active' ? renderCopy(row.link) : null) },
      ]}
      rows={links.map((l) => ({ id: l.id, artifact: l.artifactName, label: l.projectName + ' · ' + l.label, summary: summaryOf(l), guests: l.guestCount || 0,
        createdBy: l.createdBy + ' · ' + l.createdLabel, status: statusOf(l), link: l }))}
      rowActions={(row) => (row.status === 'Active' ? [{ label: 'Revoke', icon: 'bi-x-circle', danger: true, onClick: () => onRevoke(row.link) }] : null)}
      rowActionsLabel={(row) => 'Actions for ' + row.label} />;
  }

  /** A member's grants in the Members drawer, each linking to the project's Access tab. */
  function MemberGrants({ grants, onOpen, administrator }) {
    if (administrator) return <p style={note}>{'An administrator manages every project and cannot be given a grant.'}</p>;
    if (!grants.length) return <p style={note}>{'No project grants. This member has each project’s default access.'}</p>;
    return <ul aria-label="Grants" style={{ margin: 0, padding: 0, listStyle: 'none', ...stack(4) }}>{grants.map((g) =>
      <li key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <Button size="xs" variant="link" flush onClick={() => onOpen(g)}>{g.projectName + ': ' + roleLabel(g.role) + (g.artifactName ? ' on ' + g.artifactName : '')}</Button>
        {g.overrides ? <Tag mono={false}>{g.overrides}</Tag> : null}
      </li>)}</ul>;
  }

  return { GuestBadge, GuestHeader, EndedLink, GuestNameForm, WhyCanThey, PermissionChecklist, ProjectAccessPanel, AccessPolicyScreen,
    SharePeople, ShareLinksList, ShareLinkForm, ShareAccessBands, ShareLinksGrid, MemberGrants };
}
