/** The invites table for SQLite and D1; identical rules on Postgres. */
export const sqliteInvitesTableSql = `
  CREATE TABLE IF NOT EXISTS installation_invites (
    installation_id TEXT NOT NULL,
    id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('person', 'link')),
    email TEXT,
    role TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
    max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 100),
    use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0 AND use_count <= max_uses),
    secret_digest TEXT NOT NULL,
    token_prefix TEXT NOT NULL,
    opens_project_id TEXT,
    opens_artifact_id TEXT,
    opens_version_id TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by_principal_id TEXT NOT NULL,
    revoked_at TEXT,
    revoked_by_principal_id TEXT,
    last_redeemed_member_id TEXT,
    PRIMARY KEY (installation_id, id),
    CHECK ((kind = 'person' AND email IS NOT NULL) OR (kind = 'link' AND email IS NULL)),
    CHECK (kind = 'person' OR role = 'member'),
    CHECK (kind = 'link' OR max_uses = 1),
    CHECK (
      (opens_project_id IS NULL AND opens_artifact_id IS NULL AND opens_version_id IS NULL)
      OR (opens_project_id IS NOT NULL AND opens_artifact_id IS NOT NULL AND opens_version_id IS NOT NULL)
    ),
    CHECK ((revoked_at IS NULL) = (revoked_by_principal_id IS NULL))
  )`;

export const sqliteInvitesIndexSql = `
  CREATE INDEX IF NOT EXISTS installation_invites_created
    ON installation_invites (installation_id, created_at DESC, id DESC)`;

/** Admission methods every backend's CHECK accepts. */
export const admissionMethodCheckSql =
  "admission_method IS NULL OR admission_method IN ('manual', 'automatic', 'owner', 'invite')";

/** Whether a stored installation_members CREATE statement already accepts `invite`. */
export function membersAcceptInviteAdmission(tableSql: string): boolean {
  return tableSql.includes("'invite'");
}

const memberColumns = `id, installation_id, email, display_name, role, status,
  created_at, updated_at, last_active_at, admitted_by_principal_id, admission_method`;

/** The installation_members rebuild for SQLite; the caller turns foreign keys off. */
export const sqliteMemberAdmissionWidenStatements: readonly string[] = [
  "DROP TABLE IF EXISTS installation_members_next",
  `CREATE TABLE installation_members_next (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
    status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_active_at TEXT,
    admitted_by_principal_id TEXT,
    admission_method TEXT CHECK (${admissionMethodCheckSql}),
    UNIQUE (installation_id, email)
  )`,
  `INSERT INTO installation_members_next (${memberColumns})
    SELECT ${memberColumns} FROM installation_members`,
  "DROP TABLE installation_members",
  "ALTER TABLE installation_members_next RENAME TO installation_members",
];

/**
 * The same rebuild for D1, which cannot turn foreign keys off: snapshot the
 * rows, rebuild empty, and re-insert after the rename so deferred foreign-key
 * checks balance before the batch commits.
 */
export const d1MemberAdmissionWidenStatements: readonly string[] = [
  "PRAGMA defer_foreign_keys = ON",
  "DROP TABLE IF EXISTS installation_members_snapshot",
  `CREATE TABLE installation_members_snapshot AS SELECT ${memberColumns} FROM installation_members`,
  "DROP TABLE IF EXISTS installation_members_next",
  `CREATE TABLE installation_members_next (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
    status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_active_at TEXT,
    admitted_by_principal_id TEXT,
    admission_method TEXT CHECK (${admissionMethodCheckSql}),
    UNIQUE (installation_id, email)
  )`,
  "DROP TABLE installation_members",
  "ALTER TABLE installation_members_next RENAME TO installation_members",
  `INSERT INTO installation_members (${memberColumns})
    SELECT ${memberColumns} FROM installation_members_snapshot`,
  "DROP TABLE installation_members_snapshot",
];
