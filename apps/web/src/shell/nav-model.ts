import type {Principal, Project} from "@/api/client";
import type {NavItem} from "@/arkcase";
import {
  activityHref,
  libraryHref,
  projectsHref,
  projectWorkspaceHref,
  type SettingsRoute,
} from "@/review/review-routes";

/** The `id` of the link-less navigation row that opens the New project dialog. */
export const NEW_PROJECT_NAV_ID = "new-project";

/** Everything the navigation needs to know about the current screen and principal. */
export interface ShellNavInput {
  readonly activeProjectId: string | null;
  readonly activeSettings: SettingsRoute["kind"] | null;
  readonly canCreateProjects: boolean;
  readonly isAdministrator: boolean;
  /** The Library is open. */
  readonly libraryActive: boolean;
  /** Conversations waiting on a person, from the activity summary; null while unknown or failed. */
  readonly needsYou: number | null;
  readonly projects: readonly Project[];
  readonly activityActive: boolean;
  readonly projectsActive: boolean;
}

const administrationHrefs = {
  apiKeys: "/review/settings/api-keys",
  mcp: "/review/settings/mcp",
  members: "/review/settings/members",
  publicLinks: "/review/settings/public-links",
  webmcp: "/review/settings/webmcp",
} as const;

/** A direct human installation administrator (not a delegated or service principal). */
export function isInstallationAdministrator(principal: Principal): boolean {
  return isDirectHuman(principal) && principal.membershipRole === "administrator";
}

/** Whether the principal may create, rename, archive, and open project settings. */
export function canManageProjects(principal: Principal): boolean {
  return isDirectHuman(principal) || principal.capabilities.includes("project:manage");
}

/** Where "Administration" lands: Members for administrators, MCP & WebMCP otherwise. */
export function administrationHref(isAdministrator: boolean): string {
  return isAdministrator ? administrationHrefs.members : administrationHrefs.mcp;
}

/** The navigation rows; `link` values are real hrefs. The item set never changes with the screen. */
export function shellNavItems(input: ShellNavInput): NavItem[] {
  return reviewItems(input);
}

/** The `link` of the current row, or "" when no row is current. */
export function shellActiveLink(input: ShellNavInput): string {
  if (input.activeSettings !== null && input.activeSettings !== "projects" && input.activeSettings !== "project") {
    // Every administration area lives under the one Tools item.
    return administrationHref(input.isAdministrator);
  }
  if (input.activityActive) return activityHref();
  if (input.libraryActive) return libraryHref();
  // The Projects screen marks the Projects row; a project's artifacts mark its folder.
  if (input.projectsActive) return projectsHref(null);
  return input.activeProjectId === null ? "" : projectWorkspaceHref(input.activeProjectId);
}

function isDirectHuman(principal: Principal): boolean {
  return principal.kind === "human" && principal.authorizedByPrincipalId === null;
}

/** Activity's row, with the Needs-you count only when something waits. */
function activityItem(needsYou: number | null): NavItem {
  const item: NavItem = {group: "Review", icon: "bi-inbox", id: "activity", label: "Activity", link: activityHref()};
  if (needsYou !== null && needsYou > 0) item.count = needsYou;
  return item;
}

function reviewItems(input: ShellNavInput): NavItem[] {
  const items: NavItem[] = [
    activityItem(input.needsYou),
    {icon: "bi-briefcase", id: "projects", label: "Projects", link: projectsHref(null)},
    {icon: "bi-collection", id: "library", label: "Library", link: libraryHref()},
  ];
  const firstProjectIndex = items.length;
  for (const project of orderedProjects(input.projects)) {
    const item: NavItem = {
      icon: project.archivedAt === null ? "bi-folder2" : "bi-archive",
      id: `project:${project.id}`,
      label: project.name,
      // A folder opens the project's artifacts; the Projects row opens its settings and activity.
      link: projectWorkspaceHref(project.id),
    };
    if (items.length === firstProjectIndex) item.group = "Projects";
    items.push(item);
  }
  if (input.canCreateProjects) {
    const create: NavItem = {icon: "bi-plus-lg", id: NEW_PROJECT_NAV_ID, label: "New project"};
    if (items.length === firstProjectIndex) create.group = "Projects";
    items.push(create);
  }
  // Non-administrators keep their only route to the MCP & WebMCP setup screen.
  items.push(input.isAdministrator
    ? {group: "Tools", icon: "bi-gear", id: "administration", label: "Administration", link: administrationHref(true)}
    : {group: "Tools", icon: "bi-plug", id: "mcp", label: "MCP & WebMCP", link: administrationHref(false)});
  return items;
}

function orderedProjects(projects: readonly Project[]): Project[] {
  return projects.toSorted((left, right) => {
    const leftActive = left.archivedAt === null;
    const rightActive = right.archivedAt === null;
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}
