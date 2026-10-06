import React from 'react';

/* Static fills by tone. `default` is the quiet hairline token chip; `navy` is the solid
   form-code chip on header navy; the status tones use the pill pairs. */
const TAG_TONES = {
  default: { bg: 'var(--surface-canvas, #f1f5f7)', border: 'var(--border-color, #dee2e6)', fg: 'var(--text-data, #495057)', remove: 'var(--text-secondary, #5a6268)' },
  primary: { bg: 'var(--tint-primary-selected, rgba(0,121,168,.10))', border: 'color-mix(in srgb, var(--bs-primary, #0079a8) 35%, transparent)', fg: 'var(--text-link-hover, #005a7d)', remove: 'var(--text-link-hover, #005a7d)' },
  navy: { bg: 'var(--surface-header, #073652)', border: 'var(--surface-header, #073652)', fg: 'var(--text-on-navy, #ffffff)', remove: 'var(--text-on-navy, #ffffff)' },
  success: { bg: 'var(--pill-success-bg, #dcfce7)', border: 'var(--pill-success-border, #a7e3ba)', fg: 'var(--pill-success-fg, #15803d)', remove: 'var(--pill-success-fg, #15803d)' },
  warning: { bg: 'var(--pill-warning-bg, #fef3c7)', border: 'var(--pill-warning-border, #ffd894)', fg: 'var(--pill-warning-fg, #92400e)', remove: 'var(--pill-warning-fg, #92400e)' },
  danger: { bg: 'var(--pill-danger-bg, #fee2e2)', border: 'var(--pill-danger-border, #f5c2bd)', fg: 'var(--pill-danger-fg, #991b1b)', remove: 'var(--pill-danger-fg, #991b1b)' },
};

const DATA_FACE = 'var(--font-data, "Source Code Pro", ui-monospace, monospace)';
const BODY_FACE = 'var(--font-body, "Public Sans", system-ui, sans-serif)';

function present(v) { return v != null && v !== false && v !== ''; }

/* The trailing × of a removable tag. `large` is the 22px target of a chip that carries a
   meta line or sits in a toggle row; the quiet token tag keeps its 16px button. */
function RemoveButton({ name, onRemove, color, large }) {
  const [ring, setRing] = React.useState(false);
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      aria-label={name}
      title={name}
      onClick={onRemove}
      onFocus={(e) => setRing(!e.currentTarget.matches || e.currentTarget.matches(':focus-visible'))}
      onBlur={() => setRing(false)}
      onMouseEnter={large ? () => setHover(true) : undefined}
      onMouseLeave={large ? () => setHover(false) : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        width: large ? 22 : 16,
        height: large ? 22 : 16,
        margin: 0,
        padding: 0,
        border: 0,
        borderRadius: large ? 'var(--radius-pill, 10px)' : 'var(--radius-circle, 50%)',
        background: large && hover ? 'var(--tint-danger-selected, rgba(216,53,6,.10))' : 'transparent',
        color: large && hover ? 'var(--pill-danger-fg, #991b1b)' : color,
        fontSize: large ? 'var(--icon-xs, 12px)' : 9,
        lineHeight: 1,
        cursor: 'pointer',
        outline: ring ? 'var(--focus-outline, 2px solid #0079a8)' : 'none',
        outlineOffset: 1,
      }}
    >
      <i className="bi bi-x-lg" aria-hidden="true" />
    </button>
  );
}

/**
 * ArkCase Tag — a quiet token chip for a literal value: a client name, a tool
 * id, a file type, a keyword. Data face (`font-data`, 11px, `text-data`) on the
 * canvas tint inside a hairline pill. Wrap several in a flex-wrap row.
 * `onRemove` adds a trailing × button named "Remove {value}" (or `removeLabel`); TagInput
 * builds its value list from removable tags.
 *
 * `tone` repaints a static tag: `primary` (the tinted applied-filter or record-tag chip),
 * `navy` (the solid form-code chip), `success` / `warning` / `danger` (pill pairs). `meta`
 * adds a secondary line under the label (who added a tag, and when).
 *
 * `onClick` makes the tag a toggle or action chip: a native button (with `aria-pressed`
 * when `pressed` is defined) inside a 28px pill (24px at `size="sm"`) — the filter,
 * saved-view, suggestion and legend chip. Pressed paints the primary tint and border; a
 * series `color` (or `dot`) instead tints the pressed chip with that colour through
 * `color-mix()` behind a leading dot, and leaves the unpressed chip neutral with a hollow dot.
 * `icon` and a data-face `count` sit beside the label. A removable chip keeps its × as a
 * sibling button, never nested in the chip button.
 *
 * `variant="dashed"` draws the outline-only chip for something provisional or folded into
 * another item (the Admin "merged" chip): a transparent ground inside a 1px dashed border
 * (`bs-gray-500` for the default tone, the tone's border otherwise) with secondary ink.
 */
export function Tag({
  children, mono, title, onRemove, removeLabel, style,
  tone = 'default', variant = 'solid', onClick, pressed, disabled = false, icon, iconRight, dot: dotProp, color, count, meta, size = 'md',
  ...rest
}) {
  // `color` is the series colour of a legend chip; `dot` is the same thing by its older name.
  const dot = color != null && color !== '' ? color : dotProp;
  const removable = typeof onRemove === 'function';
  const interactive = typeof onClick === 'function';
  const hasMeta = present(meta);
  const hasCount = present(count);
  const hasDot = present(dot);
  const name = removeLabel || (typeof children === 'string' || typeof children === 'number' ? 'Remove ' + children : 'Remove');
  const dataFace = mono == null ? !(interactive || hasMeta) : !!mono;
  const dashed = variant === 'dashed';
  const base = TAG_TONES[tone] || TAG_TONES.default;
  const t = dashed
    ? { ...base, bg: 'transparent', border: tone === 'default' || !TAG_TONES[tone] ? 'var(--bs-gray-500, #adb5bd)' : base.border, fg: tone === 'default' || tone === 'navy' || !TAG_TONES[tone] ? 'var(--text-secondary, #5a6268)' : base.fg, remove: 'var(--text-secondary, #5a6268)' }
    : base;
  const borderStyle = dashed ? 'dashed' : 'solid';
  const [hover, setHover] = React.useState(false);
  const [ring, setRing] = React.useState(false);

  const iconNode = icon ? <i className={`bi ${icon}`} aria-hidden="true" style={{ fontSize: 'var(--icon-sm, 14px)', flex: 'none' }} /> : null;
  const trailingIcon = iconRight ? <i className={`bi ${iconRight}`} aria-hidden="true" data-tag-icon-right="" style={{ fontSize: 'var(--icon-xs, 12px)', opacity: 0.6, flex: 'none' }} /> : null;
  const countNode = hasCount ? (
    <span data-tag-count="" style={{
      fontFamily: DATA_FACE,
      fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)',
      fontSize: 'var(--font-size-label, 11px)',
      fontWeight: 400,
      color: 'var(--text-secondary, #5a6268)',
      flex: 'none',
    }}>{count}</span>
  ) : null;

  if (interactive) {
    const on = pressed === true;
    const sm = size === 'sm';
    let bg = 'var(--surface-card, #fff)';
    let border = 'var(--border-color-strong, #ced4da)';
    let fg = 'var(--text-body, #212529)';
    if (hasDot) {
      // Legend chip: tinted with its own series colour while shown, quiet and hollow while hidden.
      if (on || pressed === undefined) {
        bg = `color-mix(in srgb, ${dot} 8%, var(--surface-card, #fff))`;
        border = `color-mix(in srgb, ${dot} 25%, var(--surface-card, #fff))`;
      } else {
        border = 'var(--border-color, #dee2e6)';
        fg = 'var(--text-secondary, #5a6268)';
      }
    } else if (on) {
      bg = 'var(--tint-primary-selected, rgba(0,121,168,.10))';
      border = 'var(--bs-primary, #0079a8)';
      fg = 'var(--text-link-hover, #005a7d)';
    }
    if (hover && !disabled) {
      border = 'var(--bs-primary, #0079a8)';
      if (!hasDot) fg = 'var(--text-link-hover, #005a7d)';
    }
    const dotNode = hasDot ? (
      <span aria-hidden="true" data-tag-dot="" style={{
        width: 8, height: 8, flex: 'none', borderRadius: 'var(--radius-circle, 50%)',
        background: on || pressed === undefined ? dot : 'transparent',
        boxShadow: on || pressed === undefined ? 'none' : 'inset 0 0 0 1.5px var(--border-color-strong, #ced4da)',
      }} />
    ) : null;
    return (
      <span
        data-tag="chip"
        data-pressed={on ? '' : undefined}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          maxWidth: '100%',
          minHeight: sm ? 24 : 28,
          boxSizing: 'border-box',
          padding: removable ? '0 3px 0 0' : 0,
          border: `var(--border-width, 1px) ${borderStyle} ${border}`,
          borderRadius: sm ? 12 : 14,
          background: bg,
          color: fg,
          opacity: disabled ? 0.65 : 1,
          outline: ring ? 'var(--focus-outline, 2px solid #0079a8)' : 'none',
          outlineOffset: 'var(--focus-outline-offset, 2px)',
          transition: 'background-color var(--transition-fast, .15s ease), border-color var(--transition-fast, .15s ease), color var(--transition-fast, .15s ease)',
          ...style,
        }}
      >
        <button
          type="button"
          title={title}
          aria-pressed={pressed === undefined ? undefined : !!pressed}
          disabled={disabled}
          onClick={onClick}
          onFocus={(e) => setRing(!e.currentTarget.matches || e.currentTarget.matches(':focus-visible'))}
          onBlur={() => setRing(false)}
          {...rest}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: hasDot ? 8 : 6,
            minWidth: 0,
            minHeight: sm ? 22 : 26,
            margin: 0,
            padding: sm ? '0 8px' : (hasDot ? '0 10px 0 8px' : '0 10px'),
            paddingRight: removable ? 2 : undefined,
            border: 0,
            borderRadius: 'inherit',
            background: 'transparent',
            color: 'inherit',
            fontFamily: dataFace ? DATA_FACE : BODY_FACE,
            fontSize: dataFace ? 'var(--font-size-label, 11px)' : 'var(--font-size-xs, 12px)',
            fontWeight: on && !hasDot ? 600 : 500,
            lineHeight: 1.5,
            whiteSpace: 'nowrap',
            cursor: disabled ? 'not-allowed' : 'pointer',
            outline: 'none',
          }}
        >
          {dotNode}
          {iconNode}
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{children}</span>
          {countNode}
          {trailingIcon}
        </button>
        {removable && <RemoveButton name={name} onRemove={onRemove} color="var(--text-secondary, #5a6268)" large />}
      </span>
    );
  }

  const navy = tone === 'navy' && !dashed;
  const label = hasMeta ? (
    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <span style={{ fontSize: 'var(--font-size-dense, 13px)', fontWeight: 600, lineHeight: 'var(--line-height-tight, 1.25)', color: tone === 'default' ? 'var(--text-body, #212529)' : t.fg }}>{children}</span>
      <span data-tag-meta="" style={{ fontFamily: BODY_FACE, fontSize: 'var(--font-size-label, 11px)', fontWeight: 400, color: navy ? 'var(--text-on-navy-secondary, rgba(255,255,255,.72))' : 'var(--text-secondary, #5a6268)' }}>{meta}</span>
    </span>
  ) : children;
  const toned = tone !== 'default';
  return (
    <span
      title={title}
      data-tag={toned ? tone : undefined}
      data-tag-variant={dashed ? 'dashed' : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        maxWidth: '100%',
        boxSizing: 'border-box',
        padding: hasMeta
          ? (removable ? '6px 8px 6px 12px' : '6px 12px')
          : removable ? '1px 2px 1px var(--space-2, 8px)' : '2px var(--space-2, 8px)',
        gap: hasMeta ? 8 : (removable || iconNode || countNode || hasDot || trailingIcon) ? (removable && !iconNode && !countNode && !hasDot && !trailingIcon ? 2 : 4) : undefined,
        border: `var(--border-width, 1px) ${borderStyle} ${t.border}`,
        borderRadius: navy ? 'var(--radius-sm, 4px)' : 'var(--radius-pill, 10px)',
        background: t.bg,
        color: t.fg,
        fontFamily: dataFace ? DATA_FACE : BODY_FACE,
        fontVariantNumeric: dataFace ? 'var(--font-numeric-feature, tabular-nums)' : undefined,
        fontSize: navy
          ? 'var(--font-size-xs, 12px)'
          : dataFace ? 'var(--font-size-label, 11px)' : 'var(--font-size-xs, 12px)',
        fontWeight: navy ? 600 : toned && !hasMeta ? 500 : undefined,
        lineHeight: 'var(--line-height-tight, 1.25)',
        overflowWrap: 'anywhere',
        ...style,
      }}
      {...rest}
    >
      {hasDot && <span aria-hidden="true" data-tag-dot="" style={{ width: 8, height: 8, flex: 'none', borderRadius: 'var(--radius-circle, 50%)', background: dot }} />}
      {iconNode}
      {label}
      {countNode}
      {trailingIcon}
      {removable && <RemoveButton name={name} onRemove={onRemove} color={t.remove} large={hasMeta} />}
    </span>
  );
}
