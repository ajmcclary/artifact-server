import React from 'react';
import { navyNavigationStyle } from './nav-tone.js';
import { SideNav } from './SideNav.jsx';
import { IconButton } from '../actions/IconButton.jsx';
import { Tooltip } from '../feedback/Tooltip.jsx';
import { BrandLock } from '../shell/BrandLock.jsx';
import { AccountButton } from '../shell/AccountButton.jsx';

export const LEFT_NAV_RAIL_WIDTH = 52;
export const LEFT_NAV_DEFAULT_WIDTH = 232;
export const LEFT_NAV_MIN_WIDTH = 180;
export const LEFT_NAV_MAX_WIDTH = 420;
const RAIL_WIDTH = `var(--navigator-rail-width, ${LEFT_NAV_RAIL_WIDTH}px)`;
const FOOTER_RULE = '1px solid var(--ac-nav-divider, var(--border-color, #dee2e6))';
const DATA_FONT = "var(--font-data, 'Source Code Pro', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)";

const isBrandDescriptor = (v) => v != null && typeof v === 'object' && !React.isValidElement(v) && !Array.isArray(v);

/* A brand descriptor becomes the reversed lock-up: wordmark when expanded, emblem with a tooltip on the rail. */
function brandFor(brand, rail) {
  if (!isBrandDescriptor(brand)) return brand;
  const extra = 'product' in brand ? { product: brand.product } : null;
  const lock = (
    <BrandLock tone="reversed" size={17} wordmark={!rail} label={brand.label} homeLabel={brand.homeLabel}
      onClick={brand.onClick} href={brand.href} {...extra} />
  );
  return rail ? <Tooltip label={brand.homeLabel || brand.label || 'Home'} placement="right" fixed>{lock}</Tooltip> : lock;
}

/* An AccountButton passed as `account` draws its own rail form when no `footerRail` is given. */
const railAccountFor = (account) =>
  React.isValidElement(account) && account.type === AccountButton ? React.cloneElement(account, { rail: true }) : undefined;

/* The menu's search: a field-shaped button that opens the host's search dialog, or an icon on the rail. */
function SearchTrigger({ rail, tone, label, shortcut, keyShortcuts, open, onSearch }) {
  if (rail) {
    return (
      <Tooltip label={shortcut ? `${label}  ${shortcut}` : label} placement="right" fixed>
        <IconButton icon="bi-search" variant={tone === 'navy' ? 'navy' : 'ghost'} size="sm" ariaLabel={label}
          keyshortcuts={keyShortcuts} expanded={open} hasPopup="dialog" onClick={onSearch} />
      </Tooltip>
    );
  }
  return (
    <button
      type="button" data-ac-nav-search="" onClick={onSearch}
      aria-expanded={open == null ? undefined : !!open} aria-haspopup="dialog" aria-keyshortcuts={keyShortcuts}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', height: 30, padding: '0 10px', boxSizing: 'border-box',
        border: '1px solid var(--border-color, #dee2e6)', borderRadius: 'var(--radius-md, 5px)',
        background: 'var(--nav-search-bg, #ffffff)', color: 'var(--text-secondary, #5a6268)',
        font: 'inherit', fontSize: 'var(--font-size-dense, 13px)', textAlign: 'left', cursor: 'pointer',
      }}
    >
      <i aria-hidden="true" className="bi bi-search" style={{ flex: 'none', fontSize: 'var(--icon-sm, 14px)' }} />
      <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {shortcut && <span aria-hidden="true" style={{ flex: 'none', fontFamily: DATA_FONT, fontSize: 'var(--font-size-label, 11px)' }}>{shortcut}</span>}
    </button>
  );
}

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
  tone = 'default',
  title = 'Navigation',
  header,
  brand,
  brandRail,
  search,
  searchRail,
  onSearch,
  searchLabel = 'Quick Search',
  searchShortcut,
  searchKeyShortcuts,
  searchOpen,
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
  minWidth = LEFT_NAV_MIN_WIDTH,
  maxWidth = LEFT_NAV_MAX_WIDTH,
  onAnnounce,
  style,
  ...rest
}) {
  const railLike = mode !== 'expanded';
  const brandNode = railLike && brandRail !== undefined ? brandRail : brandFor(brand, railLike);
  const footerRailNode = footerRail !== undefined ? footerRail : railAccountFor(account);
  const slotSearch = railLike && searchRail !== undefined ? searchRail : search;
  const searchNode = slotSearch != null ? slotSearch : onSearch ? (
    <SearchTrigger rail={railLike} tone={tone} label={searchLabel} shortcut={searchShortcut}
      keyShortcuts={searchKeyShortcuts} open={searchOpen} onSearch={onSearch} />
  ) : null;
  const customFooter = railLike ? footerRailNode : (footer !== undefined ? footer : account);
  const body = navigation != null ? (
    <>
      {navigation}
      {customFooter != null && (
        <div style={{ flex: 'none', borderTop: FOOTER_RULE, padding: railLike ? '8px 0' : '8px 12px', display: 'flex', justifyContent: railLike ? 'center' : 'stretch' }}>
          {customFooter}
        </div>
      )}
    </>
  ) : (
    <SideNav
      mode={mode}
      tone={tone}
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
      footerRail={footerRailNode}
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
      data-navigation-tone={tone}
      style={{
        flex: 'none', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
        backgroundColor: 'var(--ac-nav-surface, var(--surface-card, #fff))',
        color: 'var(--ac-nav-text, var(--text-body, #212529))',
        borderRight: '1px solid var(--ac-nav-divider, var(--border-color, #dee2e6))',
        /* The rail is fixed; a slots-only column (no SideNav to size it) takes `width` when expanded.
           Otherwise the SideNav sizes the column, so a live resize drag is followed, and a peek
           column stays unclipped so its overlay can open over the content beside it. */
        width: mode === 'rail' ? RAIL_WIDTH : navigation != null && !railLike && width != null ? width : undefined,
        overflow: mode === 'peek' ? 'visible' : 'hidden',
        ...(tone === 'navy' ? navyNavigationStyle : null),
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
          borderBottom: '1px solid var(--ac-nav-divider, var(--border-color, #dee2e6))',
          display: 'flex', justifyContent: railLike ? 'center' : 'stretch',
        }}>
          {searchNode}
        </div>
      )}
      {body}
    </div>
  );
}
