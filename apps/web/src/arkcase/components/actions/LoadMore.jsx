import React from 'react';
import { Button } from './Button.jsx';

/**
 * ArkCase LoadMore — the end of a list that pages: the count of what is shown ("8 of 21
 * actions") and the step that reveals the next batch ("Load 8 more", "Show 4 Older"). The
 * step is an outline Button with a down chevron; `divided` lays the pair on a band with a
 * hairline above, at the foot of a ledger. Nothing renders once everything is shown.
 */
export function LoadMore({ shown, total, noun, step, onLoadMore, label, icon = 'bi-chevron-down', count, divided = false, style, ...rest }) {
  const remaining = Math.max(0, (total ?? 0) - (shown ?? 0));
  if (total != null && remaining === 0) return null;
  const next = step != null && total != null ? Math.min(step, remaining) : null;
  const text = label || (next != null ? 'Load ' + next + ' more' : 'Load more');
  const showCount = count != null ? !!count : !!noun && total != null;
  return (
    <div
      data-load-more=""
      style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: divided ? '10px 14px' : '8px 0',
        borderTop: divided ? '1px solid var(--list-divider, #e9ecef)' : undefined,
        ...style,
      }}
      {...rest}
    >
      {showCount && (
        <span style={{ fontFamily: 'var(--font-data, "Source Code Pro", ui-monospace, monospace)', fontSize: 'var(--font-size-label, 11px)', color: 'var(--text-secondary, #5a6268)' }}>
          {shown} of {total}{noun ? ' ' + noun : ''}
        </span>
      )}
      <Button variant="secondary" outline size="sm" icon={icon} onClick={onLoadMore} style={showCount ? { marginLeft: 'auto' } : undefined}>{text}</Button>
    </div>
  );
}
