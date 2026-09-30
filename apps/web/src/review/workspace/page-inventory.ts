/** One HTML page of an exact version, as the page picker lists it. */
export interface ReviewPage {
  readonly group: string;
  readonly isDefault: boolean;
  readonly name: string;
  readonly path: string;
}

/** A declared media type without parameters, lower-cased (`text/html`). */
export function mediaTypeEssence(mediaType: string): string {
  return mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/** The version's HTML entries in manifest order, grouped by their first folder path. */
export function htmlPages(
  entryPath: string,
  entries: readonly {readonly mediaType: string; readonly path: string}[],
): readonly ReviewPage[] {
  return entries
    .filter((entry) => mediaTypeEssence(entry.mediaType) === "text/html")
    .map((entry) => {
      const slash = entry.path.lastIndexOf("/");
      return {
        group: slash < 0 ? "Top level" : entry.path.slice(0, slash),
        isDefault: entry.path === entryPath,
        name: slash < 0 ? entry.path : entry.path.slice(slash + 1),
        path: entry.path,
      };
    });
}
