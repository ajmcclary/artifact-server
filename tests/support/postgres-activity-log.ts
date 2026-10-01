/** Action kinds a schema-17 Postgres `actions` table accepts. */
export const schema17ActionKindSql = [
  "publish", "restore", "change_access", "change_tags", "delete",
  "comment_create", "comment_reply", "comment_update",
  "comment_resolve", "comment_reopen", "comment_delete",
].map((kind) => `'${kind}'`).join(", ");

/**
 * Statements that undo migration 0018 on a populated database, so a test can
 * re-apply it (or run an older downgrade) against a realistic schema-17 file.
 * The caller removes the matching `artifact_server_postgres_migrations` rows.
 */
export const revertInstallationActivityLogStatements: readonly string[] = [
  `DELETE FROM actions WHERE id LIKE 'recovered:%' OR action NOT IN (${schema17ActionKindSql})`,
  "DROP INDEX actions_installation_created",
  "DROP INDEX actions_installation_project_created",
  "DROP INDEX actions_installation_thread",
  "DROP INDEX actions_installation_idempotency",
  `ALTER TABLE actions
    DROP CONSTRAINT actions_scope_check,
    DROP CONSTRAINT actions_principal_check,
    DROP CONSTRAINT actions_actor_kind_check,
    DROP CONSTRAINT actions_access_from_check,
    DROP CONSTRAINT actions_access_to_check,
    DROP CONSTRAINT actions_detail_check,
    DROP CONSTRAINT actions_action_check,
    DROP COLUMN thread_id, DROP COLUMN reply_id, DROP COLUMN subject_id,
    DROP COLUMN access_from, DROP COLUMN access_to,
    DROP COLUMN actor_name, DROP COLUMN actor_kind, DROP COLUMN detail_json,
    ALTER COLUMN project_id SET NOT NULL,
    ALTER COLUMN artifact_id SET NOT NULL,
    ALTER COLUMN version_id SET NOT NULL,
    ALTER COLUMN principal_id SET NOT NULL,
    ADD CONSTRAINT actions_action_check CHECK (action IN (${schema17ActionKindSql}))`,
];

/**
 * The tables and columns migration 0018 reads, in their schema-17 shape, for
 * hand-built partial legacy databases that otherwise hold only the tables
 * their own migration under test touches. Run after `artifacts` exists.
 */
export const activityLogPrerequisiteStubStatements: readonly string[] = [
  "ALTER TABLE artifacts ADD COLUMN access_setting TEXT",
  `CREATE TABLE actions (
    installation_id TEXT NOT NULL,
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    action TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    authorized_by_principal_id TEXT,
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (installation_id, id),
    CONSTRAINT actions_action_check CHECK (action IN (${schema17ActionKindSql}))
  )`,
  `CREATE TABLE idempotency_records (
    installation_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    operation TEXT NOT NULL,
    access_setting TEXT,
    PRIMARY KEY (installation_id, project_id, idempotency_key)
  )`,
  `CREATE TABLE comment_threads (
    installation_id TEXT NOT NULL,
    id TEXT NOT NULL,
    author_principal_id TEXT NOT NULL,
    author_display_name TEXT NOT NULL,
    author_principal_kind TEXT NOT NULL,
    resolved_by_principal_id TEXT,
    resolved_by_display_name TEXT,
    resolved_by_principal_kind TEXT,
    PRIMARY KEY (installation_id, id)
  )`,
  `CREATE TABLE comment_replies (
    installation_id TEXT NOT NULL,
    id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    author_principal_id TEXT NOT NULL,
    author_display_name TEXT NOT NULL,
    author_principal_kind TEXT NOT NULL,
    PRIMARY KEY (installation_id, id)
  )`,
  `CREATE TABLE registered_agents (
    installation_id TEXT NOT NULL,
    id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    PRIMARY KEY (installation_id, id)
  )`,
  `CREATE TABLE agent_dispatches (
    installation_id TEXT NOT NULL,
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    agent_display_name TEXT NOT NULL,
    thread_ids_json TEXT NOT NULL,
    sender_principal_id TEXT NOT NULL,
    sender_authorized_by_principal_id TEXT,
    sender_principal_kind TEXT NOT NULL,
    sender_display_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    addressed_at TEXT,
    PRIMARY KEY (installation_id, id)
  )`,
  `CREATE TABLE installation_members (
    installation_id TEXT NOT NULL,
    id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (installation_id, id)
  )`,
  `CREATE TABLE managed_api_keys (
    installation_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    authorized_by_principal_id TEXT,
    rotated_from_id TEXT,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    PRIMARY KEY (installation_id, id)
  )`,
];
