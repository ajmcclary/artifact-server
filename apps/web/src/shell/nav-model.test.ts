import {describe, expect, it} from "vitest";

import type {Principal, Project} from "@/api/client";
import {
  administrationHref,
  canManageProjects,
  isInstallationAdministrator,
  NEW_PROJECT_NAV_ID,
  shellActiveLink,
  shellNavItems,
  type ShellNavInput,
} from "@/shell/nav-model";

function project(id: string, name: string, archivedAt: string | null = null): Project {
  return {
    archivedAt,
    createdAt: "2026-09-01T00:00:00.000Z",
    id,
    installationId: "ins_test",
    name,
  };
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    authorizedByPrincipalId: null,
    capabilities: [],
    id: "prn_test",
    installationId: "ins_test",
    kind: "human",
    membershipRole: "administrator",
    ...overrides,
  };
}

const reviewInput: ShellNavInput = {
  activeProjectId: null,
  activeSettings: null,
  canCreateProjects: true,
  isAdministrator: true,
  libraryActive: false,
  mode: "review",
  projects: [
    project("prj_old", "Zeta", "2026-09-02T00:00:00.000Z"),
    project("prj_default", "Default"),
    project("prj_b", "Beta"),
  ],
  queueActive: false,
  returnHref: "/review?project=prj_b&artifact=art_c",
};

describe("shellNavItems in review mode", () => {
  it("lists the queue, the design library, active projects by name, archived projects, then New project", () => {
    expect(shellNavItems(reviewInput)).toEqual([
      {group: "Review", icon: "bi-inbox", id: "queue", label: "Review queue", link: "/review"},
      {icon: "bi-collection", id: "library", label: "Design library", link: "/review/library?project=prj_b"},
      {
        group: "Projects",
        icon: "bi-folder2",
        id: "project:prj_b",
        label: "Beta",
        link: "/review?project=prj_b",
      },
      {icon: "bi-folder2", id: "project:prj_default", label: "Default", link: "/review?project=prj_default"},
      {icon: "bi-archive", id: "project:prj_old", label: "Zeta", link: "/review?project=prj_old"},
      {icon: "bi-plus-lg", id: NEW_PROJECT_NAV_ID, label: "New project"},
    ]);
  });

  it("omits New project for a principal that cannot manage projects", () => {
    const items = shellNavItems({...reviewInput, canCreateProjects: false});
    expect(items.map((item) => item.label)).toEqual(["Review queue", "Design library", "Beta", "Default", "Zeta"]);
  });

  it("starts the Projects group with New project when there are no projects", () => {
    expect(shellNavItems({...reviewInput, projects: []})).toEqual([
      {group: "Review", icon: "bi-inbox", id: "queue", label: "Review queue", link: "/review"},
      {icon: "bi-collection", id: "library", label: "Design library", link: "/review/library"},
      {group: "Projects", icon: "bi-plus-lg", id: NEW_PROJECT_NAV_ID, label: "New project"},
    ]);
  });
});

describe("shellNavItems in administration mode", () => {
  it("gives an administrator every administration screen and a way back", () => {
    expect(shellNavItems({...reviewInput, mode: "admin"})).toEqual([
      {
        group: "Administration",
        icon: "bi-people",
        id: "members",
        label: "Members",
        link: "/review/settings/members",
      },
      {icon: "bi-key", id: "api-keys", label: "API keys", link: "/review/settings/api-keys"},
      {icon: "bi-link-45deg", id: "public-links", label: "Public links", link: "/review/settings/public-links"},
      {icon: "bi-plug", id: "mcp", label: "MCP & WebMCP", link: "/review/settings/mcp"},
      {
        group: "Review",
        icon: "bi-arrow-left",
        id: "back-to-review",
        label: "Back to review",
        link: "/review?project=prj_b&artifact=art_c",
      },
    ]);
  });

  it("keeps Members, API keys, and Public links administrator-only", () => {
    const items = shellNavItems({...reviewInput, isAdministrator: false, mode: "admin"});
    expect(items.map((item) => item.label)).toEqual(["MCP & WebMCP", "Back to review"]);
    expect(items[0]?.group).toBe("Administration");
  });
});

describe("shellActiveLink", () => {
  it("marks the queue, the active project, or the active administration screen", () => {
    expect(shellActiveLink({...reviewInput, queueActive: true})).toBe("/review");
    expect(shellActiveLink({...reviewInput, activeProjectId: "prj_default", libraryActive: true})).toBe("/review/library?project=prj_default");
    expect(shellNavItems({...reviewInput, activeProjectId: "prj_default"}).find((item) => item.id === "library")?.link)
      .toBe("/review/library?project=prj_default");
    expect(shellActiveLink({...reviewInput, activeProjectId: "prj_default"}))
      .toBe("/review?project=prj_default");
    expect(shellActiveLink(reviewInput)).toBe("");
    expect(shellActiveLink({...reviewInput, activeSettings: "apiKeys", mode: "admin"}))
      .toBe("/review/settings/api-keys");
    // Both MCP routes render the one MCP & WebMCP screen, so both mark its row.
    expect(shellActiveLink({...reviewInput, activeSettings: "webmcp", mode: "admin"}))
      .toBe("/review/settings/mcp");
    expect(shellActiveLink({...reviewInput, activeSettings: "project", mode: "admin"})).toBe("");
  });
});

describe("principal permissions", () => {
  it("separates installation administration from project management", () => {
    expect(isInstallationAdministrator(principal())).toBe(true);
    expect(canManageProjects(principal())).toBe(true);
    expect(isInstallationAdministrator(principal({membershipRole: "member"}))).toBe(false);
    expect(canManageProjects(principal({membershipRole: "member"}))).toBe(true);
    const delegated = principal({authorizedByPrincipalId: "prn_owner", capabilities: ["project:manage"]});
    expect(isInstallationAdministrator(delegated)).toBe(false);
    expect(canManageProjects(delegated)).toBe(true);
    const service = principal({kind: "service", membershipRole: "member"});
    expect(isInstallationAdministrator(service)).toBe(false);
    expect(canManageProjects(service)).toBe(false);
  });

  it("opens administration on Members for administrators and on MCP otherwise", () => {
    expect(administrationHref(true)).toBe("/review/settings/members");
    expect(administrationHref(false)).toBe("/review/settings/mcp");
  });
});
