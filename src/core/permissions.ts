import type {AccessPolicy} from "./access-policy.js";

/** Named permission atoms; each guards one class of product operation (ADR 0033). */
export const permissions = {
  artifactView: "artifact.view",
  artifactHistory: "artifact.history",
  commentRead: "comment.read",
  commentWrite: "comment.write",
  commentModerate: "comment.moderate",
  artifactPublish: "artifact.publish",
  artifactEdit: "artifact.edit",
  artifactDelete: "artifact.delete",
  artifactShare: "artifact.share",
  agentDispatch: "agent.dispatch",
  projectManage: "project.manage",
} as const;

/** One permission atom. */
export type Permission = (typeof permissions)[keyof typeof permissions];

/** Every permission in display order. */
export const allPermissions: readonly Permission[] = Object.values(permissions);

/** Ordered project roles; each holds every permission of the roles before it. */
export const projectRoles = {
  none: "none",
  viewer: "viewer",
  commenter: "commenter",
  editor: "editor",
  manager: "manager",
} as const;

/** One project role. */
export type ProjectRole = (typeof projectRoles)[keyof typeof projectRoles];

/** Whether every member reaches a project, or only the members it lists. */
export const projectAccessModes = {
  open: "open",
  restricted: "restricted",
} as const;

/** One project access mode. */
export type ProjectAccessMode =
  (typeof projectAccessModes)[keyof typeof projectAccessModes];

const roleAdditions = {
  none: [],
  viewer: [permissions.artifactView, permissions.artifactHistory, permissions.commentRead],
  commenter: [permissions.commentWrite],
  // Editor is exactly what an admitted member could do before ADR 0033.
  editor: [
    permissions.artifactPublish,
    permissions.artifactEdit,
    permissions.artifactDelete,
    permissions.artifactShare,
    permissions.agentDispatch,
  ],
  manager: [permissions.commentModerate, permissions.projectManage],
} as const satisfies Readonly<Record<ProjectRole, readonly Permission[]>>;

const roleOrder: readonly ProjectRole[] = Object.values(projectRoles);

const roleSets: ReadonlyMap<ProjectRole, ReadonlySet<Permission>> = new Map(
  roleOrder.map((role, index) => [
    role,
    new Set(roleOrder.slice(0, index + 1).flatMap((included) => roleAdditions[included])),
  ]),
);

/** The permissions one role holds. */
export function rolePermissions(role: ProjectRole): ReadonlySet<Permission> {
  return roleSets.get(role) ?? new Set();
}

/** The only permissions a share-link guest can ever hold. */
export const guestHoldablePermissions: ReadonlySet<Permission> = new Set([
  permissions.artifactView,
  permissions.commentRead,
  permissions.commentWrite,
]);

/** Permissions that change state; an archived project removes all of them. */
export const writePermissions: ReadonlySet<Permission> = new Set(
  allPermissions.filter((permission) =>
    permission !== permissions.artifactView &&
    permission !== permissions.artifactHistory &&
    permission !== permissions.commentRead
  ),
);

/** A member's role and overrides on one project or one artifact. */
export interface AccessGrant {
  readonly add: readonly Permission[];
  /** Null for a project grant. */
  readonly artifactId: string | null;
  readonly createdAt: string;
  readonly createdByPrincipalId: string;
  readonly expiresAt: string | null;
  readonly id: string;
  readonly memberId: string;
  readonly projectId: string;
  readonly remove: readonly Permission[];
  readonly revision: number;
  readonly role: ProjectRole;
  readonly updatedAt: string;
}

/** A project's access settings together with the state that masks writes. */
export interface ProjectAccess {
  readonly accessMode: ProjectAccessMode;
  readonly archived: boolean;
  readonly defaultMemberRole: ProjectRole;
  readonly projectId: string;
  readonly revision: number;
}

/** Who access is being resolved for. */
export type AccessSubject =
  | {readonly kind: "administrator"}
  | {readonly kind: "member"; readonly memberId: string}
  | {readonly kind: "guest"; readonly linkPermissions: readonly Permission[]};

/** One reason a permission was granted or removed, in resolution order. */
export type AccessSource =
  | {readonly layer: "administrator"}
  | {readonly layer: "project_default"; readonly role: ProjectRole}
  | {
    readonly added: readonly Permission[];
    readonly grantId: string;
    readonly layer: "project_grant" | "artifact_grant";
    readonly removed: readonly Permission[];
    readonly role: ProjectRole;
  }
  | {readonly layer: "share_link"; readonly shareLinkId: string}
  | {readonly layer: "policy"; readonly removed: readonly Permission[]}
  | {
    readonly layer: "state";
    readonly reason: "archived" | "deleted" | "expired_grant";
    readonly removed: readonly Permission[];
  };

/** The permissions a subject holds on one scope and why. */
export interface EffectiveAccess {
  readonly permissions: ReadonlySet<Permission>;
  readonly sources: readonly AccessSource[];
}

/** Everything needed to resolve one subject's access to one project or artifact. */
export interface AccessResolutionInput {
  readonly artifactDeleted: boolean;
  /** Grants on the scoped artifact only; empty for a project scope. */
  readonly artifactGrants: readonly AccessGrant[];
  readonly now: string;
  readonly policy: AccessPolicy;
  readonly project: ProjectAccess;
  readonly projectGrant: AccessGrant | null;
  readonly shareLinkId?: string;
  readonly subject: AccessSubject;
}

function isLive(grant: AccessGrant, now: string): boolean {
  return grant.expiresAt === null || grant.expiresAt > now;
}

function grantPermissions(grant: AccessGrant): Set<Permission> {
  const granted = new Set(rolePermissions(grant.role));
  for (const permission of grant.add) granted.add(permission);
  for (const permission of grant.remove) granted.delete(permission);
  return granted;
}

function grantSource(grant: AccessGrant): AccessSource {
  return {
    added: grant.add,
    grantId: grant.id,
    layer: grant.artifactId === null ? "project_grant" : "artifact_grant",
    removed: grant.remove,
    role: grant.role,
  };
}

function sortedPermissions(values: Iterable<Permission>): readonly Permission[] {
  const included = new Set(values);
  return allPermissions.filter((permission) => included.has(permission)).toSorted();
}

function removeOutside(
  granted: Set<Permission>,
  allowed: ReadonlySet<Permission>,
): readonly Permission[] {
  const removed = [...granted].filter((permission) => !allowed.has(permission));
  for (const permission of removed) granted.delete(permission);
  return sortedPermissions(removed);
}

/**
 * Resolve the five access layers for one subject on one scope.
 *
 * A member's project grant replaces the project default; artifact grants add;
 * policy ceilings and state only subtract, and always win.
 */
export function resolveEffectiveAccess(input: AccessResolutionInput): EffectiveAccess {
  const granted = new Set<Permission>();
  const sources: AccessSource[] = [];
  const {subject} = input;

  if (subject.kind === "administrator") {
    for (const permission of allPermissions) granted.add(permission);
    sources.push({layer: "administrator"});
  } else if (subject.kind === "guest") {
    const linkMaximum = input.policy.shareLinks.enabled
      ? new Set(input.policy.shareLinks.guestPermissionsMax)
      : new Set<Permission>();
    for (const permission of subject.linkPermissions) {
      if (guestHoldablePermissions.has(permission) && linkMaximum.has(permission)) {
        granted.add(permission);
      }
    }
    if (input.shareLinkId !== undefined) {
      sources.push({layer: "share_link", shareLinkId: input.shareLinkId});
    }
  } else {
    const expired: AccessGrant[] = [];
    const projectGrant = input.projectGrant !== null && isLive(input.projectGrant, input.now)
      ? input.projectGrant
      : null;
    if (input.projectGrant !== null && projectGrant === null) expired.push(input.projectGrant);

    if (projectGrant !== null) {
      for (const permission of grantPermissions(projectGrant)) granted.add(permission);
      sources.push(grantSource(projectGrant));
    } else if (input.project.accessMode === projectAccessModes.open) {
      for (const permission of rolePermissions(input.project.defaultMemberRole)) granted.add(permission);
      sources.push({layer: "project_default", role: input.project.defaultMemberRole});
    }

    for (const artifactGrant of input.artifactGrants) {
      if (!isLive(artifactGrant, input.now)) {
        expired.push(artifactGrant);
        continue;
      }
      for (const permission of grantPermissions(artifactGrant)) granted.add(permission);
      sources.push(grantSource(artifactGrant));
    }

    const ceiling = input.policy.members.memberCeiling;
    if (ceiling !== null) {
      const removed = removeOutside(granted, new Set(ceiling));
      if (removed.length > 0) sources.push({layer: "policy", removed});
    }
    if (expired.length > 0) sources.push({layer: "state", reason: "expired_grant", removed: []});
  }

  if (input.artifactDeleted) {
    const removed = sortedPermissions(granted);
    granted.clear();
    sources.push({layer: "state", reason: "deleted", removed});
  } else if (input.project.archived) {
    const removed = removeOutside(
      granted,
      new Set(allPermissions.filter((permission) => !writePermissions.has(permission))),
    );
    if (removed.length > 0) sources.push({layer: "state", reason: "archived", removed});
  }

  return {permissions: granted, sources};
}

/** The projects and artifacts a principal can see at all. */
export type VisibleScope =
  | {readonly kind: "all"}
  | {
    readonly artifactIdsByProject: ReadonlyMap<string, readonly string[]>;
    readonly kind: "limited";
    /** Projects where the subject can view every artifact. */
    readonly projectIds: readonly string[];
  };

/** Inputs for computing visibility across every project of one installation. */
export interface VisibleScopeInput {
  /** Every grant the subject holds, project and artifact alike. */
  readonly grants: readonly AccessGrant[];
  readonly now: string;
  readonly policy: AccessPolicy;
  readonly projects: readonly ProjectAccess[];
  readonly subject: AccessSubject;
}

/** Compute which projects and artifacts a subject can view. */
export function computeVisibleScope(input: VisibleScopeInput): VisibleScope {
  if (input.subject.kind === "administrator") return {kind: "all"};

  const projectIds: string[] = [];
  const artifactIdsByProject = new Map<string, string[]>();
  for (const project of input.projects) {
    const projectGrant = input.grants.find((grant) =>
      grant.projectId === project.projectId && grant.artifactId === null
    ) ?? null;
    const projectLevel = resolveEffectiveAccess({
      artifactDeleted: false,
      artifactGrants: [],
      now: input.now,
      policy: input.policy,
      project,
      projectGrant,
      subject: input.subject,
    });
    if (projectLevel.permissions.has(permissions.artifactView)) {
      projectIds.push(project.projectId);
      continue;
    }
    const visibleArtifacts = input.grants
      .filter((grant) => grant.projectId === project.projectId && grant.artifactId !== null)
      .filter((grant) =>
        resolveEffectiveAccess({
          artifactDeleted: false,
          artifactGrants: [grant],
          now: input.now,
          policy: input.policy,
          project,
          projectGrant,
          subject: input.subject,
        }).permissions.has(permissions.artifactView)
      )
      .flatMap((grant) => grant.artifactId === null ? [] : [grant.artifactId]);
    if (visibleArtifacts.length > 0) {
      artifactIdsByProject.set(project.projectId, [...new Set(visibleArtifacts)].toSorted());
    }
  }
  return {artifactIdsByProject, kind: "limited", projectIds};
}

/** The artifact filter for one project: null lists everything, a list (even empty) only those. */
export function visibleArtifactIds(visible: VisibleScope, projectId: string): readonly string[] | null {
  if (visible.kind === "all" || visible.projectIds.includes(projectId)) return null;
  return visible.artifactIdsByProject.get(projectId) ?? [];
}

/** Whether any artifact of a project is visible. */
export function isProjectVisible(visible: VisibleScope, projectId: string): boolean {
  return visible.kind === "all" ||
    visible.projectIds.includes(projectId) ||
    visible.artifactIdsByProject.has(projectId);
}

/** Projects visible as a whole, for project-wide feeds; null means every project. */
export function wholeProjectIds(visible: VisibleScope): readonly string[] | null {
  return visible.kind === "all" ? null : visible.projectIds;
}
