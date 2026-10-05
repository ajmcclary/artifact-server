import type {LibraryItem} from "@/ui/review-ui";

import type {GalleryIndexItem} from "../workspace/design-gallery.ts";

import type {PageDates} from "./gallery-dates.ts";

export * from "./gallery-dates.ts";

/** One artifact's readable gallery at the version that was current when the library loaded. */
export interface LibrarySource {
  readonly artifactId: string;
  readonly artifactName: string;
  /** Dates per page path, derived from version and comment records. */
  readonly dates: ReadonlyMap<string, PageDates>;
  readonly indexTitle: string;
  readonly items: readonly GalleryIndexItem[];
  readonly projectId: string;
  readonly projectName: string;
  readonly versionId: string;
}

/** Identities repeat paths across artifacts, so the library keys every item by both. */
export function libraryItemId(artifactId: string, path: string): string {
  return `${artifactId}\u001f${path}`;
}

export function parseLibraryItemId(id: string): {readonly artifactId: string; readonly path: string} | null {
  const separator = id.indexOf("\u001f");
  if (separator <= 0 || separator === id.length - 1) return null;
  return {artifactId: id.slice(0, separator), path: id.slice(separator + 1)};
}

/**
 * Merge every artifact's gallery into one list. Kinds stay authoritative; each tile
 * names its project and its gallery, and carries the dates its source derived.
 */
export function libraryItems(
  sources: readonly LibrarySource[],
  media: (source: LibrarySource, path: string) => string,
): LibraryItem[] {
  return sources.flatMap((source) => source.items.map((item): LibraryItem => {
    const dates = source.dates.get(item.path);
    return {
      activityAt: dates?.activityAt ?? Number.NaN,
      createdAt: dates?.createdAt ?? Number.NaN,
      description: item.description,
      gallery: source.indexTitle,
      id: libraryItemId(source.artifactId, item.path),
      kind: item.kind,
      path: item.path,
      project: source.projectName,
      thumbnailUrl: item.thumbnailPath === null ? null : media(source, item.thumbnailPath),
      title: item.title,
      viewport: item.viewport,
    };
  }));
}
