/**
 * Cold-start behavior of the deployed Worker module against real local D1 and
 * R2 bindings: the migration batch runs only when the schema is not current,
 * and a failed runtime initialization is retried by the next invocation
 * whichever entry point (fetch or cron) saw the failure.
 */
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {getPlatformProxy} from "wrangler";

import {migrateD1, requiredD1SchemaVersion} from "../src/d1-migrations.js";
import worker, {type WorkerEnvironment} from "../src/worker.js";

const installationId = "cloudflare-cold-start-test";
const origin = "https://artifacts.example.test";

type ColdStartBindings = {
  readonly ASSETS: Fetcher;
  readonly ARTIFACT_SERVER_D1_DATABASE: D1Database;
  readonly ARTIFACT_SERVER_R2_BUCKET: R2Bucket;
};

let configDirectory: string;
let proxy: Awaited<ReturnType<typeof getPlatformProxy<ColdStartBindings>>>;

beforeAll(async () => {
  configDirectory = await mkdtemp(join(tmpdir(), "artifact-server-cold-start-"));
  const configPath = join(configDirectory, "wrangler.json");
  await writeFile(configPath, JSON.stringify({
    assets: {
      binding: "ASSETS",
      directory: fileURLToPath(new URL("../../../dist/web", import.meta.url)),
    },
    compatibility_date: "2026-08-15",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: [{
      binding: "ARTIFACT_SERVER_D1_DATABASE",
      database_id: "00000000-0000-4000-8000-00000000000c",
      database_name: "artifact-server-cold-start-test",
    }],
    name: "artifact-server-cold-start-test",
    r2_buckets: [{
      binding: "ARTIFACT_SERVER_R2_BUCKET",
      bucket_name: "artifact-server-cold-start-test",
    }],
  }), "utf8");
  proxy = await getPlatformProxy<ColdStartBindings>({
    configPath,
    envFiles: [],
    persist: false,
    remoteBindings: false,
  });
}, 30_000);

afterAll(async () => {
  await proxy.dispose();
  await rm(configDirectory, {force: true, recursive: true});
});

/** Counts the statements and batches one migration run sends to real D1. */
function countingDatabase(database: D1Database) {
  const counts = {batches: 0, statements: 0};
  const counted = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          counts.statements += 1;
          return target.prepare(query);
        };
      }
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          counts.batches += 1;
          return target.batch(statements);
        };
      }
      throw new Error(`The migration used an uncounted D1 method: ${String(property)}.`);
    },
  });
  return {counted, counts};
}

function readRevision(database: D1Database): Promise<number | null> {
  return database.prepare(
    "SELECT version FROM artifact_server_schema WHERE component = 'runtime'",
  ).first<number>("version");
}

function workerEnvironment(options: {readonly identityProvider: boolean}): WorkerEnvironment {
  const environment = {
    ...proxy.env,
    ARTIFACT_SERVER_API_TOKEN: "cloudflare-cold-start-api-token-00000001",
    ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "administrator@example.test",
    ARTIFACT_SERVER_CONTENT_DOMAIN: "content.example.test",
    ARTIFACT_SERVER_INSTALLATION_ID: installationId,
    ARTIFACT_SERVER_ORIGIN: origin,
    ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
  };
  return options.identityProvider
    ? {
      ...environment,
      ARTIFACT_SERVER_OIDC_CLIENT_ID: "cloudflare-cold-start-test",
      ARTIFACT_SERVER_OIDC_ISSUER: "https://identity.example.test",
    }
    : environment;
}

/** Runs one cron invocation and settles everything it handed to waitUntil. */
async function runScheduled(environment: WorkerEnvironment): Promise<void> {
  const pending: Promise<unknown>[] = [];
  worker.scheduled(
    {cron: "*/15 * * * *", noRetry: () => undefined, scheduledTime: Date.now()},
    environment,
    {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
    },
  );
  await Promise.all(pending);
}

describe("Cloudflare Worker cold start", () => {
  it("sends one read instead of the migration batch once the D1 schema is current", async () => {
    const database = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    await migrateD1(database, installationId);
    expect(await readRevision(database)).toBe(requiredD1SchemaVersion);

    const current = countingDatabase(database);
    await migrateD1(current.counted, installationId);
    expect(current.counts).toEqual({batches: 0, statements: 1});

    // A stale revision, a changed shared-schema fingerprint, or a missing
    // default project for this installation each take the full path again.
    await database.prepare(
      "UPDATE artifact_server_schema SET version = ? WHERE component = 'runtime'",
    ).bind(requiredD1SchemaVersion - 1).run();
    const stale = countingDatabase(database);
    await migrateD1(stale.counted, installationId);
    expect(stale.counts.batches).toBeGreaterThan(0);
    expect(await readRevision(database)).toBe(requiredD1SchemaVersion);

    await database.prepare(`
      UPDATE artifact_server_schema SET version = 0
      WHERE component = 'runtime-migration-fingerprint'
    `).run();
    const drifted = countingDatabase(database);
    await migrateD1(drifted.counted, installationId);
    expect(drifted.counts.batches).toBeGreaterThan(0);
    const afterDrift = countingDatabase(database);
    await migrateD1(afterDrift.counted, installationId);
    expect(afterDrift.counts).toEqual({batches: 0, statements: 1});

    const otherInstallation = countingDatabase(database);
    await expect(migrateD1(otherInstallation.counted, "another-installation"))
      .resolves.toBeUndefined();
    expect(otherInstallation.counts.batches).toBeGreaterThan(0);
  });

  it("retries a failed runtime initialization on the next cron invocation", async () => {
    await expect(runScheduled(workerEnvironment({identityProvider: false})))
      .rejects.toThrow("exactly one OIDC or WorkOS browser-login provider");

    // The operator fixes the configuration. The next cron invocation in the
    // same isolate must build a runtime instead of replaying the failure.
    await expect(runScheduled(workerEnvironment({identityProvider: true})))
      .resolves.toBeUndefined();
    // The repaired runtime stays cached for later invocations.
    await expect(runScheduled(workerEnvironment({identityProvider: false})))
      .resolves.toBeUndefined();
  });
});
