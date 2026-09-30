import {
  type CSSProperties,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {setDraftPrincipal, writeDraft} from "@/components/comments/comment-drafts";
import {useCommentPoll} from "@/components/comments/comment-poll";
import {
  type AccessContext,
  type AccessSetting,
  api,
  ApiError,
  type ArtifactAction,
  type ArtifactComparison,
  type ArtifactDetails,
  type ArtifactPage,
  type ArtifactVersion,
  type Project,
  type Session,
} from "@/api/client";
import type {ReviewAnchor} from "@/review-frame/protocol";
import {usePalette} from "@/shell/command-palette";
import {ReviewShell} from "@/shell/review-shell";
import {dismissInnermost, SurfaceState} from "@/arkcase";
import {useAnnounce} from "@/ui/announcer";
import {changeArtifactAccess} from "./workspace/artifact-access.ts";
import {ArtifactListPanel} from "./workspace/artifact-list-panel.tsx";
import {CommentsTab, type CommentsTabHandle} from "./workspace/comments-tab.tsx";
import {ComparisonView} from "./workspace/comparison-view.tsx";
import {useDesignGalleryCanvas} from "./workspace/design-gallery-canvas.tsx";
import {DetailsTab} from "./workspace/details-tab.tsx";
import {FocusComments, FocusViewerControls, useFocusContainment} from "./workspace/focus-mode.tsx";
import {FilesTab} from "./workspace/files-tab.tsx";
import {InspectorPanel, type InspectorRailItem} from "./workspace/inspector-panel.tsx";
import {mediaTypeEssence} from "./workspace/page-inventory.ts";
import {PreviewCanvas} from "./workspace/preview-canvas.tsx";
import {ReviewToolbar} from "./workspace/review-toolbar.tsx";
import {SharePopover} from "./workspace/share-popover.tsx";
import {VersionsTab} from "./workspace/versions-tab.tsx";
import {catalogPanelId, inspectorPanelId, usePanelPreference} from "./workspace/panel-preferences.ts";
import {useViewportHeight, useViewportWidth} from "./workspace/use-viewport-size.ts";
import {catalogWidth, dockingFor, inspectorDefaultWidth, isPhoneWidth, workspaceBudget} from "./workspace/workspace-layout.ts";
import {
  type CatalogCommentFilter,
  type CatalogRefreshState,
  type CatalogSort,
  type ComparisonTab,
  type InspectorTab,
  inspectorTabs,
  type ReviewDownload,
  type VersionListItem,
} from "./workspace/workspace-types.ts";
import {useShellLayout} from "@/shell/shell-layout-context";
import {LoadingGate, SignInGate, UnavailableGate} from "@/shell/gates";
import {useReviewComments} from "./review-comments.tsx";
import {
  parseReviewRoute,
  projectSettingsHref,
  readReviewLocation,
  REVIEW_LOCATION_EVENT,
  REVIEW_RETURN_URL_KEY,
  type ReviewLocation,
  workspaceHref,
  writeReviewHistory,
} from "./review-routes.ts";
import {EmptyProjectCanvas} from "./settings/empty-project.tsx";
import {DesignLibraryScreen} from "./library/design-library-screen.tsx";
import {ReviewQueueScreen} from "./queue/review-queue-screen.tsx";
import {SettingsScreen} from "./settings/settings-screen.tsx";
import {canonicalReviewRoute} from "./settings/settings-view.ts";
import {useWebmcp, type WebmcpBindings} from "./webmcp.tsx";
import {writeStored} from "@/lib/safe-storage";

type ArtifactListLoadResult = "failed" | "loaded" | "skipped";

const workspaceStyle = {
  background: "var(--surface-canvas)",
  display: "flex",
  height: "100%",
  minHeight: 0,
  minWidth: 0,
} satisfies CSSProperties;
const focusLayerStyle = {
  background: "var(--surface-canvas)",
  display: "flex",
  inset: 0,
  position: "fixed",
  zIndex: 1030,
} satisfies CSSProperties;
const workspaceColumnStyle = {display: "flex", flex: "1 1 0", flexDirection: "column", minHeight: 0, minWidth: 0} satisfies CSSProperties;
const canvasRowStyle = {display: "flex", flex: "1 1 auto", minHeight: 0, minWidth: 0, position: "relative"} satisfies CSSProperties;
const canvasColumnStyle = {display: "flex", flex: "1 1 0", flexDirection: "column", minHeight: 0, minWidth: 0} satisfies CSSProperties;
const canvasSlotStyle = {flex: "1 1 auto", flexDirection: "column", minHeight: 0, minWidth: 0} satisfies CSSProperties;
const catalogLandmarkStyle = {display: "flex", flex: "none", minHeight: 0} satisfies CSSProperties;

const inspectorTitles = {
  comments: "Comments",
  details: "Details",
  files: "Files",
  versions: "Versions",
} satisfies Record<InspectorTab, string>;
const catalogRefreshConfirmationMilliseconds = 1_600;
const noVersions: readonly VersionListItem[] = [];

function reviewShortcutBlocked(event: KeyboardEvent): boolean {
  if (
    event.defaultPrevented
    || event.isComposing
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
  ) {
    return true;
  }

  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest([
    "input",
    "textarea",
    "select",
    "[contenteditable]:not([contenteditable='false'])",
    "[role='dialog']",
    "[role='listbox']",
    "[role='menu']",
    "[role='radiogroup']",
    "[role='slider']",
    "[role='tablist']",
  ].join(", "))) {
    return true;
  }

  // DS popovers, menus and modals exist in the DOM only while open.
  return document.querySelector("[role='dialog'], [role='menu'], [role='listbox']") !== null;
}


/** Start the artifact-first Artifact Server review application. */
export function ReviewApp() {
  const {openPalette} = usePalette();
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    setDraftPrincipal(session?.principal.id ?? null);
  }, [session]);
  const accessContextRef = useRef<AccessContext | null>(null);
  const bootstrapInFlightRef = useRef(false);
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [sessionState, setSessionState] = useState<
    "loading" | "ready" | "unauthenticated"
  >("loading");
  const [error, setError] = useState<Error | null>(null);
  const [locationHref, setLocationHref] = useState(readDocumentHref);
  // The retired projects list routes (and bare settings) replace themselves with the review queue.
  const {replaceWith, route} = useMemo(
    () => canonicalReviewRoute(parseReviewRoute(new URL(locationHref, window.location.origin))),
    [locationHref],
  );
  useLayoutEffect(() => {
    if (replaceWith !== null) window.history.replaceState(null, "", replaceWith);
  }, [replaceWith]);

  /**
   * Start the application, or renew an expired local-owner session. A renewal
   * keeps the current screen mounted: the reviewer's place, open panels, and
   * unsent text survive it.
   */
  const bootstrap = useCallback(async (mode: "renew" | "start" = "start"): Promise<void> => {
    if (bootstrapInFlightRef.current) return;
    bootstrapInFlightRef.current = true;
    if (mode === "start") setSessionState("loading");
    setError(null);
    try {
      const [loadedAccessContext, initialSession] = await Promise.all([
        api.accessContext(),
        api.session().then(
          (value) => ({kind: "authenticated" as const, value}),
          (cause: unknown) => ({cause, kind: "failed" as const}),
        ),
      ]);
      accessContextRef.current = loadedAccessContext;
      let loadedSession: Session;
      if (initialSession.kind === "authenticated") {
        loadedSession = initialSession.value;
      } else if (
        loadedAccessContext.accessMode === "local_owner"
        && initialSession.cause instanceof ApiError
        && initialSession.cause.status === 401
      ) {
        await api.localOwnerSession();
        loadedSession = await api.session();
      } else {
        throw initialSession.cause;
      }
      const loadedProjects = await api.projects();
      setSession(loadedSession);
      setProjects(loadedProjects);
      setSessionState("ready");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        setSession(null);
        setSessionState("unauthenticated");
      } else {
        setError(
          caught instanceof Error
            ? caught
            : new Error("Artifact Server could not start."),
        );
        setSessionState("ready");
      }
    } finally {
      bootstrapInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    void bootstrap();
    const expire = (): void => {
      // The first session probe 401s by design; bootstrap handles it (local-owner sign-in)
      // before the access mode is known, so an expiry during bootstrap is not a sign-out.
      if (bootstrapInFlightRef.current) return;
      if (accessContextRef.current?.accessMode === "local_owner") {
        void bootstrap("renew");
        return;
      }
      setSession(null);
      setSessionState("unauthenticated");
    };
    window.addEventListener("artifact-session-expired", expire);
    return () => window.removeEventListener("artifact-session-expired", expire);
  }, [bootstrap]);

  useEffect(() => {
    // Child effects rewrite the URL before this listener exists, so read it once on subscribe.
    const syncLocation = (): void => setLocationHref(readDocumentHref());
    syncLocation();
    window.addEventListener("popstate", syncLocation);
    window.addEventListener(REVIEW_LOCATION_EVENT, syncLocation);
    return () => {
      window.removeEventListener("popstate", syncLocation);
      window.removeEventListener(REVIEW_LOCATION_EVENT, syncLocation);
    };
  }, []);

  const createProject = useCallback(async (name: string): Promise<Project> => {
    const created = await api.createProject(name);
    setProjects((current) => [
      ...current.filter((project) => project.id !== created.id),
      created,
    ]);
    return created;
  }, []);
  const loadProjects = useCallback(async (): Promise<readonly Project[]> => {
    const loaded = await api.projects();
    setProjects(loaded);
    return loaded;
  }, []);

  if (sessionState === "loading") return <LoadingGate />;
  if (sessionState === "unauthenticated") {
    return <SignInGate returnTo={`${window.location.pathname}${window.location.search}`} />;
  }
  if (error !== null) {
    return <UnavailableGate message={error.message} onRetry={() => void bootstrap()} />;
  }
  if (session === null) return null;

  return (
    <ReviewShell
      mainStyle={route.kind === "workspace" || route.kind === "library" ? {overflow: "hidden"} : {overflowY: "auto"}}
      onCreateProject={createProject}
      onOpenPalette={openPalette}
      projects={projects}
      route={route}
      session={session}
    >
      {route.kind === "settings" ? (
        <SettingsScreen
          onProjectsChanged={loadProjects}
          projects={projects}
          route={route.settings}
          session={session}
        />
      ) : route.kind === "queue" ? (
        <ReviewQueueScreen projects={projects} />
      ) : route.kind === "library" ? (
        <DesignLibraryScreen projectId={route.projectId} projects={projects} />
      ) : (
        <ArtifactReview projects={projects} session={session} />
      )}
    </ReviewShell>
  );
}

function ArtifactReview({
  projects,
  session,
}: {
  readonly projects: readonly Project[];
  readonly session: Session;
}) {
  const [projectId, setProjectId] = useState(() => currentReviewLocation().projectId
    ?? projects.find((project) => project.archivedAt === null)?.id
    ?? projects[0]?.id
    ?? "");
  useEffect(() => {
    const followProject = (): void => {
      const named = currentReviewLocation().projectId;
      if (named !== null) setProjectId(named);
    };
    window.addEventListener("popstate", followProject);
    return () => window.removeEventListener("popstate", followProject);
  }, []);
  // A project switch mounts a fresh workspace: the catalog, its search and
  // filters, the open record, and comments all belong to one project.
  return <ProjectReview key={projectId} projectId={projectId} projects={projects} session={session} />;
}

function ProjectReview({
  projectId,
  projects,
  session,
}: {
  readonly projectId: string;
  readonly projects: readonly Project[];
  readonly session: Session;
}) {
  const initialLocation = useMemo(currentReviewLocation, []);
  const [items, setItems] = useState<ArtifactPage["artifacts"]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(
    initialLocation.artifactId,
  );
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    initialLocation.versionId,
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(
    initialLocation.path,
  );
  const [query, setQuery] = useState("");
  const searchQuery = useDeferredValue(query.trim());
  const [catalogCommentFilter, setCatalogCommentFilter] = useState<CatalogCommentFilter>("all");
  const [catalogTagFilters, setCatalogTagFilters] = useState<readonly string[]>([]);
  const [catalogKnownTags, setCatalogKnownTags] = useState<readonly string[]>([]);
  const [catalogSort, setCatalogSort] = useState<CatalogSort>("newest");
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<Error | null>(null);
  const [catalogRefreshState, setCatalogRefreshState] = useState<CatalogRefreshState>(
    "idle",
  );
  const [fetchedDetails, setDetails] = useState<ArtifactDetails | null>(null);
  const [fetchedVersions, setVersions] = useState<readonly VersionListItem[]>([]);
  // The record on screen is only ever the selected artifact's: while the next
  // artifact loads, the previous one's details and versions are not shown.
  const details = fetchedDetails?.artifact.id === selectedArtifactId ? fetchedDetails : null;
  const versions = details === null ? noVersions : fetchedVersions;
  const selectedArtifactRef = useRef(selectedArtifactId);
  selectedArtifactRef.current = selectedArtifactId;
  const [actions, setActions] = useState<readonly ArtifactAction[]>([]);
  const [actionNextCursor, setActionNextCursor] = useState<string | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<Error | null>(null);
  // Opening Activity loads it once per artifact; an empty or failed history is not re-requested.
  const [activityRequested, setActivityRequested] = useState(false);
  const [comparison, setComparison] = useState<ArtifactComparison | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState<Error | null>(null);
  const [comparisonView, setComparisonView] = useState<ComparisonTab | null>(null);
  const [fetchedVersion, setSelectedVersion] = useState<ArtifactVersion | null>(null);
  const selectedVersion = details !== null && fetchedVersion?.version.id === selectedVersionId
    ? fetchedVersion
    : null;
  const fetchedVersionRef = useRef(fetchedVersion);
  fetchedVersionRef.current = fetchedVersion;
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<Error | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("details");
  const [inspectorOpen, setInspectorOpen] = useState(readInitialInspectorOpen);
  const announce = useAnnounce();
  const viewportWidth = useViewportWidth();
  const phone = isPhoneWidth(viewportWidth);
  const viewportHeight = useViewportHeight();
  const inspectorPreference = usePanelPreference(inspectorPanelId);
  const docking = dockingFor(viewportWidth, inspectorOpen && inspectorPreference.pinned);
  const catalogPreference = usePanelPreference(catalogPanelId);
  const [catalogPeeking, setCatalogPeeking] = useState(false);
  const [catalogSheetOpen, setCatalogSheetOpen] = useState(false);
  const [catalogFiltersOpen, setCatalogFiltersOpen] = useState(false);
  const catalogDocked = docking.listDocked && catalogPreference.pinned && !phone;
  const {setPinned: setCatalogPinned} = catalogPreference;
  const toggleCatalog = useCallback((): void => {
    if (phone) {
      setCatalogSheetOpen((open) => !open);
      return;
    }
    if (catalogDocked) {
      setCatalogPinned(false);
      return;
    }
    if (docking.listDocked) {
      setCatalogPinned(true);
      setCatalogPeeking(false);
      return;
    }
    setCatalogPeeking((peeking) => !peeking);
  }, [catalogDocked, docking.listDocked, phone, setCatalogPinned]);
  const [opening, setOpening] = useState(false);
  const [focusMode, setFocusMode] = useState(initialLocation.view === "focus");
  const [focusCommentsOpen, setFocusCommentsOpen] = useState(false);
  const [focusControlsCollapsed, setFocusControlsCollapsed] = useState(false);
  const [htmlAnnotateModeActive, setHtmlAnnotateModeActive] = useState(true);
  const [htmlViewerMode, setHtmlViewerMode] = useState<"annotate" | "interactive">("annotate");
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const commentsToggleRef = useRef<HTMLSpanElement | null>(null);
  const restoreControlsRef = useRef<HTMLSpanElement | null>(null);
  useFocusContainment(workspaceRef, focusMode);
  const commentsInspectorRef = useRef<CommentsTabHandle | null>(null);
  const [previewModeTarget, setPreviewModeTarget] = useState<HTMLDivElement | null>(null);
  const catalogRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const catalogRequestGenerationRef = useRef(0);
  const followCommentVersion = useCallback((versionId: string): void => {
    setDetailError(null);
    setSelectedVersionId(versionId);
    setSelectedPath(null);
  }, []);
  const comments = useReviewComments({
    artifactId: selectedArtifactId,
    onVersionChanged: followCommentVersion,
    projectId,
    versionId: selectedVersionId,
  });
  useEffect(() => {
    if (details === null || details.artifact.tags.length === 0) return;
    setCatalogKnownTags((current) => [
      ...new Set([...current, ...details.artifact.tags]),
    ].toSorted());
  }, [details]);
  const openCommentCount = comments.threads.filter(
    (thread) => thread.state === "open",
  ).length;

  // Browser agent tools (WebMCP): the ref hands the adapter live view state
  // each render; registration itself lives entirely in webmcp.tsx.
  const webmcpRef = useRef<WebmcpBindings>({
    getSnapshot: () => webmcpSnapshot(),
    openArtifact: () => undefined,
    reloadComments: () => Promise.resolve(),
  });
  const webmcpSnapshot = (): ReturnType<WebmcpBindings["getSnapshot"]> => ({
    artifact: details === null ? null : {
      currentVersionId: details.artifact.currentVersionId,
      id: details.artifact.id,
      name: details.artifact.name,
    },
    loading: detailLoading || comments.loading
      || (selectedArtifactId !== null && selectedVersion === null),
    projectId,
    projectName: projects.find((project) => project.id === projectId)?.name ?? null,
    replies: comments.repliesByThread,
    threads: comments.threads,
    version: selectedVersion === null ? null : {
      createdAt: selectedVersion.version.createdAt,
      id: selectedVersion.version.id,
    },
  });
  webmcpRef.current = {
    getSnapshot: webmcpSnapshot,
    openArtifact: (artifactId, versionId) => {
      setDetailError(null);
      setSelectedArtifactId(artifactId);
      setSelectedVersionId(versionId);
      setSelectedPath(null);
    },
    reloadComments: comments.reload,
  };
  useWebmcp(webmcpRef);

  const selectedProject = projects.find((project) => project.id === projectId) ?? null;
  const catalogItems = useMemo<ArtifactPage["artifacts"]>(() => {
    if (
      details === null
      || searchQuery !== ""
      || catalogCommentFilter !== "all"
      || catalogTagFilters.length > 0
      || items.some(({artifact}) => artifact.id === details.artifact.id)
    ) return items;
    return [{
      artifact: details.artifact,
      commentCount: comments.threads.length,
      links: details.links,
      versionCount: versions.length,
    }, ...items];
  }, [
    catalogCommentFilter,
    catalogTagFilters.length,
    comments.threads.length,
    details,
    items,
    searchQuery,
    versions.length,
  ]);
  const catalogItemsRef = useRef(catalogItems);
  catalogItemsRef.current = catalogItems;
  const selectedIndex = catalogItems.findIndex(
    ({artifact}) => artifact.id === selectedArtifactId,
  );
  const selectedItem = selectedIndex < 0 ? null : catalogItems[selectedIndex] ?? null;
  const loadArtifacts = useCallback(async (
    cursor: string | null,
    replace: boolean,
  ): Promise<ArtifactListLoadResult> => {
    if (projectId === "") return "skipped";
    const requestGeneration = ++catalogRequestGenerationRef.current;
    setListLoading(true);
    setListError(null);
    try {
      const page = await api.artifacts(projectId, cursor, catalogTagFilters, searchQuery, {
        comments: catalogCommentFilter,
        sort: catalogSort,
      });
      if (requestGeneration !== catalogRequestGenerationRef.current) return "skipped";
      setCatalogKnownTags((current) => {
        const next = new Set(current);
        for (const {artifact} of page.artifacts) {
          for (const tag of artifact.tags) next.add(tag);
        }
        return [...next].toSorted();
      });
      setItems((current) => replace ? page.artifacts : [...current, ...page.artifacts]);
      setNextCursor(page.nextCursor);
      if (replace) {
        setSelectedArtifactId((current) => {
          return current ?? page.artifacts[0]?.artifact.id ?? null;
        });
      }
      return "loaded";
    } catch (caught) {
      if (requestGeneration === catalogRequestGenerationRef.current) {
        setListError(
          caught instanceof Error ? caught : new Error("Artifact list failed."),
        );
      }
      return "failed";
    } finally {
      if (requestGeneration === catalogRequestGenerationRef.current) {
        setListLoading(false);
      }
    }
  }, [catalogCommentFilter, catalogSort, catalogTagFilters, projectId, searchQuery]);

  const refreshArtifacts = useCallback(async (): Promise<void> => {
    if (listLoading) return;
    if (catalogRefreshTimerRef.current !== null) {
      clearTimeout(catalogRefreshTimerRef.current);
      catalogRefreshTimerRef.current = null;
    }
    setCatalogRefreshState("loading");
    announce("Refreshing artifact catalog.");
    const result = await loadArtifacts(null, true);
    if (result !== "loaded") {
      setCatalogRefreshState("idle");
      return;
    }
    setCatalogRefreshState("complete");
    announce("Artifact catalog refreshed.");
    catalogRefreshTimerRef.current = setTimeout(() => {
      catalogRefreshTimerRef.current = null;
      setCatalogRefreshState("idle");
    }, catalogRefreshConfirmationMilliseconds);
  }, [announce, listLoading, loadArtifacts]);

  useEffect(() => () => {
    if (catalogRefreshTimerRef.current !== null) {
      clearTimeout(catalogRefreshTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (catalogRefreshTimerRef.current !== null) {
      clearTimeout(catalogRefreshTimerRef.current);
      catalogRefreshTimerRef.current = null;
    }
    setCatalogRefreshState("idle");
    setItems([]);
    void loadArtifacts(null, true);
  }, [loadArtifacts]);

  useEffect(() => {
    setComparisonView(null);
    if (selectedArtifactId === null || projectId === "") {
      setDetails(null);
      setVersions([]);
      setActions([]);
      setActionNextCursor(null);
      setComparison(null);
      setSelectedVersion(null);
      return undefined;
    }
    let current = true;
    setActions([]);
    setActionNextCursor(null);
    setActivityRequested(false);
    setActivityError(null);
    setComparison(null);
    setDetailLoading(true);
    setDetailError(null);
    void (async () => {
      try {
        const [loadedDetails, loadedVersions] = await Promise.all([
          api.artifact(projectId, selectedArtifactId),
          api.versions(projectId, selectedArtifactId),
        ]);
        if (!current) return;
        setDetails(loadedDetails);
        setVersions(loadedVersions);
        setSelectedVersionId((selected) => {
          return selected ?? loadedDetails.current.version.id;
        });
      } catch (caught) {
        if (!current) return;
        setDetails(null);
        setVersions([]);
        setSelectedVersion(null);
        setDetailError(
          caught instanceof Error ? caught : new Error("Artifact details failed."),
        );
      } finally {
        if (current) setDetailLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [projectId, selectedArtifactId]);

  const refreshLinkedDetails = useCallback(async (): Promise<void> => {
    if (selectedArtifactId === null || projectId === "") return;
    try {
      const refreshed = await api.artifact(projectId, selectedArtifactId);
      if (selectedArtifactRef.current === selectedArtifactId) setDetails(refreshed);
    } catch {
      // Ambient freshness never replaces the last readable artifact state.
    }
  }, [projectId, selectedArtifactId]);

  useCommentPoll(
    refreshLinkedDetails,
    session.capabilities.linkedArtifacts && details?.sourceBinding !== undefined,
  );

  const loadActions = useCallback(async (cursor: string | null): Promise<void> => {
    if (selectedArtifactId === null || projectId === "") return;
    const artifactId = selectedArtifactId;
    setActivityLoading(true);
    setActivityError(null);
    try {
      const page = await api.actions(projectId, artifactId, cursor);
      if (selectedArtifactRef.current !== artifactId) return;
      setActions((current) => cursor === null ? page.actions : [...current, ...page.actions]);
      setActionNextCursor(page.nextCursor);
    } catch (caught) {
      if (selectedArtifactRef.current !== artifactId) return;
      setActivityError(caught instanceof Error ? caught : new Error("Activity loading failed."));
    } finally {
      setActivityLoading(false);
    }
  }, [projectId, selectedArtifactId]);

  useEffect(() => {
    if (comparisonView === "activity" && !activityRequested) {
      setActivityRequested(true);
      void loadActions(null);
    }
  }, [activityRequested, comparisonView, loadActions]);

  // Versions are immutable, so a refreshed record (the linked-source poll, a
  // tag or access edit) keeps the version on screen; only a different version
  // or a new current version re-resolves it.
  const recordLoaded = details !== null;
  const recordCurrent = details?.current ?? null;
  const recordCurrentRef = useRef(recordCurrent);
  recordCurrentRef.current = recordCurrent;
  const recordCurrentVersionId = recordCurrent?.version.id ?? null;
  useEffect(() => {
    if (
      !recordLoaded
      || selectedArtifactId === null
      || selectedVersionId === null
    ) {
      setSelectedVersion(null);
      return undefined;
    }
    const currentVersion = recordCurrentRef.current;
    if (currentVersion !== null && selectedVersionId === currentVersion.version.id) {
      setSelectedVersion(currentVersion);
      return undefined;
    }
    if (fetchedVersionRef.current?.version.id === selectedVersionId) return undefined;
    let current = true;
    setSelectedVersion(null);
    void (async () => {
      try {
        const loaded = await api.version(
          projectId,
          selectedArtifactId,
          selectedVersionId,
        );
        if (current) setSelectedVersion(loaded);
      } catch (caught) {
        if (!current) return;
        setDetailError(
          caught instanceof Error ? caught : new Error("Version loading failed."),
        );
      }
    })();
    return () => {
      current = false;
    };
  }, [projectId, recordCurrentVersionId, recordLoaded, selectedArtifactId, selectedVersionId]);

  useEffect(() => {
    const href = workspaceHref({
      artifactId: selectedArtifactId,
      path: selectedPath,
      projectId,
      versionId: selectedVersionId,
      view: focusMode ? "focus" : null,
    });
    writeReviewHistory(href, "replace");
    writeStored("session", REVIEW_RETURN_URL_KEY, href);
  }, [focusMode, projectId, selectedArtifactId, selectedPath, selectedVersionId]);

  useEffect(() => {
    // Back, forward, and in-place links within this project. Another project
    // remounts the workspace instead (see ArtifactReview), so the catalog,
    // search, and filters are kept here. The project's own link names no
    // artifact and opens its first one.
    const restoreLocation = (): void => {
      const restored = currentReviewLocation();
      if (restored.projectId !== null && restored.projectId !== projectId) return;
      const first = restored.artifactId === null ? catalogItemsRef.current[0]?.artifact ?? null : null;
      setDetailError(null);
      setSelectedArtifactId(restored.artifactId ?? first?.id ?? null);
      setSelectedVersionId(restored.versionId ?? first?.currentVersionId ?? null);
      setSelectedPath(restored.path);
      setFocusMode(restored.view === "focus");
    };
    window.addEventListener("popstate", restoreLocation);
    return () => window.removeEventListener("popstate", restoreLocation);
  }, [projectId]);

  const openRawArtifact = async (): Promise<void> => {
    if (selectedArtifactId === null || selectedVersionId === null) return;
    const popup = window.open("about:blank", "_blank");
    setOpening(true);
    setDetailError(null);
    try {
      const issued = await api.contentSession(
        projectId,
        selectedArtifactId,
        selectedVersionId,
      );
      if (popup === null) {
        window.location.assign(issued.bootstrapUrl);
      } else {
        popup.opener = null;
        popup.location.replace(issued.bootstrapUrl);
      }
    } catch (caught) {
      popup?.close();
      setDetailError(
        caught instanceof Error ? caught : new Error("Artifact opening failed."),
      );
    } finally {
      setOpening(false);
    }
  };

  const canComment = selectedProject?.archivedAt === null
    && (
      (
        session.principal.kind === "human"
        && session.principal.authorizedByPrincipalId === null
      )
      || session.principal.capabilities.includes("comment:write")
    );
  const canManageArtifacts = selectedProject?.archivedAt === null && (
    (
      session.principal.kind === "human"
      && session.principal.authorizedByPrincipalId === null
    )
    || session.principal.capabilities.includes("artifact:manage:any")
  );
  const canDeleteAnyComment = (
    session.principal.kind === "human"
    && session.principal.authorizedByPrincipalId === null
    && session.principal.membershipRole === "administrator"
  ) || session.principal.capabilities.includes("artifact:manage:any");
  const previewKind = reviewPreviewKind(selectedVersion, selectedPath);
  const galleryCanvas = useDesignGalleryCanvas({
    announce,
    artifactId: selectedArtifactId,
    focusMode,
    onNavigate: (path) => selectManifestPath(path),
    phone,
    projectId,
    selectedPath,
    version: selectedVersion,
  });
  const download = reviewDownload(
    projectId,
    selectedArtifactId,
    selectedVersion,
  );
  const selectArtifact = useCallback((artifactId: string, versionId?: string): void => {
    setDetailError(null);
    setSelectedArtifactId(artifactId);
    setSelectedVersionId(versionId ?? null);
    setSelectedPath(null);
  }, []);
  /** Exact-page navigation; null returns to the version's entry (its gallery, when it has one). */
  const selectManifestPath = (path: string | null): void => {
    writeReviewHistory(workspaceHref({
      artifactId: selectedArtifactId,
      path,
      projectId,
      versionId: selectedVersionId,
      view: focusMode ? "focus" : null,
    }), "push");
    setSelectedPath(path);
  };
  const changeTags = async (tags: readonly string[]): Promise<void> => {
    if (details === null) return;
    const changed = await api.changeTags(
      details.artifact.projectId,
      details.artifact.id,
      details.artifact.currentVersionId,
      tags,
      crypto.randomUUID(),
    );
    updateArtifact(changed.artifact);
  };
  const updateArtifact = (artifact: ArtifactDetails["artifact"]): void => {
    setCatalogKnownTags((current) => [...new Set([...current, ...artifact.tags])].toSorted());
    setDetails((current) => current?.artifact.id === artifact.id
      ? {...current, artifact}
      : current);
    setItems((current) => current.map((item) => item.artifact.id === artifact.id
      ? {...item, artifact}
      : item));
  };
  /** Show a record re-read after a mutation, unless the reviewer has moved to another artifact since. */
  const showReloadedRecord = (
    reloaded: ArtifactDetails,
    reloadedVersions: readonly VersionListItem[],
  ): boolean => {
    if (selectedArtifactRef.current !== reloaded.artifact.id) return false;
    setDetails(reloaded);
    setVersions(reloadedVersions);
    return true;
  };
  const makeVersionCurrent = async (
    versionId: string,
    expectedCurrentVersionId: string,
  ): Promise<boolean> => {
    if (details === null) return false;
    setDetailError(null);
    try {
      const restored = await api.restore(
        details.artifact.projectId,
        details.artifact.id,
        expectedCurrentVersionId,
        versionId,
        crypto.randomUUID(),
      );
      updateArtifact(restored.artifact);
      const [loadedDetails, loadedVersions] = await Promise.all([
        api.artifact(details.artifact.projectId, details.artifact.id),
        api.versions(details.artifact.projectId, details.artifact.id),
      ]);
      showReloadedRecord(loadedDetails, loadedVersions);
      return true;
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        try {
          const [loadedDetails, loadedVersions] = await Promise.all([
            api.artifact(details.artifact.projectId, details.artifact.id),
            api.versions(details.artifact.projectId, details.artifact.id),
          ]);
          showReloadedRecord(loadedDetails, loadedVersions);
          updateArtifact(loadedDetails.artifact);
        } catch {
          // Keep the original conflict visible when refreshing pointer state fails.
        }
        setDetailError(new Error(
          "The current version changed before this action completed. Nothing was changed; the latest version state has been reloaded.",
        ));
        return false;
      }
      setDetailError(
        caught instanceof Error ? caught : new Error("The version could not be made current."),
      );
      return false;
    }
  };
  const compareVersions = async (fromVersionId: string, toVersionId: string): Promise<void> => {
    if (details === null || fromVersionId === toVersionId) return;
    setComparisonLoading(true);
    setComparisonError(null);
    try {
      setComparison(await api.comparison(
        details.artifact.projectId,
        details.artifact.id,
        fromVersionId,
        toVersionId,
      ));
    } catch (caught) {
      setComparisonError(caught instanceof Error ? caught : new Error("Version comparison failed."));
    } finally {
      setComparisonLoading(false);
    }
  };
  const captureLinkedArtifact = async (): Promise<void> => {
    if (details === null) return;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const captured = await api.captureArtifact(
        details.artifact.projectId,
        details.artifact.id,
        details.artifact.currentVersionId,
        crypto.randomUUID(),
      );
      const [loadedDetails, loadedVersions] = await Promise.all([
        api.artifact(details.artifact.projectId, details.artifact.id),
        api.versions(details.artifact.projectId, details.artifact.id),
      ]);
      if (showReloadedRecord(loadedDetails, loadedVersions)) setSelectedVersionId(captured.version.id);
      updateArtifact(loadedDetails.artifact);
    } catch (caught) {
      setDetailError(caught instanceof Error ? caught : new Error("Linked artifact capture failed."));
    } finally {
      setDetailLoading(false);
    }
  };
  const openLinkedArtifact = async (): Promise<void> => {
    if (details === null) return;
    const popup = window.open("about:blank", "_blank");
    setDetailError(null);
    try {
      const issued = await api.liveSession(details.artifact.projectId, details.artifact.id);
      if (popup === null) window.location.assign(issued.bootstrapUrl);
      else {
        popup.opener = null;
        popup.location.replace(issued.bootstrapUrl);
      }
    } catch (caught) {
      popup?.close();
      setDetailError(caught instanceof Error ? caught : new Error("Live artifact opening failed."));
    }
  };
  const tombstoneArtifact = async (): Promise<boolean> => {
    if (details === null) return false;
    setDetailError(null);
    try {
      await api.deleteArtifact(
        details.artifact.projectId,
        details.artifact.id,
        details.artifact.currentVersionId,
        crypto.randomUUID(),
      );
      setItems((current) => current.filter(({artifact}) => artifact.id !== details.artifact.id));
      setSelectedArtifactId(null);
      setSelectedVersionId(null);
      setSelectedPath(null);
      setDetails(null);
      setVersions([]);
      void loadArtifacts(null, true);
      return true;
    } catch (caught) {
      setDetailError(caught instanceof Error ? caught : new Error("Artifact deletion failed."));
      return false;
    }
  };
  const enterFocusMode = useCallback((): void => {
    writeReviewHistory(workspaceHref({
      artifactId: selectedArtifactId,
      path: selectedPath,
      projectId,
      versionId: selectedVersionId,
      view: "focus",
    }), "push");
    setFocusCommentsOpen(false);
    setFocusControlsCollapsed(false);
    setFocusMode(true);
  }, [projectId, selectedArtifactId, selectedPath, selectedVersionId]);
  const exitFocusMode = useCallback((): void => {
    writeReviewHistory(workspaceHref({
      artifactId: selectedArtifactId,
      path: selectedPath,
      projectId,
      versionId: selectedVersionId,
      view: null,
    }), "push");
    setFocusCommentsOpen(false);
    setFocusControlsCollapsed(false);
    setFocusMode(false);
  }, [projectId, selectedArtifactId, selectedPath, selectedVersionId]);
  const {setChromeHidden, setNavExpandable} = useShellLayout();
  useEffect(() => {
    setNavExpandable(docking.navExpandable && !focusMode);
    // Other screens have no catalog or inspector competing for the width.
    return () => setNavExpandable(true);
  }, [docking.navExpandable, focusMode, setNavExpandable]);
  useEffect(() => {
    // Full screen is a fixed layer inside the shell; the nav beneath it must not take focus.
    setChromeHidden(focusMode);
    return () => setChromeHidden(false);
  }, [focusMode, setChromeHidden]);
  useEffect(() => {
    const handleReviewShortcut = (event: KeyboardEvent): void => {
      if (reviewShortcutBlocked(event)) return;

      const key = event.key.toLowerCase();
      if (key === "escape") {
        const dismissed = dismissInnermost([
          {close: () => setCatalogFiltersOpen(false), open: catalogFiltersOpen},
          {
            close: () => {
              setCatalogPeeking(false);
              setCatalogSheetOpen(false);
            },
            open: catalogPeeking || catalogSheetOpen,
          },
          {
            close: () => setInspectorOpen(false),
            open: inspectorOpen && !docking.inspectorDocked && !focusMode,
          },
          {close: () => setFocusCommentsOpen(false), open: focusCommentsOpen},
          {close: () => setComparisonView(null), open: comparisonView !== null},
          {
            close: () => setHtmlAnnotateModeActive(false),
            open: htmlViewerMode === "annotate" && htmlAnnotateModeActive,
          },
          {close: exitFocusMode, open: focusMode},
        ]);
        if (dismissed) event.preventDefault();
        return;
      }
      if (catalogFiltersOpen) return;

      if (key === "f" && selectedVersionId !== null) {
        event.preventDefault();
        if (focusMode) exitFocusMode();
        else enterFocusMode();
        return;
      }

      if (key === "]") {
        event.preventDefault();
        if (focusMode) setFocusCommentsOpen((current) => !current);
        else setInspectorOpen((current) => !current);
        return;
      }

      if (key === "[" && !focusMode) {
        event.preventDefault();
        toggleCatalog();
        return;
      }

      const direction = key === "j" || key === "arrowdown"
        ? 1
        : key === "k" || key === "arrowup"
          ? -1
          : 0;
      if (direction === 0) return;

      event.preventDefault();
      const next = catalogItems[selectedIndex + direction];
      if (next !== undefined) {
        selectArtifact(next.artifact.id, next.artifact.currentVersionId);
      }
    };

    window.addEventListener("keydown", handleReviewShortcut);
    return () => window.removeEventListener("keydown", handleReviewShortcut);
  }, [
    catalogFiltersOpen,
    catalogItems,
    comparisonView,
    docking.inspectorDocked,
    catalogPeeking,
    catalogSheetOpen,
    enterFocusMode,
    exitFocusMode,
    focusCommentsOpen,
    focusMode,
    htmlAnnotateModeActive,
    htmlViewerMode,
    selectArtifact,
    selectedIndex,
    selectedVersionId,
    toggleCatalog,
  ]);
  const hideFocusControls = (): void => {
    setFocusControlsCollapsed(true);
    window.requestAnimationFrame(() => {
      restoreControlsRef.current?.querySelector("button")?.focus({preventScroll: true});
    });
  };
  const showFocusControls = useCallback((): void => {
    setFocusControlsCollapsed(false);
    window.requestAnimationFrame(() => {
      commentsToggleRef.current?.querySelector("button")?.focus({preventScroll: true});
    });
  }, []);
  useEffect(() => {
    if (!focusMode) return undefined;
    const revealFocusControls = (event: KeyboardEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      const isShortcut = (event.metaKey || event.ctrlKey)
        && !event.altKey
        && !event.shiftKey
        && (event.code === "Backslash" || event.key === "\\");
      if (
        !isShortcut
        || event.defaultPrevented
        || event.isComposing
        || target?.closest('[role="dialog"]')
      ) {
        return;
      }
      event.preventDefault();
      showFocusControls();
    };
    window.addEventListener("keydown", revealFocusControls);
    return () => window.removeEventListener("keydown", revealFocusControls);
  }, [focusMode, showFocusControls]);

  const selectAnnotation = (threadId: string | null): void => {
    comments.selectThread(threadId);
    if (threadId === null) return;
    setInspectorTab("comments");
    if (focusMode) {
      setFocusCommentsOpen(true);
    } else {
      setInspectorOpen(true);
    }
  };
  const submitAnnotation = async (
    body: string,
    anchor: ReviewAnchor | null,
    path: string,
  ): Promise<boolean> => {
    const saved = await comments.submit(body, anchor, path);
    if (!saved && selectedArtifactId !== null && selectedVersionId !== null) {
      // The in-frame composer discards its text on failure; keep
      // it as this version's new-thread draft instead.
      writeDraft({
        artifactId: selectedArtifactId,
        principalId: session.principal.id,
        threadId: null,
        versionId: selectedVersionId,
      }, body);
    }
    if (saved) {
      setInspectorTab("comments");
      if (!focusMode) setInspectorOpen(true);
    }
    return saved;
  };
  const previousArtifact = selectedIndex <= 0 ? null : (): void => {
    const previous = catalogItems[selectedIndex - 1];
    if (previous !== undefined) selectArtifact(previous.artifact.id, previous.artifact.currentVersionId);
  };
  const nextArtifact = selectedIndex < 0 || selectedIndex >= catalogItems.length - 1 ? null : (): void => {
    const next = catalogItems[selectedIndex + 1];
    if (next !== undefined) selectArtifact(next.artifact.id, next.artifact.currentVersionId);
  };

  const changeAccess = async (next: AccessSetting): Promise<void> => {
    if (details === null) return;
    const changed = await changeArtifactAccess(details, next);
    updateArtifact(changed.artifact);
    announce(changed.notice);
  };
  const selectInspectorTab = (id: string): void => {
    const tab = inspectorTabs.find((candidate) => candidate === id);
    if (tab === undefined) return;
    if (inspectorOpen && inspectorTab === tab) {
      setInspectorOpen(false);
      return;
    }
    setInspectorTab(tab);
    setInspectorOpen(true);
  };
  const inspectorItems: readonly InspectorRailItem[] = [
    {count: openCommentCount, countTone: "primary", icon: "bi-chat-square-text", id: "comments", label: "Comments"},
    {count: null, countTone: "neutral", icon: "bi-info-circle", id: "details", label: "Details"},
    {count: selectedVersion?.manifest.entries.length ?? 0, countTone: "neutral", icon: "bi-folder2", id: "files", label: "Files"},
    {count: versions.length, countTone: "neutral", icon: "bi-layers", id: "versions", label: "Versions"},
  ];

  const projectEmpty = selectedProject !== null
    && !listLoading
    && listError === null
    && catalogItems.length === 0
    && query === ""
    && catalogCommentFilter === "all"
    && catalogTagFilters.length === 0;
  const annotateToggle = {
    active: htmlAnnotateModeActive,
    available: previewKind === "html" && galleryCanvas.gallery === null && canComment && htmlViewerMode === "annotate",
    onToggle: () => setHtmlAnnotateModeActive((active) => !active),
  };
  const comparisonOpen = comparisonView !== null && details !== null;
  const sharePopover = (placement: "focus" | "toolbar") => (
    <SharePopover
      details={details}
      key={`${placement}-share-${details?.artifact.id ?? "empty"}`}
      onArtifactChanged={updateArtifact}
      selectedPath={selectedPath}
      selectedVersion={selectedVersion}
    />
  );
  const commentsTab = (
    <>
      <div ref={setPreviewModeTarget} />
      <CommentsTab
        canComment={canComment}
        canDeleteAny={canDeleteAnyComment}
        handleRef={commentsInspectorRef}
        principalId={session.principal.id}
        session={comments}
        versionId={selectedVersionId}
      />
    </>
  );
  const inspectorBody = details === null || selectedVersion === null ? (
    <SurfaceState
      count={0}
      emptyBody="Select an artifact to inspect its immutable record."
      emptyTitle="Nothing selected"
      noun="artifacts"
      phase="ready"
    />
  ) : inspectorTab === "details" ? (
    <DetailsTab
      canManage={canManageArtifacts}
      details={details}
      linkedArtifacts={session.capabilities.linkedArtifacts}
      onAccessChange={changeAccess}
      onCapture={captureLinkedArtifact}
      onOpenLive={openLinkedArtifact}
      onTagsChange={changeTags}
      version={selectedVersion}
    />
  ) : inspectorTab === "comments" ? (
    commentsTab
  ) : inspectorTab === "files" ? (
    <FilesTab
      onSelect={selectManifestPath}
      selectedPath={selectedPath ?? selectedVersion.manifest.entryPath}
      version={selectedVersion}
    />
  ) : (
    <VersionsTab
      canManage={canManageArtifacts}
      currentVersionId={details.artifact.currentVersionId}
      onMakeCurrent={makeVersionCurrent}
      onOpenComparison={() => setComparisonView("compare")}
      onSelect={(versionId) => {
        setDetailError(null);
        setSelectedVersionId(versionId);
        setSelectedPath(null);
      }}
      selectedVersionId={selectedVersionId}
      versions={versions}
    />
  );

  return (
    <div ref={workspaceRef} style={focusMode ? focusLayerStyle : workspaceStyle}>
      {focusMode || (phone && !catalogSheetOpen) ? null : (
        <aside aria-label="Artifact catalog" style={catalogLandmarkStyle}>
          <ArtifactListPanel
            canPin={docking.listDocked}
            commentFilter={catalogCommentFilter}
            filtersOpen={catalogFiltersOpen}
            items={catalogItems}
            knownTags={catalogKnownTags}
            listError={listError}
            listLoading={listLoading}
            nextCursor={nextCursor}
            onAnnounce={announce}
            onCommentFilterChange={setCatalogCommentFilter}
            onFiltersOpenChange={setCatalogFiltersOpen}
            onLoadMore={() => void loadArtifacts(nextCursor, false)}
            onPeekChange={setCatalogPeeking}
            onPinChange={(pinned) => {
              setCatalogPinned(pinned);
              setCatalogPeeking(false);
            }}
            onQueryChange={setQuery}
            onRefresh={() => void refreshArtifacts()}
            onSelect={(artifactId, versionId) => {
              setCatalogSheetOpen(false);
              selectArtifact(artifactId, versionId);
            }}
            onSheetClose={() => setCatalogSheetOpen(false)}
            onSortChange={setCatalogSort}
            onTagFiltersChange={setCatalogTagFilters}
            onWidthChange={catalogPreference.setWidth}
            peeking={catalogPeeking}
            pinned={catalogPreference.pinned}
            projectName={selectedProject?.name ?? "this project"}
            query={query}
            refreshState={catalogRefreshState}
            selectedArtifactId={selectedArtifactId}
            selectedCommentCount={comments.loading ? null : comments.threads.length}
            settingsHref={selectedProject === null ? null : projectSettingsHref(selectedProject.id)}
            sheet={phone}
            sort={catalogSort}
            tagFilters={catalogTagFilters}
            width={catalogPreference.width ?? catalogWidth.defaultWidth}
          />
        </aside>
      )}
      <div style={workspaceColumnStyle}>
        {focusMode ? null : (
          <ReviewToolbar
            annotate={annotateToggle}
            artifactName={details?.artifact.name ?? selectedItem?.artifact.name ?? "Artifact Server"}
            canManage={canManageArtifacts}
            details={details}
            download={download}
            linkedArtifacts={session.capabilities.linkedArtifacts}
            onCapture={captureLinkedArtifact}
            onDelete={tombstoneArtifact}
            onEnterFocus={enterFocusMode}
            onOpenCatalog={toggleCatalog}
            onOpenComments={() => {
              setInspectorTab("comments");
              setInspectorOpen(true);
            }}
            onOpenComparison={() => setComparisonView("compare")}
            onOpenLive={openLinkedArtifact}
            onOpenRawArtifact={() => void openRawArtifact()}
            onReturnToGallery={galleryCanvas.onReturnToGallery}
            onSelectPath={selectManifestPath}
            onSelectVersion={(versionId) => {
              setDetailError(null);
              setSelectedVersionId(versionId);
              setSelectedPath(null);
            }}
            opening={opening}
            phone={phone}
            projectName={selectedProject?.name ?? "project"}
            selectedPath={selectedPath}
            selectedVersion={selectedVersion}
            share={sharePopover("toolbar")}
            versions={versions}
          />
        )}
        <div style={canvasRowStyle}>
          <div style={canvasColumnStyle}>
            {!comparisonOpen || details === null || comparisonView === null ? null : (
              <ComparisonView
                actions={actions}
                activityError={activityError}
                activityLoading={activityLoading}
                activityNextCursor={actionNextCursor}
                artifactName={details.artifact.name}
                comparison={comparison}
                comparisonError={comparisonError}
                comparisonLoading={comparisonLoading}
                currentVersionId={details.artifact.currentVersionId}
                key={details.artifact.id}
                onBack={() => setComparisonView(null)}
                onCompare={compareVersions}
                onLoadMoreActivity={() => void loadActions(actionNextCursor)}
                onTabChange={setComparisonView}
                tab={comparisonView}
                versions={versions}
              />
            )}
            <div style={{...canvasSlotStyle, display: comparisonOpen ? "none" : "flex"}}>
              <PreviewCanvas
                accessSetting={details?.artifact.accessSetting ?? "account_required"}
                annotateModeActive={htmlAnnotateModeActive}
                annotations={comments.annotations}
                artifactId={selectedArtifactId}
                artifactName={details?.artifact.name ?? selectedItem?.artifact.name ?? "Artifact"}
                chrome={focusMode ? "focus" : "workspace"}
                commentsLoading={comments.loading}
                detailError={detailError}
                detailLoading={detailLoading}
                emptyProject={projectEmpty && selectedProject !== null ? <EmptyProjectCanvas project={selectedProject} /> : null}
                gallery={galleryCanvas.gallery}
                galleryNotice={galleryCanvas.galleryNotice}
                hasDetails={details !== null}
                isCurrentVersion={selectedVersion?.version.id === details?.artifact.currentVersionId}
                modeControlsTarget={previewModeTarget}
                onAnnotateModeChange={setHtmlAnnotateModeActive}
                onNextArtifact={nextArtifact}
                onOpenRawArtifact={() => void openRawArtifact()}
                onPreviousArtifact={previousArtifact}
                onReload={() => void (commentsInspectorRef.current?.reload() ?? comments.reload())}
                onSelectAnnotation={selectAnnotation}
                onSubmitAnnotation={submitAnnotation}
                onUnanchoredChange={comments.updateUnanchored}
                onViewModeChange={setHtmlViewerMode}
                opening={opening}
                position={{index: selectedIndex, total: catalogItems.length}}
                projectId={projectId}
                readOnly={!canComment}
                selectedPath={selectedPath}
                selectedThreadId={comments.selectedThreadId}
                version={selectedVersion}
              />
            </div>
          </div>
          {focusMode ? null : (
            <InspectorPanel
              active={inspectorTab}
              canPin={!phone && viewportWidth >= workspaceBudget.inspector}
              items={inspectorItems}
              onAnnounce={announce}
              onClose={() => setInspectorOpen(false)}
              onPinChange={inspectorPreference.setPinned}
              onSelect={selectInspectorTab}
              onWidthChange={inspectorPreference.setWidth}
              open={inspectorOpen}
              pinned={inspectorPreference.pinned}
              railLabels={viewportHeight >= 680}
              sheet={phone}
              subtitle={details === null || selectedVersion === null
                ? null
                : `${details.artifact.name} · v${selectedVersion.version.number}`}
              title={inspectorTitles[inspectorTab]}
              titleCount={inspectorTab === "comments" && openCommentCount > 0 ? openCommentCount : null}
              width={inspectorPreference.width ?? inspectorDefaultWidth(inspectorTab)}
            >
              {inspectorBody}
            </InspectorPanel>
          )}
          {focusMode && focusCommentsOpen ? (
            <FocusComments commentCount={openCommentCount} onClose={() => setFocusCommentsOpen(false)}>
              {commentsTab}
            </FocusComments>
          ) : null}
          {focusMode ? (
            <FocusViewerControls
              annotate={annotateToggle}
              collapsed={focusControlsCollapsed}
              commentCount={openCommentCount}
              commentsOpen={focusCommentsOpen}
              commentsToggleRef={commentsToggleRef}
              download={download}
              onExit={exitFocusMode}
              onHide={hideFocusControls}
              onReturnToGallery={galleryCanvas.onReturnToGallery}
              onShow={showFocusControls}
              onToggleComments={() => setFocusCommentsOpen((open) => !open)}
              restoreRef={restoreControlsRef}
              share={sharePopover("focus")}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function reviewDownload(
  projectId: string,
  artifactId: string | null,
  version: ArtifactVersion | null,
): ReviewDownload | null {
  if (artifactId === null || version === null) return null;
  const entries = version.manifest.entries;
  const onlyEntry = entries.length === 1 ? entries[0] : undefined;
  if (onlyEntry !== undefined) {
    return {
      href: api.versionFileUrl(
        projectId,
        artifactId,
        version.version.id,
        onlyEntry.path,
      ),
      title: `Download ${onlyEntry.path}`,
    };
  }
  return {
    href: api.versionArchiveUrl(projectId, artifactId, version.version.id),
    title: `Download ${entries.length} files as a ZIP`,
  };
}

function readInitialInspectorOpen(): boolean {
  return window.matchMedia("(min-width: 1640px)").matches;
}

function currentReviewLocation(): ReviewLocation {
  return readReviewLocation(new URLSearchParams(window.location.search));
}

function readDocumentHref(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function reviewPreviewKind(
  version: ArtifactVersion | null,
  selectedPath: string | null,
): "html" | "media" | "other" {
  if (version === null) return "other";
  const path = selectedPath ?? version.manifest.entryPath;
  const mediaType = mediaTypeEssence(version.manifest.entries.find((entry) => entry.path === path)?.mediaType ?? "");
  if (mediaType === "text/html") return "html";
  if (mediaType.startsWith("image/") || mediaType.startsWith("video/")) {
    return "media";
  }
  return "other";
}
