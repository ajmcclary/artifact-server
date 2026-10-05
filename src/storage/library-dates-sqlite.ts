import type {LibraryDatesRequest, LibraryPageDates} from "../core/library.js";

/**
 * Page created/changed times over each artifact's versions up to its current one.
 * ?1 is a JSON array of {artifactId, currentNumber, paths}. A row counts as a change
 * when the path is new, was absent from the previous version, or its digest differs.
 * SQLite and D1 share this text; D1 caps bound parameters, hence one JSON parameter.
 */
export const sqliteLibraryManifestDatesSql = `
  WITH requested AS (
    SELECT json_extract(value, '$.artifactId') AS artifact_id,
           json_extract(value, '$.currentNumber') AS current_number,
           json_extract(value, '$.paths') AS paths
    FROM json_each(?1)
  ),
  wanted AS (
    SELECT requested.artifact_id AS artifact_id, wanted_path.value AS path
    FROM requested, json_each(requested.paths) AS wanted_path
  ),
  ranked AS (
    SELECT version.id AS id, version.artifact_id AS artifact_id, version.created_at AS created_at,
           ROW_NUMBER() OVER (PARTITION BY version.artifact_id ORDER BY version.number) AS rank
    FROM versions AS version
    JOIN requested ON requested.artifact_id = version.artifact_id
    WHERE version.number <= requested.current_number
  ),
  present AS (
    SELECT ranked.artifact_id AS artifact_id, entry.path AS path, ranked.rank AS rank,
           ranked.created_at AS created_at, entry.sha256 AS sha256
    FROM ranked
    JOIN manifest_entries AS entry ON entry.version_id = ranked.id
    JOIN wanted ON wanted.artifact_id = ranked.artifact_id AND wanted.path = entry.path
  ),
  flagged AS (
    SELECT artifact_id, path, created_at,
           CASE WHEN LAG(rank) OVER page IS NULL
                  OR LAG(rank) OVER page <> rank - 1
                  OR LAG(sha256) OVER page <> sha256
                THEN 1 ELSE 0 END AS changed
    FROM present
    WINDOW page AS (PARTITION BY artifact_id, path ORDER BY rank)
  )
  SELECT artifact_id AS artifactId, path,
         MIN(created_at) AS createdAt,
         MAX(CASE WHEN changed = 1 THEN created_at END) AS changedAt
  FROM flagged
  GROUP BY artifact_id, path
`;

/** The newest thread or reply time per page, over threads on the considered versions. */
export const sqliteLibraryCommentDatesSql = `
  WITH requested AS (
    SELECT json_extract(value, '$.artifactId') AS artifact_id,
           json_extract(value, '$.currentNumber') AS current_number,
           json_extract(value, '$.paths') AS paths
    FROM json_each(?1)
  ),
  wanted AS (
    SELECT requested.artifact_id AS artifact_id, wanted_path.value AS path
    FROM requested, json_each(requested.paths) AS wanted_path
  ),
  threads AS (
    SELECT thread.id AS id, thread.artifact_id AS artifact_id, thread.path AS path, thread.created_at AS created_at
    FROM comment_threads AS thread
    JOIN versions AS version ON version.id = thread.version_id
    JOIN requested ON requested.artifact_id = thread.artifact_id
    JOIN wanted ON wanted.artifact_id = thread.artifact_id AND wanted.path = thread.path
    WHERE version.number <= requested.current_number
  ),
  times AS (
    SELECT artifact_id, path, created_at AS at FROM threads
    UNION ALL
    SELECT threads.artifact_id, threads.path, reply.created_at
    FROM comment_replies AS reply JOIN threads ON threads.id = reply.thread_id
  )
  SELECT artifact_id AS artifactId, path, MAX(at) AS commentedAt
  FROM times
  GROUP BY artifact_id, path
`;

export interface LibraryManifestRow {
  readonly artifactId: string;
  readonly changedAt: string;
  readonly createdAt: string;
  readonly path: string;
}

export interface LibraryCommentRow {
  readonly artifactId: string;
  readonly commentedAt: string;
  readonly path: string;
}

/** Join comment activity onto the pages the manifests date. */
export function mergeLibraryDates(
  manifestRows: readonly LibraryManifestRow[],
  commentRows: readonly LibraryCommentRow[],
): LibraryPageDates[] {
  const comments = new Map(commentRows.map((row) => [`${row.artifactId}\u001f${row.path}`, row.commentedAt]));
  return manifestRows.map((row) => ({
    artifactId: row.artifactId,
    changedAt: row.changedAt,
    commentedAt: comments.get(`${row.artifactId}\u001f${row.path}`) ?? null,
    createdAt: row.createdAt,
    path: row.path,
  }));
}

/** The JSON parameter both queries take. */
export function libraryDatesParameter(requests: readonly LibraryDatesRequest[]): string {
  return JSON.stringify(requests.map((request) => ({
    artifactId: request.artifactId,
    currentNumber: request.currentVersionNumber,
    paths: request.paths,
  })));
}
