import type {MemberAdmission} from "./identity-ports.js";

import type {
  MembershipRole,
  PrincipalCapability,
  PrincipalKind,
} from "./identity.js";

/** Serialized form shared by every persisted Artifact Server managed API key. */
export const managedApiKeyCredentialPattern =
  /^as_key_(key_[0-9a-f-]+)_([A-Za-z0-9_-]{32,})$/u;

/** Installation member lifecycle states. */
export const memberStatuses = {
  active: "active",
  inactive: "inactive",
} as const;

/** One installation member lifecycle state. */
export type MemberStatus =
  (typeof memberStatuses)[keyof typeof memberStatuses];

/** A person explicitly admitted to one Artifact Server installation. */
export interface InstallationMember {
  readonly createdAt: string;
  readonly displayName: string;
  readonly email: string;
  readonly id: string;
  readonly installationId: string;
  readonly role: MembershipRole;
  readonly status: MemberStatus;
  readonly updatedAt: string;
}

/** Administrator-facing member record with admission and activity facts. */
export interface ListedMember extends InstallationMember {
  /** Null for members admitted before admission was recorded. */
  readonly admittedHow: MemberAdmission | null;
  readonly admittedByName: string | null;
  readonly lastActiveAt: string | null;
}

/** Identity information returned by a configured interactive-login provider. */
export interface ExternalIdentity {
  readonly displayName: string;
  readonly email: string;
  readonly emailVerified: boolean;
  /** True only when the provider explicitly asserted email verification. */
  readonly emailVerificationAsserted?: boolean;
  readonly provider: string;
  readonly subject: string;
}

/** One server-side browser session after its opaque credential is verified. */
export interface ApplicationSession {
  readonly createdAt: string;
  readonly csrfDigest: string;
  readonly expiresAt: string;
  readonly id: string;
  readonly installationId: string;
  readonly member: InstallationMember;
  readonly revokedAt: string | null;
  readonly tokenDigest: string;
}

/** One persisted browser-login attempt. */
export interface LoginAttempt {
  readonly codeVerifier: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** The invite this login redeems; null for an ordinary sign-in. */
  readonly inviteId: string | null;
  readonly nonce: string | null;
  readonly provider: string;
  readonly returnTo: string;
  readonly stateDigest: string;
}

/** Metadata for a managed Artifact Server API key. */
export interface ManagedApiKey {
  readonly authorizedByPrincipalId: string;
  readonly capabilities: readonly PrincipalCapability[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly id: string;
  readonly installationId: string;
  readonly name: string;
  readonly prefix: string;
  readonly principalId: string;
  readonly principalKind: PrincipalKind;
  readonly revokedAt: string | null;
  readonly rotatedFromId: string | null;
}

/** Managed-key metadata plus its stored secret digest. */
export interface StoredManagedApiKey extends ManagedApiKey {
  readonly secretDigest: string;
}

/** Administrator-facing key record with use and revocation facts. */
export interface ListedApiKey extends ManagedApiKey {
  readonly lastUsedAt: string | null;
  /** The owning member's display name; null for a service key. */
  readonly ownerName: string | null;
  /** Actor of the newest revoke or rotate action on this key, when recorded. */
  readonly revokedByName: string | null;
}

/** Lifecycle shown for one managed API key. */
export const apiKeyStatuses = {
  active: "active",
  expired: "expired",
  revoked: "revoked",
} as const;

export type ApiKeyStatus = (typeof apiKeyStatuses)[keyof typeof apiKeyStatuses];

/** Administrator-facing key record with its status at one instant. */
export interface AdministeredApiKey extends ListedApiKey {
  readonly status: ApiKeyStatus;
}

/** Revocation wins over expiry; a key expires at its exact expiry instant. */
export function apiKeyStatus(key: ManagedApiKey, now: Date): ApiKeyStatus {
  if (key.revokedAt !== null) return apiKeyStatuses.revoked;
  return Date.parse(key.expiresAt) <= now.getTime()
    ? apiKeyStatuses.expired
    : apiKeyStatuses.active;
}

/** An application session credential returned once to the browser adapter. */
export interface IssuedApplicationSession {
  readonly csrfToken: string;
  readonly session: ApplicationSession;
  readonly token: string;
}

/** A managed API key credential returned exactly once. */
export interface IssuedManagedApiKey {
  readonly apiKey: ManagedApiKey;
  readonly token: string;
}
