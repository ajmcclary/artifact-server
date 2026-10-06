import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {randomUUID, createHash} from "node:crypto";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {CreateBucketCommand, S3Client} from "@aws-sdk/client-s3";
import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterAll, afterEach, beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";

import {defaultProjectId} from "../../src/core/model.js";
import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {startExternalStorageServer} from
  "../../src/external-storage/start-external-storage-server.js";
import {createOidcIdentityProvider} from
  "../../src/identity/oidc-identity-provider.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";
import {requiredPostgresSchemaVersion} from "../../src/storage/postgres-migrations.js";
import {createS3ObjectStorageProviderFactory} from
  "../../src/storage/s3-object-storage.js";
import {
  readSqliteMigrationStatus,
  requiredSqliteSchemaVersion,
} from "../../src/storage/sqlite-schema.js";
import {revertToPreProjectPostgresStatements} from
  "../support/postgres-project-migration.js";
import {
  compactDatabasePath,
  downgradeCompactToPreProject,
  type InstallationEndpoint,
  type InstallationSnapshot,
  populateMigrationFixture,
  projectMigrationWorkerApplicationName,
  readCompactInstallationIdentity,
  snapshotInstallation,
} from "../support/project-migration.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  type RunningStubOidcProvider,
  startStubOidcProvider,
} from "../support/stub-oidc-provider.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const migrationWorker = path.join(repositoryRoot, "tests/support/project-migration-worker.ts");
const region = "us-east-1";
const bucket = "artifact-server-prj-004-project-migration";
const oidcClientId = "prj-004-project-migration";

interface ProviderEnvironment {
  readonly accessKey: string;
  readonly databaseUrl: string;
  readonly endpoint: string;
  readonly postgresContainer: string;
  readonly postgresUser: string;
  readonly secretKey: string;
}

interface PostgresInstallation {
  readonly apiToken: string;
  readonly artifactIds: readonly string[];
  readonly before: InstallationSnapshot;
  readonly installationId: string;
}

interface PopulatedPostgres {
  readonly databaseUrl: string;
  readonly installationRows: readonly unknown[];
  readonly installations: readonly PostgresInstallation[];
}

const countRowSchema = z.array(z.object({n: z.number()}));

describe.sequential("PRJ-004 project migration on SQLite and Postgres", () => {
  let environment: ProviderEnvironment;
  let oidcProvider: RunningStubOidcProvider;
  let s3Client: S3Client;
  const localInstallations: TestInstallation[] = [];
  const localServers = new Set<RunningTestServer>();
  const externalServers = new Set<{stop(): Promise<void>}>();
  const workers = new Set<ChildProcessWithoutNullStreams>();

  beforeAll(async () => {
    environment = readProviderEnvironment();
    oidcProvider = await startStubOidcProvider({clientId: oidcClientId});
    s3Client = new S3Client({
      credentials: {
        accessKeyId: environment.accessKey,
        secretAccessKey: environment.secretKey,
      },
      endpoint: environment.endpoint,
      forcePathStyle: true,
      region,
    });
    await s3Client.send(new CreateBucketCommand({Bucket: bucket}));
  });

  afterEach(async () => {
    for (const worker of workers) {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    }
    workers.clear();
    await Promise.all([...localServers].map((server) => server.stop()));
    localServers.clear();
    await Promise.all([...externalServers].map((server) => server.stop()));
    externalServers.clear();
    await Promise.all(localInstallations.splice(0).map(removeTestInstallation));
  });

  afterAll(async () => {
    s3Client.destroy();
    await oidcProvider.stop();
  });

  test("PRJ-004-B: populated SQLite and Postgres installations upgrade into one default project with every installation, artifact, version, manifest, content, action, visibility, tag, and link value preserved", {timeout: 180_000}, async () => {
    const compact = await populatedCompactInstallation("compact-upgrade");
    const databasePath = compactDatabasePath(compact.installation.dataDirectory);
    expect(readSqliteMigrationStatus(databasePath)).toMatchObject({
      compatibility: "pending",
      currentVersion: 1,
    });
    expect(compactTableExists(databasePath, "projects")).toBe(false);

    const upgraded = await startLocal(compact.installation);
    const compactAfter = await snapshotInstallation(
      localEndpoint(upgraded, compact.installation),
      compact.artifactIds,
    );
    expect(compactAfter).toEqual(compact.before);
    expectDefaultProjectScope(compactAfter);
    expectPreservedAccess(compactAfter);
    expect(readCompactInstallationIdentity(compact.installation.dataDirectory))
      .toEqual(compact.identity);
    expect(readSqliteMigrationStatus(databasePath)).toMatchObject({
      compatibility: "current",
      currentVersion: requiredSqliteSchemaVersion,
    });
    expect(compactProjects(databasePath)).toEqual([
      {id: defaultProjectId, installation_id: "local", name: "Default"},
    ]);
    expect(compactOrphanCount(databasePath)).toBe(0);

    const postgres = await populatedPostgres("upgrade");
    expect(await postgresMigrationStatus(postgres.databaseUrl)).toMatchObject({
      compatibility: "pending",
      currentVersion: 1,
    });
    expect(await postgresTableExists(postgres.databaseUrl, "projects")).toBe(false);
    await applyPostgresMigrations(postgres.databaseUrl);
    await expectPostgresPreserved(postgres);
  });

  test("PRJ-004-F: interrupted, repeated, partially applied, and rolled-back migrations keep one default project, every ID, every byte, and the same access on SQLite and Postgres", {timeout: 300_000}, async () => {
    // SQLite interrupted: kill the migrating process right after the project
    // step commits. The schema version must not claim completion, and the
    // next start must finish without losing or reshaping anything.
    const interrupted = await populatedCompactInstallation("compact-interrupted");
    const interruptedPath = compactDatabasePath(interrupted.installation.dataDirectory);
    const bulkIds = addBulkLegacyArtifacts(interruptedPath, 20_000);
    await killSqliteMigrationAfterProjectStep(interruptedPath);
    expect(compactProjects(interruptedPath)).toHaveLength(1);
    expect(readSqliteMigrationStatus(interruptedPath)).toMatchObject({
      compatibility: "pending",
      currentVersion: 1,
    });
    const resumed = await startLocal(interrupted.installation);
    const resumedEndpoint = localEndpoint(resumed, interrupted.installation);
    expect(await snapshotInstallation(resumedEndpoint, interrupted.artifactIds))
      .toEqual(interrupted.before);
    const bulkSample = [bulkIds[0], bulkIds.at(-1)].filter((id) => id !== undefined);
    const bulkSnapshot = await snapshotInstallation(resumedEndpoint, bulkSample);
    expect(bulkSnapshot.artifacts.map((item) => item.artifact.id)).toEqual(bulkSample);
    for (const item of bulkSnapshot.artifacts) {
      expect(item.artifact.projectId).toBe(defaultProjectId);
      expect(item.searchable).toBe(true);
      expect(item.access.anonymousApi).toBe(401);
      expect(item.access.anonymousContent).not.toBe(200);
    }
    await stopLocal(resumed);
    expect(compactArtifactProjects(interruptedPath)).toEqual({
      artifacts: bulkIds.length + interrupted.artifactIds.length,
      defaultProject: bulkIds.length + interrupted.artifactIds.length,
    });
    expect(compactProjects(interruptedPath)).toHaveLength(1);
    expect(compactOrphanCount(interruptedPath)).toBe(0);

    // SQLite rolled back: a legacy row the activity-log step refuses aborts
    // that step's transaction. Retrying cannot duplicate the project, and the
    // version stays pending until an operator repairs the row.
    const rolledBack = await populatedCompactInstallation("compact-rolled-back");
    const rolledBackPath = compactDatabasePath(rolledBack.installation.dataDirectory);
    insertUnknownLegacyAction(rolledBackPath, rolledBack.firstVersion);
    const expectRefusedAndRolledBack = async (): Promise<void> => {
      await expect(startLocal(rolledBack.installation))
        .rejects.toThrow(/installation_activity_log/u);
      expect(readSqliteMigrationStatus(rolledBackPath)).toMatchObject({
        compatibility: "pending",
        currentVersion: 1,
      });
      expect(compactProjects(rolledBackPath)).toHaveLength(1);
      expect(compactActionColumns(rolledBackPath)).not.toContain("subject_id");
      expect(compactActionCount(rolledBackPath, "legacy_unknown_kind")).toBe(1);
    };
    await expectRefusedAndRolledBack();
    await expectRefusedAndRolledBack();
    removeUnknownLegacyAction(rolledBackPath);
    const repaired = await startLocal(rolledBack.installation);
    expect(await snapshotInstallation(
      localEndpoint(repaired, rolledBack.installation),
      rolledBack.artifactIds,
    )).toEqual(rolledBack.before);
    await stopLocal(repaired);
    expect(compactProjects(rolledBackPath)).toHaveLength(1);
    expect(compactOrphanCount(rolledBackPath)).toBe(0);

    // SQLite partially applied, then repeated: an older build left the
    // projects table and two project columns behind. The upgrade completes,
    // and repeated starts change nothing.
    const partial = await populatedCompactInstallation("compact-partial");
    const partialPath = compactDatabasePath(partial.installation.dataDirectory);
    applyPartialProjectScope(partialPath);
    const expectPartialCompleted = async (): Promise<void> => {
      const started = await startLocal(partial.installation);
      expect(await snapshotInstallation(
        localEndpoint(started, partial.installation),
        partial.artifactIds,
      )).toEqual(partial.before);
      await stopLocal(started);
      expect(compactProjects(partialPath)).toEqual([
        {id: defaultProjectId, installation_id: "local", name: "Default"},
      ]);
      expect(compactOrphanCount(partialPath)).toBe(0);
    };
    await expectPartialCompleted();
    await expectPartialCompleted();

    // Postgres interrupted: the migrating process dies while its single
    // transaction waits on a table lock after creating the projects table.
    const killed = await populatedPostgres("interrupted");
    await killPostgresMigrationMidTransaction(killed.databaseUrl);
    await expectPostgresUntouched(killed.databaseUrl);
    await applyPostgresMigrations(killed.databaseUrl);
    await expectPostgresPreserved(killed);

    // Postgres rolled back: a later migration fails, so the whole upgrade,
    // including the project step, rolls back to the exact schema-1 state.
    const failed = await populatedPostgres("rolled-back");
    await runPostgres(failed.databaseUrl, [
      "CREATE INDEX actions_installation_idempotency ON actions (installation_id)",
    ]);
    await expect(applyPostgresMigrations(failed.databaseUrl))
      .rejects.toThrow(/Migration "18_installation_activity_log" failed/u);
    await expectPostgresUntouched(failed.databaseUrl);
    await runPostgres(failed.databaseUrl, ["DROP INDEX actions_installation_idempotency"]);
    await applyPostgresMigrations(failed.databaseUrl);
    await expectPostgresPreserved(failed);

    // Postgres repeated: concurrent processes and a later re-run serialize
    // under the advisory lock and apply each migration exactly once.
    const repeated = await populatedPostgres("repeated");
    const worker = spawnMigrationWorker("postgres", repeated.databaseUrl);
    await Promise.all([
      applyPostgresMigrations(repeated.databaseUrl),
      applyPostgresMigrations(repeated.databaseUrl),
      expect(workerExit(worker)).resolves.toEqual({code: 0, signal: null}),
    ]);
    await applyPostgresMigrations(repeated.databaseUrl);
    expect(await postgresMigrationHistory(repeated.databaseUrl)).toEqual(
      Array.from({length: requiredPostgresSchemaVersion}, (_, index) => index + 1),
    );
    await expectPostgresPreserved(repeated);
  });

  async function populatedCompactInstallation(label: string) {
    const installation = await createTestInstallation();
    localInstallations.push(installation);
    const server = await startLocal(installation);
    const endpoint = localEndpoint(server, installation);
    const artifactIds = await populateMigrationFixture(endpoint, label);
    const before = await snapshotInstallation(endpoint, artifactIds);
    expectDefaultProjectScope(before);
    expectPreservedAccess(before);
    await stopLocal(server);
    const identity = readCompactInstallationIdentity(installation.dataDirectory);
    await downgradeCompactToPreProject(installation.dataDirectory);
    const firstArtifact = before.artifacts[0];
    const firstVersion = firstArtifact?.versions[0]?.version;
    if (firstVersion === undefined) throw new Error("The fixture has no version.");
    return {artifactIds, before, firstVersion, identity, installation};
  }

  async function startLocal(installation: TestInstallation): Promise<RunningTestServer> {
    const server = await startTestServer(installation);
    localServers.add(server);
    return server;
  }

  async function stopLocal(server: RunningTestServer): Promise<void> {
    localServers.delete(server);
    await server.stop();
  }

  async function populatedPostgres(label: string): Promise<PopulatedPostgres> {
    const databaseName = `artifactserver_prj004_${label.replaceAll("-", "_")}_${
      randomUUID().replaceAll("-", "")
    }`;
    await runCommand("docker", [
      "exec",
      environment.postgresContainer,
      "createdb",
      "--username",
      environment.postgresUser,
      databaseName,
    ]);
    const target = new URL(environment.databaseUrl);
    target.pathname = `/${databaseName}`;
    const databaseUrl = target.toString();
    await applyPostgresMigrations(databaseUrl);
    const installations = await Promise.all(["first", "second"].map(async (suffix) => {
      const installationId = `prj-004-${label}-${suffix}`;
      const apiToken = managedTestKey(installationId);
      const server = await startExternal(databaseUrl, installationId, apiToken);
      const endpoint = {baseUrl: server.baseUrl, token: apiToken};
      const artifactIds = await populateMigrationFixture(endpoint, `${label}-${suffix}`);
      const before = await snapshotInstallation(endpoint, artifactIds);
      expectDefaultProjectScope(before);
      expectPreservedAccess(before);
      await server.stop();
      return {apiToken, artifactIds, before, installationId} satisfies PostgresInstallation;
    }));
    const installationRows = await readPostgresInstallations(databaseUrl);
    await runPostgres(databaseUrl, revertToPreProjectPostgresStatements);
    return {databaseUrl, installationRows, installations};
  }

  async function expectPostgresPreserved(populated: PopulatedPostgres): Promise<void> {
    expect(await postgresMigrationStatus(populated.databaseUrl)).toMatchObject({
      compatibility: "current",
      currentVersion: requiredPostgresSchemaVersion,
    });
    expect(await readPostgresInstallations(populated.databaseUrl))
      .toEqual(populated.installationRows);
    expect(await postgresProjects(populated.databaseUrl)).toEqual(
      populated.installations.map((installation) => ({
        id: defaultProjectId,
        installation_id: installation.installationId,
        name: "Default",
      })).toSorted((left, right) =>
        left.installation_id.localeCompare(right.installation_id)
      ),
    );
    expect(await postgresOrphanCount(populated.databaseUrl)).toBe(0);
    const servers = await Promise.all(populated.installations.map(async (installation) => {
      const server = await startExternal(
        populated.databaseUrl,
        installation.installationId,
        installation.apiToken,
      );
      const after = await snapshotInstallation(
        {baseUrl: server.baseUrl, token: installation.apiToken},
        installation.artifactIds,
      );
      expect(after).toEqual(installation.before);
      return server;
    }));
    const [first, second] = populated.installations;
    const [firstServer] = servers;
    if (first === undefined || second === undefined || firstServer === undefined) {
      throw new Error("The Postgres fixture needs two installations.");
    }
    const foreignStatuses = await Promise.all(second.artifactIds.map((foreignArtifactId) =>
      fetch(
        new URL(`/api/v1/artifacts/${foreignArtifactId}`, firstServer.baseUrl),
        {headers: {Authorization: `Bearer ${first.apiToken}`}},
      ).then((response) => response.status)
    ));
    expect(foreignStatuses).toEqual(second.artifactIds.map(() => 404));
    await Promise.all(servers.map((server) => server.stop()));
  }

  async function expectPostgresUntouched(databaseUrl: string): Promise<void> {
    expect(await postgresMigrationStatus(databaseUrl)).toMatchObject({
      compatibility: "pending",
      currentVersion: 1,
    });
    expect(await postgresMigrationHistory(databaseUrl)).toEqual([1]);
    expect(await postgresTableExists(databaseUrl, "projects")).toBe(false);
    expect(await postgresColumns(databaseUrl, "artifacts")).not.toContain("project_id");
    expect(await postgresColumns(databaseUrl, "versions")).not.toContain("project_id");
  }

  async function startExternal(
    databaseUrl: string,
    installationId: string,
    apiToken: string,
  ): Promise<{readonly baseUrl: string; stop(): Promise<void>}> {
    const server = await startExternalStorageServer({
      apiToken: Redacted.make(apiToken),
      applicationOrigin: "https://artifacts.example.com",
      bootstrapAdministratorEmail: "administrator@example.test",
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      contentDomain: "content.example.net",
      databaseUrl: Redacted.make(databaseUrl),
      hostname: "127.0.0.1",
      installationId,
      interactiveIdentityProvider: createOidcIdentityProvider({
        applicationOrigin: "https://artifacts.example.com",
        clientId: oidcClientId,
        clientSecret: null,
        issuer: oidcProvider.issuer,
        scopes: "openid email profile",
      }),
      objectStorage: createS3ObjectStorageProviderFactory({
        accessKeyId: environment.accessKey,
        bucket,
        endpoint: environment.endpoint,
        forcePathStyle: true,
        region,
        secretAccessKey: Redacted.make(environment.secretKey),
      }),
      port: 0,
    });
    let stopped = false;
    const running = {
      baseUrl: `http://${server.hostname}:${server.port}`,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        externalServers.delete(running);
        await server.close();
      },
    };
    externalServers.add(running);
    return running;
  }

  function spawnMigrationWorker(
    engine: "postgres" | "sqlite",
    target: string,
  ): ChildProcessWithoutNullStreams {
    const child = spawn(process.execPath, ["--import", "tsx", migrationWorker], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ARTIFACT_SERVER_MIGRATION_ENGINE: engine,
        ARTIFACT_SERVER_MIGRATION_TARGET: target,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.resume();
    child.stderr.resume();
    workers.add(child);
    return child;
  }

  async function killSqliteMigrationAfterProjectStep(databasePath: string): Promise<void> {
    const reader = new DatabaseSync(databasePath, {readOnly: true, timeout: 5_000});
    try {
      const worker = spawnMigrationWorker("sqlite", databasePath);
      const exited = workerExit(worker);
      const deadline = Date.now() + 30_000;
      let killed = false;
      while (!killed && Date.now() < deadline) {
        if (defaultProjectCommitted(reader)) {
          worker.kill("SIGKILL");
          killed = true;
        }
      }
      expect(killed).toBe(true);
      await expect(exited).resolves.toEqual({code: null, signal: "SIGKILL"});
    } finally {
      reader.close();
    }
  }

  async function killPostgresMigrationMidTransaction(databaseUrl: string): Promise<void> {
    const database = await PostgresDatabase.inspect({
      applicationName: "prj-004-lock-holder",
      maxConnections: 2,
      url: Redacted.make(databaseUrl),
    });
    try {
      const release = Promise.withResolvers<void>();
      const lockAcquired = Promise.withResolvers<void>();
      const holder = database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        yield* sql.withTransaction(Effect.gen(function*() {
          yield* sql`LOCK TABLE versions IN ACCESS EXCLUSIVE MODE`;
          yield* Effect.sync(() => lockAcquired.resolve());
          yield* Effect.promise(() => release.promise);
        }));
      }));
      await lockAcquired.promise;
      const worker = spawnMigrationWorker("postgres", databaseUrl);
      const exited = workerExit(worker);
      await expect.poll(
        () => workerBackendState(database),
        {interval: 50, timeout: 30_000},
      ).toBe("Lock");
      worker.kill("SIGKILL");
      await expect(exited).resolves.toEqual({code: null, signal: "SIGKILL"});
      release.resolve();
      await holder;
      await expect.poll(
        () => workerBackendState(database),
        {interval: 50, timeout: 30_000},
      ).toBe("absent");
    } finally {
      await database.close();
    }
  }
});

function readProviderEnvironment(): ProviderEnvironment {
  const accessKey = process.env["ARTIFACT_SERVER_TEST_S3_ACCESS_KEY"];
  const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  const endpoint = process.env["ARTIFACT_SERVER_TEST_S3_ENDPOINT"];
  const postgresContainer = process.env["ARTIFACT_SERVER_TEST_POSTGRES_CONTAINER"];
  const postgresUser = process.env["ARTIFACT_SERVER_TEST_POSTGRES_USER"];
  const secretKey = process.env["ARTIFACT_SERVER_TEST_S3_SECRET_KEY"];
  if (
    accessKey === undefined || databaseUrl === undefined ||
    endpoint === undefined || postgresContainer === undefined ||
    postgresUser === undefined || secretKey === undefined
  ) {
    throw new Error("Run this test through pnpm test:external-storage-runtime.");
  }
  return {accessKey, databaseUrl, endpoint, postgresContainer, postgresUser, secretKey};
}

function managedTestKey(label: string): string {
  const id = createHash("sha256").update(`id:${label}`).digest("hex").slice(0, 32);
  const secret = createHash("sha256").update(`secret:${label}`).digest("base64url");
  return `as_key_key_${id}_${secret}`;
}

function localEndpoint(
  server: RunningTestServer,
  installation: TestInstallation,
): InstallationEndpoint {
  return {baseUrl: server.baseUrl, token: installation.apiToken};
}

function expectDefaultProjectScope(snapshot: InstallationSnapshot): void {
  expect(snapshot.projects).toEqual([
    {archivedAt: null, id: defaultProjectId, name: "Default"},
  ]);
  for (const item of snapshot.artifacts) {
    expect(item.artifact.projectId).toBe(defaultProjectId);
    for (const saved of item.versions) {
      expect(saved.version.projectId).toBe(defaultProjectId);
      for (const entry of saved.manifest.entries) {
        expect(saved.files.get(entry.path)).toBe(entry.sha256);
      }
    }
    for (const action of item.actions) expect(action.projectId).toBe(defaultProjectId);
    expect(item.searchable).toBe(true);
  }
}

function expectPreservedAccess(snapshot: InstallationSnapshot): void {
  expect(snapshot.artifacts.map((item) => item.artifact.accessSetting))
    .toEqual(["public_link", "account_required", "account_required"]);
  expect(snapshot.artifacts.map((item) => ({
    anonymousApi: item.access.anonymousApi,
    anonymousContentServed: item.access.anonymousContent === 200,
  }))).toEqual([
    {anonymousApi: 401, anonymousContentServed: true},
    {anonymousApi: 401, anonymousContentServed: false},
    {anonymousApi: 401, anonymousContentServed: false},
  ]);
  expect(snapshot.artifacts[0]?.actions.map((action) => action.action).toSorted())
    .toEqual(["change_tags", "publish", "publish", "restore"]);
  expect(snapshot.artifacts[2]?.actions.map((action) => action.action).toSorted())
    .toEqual(["change_access", "publish"]);
}

function compactTableExists(databasePath: string, table: string): boolean {
  return withCompactReader(databasePath, (database) =>
    database.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
    ).get(table) !== undefined
  );
}

function compactProjects(databasePath: string): readonly unknown[] {
  return withCompactReader(databasePath, (database) =>
    database.prepare(
      "SELECT id, installation_id, name FROM projects ORDER BY id",
    ).all()
  );
}

function compactOrphanCount(databasePath: string): number {
  return withCompactReader(databasePath, (database) =>
    countRowSchema.parse(database.prepare(`
      SELECT (
        (SELECT count(*) FROM artifacts WHERE project_id NOT IN (SELECT id FROM projects))
        + (SELECT count(*) FROM versions v
            WHERE NOT EXISTS (
              SELECT 1 FROM artifacts a
              WHERE a.id = v.artifact_id AND a.project_id = v.project_id
            ))
        + (SELECT count(*) FROM actions x
            WHERE x.artifact_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM artifacts a
              WHERE a.id = x.artifact_id AND a.project_id = x.project_id
            ))
        + (SELECT count(*) FROM idempotency_records r
            WHERE NOT EXISTS (
              SELECT 1 FROM artifacts a
              WHERE a.id = r.artifact_id AND a.project_id = r.project_id
            ))
        + (SELECT count(*) FROM artifacts a
            WHERE NOT EXISTS (
              SELECT 1 FROM versions v
              WHERE v.id = a.current_version_id AND v.artifact_id = a.id
            ))
      ) AS n
    `).all())[0]?.n ?? -1
  );
}

function compactArtifactProjects(databasePath: string) {
  return withCompactReader(databasePath, (database) =>
    z.object({artifacts: z.number(), defaultProject: z.number()}).parse(
      database.prepare(`
        SELECT count(*) AS artifacts,
          sum(CASE WHEN project_id = ? THEN 1 ELSE 0 END) AS defaultProject
        FROM artifacts
      `).get(defaultProjectId),
    )
  );
}

function compactActionColumns(databasePath: string): readonly string[] {
  return withCompactReader(databasePath, (database) =>
    z.array(z.object({name: z.string()})).parse(
      database.prepare("PRAGMA table_info(actions)").all(),
    ).map((column) => column.name)
  );
}

function compactActionCount(databasePath: string, action: string): number {
  return withCompactReader(databasePath, (database) =>
    countRowSchema.parse(database.prepare(
      "SELECT count(*) AS n FROM actions WHERE action = ?",
    ).all(action))[0]?.n ?? -1
  );
}

function withCompactReader<Result>(
  databasePath: string,
  read: (database: DatabaseSync) => Result,
): Result {
  const database = new DatabaseSync(databasePath, {readOnly: true});
  try {
    return read(database);
  } finally {
    database.close();
  }
}

function withCompactWriter(databasePath: string, write: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(databasePath);
  try {
    write(database);
  } finally {
    database.close();
  }
}

function defaultProjectCommitted(reader: DatabaseSync): boolean {
  try {
    return countRowSchema.parse(reader.prepare(
      "SELECT count(*) AS n FROM projects",
    ).all())[0]?.n === 1;
  } catch {
    // The migrating process has not created the projects table yet.
    return false;
  }
}

/** Add many legacy artifacts so the migration has real work after the project step. */
function addBulkLegacyArtifacts(databasePath: string, count: number): readonly string[] {
  const ids: string[] = [];
  withCompactWriter(databasePath, (database) => {
    const template = z.object({
      entry_path: z.string(),
      id: z.string(),
      manifest_digest: z.string(),
    }).parse(database.prepare(
      "SELECT id, manifest_digest, entry_path FROM versions ORDER BY created_at LIMIT 1",
    ).get());
    const entries = z.array(z.object({
      disposition: z.string(),
      media_type: z.string(),
      path: z.string(),
      sha256: z.string(),
      size: z.number(),
    })).parse(database.prepare(
      "SELECT path, size, media_type, sha256, disposition FROM manifest_entries WHERE version_id = ?",
    ).all(template.id));
    const insertArtifact = database.prepare(`
      INSERT INTO artifacts (id, name, access_setting, current_version_id, created_at, deleted_at)
      VALUES (?, ?, 'account_required', ?, ?, NULL)
    `);
    const insertVersion = database.prepare(`
      INSERT INTO versions (
        id, artifact_id, number, manifest_digest, entry_path, routing_mode,
        content_token, publisher_principal_id, created_at
      ) VALUES (?, ?, 1, ?, ?, 'static', ?, 'local-api-token', ?)
    `);
    const insertEntry = database.prepare(`
      INSERT INTO manifest_entries (version_id, path, size, media_type, sha256, disposition)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertAction = database.prepare(`
      INSERT INTO actions (
        id, artifact_id, version_id, action, principal_id,
        authorized_by_principal_id, idempotency_key, created_at
      ) VALUES (?, ?, ?, 'publish', 'local-api-token', NULL, ?, ?)
    `);
    database.exec("BEGIN IMMEDIATE;");
    for (let index = 0; index < count; index += 1) {
      const suffix = String(index).padStart(5, "0");
      const artifactId = `art_prj004_bulk_${suffix}`;
      const versionId = `ver_prj004_bulk_${suffix}`;
      const createdAt = `2026-01-01T00:00:00.${String(index % 1000).padStart(3, "0")}Z`;
      insertArtifact.run(artifactId, `Bulk legacy ${suffix}`, versionId, createdAt);
      insertVersion.run(
        versionId,
        artifactId,
        template.manifest_digest,
        template.entry_path,
        `prj004bulk${suffix}`,
        createdAt,
      );
      for (const entry of entries) {
        insertEntry.run(
          versionId,
          entry.path,
          entry.size,
          entry.media_type,
          entry.sha256,
          entry.disposition,
        );
      }
      insertAction.run(`act_prj004_bulk_${suffix}`, artifactId, versionId, `bulk-${suffix}`, createdAt);
      ids.push(artifactId);
    }
    database.exec("COMMIT;");
  });
  return ids;
}

function insertUnknownLegacyAction(
  databasePath: string,
  version: {readonly artifactId: string; readonly createdAt: string; readonly id: string},
): void {
  withCompactWriter(databasePath, (database) => {
    database.prepare(`
      INSERT INTO actions (
        id, artifact_id, version_id, action, principal_id,
        authorized_by_principal_id, idempotency_key, created_at
      ) VALUES ('act_prj004_unknown', ?, ?, 'legacy_unknown_kind', 'local-api-token',
        NULL, 'prj004-unknown', ?)
    `).run(version.artifactId, version.id, version.createdAt);
  });
}

function removeUnknownLegacyAction(databasePath: string): void {
  withCompactWriter(databasePath, (database) => {
    database.prepare("DELETE FROM actions WHERE id = 'act_prj004_unknown'").run();
  });
}

/** The state an older build left after adding only part of the project scope. */
function applyPartialProjectScope(databasePath: string): void {
  withCompactWriter(databasePath, (database) => {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        archived_at TEXT
      ) STRICT;
      INSERT INTO projects (id, installation_id, name, created_at, archived_at)
        VALUES ('${defaultProjectId}', 'local', 'Default', '2026-01-01T00:00:00.000Z', NULL);
      ALTER TABLE artifacts ADD COLUMN project_id TEXT NOT NULL DEFAULT '${defaultProjectId}';
      ALTER TABLE versions ADD COLUMN project_id TEXT NOT NULL DEFAULT '${defaultProjectId}';
      COMMIT;
    `);
  });
}

function workerExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{readonly code: number | null; readonly signal: NodeJS.Signals | null}> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({code: child.exitCode, signal: child.signalCode});
      return;
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({code, signal}));
  });
}

async function workerBackendState(database: PostgresDatabase): Promise<string> {
  const rows = await database.run(Effect.gen(function*() {
    const sql = yield* SqlClient;
    return yield* sql<{readonly wait_event_type: string | null}>`
      SELECT wait_event_type FROM pg_stat_activity
      WHERE application_name = ${projectMigrationWorkerApplicationName}
    `.withoutTransform;
  }));
  const row = rows[0];
  if (row === undefined) return "absent";
  return row.wait_event_type ?? "running";
}

async function withPostgres<Result>(
  databaseUrl: string,
  program: Effect.Effect<Result, unknown, SqlClient>,
): Promise<Result> {
  const database = await PostgresDatabase.inspect({
    applicationName: "prj-004-inspection",
    maxConnections: 1,
    url: Redacted.make(databaseUrl),
  });
  try {
    return await database.run(program);
  } finally {
    await database.close();
  }
}

function runPostgres(databaseUrl: string, statements: readonly string[]): Promise<void> {
  return withPostgres(databaseUrl, Effect.gen(function*() {
    const sql = yield* SqlClient;
    for (const statement of statements) yield* sql.unsafe(statement);
  }));
}

async function applyPostgresMigrations(databaseUrl: string): Promise<void> {
  const database = await PostgresDatabase.open({
    applicationName: "prj-004-migration-apply",
    maxConnections: 1,
    url: Redacted.make(databaseUrl),
  }, "apply");
  await database.close();
}

async function postgresMigrationStatus(databaseUrl: string) {
  const database = await PostgresDatabase.inspect({
    applicationName: "prj-004-migration-status",
    maxConnections: 1,
    url: Redacted.make(databaseUrl),
  });
  try {
    return await database.migrationStatus();
  } finally {
    await database.close();
  }
}

function postgresMigrationHistory(databaseUrl: string): Promise<readonly number[]> {
  return withPostgres(databaseUrl, Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql<{readonly migration_id: number}>`
      SELECT migration_id FROM artifact_server_postgres_migrations ORDER BY migration_id
    `.withoutTransform;
    return rows.map((row) => row.migration_id);
  }));
}

function postgresTableExists(databaseUrl: string, table: string): Promise<boolean> {
  return withPostgres(databaseUrl, Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql<{readonly present: boolean}>`
      SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS present
    `.withoutTransform;
    return rows[0]?.present === true;
  }));
}

function postgresColumns(databaseUrl: string, table: string): Promise<readonly string[]> {
  return withPostgres(databaseUrl, Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql<{readonly column_name: string}>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table}
    `.withoutTransform;
    return rows.map((row) => row.column_name);
  }));
}

function postgresProjects(databaseUrl: string): Promise<readonly unknown[]> {
  return withPostgres(databaseUrl, Effect.gen(function*() {
    const sql = yield* SqlClient;
    return yield* sql`
      SELECT id, installation_id, name FROM projects ORDER BY installation_id, id
    `.withoutTransform;
  }));
}

function readPostgresInstallations(databaseUrl: string): Promise<readonly unknown[]> {
  return withPostgres(databaseUrl, Effect.gen(function*() {
    const sql = yield* SqlClient;
    return yield* sql`SELECT * FROM artifact_installations ORDER BY id`.withoutTransform;
  }));
}

function postgresOrphanCount(databaseUrl: string): Promise<number> {
  return withPostgres(databaseUrl, Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql<{readonly n: number}>`
      SELECT (
        (SELECT count(*) FROM artifacts a WHERE NOT EXISTS (
          SELECT 1 FROM projects p
          WHERE p.installation_id = a.installation_id AND p.id = a.project_id))
        + (SELECT count(*) FROM versions v WHERE NOT EXISTS (
          SELECT 1 FROM artifacts a
          WHERE a.installation_id = v.installation_id AND a.id = v.artifact_id
            AND a.project_id = v.project_id))
        + (SELECT count(*) FROM actions x WHERE x.artifact_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM artifacts a
          WHERE a.installation_id = x.installation_id AND a.id = x.artifact_id
            AND a.project_id = x.project_id))
        + (SELECT count(*) FROM idempotency_records r WHERE NOT EXISTS (
          SELECT 1 FROM artifacts a
          WHERE a.installation_id = r.installation_id AND a.id = r.artifact_id
            AND a.project_id = r.project_id))
      )::int AS n
    `.withoutTransform;
    return rows[0]?.n ?? -1;
  }));
}

function runCommand(command: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ["ignore", "pipe", "pipe"]});
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      reject(new Error(
        `${command} exited with ${exitCode ?? "no status"}: ${Buffer.concat(stderr).toString("utf8")}`,
      ));
    });
  });
}
