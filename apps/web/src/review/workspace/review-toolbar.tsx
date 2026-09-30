import {useState, type CSSProperties, type ReactNode} from "react";

import type {ArtifactDetails, ArtifactVersion, SourceFreshness} from "@/api/client";
import {
  Button,
  IconButton,
  Input,
  Menu,
  Modal,
  Popover,
  Toolbar,
  ToolbarSpacer,
} from "@/arkcase";
import {formatTimestamp, sourceDriftDescription} from "@/lib/presentation";
import {PagePicker} from "@/ui/review-ui";

import {htmlPages} from "./page-inventory.ts";
import type {ReviewDownload, VersionListItem} from "./workspace-types.ts";

/** The Annotate / Interact toggle for the in-frame annotation surface. */
export interface AnnotateToggle {
  readonly active: boolean;
  /** Shown only for an HTML preview in annotate view to a reviewer who may comment. */
  readonly available: boolean;
  readonly onToggle: () => void;
}

export interface ReviewToolbarProps {
  readonly annotate: AnnotateToggle;
  readonly artifactName: string;
  readonly canManage: boolean;
  readonly details: ArtifactDetails | null;
  readonly download: ReviewDownload | null;
  readonly linkedArtifacts: boolean;
  readonly onCapture: () => Promise<void>;
  readonly onDelete: () => Promise<boolean>;
  readonly onEnterFocus: () => void;
  readonly onOpenCatalog: () => void;
  /** Phones have a comments sheet instead of the inspector rail. */
  readonly onOpenComments: () => void;
  /** Opens Comparison and history; null until that view exists (Task 16). */
  readonly onOpenComparison: (() => void) | null;
  readonly onOpenLive: () => Promise<void>;
  readonly onOpenRawArtifact: () => void;
  readonly onSelectPath: (path: string) => void;
  readonly onSelectVersion: (versionId: string) => void;
  readonly opening: boolean;
  readonly phone: boolean;
  readonly projectName: string;
  readonly selectedPath: string | null;
  readonly selectedVersion: ArtifactVersion | null;
  /** The Share control for this toolbar instance. */
  readonly share: ReactNode;
  readonly versions: readonly VersionListItem[];
}

const toolbarStyle = {
  background: "var(--surface-card)",
  borderBottom: "1px solid var(--border-color)",
  flex: "none",
  padding: "7px 12px",
} satisfies CSSProperties;
const titleStyle = {
  flex: "0 1 auto",
  fontSize: 17,
  lineHeight: 1.3,
  margin: 0,
  minWidth: 60,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} satisfies CSSProperties;
const anchorStyle = {display: "inline-flex", flex: "none", position: "relative"} satisfies CSSProperties;
const pagePickerStyle = {display: "inline-flex", flex: "0 1 auto", minWidth: 0} satisfies CSSProperties;
const popoverTextStyle = {color: "var(--text-secondary)", fontSize: 12, lineHeight: 1.55, margin: 0} satisfies CSSProperties;
const buttonRowStyle = {alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8} satisfies CSSProperties;
const pathStyle = {color: "var(--text-data)", fontFamily: "var(--font-data)", overflowWrap: "anywhere"} satisfies CSSProperties;
const dialogTextStyle = {fontSize: "var(--font-size-sm, 14px)", lineHeight: 1.5, margin: "0 0 12px"} satisfies CSSProperties;

const driftLabels = {
  "in-sync": "Source in sync",
  missing: "Source missing",
  modified: "Source modified",
  unreadable: "Source unreadable",
} satisfies Record<SourceFreshness, string>;

/** The toolbar over the canvas: identity, exact version and page, and the artifact's actions. */
export function ReviewToolbar({
  annotate,
  artifactName,
  canManage,
  details,
  download,
  linkedArtifacts,
  onCapture,
  onDelete,
  onEnterFocus,
  onOpenCatalog,
  onOpenComments,
  onOpenComparison,
  onOpenLive,
  onOpenRawArtifact,
  onSelectPath,
  onSelectVersion,
  opening,
  phone,
  projectName,
  selectedPath,
  selectedVersion,
  share,
  versions,
}: ReviewToolbarProps) {
  const [versionMenuOpen, setVersionMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [pagePickerOpen, setPagePickerOpen] = useState(false);
  const [pageQuery, setPageQuery] = useState("");
  const [pageLimit, setPageLimit] = useState(50);
  const [driftOpen, setDriftOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const shown = selectedVersion?.version ?? null;
  const currentVersionId = details?.artifact.currentVersionId ?? null;
  const pages = selectedVersion === null
    ? []
    : htmlPages(selectedVersion.manifest.entryPath, selectedVersion.manifest.entries);
  const binding = details?.sourceBinding ?? null;
  const liveAvailable = linkedArtifacts && details?.links.live !== undefined;

  return (
    <>
      <Toolbar gap={8} label="Artifact" style={toolbarStyle} wrap={phone}>
        {phone ? (
          <IconButton
            ariaLabel={`Back to ${projectName}`}
            icon="bi-arrow-left"
            onClick={onOpenCatalog}
            size="sm"
          />
        ) : null}
        <h1 style={titleStyle}>{artifactName}</h1>
        {shown === null ? null : (
          <span style={anchorStyle}>
            <Button
              aria-label={`Choose version, showing v${shown.number} of ${versions.length}${shown.id === currentVersionId ? ", current" : ""}`}
              expanded={versionMenuOpen}
              hasPopup="menu"
              iconRight="bi-chevron-down"
              onClick={() => setVersionMenuOpen((open) => !open)}
              outline
              size="sm"
              style={{fontFamily: "var(--font-data)"}}
              variant="secondary"
            >
              {shown.id === currentVersionId ? `v${shown.number}` : `v${shown.number} · not current`}
            </Button>
            <Menu
              align="start"
              items={[
                {heading: "Version"},
                ...versions.map(({version}) => ({
                  checked: version.id === shown.id,
                  description: formatTimestamp(version.createdAt),
                  label: `Version ${version.number}`,
                  meta: version.id === currentVersionId ? "Current" : null,
                  onClick: () => onSelectVersion(version.id),
                  type: "radio" as const,
                })),
                ...(onOpenComparison === null ? [] : [
                  {divider: true},
                  {icon: "bi-clock-history", label: "Comparison and history", onClick: onOpenComparison},
                ]),
              ]}
              label="Version"
              onClose={() => setVersionMenuOpen(false)}
              open={versionMenuOpen}
              style={{maxHeight: 360, overflowY: "auto"}}
              width={270}
            />
          </span>
        )}
        {pages.length === 0 || selectedVersion === null ? null : (
          <span style={pagePickerStyle}>
            <PagePicker
              limit={pageLimit}
              onLoadMore={() => setPageLimit((limit) => limit + 50)}
              onOpenChange={(open) => {
                setPagePickerOpen(open);
                setPageQuery("");
                setPageLimit(50);
              }}
              onQueryChange={(value) => {
                setPageQuery(value);
                setPageLimit(50);
              }}
              onSelect={onSelectPath}
              open={pagePickerOpen}
              pages={[...pages]}
              phone={phone}
              query={pageQuery}
              value={selectedPath ?? selectedVersion.manifest.entryPath}
            />
          </span>
        )}
        {binding === null || binding.status === "in-sync" ? null : (
          <Popover
            contentStyle={{gap: 10, padding: 12}}
            label="Source file modified on disk"
            onOpenChange={setDriftOpen}
            open={driftOpen}
            trigger={(
              <Button
                aria-label="Source file modified on disk"
                icon="bi-exclamation-triangle-fill"
                size="sm"
                variant="outline-warning"
              >
                {phone ? null : driftLabels[binding.status]}
              </Button>
            )}
            width={330}
            zIndex={1200}
          >
            <strong>Source file modified on disk</strong>
            <p style={popoverTextStyle}>{sourceDriftDescription(binding.status, "captured")}</p>
            <p style={{...popoverTextStyle, ...pathStyle}}>{binding.path}</p>
            <div style={buttonRowStyle}>
              {canManage ? (
                <Button
                  icon="bi-camera"
                  onClick={() => {
                    setDriftOpen(false);
                    void onCapture();
                  }}
                  size="sm"
                >
                  Capture current file
                </Button>
              ) : null}
              {liveAvailable ? (
                <Button icon="bi-box-arrow-up-right" onClick={() => void onOpenLive()} outline size="sm" variant="secondary">
                  Open live file
                </Button>
              ) : null}
            </div>
          </Popover>
        )}
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
        <Button
          aria-label={opening ? "Opening raw artifact" : "Open raw artifact"}
          disabled={selectedVersion === null || opening}
          icon="bi-box-arrow-up-right"
          onClick={onOpenRawArtifact}
          outline
          size="sm"
          variant="secondary"
        >
          {phone ? null : opening ? "Opening…" : "Open raw artifact"}
        </Button>
        {download === null ? (
          <Button aria-label="Download" disabled icon="bi-download" outline size="sm" variant="secondary">
            {phone ? null : "Download"}
          </Button>
        ) : (
          <Button
            aria-label="Download"
            download
            href={download.href}
            icon="bi-download"
            outline
            size="sm"
            title={download.title}
            variant="secondary"
          >
            {phone ? null : "Download"}
          </Button>
        )}
        {share}
        <Button
          aria-label="Full screen"
          disabled={selectedVersion === null}
          icon="bi-arrows-fullscreen"
          keyshortcuts="F"
          onClick={onEnterFocus}
          size="sm"
          title="Full screen (F)"
        >
          {phone ? null : "Full screen"}
        </Button>
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
        {canManage && details !== null ? (
          <span style={anchorStyle}>
            <IconButton
              ariaLabel="More artifact actions"
              expanded={moreMenuOpen}
              hasPopup="menu"
              icon="bi-three-dots-vertical"
              onClick={() => setMoreMenuOpen((open) => !open)}
              size="sm"
            />
            <Menu
              align="end"
              items={[{
                danger: true,
                icon: "bi-trash",
                label: "Delete artifact",
                onClick: () => setDeleteOpen(true),
              }]}
              label="More artifact actions"
              onClose={() => setMoreMenuOpen(false)}
              open={moreMenuOpen}
              width={240}
            />
          </span>
        ) : null}
      </Toolbar>
      {details === null ? null : (
        <DeleteArtifactDialog
          artifactName={details.artifact.name}
          key={details.artifact.id}
          onClose={() => setDeleteOpen(false)}
          onConfirm={onDelete}
          open={deleteOpen}
        />
      )}
    </>
  );
}

interface DeleteArtifactDialogProps {
  readonly artifactName: string;
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<boolean>;
  readonly open: boolean;
}

/** Name-typed confirmation before the artifact leaves normal use (was TombstoneArtifactControl). */
function DeleteArtifactDialog({artifactName, onClose, onConfirm, open}: DeleteArtifactDialogProps) {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const close = (): void => {
    if (pending) return;
    setValue("");
    onClose();
  };
  const confirm = async (): Promise<void> => {
    if (value !== artifactName) return;
    setPending(true);
    const removed = await onConfirm();
    setPending(false);
    if (removed) {
      setValue("");
      onClose();
    }
  };
  return (
    <Modal
      onClose={close}
      open={open}
      portal
      primaryAction={{
        disabled: pending || value !== artifactName,
        icon: "bi-trash",
        label: pending ? "Deleting…" : "Delete artifact",
        onClick: () => void confirm(),
        variant: "danger",
      }}
      size="sm"
      title={`Delete ${artifactName}?`}
    >
      <p style={dialogTextStyle}>
        This removes the artifact from normal use but retains its immutable version records. Type the artifact name to confirm.
      </p>
      <Input autoFocus label="Artifact name" onChange={(event) => setValue(event.currentTarget.value)} value={value} />
    </Modal>
  );
}
