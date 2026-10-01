import type {GalleryItem} from "@/ui/review-ui";

import type {GalleryIndexItem} from "../workspace/design-gallery.ts";

/** One artifact's readable gallery at the version that was current when the library loaded. */
export interface LibrarySource {
  readonly artifactId: string;
  readonly artifactName: string;
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
 * Merge every artifact's gallery into one list. Kinds stay authoritative; each
 * section names its artifact's gallery so "Prototypes" groups by project.
 */
export function libraryItems(
  sources: readonly LibrarySource[],
  media: (source: LibrarySource, path: string) => string,
): GalleryItem[] {
  return sources.flatMap((source) => source.items.map((item): GalleryItem => {
    const tile: GalleryItem = {
      description: item.description,
      id: libraryItemId(source.artifactId, item.path),
      kind: item.kind,
      path: item.path,
      related: item.related.map((link) => ({
        id: libraryItemId(source.artifactId, link.path),
        path: link.path,
        title: link.title,
      })),
      section: `${source.indexTitle} · ${item.section}`,
      thumbnailUrl: item.thumbnailPath === null ? null : media(source, item.thumbnailPath),
      title: item.title,
      viewport: item.viewport,
    };
    // The section already names the gallery; add the artifact only when it reads differently.
    if (source.artifactName !== source.indexTitle) tile.context = source.artifactName;
    return tile;
  }));
}
