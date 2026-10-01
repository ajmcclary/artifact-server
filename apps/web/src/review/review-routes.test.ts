import {describe, expect, it} from "vitest";

import {
  activityHref,
  emptyActivityFilters,
  isApplicationPath,
  libraryHref,
  parseReviewRoute,
  projectsHref,
  projectWorkspaceHref,
  readActivityFilters,
  readReviewLocation,
  reviewReturnHref,
  workspaceHref,
  type ReviewLocation,
} from "@/review/review-routes";

const origin = "http://127.0.0.1:4318";
const emptyLocation: ReviewLocation = {
  artifactId: null,
  path: null,
  projectId: null,
  threadId: null,
  versionId: null,
  view: null,
};

function routeOf(href: string) {
  return parseReviewRoute(new URL(href, origin));
}

describe("design library route", () => {
  it("round-trips the project the library shows and tolerates a missing one", () => {
    expect(libraryHref("prj_a b")).toBe("/review/library?project=prj_a+b");
    expect(routeOf(libraryHref("prj_a b"))).toEqual({kind: "library", projectId: "prj_a b"});
    expect(routeOf("/review/library")).toEqual({kind: "library", projectId: null});
    expect(routeOf("/review/library/?project=")).toEqual({kind: "library", projectId: null});
    expect(libraryHref(null)).toBe("/review/library");
  });
});

describe("activity route", () => {
  it("ACT-005: bare /review is Activity, and its filters round-trip through the URL", () => {
    expect(routeOf("/review")).toEqual({kind: "activity", filters: emptyActivityFilters});
    expect(routeOf("/review/")).toEqual({kind: "activity", filters: emptyActivityFilters});
    expect(routeOf("/review?view=focus")).toEqual({kind: "activity", filters: emptyActivityFilters});
    const filters = {projects: ["prj_a", "prj b"], q: "totals", segment: "needs_you", types: ["comments", "versions"]} as const;
    const href = activityHref(filters);
    expect(href).toBe("/review?segment=needs_you&projects=prj_a&projects=prj+b&type=comments&type=versions&q=totals");
    expect(routeOf(href)).toEqual({kind: "activity", filters});
    expect(activityHref()).toBe("/review");
    expect(activityHref(emptyActivityFilters)).toBe("/review");
  });

  it("ACT-005: unknown segments and types are dropped, and the search is trimmed to 100 characters", () => {
    const filters = readActivityFilters(new URLSearchParams(
      `segment=everything&type=comments&type=secrets&type=comments&q=${"x".repeat(140)}`,
    ));
    expect(filters.segment).toBe("all");
    expect(filters.types).toEqual(["comments"]);
    expect(filters.q).toHaveLength(100);
  });

  it("keeps a project-only URL on the workspace, never on Activity", () => {
    expect(routeOf("/review?project=prj_default&segment=needs_you")).toEqual({
      kind: "workspace",
      location: {...emptyLocation, projectId: "prj_default"},
    });
  });
});

describe("projects route", () => {
  it("ACT-005: /review/projects names its selected project", () => {
    expect(projectsHref(null)).toBe("/review/projects");
    expect(projectsHref("prj a")).toBe("/review/projects?project=prj+a");
    expect(routeOf("/review/projects")).toEqual({kind: "projects", projectId: null});
    expect(routeOf("/review/projects/?project=prj_a")).toEqual({kind: "projects", projectId: "prj_a"});
    expect(routeOf("/review/projects?project=")).toEqual({kind: "projects", projectId: null});
  });
});

describe("thread deep link", () => {
  it("ACT-005: a workspace URL carries the thread to select after every other parameter", () => {
    const location: ReviewLocation = {...emptyLocation, artifactId: "art_1", projectId: "prj_1", threadId: "thr_9", versionId: "ver_1"};
    expect(workspaceHref(location)).toBe("/review?project=prj_1&artifact=art_1&version=ver_1&thread=thr_9");
    expect(readReviewLocation(new URL(workspaceHref(location), origin).searchParams)).toEqual(location);
  });
});

describe("parseReviewRoute", () => {
  it("keeps a project-only URL on the workspace so its first artifact is still selected", () => {
    expect(routeOf("/review?project=prj_default")).toEqual({
      kind: "workspace",
      location: {...emptyLocation, projectId: "prj_default"},
    });
  });

  it("reads every workspace parameter and ignores an unknown view", () => {
    expect(routeOf(
      "/review?project=prj_a&artifact=art_b&version=ver_c&path=docs%2Fa.html&view=focus",
    )).toEqual({
      kind: "workspace",
      location: {
        artifactId: "art_b",
        path: "docs/a.html",
        projectId: "prj_a",
        threadId: null,
        versionId: "ver_c",
        view: "focus",
      },
    });
    expect(routeOf("/review?artifact=art_b&view=wide")).toEqual({
      kind: "workspace",
      location: {...emptyLocation, artifactId: "art_b"},
    });
  });

  it("resolves settings paths, including the legacy projects and WebMCP routes", () => {
    expect(routeOf("/review/settings")).toEqual({kind: "settings", settings: {kind: "projects"}});
    expect(routeOf("/review/settings/projects"))
      .toEqual({kind: "settings", settings: {kind: "projects"}});
    expect(routeOf("/review/settings/projects/prj_a"))
      .toEqual({kind: "settings", settings: {kind: "project", projectId: "prj_a"}});
    expect(routeOf("/review/settings/mcp")).toEqual({kind: "settings", settings: {kind: "mcp"}});
    expect(routeOf("/review/settings/webmcp"))
      .toEqual({kind: "settings", settings: {kind: "webmcp"}});
    expect(routeOf("/review/settings/members"))
      .toEqual({kind: "settings", settings: {kind: "members"}});
    expect(routeOf("/review/settings/api-keys"))
      .toEqual({kind: "settings", settings: {kind: "apiKeys"}});
    expect(routeOf("/review/settings/public-links"))
      .toEqual({kind: "settings", settings: {kind: "publicLinks"}});
    expect(routeOf("/review/settings/projects/a%2Fb"))
      .toEqual({kind: "settings", settings: {kind: "notFound"}});
    expect(routeOf("/review/settings/unknown"))
      .toEqual({kind: "settings", settings: {kind: "notFound"}});
  });
});

describe("review hrefs", () => {
  it("builds workspace hrefs in the canonical parameter order", () => {
    expect(workspaceHref({
      artifactId: "art_b",
      path: "docs/a.html",
      projectId: "prj_a",
      threadId: null,
      versionId: "ver_c",
      view: "focus",
    })).toBe("/review?project=prj_a&artifact=art_b&version=ver_c&path=docs%2Fa.html&view=focus");
    expect(workspaceHref(emptyLocation)).toBe(activityHref());
    expect(workspaceHref({...emptyLocation, projectId: ""})).toBe("/review");
    expect(projectWorkspaceHref("prj a&b")).toBe("/review?project=prj+a%26b");
  });

  it("round-trips a workspace location through its href", () => {
    const location: ReviewLocation = {
      artifactId: "art_1",
      path: "pages/index.html",
      projectId: "prj_1",
      threadId: null,
      versionId: "ver_1",
      view: null,
    };
    expect(readReviewLocation(new URL(workspaceHref(location), origin).searchParams))
      .toEqual(location);
  });

  it("returns to a stored URL only when it is a review workspace URL", () => {
    expect(reviewReturnHref(null)).toBe("/review");
    expect(reviewReturnHref("/review")).toBe("/review");
    expect(reviewReturnHref("/review?project=prj_a&artifact=art_b"))
      .toBe("/review?project=prj_a&artifact=art_b");
    expect(reviewReturnHref("/review/settings/mcp")).toBe("/review");
    expect(reviewReturnHref("https://example.test/review?project=prj_a")).toBe("/review");
    expect(reviewReturnHref("//example.test/review")).toBe("/review");
    expect(reviewReturnHref("/reviewer?project=prj_a")).toBe("/review");
  });
});

describe("in-place navigation", () => {
  it("opens only application screens in place, never the review frame, sign-in, APIs, or content", () => {
    expect(isApplicationPath("/review")).toBe(true);
    expect(isApplicationPath("/review/library")).toBe(true);
    expect(isApplicationPath("/review/settings/members")).toBe(true);
    expect(isApplicationPath("/review-frame")).toBe(false);
    expect(isApplicationPath("/reviewer")).toBe(false);
    expect(isApplicationPath("/auth/login")).toBe(false);
    expect(isApplicationPath("/api/v1/artifacts/art_1/archive")).toBe(false);
    expect(isApplicationPath("/")).toBe(false);
  });
});
