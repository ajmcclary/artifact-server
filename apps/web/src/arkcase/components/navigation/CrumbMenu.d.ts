import React from 'react';

export interface CrumbMenuRenderProps {
  /** Closes the menu and returns focus to the crumb — call it after a pick. */
  close: () => void;
}

export interface CrumbMenuProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'title' | 'children'> {
  /** The crumb's visible text — the current choice ("v7", "index.html"); it truncates at `maxWidth`. */
  label: React.ReactNode;
  /** Accessible name of the trigger, naming the place and the action: "Version 7, the current version · Choose a version". */
  ariaLabel?: string;
  /** The menu's name: the Popover's label and the phone sheet's title, e.g. "Choose a page". */
  title: string;
  /** Controlled open state. @default false */
  open?: boolean;
  /** Every open and close, from the trigger, a dismissal or `close`. */
  onOpenChange: (open: boolean) => void;
  /** `popover` floats under the crumb; `sheet` is the phone's viewport sheet (44px trigger). @default "popover" */
  presentation?: 'popover' | 'sheet';
  /** Width of the floating menu in px. @default 320 */
  width?: number | string;
  /** Maximum trigger width before the label truncates (desktop). @default 260 */
  maxWidth?: number | string;
  /** Marks the crumb as the current place (`aria-current="page"`) — the last crumb of the trail. @default false */
  current?: boolean;
  /** Selector inside the menu that takes focus on open, e.g. the current row (`[aria-current="true"]`); else the first field or button. */
  focusSelector?: string;
  /** Stacking order of the floating menu. @default 1200 */
  zIndex?: number;
  /** The menu content, or a function of `{ close }` so a pick can close the menu. */
  children?: React.ReactNode | ((api: CrumbMenuRenderProps) => React.ReactNode);
  /** Style overrides for the crumb's wrapper. */
  style?: React.CSSProperties;
}

/**
 * A breadcrumb crumb that opens a picker: a ghost Button with a trailing chevron over a
 * Popover (a viewport sheet on a phone). Focus moves to the current row on open and back to
 * the crumb on `close`. Place it in `Breadcrumb variant="controls"` as a `{ node }` item.
 *
 * @startingPoint section="Navigation" subtitle="Breadcrumb crumb that opens a picker" viewport="700x320"
 */
export function CrumbMenu(props: CrumbMenuProps): React.JSX.Element;
