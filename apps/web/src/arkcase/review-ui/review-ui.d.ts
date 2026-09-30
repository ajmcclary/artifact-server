import React from 'react';

export interface ArtifactPage {
  path: string;
  name: string;
  group: string;
  description?: string;
  isDefault?: boolean;
  unavailable?: boolean;
}
export interface PagePickerProps {
  pages: ArtifactPage[];
  value: string;
  onSelect: (path: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  limit?: number;
  onLoadMore: () => void;
  phone?: boolean;
  inline?: boolean;
  automatic?: boolean;
  label?: string;
  onAnnounce?: (message: string) => void;
}
export interface ArtifactLinkRow {
  label: string;
  url: string;
  path?: string;
  description?: string;
}
export interface ArtifactLinksProps {
  rows: ArtifactLinkRow[];
  onCopy: (text: string, label: string) => React.ReactNode;
  copyAll?: string;
  title: string;
  note?: string;
}
export interface ArtifactFile {
  /** Path within the version; a leading folder segment places the row inside that folder. */
  name: string;
  size?: string | number;
  icon?: string;
  role?: string;
  onSelect?: (e: React.MouseEvent) => void;
}
export interface FileGroupsProps {
  /** Every file in the version, in display order. Top-level files render first. */
  files: ArtifactFile[];
  /** Accessible name for the inventory, e.g. "Files in version 7". */
  label: string;
  /** Path of the selected file; its folder opens automatically. */
  selected?: string;
}
/** Reuses the host's React and ArkCase components, including in the portable runtime. */
export function createReviewUI(react: typeof React, controls: Record<string, React.ElementType>): {
  PagePicker: React.ComponentType<PagePickerProps>;
  ArtifactLinks: React.ComponentType<ArtifactLinksProps>;
  /** Requires `Disclosure` and `FileList` in `controls`. */
  FileGroups: React.ComponentType<FileGroupsProps>;
};
