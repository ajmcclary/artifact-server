/** Which Review controls a guest's link permissions allow. */
export interface GuestShellControls {
  readonly comments: boolean;
  readonly composer: boolean;
}

/** The Comments panel needs comment.read; writing needs comment.write as well. */
export function guestShellControls(permissions: readonly string[]): GuestShellControls {
  const comments = permissions.includes("comment.read");
  return {comments, composer: comments && permissions.includes("comment.write")};
}

/** The banner across the guest shell, for example "Viewing as a guest via a link shared by Jordan · Expires Nov 1, 2026". */
export function guestBanner(createdByName: string, expiresAt: string | null, locale?: string): string {
  const base = `Viewing as a guest via a link shared by ${createdByName}`;
  if (expiresAt === null) return base;
  const date = new Date(expiresAt).toLocaleDateString(locale, {day: "numeric", month: "short", timeZone: "UTC", year: "numeric"});
  return `${base} · Expires ${date}`;
}

/** What the address names: a token to open, or a link whose session to resume. */
export type SharePath =
  | {readonly kind: "open"; readonly token: string}
  | {readonly kind: "resume"; readonly linkId: string};

/** Read a guest path; null for any other page. */
export function sharePathOf(pathname: string): SharePath | null {
  const open = /^\/s\/([^/]+)$/u.exec(pathname);
  if (open?.[1] !== undefined) return {kind: "open", token: decodeURIComponent(open[1])};
  const resume = /^\/review\/shared\/([^/]+)$/u.exec(pathname);
  if (resume?.[1] !== undefined) return {kind: "resume", linkId: decodeURIComponent(resume[1])};
  return null;
}
