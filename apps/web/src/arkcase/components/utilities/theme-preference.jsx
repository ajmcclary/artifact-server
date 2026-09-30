/**
 * ArkCase theme preference — a small localStorage-backed preference, not a
 * component: stores the user's chosen theme id under `arkcase.theme.v1` and
 * applies it by setting `data-theme` on the document root. Reads tolerate
 * private mode, quota, hand-edited or corrupted values by falling back to
 * `'default'`; writes fail silently and return false so a host can report the
 * failure rather than announce a choice that was lost.
 */
export const THEMES = ['default', 'dark', 'high-contrast'];

const STORAGE_KEY = 'arkcase.theme.v1';

const store = (storage) => storage || (typeof window !== 'undefined' ? window.localStorage : null);

const warn = (what, e) => {
  if (typeof console !== 'undefined') console.warn('ThemePreference: ' + what + ' — ' + ((e && e.message) || e));
};

const isValidTheme = (value) => THEMES.includes(value);

/**
 * Read the persisted theme id. Returns `'default'` when nothing is stored,
 * the stored value is not a known theme, or storage cannot be read (quota,
 * private mode, corrupted JSON).
 */
export function readThemePreference(storage) {
  try {
    const s = store(storage);
    const raw = s ? s.getItem(STORAGE_KEY) : null;
    const parsed = raw ? JSON.parse(raw) : null;
    return isValidTheme(parsed) ? parsed : 'default';
  } catch (e) {
    warn('could not read theme preference from ' + STORAGE_KEY, e);
    return 'default';
  }
}

/**
 * Persist a theme id. Returns true when the value was written, false when
 * storage failed (quota, private mode) or the theme is unknown. Unknown
 * themes are ignored rather than written.
 */
export function writeThemePreference(theme, storage) {
  if (!isValidTheme(theme)) {
    warn('refusing to write unknown theme "' + theme + '"');
    return false;
  }
  try {
    const target = store(storage);
    /* v8 ignore next */
    if (!target) throw new Error('no storage');
    target.setItem(STORAGE_KEY, JSON.stringify(theme));
    return true;
  } catch (e) {
    warn('could not write theme preference to ' + STORAGE_KEY, e);
    return false;
  }
}

/**
 * Apply a theme id to a root element by setting `data-theme`. The default
 * root is `document.documentElement`; in non-browser environments this is
 * a no-op. Unknown theme ids fall back to `'default'` (which clears the
 * attribute to the :root default).
 */
export function applyThemePreference(theme, root) {
  if (typeof document === 'undefined') return;
  const target = root || document.documentElement;
  const value = isValidTheme(theme) ? theme : 'default';
  if (value === 'default') {
    target.removeAttribute('data-theme');
  } else {
    target.setAttribute('data-theme', value);
  }
}

/**
 * Bootstrap helper: read the stored preference and apply it to the document
 * root. Safe to call during SSR; returns the theme id that was applied.
 */
export function initThemePreference() {
  const theme = readThemePreference();
  applyThemePreference(theme);
  return theme;
}

/* ---------------------------------------------------------------------------
 * Theme MODE — what the user picked, which may be 'system'. The theme above is
 * what paints; a mode resolves to one. 'system' follows prefers-contrast: more
 * (→ high-contrast) and prefers-color-scheme: dark (→ dark) live.
 * ------------------------------------------------------------------------- */

/** Every pickable mode: 'system' plus the three themes. */
export const THEME_MODES = ['system', 'default', 'dark', 'high-contrast'];

/** Display labels for the modes, in picker order. */
export const THEME_MODE_LABELS = { system: 'System', default: 'Default', dark: 'Dark', 'high-contrast': 'High contrast' };

const MODE_ALIASES = { light: 'default' };
const normalizeMode = (value) => {
  const v = MODE_ALIASES[value] || value;
  return THEME_MODES.includes(v) ? v : null;
};

/** The theme the OS asks for right now. */
export function resolveSystemTheme() {
  if (typeof window === 'undefined' || !window.matchMedia) return 'default';
  if (window.matchMedia('(prefers-contrast: more)').matches) return 'high-contrast';
  if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'default';
}

/** The theme a mode paints: 'system' resolves through the OS, the rest are themselves. */
export function resolveThemeMode(mode) {
  const m = normalizeMode(mode) || 'system';
  return m === 'system' ? resolveSystemTheme() : m;
}

/** Read the persisted mode. Nothing stored (or unreadable) means 'system'. */
export function readThemeMode(storage) {
  try {
    const s = store(storage);
    const raw = s ? s.getItem(STORAGE_KEY) : null;
    return (raw && normalizeMode(JSON.parse(raw))) || 'system';
  } catch (e) {
    warn('could not read theme mode from ' + STORAGE_KEY, e);
    return 'system';
  }
}

/** Persist a mode ('system' included). Returns false on an unknown mode or a storage failure. */
export function writeThemeMode(mode, storage) {
  const m = normalizeMode(mode);
  if (!m) {
    warn('refusing to write unknown theme mode "' + mode + '"');
    return false;
  }
  try {
    const target = store(storage);
    /* v8 ignore next */
    if (!target) throw new Error('no storage');
    target.setItem(STORAGE_KEY, JSON.stringify(m));
    return true;
  } catch (e) {
    warn('could not write theme mode to ' + STORAGE_KEY, e);
    return false;
  }
}

/**
 * Boot the theme for a page and keep it current. Precedence: a `?theme=`
 * URL parameter (an embedding host's pin — never persisted), then the stored
 * mode, then 'system'. It follows the OS while the mode is 'system', other
 * tabs through the `storage` event, and an embedding host through
 * `postMessage({ type: 'arkcase:theme', mode })`. One controller per window:
 * a second call returns the first (an App that embeds a partial boots once).
 * Every change dispatches `arkcase:themechange` on window with `{ mode, theme }`.
 */
export function bootTheme(options = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  if (window.__arkcaseTheme) return window.__arkcaseTheme;
  const root = options.root || document.documentElement;
  const storage = options.storage;
  let pinned = null;
  try {
    pinned = normalizeMode(new URLSearchParams(options.search != null ? options.search : window.location.search).get('theme'));
  } catch (e) { /* no URL — nothing pinned */ }
  let mode = pinned || readThemeMode(storage);
  const listeners = new Set();

  const apply = () => {
    const theme = resolveThemeMode(mode);
    applyThemePreference(theme, root);
    root.setAttribute('data-theme-mode', mode);
    const detail = { mode, theme };
    listeners.forEach((fn) => { try { fn(detail); } catch (e) { warn('theme listener failed', e); } });
    try { window.dispatchEvent(new CustomEvent('arkcase:themechange', { detail })); } catch (e) { /* old engines */ }
  };

  const setMode = (next, opts = {}) => {
    const m = normalizeMode(next);
    if (!m) return false;
    mode = m;
    // A reviewer's own pick outranks the host's pin from here on.
    if (opts.persist !== false) { pinned = null; writeThemeMode(m, storage); }
    apply();
    return true;
  };

  const onSystem = () => { if (mode === 'system') apply(); };
  if (window.matchMedia) {
    ['(prefers-color-scheme: dark)', '(prefers-contrast: more)'].forEach((q) => {
      const mq = window.matchMedia(q);
      if (mq.addEventListener) mq.addEventListener('change', onSystem);
      else if (mq.addListener) mq.addListener(onSystem);
    });
  }
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY || pinned) return;
    mode = readThemeMode(storage);
    apply();
  });
  window.addEventListener('message', (e) => {
    const d = e && e.data;
    if (!d || d.type !== 'arkcase:theme') return;
    const m = normalizeMode(d.mode);
    if (!m) return;
    pinned = m;
    mode = m;
    apply();
  });

  const controller = {
    getMode: () => mode,
    getTheme: () => resolveThemeMode(mode),
    setMode,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  window.__arkcaseTheme = controller;
  apply();
  return controller;
}

/**
 * The Appearance section for a `DemoPanel`'s `groups`: one row of the four
 * modes, the current one selected, a pick routed to `onPick(mode)`.
 */
export function themeModeGroup(mode, onPick, options = {}) {
  const current = normalizeMode(mode) || 'system';
  return {
    section: options.section || 'Appearance',
    rows: [{
      name: 'theme',
      label: options.label || 'Theme',
      note: current === 'system' ? 'Following the device: ' + THEME_MODE_LABELS[resolveSystemTheme()] + '.' : null,
      disabled: false,
      options: THEME_MODES.map((m) => ({ label: THEME_MODE_LABELS[m], value: m, selected: m === current })),
      onPick: (value) => onPick && onPick(value),
    }],
  };
}

/** The window event every `bootTheme` controller dispatches after it applies a theme. */
const THEME_CHANGE_EVENT = 'arkcase:themechange';

/**
 * Call `callback({ mode, theme })` after every theme change on this window — the
 * `arkcase:themechange` event `bootTheme` dispatches — so an application re-renders theme-aware
 * content without hand-wiring the listener. Returns an unsubscribe; a no-op outside a browser.
 */
export function onThemeChange(callback) {
  if (typeof window === 'undefined' || typeof callback !== 'function') return () => {};
  const listener = (event) => callback((event && event.detail) || {}, event);
  window.addEventListener(THEME_CHANGE_EVENT, listener);
  return () => window.removeEventListener(THEME_CHANGE_EVENT, listener);
}

/**
 * The Appearance group for a `DemoPanel`, wired to the page's booted theme controller: the
 * current mode selected, a pick routed to `setMode`. Boots the theme if nothing has yet (boot is
 * idempotent per window); pass `options.controller` to use a specific one. Null outside a
 * browser.
 */
export function appearanceGroup(options = {}) {
  const { controller, ...groupOptions } = options || {};
  const ctl = controller || bootTheme();
  if (!ctl || typeof ctl.getMode !== 'function' || typeof ctl.setMode !== 'function') return null;
  return themeModeGroup(ctl.getMode(), (m) => ctl.setMode(m), groupOptions);
}
