import React from 'react';
import { Button } from '../actions/Button.jsx';
import { Spinner } from './Spinner.jsx';

/* Skeleton bar widths — six pairs, cycled, so a loading list reads as records of
   uneven length rather than a barcode. */
const W = [[88, 52], [72, 61], [95, 44], [66, 57], [82, 49], [77, 64]];

/**
 * ArkCase SurfaceState — the one component every list, grid and panel hands its
 * empty, loading, failed and restricted states to. Five states, one geometry:
 *
 *  loading     → skeleton rows (silent to sighted users, announced once politely)
 *  failed      → "Could not load {noun}" + Retry
 *  filtered    → "No {noun} match these filters" + Clear Filters
 *  restricted  → "Restricted for your role" + Request Access
 *  empty       → the module's own copy + its create action
 *
 * Copy is factual, never apologetic, and always names the noun the surface holds.
 *
 * `density="inline"` is the compact form for a section inside a card or pane: one muted
 * line at the dense size — the optional `emptyIcon`, the message (`emptyBody`, else
 * `emptyTitle`, else "No {noun} yet."), and the action as a link-weight button. The other
 * states keep their own icon and use their title as the line. `variant="dashed"` draws the
 * message in a dashed, rounded box — the "space reserved for something" treatment.
 * `titleLevel` makes the block title a real heading (an unknown route's h1); a
 * `secondaryAction` sits beside the action; `actionProps` reach the action's button.
 *
 * Workers' Compensation additions, all opt-in: `meta` (a footnote line such as
 * "Signed in as Examiner"), `failedTitle`/`failedBody` and `restricted.title`/`body` for a
 * product's own copy, `loadingStyle="spinner"` with `loadingTitle`/`loadingBody` for a
 * generate-in-progress surface, and `tone="warning"` for the dashed box of a slot that is
 * waiting on the reader ("Not yet scheduled").
 *
 * `surface="dark"` sets the state on a dark stage — the document viewer's gray-800 page
 * well: white serif title, `text-on-navy-secondary` body and meta, the failed glyph in
 * warning (danger red is illegible there), a solid primary action and an on-navy outline
 * secondary action. The host paints the stage; the state stays transparent over it.
 */
export function SurfaceState({
  phase = 'ready',
  count = 0,
  noun = 'records',
  filtered = false,
  restricted,
  skeleton = 5,
  emptyIcon, emptyTitle, emptyBody, actionLabel, actionIcon, onAction,
  onRetry, onClear, filterBody,
  density = 'block', variant = 'plain',
  titleLevel, secondaryAction, actionProps,
  meta, metaIcon, failedTitle, failedBody,
  loadingStyle = 'skeleton', loadingTitle, loadingBody, tone = 'default', surface = 'light',
  style, ...rest
}) {
  const dark = surface === 'dark';
  const ink2 = dark ? 'var(--text-on-navy-secondary, rgba(255,255,255,.72))' : 'var(--text-secondary, #5a6268)';
  const bar = dark ? 'var(--border-on-navy, rgba(255,255,255,.18))' : 'var(--bs-gray-200, #e9ecef)';
  const state = restricted ? 'restricted' : phase;
  const inline = density === 'inline';
  const warn = tone === 'warning';
  const box = variant === 'dashed' ? {
    background: dark ? 'transparent' : 'var(--surface-card, #fff)',
    border: '1px dashed ' + (warn ? 'var(--bs-warning, #ff9a15)' : dark ? 'var(--text-on-navy-secondary, rgba(255,255,255,.72))' : 'var(--border-color-strong, #ced4da)'),
    borderRadius: 'var(--radius-lg, 8px)',
  } : null;
  const level = Math.min(6, Math.max(1, titleLevel | 0));
  const TitleTag = titleLevel ? 'h' + level : 'div';
  const titleStyle = { margin: 0, fontFamily: 'var(--font-display, "Source Serif 4", Georgia, serif)', fontSize: 'var(--font-size-lg, 16px)', fontWeight: 600, color: dark ? 'var(--text-on-navy, #fff)' : 'var(--text-navy, #073652)', lineHeight: 1.25, textWrap: 'pretty' };
  const bodyStyle = { fontSize: 'var(--font-size-dense, 13px)', lineHeight: 1.5, color: ink2, maxWidth: '26em', textWrap: 'pretty' };
  const metaNode = meta != null && meta !== '' && (
    <div data-surface-state-meta="" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-dense, 13px)', lineHeight: 1.5, color: ink2 }}>
      {metaIcon && <i className={`bi ${metaIcon}`} aria-hidden="true" style={{ fontSize: 'var(--icon-sm, 14px)', flex: 'none' }} />}
      <span>{meta}</span>
    </div>
  );
  const line = {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 8px',
    padding: inline && box ? '12px 16px' : '8px 16px',
    fontSize: 'var(--font-size-dense, 13px)', lineHeight: 1.5, color: ink2,
    ...box,
  };

  if (state === 'loading' && inline) {
    return (
      <div role="status" aria-live="polite" data-surface-state="loading" style={{ ...line, ...style }} {...rest}>
        {loadingStyle === 'spinner' && <Spinner size={14} />}
        {loadingTitle || `Loading ${noun}…`}
      </div>
    );
  }

  if (state === 'loading' && loadingStyle === 'spinner') {
    return (
      <div role="status" aria-live="polite" data-surface-state="loading" style={{ ...box, padding: '36px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center', ...style }} {...rest}>
        <Spinner size={24} />
        <TitleTag style={titleStyle}>{loadingTitle || `Loading ${noun}`}</TitleTag>
        {loadingBody && <div style={bodyStyle}>{loadingBody}</div>}
        {metaNode}
      </div>
    );
  }

  if (state === 'loading') {
    const rows = Array.from({ length: skeleton || 5 }, (_, i) => W[i % 6]);
    return (
      <div role="status" aria-live="polite" style={{ display: 'flex', flexDirection: 'column', position: 'relative', ...style }} {...rest}>
        <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>{`Loading ${noun}`}</span>
        {rows.map(([w1, w2], i) => (
          <div key={i} aria-hidden="true" style={{ padding: '12px 14px', borderBottom: '1px solid ' + (dark ? bar : 'var(--list-divider, #e9ecef)'), display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ height: 12, borderRadius: 'var(--radius-sm, 4px)', background: bar, width: `${w1}%` }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ height: 10, borderRadius: 'var(--radius-sm, 4px)', background: bar, width: `${w2}%` }} />
              <div style={{ height: 16, width: 56, borderRadius: 'var(--radius-pill, 10px)', background: bar, flexShrink: 0 }} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (state === 'ready' && count > 0) return null;

  let icon = emptyIcon || 'bi-folder2', tint = warn ? 'var(--bs-warning, #ff9a15)' : dark ? ink2 : 'var(--bs-gray-600, #6c757d)';
  let title = emptyTitle || `No ${noun} yet`, body = emptyBody || '';
  let label = actionLabel || '', aIcon = actionIcon || '', act = onAction;

  if (state === 'restricted') {
    icon = 'bi-shield-lock'; tint = dark ? 'var(--text-on-navy, #fff)' : 'var(--bs-primary, #0079a8)';
    title = restricted.title || 'Restricted for your role';
    body = restricted.body || `${restricted.unit} holds the access for these ${noun}. Request access if your work now requires it.`;
    label = 'Request Access'; aIcon = 'bi-envelope'; act = restricted.onRequest;
  } else if (state === 'failed') {
    icon = 'bi-exclamation-octagon'; tint = dark ? 'var(--bs-warning, #ff9a15)' : 'var(--bs-danger, #d83506)';
    title = failedTitle || `Could not load ${noun}`;
    body = failedBody || 'The case service did not respond. Nothing was changed — try again, and report the time to the service desk if it keeps failing.';
    label = 'Retry'; aIcon = 'bi-arrow-clockwise'; act = onRetry;
  } else if (filtered && count === 0) {
    icon = 'bi-funnel'; tint = dark ? 'var(--bs-warning, #ff9a15)' : 'var(--pill-warning-fg, #92400e)';
    title = `No ${noun} match these filters`;
    body = filterBody || 'Nothing in this module matches the filters you have set. Widen them, or clear them to see the full list.';
    label = 'Clear Filters'; aIcon = 'bi-x-circle'; act = onClear;
  }

  if (inline) {
    const message = state === 'ready' && !(filtered && count === 0) ? (emptyBody || emptyTitle || `No ${noun} yet.`) : title;
    const glyph = state === 'ready' && !(filtered && count === 0) ? emptyIcon : icon;
    return (
      <div data-surface-state={state} style={{ ...line, ...style }} {...rest}>
        {glyph && <i className={`bi ${glyph}`} aria-hidden="true" style={{ fontSize: 'var(--font-size-sm, 14px)', flex: 'none' }} />}
        <span style={{ minWidth: 0, textWrap: 'pretty' }}>{message}</span>
        {label && act && <Button variant={dark ? 'navy' : 'link'} size="sm" icon={aIcon} onClick={act} {...actionProps}>{label}</Button>}
        {secondaryAction && <Button variant={dark ? 'navy' : 'link'} size="sm" icon={secondaryAction.icon} onClick={secondaryAction.onClick}>{secondaryAction.label}</Button>}
      </div>
    );
  }

  return (
    <div data-surface-state-surface={dark ? 'dark' : undefined} style={{ ...box, padding: '36px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center', ...style }} {...rest}>
      <i className={`bi ${icon}`} aria-hidden="true" style={{ fontSize: 'var(--icon-xl, 24px)', color: tint }} />
      <TitleTag style={titleStyle}>{title}</TitleTag>
      {body && <div style={bodyStyle}>{body}</div>}
      {metaNode}
      {((label && act) || secondaryAction) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 'var(--space-2, 8px)', marginTop: 2 }}>
          {label && act && <Button variant={dark ? 'primary' : 'outline-primary'} size="sm" icon={aIcon} onClick={act} {...actionProps}>{label}</Button>}
          {secondaryAction && (dark
            ? <Button variant="navy" outline size="sm" icon={secondaryAction.icon} onClick={secondaryAction.onClick}>{secondaryAction.label}</Button>
            : <Button variant="outline-secondary" size="sm" icon={secondaryAction.icon} onClick={secondaryAction.onClick}>{secondaryAction.label}</Button>)}
        </div>
      )}
    </div>
  );
}
