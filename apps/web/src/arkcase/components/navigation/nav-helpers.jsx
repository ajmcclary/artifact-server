/* Private helpers shared by SideNav and MobileNavDrawer. Not a public module: it has no contract,
   guide, story or ds-exports entry, and its exports may change with the two components. */

/* True when a media query matches; false with no window or no matchMedia. */
export const matchesMedia = (q) => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q).matches : false);

/* A navigation count caps at 99+. */
export const countText = (n) => (Number(n) > 99 ? '99+' : String(n));

/* The link-click test (a modified or non-primary click belongs to the browser) is the public
   `isModifiedClick` in utilities/link-click.jsx. */
