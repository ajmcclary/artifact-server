import React from 'react';
import { SideNav } from './SideNav.jsx';

/**
 * ArkCase LeftNav — the application navigation column for the no-top-bar
 * workstation: a navy brand header, a search slot, the navigation itself, an
 * application footer, and the Panel Pin Model pin footer. Branding, search and
 * account or action content live at the head and foot of the rail, so the canvas starts at
 * the top of the viewport and no `TopNav` is rendered.
 *
 * The navigation is a `SideNav` by default (expanded, rail or peek over the
 * `items` contract); pass `navigation` instead for rows that carry per-row
 * controls a `NavItem` cannot describe. Rail variants (`brandRail`,
 * `searchRail`) replace their slots whenever the column is not expanded.
 * The column draws the full-height hairline itself and suppresses `SideNav`'s
 * own edge, so the rule runs unbroken past the header and the search row.
 */
export function LeftNav({
  mode = 'expanded',
  title = 'Navigation',
  header,
  brand,
  brandRail,
  search,
  searchRail,
  items,
  activeLink,
  onSelect,
  navigation,
  account,
  footer,
  footerRail,
  pinned,
  onPinChange,
  pinName,
  pinLabelVisible,
  currentLabel,
  footerMeta,
  width,
  resizable,
  onWidthChange,
  minWidth,
  maxWidth,
  onAnnounce,
  style,
  ...rest
}) {
  const railLike = mode !== 'expanded';
  const brandNode = railLike && brandRail !== undefined ? brandRail : brand;
  const searchNode = railLike && searchRail !== undefined ? searchRail : search;
  const body = navigation != null ? navigation : (
    <SideNav
      mode={mode}
      title={title}
      header={header}
      items={items || []}
      activeLink={activeLink}
      onSelect={onSelect}
      pinned={pinned}
      onPinChange={onPinChange}
      pinName={pinName}
      pinLabelVisible={pinLabelVisible}
      currentLabel={currentLabel}
      footerMeta={footerMeta}
      footer={footer !== undefined ? footer : account}
      footerRail={footerRail}
      width={width}
      resizable={resizable}
      onWidthChange={onWidthChange}
      minWidth={minWidth}
      maxWidth={maxWidth}
      onAnnounce={onAnnounce}
      style={{ borderRight: 'none', flex: '1 1 auto', height: 'auto', minHeight: 0 }}
    />
  );
  return (
    <div
      data-ac-left-nav={mode}
      style={{
        flex: 'none', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
        backgroundColor: 'var(--surface-card, #fff)',
        borderRight: '1px solid var(--border-color, #dee2e6)',
        overflow: 'hidden',
        ...style,
      }}
      {...rest}
    >
      {brandNode != null && (
        <div style={{
          flex: 'none', background: 'var(--surface-header, #073652)',
          display: 'flex', flexDirection: railLike ? 'column' : 'row',
          alignItems: 'center', gap: railLike ? 10 : 8,
          padding: railLike ? '12px 0' : '12px 14px',
        }}>
          {brandNode}
        </div>
      )}
      {searchNode != null && (
        <div style={{
          flex: 'none', padding: railLike ? '8px 0' : '8px 12px',
          borderBottom: '1px solid var(--border-color, #dee2e6)',
          display: 'flex', justifyContent: railLike ? 'center' : 'stretch',
        }}>
          {searchNode}
        </div>
      )}
      {body}
    </div>
  );
}
