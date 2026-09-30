import {useLayoutEffect, useState, type CSSProperties} from "react";

import {api, type Project} from "@/api/client";
import {Alert, Button, SurfaceState} from "@/arkcase";
import {useAnnounce} from "@/ui/announcer";
import {DesignGallery} from "@/ui/review-ui";

import {libraryHref, navigateReview, workspaceHref, writeReviewHistory} from "../review-routes.ts";
import {useViewportWidth} from "../workspace/use-viewport-size.ts";
import {isPhoneWidth} from "../workspace/workspace-layout.ts";
import {initialGalleryViewState, type GalleryViewState} from "../workspace/design-gallery.ts";
import {libraryItems, parseLibraryItemId, type LibrarySource} from "./design-library.ts";
import {useDesignLibrary} from "./use-design-library.ts";

const screenStyle = {display: "flex", flexDirection: "column", height: "100%", minHeight: 0} satisfies CSSProperties;
const stateStyle = {margin: "auto", maxWidth: 560, padding: 24, width: "100%"} satisfies CSSProperties;
const noticeStyle = {alignItems: "center", display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 16} satisfies CSSProperties;
const metaStyle = {color: "var(--text-secondary)", fontSize: 12} satisfies CSSProperties;
const timeFormat = new Intl.DateTimeFormat(undefined, {hour: "numeric", minute: "2-digit"});

// Search, kind, layout, scroll and the tile left from survive the trip to a page and back.
const viewStates = new Map<string, GalleryViewState>();

/**
 * Every design gallery in one project, following each artifact's current version.
 * It is a moving view, not a frozen collection: tiles open the exact version that
 * was current when the library loaded, and Refresh re-reads current versions.
 */
export function DesignLibraryScreen({
  projectId,
  projects,
}: {
  readonly projectId: string | null;
  readonly projects: readonly Project[];
}) {
  const project = projects.find((candidate) => candidate.id === projectId)
    ?? (projectId === null
      ? projects.find((candidate) => candidate.archivedAt === null) ?? projects[0]
      : undefined);
  const resolvedId = project?.id ?? null;
  useLayoutEffect(() => {
    // Tell the shell too, so its navigation marks the project this library shows.
    if (projectId === null && resolvedId !== null) writeReviewHistory(libraryHref(resolvedId), "replace");
  }, [projectId, resolvedId]);

  if (project === undefined) {
    return (
      <div style={stateStyle}>
        <SurfaceState count={0} emptyBody="Choose a project you can open to see its design galleries."
          emptyIcon="bi-question-circle" emptyTitle="Project unavailable" noun="projects" phase="ready" titleLevel={1} />
      </div>
    );
  }
  // Keyed by project: another project's galleries and refresh state never show here.
  return <ProjectDesignLibrary key={project.id} project={project} />;
}

function ProjectDesignLibrary({project}: {readonly project: Project}) {
  const announce = useAnnounce();
  const phone = isPhoneWidth(useViewportWidth());
  const {refresh, state} = useDesignLibrary(project.id);
  const [, setRevision] = useState(0);

  if (state.status === "loading") {
    return (
      <div style={stateStyle}>
        <SurfaceState loadingBody="Reading each artifact's current version and preview index."
          loadingStyle="spinner" loadingTitle="Loading the design library" noun="galleries" phase="loading" />
      </div>
    );
  }
  if (state.status === "failed") {
    return (
      <div style={stateStyle}>
        <SurfaceState failedBody={state.message} failedTitle="The design library could not load" noun="galleries"
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
          emptyBody={`None of the ${library.scanned} artifacts in ${project.name} has a design gallery. Publish a design export to add one.`}
          actionLabel="Refresh" actionIcon="bi-arrow-clockwise" onAction={refresh} />
      </div>
    );
  }
  const bySource = new Map(library.sources.map((source) => [source.artifactId, source]));
  const view = viewStates.get(project.id) ?? initialGalleryViewState;
  const update = (patch: Partial<GalleryViewState>, render: boolean): void => {
    viewStates.set(project.id, {...(viewStates.get(project.id) ?? initialGalleryViewState), ...patch});
    if (render) setRevision((revision) => revision + 1);
  };
  const exactHref = (id: string): string | null => {
    const parsed = parseLibraryItemId(id);
    const source = parsed === null ? undefined : bySource.get(parsed.artifactId);
    return parsed === null || source === undefined
      ? null
      : workspaceHref({artifactId: source.artifactId, path: parsed.path, projectId: project.id, versionId: source.versionId, view: null});
  };
  const media = (source: LibrarySource, path: string) => api.versionMediaUrl(project.id, source.artifactId, source.versionId, path);
  return (
    <div style={screenStyle}>
      <DesignGallery
        description={`Every design gallery in ${project.name}, following each artifact's current version.`}
        focusPath={view.focusPath}
        hrefFor={(id) => exactHref(id) ?? libraryHref(project.id)}
        items={libraryItems(library.sources, media)}
        key={`${project.id}:${library.loadedAt.getTime()}`}
        kind={view.kind}
        notice={(
          <>
            <div style={noticeStyle}>
              <span style={metaStyle}>
                {library.sources.length} {library.sources.length === 1 ? "gallery" : "galleries"} · current versions as of {timeFormat.format(library.loadedAt)}
                {library.truncated ? ` · first ${library.scanned} artifacts` : ""}
              </span>
              <Button icon="bi-arrow-clockwise" onClick={refresh} outline size="sm" variant="secondary">Refresh</Button>
            </div>
            {library.failures.length === 0 ? null : (
              <Alert variant="warning">
                {`These galleries could not be read and are not shown: ${library.failures.join(", ")}.`}
              </Alert>
            )}
          </>
        )}
        onAnnounce={announce}
        onKindChange={(kind) => update({kind}, true)}
        onOpen={(id) => {
          const href = exactHref(id);
          if (href === null) return;
          update({focusPath: id}, false);
          navigateReview(href);
        }}
        onQueryChange={(query) => update({query}, true)}
        onScroll={(scrollTop) => update({scrollTop}, false)}
        onViewChange={(layout) => update({view: layout}, true)}
        phone={phone}
        query={view.query}
        scrollTop={view.scrollTop}
        title={`${project.name} design library`}
        view={view.view}
      />
    </div>
  );
}
