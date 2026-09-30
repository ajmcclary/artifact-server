/** The three supported theme ids. */
export type ThemeId = 'default' | 'dark' | 'high-contrast';

/** Storage backend used by the theme preference helpers (tests may inject a fake). */
export type ThemeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The canonical list of supported theme ids. */
export const THEMES: ThemeId[];

/**
 * Read the persisted theme id. Returns `'default'` when nothing is stored,
 * the stored value is not a known theme, or storage cannot be read (quota,
 * private mode, corrupted JSON).
 *
 * @param storage - Optional storage backend; defaults to `window.localStorage` in the browser.
 */
export function readThemePreference(storage?: ThemeStorage): ThemeId;

/**
 * Persist a theme id. Returns `true` when the value was written, `false` when
 * storage failed (quota, private mode) or the theme is unknown. Unknown
 * themes are ignored rather than written.
 *
 * @param theme - The theme id to persist.
 * @param storage - Optional storage backend; defaults to `window.localStorage` in the browser.
 */
export function writeThemePreference(theme: ThemeId, storage?: ThemeStorage): boolean;

/**
 * Apply a theme id to a root element by setting `data-theme`. The default
 * root is `document.documentElement`; in non-browser environments this is
 * a no-op. Unknown theme ids fall back to `'default'` (which clears the
 * attribute to the `:root` default).
 *
 * @param theme - The theme id to apply.
 * @param root - Optional root element; defaults to `document.documentElement`.
 */
export function applyThemePreference(theme: ThemeId, root?: HTMLElement): void;

/**
 * Bootstrap helper: read the stored preference and apply it to the document
 * root. Safe to call during SSR; returns the theme id that was applied.
 */
export function initThemePreference(): ThemeId;

/** What the user picked: `'system'` or one of the three themes. */
export type ThemeMode = 'system' | ThemeId;

/** Every pickable mode, in picker order: `system`, `default`, `dark`, `high-contrast`. */
export const THEME_MODES: ThemeMode[];

/** Display labels for the modes (`default` reads "Default", as the Storybook toolbar and every artboard name it). */
export const THEME_MODE_LABELS: Record<ThemeMode, string>;

/** The theme the OS asks for now: `prefers-contrast: more` → high-contrast, `prefers-color-scheme: dark` → dark, else default. */
export function resolveSystemTheme(): ThemeId;

/** The theme a mode paints. `'system'` (and anything unknown) resolves through {@link resolveSystemTheme}. `'light'` is accepted as an alias of `'default'`. */
export function resolveThemeMode(mode: ThemeMode | 'light' | string): ThemeId;

/** Read the persisted mode (same `arkcase.theme.v1` key). Nothing stored, unknown or unreadable → `'system'`. */
export function readThemeMode(storage?: ThemeStorage): ThemeMode;

/** Persist a mode, `'system'` included. Returns false on an unknown mode or a storage failure. */
export function writeThemeMode(mode: ThemeMode, storage?: ThemeStorage): boolean;

export interface ThemeController {
  getMode(): ThemeMode;
  getTheme(): ThemeId;
  /** Switch mode. Persists unless `{ persist: false }`; a persisted pick also clears a host pin. Returns false on an unknown mode. */
  setMode(mode: ThemeMode | 'light', options?: { persist?: boolean }): boolean;
  /** Called with `{ mode, theme }` after every apply. Returns an unsubscribe. */
  subscribe(listener: (detail: { mode: ThemeMode; theme: ThemeId }) => void): () => void;
}

export interface BootThemeOptions {
  /** Element that receives `data-theme` / `data-theme-mode`. Default `document.documentElement`. */
  root?: HTMLElement;
  /** Optional storage adapter used to persist the selected theme mode. */
  storage?: ThemeStorage;
  /** Query string to read `?theme=` from. Default `window.location.search`. */
  search?: string;
}

/**
 * Boot a page's theme and keep it current. Precedence: `?theme=` (a host pin,
 * never persisted) → the stored mode → `'system'`. Follows the OS while in
 * system mode, other tabs via the `storage` event, and an embedding host via
 * `postMessage({ type: 'arkcase:theme', mode })`. Idempotent per window (the
 * controller lives on `window.__arkcaseTheme`). Every apply dispatches
 * `arkcase:themechange` on window. Returns null outside a browser.
 */
export function bootTheme(options?: BootThemeOptions): ThemeController | null;

/** A `DemoPanel` group (section "Appearance") with one row of the four modes, the current one selected. */
export function themeModeGroup(
  mode: ThemeMode,
  onPick: (mode: ThemeMode) => void,
  options?: { section?: string; label?: string },
): {
  section: string;
  rows: {
    name: 'theme';
    label: string;
    note: string | null;
    disabled: false;
    options: { label: string; value: ThemeMode; selected: boolean }[];
    onPick: (value: ThemeMode) => void;
  }[];
};

/** What `arkcase:themechange` carries: the picked mode and the theme it paints. */
export interface ThemeChangeDetail {
  /** The mode the user or host picked, `'system'` included. */
  mode: ThemeMode;
  /** The theme that mode resolved to and painted. */
  theme: ThemeId;
}

/**
 * Subscribe to the `arkcase:themechange` window event that every `bootTheme` apply dispatches.
 * The callback receives `{ mode, theme }` and the raw event. Returns an unsubscribe; a no-op
 * outside a browser.
 */
export function onThemeChange(callback: (detail: ThemeChangeDetail, event: Event) => void): () => void;

/** Options for `appearanceGroup`. */
export interface AppearanceGroupOptions {
  /** Controller to read and set; defaults to the page's booted controller (`bootTheme()`, which boots once if needed). */
  controller?: Pick<ThemeController, 'getMode' | 'setMode'> | null;
  /** DemoPanel section name. @default "Appearance" */
  section?: string;
  /** Row label. @default "Theme" */
  label?: string;
}

/**
 * `themeModeGroup(ctl.getMode(), m => ctl.setMode(m))` for the page's booted theme controller —
 * the Appearance group a `DemoPanel` shows. Null when no controller is available (outside a
 * browser).
 */
export function appearanceGroup(options?: AppearanceGroupOptions): ReturnType<typeof themeModeGroup> | null;
