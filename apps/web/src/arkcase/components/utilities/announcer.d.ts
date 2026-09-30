import React from 'react';

/** Options for {@link createAnnouncer} and {@link useAnnouncer}. */
export interface AnnouncerOptions {
  /** Milliseconds between clearing the region and writing the new message. @default 40 */
  delay?: number;
}

/** An announce function returned by {@link createAnnouncer}. */
export interface Announcer {
  /** Clear the message now, then set `text` after the delay; a newer call replaces a pending one. */
  (text: string): void;
  /** Cancel a pending write (call on teardown). */
  cancel(): void;
}

/** Wrap a message setter with the clear-then-set trick so repeated identical messages are re-spoken. */
export function createAnnouncer(setMessage: (text: string) => void, options?: AnnouncerOptions): Announcer;

/** React state for a live region: render `message`, call `announce(text)`; pending writes are cancelled on unmount. */
export function useAnnouncer(options?: AnnouncerOptions): { message: string; announce: Announcer };

export interface LiveRegionProps {
  /** Text the region currently holds; changing it is what gets announced. @default "" */
  message?: string;
  /** `polite` renders `role="status"`; `assertive` renders `role="alert"` for urgent failures only. @default "polite" */
  politeness?: 'polite' | 'assertive';
  /** Style overrides merged over the visually hidden style. */
  style?: React.CSSProperties;
}

/**
 * Visually hidden live region for surfaces without an AppShell (which owns its own regions).
 */
export function LiveRegion(props: LiveRegionProps): React.JSX.Element;
