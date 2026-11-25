import type {EffectiveAccess} from "@/api/client";

import {type Permission, roleLabel} from "../settings/project-access-model.ts";

/** The part of the server's effective access that decides whether a person may write comments. */
export interface CommentAccess {
  readonly permissions: ReadonlySet<Permission>;
  readonly sources: EffectiveAccess["sources"];
}

/**
 * Why this access cannot write in an artifact's conversations, as one sentence; null when it
 * can (UX-10). An archived project is named first; otherwise the role that decided the access.
 */
export function commentLockReason(access: CommentAccess, projectName: string, archived: boolean): string | null {
  const stateArchived = access.sources.some((source) => source.layer === "state" && source.reason === "archived");
  if (archived || stateArchived) return `${projectName} is archived, so its conversations are read-only.`;
  if (access.permissions.has("comment.write")) return null;
  if (access.sources.some((source) => source.layer === "state" && source.reason === "deleted")) {
    return "This artifact was deleted, so its conversations are read-only.";
  }
  const decided = access.sources.flatMap((source) =>
    source.layer === "project_default" || source.layer === "project_grant" || source.layer === "artifact_grant"
      ? [source.role]
      : []).at(-1);
  return decided === undefined
    ? "Your access lets you read these conversations but not write in them."
    : `You have ${roleLabel(decided)} access to ${projectName}: you can read these conversations but not write in them.`;
}
