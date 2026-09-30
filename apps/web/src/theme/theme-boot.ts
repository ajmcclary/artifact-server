/**
 * Classic, render-blocking script: `vite/theme-boot-plugin.ts` bundles it as
 * an IIFE into `assets/theme-boot-<hash>.js` and loads it first in
 * `review.html`'s head, so `data-theme` (and the loading skeleton's navigation
 * width) is on `<html>` before first paint.
 * It imports the DS utility directly rather than the `@/arkcase` barrel so
 * the bundle carries no components.
 */
import {bootTheme} from "../arkcase/components/utilities/theme-preference.jsx";

import {bootShellLayout} from "../shell/shell-boot.ts";
import {migrateLegacyTheme} from "./theme-migration.ts";

try {
  migrateLegacyTheme(window.localStorage);
} catch {
  // Storage is blocked; there is nothing to migrate.
}

try {
  bootTheme();
} catch {
  // The page renders with the :root default theme instead.
}

try {
  bootShellLayout(document.documentElement, window.localStorage);
} catch {
  // Storage is blocked or unreadable; the skeleton shows the navigation rail.
}
