import React from 'react';

export interface CopyButtonProps {
  /** `bi-*` studio icon class for the resting state. @default "bi-clipboard" */
  icon?: string;
  /** `bi-*` studio icon class for the copied state. @default "bi-check2" */
  copiedIcon?: string;
  /** @default "sm" */
  /** Visual size of the CopyButton. */
  size?: 'sm' | 'md' | 'lg';
  /**
   * Ghost with no children renders an icon-only button; ghost with children
   * renders a labelled outline button; link renders a labelled link button.
   * @default "ghost"
   */
  variant?: 'ghost' | 'outline' | 'link' | 'navy';
  /** Tooltip placement naming the control. @default "top" */
  placement?: 'top' | 'bottom' | 'end' | 'right' | 'left';
  /** Wraps the tooltip to 236px — for the rare name that is a sentence. @default false */
  wide?: boolean;
  /** Confirmation label replacing the children while copied. */
  copiedLabel?: string;
  /** Controlled copied state; omit for the internal two-second hold. */
  copied?: boolean;
  /** Length of the internal copied hold in ms. @default 2000 */
  holdMs?: number;
  /** Disables interaction with the CopyButton. */
  disabled?: boolean;
  /** The host's clipboard write — the button never touches the clipboard itself. */
  onCopy?: (e: React.MouseEvent) => void;
  /** Every copy is spoken here — hand it the shell's live region. */
  onAnnounce?: (text: string) => void;
  /** Label text; omit for the icon-only row copy. */
  children?: React.ReactNode;
  /** Style overrides for the CopyButton root. */
  style?: React.CSSProperties;
}

/**
 * Copy-to-clipboard with in-place confirmation: the icon (and label, when it
 * has one) swap to the copied state for a short hold, then swap back. The
 * tooltip names the control on hover and keyboard focus.
 *
 * @startingPoint section="Actions" subtitle="Copy with in-place confirmation" viewport="700x150"
 */
export function CopyButton(props: CopyButtonProps): React.JSX.Element;
