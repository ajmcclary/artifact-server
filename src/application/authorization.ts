import {Context, DateTime, Effect, Layer} from "effect";

import type {AccessRepository} from "../core/access-ports.js";
import {
  ArtifactNotFound,
  type ArtifactRepositoryFailure,
  AuthorizationDenied,
  ProjectNotFound,
} from "../core/errors.js";
import {
  hasCapability,
  isDirectHumanPrincipal,
  isHumanAdministrator,
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../core/identity.js";
import {
  computeVisibleScope,
  permissions,
  resolveEffectiveAccess,
  type AccessSubject,
  type EffectiveAccess,
  type Permission,
  type VisibleScope,
} from "../core/permissions.js";
import type {ApplicationClock} from "./application-clock.js";

/** The access store, with each operation lifted into Effect. */
export type AccessRepositoryEffects = {
  readonly [Operation in keyof AccessRepository]: (
    ...args: Parameters<AccessRepository[Operation]>
  ) => Effect.Effect<Awaited<ReturnType<AccessRepository[Operation]>>, ArtifactRepositoryFailure>;
};

/** The project, and optionally the artifact, one check is about. */
export interface AccessScope {
  readonly artifactId: string | null;
  readonly projectId: string;
}

/** A check about one project as a whole. */
export interface ProjectScope {
  readonly projectId: string;
}

/** A check about one artifact. */
export interface ArtifactScope {
  readonly artifactId: string;
  readonly projectId: string;
}

/** Every way a project-scoped check can refuse. */
export type ProjectScopedDenial =
  | ArtifactRepositoryFailure
  | AuthorizationDenied
  | ProjectNotFound;

/** Every way an artifact-scoped check can refuse. */
export type ScopedDenial = ArtifactNotFound | ProjectScopedDenial;

/** Configuration and persistence trusted by authorization policy. */
export interface AuthorizationDependencies {
  readonly access: AccessRepositoryEffects;
  readonly clock: ApplicationClock;
  readonly installationId: string;
}

/** Permissions an artifact-management check may require. */
export type ArtifactManagementPermission =
  | typeof permissions.artifactDelete
  | typeof permissions.artifactEdit
  | typeof permissions.artifactHistory
  | typeof permissions.artifactShare;

/** Authorization decisions shared by every application operation. */
export interface AuthorizationOperations {
  readonly effectiveAccess: (
    principal: Principal,
    scope: AccessScope,
  ) => Effect.Effect<EffectiveAccess, ScopedDenial>;
  readonly requireAgentConnection: (
    principal: Principal,
  ) => Effect.Effect<void, AuthorizationDenied>;
  /** Installation-wide listings (activity, library, agents): any principal that may read some artifact. */
  readonly requireArtifactDiscovery: (
    principal: Principal,
  ) => Effect.Effect<void, AuthorizationDenied>;
  readonly requireArtifactCreation: (
    principal: Principal,
    scope: ProjectScope,
  ) => Effect.Effect<void, ProjectScopedDenial>;
  readonly requireArtifactHistory: (
    principal: Principal,
    scope: ArtifactScope,
  ) => Effect.Effect<void, ScopedDenial>;
  readonly requireArtifactListing: (
    principal: Principal,
    scope: ProjectScope,
  ) => Effect.Effect<void, ProjectScopedDenial>;
  readonly requireArtifactManagement: (
    principal: Principal,
    scope: ArtifactScope,
    permission: ArtifactManagementPermission,
  ) => Effect.Effect<void, ScopedDenial>;
  readonly requireArtifactRead: (
    principal: Principal,
    scope: ArtifactScope,
  ) => Effect.Effect<void, ScopedDenial>;
  readonly requireCommentModeration: (
    principal: Principal,
    scope: ArtifactScope,
  ) => Effect.Effect<void, ScopedDenial>;
  readonly requireCommentRead: (
    principal: Principal,
    scope: ArtifactScope,
  ) => Effect.Effect<void, ScopedDenial>;
  readonly requireCommentWrite: (
    principal: Principal,
    scope: ArtifactScope,
  ) => Effect.Effect<void, ScopedDenial>;
  readonly requireContentSession: (
    principal: Principal,
    scope: ArtifactScope,
  ) => Effect.Effect<void, ScopedDenial>;
  readonly requireDispatchSend: (
    principal: Principal,
    scope: ProjectScope,
  ) => Effect.Effect<void, ProjectScopedDenial>;
  readonly requireInstallationAdministration: (
    principal: Principal,
  ) => Effect.Effect<void, AuthorizationDenied>;
  readonly requirePublicationPreparation: (
    principal: Principal,
    scope: ProjectScope | null,
  ) => Effect.Effect<void, ProjectScopedDenial>;
  readonly requireProjectAccess: (
    principal: Principal,
    scope: ProjectScope,
  ) => Effect.Effect<void, ProjectScopedDenial>;
  readonly requireProjectCreation: (
    principal: Principal,
  ) => Effect.Effect<void, AuthorizationDenied>;
  /** Installation-wide project discovery; listings are then filtered by visibleScope. */
  readonly requireProjectListing: (
    principal: Principal,
  ) => Effect.Effect<void, AuthorizationDenied>;
  readonly requireProjectManagement: (
    principal: Principal,
    scope: ProjectScope,
  ) => Effect.Effect<void, ProjectScopedDenial>;
  readonly requireVersionPublication: (
    principal: Principal,
    scope: ArtifactScope,
  ) => Effect.Effect<void, ScopedDenial>;
  readonly visibleScope: (
    principal: Principal,
  ) => Effect.Effect<VisibleScope, ArtifactRepositoryFailure>;
}

/** Applies installation, membership, project, and capability policy. */
export class AuthorizationService extends Context.Service<
  AuthorizationService,
  AuthorizationOperations
>()("artifact-server/application/AuthorizationService") {
  /** Construct policy for one trusted installation over its access store. */
  static readonly layer = (
    dependencies: AuthorizationDependencies,
  ): Layer.Layer<AuthorizationService> =>
    Layer.succeed(
      AuthorizationService,
      makeAuthorizationService(dependencies),
    );
}

type CapabilityRule = (principal: Principal) => boolean;

const anyCapability = (...capabilities: readonly Principal["capabilities"][number][]): CapabilityRule =>
  (principal) => capabilities.some((capability) => hasCapability(principal, capability));

const readRule = anyCapability(principalCapabilities.readArtifacts, principalCapabilities.manageAnyArtifact);
const manageRule = anyCapability(principalCapabilities.manageAnyArtifact);
// Every artifact-facing capability; agent:connect alone reaches no project.
const projectRule = anyCapability(
  principalCapabilities.createArtifact,
  principalCapabilities.issueContentSession,
  principalCapabilities.manageAnyArtifact,
  principalCapabilities.manageProjects,
  principalCapabilities.publishAnyArtifact,
  principalCapabilities.readArtifacts,
  principalCapabilities.writeComments,
);

// A key bound to an administrator acts as that administrator, within its capabilities.
const subjectOf = (principal: Principal): AccessSubject =>
  principal.kind === principalKinds.human && principal.membershipRole === membershipRoles.administrator
    ? {kind: "administrator"}
    : {kind: "member", memberId: principal.id};

const isVisible = (visible: VisibleScope, scope: AccessScope): boolean =>
  visible.kind === "all" ||
  visible.projectIds.includes(scope.projectId) ||
  (scope.artifactId === null
    ? visible.artifactIdsByProject.has(scope.projectId)
    : (visible.artifactIdsByProject.get(scope.projectId) ?? []).includes(scope.artifactId));

function makeAuthorizationService(
  dependencies: AuthorizationDependencies,
): AuthorizationOperations {
  const {access} = dependencies;

  const requireInstallation = (
    principal: Principal,
  ): Effect.Effect<void, AuthorizationDenied> =>
    principal.installationId === dependencies.installationId
      ? Effect.void
      : denied();

  const now = Effect.map(dependencies.clock.now, DateTime.formatIso);

  // Archive and deletion stay enforced by the services that own them, so the
  // existing ProjectArchived and not-found failures keep their meaning.
  const resolve = Effect.fnUntraced(function*(principal: Principal, scope: AccessScope) {
    const project = yield* access.readProjectAccess(dependencies.installationId, scope.projectId);
    if (project === null) return yield* projectNotFound();
    const subject = subjectOf(principal);
    const grants = subject.kind === "administrator"
      ? {artifactGrants: [], projectGrant: null}
      : yield* access.findSubjectGrants({
        artifactId: scope.artifactId,
        installationId: dependencies.installationId,
        memberId: principal.id,
        projectId: scope.projectId,
      });
    const stored = yield* access.readAccessPolicy(dependencies.installationId);
    return resolveEffectiveAccess({
      artifactDeleted: false,
      artifactGrants: grants.artifactGrants,
      now: yield* now,
      policy: stored.policy,
      project: {...project, archived: false},
      projectGrant: grants.projectGrant,
      subject,
    });
  });

  const visibleScope = Effect.fn("AuthorizationService.visibleScope")(
    function*(principal: Principal) {
      if (principal.kind === principalKinds.service) {
        return principal.projectIds.length === 0
          ? {kind: "all"} as const
          : {artifactIdsByProject: new Map(), kind: "limited", projectIds: principal.projectIds} as const;
      }
      const subject = subjectOf(principal);
      if (subject.kind === "administrator") return {kind: "all"} as const;
      const projects = yield* access.listProjectAccess(dependencies.installationId);
      const grants = yield* access.listMemberGrants(dependencies.installationId, principal.id);
      const stored = yield* access.readAccessPolicy(dependencies.installationId);
      const visible = computeVisibleScope({
        grants,
        now: yield* now,
        policy: stored.policy,
        projects,
        subject,
      });
      if (visible.kind === "all" || principal.projectIds.length === 0) return visible;
      return {
        artifactIdsByProject: new Map(
          [...visible.artifactIdsByProject].filter(([projectId]) => principal.projectIds.includes(projectId)),
        ),
        kind: "limited",
        projectIds: visible.projectIds.filter((projectId) => principal.projectIds.includes(projectId)),
      } as const;
    },
  );

  const notFoundFor = (scope: AccessScope) =>
    scope.artifactId === null ? projectNotFound() : artifactNotFound();

  /**
   * One scoped check. Service principals keep their explicit capability rule
   * and their project scope; humans resolve the five access layers, and a key
   * bound to a member must pass both.
   */
  const requireScoped = Effect.fnUntraced(function*(
    principal: Principal,
    scope: AccessScope,
    permission: Permission | "visible",
    capabilityRule: CapabilityRule,
  ) {
    yield* requireInstallation(principal);
    if (principal.projectIds.length > 0 && !principal.projectIds.includes(scope.projectId)) {
      yield* notFoundFor(scope);
      return;
    }
    if (principal.kind === principalKinds.service) {
      if (!capabilityRule(principal)) yield* denied();
      return;
    }
    if (!isDirectHumanPrincipal(principal) && !capabilityRule(principal)) {
      yield* denied();
      return;
    }
    if (permission === "visible" || scope.artifactId === null) {
      // A project is visible through project-level view or any artifact grant in it.
      const visible = yield* visibleScope(principal);
      if (!isVisible(visible, scope)) yield* notFoundFor(scope);
      if (permission === "visible") return;
    }
    const effective = yield* resolve(principal, scope);
    if (scope.artifactId !== null && !effective.permissions.has(permissions.artifactView)) {
      yield* artifactNotFound();
      return;
    }
    if (!effective.permissions.has(permission)) yield* denied();
  });

  const effectiveAccess = Effect.fn("AuthorizationService.effectiveAccess")(
    function*(principal: Principal, scope: AccessScope) {
      yield* requireInstallation(principal);
      return yield* resolve(principal, scope);
    },
  );

  // Direct humans are not agents: the registry, claim, and report surface is
  // reserved for service principals holding the agent connection capability.
  const requireAgentConnection = Effect.fn(
    "AuthorizationService.requireAgentConnection",
  )(function*(principal: Principal) {
    yield* requireInstallation(principal);
    if (
      principal.kind === principalKinds.service &&
      hasCapability(principal, principalCapabilities.connectAgents)
    ) {
      return;
    }
    yield* denied();
  });

  const requireArtifactDiscovery = Effect.fn("AuthorizationService.requireArtifactDiscovery")(
    function*(principal: Principal) {
      yield* requireInstallation(principal);
      if (isDirectHumanPrincipal(principal) || readRule(principal)) return;
      yield* denied();
    },
  );

  const requireInstallationAdministration = Effect.fn(
    "AuthorizationService.requireInstallationAdministration",
  )(function*(principal: Principal) {
    yield* requireInstallation(principal);
    if (isHumanAdministrator(principal)) return;
    yield* denied();
  });

  const requireProjectListing = Effect.fn("AuthorizationService.requireProjectListing")(
    function*(principal: Principal) {
      yield* requireInstallation(principal);
      if (isDirectHumanPrincipal(principal) || projectRule(principal)) return;
      yield* denied();
    },
  );

  const requireProjectCreation = Effect.fn("AuthorizationService.requireProjectCreation")(
    function*(principal: Principal) {
      yield* requireInstallation(principal);
      if (
        isHumanAdministrator(principal) ||
        hasCapability(principal, principalCapabilities.manageProjects)
      ) {
        return;
      }
      yield* denied();
    },
  );

  const projectScoped = (
    name: string,
    permission: Permission | "visible",
    capabilityRule: CapabilityRule,
  ) => (principal: Principal, scope: ProjectScope): Effect.Effect<void, ProjectScopedDenial> =>
    requireScoped(principal, {artifactId: null, projectId: scope.projectId}, permission, capabilityRule).pipe(
      // A project scope can only refuse with ProjectNotFound; narrow the type to say so.
      Effect.catchTag("ArtifactNotFound", () => projectNotFound()),
      Effect.withSpan(name),
    );

  const artifactScoped = (
    name: string,
    permission: Permission,
    capabilityRule: CapabilityRule,
  ) => Effect.fn(name)(function*(principal: Principal, scope: ArtifactScope) {
    yield* requireScoped(principal, scope, permission, capabilityRule);
  });

  const requireArtifactManagement = Effect.fn("AuthorizationService.requireArtifactManagement")(
    function*(principal: Principal, scope: ArtifactScope, permission: ArtifactManagementPermission) {
      yield* requireScoped(principal, scope, permission, manageRule);
    },
  );

  const requirePublicationPreparation = Effect.fn(
    "AuthorizationService.requirePublicationPreparation",
  )(function*(principal: Principal, scope: ProjectScope | null) {
    const rule = anyCapability(principalCapabilities.createArtifact, principalCapabilities.publishAnyArtifact);
    if (scope !== null) {
      yield* projectScoped("AuthorizationService.requirePublicationPreparation.scoped", permissions.artifactPublish, rule)(
        principal,
        scope,
      );
      return;
    }
    yield* requireInstallation(principal);
    if (isDirectHumanPrincipal(principal) || rule(principal)) return;
    yield* denied();
  });

  return AuthorizationService.of({
    effectiveAccess,
    requireAgentConnection,
    requireArtifactDiscovery,
    requireArtifactCreation: projectScoped(
      "AuthorizationService.requireArtifactCreation",
      permissions.artifactPublish,
      anyCapability(principalCapabilities.createArtifact),
    ),
    requireArtifactHistory: artifactScoped(
      "AuthorizationService.requireArtifactHistory",
      permissions.artifactHistory,
      readRule,
    ),
    requireArtifactListing: projectScoped("AuthorizationService.requireArtifactListing", "visible", readRule),
    requireArtifactManagement,
    requireArtifactRead: artifactScoped("AuthorizationService.requireArtifactRead", permissions.artifactView, readRule),
    requireCommentModeration: artifactScoped(
      "AuthorizationService.requireCommentModeration",
      permissions.commentModerate,
      manageRule,
    ),
    requireCommentRead: artifactScoped("AuthorizationService.requireCommentRead", permissions.commentRead, readRule),
    requireCommentWrite: artifactScoped(
      "AuthorizationService.requireCommentWrite",
      permissions.commentWrite,
      anyCapability(principalCapabilities.writeComments),
    ),
    requireContentSession: artifactScoped(
      "AuthorizationService.requireContentSession",
      permissions.artifactView,
      anyCapability(principalCapabilities.issueContentSession),
    ),
    // Sending and canceling dispatches stays a human decision in v1; the only
    // service exception is the artifact-management capability.
    requireDispatchSend: projectScoped("AuthorizationService.requireDispatchSend", permissions.agentDispatch, manageRule),
    requireInstallationAdministration,
    requireProjectAccess: projectScoped(
      "AuthorizationService.requireProjectAccess",
      "visible",
      projectRule,
    ),
    requireProjectCreation,
    requireProjectListing,
    requireProjectManagement: projectScoped(
      "AuthorizationService.requireProjectManagement",
      permissions.projectManage,
      anyCapability(principalCapabilities.manageProjects),
    ),
    requirePublicationPreparation,
    requireVersionPublication: artifactScoped(
      "AuthorizationService.requireVersionPublication",
      permissions.artifactPublish,
      anyCapability(principalCapabilities.publishAnyArtifact),
    ),
    visibleScope,
  });
}

function denied(): Effect.Effect<never, AuthorizationDenied> {
  return Effect.fail(new AuthorizationDenied({
    message: "The authenticated principal is not permitted to perform this operation.",
  }));
}

function projectNotFound(): Effect.Effect<never, ProjectNotFound> {
  return Effect.fail(new ProjectNotFound({message: "The project does not exist."}));
}

function artifactNotFound(): Effect.Effect<never, ArtifactNotFound> {
  return Effect.fail(new ArtifactNotFound({message: "The artifact does not exist."}));
}
