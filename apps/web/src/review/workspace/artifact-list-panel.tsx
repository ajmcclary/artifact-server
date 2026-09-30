import type {CSSProperties} from "react";

import type {ArtifactPage} from "@/api/client";
import {
  Button,
  Checkbox,
  CountBadge,
  IconButton,
  Panel,
  Popover,
  RailHeader,
  Select,
  SelectableRow,
  StatusPill,
  SurfaceState,
} from "@/arkcase";
import {formatTimestamp} from "@/lib/presentation";

import {catalogWidth} from "./workspace-layout.ts";
import type {
  CatalogCommentFilter,
  CatalogRefreshState,
  CatalogSort,
} from "./workspace-types.ts";

type CatalogItem = ArtifactPage["artifacts"][number];

/** Everything the artifact catalog shows and reports. The review owns every value. */
export interface ArtifactListPanelProps {
  /** Whether the width budget lets the catalog dock (DS `canPin`). */
  readonly canPin: boolean;
  readonly commentFilter: CatalogCommentFilter;
  readonly filtersOpen: boolean;
  readonly items: readonly CatalogItem[];
  readonly knownTags: readonly string[];
  readonly listError: Error | null;
  readonly listLoading: boolean;
  readonly nextCursor: string | null;
  readonly onAnnounce: (message: string) => void;
  readonly onCollapse: () => void;
  readonly onCommentFilterChange: (filter: CatalogCommentFilter) => void;
  readonly onFiltersOpenChange: (open: boolean) => void;
  readonly onLoadMore: () => void;
  readonly onPeekChange: (peeking: boolean) => void;
  readonly onPinChange: (pinned: boolean) => void;
  readonly onQueryChange: (query: string) => void;
  readonly onRefresh: () => void;
  readonly onSelect: (artifactId: string, versionId: string) => void;
  readonly onSheetClose: () => void;
  readonly onSortChange: (sort: CatalogSort) => void;
  readonly onTagFiltersChange: (tags: readonly string[]) => void;
  readonly onWidthChange: (width: number | null) => void;
  readonly peeking: boolean;
  readonly pinned: boolean;
  readonly projectName: string;
  readonly query: string;
  readonly refreshState: CatalogRefreshState;
  readonly selectedArtifactId: string | null;
  /** The selected artifact's live thread count once its comments have loaded, else null. */
  readonly selectedCommentCount: number | null;
  /** The selected project's settings page, or null when no project is selected. */
  readonly settingsHref: string | null;
  /** Phone presentation: the catalog fills the viewport. */
  readonly sheet: boolean;
  readonly sort: CatalogSort;
  readonly tagFilters: readonly string[];
  readonly width: number;
}

const commentFilterOptions = [
  {label: "All artifacts", value: "all"},
  {label: "With comments", value: "with"},
  {label: "No comments", value: "without"},
] as const satisfies readonly {readonly label: string; readonly value: CatalogCommentFilter}[];

const listStyle = {listStyle: "none", margin: 0, padding: 0} satisfies CSSProperties;
const filterStackStyle = {display: "flex", flexDirection: "column", gap: 10} satisfies CSSProperties;
const fieldsetStyle = {
  border: 0,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  margin: 0,
  minWidth: 0,
  padding: 0,
} satisfies CSSProperties;
const legendStyle = {
  color: "var(--text-secondary)",
  fontSize: "var(--font-size-label, 11px)",
  fontWeight: 600,
  letterSpacing: ".06em",
  marginBottom: 4,
  textTransform: "uppercase",
} satisfies CSSProperties;
const noteStyle = {color: "var(--text-secondary)", fontSize: "var(--font-size-xs, 12px)", margin: 0} satisfies CSSProperties;
const rowTitleStyle = {alignItems: "center", display: "flex", gap: 8, minWidth: 0} satisfies CSSProperties;
const rowNameStyle = {
  color: "var(--text-strong)",
  flex: "1 1 auto",
  fontSize: "var(--font-size-sm, 14px)",
  minWidth: 0,
  overflow: "hidden",
  textAlign: "left",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} satisfies CSSProperties;
const rowMetaStyle = {
  alignItems: "center",
  color: "var(--text-secondary)",
  display: "flex",
  fontSize: "var(--font-size-xs, 12px)",
  gap: 6,
  marginTop: 4,
} satisfies CSSProperties;
const rowButtonStyle = {display: "block", textAlign: "left", width: "100%"} satisfies CSSProperties;
const loadMoreStyle = {display: "flex", justifyContent: "center", padding: "10px 14px 14px"} satisfies CSSProperties;
const projectSettingsStyle = {display: "flex", flex: "none", justifyContent: "flex-end", padding: "4px 8px 0"} satisfies CSSProperties;
const sheetBackStyle = {background: "var(--surface-secondary)", flex: "none", padding: "4px 8px 0"} satisfies CSSProperties;
const shortcutListStyle = {display: "grid", gap: 6, margin: 0} satisfies CSSProperties;
const shortcutRowStyle = {alignItems: "center", display: "flex", gap: 12, justifyContent: "space-between"} satisfies CSSProperties;
const shortcutHeadingStyle = {fontSize: "var(--font-size-xs, 12px)", margin: "4px 0 2px", textTransform: "uppercase"} satisfies CSSProperties;
const keysStyle = {alignItems: "center", display: "inline-flex", gap: 4, margin: 0} satisfies CSSProperties;
const kbdStyle = {
  border: "1px solid var(--border-color-strong)",
  borderRadius: "var(--radius-sm, 4px)",
  fontFamily: "var(--font-data)",
  fontSize: "var(--font-size-label, 11px)",
  padding: "1px 5px",
} satisfies CSSProperties;

/** The filter summary the closed filter slot shows (the old trigger label). */
function catalogFilterLabel(
  commentFilter: CatalogCommentFilter,
  tagFilters: readonly string[],
): string {
  const activeFilterCount = Number(commentFilter !== "all") + tagFilters.length;
  if (commentFilter === "all" && tagFilters.length === 1) return tagFilters[0] ?? "1 tag";
  if (commentFilter === "all" && tagFilters.length > 1) return `${tagFilters.length} tags`;
  if (commentFilter === "with" && tagFilters.length === 0) return "With comments";
  if (commentFilter === "without" && tagFilters.length === 0) return "No comments";
  if (activeFilterCount > 0) return `${activeFilterCount} filters`;
  return "All artifacts";
}

/** The catalog: a pinnable, resizable, peeking DS Panel over the project's artifacts. */
export function ArtifactListPanel({
  canPin,
  commentFilter,
  filtersOpen,
  items,
  knownTags,
  listError,
  listLoading,
  nextCursor,
  onAnnounce,
  onCollapse,
  onCommentFilterChange,
  onFiltersOpenChange,
  onLoadMore,
  onPeekChange,
  onPinChange,
  onQueryChange,
  onRefresh,
  onSelect,
  onSheetClose,
  onSortChange,
  onTagFiltersChange,
  onWidthChange,
  peeking,
  pinned,
  projectName,
  query,
  refreshState,
  selectedArtifactId,
  selectedCommentCount,
  settingsHref,
  sheet,
  sort,
  tagFilters,
  width,
}: ArtifactListPanelProps) {
  const activeFilterCount = Number(commentFilter !== "all") + tagFilters.length;
  const filtered = query !== "" || activeFilterCount > 0;
  const tags = [...new Set([...knownTags, ...tagFilters])].toSorted();
  const toggleTag = (tag: string): void => {
    onTagFiltersChange(
      tagFilters.includes(tag)
        ? tagFilters.filter((selected) => selected !== tag)
        : [...tagFilters, tag].toSorted(),
    );
  };
  const clearFilters = (): void => {
    onCommentFilterChange("all");
    onTagFiltersChange([]);
  };

  const actions = (
    <>
      <Button
        aria-label="Refresh artifacts published by agents, the CLI, or other sessions"
        data-state={refreshState}
        disabled={listLoading}
        icon={refreshState === "complete" ? "bi-check2" : "bi-arrow-clockwise"}
        loading={refreshState === "loading"}
        onClick={onRefresh}
        size="sm"
        title="Refresh artifacts published by agents, the CLI, or other sessions"
        variant="light"
      />
      <Button
        aria-label={`Filter artifacts. ${activeFilterCount === 0 ? "No filters applied" : `${activeFilterCount} applied`}.`}
        expanded={filtersOpen}
        icon="bi-funnel"
        onClick={() => onFiltersOpenChange(!filtersOpen)}
        size="sm"
        title="Filter artifacts"
        variant="light"
      >
        {activeFilterCount === 0 ? null : <CountBadge count={activeFilterCount} tone="primary" />}
      </Button>
      <KeyboardShortcuts />
      {pinned && canPin && !sheet ? (
        <IconButton
          ariaLabel="Collapse artifact catalog"
          icon="bi-layout-sidebar-inset"
          keyshortcuts="["
          onClick={onCollapse}
          size="sm"
          title="Collapse artifact catalog ([)"
        />
      ) : null}
    </>
  );

  const filters = (
    <div
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onFiltersOpenChange(false);
      }}
      style={filterStackStyle}
    >
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Comments</legend>
        {commentFilterOptions.map((option) => (
          <Checkbox
            checked={commentFilter === option.value}
            key={option.value}
            label={option.label}
            name="catalog-comment-filter"
            onChange={() => onCommentFilterChange(option.value)}
            radio
          />
        ))}
      </fieldset>
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Tags</legend>
        <Button
          flush
          onClick={() => onTagFiltersChange([])}
          pressed={tagFilters.length === 0}
          size="sm"
          variant="link"
        >
          Any tag
        </Button>
        {tags.length === 0
          ? <p style={noteStyle}>No tags in the loaded catalog.</p>
          : tags.map((tag) => (
            <Checkbox
              checked={tagFilters.includes(tag)}
              key={tag}
              label={tag}
              name="catalog-tag-filter"
              onChange={() => toggleTag(tag)}
            />
          ))}
      </fieldset>
      <Select
        label="Sort artifacts"
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === "comments" || value === "newest") onSortChange(value);
        }}
        options={[
          {label: "Newest first", value: "newest"},
          {label: "Most comments", value: "comments"},
        ]}
        size="sm"
        value={sort}
      />
      {activeFilterCount === 0 ? null : (
        <Button flush icon="bi-x-circle" onClick={clearFilters} size="sm" variant="link">
          Clear filters
        </Button>
      )}
    </div>
  );

  const header = (
    <>
      {sheet ? (
        <div style={sheetBackStyle}>
          <Button icon="bi-chevron-left" onClick={onSheetClose} size="sm" variant="link">Back</Button>
        </div>
      ) : null}
      {settingsHref === null ? null : (
        <div style={projectSettingsStyle}>
          <Button href={settingsHref} icon="bi-sliders" size="sm" variant="ghost">
            Project settings
          </Button>
        </div>
      )}
      <RailHeader
        actions={actions}
        filters={filters}
        filtersOpen={filtersOpen}
        headingLevel={2}
        onQuery={(event) => onQueryChange(event.currentTarget.value)}
        onQueryKeyDown={(event) => {
          if (event.key !== "Escape" || query === "") return;
          event.stopPropagation();
          onQueryChange("");
        }}
        query={query}
        queryLabel="Search artifacts"
        queryPlaceholder="Search artifacts…"
        summary={activeFilterCount === 0 ? null : catalogFilterLabel(commentFilter, tagFilters)}
        title="Artifacts"
      />
    </>
  );

  return (
    <Panel
      bodyStyle={{display: "flex", flexDirection: "column"}}
      canPin={canPin}
      count={items.length}
      countLabel={`${items.length} artifacts in ${projectName}`}
      footerMeta={`${items.length} loaded${nextCursor === null ? "" : " · more available"}`}
      header={header}
      icon="bi-collection"
      id="artifact-catalog"
      maxWidth={catalogWidth.maximum}
      minWidth={catalogWidth.minimum}
      name="artifact catalog"
      onAnnounce={onAnnounce}
      onPeekChange={onPeekChange}
      onPinChange={onPinChange}
      onWidthChange={onWidthChange}
      peeking={peeking}
      pinned={pinned}
      railLabel="Artifacts"
      resizable
      sheet={sheet}
      width={width}
    >
      {({closePeek}) => (
        <>
          {listError === null ? null : (
            <SurfaceState
              density="inline"
              failedBody={listError.message}
              failedTitle="Catalog unavailable"
              noun="artifacts"
              onRetry={onRefresh}
              phase="failed"
            />
          )}
          {listLoading && items.length === 0 ? (
            <SurfaceState
              density="inline"
              loadingStyle="spinner"
              loadingTitle="Loading artifacts"
              noun="artifacts"
              phase="loading"
            />
          ) : null}
          {!listLoading && listError === null && items.length === 0 ? (
            <SurfaceState
              count={0}
              emptyBody={filtered
                ? "Try clearing a filter or using a wider search."
                : "Publish from the CLI to populate this project."}
              emptyIcon={filtered ? "bi-search" : "bi-collection"}
              emptyTitle={filtered ? "No matching artifacts" : "No artifacts yet"}
              noun="artifacts"
              phase="ready"
            />
          ) : null}
          <ul aria-label="Artifacts" style={listStyle}>
            {items.map(({artifact, commentCount, versionCount}) => {
              const selected = artifact.id === selectedArtifactId;
              const comments = selected && selectedCommentCount !== null
                ? selectedCommentCount
                : commentCount;
              const publicLink = artifact.accessSetting === "public_link";
              return (
                <li key={artifact.id}>
                  <SelectableRow
                    as="button"
                    onSelect={() => {
                      closePeek();
                      onSelect(artifact.id, artifact.currentVersionId);
                    }}
                    padding="9px 14px"
                    selected={selected}
                    style={rowButtonStyle}
                  >
                    <span style={rowTitleStyle}>
                      <strong style={rowNameStyle}>{artifact.name}</strong>
                      <StatusPill label={publicLink ? "public" : "private"} tone={publicLink ? "primary" : "neutral"} />
                    </span>
                    <span style={rowMetaStyle}>
                      <time dateTime={artifact.createdAt}>{formatTimestamp(artifact.createdAt)}</time>
                      <span aria-hidden="true">·</span>
                      <span>{versionCount} version{versionCount === 1 ? "" : "s"}</span>
                      <CountBadge
                        count={comments}
                        label={`${comments} comment${comments === 1 ? "" : "s"}`}
                        style={{marginLeft: "auto"}}
                      />
                    </span>
                  </SelectableRow>
                </li>
              );
            })}
          </ul>
          {nextCursor === null ? null : (
            <div style={loadMoreStyle}>
              <Button disabled={listLoading} onClick={onLoadMore} outline size="sm" variant="secondary">
                {listLoading ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

/** The shortcut map, reachable from the catalog header. */
function KeyboardShortcuts() {
  return (
    <Popover
      contentStyle={{gap: 8, padding: 12}}
      label="Keyboard shortcuts"
      placement="bottom-end"
      trigger={(
        <Button
          aria-label="Keyboard shortcuts"
          icon="bi-keyboard"
          size="sm"
          title="Keyboard shortcuts"
          variant="light"
        />
      )}
      width={300}
    >
      <h3 style={shortcutHeadingStyle}>Navigate</h3>
      <dl style={shortcutListStyle}>
        <ShortcutRow joiner="or" keys={["K", "↑"]} label="Previous artifact" />
        <ShortcutRow joiner="or" keys={["J", "↓"]} label="Next artifact" />
      </dl>
      <h3 style={shortcutHeadingStyle}>Layout</h3>
      <dl style={shortcutListStyle}>
        <ShortcutRow joiner="or" keys={["["]} label="Artifact catalog" />
        <ShortcutRow joiner="or" keys={["]"]} label="Inspector or comments" />
        <ShortcutRow joiner="or" keys={["F"]} label="Full screen" />
        <ShortcutRow joiner="or" keys={["Esc"]} label="Back or close current layer" />
        <ShortcutRow joiner="+" keys={["⌘ / Ctrl", "\\"]} label="Reveal hidden viewer controls" />
      </dl>
    </Popover>
  );
}

interface ShortcutRowProps {
  readonly joiner: "+" | "or";
  readonly keys: readonly string[];
  readonly label: string;
}

function ShortcutRow({joiner, keys, label}: ShortcutRowProps) {
  return (
    <div style={shortcutRowStyle}>
      <dt>{label}</dt>
      <dd style={keysStyle}>
        {keys.map((key, index) => (
          <span key={key} style={keysStyle}>
            {index === 0 ? null : <span>{joiner}</span>}
            <kbd style={kbdStyle}>{key}</kbd>
          </span>
        ))}
      </dd>
    </div>
  );
}
