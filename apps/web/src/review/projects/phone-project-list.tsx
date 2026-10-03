import type {CSSProperties} from "react";

import {CountBadge, IconButton, SectionHeading, SelectableRow, StatusPill, SurfaceState} from "@/arkcase";

import {projectRowMeta, type ProjectRow} from "./projects-model.ts";

export interface PhoneProjectListProps {
  readonly onAdd: () => void;
  readonly onSelect: (projectId: string) => void;
  readonly rows: readonly ProjectRow[];
}

/**
 * A phone's Projects tab: the project list as a page of its own, scrolled by
 * the document. A row opens that project's settings one level down; ‹ Projects
 * returns here at the offset it was left.
 */
export function PhoneProjectList({onAdd, onSelect, rows}: PhoneProjectListProps) {
  return (
    <section aria-label="Projects" data-phone-projects="" style={pageStyle}>
      <header style={headerStyle}>
        <SectionHeading
          level={1}
          meta={`${rows.length} ${rows.length === 1 ? "project" : "projects"}`}
          size="lg"
          title="Projects"
        >
          <IconButton ariaLabel="New project" icon="bi-folder-plus" onClick={onAdd} size="sm" variant="primary" />
        </SectionHeading>
      </header>
      {rows.length === 0 ? (
        <SurfaceState
          actionIcon="bi-plus-lg"
          actionLabel="New project"
          count={0}
          emptyBody="Create a project to publish artifacts into it."
          emptyIcon="bi-briefcase"
          emptyTitle="No projects yet"
          noun="projects"
          onAction={onAdd}
          phase="ready"
          titleLevel={2}
          variant="dashed"
        />
      ) : (
        <ul aria-label="Projects" style={listStyle}>
          {rows.map((row) => {
            const meta = projectRowMeta(row);
            return (
              <li key={row.id}>
                <SelectableRow as="button" onSelect={() => onSelect(row.id)} padding="11px 14px" selected={false} style={rowStyle}>
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
      )}
    </section>
  );
}

const pageStyle: CSSProperties = {background: "var(--surface-canvas, #F1F5F7)", padding: "0 16px 32px"};
const headerStyle: CSSProperties = {padding: "20px 0 12px"};
const listStyle: CSSProperties = {
  background: "var(--surface-card, #fff)",
  border: "1px solid var(--border-color, #DEE2E6)",
  borderRadius: "var(--radius-md, 5px)",
  boxShadow: "var(--shadow-card, 0 1px 3px rgba(7, 54, 82, 0.10))",
  listStyle: "none",
  margin: 0,
  overflow: "hidden",
  padding: 0,
};
const rowStyle: CSSProperties = {
  borderBottom: "1px solid var(--list-divider, #E9ECEF)",
  display: "flex",
  flexDirection: "column",
  minHeight: 56,
  textAlign: "left",
  width: "100%",
};
const rowTitleStyle: CSSProperties = {alignItems: "baseline", display: "flex", gap: 8};
const rowNameStyle: CSSProperties = {flex: "1 1 auto", fontSize: 15, fontWeight: 600, lineHeight: 1.35, minWidth: 0, overflowWrap: "anywhere"};
const rowMetaStyle: CSSProperties = {
  alignItems: "center",
  color: "var(--text-secondary, #5A6268)",
  display: "flex",
  flexWrap: "wrap",
  fontSize: 12,
  gap: 8,
  marginTop: 5,
};
