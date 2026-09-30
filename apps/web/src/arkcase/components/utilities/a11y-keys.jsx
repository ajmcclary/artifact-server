/**
 * ArkCase a11y keys — the framework-free keyboard helpers every composite widget wrote again:
 * arrow-key roving among a container's controls (toolbars, tab lists, radio groups), first-letter
 * typeahead over a list of labels, and a focus call that waits for a re-render to put its target
 * on the page. Promoted from the Designer Storybook prototype's `rove`, `toolbarKey`, `tabKey`,
 * `radioKey`, `treeKey` typeahead and `refocus` / `flushTreeFocus` helpers. No React: the
 * functions take a DOM keyboard event (a React synthetic event works too) and plain values.
 */

const ARROWS = {
  horizontal: { prev: ['ArrowLeft'], next: ['ArrowRight'] },
  vertical: { prev: ['ArrowUp'], next: ['ArrowDown'] },
  both: { prev: ['ArrowLeft', 'ArrowUp'], next: ['ArrowRight', 'ArrowDown'] },
};

/* A composite nested inside the roving container owns its own arrow keys. */
const NESTED = '[role="menu"], [role="menubar"], [role="listbox"], [role="tree"], [role="grid"], [role="dialog"], [role="toolbar"]';

const TEXT_TYPES = /^(?:text|search|email|url|tel|password|number|date|datetime-local|month|week|time)$/i;

/* Arrow keys, Home and End already mean something inside a text field or a native select. */
function ownsArrows(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select' || el.isContentEditable) return true;
  return tag === 'input' && TEXT_TYPES.test(el.type || 'text');
}

function usable(el, root) {
  if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.hidden) return false;
  if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
  const nested = el.parentElement && el.parentElement.closest(NESTED);
  return !(nested && nested !== root && root.contains(nested));
}

/**
 * Move focus among the enabled, visible elements matching `selector` inside the container.
 * Returns true (after preventDefault and stopPropagation) when the key was handled.
 */
export function rovingKeyDown(event, options) {
  const { selector, orientation = 'horizontal', wrap = true, activate = false, container } = options || {};
  if (!event || !selector || event.defaultPrevented) return false;
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  const keys = ARROWS[orientation] || ARROWS.horizontal;
  const key = event.key;
  const isPrev = keys.prev.indexOf(key) >= 0;
  const isNext = keys.next.indexOf(key) >= 0;
  if (!isPrev && !isNext && key !== 'Home' && key !== 'End') return false;
  const root = container || event.currentTarget;
  if (!root || typeof root.querySelectorAll !== 'function') return false;
  if (ownsArrows(event.target)) return false;
  const items = Array.from(root.querySelectorAll(selector)).filter((el) => usable(el, root));
  const at = items.indexOf(event.target);
  if (at < 0) return false;
  const last = items.length - 1;
  let next;
  if (key === 'Home') next = 0;
  else if (key === 'End') next = last;
  else if (isNext) next = at === last ? (wrap ? 0 : last) : at + 1;
  else next = at === 0 ? (wrap ? last : 0) : at - 1;
  event.preventDefault();
  event.stopPropagation();
  const el = items[next];
  if (el !== event.target) {
    el.focus();
    if (activate && typeof el.click === 'function') el.click();
  }
  return true;
}

/**
 * The single printable character a key event types, lower-cased, or null for a modified,
 * whitespace or named key. Typeahead handlers call it before `typeahead`.
 */
export function typeaheadChar(event) {
  if (!event || event.altKey || event.ctrlKey || event.metaKey) return null;
  const k = event.key;
  return typeof k === 'string' && k.length === 1 && /\S/.test(k) ? k.toLowerCase() : null;
}

/**
 * The index of the next label, after `fromIndex` and cycling, that starts with `char`
 * (case-insensitive); -1 when none does.
 */
export function typeahead(labels, fromIndex, char) {
  if (!Array.isArray(labels) || !labels.length || typeof char !== 'string' || char.length !== 1 || !/\S/.test(char)) return -1;
  const ch = char.toLowerCase();
  const n = labels.length;
  const from = Number.isInteger(fromIndex) && fromIndex >= 0 && fromIndex < n ? fromIndex : -1;
  for (let step = 1; step <= n; step++) {
    const i = (from + step) % n;
    if (String(labels[i] == null ? '' : labels[i]).trim().toLowerCase().indexOf(ch) === 0) return i;
  }
  return -1;
}

const nextFrame = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));

/**
 * Focus the element `getEl` returns once it is on the page, retrying one animation frame at a
 * time up to `tries` times (a row that a state change is about to render). Returns a cancel
 * function.
 */
export function focusWhenReady(getEl, options) {
  const tries = options && Number.isFinite(options.tries) ? options.tries : 10;
  let cancelled = false;
  let attempt = 0;
  const run = () => {
    if (cancelled) return;
    const el = typeof getEl === 'function' ? getEl() : null;
    if (el && el.isConnected && typeof el.focus === 'function') {
      el.focus();
      if (el.ownerDocument && el.ownerDocument.activeElement === el) return;
    }
    if (attempt++ < tries) nextFrame(run);
  };
  nextFrame(run);
  return () => { cancelled = true; };
}

/* ---------------------------------------------------------------------------
 * Global shortcuts and modal Tab containment — promoted from the Artifacts
 * App's hand-built search palette: Cmd/Ctrl-K, "/" outside a field, and a
 * Tab trap that wraps at the ends of a temporary layer.
 * ------------------------------------------------------------------------- */

const NAMED_KEYS = {
  esc: 'escape', escape: 'escape', enter: 'enter', return: 'enter', tab: 'tab', space: ' ',
  up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright',
  arrowup: 'arrowup', arrowdown: 'arrowdown', arrowleft: 'arrowleft', arrowright: 'arrowright',
  home: 'home', end: 'end', pageup: 'pageup', pagedown: 'pagedown',
  backspace: 'backspace', delete: 'delete', del: 'delete', plus: '+',
};

const PUNCTUATION_CODES = {
  '/': 'Slash', '.': 'Period', ',': 'Comma', ';': 'Semicolon', "'": 'Quote', '[': 'BracketLeft',
  ']': 'BracketRight', '\\': 'Backslash', '-': 'Minus', '=': 'Equal', '`': 'Backquote',
};

/* The physical key a single printable character sits on, so "shift+/" matches the "?" it types
   and "alt+k" matches on a Mac, where Option changes the character. */
function codeFor(ch) {
  if (/^[a-z]$/.test(ch)) return 'Key' + ch.toUpperCase();
  if (/^[0-9]$/.test(ch)) return 'Digit' + ch;
  return PUNCTUATION_CODES[ch] || null;
}

function parseCombo(combo) {
  const parts = String(combo).trim().toLowerCase().split('+');
  // "mod++" splits into ['mod', '', ''] — the empty tail means the key itself is "+".
  let key = parts.pop();
  if (key === '' && parts.length && parts[parts.length - 1] === '') { parts.pop(); key = '+'; }
  const mods = new Set(parts.filter(Boolean).map((m) => (m === 'control' ? 'ctrl' : m === 'cmd' || m === 'command' ? 'meta' : m === 'option' ? 'alt' : m)));
  return { key: NAMED_KEYS[key] || key, mods };
}

/**
 * True when a keyboard event matches `combo` ("mod+k", "shift+/", "escape", "alt+arrowdown"),
 * or any of an array of combos. `mod` accepts either Meta (Command) or Control, so one binding
 * serves macOS and everything else. Modifiers the combo does not name must not be held.
 */
export function matchesHotkey(event, combo) {
  if (!event || combo == null) return false;
  if (Array.isArray(combo)) return combo.some((c) => matchesHotkey(event, c));
  if (typeof event.key !== 'string') return false;
  const { key, mods } = parseCombo(combo);
  if (!key) return false;
  const ctrl = !!event.ctrlKey;
  const meta = !!event.metaKey;
  if (mods.has('mod')) {
    if (!ctrl && !meta) return false;
    if (ctrl && meta && !mods.has('ctrl') && !mods.has('meta')) return false;
  } else {
    if (ctrl !== mods.has('ctrl')) return false;
    if (meta !== mods.has('meta')) return false;
  }
  if (!!event.altKey !== mods.has('alt')) return false;
  const pressed = event.key.toLowerCase();
  const literal = pressed === key;
  const code = key.length === 1 ? codeFor(key) : null;
  const byCode = !!code && event.code === code;
  if (mods.has('shift')) return !!event.shiftKey && (literal || byCode);
  if (!event.shiftKey) return literal || byCode;
  // Shift not named: only a character that itself needs Shift ("?", "+") still matches.
  return literal && key.length === 1 && !/[a-z0-9]/.test(key);
}

const NON_TEXT_INPUTS = /^(?:button|submit|reset|checkbox|radio|range|color|file|image|hidden)$/i;

/**
 * True when the element takes typed text — a text-like input, a textarea, a select or an
 * editable region — so a bare-character shortcut such as "/" must leave the key alone.
 */
export function isTypingTarget(target) {
  if (!target || !target.tagName) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return tag === 'INPUT' && !NON_TEXT_INPUTS.test(target.type || 'text');
}

const TABBABLE = 'a[href], area[href], button, input, select, textarea, iframe, summary, [contenteditable=""], [contenteditable="true"], [tabindex]';

function tabbables(container) {
  return Array.from(container.querySelectorAll(TABBABLE)).filter((el) => {
    if (el.disabled || el.getAttribute('tabindex') === '-1' || el.hidden) return false;
    if (el.tagName === 'INPUT' && el.type === 'hidden') return false;
    if (el.closest('[inert]')) return false;
    return typeof el.getClientRects !== 'function' || el.getClientRects().length > 0;
  });
}

/**
 * Keep Tab and Shift+Tab inside `container`: wrap from the last tabbable descendant to the
 * first and back, pull focus that has escaped the container back in, and hold focus when the
 * container has nothing tabbable. Returns true when it moved focus (after preventDefault);
 * false leaves the browser's own Tab step, which stays inside.
 */
export function trapTab(event, container) {
  if (!event || event.key !== 'Tab' || !container || typeof container.querySelectorAll !== 'function') return false;
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  const doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const active = doc ? doc.activeElement : null;
  const items = tabbables(container);
  if (!items.length) {
    event.preventDefault();
    if (active !== container && typeof container.focus === 'function' && container.hasAttribute && container.hasAttribute('tabindex')) container.focus();
    return true;
  }
  const first = items[0];
  const last = items[items.length - 1];
  let target = null;
  if (!active || !container.contains(active)) target = event.shiftKey ? last : first;
  else if (event.shiftKey && (active === first || active === container)) target = last;
  else if (!event.shiftKey && active === last) target = first;
  if (!target) return false;
  event.preventDefault();
  target.focus();
  return true;
}
