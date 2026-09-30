import type {Principal, Project} from "@/api/client";
import type {NavItem} from "@/arkcase";
import {
  projectWorkspaceHref,
  reviewQueueHref,
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
  readonly mode: ShellMode;
  readonly projects: readonly Project[];
  readonly queueActive: boolean;
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
    : reviewItems(input.projects, input.canCreateProjects);
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
  if (input.queueActive) return reviewQueueHref();
  return input.activeProjectId === null ? "" : projectWorkspaceHref(input.activeProjectId);
}

function isDirectHuman(principal: Principal): boolean {
  return principal.kind === "human" && principal.authorizedByPrincipalId === null;
}

function reviewItems(projects: readonly Project[], canCreateProjects: boolean): NavItem[] {
  const items: NavItem[] = [
    {group: "Review", icon: "bi-inbox", id: "queue", label: "Review queue", link: reviewQueueHref()},
  ];
  for (const project of orderedProjects(projects)) {
    const item: NavItem = {
      icon: project.archivedAt === null ? "bi-folder2" : "bi-archive",
      id: `project:${project.id}`,
      label: project.name,
      link: projectWorkspaceHref(project.id),
    };
    if (items.length === 1) item.group = "Projects";
    items.push(item);
  }
  if (canCreateProjects) {
    const create: NavItem = {icon: "bi-plus-lg", id: NEW_PROJECT_NAV_ID, label: "New project"};
    if (items.length === 1) create.group = "Projects";
    items.push(create);
  }
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
