import type {Principal} from "@/api/client";
import {projectsHref, type ReviewRoute, type SettingsRoute} from "../review-routes.ts";

/** What the signed-in principal may administer. */
export interface SettingsAccess {
  readonly administrator: boolean;
  readonly canManageProjects: boolean;
}

/** The one screen or state a settings URL shows for this principal. */
export type SettingsView =
  | {readonly kind: "administratorPermission"}
  | {readonly kind: "apiKeys"}
  | {readonly kind: "mcp"; readonly administrator: boolean}
  | {readonly kind: "members"}
  | {readonly kind: "notFound"}
  | {readonly kind: "project"; readonly projectId: string}
  | {readonly kind: "projectPermission"}
  | {readonly kind: "publicLinks"}
  | {readonly kind: "redirect"; readonly href: string};

/** A parsed route plus the URL that should replace the current history entry, if any. */
export interface CanonicalReviewRoute {
  readonly replaceWith: string | null;
  readonly route: ReviewRoute;
}

/** Derive administration rights: direct humans manage projects; only direct administrators manage the installation. */
export function settingsAccess(principal: Principal): SettingsAccess {
  const directHuman = principal.kind === "human"
    && principal.authorizedByPrincipalId === null;
  return {
    administrator: directHuman && principal.membershipRole === "administrator",
    canManageProjects: directHuman || principal.capabilities.includes("project:manage"),
  };
}

/** Old project settings bookmarks land on the Projects screen with a replaced history entry. */
export function canonicalReviewRoute(route: ReviewRoute): CanonicalReviewRoute {
  if (route.kind === "settings" && route.settings.kind === "projects") {
    return {replaceWith: projectsHref(null), route: {kind: "projects", projectId: null}};
  }
  if (route.kind === "settings" && route.settings.kind === "project") {
    const projectId = route.settings.projectId;
    return {replaceWith: projectsHref(projectId), route: {kind: "projects", projectId}};
  }
  return {replaceWith: null, route};
}

/** Map one settings route to its screen, or to the permission state that replaces it. */
export function resolveSettingsView(route: SettingsRoute, access: SettingsAccess): SettingsView {
  switch (route.kind) {
    case "projects":
      return {href: projectsHref(null), kind: "redirect"};
    case "notFound":
      return {kind: "notFound"};
    case "project":
      return access.canManageProjects
        ? {kind: "project", projectId: route.projectId}
        : {kind: "projectPermission"};
    case "mcp":
    case "webmcp":
      return {administrator: access.administrator, kind: "mcp"};
    case "members":
      return access.administrator ? {kind: "members"} : {kind: "administratorPermission"};
    case "apiKeys":
      return access.administrator ? {kind: "apiKeys"} : {kind: "administratorPermission"};
    case "publicLinks":
      break;
  }
  return access.administrator ? {kind: "publicLinks"} : {kind: "administratorPermission"};
}
