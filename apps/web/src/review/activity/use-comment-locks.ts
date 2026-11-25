import {useEffect, useMemo, useRef, useState} from "react";

import {api, type ActivityEntry} from "@/api/client";
import {createRequestLimiter} from "@/lib/request-limiter";

import {commentLockReason} from "../workspace/comment-lock.ts";
import type {Permission} from "../settings/project-access-model.ts";

/** One artifact the feed shows conversations for. */
interface CommentPlace {
  readonly artifactId: string;
  readonly projectId: string;
  readonly projectName: string;
}

const accessReads = createRequestLimiter(4);
const placeKey = (projectId: string, artifactId: string): string => `${projectId}\u0000${artifactId}`;

/** Each artifact with a conversation in the loaded entries, once. */
function commentPlaces(entries: readonly ActivityEntry[]): CommentPlace[] {
  const places = new Map<string, CommentPlace>();
  for (const entry of entries) {
    if (entry.thread === undefined || entry.artifact === null || entry.project === null) continue;
    const key = placeKey(entry.project.id, entry.artifact.id);
    if (!places.has(key)) places.set(key, {artifactId: entry.artifact.id, projectId: entry.project.id, projectName: entry.project.name});
  }
  return [...places.values()];
}

/**
 * Why the viewer cannot write in each artifact's conversations (UX-01), from the server's
 * effective access for that artifact, read once per artifact while the feed is mounted.
 * The answer is null while it loads or when the read fails: the controls stay, and the
 * server still refuses a write the access does not allow.
 */
export function useCommentLocks(entries: readonly ActivityEntry[]): (projectId: string, artifactId: string) => string | null {
  const [reasons, setReasons] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  // Keys already asked for; a read in flight lands after a refresh that changed `entries`.
  const requested = useRef(new Set<string>());
  const mounted = useRef(true);
  const places = useMemo(() => commentPlaces(entries), [entries]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    for (const place of places) {
      const key = placeKey(place.projectId, place.artifactId);
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      void (async () => {
        try {
          const access = await accessReads(() => api.effectiveAccess(place.projectId, place.artifactId));
          const reason = commentLockReason(
            {permissions: new Set<Permission>(access.permissions), sources: access.sources}, place.projectName, false,
          );
          if (mounted.current) setReasons((known) => new Map(known).set(key, reason));
        } catch {
          // Unknown access keeps the controls; the server refuses what it does not allow.
        }
      })();
    }
  }, [places]);

  return (projectId, artifactId) => reasons.get(placeKey(projectId, artifactId)) ?? null;
}
