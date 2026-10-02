/* Private helpers shared by SideNav and MobileNavDrawer. Not a public module: it has no contract,
   guide, story or ds-exports entry, and its exports may change with the two components. */

/* True when a media query matches; false with no window or no matchMedia. */
export const matchesMedia = (q) => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q).matches : false);

/* A navigation count caps at 99+. */
export const countText = (n) => (Number(n) > 99 ? '99+' : String(n));

/* A modified or non-primary click on a link row — Cmd/Ctrl for a new tab, Shift for a new window,
   Alt to download — belongs to the browser: it follows the href natively, selects nothing and
   leaves any drawer or peek open. */
export const leftToBrowser = (e) => e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
