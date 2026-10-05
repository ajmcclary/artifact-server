import type {ManifestEntry, PageCursor} from "../core/model.js";
import type {ArtifactRepository, ProjectRepository} from "../core/ports.js";

/** The repository reads the backfill needs. */
export type CurrentVersionCatalog = Pick<ProjectRepository, "listProjects">
  & Pick<ArtifactRepository, "findVersionRecord" | "listArtifacts">;

const artifactPageSize = 100;

/** Every manifest entry of every project's current versions, one artifact at a time. */
export async function* currentVersionEntries(
  catalog: CurrentVersionCatalog,
): AsyncGenerator<ManifestEntry> {
  for (const project of await catalog.listProjects()) {
    let cursor: PageCursor | null = null;
    do {
      // eslint-disable-next-line no-await-in-loop -- each page names the next cursor
      const page = await catalog.listArtifacts({
        comments: "all",
        cursor,
        limit: artifactPageSize,
        projectId: project.id,
        sort: "newest",
        tags: [],
      });
      for (const artifact of page.items) {
        // eslint-disable-next-line no-await-in-loop -- versions are read one artifact at a time
        const current = await catalog.findVersionRecord(project.id, artifact.id, artifact.currentVersionId);
        if (current !== null) yield* current.manifest.entries;
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  }
}
