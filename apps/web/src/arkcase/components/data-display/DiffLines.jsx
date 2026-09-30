import React from 'react';
import { VisuallyHidden } from '../utilities/VisuallyHidden.jsx';

const MARKS = {
  '+': { spoken: 'Added', bg: 'var(--pill-success-bg, #dcfce7)', fg: 'var(--pill-success-fg, #15803d)' },
  '-': { spoken: 'Removed', bg: 'var(--pill-danger-bg, #fee2e2)', fg: 'var(--text-overdue, #991b1b)' },
  '~': { spoken: 'Changed', bg: 'var(--pill-warning-bg, #fef3c7)', fg: 'var(--pill-warning-fg, #92400e)' },
  ' ': { spoken: 'Unchanged', bg: 'transparent', fg: 'var(--text-secondary, #5a6268)' },
};
const DATA = 'var(--font-data, "Source Code Pro", ui-monospace, monospace)';

/**
 * ArkCase DiffLines — the changed lines between two versions of a text file:
 * a `+`/`-`/`~` mark, the line number and the line, on the success tint for
 * added lines, the danger tint for removed ones and the warning tint for
 * changed ones, all in the data face. Colour is never the only signal: every
 * row also says "Added", "Removed", "Changed" or "Unchanged" to assistive
 * technology. With `numbered={false}` the number column is dropped, for change
 * summaries. With a
 * `label` the block is a named, focusable region so keyboard users can scroll
 * a wide diff.
 */
const hasN = (l) => l.n != null && l.n !== '';

export function DiffLines({ lines = [], empty, label, numbered, style, ...rest }) {
  const showNumbers = numbered !== false;
  if (!lines.length) {
    return (
      <div
        style={{ padding: 14, fontSize: 'var(--font-size-dense, 13px)', lineHeight: 1.5, color: 'var(--text-secondary, #5a6268)', ...style }}
        {...rest}
      >
        {empty}
      </div>
    );
  }
  return (
    <div
      role={label ? 'region' : undefined}
      aria-label={label}
      tabIndex={label ? 0 : undefined}
      style={{ overflowX: 'auto', ...style }}
      {...rest}
    >
      <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {lines.map((l, i) => {
          const m = MARKS[l.mark] || MARKS[' '];
          return (
            <li
              key={i}
              style={{
                display: 'grid',
                gridTemplateColumns: showNumbers ? '22px 52px minmax(0, 1fr)' : '22px minmax(0, 1fr)',
                gap: 'var(--space-2, 8px)',
                alignItems: 'baseline',
                padding: '5px 14px',
                borderBottom: 'var(--border-width, 1px) solid var(--surface-canvas, #f1f5f7)',
                background: m.bg,
                fontFamily: DATA,
              }}
            >
              <span aria-hidden="true" style={{ fontSize: 'var(--font-size-xs, 12px)', fontWeight: 'var(--bs-font-weight-semibold, 600)', color: m.fg }}>{l.mark === ' ' ? '' : l.mark}</span>
              {showNumbers && <span aria-hidden="true" style={{ fontSize: 'var(--font-size-label, 11px)', color: 'var(--text-secondary, #5a6268)', textAlign: 'right', fontVariantNumeric: 'var(--font-numeric-feature, tabular-nums)' }}>{l.n}</span>}
              <span style={{ fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-data, #495057)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                <VisuallyHidden>{m.spoken + (showNumbers && hasN(l) ? ', line ' + l.n : '') + ': '}</VisuallyHidden>
                {l.text}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
