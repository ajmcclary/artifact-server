import type {LibraryGrouping, LibrarySort} from "@/ui/review-ui";

import type {GalleryKind} from "./preview-index.ts";

export * from "./preview-index.ts";

/** The gallery's grouping choices: the Library's, with Section in place of Project. */
export type GalleryGrouping = Exclude<LibraryGrouping, "project">;

/**
 * Host-owned gallery state, kept per exact version so a return restores it: every
 * toolbar choice the Library makes, plus where the reader was.
 */
export interface GalleryViewState {
  readonly collapsed: readonly string[];
  readonly focusPath: string | null;
  readonly groupBy: GalleryGrouping;
  readonly query: string;
  readonly scrollTop: number;
  readonly sortBy: LibrarySort;
  readonly sortDir: "asc" | "desc";
  readonly types: readonly GalleryKind[];
  readonly view: "grid" | "list";
}

/** One artifact's gallery opens grouped by kind and sorted by name, A to Z. */
export const initialGalleryViewState: GalleryViewState = {
  collapsed: [],
  focusPath: null,
  groupBy: "type",
  query: "",
  scrollTop: 0,
  sortBy: "name",
  sortDir: "asc",
  types: [],
  view: "grid",
};
