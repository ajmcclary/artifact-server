import type {ActionAttribution} from "../core/action-attribution.js";
import type {AccessSetting, ActionKind, ActivityDetail, ActorSnapshot} from "../core/model.js";
import {activityDetailJsonMaxBytes} from "./activity-log-schema.js";

/** Largest serialized `detail_json` an action may carry (spec §1). */
export const maximumActionDetailBytes = activityDetailJsonMaxBytes;

/** One row for the installation activity log, independent of the backend. */
export interface ActionInsert {
  readonly accessFrom?: AccessSetting | null;
  readonly accessTo?: AccessSetting | null;
  readonly action: ActionKind;
  /** A caller-chosen id; null lets the database generate one. */
  readonly actionId?: string | null;
  readonly actor: ActorSnapshot | null;
  readonly artifactId: string | null;
  readonly authorizedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly detail?: ActivityDetail | null;
  readonly idempotencyKey: string;
  readonly principalId: string | null;
  readonly projectId: string | null;
  readonly replyId?: string | null;
  readonly subjectId?: string | null;
  readonly threadId?: string | null;
  readonly versionId: string | null;
}

/** Columns after `id`, in bind order, shared by every writer. */
export const actionInsertColumns = [
  "project_id",
  "artifact_id",
  "version_id",
  "action",
  "principal_id",
  "authorized_by_principal_id",
  "idempotency_key",
  "created_at",
  "thread_id",
  "reply_id",
  "subject_id",
  "access_from",
  "access_to",
  "actor_name",
  "actor_kind",
  "detail_json",
] as const;

const columnList = `id, ${actionInsertColumns.join(", ")}`;
const placeholders = actionInsertColumns.map(() => "?").join(", ");

/** SQLite and D1 insert; the first bind value is the optional action id. */
export const positionalActionInsertSql =
  `INSERT INTO actions (${columnList})
   VALUES (COALESCE(?, lower(hex(randomblob(16)))), ${placeholders})`;

/** SQLite and D1 insert that does nothing when the idempotency key exists. */
export const positionalActionInsertOnceSql =
  `INSERT INTO actions (${columnList})
   SELECT COALESCE(?, lower(hex(randomblob(16)))), ${placeholders}
   WHERE NOT EXISTS (SELECT 1 FROM actions WHERE idempotency_key = ?)`;

/**
 * SQLite and D1 insert written only when `condition` holds, for batches that
 * cannot branch (D1). Bind {@link positionalActionValues} then the condition's values.
 */
export function positionalActionInsertWhereSql(condition: string): string {
  return `INSERT INTO actions (${columnList})
   SELECT COALESCE(?, lower(hex(randomblob(16)))), ${placeholders}
   WHERE ${condition}`;
}

/** Serialize bounded detail, refusing (not truncating) oversized history. */
export function serializeActionDetail(
  detail: ActivityDetail | null | undefined,
): string | null {
  if (detail === null || detail === undefined) return null;
  const json = JSON.stringify(detail);
  if (new TextEncoder().encode(json).byteLength > maximumActionDetailBytes) {
    throw new RangeError(
      `Action detail exceeds ${maximumActionDetailBytes} bytes.`,
    );
  }
  return json;
}

/** Bind values for {@link positionalActionInsertSql}. */
export function positionalActionValues(insert: ActionInsert): (string | null)[] {
  return [
    insert.actionId ?? null,
    insert.projectId,
    insert.artifactId,
    insert.versionId,
    insert.action,
    insert.principalId,
    insert.authorizedByPrincipalId,
    insert.idempotencyKey,
    insert.createdAt,
    insert.threadId ?? null,
    insert.replyId ?? null,
    insert.subjectId ?? null,
    insert.accessFrom ?? null,
    insert.accessTo ?? null,
    insert.actor?.displayName ?? null,
    insert.actor?.kind ?? null,
    serializeActionDetail(insert.detail),
  ];
}

/** Bind values for {@link positionalActionInsertOnceSql}. */
export function positionalActionOnceValues(insert: ActionInsert): (string | null)[] {
  return [...positionalActionValues(insert), insert.idempotencyKey];
}

/** The companion row an access change writes when its direction changes. */
export function publicLinkTransition(
  from: AccessSetting | null,
  to: AccessSetting,
): "public_link_enable" | "public_link_disable" | null {
  if (from === to) return null;
  if (to === "public_link") return "public_link_enable";
  return from === "public_link" ? "public_link_disable" : null;
}

/** Derived key for a companion row; never collides with a caller key. */
export function companionIdempotencyKey(idempotencyKey: string): string {
  return `${idempotencyKey}:public_link`;
}

/** Build an installation-level row from an attribution. */
export function attributedInsert(
  attribution: ActionAttribution,
  fields: Omit<
    ActionInsert,
    "actor" | "artifactId" | "authorizedByPrincipalId" | "principalId" | "versionId"
  >,
): ActionInsert {
  return {
    ...fields,
    actor: attribution.actor,
    artifactId: null,
    authorizedByPrincipalId: attribution.authorizedByPrincipalId,
    principalId: attribution.principalId,
    versionId: null,
  };
}
