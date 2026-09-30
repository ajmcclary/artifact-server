import {describe, expect, it} from "vitest";

import {
  isApplicationPath,
  libraryHref,
  parseReviewRoute,
  projectWorkspaceHref,
  readReviewLocation,
  reviewQueueHref,
  reviewReturnHref,
  workspaceHref,
  type ReviewLocation,
} from "@/review/review-routes";

const origin = "http://127.0.0.1:4318";
const emptyLocation: ReviewLocation = {
  artifactId: null,
  path: null,
  projectId: null,
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

describe("parseReviewRoute", () => {
  it("resolves bare /review to the review queue", () => {
    expect(routeOf("/review")).toEqual({kind: "queue"});
    expect(routeOf("/review/")).toEqual({kind: "queue"});
    expect(routeOf("/review?view=focus")).toEqual({kind: "queue"});
  });

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
  it("names the queue with bare /review", () => {
    expect(reviewQueueHref()).toBe("/review");
  });

  it("builds workspace hrefs in the canonical parameter order", () => {
    expect(workspaceHref({
      artifactId: "art_b",
      path: "docs/a.html",
      projectId: "prj_a",
      versionId: "ver_c",
      view: "focus",
    })).toBe("/review?project=prj_a&artifact=art_b&version=ver_c&path=docs%2Fa.html&view=focus");
    expect(workspaceHref(emptyLocation)).toBe(reviewQueueHref());
    expect(workspaceHref({...emptyLocation, projectId: ""})).toBe("/review");
    expect(projectWorkspaceHref("prj a&b")).toBe("/review?project=prj+a%26b");
  });

  it("round-trips a workspace location through its href", () => {
    const location: ReviewLocation = {
      artifactId: "art_1",
      path: "pages/index.html",
      projectId: "prj_1",
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
