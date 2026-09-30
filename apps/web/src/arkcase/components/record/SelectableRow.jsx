import React from 'react';

/* Persistent status rail colours for `tone`. The rail is a 3px mark, not text. */
const RAIL_TONES = {
  success: 'var(--bs-success, #00b532)',
  danger:  'var(--bs-danger, #d83506)',
  warning: 'var(--bs-warning, #ff9a15)',
  primary: 'var(--bs-primary, #0079a8)',
  neutral: 'var(--border-color-strong, #ced4da)',
  info:    'var(--bs-info, #0a7a90)',
  muted:   'var(--bs-gray-500, #adb5bd)',
};

/**
 * ArkCase SelectableRow — the one selectable list row. Selection is a 3px left rail that is
 * always present and transparent at rest, so selecting never shifts text, plus the 10% primary
 * tint; interaction is a button's: focusable, Enter and Space select, Space never scrolls. A
 * row's body is the caller's. Arrow keys between rows belong to the list, not the row.
 * `disabled` drops the role and the tab stop and says so. `rail={false}` for a row inside a
 * component that draws its own rail. Harvested from the ExtractionKit list panels, where five
 * screens had rebuilt it.
 *
 * `tone` (or a literal `railColor`) makes the rail persistent: it carries the row's status
 * whether or not the row is selected, and selection is then read from the tint and
 * aria-current alone. An interactive, enabled, unselected row takes the 5% hover wash;
 * `hover={false}` opts out. `as="button"` renders a native button: no role, no tabIndex, no key
 * handler — the element already has them — and native `disabled`.
 */
export function SelectableRow({ selected, onSelect, disabled, as = 'div', label, padding = '10px 16px', rail = true, tone, railColor, hover = true, style, children, ...rest }) {
  const Tag = as;
  /* The 5% hover wash, only on a row that answers a click: interactive, enabled, not already
     carrying the 10% selected wash. Tracked in state because an inline style has no :hover. */
  const [pointed, setPointed] = React.useState(false);
  const { onMouseEnter, onMouseLeave } = rest;
  const hoverable = hover && !disabled && !selected && !!(onSelect || rest.onClick);
  const washed = hoverable && pointed;
  const native = as === 'button';
  const status = railColor || (tone ? RAIL_TONES[tone] || RAIL_TONES.neutral : null);
  const railPaint = status || (selected ? 'var(--list-rail, #0079a8)' : 'transparent');
  const act = (e) => { if (!disabled && onSelect) onSelect(e); };
  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(e); }
  };
  return (
    <Tag
      type={native ? 'button' : undefined}
      disabled={native && disabled ? true : undefined}
      role={native || disabled ? undefined : 'button'}
      tabIndex={native || disabled ? undefined : 0}
      aria-disabled={!native && disabled ? 'true' : undefined}
      aria-current={selected ? 'true' : undefined}
      aria-label={label}
      data-selectable-row=""
      data-selected={selected ? '' : undefined}
      data-row-tone={tone || undefined}
      onClick={act}
      onKeyDown={native || disabled ? undefined : onKeyDown}
      data-hovered={washed ? '' : undefined}
      style={{
        padding,
        borderBottom: '1px solid var(--bs-light, #f1f5f7)',
        ...(native ? { display: 'block', width: '100%', margin: 0, borderTop: 0, borderRight: 0, borderLeft: 0, font: 'inherit', color: 'inherit', textAlign: 'left' } : null),
        borderLeft: rail ? '3px solid ' + railPaint : undefined,
        background: selected ? 'var(--tint-primary-selected, rgba(0,121,168,.10))' : washed ? 'var(--tint-primary-hover, rgba(0,121,168,.05))' : native ? 'transparent' : undefined,
        cursor: onSelect && !disabled ? 'pointer' : undefined,
        ...style,
      }}
      {...rest}
      onMouseEnter={(e) => { setPointed(true); if (onMouseEnter) onMouseEnter(e); }}
      onMouseLeave={(e) => { setPointed(false); if (onMouseLeave) onMouseLeave(e); }}
    >
      {children}
    </Tag>
  );
}
