import React from 'react';

/** The primary action of the default footer a Modal draws when no `footer` is given. */
export interface ModalPrimaryAction {
  /** Button text, e.g. "Create project". */
  label: string;
  /** Leading `bi-*` icon class, e.g. "bi-folder-plus". */
  icon?: string;
  /** Called when the primary button is activated. */
  onClick: () => void;
  /** Native `disabled` while the form cannot be submitted. */
  disabled?: boolean;
  /** Button variant, e.g. "danger" for a destructive confirmation. @default "primary" */
  variant?: 'primary' | 'secondary' | 'success' | 'danger' | 'warning' | 'info' | 'light' | 'dark' | 'link' | 'ghost' | 'navy';
}

export interface ModalProps {
  /** @default true */
  /** Whether the Modal is visible. */
  open?: boolean;
  /** Visible title for the Modal. */
  title?: React.ReactNode;
  /** One line of context under the title. */
  subtitle?: React.ReactNode;
  /** `bi-*` icon class for the navy title tile. */
  icon?: string;
  /** sm 480 · md 620 · lg 820 · full — inset 28px top and bottom (or `inset` on every edge) · viewport — the whole viewport at inset 0, with no radius, border or shadow. @default "md" */
  size?: 'sm' | 'md' | 'lg' | 'full' | 'viewport';
  /** With `size="full"` (centred), sit this many px inside every viewport edge, with no max width or height. Omitted, `full` keeps its 28px top/bottom inset and 94vw cap. */
  inset?: number;
  /**
   * Render the backdrop and dialog into a host `<div data-ak-modal-portal>` appended to
   * `document.body` while open, via `ReactDOM.createPortal` from the page's `window.ReactDOM`
   * global (the React UMD pages load it; a Storybook or bundler host assigns it). Without
   * that global the dialog renders in place. @default false
   */
  portal?: boolean;
  /**
   * While open, set `inert` on every other child of `document.body` (scripts and styles
   * excepted) — the portal host is kept live, or, without `portal`, the body child that
   * contains the dialog. Elements that were already inert are left alone; the rest are
   * restored on close, before focus returns to the opener. @default false
   */
  inertSiblings?: boolean;
  /** What takes focus on open instead of the dialog frame: a selector matched inside the dialog (e.g. `"[data-viewer-close]"`) or a ref. Ignored when focus is already inside. */
  initialFocus?: string | React.RefObject<HTMLElement | null>;
  /** Called when the Modal requests dismissal. */
  onClose?: () => void;
  /** Footer actions — primary last, on the #F8F9FA cap. */
  footer?: React.ReactNode;
  /** Dialog content between its header and footer. */
  children?: React.ReactNode;
  /** Escape closes only the innermost shared overlay; backdrop click closes this dialog. An Escape keydown whose default a nested layer prevented (`event.preventDefault()`) is left to that layer. @default true */
  dismissible?: boolean;
  /** Id of an external heading, when the dialog draws its own. */
  labelledBy?: string;
  /** `aria-label`, for a dialog named without a title. */
  label?: string;
  /** `top` docks under the bar (centred, or at `anchor.right`); `end` docks to the end edge from `anchor.top` to the bottom. @default "center" */
  placement?: 'center' | 'top' | 'end';
  /** Offsets for a docked placement, in px. */
  anchor?: { top?: number; right?: number };
  /** Width of a docked placement; `size` is not read there. */
  width?: number | string;
  /** True moves focus into the dialog on open, traps Tab inside it, and returns focus to the opener on close.
   * False is an anchored panel: no `aria-modal`, no focus move, no scroll lock. Escape still closes when dismissible. @default true */
  modal?: boolean;
  /** @default "navy" */
  /** Backdrop treatment behind the dialog. */
  backdrop?: 'navy' | 'tint' | 'none';
  /** False draws no title row; the host draws its own inside the frame. @default true */
  header?: boolean;
  /** Merged over the body's padding and scroll. */
  bodyStyle?: React.CSSProperties;
  /** Heading level of the title element. @default 2 */
  titleLevel?: 2 | 3 | 4 | 5 | 6;
  /** Nodes at the end of the title row, before the close button — step chips, a note. */
  headerEnd?: React.ReactNode;
  /** The backdrop's z-index; the frame sits one above. @default 1050 */
  zIndex?: number;
  /** Without `footer`, draws the standard footer — a secondary outline Cancel, then this primary sm Button last. `footer` wins when both are given. */
  primaryAction?: ModalPrimaryAction;
  /** Label of the default footer's cancel button. @default "Cancel" */
  cancelLabel?: string;
  /** Called by the default footer's cancel button; falls back to `onClose`. */
  onCancel?: () => void;
  /**
   * The phone's full-screen form of any placement: inset 0, full width and height, no radius,
   * border, shadow or transform, and safe-area padding at the top and bottom. The host passes it
   * for its phone display profile; `style` still merges over it (a docked results sheet can keep
   * a `top`). @default false
   */
  fullscreen?: boolean;
  /** Apply `fullscreen` automatically while the viewport is narrower than this many px (a `max-width` media query, re-read on change). Omitted, only `fullscreen` applies. */
  fullscreenBelow?: number;
  /** Leads the footer band, left-aligned and taking the room the buttons leave: a hint, or the note that says why the primary action is disabled. Drawn with the default footer, an explicit `footer`, or alone. */
  footerNote?: React.ReactNode;
  /** `default` sets the note in 13px `text-secondary`; `danger` in semibold `pill-danger-fg`, for a gate the reader must clear. @default "default" */
  footerNoteTone?: 'default' | 'danger';
  /** Style overrides for the Modal root. */
  style?: React.CSSProperties;
}

/** Dialog for forms, pickers and confirmations. A modal dialog owns focus for its
 * whole open session — in on open, Tab trapped inside, back to the opener on
 * close — so hosts never hand-roll a trap around it. */
export function Modal(props: ModalProps): React.JSX.Element | null;
