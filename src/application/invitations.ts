import {Context, Effect, Layer} from "effect";

import {attributionOf} from "../core/action-attribution.js";
import {
  type ArtifactRepositoryFailure,
  AuthorizationDenied,
  IdentityConflict,
  type IdentityNotFound,
  type IdentityRepositoryFailure,
  InvalidInvite,
  InvitesUnavailable,
  VersionNotFound,
} from "../core/errors.js";
import {
  isHumanAdministrator,
  membershipRoles,
  type MembershipRole,
  type Principal,
} from "../core/identity.js";
import type {InstallationMember, ListedMember} from "../core/installation-identity.js";
import type {CreateInviteRecord, RevokeInviteRecord} from "../core/invitation-ports.js";
import {
  type AdministeredInvite,
  type Invite,
  type InviteDestination,
  inviteIdFromToken,
  inviteKinds,
  type InviteKind,
  type InviteLifetime,
  inviteLifetimes,
  inviteStatus,
  inviteStatuses,
  type InviteStatus,
  inviteTokenFor,
  inviteTokenPrefix,
  inviteWelcomePath,
  type ListedInvite,
  maskInviteEmail,
  maximumInviteUses,
  type StoredInvite,
} from "../core/invitations.js";
import {identitySecretsEqual, type IdentitySecretProvider} from "./installation-access.js";
import type {LoginHints} from "./interactive-login.js";

export interface InvitationRepositoryEffects {
  readonly createInvite: (record: CreateInviteRecord) => Effect.Effect<Invite, IdentityRepositoryFailure>;
  readonly findInvite: (
    installationId: string,
    inviteId: string,
  ) => Effect.Effect<StoredInvite | null, IdentityRepositoryFailure>;
  readonly findMember: (
    installationId: string,
    memberId: string,
  ) => Effect.Effect<InstallationMember | null, IdentityRepositoryFailure>;
  readonly listInvites: (installationId: string) => Effect.Effect<readonly ListedInvite[], IdentityRepositoryFailure>;
  readonly listMembers: (installationId: string) => Effect.Effect<readonly ListedMember[], IdentityRepositoryFailure>;
  readonly revokeInvite: (
    record: RevokeInviteRecord,
  ) => Effect.Effect<Invite, IdentityConflict | IdentityNotFound | IdentityRepositoryFailure>;
}

/** Names an invite destination for preview; null when it no longer exists. */
export interface InviteDestinations {
  readonly describe: (
    destination: InviteDestination,
  ) => Effect.Effect<{readonly artifactName: string; readonly versionNumber: number} | null, ArtifactRepositoryFailure>;
}

export interface InvitationDependencies {
  readonly clock: {readonly now: () => Date};
  readonly destinations: InviteDestinations;
  /** False when no interactive identity provider is configured. */
  readonly enabled: boolean;
  readonly ids: {readonly inviteId: () => string};
  readonly installationId: string;
  readonly repository: InvitationRepositoryEffects;
  readonly secrets: IdentitySecretProvider;
}

export interface CreateInviteCommand {
  readonly email?: string | undefined;
  readonly expiresIn: InviteLifetime;
  readonly kind: InviteKind;
  readonly maxUses?: number | undefined;
  readonly opens?: InviteDestination | undefined;
  readonly principal: Principal;
  readonly role?: MembershipRole | undefined;
}

export interface IssuedInvite {
  readonly invite: AdministeredInvite;
  /** Returned once; only its digest is stored. */
  readonly token: string;
}

export type InvitePreview =
  | {readonly status: "invalid"}
  | {
    readonly expiresAt: string;
    readonly inviterName: string | null;
    readonly kind: InviteKind;
    readonly maskedEmail: string | null;
    readonly opens: {readonly artifactName: string; readonly versionNumber: number} | null;
    readonly role: MembershipRole;
    readonly status: InviteStatus;
    readonly usesLeft: number;
  };

/** A preview of an invite whose token matched. */
export type ActiveInvitePreview = Exclude<InvitePreview, {readonly status: "invalid"}>;

export type InviteLoginPlan =
  | {readonly hints: LoginHints; readonly inviteId: string; readonly kind: "start"; readonly returnTo: string}
  | {readonly kind: "unavailable"; readonly preview: InvitePreview};

export interface InvitationOperations {
  readonly create: (command: CreateInviteCommand) => Effect.Effect<
    IssuedInvite,
    | ArtifactRepositoryFailure
    | AuthorizationDenied
    | IdentityConflict
    | IdentityRepositoryFailure
    | InvalidInvite
    | InvitesUnavailable
    | VersionNotFound
  >;
  readonly list: (principal: Principal) => Effect.Effect<
    readonly AdministeredInvite[],
    AuthorizationDenied | IdentityRepositoryFailure | InvitesUnavailable
  >;
  readonly planLogin: (token: string, forceSignIn: boolean) => Effect.Effect<
    InviteLoginPlan,
    ArtifactRepositoryFailure | IdentityRepositoryFailure | InvitesUnavailable
  >;
  readonly preview: (token: string) => Effect.Effect<
    InvitePreview,
    ArtifactRepositoryFailure | IdentityRepositoryFailure
  >;
  readonly revoke: (principal: Principal, inviteId: string) => Effect.Effect<
    AdministeredInvite,
    AuthorizationDenied | IdentityConflict | IdentityNotFound | IdentityRepositoryFailure | InvitesUnavailable
  >;
}

/** Administrator-issued invites: issuance, listing, revocation and public preview. */
export class InvitationService extends Context.Service<InvitationService, InvitationOperations>()(
  "artifact-server/application/InvitationService",
) {
  static readonly layer = (dependencies: InvitationDependencies): Layer.Layer<InvitationService> =>
    Layer.succeed(InvitationService, makeInvitationService(dependencies));
}

function makeInvitationService(dependencies: InvitationDependencies): InvitationOperations {
  const requireEnabled = dependencies.enabled
    ? Effect.void
    : Effect.fail(new InvitesUnavailable({
      message: "Invites need an identity provider; this installation has none.",
    }));

  const requireAdministrator = (principal: Principal) =>
    principal.installationId === dependencies.installationId && isHumanAdministrator(principal)
      ? Effect.void
      : Effect.fail(new AuthorizationDenied({message: "An Artifact Server administrator is required."}));

  const administered = (invite: ListedInvite): AdministeredInvite =>
    Object.assign({}, invite, {status: inviteStatus(invite, dependencies.clock.now())});

  const create = Effect.fn("InvitationService.create")(function*(command: CreateInviteCommand) {
    yield* requireEnabled;
    yield* requireAdministrator(command.principal);
    if (!Object.hasOwn(inviteLifetimes, command.expiresIn)) {
      return yield* new InvalidInvite({message: "Choose an expiry of 24 hours, 7 days or 30 days."});
    }
    let email: string | null = null;
    let role: MembershipRole = command.role ?? membershipRoles.member;
    let maxUses: number;
    if (command.kind === inviteKinds.person) {
      if (command.maxUses !== undefined && command.maxUses !== 1) {
        return yield* new InvalidInvite({message: "A one-person invite works once."});
      }
      const normalized = (command.email ?? "").trim().toLocaleLowerCase("en-US");
      if (normalized.length < 3 || normalized.length > 320 || !normalized.includes("@")) {
        return yield* new InvalidInvite({message: "A valid email address is required."});
      }
      const members = yield* dependencies.repository.listMembers(dependencies.installationId);
      if (members.some((member) => member.email === normalized)) {
        return yield* new IdentityConflict({message: "That email already belongs to a member."});
      }
      email = normalized;
      maxUses = 1;
    } else {
      if (command.email !== undefined) {
        return yield* new InvalidInvite({message: "A link invite does not name an email."});
      }
      if (role !== membershipRoles.member) {
        return yield* new InvalidInvite({message: "A link invite only admits members."});
      }
      role = membershipRoles.member;
      maxUses = command.maxUses ?? 0;
      if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > maximumInviteUses) {
        return yield* new InvalidInvite({message: `A link invite allows 1 to ${maximumInviteUses} uses.`});
      }
    }
    const opens = command.opens ?? null;
    if (opens !== null && (yield* dependencies.destinations.describe(opens)) === null) {
      return yield* new VersionNotFound({message: "The invite destination version does not exist."});
    }
    const now = dependencies.clock.now();
    const id = dependencies.ids.inviteId();
    const token = inviteTokenFor(id, dependencies.secrets.issue());
    const stored: StoredInvite = {
      createdAt: now.toISOString(),
      createdByPrincipalId: command.principal.id,
      email,
      expiresAt: new Date(now.getTime() + inviteLifetimes[command.expiresIn]).toISOString(),
      id,
      installationId: dependencies.installationId,
      kind: command.kind,
      maxUses,
      opens,
      revokedAt: null,
      revokedByPrincipalId: null,
      role,
      secretDigest: dependencies.secrets.digest(token),
      tokenPrefix: inviteTokenPrefix(id),
      useCount: 0,
    };
    const invite = yield* dependencies.repository.createInvite({
      attribution: attributionOf(command.principal),
      invite: stored,
    });
    return {invite: administered({...invite, createdByName: command.principal.displayName}), token};
  });

  const list = Effect.fn("InvitationService.list")(function*(principal: Principal) {
    yield* requireEnabled;
    yield* requireAdministrator(principal);
    const invites = yield* dependencies.repository.listInvites(dependencies.installationId);
    return invites.map(administered);
  });

  const revoke = Effect.fn("InvitationService.revoke")(function*(principal: Principal, inviteId: string) {
    yield* requireEnabled;
    yield* requireAdministrator(principal);
    const invite = yield* dependencies.repository.revokeInvite({
      attribution: attributionOf(principal),
      installationId: dependencies.installationId,
      inviteId,
      revokedAt: dependencies.clock.now().toISOString(),
    });
    const creator = yield* dependencies.repository.findMember(
      dependencies.installationId,
      invite.createdByPrincipalId,
    );
    return administered({...invite, createdByName: creator?.displayName ?? null});
  });

  /** The stored invite a token names, only when its secret matches. */
  const resolve = Effect.fn("InvitationService.resolve")(function*(token: string) {
    if (!dependencies.enabled) return null;
    const inviteId = inviteIdFromToken(token);
    if (inviteId === null) return null;
    const stored = yield* dependencies.repository.findInvite(dependencies.installationId, inviteId);
    if (stored === null) return null;
    return identitySecretsEqual(dependencies.secrets.digest(token), stored.secretDigest) ? stored : null;
  });

  const describe = Effect.fn("InvitationService.describe")(function*(stored: StoredInvite) {
    const [inviter, opens] = yield* Effect.all([
      dependencies.repository.findMember(dependencies.installationId, stored.createdByPrincipalId),
      stored.opens === null ? Effect.succeed(null) : dependencies.destinations.describe(stored.opens),
    ]);
    const preview: ActiveInvitePreview = {
      expiresAt: stored.expiresAt,
      inviterName: inviter?.displayName ?? null,
      kind: stored.kind,
      maskedEmail: stored.email === null ? null : maskInviteEmail(stored.email),
      opens,
      role: stored.role,
      status: inviteStatus(stored, dependencies.clock.now()),
      usesLeft: Math.max(0, stored.maxUses - stored.useCount),
    };
    return preview;
  });

  const preview = Effect.fn("InvitationService.preview")(function*(token: string) {
    const stored = yield* resolve(token);
    if (stored === null) return {status: "invalid"} satisfies InvitePreview;
    return yield* describe(stored);
  });

  const planLogin = Effect.fn("InvitationService.planLogin")(function*(token: string, forceSignIn: boolean) {
    yield* requireEnabled;
    const stored = yield* resolve(token);
    if (stored === null) {
      return {kind: "unavailable", preview: {status: "invalid"}} satisfies InviteLoginPlan;
    }
    const summary = yield* describe(stored);
    if (summary.status !== inviteStatuses.active) {
      return {kind: "unavailable", preview: summary} satisfies InviteLoginPlan;
    }
    // A link invite usually reaches someone new; a one-person invite knows the email.
    const audience: LoginHints = stored.email === null
      ? {screenHint: "sign-up"}
      : {loginHint: stored.email};
    const hints: LoginHints = forceSignIn ? {...audience, forceSignIn: true} : audience;
    return {
      hints,
      inviteId: stored.id,
      kind: "start",
      returnTo: inviteWelcomePath(summary.opens === null ? null : stored.opens),
    } satisfies InviteLoginPlan;
  });

  return InvitationService.of({create, list, planLogin, preview, revoke});
}
