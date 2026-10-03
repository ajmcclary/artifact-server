import React from 'react';
import { panelBudgetContext } from './PanelBudget.jsx';
import { useResizeSeam } from './resize-seam.jsx';
import { splitSlots } from '../utilities/slots.jsx';
import { Button } from '../actions/Button.jsx';
import { PIN_CUE_MS, PIN_RING, PIN_CUE_CHIP_STYLE, ensurePinCueKeyframes } from './PinCue.jsx';

/**
 * ArkCase Panel — a docked column with the pin in its own 32px footer.
 *
 * Pinned, it is a column of `width`: header slot, selection slot, a scrolling
 * body, then the footer with the pin glyph on the left — its label is the
 * button's name and tooltip, never visible text — and the panel's meta on the
 * right; a cue chip names the new state for two seconds after a toggle. Unpinned,
 * it is a 36px rail — icon, count, vertical name, and the outline pin in a footer
 * of its own on the same baseline as the pinned column's — that opens its content
 * as an overlay when the rail is pressed, so a railed list is still reachable without
 * pinning it. Pointer travel never opens it: a peek follows a click, a tap, Enter or
 * Space, and retracts on Escape, a press outside the panel or focus leaving it. The
 * overlay covers the rail, so its footer pin takes the rail pin's place rather than
 * drawing a second pin beside it. Inside a `PanelBudget` with `autoCollapse`, the
 * panel pinned most recently wins the width: an older pin stands down to its rail
 * with the pin cue, and comes back when there is room again. `pinnable={false}` is the
 * route's own content: no rail, the footer drawn with an empty pin slot so the
 * baseline every pin sits on stays unbroken. `resizable` adds a seam on the
 * inward edge; dragging it past `minWidth` and holding for one second
 * collapses the panel, leaving the width alone so re-pinning restores it.
 *
 * The panel owns no persistence: `pinned` / `width` are controlled when given,
 * and every change goes out through `onPinChange`, `onWidthChange` and
 * `onAnnounce`. Admission comes from `canPin`, or from the nearest
 * `PanelBudget` by `id`. `railLabel` is the rail's vertical word when the pane's name does not
 * read well vertically — "Claims" for the claim list — and defaults to the capitalised name;
 * `countLabel` names the rail's count for a reader ("3 unread notifications") where the number
 * alone would not.
 *
 * `unpinned="float"` swaps the rail for the whole column floating over the content at its
 * edge — the inspector's unpinned mode: the root takes no layout width, the column is laid
 * absolutely against the nearest positioned ancestor, `floatOffset` in from the edge (inside
 * a `RailTabs` strip), and the footer pin brings it back into the flow. `sheet` is the phone
 * presentation: the column fills the viewport, no rail, no pin, no seam; with `onSheetClose` it
 * opens on a 44px "‹ Back" link above the header, the sheet's way back to the screen it covers.
 *
 * `stacked` is the narrow layout where the workspace becomes a column (Advanced Search's
 * filters above the results, its preview under them): the panel spans the full width, has no
 * rail, pin or seam, and a 32px toggle strip on its outer edge (`stackEdge`) carries a ghost
 * "Show filters" / "Hide filters" button. The open state is the same `pinned` value, so a
 * host keeps one preference across both layouts; the strip reports through `onPinChange`.
 */

const RAIL_W = 'var(--panel-rail-width, 36px)';
const DEFAULT_WIDTH = 330;
const CUE_MS = PIN_CUE_MS;
const BORDER = '1px solid var(--border-color, #dee2e6)';
const BORDER_STRONG = '1px solid var(--border-color-strong, #ced4da)';

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}
function coarsePointerMedia() {
  return typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false;
}
function isFocusVisible(el) {
  /* v8 ignore next */
  try { return el.matches(':focus-visible'); } catch (_) { return true; }
}
const capitalise = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

/* The pin itself — 24px hit area, ghost hover at the 5% cyan rung, pressed at 10%. */
function PinButton({ pressed, label, disabled, onClick, cue, reduce, buttonRef, onFocus, onBlur }) {
  const [hover, setHover] = React.useState(false);
  const [focus, setFocus] = React.useState(false);
  return (
    <button
      ref={buttonRef}
      type="button"
      data-panel-pin=""
      data-ac-pin=""
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={(e) => { setFocus(isFocusVisible(e.target)); onFocus && onFocus(e); }}
      onBlur={(e) => { setFocus(false); onBlur && onBlur(e); }}
      style={{
        flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 24, height: 24, padding: 0, border: 0, borderRadius: 'var(--radius-md, 5px)',
        background: disabled ? 'transparent' : pressed && hover ? 'var(--tint-primary-selected, rgba(0,121,168,.10))' : hover ? 'var(--tint-primary-hover, rgba(0,121,168,.05))' : 'transparent',
        color: disabled ? 'var(--text-disabled, #adb5bd)' : pressed ? 'var(--text-link, #0079a8)' : hover ? 'var(--text-link-on-tint, #00688f)' : 'var(--text-secondary, #5a6268)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        boxShadow: focus ? 'var(--focus-ring, 0 0 0 0.25rem rgba(0,121,168,0.25))' : cue && reduce ? '0 0 0 3px ' + PIN_RING : 'none',
        animation: cue && !reduce ? 'ak-pin-ring 1s ease-out 2' : 'none',
        transition: reduce ? 'none' : 'background-color .15s ease, color .15s ease',
      }}
    >
      <i aria-hidden="true" className={'bi ' + (pressed ? 'bi-pin-angle-fill' : 'bi-pin-angle')} style={{ fontSize: 'var(--icon-sm, 14px)' }} />
    </button>
  );
}

export function Panel({
  id, name = 'panel', icon, count, countLabel, railLabel, pinName,
  pinned, defaultPinned = true, onPinChange, canPin: canPinProp, pinnable = true,
  side = 'start', width, onWidthChange, resizable = false, minWidth = 200, maxWidth,
  unpinned = 'rail', floatOffset = 0, sheet = false, stacked = false, stackEdge, stackLabel,
  peek = true, peeking: peekingProp, onPeekChange, cueExternalPin = false, onSheetClose, sheetCloseLabel = 'Back', bodyLayout = 'block', header: headerProp, selection: selectionProp, footerMeta: footerMetaProp, onAnnounce, style, bodyStyle, children: childrenProp, ...rest
}) {
  /* A portable page fills the node props through slotted children; an explicit prop wins. A
     function child is the peek API form and carries no slots. */
  const slots = typeof childrenProp === 'function' ? null : splitSlots(childrenProp);
  const header = headerProp ?? (slots && slots.header);
  const selection = selectionProp ?? (slots && slots.selection);
  const footerMeta = footerMetaProp ?? (slots && slots.footerMeta);
  const children = slots ? slots.children : childrenProp;
  const budget = React.useContext(panelBudgetContext());
  const Name = capitalise(name);
  const say = (text) => { if (onAnnounce) onAnnounce(text); };
  const reduce = prefersReducedMotion();

  /* Pinned and width are controlled when given, owned otherwise. */
  const [ownPinned, setOwnPinned] = React.useState(defaultPinned);
  const wantsPin = pinned !== undefined ? !!pinned : ownPinned;
  const [ownWidth, setOwnWidth] = React.useState(null);
  const baseWidth = width != null ? width : ownWidth != null ? ownWidth : DEFAULT_WIDTH;
  const viewportWidth = (budget && budget.viewportWidth) || (typeof window !== 'undefined' ? window.innerWidth : 1280);
  const maxW = maxWidth != null ? maxWidth : Math.min(720, Math.max(300, Math.round(viewportWidth * 0.45)));
  const minW = minWidth;

  const pointer = budget ? budget.pointer : coarsePointerMedia() ? 'coarse' : 'fine';
  /* The seam: the shared hook, with the hold-to-collapse this panel alone has. An owned width
     is set here and a controlled one only reported; `setPin` is declared below, and the
     overshoot closure runs on a pointer event long after it. */
  const canCollapse = pinnable && pointer !== 'none';
  const seamState = useResizeSeam({
    width: baseWidth, minWidth: minW, maxWidth: maxW, side, name, reduceMotion: reduce,
    onWidthChange: (w) => { if (width == null) setOwnWidth(w); if (onWidthChange) onWidthChange(w); },
    onAnnounce: say,
    onOvershoot: canCollapse ? () => setPin(false) : undefined,
  });
  const panelWidth = seamState.width;
  const dragging = seamState.dragging;
  /* `fits` is whether the pin may be pressed; `admitted` whether a wanted pin docks. They differ
     only under `autoCollapse`, where a railed pin always fits — pressing it displaces an older
     pin — but a wanted pin docks only while the budget's recency walk admits it. */
  const fits = canPinProp !== undefined ? !!canPinProp : budget ? budget.can(id, panelWidth) : true;
  const admitted = canPinProp === undefined && budget && budget.autoCollapse && wantsPin ? !!budget.admitted[id] : fits;
  /* A pinned panel that no longer fits is railed for now only — the host keeps its
     preference, so the pin comes back the moment there is room. On a pointer that can
     never pin there is no rail: the panel stays a column with an empty pin slot. */
  const isSheet = !!sheet;
  const isStacked = !!stacked && !isSheet;
  const noPin = !pinnable || pointer === 'none' || isSheet || isStacked;
  const isPinned = noPin || (wantsPin && admitted);
  /* Unpinned in float mode there is no rail and no peek: the column itself floats. */
  const floating = !isPinned && unpinned === 'float';
  const canPeek = peek !== false && !floating;
  const peekWidth = (peek && typeof peek === 'object' && peek.width) || panelWidth;

  /* The peek is owned unless `peeking` is given; either way every change is reported, so a
     host can open a railed pane from a shortcut without reaching into the rail's markup. */
  const [ownPeeking, setOwnPeeking] = React.useState(false);
  const peeking = peekingProp !== undefined ? !!peekingProp : ownPeeking;
  const peekChange = React.useRef(onPeekChange);
  peekChange.current = onPeekChange;
  const controlledPeek = peekingProp !== undefined;
  const setPeeking = React.useCallback((value) => {
    if (!controlledPeek) setOwnPeeking(value);
    if (peekChange.current) peekChange.current(value);
  }, [controlledPeek]);
  const [cue, setCue] = React.useState(false);
  const [cueText, setCueText] = React.useState('');
  const rootRef = React.useRef(null);
  const railBtnRef = React.useRef(null);
  const railPinRef = React.useRef(null);
  const focusPinNext = React.useRef(false);
  const cueTimer = React.useRef(null);

  React.useEffect(ensurePinCueKeyframes, []);
  React.useEffect(() => () => { if (cueTimer.current) clearTimeout(cueTimer.current); }, []);

  const closePeek = React.useCallback(() => setPeeking(false), [setPeeking]);
  /* Retract the peek; if focus was inside it, hand focus back to the rail. */
  const retractPeek = React.useCallback(() => {
    setPeeking(false);
    const root = rootRef.current;
    if (root && railBtnRef.current && root.contains(document.activeElement) && document.activeElement !== railBtnRef.current) {
      railBtnRef.current.focus({ preventScroll: true });
    }
  }, [setPeeking]);

  const runCue = (value, text) => {
    setCueText(text || Name + (value ? ' pinned.' : ' unpinned.'));
    setCue(true);
    if (cueTimer.current) clearTimeout(cueTimer.current);
    cueTimer.current = setTimeout(() => { setCue(false); setCueText(''); }, CUE_MS);
  };
  /* Set by the panel's own pin press, cleared on the render after it. */
  const pressed = React.useRef(false);
  /* The value the panel's own pin last asked for; the controlled echo of it is not external. */
  const selfToggle = React.useRef(null);
  const setPin = (value) => {
    /* v8 ignore next */
    if (noPin) return;
    setPeeking(false);
    if (value && budget && budget.touch && id) budget.touch(id);
    pressed.current = true;
    selfToggle.current = value;
    if (pinned === undefined) setOwnPinned(value);
    if (onPinChange) onPinChange(value);
    say(Name + (value ? ' pinned.' : ' unpinned.'));
    focusPinNext.current = true;
    runCue(value);
  };

  /* A controlled `pinned` that changes from outside the panel — a shortcut, a menu command,
     the host unpinning it to make room — moves the pin between the footer and the rail too.
     With `cueExternalPin` the same ring and chip mark where the control now is. Focus stays
     where it was and nothing is announced: the host that made the change says so. */
  const lastPinned = React.useRef(pinned);
  React.useEffect(() => {
    const prev = lastPinned.current;
    lastPinned.current = pinned;
    const echo = selfToggle.current !== null && selfToggle.current === !!pinned;
    selfToggle.current = null;
    if (echo) return;
    if (!cueExternalPin || noPin || pinned === undefined || prev === undefined || !!prev === !!pinned) return;
    runCue(!!pinned);
  }, [pinned]);

  /* Auto-collapse: a pin made anywhere — the host, a mount after the budget's first render —
     makes this the newest pin; and when a newer one takes the width this panel stands down
     to its rail with the cue, keeping the host's preference so it returns with the room. */
  const touch = budget && budget.touch;
  const firstTouch = React.useRef(true);
  React.useEffect(() => {
    const initial = firstTouch.current;
    firstTouch.current = false;
    if (wantsPin && touch && id) touch(id, initial);
  }, [wantsPin, touch, id]);
  const lastAdmitted = React.useRef(admitted);
  React.useEffect(() => {
    const prev = lastAdmitted.current;
    lastAdmitted.current = admitted;
    /* The render after this panel's own pin press: that press has said its piece. */
    const own = pressed.current;
    pressed.current = false;
    if (!touch || noPin || !wantsPin || prev === admitted || own) return;
    const text = admitted ? Name + ' pinned again.' : Name + ' moved to its rail to make room.';
    say(text);
    runCue(admitted, text);
  });

  /* After a toggle the pin moves between the footer and the rail; keep focus on it. */
  React.useEffect(() => {
    if (!focusPinNext.current) return;
    focusPinNext.current = false;
    const el = isPinned || floating ? (rootRef.current && rootRef.current.querySelector('button[data-panel-pin]')) : railPinRef.current;
    if (el && el.focus) el.focus({ preventScroll: true });
  }, [isPinned, floating]);

  /* While the peek is open: Escape retracts it from anywhere (a controlled peek may have
     moved no focus), and so does a press outside the panel, on any pointer. */
  React.useEffect(() => {
    if (!peeking) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') retractPeek(); };
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setPeeking(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown, true); };
  }, [peeking, retractPeek]);

  const edge = side === 'end' ? 'Left' : 'Right';
  const edgeKey = 'border' + edge;

  const seam = resizable && isPinned && !isSheet && seamState.seam;

  /* ---- The footer: 32px, the pin left as a glyph, the meta right ---------------
     The label is the button's name and its tooltip, never visible text: the App draws every
     panel pin this way, and the visible "Unpin the menu" is the SideNav's alone. A two-second
     cue chip names the new state after a toggle, the App's pinCue as the component's own.
     Since E5h `pinName` names the pin's object without its article where a host has its own
     word — "claim information" reads "Pin claim information"; the default is "the " + name. */
  const who = pinName != null ? pinName : 'the ' + name;
  const pinLabel = (isPinned ? 'Unpin ' : 'Pin ') + who;
  const chip = cue && cueText && (
    <span
      data-panel-cue=""
      aria-hidden="true"
      style={{
        /* Above the peek overlay (30): a controlled peek can open while the chip still names
           the new state, and the chip must not sit beneath it. */
        ...PIN_CUE_CHIP_STYLE,
        position: 'absolute', bottom: 36, [side === 'end' ? 'right' : 'left']: 8, zIndex: 31,
        transition: reduce ? 'none' : 'opacity .15s ease',
      }}
    >
      {cueText}
    </span>
  );
  const footer = (
    <div style={{
      flex: 'none', height: 32, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 6,
      padding: '0 8px 0 4px', borderTop: BORDER, background: 'var(--surface-secondary, #f8f9fa)', position: 'relative',
    }}>
      {noPin ? (
        <span aria-hidden="true" style={{ width: 24, height: 24, flex: 'none' }} />
      ) : (
        <PinButton
          pressed={isPinned}
          label={isPinned ? pinLabel : fits ? pinLabel : 'Not enough room to pin ' + who}
          disabled={!isPinned && !fits}
          onClick={() => setPin(!isPinned)}
          cue={cue}
          reduce={reduce}
        />
      )}
      {footerMeta != null && (
        <span style={{ marginLeft: 'auto', flex: 'none', fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-secondary, #5a6268)', whiteSpace: 'nowrap' }}>{footerMeta}</span>
      )}
      {/* The peek overlay draws this same footer; the chip belongs to the rail then. */}
      {(isPinned || floating) && chip}
    </div>
  );

  const body = typeof children === 'function' ? children({ peeking, closePeek, pinned: isPinned }) : children;
  const sheetBack = isSheet && onSheetClose ? (
    <div data-panel-sheet-back="" style={{ flex: 'none', padding: '4px 8px 0', background: 'var(--surface-secondary, #f8f9fa)' }}>
      <Button variant="link" size="sm" icon="bi-chevron-left" onClick={onSheetClose} style={{ minHeight: 44 }}>{sheetCloseLabel}</Button>
    </div>
  ) : null;
  const column = (
    <React.Fragment>
      {sheetBack}
      {header}
      {selection}
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', ...(bodyLayout === 'column' ? { display: 'flex', flexDirection: 'column', overflow: 'hidden' } : null), ...bodyStyle }}>{body}</div>
      {footer}
    </React.Fragment>
  );

  /* ---- The rail ------------------------------------------------------------ */
  const [railHover, setRailHover] = React.useState(false);
  const onRootKeyDown = (e) => {
    if (e.key === 'Escape' && peeking) { e.preventDefault(); e.stopPropagation(); retractPeek(); }
  };
  const onRootBlur = (e) => {
    if (isPinned) return;
    const to = e.relatedTarget;
    if (!to || !(rootRef.current && rootRef.current.contains(to))) setPeeking(false);
  };

  /* The rail's pin sits in a 32px footer, not above the list: it is the same footer the
     pinned column draws, on the same baseline, so the control does not travel up the
     screen and back down as the panel is pinned and unpinned. While the peek covers the
     rail its footer pin is the one pin; this one leaves the tab order and the a11y tree. */
  const railPin = !isPinned && (
    <div style={{
      flex: 'none', height: 32, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center',
      borderTop: BORDER, background: 'var(--surface-secondary, #f8f9fa)', position: 'relative',
    }}>
      <span style={{ display: 'contents', visibility: peeking ? 'hidden' : undefined }}>
      <PinButton
        buttonRef={railPinRef}
        pressed={false}
        label={fits ? 'Pin ' + who : 'Not enough room to pin ' + who}
        disabled={!fits}
        onClick={() => setPin(true)}
        cue={cue}
        reduce={reduce}
      />
      </span>
      {chip}
    </div>
  );

  const rail = !isPinned && !floating && (
    <React.Fragment>
      <button
        ref={railBtnRef}
        type="button"
        aria-label={'Show the ' + name}
        title={'Show the ' + name}
        aria-expanded={canPeek ? peeking : undefined}
        onClick={() => { if (canPeek) setPeeking(!peeking); }}
        onMouseEnter={() => setRailHover(true)}
        onMouseLeave={() => setRailHover(false)}
        style={{
          flex: '1 1 auto', minHeight: 0, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
          padding: '9px 0', border: 0, background: railHover ? 'var(--surface-canvas, #f1f5f7)' : 'transparent',
          font: 'inherit', cursor: 'pointer', color: 'var(--text-secondary, #5a6268)',
          transition: reduce ? 'none' : 'background-color .15s ease',
        }}
      >
        {icon && <i aria-hidden="true" className={'bi ' + icon} style={{ fontSize: 'var(--icon-sm, 14px)', color: 'var(--text-data, #495057)' }} />}
        {count != null && (
          <span aria-label={countLabel} style={{
            display: 'inline-block', minWidth: 18, padding: '1px 5px', borderRadius: 'var(--radius-pill, 10px)',
            background: 'var(--pill-neutral-bg, #e9ecef)', color: 'var(--pill-neutral-fg, #495057)',
            fontFamily: 'var(--font-data, ui-monospace, monospace)', fontSize: 'var(--font-size-label, 11px)', fontWeight: 600, lineHeight: '14px',
          }}>{count}</span>
        )}
        <span style={{ writingMode: 'vertical-rl', fontSize: 'var(--font-size-label, 11px)', letterSpacing: '.05em', color: 'var(--text-secondary, #5a6268)', whiteSpace: 'nowrap' }}>{railLabel != null ? railLabel : Name}</span>
      </button>
      {railPin}
    </React.Fragment>
  );

  /* The peek lies over the rail, not beside it: the rail is the collapsed form of this same
     column, so opening it draws one column with one pin in one footer. */
  const overlay = !isPinned && !floating && peeking && (
    <div
      data-panel-peek={id || name}
      style={{
        position: 'absolute', top: 0, bottom: 0, [side === 'end' ? 'right' : 'left']: 0, width: peekWidth, zIndex: 30,
        display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--surface-card, #fff)',
        [edgeKey]: BORDER_STRONG, boxShadow: '0 8px 28px rgba(7,54,82,.22)',
      }}
    >
      {column}
    </div>
  );

  /* Floating: the whole column over the content at its edge. The root is static and takes
     no width, so the column anchors to the host's positioned workspace and siblings keep the
     space; `floatOffset` clears a tab strip at that edge. */
  const floatOff = typeof floatOffset === 'number' ? floatOffset + 'px' : floatOffset || '0px';
  const floater = floating && (
    <div
      data-panel-float={id || name}
      style={{
        position: 'absolute', top: 0, bottom: 0, [side === 'end' ? 'right' : 'left']: floatOffset, zIndex: 30,
        width: panelWidth, maxWidth: 'calc(100% - ' + floatOff + ')', boxSizing: 'border-box',
        display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'hidden',
        background: 'var(--surface-card, #fff)', [edgeKey]: BORDER_STRONG,
        boxShadow: 'var(--shadow-lg, 0 4px 8px rgba(0,0,0,.06), 0 12px 32px rgba(0,0,0,.14))',
      }}
    >
      {column}
    </div>
  );

  const rootLayout = isSheet
    ? { position: 'fixed', inset: 0, zIndex: 1401, width: 'auto', border: 0 }
    : floating
      ? { position: 'static', width: 0, [edgeKey]: 0 }
      : null;
  const state = isSheet ? 'sheet' : isPinned ? 'pinned' : floating ? 'floating' : 'railed';

  /* ---- Stacked: a full-width block behind a toggle strip ----------------------- */
  const stackId = 'panel-stack-' + React.useId().replace(/[^A-Za-z0-9_-]/g, '');
  if (isStacked) {
    const open = wantsPin;
    const top = (stackEdge || (side === 'end' ? 'bottom' : 'top')) === 'top';
    const labels = stackLabel || {};
    const text = open ? labels.hide || 'Hide ' + name : labels.show || 'Show ' + name;
    const toggle = () => {
      const next = !open;
      if (pinned === undefined) setOwnPinned(next);
      if (onPinChange) onPinChange(next);
      say(Name + (next ? ' shown.' : ' hidden.'));
    };
    const strip = (
      <div data-panel-strip="" style={{
        flex: 'none', width: '100%', height: 32, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 6px 0 8px', background: 'var(--surface-secondary, #f8f9fa)',
        [top ? 'borderBottom' : 'borderTop']: BORDER,
      }}>
        <Button variant="ghost" size="xs" icon={icon} onClick={toggle} aria-expanded={open} aria-controls={open ? stackId : undefined}>{text}</Button>
        {count != null && !open && (
          <span aria-label={countLabel} style={{
            fontFamily: 'var(--font-data, ui-monospace, monospace)', fontSize: 'var(--font-size-label, 11px)', fontWeight: 600,
            color: 'var(--text-secondary, #5a6268)',
          }}>{count}</span>
        )}
      </div>
    );
    const block = open && (
      <div id={stackId} style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'hidden', [top ? 'borderBottom' : 'borderTop']: BORDER_STRONG }}>
        {column}
      </div>
    );
    return (
      <div
        ref={rootRef}
        data-panel={id || name}
        data-panel-state={open ? 'stacked-open' : 'stacked'}
        style={{
          flex: open ? '0 1 auto' : 'none', position: 'relative', boxSizing: 'border-box', width: '100%',
          display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, background: 'var(--surface-card, #fff)',
          ...style,
        }}
        {...rest}
      >
        {top ? strip : block}
        {top ? block : strip}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      data-panel={id || name}
      data-panel-state={state}
      onBlur={onRootBlur}
      onKeyDown={onRootKeyDown}
      style={{
        flex: 'none', position: 'relative', boxSizing: 'border-box',
        width: isPinned ? panelWidth : RAIL_W,
        display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0,
        background: 'var(--surface-card, #fff)',
        [edgeKey]: BORDER_STRONG,
        transition: reduce || dragging || isSheet || floating ? 'none' : 'width .3s ease',
        ...rootLayout,
        ...style,
      }}
      {...rest}
    >
      {isPinned ? (
        <div style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
          {column}
        </div>
      ) : floating ? floater : rail}
      {overlay}
      {seam}
    </div>
  );
}
