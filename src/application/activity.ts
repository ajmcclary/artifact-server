import {Context, Effect, Layer} from "effect";

import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";
import {
  type ActivityEntry,
  type SubjectNames,
  toActivityEntry,
} from "./activity-entries.js";
import type {
  ArtifactRepositoryFailure,
  AuthorizationDenied,
  IdentityRepositoryFailure,
} from "../core/errors.js";
import {isHumanAdministrator, type Principal} from "../core/identity.js";
import type {PageCursor} from "../core/model.js";
import type {
  ActivityPage,
  ActivityQuery,
  ActivitySegment,
  ActivitySummary,
  ActivityType,
} from "../core/ports.js";
import {maximumActivitySearchCharacters} from "../core/publishing-limits.js";

/** Activity reads, as the application consumes them. */
export interface ActivityPersistence {
  readonly listActivity: (
    query: ActivityQuery,
  ) => Effect.Effect<ActivityPage, ArtifactRepositoryFailure>;
  readonly summarizeActivity: (
    projectIds: readonly string[],
  ) => Effect.Effect<ActivitySummary, ArtifactRepositoryFailure>;
}

/** Member and key names, read only for administrators. */
export interface ActivityDirectory {
  readonly listApiKeys: () => Effect.Effect<
    readonly {readonly id: string; readonly name: string}[],
    IdentityRepositoryFailure
  >;
  readonly listMembers: () => Effect.Effect<
    readonly {readonly displayName: string; readonly id: string}[],
    IdentityRepositoryFailure
  >;
}

/** Dependencies used to construct the activity service. */
export interface ActivityDependencies {
  readonly directory: ActivityDirectory;
  readonly persistence: ActivityPersistence;
}

/** One parsed feed request. Bounds are enforced at the protocol boundary. */
export interface ActivityRequest {
  readonly cursor: PageCursor | null;
  readonly limit: number;
  readonly projectIds: readonly string[];
  readonly search: string | null;
  readonly segment: ActivitySegment;
  readonly types: readonly ActivityType[];
}

/** One feed page; the protocol adapter encodes the cursor. */
export interface ActivityResponse {
  readonly items: readonly ActivityEntry[];
  readonly nextCursor: PageCursor | null;
}

/** Expected failures produced by activity reads. */
export type ActivityFailure =
  | ArtifactRepositoryFailure
  | AuthorizationDenied
  | IdentityRepositoryFailure;

interface ActivityOperations {
  readonly list: (
    principal: Principal,
    request: ActivityRequest,
  ) => Effect.Effect<ActivityResponse, ActivityFailure>;
  readonly summary: (
    principal: Principal,
    projectIds: readonly string[],
  ) => Effect.Effect<ActivitySummary, ActivityFailure>;
}

/** Reads the installation activity log under membership visibility rules. */
export class ActivityService extends Context.Service<
  ActivityService,
  ActivityOperations
>()("artifact-server/application/ActivityService") {
  /** Construct activity reads over deployment-neutral persistence. */
  static readonly layer = (
    dependencies: ActivityDependencies,
  ): Layer.Layer<ActivityService, never, AuthorizationService> =>
    Layer.effect(
      ActivityService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        return makeActivityService(dependencies, authorization);
      }),
    );
}

const emptyNames: SubjectNames = {keys: new Map(), members: new Map()};

/**
 * The literal search term: trimmed and bounded. Case is matched by the database applying the same
 * `lower()` to the term and the stored text, so a term always matches text written the same way.
 */
function normalizeActivitySearch(candidate: string | null): string | null {
  if (candidate === null) return null;
  const trimmed = candidate.slice(0, maximumActivitySearchCharacters).trim();
  return trimmed === "" ? null : trimmed;
}

function makeActivityService(
  dependencies: ActivityDependencies,
  authorization: AuthorizationOperations,
): ActivityOperations {
  const subjectNames = Effect.fn("ActivityService.subjectNames")(
    function*(page: ActivityPage) {
      const needsNames = page.items.some(({action}) =>
        action.action.startsWith("member_") || action.action.startsWith("key_")
      );
      if (!needsNames) return emptyNames;
      const members = yield* dependencies.directory.listMembers();
      const keys = yield* dependencies.directory.listApiKeys();
      return {
        keys: new Map(keys.map((key) => [key.id, key.name])),
        members: new Map(members.map((member) => [member.id, member.displayName])),
      } satisfies SubjectNames;
    },
  );

  const list = Effect.fn("ActivityService.list")(function*(
    principal: Principal,
    request: ActivityRequest,
  ) {
    yield* authorization.requireArtifactListing(principal);
    const includeAdministration = isHumanAdministrator(principal);
    const page = yield* dependencies.persistence.listActivity({
      cursor: request.cursor,
      includeAdministration,
      limit: request.limit,
      projectIds: request.projectIds,
      search: normalizeActivitySearch(request.search),
      segment: request.segment,
      types: request.types,
    });
    const names = includeAdministration ? yield* subjectNames(page) : emptyNames;
    return {
      items: page.items.flatMap((row) => {
        const entry = toActivityEntry(row, names);
        return entry === null ? [] : [entry];
      }),
      nextCursor: page.nextCursor,
    } satisfies ActivityResponse;
  });

  const summary = Effect.fn("ActivityService.summary")(function*(
    principal: Principal,
    projectIds: readonly string[],
  ) {
    yield* authorization.requireArtifactListing(principal);
    return yield* dependencies.persistence.summarizeActivity(projectIds);
  });

  return {list, summary};
}
