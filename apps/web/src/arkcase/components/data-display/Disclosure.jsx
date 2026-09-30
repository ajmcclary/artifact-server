import React from 'react';
import { splitSlots } from '../utilities/slots.jsx';

/* splitSlots returns plain arrays; spread them as variadic children so React needs no keys. */
const nodes = (v) => (Array.isArray(v) ? (v.length ? React.createElement(React.Fragment, null, ...v) : null) : v);

/* Persistent status rail colours for `tone`, the same 3px mark SelectableRow draws. Not text. */
const RAIL_TONES = {
  success: 'var(--bs-success, #00b532)',
  danger: 'var(--bs-danger, #d83506)',
  warning: 'var(--bs-warning, #ff9a15)',
  primary: 'var(--bs-primary, #0079a8)',
  neutral: 'var(--border-color-strong, #ced4da)',
};

const DENSITY = {
  comfortable: { minHeight: 'var(--space-8, 48px)', padY: 'var(--space-2, 8px)', title: 'var(--font-size-sm, 14px)' },
  compact: { minHeight: 'var(--space-7, 40px)', padY: 'var(--space-1, 4px)', title: 'var(--font-size-dense, 13px)' },
  /* The builder palette's group band: a 30px header on the secondary surface between
     border-color hairlines, 12px/600 emphasis label, 10px inline padding and 6px gaps. */
  dense: { minHeight: '30px', padY: '0px', title: 'var(--font-size-xs, 12px)' },
};

/**
 * ArkCase Disclosure — an expandable row: a native button header carrying `aria-expanded`
 * and `aria-controls`, and the detail block it reveals. The header lays out an optional
 * leading node (a StatusPill, an identifier), the title over an optional meta line, an
 * optional trailing node (a count, a pill) and the chevron (`bi-chevron-right` closed,
 * `bi-chevron-down` open). `tone` adds the persistent 3px status rail SelectableRow uses.
 * Open state is controlled (`open` + `onToggle`) or uncontrolled (`defaultOpen`).
 * `actionLabel` adds trailing action words that swap with the state ("Inspect checks" /
 * "Close details"); `framed` draws the row as its own bordered card whose header takes the
 * secondary surface while open. `disabled` makes the header a native disabled button: the
 * row keeps whatever open state it has, stops toggling, and dims its title and chevron.
 * `density="dense"` draws the compact band header a builder palette groups its entries
 * under; `sticky` pins the header to the top of its scrolling container at any density.
 *
 * Portable pages that can pass only children may send `leading`, `trailing`, `meta` and
 * `title` as children marked slot="leading" / "trailing" / "meta" / "title"; an explicit
 * prop wins, and every other child is the detail.
 */
export function Disclosure({
  title: titleProp,
  meta: metaProp,
  leading: leadingProp,
  trailing: trailingProp,
  tone,
  open: openProp,
  defaultOpen = false,
  onToggle,
  id: idProp,
  region = false,
  divider = true,
  density = 'comfortable',
  actionLabel,
  framed = false,
  disabled = false,
  actions,
  sticky = false,
  children: childrenProp,
  style,
  ...rest
}) {
  const slots = splitSlots(childrenProp);
  const title = titleProp != null ? titleProp : nodes(slots.title);
  const meta = metaProp != null ? metaProp : nodes(slots.meta);
  const leading = leadingProp != null ? leadingProp : nodes(slots.leading);
  const trailing = trailingProp != null ? trailingProp : nodes(slots.trailing);
  const detail = nodes(slots.children);

  const autoId = React.useId();
  const base = idProp || 'disclosure-' + autoId.replace(/[^A-Za-z0-9_-]/g, '');
  const headerId = base + '-header';
  const regionId = base + '-region';

  const controlled = openProp !== undefined;
  const [inner, setInner] = React.useState(!!defaultOpen);
  const open = controlled ? !!openProp : inner;
  const [hover, setHover] = React.useState(false);

  const d = DENSITY[density] || DENSITY.comfortable;
  const dense = density === 'dense';
  const rail = tone ? RAIL_TONES[tone] || RAIL_TONES.neutral : null;
  /* With a rail the 3px border sits inside the 20px start padding, so titles align either way.
     The dense band keeps the builder's 10px inset (less the rail when one is drawn). */
  const padStart = dense
    ? (rail ? '7px' : '10px')
    : (rail ? 'calc(var(--space-5, 24px) - 3px)' : 'var(--space-5, 24px)');
  const padEnd = dense ? '10px' : 'var(--space-3, 12px)';
  const gap = dense ? '6px' : 'var(--space-3, 12px)';
  const action = actionLabel ? (open ? actionLabel.open : actionLabel.closed) : null;
  const columns = [leading != null ? 'auto' : null, 'minmax(0, 1fr)', trailing != null ? 'auto' : null, action != null ? 'auto' : null, dense ? '12px' : 'var(--space-4, 16px)']
    .filter(Boolean).join(' ');

  /* `actions` sit beside the header button, never inside it (a button may not nest a button).
     With them the header row is a flex wrapper: the framed-open ground and hairline move to
     the wrapper so they run under the actions too. */
  const hasActions = actions != null && actions !== false;
  const framedOpenRow = framed && open;
  const headRadius = framed ? (open ? 'var(--radius-md, 5px) var(--radius-md, 5px) 0 0' : 'var(--radius-md, 5px)') : undefined;
  /* The dense band is always drawn: secondary ground between top and bottom hairlines. With
     actions the band moves to the wrapper so it runs under them too. */
  const band = dense ? {
    borderTop: '1px solid var(--border-color, #dee2e6)',
    borderBottom: '1px solid var(--border-color, #dee2e6)',
    background: 'var(--surface-secondary, #f8f9fa)',
  } : null;
  const stick = sticky ? { position: 'sticky', top: 0, zIndex: 2 } : null;
  /* A sticky header needs an opaque ground so the rows scrolling beneath it do not show
     through; the translucent hover tint is then layered over that ground. */
  const hoverTint = 'var(--tint-primary-hover, rgba(0,121,168,.05))';
  const restGround = (framedOpenRow || dense) && !hasActions
    ? 'var(--surface-secondary, #f8f9fa)'
    : sticky && !hasActions ? 'var(--surface-card, #fff)' : null;
  const hovering = hover && !disabled;
  const layered = dense || sticky; /* earlier densities keep their plain tint on hover */
  const headerGround = hovering
    ? (restGround && layered ? 'linear-gradient(' + hoverTint + ', ' + hoverTint + '), ' + restGround : hoverTint)
    : restGround || 'transparent';

  const toggle = () => {
    if (disabled) return;
    const next = !open;
    if (!controlled) setInner(next);
    if (onToggle) onToggle(next);
  };

  const header = (
    <button
      type="button"
      id={headerId}
      aria-expanded={open}
      aria-controls={regionId}
      disabled={disabled}
      onClick={toggle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: hasActions ? undefined : '100%',
        flex: hasActions ? '1 1 auto' : undefined,
        minWidth: hasActions ? 0 : undefined,
        display: 'grid',
        gridTemplateColumns: columns,
        gap,
        alignItems: 'center',
        minHeight: d.minHeight,
        boxSizing: 'border-box',
        margin: 0,
        padding: d.padY + ' ' + padEnd + ' ' + d.padY + ' ' + padStart,
        border: 0,
        borderBottom: framedOpenRow && !hasActions ? '1px solid var(--border-color, #dee2e6)' : 0,
        borderRadius: hasActions ? (framed ? (open ? 'var(--radius-md, 5px) 0 0 0' : 'var(--radius-md, 5px) 0 0 var(--radius-md, 5px)') : undefined) : headRadius,
        background: headerGround,
        ...(band && !hasActions ? { borderTop: band.borderTop, borderBottom: band.borderBottom } : null),
        ...(stick && !hasActions ? stick : null),
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background var(--transition-fast, 0.15s)',
      }}
    >
      {leading != null && <span data-disclosure-leading="" style={{ display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap' }}>{leading}</span>}
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span
          data-disclosure-title=""
          style={{
            fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
            fontSize: d.title,
            fontWeight: 600,
            lineHeight: 'var(--line-height-snug, 1.375)',
            color: disabled ? 'var(--text-secondary, #5a6268)' : dense ? 'var(--text-emphasis, #343a40)' : 'var(--text-strong, #111827)',
            textWrap: 'pretty',
            ...(dense ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : null),
          }}
        >
          {title}
        </span>
        {meta != null && (
          <span data-disclosure-meta="" style={{ fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5a6268)', lineHeight: 'var(--line-height-normal, 1.5)' }}>
            {meta}
          </span>
        )}
      </span>
      {trailing != null && (
        <span
          data-disclosure-trailing=""
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-2, 8px)',
            fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)',
            fontSize: 'var(--font-size-dense, 13px)',
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--text-data, #495057)',
            whiteSpace: 'nowrap',
          }}
        >
          {trailing}
        </span>
      )}
      {action != null && (
        /* The action words restate aria-expanded for sighted readers; hidden from the
           accessible name so the button keeps one stable name as it toggles. */
        <span
          data-disclosure-action=""
          aria-hidden="true"
          style={{
            fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
            fontSize: 'var(--font-size-xs, 12px)',
            fontWeight: 600,
            color: 'var(--text-link-on-tint, #00688f)',
            whiteSpace: 'nowrap',
          }}
        >
          {action}
        </span>
      )}
      <i
        className={'bi ' + (open ? 'bi-chevron-down' : 'bi-chevron-right')}
        aria-hidden="true"
        style={{ justifySelf: 'center', fontSize: 'var(--font-size-xs, 12px)', color: disabled ? 'var(--text-secondary, #5a6268)' : dense ? 'var(--text-emphasis, #343a40)' : undefined }}
      />
    </button>
  );

  const head = hasActions ? (
    <div
      data-disclosure-head=""
      style={{
        display: 'flex',
        alignItems: 'stretch',
        borderBottom: framedOpenRow ? '1px solid var(--border-color, #dee2e6)' : undefined,
        borderRadius: headRadius,
        background: framedOpenRow ? 'var(--surface-secondary, #f8f9fa)' : sticky ? 'var(--surface-card, #fff)' : undefined,
        ...band,
        ...stick,
      }}
    >
      {header}
      <div
        data-disclosure-actions=""
        style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 'var(--space-2, 8px)', padding: dense ? '0 10px 0 6px' : '0 var(--space-3, 12px) 0 var(--space-4, 16px)' }}
      >
        {actions}
      </div>
    </div>
  ) : header;

  return (
    <div
      data-disclosure=""
      data-open={open ? '' : undefined}
      data-tone={tone || undefined}
      data-framed={framed ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      data-density={dense ? 'dense' : undefined}
      data-sticky={sticky ? '' : undefined}
      style={{
        ...(framed ? {
          border: '1px solid var(--border-color, #dee2e6)',
          borderRadius: 'var(--radius-md, 5px)',
          background: 'var(--surface-card, #fff)',
        } : { borderBottom: divider && !dense ? '1px solid var(--list-divider, #e9ecef)' : undefined }),
        ...(rail ? { borderLeft: '3px solid ' + rail } : {}),
        ...style,
      }}
      {...rest}
    >
      {head}
      <div
        id={regionId}
        role={region ? 'region' : undefined}
        aria-labelledby={region ? headerId : undefined}
        hidden={!open}
        data-disclosure-region=""
        style={{ padding: framed ? 'var(--space-3, 12px)' : dense ? 0 : '0 var(--space-4, 16px) var(--space-4, 16px) ' + padStart }}
      >
        {open ? detail : null}
      </div>
    </div>
  );
}
