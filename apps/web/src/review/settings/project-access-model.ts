/** Permission atoms in display order; mirrors the server's ADR 0033 list. */
export const permissionOrder = [
  "artifact.view",
  "artifact.history",
  "comment.read",
  "comment.write",
  "comment.moderate",
  "artifact.publish",
  "artifact.edit",
  "artifact.delete",
  "artifact.share",
  "agent.dispatch",
  "project.manage",
] as const;

/** One permission atom. */
export type Permission = (typeof permissionOrder)[number];

/** Project roles in ascending order. */
export const projectRoleOrder = ["none", "viewer", "commenter", "editor", "manager"] as const;

/** One project role. */
export type ProjectRole = (typeof projectRoleOrder)[number];

const roleAdditions = {
  none: [],
  viewer: ["artifact.view", "artifact.history", "comment.read"],
  commenter: ["comment.write"],
  editor: ["artifact.publish", "artifact.edit", "artifact.delete", "artifact.share", "agent.dispatch"],
  manager: ["comment.moderate", "project.manage"],
} as const satisfies Readonly<Record<ProjectRole, readonly Permission[]>>;

/** Every permission one role holds, in display order. */
export function rolePermissions(role: ProjectRole): readonly Permission[] {
  const index = projectRoleOrder.indexOf(role);
  const held = new Set<Permission>(projectRoleOrder.slice(0, index + 1).flatMap((included) => roleAdditions[included]));
  return permissionOrder.filter((permission) => held.has(permission));
}

const permissionLabels = {
  "agent.dispatch": "Send work to agents",
  "artifact.delete": "Delete artifacts",
  "artifact.edit": "Rename, tag and restore",
  "artifact.history": "See history and comparisons",
  "artifact.publish": "Publish versions",
  "artifact.share": "Share and change access",
  "artifact.view": "Open artifacts",
  "comment.moderate": "Delete anyone's comments",
  "comment.read": "Read comments",
  "comment.write": "Write comments",
  "project.manage": "Manage the project and its access",
} as const satisfies Readonly<Record<Permission, string>>;

/** The plain-language name of one permission. */
export function permissionLabel(permission: Permission): string {
  return permissionLabels[permission];
}

const roleLabels = {
  commenter: "Commenter",
  editor: "Editor",
  manager: "Manager",
  none: "No access",
  viewer: "Viewer",
} as const satisfies Readonly<Record<ProjectRole, string>>;

/** The display name of one role. */
export function roleLabel(role: ProjectRole): string {
  return roleLabels[role];
}

/** How one permission stands on a grant being edited. */
export type OverrideState = "added" | "blocked_by_policy" | "from_role" | "off" | "removed";

/** One row of the permission override checklist. */
export interface OverrideRow {
  readonly disabledReason: string | null;
  readonly label: string;
  readonly permission: Permission;
  readonly state: OverrideState;
}

/**
 * The checklist for a grant: each permission's state against the role, and why
 * the editor cannot change it when they do not hold it or policy forbids it.
 */
export function overrideRows(
  role: ProjectRole,
  add: readonly Permission[],
  remove: readonly Permission[],
  actorPermissions: ReadonlySet<Permission>,
  ceiling: readonly Permission[] | null,
): readonly OverrideRow[] {
  const fromRole = new Set(rolePermissions(role));
  return permissionOrder.map((permission) => {
    const blocked = ceiling !== null && !ceiling.includes(permission);
    const state: OverrideState = blocked
      ? "blocked_by_policy"
      : remove.includes(permission)
      ? "removed"
      : fromRole.has(permission)
      ? "from_role"
      : add.includes(permission)
      ? "added"
      : "off";
    const disabledReason = blocked
      ? "Blocked by installation policy"
      : actorPermissions.has(permission)
      ? null
      : "You don't have this permission";
    return {disabledReason, label: permissionLabel(permission), permission, state};
  });
}

/** The confirmation shown before restricting a project. */
export function restrictConfirmation(membersLosingAccess: number): string {
  return `${membersLosingAccess} ${membersLosingAccess === 1 ? "member" : "members"} will lose access to this project.`;
}

/** The helper under a role picker on an archived project, where only narrowing saves. */
export const archivedRoleHelp = "An archived project can only lower roles.";
/** The helper under "Who can open this project" on an archived restricted project. */
export const archivedOpenHelp = "An archived project cannot be opened to all members.";

/** The note above Project → Access on an archived project. */
export function archivedAccessNotice(projectName: string): string {
  return `${projectName} is archived. You can restrict it, lower roles and remove people; nothing can be opened or widened.`;
}

/** A role choice; a disabled one stays listed so the whole range reads, but cannot be picked. */
export interface RoleChoice {
  readonly disabled: boolean;
  readonly label: string;
  readonly value: ProjectRole;
}

/**
 * Every role, with those above `ceiling` disabled. An archived project passes the saved
 * role as the ceiling, so a picker offers only lowering (UX-09); null leaves all open.
 */
export function roleChoices(ceiling: ProjectRole | null): readonly RoleChoice[] {
  const limit = ceiling === null ? projectRoleOrder.length - 1 : projectRoleOrder.indexOf(ceiling);
  return projectRoleOrder.map((role, index) => ({disabled: index > limit, label: roleLabel(role), value: role}));
}
