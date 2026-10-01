import type {Project} from "@/api/client";
import {usDate} from "@/ui/activity-model";

/** The project list pane's remembered pin and width, under the review panel store. */
export const projectListPanelId = "project-list";

/** One project's counts from `GET /api/v1/activity/summary`. */
export interface ProjectSummaryCounts {
  readonly artifactCount: number;
  readonly id: string;
  readonly lastActivityAt: string | null;
  readonly unresolved: number;
}

/** One row of the Projects list; counts are null when the summary did not load. */
export interface ProjectRow {
  readonly archived: boolean;
  readonly artifactCount: number | null;
  readonly id: string;
  readonly lastActivityAt: string | null;
  readonly name: string;
  readonly unresolved: number;
}

/** Active projects first, then archived, each group in server order, filtered by name. */
export function projectRows(
  projects: readonly Project[],
  summaries: readonly ProjectSummaryCounts[] | null,
  query: string,
): ProjectRow[] {
  const needle = query.trim().toLocaleLowerCase();
  const counts = new Map((summaries ?? []).map((summary) => [summary.id, summary]));
  return projects
    .filter((project) => needle === "" || project.name.toLocaleLowerCase().includes(needle))
    .toSorted((left, right) => Number(left.archivedAt !== null) - Number(right.archivedAt !== null))
    .map((project) => {
      const summary = counts.get(project.id);
      return {
        archived: project.archivedAt !== null,
        artifactCount: summary?.artifactCount ?? null,
        id: project.id,
        lastActivityAt: summary?.lastActivityAt ?? null,
        name: project.name,
        unresolved: summary?.unresolved ?? 0,
      };
    });
}

/** "N artifacts · MM/DD/YYYY", or null when counts are unknown. */
export function projectRowMeta(row: ProjectRow): string | null {
  if (row.artifactCount === null) return null;
  const count = `${row.artifactCount} ${row.artifactCount === 1 ? "artifact" : "artifacts"}`;
  const instant = row.lastActivityAt === null ? Number.NaN : Date.parse(row.lastActivityAt);
  return Number.isNaN(instant) ? count : `${count} · ${usDate(instant)}`;
}

/** The pane footer: "x of y" while searching, otherwise the total. */
export function projectListFooter(shown: number, total: number, query: string): string {
  if (query.trim() !== "") return `${shown} of ${total}`;
  return `${total} ${total === 1 ? "project" : "projects"}`;
}

/**
 * The project the screen shows. A named project is kept even when unknown, so
 * the detail can say it was not found instead of silently showing another.
 */
export function initialProjectId(projects: readonly Project[], requested: string | null): string | null {
  if (requested !== null) return requested;
  return projects.find((project) => project.archivedAt === null)?.id ?? projects[0]?.id ?? null;
}
