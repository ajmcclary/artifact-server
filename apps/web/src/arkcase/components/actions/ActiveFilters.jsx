import React from 'react';
import { Button } from './Button.jsx';
import { visuallyHiddenStyle } from '../utilities/VisuallyHidden.jsx';

/**
 * ArkCase ActiveFilters — the row under a page toolbar while the view is narrowed: the count
 * ("Showing 3 of 12 previews"), a removable chip per filter and Clear filters. Promoted from the
 * ArkCase Artifacts Activity and Library toolbars.
 *
 * A removed chip takes its focus with it, so focus moves to what now stands in its place: the
 * next chip, or Clear filters after the last one; once nothing is left to stand on —
 * the last chip removed, or Clear filters pressed — focus goes to `returnFocusRef` (its first
 * button or field when it is a container), so it never falls to the page's body. With `live`
 * the count stays mounted (visually hidden at rest, saying `restStatus`) as a polite status, so
 * every change of the count is spoken.
 */
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ActiveFilters({
  filters = [], filtered, status, restStatus, live = false, onClear, clearLabel = 'Clear filters', returnFocusRef, style, ...rest
}) {
  const rowRef = React.useRef(null);
  const pendingFocus = React.useRef(null);
  const on = filtered == null ? filters.length > 0 : !!filtered;
  React.useLayoutEffect(() => {
    const want = pendingFocus.current;
    if (want == null) return;
    pendingFocus.current = null;
    const stops = rowRef.current ? [...rowRef.current.querySelectorAll('[data-filter-chip], [data-clear-filters]')] : [];
    let target = typeof want === 'number' && stops.length ? stops[Math.min(want, stops.length - 1)] : null;
    if (!target) {
      const home = returnFocusRef && returnFocusRef.current;
      target = home && (home.matches && home.matches(FOCUSABLE) ? home : home.querySelector && home.querySelector(FOCUSABLE));
    }
    if (target) target.focus();
  });
  if (!on && !live) return null;
  return (
    <div ref={rowRef} data-active-filters={on ? 'on' : 'off'}
      style={on ? { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '10px 0 2px', ...style } : { height: 0, ...style }} {...rest}>
      <span role={live ? 'status' : undefined} aria-live={live ? 'polite' : undefined}
        style={on ? { fontSize: 'var(--font-size-dense, 13px)', color: 'var(--text-secondary, #5a6268)' } : visuallyHiddenStyle}>
        {on ? status : restStatus}
      </span>
      {on && filters.map((f, i) => (
        <Button key={f.id} data-filter-chip="" variant="secondary" outline size="xs" icon={f.icon} iconRight="bi-x-lg"
          aria-label={f.removeLabel || `Remove ${typeof f.label === 'string' ? f.label : f.id} filter`}
          onClick={() => { pendingFocus.current = i; f.onRemove(); }}>{f.label}</Button>
      ))}
      {on && onClear && (
        <>
          <span aria-hidden="true" style={{ color: 'var(--text-secondary, #5a6268)' }}>·</span>
          <Button data-clear-filters="" variant="link" flush size="xs" onClick={() => { pendingFocus.current = 'return'; onClear(); }}>{clearLabel}</Button>
        </>
      )}
    </div>
  );
}
