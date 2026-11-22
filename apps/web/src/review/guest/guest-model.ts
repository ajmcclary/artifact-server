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

const openSharePath = /^\/s\/([^/]+)$/u;
const resumeSharePath = /^\/review\/shared\/([^/]+)$/u;

/** Whether the address is shaped like a guest page, even one whose link cannot be read. */
export function isShareAddress(pathname: string): boolean {
  return openSharePath.test(pathname) || resumeSharePath.test(pathname);
}

/** Read a guest path; null for any other page, or for a malformed escape (the ended-link state). */
export function sharePathOf(pathname: string): SharePath | null {
  const open = openSharePath.exec(pathname);
  if (open?.[1] !== undefined) {
    const token = decodedSegment(open[1]);
    return token === null ? null : {kind: "open", token};
  }
  const resume = resumeSharePath.exec(pathname);
  if (resume?.[1] !== undefined) {
    const linkId = decodedSegment(resume[1]);
    return linkId === null ? null : {kind: "resume", linkId};
  }
  return null;
}

function decodedSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch (caught) {
    if (caught instanceof URIError) return null;
    throw caught;
  }
}
