import {DateTime, Effect} from "effect";

import type {AccessPolicy} from "../core/access-policy.js";
import type {ArtifactRepositoryFailure} from "../core/errors.js";
import {isShareLinkActive, type GuestRecord, type ShareLink} from "../core/share-links.js";
import type {ApplicationClock} from "./application-clock.js";
import type {AccessRepositoryEffects} from "./authorization.js";
import type {ShareLinkRepositoryEffects} from "./share-links.js";

/** A guest whose link still admits them, with the policy that bounds them. */
export interface ActiveGuest {
  readonly guest: GuestRecord;
  readonly link: ShareLink;
  readonly policy: AccessPolicy;
}

/** What deciding a guest's validity reads. */
export interface GuestValidityDependencies {
  readonly access: Pick<AccessRepositoryEffects, "readAccessPolicy">;
  readonly clock: ApplicationClock;
  readonly installationId: string;
  readonly shareLinks: Pick<ShareLinkRepositoryEffects, "findGuest">;
}

/**
 * Resolve a guest freshly on every request: the link must be active, unrotated
 * since the guest joined, and allowed by policy. No result is ever cached, so a
 * revoke, rotation, expiry, or policy change applies on the next request.
 */
export const resolveActiveGuest = Effect.fnUntraced(function*(
  dependencies: GuestValidityDependencies,
  guestId: string,
): Effect.fn.Return<ActiveGuest | null, ArtifactRepositoryFailure> {
  const found = yield* dependencies.shareLinks.findGuest(dependencies.installationId, guestId);
  if (found === null) return null;
  const now = DateTime.formatIso(yield* dependencies.clock.now);
  if (!isShareLinkActive(found.link, now) || found.guest.generation !== found.link.generation) return null;
  const {policy} = yield* dependencies.access.readAccessPolicy(dependencies.installationId);
  if (!policy.shareLinks.enabled) return null;
  return {guest: found.guest, link: found.link, policy};
});
