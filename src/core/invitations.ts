import {membershipRoles, type MembershipRole} from "./identity.js";
import {type InstallationMember, memberStatuses} from "./installation-identity.js";

/** The two kinds of invite an administrator can issue. */
export const inviteKinds = {
  link: "link",
  person: "person",
} as const;

/** One invite kind. */
export type InviteKind = (typeof inviteKinds)[keyof typeof inviteKinds];

/** Lifecycle shown for one invite at one instant; never stored. */
export const inviteStatuses = {
  active: "active",
  expired: "expired",
  revoked: "revoked",
  used: "used",
} as const;

/** One invite status. */
export type InviteStatus = (typeof inviteStatuses)[keyof typeof inviteStatuses];

/** The only lifetimes an administrator may choose, in milliseconds. */
export const inviteLifetimes = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
} as const;

/** One offered invite lifetime. */
export type InviteLifetime = keyof typeof inviteLifetimes;

/** Upper bound on a link invite's uses. */
export const maximumInviteUses = 100;

/** The exact version an invite lands on after joining. */
export interface InviteDestination {
  readonly artifactId: string;
  readonly projectId: string;
  readonly versionId: string;
}

/** One administrator-issued invite, without its secret digest. */
export interface Invite {
  readonly createdAt: string;
  readonly createdByPrincipalId: string;
  /** Normalized email for a one-person invite; null for a link invite. */
  readonly email: string | null;
  readonly expiresAt: string;
  readonly id: string;
  readonly installationId: string;
  readonly kind: InviteKind;
  readonly maxUses: number;
  readonly opens: InviteDestination | null;
  readonly revokedAt: string | null;
  readonly revokedByPrincipalId: string | null;
  readonly role: MembershipRole;
  /** `as_inv_<inviteId>`: identifies the token without its secret. */
  readonly tokenPrefix: string;
  readonly useCount: number;
}

/** An invite plus the SHA-256 digest of its token. */
export interface StoredInvite extends Invite {
  readonly secretDigest: string;
}

/** Administrator-facing invite with its creator's display name. */
export interface ListedInvite extends Invite {
  readonly createdByName: string | null;
}

/** Listed invite plus its status at one instant. */
export interface AdministeredInvite extends ListedInvite {
  readonly status: InviteStatus;
}

/** Revocation wins, then a spent cap, then expiry at its exact instant. */
export function inviteStatus(
  invite: Pick<Invite, "expiresAt" | "maxUses" | "revokedAt" | "useCount">,
  now: Date,
): InviteStatus {
  if (invite.revokedAt !== null) return inviteStatuses.revoked;
  if (invite.useCount >= invite.maxUses) return inviteStatuses.used;
  return Date.parse(invite.expiresAt) <= now.getTime()
    ? inviteStatuses.expired
    : inviteStatuses.active;
}

/** Serialized invite credential: `as_inv_<inv_uuid>_<secret>`. */
export const inviteCredentialPattern =
  /^as_inv_(inv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]{32,128})$/u;

/** The full token for one invite id and freshly issued secret. */
export function inviteTokenFor(inviteId: string, secret: string): string {
  return `as_inv_${inviteId}_${secret}`;
}

/** The invite id inside a well-formed token, or null. */
export function inviteIdFromToken(token: string): string | null {
  return inviteCredentialPattern.exec(token)?.[1] ?? null;
}

/** The display prefix stored beside the digest; it never contains the secret. */
export function inviteTokenPrefix(inviteId: string): string {
  return `as_inv_${inviteId}`;
}

/** First character and domain only, with a fixed-length mask so length leaks nothing. */
export function maskInviteEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "••••••";
  return `${email.slice(0, 1)}••••••${email.slice(at)}`;
}

/** Why an invite did not admit anyone; carried to `/review/join?outcome=`. */
export const inviteOutcomes = {
  accountUnavailable: "account_unavailable",
  expired: "expired",
  invalid: "invalid",
  revoked: "revoked",
  unverified: "unverified",
  used: "used",
  wrongAccount: "wrong_account",
} as const;

/** One refusal outcome. */
export type InviteOutcome = (typeof inviteOutcomes)[keyof typeof inviteOutcomes];

/** Plain sentences for each refusal; safe to show to the invitee. */
export const inviteOutcomeMessages = {
  account_unavailable: "This account cannot join. It may belong to a deactivated member.",
  expired: "This invite link has expired.",
  invalid: "This invite link is incomplete or was changed.",
  revoked: "This invite link was revoked.",
  unverified: "Your sign-in provider has not verified this email address.",
  used: "This invite link has already been used.",
  wrong_account: "This invite is for a different email address.",
} as const satisfies Readonly<Record<InviteOutcome, string>>;

const statusOutcomes = {
  expired: inviteOutcomes.expired,
  revoked: inviteOutcomes.revoked,
  used: inviteOutcomes.used,
} as const satisfies Readonly<Record<Exclude<InviteStatus, "active">, InviteOutcome>>;

/** The refusal outcome for an invite that is no longer active. */
export function outcomeForStatus(
  status: Exclude<InviteStatus, "active">,
): InviteOutcome {
  return statusOutcomes[status];
}

/** Null when this verified email may redeem the invite at `at`; otherwise why not. */
export function redemptionRefusal(
  invite: StoredInvite | null,
  normalizedEmail: string,
  at: string,
): InviteOutcome | null {
  if (invite === null) return inviteOutcomes.invalid;
  const status = inviteStatus(invite, new Date(at));
  if (status !== inviteStatuses.active) return outcomeForStatus(status);
  if (invite.kind === inviteKinds.person && invite.email !== normalizedEmail) {
    return inviteOutcomes.wrongAccount;
  }
  return null;
}

/** The review URL an invite lands on; Projects when it names no version. */
export function inviteDestinationPath(destination: InviteDestination | null): string {
  if (destination === null) return "/review/projects";
  return `/review?${new URLSearchParams({
    artifact: destination.artifactId,
    project: destination.projectId,
    version: destination.versionId,
    view: "focus",
  })}`;
}

/** Where a successful invite login returns: the welcome screen, then the destination. */
export function inviteWelcomePath(destination: InviteDestination | null): string {
  return `/review/join?${new URLSearchParams({next: inviteDestinationPath(destination)})}`;
}

/** The activity-log subject; never contains the token. */
export function inviteActivitySubject(
  invite: Pick<Invite, "email" | "kind" | "maxUses">,
): string {
  if (invite.kind === inviteKinds.person) {
    return `invite for ${invite.email ?? "one person"}`;
  }
  return `invite link (${invite.maxUses} ${invite.maxUses === 1 ? "use" : "uses"})`;
}

/** Whether a member may still stand behind the invites they issued. */
export function isActiveAdministrator(member: InstallationMember | null): boolean {
  return member !== null && member.status === memberStatuses.active &&
    member.role === membershipRoles.administrator;
}
