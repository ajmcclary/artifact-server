import type {ActivitySegment, ActivityType} from "@/api/client";

import {historyIndex, historyOrigin, type HistoryOrigin, pushHistoryEntry, replaceHistoryEntry} from "./review-history.ts";

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
  /** The conversation to select once the version's threads load. */
  readonly threadId: string | null;
  readonly versionId: string | null;
  readonly view: "focus" | null;
}

/** The screen one application URL resolves to. */
export type ReviewRoute =
  | {readonly kind: "activity"; readonly filters: ActivityFilters}
  | {readonly kind: "projects"; readonly projectId: string | null}
  | {readonly kind: "settings"; readonly settings: SettingsRoute}
  | {readonly kind: "workspace"; readonly location: ReviewLocation}
  | {readonly kind: "library"};

/** Window event fired after the application rewrites the review URL without a document load. */
export const REVIEW_LOCATION_EVENT = "artifact-review-location-changed";

/** Window event a phone's app bar fires to open the review's artifact list sheet. */
export const REVIEW_OPEN_CATALOG_EVENT = "artifact-review-open-catalog";

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

const libraryPathname = "/review/library";
/**
 * The Activity feed's filters, all carried in the bare /review URL.
 * The project filter uses `projects=`, never `project=`: a `/review?project=` URL is the workspace.
 */
export interface ActivityFilters {
  /** Principal IDs; the people filter uses `person=`. */
  readonly people: readonly string[];
  readonly projects: readonly string[];
  readonly q: string;
  readonly segment: ActivitySegment;
  readonly types: readonly ActivityType[];
}

export const emptyActivityFilters: ActivityFilters = {people: [], projects: [], q: "", segment: "all", types: []};

const activitySegments: readonly ActivitySegment[] = ["all", "needs_you", "with_agent"];
const activityTypes: readonly ActivityType[] = ["comments", "versions", "agents", "access", "admin"];
/** The server's own search limit; a longer value would only be refused. */
const activitySearchLimit = 100;
/** The server's own people-filter limit and identifier shape; anything else would only be refused. */
const activityPeopleLimit = 50;
const projectsPathname = "/review/projects";

/** Read the feed filters from a query string, dropping values the server does not accept. */
export function readActivityFilters(search: URLSearchParams): ActivityFilters {
  const segment = search.get("segment");
  const types = [...new Set(search.getAll("type"))].flatMap((type) => {
    const known = activityTypes.find((candidate) => candidate === type);
    return known === undefined ? [] : [known];
  });
  return {
    people: [...new Set(search.getAll("person").filter((id) => /^[A-Za-z0-9_:-]{1,200}$/u.test(id)))].slice(0, activityPeopleLimit),
    projects: [...new Set(search.getAll("projects").filter((id) => id !== ""))],
    q: (search.get("q") ?? "").trim().slice(0, activitySearchLimit),
    segment: activitySegments.find((candidate) => candidate === segment) ?? "all",
    types,
  };
}

/** The Activity feed's canonical URL: bare /review, with only the filters that narrow it. */
export function activityHref(filters: ActivityFilters = emptyActivityFilters): string {
  const search = new URLSearchParams();
  if (filters.segment !== "all") search.set("segment", filters.segment);
  for (const person of filters.people) search.append("person", person);
  for (const project of filters.projects) search.append("projects", project);
  for (const type of filters.types) search.append("type", type);
  if (filters.q !== "") search.set("q", filters.q);
  return search.size === 0 ? "/review" : `/review?${search}`;
}

/** The Projects screen, optionally with one project selected. */
export function projectsHref(projectId: string | null): string {
  return projectId === null || projectId === ""
    ? projectsPathname
    : `${projectsPathname}?${new URLSearchParams({project: projectId})}`;
}

/** The Library: every gallery across all projects, following current versions. */
export function libraryHref(): string {
  return libraryPathname;
}

/** Resolve one application URL to its screen. Bare `/review` is the Activity feed. */
export function parseReviewRoute(url: URL): ReviewRoute {
  if (isSettingsPath(url.pathname)) {
    return {kind: "settings", settings: parseSettingsRoute(url.pathname)};
  }
  if (url.pathname === projectsPathname || url.pathname === `${projectsPathname}/`) {
    const projectId = url.searchParams.get("project");
    return {kind: "projects", projectId: projectId === null || projectId === "" ? null : projectId};
  }
  if (url.pathname === libraryPathname || url.pathname === `${libraryPathname}/`) {
    // A pre-rollup `?project=` link still loads; the library always spans every project.
    return {kind: "library"};
  }
  const location = readReviewLocation(url.searchParams);
  return location.projectId === null && location.artifactId === null
    ? {kind: "activity", filters: readActivityFilters(url.searchParams)}
    : {kind: "workspace", location};
}

/** Read the review location one query string names. */
export function readReviewLocation(search: URLSearchParams): ReviewLocation {
  return {
    artifactId: search.get("artifact"),
    path: search.get("path"),
    projectId: search.get("project"),
    threadId: search.get("thread"),
    versionId: search.get("version"),
    view: search.get("view") === "focus" ? "focus" : null,
  };
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
  if (location.threadId !== null) search.set("thread", location.threadId);
  if (location.view !== null) search.set("view", location.view);
  return search.size === 0 ? activityHref() : `/review?${search}`;
}

/** The URL that opens one project's workspace on its first artifact. */
export function projectWorkspaceHref(projectId: string): string {
  return workspaceHref({
    artifactId: null,
    path: null,
    projectId,
    threadId: null,
    versionId: null,
    view: null,
  });
}

/**
 * Rewrite the review URL and tell the shell the location changed. A pushed
 * step inside one screen (a review's page) keeps the entry that screen was
 * opened from, so ‹ Back still returns straight to it.
 */
export function writeReviewHistory(href: string, entry: "push" | "replace"): void {
  if (entry === "push") {
    pushHistoryEntry(href, historyOrigin());
  } else {
    replaceHistoryEntry(href);
  }
  window.dispatchEvent(new Event(REVIEW_LOCATION_EVENT));
}

/**
 * A screen one level below a root on a phone — a review, or one project's
 * settings — which leads with ‹ Back to the screen it was opened from.
 */
export function isPushedScreen(route: ReviewRoute): boolean {
  return route.kind === "workspace" || (route.kind === "projects" && route.projectId !== null);
}

/**
 * Where a pushed screen opened at `href` returns to: the current entry, or,
 * when the current entry is already that kind of screen (another page, artifact
 * or project of it), the entry the current one came from.
 */
export function originFor(href: string): HistoryOrigin | null {
  const target = parseReviewRoute(new URL(href, window.location.origin));
  if (!isPushedScreen(target)) return null;
  const here = parseReviewRoute(new URL(window.location.href));
  if (isPushedScreen(here) && here.kind === target.kind) return historyOrigin();
  return {href: `${window.location.pathname}${window.location.search}`, idx: historyIndex()};
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

/**
 * Move to another application screen without a document load. The workspace
 * and the application route both re-read `window.location` on popstate, which
 * is the same path the browser's own back and forward take. Moving to the URL
 * already shown adds no history entry.
 */
export function navigateReview(
  href: string,
  options: {readonly replace?: boolean} = {},
): void {
  const current = `${window.location.pathname}${window.location.search}`;
  if (options.replace === true || href === current) {
    replaceHistoryEntry(href);
  } else {
    const target = parseReviewRoute(new URL(href, window.location.origin));
    const here = parseReviewRoute(new URL(window.location.href));
    pushHistoryEntry(href, originFor(href));
    // A new screen starts at its top; a filter or search on the same screen keeps the reader's place.
    if (window.scrollY > 0 && (target.kind !== here.kind || isPushedScreen(target))) window.scrollTo(0, 0);
  }
  window.dispatchEvent(new PopStateEvent("popstate", {state: window.history.state}));
}

/** Whether one same-origin pathname is a screen of this application rather than a document or API URL. */
export function isApplicationPath(pathname: string): boolean {
  return pathname === "/review" || pathname.startsWith("/review/");
}

/**
 * The in-application href a plain primary click on `anchor` should open in
 * place, or null when the browser must handle it: modified or non-primary
 * clicks, new-tab or download links, other origins, and non-application paths
 * (sign-in, APIs, artifact content) keep their native document navigation.
 */
export function inAppLinkTarget(event: MouseEvent, anchor: HTMLAnchorElement): string | null {
  if (
    event.defaultPrevented
    || event.button !== 0
    || event.metaKey
    || event.ctrlKey
    || event.shiftKey
    || event.altKey
    || anchor.hasAttribute("download")
    || (anchor.target !== "" && anchor.target !== "_self")
  ) {
    return null;
  }
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin || !isApplicationPath(url.pathname)) return null;
  return `${url.pathname}${url.search}`;
}
