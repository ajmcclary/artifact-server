import {usDate, usDateTime} from "@/ui/activity-model";

/** The administration menu's remembered pin and width, under the review panel store. */
export const adminMenuPanelId = "admin-areas";

export type AdminAreaId = "apiKeys" | "invites" | "mcp" | "members" | "publicLinks";

/** One administration area: its menu row, route, and one-line lede. */
export interface AdminArea {
  readonly administratorOnly: boolean;
  readonly group: string;
  readonly href: string;
  readonly icon: string;
  readonly id: AdminAreaId;
  readonly label: string;
  readonly lede: string;
}

export const adminAreas: readonly AdminArea[] = [
  {
    administratorOnly: true,
    group: "People and access",
    href: "/review/settings/members",
    icon: "bi-people",
    id: "members",
    label: "Members",
    lede: "Members can open every project in this installation.",
  },
  {
    administratorOnly: true,
    group: "People and access",
    href: "/review/settings/invites",
    icon: "bi-person-plus",
    id: "invites",
    label: "Invites",
    lede: "Links that let someone join by signing in. Each link is shown once.",
  },
  {
    administratorOnly: true,
    group: "People and access",
    href: "/review/settings/api-keys",
    icon: "bi-key",
    id: "apiKeys",
    label: "API keys",
    lede: "Keys let agents and automation act with the capabilities you grant.",
  },
  {
    administratorOnly: true,
    group: "Sharing",
    href: "/review/settings/public-links",
    icon: "bi-link-45deg",
    id: "publicLinks",
    label: "Public links",
    lede: "Artifacts anyone with the link can open at their current version.",
  },
  {
    administratorOnly: false,
    group: "Integrations",
    href: "/review/settings/mcp",
    icon: "bi-plug",
    id: "mcp",
    label: "MCP & WebMCP",
    lede: "Connect AI clients to projects, artifacts, versions and comments.",
  },
];

/** The areas this principal may open; hidden areas are still refused by the server. */
export function visibleAdminAreas(administrator: boolean): readonly AdminArea[] {
  return adminAreas.filter((area) => administrator || !area.administratorOnly);
}

export function adminAreaById(id: AdminAreaId): AdminArea {
  const area = adminAreas.find((candidate) => candidate.id === id);
  if (area === undefined) throw new Error(`Unknown administration area ${id}.`);
  return area;
}

const selectedParameter = "selected";

/** The record whose detail pane a URL reopens, or null. */
export function readSelectedRecord(search: string): string | null {
  const value = new URLSearchParams(search).get(selectedParameter);
  return value === null || value === "" ? null : value;
}

/** The same screen's URL with `?selected=` set to `id`, or removed for null. */
export function selectedRecordHref(
  location: {readonly pathname: string; readonly search: string},
  id: string | null,
): string {
  const search = new URLSearchParams(location.search);
  if (id === null) search.delete(selectedParameter);
  else search.set(selectedParameter, id);
  return search.size === 0 ? location.pathname : `${location.pathname}?${search}`;
}

/** "Automatic", "Installation owner", the admitter's name (with "· Invite" for an invite), or a dash. */
export function admittedLabel(member: {
  readonly admittedBy: {readonly name: string} | null;
  readonly admittedHow: "automatic" | "invite" | "manual" | "owner" | null;
}): string {
  if (member.admittedHow === "automatic") return "Automatic";
  if (member.admittedHow === "owner") return "Installation owner";
  const admitter = member.admittedBy?.name ?? "—";
  return member.admittedHow === "invite" ? `${admitter} · Invite` : admitter;
}

function instantOf(iso: string | null): number {
  return iso === null ? Number.NaN : Date.parse(iso);
}

/** MM/DD/YYYY in local time, or a dash. */
export function dateOrDash(iso: string | null): string {
  const instant = instantOf(iso);
  return Number.isNaN(instant) ? "—" : usDate(instant);
}

/** MM/DD/YYYY h:mm AM/PM in local time, or a dash. */
export function dateTimeOrDash(iso: string | null): string {
  const instant = instantOf(iso);
  return Number.isNaN(instant) ? "—" : usDateTime(instant);
}

export type KeyStatus = "active" | "expired" | "revoked";

export function keyStatusLabel(status: KeyStatus): "Active" | "Expired" | "Revoked" {
  return status === "active" ? "Active" : status === "expired" ? "Expired" : "Revoked";
}

export function keyStatusTone(status: KeyStatus): "neutral" | "success" | "warning" {
  return status === "active" ? "success" : status === "expired" ? "warning" : "neutral";
}
