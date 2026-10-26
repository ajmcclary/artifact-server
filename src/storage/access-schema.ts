/** SQLite and D1 project columns for ADR 0033, each added when missing. */
export const sqliteProjectAccessColumns = [
  {
    column: "access_mode",
    sql: `ALTER TABLE projects ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'open'
      CHECK (access_mode IN ('open', 'restricted'))`,
  },
  {
    column: "default_member_role",
    sql: `ALTER TABLE projects ADD COLUMN default_member_role TEXT NOT NULL DEFAULT 'editor'
      CHECK (default_member_role IN ('none', 'viewer', 'commenter', 'editor', 'manager'))`,
  },
  {
    column: "access_revision",
    sql: "ALTER TABLE projects ADD COLUMN access_revision INTEGER NOT NULL DEFAULT 0 CHECK (access_revision >= 0)",
  },
] as const;

/** SQLite and D1 key column; an empty list means the key reaches every project. */
export const sqliteKeyProjectScopeColumnSql =
  "ALTER TABLE managed_api_keys ADD COLUMN project_ids_json TEXT NOT NULL DEFAULT '[]'";

/** SQLite and D1 policy and grant tables; identical rules on Postgres. */
export const sqliteAccessTableStatements = [
  `CREATE TABLE IF NOT EXISTS installation_access_policy (
    installation_id TEXT PRIMARY KEY,
    policy_json TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_at TEXT NOT NULL,
    updated_by_principal_id TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS access_grants (
    installation_id TEXT NOT NULL,
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    artifact_id TEXT,
    member_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('none', 'viewer', 'commenter', 'editor', 'manager')),
    add_permissions_json TEXT NOT NULL DEFAULT '[]',
    remove_permissions_json TEXT NOT NULL DEFAULT '[]',
    expires_at TEXT,
    created_at TEXT NOT NULL,
    created_by_principal_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    PRIMARY KEY (installation_id, id),
    CHECK (artifact_id IS NULL OR role <> 'none')
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS access_grants_subject
    ON access_grants (installation_id, project_id, COALESCE(artifact_id, ''), member_id)`,
  `CREATE INDEX IF NOT EXISTS access_grants_member
    ON access_grants (installation_id, member_id)`,
] as const;
