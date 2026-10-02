/**
 * Types for the vendored, untyped page model (scripts/sync-arkcase-ds.mjs copies
 * workspace/projects/arkcase-artifacts/page-model.js without a declaration). Only the
 * functions the application's tests call are declared; the Library's filtering is pinned by
 * src/review/library/design-library.test.ts.
 */
declare module "@/arkcase/review-ui/page-model.js" {
  import type {GalleryKind, LibraryItem} from "@/arkcase/review-ui/review-ui.jsx";

  /**
   * Items whose kind is in `types` and whose project is in `projects` (an empty list allows
   * every value), and whose text matches `query`.
   */
  export function filterLibrary<Item extends LibraryItem>(
    items: readonly Item[],
    query?: string,
    types?: readonly GalleryKind[],
    projects?: readonly string[],
  ): Item[];
}
