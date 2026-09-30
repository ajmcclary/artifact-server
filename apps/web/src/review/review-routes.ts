/** One canonical settings destination inside the Artifact Server application. */
export type SettingsRoute =
  | {readonly kind: "projects"}
  | {readonly kind: "project"; readonly projectId: string}
  | {readonly kind: "mcp"}
  | {readonly kind: "webmcp"}
  | {readonly kind: "members"}
  | {readonly kind: "apiKeys"}
  | {readonly kind: "publicLinks"}
  | {readonly kind: "notFound"};

/** The project, artifact, version, file, and view a review URL names; null means not named. */
export interface ReviewLocation {
  readonly artifactId: string | null;
  readonly path: string | null;
  readonly projectId: string | null;
  readonly versionId: string | null;
  readonly view: "focus" | null;
}

/** The screen one application URL resolves to. */
export type ReviewRoute =
  | {readonly kind: "queue"}
  | {readonly kind: "settings"; readonly settings: SettingsRoute}
  | {readonly kind: "workspace"; readonly location: ReviewLocation};

/** Session-storage key holding the last review workspace URL that "Back to review" returns to. */
export const REVIEW_RETURN_URL_KEY = "artifact-review-return-url";

/** Window event fired after the application rewrites the review URL without a document load. */
export const REVIEW_LOCATION_EVENT = "artifact-review-location-changed";

/** Return whether the current document path belongs to the settings mode. */
export function isSettingsPath(pathname: string): boolean {
  return pathname === "/review/settings"
    || pathname.startsWith("/review/settings/");
}

/** Parse one refresh-safe settings URL without guessing a missing identity. */
export function parseSettingsRoute(pathname: string): SettingsRoute {
  if (pathname === "/review/settings" || pathname === "/review/settings/") {
    return {kind: "projects"};
  }
  const segments = pathname.split("/").filter((segment) => segment !== "");
  if (segments[0] !== "review" || segments[1] !== "settings") {
    return {kind: "notFound"};
  }
  if (segments.length === 3) {
    switch (segments[2]) {
      case "projects":
        return {kind: "projects"};
      case "mcp":
        return {kind: "mcp"};
      case "webmcp":
        return {kind: "webmcp"};
      case "members":
        return {kind: "members"};
      case "api-keys":
        return {kind: "apiKeys"};
      case "public-links":
        return {kind: "publicLinks"};
      default:
        return {kind: "notFound"};
    }
  }
  if (segments.length === 4 && segments[2] === "projects") {
    const projectId = parsePathSegment(segments[3]);
    return projectId === null
      ? {kind: "notFound"}
      : {kind: "project", projectId};
  }
  return {kind: "notFound"};
}

/** Resolve one application URL to its screen. Bare `/review` is the review queue. */
export function parseReviewRoute(url: URL): ReviewRoute {
  if (isSettingsPath(url.pathname)) {
    return {kind: "settings", settings: parseSettingsRoute(url.pathname)};
  }
  const location = readReviewLocation(url.searchParams);
  return location.projectId === null && location.artifactId === null
    ? {kind: "queue"}
    : {kind: "workspace", location};
}

/** Read the review location one query string names. */
export function readReviewLocation(search: URLSearchParams): ReviewLocation {
  return {
    artifactId: search.get("artifact"),
    path: search.get("path"),
    projectId: search.get("project"),
    versionId: search.get("version"),
    view: search.get("view") === "focus" ? "focus" : null,
  };
}

/** The review queue's canonical URL. */
export function reviewQueueHref(): string {
  return "/review";
}

/** Build the canonical review URL for one location, in project, artifact, version, path, view order. */
export function workspaceHref(location: ReviewLocation): string {
  const search = new URLSearchParams();
  if (location.projectId !== null && location.projectId !== "") {
    search.set("project", location.projectId);
  }
  if (location.artifactId !== null) search.set("artifact", location.artifactId);
  if (location.versionId !== null) search.set("version", location.versionId);
  if (location.path !== null) search.set("path", location.path);
  if (location.view !== null) search.set("view", location.view);
  return search.size === 0 ? reviewQueueHref() : `/review?${search}`;
}

/** The URL that opens one project's workspace on its first artifact. */
export function projectWorkspaceHref(projectId: string): string {
  return workspaceHref({
    artifactId: null,
    path: null,
    projectId,
    versionId: null,
    view: null,
  });
}

/** The stored review URL when it names a review workspace, otherwise the queue. */
export function reviewReturnHref(stored: string | null): string {
  if (stored !== null && (stored === "/review" || stored.startsWith("/review?"))) {
    return stored;
  }
  return reviewQueueHref();
}

/** Rewrite the review URL in place and tell the shell the location changed. */
export function writeReviewHistory(href: string, entry: "push" | "replace"): void {
  if (entry === "push") {
    window.history.pushState(null, "", href);
  } else {
    window.history.replaceState(null, "", href);
  }
  window.dispatchEvent(new Event(REVIEW_LOCATION_EVENT));
}

/** Build the canonical settings URL for one project. */
export function projectSettingsHref(projectId: string): string {
  return `/review/settings/projects/${encodeURIComponent(projectId)}`;
}

function parsePathSegment(segment: string | undefined): string | null {
  if (segment === undefined || segment === "") return null;
  try {
    const decoded = decodeURIComponent(segment);
    return decoded === "" || decoded.includes("/") ? null : decoded;
  } catch {
    return null;
  }
}
