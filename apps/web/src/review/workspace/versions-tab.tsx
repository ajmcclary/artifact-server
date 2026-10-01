import {useState} from "react";

import {ConfirmDialog} from "@/arkcase";
import {VersionList} from "@/ui/review-ui";

import {versionListEntries} from "./version-entries.ts";
import type {VersionListItem} from "./workspace-types.ts";

export interface VersionsTabProps {
  readonly artifactName: string;
  readonly canManage: boolean;
  readonly currentVersionId: string;
  readonly onCompare: (fromVersionId: string, toVersionId: string) => void;
  readonly onMakeCurrent: (versionId: string, expectedCurrentVersionId: string) => Promise<boolean>;
  readonly onOpenHistory: () => void;
  readonly onSelect: (versionId: string) => void;
  readonly phone: boolean;
  readonly selectedVersionId: string | null;
  readonly versions: readonly VersionListItem[];
}

/** Rows shown before Show Older; each press adds another page. */
const versionPage = 20;

/**
 * The artifact's immutable history, newest first. Each row previews its version; Preview
 * and More (Make Current, Compare with vN, Action History) appear on hover or focus.
 */
export function VersionsTab({
  artifactName,
  canManage,
  currentVersionId,
  onCompare,
  onMakeCurrent,
  onOpenHistory,
  onSelect,
  phone,
  selectedVersionId,
  versions,
}: VersionsTabProps) {
  const [limit, setLimit] = useState(versionPage);
  const [pendingCurrent, setPendingCurrent] = useState<number | null>(null);
  const entries = versionListEntries(versions, currentVersionId);
  const idOf = new Map(versions.map(({version}) => [version.number, version.id]));
  const shown = versions.find(({version}) => version.id === selectedVersionId)?.version.number ?? 0;
  const current = versions.find(({version}) => version.id === currentVersionId)?.version.number ?? null;
  const remaining = Math.max(0, entries.length - limit);
  const compare = (left: number, right: number): void => {
    const from = idOf.get(Math.min(left, right));
    const to = idOf.get(Math.max(left, right));
    if (from !== undefined && to !== undefined) onCompare(from, to);
  };
  return (
    <>
      <VersionList
        label={`Versions of ${artifactName}`}
        menuItems={(entry) => {
          const other = entry.current ? (entry.n > 1 ? entry.n - 1 : null) : current;
          return [
            ...(entry.current || !canManage ? [] : [{
              icon: "bi-bookmark-check",
              label: "Make Current",
              onClick: () => setPendingCurrent(entry.n),
            }]),
            ...(other === null || !idOf.has(other) ? [] : [{
              icon: "bi-file-diff",
              label: `Compare with v${other}`,
              onClick: () => compare(entry.n, other),
            }]),
            {icon: "bi-clock-history", label: "Action History", onClick: onOpenHistory},
          ];
        }}
        olderLabel={`Show ${Math.min(versionPage, remaining)} Older`}
        onPreview={(n) => {
          const id = idOf.get(n);
          if (id !== undefined) onSelect(id);
        }}
        onShowOlder={() => setLimit((value) => value + versionPage)}
        phone={phone}
        remaining={remaining}
        shown={shown}
        versions={entries.slice(0, limit)}
      />
      <ConfirmDialog
        confirmIcon="bi-bookmark-check"
        confirmLabel="Make Current"
        message={`The stable artifact link will point to Version ${pendingCurrent ?? ""}. No saved version is changed or duplicated.`}
        onClose={() => setPendingCurrent(null)}
        onConfirm={() => {
          const id = pendingCurrent === null ? undefined : idOf.get(pendingCurrent);
          if (id !== undefined) void onMakeCurrent(id, currentVersionId);
        }}
        open={pendingCurrent !== null}
        title={`Make Version ${pendingCurrent ?? ""} current?`}
        tone="primary"
      />
    </>
  );
}
