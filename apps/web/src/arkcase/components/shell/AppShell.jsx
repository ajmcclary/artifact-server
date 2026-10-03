import React from 'react';
import { useDisplayProfile, displayProfileContext, defaultLadder } from './DisplayProfile.jsx';

const VISUALLY_HIDDEN = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' };

/* The frame reads the profile the root provides, so the mobile decisions — no rail,
   a drawer instead — are made once, here, and not by every slot. */
/* A fixed phone bar spans the window; in a framed column it is pulled in to the column's edges. */
function inColumn(el, offset) {
  if (offset == null || !React.isValidElement(el)) return el;
  return React.cloneElement(el, { style: { left: offset, right: offset, ...(el.props && el.props.style) } });
}

function ShellFrame({ chrome, bar, strip, nav, drawer, appBar, tabBar, aside, status, announce, alert, mainId, skipLabel, mainStyle, drawerLeft, children }) {
  const dp = React.useContext(displayProfileContext());
  const mobile = !!dp && dp.profile === 'mobile';
  /* Phone chrome: the document scrolls, the app bar and tab bar are fixed, and main pads past them. */
  const phone = mobile && (appBar != null || tabBar != null);
  const reduceMotion = !!dp && dp.reduceMotion;
  const topChrome = chrome === 'top';
  const [skipFocused, setSkipFocused] = React.useState(false);
  const mainRef = React.useRef(null);
  return (
    <React.Fragment>
      {/* WCAG 2.4.1 — skip link: off-screen until focused. */}
      <a
        href={`#${mainId}`}
        onClick={(event) => { event.preventDefault(); mainRef.current?.focus(); }}
        onFocus={() => setSkipFocused(true)}
        onBlur={() => setSkipFocused(false)}
        style={{
          position: 'absolute', left: 8, top: skipFocused ? 0 : -48, zIndex: 2100, height: 38,
          display: 'inline-flex', alignItems: 'center', padding: '0 14px',
          borderRadius: '0 0 5px 5px',
          background: 'var(--surface-header, #073652)', color: 'var(--text-on-navy, #fff)',
          fontSize: 'var(--font-size-dense, 13px)', fontWeight: 600, textDecoration: 'none',
          transition: reduceMotion ? 'none' : 'top .15s ease',
        }}
      >
        {skipLabel}
      </a>
      <div aria-live="polite" style={VISUALLY_HIDDEN}>{announce}</div>
      <div role="alert" aria-live="assertive" style={VISUALLY_HIDDEN}>{alert}</div>
      {topChrome && !phone && bar}
      {topChrome && !phone && strip}
      {phone && inColumn(appBar, drawerLeft)}
      <div style={{ display: 'flex', flex: '1 1 auto', minHeight: 0, position: 'relative' }}>
        {!mobile && nav}
        <main
          ref={mainRef}
          id={mainId}
          role="main"
          tabIndex={-1}
          style={phone ? {
            flex: '1 1 auto', minWidth: 0, outline: 'none', overflow: 'visible',
            paddingTop: appBar != null ? 'calc(var(--mobile-app-bar-height, 52px) + env(safe-area-inset-top, 0px))' : undefined,
            paddingBottom: tabBar != null ? 'calc(var(--mobile-tab-bar-height, 56px) + env(safe-area-inset-bottom, 0px))' : undefined,
            scrollPaddingTop: 'calc(var(--mobile-app-bar-height, 52px) + 46px)',
            ...mainStyle,
          } : { flex: '1 1 auto', minWidth: 0, minHeight: 0, overflow: 'auto', outline: 'none', ...mainStyle }}
        >
          {children}
        </main>
        {aside}
      </div>
      {status}
      {phone && inColumn(tabBar, drawerLeft)}
      {mobile && (drawerLeft != null && React.isValidElement(drawer)
        ? React.cloneElement(drawer, { style: { left: drawerLeft, ...(drawer.props && drawer.props.style) } })
        : drawer)}
    </React.Fragment>
  );
}

/* `frame`: when `force` pins a profile narrower than the real viewport, the shell
   draws itself at that profile's ladder width, centred, so a reviewer sees the
   narrow layout as a device-sized column rather than stretched across the window. */
function useAppShellFrame(frame, force, ladder) {
  const [realWidth, setRealWidth] = React.useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth));
  const key = force ? String(force).toLowerCase() : null;
  const widths = { ...defaultLadder.widths, ...((ladder && ladder.widths) || {}) };
  const target = frame && key && widths[key] != null ? widths[key] : null;
  React.useEffect(() => {
    if (target == null || typeof window === 'undefined') return undefined;
    const on = () => setRealWidth(window.innerWidth);
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [target]);
  if (target == null || !(target < realWidth)) return null;
  return { width: target, offset: Math.max(0, Math.round((realWidth - target) / 2)) };
}

/**
 * ArkCase AppShell — the frame every workstation screen sits in. A DisplayProfile
 * root carrying `data-ac-profile`; then, in order, the skip link, one of two
 * chrome arrangements, the nav + main + aside row, the status row, and on
 * `mobile` the drawer instead of the nav. `left` is the default: its nav owns
 * the full viewport height and the bar/strip are omitted. `top` retains the
 * traditional bar and optional strip above the row. It is the one host of the
 * two live regions, so every control that announces hands its text up rather
 * than owning a region.
 *
 * `frame` (opt-in) draws a forced profile narrower than the window as a centred
 * column at the ladder width, with `shadow-lg` and hairline sides, and slides the
 * phone drawer into that column.
 *
 * Phone chrome: on `mobile`, an `appBar` (a `MobileAppBar`) or `tabBar` (a
 * `MobileTabBar`) switches the frame to document scroll. The root grows with its
 * content, `main` stops scrolling and pads past the fixed bars, and the desktop
 * `bar` and `strip` stand down. Without either prop the phone keeps the previous
 * frame, so existing hosts are unchanged.
 */
export function AppShell({
  chrome = 'left', force = null, ladder, bar, strip, nav, drawer, appBar, tabBar, aside, status, announce, alert,
  mainId = 'ak-main', skipLabel = 'Skip to main content', mainStyle, frame = false, style, children, ...rest
}) {
  const framed = useAppShellFrame(frame, force, ladder);
  const frameStyle = framed ? {
    boxSizing: 'border-box', width: framed.width, margin: '0 auto',
    boxShadow: 'var(--shadow-lg, 0 8px 24px rgba(0,0,0,.18))',
    borderLeft: '1px solid var(--border-color, #dee2e6)', borderRight: '1px solid var(--border-color, #dee2e6)',
  } : null;
  const profile = useDisplayProfile({ force, ladder: ladder || defaultLadder });
  const phone = profile.profile === 'mobile' && (appBar != null || tabBar != null);
  /* The phone frame grows with its content so the document — not a pane — scrolls. */
  const sizing = phone
    ? { minHeight: '100dvh', overflow: 'visible' }
    : { height: '100dvh', overflow: 'hidden' };
  const Provider = displayProfileContext().Provider;
  return (
    <div
      data-ac-profile={profile.profile}
      data-ak-shell-frame={framed ? '' : undefined}
      data-ak-phone-chrome={phone ? '' : undefined}
      style={{ position: 'relative', display: 'flex', flexDirection: 'column', maxWidth: '100vw', background: 'var(--surface-canvas, #f1f5f7)', ...sizing, ...frameStyle, ...style }}
      {...rest}
    >
      <Provider value={profile}>
      <ShellFrame chrome={chrome} bar={bar} strip={strip} nav={nav} drawer={drawer} appBar={appBar} tabBar={tabBar} aside={aside} status={status} announce={announce} alert={alert} mainId={mainId} skipLabel={skipLabel} mainStyle={mainStyle} drawerLeft={framed ? framed.offset : null}>
        {children}
      </ShellFrame>
      </Provider>
    </div>
  );
}
