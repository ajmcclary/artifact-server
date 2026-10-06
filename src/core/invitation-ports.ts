import type {ActionAttribution} from "./action-attribution.js";
import type {
  AdmitMemberRecord,
  BindExternalIdentityRecord,
} from "./identity-ports.js";
import type {InstallationMember} from "./installation-identity.js";
import type {
  Invite,
  InviteOutcome,
  ListedInvite,
  StoredInvite,
} from "./invitations.js";

/** Values persisted when an administrator issues one invite. */
export interface CreateInviteRecord {
  readonly attribution: ActionAttribution;
  readonly invite: StoredInvite;
}

/** Values persisted when an administrator revokes one active invite. */
export interface RevokeInviteRecord {
  readonly attribution: ActionAttribution;
  readonly installationId: string;
  readonly inviteId: string;
  readonly revokedAt: string;
}

/** Everything one redemption writes in a single transaction. */
export interface RedeemInviteRecord {
  /** `admittedHow: invite`; attributed to the inviting administrator. */
  readonly admission: AdmitMemberRecord;
  readonly binding: BindExternalIdentityRecord;
  /** The verified, normalized email of the person redeeming. */
  readonly email: string;
  readonly inviteId: string;
  readonly redeemedAt: string;
}

/** Either the new member, or why nothing was written. */
export type RedeemInviteResult =
  | {readonly kind: "admitted"; readonly member: InstallationMember}
  | {readonly kind: "refused"; readonly outcome: Exclude<InviteOutcome, "unverified">};

/** Invite persistence; every backend implements all of it atomically. */
export interface InvitationRepository {
  /** Store the invite and its `invite_create` row together. */
  createInvite(record: CreateInviteRecord): Promise<Invite>;
  findInvite(installationId: string, inviteId: string): Promise<StoredInvite | null>;
  /** Newest first, at most 200. */
  listInvites(installationId: string): Promise<readonly ListedInvite[]>;
  /**
   * Redeem one use, admit the member, bind the identity and write
   * `member_admit` and `invite_redeem` in one transaction, or write nothing.
   */
  redeemInvite(record: RedeemInviteRecord): Promise<RedeemInviteResult>;
  /**
   * Revoke an active invite and write `invite_revoke`. Throws IdentityNotFound
   * for an unknown invite and IdentityConflict for one that is not active.
   */
  revokeInvite(record: RevokeInviteRecord): Promise<Invite>;
}
