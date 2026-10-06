import {revertInstallationActivityLogStatements} from "./postgres-activity-log.js";

/**
 * Statements that return a populated current Postgres database to the schema-1
 * (pre-project) shape, so a test can upgrade a realistic legacy installation.
 * They keep every schema-1 row (installations, artifacts, versions, manifests,
 * tags, idempotency records, and artifact actions) and remove only the later
 * structures. The final statement forgets every migration after schema 1.
 */
export const revertToPreProjectPostgresStatements: readonly string[] = [
  ...revertInstallationActivityLogStatements,
  `ALTER TABLE actions
    DROP CONSTRAINT actions_action_check,
    ADD CONSTRAINT actions_action_check
      CHECK (action IN ('publish', 'restore', 'change_access', 'change_tags', 'delete'))`,
  `ALTER TABLE idempotency_records
    DROP CONSTRAINT idempotency_records_operation_check,
    ADD CONSTRAINT idempotency_records_operation_check
      CHECK (operation IN ('publish', 'restore', 'change_access', 'change_tags', 'delete'))`,
  `ALTER TABLE versions
    DROP CONSTRAINT versions_routing_mode_check,
    ADD CONSTRAINT versions_routing_mode_check
      CHECK (routing_mode = 'static')`,
  `ALTER TABLE staged_uploads
    DROP CONSTRAINT staged_uploads_routing_mode_check,
    ADD CONSTRAINT staged_uploads_routing_mode_check
      CHECK (routing_mode = 'static')`,
  "DROP INDEX staged_uploads_idempotency",
  "ALTER TABLE staged_uploads DROP COLUMN idempotency_key",
  "ALTER TABLE content_sessions DROP COLUMN project_id CASCADE",
  "ALTER TABLE content_bootstraps DROP COLUMN project_id CASCADE",
  "ALTER TABLE staged_uploads DROP COLUMN project_id CASCADE",
  "ALTER TABLE actions DROP COLUMN project_id CASCADE",
  "ALTER TABLE idempotency_records DROP COLUMN project_id CASCADE",
  "ALTER TABLE versions DROP COLUMN project_id CASCADE",
  "ALTER TABLE artifacts DROP COLUMN search_name",
  "ALTER TABLE artifacts DROP COLUMN comment_revision",
  "ALTER TABLE artifacts DROP COLUMN project_id CASCADE",
  "ALTER TABLE login_attempts DROP COLUMN nonce",
  "DROP TABLE prepared_manifest_entries",
  "DROP TABLE comment_replies",
  "DROP TABLE comment_threads",
  "DROP TABLE agent_dispatches",
  "DROP TABLE registered_agents",
  "DROP TABLE git_history_budget_reservations",
  "DROP TABLE git_history_mappings",
  "DROP TABLE git_history_jobs",
  "DROP TABLE git_history_repositories",
  "DROP TABLE git_history_provider_identity",
  "DROP TABLE git_history_project_settings",
  "DROP TABLE projects",
  `ALTER TABLE artifacts ADD CONSTRAINT artifacts_current_version_fk
    FOREIGN KEY (installation_id, current_version_id)
    REFERENCES versions(installation_id, id)
    DEFERRABLE INITIALLY DEFERRED`,
  "ALTER TABLE idempotency_records ADD CONSTRAINT idempotency_records_pkey PRIMARY KEY (installation_id, idempotency_key)",
  "ALTER TABLE actions ADD CONSTRAINT actions_installation_id_idempotency_key_key UNIQUE (installation_id, idempotency_key)",
  "CREATE INDEX versions_artifact_id ON versions (installation_id, artifact_id, number)",
  "CREATE INDEX artifacts_active_created ON artifacts (installation_id, deleted_at, created_at DESC, id DESC)",
  "CREATE INDEX actions_artifact_created ON actions (installation_id, artifact_id, created_at DESC, id DESC)",
  "DELETE FROM artifact_server_postgres_migrations WHERE migration_id >= 2",
];
