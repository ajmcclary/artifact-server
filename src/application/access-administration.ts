import {Context, DateTime, Effect, Layer} from "effect";

import {type AccessPolicy, type StoredAccessPolicy} from "../core/access-policy.js";
import {attributionOf} from "../core/action-attribution.js";
import {
  AccessChangeUnconfirmed,
  AccessGrantInvalid,
  AccessRevisionConflict,
  type ArtifactRepositoryFailure,
  AuthorizationDenied,
  type IdentityRepositoryFailure,
  PermissionNotHeld,
} from "../core/errors.js";
import {isDirectHumanPrincipal, membershipRoles, type MembershipRole, type Principal} from "../core/identity.js";
import type {InstallationMember} from "../core/installation-identity.js";
import {
  allPermissions,
  permissions,
  projectAccessModes,
  resolveEffectiveAccess,
  rolePermissions,
  type AccessGrant,
  type AccessSubject,
  type EffectiveAccess,
  type Permission,
  type ProjectAccess,
  type ProjectAccessMode,
  type ProjectRole,
} from "../core/permissions.js";
import type {PageCursor} from "../core/model.js";
import type {IdGenerator} from "../core/ports.js";
import type {ShareLink} from "../core/share-links.js";
import type {ApplicationClock} from "./application-clock.js";
import {
  type ArtifactManagementFailure,
  ArtifactManagementService,
} from "./artifact-management.js";
import {
  type AccessRepositoryEffects,
  type AccessScope,
  type AuthorizationOperations,
  AuthorizationService,
  type ScopedDenial,
} from "./authorization.js";
import {
  type ProjectManagementFailure,
  ProjectManagementService,
} from "./project-management.js";

/** Largest number of artifact grants one member may hold in one project. */
export const maximumArtifactGrantsPerProject = 500;

/** Persistence and identity reads the administration service depends on. */
export interface AccessAdministrationDependencies {
  readonly access: AccessRepositoryEffects;
  readonly clock: ApplicationClock;
  readonly ids: IdGenerator;
  readonly installationId: string;
  /** One page of the installation's active share links, for counting what a policy narrows. */
  readonly listActiveShareLinks: (command: {
    readonly cursor: PageCursor | null;
    readonly limit: number;
    readonly now: string;
  }) => Effect.Effect<{readonly items: readonly ShareLink[]; readonly nextCursor: PageCursor | null}, ArtifactRepositoryFailure>;
  readonly listMembers: () => Effect.Effect<readonly InstallationMember[], IdentityRepositoryFailure>;
  /** End the preview leases and content sessions these members hold, so narrowed access applies now. */
  readonly revokeContentSessions: (principalIds: readonly string[]) => Effect.Effect<void, ArtifactRepositoryFailure>;
}

/** Every expected failure of access administration. */
export type AccessAdministrationFailure =
  | AccessChangeUnconfirmed
  | AccessGrantInvalid
  | AccessRevisionConflict
  | ArtifactManagementFailure
  | ArtifactRepositoryFailure
  | IdentityRepositoryFailure
  | PermissionNotHeld
  | ProjectManagementFailure
  | ScopedDenial;

/** One member as a project's access screen shows them. */
export interface ProjectAccessMember {
  readonly displayName: string;
  readonly effectiveRole: ProjectRole | "administrator";
  readonly email: string;
  readonly memberId: string;
  readonly role: MembershipRole;
}

/** A grant change requested by a caller. */
export interface PutGrantCommand {
  readonly add: readonly Permission[];
  readonly artifactId: string | null;
  /** Null creates the grant; a number updates that revision. */
  readonly expectedRevision: number | null;
  readonly expiresAt: string | null;
  readonly memberId: string;
  readonly principal: Principal;
  readonly projectId: string;
  readonly remove: readonly Permission[];
  readonly role: ProjectRole;
}

/** Effective access with the subject it was resolved for. */
export interface ExplainedAccess extends EffectiveAccess {
  readonly subject: {readonly displayName: string; readonly id: string};
}

interface AccessAdministrationOperations {
  readonly changeProjectAccess: (command: {
    readonly accessMode: ProjectAccessMode;
    readonly confirmMembersLosingAccess: number | null;
    readonly defaultMemberRole: ProjectRole;
    readonly expectedRevision: number;
    readonly principal: Principal;
    readonly projectId: string;
  }) => Effect.Effect<ProjectAccess, AccessAdministrationFailure>;
  readonly deleteGrant: (command: {
    readonly artifactId: string | null;
    readonly expectedRevision: number;
    readonly memberId: string;
    readonly principal: Principal;
    readonly projectId: string;
  }) => Effect.Effect<void, AccessAdministrationFailure>;
  readonly explain: (command: {
    readonly artifactId: string | null;
    readonly principal: Principal;
    readonly projectId: string;
    /** Null explains the caller's own access. */
    readonly subjectMemberId: string | null;
  }) => Effect.Effect<ExplainedAccess, AccessAdministrationFailure>;
  readonly listMemberGrants: (command: {
    readonly memberId: string;
    readonly principal: Principal;
  }) => Effect.Effect<readonly AccessGrant[], AccessAdministrationFailure>;
  readonly putGrant: (command: PutGrantCommand) => Effect.Effect<AccessGrant, AccessAdministrationFailure>;
  readonly readPolicy: (principal: Principal) => Effect.Effect<StoredAccessPolicy, AccessAdministrationFailure>;
  readonly readProjectAccess: (command: {
    readonly principal: Principal;
    readonly projectId: string;
  }) => Effect.Effect<{
    readonly access: ProjectAccess;
    readonly grants: readonly AccessGrant[];
    readonly members: readonly ProjectAccessMember[];
  }, AccessAdministrationFailure>;
  readonly writePolicy: (command: {
    readonly expectedRevision: number;
    readonly policy: AccessPolicy;
    readonly principal: Principal;
  }) => Effect.Effect<{
    readonly narrowed: {readonly grants: number; readonly shareLinks: number};
    readonly policy: StoredAccessPolicy;
  }, AccessAdministrationFailure>;
}

/** Policy, project access settings, grants, and access explanations (ADR 0033). */
export class AccessAdministrationService extends Context.Service<
  AccessAdministrationService,
  AccessAdministrationOperations
>()("artifact-server/application/AccessAdministrationService") {
  /** Construct access administration over the access store and identity reads. */
  static readonly layer = (
    dependencies: AccessAdministrationDependencies,
  ): Layer.Layer<
    AccessAdministrationService,
    never,
    ArtifactManagementService | AuthorizationService | ProjectManagementService
  > =>
    Layer.effect(
      AccessAdministrationService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        const artifacts = yield* ArtifactManagementService;
        const projects = yield* ProjectManagementService;
        return makeAccessAdministrationService(dependencies, authorization, artifacts, projects);
      }),
    );
}

const memberSubject = (member: InstallationMember): AccessSubject =>
  member.role === membershipRoles.administrator
    ? {kind: "administrator"}
    : {kind: "member", memberId: member.id};

const sortedPermissions = (values: Iterable<Permission>): readonly Permission[] => {
  const included = new Set(values);
  return allPermissions.filter((permission) => included.has(permission)).toSorted();
};

const invalid = (message: string) => new AccessGrantInvalid({message});

function makeAccessAdministrationService(
  dependencies: AccessAdministrationDependencies,
  authorization: AuthorizationOperations,
  artifacts: ArtifactManagementService["Service"],
  projects: ProjectManagementService["Service"],
): AccessAdministrationOperations {
  const {access, installationId} = dependencies;
  const now = Effect.map(dependencies.clock.now, DateTime.formatIso);

  const activeMembers = Effect.map(
    dependencies.listMembers(),
    (members) => members.filter((member) => member.status === "active"),
  );

  /** Resolve a subject's access to one scope with archive state, for explanations and counts. */
  const resolveFor = Effect.fnUntraced(function*(
    subject: AccessSubject,
    memberId: string,
    project: ProjectAccess,
    artifactId: string | null,
    policy: AccessPolicy,
  ) {
    const grants = subject.kind === "administrator"
      ? {artifactGrants: [], projectGrant: null}
      : yield* access.findSubjectGrants({artifactId, installationId, memberId, projectId: project.projectId});
    return resolveEffectiveAccess({
      artifactDeleted: false,
      artifactGrants: grants.artifactGrants,
      now: yield* now,
      policy,
      project,
      projectGrant: grants.projectGrant,
      subject,
    });
  });

  const requireProjectAccessRecord = Effect.fnUntraced(function*(projectId: string) {
    const record = yield* access.readProjectAccess(installationId, projectId);
    if (record === null) {
      return yield* new AccessRevisionConflict({message: "The project's access settings changed."});
    }
    return record;
  });

  // The caller must see the scope and hold the permission that administers it.
  const requireAdministersScope = Effect.fnUntraced(function*(principal: Principal, scope: AccessScope) {
    yield* projects.getProject({principal, projectId: scope.projectId});
    if (scope.artifactId === null) {
      yield* authorization.requireProjectManagement(principal, {projectId: scope.projectId});
      return;
    }
    yield* artifacts.getArtifact({artifactId: scope.artifactId, principal, projectId: scope.projectId});
    yield* authorization.requireArtifactManagement(
      principal,
      {artifactId: scope.artifactId, projectId: scope.projectId},
      permissions.artifactShare,
    );
  });

  const requireHeld = Effect.fnUntraced(function*(
    principal: Principal,
    scope: AccessScope,
    granted: Iterable<Permission>,
  ) {
    const held = (yield* authorization.effectiveAccess(principal, scope)).permissions;
    const missing = sortedPermissions([...granted].filter((permission) => !held.has(permission)));
    if (missing.length > 0) {
      yield* new PermissionNotHeld({
        message: `You cannot grant permissions you do not hold here: ${missing.join(", ")}.`,
      });
    }
  });

  const readPolicy = Effect.fn("AccessAdministrationService.readPolicy")(function*(principal: Principal) {
    yield* authorization.requireInstallationAdministration(principal);
    return yield* access.readAccessPolicy(installationId);
  });

  const writePolicy = Effect.fn("AccessAdministrationService.writePolicy")(function*(command: {
    readonly expectedRevision: number;
    readonly policy: AccessPolicy;
    readonly principal: Principal;
  }) {
    yield* authorization.requireInstallationAdministration(command.principal);
    const written = yield* access.writeAccessPolicy({
      attribution: attributionOf(command.principal),
      expectedRevision: command.expectedRevision,
      installationId,
      policy: command.policy,
    });
    if (written === "conflict") {
      return yield* new AccessRevisionConflict({message: "The access policy changed; reload it and try again."});
    }
    const ceiling = command.policy.members.memberCeiling;
    let narrowedGrants = 0;
    if (ceiling !== null) {
      yield* dependencies.revokeContentSessions(
        (yield* activeMembers).filter((member) => member.role !== membershipRoles.administrator).map((member) => member.id),
      );
      const allowed = new Set(ceiling);
      for (const project of yield* access.listProjectAccess(installationId)) {
        const grants = yield* access.listProjectGrants(installationId, project.projectId);
        narrowedGrants += grants.filter((grant) =>
          [...rolePermissions(grant.role), ...grant.add].some((permission) => !allowed.has(permission))
        ).length;
      }
    }
    const guestMaximum = new Set(command.policy.shareLinks.guestPermissionsMax);
    let narrowedLinks = 0;
    let cursor: PageCursor | null = null;
    const at = yield* now;
    do {
      const page: {readonly items: readonly ShareLink[]; readonly nextCursor: PageCursor | null} =
        yield* dependencies.listActiveShareLinks({cursor, limit: 100, now: at});
      narrowedLinks += page.items.filter((link) =>
        !command.policy.shareLinks.enabled || link.permissions.some((permission) => !guestMaximum.has(permission))
      ).length;
      cursor = page.nextCursor;
    } while (cursor !== null);
    return {narrowed: {grants: narrowedGrants, shareLinks: narrowedLinks}, policy: written};
  });

  const readProjectAccess = Effect.fn("AccessAdministrationService.readProjectAccess")(function*(command: {
    readonly principal: Principal;
    readonly projectId: string;
  }) {
    yield* requireAdministersScope(command.principal, {artifactId: null, projectId: command.projectId});
    const record = yield* requireProjectAccessRecord(command.projectId);
    const grants = yield* access.listProjectGrants(installationId, command.projectId);
    const members = (yield* activeMembers).map((member): ProjectAccessMember => {
      const projectGrant = grants.find((grant) => grant.memberId === member.id && grant.artifactId === null);
      const effectiveRole = member.role === membershipRoles.administrator
        ? "administrator" as const
        : projectGrant?.role ??
          (record.accessMode === projectAccessModes.open ? record.defaultMemberRole : "none");
      return {
        displayName: member.displayName,
        effectiveRole,
        email: member.email,
        memberId: member.id,
        role: member.role,
      };
    });
    return {access: record, grants, members};
  });

  const changeProjectAccess = Effect.fn("AccessAdministrationService.changeProjectAccess")(function*(command: {
    readonly accessMode: ProjectAccessMode;
    readonly confirmMembersLosingAccess: number | null;
    readonly defaultMemberRole: ProjectRole;
    readonly expectedRevision: number;
    readonly principal: Principal;
    readonly projectId: string;
  }) {
    const scope = {artifactId: null, projectId: command.projectId};
    yield* requireAdministersScope(command.principal, scope);
    // The default role grants its permissions to every member, so the caller must hold them.
    yield* requireHeld(command.principal, scope, rolePermissions(command.defaultMemberRole));
    const current = yield* requireProjectAccessRecord(command.projectId);
    const {policy} = yield* access.readAccessPolicy(installationId);
    const next: ProjectAccess = {
      ...current,
      accessMode: command.accessMode,
      defaultMemberRole: command.defaultMemberRole,
    };
    let membersLosingAccess = 0;
    const narrowedMemberIds: string[] = [];
    for (const member of yield* activeMembers) {
      const subject = memberSubject(member);
      if (subject.kind === "administrator") continue;
      const before = yield* resolveFor(subject, member.id, current, null, policy);
      const after = yield* resolveFor(subject, member.id, next, null, policy);
      if (before.permissions.has(permissions.artifactView) && !after.permissions.has(permissions.artifactView)) {
        membersLosingAccess += 1;
      }
      if ([...before.permissions].some((permission) => !after.permissions.has(permission))) {
        narrowedMemberIds.push(member.id);
      }
    }
    if (membersLosingAccess > 0 && command.confirmMembersLosingAccess !== membersLosingAccess) {
      return yield* new AccessChangeUnconfirmed({
        membersLosingAccess,
        message: `${membersLosingAccess} ${membersLosingAccess === 1 ? "member" : "members"} will lose access to this project.`,
      });
    }
    const written = yield* access.writeProjectAccess({
      accessMode: command.accessMode,
      attribution: attributionOf(command.principal),
      defaultMemberRole: command.defaultMemberRole,
      expectedRevision: command.expectedRevision,
      installationId,
      projectId: command.projectId,
    });
    if (written === "conflict") {
      return yield* new AccessRevisionConflict({message: "The project's access settings changed; reload them."});
    }
    if (narrowedMemberIds.length > 0) yield* dependencies.revokeContentSessions(narrowedMemberIds);
    return written;
  });

  const putGrant = Effect.fn("AccessAdministrationService.putGrant")(function*(command: PutGrantCommand) {
    const scope = {artifactId: command.artifactId, projectId: command.projectId};
    yield* requireAdministersScope(command.principal, scope);
    const member = (yield* activeMembers).find((candidate) => candidate.id === command.memberId);
    if (member === undefined) return yield* invalid("Access can only be granted to an active member.");
    if (member.role === membershipRoles.administrator) {
      return yield* invalid("Administrators manage every project and cannot receive a grant.");
    }
    const overlap = command.add.filter((permission) => command.remove.includes(permission));
    if (overlap.length > 0) {
      return yield* invalid(`A permission cannot be both added and removed: ${sortedPermissions(overlap).join(", ")}.`);
    }
    const fromRole = rolePermissions(command.role);
    const add = sortedPermissions(command.add.filter((permission) => !fromRole.has(permission)));
    const remove = sortedPermissions(command.remove.filter((permission) => fromRole.has(permission)));
    if (command.artifactId !== null) {
      if (command.role === "none") return yield* invalid("An artifact grant adds access, so its role cannot be none.");
      if (remove.includes(permissions.artifactView)) {
        return yield* invalid("An artifact grant cannot remove the permission to view that artifact.");
      }
    }
    if (command.expiresAt !== null && command.expiresAt <= (yield* now)) {
      return yield* invalid("A grant must expire in the future.");
    }
    const granted = new Set(fromRole);
    for (const permission of add) granted.add(permission);
    for (const permission of remove) granted.delete(permission);
    yield* requireHeld(command.principal, scope, granted);

    const existing = yield* access.findSubjectGrants({
      artifactId: command.artifactId,
      installationId,
      memberId: command.memberId,
      projectId: command.projectId,
    });
    const current = command.artifactId === null
      ? existing.projectGrant
      : existing.artifactGrants.find((grant) => grant.artifactId === command.artifactId) ?? null;
    if (current === null && command.artifactId !== null) {
      const held = (yield* access.listProjectGrants(installationId, command.projectId))
        .filter((grant) => grant.memberId === command.memberId && grant.artifactId !== null);
      if (held.length >= maximumArtifactGrantsPerProject) {
        return yield* invalid(`A member can hold at most ${maximumArtifactGrantsPerProject} artifact grants in one project.`);
      }
    }
    if ((current === null) !== (command.expectedRevision === null)) {
      return yield* new AccessRevisionConflict({message: "This member's access changed; reload it and try again."});
    }
    const written = yield* access.upsertGrant({
      attribution: attributionOf(command.principal),
      expectedRevision: command.expectedRevision,
      grant: {
        add,
        artifactId: command.artifactId,
        createdByPrincipalId: current?.createdByPrincipalId ?? command.principal.id,
        expiresAt: command.expiresAt,
        id: current?.id ?? dependencies.ids.accessGrantId(),
        memberId: command.memberId,
        projectId: command.projectId,
        remove,
        role: command.role,
      },
      installationId,
    });
    if (written === "conflict") {
      return yield* new AccessRevisionConflict({message: "This member's access changed; reload it and try again."});
    }
    // Any grant change may narrow this member; their next preview request re-authorizes.
    yield* dependencies.revokeContentSessions([command.memberId]);
    return written;
  });

  const deleteGrant = Effect.fn("AccessAdministrationService.deleteGrant")(function*(command: {
    readonly artifactId: string | null;
    readonly expectedRevision: number;
    readonly memberId: string;
    readonly principal: Principal;
    readonly projectId: string;
  }) {
    yield* requireAdministersScope(command.principal, {artifactId: command.artifactId, projectId: command.projectId});
    const existing = yield* access.findSubjectGrants({
      artifactId: command.artifactId,
      installationId,
      memberId: command.memberId,
      projectId: command.projectId,
    });
    const current = command.artifactId === null
      ? existing.projectGrant
      : existing.artifactGrants.find((grant) => grant.artifactId === command.artifactId) ?? null;
    if (current === null) {
      yield* invalid("This member has no grant here.");
      return;
    }
    const deleted = yield* access.deleteGrant({
      attribution: attributionOf(command.principal),
      expectedRevision: command.expectedRevision,
      grantId: current.id,
      installationId,
    });
    if (deleted !== "deleted") {
      yield* new AccessRevisionConflict({message: "This member's access changed; reload it and try again."});
      return;
    }
    yield* dependencies.revokeContentSessions([command.memberId]);
  });

  const explain = Effect.fn("AccessAdministrationService.explain")(function*(command: {
    readonly artifactId: string | null;
    readonly principal: Principal;
    readonly projectId: string;
    readonly subjectMemberId: string | null;
  }) {
    // Explanations describe people; service principals act through capabilities instead.
    if (command.principal.kind !== "human") {
      return yield* new AuthorizationDenied({message: "Only people can explain access."});
    }
    yield* projects.getProject({principal: command.principal, projectId: command.projectId});
    if (command.artifactId !== null) {
      yield* artifacts.getArtifact({
        artifactId: command.artifactId,
        principal: command.principal,
        projectId: command.projectId,
      });
    }
    const subjectId = command.subjectMemberId ?? command.principal.id;
    if (subjectId !== command.principal.id) {
      yield* requireAdministersScope(command.principal, {artifactId: command.artifactId, projectId: command.projectId});
    }
    const member = (yield* activeMembers).find((candidate) => candidate.id === subjectId);
    if (member === undefined) return yield* invalid("Access can only be explained for an active member.");
    const subject: AccessSubject = subjectId === command.principal.id && !isDirectHumanPrincipal(command.principal)
      ? {kind: "member", memberId: member.id}
      : memberSubject(member);
    const project = yield* requireProjectAccessRecord(command.projectId);
    const {policy} = yield* access.readAccessPolicy(installationId);
    const effective = yield* resolveFor(subject, member.id, project, command.artifactId, policy);
    return {...effective, subject: {displayName: member.displayName, id: member.id}};
  });

  const listMemberGrants = Effect.fn("AccessAdministrationService.listMemberGrants")(function*(command: {
    readonly memberId: string;
    readonly principal: Principal;
  }) {
    yield* authorization.requireInstallationAdministration(command.principal);
    return yield* access.listMemberGrants(installationId, command.memberId);
  });

  return AccessAdministrationService.of({
    changeProjectAccess,
    deleteGrant,
    explain,
    listMemberGrants,
    putGrant,
    readPolicy,
    readProjectAccess,
    writePolicy,
  });
}
