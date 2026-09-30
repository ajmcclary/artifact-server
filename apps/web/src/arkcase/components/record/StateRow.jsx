import React from 'react';
import { MetaChain } from './MetaChain.jsx';
import { SelectableRow } from './SelectableRow.jsx';
import { StatusPill } from '../data-display/StatusPill.jsx';

/* The row's tone vocabulary, drawn in StatusPill's: what the row wants from the reader. */
const PILL_TONE = { attention: 'warning', running: 'primary', settled: 'success', failed: 'danger', neutral: 'neutral' };
const DATA_FONT = 'var(--font-data, monospace)';
const ONE_LINE = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

/**
 * ArkCase StateRow — the record list row. The record's identifier leads in the data font with
 * the state it is in pinned right as a StatusPill — the identifier keeps its width and a long
 * state label ellipsises, its full text in the pill's title; one sentence that state implies follows,
 * clamped at two lines, and a single meta line closes the row — where it sits first, then the
 * chain, ellipsised rather than wrapped so no part is ever orphaned on a line of its own.
 * Selection is a 3px rail that is always present and transparent at rest, so selecting a row
 * never shifts its text. Harvested from the ExtractionKit run list; the row itself is a
 * SelectableRow, so onClick answers Enter and Space as well.
 */
export function StateRow({ state, tone = 'neutral', id, qualifier, position, sentence, meta, selected, onClick, style, children, ...rest }) {
  const chain = [position != null && position !== '' ? { value: position, mono: true } : null].concat(meta || []).filter(Boolean);
  return (
    <SelectableRow
      selected={selected}
      onSelect={onClick}
      style={{ display: 'flex', gap: 12, ...style }}
      {...rest}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
        {(id || qualifier || state) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {id && <span style={{ flex: 'none', whiteSpace: 'nowrap', fontFamily: DATA_FONT, fontSize: 'var(--font-size-dense, 13px)', fontWeight: 600, color: 'var(--text-navy, #073652)' }}>{id}</span>}
            {qualifier && <span style={{ flex: 'none', fontFamily: DATA_FONT, fontSize: 'var(--font-size-label, 11px)', color: 'var(--text-secondary, #5a6268)' }}>{qualifier}</span>}
            {state && <StatusPill tone={PILL_TONE[tone] || 'neutral'} label={state} title={typeof state === 'string' ? state : undefined}
              style={{ display: 'block', flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', marginLeft: 'auto' }} />}
          </div>
        )}
        {sentence && <div style={{ fontSize: 'var(--font-size-dense, 13px)', color: 'var(--text-body, #212529)', lineHeight: 1.45, textWrap: 'pretty', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{sentence}</div>}
        {chain.length > 0 && (
          <MetaChain items={chain} separator={<span style={{ margin: '0 4px' }}>·</span>}
            style={{ display: 'block', ...ONE_LINE }} />
        )}
        {children}
      </div>
    </SelectableRow>
  );
}
