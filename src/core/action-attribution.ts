import type {Principal} from "./identity.js";
import type {ActorSnapshot, CommentAuthor} from "./model.js";

/**
 * Who caused one installation-level mutation. A null actor and principal mark
 * a system mutation, such as automatic admission or the bootstrap key, so the
 * activity log never invents a person.
 */
export interface ActionAttribution {
  readonly actor: ActorSnapshot | null;
  readonly authorizedByPrincipalId: string | null;
  readonly principalId: string | null;
}

/** The display name and kind recorded with an action at write time. */
export function actorSnapshotOf(
  principal: Pick<Principal, "displayName" | "kind">,
): ActorSnapshot {
  return {displayName: principal.displayName, kind: principal.kind};
}

/** The same snapshot taken from a comment or dispatch author record. */
export function actorSnapshotOfAuthor(author: CommentAuthor): ActorSnapshot {
  return {displayName: author.displayName, kind: author.principalKind};
}

/** Attribution for a mutation one authenticated principal performed. */
export function attributionOf(principal: Principal): ActionAttribution {
  return {
    actor: actorSnapshotOf(principal),
    authorizedByPrincipalId: principal.authorizedByPrincipalId,
    principalId: principal.id,
  };
}

/** Attribution for a mutation no person performed. */
export const systemAttribution: ActionAttribution = Object.freeze({
  actor: null,
  authorizedByPrincipalId: null,
  principalId: null,
});
