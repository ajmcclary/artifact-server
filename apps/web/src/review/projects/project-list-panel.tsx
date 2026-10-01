import type {CSSProperties} from "react";

import {Button, CountBadge, Panel, RailHeader, SelectableRow, StatusPill, SurfaceState} from "@/arkcase";

import {catalogWidth} from "../workspace/workspace-layout.ts";
import {projectListFooter, projectListPanelId, projectRowMeta, type ProjectRow} from "./projects-model.ts";

export interface ProjectListPanelProps {
  readonly canPin: boolean;
  readonly onAdd: () => void;
  readonly onAnnounce: (text: string) => void;
  readonly onPeekChange: (peeking: boolean) => void;
  readonly onPinChange: (pinned: boolean) => void;
  readonly onQueryChange: (query: string) => void;
  readonly onSelect: (projectId: string) => void;
  readonly onSheetClose: () => void;
  readonly onWidthChange: (width: number | null) => void;
  readonly peeking: boolean;
  readonly pinned: boolean;
  readonly query: string;
  readonly rows: readonly ProjectRow[];
  readonly selectedId: string | null;
  readonly sheet: boolean;
  readonly total: number;
  readonly width: number | null;
}

/** The Projects list: the artifact catalog's Panel, header and rows, one row per project. */
export function ProjectListPanel({
  canPin,
  onAdd,
  onAnnounce,
  onPeekChange,
  onPinChange,
  onQueryChange,
  onSelect,
  onSheetClose,
  onWidthChange,
  peeking,
  pinned,
  query,
  rows,
  selectedId,
  sheet,
  total,
  width,
}: ProjectListPanelProps) {
  const header = (
    <>
      {sheet ? (
        <div style={sheetBackStyle}>
          <Button icon="bi-chevron-left" onClick={onSheetClose} size="sm" variant="link">Back</Button>
        </div>
      ) : null}
      <RailHeader
        addLabel="New project"
        headingLevel={2}
        onAdd={onAdd}
        onQuery={(event) => onQueryChange(event.currentTarget.value)}
        onQueryKeyDown={(event) => {
          if (event.key !== "Escape" || query === "") return;
          event.stopPropagation();
          onQueryChange("");
        }}
        query={query}
        queryLabel="Search projects"
        queryPlaceholder="Search projects"
        title="Projects"
      />
    </>
  );
  return (
    <Panel
      bodyStyle={{display: "flex", flexDirection: "column"}}
      canPin={canPin}
      count={total}
      countLabel={`${total} ${total === 1 ? "project" : "projects"}`}
      footerMeta={projectListFooter(rows.length, total, query)}
      header={header}
      icon="bi-folder2-open"
      id={projectListPanelId}
      maxWidth={catalogWidth.maximum}
      minWidth={catalogWidth.minimum}
      name="project list"
      onAnnounce={onAnnounce}
      onPeekChange={onPeekChange}
      onPinChange={onPinChange}
      onWidthChange={onWidthChange}
      peeking={peeking}
      pinned={pinned}
      railLabel="Projects"
      resizable
      sheet={sheet}
      width={width ?? catalogWidth.defaultWidth}
    >
      {({closePeek}) => (rows.length === 0 ? (
        <SurfaceState
          count={0}
          density="inline"
          filterBody="No project matches the search."
          filtered
          noun="projects"
          onClear={() => onQueryChange("")}
          phase="ready"
        />
      ) : (
        <ul aria-label="Projects" style={listStyle}>
          {rows.map((row) => {
            const meta = projectRowMeta(row);
            return (
              <li key={row.id}>
                <SelectableRow
                  as="button"
                  onSelect={() => {
                    closePeek();
                    onSelect(row.id);
                  }}
                  padding="11px 12px"
                  selected={row.id === selectedId}
                  style={rowStyle}
                >
                  <span style={rowTitleStyle}>
                    <strong style={rowNameStyle}>{row.name}</strong>
                    {row.archived ? <StatusPill label="Archived" tone="neutral" /> : null}
                  </span>
                  <span style={rowMetaStyle}>
                    {row.unresolved > 0
                      ? <CountBadge count={`${row.unresolved} unresolved`} mono={false} tone="primary" />
                      : null}
                    {meta === null ? null : <span>{meta}</span>}
                  </span>
                </SelectableRow>
              </li>
            );
          })}
        </ul>
      ))}
    </Panel>
  );
}

const sheetBackStyle: CSSProperties = {background: "var(--surface-secondary, #F8F9FA)", flex: "none", padding: "4px 8px 0"};
const listStyle: CSSProperties = {listStyle: "none", margin: 0, padding: 0};
const rowStyle: CSSProperties = {
  borderBottom: "1px solid var(--list-divider, #E9ECEF)",
  display: "flex",
  flexDirection: "column",
  minHeight: 44,
  textAlign: "left",
  width: "100%",
};
const rowTitleStyle: CSSProperties = {alignItems: "baseline", display: "flex", gap: 8};
const rowNameStyle: CSSProperties = {flex: "1 1 auto", fontSize: 14, fontWeight: 600, lineHeight: 1.35, minWidth: 0};
const rowMetaStyle: CSSProperties = {
  alignItems: "center",
  color: "var(--text-secondary, #5A6268)",
  display: "flex",
  flexWrap: "wrap",
  fontSize: 12,
  gap: 8,
  marginTop: 5,
};
