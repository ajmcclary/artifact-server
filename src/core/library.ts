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

/** One preview tile, renderable without further reads. Dates are ISO 8601. */
export interface LibraryGalleryItem {
  readonly activityAt: string;
  readonly createdAt: string;
  readonly description: string;
  readonly kind: string;
  readonly path: string;
  readonly related: readonly {readonly path: string; readonly title: string}[];
  readonly section: string;
  readonly thumbnailPath: string | null;
  readonly title: string;
  readonly viewport: {readonly height: number; readonly width: number};
}

/** One artifact's gallery at the version that was current when the response was assembled. */
export interface LibraryGallery {
  readonly artifactId: string;
  readonly artifactName: string;
  readonly indexTitle: string;
  readonly items: readonly LibraryGalleryItem[];
  readonly projectId: string;
  readonly projectName: string;
  readonly versionId: string;
}

/** Every readable gallery across the caller's projects. */
export interface LibraryResponse {
  readonly galleries: readonly LibraryGallery[];
  readonly generatedAt: string;
  /** True when the artifact cap was reached; the Library shows a partial view. */
  readonly truncated: boolean;
  /** Artifacts whose preview index exists but cannot be read, by artifact name. */
  readonly unreadable: readonly string[];
}
