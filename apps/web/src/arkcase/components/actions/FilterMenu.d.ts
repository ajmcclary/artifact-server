import React from 'react';
import type { MenuItem } from '../overlays/Menu';

export interface FilterMenuProps {
  /** Controlled open state; omit it to let the menu keep its own. */
  open?: boolean;
  /** Initial open state when uncontrolled. @default false */
  defaultOpen?: boolean;
  /** Called with the next open state on every toggle (a second press on the trigger closes), item activation that closes the menu, Escape or outside click. Escape and a closing item return focus to the trigger. */
  onOpenChange?: (open: boolean) => void;
  /** `bi-*` glyph before the trigger's label, e.g. "bi-funnel". */
  icon?: string;
  /** The trigger's text: the filter and what it is set to, e.g. "All types", "Types · 2" or "Group: Date". A node may carry visually hidden detail. */
  label: React.ReactNode;
  /** Accessible name of the menu, e.g. "Artifact types". @default the label when it is a string */
  menuLabel?: string;
  /** The choices, as Menu items: `type: 'checkbox'` with `keepOpen` for a filter, `type: 'radio'` for a grouping or sort, `heading` and `divider` rows. @default [] */
  items?: MenuItem[];
  /** Narrowest the menu may be, in px. */
  minWidth?: number;
  /** Menu width; the default sizes it to its longest row, capped at 400px or the viewport less 32px. @default "max-content" */
  width?: number | string;
  /** Menu row density; a sheet is always comfortable. */
  density?: 'compact' | 'comfortable';
  /** `popover` hangs the menu under the trigger (anchored, fixed position); `sheet` (a phone) opens the Menu's bottom sheet. @default "popover" */
  presentation?: 'popover' | 'sheet';
  /** Natively disables the trigger; the menu stays closed. @default false */
  disabled?: boolean;
  /** Ref to the trigger's wrapper, e.g. to move focus back to it after the filters are cleared. */
  triggerRef?: React.Ref<HTMLSpanElement>;
  /** Style overrides for the wrapper. */
  style?: React.CSSProperties;
}

/**
 * One filter of a page toolbar: a ghost trigger with a chevron that opens a Menu of checkbox or
 * radio choices, under the trigger or as a phone's bottom sheet.
 *
 * @startingPoint section="Actions" subtitle="A toolbar's filter menu" viewport="420x320"
 */
export function FilterMenu(props: FilterMenuProps): React.JSX.Element;
