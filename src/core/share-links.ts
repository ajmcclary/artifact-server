import type {AccessPolicy} from "./access-policy.js";
import {GuestIdentityRequired, ShareLinkInvalid} from "./errors.js";
import {
  allPermissions,
  guestHoldablePermissions,
  permissions,
  type Permission,
} from "./permissions.js";
import {stripInvisibleControls} from "./untrusted-text.js";

/** Longest a share-link label may be, in characters. */
export const maximumShareLinkLabelLength = 80;
/** Longest a guest display name may be, in characters. */
export const maximumGuestDisplayNameLength = 60;
/** Longest a guest session lasts when its link does not expire sooner. */
export const guestSessionLifetimeDays = 30;

/** Which version a share link opens. */
export type ShareLinkTarget =
  | {readonly kind: "latest"}
  | {readonly kind: "pinned"; readonly versionId: string};

/** One share link: bounded Review access to one artifact for people without an account. */
export interface ShareLink {
  readonly artifactId: string;
  readonly createdAt: string;
  readonly createdByName: string;
  readonly createdByPrincipalId: string;
  readonly expiresAt: string | null;
  /** Rotation increments it; a guest who joined under an older generation is ended. */
  readonly generation: number;
  readonly guestCount: number;
  readonly id: string;
  readonly label: string;
  readonly permissions: readonly Permission[];
  readonly projectId: string;
  readonly revision: number;
  readonly revokedAt: string | null;
  readonly target: ShareLinkTarget;
  readonly token: string;
}

/** One person who opened a share link, known by the name they gave. */
export interface GuestRecord {
  readonly contactEmail: string | null;
  readonly createdAt: string;
  /** Null until the guest names themselves to comment. */
  readonly displayName: string | null;
  readonly generation: number;
  readonly id: string;
  readonly shareLinkId: string;
}

/** One browser session of one guest. */
export interface GuestSessionRecord {
  readonly expiresAt: string;
  readonly guestId: string;
  readonly id: string;
  readonly revokedAt: string | null;
}

/**
 * Normalize and check a link's permissions: non-empty, including view,
 * guest-holdable only, inside the policy's guest maximum, and comment writing
 * only with comment reading.
 */
export function validateShareLinkPermissions(
  requested: readonly Permission[],
  policy: AccessPolicy,
): readonly Permission[] | ShareLinkInvalid {
  const included = new Set(requested);
  const normalized = allPermissions.filter((permission) => included.has(permission));
  if (!included.has(permissions.artifactView)) {
    return new ShareLinkInvalid({message: "A share link must let people open the artifact."});
  }
  const outside = normalized.filter((permission) => !guestHoldablePermissions.has(permission));
  if (outside.length > 0) {
    return new ShareLinkInvalid({message: `A share link cannot grant ${outside.join(", ")}.`});
  }
  const beyondPolicy = normalized.filter((permission) => !policy.shareLinks.guestPermissionsMax.includes(permission));
  if (beyondPolicy.length > 0) {
    return new ShareLinkInvalid({message: `Installation policy does not allow guests to hold ${beyondPolicy.join(", ")}.`});
  }
  if (included.has(permissions.commentWrite) && !included.has(permissions.commentRead)) {
    return new ShareLinkInvalid({message: "Guests who write comments must also be able to read them."});
  }
  return normalized;
}

/** Whether a link still admits guests at `now`. */
export function isShareLinkActive(link: Pick<ShareLink, "expiresAt" | "revokedAt">, now: string): boolean {
  return link.revokedAt === null && (link.expiresAt === null || link.expiresAt > now);
}

/** When a guest session that starts at `now` ends: with its link, or after thirty days. */
export function guestSessionExpiry(link: Pick<ShareLink, "expiresAt">, now: string): string {
  const longest = new Date(Date.parse(now) + guestSessionLifetimeDays * 86_400_000).toISOString();
  return link.expiresAt !== null && link.expiresAt < longest ? link.expiresAt : longest;
}

/** A guest's name with invisible controls removed, trimmed and bounded. */
export function normalizeGuestDisplayName(raw: string): string | GuestIdentityRequired {
  const name = stripInvisibleControls(raw).trim();
  if (name.length === 0 || name.length > maximumGuestDisplayNameLength) {
    return new GuestIdentityRequired({
      message: `Enter a name between 1 and ${maximumGuestDisplayNameLength} characters.`,
    });
  }
  return name;
}

/** A link label with invisible controls removed, trimmed and bounded. */
export function normalizeShareLinkLabel(raw: string): string | ShareLinkInvalid {
  const label = stripInvisibleControls(raw).trim();
  if (label.length === 0 || label.length > maximumShareLinkLabelLength) {
    return new ShareLinkInvalid({
      message: `A share-link label must contain between 1 and ${maximumShareLinkLabelLength} characters.`,
    });
  }
  return label;
}
