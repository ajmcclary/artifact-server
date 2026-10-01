import type {ActivityEntry} from "@/api/client";
import {reviewAnchorSchema} from "@/review-frame/protocol";

export type ThumbnailPlan =
  | {readonly kind: "frame"; readonly path: string; readonly pin: boolean}
  | {readonly kind: "tile"; readonly reason: "not-html" | "no-artifact"};

/**
 * Decide, before any request, whether a conversation's screen can be drawn at all, and whether
 * its pin goes on it. A conversation with no pin on the page still draws its exact version.
 */
export function thumbnailPlan(entry: ActivityEntry, entryPath: string | null): ThumbnailPlan {
  const thread = entry.thread;
  if (thread === undefined || entry.artifact === null || entry.project === null) return {kind: "tile", reason: "no-artifact"};
  const path = thread.path ?? entryPath;
  if (path === null || !/\.html?$/iu.test(path)) return {kind: "tile", reason: "not-html"};
  const anchor = reviewAnchorSchema.safeParse(thread.anchor);
  return {kind: "frame", path, pin: anchor.success && anchor.data.htmlAnchor !== null};
}
