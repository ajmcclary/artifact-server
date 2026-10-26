import {Context, DateTime, Effect, Layer, type Redacted} from "effect";

import {
  type ArtifactRepositoryFailure,
  CommentNotFound,
  GuestIdentityRequired,
  GuestRateLimited,
  GuestSessionRequired,
  GuestVersionChanged,
  ShareLinkNotFound,
} from "../core/errors.js";
import {membershipRoles, principalKinds, type Principal} from "../core/identity.js";
import type {ArtifactRecord, CommentThreadState, ProjectRecord, VersionRecord} from "../core/model.js";
import type {Permission} from "../core/permissions.js";
import type {IdGenerator} from "../core/ports.js";
import {
  guestSessionExpiry,
  isShareLinkActive,
  normalizeGuestDisplayName,
  type GuestRecord,
  type ShareLink,
} from "../core/share-links.js";
import {stripInvisibleControls} from "../core/untrusted-text.js";
import type {ApplicationClock} from "./application-clock.js";
import {
  type ArtifactCommentFailure,
  ArtifactCommentService,
} from "./artifact-comments.js";
import {
  type AccessRepositoryEffects,
  type AuthorizationOperations,
  AuthorizationService,
  type ScopedDenial,
} from "./authorization.js";
import {
  type ContentAccessFailure,
  ContentAccessService,
} from "./content-access.js";
import {resolveActiveGuest} from "./guest-links.js";
import type {IdentitySecretProvider} from "./installation-access.js";
import type {ShareLinkRepositoryEffects} from "./share-links.js";

/** Longest a guest's optional contact email may be. */
export const maximumGuestEmailLength = 320;

/** Reads, identifiers, and secrets the guest service depends on. */
export interface GuestReviewDependencies {
  readonly access: AccessRepositoryEffects;
  readonly clock: ApplicationClock;
  readonly findArtifact: (projectId: string, artifactId: string) => Effect.Effect<ArtifactRecord | null, ArtifactRepositoryFailure>;
  readonly findProject: (projectId: string) => Effect.Effect<ProjectRecord | null, ArtifactRepositoryFailure>;
  readonly findVersion: (
    projectId: string,
    artifactId: string,
    versionId: string,
  ) => Effect.Effect<VersionRecord | null, ArtifactRepositoryFailure>;
  readonly ids: IdGenerator;
  readonly installationId: string;
  readonly secrets: IdentitySecretProvider;
  readonly shareLinks: ShareLinkRepositoryEffects;
}

/** What a guest's Review shell shows about where they are. */
export interface GuestContext {
  readonly artifact: {readonly id: string; readonly name: string};
  readonly guest: {readonly displayName: string | null; readonly id: string};
  readonly link: {
    readonly createdByName: string;
    readonly expiresAt: string | null;
    readonly id: string;
    readonly label: string;
    readonly permissions: readonly Permission[];
  };
  readonly project: {readonly id: string; readonly name: string};
  readonly version: {readonly id: string; readonly number: number; readonly savedAt: string};
}

/** Every expected failure of guest review. */
export type GuestReviewFailure =
  | ArtifactCommentFailure
  | ArtifactRepositoryFailure
  | ContentAccessFailure
  | GuestIdentityRequired
  | GuestRateLimited
  | GuestSessionRequired
  | GuestVersionChanged
  | ScopedDenial
  | ShareLinkNotFound;

/** Opening a link: the token, the browser's existing session for a link, and whether a new guest may join. */
export interface StartGuestSessionCommand {
  /** Seconds until this link may admit another new guest, or null to admit one now. */
  readonly admissionWait: (linkId: string) => number | null;
  /** The session and CSRF tokens this browser already holds for a link, if any. */
  readonly existingSession: (linkId: string) => {readonly csrfToken: string; readonly sessionToken: string} | null;
  readonly token: string;
}

interface GuestThreadCommand {
  readonly principal: Principal;
  readonly threadId: string;
  /** The version the guest is looking at; null when the caller does not say. */
  readonly viewingVersionId: string | null;
}

interface GuestReviewOperations {
  readonly authenticate: (command: {readonly sessionToken: string}) => Effect.Effect<{
    readonly context: GuestContext;
    readonly csrfDigest: string;
    readonly principal: Principal;
  }, GuestReviewFailure>;
  readonly context: (principal: Principal) => Effect.Effect<GuestContext, GuestReviewFailure>;
  readonly createReply: (command: GuestThreadCommand & {
    readonly body: string;
    readonly idempotencyKey: string;
  }) => Effect.Effect<Effect.Success<ReturnType<ArtifactCommentService["Service"]["createReply"]>>, GuestReviewFailure>;
  readonly createThread: (command: {
    readonly anchor: unknown;
    readonly body: string;
    readonly idempotencyKey: string;
    readonly path: string | null;
    readonly principal: Principal;
    /** The version the guest is looking at; null when the caller does not say. */
    readonly viewingVersionId: string | null;
  }) => Effect.Effect<Effect.Success<ReturnType<ArtifactCommentService["Service"]["createThread"]>>, GuestReviewFailure>;
  readonly deleteReply: (command: GuestThreadCommand & {readonly replyId: string}) => Effect.Effect<void, GuestReviewFailure>;
  readonly deleteThread: (command: GuestThreadCommand) => Effect.Effect<void, GuestReviewFailure>;
  readonly getThread: (
    command: GuestThreadCommand,
  ) => Effect.Effect<Effect.Success<ReturnType<ArtifactCommentService["Service"]["getThread"]>>, GuestReviewFailure>;
  readonly issuePreviewLease: (command: {readonly principal: Principal}) => Effect.Effect<{
    readonly expiresAt: string;
    readonly token: Redacted.Redacted;
    readonly versionId: string;
  }, GuestReviewFailure>;
  readonly listThreads: (command: {
    readonly cursor: Parameters<ArtifactCommentService["Service"]["listThreads"]>[0]["cursor"];
    readonly limit: number;
    readonly principal: Principal;
    readonly viewingVersionId: string | null;
  }) => Effect.Effect<Effect.Success<ReturnType<ArtifactCommentService["Service"]["listThreads"]>>, GuestReviewFailure>;
  readonly setIdentity: (command: {
    readonly contactEmail: string | null;
    readonly displayName: string;
    readonly principal: Principal;
  }) => Effect.Effect<GuestContext, GuestReviewFailure>;
  readonly setThreadState: (command: GuestThreadCommand & {
    readonly state: CommentThreadState;
  }) => Effect.Effect<Effect.Success<ReturnType<ArtifactCommentService["Service"]["updateThread"]>>, GuestReviewFailure>;
  readonly startSession: (command: StartGuestSessionCommand) => Effect.Effect<{
    readonly context: GuestContext;
    readonly csrfToken: string;
    readonly expiresAt: string;
    /** True when the browser's existing session for this link was resumed; no new guest exists. */
    readonly resumed: boolean;
    readonly sessionToken: string;
  }, GuestReviewFailure>;
  readonly updateReply: (command: GuestThreadCommand & {
    readonly body: string;
    readonly replyId: string;
  }) => Effect.Effect<Effect.Success<ReturnType<ArtifactCommentService["Service"]["updateReply"]>>, GuestReviewFailure>;
  readonly updateThread: (command: GuestThreadCommand & {
    readonly body: string;
  }) => Effect.Effect<Effect.Success<ReturnType<ArtifactCommentService["Service"]["updateThread"]>>, GuestReviewFailure>;
}

/** Review for people without an account, bounded to one share link's version target (ADR 0033). */
export class GuestReviewService extends Context.Service<GuestReviewService, GuestReviewOperations>()(
  "artifact-server/application/GuestReviewService",
) {
  static readonly layer = (
    dependencies: GuestReviewDependencies,
  ): Layer.Layer<GuestReviewService, never, ArtifactCommentService | AuthorizationService | ContentAccessService> =>
    Layer.effect(
      GuestReviewService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        const comments = yield* ArtifactCommentService;
        const content = yield* ContentAccessService;
        return makeGuestReviewService(dependencies, authorization, comments, content);
      }),
    );
}

// Every refusal to open a link reads the same, so a token's state is never disclosed.
const linkEnded = () => new ShareLinkNotFound({message: "This link has ended or is not valid."});
const sessionRequired = () => new GuestSessionRequired({message: "Open the share link again to continue."});

const scopeOf = (link: ShareLink) => ({artifactId: link.artifactId, projectId: link.projectId});

function guestPrincipal(installationId: string, guest: GuestRecord, link: ShareLink): Principal {
  return {
    authorizedByPrincipalId: link.createdByPrincipalId,
    capabilities: [],
    displayName: guest.displayName ?? "Guest",
    id: guest.id,
    installationId,
    kind: principalKinds.guest,
    membershipRole: membershipRoles.member,
    projectIds: [link.projectId],
  };
}

function makeGuestReviewService(
  dependencies: GuestReviewDependencies,
  authorization: AuthorizationOperations,
  comments: ArtifactCommentService["Service"],
  content: ContentAccessService["Service"],
): GuestReviewOperations {
  const {installationId} = dependencies;
  const now = Effect.map(dependencies.clock.now, DateTime.formatIso);
  const validity = {
    access: dependencies.access,
    clock: dependencies.clock,
    installationId,
    shareLinks: dependencies.shareLinks,
  };

  /** The version a link opens right now, or null when its artifact is gone. */
  const targetOf = Effect.fnUntraced(function*(link: ShareLink) {
    const artifact = yield* dependencies.findArtifact(link.projectId, link.artifactId);
    if (artifact === null || artifact.deletedAt !== null) return null;
    const versionId = link.target.kind === "pinned" ? link.target.versionId : artifact.currentVersionId;
    const version = yield* dependencies.findVersion(link.projectId, link.artifactId, versionId);
    return version === null ? null : {artifact, version};
  });

  const contextOf = Effect.fnUntraced(function*(guest: GuestRecord, link: ShareLink) {
    const target = yield* targetOf(link);
    const project = yield* dependencies.findProject(link.projectId);
    if (target === null || project === null) return null;
    return {
      artifact: {id: target.artifact.id, name: target.artifact.name},
      guest: {displayName: guest.displayName, id: guest.id},
      link: {
        createdByName: link.createdByName,
        expiresAt: link.expiresAt,
        id: link.id,
        label: link.label,
        permissions: link.permissions,
      },
      project: {id: project.id, name: project.name},
      version: {id: target.version.id, number: target.version.number, savedAt: target.version.createdAt},
    } satisfies GuestContext;
  });

  /** The guest's link and target on this request, or the guest's session has ended. */
  const requireActive = Effect.fnUntraced(function*(principal: Principal) {
    if (principal.kind !== principalKinds.guest || principal.installationId !== installationId) {
      return yield* sessionRequired();
    }
    const active = yield* resolveActiveGuest(validity, principal.id);
    if (active === null) return yield* sessionRequired();
    const target = yield* targetOf(active.link);
    if (target === null) return yield* sessionRequired();
    return {...active, target};
  });

  const startSession = Effect.fn("GuestReviewService.startSession")(function*(command: StartGuestSessionCommand) {
    const link = yield* dependencies.shareLinks.findShareLinkByToken(command.token);
    const at = yield* now;
    if (link === null || link.installationId !== installationId || !isShareLinkActive(link, at)) {
      return yield* linkEnded();
    }
    const {policy} = yield* dependencies.access.readAccessPolicy(installationId);
    if (!policy.shareLinks.enabled) return yield* linkEnded();
    const target = yield* targetOf(link);
    if (target === null) return yield* linkEnded();
    // Reopening a link in the same browser keeps its guest, their name and their comments.
    const existing = command.existingSession(link.id);
    if (existing !== null) {
      const resumed = yield* authenticate({sessionToken: existing.sessionToken}).pipe(
        Effect.map((found) => found.context.link.id === link.id &&
            found.csrfDigest === dependencies.secrets.digest(existing.csrfToken)
          ? found
          : null),
        Effect.catchTag("GuestSessionRequired", () => Effect.succeed(null)),
      );
      if (resumed !== null) {
        const session = yield* dependencies.shareLinks.findGuestSession(
          installationId,
          dependencies.secrets.digest(existing.sessionToken),
        );
        return {
          context: resumed.context,
          csrfToken: existing.csrfToken,
          expiresAt: session?.session.expiresAt ?? guestSessionExpiry(link, at),
          resumed: true,
          sessionToken: existing.sessionToken,
        };
      }
    }
    const wait = command.admissionWait(link.id);
    if (wait !== null) {
      return yield* new GuestRateLimited({
        message: "Too many people opened this link recently. Try again later.",
        retryAfterSeconds: wait,
      });
    }
    const guest: GuestRecord = {
      contactEmail: null,
      createdAt: at,
      displayName: null,
      generation: link.generation,
      id: dependencies.ids.guestId(),
      shareLinkId: link.id,
    };
    const sessionToken = dependencies.secrets.issue();
    const csrfToken = dependencies.secrets.issue();
    const expiresAt = guestSessionExpiry(link, at);
    yield* dependencies.shareLinks.createGuest({
      attribution: {
        actor: {displayName: "Guest", kind: principalKinds.guest},
        authorizedByPrincipalId: link.createdByPrincipalId,
        principalId: guest.id,
      },
      guest,
      installationId,
      session: {
        csrfDigest: dependencies.secrets.digest(csrfToken),
        expiresAt,
        guestId: guest.id,
        id: dependencies.ids.guestSessionId(),
        revokedAt: null,
        tokenDigest: dependencies.secrets.digest(sessionToken),
      },
      versionId: target.version.id,
    });
    const context = yield* contextOf(guest, link);
    if (context === null) return yield* linkEnded();
    return {context, csrfToken, expiresAt, resumed: false, sessionToken};
  });

  // No cache: a revoke, rotation, expiry or policy change applies to the very next request.
  const authenticate = Effect.fn("GuestReviewService.authenticate")(function*(command: {readonly sessionToken: string}) {
    const found = yield* dependencies.shareLinks.findGuestSession(
      installationId,
      dependencies.secrets.digest(command.sessionToken),
    );
    const at = yield* now;
    if (found === null || found.session.revokedAt !== null || found.session.expiresAt <= at) {
      return yield* sessionRequired();
    }
    const active = yield* resolveActiveGuest(validity, found.guest.id);
    if (active === null) return yield* sessionRequired();
    const context = yield* contextOf(active.guest, active.link);
    if (context === null) return yield* sessionRequired();
    return {
      context,
      csrfDigest: found.session.csrfDigest,
      principal: guestPrincipal(installationId, active.guest, active.link),
    };
  });

  const context = Effect.fn("GuestReviewService.context")(function*(principal: Principal) {
    const active = yield* requireActive(principal);
    const built = yield* contextOf(active.guest, active.link);
    if (built === null) return yield* sessionRequired();
    return built;
  });

  const setIdentity = Effect.fn("GuestReviewService.setIdentity")(function*(command: {
    readonly contactEmail: string | null;
    readonly displayName: string;
    readonly principal: Principal;
  }) {
    const active = yield* requireActive(command.principal);
    const displayName = normalizeGuestDisplayName(command.displayName);
    if (displayName instanceof GuestIdentityRequired) return yield* displayName;
    const email = command.contactEmail === null ? null : stripInvisibleControls(command.contactEmail).trim();
    const contactEmail = email === null || email === "" ? null : email.slice(0, maximumGuestEmailLength);
    const guest = yield* dependencies.shareLinks.setGuestIdentity({
      contactEmail,
      displayName,
      guestId: active.guest.id,
      installationId,
    });
    const built = yield* contextOf(guest, active.link);
    if (built === null) return yield* sessionRequired();
    return built;
  });

  const issuePreviewLease = Effect.fn("GuestReviewService.issuePreviewLease")(function*(command: {
    readonly principal: Principal;
  }) {
    const active = yield* requireActive(command.principal);
    const lease = yield* content.issuePreviewLease({
      artifactId: active.link.artifactId,
      principal: command.principal,
      projectId: active.link.projectId,
      reuseToken: null,
      versionId: active.target.version.id,
    });
    return {expiresAt: lease.expiresAt, token: lease.token, versionId: lease.versionId};
  });

  /** A thread on the link's version target; any other thread is reported as missing. */
  const requireTargetThread = Effect.fnUntraced(function*(command: GuestThreadCommand) {
    const active = yield* requireActive(command.principal);
    yield* requireViewing(active, command.viewingVersionId);
    const details = yield* comments.getThread({...scopeOf(active.link), principal: command.principal, threadId: command.threadId});
    if (details.thread.versionId !== active.target.version.id) {
      return yield* new CommentNotFound({message: "The comment does not exist."});
    }
    return {active, details};
  });

  /** A latest link that moved on refuses work aimed at the version the guest still sees. */
  const requireViewing = Effect.fnUntraced(function*(
    active: {readonly target: {readonly version: {readonly id: string; readonly number: number}}},
    viewingVersionId: string | null,
  ) {
    if (viewingVersionId !== null && viewingVersionId !== active.target.version.id) {
      yield* new GuestVersionChanged({
        message: `This link now opens version ${active.target.version.number}. Reload to review it.`,
      });
    }
  });

  /** Writing needs the link's comment permission first, then a name. */
  const requireWriter = Effect.fnUntraced(function*(principal: Principal) {
    const active = yield* requireActive(principal);
    yield* authorization.requireCommentWrite(principal, scopeOf(active.link));
    if (active.guest.displayName === null) {
      return yield* new GuestIdentityRequired({message: "Enter your name before commenting."});
    }
    return active;
  });

  const listThreads = Effect.fn("GuestReviewService.listThreads")(function*(command: {
    readonly cursor: Parameters<ArtifactCommentService["Service"]["listThreads"]>[0]["cursor"];
    readonly limit: number;
    readonly principal: Principal;
    readonly viewingVersionId: string | null;
  }) {
    const active = yield* requireActive(command.principal);
    yield* requireViewing(active, command.viewingVersionId);
    return yield* comments.listThreads({
      ...scopeOf(active.link),
      cursor: command.cursor,
      limit: command.limit,
      principal: command.principal,
      since: null,
      state: null,
      versionId: active.target.version.id,
    });
  });

  const getThread = Effect.fn("GuestReviewService.getThread")(function*(command: GuestThreadCommand) {
    return (yield* requireTargetThread(command)).details;
  });

  const createThread = Effect.fn("GuestReviewService.createThread")(function*(command: {
    readonly anchor: unknown;
    readonly body: string;
    readonly idempotencyKey: string;
    readonly path: string | null;
    readonly principal: Principal;
    readonly viewingVersionId: string | null;
  }) {
    const active = yield* requireWriter(command.principal);
    yield* requireViewing(active, command.viewingVersionId);
    return yield* comments.createThread({
      ...scopeOf(active.link),
      anchor: command.anchor,
      body: command.body,
      idempotencyKey: command.idempotencyKey,
      path: command.path,
      principal: command.principal,
      versionId: active.target.version.id,
    });
  });

  const createReply = Effect.fn("GuestReviewService.createReply")(function*(command: GuestThreadCommand & {
    readonly body: string;
    readonly idempotencyKey: string;
  }) {
    yield* requireWriter(command.principal);
    const {active} = yield* requireTargetThread(command);
    return yield* comments.createReply({
      ...scopeOf(active.link),
      body: command.body,
      idempotencyKey: command.idempotencyKey,
      principal: command.principal,
      threadId: command.threadId,
    });
  });

  const updateThread = Effect.fn("GuestReviewService.updateThread")(function*(command: GuestThreadCommand & {
    readonly body: string;
  }) {
    yield* requireWriter(command.principal);
    const {active} = yield* requireTargetThread(command);
    return yield* comments.updateThread({
      ...scopeOf(active.link),
      body: command.body,
      principal: command.principal,
      threadId: command.threadId,
    });
  });

  const setThreadState = Effect.fn("GuestReviewService.setThreadState")(function*(command: GuestThreadCommand & {
    readonly state: CommentThreadState;
  }) {
    yield* requireWriter(command.principal);
    const {active} = yield* requireTargetThread(command);
    return yield* comments.updateThread({
      ...scopeOf(active.link),
      principal: command.principal,
      state: command.state,
      threadId: command.threadId,
    });
  });

  const updateReply = Effect.fn("GuestReviewService.updateReply")(function*(command: GuestThreadCommand & {
    readonly body: string;
    readonly replyId: string;
  }) {
    yield* requireWriter(command.principal);
    const {active} = yield* requireTargetThread(command);
    return yield* comments.updateReply({
      ...scopeOf(active.link),
      body: command.body,
      principal: command.principal,
      replyId: command.replyId,
      threadId: command.threadId,
    });
  });

  const deleteThread = Effect.fn("GuestReviewService.deleteThread")(function*(command: GuestThreadCommand) {
    const {active} = yield* requireTargetThread(command);
    yield* authorization.requireCommentWrite(command.principal, scopeOf(active.link));
    yield* comments.deleteThread({...scopeOf(active.link), principal: command.principal, threadId: command.threadId});
  });

  const deleteReply = Effect.fn("GuestReviewService.deleteReply")(function*(command: GuestThreadCommand & {
    readonly replyId: string;
  }) {
    const {active} = yield* requireTargetThread(command);
    yield* authorization.requireCommentWrite(command.principal, scopeOf(active.link));
    yield* comments.deleteReply({
      ...scopeOf(active.link),
      principal: command.principal,
      replyId: command.replyId,
      threadId: command.threadId,
    });
  });

  return GuestReviewService.of({
    authenticate,
    context,
    createReply,
    createThread,
    deleteReply,
    deleteThread,
    getThread,
    issuePreviewLease,
    listThreads,
    setIdentity,
    setThreadState,
    startSession,
    updateReply,
    updateThread,
  });
}
