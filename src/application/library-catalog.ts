import {Context, DateTime, Effect, Layer} from "effect";

import type {
  ArtifactRepositoryFailure,
  AuthorizationDenied,
  BlobStorageFailure,
} from "../core/errors.js";
import type {Principal} from "../core/identity.js";
import type {
  LibraryDatesRequest,
  LibraryGallery,
  LibraryGalleryItem,
  LibraryPageDates,
  LibraryResponse,
} from "../core/library.js";
import type {
  ArtifactListItem,
  ArtifactPage,
  ArtifactVersion,
  ManifestEntry,
  PageCursor,
  ProjectRecord,
} from "../core/model.js";
import type {ListArtifacts} from "../core/ports.js";
import {
  maximumPreviewIndexBytes,
  type PreviewIndexReading,
  readPreviewIndex,
} from "../manifest/preview-index-reader.js";
import {previewIndexPath} from "../manifest/preview-index.js";
import type {ApplicationClock} from "./application-clock.js";
import {AuthorizationService, type AuthorizationOperations} from "./authorization.js";

/** The Library examines at most this many artifacts, matching the client's former 20 pages of 100. */
export const maximumLibraryArtifacts = 2_000;
const artifactPageSize = 100;
/** What each immutable version contributes; a cached entry can never go stale. */
const maximumCachedVersions = 1_000;
/** Cache misses read concurrently, leaving headroom in each process's database pool. */
const missReadConcurrency = 6;

/** Reads the Library needs, as the application consumes them. */
export interface LibraryCatalogDependencies {
  readonly clock: ApplicationClock;
  readonly findVersionRecord: (
    projectId: string,
    artifactId: string,
    versionId: string,
  ) => Effect.Effect<ArtifactVersion | null, ArtifactRepositoryFailure>;
  readonly listArtifacts: (command: ListArtifacts) => Effect.Effect<ArtifactPage, ArtifactRepositoryFailure>;
  readonly listProjects: () => Effect.Effect<readonly ProjectRecord[], ArtifactRepositoryFailure>;
  readonly pageDates: (
    requests: readonly LibraryDatesRequest[],
  ) => Effect.Effect<readonly LibraryPageDates[], ArtifactRepositoryFailure>;
  /** One manifest entry's bytes as UTF-8 text. */
  readonly readBlobText: (entry: ManifestEntry) => Effect.Effect<string, BlobStorageFailure>;
}

export type LibraryCatalogFailure = ArtifactRepositoryFailure | AuthorizationDenied;

export interface LibraryCatalogOperations {
  readonly read: (principal: Principal) => Effect.Effect<LibraryResponse, LibraryCatalogFailure>;
}

/** Assembles the Library on the server in one authorized read. */
export class LibraryCatalogService extends Context.Service<
  LibraryCatalogService,
  LibraryCatalogOperations
>()("artifact-server/application/LibraryCatalogService") {
  static readonly layer = (
    dependencies: LibraryCatalogDependencies,
  ): Layer.Layer<LibraryCatalogService, never, AuthorizationService> =>
    Layer.effect(
      LibraryCatalogService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        return makeLibraryCatalogService(dependencies, authorization);
      }),
    );
}

type ReadyReading = Extract<PreviewIndexReading, {readonly status: "ready"}>;

/** What one exact version contributes to the Library; immutable, so cacheable by version id. */
type VersionContribution =
  | {
    readonly kind: "gallery";
    readonly reading: ReadyReading;
    readonly versionCreatedAt: string;
    readonly versionId: string;
    readonly versionNumber: number;
  }
  | {readonly kind: "invalid"}
  | {readonly kind: "none"};

type GalleryContribution = Extract<VersionContribution, {readonly kind: "gallery"}>;

interface ReadableGallery {
  readonly artifact: ArtifactListItem;
  readonly contribution: GalleryContribution;
  readonly project: ProjectRecord;
}

interface ListedArtifact {
  readonly artifact: ArtifactListItem;
  readonly project: ProjectRecord;
}

function laterOf(left: string, right: string | null): string {
  return right !== null && right > left ? right : left;
}

function assembleGallery(gallery: ReadableGallery, dates: ReadonlyMap<string, LibraryPageDates>): LibraryGallery {
  const fallback = gallery.contribution.versionCreatedAt;
  return {
    artifactId: gallery.artifact.id,
    artifactName: gallery.artifact.name,
    indexTitle: gallery.contribution.reading.title,
    items: gallery.contribution.reading.items.map((item): LibraryGalleryItem => {
      const dated = dates.get(`${gallery.artifact.id}\u001f${item.path}`);
      return {
        activityAt: dated === undefined ? fallback : laterOf(dated.changedAt, dated.commentedAt),
        createdAt: dated?.createdAt ?? fallback,
        description: item.description,
        kind: item.kind,
        path: item.path,
        related: item.related,
        section: item.section,
        thumbnailPath: item.thumbnailPath,
        title: item.title,
        viewport: item.viewport,
      };
    }),
    projectId: gallery.project.id,
    projectName: gallery.project.name,
    versionId: gallery.contribution.versionId,
  };
}

function makeLibraryCatalogService(
  dependencies: LibraryCatalogDependencies,
  authorization: AuthorizationOperations,
): LibraryCatalogOperations {
  // Least recently used first; a hit moves its entry to the end.
  const contributions = new Map<string, VersionContribution>();

  const remember = (versionId: string, contribution: VersionContribution): VersionContribution => {
    contributions.delete(versionId);
    contributions.set(versionId, contribution);
    if (contributions.size > maximumCachedVersions) {
      const oldest = contributions.keys().next().value;
      if (oldest !== undefined) contributions.delete(oldest);
    }
    return contribution;
  };

  const contributionOf = Effect.fn("LibraryCatalogService.contributionOf")(function*(listed: ListedArtifact) {
    const versionId = listed.artifact.currentVersionId;
    const cached = contributions.get(versionId);
    if (cached !== undefined) return remember(versionId, cached);
    const version = yield* dependencies.findVersionRecord(listed.project.id, listed.artifact.id, versionId);
    // A current version that cannot be found is not cached: the next read looks again.
    if (version === null) return {kind: "none"} satisfies VersionContribution;
    const indexEntry = version.manifest.entries.find((entry) => entry.path === previewIndexPath);
    if (indexEntry === undefined) return remember(versionId, {kind: "none"});
    if (indexEntry.size > maximumPreviewIndexBytes) return remember(versionId, {kind: "invalid"});
    // A failed read marks only this gallery unreadable and is not cached: it may be transient.
    const text = yield* dependencies.readBlobText(indexEntry).pipe(Effect.orElseSucceed(() => null));
    if (text === null) return {kind: "invalid"} satisfies VersionContribution;
    const reading = readPreviewIndex(text, version.manifest.entries);
    return remember(versionId, reading.status === "ready"
      ? {
        kind: "gallery",
        reading,
        versionCreatedAt: version.version.createdAt,
        versionId,
        versionNumber: version.version.number,
      }
      : {kind: "invalid"});
  });

  const read = Effect.fn("LibraryCatalogService.read")(function*(principal: Principal) {
    yield* authorization.requireArtifactListing(principal);
    const projects = (yield* dependencies.listProjects())
      .toSorted((left, right) => left.name.localeCompare(right.name));
    const listed: ListedArtifact[] = [];
    let truncated = false;
    for (const project of projects) {
      let cursor: PageCursor | null = null;
      do {
        const page: ArtifactPage = yield* dependencies.listArtifacts({
          comments: "all",
          cursor,
          limit: artifactPageSize,
          projectId: project.id,
          sort: "newest",
          tags: [],
        });
        for (const artifact of page.items) {
          if (listed.length >= maximumLibraryArtifacts) {
            truncated = true;
            break;
          }
          listed.push({artifact, project});
        }
        cursor = truncated ? null : page.nextCursor;
      } while (cursor !== null);
      if (truncated) break;
    }
    const contributed = yield* Effect.forEach(
      listed,
      (entry) => contributionOf(entry).pipe(Effect.map((contribution) => ({artifact: entry.artifact, contribution, project: entry.project}))),
      {concurrency: missReadConcurrency},
    );
    const galleries: ReadableGallery[] = [];
    const unreadable: string[] = [];
    for (const {artifact, contribution, project} of contributed) {
      if (contribution.kind === "gallery") galleries.push({artifact, contribution, project});
      else if (contribution.kind === "invalid") unreadable.push(artifact.name);
    }
    const dates = yield* dependencies.pageDates(galleries.map((gallery) => ({
      artifactId: gallery.artifact.id,
      currentVersionNumber: gallery.contribution.versionNumber,
      paths: gallery.contribution.reading.items.map((item) => item.path),
    })));
    const datesByPage = new Map(dates.map((row) => [`${row.artifactId}\u001f${row.path}`, row]));
    return {
      examined: listed.length,
      galleries: galleries
        .toSorted((left, right) =>
          left.project.name.localeCompare(right.project.name)
          || left.artifact.name.localeCompare(right.artifact.name))
        .map((gallery) => assembleGallery(gallery, datesByPage)),
      generatedAt: DateTime.formatIso(yield* dependencies.clock.now),
      truncated,
      unreadable: unreadable.toSorted((left, right) => left.localeCompare(right)),
    } satisfies LibraryResponse;
  });

  return LibraryCatalogService.of({read});
}
