import {useState, type CSSProperties} from "react";

import type {Version} from "@/api/client";
import {ActionRow, Button, Modal} from "@/arkcase";
import {formatTimestamp} from "@/lib/presentation";

import {compactId} from "./workspace-format.ts";
import type {VersionListItem} from "./workspace-types.ts";

export interface VersionsTabProps {
  readonly canManage: boolean;
  readonly currentVersionId: string;
  readonly onMakeCurrent: (versionId: string, expectedCurrentVersionId: string) => Promise<boolean>;
  readonly onOpenComparison: () => void;
  readonly onSelect: (versionId: string) => void;
  readonly selectedVersionId: string | null;
  readonly versions: readonly VersionListItem[];
}

const listStyle = {listStyle: "none", margin: 0, padding: 0} satisfies CSSProperties;
const shownRowStyle = {background: "var(--tint-primary-selected)"} satisfies CSSProperties;
const plainRowStyle = {} satisfies CSSProperties;
const footerStyle = {padding: "12px 14px 16px"} satisfies CSSProperties;
const dialogTextStyle = {fontSize: "var(--font-size-sm, 14px)", lineHeight: 1.5, margin: 0} satisfies CSSProperties;

/** The artifact's immutable history, newest first, with preview and restore on each row. */
export function VersionsTab({
  canManage,
  currentVersionId,
  onMakeCurrent,
  onOpenComparison,
  onSelect,
  selectedVersionId,
  versions,
}: VersionsTabProps) {
  return (
    <div>
      <ul aria-label="Versions" style={listStyle}>
        {versions.map(({version}, index) => {
          const current = version.id === currentVersionId;
          const shown = version.id === selectedVersionId;
          return (
            <li key={version.id}>
              <ActionRow
                last={index === versions.length - 1}
                meta={`${formatTimestamp(version.createdAt)} · ${compactId(version.id)}`}
                note={current ? (shown ? "Current · shown" : "Current") : shown ? "Shown" : null}
                style={shown ? shownRowStyle : plainRowStyle}
                title={(
                  <Button
                    aria-current={shown ? "true" : undefined}
                    flush
                    onClick={() => onSelect(version.id)}
                    size="sm"
                    variant="link"
                  >
                    Version {version.number}
                  </Button>
                )}
              >
                {canManage && !current ? (
                  <MakeCurrentControl
                    expectedCurrentVersionId={currentVersionId}
                    onConfirm={onMakeCurrent}
                    version={version}
                  />
                ) : null}
              </ActionRow>
            </li>
          );
        })}
      </ul>
      <div style={footerStyle}>
        <Button icon="bi-clock-history" onClick={onOpenComparison} size="sm" variant="link">
          Comparison and history
        </Button>
      </div>
    </div>
  );
}

interface MakeCurrentControlProps {
  readonly expectedCurrentVersionId: string;
  readonly onConfirm: (versionId: string, expectedCurrentVersionId: string) => Promise<boolean>;
  readonly version: Version;
}

function MakeCurrentControl({expectedCurrentVersionId, onConfirm, version}: MakeCurrentControlProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const confirm = async (): Promise<void> => {
    setPending(true);
    await onConfirm(version.id, expectedCurrentVersionId);
    setPending(false);
    setOpen(false);
  };
  return (
    <>
      <Button onClick={() => setOpen(true)} size="xs" variant="link">Make current</Button>
      <Modal
        onClose={() => {
          if (!pending) setOpen(false);
        }}
        open={open}
        portal
        primaryAction={{
          disabled: pending,
          label: pending ? "Making current…" : "Make current",
          onClick: () => void confirm(),
        }}
        size="sm"
        title={`Make Version ${version.number} current?`}
      >
        <p style={dialogTextStyle}>
          The stable artifact link will point to Version {version.number}. No saved version is changed or duplicated.
        </p>
      </Modal>
    </>
  );
}
