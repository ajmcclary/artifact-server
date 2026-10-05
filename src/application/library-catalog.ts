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
/** Parsed indexes per immutable version; a cached entry can never go stale. */
const maximumCachedIndexes = 1_000;

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

interface ReadableGallery {
  readonly artifact: ArtifactListItem;
  readonly project: ProjectRecord;
  readonly reading: Extract<PreviewIndexReading, {readonly status: "ready"}>;
  readonly version: ArtifactVersion;
}

function laterOf(left: string, right: string | null): string {
  return right !== null && right > left ? right : left;
}

function assembleGallery(gallery: ReadableGallery, dates: ReadonlyMap<string, LibraryPageDates>): LibraryGallery {
  const fallback = gallery.version.version.createdAt;
  return {
    artifactId: gallery.artifact.id,
    artifactName: gallery.artifact.name,
    indexTitle: gallery.reading.title,
    items: gallery.reading.items.map((item): LibraryGalleryItem => {
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
    versionId: gallery.version.version.id,
  };
}

function makeLibraryCatalogService(
  dependencies: LibraryCatalogDependencies,
  authorization: AuthorizationOperations,
): LibraryCatalogOperations {
  const indexes = new Map<string, PreviewIndexReading>();

  const readIndex = Effect.fn("LibraryCatalogService.readIndex")(function*(
    version: ArtifactVersion,
    indexEntry: ManifestEntry,
  ) {
    const cached = indexes.get(version.version.id);
    if (cached !== undefined) return cached;
    if (indexEntry.size > maximumPreviewIndexBytes) {
      return {reason: "The preview index is too large.", status: "invalid"} satisfies PreviewIndexReading;
    }
    // A failed read marks only this gallery unreadable and is not cached: it may be transient.
    const text = yield* dependencies.readBlobText(indexEntry).pipe(Effect.orElseSucceed(() => null));
    if (text === null) return {reason: "The preview index could not be read.", status: "invalid"} satisfies PreviewIndexReading;
    const reading = readPreviewIndex(text, version.manifest.entries);
    indexes.set(version.version.id, reading);
    if (indexes.size > maximumCachedIndexes) {
      const oldest = indexes.keys().next().value;
      if (oldest !== undefined) indexes.delete(oldest);
    }
    return reading;
  });

  const read = Effect.fn("LibraryCatalogService.read")(function*(principal: Principal) {
    yield* authorization.requireArtifactListing(principal);
    const projects = (yield* dependencies.listProjects())
      .toSorted((left, right) => left.name.localeCompare(right.name));
    const galleries: ReadableGallery[] = [];
    const unreadable: string[] = [];
    let examined = 0;
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
          if (examined >= maximumLibraryArtifacts) {
            truncated = true;
            break;
          }
          examined += 1;
          const version = yield* dependencies.findVersionRecord(project.id, artifact.id, artifact.currentVersionId);
          const indexEntry = version?.manifest.entries.find((entry) => entry.path === previewIndexPath);
          if (version === null || indexEntry === undefined) continue;
          const reading = yield* readIndex(version, indexEntry);
          if (reading.status === "invalid") {
            unreadable.push(artifact.name);
            continue;
          }
          galleries.push({artifact, project, reading, version});
        }
        cursor = truncated ? null : page.nextCursor;
      } while (cursor !== null);
      if (truncated) break;
    }
    const dates = yield* dependencies.pageDates(galleries.map((gallery) => ({
      artifactId: gallery.artifact.id,
      currentVersionNumber: gallery.version.version.number,
      paths: gallery.reading.items.map((item) => item.path),
    })));
    const datesByPage = new Map(dates.map((row) => [`${row.artifactId}\u001f${row.path}`, row]));
    return {
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
