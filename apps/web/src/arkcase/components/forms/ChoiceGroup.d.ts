import React from 'react';

export interface ChoiceGroupOption {
  /** Stable key; the value `onChange` reports. */
  id: string;
  /** The choice's name, e.g. "Degrade and continue". Forms the radio's accessible name with `meta`. */
  title: React.ReactNode;
  /** Identifier beside the title in the data face, e.g. the contract value `degrade`. */
  meta?: React.ReactNode;
  /** One or two sentences under the title (12px `text-secondary`); the radio's accessible description. */
  description?: React.ReactNode;
  /** Revealed under the option only while it is checked, outside the radio, so it may hold its own controls. */
  detail?: React.ReactNode;
  /** Shown but not selectable, and skipped by the arrow keys. */
  disabled?: boolean;
  /** Leading `bi-*` studio glyph in the Studio duotone: 20px above the title on a card (a role picker), 14px before it in a row. */
  icon?: string;
  /** Small decorative sketch of the choice, e.g. a wireframe of how a control looks. On a card it is drawn full width above the glyph and title, 6px over them, in place of `icon`; in a row it sits before the title, in place of `icon`. Wrapped `aria-hidden` — the title must still name the choice — and dimmed with a disabled option. */
  preview?: React.ReactNode;
  /** Extra attributes for the option's radio element, e.g. `{ 'data-launch-mode': 'upload' }`; a `style` here merges over the radio's own. */
  props?: Record<string, unknown> & { style?: React.CSSProperties };
}

export interface ChoiceGroupGroup {
  /** Band label over the run, e.g. "Committed records"; the run is a `group` named by it. */
  label: string;
  /** The options in this run. */
  options: ChoiceGroupOption[];
}

export interface ChoiceGroupProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'style' | 'onChange'> {
  /** Accessible name of the radiogroup. Omit inside a FormField, whose label names it. */
  label?: string;
  /** Options before any group, in order. @default [] */
  options?: ChoiceGroupOption[];
  /** Labelled runs of options after the ungrouped ones, each headed by an 11px band with its count. */
  groups?: ChoiceGroupGroup[];
  /** The checked option's id, or null when nothing is chosen; with `multiple`, the array of checked ids. The group never picks one on its own. @default null */
  value?: string | null | string[];
  /**
   * Called with the chosen id and option on click, Space or Enter; with `(null, null)` from the Unchoose button.
   * Never called by focus or arrow keys. With `multiple`, called with the next array of checked ids and the
   * toggled option (click or Space), or `([], null)` from Unchoose.
   */
  onChange?: (id: any, option: ChoiceGroupOption | null) => void;
  /** Several choices at once: a `group` of `checkbox` items drawn with a 16px check box; every enabled option is a tab stop and Space toggles it. `value` is then an array of ids. @default false */
  multiple?: boolean;
  /** Lay each run of options out in an auto-fill grid whose columns are at least this wide (a number is pixels), e.g. 230 for settings check cards. Omit for one column. */
  minColumnWidth?: number | string;
  /** `card` is a bordered card per option, 10px apart; `row` is a list of rows with a 3px left rail and `list-divider` hairlines. @default "card" */
  variant?: 'card' | 'row';
  /** Shows an outline Unchoose button once an option is chosen; it reports `onChange(null, null)` and returns focus to the group. @default false */
  clearable?: boolean;
  /** Label of the clear button. @default "Unchoose" */
  clearLabel?: string;
  /** Style overrides for the ChoiceGroup root. */
  style?: React.CSSProperties;
}

/** Single-select radiogroup drawn as cards or rows; nothing is pre-picked, arrows move focus, Space or Enter selects. */
export function ChoiceGroup(props: ChoiceGroupProps): React.JSX.Element;
