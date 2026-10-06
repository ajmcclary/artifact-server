import {createHash} from "node:crypto";
import {rename, rm} from "node:fs/promises";
import {request} from "node:http";
import path from "node:path";
import {DatabaseSync, type SQLOutputValue} from "node:sqlite";

import {z} from "zod";

/** Application name the migration worker's Postgres connection reports. */
export const projectMigrationWorkerApplicationName = "prj-004-migration-worker";

/** The compact database file inside one local data directory. */
export function compactDatabasePath(dataDirectory: string): string {
  return path.join(dataDirectory, "artifact-server.db");
}

/**
 * The schema-1 compact database: artifacts, versions, manifests, tags,
 * idempotency records, and actions with no project scope at all.
 */
const preProjectSqliteSchema = `
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    access_setting TEXT NOT NULL CHECK (access_setting IN ('account_required', 'public_link')),
    current_version_id TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  ) STRICT;
  CREATE TABLE versions (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    number INTEGER NOT NULL CHECK (number > 0),
    manifest_digest TEXT NOT NULL,
    entry_path TEXT NOT NULL,
    routing_mode TEXT NOT NULL CHECK (routing_mode = 'static'),
    content_token TEXT NOT NULL UNIQUE,
    publisher_principal_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (artifact_id, number)
  ) STRICT;
  CREATE TABLE manifest_entries (
    version_id TEXT NOT NULL REFERENCES versions(id),
    path TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0),
    media_type TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN ('inline', 'attachment')),
    PRIMARY KEY (version_id, path)
  ) STRICT;
  CREATE TABLE artifact_tags (
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    tag TEXT NOT NULL,
    PRIMARY KEY (artifact_id, tag)
  ) STRICT;
  CREATE TABLE idempotency_records (
    idempotency_key TEXT PRIMARY KEY,
    input_digest TEXT NOT NULL,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    version_id TEXT NOT NULL REFERENCES versions(id),
    operation TEXT NOT NULL DEFAULT 'publish'
      CHECK (operation IN ('publish', 'restore', 'change_access', 'change_tags', 'delete')),
    access_setting TEXT
      CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link')),
    tags_json TEXT,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE actions (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    version_id TEXT NOT NULL REFERENCES versions(id),
    action TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    authorized_by_principal_id TEXT,
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  PRAGMA user_version = 1;
`;

/** Installation-level identity tables that predate projects and never carry project scope. */
const installationIdentityTables = [
  "installation_members",
  "external_identities",
  "application_sessions",
  "managed_api_keys",
  "login_attempts",
] as const;

const tableSqlSchema = z.object({name: z.string(), sql: z.string()});

/**
 * Rewrite a stopped compact installation into the schema-1 (pre-project)
 * shape. Every schema-1 row and every installation identity row is copied
 * unchanged; blobs and other data-directory files are left untouched.
 */
export async function downgradeCompactToPreProject(dataDirectory: string): Promise<void> {
  const databasePath = compactDatabasePath(dataDirectory);
  const legacyPath = path.join(dataDirectory, "artifact-server.pre-project.db");
  const current = new DatabaseSync(databasePath);
  let identityTables: ReadonlyArray<z.infer<typeof tableSqlSchema>>;
  try {
    current.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    identityTables = z.array(tableSqlSchema).parse(current.prepare(`
      SELECT name, sql FROM sqlite_schema
      WHERE type = 'table' AND name IN (${installationIdentityTables.map(() => "?").join(", ")})
    `).all(...installationIdentityTables));
  } finally {
    current.close();
  }

  const legacy = new DatabaseSync(legacyPath);
  try {
    legacy.exec("PRAGMA journal_mode = WAL;");
    legacy.exec(preProjectSqliteSchema);
    for (const table of identityTables) legacy.exec(table.sql);
    legacy.prepare("ATTACH DATABASE ? AS current").run(databasePath);
    legacy.exec(`
      BEGIN IMMEDIATE;
      INSERT INTO main.artifacts
        SELECT id, name, access_setting, current_version_id, created_at, deleted_at
        FROM current.artifacts;
      INSERT INTO main.versions
        SELECT id, artifact_id, number, manifest_digest, entry_path, routing_mode,
          content_token, publisher_principal_id, created_at
        FROM current.versions;
      INSERT INTO main.manifest_entries
        SELECT version_id, path, size, media_type, sha256, disposition
        FROM current.manifest_entries;
      INSERT INTO main.artifact_tags SELECT artifact_id, tag FROM current.artifact_tags;
      INSERT INTO main.idempotency_records
        SELECT idempotency_key, input_digest, artifact_id, version_id, operation,
          access_setting, tags_json, created_at
        FROM current.idempotency_records;
      INSERT INTO main.actions
        SELECT id, artifact_id, version_id, action, principal_id,
          authorized_by_principal_id, idempotency_key, created_at
        FROM current.actions
        WHERE artifact_id IS NOT NULL
          AND action IN ('publish', 'restore', 'change_access', 'change_tags', 'delete');
      ${identityTables.map((table) =>
        `INSERT INTO main.${table.name} SELECT * FROM current.${table.name};`
      ).join("\n")}
      COMMIT;
      DETACH DATABASE current;
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
  } finally {
    legacy.close();
  }
  await Promise.all(["", "-wal", "-shm"].map((suffix) =>
    rm(`${databasePath}${suffix}`, {force: true})
  ));
  await rm(`${legacyPath}-wal`, {force: true});
  await rm(`${legacyPath}-shm`, {force: true});
  await rename(legacyPath, databasePath);
}

/** Every stored row of one installation identity table. */
export interface IdentityTableRows {
  readonly rows: ReadonlyArray<Readonly<Record<string, SQLOutputValue>>>;
  readonly table: string;
}

/** Read every row of the installation identity tables, in a stable order. */
export function readCompactInstallationIdentity(
  dataDirectory: string,
): readonly IdentityTableRows[] {
  const database = new DatabaseSync(compactDatabasePath(dataDirectory), {readOnly: true});
  try {
    const present = new Set(z.array(z.object({name: z.string()})).parse(
      database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all(),
    ).map((row) => row.name));
    return installationIdentityTables
      .filter((table) => present.has(table))
      .map((table) => ({
        rows: database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        table,
      }));
  } finally {
    database.close();
  }
}

/** One authenticated Artifact Server installation reached over HTTP. */
export interface InstallationEndpoint {
  readonly baseUrl: string;
  readonly token: string;
}

interface FixtureFile {
  readonly content: string;
  readonly mediaType: string;
  readonly path: string;
}

const uploadPlanSchema = z.object({
  commitUrl: z.url(),
  files: z.array(z.object({path: z.string(), uploadUrl: z.url()})),
});

const committedSchema = z.object({
  artifact: z.object({currentVersionId: z.string(), id: z.string()}),
  version: z.object({id: z.string()}),
});

const stateSchema = z.object({
  artifact: z.object({currentVersionId: z.string(), id: z.string()}),
});

/**
 * Publish a small but varied set of artifacts through the real HTTP API:
 * multi-file and single-file versions, a restore, tag and access changes,
 * and both access settings. Returns the artifact IDs in publication order.
 */
export async function populateMigrationFixture(
  endpoint: InstallationEndpoint,
  label: string,
): Promise<readonly string[]> {
  const report = {
    content: JSON.stringify({label, rows: [1, 2, 3]}),
    mediaType: "application/json",
    path: "data/report.json",
  };
  const release = await publish(endpoint, `${label}-release-v1`, [
    {content: `<!doctype html><title>${label} release one</title>`, mediaType: "text/html; charset=utf-8", path: "index.html"},
    report,
  ], {
    accessSetting: "public_link",
    kind: "new_artifact",
    name: `Release notes ${label}`,
    tags: ["migrated", "alpha"],
  });
  const second = await publish(endpoint, `${label}-release-v2`, [
    {content: `<!doctype html><title>${label} release two</title>`, mediaType: "text/html; charset=utf-8", path: "index.html"},
    report,
  ], {
    artifactId: release.artifact.id,
    expectedCurrentVersionId: release.version.id,
    kind: "new_version",
  });
  const restored = await mutate(endpoint, `/api/v1/artifacts/${release.artifact.id}/restore`, "POST", `${label}-release-restore`, {
    expectedCurrentVersionId: second.version.id,
    versionId: release.version.id,
  });
  await mutate(endpoint, `/api/v1/artifacts/${release.artifact.id}/tags`, "PATCH", `${label}-release-tags`, {
    expectedCurrentVersionId: restored.artifact.currentVersionId,
    tags: ["alpha", "migrated", "release"],
  });

  const plan = await publish(endpoint, `${label}-plan`, [
    {content: `# ${label} private plan\n`, mediaType: "text/markdown; charset=utf-8", path: "plan.md"},
  ], {
    accessSetting: "account_required",
    kind: "new_artifact",
    name: `Private plan ${label}`,
    tags: ["private"],
  });

  const toggled = await publish(endpoint, `${label}-toggle`, [
    {content: `<!doctype html><title>${label} toggled</title>`, mediaType: "text/html; charset=utf-8", path: "index.html"},
  ], {
    accessSetting: "public_link",
    kind: "new_artifact",
    name: `Toggled access ${label}`,
    tags: [],
  });
  await mutate(endpoint, `/api/v1/artifacts/${toggled.artifact.id}/access`, "PATCH", `${label}-toggle-access`, {
    accessSetting: "account_required",
    expectedCurrentVersionId: toggled.version.id,
  });
  return [release.artifact.id, plan.artifact.id, toggled.artifact.id];
}

/** The commit target the staged-upload API accepts. */
type CommitTarget =
  | {
    readonly accessSetting: "account_required" | "public_link";
    readonly kind: "new_artifact";
    readonly name: string;
    readonly tags: readonly string[];
  }
  | {
    readonly artifactId: string;
    readonly expectedCurrentVersionId: string;
    readonly kind: "new_version";
  };

/** One management mutation body guarded by the expected current version. */
interface MutationBody {
  readonly accessSetting?: "account_required" | "public_link";
  readonly expectedCurrentVersionId: string;
  readonly tags?: readonly string[];
  readonly versionId?: string;
}

async function publish(
  endpoint: InstallationEndpoint,
  idempotencyKey: string,
  files: readonly FixtureFile[],
  target: CommitTarget,
): Promise<z.infer<typeof committedSchema>> {
  const encoded = files.map((file) => ({...file, bytes: new TextEncoder().encode(file.content)}));
  const created = await fetch(new URL("/api/v1/uploads", endpoint.baseUrl), {
    body: JSON.stringify({
      entryPath: encoded[0]?.path,
      files: encoded.map((file) => ({
        mediaType: file.mediaType,
        path: file.path,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
        size: file.bytes.byteLength,
      })),
    }),
    headers: jsonHeaders(endpoint.token),
    method: "POST",
  });
  const plan = await requireOk(created, "upload plan", uploadPlanSchema);
  await Promise.all(plan.files.map(async (planned) => {
    const file = encoded.find((candidate) => candidate.path === planned.path);
    if (file === undefined) throw new Error(`The fixture has no ${planned.path}.`);
    const uploaded = await fetch(planned.uploadUrl, {
      body: file.bytes,
      headers: {Authorization: `Bearer ${endpoint.token}`},
      method: "PUT",
    });
    if (!uploaded.ok) {
      throw new Error(`Fixture upload of ${planned.path} failed with HTTP ${uploaded.status}.`);
    }
  }));
  const committed = await fetch(plan.commitUrl, {
    body: JSON.stringify({target}),
    headers: {...jsonHeaders(endpoint.token), "Idempotency-Key": idempotencyKey},
    method: "POST",
  });
  return requireOk(committed, "commit", committedSchema);
}

async function mutate(
  endpoint: InstallationEndpoint,
  pathname: string,
  method: "PATCH" | "POST",
  idempotencyKey: string,
  body: MutationBody,
): Promise<z.infer<typeof stateSchema>> {
  const response = await fetch(new URL(pathname, endpoint.baseUrl), {
    body: JSON.stringify(body),
    headers: {...jsonHeaders(endpoint.token), "Idempotency-Key": idempotencyKey},
    method,
  });
  return requireOk(response, `${method} ${pathname}`, stateSchema);
}

function jsonHeaders(token: string) {
  return {Authorization: `Bearer ${token}`, "Content-Type": "application/json"};
}

async function requireOk<Schema extends z.ZodType>(
  response: Response,
  step: string,
  schema: Schema,
): Promise<z.infer<Schema>> {
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`Fixture ${step} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return schema.parse(body);
}

const manifestEntrySchema = z.object({
  disposition: z.string(),
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: z.number(),
});

const versionRecordSchema = z.object({
  artifactId: z.string(),
  contentToken: z.string(),
  createdAt: z.string(),
  entryPath: z.string(),
  id: z.string(),
  manifestDigest: z.string(),
  number: z.number(),
  projectId: z.string(),
  publisherPrincipalId: z.string(),
  routingMode: z.string(),
});

const versionLinksSchema = z.object({review: z.url(), version: z.url()});

const artifactDetailsSchema = z.object({
  artifact: z.object({
    accessSetting: z.string(),
    createdAt: z.string(),
    currentVersionId: z.string(),
    deletedAt: z.string().nullable(),
    id: z.string(),
    name: z.string(),
    projectId: z.string(),
    tags: z.array(z.string()),
  }),
  links: z.object({artifact: z.url()}),
});

const versionListSchema = z.object({
  versions: z.array(z.object({links: versionLinksSchema, version: versionRecordSchema})),
});

const versionDetailsSchema = z.object({
  manifest: z.object({
    digest: z.string(),
    entries: z.array(manifestEntrySchema),
    entryPath: z.string(),
    routingMode: z.string(),
  }),
});

/** Only the action fields a schema-1 database stored; later fields are derived. */
const actionSchema = z.object({
  action: z.string(),
  artifactId: z.string(),
  authorizedByPrincipalId: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  idempotencyKey: z.string(),
  principalId: z.string(),
  projectId: z.string(),
  versionId: z.string(),
});

const projectListSchema = z.object({
  projects: z.array(z.object({
    archivedAt: z.string().nullable(),
    id: z.string(),
    name: z.string(),
  })),
});

const artifactPageSchema = z.object({
  artifacts: z.array(z.object({artifact: z.object({id: z.string()})})),
});

/** Every externally observable value of the named artifacts, made host-independent. */
export async function snapshotInstallation(
  endpoint: InstallationEndpoint,
  artifactIds: readonly string[],
) {
  const [projects, artifacts] = await Promise.all([
    readJson(endpoint, "/api/v1/projects", projectListSchema),
    Promise.all(artifactIds.map((artifactId) => snapshotArtifact(endpoint, artifactId))),
  ]);
  return {artifacts, projects: projects.projects};
}

/** The host-independent installation snapshot type. */
export type InstallationSnapshot = Awaited<ReturnType<typeof snapshotInstallation>>;

async function snapshotArtifact(endpoint: InstallationEndpoint, artifactId: string) {
  const [details, listed, actions] = await Promise.all([
    readJson(endpoint, `/api/v1/artifacts/${artifactId}`, artifactDetailsSchema),
    readJson(endpoint, `/api/v1/artifacts/${artifactId}/versions`, versionListSchema),
    readJson(
      endpoint,
      `/api/v1/artifacts/${artifactId}/actions?limit=100`,
      z.object({actions: z.array(actionSchema)}),
    ),
  ]);
  const current = listed.versions.find((entry) =>
    entry.version.id === details.artifact.currentVersionId
  );
  if (current === undefined) throw new Error(`${artifactId} has no current version.`);
  const [versions, searched, anonymousApi, anonymousContent] = await Promise.all([
    Promise.all(listed.versions.map((entry) => snapshotVersion(endpoint, entry))),
    readJson(
      endpoint,
      `/api/v1/artifacts?${new URLSearchParams({
        limit: "100",
        search: details.artifact.name,
      }).toString()}`,
      artifactPageSchema,
    ),
    fetch(new URL(`/api/v1/artifacts/${artifactId}`, endpoint.baseUrl))
      .then((response) => response.status),
    fetchContentThroughServer(endpoint.baseUrl, current.links.version)
      .then((response) => response.status),
  ]);
  return {
    access: {anonymousApi, anonymousContent},
    actions: actions.actions.toSorted((left, right) => left.id.localeCompare(right.id)),
    artifact: {...details.artifact, tags: details.artifact.tags.toSorted()},
    link: new URL(details.links.artifact).pathname,
    searchable: searched.artifacts.some((item) => item.artifact.id === artifactId),
    versions: versions.toSorted((left, right) => left.version.number - right.version.number),
  };
}

async function snapshotVersion(
  endpoint: InstallationEndpoint,
  entry: z.infer<typeof versionListSchema>["versions"][number],
) {
  const {manifest} = await readJson(
    endpoint,
    `/api/v1/artifacts/${entry.version.artifactId}/versions/${entry.version.id}`,
    versionDetailsSchema,
  );
  const fileDigests = await Promise.all(manifest.entries.map(async (file) => {
    const response = await fetch(new URL(
      `/api/v1/artifacts/${entry.version.artifactId}/versions/${entry.version.id}/file?` +
        new URLSearchParams({path: file.path}).toString(),
      endpoint.baseUrl,
    ), {headers: {Authorization: `Bearer ${endpoint.token}`}});
    if (response.status !== 200) {
      throw new Error(`Reading ${file.path} returned HTTP ${response.status}.`);
    }
    const digest = createHash("sha256")
      .update(new Uint8Array(await response.arrayBuffer()))
      .digest("hex");
    return [file.path, digest] as const;
  }));
  const review = new URL(entry.links.review);
  return {
    files: new Map(fileDigests),
    links: {
      review: `${review.pathname}${review.search}`,
      version: new URL(entry.links.version).hostname.split(".")[0],
    },
    manifest,
    version: entry.version,
  };
}

async function readJson<Schema extends z.ZodType>(
  endpoint: InstallationEndpoint,
  pathname: string,
  schema: Schema,
): Promise<z.infer<Schema>> {
  const response = await fetch(new URL(pathname, endpoint.baseUrl), {
    headers: {Authorization: `Bearer ${endpoint.token}`},
  });
  const body: unknown = await response.json();
  if (response.status !== 200) {
    throw new Error(`GET ${pathname} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return schema.parse(body);
}

/** Request a content-host URL from the server that answers for that host. */
export function fetchContentThroughServer(
  baseUrl: string,
  contentUrl: string,
): Promise<Response> {
  const server = new URL(baseUrl);
  const target = new URL(contentUrl);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        headers: {Host: target.host},
        hostname: server.hostname,
        path: `${target.pathname}${target.search}`,
        port: server.port,
      },
      (incoming) => {
        const chunks: Uint8Array[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          const status = incoming.statusCode ?? 500;
          resolve(new Response(
            status === 204 || status === 304 ? null : Buffer.concat(chunks),
            {status},
          ));
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}
