import {useState, type CSSProperties, type ReactNode} from "react";

import type {ArtifactDetails, ArtifactVersion, SourceFreshness} from "@/api/client";
import {
  Alert,
  Button,
  ConfirmDialog,
  IconButton,
  Menu,
  StatusPill,
  Toolbar,
  ToolbarSeparator,
  ToolbarSpacer,
} from "@/arkcase";
import {sourceDriftDescription} from "@/lib/presentation";
import {ArtifactBreadcrumb, PageMenu, VersionMenu} from "@/ui/review-ui";

import {htmlPages} from "./page-inventory.ts";
import {versionMenuEntries} from "./version-entries.ts";
import type {VersionListItem} from "./workspace-types.ts";

/** The Annotate / Interact toggle for the in-frame annotation surface. */
export interface AnnotateToggle {
  readonly active: boolean;
  /** Shown only for an HTML preview in annotate view to a reviewer who may comment. */
  readonly available: boolean;
  readonly onToggle: () => void;
}

/** A version with a design gallery: the page menu pins a Gallery row that returns to it. */
export interface GalleryCrumb {
  readonly count: number;
  readonly onOpen: () => void;
  /** The gallery is on screen rather than one of its pages. */
  readonly shown: boolean;
}

export interface ReviewToolbarProps {
  readonly annotate: AnnotateToggle;
  readonly artifactName: string;
  readonly canManage: boolean;
  readonly details: ArtifactDetails | null;
  readonly focusActive: boolean;
  readonly gallery: GalleryCrumb | null;
  readonly linkedArtifacts: boolean;
  readonly onAnnounce: (message: string) => void;
  readonly onCapture: () => Promise<void>;
  readonly onEnterFocus: () => void;
  readonly onMakeCurrent: (versionId: string, expectedCurrentVersionId: string) => Promise<boolean>;
  readonly onOpenCatalog: () => void;
  /** Phones have a comments sheet instead of the inspector rail. */
  readonly onOpenComments: () => void;
  readonly onOpenComparison: () => void;
  readonly onOpenLive: () => Promise<void>;
  readonly onOpenRawArtifact: () => void;
  readonly onOpenVersionsPanel: () => void;
  readonly onSelectPath: (path: string) => void;
  readonly onSelectVersion: (versionId: string) => void;
  readonly opening: boolean;
  readonly phone: boolean;
  readonly projectName: string;
  readonly selectedPath: string | null;
  readonly selectedVersion: ArtifactVersion | null;
  /** The Share control for this toolbar instance. */
  readonly share: ReactNode;
  /** The artifact list is collapsed, so the name joins the breadcrumb as its first crumb. */
  readonly showName: boolean;
  readonly versions: readonly VersionListItem[];
}

const toolbarStyle = {
  background: "var(--surface-card)",
  borderBottom: "1px solid var(--border-color)",
  boxSizing: "border-box",
  flex: "none",
  minHeight: 48,
  padding: "7px 8px 7px 16px",
} satisfies CSSProperties;
const phoneToolbarStyle = {...toolbarStyle, padding: "7px 8px"} satisfies CSSProperties;
const inlineStyle = {display: "inline-flex", flex: "none"} satisfies CSSProperties;
const anchorStyle = {display: "inline-flex", flex: "none", position: "relative"} satisfies CSSProperties;
const separatorStyle = {height: 20, margin: "0 2px"} satisfies CSSProperties;

const driftTags = {
  "in-sync": "In sync",
  missing: "Source missing",
  modified: "Modified",
  unreadable: "Source unreadable",
} satisfies Record<SourceFreshness, string>;

/**
 * The toolbar over the canvas: a breadcrumb (the artifact name while the list is
 * collapsed, then the version and the page, each with its own menu), the source-change
 * and preview tags, then Share, Open raw and Focus as icons, and More.
 */
export function ReviewToolbar({
  annotate,
  artifactName,
  canManage,
  details,
  focusActive,
  gallery,
  linkedArtifacts,
  onAnnounce,
  onCapture,
  onEnterFocus,
  onMakeCurrent,
  onOpenCatalog,
  onOpenComments,
  onOpenComparison,
  onOpenLive,
  onOpenRawArtifact,
  onOpenVersionsPanel,
  onSelectPath,
  onSelectVersion,
  opening,
  phone,
  projectName,
  selectedPath,
  selectedVersion,
  share,
  showName,
  versions,
}: ReviewToolbarProps) {
  const [versionOpen, setVersionOpen] = useState(false);
  const [versionQuery, setVersionQuery] = useState("");
  const [pageOpen, setPageOpen] = useState(false);
  const [pageQuery, setPageQuery] = useState("");
  const [pageLimit, setPageLimit] = useState(50);
  const [moreOpen, setMoreOpen] = useState(false);
  const [makeCurrentAsk, setMakeCurrentAsk] = useState(false);
  const shown = selectedVersion?.version ?? null;
  const currentVersionId = details?.artifact.currentVersionId ?? null;
  const current = versions.find(({version}) => version.id === currentVersionId)?.version ?? null;
  const historical = shown !== null && current !== null && shown.id !== current.id;
  const pages = selectedVersion === null
    ? []
    : htmlPages(selectedVersion.manifest.entryPath, selectedVersion.manifest.entries);
  const binding = details?.sourceBinding ?? null;
  const drifted = binding !== null && binding.status !== "in-sync";
  const liveAvailable = linkedArtifacts && details?.links.live !== undefined;
  const galleryShown = gallery?.shown === true;
  const pagePath = selectedVersion === null ? null : selectedPath ?? selectedVersion.manifest.entryPath;
  const pageName = galleryShown ? "Gallery" : pagePath?.split("/").pop() ?? "";
  const byNumber = new Map(versions.map(({version}) => [version.number, version.id]));

  const driftActions = [
    ...(canManage && binding?.status === "modified" ? [{
      label: `Publish Version ${(versions[0]?.version.number ?? 0) + 1}`,
      onClick: () => {
        setVersionOpen(false);
        void onCapture();
      },
      variant: "primary" as const,
    }] : []),
    ...(liveAvailable ? [{
      label: "Open Live File",
      onClick: () => {
        setVersionOpen(false);
        void onOpenLive();
      },
      variant: "ghost" as const,
    }] : []),
  ];
  const driftNotice = !drifted || binding === null || shown === null ? null : (
    <Alert action={driftActions} density="compact" live="off" variant="warning">
      {binding.status === "modified"
        ? `The source changed after v${shown.number} was captured. Publish a new version to keep it.`
        : sourceDriftDescription(binding.status, "captured")}
    </Alert>
  );

  const versionMenu = shown === null ? null : (
    <VersionMenu
      ariaLabel={`${historical && current !== null
        ? `Version ${shown.number}, a preview; version ${current.number} is current`
        : `Version ${shown.number}, the current version`} · Choose a version`}
      footer={driftNotice}
      label={`v${shown.number}`}
      onAnnounce={onAnnounce}
      onOpenChange={(open) => {
        setVersionOpen(open);
        setVersionQuery("");
        if (open) {
          setPageOpen(false);
          setMoreOpen(false);
        }
      }}
      onOpenPanel={onOpenVersionsPanel}
      onQueryChange={setVersionQuery}
      onSelectVersion={(number) => {
        const id = byNumber.get(number);
        if (id !== undefined) onSelectVersion(id);
      }}
      open={versionOpen}
      phone={phone}
      query={versionQuery}
      version={shown.number}
      versions={versionMenuEntries(versions, currentVersionId)}
    />
  );
  const pageMenu = selectedVersion === null || (pages.length === 0 && gallery === null) ? null : (
    <PageMenu
      ariaLabel={`Page ${pageName} · Choose a page`}
      label={galleryShown ? "Gallery" : pagePath ?? ""}
      limit={pageLimit}
      onAnnounce={onAnnounce}
      onLoadMore={() => setPageLimit((limit) => limit + 50)}
      onOpenChange={(open) => {
        setPageOpen(open);
        setPageQuery("");
        setPageLimit(50);
        if (open) {
          setVersionOpen(false);
          setMoreOpen(false);
        }
      }}
      onQueryChange={(value) => {
        setPageQuery(value);
        setPageLimit(50);
      }}
      onSelectPage={onSelectPath}
      open={pageOpen}
      page={galleryShown ? null : pagePath}
      pages={[...pages]}
      phone={phone}
      query={pageQuery}
      {...(gallery === null ? {} : {
        gallery: {
          description: `${gallery.count} ${gallery.count === 1 ? "preview" : "previews"}`,
          onOpen: gallery.onOpen,
        },
      })}
    />
  );

  return (
    <>
      <Toolbar gap={6} label="Artifact" style={phone ? phoneToolbarStyle : toolbarStyle} wrap={phone}>
        {showName && !phone ? null : (
          <IconButton
            ariaLabel={`Back to ${projectName}`}
            icon="bi-arrow-left"
            onClick={onOpenCatalog}
            size="sm"
            title={`Back to ${projectName}`}
          />
        )}
        <ArtifactBreadcrumb
          crumbs={[versionMenu, pageMenu]}
          name={artifactName}
          nameMaxWidth={phone ? 140 : 260}
          showName={showName}
        />
        {drifted && binding !== null && shown !== null ? (
          <span style={inlineStyle}>
            <StatusPill
              label={driftTags[binding.status]}
              title={`The linked source file changed on disk after v${shown.number} was captured`}
              tone="warning"
            />
          </span>
        ) : null}
        {historical && current !== null ? (
          <>
            <span style={inlineStyle}><StatusPill label="Preview" tone="neutral" /></span>
            <Button
              icon="bi-arrow-counterclockwise"
              onClick={() => onSelectVersion(current.id)}
              size="sm"
              variant="ghost"
            >
              {`Back to v${current.number}`}
            </Button>
            {canManage ? (
              <Button onClick={() => setMakeCurrentAsk(true)} outline size="sm" variant="secondary">
                Make Current
              </Button>
            ) : null}
          </>
        ) : null}
        {annotate.available ? (
          <IconButton
            ariaLabel={annotate.active
              ? "Annotate mode: click an element or select text to comment. Press Escape to interact."
              : "Interact mode: links and controls work normally. Select text or turn annotation mode back on to comment."}
            icon="bi-pencil-square"
            onClick={annotate.onToggle}
            pressed={annotate.active}
            size="sm"
          />
        ) : null}
        <ToolbarSpacer />
        <span style={inlineStyle}>{share}</span>
        <IconButton
          ariaLabel={opening ? "Opening raw in a new window" : "Open raw in a new window"}
          disabled={selectedVersion === null || opening}
          icon="bi-box-arrow-up-right"
          onClick={onOpenRawArtifact}
          size="sm"
          title="Open raw"
        />
        <IconButton
          ariaLabel={focusActive ? "Focus is on — restore the workspace" : "Focus — expand the workspace"}
          disabled={selectedVersion === null}
          icon={focusActive ? "bi-arrows-angle-contract" : "bi-arrows-angle-expand"}
          keyshortcuts="F"
          onClick={onEnterFocus}
          pressed={focusActive}
          size="sm"
          title="Focus (F)"
        />
        {phone ? (
          <IconButton
            ariaLabel="Open comments"
            disabled={selectedVersion === null}
            icon="bi-chat-square-text"
            onClick={onOpenComments}
            size="sm"
            title="Open comments"
          />
        ) : null}
        <ToolbarSeparator style={separatorStyle} />
        <span style={anchorStyle}>
          <IconButton
            ariaLabel="More artifact actions"
            disabled={details === null}
            expanded={moreOpen}
            hasPopup="menu"
            icon="bi-three-dots-vertical"
            onClick={() => {
              setMoreOpen((open) => !open);
              setVersionOpen(false);
              setPageOpen(false);
            }}
            size="sm"
          />
          <Menu
            align="end"
            items={[
              {heading: "This artifact"},
              {icon: "bi-clock-history", label: "Comparison and history", onClick: onOpenComparison},
              {icon: "bi-layers", label: "Open Versions Panel", onClick: onOpenVersionsPanel},
            ]}
            label="More artifact actions"
            onClose={() => setMoreOpen(false)}
            open={moreOpen}
            width={266}
          />
        </span>
      </Toolbar>
      {shown === null || current === null ? null : (
        <ConfirmDialog
          confirmIcon="bi-bookmark-check"
          confirmLabel="Make Current"
          message={`The stable artifact link will point to Version ${shown.number}. No saved version is changed or duplicated.`}
          onClose={() => setMakeCurrentAsk(false)}
          onConfirm={() => void onMakeCurrent(shown.id, current.id)}
          open={makeCurrentAsk}
          title={`Make Version ${shown.number} current?`}
          tone="primary"
        />
      )}
    </>
  );
}
