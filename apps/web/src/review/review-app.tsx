import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {setDraftPrincipal, writeDraft} from "@/components/comments/comment-drafts";
import {
  type AccessContext,
  type AccessSetting,
  api,
  ApiError,
  type ArtifactDetails,
  type ArtifactPage,
  type ArtifactVersion,
  type Project,
  type Session,
} from "@/api/client";
import type {ReviewAnchor} from "@/review-frame/protocol";
import {usePalette} from "@/shell/command-palette";
import {canManageProjects} from "@/shell/nav-model";
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
import {useArtifactCatalog} from "./workspace/use-artifact-catalog.ts";
import {useArtifactActivity, useVersionComparison} from "./workspace/use-artifact-history.ts";
import {useArtifactRecord} from "./workspace/use-artifact-record.ts";
import {useViewportHeight, useViewportWidth} from "./workspace/use-viewport-size.ts";
import {catalogWidth, dockingFor, inspectorDefaultWidth, isPhoneWidth, workspaceBudget} from "./workspace/workspace-layout.ts";
import {
  type ComparisonTab,
  type InspectorTab,
  inspectorTabs,
  type ReviewDownload,
} from "./workspace/workspace-types.ts";
import {useShellLayout} from "@/shell/shell-layout-context";
import {LoadingGate, SignInGate, UnavailableGate} from "@/shell/gates";
import {useReviewComments} from "./review-comments.tsx";
import {
  parseReviewRoute,
  projectsHref,
  readReviewLocation,
  REVIEW_LOCATION_EVENT,
  REVIEW_RETURN_URL_KEY,
  type ReviewLocation,
  workspaceHref,
  writeReviewHistory,
} from "./review-routes.ts";
import {EmptyProjectCanvas} from "./settings/empty-project.tsx";
import {DesignLibraryScreen} from "./library/design-library-screen.tsx";
import {ActivityScreen} from "./activity/activity-screen.tsx";
import {SettingsScreen} from "./settings/settings-screen.tsx";
import {canonicalReviewRoute} from "./settings/settings-view.ts";
import {useWebmcp, type WebmcpBindings} from "./webmcp.tsx";
import {writeStored} from "@/lib/safe-storage";
import {ProjectSettings} from "./settings/project-settings.tsx";

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

/** A startup that has not answered by then shows the unavailable state and its Try again. */
const startupDeadlineMilliseconds = 20_000;

interface Startup {
  readonly accessContext: AccessContext;
  readonly projects: readonly Project[];
  readonly session: Session;
}

type Settled<T> =
  | {readonly kind: "failed"; readonly cause: unknown}
  | {readonly kind: "ok"; readonly value: T};

function settle<T>(work: Promise<T>): Promise<Settled<T>> {
  return work.then(
    (value) => ({kind: "ok", value}),
    (cause: unknown) => ({cause, kind: "failed"}),
  );
}

/**
 * Read what every screen needs. A signed-in start is one round trip: the
 * project list is read beside the session probe rather than after it. A
 * local-owner start signs in, then reads both together.
 */
async function loadStartup(): Promise<Startup> {
  const [accessContext, session, projects] = await Promise.all([
    api.accessContext(),
    settle(api.session()),
    settle(api.projects()),
  ]);
  if (session.kind === "ok") {
    if (projects.kind === "failed") throw projects.cause;
    return {accessContext, projects: projects.value, session: session.value};
  }
  if (
    accessContext.accessMode === "local_owner"
    && session.cause instanceof ApiError
    && session.cause.status === 401
  ) {
    await api.localOwnerSession();
    const [signedIn, signedInProjects] = await Promise.all([api.session(), api.projects()]);
    return {accessContext, projects: signedInProjects, session: signedIn};
  }
  throw session.cause;
}

async function withinStartupDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Artifact Server did not answer in time. Check the connection, then try again."));
    }, startupDeadlineMilliseconds);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

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
  // The retired projects list routes (and bare settings) replace themselves with Activity or Projects.
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
      const startup = await withinStartupDeadline(loadStartup());
      accessContextRef.current = startup.accessContext;
      setSession(startup.session);
      setProjects(startup.projects);
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
      ) : route.kind === "activity" ? (
        <ActivityScreen filters={route.filters} projects={projects} session={session} />
      ) : route.kind === "projects" ? (
        <InterimProjectsScreen
          onProjectsChanged={loadProjects}
          projectId={route.projectId}
          projects={projects}
          session={session}
        />
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
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(
    initialLocation.artifactId,
  );
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    initialLocation.versionId,
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(
    initialLocation.path,
  );
  const selectedArtifactRef = useRef(selectedArtifactId);
  selectedArtifactRef.current = selectedArtifactId;
  const record = useArtifactRecord({
    artifactId: selectedArtifactId,
    followLinkedSource: session.capabilities.linkedArtifacts,
    onCurrentVersion: useCallback((currentVersionId: string) => {
      setSelectedVersionId((selected) => selected ?? currentVersionId);
    }, []),
    projectId,
    versionId: selectedVersionId,
  });
  const {
    details,
    error: detailError,
    loading: detailLoading,
    setError: setDetailError,
    setLoading: setDetailLoading,
    version: selectedVersion,
    versions,
  } = record;
  const [comparisonView, setComparisonView] = useState<ComparisonTab | null>(null);
  const activity = useArtifactActivity(projectId, selectedArtifactId, comparisonView === "activity");
  const versionComparison = useVersionComparison(projectId, selectedArtifactId);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("details");
  const [inspectorOpen, setInspectorOpen] = useState(readInitialInspectorOpen);
  const announce = useAnnounce();
  // The first page of a project opens its first artifact, at its current
  // version, so comments and the preview load beside the record.
  const openFirstArtifact = useCallback((artifacts: ArtifactPage["artifacts"]): void => {
    const first = artifacts[0]?.artifact;
    if (first === undefined || selectedArtifactRef.current !== null) return;
    setSelectedArtifactId(first.id);
    setSelectedVersionId(first.currentVersionId);
  }, []);
  const catalog = useArtifactCatalog(projectId, {announce, onFirstPage: openFirstArtifact});
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
  const {learnTags} = catalog;
  useEffect(() => {
    if (details !== null) learnTags(details.artifact.tags);
  }, [details, learnTags]);
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
  // An artifact opened by URL beyond the first page still gets its row.
  const catalogItems = useMemo<ArtifactPage["artifacts"]>(() => {
    if (
      details === null
      || catalog.filtered
      || catalog.items.some(({artifact}) => artifact.id === details.artifact.id)
    ) return catalog.items;
    return [{
      artifact: details.artifact,
      commentCount: comments.threads.length,
      links: details.links,
      versionCount: versions.length,
    }, ...catalog.items];
  }, [catalog.filtered, catalog.items, comments.threads.length, details, versions.length]);
  const catalogItemsRef = useRef(catalogItems);
  catalogItemsRef.current = catalogItems;
  const selectedIndex = catalogItems.findIndex(
    ({artifact}) => artifact.id === selectedArtifactId,
  );
  const selectedItem = selectedIndex < 0 ? null : catalogItems[selectedIndex] ?? null;





  useEffect(() => {
    // Comparison and history belong to one artifact.
    setComparisonView(null);
  }, [selectedArtifactId]);

  useEffect(() => {
    const href = workspaceHref({
      artifactId: selectedArtifactId,
      path: selectedPath,
      projectId,
      threadId: null,
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
      threadId: null,
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
    catalog.learnTags(artifact.tags);
    record.patchArtifact(artifact);
    catalog.replaceArtifact(artifact);
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
      await record.reload();
      return true;
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        try {
          const reloaded = await record.reload();
          if (reloaded !== null) updateArtifact(reloaded.details.artifact);
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
      const reloaded = await record.reload();
      if (reloaded?.shown === true) setSelectedVersionId(captured.version.id);
      if (reloaded !== null) updateArtifact(reloaded.details.artifact);
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
      catalog.removeArtifact(details.artifact.id);
      setSelectedArtifactId(null);
      setSelectedVersionId(null);
      setSelectedPath(null);
      catalog.reload();
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
      threadId: null,
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
      threadId: null,
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
  // An Activity "Open" names one conversation: select it once this version's threads arrive, then drop it from the URL.
  const requestedThreadRef = useRef(currentReviewLocation().threadId);
  useEffect(() => {
    const requested = requestedThreadRef.current;
    if (requested === null || !comments.threads.some((thread) => thread.id === requested)) return;
    requestedThreadRef.current = null;
    selectAnnotation(requested);
    writeReviewHistory(workspaceHref({...currentReviewLocation(), threadId: null}), "replace");
  });
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
    && !catalog.loading
    && catalog.error === null
    && catalogItems.length === 0
    && catalog.query === ""
    && !catalog.filtered;
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
  // Something is on its way: a named artifact's record, or the first page that names one.
  const awaitingRecord = selectedArtifactId === null
    ? catalog.loading && catalog.items.length === 0
    : detailError === null;
  // Comments stay mounted while the next artifact loads, keeping the chosen view and its listing.
  const inspectorBody = inspectorTab === "comments" && selectedArtifactId !== null ? (
    commentsTab
  ) : details === null || selectedVersion === null ? (
    awaitingRecord ? (
      <SurfaceState
        loadingBody="Loading artifact metadata and immutable history."
        loadingStyle="spinner"
        loadingTitle="Reading artifact"
        noun="artifacts"
        phase="loading"
      />
    ) : (
      <SurfaceState
        count={0}
        emptyBody="Select an artifact to inspect its immutable record."
        emptyTitle="Nothing selected"
        noun="artifacts"
        phase="ready"
      />
    )
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
            commentFilter={catalog.commentFilter}
            filtersOpen={catalogFiltersOpen}
            items={catalogItems}
            knownTags={catalog.knownTags}
            listError={catalog.error}
            listLoading={catalog.loading}
            listRereading={catalog.rereading}
            nextCursor={catalog.nextCursor}
            onAnnounce={announce}
            onCommentFilterChange={catalog.setCommentFilter}
            onFiltersOpenChange={setCatalogFiltersOpen}
            onLoadMore={catalog.loadMore}
            onPeekChange={setCatalogPeeking}
            onPinChange={(pinned) => {
              setCatalogPinned(pinned);
              setCatalogPeeking(false);
            }}
            onQueryChange={catalog.setQuery}
            onRefresh={catalog.refresh}
            onSelect={(artifactId, versionId) => {
              setCatalogSheetOpen(false);
              selectArtifact(artifactId, versionId);
            }}
            onSheetClose={() => setCatalogSheetOpen(false)}
            onSortChange={catalog.setSort}
            onTagFiltersChange={catalog.setTagFilters}
            onWidthChange={catalogPreference.setWidth}
            peeking={catalogPeeking}
            pinned={catalogPreference.pinned}
            projectName={selectedProject?.name ?? "this project"}
            query={catalog.query}
            refreshState={catalog.refreshState}
            selectedArtifactId={selectedArtifactId}
            selectedCommentCount={comments.loading ? null : comments.threads.length}
            settingsHref={selectedProject === null ? null : projectsHref(selectedProject.id)}
            sheet={phone}
            sort={catalog.sort}
            tagFilters={catalog.tagFilters}
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
                actions={activity.actions}
                activityError={activity.error}
                activityLoading={activity.loading}
                activityNextCursor={activity.nextCursor}
                artifactName={details.artifact.name}
                comparison={versionComparison.comparison}
                comparisonError={versionComparison.error}
                comparisonLoading={versionComparison.loading}
                currentVersionId={details.artifact.currentVersionId}
                key={details.artifact.id}
                onBack={() => setComparisonView(null)}
                onCompare={versionComparison.compare}
                onLoadMoreActivity={activity.loadMore}
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
                awaitingCatalog={catalog.loading && catalog.items.length === 0}
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

/** Slice 5's Projects route: the selected (else first active) project's settings; slice 6 docks the list beside it. */
function InterimProjectsScreen({onProjectsChanged, projectId, projects, session}: {
  readonly onProjectsChanged: () => Promise<readonly Project[]>;
  readonly projectId: string | null;
  readonly projects: readonly Project[];
  readonly session: Session;
}) {
  const selected = projectId ?? projects.find((project) => project.archivedAt === null)?.id ?? projects[0]?.id ?? null;
  if (selected === null) {
    return <SurfaceState count={0} emptyBody="Create a project to publish into." emptyIcon="bi-folder2-open"
      emptyTitle="No projects yet" noun="projects" phase="ready" titleLevel={1} />;
  }
  return (
    <ProjectSettings
      canManage={canManageProjects(session.principal)}
      gitHistory={session.capabilities.gitHistory}
      key={selected}
      onProjectsChanged={onProjectsChanged}
      projectId={selected}
      projects={projects}
    />
  );
}
