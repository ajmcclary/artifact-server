import {useState, type CSSProperties, type ReactNode} from "react";

import type {ArtifactDetails, ArtifactVersion, SourceFreshness} from "@/api/client";
import {
  Alert,
  Button,
  ConfirmDialog,
  IconButton,
  Menu,
  type MenuItem,
  type PreviewPreset,
  Select,
  StatusPill,
  Toolbar,
  ToolbarSeparator,
  ToolbarSpacer,
  visuallyHiddenStyle,
} from "@/arkcase";
import {sourceDriftDescription} from "@/lib/presentation";
import {ArtifactBreadcrumb, PageMenu, VersionMenu} from "@/ui/review-ui";

import {htmlPages} from "./page-inventory.ts";
import {useScenarioSession} from "./scenario-session.tsx";
import {versionMenuEntries} from "./version-entries.ts";
import type {VersionListItem} from "./workspace-types.ts";

/** The Annotate / Interact toggle for the in-frame annotation surface. */
export interface AnnotateToggle {
  readonly active: boolean;
  /** Shown only for an HTML preview in annotate view to a reviewer who may comment. */
  readonly available: boolean;
  readonly onToggle: () => void;
}

/** The artboard widths that fit the canvas, picked from the More menu. */
export interface ArtboardWidth {
  readonly onChange: (key: string) => void;
  readonly presets: readonly PreviewPreset[];
  readonly value: string;
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
  readonly artboard: ArtboardWidth;
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
  /** Refreshes threads, sends and presence for the shown version. */
  readonly onReload: () => void;
  readonly onSelectPath: (path: string) => void;
  readonly onSelectVersion: (versionId: string) => void;
  readonly opening: boolean;
  readonly phone: boolean;
  readonly projectName: string;
  readonly reloading: boolean;
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
const scenarioStatusStyle = {color: "var(--pill-danger-fg)", fontSize: "var(--font-size-xs, 12px)", whiteSpace: "nowrap"} satisfies CSSProperties;
const anchorStyle = {display: "inline-flex", flex: "none", position: "relative"} satisfies CSSProperties;
const separatorStyle = {height: 20, margin: "0 2px"} satisfies CSSProperties;
const pickersStyle = {alignItems: "center", display: "flex", flex: "0 1 auto", gap: 2, minWidth: 0} satisfies CSSProperties;

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
  artboard,
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
  onReload,
  onSelectPath,
  onSelectVersion,
  opening,
  phone,
  projectName,
  reloading,
  selectedPath,
  selectedVersion,
  share,
  showName,
  versions,
}: ReviewToolbarProps) {
  const scenario = useScenarioSession();
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
  // A lone Fit has nothing to choose between, so the width group only appears with room for another.
  const artboardItems: MenuItem[] = artboard.presets.length < 2 ? [] : [
    {divider: true},
    {heading: "Artboard width"},
    ...artboard.presets.map((preset): MenuItem => ({
      checked: preset.key === artboard.value,
      label: preset.px === null ? "Fit the column" : `${preset.px} pixels wide`,
      onClick: () => artboard.onChange(preset.key),
      type: "radio",
    })),
  ];

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

  // A page without an adapter is reviewed exactly as before: no scenario controls.
  const noAdapter = scenario.onScreen.status === "unsupported" && scenario.onScreen.reason === "no-adapter";
  const requestedScenario = scenario.requested?.scenarioId ?? null;
  const scenarioFailure = requestedScenario !== null
    && (scenario.onScreen.status === "failed" || scenario.onScreen.status === "unsupported")
    ? `Couldn't open scenario ${requestedScenario} (${scenario.onScreen.reason ?? "unknown"})`
    : null;
  const scenarioPicker = scenario.view === null ? null : (
    <>
      {noAdapter ? null : (
        <Select
          aria-label="Designed scenario"
          fit="selected"
          onChange={(event) => scenario.requestScenario(event.currentTarget.value)}
          options={scenario.view.scenarios.map((option) => ({
            label: `${option.scenarioId} · ${option.label}`,
            value: option.scenarioId,
          }))}
          placeholder="Scenario"
          size="viewer"
          value={scenario.onScreen.scenarioId ?? requestedScenario ?? ""}
        />
      )}
      {scenarioFailure === null ? null : (
        <span role="status" style={scenarioStatusStyle}>{scenarioFailure}</span>
      )}
    </>
  );

  return (
    <>
      <Toolbar gap={phone ? 2 : 6} label="Artifact" style={phone ? phoneToolbarStyle : toolbarStyle} wrap={phone}>
        {/* A phone's app bar carries ‹ Back and the artifact's name, so its toolbar keeps only
            the version and page pickers (each a sheet): no arrow and no breadcrumb trail. */}
        {showName || phone ? null : (
          <IconButton
            ariaLabel={`Back to ${projectName}`}
            icon="bi-arrow-left"
            onClick={onOpenCatalog}
            size="sm"
            title={`Back to ${projectName}`}
          />
        )}
        {phone ? (
          <>
            <h1 style={visuallyHiddenStyle}>{artifactName}</h1>
            <div aria-label="Version and page" role="group" style={pickersStyle}>
              {versionMenu}
              {pageMenu}
            </div>
          </>
        ) : (
          <ArtifactBreadcrumb
            crumbs={[versionMenu, pageMenu]}
            name={artifactName}
            nameMaxWidth={260}
            showName={showName}
          />
        )}
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
        {scenarioPicker}
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
        {/* A phone keeps every action on one row. */}
        {phone ? null : <ToolbarSeparator style={separatorStyle} />}
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
              {icon: "bi-layout-split", label: "Comparison and history", onClick: onOpenComparison},
              {icon: "bi-layers", label: "Open Versions Panel", onClick: onOpenVersionsPanel},
              {
                disabled: reloading || selectedVersion === null,
                icon: "bi-arrow-clockwise",
                label: reloading ? "Loading…" : "Reload",
                onClick: onReload,
              },
              ...artboardItems,
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
