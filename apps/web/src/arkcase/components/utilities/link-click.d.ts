/** The mouse event fields `isModifiedClick` reads; a React or DOM `MouseEvent` qualifies. */
export interface ModifiedClickEvent {
  /** The pressed button: 0 primary, 1 middle, 2 secondary. */
  button: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/**
 * True for a click the browser should handle on a native link: a non-primary button, or Cmd,
 * Ctrl, Shift or Alt held (a new tab, a new window, a download). Return early on it and let the
 * `href` work; on a plain primary click, `preventDefault()` and handle the selection in place.
 */
export function isModifiedClick(event: ModifiedClickEvent | null | undefined): boolean;
