import {
  type ActionKind,
  artifactActionKinds,
  artifactHistoryActionKinds,
  defaultProjectId,
  installationActionKinds,
} from "../core/model.js";

/** Prefix reserved for rows reconstructed from recorded state during migration. */
export const recoveredActionIdPrefix = "recovered:";

/** Largest serialized `detail_json` the activity log stores. */
export const activityDetailJsonMaxBytes = 4096;

/** Deterministic id of one reconstructed row, so a repeated migration cannot duplicate it. */
export function recoveredActionId(kind: ActionKind, subjectId: string): string {
  return `${recoveredActionIdPrefix}${kind}:${subjectId}`;
}

/** Kinds that belong to one project but no artifact. */
export const projectScopedActionKinds = [
  installationActionKinds.dispatchAddressed,
  installationActionKinds.dispatchCreate,
  installationActionKinds.projectArchive,
  installationActionKinds.projectCreate,
  installationActionKinds.projectUnarchive,
] as const;

/** Kinds that belong to the installation as a whole. */
export const installationScopedActionKinds = [
  installationActionKinds.inviteCreate,
  installationActionKinds.inviteRedeem,
  installationActionKinds.inviteRevoke,
  installationActionKinds.keyIssue,
  installationActionKinds.keyRevoke,
  installationActionKinds.keyRotate,
  installationActionKinds.memberAdmit,
  installationActionKinds.memberDeactivate,
] as const;

/**
 * Kinds the installation itself may perform with no principal: automatic or
 * owner-bootstrap admission and the bootstrap API key. Every other live row
 * keeps a principal (AUD-001-F).
 */
export const systemPerformableActionKinds = [
  installationActionKinds.keyIssue,
  installationActionKinds.memberAdmit,
] as const;

// Every value comes from a closed constant set, so quoting needs no escaping.
const sqlList = (kinds: readonly string[]): string =>
  kinds.map((kind) => `'${kind}'`).join(", ");

export const artifactActionKindSql = sqlList(Object.values(artifactActionKinds));
export const artifactHistoryActionKindSql = sqlList(artifactHistoryActionKinds);
export const projectScopedActionKindSql = sqlList(projectScopedActionKinds);
export const installationScopedActionKindSql = sqlList(installationScopedActionKinds);
export const systemPerformableActionKindSql = sqlList(systemPerformableActionKinds);
export const allActionKindSql = sqlList([
  ...Object.values(artifactActionKinds),
  ...Object.values(installationActionKinds),
]);

const commentKindSql = sqlList([
  artifactActionKinds.commentCreate,
  artifactActionKinds.commentDelete,
  artifactActionKinds.commentReopen,
  artifactActionKinds.commentReply,
  artifactActionKinds.commentResolve,
  artifactActionKinds.commentUpdate,
]);
const firstPublicationKindSql = sqlList([
  artifactActionKinds.capture,
  artifactActionKinds.link,
  artifactActionKinds.publish,
]);

/** Row rules every backend's `actions` table enforces, as portable CHECK bodies. */
export const actionRowChecks = [
  `action IN (${allActionKindSql})`,
  `(action IN (${artifactActionKindSql})
      AND project_id IS NOT NULL AND artifact_id IS NOT NULL AND version_id IS NOT NULL)
    OR (action IN (${projectScopedActionKindSql})
      AND project_id IS NOT NULL AND artifact_id IS NULL AND version_id IS NULL)
    OR (action IN (${installationScopedActionKindSql})
      AND project_id IS NULL AND artifact_id IS NULL AND version_id IS NULL)`,
  `principal_id IS NOT NULL OR id LIKE '${recoveredActionIdPrefix}%'
    OR action IN (${systemPerformableActionKindSql})`,
  "actor_kind IS NULL OR actor_kind IN ('human', 'service')",
  "access_from IS NULL OR access_from IN ('account_required', 'public_link')",
  "access_to IS NULL OR access_to IN ('account_required', 'public_link')",
] as const;

const legacyColumns = `id, project_id, artifact_id, version_id, action, principal_id,
  authorized_by_principal_id, idempotency_key, created_at`;

function actionsTableSql(name: string, strict: boolean): string {
  return `CREATE TABLE ${name} (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id),
      artifact_id TEXT REFERENCES artifacts(id),
      version_id TEXT REFERENCES versions(id),
      action TEXT NOT NULL,
      principal_id TEXT,
      authorized_by_principal_id TEXT,
      idempotency_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      thread_id TEXT,
      reply_id TEXT,
      subject_id TEXT,
      access_from TEXT,
      access_to TEXT,
      actor_name TEXT,
      actor_kind TEXT,
      detail_json TEXT,
      ${actionRowChecks.map((check) => `CHECK (${check})`).join(",\n      ")},
      CHECK (detail_json IS NULL OR (
        json_valid(detail_json)
        AND length(CAST(detail_json AS BLOB)) <= ${activityDetailJsonMaxBytes}
      ))
    )${strict ? " STRICT" : ""}`;
}

const actionsIndexStatements = [
  `CREATE INDEX IF NOT EXISTS actions_artifact_created
    ON actions (project_id, artifact_id, created_at DESC, id DESC)`,
  "CREATE INDEX IF NOT EXISTS actions_created ON actions (created_at DESC, id DESC)",
  `CREATE INDEX IF NOT EXISTS actions_project_created
    ON actions (project_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS actions_thread
    ON actions (thread_id) WHERE thread_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS actions_installation_idempotency
    ON actions (idempotency_key) WHERE project_id IS NULL`,
] as const;

const actionsSubjectIndexStatement = `CREATE INDEX IF NOT EXISTS actions_subject
    ON actions (subject_id, created_at DESC, id DESC)
    WHERE subject_id IS NOT NULL`;

/**
 * Copy `actions` into the activity-log shape inside the caller's transaction
 * (SQLite) or batch (D1). The copy-check table's CHECK aborts the whole
 * transaction unless both tables hold exactly the same legacy rows.
 */
export function sqliteActionsRebuildStatements(
  options: {readonly strict: boolean},
): readonly string[] {
  return [
    "DROP TABLE IF EXISTS actions_next",
    "DROP TABLE IF EXISTS actions_copy_check",
    actionsTableSql("actions_next", options.strict),
    `INSERT INTO actions_next (${legacyColumns})
      SELECT ${legacyColumns} FROM actions`,
    // The migrated column refuses a table a concurrent migrator already rebuilt: copying only the legacy
    // columns from it would drop every activity-log column.
    `CREATE TABLE actions_copy_check (
      expected INTEGER NOT NULL,
      copied INTEGER NOT NULL,
      missing INTEGER NOT NULL,
      migrated INTEGER NOT NULL,
      CHECK (expected = copied AND missing = 0 AND migrated = 0)
    )`,
    `INSERT INTO actions_copy_check (expected, copied, missing, migrated)
      SELECT
        (SELECT count(*) FROM actions),
        (SELECT count(*) FROM actions_next),
        (SELECT count(*) FROM (
          SELECT ${legacyColumns} FROM actions
          EXCEPT
          SELECT ${legacyColumns} FROM actions_next
        )),
        (SELECT count(*) FROM sqlite_schema
          WHERE type = 'table' AND name = 'actions' AND instr(sql, 'subject_id') > 0)`,
    "DROP TABLE actions_copy_check",
    "DROP TABLE actions",
    "ALTER TABLE actions_next RENAME TO actions",
    ...actionsIndexStatements,
  ];
}

const activityColumns = `id, project_id, artifact_id, version_id, action, principal_id,
  authorized_by_principal_id, idempotency_key, created_at, thread_id, reply_id,
  subject_id, access_from, access_to, actor_name, actor_kind, detail_json`;

/** Whether the stored actions CREATE statement accepts every current kind. */
export function sqliteActionsTableAcceptsEveryKind(tableSql: string): boolean {
  return [...Object.values(artifactActionKinds), ...Object.values(installationActionKinds)]
    .every((kind) => tableSql.includes(`'${kind}'`));
}

/**
 * Rebuild an activity-log-shaped `actions` table so its CHECKs accept every
 * current kind. Run inside the caller's transaction (SQLite) or batch (D1);
 * the copy check aborts unless every row arrived.
 */
export function sqliteActionsWidenStatements(
  options: {readonly strict: boolean},
): readonly string[] {
  return [
    "DROP TABLE IF EXISTS actions_next",
    "DROP TABLE IF EXISTS actions_copy_check",
    actionsTableSql("actions_next", options.strict),
    `INSERT INTO actions_next (${activityColumns}) SELECT ${activityColumns} FROM actions`,
    `CREATE TABLE actions_copy_check (
      expected INTEGER NOT NULL,
      copied INTEGER NOT NULL,
      CHECK (expected = copied)
    )`,
    `INSERT INTO actions_copy_check (expected, copied)
      SELECT (SELECT count(*) FROM actions), (SELECT count(*) FROM actions_next)`,
    "DROP TABLE actions_copy_check",
    "DROP TABLE actions",
    "ALTER TABLE actions_next RENAME TO actions",
    ...actionsIndexStatements,
    actionsSubjectIndexStatement,
  ];
}

const recoveredInsertColumns = `id, project_id, artifact_id, version_id, action,
  principal_id, authorized_by_principal_id, idempotency_key, created_at,
  subject_id, actor_name, actor_kind, detail_json`;

/**
 * Fill the new columns and reconstruct rows from what SQLite or D1 already
 * recorded. Every statement is idempotent: updates only touch NULL columns
 * and inserts use deterministic ids with INSERT OR IGNORE. Pass
 * `identity: false` when the identity tables do not exist yet.
 */
export function sqliteActivityRecoveryStatements(
  options: {readonly identity: boolean},
): readonly string[] {
  const threadAndAccess = [
    // comment:<threadId>:<36-character uuid>
    `UPDATE actions
       SET thread_id = substr(idempotency_key, 9, length(idempotency_key) - 45)
     WHERE action IN (${commentKindSql})
       AND thread_id IS NULL
       AND idempotency_key LIKE 'comment:%'
       AND length(idempotency_key) > 45
       AND substr(idempotency_key, length(idempotency_key) - 36, 1) = ':'`,
    `UPDATE actions
       SET reply_id = (
         SELECT r.id FROM comment_replies r
          WHERE r.thread_id = actions.thread_id
            AND r.created_at = actions.created_at
            AND r.author_principal_id = actions.principal_id)
     WHERE action = 'comment_reply'
       AND reply_id IS NULL
       AND thread_id IS NOT NULL
       AND (SELECT count(*) FROM comment_replies r
             WHERE r.thread_id = actions.thread_id
               AND r.created_at = actions.created_at
               AND r.author_principal_id = actions.principal_id) = 1`,
    `UPDATE actions
       SET access_to = (
         SELECT i.access_setting FROM idempotency_records i
          WHERE i.project_id = actions.project_id
            AND i.idempotency_key = actions.idempotency_key
            AND i.operation = 'change_access')
     WHERE action = 'change_access' AND access_to IS NULL`,
    `UPDATE actions
       SET access_from = (
         SELECT i.access_setting
           FROM actions p
           JOIN idempotency_records i
             ON i.project_id = p.project_id AND i.idempotency_key = p.idempotency_key
          WHERE p.project_id = actions.project_id
            AND p.artifact_id = actions.artifact_id
            AND i.access_setting IS NOT NULL
            AND (p.created_at < actions.created_at
              OR (p.created_at = actions.created_at AND p.id < actions.id))
          ORDER BY p.created_at DESC, p.id DESC
          LIMIT 1)
     WHERE action = 'change_access' AND access_from IS NULL`,
  ];
  const reconstructed = [
    `INSERT OR IGNORE INTO actions (${recoveredInsertColumns})
     SELECT 'recovered:dispatch_create:' || d.id, d.project_id, NULL, NULL,
       'dispatch_create', d.sender_principal_id, d.sender_authorized_by_principal_id,
       'recovered:dispatch_create:' || d.id, d.created_at, d.id,
       d.sender_display_name, d.sender_principal_kind,
       -- Thread ids stay on the dispatch row: a 100-thread bundle exceeds the detail bound.
       json_object('agentDisplayName', d.agent_display_name)
       FROM agent_dispatches d`,
    `INSERT OR IGNORE INTO actions (${recoveredInsertColumns})
     SELECT 'recovered:dispatch_addressed:' || d.id, d.project_id, NULL, NULL,
       'dispatch_addressed',
       (SELECT ra.principal_id FROM registered_agents ra WHERE ra.id = d.agent_id),
       NULL, 'recovered:dispatch_addressed:' || d.id, d.addressed_at, d.id,
       d.agent_display_name, 'service',
       json_object('agentDisplayName', d.agent_display_name)
       FROM agent_dispatches d
      WHERE d.addressed_at IS NOT NULL`,
    `INSERT OR IGNORE INTO actions (${recoveredInsertColumns})
     SELECT 'recovered:project_create:' || p.id, p.id, NULL, NULL,
       'project_create', NULL, NULL, 'recovered:project_create:' || p.id,
       p.created_at, p.id, NULL, NULL, json_object('name', p.name)
       FROM projects p
      WHERE p.id <> '${defaultProjectId}'`,
    `INSERT OR IGNORE INTO actions (${recoveredInsertColumns})
     SELECT 'recovered:project_archive:' || p.id, p.id, NULL, NULL,
       'project_archive', NULL, NULL, 'recovered:project_archive:' || p.id,
       p.archived_at, p.id, NULL, NULL, NULL
       FROM projects p
      WHERE p.archived_at IS NOT NULL`,
  ];
  const identityRows = options.identity
    ? [
      `INSERT OR IGNORE INTO actions (${recoveredInsertColumns})
       SELECT 'recovered:member_admit:' || m.id, NULL, NULL, NULL,
         'member_admit', NULL, NULL, 'recovered:member_admit:' || m.id,
         m.created_at, m.id, NULL, NULL, NULL
         FROM installation_members m`,
      `INSERT OR IGNORE INTO actions (${recoveredInsertColumns})
       SELECT 'recovered:' || kind || ':' || k.id, NULL, NULL, NULL,
         kind, k.authorized_by_principal_id, NULL,
         'recovered:' || kind || ':' || k.id, k.created_at, k.id, NULL, NULL,
         json_object('capabilities', json(k.capabilities_json))
         FROM (
           SELECT managed_api_keys.*,
             CASE WHEN rotated_from_id IS NULL THEN 'key_issue' ELSE 'key_rotate' END AS kind
             FROM managed_api_keys
         ) k`,
      `INSERT OR IGNORE INTO actions (${recoveredInsertColumns})
       SELECT 'recovered:key_revoke:' || k.id, NULL, NULL, NULL,
         'key_revoke', NULL, NULL, 'recovered:key_revoke:' || k.id,
         k.revoked_at, k.id, NULL, NULL, NULL
         FROM managed_api_keys k
        WHERE k.revoked_at IS NOT NULL`,
    ]
    : [];
  const actorNames = [
    `UPDATE actions
       SET (actor_name, actor_kind) = (
         SELECT t.author_display_name, t.author_principal_kind FROM comment_threads t
          WHERE t.id = actions.thread_id AND t.author_principal_id = actions.principal_id)
     WHERE actor_name IS NULL AND thread_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM comment_threads t
                    WHERE t.id = actions.thread_id
                      AND t.author_principal_id = actions.principal_id)`,
    `UPDATE actions
       SET (actor_name, actor_kind) = (
         SELECT r.author_display_name, r.author_principal_kind FROM comment_replies r
          WHERE r.thread_id = actions.thread_id AND r.author_principal_id = actions.principal_id
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT 1)
     WHERE actor_name IS NULL AND thread_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM comment_replies r
                    WHERE r.thread_id = actions.thread_id
                      AND r.author_principal_id = actions.principal_id)`,
    `UPDATE actions
       SET (actor_name, actor_kind) = (
         SELECT t.resolved_by_display_name, t.resolved_by_principal_kind FROM comment_threads t
          WHERE t.id = actions.thread_id AND t.resolved_by_principal_id = actions.principal_id)
     WHERE actor_name IS NULL AND thread_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM comment_threads t
                    WHERE t.id = actions.thread_id
                      AND t.resolved_by_principal_id = actions.principal_id)`,
    ...(options.identity
      ? [
        `UPDATE actions
           SET (actor_name, actor_kind) = (
             SELECT m.display_name, 'human' FROM installation_members m
              WHERE m.id = actions.principal_id)
         WHERE actor_name IS NULL AND principal_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM installation_members m
                        WHERE m.id = actions.principal_id)`,
        `UPDATE actions
           SET (actor_name, actor_kind) = (
             SELECT k.name, 'service' FROM managed_api_keys k
              WHERE k.id = substr(actions.principal_id, 9))
         WHERE actor_name IS NULL AND principal_id LIKE 'service:%'
           AND EXISTS (SELECT 1 FROM managed_api_keys k
                        WHERE k.id = substr(actions.principal_id, 9))`,
      ]
      : []),
  ];
  const publicLinks = [
    `INSERT OR IGNORE INTO actions (
       id, project_id, artifact_id, version_id, action, principal_id,
       authorized_by_principal_id, idempotency_key, created_at,
       access_from, access_to, actor_name, actor_kind)
     SELECT 'recovered:public_link_enable:' || a.id, a.project_id, a.artifact_id,
       a.version_id, 'public_link_enable', a.principal_id,
       a.authorized_by_principal_id, 'recovered:public_link_enable:' || a.id,
       a.created_at, a.access_from, a.access_to, a.actor_name, a.actor_kind
       FROM actions a
      WHERE a.action = 'change_access'
        AND a.access_from = 'account_required' AND a.access_to = 'public_link'`,
    `INSERT OR IGNORE INTO actions (
       id, project_id, artifact_id, version_id, action, principal_id,
       authorized_by_principal_id, idempotency_key, created_at,
       access_from, access_to, actor_name, actor_kind)
     SELECT 'recovered:public_link_disable:' || a.id, a.project_id, a.artifact_id,
       a.version_id, 'public_link_disable', a.principal_id,
       a.authorized_by_principal_id, 'recovered:public_link_disable:' || a.id,
       a.created_at, a.access_from, a.access_to, a.actor_name, a.actor_kind
       FROM actions a
      WHERE a.action = 'change_access'
        AND a.access_from = 'public_link' AND a.access_to = 'account_required'`,
    // An artifact still public that never changed access was published public.
    `INSERT OR IGNORE INTO actions (
       id, project_id, artifact_id, version_id, action, principal_id,
       authorized_by_principal_id, idempotency_key, created_at,
       access_from, access_to, actor_name, actor_kind)
     SELECT 'recovered:public_link_enable:' || p.id, p.project_id, p.artifact_id,
       p.version_id, 'public_link_enable', p.principal_id,
       p.authorized_by_principal_id, 'recovered:public_link_enable:' || p.id,
       p.created_at, NULL, 'public_link', p.actor_name, p.actor_kind
       FROM actions p
       JOIN artifacts art ON art.id = p.artifact_id
      WHERE art.access_setting = 'public_link'
        AND p.action IN (${firstPublicationKindSql})
        AND NOT EXISTS (SELECT 1 FROM actions c
                         WHERE c.artifact_id = p.artifact_id AND c.action = 'change_access')
        AND NOT EXISTS (SELECT 1 FROM actions e
                         WHERE e.artifact_id = p.artifact_id
                           AND e.action IN (${firstPublicationKindSql})
                           AND (e.created_at < p.created_at
                             OR (e.created_at = p.created_at AND e.id < p.id)))`,
  ];
  return [...threadAndAccess, ...reconstructed, ...identityRows, ...actorNames, ...publicLinks];
}
