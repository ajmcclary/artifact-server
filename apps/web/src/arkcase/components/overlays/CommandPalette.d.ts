import React from 'react';

/** One row in the palette's results. */
export interface CommandPaletteResult {
  /** Stable key for the row; a changed id set resets the active row to the first. */
  id: string | number;
  /** Eyebrow above the title naming what the row is, e.g. "Artifact", "Version", "Conversation". */
  kind?: string;
  /** The row's main text, 13px semibold. */
  title: React.ReactNode;
  /** Secondary context line, e.g. "Records intake · v4". */
  meta?: React.ReactNode;
  /** Identifier, date or author line in the data font, e.g. a version id. */
  note?: React.ReactNode;
  /** Called with the result when it is clicked or chosen with Enter; the host decides whether to close. */
  onSelect: (result: CommandPaletteResult) => void;
}

/** A read-only keyboard hint shown on the status row. */
export interface CommandPaletteShortcut {
  /** Keycap text as displayed, e.g. "⌘K", "/", "Esc". */
  keys: string;
  /** Spoken equivalent for symbolic keycaps, e.g. "Command K". */
  label?: string;
}

export interface CommandPaletteProps {
  /** Whether the palette is showing; nothing renders when false. @default false */
  open?: boolean;
  /** Called on Escape, a scrim click and the close button. The host sets `open` false. */
  onClose?: () => void;
  /** Controlled query text in the search field. @default "" */
  query?: string;
  /** Called with the new field value on every edit. */
  onQueryChange?: (value: string) => void;
  /** Hint in the empty field, e.g. "Search artifacts, versions and conversations". */
  placeholder?: string;
  /** Accessible name of the dialog and the search field; the listbox is named "{label} results". @default "Search" */
  label?: string;
  /** Accessible name of the close button. @default "Close search" */
  closeLabel?: string;
  /** Result count text on the status row, e.g. "3 results". A polite status unless `onAnnounce` is given. */
  countLabel?: React.ReactNode;
  /** Keyboard hints on the status row, in order. Hints only — the host installs the shortcuts. */
  shortcuts?: CommandPaletteShortcut[];
  /** The matches for the current query, in display order. */
  results?: CommandPaletteResult[];
  /** Shown while the query is empty — what the search covers. */
  idle?: React.ReactNode;
  /** Title of the no-match state. @default "Nothing matches" */
  emptyTitle?: React.ReactNode;
  /** Body of the no-match state — what the search covered. */
  emptyBody?: React.ReactNode;
  /** Called by the no-match state's clear button; the host empties the query. Without it the button is not drawn. */
  onClear?: () => void;
  /** Label of the no-match state's clear button. @default "Clear the search" */
  clearLabel?: string;
  /** Receives `countLabel` as text when it changes while open, for a host that owns a live region (AppShell `announce`); the status row then stops being a live region. */
  onAnnounce?: (message: string) => void;
  /** The scrim's z-index; the panel sits one above. @default 1400 */
  zIndex?: number;
  /**
   * Takes free text: Enter in the field calls `onSubmit(text)` with the trimmed query when no
   * result row is active (no results, or none given) and the text is not blank. With
   * `onSubmit` the no-match state is not drawn, and without `results` the field is a plain
   * text field rather than a combobox — the "ask one question" command bar.
   */
  onSubmit?: (text: string) => void;
  /** Replaces the field's search glyph at the start of the header row, e.g. an assistant mark. */
  leading?: React.ReactNode;
  /** Replaces the results area (list, no-match and idle states) with the host's own content — an answer, a hint, follow-up links — inside a polite live region. */
  children?: React.ReactNode;
  /** Scrim weight: `default` is navy at 38%; `tint` is navy at 18%, the Modal's `tint`, for a bar that keeps the page readable. @default "default" */
  scrim?: 'default' | 'tint';
  /** Style overrides for the panel. */
  style?: React.CSSProperties;
}

/**
 * Centred global search dialog: the search field drives a listbox of results (ArrowUp/Down,
 * Enter), Tab is trapped inside, Escape and the scrim close, and focus returns to the opener.
 */
export function CommandPalette(props: CommandPaletteProps): React.JSX.Element | null;
