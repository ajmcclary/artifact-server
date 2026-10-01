import React from 'react';
import { Input } from '../forms/Input.jsx';
import { Button } from '../actions/Button.jsx';
import { LinkRow } from '../data-display/LinkRow.jsx';
import { GroupBand } from '../record/GroupBand.jsx';
import { SurfaceState } from '../feedback/SurfaceState.jsx';

const SECONDARY = { fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5a6268)', overflowWrap: 'anywhere' };
/* Rows run edge to edge: square, the gutter inside the row, so the selected tint and its rail
   meet the list's sides. */
const ROW = { borderRadius: 0, padding: '2px 8px' };
const HAIRLINE = '1px solid var(--list-divider, #e9ecef)';

function Check() {
  return (
    <span style={{ display: 'inline-flex', padding: '0 6px' }}>
      <i className="bi bi-check-lg" aria-hidden="true" data-icon-tone="current" style={{ color: 'var(--text-link, #0079a8)' }} />
    </span>
  );
}

/**
 * ArkCase SearchableList — the picker body a crumb menu, a popover or an inline field opens on:
 * a search field, rows that are pinned above the search's reach, then the matching rows grouped
 * under sticky `GroupBand`s, a Load more step and a footer that counts what is shown. Rows are
 * compact `LinkRow`s, edge to edge; the selected one takes the tint, the 3px rail and a check.
 * The host filters: it passes the matching `items` for its `query` (and the unfiltered `total`),
 * so search can cover fields the list never shows. A query change is announced with the count.
 */
export function SearchableList({
  label, items = [], selected = null, onSelect, query = '', onQueryChange, searchable, searchLabel = 'Search',
  searchPlaceholder, touch = false, pinned = [], groupLabel, grouped, stickyGroups = true,
  limit, onLoadMore, loadMoreLabel = 'Load more', total, countLabel, noun = 'items', footer, after,
  emptyTitle = 'No matches', emptyBody, maxHeight = 'min(50vh, 320px)', check = true, onAnnounce, style, ...rest
}) {
  const canSearch = searchable != null ? !!searchable : typeof onQueryChange === 'function';
  const visible = typeof limit === 'number' ? items.slice(0, limit) : items;
  const groups = [...new Set(visible.map((item) => item.group ?? null))];
  const showGroups = grouped != null ? !!grouped : groups.length > 1;
  const all = total != null ? total : items.length;
  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (onAnnounce) onAnnounce(items.length + ' matching ' + noun + '.');
  }, [query]);
  const row = (item) => {
    const isSelected = selected != null && item.id === selected;
    const trailing = (item.meta != null || (check && isSelected))
      ? <>{item.meta}{check && isSelected ? <Check /> : null}</>
      : undefined;
    return (
      <LinkRow key={item.id} density="compact" tone="body" selected={isSelected} rail style={ROW}
        icon={item.icon} iconTone="muted" title={item.title} description={item.description}
        ariaLabel={item.ariaLabel} actions={trailing}
        onSelect={() => onSelect && onSelect(item.id, item)} />
    );
  };
  const bandOf = (group) => (groupLabel ? groupLabel(group) : group);
  return (
    <div data-searchable-list={label} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, ...style }} {...rest}>
      {canSearch && (
        <div style={{ padding: '10px 12px 8px', flex: 'none' }}>
          <Input label={searchLabel} icon="bi-search" type="search" size="sm" touch={touch} placeholder={searchPlaceholder}
            value={query} onChange={(e) => onQueryChange && onQueryChange(e.target.value)} />
        </div>
      )}
      {pinned.length > 0 && (
        <div data-searchable-list-pinned="" style={{ flex: 'none', borderTop: canSearch ? HAIRLINE : 0, display: 'flex', flexDirection: 'column' }}>
          {pinned.map(row)}
        </div>
      )}
      <section aria-label={label} data-searchable-list-rows="" style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', maxHeight,
        borderTop: canSearch || pinned.length ? HAIRLINE : 0, display: 'flex', flexDirection: 'column' }}>
        {showGroups
          ? groups.map((group) => (
            <section key={String(group)} aria-label={String(bandOf(group))}>
              <GroupBand label={bandOf(group)} sticky={stickyGroups} />
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {visible.filter((item) => (item.group ?? null) === group).map(row)}
              </div>
            </section>
          ))
          : visible.map(row)}
        {!items.length && <SurfaceState phase="ready" count={0} noun={noun} density="inline" emptyTitle={emptyTitle} emptyBody={emptyBody} />}
      </section>
      {items.length > visible.length && onLoadMore && (
        <div style={{ flex: 'none', padding: '8px 12px 0' }}>
          <Button variant="secondary" outline size="sm" onClick={onLoadMore}>{loadMoreLabel}</Button>
        </div>
      )}
      <div data-searchable-list-footer="" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderTop: HAIRLINE, ...SECONDARY }}>
        <span style={{ flex: '1 1 auto' }}>{countLabel ? countLabel(visible.length, all, items.length) : visible.length + ' of ' + all + ' ' + noun}</span>
        {footer}
      </div>
      {after}
    </div>
  );
}
