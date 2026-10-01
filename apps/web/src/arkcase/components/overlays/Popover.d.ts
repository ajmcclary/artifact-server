import React from 'react';

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

export interface PopoverProps {
  /** Controlled open state. Omit for uncontrolled. */
  open?: boolean;
  /** Uncontrolled initial state. @default false */
  defaultOpen?: boolean;
  /** Fires on every open change, trigger or dismiss alike. */
  onOpenChange?: (open: boolean) => void;
  /** Fires on an Escape or outside-press dismiss. */
  onClose?: () => void;
  /** The control the content anchors to — a host element or a ref-forwarding
   * component. It is cloned to inject `aria-haspopup="dialog"`,
   * `aria-expanded`, and the toggling press; a host `onClick` still runs first. */
  trigger: React.ReactNode;
  /** Accessible name for the floating content. @default "Dialog" */
  label?: string;
  /** Anchor edge and alignment; follows scrolling and resizing in the native top layer (fixed fallback). @default "bottom-start" */
  placement?: PopoverPlacement;
  /** Flip vertically when the content would run off the viewport. @default true */
  flip?: boolean;
  /** Outside-press and Escape dismiss the content. @default true */
  dismissible?: boolean;
  /** Cycle Tab inside the content while open; leaving is what Escape and the
   * trigger are for. A nested floating menu stops its own Escape first.
   * @default false */
  containTab?: boolean;
  /** Local stacking order — coordinate with Modal's 1050+ frame by intent. @default 30 */
  zIndex?: number;
  /** Content width in px. @default 320 */
  width?: number | string;
  /** Every open and close is spoken here — hand it the shell's live region. */
  onAnnounce?: (text: string) => void;
  /** `popover` floats beside the trigger; `sheet` is the phone form — the same trigger opens the content in a viewport `Modal` (focus trapped, Escape and × close, focus returns to the trigger). @default "popover" */
  presentation?: 'popover' | 'sheet';
  /** Title of the sheet's Modal header. @default label */
  sheetTitle?: React.ReactNode;
  /** In `sheet`: what takes focus when it opens — a selector inside the content or a ref. @default the dialog itself */
  initialFocus?: string | React.RefObject<HTMLElement | null>;
  /** Style overrides for the Popover root. */
  style?: React.CSSProperties;
  /** Merged over the floating content's surface; not applied to the sheet, whose body is the Modal's. */
  contentStyle?: React.CSSProperties;
  /** Content rendered inside the Popover. */
  children?: React.ReactNode;
}

/**
 * An anchored non-modal container: the trigger's own press opens it, a press
 * outside or Escape closes it, and the content floats beside the trigger
 * instead of centring like a `Modal`. Reach for it when the reader keeps the
 * page they are on — a picker's list, a row's actions. Reach for `Modal` when
 * nothing else may happen first, and for `Menu` when the floating content is
 * a row-action sheet the host already positions. `presentation="sheet"` renders
 * the same content as a phone viewport sheet.
 *
 * @startingPoint section="Overlays" subtitle="Anchored trigger-and-content popover" viewport="700x260"
 */
export function Popover(props: PopoverProps): React.JSX.Element;
