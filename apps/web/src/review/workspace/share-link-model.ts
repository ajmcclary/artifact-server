/** Copy for every revoke confirmation. */
export const revokeLinkWarning = "People with this link lose access now. Their comments stay.";

/** The permissions a share link can grant, in display order. */
export const guestPermissionOrder = ["artifact.view", "comment.read", "comment.write"] as const;

export type GuestPermission = (typeof guestPermissionOrder)[number];

/** How a link's permissions were chosen in the form. */
export type ShareLinkPreset = "comment" | "custom" | "view";

const viewOnly: readonly GuestPermission[] = ["artifact.view"];
const viewAndComment: readonly GuestPermission[] = guestPermissionOrder;

/** The permissions a preset grants. Custom sets always include viewing. */
export function presetPermissions(
  preset: ShareLinkPreset,
  custom: readonly GuestPermission[],
): readonly GuestPermission[] {
  if (preset === "view") return viewOnly;
  if (preset === "comment") return viewAndComment;
  const chosen = new Set<GuestPermission>([...custom, "artifact.view"]);
  return guestPermissionOrder.filter((permission) => chosen.has(permission));
}

/** The preset a stored permission set reads as. */
export function presetOf(permissions: readonly string[]): ShareLinkPreset {
  const held = new Set(permissions);
  const matches = (preset: readonly GuestPermission[]) =>
    held.size === preset.length && preset.every((permission) => held.has(permission));
  if (matches(viewOnly)) return "view";
  if (matches(viewAndComment)) return "comment";
  return "custom";
}

const presetLabels = {comment: "View and comment", custom: "Custom", view: "View only"} as const;

/** The form's label for a preset. */
export function presetLabel(preset: ShareLinkPreset): string {
  return presetLabels[preset];
}

/** What a summary line reads from a link. */
export interface ShareLinkSummaryInput {
  readonly expiresAt: string | null;
  readonly guestCount: number;
  readonly permissions: readonly string[];
  readonly revokedAt: string | null;
  readonly target: {readonly kind: "latest"} | {readonly kind: "pinned"; readonly versionId: string};
}

const dayMilliseconds = 86_400_000;

function expiryLabel(link: ShareLinkSummaryInput, now: string): string {
  if (link.revokedAt !== null) return "Revoked";
  if (link.expiresAt === null) return "Never expires";
  const remaining = Date.parse(link.expiresAt) - Date.parse(now);
  if (remaining <= 0) return "Expired";
  if (remaining < dayMilliseconds) return "Expires in under a day";
  const days = Math.round(remaining / dayMilliseconds);
  return `Expires in ${days} ${days === 1 ? "day" : "days"}`;
}

/** One line describing a link, for example "View and comment · This version (v2) · Expires in 6 days · 3 guests". */
export function linkSummary(link: ShareLinkSummaryInput, now: string, versionNumber: number | null): string {
  const target = link.target.kind === "latest"
    ? "Latest"
    : versionNumber === null ? "This version" : `This version (v${versionNumber})`;
  const guests = link.guestCount === 0
    ? "No guests yet"
    : `${link.guestCount} ${link.guestCount === 1 ? "guest" : "guests"}`;
  return [presetLabel(presetOf(link.permissions)), target, expiryLabel(link, now), guests].join(" · ");
}

/** One choice in the expiry menu; null days means the link never expires. */
export interface ExpiryChoice {
  readonly days: number | null;
  readonly label: string;
}

/** Expiries the policy allows: never (only without a maximum), 1, 7 and 30 days, capped at the maximum. */
export function expiryChoices(maxExpiryDays: number | null): readonly ExpiryChoice[] {
  const days = [1, 7, 30].filter((count) => maxExpiryDays === null || count < maxExpiryDays);
  if (maxExpiryDays !== null) days.push(maxExpiryDays);
  const bounded = days.map((count) => ({days: count, label: count === 1 ? "1 day" : `${count} days`}));
  return maxExpiryDays === null ? [{days: null, label: "Never"}, ...bounded] : bounded;
}

/** The ISO instant a link chosen now with this expiry ends, or null. */
export function expiryInstant(days: number | null, now: Date): string | null {
  return days === null ? null : new Date(now.getTime() + days * dayMilliseconds).toISOString();
}
