import React from 'react';

/** One option in the scope menu inside the search pill. */
export interface RailHeaderScopeOption {
  /** Value reported to `scope.onChange`. */
  value: string;
  /** Visible label, also shown on the pill's scope button when selected. */
  label: string;
  /** Count shown at the option's end, in the data face. */
  count?: React.ReactNode;
}

/** The list's population selector, drawn inside the search pill. */
export interface RailHeaderScope {
  /** The selected option's value. */
  value: string;
  /** Names the menu and prefixes the button's accessible name — "Status: Active". @default "Scope" */
  label?: string;
  /** Options, in menu order. */
  options: RailHeaderScopeOption[];
  /** Called with the chosen option's value; the host owns the selection. */
  onChange: (value: string) => void;
}

export interface RailHeaderProps {
  /** The list's name, rendered as a heading in the display face (20px). Not rewritten by filtering. */
  title?: React.ReactNode;
  /** Heading level of the title. @default 2 */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Secondary icon controls (refresh, filter, settings): light, small, square IconButtons. Never the add button. */
  actions?: React.ReactNode;
  /** Present to render the add button — the primary circle, always the last header control. */
  onAdd?: (e: React.MouseEvent) => void;
  /** @default "Add" */
  /** Accessible name and tooltip of the add button. */
  addLabel?: string;
  /** Natively disables the add button (read-only roles). */
  addDisabled?: boolean;
  /** Select-all state. */
  selectAll?: boolean;
  /** Present to render the select-all checkbox before the search. */
  onSelectAll?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** @default "Select All" */
  /** Visible label and accessible name of the select-all control. */
  selectAllLabel?: string;
  /** Current search text. */
  query?: string;
  /** Reports each search edit. Every list header carries a search unless `search={false}`; omitting this otherwise warns. */
  onQuery?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** `false` drops the pill search (and its scope menu) for a list with no quick filter — an Admin grid that filters in its own toolbar; the working row then remains only for select-all, and no warning is raised. @default true */
  search?: boolean;
  /** @default "Search" */
  /** Hint shown in the empty search field. */
  queryPlaceholder?: string;
  /** Accessible name of the search field; start it with "Search". @default "Search <title>" */
  queryLabel?: string;
  /** Keyboard shortcut announced on the search field, e.g. "/". */
  queryKeyShortcuts?: string;
  /** Ref to the native search input, for host shortcuts that focus it. */
  inputRef?: React.Ref<HTMLInputElement>;
  /** Key handler on the search input, e.g. Escape clears the query. */
  onQueryKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Population selector inside the search pill. Escape closes only its menu and restores focus to the scope trigger. */
  scope?: RailHeaderScope;
  /** Filter controls shown under the search while `filtersOpen` is true. */
  filters?: React.ReactNode;
  /** Whether the filter slot is open; the host toggles it from its filter action. */
  filtersOpen?: boolean;
  /** One-line summary of applied filters, shown while the filter slot is closed. */
  summary?: React.ReactNode;
  /** Style overrides for the RailHeader root. */
  style?: React.CSSProperties;
}

/** The one list-panel header: display-face title, actions and add button, pill search with scope. */
export function RailHeader(props: RailHeaderProps): React.JSX.Element;
