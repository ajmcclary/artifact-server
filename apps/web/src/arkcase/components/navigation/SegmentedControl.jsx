import React from 'react';

/**
 * ArkCase SegmentedControl — two to four mutually exclusive views of one surface
 * (Open / Closed / All, Employee / Employer report, Month / Week / Day). The
 * selected segment fills with the tertiary teal, not the primary cyan: the
 * control is a view switch, not the page's action.
 *
 * `variant="pill"` is the dense tool-chrome look: a tertiary-surface track with pill
 * segments, the selected one filled with the primary blue. `size="sm"` gives 20–24px
 * segments. Options may carry an icon (`bi-*`), a data-font count, a tooltip, a shortcut
 * hint and native `disabled`; an icon-only option takes its name from `ariaLabel`.
 *
 * `mode="radio"` exposes the control as an APG radio group: one tab stop (the checked
 * segment), arrow keys move and select (wrapping, skipping disabled), Home/End jump; the
 * handler stops propagation so a host's roving handler does not move the same press twice.
 *
 * `variant="chip"` draws each option as a separate 28px bordered pill (Tag's toggle-chip
 * look: the selected one takes the primary tint, border and ink) in a row that wraps —
 * the picker chips of a settings card, where more than four short options are fine.
 * `wrap` lets any variant's row wrap (chip wraps by default).
 *
 * An option's `glyph` is a small drawn picture in the icon's place — the Dashboard column
 * picker's bar drawings — as a node or a `(selected) => node` function; it is aria-hidden
 * and paints best in `currentColor`, so it follows the segment's ink.
 *
 * For navigation between sections use Tabs; for a filter with more than four
 * options use Select.
 */
const RADIO_KEYS = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];

export function SegmentedControl({ options = [], value, onChange, block = false, label, variant = 'bordered', size = 'md', mode = 'toggle', wrap, style, ...rest }) {
  const [internal, setInternal] = React.useState(value ?? (options[0] && (options[0].id ?? options[0])));
  const [hover, setHover] = React.useState(null);
  const cur = value !== undefined ? value : internal;
  const pill = variant === 'pill';
  const chip = variant === 'chip';
  const wraps = wrap == null ? chip : !!wrap;
  const sm = size === 'sm';
  const radio = mode === 'radio';

  const select = (id) => { if (value === undefined) setInternal(id); onChange && onChange(id); };

  // Roving tab stop for radio mode: the checked enabled segment, else the first enabled one.
  const ids = options.map((o) => o.id ?? o);
  const enabled = options.map((o) => !(o && typeof o === 'object' && o.disabled));
  let tabStop = ids.findIndex((id, i) => id === cur && enabled[i]);
  if (tabStop < 0) tabStop = enabled.indexOf(true);

  const onKeyDown = (e) => {
    if (!radio || RADIO_KEYS.indexOf(e.key) < 0) return;
    const buttons = Array.from(e.currentTarget.querySelectorAll('[role="radio"]:not([disabled])'));
    if (!buttons.length) return;
    e.preventDefault();
    e.stopPropagation();
    const at = Math.max(0, buttons.indexOf(document.activeElement));
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
      : (at + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
    buttons[next].click();
  };

  const rootStyle = chip
    ? {
        display: block ? 'flex' : 'inline-flex',
        width: block ? '100%' : undefined,
        alignItems: 'center',
        gap: 6,
      }
    : pill
    ? {
        display: block ? 'flex' : 'inline-flex',
        width: block ? '100%' : undefined,
        gap: 2, padding: 2,
        background: 'var(--surface-tertiary, #e9ecef)',
        borderRadius: 'var(--radius-pill, 10px)',
        boxSizing: 'border-box',
      }
    : {
        display: block ? 'flex' : 'inline-flex',
        width: block ? '100%' : undefined,
        border: '1px solid var(--border-color, #dee2e6)',
        borderRadius: 'var(--radius-md, 5px)',
        overflow: 'hidden',
      };

  return (
    <div
      role={radio ? 'radiogroup' : 'group'}
      aria-label={label}
      onKeyDown={radio ? onKeyDown : undefined}
      data-variant={chip ? 'chip' : undefined}
      style={{ ...rootStyle, ...(wraps ? { flexWrap: 'wrap', maxWidth: '100%' } : null), ...style }}
      {...rest}
    >
      {options.map((o, i) => {
        const obj = o && typeof o === 'object' ? o : null;
        const id = ids[i];
        const on = id === cur;
        const text = obj ? obj.label : o;
        const hasText = text != null && text !== '';
        const iconOnly = !!(obj && obj.icon) && !hasText;
        const disabled = !!(obj && obj.disabled);
        const hasCount = !!obj && obj.count != null && obj.count !== '';
        const hasGlyph = !!obj && obj.glyph != null && obj.glyph !== false;
        const rich = !!obj && (obj.icon || hasCount || hasGlyph);

        const onBg = pill ? 'var(--bs-primary, #0079a8)' : 'var(--bs-tertiary, #005a7d)';
        const offBg = pill ? 'transparent' : 'var(--surface-card, #fff)';
        const offFg = pill ? 'var(--text-secondary, #5a6268)' : 'var(--text-data, #495057)';
        const padding = iconOnly ? 0 : sm ? '4px 10px' : '6px 12px';

        const segStyle = {
          flex: block || !pill ? 1 : 'none',
          padding,
          font: 'inherit', fontSize: 'var(--font-size-xs, 12px)', fontWeight: 600,
          letterSpacing: 'var(--letter-spacing-wide, 0.025em)',
          border: 'none',
          borderLeft: !pill && !chip && i > 0 ? '1px solid var(--border-color, #dee2e6)' : 'none',
          background: on ? onBg : offBg,
          color: on ? 'var(--text-on-primary, #fff)' : offFg,
          cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
          transition: 'background-color .15s ease, color .15s ease',
        };
        if (pill) {
          segStyle.borderRadius = 'var(--radius-pill, 10px)';
          if (hover === i && !on && !disabled) segStyle.boxShadow = 'inset 0 0 0 1px var(--border-color-strong, #ced4da)';
        }
        if (chip) {
          const lit = on || (hover === i && !disabled);
          delete segStyle.borderLeft;
          Object.assign(segStyle, {
            flex: block ? 1 : 'none',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            minHeight: sm ? 24 : 28, boxSizing: 'border-box',
            padding: iconOnly ? 0 : sm ? '0 8px' : '0 10px',
            minWidth: iconOnly ? (sm ? 24 : 28) : undefined,
            letterSpacing: 'normal',
            fontWeight: on ? 600 : 500,
            border: `1px solid ${lit ? 'var(--bs-primary, #0079a8)' : 'var(--border-color-strong, #ced4da)'}`,
            borderRadius: sm ? 12 : 14,
            background: on ? 'var(--tint-primary-selected, rgba(0,121,168,.10))' : 'var(--surface-card, #fff)',
            color: lit ? 'var(--text-link-hover, #005a7d)' : 'var(--text-body, #212529)',
            transition: 'background-color .15s ease, border-color .15s ease, color .15s ease',
          });
        }
        if (sm && !chip) segStyle.lineHeight = 1.2;
        if (rich && !chip) Object.assign(segStyle, { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 });
        if (iconOnly && !chip) Object.assign(segStyle, { minWidth: sm ? 32 : 36, minHeight: sm ? 24 : 30, lineHeight: 1, fontSize: sm ? 'var(--font-size-dense, 13px)' : 'var(--icon-sm, 14px)' });
        if (disabled) segStyle.opacity = 0.5;

        return (
          <button
            key={i}
            type="button"
            role={radio ? 'radio' : undefined}
            aria-checked={radio ? on : undefined}
            aria-pressed={radio ? undefined : on}
            tabIndex={radio ? (i === tabStop ? 0 : -1) : undefined}
            aria-label={obj && obj.ariaLabel ? obj.ariaLabel : undefined}
            aria-keyshortcuts={obj && obj.keys ? obj.keys : undefined}
            title={obj && obj.title ? obj.title : undefined}
            disabled={disabled || undefined}
            data-icon-tone={obj && obj.icon && on && !chip ? 'current' : undefined}
            onClick={() => select(id)}
            onMouseEnter={pill || chip ? () => setHover(i) : undefined}
            onMouseLeave={pill || chip ? () => setHover(null) : undefined}
            style={segStyle}
          >
            {obj && obj.icon && <i className={`bi ${obj.icon}`} aria-hidden="true" style={iconOnly ? undefined : { fontSize: chip ? 'var(--icon-sm, 14px)' : 'var(--icon-xs, 12px)' }} />}
            {hasGlyph && (
              <span aria-hidden="true" data-segment-glyph="" style={{ display: 'inline-flex', alignItems: 'center', flex: 'none', lineHeight: 0 }}>
                {typeof obj.glyph === 'function' ? obj.glyph(on) : obj.glyph}
              </span>
            )}
            {hasText ? text : null}
            {hasCount && !chip && ' '}
            {hasCount && (
              <span style={{ fontFamily: 'var(--font-data, "Source Code Pro", monospace)', fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)', fontSize: 'var(--font-size-label, 11px)', fontWeight: chip ? 400 : 600, color: chip ? 'var(--text-secondary, #5a6268)' : undefined }}>{obj.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
