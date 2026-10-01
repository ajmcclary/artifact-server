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
  /** Line above the rows; `null` or `''` omits it. @default "Example URLs · browser-local prototype" */
  note?: string | null;
  /** One truncated line per URL (full address in its title and in the copy) with the copy control at the row's end, for a dense panel. @default false */
  compact?: boolean;
}
export interface ArtifactFile {
  /** Path within the version; each folder segment nests the row one level deeper in the tree. */
  name: string;
  /** Shown in the row's fixed right-aligned size column. */
  size?: string | number;
  /** `bi-*` glyph; defaults to one chosen by the file extension. */
  icon?: string;
  /** A trailing neutral pill such as "Default page"; "Selected" is ignored (the tree draws selection). */
  role?: string;
  /** Called when the row is chosen by click, Enter or Space. */
  onSelect?: () => void;
}
export interface FileGroupsProps {
  /** Every file in the version, in display order. Top-level files render before folders. */
  files: ArtifactFile[];
  /** Accessible name for the tree, e.g. "Files in version 7". */
  label: string;
  /** Path of the selected file; the folders holding it open automatically. */
  selected?: string;
}
export interface VersionMenuEntry {
  n: number;
  /** Date, or date and time, in the data face, e.g. "04/14/2026 10:00 AM". Searchable. */
  date: string;
  by: string;
  current?: boolean;
}
export interface VersionPageMenuProps {
  /** Visible trigger text, e.g. "v7 · index". */
  label: string;
  /** Spoken trigger name, e.g. "Version 7, the current version · Page index · Choose a version or page". */
  ariaLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every version, newest first. The newest `versionLimit` are listed, plus the shown one when older. */
  versions: VersionMenuEntry[];
  /** The version shown. */
  version: number;
  onSelectVersion: (n: number) => void;
  /** @default 4 */
  versionLimit?: number;
  /** Text of the link to every version, e.g. "All 7 versions". */
  allVersionsLabel?: string;
  onAllVersions?: () => void;
  pages: ArtifactPage[];
  /** Path of the page shown, or null on a gallery. */
  page: string | null;
  onSelectPage: (path: string) => void;
  /** Page search; shown from `searchFrom` pages. The host resets `limit` when it changes. */
  query?: string;
  onQueryChange?: (query: string) => void;
  /** @default 50 */
  limit?: number;
  onLoadMore?: () => void;
  /** @default 9 */
  searchFrom?: number;
  /** Host content after the lists, e.g. the notice that the linked source changed. */
  footer?: React.ReactNode;
  /** A viewport Modal instead of the anchored Popover. @default false */
  phone?: boolean;
  onAnnounce?: (message: string) => void;
}
export interface ArtifactBreadcrumbProps {
  /** The artifact name; always the page's h1. */
  name: string;
  /** Shows the name as the first crumb (serif, truncating first). Hidden but announced while the docked artifact list already names it. @default true */
  showName?: boolean;
  /** Width at which the name truncates. @default 260 */
  nameMaxWidth?: number;
  /** The crumbs after the name, e.g. the VersionMenu and PageMenu triggers, separated by chevrons. */
  crumbs?: React.ReactNode[];
  /** Accessible name of the nav. @default "Breadcrumb" */
  label?: string;
}
export interface VersionMenuProps {
  /** Visible crumb text, e.g. "v7". */
  label: string;
  /** Spoken crumb name, e.g. "Version 7, the current version · Choose a version". */
  ariaLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every version, newest first; the list scrolls. */
  versions: VersionMenuEntry[];
  /** The version shown; its row is checked and takes focus when the menu opens. */
  version: number;
  onSelectVersion: (n: number) => void;
  /** "Find a version": matches number, author or date. The host clears it when the menu closes. */
  query?: string;
  onQueryChange?: (query: string) => void;
  /** Adds the footer link to the Versions panel. */
  onOpenPanel?: () => void;
  /** @default "Open Versions Panel" */
  panelLabel?: string;
  /** Host content under the count, e.g. the notice that the linked source changed. */
  footer?: React.ReactNode;
  /** A viewport Modal instead of the anchored Popover. @default false */
  phone?: boolean;
  onAnnounce?: (message: string) => void;
}
export interface PageMenuProps {
  /** Visible crumb text: the page's path, or "Gallery". The crumb carries `aria-current="page"`. */
  label: string;
  /** Spoken crumb name, e.g. "Page index · Choose a page". */
  ariaLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The version's pages. The default page heads the list; the rest group under sticky folder or designer headers. */
  pages: ArtifactPage[];
  /** Path of the page shown, or null on a gallery. */
  page: string | null;
  onSelectPage: (path: string) => void;
  /** "Find a page": matches name, path or group. The host resets `limit` when it changes. */
  query?: string;
  onQueryChange?: (query: string) => void;
  /** @default 50 */
  limit?: number;
  onLoadMore?: () => void;
  /** The search shows from this many pages. @default 2 */
  searchFrom?: number;
  /** A viewport Modal instead of the anchored Popover. @default false */
  phone?: boolean;
  onAnnounce?: (message: string) => void;
  /** A version with a design gallery: a Gallery row pinned above the list, selected while `page` is null. */
  gallery?: {
    /** Secondary line, such as "9 previews". */
    description?: string;
    /** Return to the gallery. */
    onOpen: () => void;
  };
}
export interface VersionListEntry {
  n: number;
  by: string;
  /** Formatted date and time, in the data face. */
  when: string;
  current?: boolean;
}
export interface VersionListProps {
  /** Accessible name of the list region. @default "Versions" */
  label?: string;
  /** Versions to show, newest first. */
  versions: VersionListEntry[];
  /** The version shown; its row is selected. */
  shown: number;
  /** Preview a version: the row itself and its eye button. */
  onPreview: (n: number) => void;
  /** Items of a row's More menu, e.g. Make Current, Compare with v7, Action History. An empty list hides More. */
  menuItems: (version: VersionListEntry) => Array<{ label: string; icon?: string; disabled?: boolean; onClick: () => void }>;
  /** Older versions not yet shown; above 0 the list ends with Show older. @default 0 */
  remaining?: number;
  /** @default "Show {remaining} Older" */
  olderLabel?: string;
  onShowOlder?: () => void;
  /** Keep the row actions visible instead of on hover or focus. @default false */
  phone?: boolean;
}
export interface MentionPerson {
  name: string;
  /** Second column of the list, e.g. a role. */
  detail?: string;
  /** `bi-*` glyph for a non-person (an agent). */
  icon?: string;
}
export interface MentionComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Called with the trimmed draft by the send button or Cmd/Ctrl+Enter. */
  onSubmit: (value: string) => void;
  /** Accessible name of the field. */
  label: string;
  placeholder?: string;
  /** @default "Post comment" */
  submitLabel?: string;
  /** Who can be mentioned; matched on the start of any word of the name. */
  people?: MentionPerson[];
  /** The line above the box saying what is being written: a node, or `{ icon, text, cancel }` for the shared context line. */
  context?: React.ReactNode | { icon?: string; text: React.ReactNode; cancel?: { label: string; onClick: () => void } };
  /** Host controls before the @ button inside the box, e.g. Place on the artifact. */
  tools?: React.ReactNode;
  /** Escape with no mention list open, e.g. to cancel a reply. */
  onEscape?: () => void;
  /** @default 2 */
  rows?: number;
  /** The field grows to this many lines, then scrolls. @default 6 */
  maxRows?: number;
  autoFocus?: boolean;
  onAnnounce?: (message: string) => void;
}
export interface MentionTextProps {
  text: string;
  /** Names drawn as mentions when written as "@Name". */
  people?: MentionPerson[];
}
export type GalleryKind = 'prototype' | 'template' | 'component' | 'guideline' | 'documentation' | 'artboard'
  | 'document' | 'spreadsheet' | 'presentation';
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
export interface LibraryItem {
  /** Identity for keys, focus, `onOpen` and `hrefFor`; combine artifact and path because paths repeat. */
  id?: string;
  /** Exact published path of the original HTML document. */
  path: string;
  kind: GalleryKind;
  title: string;
  description?: string;
  /** Declared preview viewport, shown in the placeholder's size chip and the list's size column. */
  viewport: { width: number; height: number };
  /** Same-origin, exact-version image URL supplied by the host; null draws the kind's placeholder. */
  thumbnailUrl?: string | null;
  /** Project name; grouping by project uses it, and tiles name it otherwise. */
  project: string;
  /** Gallery (preview index) title; tiles name it while grouped by project. */
  gallery: string;
  /** Epoch ms of the first version that listed the page. */
  createdAt: number;
  /** Epoch ms of the later of the last version that changed the page and its newest comment. */
  activityAt: number;
}
export type LibraryGrouping = 'date' | 'project' | 'type' | 'none';
export type LibrarySort = 'name' | 'created' | 'activity';
export interface DesignLibraryProps {
  title?: string;
  description?: string;
  items: LibraryItem[];
  /** The clock date buckets read from. @default Date.now() */
  now?: number;
  /** Host content under the heading, such as the unreadable-gallery Alert. */
  notice?: React.ReactNode;
  query: string;
  onQueryChange: (query: string) => void;
  /** Kinds shown; empty shows every kind. */
  types?: GalleryKind[];
  onTypesChange: (types: GalleryKind[]) => void;
  /** @default "date" */
  groupBy?: LibraryGrouping;
  onGroupByChange: (groupBy: LibraryGrouping) => void;
  /** Group by date reads creation when this is `created`, otherwise last activity. @default "activity" */
  sortBy?: LibrarySort;
  /** Defaults to `asc` for name and `desc` for dates. */
  sortDir?: 'asc' | 'desc';
  /** Choosing a sort passes its default direction. */
  onSortChange: (sortBy: LibrarySort, sortDir: 'asc' | 'desc') => void;
  view?: 'grid' | 'list';
  onViewChange: (view: 'grid' | 'list') => void;
  /** Keys of collapsed groups (`date:…`, `project:…`, `kind:…`). */
  collapsed?: string[];
  onCollapsedChange: (collapsed: string[]) => void;
  /** Shows the toolbar's icon-only Refresh. */
  onRefresh?: () => void;
  /** When the library was read, for Refresh's tooltip. */
  refreshedAt?: string;
  onOpen: (id: string) => void;
  hrefFor?: (id: string) => string;
  focusPath?: string | null;
  scrollTop?: number;
  onScroll?: (scrollTop: number) => void;
  onAnnounce?: (message: string) => void;
  phone?: boolean;
}
export interface GalleryPlaceholderProps {
  kind: GalleryKind;
  /** Viewport label for the size chip, such as "1440 × 900". */
  size?: string;
  /** Drops the size chip, for list thumbnails. */
  compact?: boolean;
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
/** One actor's consecutive version or access events within the burst window (`groupBursts`). */
export interface ActivityBurst {
  id: string;
  kind: 'burst';
  type: 'version' | 'access';
  actor: string;
  verb: string;
  items: ActivityEvent[];
  /** Projects the items touch, each with its version (or change) count. */
  projects: Array<{ id: string; name: string; count: number }>;
  /** Versions published (summing merged spans), or changes made. */
  count: number;
  /** Newest item's time. */
  at: number;
  /** Oldest item's time. */
  firstAt: number;
  archived: boolean; needsYou: boolean; withAgent: boolean; adminOnly: boolean;
}
/** One day's conversations on one artifact, with its agent hand-off (`groupByArtifact`). */
export interface ActivityArtifactGroup {
  id: string;
  kind: 'artifact';
  type: 'comment';
  artifactId: string; artifactName: string; projectId: string; projectName: string; archived: boolean;
  /** Everyone with an event in the group, newest first. */
  actors: string[];
  /** One comment or resolution event per conversation, newest first. */
  threads: ActivityEvent[];
  /** The agent hand-off on this artifact that day, shown as the card's footer. */
  agent: ActivityEvent | null;
  /** Every event the group holds. */
  events: ActivityEvent[];
  at: number;
  needsYou: boolean; withAgent: boolean; adminOnly: boolean;
}
/** A feed entry: a plain event, a burst or an artifact's conversations (`groupEntries`). */
export type ActivityEntry = ActivityEvent | ActivityBurst | ActivityArtifactGroup;
export interface ActivityFeedProps {
  /** One page of newest-first entries. Plain comment or resolution events are shown as one-thread cards. */
  events: ActivityEntry[];
  /** Reference time for the Today / Yesterday day labels. */
  now: number;
  hasMore: boolean;
  /** Entries not yet shown. `0` means "unknown": a cursor-paged host prints plain "Show older". */
  remaining: number;
  onShowOlder: () => void;
  /** Thread keys whose folded replies are open. */
  expandedIds?: string[];
  onToggleReplies?: (threadKey: string, expanded: boolean) => void;
  /** Ids of bursts whose item lists are open. */
  openGroups?: string[];
  onToggleGroup?: (id: string, open: boolean) => void;
  /** Called with the entry (or a burst's item) whose artifact should open in review. */
  onOpen: (event: ActivityEntry) => void;
  onCompare?: (event: ActivityEvent) => void;
  onReply?: (threadKey: string) => void;
  onResolve?: (threadKey: string, next: boolean) => void;
  renderReplyComposer?: (threadKey: string) => React.ReactNode;
  /** True when filters are narrowing the feed; the empty state then offers Clear filters. */
  filtered?: boolean;
  onClearFilters?: () => void;
  /** Names the feed's day lists ("Activity · Today"). @default "Activity" */
  label?: string;
  /** Height of whatever is docked above the feed (the filter row), so day caps and conversation heads pin beneath it. @default 0 */
  stickyTop?: number;
  /** The page a conversation refers to, rendered by the host at 800px wide; the feed scales it into a 168×104 thumbnail with the comment's pin. Omit for no thumbnails. */
  renderThumbnail?: (entry: ActivityArtifactGroup) => React.ReactNode;
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
  /** The page's primary action, at the heading's end. */
  action?: React.ReactNode;
  metrics?: ActivityMetric[];
}
export interface ActivityToolbarProps {
  segment: 'All' | 'Needs you' | 'With an agent';
  onSegment: (segment: string) => void;
  counts?: Record<string, number>;
  /** The People menu's rows (`peopleOf`). Omit `onPeople` for no People menu. */
  people?: Array<{ id: string; name: string; agent: boolean; count: number; self?: boolean }>;
  selectedPeople?: string[];
  onPeople?: (ids: string[]) => void;
  projects: Array<{ id: string; name: string; count?: number; archived?: boolean }>;
  selectedProjects: string[];
  onProjects: (ids: string[]) => void;
  types: Array<'comments' | 'versions' | 'agents' | 'access'>;
  onTypes: (ids: string[]) => void;
  /** Entries per type filter, shown in the Types menu. */
  typeCounts?: Partial<Record<'comments' | 'versions' | 'agents' | 'access', number>>;
  query: string;
  onQuery: (text: string) => void;
  /** Reports the docked row's height (including its padding) whenever it changes. */
  onHeight?: (height: number) => void;
  /** Entries after filtering and in all. Given both, the toolbar keeps a live "Showing N of M entries" region and, while filtered, a row of removable filter chips. */
  shown?: number;
  total?: number;
  /** Clears every filter, people included. */
  onClearFilters?: () => void;
}
export function createReviewUI(react: typeof React, controls: Record<string, React.ElementType>): {
  PagePicker: React.ComponentType<PagePickerProps>;
  ArtifactLinks: React.ComponentType<ArtifactLinksProps>;
  /** Requires `TreeView` in `controls`. */
  FileGroups: React.ComponentType<FileGroupsProps>;
  /** The earlier combined version · page control, kept for existing hosts; the Review toolbar now uses `ArtifactBreadcrumb` with `VersionMenu` and `PageMenu`. Requires `CrumbMenu`, `SearchableList`, `Button`, `LinkRow` and `Eyebrow` in `controls`. */
  VersionPageMenu: React.ComponentType<VersionPageMenuProps>;
  /** The Review toolbar's breadcrumb: the artifact name, then the crumbs it is given. Requires `Breadcrumb` and `visuallyHiddenStyle` in `controls`. */
  ArtifactBreadcrumb: React.ComponentType<ArtifactBreadcrumbProps>;
  /** Requires `CrumbMenu`, `SearchableList`, `Button` and `StatusPill` in `controls`. */
  VersionMenu: React.ComponentType<VersionMenuProps>;
  /** Requires `CrumbMenu` and `SearchableList` in `controls`. */
  PageMenu: React.ComponentType<PageMenuProps>;
  /** Requires `RowActions`, `LoadMore`, `LinkRow`, `IconButton` and `StatusPill` in `controls`. */
  VersionList: React.ComponentType<VersionListProps>;
  /** The design system's `MentionComposer`, re-exported for existing hosts. Requires `MentionComposer` in `controls`. */
  MentionComposer: React.ComponentType<MentionComposerProps>;
  /** The design system's `MentionText`, re-exported for existing hosts. Requires `MentionText` in `controls`. */
  MentionText: React.ComponentType<MentionTextProps>;
  /** Requires `SegmentedControl`, `Input`, `GroupBand` and `SurfaceState` in `controls`. */
  DesignGallery: React.ComponentType<DesignGalleryProps>;
  /** Requires `Button`, `IconButton`, `Menu`, `Input`, `SegmentedControl`, `GroupBand`, `SurfaceState`, `SectionHeading` and `ScrollDock` in `controls`. */
  DesignLibrary: React.ComponentType<DesignLibraryProps>;
  /** A full-bleed sketch of one kind; fills its positioned container. */
  GalleryPlaceholder: React.ComponentType<GalleryPlaceholderProps>;
  /** Requires `AutoGrid` and `MetricCard` in `controls`. */
  ActivityHeader: React.ComponentType<ActivityHeaderProps>;
  /** Requires `CommentThread`, `StatusPill`, `Button`, `SurfaceState`, `ScrollDock`, `AnnotationPin` and `LoadMore` in `controls`. */
  ActivityFeed: React.ComponentType<ActivityFeedProps>;
  /** Requires `SegmentedControl`, `Button`, `Menu`, `Input`, `Avatar` and `ScrollDock` in `controls`. */
  ActivityToolbar: React.ComponentType<ActivityToolbarProps>;
};
