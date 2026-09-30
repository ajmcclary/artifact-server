/**
 * Classic, render-blocking script: `vite/theme-boot-plugin.ts` bundles it as
 * an IIFE into `assets/theme-boot-<hash>.js` and loads it first in
 * `review.html`'s head, so `data-theme` is on `<html>` before first paint.
 * It imports the DS utility directly rather than the `@/arkcase` barrel so
 * the bundle carries no components.
 */
import {bootTheme} from "../arkcase/components/utilities/theme-preference.jsx";

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
