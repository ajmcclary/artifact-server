/**
 * Storage keys and navigation widths, in a module with no imports so the
 * render-blocking boot script can read them without bundling components.
 */

/** The one localStorage key under which the review panes remember pins and widths. */
export const REVIEW_PANEL_STORAGE_KEY = "artifact-review-panels";

/** The navigation column's pin, stored under `REVIEW_PANEL_STORAGE_KEY`. */
export const NAV_PANEL_ID = "navMenu";

/** Matches the prototype's menu seam; both the header and rows share this width. */
export const navigationWidth = {defaultWidth: 232, minimum: 200, maximum: 380} as const;

/**
 * The pinned navigation's width in whole pixels, kept only while the
 * navigation is pinned, for the boot script to size the loading skeleton.
 */
export const NAV_BOOT_WIDTH_KEY = "artifact-review-nav-boot-width";
