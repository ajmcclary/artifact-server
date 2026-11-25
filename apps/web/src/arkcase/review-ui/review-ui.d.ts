import React from 'react';
import type { MentionComposerPerson, MentionComposerProps as SharedMentionComposerProps } from '../components/forms/MentionComposer';
import type { MentionTextProps as SharedMentionTextProps } from '../components/data-display/MentionText';

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
  /** A candidate's state; its row shows `stateLabel` (or the state) where the current row shows Current. */
  state?: 'candidate' | 'promoted' | 'rejected' | 'superseded';
  stateLabel?: string;
}
export interface VersionListProps {
  /** Accessible name of the list region. @default "Versions" */
  label?: string;
  /** A visible heading above the rows, for a second list such as the candidates under the accepted history. */
  heading?: string;
  /** Versions to show, newest first. */
  versions: VersionListEntry[];
  /** The version shown; its row is selected. */
  shown: number;
  /** Preview a version: the row itself and its eye button. */
  onPreview: (n: number) => void;
  /** Items of a row's More menu, e.g. Make Current, Compare with v7, Action History. An empty list hides More. */
  menuItems: (version: VersionListEntry) => Array<{ label: string; icon?: string; disabled?: boolean; onClick: () => void }>;
  /** Older versions not yet shown; above 0 the list ends with an older-versions row (a chevron, "Show N older versions" and the range it reveals). @default 0 */
  remaining?: number;
  /** How many versions the next press reveals; sets N and the range. @default remaining */
  olderStep?: number;
  /** Overrides the row's title. @default "Show {N} older versions" */
  olderLabel?: string;
  onShowOlder?: () => void;
  /** Keep the row actions visible instead of on hover or focus. @default false */
  phone?: boolean;
}
/* The composer and posted-text contracts are the design system's own; `createReviewUI`
   re-exports those components, so the types are re-exported rather than copied. */
export type MentionPerson = MentionComposerPerson;
export type MentionComposerProps = SharedMentionComposerProps;
export type MentionTextProps = SharedMentionTextProps;
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
/**
 * One artifact's gallery in the Library's design (`DesignLibrary` with `scope="artifact"`): the
 * same toolbar, bands, tiles and list rows, over that version's preview index. Grouping offers
 * Section in place of Project and there is no Projects menu. The review toolbar names the
 * artifact, so no heading or description shows and the docked bar carries no title; `title`
 * names the region ("{title} gallery") and group bands are level-2 headings.
 * Each view choice is host-owned when its value is passed and kept internally otherwise
 * (defaults: Artifact type, Name A–Z, grid).
 */
export interface DesignGalleryProps {
  /** Names the gallery region; not shown. */
  title: string;
  /** Not shown; kept for existing hosts. */
  description?: string;
  /** Not shown; kept for existing hosts. */
  coverUrl?: string | null;
  /** Preview-index items; `createdAt` / `activityAt` (epoch ms) add the date line, date grouping and date sorts. */
  items: Array<GalleryItem & { createdAt?: number; activityAt?: number }>;
  /** The clock date buckets read from. @default Date.now() */
  now?: number;
  query: string;
  onQueryChange: (query: string) => void;
  /** Kinds shown; empty shows every kind. */
  types?: GalleryKind[];
  onTypesChange?: (types: GalleryKind[]) => void;
  /** Earlier single-kind filter: seeds `types` when they are not passed, and hears the single kind chosen (or `'all'`). */
  kind?: 'all' | GalleryKind;
  onKindChange?: (kind: 'all' | GalleryKind) => void;
  /** @default "type" */
  groupBy?: Exclude<LibraryGrouping, 'project'>;
  onGroupByChange?: (groupBy: Exclude<LibraryGrouping, 'project'>) => void;
  /** @default "name" */
  sortBy?: LibrarySort;
  sortDir?: 'asc' | 'desc';
  onSortChange?: (sortBy: LibrarySort, sortDir: 'asc' | 'desc') => void;
  view?: 'grid' | 'list';
  onViewChange: (view: 'grid' | 'list') => void;
  /** Keys of collapsed groups (`date:…`, `section:…`, `kind:…`). */
  collapsed?: string[];
  onCollapsedChange?: (collapsed: string[]) => void;
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
  /** Host content under the heading, such as a compatibility notice. */
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
  /** Section heading from the preview index; artifact scope groups by it and tiles name it. */
  section?: string;
  /** Related guides: grid tiles show their count, list rows link each one beneath. */
  related?: GalleryLink[];
  /** Gallery (preview index) title; tiles name it while grouped by project. */
  gallery: string;
  /** Epoch ms of the first version that listed the page. */
  createdAt: number;
  /** Epoch ms of the later of the last version that changed the page and its newest comment. */
  activityAt: number;
}
/** `section` is offered in artifact scope, in place of `project`. */
export type LibraryGrouping = 'date' | 'project' | 'section' | 'type' | 'none';
export type LibrarySort = 'name' | 'created' | 'activity';
export interface DesignLibraryProps {
  /** @default "Library" */
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
  /** Project names shown (matched against `LibraryItem.project`); empty shows every project. */
  projects?: string[];
  /** Shows the toolbar's Projects menu, listing each project the items name with its count. */
  onProjectsChange?: (projects: string[]) => void;
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
  /** `artifact` is one artifact's gallery: Section replaces Project in grouping and tile context, the toolbar is named "Gallery view", and no heading, description or docked title shows (the host toolbar names the artifact). @default "library" */
  scope?: 'library' | 'artifact';
  /** Level of the page heading; group bands sit one below (in artifact scope, which has no heading, the bands take this level). @default 1 */
  headingLevel?: 1 | 2 | 3 | 4 | 5;
  /** Decorative cover beside the heading, hidden on phone widths. */
  coverUrl?: string | null;
  /** The window scrolls the page (a phone's document scroll) instead of the library's own pane: `scrollTop` restores and `onScroll` reports the window's offset. @default false */
  documentScroll?: boolean;
  /** Height of fixed chrome over a document-scrolled page (the phone's app bar), in px; the toolbar and group bands dock beneath it. @default 0 */
  dockTop?: number;
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
  /** `candidate`: a version staged for review, then promoted or closed (`verb` `staged`, `promoted` or `closed`). */
  type: 'comment' | 'version' | 'candidate' | 'resolution' | 'agent' | 'access' | 'admin';
  /** Epoch milliseconds; NaN when the record carries no readable time. */
  at: number;
  actor: string;
  verb: string;
  artifactId?: string; artifactName?: string; projectId?: string; projectName?: string; archived?: boolean;
  version?: number; fromVersion?: number | null; firstVersion?: number; count?: number;
  thread?: { key: string; author: string; when?: string; at?: string; body: string; isResolved: boolean; replies: Array<{ id?: string; author: string; when?: string; at?: string; body: string }> };
  excerpt?: string; from?: string; to?: string; agent?: string; state?: string; detail?: string; icon?: string;
  /** A candidate's base version, and whether current has moved past it while it is still open. */
  baseVersion?: number; stale?: boolean;
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
  /** Compact rows and flat day dividers for a panel; comfortable day cards for a page. @default "comfortable" */
  density?: 'comfortable' | 'compact';
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
  /** Why an artifact's conversations are read-only for the viewer, or null when they can write; a reason hides Reply, Resolve and the composer on that card and is shown in their place. */
  readOnlyReason?: (entry: ActivityEntry) => string | null;
  /** Opens one conversation at its own version and page. A card whose conversations span pages or versions shows each one's location as this link. */
  onOpenThread?: (entry: ActivityEntry, thread: NonNullable<ActivityEvent['thread']> & { version?: number; path?: string | null; kind?: string }) => void;
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
  /** The level-1 title, set as the Library's `SectionHeading` page title. @default "Activity" */
  title?: string;
  /** Optional one-sentence line under the title; Activity passes none. */
  description?: string;
  /** The page's primary action, at the heading's end. */
  action?: React.ReactNode;
  metrics?: ActivityMetric[];
  /** Phone layout: the metric tiles form a compact two-by-two grid. @default false */
  compact?: boolean;
}
export interface ActivityToolbarProps {
  /** The page title the toolbar leads with once docked, as the Library's does. @default "Activity" */
  title?: string;
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
  /** Reports the docked bar's height (its hairline included) whenever it changes. */
  onHeight?: (height: number) => void;
  /** Phone layout: no docked title and no separator after the segments, so the wrapped bar stays short; the filter menus form one sideways-scrolling row and open as bottom sheets. @default false */
  phone?: boolean;
  /** Height of fixed chrome over a document-scrolled page (the phone's app bar), in px; the toolbar docks beneath it. @default 0 */
  top?: number;
  /** Entries after filtering and in all. Given both, the toolbar keeps a live "Showing N of M entries" region and, while filtered, a row of removable filter chips and Clear filters. */
  shown?: number;
  total?: number;
  /** Clears every filter, people included. */
  onClearFilters?: () => void;
}
/** One Office page, drawn by its family's viewer inside Review's preview frame. */
export interface OfficeViewerProps {
  /** The gallery kind; any other kind renders nothing. */
  kind: 'document' | 'spreadsheet' | 'presentation';
  /** The document's own title: the Word heading, the worksheet's title cell, the title slide. */
  title: string;
  /** The template's catalog name; a workbook names its first sheet with it. @default title */
  name?: string;
  /** The catalog category, shown as the document's and the title slide's kicker. */
  category?: string;
  /** A slide layout (`SlideWireframe`) the deck's second slide takes, e.g. "agenda". */
  layout?: string;
  /** The native format the page was published beside, e.g. "DOCX". @default "DOCX" */
  format?: string;
  /** The host's pins and pick layer, laid over the paper, sheet or slide itself so they stay on the document at any zoom or scroll. */
  overlay?: React.ReactNode;
  /** The shown part, owned by the host: a page or slide index, or a sheet id (`main`, `inputs`, `readme`). Omit it and the viewer keeps its own. */
  part?: OfficePartValue | null;
  /** Called when the reader turns to another page, sheet or slide, so the host can show only that part's pins. */
  onPartChange?: (part: OfficePartValue) => void;
}
export type OfficePartValue = number | string;
interface OfficePartProps { overlay?: React.ReactNode; part?: OfficePartValue | null; onPartChange?: (part: OfficePartValue) => void; }
export interface DocumentViewerProps extends OfficePartProps { title: string; category?: string; format?: string; }
export interface SpreadsheetViewerProps extends OfficePartProps { title: string; name: string; }
export interface PresentationViewerProps extends OfficePartProps { title: string; category?: string; layout?: string; }
/* ---- Review workspace renderings (review-pane-ui.jsx). The host owns every value and callback. ---- */
/** An artifact fixture as the placeholder page draws it. */
export interface SketchArtifact { name?: string; eyebrow: React.ReactNode; title: React.ReactNode; lead: React.ReactNode; panel: React.ReactNode; }
export interface PageSketchProps { artifact: SketchArtifact; big?: boolean; heading?: React.ElementType; close?: React.ReactNode; }
export interface PreviewManifestFile { path: string; mediaType: string; size: number; }
export interface PreviewSnapshot { version: { id: string }; manifest: { entryPath: string; entries: PreviewManifestFile[]; routingMode?: string }; links: { version: string }; }
export interface PreviewPageProps {
  /** The raw view's sheet: the default page's sketch without padding, an Office page at least 640px tall. */
  big?: boolean;
  /** Pins and the pick layer, laid over an Office page's paper. */
  overlay?: React.ReactNode[];
  path: string;
  page?: ArtifactPage;
  file?: PreviewManifestFile;
  /** A route error replaces the page with Page unavailable. */
  error?: string | null;
  snapshot: PreviewSnapshot;
  pages: ArtifactPage[];
  /** The gallery item when the page is a `document`, `spreadsheet` or `presentation`. */
  officeItem?: GalleryItem | null;
  artifact: SketchArtifact & { name: string };
  /** The default page sketch's closing sentence. */
  closeLine?: React.ReactNode;
  onSelectPage: (path: string) => void;
  /** An Office page's shown part, owned by the host (`OfficeViewerProps.part`). */
  officePart?: OfficePartValue | null;
  onOfficePartChange?: (part: OfficePartValue) => void;
}
export interface FocusTitleProps { title: React.ReactNode; version: number; }
export interface FocusControlsProps {
  /** Folded to the one restore button. */
  hidden?: boolean;
  /** Shows Back to gallery (a page opened from a gallery). */
  returnable?: boolean;
  /** Open threads on the Comments button; null hides Comments (without `comment.read`). */
  unresolvedCount: number | null;
  commentsOpen?: boolean;
  /** The Annotate switch: `canComment` picks its read-only form ("Show comments on the page"). */
  annotate?: { active: boolean; canComment: boolean; onToggle: () => void } | null;
  /** The host's Share popover, with its navy trigger. */
  share?: React.ReactNode;
  onShowControls: () => void;
  onBackToGallery: () => void;
  onToggleComments: () => void;
  onOpenRaw: () => void;
  onExit: () => void;
  onHideControls: () => void;
}
export interface ReviewAgent { name: string; initials: string; state: 'Replying' | 'Idle' | 'Disconnected' | string; }
export interface AgentControlsProps { open: boolean; agents: ReviewAgent[]; archived?: boolean; unresolvedCount: number; onSendAll: () => void; }
export interface DetailsPanelProps {
  artifact: { id: string; versions: number; mirrored?: boolean };
  snapshot: PreviewSnapshot;
  viewVersion: number;
  current: number;
  historical: boolean;
  published: { by: string; when: string };
  archived?: boolean;
  galleryItem?: GalleryItem | null;
  access: string;
  accessOptions: string[];
  onAccessChange: (event: unknown) => void;
  onChangeDefault: () => void;
  onSelectPage: (path: string) => void;
  /** Returns the shared CopyButton for one link. */
  onCopyLink: (text: string, label: string) => React.ReactNode;
  reviewUrl: string;
  latestUrl: string;
  onDelete: () => void;
  /** The editable name: renders the first section, Artifact, with `NameEditor`. Omit to keep the earlier layout. */
  name?: Omit<NameEditorProps, 'disabled'>;
  /** Which controls effective access allows; a `false` hides or disables that control (rename, the Access select, Change default page, Delete Artifact). Omitted keys are allowed. */
  can?: { rename?: boolean; share?: boolean; publish?: boolean; remove?: boolean };
  /** The version's source record for the Source section; null reads "Source not recorded". */
  provenance?: SourceRecordValue | null;
}
/** The name editor in Details: typing starts an edit; Save name (or Enter) and Cancel appear while the draft differs. */
export interface NameEditorProps {
  /** The current name. */
  value: string;
  /** The host-owned draft. */
  draft: string;
  onDraft: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
  /** The refusal to show, e.g. the name rule; with it, Reload current details calls `onReload` and keeps the draft. */
  error?: string;
  onReload: () => void;
  /** Without `artifact.edit`, or in an archived project. */
  disabled?: boolean;
}
/** A producer's source record, checked against the version's manifest. */
export type SourceRecordValue =
  | { status: 'verified' | 'mismatch'; repository: string; commit: string; dirty?: boolean; digest: string; declared: number; files: number; edges: 'complete' | 'partial' | 'none'; mismatches?: string[] }
  | { status: 'not-recorded' }
  | { status: 'invalid'; diagnostic: string }
  | { status: 'unsupported-version'; version: number };
export interface SourceRecordProps { record: SourceRecordValue | null; }
export interface FilesPanelProps {
  view: 'Files' | 'Page URLs' | string;
  onViewChange: (view: string) => void;
  files: PreviewManifestFile[];
  pages: ArtifactPage[];
  snapshot: PreviewSnapshot;
  viewVersion: number;
  selectedPath: string;
  onSelectPage: (path: string) => void;
  onCopy: (text: string, label: string) => React.ReactNode;
}
export interface FilesFooterProps { path: string; file?: PreviewManifestFile; }
export interface ShareHeaderProps { title: React.ReactNode; subtitle: React.ReactNode; onBack: () => void; onClose: () => void; }
export interface ShareOverviewProps {
  target: 'version' | 'latest';
  onTargetChange: (id: string | null) => void;
  viewVersion: number;
  url: string;
  /** The host's Copy Link button. */
  copyLink: React.ReactNode;
  access: string;
  onManageAccess: () => void;
  /** Active members for the Invite band, shown to administrators only; null hides the band. */
  members: number | null;
  onInvite: () => void;
  /** Opens "Why can they?"; omit for someone without `project.manage`. */
  onWhy?: () => void;
  /** The People and Share links bands (`ShareAccessBands`), after the link section. */
  accessBands?: React.ReactNode;
  /** A neutral note above the link section, e.g. that an archived project allows only narrowing. */
  notice?: React.ReactNode;
  /** The host's Copy Review Prompt button. */
  copyPrompt: React.ReactNode;
  onConnect: () => void;
}
export interface ShareConnectProps { localWell: React.ReactNode; remoteWell: React.ReactNode; }

/* ---- Administration (admin-ui.jsx) ---- */
export interface AdminListPanelProps { label: string; subtitle: React.ReactNode; add?: { label: string; onClick: () => void } | null; children?: React.ReactNode; }
export interface AdminMember { name: string; email: string; role: string; status?: string; admitted?: string; admittedBy?: string; lastActive?: string | null; }
export interface MembersGridProps { members: AdminMember[]; statusOf: (member: AdminMember) => string; onSelect: (email: string) => void; onDeactivate: (member: AdminMember) => void;
  /** Adds the Projects column, e.g. "All · administrator" or "3 of 5". */
  projectsOf?: (member: AdminMember) => string; }
export interface MemberInspectorProps { member: AdminMember; status: string; onClose: () => void; onDeactivate: () => void;
  /** The member's grants (`MemberGrants`), under Project access. */
  grants?: React.ReactNode;
  /** "Why can they?" for this member. */
  explainer?: React.ReactNode; }
export interface AdminInvite { id: string; email: string | null; role: string; createdBy: string; useCount: number; maxUses: number; expires: string; }
export interface InvitesGridProps { invites: AdminInvite[]; statusOf: (invite: AdminInvite) => 'Active' | 'Used' | 'Expired' | 'Revoked' | string; onRevoke: (invite: AdminInvite) => void; }
export interface AdminKey { id: string; name: string; owner: string; capabilities: string[]; created?: string | null; lastUsed?: string | null; expires: string; }
export interface KeysGridProps { keys: AdminKey[]; statusOf: (key: AdminKey) => string; onSelect: (id: string) => void; onRevoke: (key: AdminKey) => void; }
export interface KeyInspectorProps { apiKey: AdminKey; status: string; capabilityLabels: Record<string, string>; onClose: () => void; onRevoke: () => void; }
export interface PublicLinkArtifact { id: string; name: string; projectName: string; }
export interface PublicLinksGridProps {
  artifacts: PublicLinkArtifact[];
  versionOf: (artifact: PublicLinkArtifact) => number;
  urlOf: (artifact: PublicLinkArtifact) => string;
  renderCopy: (url: string, row: { id: string; name: string }) => React.ReactNode;
  onOpen: (row: { id: string; name: string }) => void;
  onMakePrivate: (artifact: PublicLinkArtifact) => void;
}
/* ---- Access (access-ui.jsx): Artifact Server's permissions model ---- */
export type Permission = 'artifact.view' | 'artifact.history' | 'comment.read' | 'comment.write' | 'comment.moderate'
  | 'artifact.publish' | 'artifact.edit' | 'artifact.delete' | 'artifact.share' | 'agent.dispatch' | 'project.manage';
export type ProjectRole = 'none' | 'viewer' | 'commenter' | 'editor' | 'manager';
export interface AccessPolicy {
  shareLinks: { enabled: boolean; guestPermissionsMax: Permission[]; maxExpiryDays: number | null; linkCreators: 'sharers' | 'administrators' };
  projects: { defaultMode: 'open' | 'restricted' };
  members: { memberCeiling: Permission[] | null };
}
/** "Guest" beside a guest author, with the link label; `ended` adds "(link ended)". */
export interface GuestBadgeProps { linkLabel?: string | null; ended?: boolean; }
/** The guest shell's banner; `controls` are the host's Annotate switch and Platform and Appearance controls. */
export interface GuestHeaderProps { creator: string; expires?: string | null; artifactName: string; version: number; controls?: React.ReactNode; }
export interface GuestNameFormProps { name: string; email: string; onName: (name: string) => void; onEmail: (email: string) => void; error?: string; }
export interface AccessChainEntry { layer: string; text: string; }
export interface WhyCanTheyProps {
  /** People to ask about; omit when the subject is fixed (a member's drawer). */
  people?: Array<{ value: string; label: string }>;
  person?: string;
  onPerson?: (id: string) => void;
  permission: Permission;
  onPermission: (permission: Permission) => void;
  /** The deciding layer as one sentence, e.g. "Dana can write comments: Commenter on Design." */
  sentence: string;
  /** Every layer that applied, in resolution order. */
  chain?: AccessChainEntry[];
  /** The region's name. @default "Why can they?" */
  label?: string;
}
export interface OverrideRow { permission: Permission; label: string; state: 'from_role' | 'added' | 'removed' | 'blocked_by_policy' | 'off'; disabledReason: string | null; }
export interface PermissionChecklistProps {
  name: string; role: ProjectRole; rows: OverrideRow[];
  onToggle: (permission: Permission, on: boolean) => void; onSave: () => void; onCancel: () => void; dirty?: boolean;
}
export interface ProjectAccessRow { id: string; name: string; email: string; role: ProjectRole; locked?: boolean; hasGrant?: boolean; overrides?: string; }
export interface ProjectAccessPanelProps {
  mode: 'open' | 'restricted'; defaultRole: ProjectRole; savedMode: 'open' | 'restricted';
  onMode: (mode: string) => void; onDefaultRole: (role: string) => void; dirty: boolean; onSave: () => void;
  /** Administrators (locked "Manager (administrator)") and the people listed with a role. */
  rows: ProjectAccessRow[];
  onRole: (row: ProjectAccessRow, role: ProjectRole) => void;
  /** The host's override Popover (trigger and `PermissionChecklist`) for one row. */
  renderCustomize: (row: ProjectAccessRow) => React.ReactNode;
  /** "Use default" on an open project, "Remove" on a restricted one. */
  onRemove: (row: ProjectAccessRow) => void;
  candidates: Array<{ value: string; label: string }>;
  addMember: string; addRole: ProjectRole; onAddMember: (id: string) => void; onAddRole: (role: string) => void; onAdd: () => void;
  /** Without `project.manage`, every control is read-only. */
  canManage: boolean;
  /** Shows the add-person row; false on an archived project, where only narrowing is allowed. @default canManage */
  canAdd?: boolean;
  /** A neutral note above the panels, e.g. what an archived project still allows. */
  notice?: React.ReactNode;
  /** On an archived project, the saved access: opening a restricted project and roles above the saved ones are listed but disabled, with the reason as helper text. */
  narrowFrom?: { mode: 'open' | 'restricted'; defaultRole: ProjectRole } | null;
  explainer?: React.ReactNode;
}
export interface AccessPolicyScreenProps {
  draft: AccessPolicy; saved: AccessPolicy; onChange: (next: AccessPolicy) => void; onSave: () => void; onDiscard: () => void;
  /** How many grants and active share links saving the draft narrows; stated before saving. */
  narrowing: { grants: number; shareLinks: number } | null;
  /** The saved result, e.g. "Saved. This narrows 1 grant and 2 share links." */
  notice?: string;
}
export interface SharePeopleProps {
  projectName: string; projectSummary: React.ReactNode;
  grants: Array<{ id: string; name: string; role: ProjectRole }>;
  candidates: Array<{ value: string; label: string }>;
  addMember: string; addRole: ProjectRole; onAddMember: (id: string) => void; onAddRole: (role: string) => void; onAdd: () => void;
  onRemove: (grant: { id: string; name: string }) => void;
  /** With `artifact.share`: remove (and add) grants. */
  canEdit: boolean;
  /** Shows the add-person row; false on an archived project, where grants can only be removed. @default canEdit */
  canAdd?: boolean;
  /** What Add would change, stated before it is pressed, e.g. "Rosa Santoro will stay Manager through …". */
  addPreview?: React.ReactNode;
  /** Opens the project's Access tab, for a project manager. */
  onOpenProject?: (() => void) | null;
}
export interface ShareLinkRecord {
  id: string; artifactId: string; projectId: string; label: string; permissions: Permission[];
  target: { kind: 'latest' } | { kind: 'pinned'; versionId: string; version?: number };
  /** ISO date, or null for no expiry. */
  expires: string | null; revokedAt: string | null; guestCount: number; createdAt: string; createdBy: string; url: string;
}
export interface ShareLinksListProps {
  /** Active links with their "{Preset} · {Target} · {Expiry} · {Guests}" summary. */
  links: Array<ShareLinkRecord & { summary: string }>;
  /** The result of the last action; may carry a control, e.g. Copy new link after a rotation. */
  ended?: string | null; notice?: React.ReactNode;
  renderCopy: (link: ShareLinkRecord) => React.ReactNode;
  onEdit: (link: ShareLinkRecord) => void; onRotate: (link: ShareLinkRecord) => void;
  /** The link whose Revoke is being confirmed in place. */
  revoking: string | null;
  onRevoke: (link: ShareLinkRecord) => void; onConfirmRevoke: (link: ShareLinkRecord) => void; onCancelRevoke: () => void;
  onNew: () => void; canCreate: boolean;
  /** The link whose Rotate is being confirmed in place; `onRotate` asks, `onConfirmRotate` rotates. Without `onConfirmRotate`, `onRotate` rotates at once. */
  rotating?: string | null;
  onConfirmRotate?: (link: ShareLinkRecord) => void; onCancelRotate?: () => void;
  /** Why New Link is missing when `canCreate` is false. @default "Only administrators can create share links on this installation." */
  createNote?: string;
}
export interface ShareLinkFormValue { label: string; preset: 'view' | 'comment' | 'custom'; custom: Permission[]; target: 'version' | 'latest'; expires: string; keepLabel?: string; }
export interface ShareLinkFormProps {
  form: ShareLinkFormValue; onChange: (next: ShareLinkFormValue) => void; version: number;
  /** The policy's longest expiry in days; null offers Never. */
  maxDays: number | null; guestMax: Permission[]; error?: string; editing?: boolean; onCancel: () => void; onSubmit: () => void;
  /** On an archived project, the saved link: choices that would reach further (a permission it lacks, the other target, a later or no expiry) are disabled or left out. `daysLeft` is null when it never expires. */
  narrowFrom?: { permissions: Permission[]; target: 'version' | 'latest'; daysLeft: number | null } | null;
  /** The note above the form while `narrowFrom` applies. */
  narrowNote?: React.ReactNode;
}
export interface ShareAccessBandsProps { peopleLine: React.ReactNode; linkCount: number; onPeople?: () => void; onLinks?: () => void; }
export interface ShareLinksGridProps {
  links: Array<ShareLinkRecord & { artifactName: string; projectName: string; createdLabel: string }>;
  statusOf: (link: ShareLinkRecord) => 'Active' | 'Expired' | 'Revoked';
  summaryOf: (link: ShareLinkRecord) => string;
  selectedIds: string[]; onSelectionChange: (ids: Array<string | number>) => void;
  renderCopy: (link: ShareLinkRecord) => React.ReactNode;
  onOpenArtifact: (link: ShareLinkRecord) => void; onRevoke: (link: ShareLinkRecord) => void;
}
export interface MemberGrantsProps {
  grants: Array<{ id: string; projectName: string; role: ProjectRole; artifactName?: string | null; overrides?: string }>;
  onOpen: (grant: { id: string; projectId?: string }) => void; administrator?: boolean;
}

export interface McpAreaProps { connectWell: React.ReactNode; remoteWell: React.ReactNode; clients: string[]; toolLedger: React.ReactNode; webmcpTools: string[]; }

/* ---- Lists (projects-ui.jsx) ---- */
export interface ArtifactRowProps { artifact: { name: string; versions: number; updated: string }; unresolved: number; selected?: boolean; padding?: string; minHeight?: number; onSelect: () => void; }
export interface ProjectRowProps { project: { id: string; name: string; archived?: boolean }; count: number; unresolved: number; last?: string; selected?: boolean; padding?: string; minHeight?: number; onSelect: () => void; }
export interface PhoneProjectsProps { rows: Array<Omit<ProjectRowProps, 'selected' | 'padding' | 'minHeight' | 'onSelect'>>; onNew: () => void; onOpen: (project: ProjectRowProps['project']) => void; }

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
  /** The Library in artifact scope; requires the same `controls` as `DesignLibrary`. */
  DesignGallery: React.ComponentType<DesignGalleryProps>;
  /** Requires `Button`, `IconButton`, `SearchField`, `FilterMenu`, `ActiveFilters`, `SegmentedControl`, `GroupBand`, `SurfaceState`, `SectionHeading`, `ScrollDock`, `Toolbar`, `ToolbarGroup`, `ToolbarSeparator` and `visuallyHiddenStyle` in `controls`. */
  DesignLibrary: React.ComponentType<DesignLibraryProps>;
  /** A full-bleed sketch of one kind; fills its positioned container. */
  GalleryPlaceholder: React.ComponentType<GalleryPlaceholderProps>;
  /** Requires `SectionHeading`, `AutoGrid` and `MetricCard` in `controls`. */
  ActivityHeader: React.ComponentType<ActivityHeaderProps>;
  /** Requires `CommentThread`, `StatusPill`, `Button`, `SurfaceState`, `ScrollDock`, `AnnotationPin` and `LoadMore` in `controls`. */
  ActivityFeed: React.ComponentType<ActivityFeedProps>;
  /** Requires `SegmentedControl`, `SearchField`, `FilterMenu`, `ActiveFilters`, `Avatar`, `ScrollDock`, `Toolbar`, `ToolbarGroup` and `ToolbarSeparator` in `controls`. */
  ActivityToolbar: React.ComponentType<ActivityToolbarProps>;
  /** Picks the family's viewer for `kind`. Each viewer fills its container, scrolls its paper inside it and keeps its page, sheet or slide to itself; it never writes browser history. Its controls ride in one floating pill (the design system's `Toolbar placement="floating"`, with arrow-key movement) at the document's foot, with the occasional options in a View menu. */
  OfficeViewer: React.ComponentType<OfficeViewerProps>;
  /** Word: Letter paper with Fit width (to 150%) and Fit page; the pill holds Page thumbnails, Pager and zoom; View holds Margins and Regions. Requires `IconButton`, `Pager`, `ZoomControl`, `PageThumbnails`, `Menu`, `BrandLock`, `Toolbar`, `ToolbarSeparator`, `fitZoom` and `useElementSize` in `controls`. */
  DocumentViewer: React.ComponentType<DocumentViewerProps>;
  /** Excel: an edge-to-edge sheet whose empty rows continue to the pill; the pill holds the sheet and zoom; View holds Formula bar, Gridlines, Compact rows and Cell styles. Requires `Select`, `ZoomControl`, `IconButton`, `Menu`, `WorksheetMock`, `Toolbar`, `ToolbarSeparator`, `fitZoom` and `useElementSize` in `controls`. */
  SpreadsheetViewer: React.ComponentType<SpreadsheetViewerProps>;
  /** PowerPoint: the slide fits the column's width and height; the pill holds the Slide rail, Pager, zoom and Speaker notes; View holds Slide sorter and Safe area. Requires `IconButton`, `Pager`, `ZoomControl`, `Menu`, `SlideMock`, `SlideWireframe`, `Toolbar`, `ToolbarSeparator`, `fitZoom` and `useElementSize` in `controls`. */
  PresentationViewer: React.ComponentType<PresentationViewerProps>;
  /** A part's value and its words in a comment ("page 2", "sheet Inputs", "slide 3"); an absent value is the part the viewer opens on. */
  officePartOf: (kind: 'document' | 'spreadsheet' | 'presentation', value: OfficePartValue | null | undefined, name: string) => { value: OfficePartValue; label: string };
  /** The artifact fixture's placeholder page. Requires `Eyebrow` and `SkeletonLines` in `controls`. */
  PageSketch: React.ComponentType<PageSketchProps>;
  /** The shown page in the preview (or the raw view). Requires `SurfaceState`, `CodeBlock`, `Button`, `Eyebrow`, `FieldGrid` and `SkeletonLines` in `controls`, plus `OfficeViewer`'s. */
  PreviewPage: React.ComponentType<PreviewPageProps>;
  /** Focus's title: the page (or gallery) and the version on navy. */
  FocusTitle: React.ComponentType<FocusTitleProps>;
  /** Focus's navy title-bar controls. Requires `Toolbar`, `IconButton` and `Button` in `controls`. */
  FocusControls: React.ComponentType<FocusControlsProps>;
  /** Requires `Avatar` and `Button` in `controls`. */
  AgentControls: React.ComponentType<AgentControlsProps>;
  /** Requires `PanelSection`, `FieldGrid`, `StatusPill`, `Select` and `Button` in `controls`. */
  DetailsPanel: React.ComponentType<DetailsPanelProps>;
  /** Requires `Tabs` and `TreeView` in `controls`. */
  FilesPanel: React.ComponentType<FilesPanelProps>;
  FilesFooter: React.ComponentType<FilesFooterProps>;
  /** Requires `IconButton` in `controls`. */
  ShareHeader: React.ComponentType<ShareHeaderProps>;
  /** Requires `PanelSection`, `ChoiceGroup`, `Input` and `Button` in `controls`. */
  ShareOverview: React.ComponentType<ShareOverviewProps>;
  ShareConnect: React.ComponentType<ShareConnectProps>;
  /** Requires `RecordPanel`, `Tooltip` and `IconButton` in `controls`. */
  AdminListPanel: React.ComponentType<AdminListPanelProps>;
  /** Requires `DataGrid` and `StatusPill` in `controls`. */
  MembersGrid: React.ComponentType<MembersGridProps>;
  /** Requires `SlideOver`, `FieldGrid`, `StatusPill` and `Button` in `controls`. */
  MemberInspector: React.ComponentType<MemberInspectorProps>;
  InvitesGrid: React.ComponentType<InvitesGridProps>;
  KeysGrid: React.ComponentType<KeysGridProps>;
  /** Also requires `Tag` in `controls`. */
  KeyInspector: React.ComponentType<KeyInspectorProps>;
  /** Also requires `SurfaceState` in `controls`. */
  PublicLinksGrid: React.ComponentType<PublicLinksGridProps>;
  /** Requires `RecordPanel`, `Tag` and `Switch` in `controls`. */
  McpArea: React.ComponentType<McpAreaProps>;
  /** Details' name editor. Requires `Input`, `Button` and `Alert` in `controls`. */
  NameEditor: React.ComponentType<NameEditorProps>;
  /** Details' Source section. Requires `FieldGrid` and `StatusPill` in `controls`. */
  SourceRecord: React.ComponentType<SourceRecordProps>;
  /** Requires `Tag` in `controls`. */
  GuestBadge: React.ComponentType<GuestBadgeProps>;
  GuestHeader: React.ComponentType<GuestHeaderProps>;
  /** The one page for every ended, revoked, rotated, turned-off or unknown link. */
  EndedLink: React.ComponentType<Record<string, never>>;
  /** Requires `Input` and `Alert` in `controls`. */
  GuestNameForm: React.ComponentType<GuestNameFormProps>;
  /** Requires `Select` in `controls`. */
  WhyCanThey: React.ComponentType<WhyCanTheyProps>;
  /** Requires `Checkbox` and `Button` in `controls`. */
  PermissionChecklist: React.ComponentType<PermissionChecklistProps>;
  /** Requires `RecordPanel`, `Select`, `StatusPill`, `Tag` and `Button` in `controls`. */
  ProjectAccessPanel: React.ComponentType<ProjectAccessPanelProps>;
  /** Requires `RecordPanel`, `Switch`, `Checkbox`, `Input`, `Select`, `Alert` and `Button` in `controls`. */
  AccessPolicyScreen: React.ComponentType<AccessPolicyScreenProps>;
  /** Requires `Select`, `IconButton` and `Button` in `controls`. */
  SharePeople: React.ComponentType<SharePeopleProps>;
  /** Requires `Alert` and `Button` in `controls`. */
  ShareLinksList: React.ComponentType<ShareLinksListProps>;
  /** Requires `Input`, `ChoiceGroup`, `Checkbox`, `Select`, `Alert` and `Button` in `controls`. */
  ShareLinkForm: React.ComponentType<ShareLinkFormProps>;
  /** Requires `PanelSection` and `Button` in `controls`. */
  ShareAccessBands: React.ComponentType<ShareAccessBandsProps>;
  /** Requires `DataGrid`, `StatusPill` and `SurfaceState` in `controls`. */
  ShareLinksGrid: React.ComponentType<ShareLinksGridProps>;
  /** Requires `Button` and `Tag` in `controls`. */
  MemberGrants: React.ComponentType<MemberGrantsProps>;
  /** Requires `SelectableRow`, `RowSummary` and `CountBadge` in `controls`. */
  ArtifactRow: React.ComponentType<ArtifactRowProps>;
  /** Also requires `StatusPill` in `controls`. */
  ProjectRow: React.ComponentType<ProjectRowProps>;
  /** Also requires `SectionHeading` and `IconButton` in `controls`. */
  PhoneProjects: React.ComponentType<PhoneProjectsProps>;
};
