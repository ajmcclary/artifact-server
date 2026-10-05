/** One artifact's current version and the preview paths to date. */
export interface LibraryDatesRequest {
  readonly artifactId: string;
  readonly currentVersionNumber: number;
  readonly paths: readonly string[];
}

/** Raw dates for one page; the service derives activity and applies the fallback. */
export interface LibraryPageDates {
  readonly artifactId: string;
  readonly changedAt: string;
  readonly commentedAt: string | null;
  readonly createdAt: string;
  readonly path: string;
}

/** Computes page dates from version and comment history. */
export interface LibraryDatesStore {
  libraryPageDates(requests: readonly LibraryDatesRequest[]): Promise<readonly LibraryPageDates[]>;
}
