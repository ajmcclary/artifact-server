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
  needsYou: null,
  projects: [
    project("prj_old", "Zeta", "2026-09-02T00:00:00.000Z"),
    project("prj_default", "Default"),
    project("prj_b", "Beta"),
  ],
  activityActive: false,
  projectsActive: false,
};

describe("shellNavItems in review mode", () => {
  it("ACT-005: lists Activity, Projects and the design library, then project folders, New project and administrator Tools", () => {
    expect(shellNavItems(reviewInput)).toEqual([
      {group: "Review", icon: "bi-inbox", id: "activity", label: "Activity", link: "/review"},
      {icon: "bi-briefcase", id: "projects", label: "Projects", link: "/review/projects"},
      {icon: "bi-collection", id: "library", label: "Design library", link: "/review/library"},
      {group: "Projects", icon: "bi-folder2", id: "project:prj_b", label: "Beta", link: "/review?project=prj_b"},
      {icon: "bi-folder2", id: "project:prj_default", label: "Default", link: "/review?project=prj_default"},
      {icon: "bi-archive", id: "project:prj_old", label: "Zeta", link: "/review?project=prj_old"},
      {icon: "bi-plus-lg", id: NEW_PROJECT_NAV_ID, label: "New project"},
      {group: "Tools", icon: "bi-gear", id: "administration", label: "Administration", link: "/review/settings/members"},
    ]);
  });

  it("ACT-005: gives a non-administrator MCP & WebMCP in Tools instead of Administration", () => {
    const items = shellNavItems({...reviewInput, canCreateProjects: false, isAdministrator: false});
    expect(items.map((item) => item.label)).toEqual(["Activity", "Projects", "Design library", "Beta", "Default", "Zeta", "MCP & WebMCP"]);
    expect(items.at(-1)).toEqual({group: "Tools", icon: "bi-plug", id: "mcp", label: "MCP & WebMCP", link: "/review/settings/mcp"});
  });

  it("starts the Projects group with New project when there are no projects", () => {
    expect(shellNavItems({...reviewInput, projects: []}).slice(3)).toEqual([
      {group: "Projects", icon: "bi-plus-lg", id: NEW_PROJECT_NAV_ID, label: "New project"},
      {group: "Tools", icon: "bi-gear", id: "administration", label: "Administration", link: "/review/settings/members"},
    ]);
  });
});

describe("shellActiveLink", () => {
  it("marks Activity, the active project, the library, or the active administration screen", () => {
    expect(shellActiveLink({...reviewInput, activityActive: true})).toBe("/review");
    expect(shellActiveLink({...reviewInput, projectsActive: true})).toBe("/review/projects");
    // The Projects screen marks the Projects row, whichever project it has selected.
    expect(shellActiveLink({...reviewInput, activeProjectId: "prj_default", projectsActive: true}))
      .toBe("/review/projects");
    expect(shellActiveLink({...reviewInput, libraryActive: true})).toBe("/review/library");
    expect(shellActiveLink({...reviewInput, activeProjectId: "prj_default", libraryActive: true})).toBe("/review/library");
    // A project folder opens that project's artifacts, and is current while they show.
    expect(shellActiveLink({...reviewInput, activeProjectId: "prj_default"}))
      .toBe("/review?project=prj_default");
    expect(shellNavItems({...reviewInput, activeProjectId: "prj_default"}).find((item) => item.id === "library")?.link)
      .toBe("/review/library");
    expect(shellActiveLink(reviewInput)).toBe("");
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

describe("settings routes keep the review navigation", () => {
  it("never swaps item sets, and marks the Tools item current on settings screens", () => {
    const onKeys = {...reviewInput, activeSettings: "apiKeys" as const};
    expect(shellNavItems(onKeys)).toEqual(shellNavItems(reviewInput));
    expect(shellActiveLink(onKeys)).toBe("/review/settings/members");
    expect(shellActiveLink({...reviewInput, activeSettings: "webmcp" as const})).toBe("/review/settings/members");
  });

  it("marks MCP & WebMCP current for a non-administrator on the MCP screen", () => {
    const member = {...reviewInput, activeSettings: "mcp" as const, canCreateProjects: false, isAdministrator: false};
    expect(shellNavItems(member).at(-1)).toEqual({group: "Tools", icon: "bi-plug", id: "mcp", label: "MCP & WebMCP", link: "/review/settings/mcp"});
    expect(shellActiveLink(member)).toBe("/review/settings/mcp");
  });
});

describe("Activity's Needs-you badge", () => {
  it("ACT-005: counts waiting conversations on the Activity row, and shows nothing when none wait or the count is unknown", () => {
    const activity = (needsYou: number | null) => shellNavItems({...reviewInput, needsYou}).find((item) => item.id === "activity");
    expect(activity(3)?.count).toBe(3);
    expect(activity(0)).not.toHaveProperty("count");
    expect(activity(null)).not.toHaveProperty("count");
  });
});
