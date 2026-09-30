import {writeThemeMode, type ThemeMode} from "../arkcase/components/utilities/theme-preference.jsx";
import type {KeyValueStorage} from "../lib/key-value-storage.ts";

/** The old two-theme toggle's key: `moon` (dark) or `dawn` (light). */
export const LEGACY_THEME_KEY = "artifact-review-theme";

/** The DS theme-preference key (`arkcase.theme.v1`), which the DS does not export. */
const themeModeKey = "arkcase.theme.v1";

const legacyModes = new Map<string, ThemeMode>([
  ["dawn", "default"],
  ["moon", "dark"],
]);

function readLegacyTheme(storage: KeyValueStorage): string | null {
  try {
    return storage.getItem(LEGACY_THEME_KEY);
  } catch {
    return null;
  }
}

/**
 * Moves the old toggle's choice onto the DS theme mode once: `moon` becomes
 * Dark and `dawn` becomes Light (`default`), written with the DS
 * `writeThemeMode`, and then the old key is removed. A mode the user already
 * chose in the new appearance menu wins. An unknown old value is removed
 * without choosing a mode. When storage cannot be read or the write fails,
 * nothing is removed, so the next load tries again.
 */
export function migrateLegacyTheme(storage: KeyValueStorage): void {
  const legacy = readLegacyTheme(storage);
  if (legacy === null) return;
  const mode = legacyModes.get(legacy);
  try {
    if (mode !== undefined && storage.getItem(themeModeKey) === null && !writeThemeMode(mode, storage)) return;
    storage.removeItem(LEGACY_THEME_KEY);
  } catch {
    // Storage refused the read or the removal; the next load retries.
  }
}
