import {useEffect, useState} from "react";

import {api, type ArtifactVersion} from "@/api/client";

import {
  maximumPreviewIndexBytes,
  parsePreviewIndex,
  previewIndexEntry,
  previewIndexPath,
  type PreviewIndexResult,
} from "./design-gallery.ts";

export type PreviewIndexState =
  | {readonly status: "absent"}
  | {readonly status: "loading"}
  | PreviewIndexResult;

interface Loaded {
  readonly versionId: string;
  readonly state: PreviewIndexState;
}

/**
 * Read the exact version's preview index through the authorized version-file route.
 * Versions without one — including every publication made before indexes existed —
 * report `absent` and keep their own entry page.
 */
export function usePreviewIndex(
  projectId: string,
  artifactId: string | null,
  version: ArtifactVersion | null,
): PreviewIndexState {
  const entry = version === null ? null : previewIndexEntry(version.manifest);
  const versionId = entry === null || artifactId === null ? null : version?.version.id ?? null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    if (versionId === null || artifactId === null || entry === null || version === null) return undefined;
    if (entry.size > maximumPreviewIndexBytes) {
      setLoaded({versionId, state: {status: "invalid", reason: "The preview index is larger than Review reads."}});
      return undefined;
    }
    let current = true;
    const entries = version.manifest.entries;
    void (async () => {
      try {
        const text = await api.versionFile(projectId, artifactId, versionId, previewIndexPath);
        if (current) setLoaded({versionId, state: parsePreviewIndex(text, entries)});
      } catch {
        if (current) setLoaded({versionId, state: {status: "invalid", reason: "The preview index could not be read."}});
      }
    })();
    return () => {
      current = false;
    };
    // The version id names immutable bytes; its manifest cannot change underneath it.
  }, [artifactId, projectId, versionId]);
  if (versionId === null) return {status: "absent"};
  return loaded?.versionId === versionId ? loaded.state : {status: "loading"};
}
