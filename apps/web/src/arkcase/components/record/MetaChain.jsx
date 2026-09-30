import React from 'react';

/**
 * ArkCase MetaChain — the middot-separated provenance line beneath a row or
 * heading. Coded parts render in the data font; the separators are one tone
 * lighter than the text so the chain reads as one line, not as list items.
 */
export function MetaChain({ items = [], separator = '·', style, ...rest }) {
  const parts = items.filter(Boolean).map((i) => (typeof i === 'object' && !React.isValidElement(i) ? i : { value: i }));
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap', fontSize: 'var(--font-size-label, 11px)', color: 'var(--text-secondary, #5a6268)', ...style }} {...rest}>
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span style={{ color: 'var(--bs-gray-600, #6c757d)' }}>{separator}</span>}
          <span style={p.mono ? { fontFamily: 'var(--font-data, monospace)' } : undefined}>{p.value}</span>
        </React.Fragment>
      ))}
    </div>
  );
}
