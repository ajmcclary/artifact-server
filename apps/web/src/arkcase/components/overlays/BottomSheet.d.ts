import React from 'react';

export interface BottomSheetProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title' | 'style'> {
  /** Whether the sheet is shown. Closed, it renders nothing. @default false */
  open?: boolean;
  /** Called on Escape, the scrim, the close button and a downward drag past 96px (or a quick flick). */
  onClose?: () => void;
  /** Serif heading in the sheet's header; it also names the dialog. */
  title?: React.ReactNode;
  /** `aria-label` of the dialog when there is no `title`. @default "Sheet" */
  label?: string;
  /** Sheet content; it scrolls inside the sheet with `overscroll-behavior: contain`. */
  children?: React.ReactNode;
  /** Content of a footer band under a hairline — the sheet's actions. */
  footer?: React.ReactNode;
  /** Extra controls at the header's end, before the close button. */
  headerEnd?: React.ReactNode;
  /** Draw the 44px close button. @default true */
  showClose?: boolean;
  /** Accessible name of the close button. @default "Close" */
  closeLabel?: string;
  /** `false` makes the sheet a decision: no scrim close, no Escape, no drag, no close button. @default true */
  dismissible?: boolean;
  /** Tallest the sheet may grow before its body scrolls. @default "92dvh" */
  maxHeight?: number | string;
  /** Selector, inside the sheet, of the element that takes focus on open. Defaults to the first control in the body. */
  initialFocus?: string;
  /** Selector of the element that takes focus back on close, for openers WebKit does not focus on tap. */
  returnFocusSelector?: string;
  /** Stacking order of the scrim; the sheet sits one above it. @default 1040 */
  zIndex?: number;
  /** Style overrides for the sheet surface. */
  style?: React.CSSProperties;
  /** Style overrides for the scrolling body. */
  bodyStyle?: React.CSSProperties;
}

/**
 * The phone's modal surface: it rises from the bottom edge over the navy scrim, holds the
 * host's content, and never pushes a navigation level. A grabber and header take a downward
 * drag to dismiss; Escape, the scrim and the close button close it too. Tab is trapped, the
 * body's scroll is locked and focus returns to the opener.
 */
export function BottomSheet(props: BottomSheetProps): React.JSX.Element | null;
