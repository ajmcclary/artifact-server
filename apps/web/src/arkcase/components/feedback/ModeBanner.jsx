import React from 'react';
import { Button } from '../actions/Button.jsx';

/* The floating variant's own small pill control: outlined on navy, with a light
   focus ring because the shared cyan outline is too faint on the navy ground. */
function FloatingAction({ label, icon, onClick }) {
  const [hover, setHover] = React.useState(false);
  const [focusVisible, setFocusVisible] = React.useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={(e) => { try { setFocusVisible(e.target.matches(':focus-visible')); } catch (_) { setFocusVisible(true); } }}
      onBlur={() => setFocusVisible(false)}
      data-icon-tone="current"
      style={{
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-1, 4px)',
        minHeight: 24,
        padding: '0 9px',
        border: 'var(--border-width, 1px) solid var(--text-on-navy-secondary, rgba(255, 255, 255, 0.72))',
        borderRadius: 'var(--radius-pill, 10px)',
        background: hover ? 'var(--surface-navy-strong, #0d4a6b)' : 'transparent',
        color: 'var(--text-on-navy, #ffffff)',
        font: 'inherit',
        fontSize: 'var(--font-size-label, 11px)',
        cursor: 'pointer',
        outline: focusVisible ? '2px solid var(--text-on-navy, #ffffff)' : 'none',
        outlineOffset: 2,
      }}
    >
      {icon ? <i aria-hidden="true" className={`bi ${icon}`} /> : null}
      {label}
    </button>
  );
}

/* The card variant: a light surface ruled in primary, for a mode that edits the page the
   user is still reading (a dashboard in configuration). An icon disc, a title and hint, the
   mode's own controls inline, and the way out pushed to the end. It wraps on narrow widths:
   the identity block keeps a 260px basis, the controls and actions drop beneath it. */
function CardBanner({ icon, title, meta, action, controls, actions, role, style, rest, children }) {
  const hasText = children != null && children !== '';
  const trailing = actions != null || action;
  return (
    <div
      role={role}
      data-mode-banner="card"
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 16,
        boxSizing: 'border-box',
        padding: '12px 14px',
        background: 'var(--surface-card, #ffffff)',
        color: 'var(--text-body, #212529)',
        border: 'var(--border-width, 1px) solid var(--bs-primary, #0079a8)',
        borderRadius: 'var(--radius-md, 5px)',
        boxShadow: 'var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.06), 0 1px 3px rgba(0, 0, 0, 0.04))',
        fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
        ...style,
      }}
      {...rest}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: '1 1 260px', minWidth: 0 }}>
        {icon ? (
          <span
            data-icon-tone="current"
            style={{
              flex: '0 0 auto', width: 28, height: 28, borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--tint-primary-selected, rgba(0, 121, 168, 0.10))',
              color: 'var(--text-link-hover, #005a7d)',
            }}
          >
            <i aria-hidden="true" className={`bi ${icon}`} style={{ fontSize: 'var(--icon-sm, 16px)' }} />
          </span>
        ) : null}
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {title != null && title !== '' ? (
            <span data-mode-banner-title="" style={{ fontSize: 'var(--font-size-sm, 14px)', fontWeight: 600, color: 'var(--text-body, #212529)' }}>{title}</span>
          ) : null}
          {hasText ? (
            <span style={{ fontSize: 'var(--font-size-dense, 13px)', color: 'var(--text-secondary, #5a6268)', textWrap: 'pretty' }}>{children}</span>
          ) : null}
        </div>
        {meta != null && meta !== '' ? (
          <span style={{ flex: 'none', fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)', fontSize: 'var(--font-size-xs, 12px)', fontVariantNumeric: 'tabular-nums', color: 'var(--text-data, #495057)' }}>{meta}</span>
        ) : null}
      </div>
      {controls != null ? (
        <div data-mode-banner-controls="" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 16, minWidth: 0 }}>{controls}</div>
      ) : null}
      {trailing ? (
        <div data-mode-banner-actions="" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginLeft: 'auto' }}>
          {actions}
          {action ? (
            <Button variant="primary" size="sm" icon={action.icon} onClick={action.onClick}>{action.label}</Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * ArkCase ModeBanner — announces a temporary mode the user must leave on
 * purpose: picking a point on a canvas, previewing as an end user. `floating`
 * is a compact navy pill pinned 14px above the bottom of its positioned parent;
 * `bar` is a full-width navy strip for a mode that owns the whole screen; `card` is
 * a light card ruled in primary for a mode that edits the page in place (a
 * dashboard in configuration), with a `title`, inline `controls` and `actions`. The
 * message is a polite status; the action (usually "Cancel (Esc)" or "Back to
 * review (Esc)") is the visible way out. The host owns the mode and the Esc key.
 */
export function ModeBanner({ variant = 'floating', icon, title, children, meta, action, controls, actions, role = 'status', style, ...rest }) {
  if (variant === 'card') {
    return (
      <CardBanner icon={icon} title={title} meta={meta} action={action} controls={controls} actions={actions} role={role} style={style} rest={rest}>
        {children}
      </CardBanner>
    );
  }
  const floating = variant !== 'bar';
  const metaNode = meta != null && meta !== '' ? (
    <span
      style={{
        flex: 'none',
        fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)',
        fontSize: 'var(--font-size-label, 11px)',
        color: 'var(--text-on-navy-secondary, rgba(255, 255, 255, 0.72))',
        overflowWrap: 'anywhere',
      }}
    >
      {meta}
    </span>
  ) : null;
  const iconNode = icon ? (
    <i aria-hidden="true" className={`bi ${icon}`} style={{ flex: 'none', fontSize: floating ? 13 : 'var(--icon-sm, 16px)' }} />
  ) : null;

  if (floating) {
    return (
      <div
        role={role}
        title={typeof title === 'string' ? title : undefined}
        data-icon-tone="current"
        style={{
          position: 'absolute',
          zIndex: 60,
          bottom: 14,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2, 10px)',
          maxWidth: 'calc(100% - 24px)',
          boxSizing: 'border-box',
          padding: '6px 8px 6px 12px',
          background: 'var(--surface-header, #073652)',
          color: 'var(--text-on-navy, #ffffff)',
          borderRadius: 'var(--radius-pill, 10px)',
          boxShadow: 'var(--shadow-md, 0 2px 4px rgba(0, 0, 0, 0.05), 0 4px 12px rgba(0, 0, 0, 0.10))',
          fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
          ...style,
        }}
        {...rest}
      >
        {iconNode}
        <span style={{ minWidth: 0, fontSize: 'var(--font-size-xs, 12px)', lineHeight: 1.4 }}>{children}</span>
        {metaNode}
        {action ? <FloatingAction label={action.label} icon={action.icon} onClick={action.onClick} /> : null}
      </div>
    );
  }

  return (
    <div
      role={role}
      title={typeof title === 'string' ? title : undefined}
      data-icon-tone="current"
      style={{
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 'var(--space-2, 10px)',
        padding: '8px 14px',
        background: 'var(--surface-header, #073652)',
        color: 'var(--text-on-navy, #ffffff)',
        fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
        ...style,
      }}
      {...rest}
    >
      {iconNode}
      <span style={{ flex: '1 1 auto', minWidth: 0, fontSize: 'var(--font-size-dense, 13px)' }}>{children}</span>
      {metaNode}
      {action ? (
        <Button variant="primary" size="sm" icon={action.icon} onClick={action.onClick}>{action.label}</Button>
      ) : null}
    </div>
  );
}
