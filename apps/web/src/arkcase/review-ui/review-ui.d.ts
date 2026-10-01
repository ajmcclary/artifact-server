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
export type GalleryKind = 'prototype' | 'template' | 'component' | 'guideline' | 'documentation' | 'artboard';
export interface GalleryLink {
  title: string;
  /** Exact published path of the related document. */
  path: string;
  /** Identity passed to `onOpen`/`hrefFor` when paths repeat across artifacts; defaults to `path`. */
  id?: string;
}
export interface GalleryItem {
  /** Exact published path of the original HTML document. */
  path: string;
  /** Identity for keys, focus, `onOpen` and `hrefFor` when paths repeat across artifacts; defaults to `path`. */
  id?: string;
  /** Where the item comes from, such as an artifact name in a cross-project library. */
  context?: string;
  /** Declared by the publication's preview index. `.dc.html` alone never implies `template`. */
  kind: GalleryKind;
  /** Heading within the kind, such as a project group or card group. */
  section: string;
  title: string;
  description?: string;
  /** Declared preview viewport; placeholders keep its proportions. */
  viewport: { width: number; height: number };
  /** Same-origin, exact-version image URL supplied by the host; null draws a placeholder. */
  thumbnailUrl?: string | null;
  /** Related guides. Grid tiles show their count; list view links each beside the tile. */
  related?: GalleryLink[];
}
export interface DesignGalleryProps {
  title: string;
  description?: string;
  /** Decorative project cover, hidden on phone widths. */
  coverUrl?: string | null;
  items: GalleryItem[];
  query: string;
  onQueryChange: (query: string) => void;
  /** `'all'` or one GalleryKind; the host owns it so returning restores it. */
  kind?: 'all' | GalleryKind;
  onKindChange: (kind: 'all' | GalleryKind) => void;
  view?: 'grid' | 'list';
  onViewChange: (view: 'grid' | 'list') => void;
  /** Open one original document (a tile or a related guide) by its identity as the host's exact selected page. */
  onOpen: (id: string) => void;
  /** Optional shareable URL per identity; plain clicks still call `onOpen`, modified clicks follow the link. */
  hrefFor?: (id: string) => string;
  /** Tile identity (`id` or `path`) to focus on mount, typically the item the user returned from. */
  focusPath?: string | null;
  /** Initial scroll offset of the gallery's own scroll container, restored on mount. */
  scrollTop?: number;
  onScroll?: (scrollTop: number) => void;
  onAnnounce?: (message: string) => void;
  /** Host content above the controls, such as a compatibility notice. */
  notice?: React.ReactNode;
  phone?: boolean;
}
/** Reuses the host's React and ArkCase components, including in the portable runtime. */
export interface ActivityEvent {
  id: string;
  type: 'comment' | 'version' | 'resolution' | 'agent' | 'access' | 'admin';
  /** Epoch milliseconds; NaN when the record carries no readable time. */
  at: number;
  actor: string;
  verb: string;
  artifactId?: string; artifactName?: string; projectId?: string; projectName?: string; archived?: boolean;
  version?: number; fromVersion?: number | null; firstVersion?: number; count?: number;
  thread?: { key: string; author: string; when?: string; at?: string; body: string; isResolved: boolean; replies: Array<{ id?: string; author: string; when?: string; at?: string; body: string }> };
  excerpt?: string; from?: string; to?: string; agent?: string; state?: string; detail?: string; icon?: string;
  needsYou: boolean; withAgent: boolean; adminOnly: boolean;
}
export interface ActivityFeedProps {
  /** One page of newest-first events. */
  events: ActivityEvent[];
  /** Reference time for the Today / Yesterday day labels. */
  now: number;
  hasMore: boolean;
  /** Entries not yet shown. `0` means "unknown": a cursor-paged host prints plain "Show older". */
  remaining: number;
  onShowOlder: () => void;
  /** Thread keys whose folded replies are open. */
  expandedIds?: string[];
  onToggleReplies?: (threadKey: string, expanded: boolean) => void;
  onOpen: (event: ActivityEvent) => void;
  onCompare?: (event: ActivityEvent) => void;
  onReply?: (threadKey: string) => void;
  onResolve?: (threadKey: string, next: boolean) => void;
  renderReplyComposer?: (threadKey: string) => React.ReactNode;
  /** True when filters are narrowing the feed; the empty state then offers Clear filters. */
  filtered?: boolean;
  onClearFilters?: () => void;
  /** Names the feed's day lists ("Activity · Today"). @default "Activity" */
  label?: string;
  /** Height of whatever is docked above the feed (the filter row), so day bands and conversation headers pin beneath it. @default 0 */
  stickyTop?: number;
  /** The page a conversation refers to, rendered by the host at 800px wide; the feed scales it into a 160×100 thumbnail with the comment's pin. Omit for no thumbnails. */
  renderThumbnail?: (event: ActivityEvent) => React.ReactNode;
}
export interface ActivityMetric {
  id: string;
  label: string;
  value: string | number;
  /** Makes the tile a toggle, e.g. a filter shortcut. */
  onClick?: () => void;
  pressed?: boolean;
}
export interface ActivityHeaderProps {
  /** @default "Activity" */
  title?: string;
  /** One line of facts under the title. */
  summary?: React.ReactNode;
  /** The page's primary action, at the heading's end. */
  action?: React.ReactNode;
  metrics?: ActivityMetric[];
}
export interface ActivityToolbarProps {
  segment: 'All' | 'Needs you' | 'With an agent';
  onSegment: (segment: string) => void;
  counts?: Record<string, number>;
  projects: Array<{ id: string; name: string }>;
  selectedProjects: string[];
  onProjects: (ids: string[]) => void;
  types: Array<'comments' | 'versions' | 'agents' | 'access'>;
  onTypes: (ids: string[]) => void;
  query: string;
  onQuery: (text: string) => void;
  /** Reports the docked row's height (including its padding) whenever it changes. */
  onHeight?: (height: number) => void;
}
export function createReviewUI(react: typeof React, controls: Record<string, React.ElementType>): {
  PagePicker: React.ComponentType<PagePickerProps>;
  ArtifactLinks: React.ComponentType<ArtifactLinksProps>;
  /** Requires `Disclosure` and `FileList` in `controls`. */
  FileGroups: React.ComponentType<FileGroupsProps>;
  /** Requires `SegmentedControl`, `Input`, `GroupBand` and `SurfaceState` in `controls`. */
  DesignGallery: React.ComponentType<DesignGalleryProps>;
  /** Requires `SectionHeading`, `AutoGrid` and `MetricCard` in `controls`. */
  ActivityHeader: React.ComponentType<ActivityHeaderProps>;
  /** Requires `Timeline`, `CommentThread`, `StatusPill`, `Button`, `SurfaceState`, `GroupBand`, `ScrollDock` and `AnnotationPin` in `controls`. */
  ActivityFeed: React.ComponentType<ActivityFeedProps>;
  /** Requires `SegmentedControl`, `Button`, `Menu`, `Input` and `ScrollDock` in `controls`. */
  ActivityToolbar: React.ComponentType<ActivityToolbarProps>;
};
