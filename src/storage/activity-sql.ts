import {z} from "zod";

import {
  type ActionKind,
  type ActivityActionRow,
  artifactActionKinds,
  type CommentReplyRecord,
  type CommentThreadRecord,
  installationActionKinds,
} from "../core/model.js";
import type {
  ActivityPage,
  ActivityQuery,
  ActivityRow,
  ActivitySegment,
  ActivityThreadSnapshot,
  ActivityType,
} from "../core/ports.js";

/** SQL dialects that share the activity statement shape. */
export type ActivitySqlDialect = "postgres" | "sqlite";

/** One positional statement ready for the backend driver. */
export interface ActivityStatement {
  readonly text: string;
  readonly values: readonly (number | string | null)[];
}

/** Comment kinds whose newest row per thread stands for the thread. */
export const threadHeadKinds = [
  artifactActionKinds.commentCreate,
  artifactActionKinds.commentReply,
] as const;

/** Action kinds each feed type shows. Kinds outside every list never reach the feed. */
export const feedKindsByType = {
  access: [
    artifactActionKinds.publicLinkEnable,
    artifactActionKinds.publicLinkDisable,
  ],
  admin: [
    installationActionKinds.memberAdmit,
    installationActionKinds.memberDeactivate,
    installationActionKinds.keyIssue,
    installationActionKinds.keyRotate,
    installationActionKinds.keyRevoke,
    installationActionKinds.projectCreate,
    installationActionKinds.projectArchive,
    installationActionKinds.projectUnarchive,
  ],
  agents: [
    installationActionKinds.dispatchCreate,
    installationActionKinds.dispatchAddressed,
  ],
  comments: [
    artifactActionKinds.commentCreate,
    artifactActionKinds.commentReply,
    artifactActionKinds.commentResolve,
    artifactActionKinds.commentReopen,
    artifactActionKinds.commentDelete,
  ],
  versions: [artifactActionKinds.publish, artifactActionKinds.restore],
} as const satisfies Record<ActivityType, readonly ActionKind[]>;

/** Kinds only administrators may read. */
export const administrationKinds: readonly ActionKind[] = [
  installationActionKinds.memberAdmit,
  installationActionKinds.memberDeactivate,
  installationActionKinds.keyIssue,
  installationActionKinds.keyRotate,
  installationActionKinds.keyRevoke,
];

const actionKindSchema = z.union([
  z.enum(artifactActionKinds),
  z.enum(installationActionKinds),
]);

const activeDispatchStates = "('queued', 'claimed', 'delivered')";

/** Positional values bound in textual order. */
class StatementValues {
  readonly values: (number | string | null)[] = [];
  readonly dialect: ActivitySqlDialect;

  constructor(dialect: ActivitySqlDialect) {
    this.dialect = dialect;
  }

  bind(value: number | string | null): string {
    this.values.push(value);
    return this.dialect === "postgres" ? `$${this.values.length}` : "?";
  }

  /** A subquery yielding each string in `items`, bound as one JSON value. */
  bindList(items: readonly string[]): string {
    const placeholder = this.bind(JSON.stringify(items));
    return this.dialect === "postgres"
      ? `(SELECT jsonb_array_elements_text(${placeholder}::jsonb))`
      : `(SELECT value FROM json_each(${placeholder}))`;
  }
}

/** Constant kind names only; never caller input. */
function kindLiterals(kinds: readonly ActionKind[]): string {
  return kinds.map((kind) => {
    if (!/^[a-z_]+$/u.test(kind)) throw new Error(`Unsafe action kind: ${kind}`);
    return `'${kind}'`;
  }).join(", ");
}

function scope(dialect: ActivitySqlDialect, alias: string, owner: string): string {
  return dialect === "postgres"
    ? ` AND ${alias}.installation_id = ${owner}.installation_id`
    : "";
}

function visibleKinds(query: ActivityQuery): readonly ActionKind[] {
  const types: readonly ActivityType[] = query.types.length === 0
    ? ["access", "admin", "agents", "comments", "versions"]
    : query.types;
  const kinds = types.flatMap((type) => feedKindsByType[type]);
  return query.includeAdministration
    ? kinds
    : kinds.filter((kind) => !administrationKinds.includes(kind));
}

function segmentPredicate(segment: ActivitySegment, heads: string): string | null {
  if (segment === "all") return null;
  // The same open-thread rule the summary counts: conversations on deleted artifacts never wait.
  const openHead = `(x.action IN (${heads}) AND t.state = 'open' AND a.deleted_at IS NULL)`;
  if (segment === "needs_you") return `(${openHead} AND held.id IS NULL)`;
  return `((${openHead} AND held.id IS NOT NULL)
      OR (x.action IN (${kindLiterals(feedKindsByType.agents)})
        AND d.state IN ${activeDispatchStates}))`;
}

function searchPredicate(
  dialect: ActivitySqlDialect,
  values: StatementValues,
  search: string | null,
): string | null {
  if (search === null) return null;
  const find = dialect === "postgres" ? "strpos" : "instr";
  const needle = () => values.bind(search);
  return `(${find}(lower(COALESCE(x.actor_name, '')), ${needle()}) > 0
      OR ${find}(lower(COALESCE(a.name, '')), ${needle()}) > 0
      OR ${find}(lower(COALESCE(p.name, '')), ${needle()}) > 0
      OR ${find}(lower(COALESCE(t.body, '')), ${needle()}) > 0
      OR EXISTS (
        SELECT 1 FROM comment_replies sr
        WHERE sr.thread_id = t.id${scope(dialect, "sr", "t")}
          AND ${find}(lower(sr.body), ${needle()}) > 0))`;
}

/** Build the one-page feed statement for a dialect. */
export function buildListActivityStatement(
  dialect: ActivitySqlDialect,
  query: ActivityQuery,
  installationId: string,
): ActivityStatement {
  const values = new StatementValues(dialect);
  const heads = kindLiterals(threadHeadKinds);
  const where: string[] = [];
  if (dialect === "postgres") {
    where.push(`x.installation_id = ${values.bind(installationId)}`);
  }
  where.push(`x.action IN (${kindLiterals(visibleKinds(query))})`);
  where.push(`(x.action NOT IN (${heads}) OR (t.id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM actions newer
      WHERE newer.thread_id = x.thread_id${scope(dialect, "newer", "x")}
        AND newer.action IN (${heads})
        AND (newer.created_at > x.created_at
          OR (newer.created_at = x.created_at AND newer.id > x.id)))))`);
  if (query.projectIds.length > 0) {
    where.push(`x.project_id IN ${values.bindList(query.projectIds)}`);
  }
  const segment = segmentPredicate(query.segment, heads);
  if (segment !== null) where.push(segment);
  const search = searchPredicate(dialect, values, query.search);
  if (search !== null) where.push(search);
  if (query.cursor !== null) {
    const createdAt = values.bind(query.cursor.createdAt);
    const sameCreatedAt = values.bind(query.cursor.createdAt);
    const id = values.bind(query.cursor.id);
    where.push(`(x.created_at < ${createdAt}
      OR (x.created_at = ${sameCreatedAt} AND x.id < ${id}))`);
  }
  const limit = values.bind(query.limit + 1);
  const text = `SELECT
      x.id AS "id",
      x.action AS "action",
      x.created_at AS "createdAt",
      x.principal_id AS "principalId",
      x.actor_name AS "actorName",
      x.actor_kind AS "actorKind",
      x.project_id AS "projectId",
      x.artifact_id AS "artifactId",
      x.version_id AS "versionId",
      x.thread_id AS "threadId",
      x.reply_id AS "replyId",
      x.subject_id AS "subjectId",
      x.access_from AS "accessFrom",
      x.access_to AS "accessTo",
      x.detail_json AS "detailJson",
      p.name AS "projectName",
      a.name AS "artifactName",
      CASE WHEN a.id IS NULL THEN NULL
        WHEN a.deleted_at IS NOT NULL OR p.archived_at IS NOT NULL THEN 1
        ELSE 0 END AS "artifactArchived",
      v.number AS "versionNumber",
      d.agent_display_name AS "dispatchAgentName",
      d.state AS "dispatchState",
      d.thread_ids_json AS "dispatchThreadIdsJson",
      t.id AS "liveThreadId",
      t.state AS "threadState",
      CASE WHEN held.id IS NULL THEN 0 ELSE 1 END AS "threadHeld",
      substr(t.body, 1, 280) AS "threadExcerpt"
    FROM actions x
    LEFT JOIN projects p ON p.id = x.project_id${scope(dialect, "p", "x")}
    LEFT JOIN artifacts a ON a.id = x.artifact_id${scope(dialect, "a", "x")}
    LEFT JOIN versions v ON v.id = x.version_id${scope(dialect, "v", "x")}
    LEFT JOIN comment_threads t ON t.id = x.thread_id${scope(dialect, "t", "x")}
    LEFT JOIN agent_dispatches held ON held.id = t.dispatch_id${scope(dialect, "held", "t")}
      AND held.state IN ${activeDispatchStates}
    LEFT JOIN agent_dispatches d ON d.id = x.subject_id${scope(dialect, "d", "x")}
      AND x.action IN (${kindLiterals(feedKindsByType.agents)})
    WHERE ${where.join("\n      AND ")}
    ORDER BY x.created_at DESC, x.id DESC
    LIMIT ${limit}`;
  return {text, values: values.values};
}

/** The newest two replies of each thread, oldest first within a thread. */
export function buildNewestRepliesStatement(
  dialect: ActivitySqlDialect,
  threadIds: readonly string[],
  installationId: string,
): ActivityStatement {
  const values = new StatementValues(dialect);
  const installation = dialect === "postgres"
    ? `r.installation_id = ${values.bind(installationId)} AND `
    : "";
  const ids = values.bindList(threadIds);
  return {
    text: `SELECT "id", "threadId", "projectId", "body", "authorPrincipalId",
        "authorPrincipalKind", "authorDisplayName",
        "authorAuthorizedByPrincipalId", "createdAt", "updatedAt"
      FROM (
        SELECT r.id AS "id", r.thread_id AS "threadId",
          r.project_id AS "projectId", r.body AS "body",
          r.author_principal_id AS "authorPrincipalId",
          r.author_principal_kind AS "authorPrincipalKind",
          r.author_display_name AS "authorDisplayName",
          r.author_authorized_by_principal_id AS "authorAuthorizedByPrincipalId",
          r.created_at AS "createdAt", r.updated_at AS "updatedAt",
          ROW_NUMBER() OVER (
            PARTITION BY r.thread_id ORDER BY r.created_at DESC, r.id DESC
          ) AS "newestRank"
        FROM comment_replies r
        WHERE ${installation}r.thread_id IN ${ids}
      ) ranked
      WHERE "newestRank" <= 2
      ORDER BY "threadId", "createdAt", "id"`,
    values: values.values,
  };
}

const accessSettingSchema = z.enum(["account_required", "public_link"]);
const principalKindSchema = z.enum(["human", "service"]);
const dispatchStateSchema = z.enum([
  "addressed",
  "canceled",
  "claimed",
  "delivered",
  "failed",
  "queued",
]);

/** One flat feed row exactly as every dialect's statement returns it. */
export const activitySqlRowSchema = z.object({
  accessFrom: accessSettingSchema.nullable(),
  accessTo: accessSettingSchema.nullable(),
  action: actionKindSchema,
  actorKind: principalKindSchema.nullable(),
  actorName: z.string().nullable(),
  artifactArchived: z.number().int().nullable(),
  artifactId: z.string().nullable(),
  artifactName: z.string().nullable(),
  createdAt: z.string(),
  detailJson: z.string().nullable(),
  dispatchAgentName: z.string().nullable(),
  dispatchState: dispatchStateSchema.nullable(),
  dispatchThreadIdsJson: z.string().nullable(),
  id: z.string(),
  liveThreadId: z.string().nullable(),
  principalId: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  replyId: z.string().nullable(),
  subjectId: z.string().nullable(),
  threadExcerpt: z.string().nullable(),
  threadHeld: z.number().int(),
  threadId: z.string().nullable(),
  threadState: z.enum(["open", "resolved"]).nullable(),
  versionId: z.string().nullable(),
  versionNumber: z.number().int().nullable(),
});

export type ActivitySqlRow = z.infer<typeof activitySqlRowSchema>;

const isThreadHead = (action: ActionKind): boolean =>
  threadHeadKinds.some((kind) => kind === action);

/** Live thread IDs on the returned page whose snapshot must be read. */
export function snapshotThreadIds(
  rows: readonly ActivitySqlRow[],
  limit: number,
): readonly string[] {
  return [...new Set(rows.slice(0, limit).flatMap((row) =>
    isThreadHead(row.action) && row.liveThreadId !== null
      ? [row.liveThreadId]
      : []
  ))];
}

const threadIdListSchema = z.array(z.string());
const detailSchema = z.record(z.string(), z.unknown());

function actionFromRow(row: ActivitySqlRow): ActivityActionRow {
  return {
    accessFrom: row.accessFrom,
    accessTo: row.accessTo,
    action: row.action,
    actor: row.actorName === null || row.actorKind === null
      ? null
      : {displayName: row.actorName, kind: row.actorKind},
    artifactId: row.artifactId,
    createdAt: row.createdAt,
    detail: row.detailJson === null
      ? null
      : detailSchema.parse(JSON.parse(row.detailJson)),
    id: row.id,
    principalId: row.principalId,
    projectId: row.projectId,
    replyId: row.replyId,
    subjectId: row.subjectId,
    threadId: row.threadId,
    versionId: row.versionId,
  };
}

function snapshotFor(
  row: ActivitySqlRow,
  threads: ReadonlyMap<string, CommentThreadRecord>,
  replies: ReadonlyMap<string, readonly CommentReplyRecord[]>,
): ActivityThreadSnapshot | null {
  if (!isThreadHead(row.action) || row.liveThreadId === null) return null;
  const opener = threads.get(row.liveThreadId);
  if (opener === undefined) return null;
  const isResolved = opener.state === "resolved";
  return {
    anchor: opener.anchor,
    id: opener.id,
    isResolved,
    opener,
    replies: replies.get(opener.id) ?? [],
    replyCount: opener.replyCount,
    state: isResolved ? "resolved" : row.threadHeld === 1 ? "with_agent" : "needs_you",
  };
}

/** Turn statement rows plus thread snapshots into one bounded page. */
export function assembleActivityPage(
  rows: readonly ActivitySqlRow[],
  threads: readonly CommentThreadRecord[],
  replies: readonly CommentReplyRecord[],
  limit: number,
): ActivityPage {
  const page = rows.slice(0, limit);
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const repliesByThread = new Map<string, CommentReplyRecord[]>();
  for (const reply of replies) {
    const list = repliesByThread.get(reply.threadId) ?? [];
    list.push(reply);
    repliesByThread.set(reply.threadId, list);
  }
  const items: ActivityRow[] = page.map((row) => ({
    action: actionFromRow(row),
    artifact: row.artifactId === null || row.artifactName === null
      ? null
      : {
        archived: row.artifactArchived === 1,
        id: row.artifactId,
        name: row.artifactName,
      },
    dispatch: row.dispatchState === null || row.dispatchAgentName === null
      ? null
      : {
        agentDisplayName: row.dispatchAgentName,
        state: row.dispatchState,
        threadIds: threadIdListSchema.parse(
          JSON.parse(row.dispatchThreadIdsJson ?? "[]"),
        ),
      },
    excerpt: row.action === artifactActionKinds.commentResolve ||
        row.action === artifactActionKinds.commentReopen
      ? row.threadExcerpt?.split("\n", 1)[0] ?? null
      : null,
    project: row.projectId === null || row.projectName === null
      ? null
      : {id: row.projectId, name: row.projectName},
    thread: snapshotFor(row, threadsById, repliesByThread),
    versionNumber: row.versionNumber,
  }));
  const last = page.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last !== undefined
      ? {createdAt: last.createdAt, id: last.id}
      : null,
  };
}

/** The two statements behind one activity summary. */
export interface ActivitySummaryStatements {
  readonly projects: ActivityStatement;
  readonly totals: ActivityStatement;
}

/** Totals and per-project counts over live open threads. */
export function buildSummaryStatements(
  dialect: ActivitySqlDialect,
  projectIds: readonly string[],
  installationId: string,
): ActivitySummaryStatements {
  const totalValues = new StatementValues(dialect);
  const totalWhere = ["t.state = 'open'"];
  if (dialect === "postgres") {
    totalWhere.push(`t.installation_id = ${totalValues.bind(installationId)}`);
  }
  if (projectIds.length > 0) {
    totalWhere.push(`t.project_id IN ${totalValues.bindList(projectIds)}`);
  }
  const totals = {
    text: `SELECT
        COALESCE(SUM(CASE WHEN held.id IS NULL THEN 1 ELSE 0 END), 0) AS "needsYou",
        COALESCE(SUM(CASE WHEN held.id IS NULL THEN 0 ELSE 1 END), 0) AS "withAgent",
        COUNT(t.id) AS "openConversations",
        COUNT(DISTINCT t.artifact_id) AS "artifactsInReview"
      FROM comment_threads t
      JOIN artifacts a ON a.id = t.artifact_id${scope(dialect, "a", "t")}
        AND a.deleted_at IS NULL
      LEFT JOIN agent_dispatches held ON held.id = t.dispatch_id${scope(dialect, "held", "t")}
        AND held.state IN ${activeDispatchStates}
      WHERE ${totalWhere.join(" AND ")}`,
    values: totalValues.values,
  };
  const projectValues = new StatementValues(dialect);
  const projectWhere: string[] = [];
  if (dialect === "postgres") {
    projectWhere.push(`p.installation_id = ${projectValues.bind(installationId)}`);
  }
  if (projectIds.length > 0) {
    projectWhere.push(`p.id IN ${projectValues.bindList(projectIds)}`);
  }
  const projects = {
    text: `SELECT
        p.id AS "id",
        (SELECT COUNT(*) FROM artifacts pa
          WHERE pa.project_id = p.id${scope(dialect, "pa", "p")}
            AND pa.deleted_at IS NULL) AS "artifactCount",
        (SELECT COUNT(*) FROM comment_threads pt
          JOIN artifacts pta ON pta.id = pt.artifact_id${scope(dialect, "pta", "pt")}
            AND pta.deleted_at IS NULL
          WHERE pt.project_id = p.id${scope(dialect, "pt", "p")}
            AND pt.state = 'open') AS "unresolved",
        (SELECT MAX(px.created_at) FROM actions px
          WHERE px.project_id = p.id${scope(dialect, "px", "p")}) AS "lastActivityAt"
      FROM projects p
      ${projectWhere.length === 0 ? "" : `WHERE ${projectWhere.join(" AND ")}`}
      ORDER BY p.created_at, p.id`,
    values: projectValues.values,
  };
  return {projects, totals};
}

/** Postgres returns COUNT and SUM as bigint strings; SQLite as numbers. */
export const activitySummaryTotalsSchema = z.object({
  artifactsInReview: z.coerce.number().int().nonnegative(),
  needsYou: z.coerce.number().int().nonnegative(),
  openConversations: z.coerce.number().int().nonnegative(),
  withAgent: z.coerce.number().int().nonnegative(),
});

export const activityProjectSummarySchema = z.object({
  artifactCount: z.coerce.number().int().nonnegative(),
  id: z.string(),
  lastActivityAt: z.string().nullable(),
  unresolved: z.coerce.number().int().nonnegative(),
});
