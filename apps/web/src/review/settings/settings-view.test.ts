import type {Principal} from "@/api/client";
import {parseReviewRoute, projectsHref} from "@/review/review-routes";
import {
  canonicalReviewRoute,
  resolveSettingsView,
  settingsAccess,
} from "@/review/settings/settings-view";
import {describe, expect, it} from "vitest";

function principal(overrides: Partial<Principal>): Principal {
  return {
    authorizedByPrincipalId: null,
    capabilities: [],
    id: "prn_settings",
    installationId: "ins_settings",
    kind: "human",
    membershipRole: "member",
    ...overrides,
  };
}

function reviewUrl(path: string): URL {
  return new URL(path, "https://artifacts.example.test");
}

describe("settings routing", () => {
  it("ADM-006-B: old project settings URLs replace themselves with the Projects screen", () => {
    for (const path of ["/review/settings", "/review/settings/", "/review/settings/projects"]) {
      expect(canonicalReviewRoute(parseReviewRoute(reviewUrl(path)))).toEqual({
        replaceWith: projectsHref(null),
        route: {kind: "projects", projectId: null},
      });
    }
    expect(canonicalReviewRoute(parseReviewRoute(reviewUrl("/review/settings/projects/prj_default")))).toEqual({
      replaceWith: projectsHref("prj_default"),
      route: {kind: "projects", projectId: "prj_default"},
    });
    const library = parseReviewRoute(reviewUrl("/review/library?project=prj_default"));
    expect(canonicalReviewRoute(library)).toEqual({replaceWith: null, route: library});
  });

  it("WMC-001-F: the MCP and WebMCP routes resolve to one MCP & WebMCP screen", () => {
    const member = settingsAccess(principal({}));
    expect(resolveSettingsView({kind: "mcp"}, member)).toEqual({administrator: false, kind: "mcp"});
    expect(resolveSettingsView({kind: "webmcp"}, member)).toEqual({administrator: false, kind: "mcp"});
    const administrator = settingsAccess(principal({membershipRole: "administrator"}));
    expect(resolveSettingsView({kind: "webmcp"}, administrator))
      .toEqual({administrator: true, kind: "mcp"});
  });

  it("ADM-006-F: direct unauthorized settings routes resolve to forbidden states, not empty data", () => {
    const member = settingsAccess(principal({}));
    for (const kind of ["members", "apiKeys", "publicLinks"] as const) {
      expect(resolveSettingsView({kind}, member)).toEqual({kind: "administratorPermission"});
    }
    const delegated = settingsAccess(principal({
      authorizedByPrincipalId: "prn_owner",
      capabilities: ["project:manage"],
      membershipRole: "administrator",
    }));
    expect(delegated).toEqual({administrator: false, canManageProjects: true});
    expect(resolveSettingsView({kind: "members"}, delegated))
      .toEqual({kind: "administratorPermission"});
    const administrator = settingsAccess(principal({membershipRole: "administrator"}));
    expect(resolveSettingsView({kind: "publicLinks"}, administrator)).toEqual({kind: "publicLinks"});
    expect(resolveSettingsView({kind: "notFound"}, administrator)).toEqual({kind: "notFound"});
    expect(resolveSettingsView({kind: "projects"}, administrator))
      .toEqual({href: projectsHref(null), kind: "redirect"});
    expect(resolveSettingsView({kind: "project", projectId: "prj_default"}, member))
      .toEqual({href: projectsHref("prj_default"), kind: "redirect"});
  });


});
