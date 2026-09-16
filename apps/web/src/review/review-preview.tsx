import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLinkIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import {
  api,
  type ArtifactVersion,
} from "@/api/client";
import {formatBytes} from "@/lib/presentation";
import {
  frameMessageSchema,
  reviewProtocolVersion,
  type HostMessage,
  type ReviewAnchor,
  type ReviewAnnotation,
} from "@/review-frame/protocol";

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

/** Render one exact immutable manifest entry in the Artifact Server preview surface. */
export function ReviewPreview({
  accessSetting,
  annotateModeActive,
  annotations,
  artifactId,
  artifactName,
  isLight,
  isCurrentVersion,
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
  selectedPath,
  version,
}: {
  readonly accessSetting: "account_required" | "public_link";
  readonly annotateModeActive: boolean;
  readonly annotations: readonly ReviewAnnotation[];
  readonly artifactId: string;
  readonly artifactName: string;
  readonly isLight: boolean;
  readonly isCurrentVersion: boolean;
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
    return (
      <HtmlPreview
        accessSetting={accessSetting}
        actions={commonActions}
        annotateModeActive={annotateModeActive}
        annotations={annotations}
        artifactId={artifactId}
        entry={entry}
        isLight={isLight}
        isCurrentVersion={isCurrentVersion}
        key={identity}
        onAnnotateModeChange={onAnnotateModeChange}
        onSelectAnnotation={onSelectAnnotation}
        onSubmitAnnotation={onSubmitAnnotation}
        onUnanchoredChange={onUnanchoredChange}
        onViewModeChange={onViewModeChange}
        projectId={projectId}
        readOnly={readOnly}
        selectedThreadId={selectedThreadId}
        version={version}
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
  isLight,
  isCurrentVersion,
  onAnnotateModeChange,
  onSelectAnnotation,
  onSubmitAnnotation,
  onUnanchoredChange,
  onViewModeChange,
  projectId,
  readOnly,
  selectedThreadId,
  version,
}: {
  readonly accessSetting: "account_required" | "public_link";
  readonly actions: PreviewActions;
  readonly annotateModeActive: boolean;
  readonly annotations: readonly ReviewAnnotation[];
  readonly artifactId: string;
  readonly entry: PreviewEntry;
  readonly isLight: boolean;
  readonly isCurrentVersion: boolean;
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
  readonly version: ArtifactVersion;
}) {
  const [previewDocument, setPreviewDocument] = useState<PreviewDocument | null>(null);
  const [chosenMode, setChosenMode] = useState<"annotate" | "interactive" | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const initialisedRef = useRef(false);

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
          setPreviewDocument({
            baseHref: documentBaseUrl(lease.baseUrl, entry.path),
            entryPath: entry.path,
            html,
            interactiveUrl,
            prefersInteractive: hasBlockedExternalScript(html, interactiveUrl),
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
      isLight,
      readOnly,
      themeTokens: reviewThemeTokens(),
      type: "as-review-init",
      v: reviewProtocolVersion,
    });
  }, [annotateModeActive, annotations, frameReady, isLight, mode, postToFrame, previewDocument, readOnly]);

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
    const frame = window.requestAnimationFrame(() => {
      postToFrame({
        isLight,
        themeTokens: reviewThemeTokens(),
        type: "as-review-theme",
        v: reviewProtocolVersion,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isLight, postToFrame]);

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
  }, [postToFrame, selectedThreadId]);

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
  return (
    <div className="as-html-preview" data-mode={mode}>
      <div aria-label="HTML preview mode" className="as-html-preview__toolbar" role="group">
        <button aria-pressed={mode === "interactive"} onClick={() => setChosenMode("interactive")} type="button">
          Interactive preview
        </button>
        <button aria-pressed={mode === "annotate"} onClick={() => setChosenMode("annotate")} type="button">
          Annotate
        </button>
        {mode === "interactive" ? (
          <span>{previewDocument?.temporarySession === true
            ? "Preview changes may be lost. Open raw artifact to keep work."
            : previewDocument?.prefersInteractive === true
              ? "Annotate may not render this page's external scripts."
              : "Use Annotate to place comments on the page."}</span>
        ) : previewDocument?.prefersInteractive === true ? (
          <span>This page's external scripts are blocked here. Switch to Interactive preview if blank.</span>
        ) : null}
      </div>
      {mode === "interactive" && previewDocument !== null ? (
        <iframe
          className="as-artifact-frame"
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin"
          src={previewDocument.interactiveUrl}
          title={`Interactive preview: ${entry.path}`}
        />
      ) : (
        <iframe
          className="as-artifact-frame"
          ref={frameRef}
          src="/review-frame"
          title={`${version.version.artifactId} version ${version.version.number}`}
        />
      )}
    </div>
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

function hasBlockedExternalScript(html: string, entryUrl: string): boolean {
  const parsed = new DOMParser().parseFromString(html, "text/html");
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
    <div className="as-media-preview" data-kind={kind} data-status={status}>
      {kind === "image" ? (
        <img
          alt={accessibleName}
          key={retry}
          onError={handleMediaError}
          onLoad={() => setStatus("ready")}
          src={mediaSource}
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
        />
      )}
      {status === "loading" ? (
        <div className="as-media-preview__loading" role="status">
          <span aria-hidden="true" className="as-preview-state__mark" />
          <strong>Loading preview</strong>
          <small>{entry.path}</small>
        </div>
      ) : null}
    </div>
  );
}

function mediaTypeEssence(mediaType: string): string {
  return mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function reviewThemeTokens() {
  const style = getComputedStyle(document.documentElement);
  const value = (name: string): string => style.getPropertyValue(name).trim();
  return {
    "--accent": value("--as-surface-raised"),
    "--accent-foreground": value("--as-text"),
    "--background": value("--as-surface"),
    "--border": value("--as-border"),
    "--card": value("--as-surface"),
    "--card-foreground": value("--as-text"),
    "--code-bg": value("--as-canvas"),
    "--destructive": value("--as-love"),
    "--destructive-foreground": value("--as-canvas"),
    "--focus-highlight": value("--as-iris-soft"),
    "--font-mono": '"Atkinson Hyperlegible Mono", ui-monospace, monospace',
    "--font-sans": '"Atkinson Hyperlegible Next", ui-sans-serif, sans-serif',
    "--foreground": value("--as-text"),
    "--input": value("--as-border"),
    "--muted": value("--as-surface-raised"),
    "--muted-foreground": value("--as-subtle"),
    "--popover": value("--as-surface-raised"),
    "--popover-foreground": value("--as-text"),
    "--primary": value("--as-action"),
    "--primary-foreground": value("--as-on-action"),
    "--radius": "0.75rem",
    "--ring": value("--as-iris"),
    "--secondary": value("--as-foam"),
    "--secondary-foreground": value("--as-canvas"),
    "--success": value("--as-pine"),
    "--success-foreground": value("--as-canvas"),
    "--warning": value("--as-gold"),
    "--warning-foreground": value("--as-canvas"),
  };
}

function TerminalPreviewState({
  actions,
  description,
  mediaType,
  onRetry,
  path,
  size,
  title,
}: {
  readonly actions: PreviewActions;
  readonly description: string;
  readonly mediaType: string;
  readonly onRetry?: () => void;
  readonly path: string;
  readonly size: number | null;
  readonly title: string;
}) {
  return (
    <div className="as-preview-state as-preview-state--terminal" data-tone="error" role="alert">
      <span aria-hidden="true" className="as-preview-state__mark" />
      <h3>{title}</h3>
      <p>{description}</p>
      <dl className="as-preview-state__details">
        <div><dt>Path</dt><dd><code>{path}</code></dd></div>
        <div><dt>Type</dt><dd><code>{mediaType}</code></dd></div>
        {size === null ? null : (
          <div><dt>Size</dt><dd>{formatBytes(size)}</dd></div>
        )}
      </dl>
      <div className="as-preview-state__actions">
        {onRetry === undefined ? null : (
          <button className="as-button" onClick={onRetry} type="button">Retry preview</button>
        )}
        <button
          className="as-button as-button--primary"
          disabled={actions.opening}
          onClick={actions.onOpenRawArtifact}
          type="button"
        >
          <HugeiconsIcon aria-hidden="true" icon={ExternalLinkIcon} strokeWidth={1.8} />
          {actions.opening ? "Opening…" : "Open raw artifact"}
        </button>
        {actions.downloadUrl === null ? null : (
          <a className="as-button" download href={actions.downloadUrl}>Download file</a>
        )}
      </div>
    </div>
  );
}

function PreviewState({
  description,
  title,
}: {
  readonly description: string;
  readonly title: string;
}) {
  return (
    <div className="as-preview-state" role="status">
      <span aria-hidden="true" className="as-preview-state__mark" />
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
