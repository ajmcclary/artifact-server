import React from 'react';
import { BottomSheet } from '../overlays/BottomSheet.jsx';
import { countText } from '../navigation/nav-helpers.jsx';

const STICKY_TOP = 'calc(var(--mobile-app-bar-height, 52px) + env(safe-area-inset-top, 0px))';
const COUNT = {
  minWidth: 18, padding: '0 5px', boxSizing: 'border-box', borderRadius: 9, textAlign: 'center',
  background: 'var(--surface-tertiary, #e9ecef)', color: 'var(--text-emphasis, #374151)',
  font: '500 var(--font-size-label, 11px)/18px var(--font-data, "Source Code Pro", ui-monospace, monospace)',
};

/* Docked once the bar's top meets its sticky offset; the page (not a pane) is the scroller. */
function useDocked(ref, enabled) {
  const [docked, setDocked] = React.useState(false);
  React.useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;
    const read = () => {
      const el = ref.current;
      if (!el) return;
      const top = parseFloat(window.getComputedStyle(el).top) || 0;
      setDocked(el.getBoundingClientRect().top <= top + 0.5 && (window.scrollY || 0) > 0);
    };
    read();
    window.addEventListener('scroll', read, { passive: true });
    window.addEventListener('resize', read);
    return () => { window.removeEventListener('scroll', read); window.removeEventListener('resize', read); };
  }, [enabled]);
  return docked;
}

/**
 * ArkCase MobileSectionBar — a record's sections on a phone. One line of
 * underline tabs that scrolls sideways under a fade, sticky beneath the
 * `MobileAppBar`, with a list button at the end that opens every section,
 * grouped, in a `BottomSheet`. It picks up `shadow-md` once docked. Switching
 * sections replaces the view in place; the host should not push a history
 * entry for it.
 */
export function MobileSectionBar({
  sections = [], activeId, onSelect, label = 'Sections', allLabel = 'All sections', sheetTitle,
  sticky = true, top = STICKY_TOP, zIndex = 10, style, ...rest
}) {
  const barRef = React.useRef(null);
  const stripRef = React.useRef(null);
  const [sheet, setSheet] = React.useState(false);
  const docked = useDocked(barRef, sticky);

  React.useEffect(() => {
    const strip = stripRef.current;
    const tab = strip && strip.querySelector('[aria-current="page"]');
    if (!tab) return;
    const left = tab.offsetLeft - 24, right = tab.offsetLeft + tab.offsetWidth + 24;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth;
  }, [activeId]);

  const pick = (s) => { if (onSelect) onSelect(s); setSheet(false); };
  const onKeyDown = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    const tabs = [...stripRef.current.querySelectorAll('button')];
    const at = tabs.indexOf(document.activeElement);
    if (at < 0) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus();
  };
  const groups = [];
  sections.forEach((s) => {
    const name = s.group || '';
    let g = groups.find((x) => x.name === name);
    if (!g) { g = { name, items: [] }; groups.push(g); }
    g.items.push(s);
  });

  return (
    <React.Fragment>
      <nav
        ref={barRef}
        aria-label={label}
        data-ak-section-bar=""
        data-docked={docked ? '' : undefined}
        style={{
          position: sticky ? 'sticky' : 'relative', top: sticky ? top : undefined, zIndex,
          display: 'flex', height: 46, boxSizing: 'border-box',
          background: 'var(--surface-card, #ffffff)', borderTop: '1px solid var(--border-color, #dee2e6)', borderBottom: '1px solid var(--border-color, #dee2e6)',
          boxShadow: docked ? 'var(--shadow-md, 0 2px 4px rgba(0,0,0,.05), 0 4px 12px rgba(0,0,0,.10))' : 'none',
          transition: 'box-shadow var(--transition-fast, 0.15s ease) ease', fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)',
          ...style,
        }}
        {...rest}
      >
        <div ref={stripRef} onKeyDown={onKeyDown} style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', padding: '0 6px', overflowX: 'auto', overflowY: 'hidden', scrollbarWidth: 'none', whiteSpace: 'nowrap' }}>
          {sections.map((s) => {
            const active = s.id === activeId;
            return (
              <button
                key={s.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => pick(s)}
                style={{
                  flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 12px', margin: 0, border: 0,
                  background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'var(--font-size-sm, 14px)',
                  fontWeight: active ? 600 : 500, color: active ? 'var(--text-link, #0079a8)' : 'var(--text-secondary, #5a6268)',
                  boxShadow: active ? 'inset 0 -2px 0 var(--bs-primary, #0079a8)' : 'none',
                }}
              >
                {s.label}
                {s.count != null && s.count !== 0 && <span style={COUNT}>{countText(s.count)}</span>}
              </button>
            );
          })}
        </div>
        <span aria-hidden="true" style={{ position: 'absolute', top: 0, bottom: 0, right: 47, width: 28, pointerEvents: 'none', background: 'linear-gradient(to right, transparent, var(--surface-card, #ffffff))' }} />
        <button
          type="button"
          aria-label={allLabel}
          title={allLabel}
          aria-haspopup="dialog"
          data-ak-section-all=""
          onClick={() => setSheet(true)}
          style={{ flex: 'none', width: 47, padding: 0, border: 0, borderLeft: '1px solid var(--border-color, #dee2e6)', background: 'var(--surface-card, #ffffff)', color: 'var(--icon-primary, #073652)', display: 'grid', placeItems: 'center', cursor: 'pointer' }}
        >
          <i aria-hidden="true" className="bi bi-list-ul" style={{ fontSize: 'var(--icon-lg, 20px)' }} />
        </button>
      </nav>
      <BottomSheet open={sheet} onClose={() => setSheet(false)} title={sheetTitle || label} returnFocusSelector="[data-ak-section-all]">
        {groups.map((g, gi) => (
          <section key={g.name || gi} aria-label={g.name || undefined}>
            {g.name && <h3 style={{ margin: 0, padding: gi ? '14px 0 8px' : '4px 0 8px', fontFamily: 'var(--font-body, "Public Sans", system-ui, sans-serif)', lineHeight: '16px', fontSize: 'var(--font-size-label, 11px)', fontWeight: 600, letterSpacing: 'var(--letter-spacing-wide, 0.025em)', textTransform: 'uppercase', color: 'var(--text-secondary, #5a6268)' }}>{g.name}</h3>}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
              {g.items.map((s) => {
                const active = s.id === activeId;
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => pick(s)}
                    style={{
                      minHeight: 48, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', borderRadius: 'var(--radius-md, 5px)',
                      border: `1px solid ${active ? 'var(--bs-primary, #0079a8)' : 'var(--border-color, #dee2e6)'}`,
                      background: active ? 'var(--tint-primary-selected, rgba(0, 121, 168, 0.10))' : 'var(--surface-card, #ffffff)',
                      color: active ? 'var(--text-link-on-tint, #00688f)' : 'var(--text-body, #212529)',
                      fontFamily: 'inherit', fontSize: 'var(--font-size-sm, 14px)', fontWeight: active ? 600 : 500, textAlign: 'left', cursor: 'pointer',
                    }}
                  >
                    <span style={{ flex: '1 1 auto', minWidth: 0 }}>{s.label}</span>
                    {s.count != null && s.count !== 0 && <span style={COUNT}>{countText(s.count)}</span>}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </BottomSheet>
    </React.Fragment>
  );
}
