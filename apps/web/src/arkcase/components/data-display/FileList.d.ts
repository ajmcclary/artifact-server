import React from 'react';

/** One file row. */
export interface FileListItem {
  /** File name or path, shown in the data face; its extension picks the default icon. */
  name: string;
  /** Human-readable size, e.g. "4.2 KB"; appended as `name · size`. */
  size?: string | number;
  /** `bi-*` studio icon class overriding the extension-derived icon. */
  icon?: string;
  /** Short trailing role, e.g. "entry" or "asset", in 11px `text-secondary`. */
  role?: string;
  /** Makes the row a full-width button; called on activation. */
  onSelect?: (e: React.MouseEvent) => void;
}

export interface FileListProps extends Omit<React.HTMLAttributes<HTMLUListElement>, 'style' | 'children'> {
  /** Rows to render, in order. */
  files: FileListItem[];
  /** Accessible name for the list, e.g. "Files in version 4". */
  label?: string;
  /** Style overrides for the FileList root. */
  style?: React.CSSProperties;
}

/** List of file rows: type icon, name and size in the data face, optional role. */
export function FileList(props: FileListProps): React.JSX.Element;
