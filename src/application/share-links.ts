import {Context, DateTime, Effect, Layer} from "effect";

import type {AccessPolicy} from "../core/access-policy.js";
import {attributionOf} from "../core/action-attribution.js";
import {
  AccessRevisionConflict,
  type ArtifactRepositoryFailure,
  InvalidPagination,
  ShareLinkInvalid,
  ShareLinkNotFound,
  ShareLinksDisabled,
} from "../core/errors.js";
import {isHumanAdministrator, type Principal} from "../core/identity.js";
import type {PageCursor} from "../core/model.js";
import {permissions, type Permission} from "../core/permissions.js";
import type {IdGenerator} from "../core/ports.js";
import type {ShareLinkRepository} from "../core/share-link-ports.js";
import {
  normalizeShareLinkLabel,
  validateShareLinkPermissions,
  type ShareLink,
  type ShareLinkTarget,
} from "../core/share-links.js";
import type {ApplicationClock} from "./application-clock.js";
import {
  type ArtifactManagementFailure,
  ArtifactManagementService,
} from "./artifact-management.js";
import {
  type AccessRepositoryEffects,
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";

/** Largest share-link inventory page. */
export const maximumShareLinkPageSize = 100;

/** The share-link store, with each operation lifted into Effect. */
export type ShareLinkRepositoryEffects = {
  readonly [Operation in keyof ShareLinkRepository]: (
    ...args: Parameters<ShareLinkRepository[Operation]>
  ) => Effect.Effect<Awaited<ReturnType<ShareLinkRepository[Operation]>>, ArtifactRepositoryFailure>;
};

/** Persistence and identifiers the share-link service depends on. */
export interface ShareLinkDependencies {
  readonly access: AccessRepositoryEffects;
  readonly clock: ApplicationClock;
  readonly ids: IdGenerator;
  readonly installationId: string;
  readonly shareLinks: ShareLinkRepositoryEffects;
}

/** Every expected failure of share-link management. */
export type ShareLinkFailure =
  | AccessRevisionConflict
  | ArtifactManagementFailure
  | ArtifactRepositoryFailure
  | InvalidPagination
  | ShareLinkInvalid
  | ShareLinkNotFound
  | ShareLinksDisabled;

/** One inventory row: the link and the name of the artifact it opens. */
export interface InventoryShareLink extends ShareLink {
  readonly artifactName: string;
}

/** What a caller sets on a link. */
export interface ShareLinkSettings {
  readonly expiresAt: string | null;
  readonly label: string;
  readonly permissions: readonly Permission[];
  readonly target: ShareLinkTarget;
}

interface ShareLinkOperations {
  readonly create: (command: ShareLinkSettings & {
    readonly artifactId: string;
    readonly principal: Principal;
    readonly projectId: string | null;
  }) => Effect.Effect<ShareLink, ShareLinkFailure>;
  readonly inventory: (command: {
    readonly cursor: PageCursor | null;
    readonly limit: number;
    readonly principal: Principal;
  }) => Effect.Effect<{readonly items: readonly InventoryShareLink[]; readonly nextCursor: PageCursor | null}, ShareLinkFailure>;
  readonly listForArtifact: (command: {
    readonly artifactId: string;
    readonly principal: Principal;
    readonly projectId: string | null;
  }) => Effect.Effect<readonly ShareLink[], ShareLinkFailure>;
  readonly revoke: (command: {
    readonly linkId: string;
    readonly principal: Principal;
    readonly projectId: string | null;
  }) => Effect.Effect<ShareLink, ShareLinkFailure>;
  readonly rotate: (command: {
    readonly expectedRevision: number;
    readonly linkId: string;
    readonly principal: Principal;
    readonly projectId: string | null;
  }) => Effect.Effect<ShareLink, ShareLinkFailure>;
  readonly update: (command: ShareLinkSettings & {
    readonly expectedRevision: number;
    readonly linkId: string;
    readonly principal: Principal;
    readonly projectId: string | null;
  }) => Effect.Effect<ShareLink, ShareLinkFailure>;
}

/** Share links: bounded Review access to one artifact for people without an account (ADR 0033). */
export class ShareLinkService extends Context.Service<ShareLinkService, ShareLinkOperations>()(
  "artifact-server/application/ShareLinkService",
) {
  /** Construct share-link management over its store and the artifact services. */
  static readonly layer = (
    dependencies: ShareLinkDependencies,
  ): Layer.Layer<ShareLinkService, never, ArtifactManagementService | AuthorizationService> =>
    Layer.effect(
      ShareLinkService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        const artifacts = yield* ArtifactManagementService;
        return makeShareLinkService(dependencies, authorization, artifacts);
      }),
    );
}

const linkNotFound = () => new ShareLinkNotFound({message: "The share link does not exist."});

/** The version a link's activity rows name: its pinned version, or the artifact's current one. */
const versionFor = (link: ShareLink, currentVersionId: string): string =>
  link.target.kind === "pinned" ? link.target.versionId : currentVersionId;

function makeShareLinkService(
  dependencies: ShareLinkDependencies,
  authorization: AuthorizationOperations,
  artifacts: ArtifactManagementService["Service"],
): ShareLinkOperations {
  const {installationId, shareLinks} = dependencies;
  const now = Effect.map(dependencies.clock.now, DateTime.formatIso);

  /** The caller may share this artifact under the current policy; returns the artifact and policy. */
  const requireSharer = Effect.fnUntraced(function*(principal: Principal, projectId: string | null, artifactId: string) {
    const {policy} = yield* dependencies.access.readAccessPolicy(installationId);
    const read = yield* artifacts.getArtifact({artifactId, principal, projectId});
    yield* authorization.requireArtifactManagement(
      principal,
      {artifactId: read.artifact.id, projectId: read.artifact.projectId},
      permissions.artifactShare,
    );
    if (!policy.shareLinks.enabled) {
      return yield* new ShareLinksDisabled({message: "Share links are turned off for this installation."});
    }
    if (policy.shareLinks.linkCreators === "administrators" && !isHumanAdministrator(principal)) {
      return yield* new ShareLinksDisabled({message: "Only administrators can manage share links here."});
    }
    return {artifact: read.artifact, policy};
  });

  /** Validate settings; returns the normalized settings and the version the activity row names. */
  const validated = Effect.fnUntraced(function*(
    principal: Principal,
    projectId: string,
    artifactId: string,
    currentVersionId: string,
    policy: AccessPolicy,
    settings: ShareLinkSettings,
  ) {
    const label = normalizeShareLinkLabel(settings.label);
    if (label instanceof ShareLinkInvalid) return yield* label;
    const granted = validateShareLinkPermissions(settings.permissions, policy);
    if (granted instanceof ShareLinkInvalid) return yield* granted;
    const at = yield* now;
    const maxDays = policy.shareLinks.maxExpiryDays;
    if (settings.expiresAt !== null && settings.expiresAt <= at) {
      return yield* new ShareLinkInvalid({message: "A share link must expire in the future."});
    }
    if (maxDays !== null) {
      const latest = new Date(Date.parse(at) + maxDays * 86_400_000).toISOString();
      if (settings.expiresAt === null || settings.expiresAt > latest) {
        return yield* new ShareLinkInvalid({
          message: `Installation policy requires share links to expire within ${maxDays} days.`,
        });
      }
    }
    if (settings.target.kind === "pinned") {
      yield* artifacts.getVersionDetails({
        artifactId,
        principal,
        projectId,
        versionId: settings.target.versionId,
      }).pipe(Effect.catchTag("VersionNotFound", () =>
        Effect.fail(new ShareLinkInvalid({message: "A pinned share link must name a version of this artifact."}))));
    }
    return {
      settings: {expiresAt: settings.expiresAt, label, permissions: granted, target: settings.target},
      versionId: settings.target.kind === "pinned" ? settings.target.versionId : currentVersionId,
    };
  });

  // A caller-named project must match the link's; the artifact read then checks the caller can see it.
  const requireLink = Effect.fnUntraced(function*(projectId: string | null, linkId: string) {
    const link = yield* shareLinks.findShareLink(installationId, linkId);
    if (link === null || (projectId !== null && link.projectId !== projectId)) return yield* linkNotFound();
    return link;
  });

  const create = Effect.fn("ShareLinkService.create")(function*(command: ShareLinkSettings & {
    readonly artifactId: string;
    readonly principal: Principal;
    readonly projectId: string | null;
  }) {
    const {artifact, policy} = yield* requireSharer(command.principal, command.projectId, command.artifactId);
    const checked = yield* validated(
      command.principal,
      artifact.projectId,
      artifact.id,
      artifact.currentVersionId,
      policy,
      command,
    );
    return yield* shareLinks.createShareLink({
      attribution: attributionOf(command.principal),
      installationId,
      link: {
        ...checked.settings,
        artifactId: artifact.id,
        createdAt: yield* now,
        createdByName: command.principal.displayName,
        createdByPrincipalId: command.principal.id,
        id: dependencies.ids.shareLinkId(),
        projectId: artifact.projectId,
        token: dependencies.ids.shareLinkToken(),
      },
      versionId: checked.versionId,
    });
  });

  const update = Effect.fn("ShareLinkService.update")(function*(command: ShareLinkSettings & {
    readonly expectedRevision: number;
    readonly linkId: string;
    readonly principal: Principal;
    readonly projectId: string | null;
  }) {
    const link = yield* requireLink(command.projectId, command.linkId);
    const {artifact, policy} = yield* requireSharer(command.principal, link.projectId, link.artifactId);
    const checked = yield* validated(
      command.principal,
      artifact.projectId,
      artifact.id,
      artifact.currentVersionId,
      policy,
      command,
    );
    const written = yield* shareLinks.updateShareLink({
      ...checked.settings,
      attribution: attributionOf(command.principal),
      expectedRevision: command.expectedRevision,
      installationId,
      linkId: link.id,
      versionId: checked.versionId,
    });
    if (written === "missing") return yield* linkNotFound();
    if (written === "conflict") {
      return yield* new AccessRevisionConflict({message: "The share link changed; reload it and try again."});
    }
    return written;
  });

  const rotate = Effect.fn("ShareLinkService.rotate")(function*(command: {
    readonly expectedRevision: number;
    readonly linkId: string;
    readonly principal: Principal;
    readonly projectId: string | null;
  }) {
    const link = yield* requireLink(command.projectId, command.linkId);
    const {artifact} = yield* requireSharer(command.principal, link.projectId, link.artifactId);
    const written = yield* shareLinks.rotateShareLink({
      attribution: attributionOf(command.principal),
      expectedRevision: command.expectedRevision,
      installationId,
      linkId: link.id,
      token: dependencies.ids.shareLinkToken(),
      versionId: versionFor(link, artifact.currentVersionId),
    });
    if (written === "missing") return yield* linkNotFound();
    if (written === "conflict") {
      return yield* new AccessRevisionConflict({message: "The share link changed; reload it and try again."});
    }
    return written;
  });

  // Ending access is always allowed to a sharer, even when policy has since turned links off.
  const revoke = Effect.fn("ShareLinkService.revoke")(function*(command: {
    readonly linkId: string;
    readonly principal: Principal;
    readonly projectId: string | null;
  }) {
    const link = yield* requireLink(command.projectId, command.linkId);
    const read = yield* artifacts.getArtifact({
      artifactId: link.artifactId,
      principal: command.principal,
      projectId: link.projectId,
    });
    yield* authorization.requireArtifactManagement(
      command.principal,
      {artifactId: link.artifactId, projectId: link.projectId},
      permissions.artifactShare,
    );
    const revoked = yield* shareLinks.revokeShareLink({
      attribution: attributionOf(command.principal),
      installationId,
      linkId: link.id,
      versionId: versionFor(link, read.artifact.currentVersionId),
    });
    if (revoked === "missing") return yield* linkNotFound();
    return revoked;
  });

  const listForArtifact = Effect.fn("ShareLinkService.listForArtifact")(function*(command: {
    readonly artifactId: string;
    readonly principal: Principal;
    readonly projectId: string | null;
  }) {
    const read = yield* artifacts.getArtifact(command);
    yield* authorization.requireArtifactManagement(
      command.principal,
      {artifactId: read.artifact.id, projectId: read.artifact.projectId},
      permissions.artifactShare,
    );
    return yield* shareLinks.listArtifactShareLinks(installationId, read.artifact.projectId, read.artifact.id);
  });

  const inventory = Effect.fn("ShareLinkService.inventory")(function*(command: {
    readonly cursor: PageCursor | null;
    readonly limit: number;
    readonly principal: Principal;
  }) {
    yield* authorization.requireInstallationAdministration(command.principal);
    if (!Number.isSafeInteger(command.limit) || command.limit < 1 || command.limit > maximumShareLinkPageSize) {
      return yield* new InvalidPagination({
        message: `A share-link page must contain between 1 and ${maximumShareLinkPageSize} records.`,
      });
    }
    const page = yield* shareLinks.listActiveShareLinks({
      cursor: command.cursor,
      installationId,
      limit: command.limit,
      now: yield* now,
    });
    // An artifact the administrator can no longer read keeps its id as its name.
    const items = yield* Effect.forEach(page.items, (link) =>
      artifacts.getArtifact({artifactId: link.artifactId, principal: command.principal, projectId: link.projectId}).pipe(
        Effect.map((read) => read.artifact.name),
        Effect.catchTag("ArtifactNotFound", () => Effect.succeed(link.artifactId)),
        Effect.map((artifactName): InventoryShareLink => Object.assign({artifactName}, link)),
      ));
    return {items, nextCursor: page.nextCursor};
  });

  return ShareLinkService.of({create, inventory, listForArtifact, revoke, rotate, update});
}
