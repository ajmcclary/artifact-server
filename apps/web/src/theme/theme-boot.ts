/**
 * Classic, render-blocking script: `vite/theme-boot-plugin.ts` bundles it as
 * an IIFE into `assets/theme-boot-<hash>.js` and loads it first in
 * `review.html`'s head, so `data-theme` is on `<html>` before first paint.
 * It imports the DS utility directly rather than the `@/arkcase` barrel so
 * the bundle carries no components.
 */
import {bootTheme} from "../arkcase/components/utilities/theme-preference.jsx";

import {migrateLegacyTheme} from "./theme-migration.ts";

// While review.html carries data-review-theme, the legacy appearance toggle
// still owns `artifact-review-theme` and rewrites it on every load; migrating
// then would reset that toggle. Task 7 removes the attribute with the toggle,
// which turns the migration on.
const legacyToggleOwnsTheme = document.documentElement.hasAttribute("data-review-theme");

try {
  if (!legacyToggleOwnsTheme) migrateLegacyTheme(window.localStorage);
} catch {
  // Storage is blocked; there is nothing to migrate.
}

try {
  bootTheme();
} catch {
  // The page renders with the :root default theme instead.
}
