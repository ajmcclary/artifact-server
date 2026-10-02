import {useEffect, useRef, useState, type CSSProperties} from "react";

import {api, type Project} from "@/api/client";
import {Alert, SurfaceState} from "@/arkcase";
import {usDateTime} from "@/ui/activity-model";
import {useAnnounce} from "@/ui/announcer";
import {DesignLibrary, type GalleryKind, type LibraryGrouping, type LibrarySort} from "@/ui/review-ui";

import {libraryHref, navigateReview, workspaceHref} from "../review-routes.ts";
import {useViewportWidth} from "../workspace/use-viewport-size.ts";
import {isPhoneWidth} from "../workspace/workspace-layout.ts";
import {libraryItems, parseLibraryItemId, type LibrarySource} from "./design-library.ts";
import {useDesignLibrary} from "./use-design-library.ts";

const screenStyle = {display: "flex", flexDirection: "column", height: "100%", minHeight: 0} satisfies CSSProperties;
const stateStyle = {margin: "auto", maxWidth: 560, padding: 24, width: "100%"} satisfies CSSProperties;

/** Every choice the library's toolbar makes, plus where the reader was. */
export interface LibraryViewState {
  readonly collapsed: readonly string[];
  readonly focusPath: string | null;
  readonly groupBy: LibraryGrouping;
  readonly projects: readonly string[];
  readonly query: string;
  readonly scrollTop: number;
  readonly sortBy: LibrarySort;
  readonly sortDir: "asc" | "desc";
  readonly types: readonly GalleryKind[];
  readonly view: "grid" | "list";
}

const initialLibraryViewState: LibraryViewState = {
  collapsed: [],
  focusPath: null,
  groupBy: "date",
  projects: [],
  query: "",
  scrollTop: 0,
  sortBy: "activity",
  sortDir: "desc",
  types: [],
  view: "grid",
};

// Search, projects, types, grouping, sort, layout, collapsed groups, scroll and the tile left from
// survive the trip to a page and back.
const viewStates = new Map<string, LibraryViewState>();
const libraryViewKey = "all";
const media = (source: LibrarySource, path: string) => api.versionMediaUrl(source.projectId, source.artifactId, source.versionId, path);

/**
 * Every design gallery across all projects, following each artifact's current version.
 * It is a moving view, not a frozen collection: tiles open the exact version that
 * was current when the library loaded, and Refresh re-reads current versions.
 */
export function DesignLibraryScreen({projects}: {readonly projects: readonly Project[]}) {
  const announce = useAnnounce();
  const phone = isPhoneWidth(useViewportWidth());
  const {refresh, state} = useDesignLibrary(projects);
  const [, setRevision] = useState(0);
  const loadedAt = state.status === "ready" ? state.library.loadedAt : null;
  const shownLoad = useRef(loadedAt);
  useEffect(() => {
    // A completed Refresh says so; the first load and a return from a page stay quiet.
    if (shownLoad.current !== null && loadedAt !== null && loadedAt !== shownLoad.current) {
      announce("Library refreshed from each artifact’s current version.");
    }
    shownLoad.current = loadedAt;
  }, [announce, loadedAt]);

  if (state.status === "loading") {
    return (
      <div style={stateStyle}>
        <SurfaceState loadingBody="Reading each artifact's current version, history and preview index."
          loadingStyle="spinner" loadingTitle="Loading the library" noun="galleries" phase="loading" />
      </div>
    );
  }
  if (state.status === "failed") {
    return (
      <div style={stateStyle}>
        <SurfaceState failedBody={state.message} failedTitle="The library could not load" noun="galleries"
          onRetry={refresh} phase="failed" />
      </div>
    );
  }
  const {library} = state;
  if (library.sources.length === 0) {
    return (
      <div style={stateStyle}>
        <SurfaceState count={0} titleLevel={1} noun="galleries" phase="ready" emptyIcon="bi-collection"
          emptyTitle="No design galleries yet"
          emptyBody={`None of the ${library.scanned} artifacts has a design gallery. Publish a design export to add one.`}
          actionLabel="Refresh" actionIcon="bi-arrow-clockwise" onAction={refresh} />
      </div>
    );
  }
  const bySource = new Map(library.sources.map((source) => [source.artifactId, source]));
  const view = viewStates.get(libraryViewKey) ?? initialLibraryViewState;
  const update = (patch: Partial<LibraryViewState>, render: boolean): void => {
    viewStates.set(libraryViewKey, {...(viewStates.get(libraryViewKey) ?? initialLibraryViewState), ...patch});
    if (render) setRevision((revision) => revision + 1);
  };
  const exactHref = (id: string): string | null => {
    const parsed = parseLibraryItemId(id);
    const source = parsed === null ? undefined : bySource.get(parsed.artifactId);
    return parsed === null || source === undefined
      ? null
      : workspaceHref({artifactId: source.artifactId, path: parsed.path, projectId: source.projectId, threadId: null, versionId: source.versionId, view: null});
  };
  const notices = [
    state.refresh === "failed" ? (
      <Alert key="refresh" variant="warning">
        The library could not be re-read, so these are the galleries as last read. Nothing was changed.
      </Alert>
    ) : null,
    library.failures.length === 0 ? null : (
      <Alert key="failures" variant="warning">
        {`These galleries could not be read and are not shown: ${library.failures.join(", ")}.`}
      </Alert>
    ),
    library.undated.length === 0 ? null : (
      <Alert key="undated" variant="info">
        {`The history of these galleries could not be read, so their pages are dated by the current version: ${library.undated.join(", ")}.`}
      </Alert>
    ),
    library.truncated ? (
      <Alert key="truncated" variant="info">
        {`The library reads the first ${library.scanned} artifacts; galleries past them are not shown.`}
      </Alert>
    ) : null,
  ].filter((notice) => notice !== null);
  return (
    <div style={screenStyle}>
      <DesignLibrary
        collapsed={[...view.collapsed]}
        description="Every design gallery across all projects, following each artifact’s current version."
        focusPath={view.focusPath}
        groupBy={view.groupBy}
        hrefFor={(id) => exactHref(id) ?? libraryHref()}
        items={libraryItems(library.sources, media)}
        key={`${libraryViewKey}:${library.loadedAt.getTime()}`}
        notice={notices.length === 0 ? undefined : <>{notices}</>}
        now={Date.now()}
        onAnnounce={announce}
        onCollapsedChange={(collapsed) => update({collapsed}, true)}
        onGroupByChange={(groupBy) => update({groupBy}, true)}
        onOpen={(id) => {
          const href = exactHref(id);
          if (href === null) return;
          update({focusPath: id}, false);
          navigateReview(href);
        }}
        onProjectsChange={(selected) => update({projects: selected}, true)}
        onQueryChange={(query) => update({query}, true)}
        onRefresh={refresh}
        onScroll={(scrollTop) => update({scrollTop}, false)}
        onSortChange={(sortBy, sortDir) => update({sortBy, sortDir}, true)}
        onTypesChange={(types) => update({types}, true)}
        onViewChange={(layout) => update({view: layout}, true)}
        phone={phone}
        projects={[...view.projects]}
        query={view.query}
        refreshedAt={usDateTime(library.loadedAt.getTime())}
        scrollTop={view.scrollTop}
        sortBy={view.sortBy}
        sortDir={view.sortDir}
        title="Library"
        types={[...view.types]}
        view={view.view}
      />
    </div>
  );
}
