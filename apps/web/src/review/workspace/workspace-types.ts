import type {Version} from "@/api/client";

/** One row of an artifact's immutable history, as `api.versions` returns it. */
export interface VersionListItem {
  readonly links: {readonly review: string; readonly version: string};
  readonly version: Version;
}

/** The one-click download for the selected version: its single file, or a ZIP. */
export interface ReviewDownload {
  readonly href: string;
  readonly title: string;
}

export type CatalogCommentFilter = "all" | "with" | "without";
export type CatalogRefreshState = "complete" | "idle" | "loading";
export type CatalogSort = "comments" | "newest";
export type InspectorTab = "comments" | "details" | "files" | "versions";
export type ComparisonTab = "activity" | "compare";
/** The inspector's views in rail order. */
export const inspectorTabs = [
  "comments",
  "files",
  "versions",
  "details",
] as const satisfies readonly InspectorTab[];
