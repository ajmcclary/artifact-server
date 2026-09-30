/** Which arrow keys move focus: Left/Right, Up/Down, or all four. */
export type RovingOrientation = 'horizontal' | 'vertical' | 'both';

/** Options for `rovingKeyDown`. */
export interface RovingOptions {
  /** CSS selector for the elements focus moves among (disabled, `aria-disabled`, hidden and nested-composite matches are skipped). */
  selector: string;
  /** Arrow keys that move focus; Home and End always go to the first and last item. @default "horizontal" */
  orientation?: RovingOrientation;
  /** Past the last item go to the first (and back); false stops at the ends. @default true */
  wrap?: boolean;
  /** Click the newly focused item, for selection that follows focus (tabs, radios). @default false */
  activate?: boolean;
  /** Element to search instead of `event.currentTarget`. */
  container?: Element | null;
}

/** The parts of a DOM or React keyboard event the helpers read. */
export interface KeyEventLike {
  /** The key value, e.g. "ArrowRight". */
  key: string;
  /** The element the key was pressed on. */
  target: EventTarget | null;
  /** The element the handler is attached to. */
  currentTarget?: EventTarget | null;
  /** Alt/Option held. */
  altKey?: boolean;
  /** Control held. */
  ctrlKey?: boolean;
  /** Meta/Command held. */
  metaKey?: boolean;
  /** Shift held. */
  shiftKey?: boolean;
  /** Physical key, e.g. "KeyK" or "Slash"; lets a combo match when a modifier changes `key`. */
  code?: string;
  /** True when an earlier handler already handled the key. */
  defaultPrevented?: boolean;
  /** Stops the browser default. */
  preventDefault: () => void;
  /** Stops the event reaching ancestor handlers. */
  stopPropagation: () => void;
}

/**
 * Move focus among the enabled, visible elements matching `selector` inside the container
 * (`event.currentTarget` unless `container` is given). Arrow keys per `orientation`, Home and
 * End; ignored with Alt/Ctrl/Meta, inside text fields and native selects, and when the event
 * target is not one of the items. Returns true, after preventDefault and stopPropagation,
 * when the key was handled.
 */
export function rovingKeyDown(event: KeyEventLike, options: RovingOptions): boolean;

/** The single printable character a key event types, lower-cased; null for modified, whitespace or named keys. */
export function typeaheadChar(event: Pick<KeyEventLike, 'key' | 'altKey' | 'ctrlKey' | 'metaKey'>): string | null;

/**
 * Index of the next label after `fromIndex` (cycling past the end) that starts with `char`,
 * case-insensitively; -1 when none does. A `fromIndex` of -1 searches from the start.
 */
export function typeahead(labels: string[], fromIndex: number, char: string): number;

/** Options for `focusWhenReady`. */
export interface FocusWhenReadyOptions {
  /** Animation frames to retry before giving up. @default 10 */
  tries?: number;
}

/**
 * Focus the element `getEl` returns once it is connected, retrying one animation frame at a
 * time (for an element a pending state change will render). Returns a cancel function.
 */
export function focusWhenReady(getEl: () => HTMLElement | null, options?: FocusWhenReadyOptions): () => void;

/**
 * A key combination such as `"mod+k"`, `"shift+/"`, `"escape"` or `"alt+arrowdown"`: modifiers
 * (`mod`, `ctrl`/`control`, `meta`/`cmd`, `alt`/`option`, `shift`) joined by `+` before a key
 * name or single character. `mod` is Meta (Command) or Control.
 */
export type Hotkey = string;

/**
 * True when the keyboard event matches `combo` (or any combo in an array). `mod` accepts either
 * `metaKey` or `ctrlKey`; modifiers the combo does not name must not be held, except that a
 * character which itself needs Shift ("?") still matches without naming it. Single characters
 * also match by physical `code`, so `"shift+/"` matches the "?" it types.
 */
export function matchesHotkey(
  event: Pick<KeyEventLike, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'code'>,
  combo: Hotkey | Hotkey[],
): boolean;

/**
 * True when the element takes typed text: a text-like `input` (not a checkbox, radio, button,
 * range, color or file input), a `textarea`, a `select` or a contentEditable region. Guard
 * bare-character shortcuts such as "/" with it.
 */
export function isTypingTarget(target: EventTarget | null | undefined): boolean;

/**
 * Keep Tab and Shift+Tab inside `container`: wrap between its first and last enabled, visible,
 * tabbable descendants, pull escaped focus back in, and hold focus when nothing inside is
 * tabbable. Returns true (after preventDefault) when it moved or held focus; false for other
 * keys and for Tab steps the browser can take without leaving the container.
 */
export function trapTab(event: KeyEventLike, container: Element | null | undefined): boolean;
