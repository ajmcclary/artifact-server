import {useId, useState, type CSSProperties} from "react";

import type {ArtifactAction, ArtifactComparison, ComparedFile} from "@/api/client";
import {
  Alert,
  Button,
  DiffLines,
  IconButton,
  RecordTable,
  SectionHeading,
  Select,
  SurfaceState,
  Tabs,
} from "@/arkcase";
import {actionLabel, formatTimestamp} from "@/lib/presentation";

import {compactId} from "./workspace-format.ts";
import type {ComparisonTab, VersionListItem} from "./workspace-types.ts";

export interface ComparisonViewProps {
  readonly actions: readonly ArtifactAction[];
  readonly activityError: Error | null;
  readonly activityLoading: boolean;
  readonly activityNextCursor: string | null;
  readonly artifactName: string;
  readonly comparison: ArtifactComparison | null;
  readonly comparisonError: Error | null;
  readonly comparisonLoading: boolean;
  readonly currentVersionId: string;
  readonly onBack: () => void;
  readonly onCompare: (fromVersionId: string, toVersionId: string) => Promise<void>;
  readonly onLoadMoreActivity: () => void;
  readonly onTabChange: (tab: ComparisonTab) => void;
  readonly tab: ComparisonTab;
  readonly versions: readonly VersionListItem[];
}

interface ChangedEntry {
  readonly file: ComparedFile | null;
  readonly kind: "Added" | "Changed" | "Removed" | "Renamed";
  readonly path: string;
}

const viewStyle = {
  display: "flex",
  flex: "1 1 auto",
  flexDirection: "column",
  gap: 10,
  minHeight: 0,
  padding: "12px 16px",
} satisfies CSSProperties;
const panelStyle = {
  display: "flex",
  flex: "1 1 auto",
  flexDirection: "column",
  gap: 14,
  maxWidth: 1000,
  minHeight: 0,
  overflowY: "auto",
  paddingBottom: 24,
} satisfies CSSProperties;
const selectRowStyle = {alignItems: "flex-end", display: "flex", flexWrap: "wrap", gap: 10} satisfies CSSProperties;
const summaryStyle = {color: "var(--text-data)", fontFamily: "var(--font-data)", fontSize: 12, margin: 0} satisfies CSSProperties;

function changedEntries(comparison: ArtifactComparison): readonly ChangedEntry[] {
  return [
    ...comparison.added.map((entry) => ({file: null, kind: "Added" as const, path: entry.path})),
    ...comparison.changed.map((entry) => ({file: entry, kind: "Changed" as const, path: entry.after.path})),
    ...comparison.removed.map((entry) => ({file: null, kind: "Removed" as const, path: entry.path})),
    ...comparison.renamed.map((entry) => ({
      file: null,
      kind: "Renamed" as const,
      path: `${entry.from.path} → ${entry.to.path}`,
    })),
  ];
}

function diffEmptyMessage(file: ComparedFile): string {
  if (file.detail.kind === "text") return "No text changes recorded for this path.";
  return file.detail.reason === "text_limit_exceeded"
    ? "This file is too large to show changed lines."
    : "This file is binary or not valid UTF-8, so no lines are shown.";
}

/** Compare two exact versions, or read the artifact's attributed action history. */
export function ComparisonView({
  actions,
  activityError,
  activityLoading,
  activityNextCursor,
  artifactName,
  comparison,
  comparisonError,
  comparisonLoading,
  currentVersionId,
  onBack,
  onCompare,
  onLoadMoreActivity,
  onTabChange,
  tab,
  versions,
}: ComparisonViewProps) {
  const ids = useId();
  const [fromVersionId, setFromVersionId] = useState(versions.at(-1)?.version.id ?? currentVersionId);
  const [toVersionId, setToVersionId] = useState(currentVersionId);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const entries = comparison === null ? [] : changedEntries(comparison);
  const selected = entries.find((entry) => entry.path === selectedPath)
    ?? entries.find((entry) => entry.file !== null)
    ?? null;
  const selectedFile = selected?.file ?? null;
  const change = selectedFile !== null && selectedFile.detail.kind === "text" ? selectedFile.detail.change : null;
  const versionOptions = versions.map(({version}) => ({label: `Version ${version.number}`, value: version.id}));

  return (
    <section aria-label="Comparison and history" style={viewStyle}>
      <SectionHeading level={2} meta={artifactName} size="sm" title="Comparison and history">
        <Button icon="bi-chevron-left" onClick={onBack} outline size="sm" variant="secondary">
          Back to the preview
        </Button>
      </SectionHeading>
      <Tabs
        active={tab}
        onChange={(id) => {
          if (id === "compare" || id === "activity") onTabChange(id);
        }}
        tabs={[
          {id: "compare", label: "Compare", panelId: `${ids}-compare`, tabId: `${ids}-compare-tab`},
          {id: "activity", label: "Activity", panelId: `${ids}-activity`, tabId: `${ids}-activity-tab`},
        ]}
      />
      <div aria-labelledby={`${ids}-${tab}-tab`} id={`${ids}-${tab}`} role="tabpanel" style={panelStyle} tabIndex={0}>
        {tab === "compare" ? (
          <>
            {versions.length < 2 ? (
              <SurfaceState
                count={0}
                emptyBody="Publish another version to compare it with this one."
                emptyTitle="Only one version"
                noun="versions"
                phase="ready"
              />
            ) : (
              <div style={selectRowStyle}>
                <Select
                  label="Base version"
                  onChange={(event) => setFromVersionId(event.currentTarget.value)}
                  options={versionOptions}
                  size="sm"
                  value={fromVersionId}
                />
                <IconButton
                  ariaLabel="Swap the two versions"
                  icon="bi-arrow-left-right"
                  onClick={() => {
                    setFromVersionId(toVersionId);
                    setToVersionId(fromVersionId);
                  }}
                  size="sm"
                  variant="light"
                />
                <Select
                  label="Compared version"
                  onChange={(event) => setToVersionId(event.currentTarget.value)}
                  options={versionOptions}
                  size="sm"
                  value={toVersionId}
                />
                <Button
                  disabled={comparisonLoading || fromVersionId === toVersionId}
                  onClick={() => void onCompare(fromVersionId, toVersionId)}
                  size="sm"
                >
                  {comparisonLoading ? "Comparing…" : "Compare"}
                </Button>
              </div>
            )}
            {comparisonError === null ? null : <Alert variant="danger">{comparisonError.message}</Alert>}
            {comparison === null ? null : (
              <>
                <p style={summaryStyle}>
                  Version {comparison.from.number} → {comparison.to.number}: {comparison.added.length} added · {comparison.changed.length} changed · {comparison.removed.length} removed · {comparison.renamed.length} renamed · {comparison.unchangedCount} unchanged
                </p>
                <SectionHeading count={entries.length} level={3} size="sm" title="Changed files" />
                <RecordTable
                  ariaLabel="Changed files"
                  columns={[
                    {key: "kind", label: "Change", width: "120px"},
                    {key: "path", label: "Path", mono: true},
                  ]}
                  empty="These versions have the same files."
                  onRowSelect={(row, index) => setSelectedPath(entries[index]?.path ?? null)}
                  rowKey={(row, index) => entries[index]?.path ?? String(index)}
                  rows={entries.map((entry) => ({kind: entry.kind, path: entry.path}))}
                  selectedKey={selected?.path ?? null}
                />
                {selectedFile === null ? null : (
                  <>
                    <SectionHeading level={3} size="sm" title="Changed lines" />
                    <DiffLines
                      empty={diffEmptyMessage(selectedFile)}
                      label={`Changed lines in ${selectedFile.after.path}`}
                      lines={change === null ? [] : [
                        ...change.before.map((text, index) => ({mark: "-" as const, n: change.beforeStartLine + index, text})),
                        ...change.after.map((text, index) => ({mark: "+" as const, n: change.afterStartLine + index, text})),
                      ]}
                    />
                  </>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <SectionHeading count={actions.length} level={3} size="sm" title="Action history" />
            {activityError === null ? null : <Alert variant="danger">{activityError.message}</Alert>}
            {actions.length === 0 && activityLoading ? (
              <SurfaceState loadingStyle="spinner" loadingTitle="Loading activity…" noun="actions" phase="loading" />
            ) : null}
            {actions.length === 0 && !activityLoading ? (
              <SurfaceState count={0} emptyTitle="No activity recorded." noun="actions" phase="ready" />
            ) : null}
            {actions.length === 0 ? null : (
              <RecordTable
                ariaLabel="Artifact activity"
                columns={[
                  {key: "action", label: "Action"},
                  {key: "when", label: "When", mono: true},
                  {key: "principal", label: "Principal", mono: true},
                ]}
                rowKey={(row, index) => actions[index]?.id ?? String(index)}
                rows={actions.map((action) => ({
                  action: actionLabel(action.action),
                  principal: compactId(action.principalId),
                  when: formatTimestamp(action.createdAt),
                }))}
              />
            )}
            {activityNextCursor === null ? null : (
              <Button disabled={activityLoading} onClick={onLoadMoreActivity} outline size="sm" variant="secondary">
                {activityLoading ? "Loading…" : "Load more"}
              </Button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
