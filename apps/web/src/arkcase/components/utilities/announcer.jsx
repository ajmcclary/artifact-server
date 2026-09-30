import React from 'react';

/**
 * ArkCase announcer — the clear-then-set live-region trick, written once. A screen reader
 * announces a live region when its text changes, so posting the same message twice ("Pin
 * cancelled", "240 pixels wide") is silent unless the region is emptied first and refilled a
 * tick later. `createAnnouncer` is the framework-free core, `useAnnouncer` its React state,
 * and `LiveRegion` the visually hidden region for surfaces that are not inside an AppShell
 * (AppShell already owns a polite and an assertive region; hand its `announce`/`alert` props
 * the `message` instead of mounting a second one).
 *
 * Written with `React.createElement` rather than JSX so the pure core also loads in Node's
 * test runner.
 */

/** Wrap a setter so each call clears the message, then sets it after `delay` ms. The newest call wins. */
export function createAnnouncer(setMessage, options) {
  const { delay = 40 } = options || {};
  let timer = null;
  const announce = (text) => {
    if (timer != null) clearTimeout(timer);
    setMessage('');
    timer = setTimeout(() => { timer = null; setMessage(text == null ? '' : String(text)); }, delay);
  };
  announce.cancel = () => { if (timer != null) clearTimeout(timer); timer = null; };
  return announce;
}

/** React state for a live region: `message` to render, `announce(text)` to (re-)speak it. Pending timers are cancelled on unmount. */
export function useAnnouncer(options) {
  const delay = options && options.delay;
  const [message, setMessage] = React.useState('');
  const announce = React.useMemo(() => createAnnouncer(setMessage, delay == null ? undefined : { delay }), [delay]);
  React.useEffect(() => () => announce.cancel(), [announce]);
  return { message, announce };
}

const VISUALLY_HIDDEN = {
  position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, border: 0,
  overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap',
};

/** A visually hidden live region: `role="status"` (polite) or `role="alert"` (assertive). */
export function LiveRegion({ message = '', politeness = 'polite', style, ...rest }) {
  const assertive = politeness === 'assertive';
  return React.createElement('div', {
    role: assertive ? 'alert' : 'status',
    'aria-live': assertive ? 'assertive' : 'polite',
    'aria-atomic': 'true',
    ...rest,
    style: { ...VISUALLY_HIDDEN, ...style },
  }, message);
}
