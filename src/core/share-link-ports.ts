import type {ActionAttribution} from "./action-attribution.js";
import type {PageCursor} from "./model.js";
import type {Permission} from "./permissions.js";
import type {GuestRecord, GuestSessionRecord, ShareLink} from "./share-links.js";

/** A share link as written at creation; the store assigns the counters. */
export type ShareLinkDraft = Omit<ShareLink, "generation" | "guestCount" | "revision" | "revokedAt">;

/** Persistence for share links, their guests, and guest sessions (ADR 0033). */
export interface ShareLinkRepository {
  readonly createGuest: (command: {
    /** The version the activity row names: the artifact's current or pinned version. */
    readonly versionId: string;
    readonly attribution: ActionAttribution;
    readonly guest: GuestRecord;
    readonly installationId: string;
    readonly session: GuestSessionRecord & {readonly csrfDigest: string; readonly tokenDigest: string};
  }) => Promise<void>;
  readonly createShareLink: (command: {
    /** The version the activity row names: the artifact's current or pinned version. */
    readonly versionId: string;
    readonly attribution: ActionAttribution;
    readonly installationId: string;
    readonly link: ShareLinkDraft;
  }) => Promise<ShareLink>;
  readonly findGuest: (
    installationId: string,
    guestId: string,
  ) => Promise<{readonly guest: GuestRecord; readonly link: ShareLink} | null>;
  readonly findGuestSession: (
    installationId: string,
    tokenDigest: string,
  ) => Promise<{
    readonly guest: GuestRecord;
    readonly link: ShareLink;
    readonly session: GuestSessionRecord & {readonly csrfDigest: string};
  } | null>;
  readonly findShareLink: (installationId: string, linkId: string) => Promise<ShareLink | null>;
  readonly findShareLinkByToken: (
    token: string,
  ) => Promise<(ShareLink & {readonly installationId: string}) | null>;
  readonly listActiveShareLinks: (command: {
    readonly cursor: PageCursor | null;
    readonly installationId: string;
    readonly limit: number;
    readonly now: string;
  }) => Promise<{readonly items: readonly ShareLink[]; readonly nextCursor: PageCursor | null}>;
  readonly listArtifactShareLinks: (
    installationId: string,
    projectId: string,
    artifactId: string,
  ) => Promise<readonly ShareLink[]>;
  readonly revokeArtifactShareLinks: (command: {
    /** The version the activity row names: the artifact's current or pinned version. */
    readonly versionId: string;
    readonly artifactId: string;
    readonly attribution: ActionAttribution;
    readonly installationId: string;
    readonly projectId: string;
  }) => Promise<number>;
  readonly revokeShareLink: (command: {
    /** The version the activity row names: the artifact's current or pinned version. */
    readonly versionId: string;
    readonly attribution: ActionAttribution;
    readonly installationId: string;
    readonly linkId: string;
  }) => Promise<ShareLink | "missing">;
  /** Replace the token and end every guest who joined before (generation + 1). */
  readonly rotateShareLink: (command: {
    /** The version the activity row names: the artifact's current or pinned version. */
    readonly versionId: string;
    readonly attribution: ActionAttribution;
    readonly expectedRevision: number;
    readonly installationId: string;
    readonly linkId: string;
    readonly token: string;
  }) => Promise<ShareLink | "conflict" | "missing">;
  readonly setGuestIdentity: (command: {
    readonly contactEmail: string | null;
    readonly displayName: string;
    readonly guestId: string;
    readonly installationId: string;
  }) => Promise<GuestRecord>;
  readonly updateShareLink: (command: {
    /** The version the activity row names: the artifact's current or pinned version. */
    readonly versionId: string;
    readonly attribution: ActionAttribution;
    readonly expectedRevision: number;
    readonly expiresAt: string | null;
    readonly installationId: string;
    readonly label: string;
    readonly linkId: string;
    readonly permissions: readonly Permission[];
    readonly target: ShareLink["target"];
  }) => Promise<ShareLink | "conflict" | "missing">;
}
