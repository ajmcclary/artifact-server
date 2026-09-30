import type {Principal} from "@/api/client";
import {parseReviewRoute, reviewQueueHref} from "@/review/review-routes";
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
  it("ADM-006-B: the retired projects list replaces itself with the review queue", () => {
    for (const path of ["/review/settings", "/review/settings/", "/review/settings/projects"]) {
      expect(canonicalReviewRoute(parseReviewRoute(reviewUrl(path)))).toEqual({
        replaceWith: reviewQueueHref(),
        route: {kind: "queue"},
      });
    }
    const projectRoute = parseReviewRoute(reviewUrl("/review/settings/projects/prj_default"));
    expect(canonicalReviewRoute(projectRoute)).toEqual({replaceWith: null, route: projectRoute});
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
    const service = settingsAccess(principal({kind: "service"}));
    expect(resolveSettingsView({kind: "project", projectId: "prj_default"}, service))
      .toEqual({kind: "projectPermission"});
    const delegated = settingsAccess(principal({
      authorizedByPrincipalId: "prn_owner",
      capabilities: ["project:manage"],
      membershipRole: "administrator",
    }));
    expect(delegated).toEqual({administrator: false, canManageProjects: true});
    expect(resolveSettingsView({kind: "members"}, delegated))
      .toEqual({kind: "administratorPermission"});
    expect(resolveSettingsView({kind: "project", projectId: "prj_default"}, delegated))
      .toEqual({kind: "project", projectId: "prj_default"});
    const administrator = settingsAccess(principal({membershipRole: "administrator"}));
    expect(resolveSettingsView({kind: "publicLinks"}, administrator)).toEqual({kind: "publicLinks"});
    expect(resolveSettingsView({kind: "notFound"}, administrator)).toEqual({kind: "notFound"});
    expect(resolveSettingsView({kind: "projects"}, administrator))
      .toEqual({href: reviewQueueHref(), kind: "redirect"});
  });

});
