import { akStyleDocument } from '@/arkcase-style';
import React from 'react';
import { Button } from '../actions/Button.jsx';
import { Eyebrow } from '../data-display/Eyebrow.jsx';

/* Focus outline and the resting hover live in a sheet (not inline) so :focus-visible and
   :hover can apply; injected once per document, scoped by data attributes. */
function ensureChoiceGroupStyles() {
  if (typeof document === 'undefined' || akStyleDocument.getElementById('ak-choice-group-css')) return;
  const s = akStyleDocument.createElement('style');
  s.id = 'ak-choice-group-css';
  s.textContent =
    '[data-ak-choice-radio]{outline:none}' +
    '[data-ak-choice-radio]:focus-visible{outline:var(--focus-outline, 2px solid #0079a8);outline-offset:var(--focus-outline-offset, 2px)}' +
    '[data-ak-choice-variant="row"] [data-ak-choice-radio]:focus-visible{outline-offset:-2px}' +
    '[data-ak-choice-option]:not([data-checked]):not([data-disabled]):hover{background:var(--tint-primary-hover, rgba(0,121,168,.05))}';
  akStyleDocument.head.appendChild(s);
}

const CHOICE_GROUP_KEYS = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

/**
 * ArkCase ChoiceGroup — one choice from a short list, drawn as cards or rows rather than
 * bare radios, because each choice carries a title, an identifier, a sentence and
 * sometimes its own follow-up controls. A `role="radiogroup"` of `role="radio"` items with
 * a roving tab stop: the arrow keys move focus only, Space or Enter selects. Nothing is
 * pre-picked — `value` may be null, and focusing an option never selects it — so a form
 * that must not choose a safety posture on the reader's behalf can use it as is.
 *
 * Each option draws `bi-record-circle-fill` when checked and `bi-circle` otherwise, a
 * `bs-primary` border (card) or 3px left rail (row), and `tint-primary-selected`. An
 * option's `detail` renders under it only while it is checked, outside the radio, so it
 * may hold controls of its own. `groups` adds labelled runs after the ungrouped options;
 * `clearable` adds an Unchoose button once something is chosen.
 *
 * `multiple` turns the group into a `role="group"` of `role="checkbox"` items: `value` is
 * an array of ids, each option is its own tab stop, Space toggles it, and the glyph is a
 * 16px check box. An option's `icon` (`bi-*`) sits above the title on a card, before it
 * in a row; an option's `preview` (a small decorative sketch) takes the icon's place — full
 * width above the title and glyph on a card, before the title in a row. `minColumnWidth` lays the options out in an auto-fill grid of columns at least
 * that wide (settings check cards, a role picker).
 */
export function ChoiceGroup({
  label,
  options = [],
  groups,
  value = null,
  onChange,
  variant = 'card',
  clearable = false,
  clearLabel = 'Unchoose',
  multiple = false,
  minColumnWidth,
  style,
  ...rest
}) {
  React.useEffect(ensureChoiceGroupStyles, []);
  const base = 'cg-' + React.useId().replace(/[^A-Za-z0-9_-]/g, '');
  const row = variant === 'row';
  const all = options.concat(...(groups || []).map((g) => g.options || []));
  const enabled = all.filter((o) => !o.disabled);
  const [focusId, setFocusId] = React.useState(null);
  const refs = React.useRef({});

  const chosen = multiple ? (Array.isArray(value) ? value : value != null ? [value] : []) : null;
  const isOn = (o) => (multiple ? chosen.indexOf(o.id) > -1 : value != null && o.id === value);
  const checkedOption = multiple ? null : all.find((o) => value != null && o.id === value && !o.disabled);
  const stop = (focusId != null && enabled.some((o) => o.id === focusId) && focusId)
    || (checkedOption && checkedOption.id)
    || (enabled[0] && enabled[0].id);

  /* The Unchoose button leaves with the choice; focus returns to the group's tab stop. */
  const refocus = React.useRef(false);
  React.useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const el = stop != null && refs.current[stop];
    if (el) el.focus();
  });
  const clear = () => { refocus.current = true; if (onChange) onChange(multiple ? [] : null, null); };

  const choose = (o) => {
    if (o.disabled || !onChange) return;
    if (multiple) {
      onChange(chosen.indexOf(o.id) > -1 ? chosen.filter((id) => id !== o.id) : chosen.concat(o.id), o);
      return;
    }
    if (o.id !== value) onChange(o.id, o);
  };

  const onKeyDown = (e, o) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (multiple) {
      if (e.key === ' ') { e.preventDefault(); choose(o); }
      return;
    }
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); choose(o); return; }
    const step = CHOICE_GROUP_KEYS[e.key];
    const at = enabled.findIndex((x) => x.id === o.id);
    let next = null;
    if (step) next = enabled[(at + step + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault();
    setFocusId(next.id);
    const el = refs.current[next.id];
    if (el) el.focus();
  };

  const renderOption = (o) => {
    const on = isOn(o);
    const off = !!o.disabled;
    const id = base + '-' + String(o.id).replace(/[^A-Za-z0-9_-]/g, '_');
    const hasDesc = o.description != null && o.description !== '';
    const hasMeta = o.meta != null && o.meta !== '';
    const ink = off ? 'var(--text-disabled, #adb5bd)' : 'var(--text-emphasis, #374151)';
    const shell = row ? {
      borderBottom: '1px solid var(--list-divider, #e9ecef)',
      borderLeft: '3px solid ' + (on ? 'var(--bs-primary, #0079a8)' : 'transparent'),
      background: on ? 'var(--tint-primary-selected, rgba(0,121,168,.10))' : undefined,
    } : {
      border: '1px solid ' + (on ? 'var(--bs-primary, #0079a8)' : 'var(--border-color, #dee2e6)'),
      borderRadius: 'var(--radius-md, 5px)',
      background: on ? 'var(--tint-primary-selected, rgba(0,121,168,.10))' : 'var(--surface-card, #fff)',
    };
    const { style: optStyle, ...optProps } = o.props || {};
    /* A preview is decorative and replaces the icon: full width over the card's glyph and
       text, or a leading sketch in a row's title line. */
    const hasPreview = o.preview != null && o.preview !== false;
    const cardPreview = hasPreview && !row;
    const showIcon = o.icon && !hasPreview;
    return (
      <div
        key={o.id}
        data-ak-choice-option=""
        data-checked={on ? '' : undefined}
        data-disabled={off ? '' : undefined}
        style={{ ...shell, transition: 'background-color var(--transition-fast, 0.15s ease), border-color var(--transition-fast, 0.15s ease)' }}
      >
        <div
          ref={(el) => { refs.current[o.id] = el; }}
          role={multiple ? 'checkbox' : 'radio'}
          aria-checked={on ? 'true' : 'false'}
          aria-disabled={off ? 'true' : undefined}
          aria-labelledby={id + '-title' + (hasMeta ? ' ' + id + '-meta' : '')}
          aria-describedby={hasDesc ? id + '-desc' : undefined}
          tabIndex={multiple ? (off ? -1 : 0) : o.id === stop ? 0 : -1}
          data-ak-choice-radio=""
          onClick={() => choose(o)}
          onKeyDown={(e) => onKeyDown(e, o)}
          onFocus={() => setFocusId(o.id)}
          {...optProps}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: row ? 'var(--space-2, 8px)' : 10,
            padding: row ? '10px var(--space-3, 12px)' : '10px var(--space-3, 12px)',
            borderRadius: row ? undefined : 'var(--radius-md, 5px)',
            cursor: off ? 'not-allowed' : 'pointer',
            ...(cardPreview ? { flexDirection: 'column', alignItems: 'stretch', gap: 6 } : null),
            ...optStyle,
          }}
        >
          {cardPreview && (
            <span aria-hidden="true" data-ak-choice-preview="" style={{ display: 'block', width: '100%', minWidth: 0, opacity: off ? 0.5 : 1 }}>
              {o.preview}
            </span>
          )}
          {/* Under a card preview the glyph and text share their own row; otherwise they sit
              directly in the radio, exactly as before. */}
          {React.createElement(cardPreview ? 'span' : React.Fragment, cardPreview ? { style: { display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0 } } : null,
          multiple ? (
            <span
              aria-hidden="true"
              data-ak-choice-box=""
              style={{
                flex: 'none', boxSizing: 'border-box', width: 16, height: 16, marginTop: 2,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 3,
                border: '1px solid ' + (off ? 'var(--border-color, #dee2e6)' : on ? 'var(--bs-primary, #0079a8)' : 'var(--border-color-strong, #ced4da)'),
                background: on ? (off ? 'var(--text-disabled, #adb5bd)' : 'var(--bs-primary, #0079a8)') : 'var(--surface-card, #fff)',
              }}
            >
              {on && <i className="bi bi-check-lg" style={{ fontSize: 'var(--icon-xs, 12px)', color: 'var(--text-on-primary, #fff)', lineHeight: 1 }} />}
            </span>
          ) : (
            <i
              aria-hidden="true"
              className={'bi ' + (on ? 'bi-record-circle-fill' : 'bi-circle')}
              style={{
                flex: 'none',
                marginTop: 3,
                fontSize: 'var(--icon-sm, 14px)',
                color: off ? 'var(--text-disabled, #adb5bd)' : on ? 'var(--bs-primary, #0079a8)' : 'var(--text-secondary, #5a6268)',
              }}
            />
          ),
          <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {showIcon && !row && (
              <i aria-hidden="true" data-ak-choice-icon="" className={'bi ' + o.icon} style={{ fontSize: 'var(--icon-lg, 20px)', lineHeight: 1, marginBottom: 4, opacity: off ? 0.5 : 1 }} />
            )}
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2, 8px)', flexWrap: 'wrap' }}>
              {showIcon && row && (
                <i aria-hidden="true" data-ak-choice-icon="" className={'bi ' + o.icon} style={{ flex: 'none', fontSize: 'var(--icon-sm, 14px)', alignSelf: 'center', opacity: off ? 0.5 : 1 }} />
              )}
              {hasPreview && row && (
                <span aria-hidden="true" data-ak-choice-preview="" style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', alignSelf: 'center', opacity: off ? 0.5 : 1 }}>
                  {o.preview}
                </span>
              )}
              <span
                id={id + '-title'}
                style={{
                  flex: row ? '1 1 auto' : undefined,
                  minWidth: 0,
                  fontSize: row ? 'var(--font-size-dense, 13px)' : 'var(--font-size-sm, 14px)',
                  fontWeight: row ? 600 : 400,
                  lineHeight: 'var(--line-height-normal, 1.5)',
                  color: row ? ink : off ? ink : 'var(--text-body, #212529)',
                  overflowWrap: 'anywhere',
                }}
              >
                {o.title}
              </span>
              {hasMeta && (
                <span
                  id={id + '-meta'}
                  style={{
                    fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)',
                    fontVariantNumeric: 'tabular-nums',
                    fontSize: 'var(--font-size-xs, 12px)',
                    color: off ? 'var(--text-disabled, #adb5bd)' : row ? 'var(--text-secondary, #5a6268)' : 'var(--text-data, #495057)',
                    marginLeft: row ? 'auto' : undefined,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {o.meta}
                </span>
              )}
            </span>
            {hasDesc && (
              <span
                id={id + '-desc'}
                style={{ fontSize: 'var(--font-size-xs, 12px)', lineHeight: 'var(--line-height-normal, 1.5)', color: off ? 'var(--text-disabled, #adb5bd)' : 'var(--text-secondary, #5a6268)', textWrap: 'pretty' }}
              >
                {o.description}
              </span>
            )}
          </span>)}
        </div>
        {on && o.detail != null && (
          <div data-ak-choice-detail="" style={{ padding: row ? '0 var(--space-3, 12px) var(--space-3, 12px) 34px' : '0 var(--space-3, 12px) var(--space-3, 12px) 36px' }}>
            {o.detail}
          </div>
        )}
      </div>
    );
  };

  const list = { display: 'flex', flexDirection: 'column', gap: row ? 0 : 10 };
  /* minColumnWidth: each run of options becomes an auto-fill grid inside the column. */
  const grid = minColumnWidth
    ? { display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(min(${typeof minColumnWidth === 'number' ? minColumnWidth + 'px' : minColumnWidth}, 100%), 1fr))`, gap: row ? 0 : 8, alignItems: 'start' }
    : null;
  const run = (opts) => (grid ? (opts.length ? <div data-ak-choice-grid="" style={grid}>{opts.map(renderOption)}</div> : null) : opts.map(renderOption));

  return (
    <div data-choice-group="" data-ak-choice-variant={row ? 'row' : 'card'} style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, ...style }} {...rest}>
      <div role={multiple ? 'group' : 'radiogroup'} aria-label={typeof label === 'string' ? label : undefined} style={list}>
        {run(options)}
        {(groups || []).map((g, gi) => {
          const bandId = base + '-g' + gi;
          const n = (g.options || []).length;
          return (
            <div key={bandId} role="group" aria-labelledby={bandId} style={list}>
              <div
                style={{
                  display: 'flex', alignItems: 'baseline', gap: 6,
                  padding: row ? '5px var(--space-3, 12px)' : '4px 0 0',
                  background: row ? 'var(--surface-secondary, #f8f9fa)' : undefined,
                  borderBottom: row ? '1px solid var(--list-divider, #e9ecef)' : undefined,
                }}
              >
                <Eyebrow id={bandId}>{g.label}</Eyebrow>
                <span aria-hidden="true" style={{ fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)', fontSize: 'var(--font-size-label, 11px)', color: 'var(--text-secondary, #5a6268)' }}>{'· ' + n}</span>
              </div>
              {run(g.options || [])}
            </div>
          );
        })}
      </div>
      {clearable && value != null && (
        <div style={{ padding: row ? '0 var(--space-3, 12px) var(--space-3, 12px)' : 0 }}>
          <Button variant="outline-secondary" size="sm" icon="bi-arrow-counterclockwise" onClick={clear}>{clearLabel}</Button>
        </div>
      )}
    </div>
  );
}
