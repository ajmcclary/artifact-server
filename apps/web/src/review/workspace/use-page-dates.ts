import {useEffect, useState} from "react";

import type {ArtifactVersion} from "@/api/client";
import {createRequestLimiter} from "@/lib/request-limiter";

import type {PageDates} from "../library/design-library.ts";
import {pageDatesFor} from "../library/page-dates.ts";

/** Reads one gallery's history at a time, as gently as the Library reads one of its galleries. */
const concurrentReads = 4;
const maximumCachedVersions = 64;

// A version's page dates only move when a comment lands, so a return to its gallery shows
// the last read at once while a fresh one runs.
const readDates = new Map<string, ReadonlyMap<string, PageDates>>();

interface Loaded {
  readonly dates: ReadonlyMap<string, PageDates>;
  readonly key: string;
}

/**
 * Created and last-activity dates for the pages of the version being viewed, read the
 * way the Library dates its galleries (`pageDatesFor`). Null while reading or when the
 * history cannot be read; tiles then hide their date line.
 */
export function usePageDates(
  projectId: string,
  artifactId: string | null,
  version: ArtifactVersion | null,
  paths: readonly string[] | null,
): ReadonlyMap<string, PageDates> | null {
  const versionId = version?.version.id ?? null;
  const pathKey = paths === null ? null : paths.join("\u001f");
  const key = artifactId === null || versionId === null || pathKey === null ? null : `${artifactId}\u001f${versionId}\u001f${pathKey}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    if (key === null || artifactId === null || version === null || paths === null) return undefined;
    let current = true;
    const limit = createRequestLimiter(concurrentReads);
    void (async () => {
      try {
        const dates = await pageDatesFor(limit, {
          artifactId,
          commentCount: null,
          manifest: version.manifest,
          paths,
          projectId,
          version: version.version,
        }, () => current);
        if (dates === null || !current) return;
        if (!readDates.has(key) && readDates.size >= maximumCachedVersions) {
          const oldest = readDates.keys().next();
          if (oldest.done !== true) readDates.delete(oldest.value);
        }
        readDates.set(key, dates);
        setLoaded({dates, key});
      } catch {
        // The gallery stays usable without dates.
      }
    })();
    return () => {
      current = false;
    };
    // The key names the version and its pages; immutable bytes cannot change underneath it.
  }, [key]);
  if (key === null) return null;
  return loaded?.key === key ? loaded.dates : readDates.get(key) ?? null;
}
