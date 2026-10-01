import type {Principal, Project} from "@/api/client";
import type {NavItem} from "@/arkcase";
import {
  activityHref,
  libraryHref,
  projectsHref,
  type SettingsRoute,
} from "@/review/review-routes";

/** Which item set the application navigation shows. */
export type ShellMode = "admin" | "review";

/** The `id` of the link-less navigation row that opens the New project dialog. */
export const NEW_PROJECT_NAV_ID = "new-project";

/** Everything the navigation needs to know about the current screen and principal. */
export interface ShellNavInput {
  readonly activeProjectId: string | null;
  readonly activeSettings: SettingsRoute["kind"] | null;
  readonly canCreateProjects: boolean;
  readonly isAdministrator: boolean;
  /** The design library is open. */
  readonly libraryActive: boolean;
  readonly mode: ShellMode;
  readonly projects: readonly Project[];
  readonly activityActive: boolean;
  readonly projectsActive: boolean;
  readonly returnHref: string;
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

/** The navigation rows for the current mode; `link` values are real hrefs. */
export function shellNavItems(input: ShellNavInput): NavItem[] {
  return input.mode === "admin"
    ? administrationItems(input.isAdministrator, input.returnHref)
    : reviewItems(input);
}

/** The `link` of the current row, or "" when no row is current. */
export function shellActiveLink(input: ShellNavInput): string {
  if (input.mode === "admin") {
    switch (input.activeSettings) {
      case "apiKeys":
        return administrationHrefs.apiKeys;
      case "mcp":
        return administrationHrefs.mcp;
      case "members":
        return administrationHrefs.members;
      case "publicLinks":
        return administrationHrefs.publicLinks;
      case "webmcp":
        return administrationHrefs.mcp;
      default:
        return "";
    }
  }
  if (input.activityActive) return activityHref();
  if (input.libraryActive) return libraryHref();
  if (input.projectsActive && input.activeProjectId === null) return projectsHref(null);
  return input.activeProjectId === null ? "" : projectsHref(input.activeProjectId);
}

function isDirectHuman(principal: Principal): boolean {
  return principal.kind === "human" && principal.authorizedByPrincipalId === null;
}

function reviewItems(input: ShellNavInput): NavItem[] {
  const items: NavItem[] = [
    {group: "Review", icon: "bi-activity", id: "activity", label: "Activity", link: activityHref()},
    {icon: "bi-folder2-open", id: "projects", label: "Projects", link: projectsHref(null)},
    {icon: "bi-collection", id: "library", label: "Design library", link: libraryHref()},
  ];
  const firstProjectIndex = items.length;
  for (const project of orderedProjects(input.projects)) {
    const item: NavItem = {
      icon: project.archivedAt === null ? "bi-folder2" : "bi-archive",
      id: `project:${project.id}`,
      label: project.name,
      link: projectsHref(project.id),
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

function administrationItems(isAdministrator: boolean, returnHref: string): NavItem[] {
  const items: NavItem[] = [];
  if (isAdministrator) {
    items.push(
      {icon: "bi-people", id: "members", label: "Members", link: administrationHrefs.members},
      {icon: "bi-key", id: "api-keys", label: "API keys", link: administrationHrefs.apiKeys},
      {
        icon: "bi-link-45deg",
        id: "public-links",
        label: "Public links",
        link: administrationHrefs.publicLinks,
      },
    );
  }
  // Both MCP routes render one MCP & WebMCP screen.
  items.push({icon: "bi-plug", id: "mcp", label: "MCP & WebMCP", link: administrationHrefs.mcp});
  const [first] = items;
  if (first !== undefined) first.group = "Administration";
  items.push({
    group: "Review",
    icon: "bi-arrow-left",
    id: "back-to-review",
    label: "Back to review",
    link: returnHref,
  });
  return items;
}
