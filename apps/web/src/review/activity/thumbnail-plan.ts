import type {ActivityEntry} from "@/api/client";
import {reviewAnchorSchema} from "@/review-frame/protocol";

export type ThumbnailPlan =
  | {readonly kind: "frame"; readonly path: string}
  | {readonly kind: "tile"; readonly reason: "not-html" | "no-anchor" | "no-artifact"};

/** Decide, before any request, whether a conversation's screen can be drawn at all. */
export function thumbnailPlan(entry: ActivityEntry, entryPath: string | null): ThumbnailPlan {
  const thread = entry.thread;
  if (thread === undefined || entry.artifact === null || entry.project === null) return {kind: "tile", reason: "no-artifact"};
  const path = thread.path ?? entryPath;
  if (path === null || !/\.html?$/iu.test(path)) return {kind: "tile", reason: "not-html"};
  const anchor = reviewAnchorSchema.safeParse(thread.anchor);
  if (!anchor.success || anchor.data.htmlAnchor === null) return {kind: "tile", reason: "no-anchor"};
  return {kind: "frame", path};
}
