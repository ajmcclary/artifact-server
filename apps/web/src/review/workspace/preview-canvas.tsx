import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import {createPortal} from "react-dom";

import {api, type AccessSetting, type ArtifactVersion} from "@/api/client";
import {maximumReviewHtmlBytes} from "@/api/bounded-text";
import {
  Alert,
  Button,
  FieldGrid,
  onThemeChange,
  PreviewFrame,
  SegmentedControl,
  SurfaceState,
} from "@/arkcase";
import {formatBytes} from "@/lib/presentation";
import {
  frameMessageSchema,
  reviewProtocolVersion,
  type HostMessage,
  type ReviewAnchor,
  type ReviewAnnotation,
} from "@/review-frame/protocol";
import {arkcaseFrameTokens, frameIsLight} from "@/theme/frame-theme";

import {mediaTypeEssence} from "./page-inventory.ts";
import type {HtmlViewerMode} from "./workspace-types.ts";

interface PreviewDocument {
  readonly baseHref: string;
  readonly entryPath: string;
  readonly html: string;
  readonly interactiveUrl: string;
  readonly prefersInteractive: boolean;
  readonly temporarySession: boolean;
}

interface PreviewEntry {
  readonly mediaType: string;
  readonly path: string;
  readonly size: number;
}

interface PreviewActions {
  readonly downloadUrl: string | null;
  readonly onOpenRawArtifact: () => void;
  readonly opening: boolean;
}

/** Everything the canvas draws; the review owns every value. */
export interface PreviewCanvasProps {
  readonly accessSetting: AccessSetting;
  readonly annotateModeActive: boolean;
  readonly annotations: readonly ReviewAnnotation[];
  readonly artifactId: string | null;
  readonly artifactName: string;
  /** `focus` fills the full-screen layer: always fit, no frame border. */
  readonly chrome: "focus" | "workspace";
  readonly detailError: Error | null;
  readonly detailLoading: boolean;
  /** No artifact is named yet and the catalog's first page is still being read. */
  readonly awaitingCatalog: boolean;
  /** Shown instead of "Select an artifact" when the project has nothing published yet. */
  readonly emptyProject: ReactNode;
  /** The artboard width chosen in the toolbar, or null to fit the column. */
  readonly frameWidth: number | null;
  readonly focusControls: ReactNode;
  readonly focusTitleControls: ReactNode;
  /** A native design gallery that replaces the version's entry page, or null. */
  readonly gallery: {readonly content: ReactNode; readonly title: string} | null;
  /** Explains why a version's gallery fell back to its entry page. */
  readonly galleryNotice: string | null;
  readonly hasDetails: boolean;
  readonly isCurrentVersion: boolean;
  /** The Comments view owns the preview mode controls, outside the artifact canvas. */
  readonly modeControlsTarget: HTMLElement | null;
  readonly onAnnotateModeChange: (active: boolean) => void;
  readonly onOpenRawArtifact: () => void;
  readonly onSelectAnnotation: (threadId: string | null) => void;
  readonly onSubmitAnnotation: (body: string, anchor: ReviewAnchor | null, path: string) => Promise<boolean>;
  readonly onUnanchoredChange: (threadIds: readonly string[]) => void;
  readonly onViewModeChange: (mode: HtmlViewerMode) => void;
  readonly opening: boolean;
  readonly projectId: string;
  readonly readOnly: boolean;
  readonly selectedPath: string | null;
  readonly selectedThreadId: string | null;
  /** Bumped to bring the selected thread's place into view again. */
  readonly threadFocusRevision: number;
  readonly version: ArtifactVersion | null;
}

const columnStyle = {
  display: "flex",
  flex: "1 1 0",
  flexDirection: "column",
  gap: 8,
  minHeight: 0,
  minWidth: 0,
  padding: 12,
} satisfies CSSProperties;
const focusColumnStyle = {display: "flex", flex: "1 1 0", flexDirection: "column", minHeight: 0, minWidth: 0} satisfies CSSProperties;
const frameStyle = {display: "flex", flex: "1 1 auto", flexDirection: "column", minHeight: 0} satisfies CSSProperties;
const focusFrameStyle = {...frameStyle, border: 0, borderRadius: 0, boxShadow: "none"} satisfies CSSProperties;
const frameBodyStyle = {display: "flex", flex: "1 1 auto", flexDirection: "column", minHeight: 0} satisfies CSSProperties;
const galleryStyle = {display: "flex", flex: "1 1 auto", flexDirection: "column", minHeight: 0} satisfies CSSProperties;
const htmlPreviewStyle = {display: "flex", flex: "1 1 auto", flexDirection: "column", minHeight: 0} satisfies CSSProperties;
const modeBarStyle = {
  alignItems: "center",
  background: "var(--surface-secondary)",
  borderBottom: "1px solid var(--border-color)",
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  padding: "6px 10px",
} satisfies CSSProperties;
const modeNoteStyle = {color: "var(--text-secondary)", fontSize: 12} satisfies CSSProperties;
const frameElementStyle = {
  background: "var(--surface-card)",
  border: 0,
  flex: "1 1 auto",
  minHeight: 0,
  width: "100%",
} satisfies CSSProperties;
const stateStyle = {margin: "auto", maxWidth: 560, padding: 24, width: "100%"} satisfies CSSProperties;
/** Guides and other text files render as text, never as markup. */
const maximumTextPreviewBytes = 1024 * 1024;
const textPreviewStyle = {
  background: "var(--surface-card)",
  color: "var(--text-body)",
  flex: "1 1 auto",
  fontFamily: "var(--font-data)",
  fontSize: 13,
  lineHeight: 1.55,
  margin: 0,
  minHeight: 0,
  overflow: "auto",
  overflowWrap: "anywhere",
  padding: "16px 20px",
  whiteSpace: "pre-wrap",
} satisfies CSSProperties;
const stateActionsStyle = {display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: 12} satisfies CSSProperties;
const mediaStageStyle = {
  alignItems: "center",
  display: "flex",
  flex: "1 1 auto",
  justifyContent: "center",
  minHeight: 0,
  padding: 16,
  position: "relative",
} satisfies CSSProperties;
const mediaStyle = {maxHeight: "100%", maxWidth: "100%", objectFit: "contain"} satisfies CSSProperties;
const mediaLoadingStyle = {inset: 0, margin: "auto", position: "absolute"} satisfies CSSProperties;

/** The canvas: one PreviewFrame at the chosen width around the exact manifest entry. */
export function PreviewCanvas({
  accessSetting,
  annotateModeActive,
  annotations,
  artifactId,
  artifactName,
  chrome,
  detailError,
  detailLoading,
  awaitingCatalog,
  emptyProject,
  frameWidth,
  focusControls,
  focusTitleControls,
  gallery,
  galleryNotice,
  hasDetails,
  isCurrentVersion,
  modeControlsTarget,
  onAnnotateModeChange,
  onOpenRawArtifact,
  onSelectAnnotation,
  onSubmitAnnotation,
  onUnanchoredChange,
  onViewModeChange,
  opening,
  projectId,
  readOnly,
  selectedPath,
  selectedThreadId,
  threadFocusRevision,
  version,
}: PreviewCanvasProps) {
  const focus = chrome === "focus";
  const path = version === null ? null : selectedPath ?? version.manifest.entryPath;
  return (
    <div style={focus ? focusColumnStyle : columnStyle}>
      {detailError === null || focus ? null : <Alert variant="danger">{detailError.message}</Alert>}
      {galleryNotice === null ? null : <Alert variant="warning">{galleryNotice}</Alert>}
      {/* No title bar in the workspace: the toolbar's breadcrumb already names the version and
          page. Focus hides that toolbar, so there the frame keeps its bar. */}
      <PreviewFrame
        bodyStyle={frameBodyStyle}
        label="Artifact preview"
        style={focus ? focusFrameStyle : frameStyle}
        tabIndex={-1}
        width={focus ? null : frameWidth}
        {...(focus ? {
          meta: focusControls,
          title: <span style={{alignItems: "center", display: "flex", gap: 8, minWidth: 0}}>
            <span style={{minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{gallery?.title ?? path ?? artifactName}</span>
            {version === null ? null : <span style={{color: "var(--text-on-navy-secondary)", flex: "none", fontFamily: "var(--font-data)"}}>v{version.version.number}</span>}
            {focusTitleControls}
          </span>,
        } : {})}
      >
        {artifactId === null && emptyProject !== null ? (
          <div style={stateStyle}>{emptyProject}</div>
        ) : artifactId === null && awaitingCatalog ? (
          <div style={stateStyle}>
            <SurfaceState
              loadingBody="Reading this project's artifacts."
              loadingStyle="spinner"
              loadingTitle="Opening project"
              noun="artifacts"
              phase="loading"
            />
          </div>
        ) : artifactId === null ? (
          <div style={stateStyle}>
            <SurfaceState
              count={0}
              emptyBody="Choose an artifact from the catalog to inspect its current immutable version."
              emptyIcon="bi-collection"
              emptyTitle="Select an artifact"
              noun="artifacts"
              phase="ready"
              titleLevel={2}
            />
          </div>
        ) : detailLoading && !hasDetails ? (
          <div style={stateStyle}>
            <SurfaceState
              loadingBody="Loading artifact metadata and immutable history."
              loadingStyle="spinner"
              loadingTitle="Reading artifact"
              noun="artifacts"
              phase="loading"
            />
          </div>
        ) : detailError !== null && version === null ? (
          <div style={stateStyle}>
            <SurfaceState
              count={0}
              emptyBody="The project, artifact, or version named by this Review URL is unavailable."
              emptyIcon="bi-question-circle"
              emptyTitle="Review target unavailable"
              noun="artifacts"
              phase="ready"
              titleLevel={2}
            />
          </div>
        ) : gallery === null ? (
          <ReviewPreview
            accessSetting={accessSetting}
            annotateModeActive={annotateModeActive}
            annotations={annotations}
            artifactId={artifactId}
            artifactName={artifactName}
            isCurrentVersion={isCurrentVersion}
        modeControlsTarget={modeControlsTarget}
            onAnnotateModeChange={onAnnotateModeChange}
            onOpenRawArtifact={onOpenRawArtifact}
            onSelectAnnotation={onSelectAnnotation}
            onSubmitAnnotation={onSubmitAnnotation}
            onUnanchoredChange={onUnanchoredChange}
            onViewModeChange={onViewModeChange}
            opening={opening}
            projectId={projectId}
            readOnly={readOnly}
            selectedPath={selectedPath}
            selectedThreadId={selectedThreadId}
            threadFocusRevision={threadFocusRevision}
            version={version}
          />
        ) : (
          <div style={galleryStyle}>{gallery.content}</div>
        )}
      </PreviewFrame>
    </div>
  );
}

function ReviewPreview({
  accessSetting,
  annotateModeActive,
  annotations,
  artifactId,
  artifactName,
  isCurrentVersion,
  modeControlsTarget,
  onOpenRawArtifact,
  onAnnotateModeChange,
  onSelectAnnotation,
  onSubmitAnnotation,
  onUnanchoredChange,
  onViewModeChange,
  opening,
  projectId,
  readOnly,
  selectedThreadId,
  threadFocusRevision,
  selectedPath,
  version,
}: {
  readonly accessSetting: "account_required" | "public_link";
  readonly annotateModeActive: boolean;
  readonly annotations: readonly ReviewAnnotation[];
  readonly artifactId: string;
  readonly artifactName: string;
  readonly isCurrentVersion: boolean;
  /** The Comments view owns the preview mode controls, outside the artifact canvas. */
  readonly modeControlsTarget: HTMLElement | null;
  readonly onOpenRawArtifact: () => void;
  readonly onAnnotateModeChange: (active: boolean) => void;
  readonly onSelectAnnotation: (threadId: string | null) => void;
  readonly onSubmitAnnotation: (
    body: string,
    anchor: ReviewAnchor | null,
    path: string,
  ) => Promise<boolean>;
  readonly onUnanchoredChange: (threadIds: readonly string[]) => void;
  readonly onViewModeChange: (mode: "annotate" | "interactive") => void;
  readonly opening: boolean;
  readonly projectId: string;
  readonly readOnly: boolean;
  readonly selectedThreadId: string | null;
  /** Bumped to bring the selected thread's place into view again. */
  readonly threadFocusRevision: number;
  readonly selectedPath: string | null;
  readonly version: ArtifactVersion | null;
}) {
  if (version === null) {
    return (
      <PreviewState
        description="Reading the selected immutable version."
        title="Loading preview"
      />
    );
  }
  const path = selectedPath ?? version.manifest.entryPath;
  const entry = version.manifest.entries.find(
    (candidate) => candidate.path === path,
  );
  const commonActions: PreviewActions = {
    downloadUrl: entry === undefined
      ? null
      : api.versionFileUrl(projectId, artifactId, version.version.id, entry.path),
    onOpenRawArtifact,
    opening,
  };
  if (entry === undefined) {
    return (
      <TerminalPreviewState
        actions={commonActions}
        description="This path is not part of the selected immutable version."
        mediaType="unknown"
        path={path}
        size={null}
        title="File not found"
      />
    );
  }
  const mediaType = mediaTypeEssence(entry.mediaType);
  const identity = `${version.version.id}:${entry.path}`;
  if (mediaType === "text/html") {
    if (entry.size > maximumReviewHtmlBytes) {
      return (
        <TerminalPreviewState
          actions={commonActions}
          description={`Review previews HTML files up to ${formatBytes(maximumReviewHtmlBytes)}. Open or download the raw artifact to view this file.`}
          mediaType={entry.mediaType}
          path={entry.path}
          size={entry.size}
          title="Preview too large"
        />
      );
    }
    return (
      <HtmlPreview
        accessSetting={accessSetting}
        actions={commonActions}
        annotateModeActive={annotateModeActive}
        annotations={annotations}
        artifactId={artifactId}
        entry={entry}
        isCurrentVersion={isCurrentVersion}
        modeControlsTarget={modeControlsTarget}
        key={identity}
        onAnnotateModeChange={onAnnotateModeChange}
        onSelectAnnotation={onSelectAnnotation}
        onSubmitAnnotation={onSubmitAnnotation}
        onUnanchoredChange={onUnanchoredChange}
        onViewModeChange={onViewModeChange}
        projectId={projectId}
        readOnly={readOnly}
        selectedThreadId={selectedThreadId}
            threadFocusRevision={threadFocusRevision}
        version={version}
      />
    );
  }
  if (mediaType.startsWith("text/")) {
    if (entry.size > maximumTextPreviewBytes) {
      return (
        <TerminalPreviewState
          actions={commonActions}
          description={`Review shows text files up to ${formatBytes(maximumTextPreviewBytes)}. Open or download the raw artifact to read this file.`}
          mediaType={entry.mediaType}
          path={entry.path}
          size={entry.size}
          title="Text too large"
        />
      );
    }
    return (
      <TextPreview
        actions={commonActions}
        entry={entry}
        key={identity}
        load={() => api.versionFile(projectId, artifactId, version.version.id, entry.path)}
      />
    );
  }
  if (mediaType.startsWith("image/")) {
    return (
      <NativeMediaPreview
        actions={commonActions}
        artifactName={artifactName}
        entry={entry}
        key={identity}
        kind="image"
        onProbe={() => api.probeVersionMedia(
          projectId,
          artifactId,
          version.version.id,
          entry.path,
        )}
        source={api.versionMediaUrl(
          projectId,
          artifactId,
          version.version.id,
          entry.path,
        )}
      />
    );
  }
  if (mediaType.startsWith("video/")) {
    return (
      <NativeMediaPreview
        actions={commonActions}
        artifactName={artifactName}
        entry={entry}
        key={identity}
        kind="video"
        onProbe={() => api.probeVersionMedia(
          projectId,
          artifactId,
          version.version.id,
          entry.path,
        )}
        source={api.versionMediaUrl(
          projectId,
          artifactId,
          version.version.id,
          entry.path,
        )}
      />
    );
  }
  return (
    <TerminalPreviewState
      actions={commonActions}
      description="Artifact Server does not preview this declared media type."
      mediaType={entry.mediaType}
      path={entry.path}
      size={entry.size}
      title="Preview not supported"
    />
  );
}


function HtmlPreview({
  accessSetting,
  actions,
  annotateModeActive,
  annotations,
  artifactId,
  entry,
  isCurrentVersion,
  modeControlsTarget,
  onAnnotateModeChange,
  onSelectAnnotation,
  onSubmitAnnotation,
  onUnanchoredChange,
  onViewModeChange,
  projectId,
  readOnly,
  selectedThreadId,
  threadFocusRevision,
  version,
}: {
  readonly accessSetting: "account_required" | "public_link";
  readonly actions: PreviewActions;
  readonly annotateModeActive: boolean;
  readonly annotations: readonly ReviewAnnotation[];
  readonly artifactId: string;
  readonly entry: PreviewEntry;
  readonly isCurrentVersion: boolean;
  /** The Comments view owns the preview mode controls, outside the artifact canvas. */
  readonly modeControlsTarget: HTMLElement | null;
  readonly onAnnotateModeChange: (active: boolean) => void;
  readonly onSelectAnnotation: (threadId: string | null) => void;
  readonly onSubmitAnnotation: (
    body: string,
    anchor: ReviewAnchor | null,
    path: string,
  ) => Promise<boolean>;
  readonly onUnanchoredChange: (threadIds: readonly string[]) => void;
  readonly onViewModeChange: (mode: "annotate" | "interactive") => void;
  readonly projectId: string;
  readonly readOnly: boolean;
  readonly selectedThreadId: string | null;
  /** Bumped to bring the selected thread's place into view again. */
  readonly threadFocusRevision: number;
  readonly version: ArtifactVersion;
}) {
  const [previewDocument, setPreviewDocument] = useState<PreviewDocument | null>(null);
  const [chosenMode, setChosenMode] = useState<"annotate" | "interactive" | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const initialisedRef = useRef(false);
  const [themeRevision, setThemeRevision] = useState(0);
  useEffect(() => onThemeChange(() => setThemeRevision((revision) => revision + 1)), []);

  const postToFrame = useCallback((message: HostMessage): void => {
    const frame = frameRef.current?.contentWindow;
    if (frame === null || frame === undefined) return;
    frame.postMessage(message, window.location.origin);
  }, []);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const [html, lease] = await Promise.all([
          api.versionFile(
            projectId,
            artifactId,
            version.version.id,
            entry.path,
          ),
          api.previewLease(projectId, artifactId, version.version.id),
        ]);
        if (lease.versionId !== version.version.id) {
          throw new Error("The preview lease resolved a different version.");
        }
        const useStableOrigin = accessSetting === "public_link" && isCurrentVersion;
        const interactiveBase = useStableOrigin ? version.links.version : lease.baseUrl;
        const interactiveUrl = documentEntryUrl(interactiveBase, entry.path);
        if (!isVersionContentUrl(interactiveUrl, lease.baseUrl)) {
          throw new Error("Interactive preview requires a separate version content origin.");
        }
        if (current) {
          // A re-read after an access or current-version change replaces an earlier failure.
          setError(null);
          setPreviewDocument({
            baseHref: documentBaseUrl(lease.baseUrl, entry.path),
            entryPath: entry.path,
            html,
            interactiveUrl,
            prefersInteractive: prefersInteractivePreview(html, interactiveUrl, entry.path),
            temporarySession: !useStableOrigin,
          });
        }
      } catch (cause) {
        if (!current) return;
        setError(
          cause instanceof Error ? cause : new Error("Artifact preview failed."),
        );
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [accessSetting, artifactId, entry.path, isCurrentVersion, projectId, version.links.version, version.version.id]);

  const mode = chosenMode ?? (previewDocument?.prefersInteractive === true
    ? "interactive"
    : "annotate");

  useEffect(() => onViewModeChange(mode), [mode, onViewModeChange]);

  useEffect(() => {
    if (mode !== "interactive") return;
    initialisedRef.current = false;
    setFrameReady(false);
  }, [mode]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (event.origin !== window.location.origin) return;
      const parsed = frameMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "as-review-ready") {
        setFrameReady(true);
        return;
      }
      if (message.type === "as-review-select") {
        onSelectAnnotation(message.threadId);
        return;
      }
      if (message.type === "as-review-unanchored") {
        onUnanchoredChange(message.threadIds);
        return;
      }
      if (message.type === "as-review-annotate-mode-request") {
        onAnnotateModeChange(message.active);
        return;
      }
      void (async () => {
        const saved = await onSubmitAnnotation(message.body, message.anchor, entry.path);
        if (!saved) {
          postToFrame({
            annotations: [...annotations],
            type: "as-review-annotations",
            v: reviewProtocolVersion,
          });
        }
      })();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [
    annotations,
    entry.path,
    onAnnotateModeChange,
    onSelectAnnotation,
    onSubmitAnnotation,
    onUnanchoredChange,
    postToFrame,
  ]);

  useEffect(() => {
    if (mode !== "annotate" || !frameReady || previewDocument === null || initialisedRef.current) return;
    initialisedRef.current = true;
    postToFrame({
      annotateModeActive,
      annotations: [...annotations],
      baseHref: previewDocument.baseHref,
      entryPath: previewDocument.entryPath,
      html: previewDocument.html,
      isLight: frameIsLight(),
      readOnly,
      themeTokens: arkcaseFrameTokens(),
      type: "as-review-init",
      v: reviewProtocolVersion,
    });
  }, [annotateModeActive, annotations, frameReady, mode, postToFrame, previewDocument, readOnly]);

  useEffect(() => {
    if (!initialisedRef.current) return;
    postToFrame({
      active: annotateModeActive,
      type: "as-review-annotate-mode",
      v: reviewProtocolVersion,
    });
  }, [annotateModeActive, postToFrame]);

  useEffect(() => {
    if (!initialisedRef.current) return undefined;
    // Wait one frame so the shell's new data-theme has restyled :root.
    const frame = window.requestAnimationFrame(() => {
      postToFrame({
        isLight: frameIsLight(),
        themeTokens: arkcaseFrameTokens(),
        type: "as-review-theme",
        v: reviewProtocolVersion,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [postToFrame, themeRevision]);

  useEffect(() => {
    if (!initialisedRef.current) return;
    postToFrame({
      annotations: [...annotations],
      type: "as-review-annotations",
      v: reviewProtocolVersion,
    });
  }, [annotations, postToFrame]);

  useEffect(() => {
    if (!initialisedRef.current) return;
    postToFrame({
      threadId: selectedThreadId,
      type: "as-review-focus",
      v: reviewProtocolVersion,
    });
  }, [postToFrame, selectedThreadId, threadFocusRevision]);

  if (loading) {
    return (
      <PreviewState
        description={`Reading ${entry.path} from the selected version.`}
        title="Loading preview"
      />
    );
  }
  if (error !== null) {
    return (
      <TerminalPreviewState
        actions={actions}
        description={error.message}
        mediaType={entry.mediaType}
        path={entry.path}
        size={entry.size}
        title="Preview unavailable"
      />
    );
  }
  const modeNote = mode === "interactive"
    ? previewDocument?.temporarySession === true
      ? "Preview changes may be lost. Open raw artifact to keep work."
      : previewDocument?.prefersInteractive === true
        ? "Annotate may not render this page's external scripts."
        : "Use Annotate to place comments on the page."
    : previewDocument?.prefersInteractive === true
      ? "This page's external scripts are blocked here. Switch to Interactive preview if blank."
      : null;
  return (
    <>
      {modeControlsTarget === null ? null : createPortal(
        <div style={modeBarStyle}>
          <SegmentedControl
            label="HTML preview mode"
            mode="toggle"
            onChange={(id) => {
              if (id === "annotate" || id === "interactive") setChosenMode(id);
            }}
            options={[
              {id: "interactive", label: "Interactive preview"},
              {id: "annotate", label: "Annotate"},
            ]}
            size="sm"
            value={mode}
          />
          {modeNote === null ? null : <span style={modeNoteStyle}>{modeNote}</span>}
        </div>, modeControlsTarget,
      )}
      <div style={htmlPreviewStyle}>
        {mode === "interactive" && previewDocument !== null ? (
          <iframe
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin"
            src={previewDocument.interactiveUrl}
            style={frameElementStyle}
            title={`Interactive preview: ${entry.path}`}
          />
        ) : (
          <iframe
            ref={frameRef}
            src="/review-frame"
            style={frameElementStyle}
            title={`${version.version.artifactId} version ${version.version.number}`}
          />
        )}
      </div>
    </>
  );
}

function documentBaseUrl(versionBaseUrl: string, entryPath: string): string {
  return new URL(".", documentEntryUrl(versionBaseUrl, entryPath)).toString();
}

function documentEntryUrl(versionBaseUrl: string, entryPath: string): string {
  return new URL(
    entryPath.split("/").map(encodeURIComponent).join("/"),
    versionBaseUrl,
  ).toString();
}

function prefersInteractivePreview(html: string, entryUrl: string, path: string): boolean {
  // Claude Design artboards boot a runtime that loads React from a CDN at run time,
  // which only the version's own content origin permits. Annotate stays one click away.
  if (path.endsWith(".dc.html")) return true;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  if (parsed.querySelector('meta[name="artifact-server-preview"][content="claude-design-catalog"]') !== null) {
    return true;
  }
  const contentOrigin = new URL(entryUrl).origin;
  return [...parsed.querySelectorAll("script[src]")].some((script) => {
    const source = script.getAttribute("src");
    if (source === null) return false;
    try {
      return new URL(source, entryUrl).origin !== contentOrigin;
    } catch {
      return false;
    }
  });
}

function isVersionContentUrl(candidate: string, leaseBase: string): boolean {
  const target = new URL(candidate);
  const lease = new URL(leaseBase);
  const suffix = lease.hostname.slice(lease.hostname.indexOf("."));
  const label = target.hostname.slice(0, -suffix.length);
  return suffix.startsWith(".")
    && label.length > 0
    && !label.includes(".")
    && target.hostname.endsWith(suffix)
    && target.protocol === lease.protocol
    && target.port === lease.port
    && ["http:", "https:"].includes(target.protocol)
    && target.origin !== window.location.origin;
}

function NativeMediaPreview({
  actions,
  artifactName,
  entry,
  kind,
  onProbe,
  source,
}: {
  readonly actions: PreviewActions;
  readonly artifactName: string;
  readonly entry: PreviewEntry;
  readonly kind: "image" | "video";
  readonly onProbe: () => Promise<void>;
  readonly source: string;
}) {
  const [status, setStatus] = useState<"error" | "loading" | "ready">("loading");
  const [retry, setRetry] = useState(0);
  const mountedRef = useRef(true);
  const probeInFlightRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const accessibleName = `${artifactName} — ${entry.path}`;

  useEffect(() => () => {
    mountedRef.current = false;
    const video = videoRef.current;
    if (video !== null) {
      video.removeAttribute("src");
      video.load();
    }
  }, []);

  const handleMediaError = (): void => {
    if (probeInFlightRef.current) return;
    probeInFlightRef.current = true;
    void (async () => {
      try {
        await onProbe();
      } catch {
        // The API boundary separately broadcasts an expired session. Every
        // other probe failure uses the same honest terminal media fallback.
      } finally {
        if (mountedRef.current) setStatus("error");
        probeInFlightRef.current = false;
      }
    })();
  };

  if (status === "error") {
    return (
      <TerminalPreviewState
        actions={actions}
        description={`This browser could not decode or deliver the declared ${entry.mediaType} file.`}
        mediaType={entry.mediaType}
        onRetry={() => {
          setRetry((current) => current + 1);
          setStatus("loading");
        }}
        path={entry.path}
        size={entry.size}
        title={`${kind === "image" ? "Image" : "Video"} preview unavailable`}
      />
    );
  }
  const mediaSource = `${source}#preview-${retry}`;
  return (
    <div style={mediaStageStyle}>
      {kind === "image" ? (
        <img
          alt={accessibleName}
          key={retry}
          onError={handleMediaError}
          onLoad={() => setStatus("ready")}
          src={mediaSource}
          style={mediaStyle}
        />
      ) : (
        <video
          aria-label={accessibleName}
          controls
          key={retry}
          onError={handleMediaError}
          onLoadedMetadata={() => setStatus("ready")}
          playsInline
          preload="metadata"
          ref={videoRef}
          src={mediaSource}
          style={mediaStyle}
        />
      )}
      {status === "loading" ? (
        <div style={mediaLoadingStyle}>
          <SurfaceState
            density="inline"
            loadingBody={entry.path}
            loadingStyle="spinner"
            loadingTitle="Loading preview"
            noun="previews"
            phase="loading"
          />
        </div>
      ) : null}
    </div>
  );
}

interface TerminalPreviewStateProps {
  readonly actions: PreviewActions;
  readonly description: string;
  readonly mediaType: string;
  readonly onRetry?: () => void;
  readonly path: string;
  readonly size: number | null;
  readonly title: string;
}

/** A preview that cannot render: what it is, and the ways out that still work. */
function TerminalPreviewState({actions, description, mediaType, onRetry, path, size, title}: TerminalPreviewStateProps) {
  const fields = [
    {label: "Path", mono: true, value: path},
    {label: "Type", mono: true, value: mediaType},
    ...(size === null ? [] : [{label: "Size", value: formatBytes(size)}]),
  ];
  return (
    <div role="alert" style={stateStyle}>
      <SurfaceState
        count={0}
        emptyBody={description}
        emptyIcon="bi-exclamation-octagon"
        emptyTitle={title}
        noun="previews"
        phase="ready"
        titleLevel={3}
      />
      <FieldGrid columns={1} fields={fields} layout="inline" />
      <div style={stateActionsStyle}>
        {onRetry === undefined ? null : (
          <Button onClick={onRetry} outline size="sm" variant="secondary">Retry preview</Button>
        )}
        <Button disabled={actions.opening} icon="bi-box-arrow-up-right" onClick={actions.onOpenRawArtifact} size="sm">
          {actions.opening ? "Opening…" : "Open raw artifact"}
        </Button>
        {actions.downloadUrl === null ? null : (
          <Button download href={actions.downloadUrl} icon="bi-download" outline size="sm" variant="secondary">
            Download file
          </Button>
        )}
      </div>
    </div>
  );
}

function TextPreview({actions, entry, load}: {
  readonly actions: PreviewActions;
  readonly entry: PreviewEntry;
  readonly load: () => Promise<string>;
}) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setFailed(false);
    void (async () => {
      try {
        const loaded = await load();
        if (current) setText(loaded);
      } catch {
        if (current) setFailed(true);
      }
    })();
    return () => {
      current = false;
    };
    // `load` names one immutable file; `attempt` re-runs it on retry.
  }, [attempt]);
  if (failed) {
    return (
      <TerminalPreviewState
        actions={actions}
        description="The text could not be read from this version."
        mediaType={entry.mediaType}
        onRetry={() => setAttempt((value) => value + 1)}
        path={entry.path}
        size={entry.size}
        title="Text unavailable"
      />
    );
  }
  if (text === null) return <PreviewState description="Reading the text of this immutable file." title="Loading text" />;
  return (
    <pre aria-label={`Text of ${entry.path}`} style={textPreviewStyle} tabIndex={0}>{text}</pre>
  );
}

interface PreviewStateProps {
  readonly description: string;
  readonly title: string;
}

function PreviewState({description, title}: PreviewStateProps) {
  return (
    <div style={stateStyle}>
      <SurfaceState loadingBody={description} loadingStyle="spinner" loadingTitle={title} noun="previews" phase="loading" />
    </div>
  );
}
