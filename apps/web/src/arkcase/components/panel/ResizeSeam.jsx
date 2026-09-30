import React from 'react';

/**
 * ArkCase ResizeSeam — a factory, not a component: the drag arithmetic Panel's and SideNav's
 * seams share, and the Workers Compensation seam scanner too, as one implementation with no
 * renderer of its own. It holds the clamp (rounded, bounded), the side-to-direction rule, the
 * one-second hold-to-collapse on reaching the minimum, commit-on-up only when the width changed,
 * the reset, the key table and the two announcements. Nothing here touches the DOM, a store or
 * the window; a caller feeds it pointer positions and keys and draws what `onState` reports.
 *
 * `onOvershoot` is what separates a panel from a navigation: given, a drag that reaches
 * `minWidth` and holds for `holdMs` fires it and ends the drag with the width untouched, so a
 * re-pin restores it; omitted, the drag simply bottoms out at the minimum. `now`, `raf` and
 * `caf` are the clock and the frame, injectable so a test can drive the hold. Exposed on the
 * namespace because its name is capitalised; `useResizeSeam` is its React face.
 *
 * `axis: 'y'` measures a height instead: feed it `clientY`, and `side` names the edge the
 * pane docks to — `end` for a bottom dock, whose seam on the top edge grows upward. The key
 * table then takes only the vertical arrows (toward the seam's outside grows), and the
 * announcements say "height". The width-named callbacks and state keep their names.
 */
const KEY_STEP = 16;
const HOLD_MS = 1000;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n)));
const capitalise = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

export function ResizeSeam({
  minWidth = 200, maxWidth = 720, side = 'start', axis = 'x', step = KEY_STEP, name = 'panel', holdMs = HOLD_MS,
  onWidthChange, onAnnounce, onOvershoot, onState, now, raf, caf,
} = {}) {
  const clock = now || (() => Date.now());
  const frame = raf || ((f) => requestAnimationFrame(f));
  /* v8 ignore next */
  const cancelFrame = caf || ((h) => cancelAnimationFrame(h));
  const Name = capitalise(name);
  const vertical = axis === 'y';
  const measure = vertical ? 'height' : 'width';
  const dir = side === 'end' ? -1 : 1;
  const canCollapse = typeof onOvershoot === 'function';
  let drag = null; /* { startX, startW, w } while a press is down */
  let arm = null;  /* { t0, handle } while the hold is running */
  let armPct = 0;

  const state = () => ({ width: drag ? drag.w : null, dragging: !!drag, arming: !!drag && armPct > 0, armPct });
  const report = () => { if (onState) onState(state()); };
  const say = (text) => { if (onAnnounce) onAnnounce(text); };
  const commitWidth = (w) => {
    const next = clamp(w, minWidth, maxWidth);
    if (onWidthChange) onWidthChange(next);
    say(Name + ' ' + measure + ' set to ' + next + ' pixels.');
    return next;
  };
  const resetWidth = () => {
    if (onWidthChange) onWidthChange(null);
    say(Name + ' ' + measure + ' reset to the default.');
  };
  const disarm = () => {
    if (arm) { if (arm.handle != null) cancelFrame(arm.handle); arm = null; }
    armPct = 0;
  };
  const finish = (collapse) => {
    const d = drag;
    drag = null;
    disarm();
    report();
    if (!d) return;
    /* The overshoot asked for a collapse, not a narrower panel: the width stands. */
    if (collapse) { if (onOvershoot) onOvershoot(); }
    else if (d.w !== d.startW) commitWidth(d.w);
  };
  const armCollapse = () => {
    if (arm) return;
    const t0 = clock();
    arm = { t0, handle: null };
    const tick = () => {
      if (!arm) return;
      armPct = Math.min(1, (clock() - t0) / holdMs);
      if (armPct >= 1) { arm = null; armPct = 0; finish(true); return; }
      report();
      arm.handle = frame(tick);
    };
    arm.handle = frame(tick);
  };

  return {
    /** A press at `x` over a seam whose column is `startWidth` px wide. */
    begin(x, startWidth) {
      const w = clamp(typeof startWidth === 'number' ? startWidth : minWidth, minWidth, maxWidth);
      drag = { startX: x, startW: w, w };
      report();
      if (canCollapse && w <= minWidth) armCollapse();
    },
    /** The pointer at `x`: the clamped live width, arming on reaching the minimum. */
    move(x) {
      if (!drag) return;
      const want = drag.startW + dir * (x - drag.startX);
      drag.w = clamp(want, minWidth, maxWidth);
      /* Reaching the minimum is the whole signal; the hold is what separates a deliberate
         collapse from a drag that simply bottomed out. */
      if (canCollapse && want <= minWidth) armCollapse(); else disarm();
      report();
    },
    /** The release: commit a changed width, else nothing. */
    end() { finish(false); },
    /** Drop the drag and any hold without a commit. */
    cancel() { drag = null; disarm(); report(); },
    /** The key table over `current`; true when the key was one of the seam's. */
    key(k, current) {
      const cur = clamp(typeof current === 'number' ? current : minWidth, minWidth, maxWidth);
      /* Across the x axis ArrowUp and ArrowDown also widen and narrow; across y only the
         vertical arrows count, toward the seam's outside growing the pane. */
      const wider = vertical ? (side === 'end' ? 'ArrowUp' : 'ArrowDown') : side === 'end' ? 'ArrowLeft' : 'ArrowRight';
      const narrower = vertical ? (side === 'end' ? 'ArrowDown' : 'ArrowUp') : side === 'end' ? 'ArrowRight' : 'ArrowLeft';
      let next = null;
      if (k === wider || (!vertical && k === 'ArrowUp')) next = cur + step;
      else if (k === narrower || (!vertical && k === 'ArrowDown')) next = cur - step;
      else if (k === 'Home') next = minWidth;
      else if (k === 'End') next = maxWidth;
      else if (k === 'Delete' || k === 'Backspace') { resetWidth(); return true; }
      if (next === null) return false;
      commitWidth(next);
      return true;
    },
    reset() { resetWidth(); },
    state,
  };
}
