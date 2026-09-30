import React from 'react';

export interface ToolbarProps {
  /** Accessible name of the toolbar (`aria-label`), e.g. "Preview toolbar". Required in practice: every toolbar needs a name. */
  label?: string;
  /** Layout axis, emitted as `aria-orientation`; Left/Right move focus when horizontal, Up/Down when vertical. @default "horizontal" */
  orientation?: 'horizontal' | 'vertical';
  /** `light` sits on the host surface; `navy` is the app-chrome bar (`surface-header` fill, `text-on-navy` ink, tonal icons). @default "light" */
  variant?: 'light' | 'navy';
  /** Space between controls, in pixels or any CSS length. @default 4 */
  gap?: number | string;
  /** Lets the controls wrap onto further rows when the toolbar is too narrow, instead of overflowing; row gap equals `gap`. @default false */
  wrap?: boolean;
  /** The controls: Button, IconButton, SegmentedControl, native inputs and selects, separators and spacers. */
  children?: React.ReactNode;
  /** Called before the toolbar's own arrow-key handling; call `preventDefault()` to take the key. */
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  /** Style overrides for the toolbar root (height, padding, overflow). */
  style?: React.CSSProperties;
}

/** A labelled `role="toolbar"` with arrow-key movement between its controls; native tab order is kept. */
export function Toolbar(props: ToolbarProps): React.JSX.Element;

export interface ToolbarSeparatorProps {
  /** Line colour; inherited from the enclosing Toolbar when omitted (`border-color`, or `border-on-navy` on navy). */
  variant?: 'light' | 'navy';
  /** Orientation of the enclosing toolbar; the separator is drawn perpendicular to it. Inherited when omitted. */
  orientation?: 'horizontal' | 'vertical';
  /** Style overrides for the separator line. */
  style?: React.CSSProperties;
}

/** A `role="separator"` hairline (1px by 20px) dividing groups of toolbar controls. */
export function ToolbarSeparator(props: ToolbarSeparatorProps): React.JSX.Element;

export interface ToolbarSpacerProps {
  /** Style overrides for the flexible spacer. */
  style?: React.CSSProperties;
}

/** A flexible, hidden gap that pushes the following toolbar controls to the far end. */
export function ToolbarSpacer(props: ToolbarSpacerProps): React.JSX.Element;

export interface ToolbarGroupProps {
  /** Accessible name of the joined group (`role="group"`), e.g. "Zoom". */
  label?: string;
  /** The joined controls — IconButtons, Buttons, a Select; a 1px `border-color` divider is drawn between each pair. */
  children?: React.ReactNode;
  /** Style overrides for the group root. */
  style?: React.CSSProperties;
}

/** A bordered, joined segment of toolbar controls with hairline dividers between them; the controls lose their own borders and inner corners. */
export function ToolbarGroup(props: ToolbarGroupProps): React.JSX.Element;
