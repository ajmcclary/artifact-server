import type {VersionListEntry, VersionMenuEntry} from "@/ui/review-ui";
import {formatTimestamp} from "@/lib/presentation";

import {compactId} from "./workspace-format.ts";
import type {VersionListItem} from "./workspace-types.ts";

/*
 * The version API names each publisher only by principal id, so the rows lead with the
 * saved time where the design shows the author, and the version id stands in for the
 * secondary line. Both stay searchable in "Find a version".
 */

/** Rows for the toolbar's version menu, newest first, the current version tagged. */
export function versionMenuEntries(
  versions: readonly VersionListItem[],
  currentVersionId: string | null,
): VersionMenuEntry[] {
  return newestFirst(versions).map(({version}) => ({
    by: formatTimestamp(version.createdAt),
    current: version.id === currentVersionId,
    date: compactId(version.id),
    n: version.number,
  }));
}

/** Rows for the Versions panel, newest first, the current version tagged. */
export function versionListEntries(
  versions: readonly VersionListItem[],
  currentVersionId: string | null,
): VersionListEntry[] {
  return newestFirst(versions).map(({version}) => ({
    by: formatTimestamp(version.createdAt),
    current: version.id === currentVersionId,
    n: version.number,
    when: compactId(version.id),
  }));
}

function newestFirst(versions: readonly VersionListItem[]): VersionListItem[] {
  return versions.toSorted((left, right) => right.version.number - left.version.number);
}
