/**
 * The transient recovery Worker against real local D1 and R2 bindings: the
 * module's own fetch handler, a migrated schema, and repository writes made
 * through the same D1 adapters the deployed Worker uses.
 */
import {randomBytes} from "node:crypto";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {getPlatformProxy} from "wrangler";
import {z} from "zod";

import {systemAttribution} from "../../../src/core/action-attribution.js";
import {memberAdmissions} from "../../../src/core/identity-ports.js";
import {createD1IdentityRepository} from "../src/d1-identity-repository.js";
import {migrateD1} from "../src/d1-migrations.js";
import recoveryWorker from "../src/recovery-worker.js";

const installationId = "cloudflare-recovery-worker-test";
const recoveryToken = randomBytes(32).toString("base64url");

const inspectionSchema = z.object({
  integrity: z.object({
    problemCount: z.number().int().nonnegative(),
    status: z.enum(["corrupt", "healthy"]),
  }).loose(),
  tableRows: z.record(z.string(), z.number().int().nonnegative()),
}).loose();
const tableNameSchema = z.object({name: z.string()});

type RecoveryBindings = {
  readonly RECOVERY_D1: D1Database;
  readonly RECOVERY_R2: R2Bucket;
};

let configDirectory: string;
let proxy: Awaited<ReturnType<typeof getPlatformProxy<RecoveryBindings>>>;

beforeAll(async () => {
  configDirectory = await mkdtemp(join(tmpdir(), "artifact-server-recovery-"));
  const configPath = join(configDirectory, "wrangler.json");
  await writeFile(configPath, JSON.stringify({
    compatibility_date: "2026-08-15",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: [{
      binding: "RECOVERY_D1",
      database_id: "00000000-0000-4000-8000-00000000000d",
      database_name: "artifact-server-recovery-test",
    }],
    name: "artifact-server-recovery-test",
    r2_buckets: [{
      binding: "RECOVERY_R2",
      bucket_name: "artifact-server-recovery-test",
    }],
  }), "utf8");
  proxy = await getPlatformProxy<RecoveryBindings>({
    configPath,
    envFiles: [],
    persist: false,
    remoteBindings: false,
  });
  await migrateD1(proxy.env.RECOVERY_D1, installationId);
}, 30_000);

afterAll(async () => {
  await proxy.dispose();
  await rm(configDirectory, {force: true, recursive: true});
});

function recoveryEnvironment(token: string | undefined) {
  const environment = {
    ARTIFACT_SERVER_INSTALLATION_ID: installationId,
    ARTIFACT_SERVER_RECOVERY_MODE: "source" as const,
    RECOVERY_D1: proxy.env.RECOVERY_D1,
    RECOVERY_R2: proxy.env.RECOVERY_R2,
  };
  return token === undefined
    ? environment
    : {...environment, ARTIFACT_SERVER_RECOVERY_TOKEN: token};
}

function recoveryRequest(path: string, authorization: string | null): Request {
  return new Request(`https://recovery.example.test${path}`, {
    headers: authorization === null ? {} : {Authorization: authorization},
  });
}

describe("Cloudflare recovery Worker (SEC-004)", () => {
  it("refuses every request when the recovery secret is unset, empty, or short", async () => {
    const unset = await recoveryWorker.fetch(
      recoveryRequest("/ready", "Bearer undefined"),
      recoveryEnvironment(undefined),
    );
    expect(unset.status).toBe(401);

    const empty = await recoveryWorker.fetch(
      recoveryRequest("/ready", "Bearer "),
      recoveryEnvironment(""),
    );
    expect(empty.status).toBe(401);

    const shortSecret = "short-recovery-secret";
    const short = await recoveryWorker.fetch(
      recoveryRequest("/ready", `Bearer ${shortSecret}`),
      recoveryEnvironment(shortSecret),
    );
    expect(short.status).toBe(401);

    const wrong = await recoveryWorker.fetch(
      recoveryRequest("/ready", `Bearer ${recoveryToken.slice(1)}x`),
      recoveryEnvironment(recoveryToken),
    );
    expect(wrong.status).toBe(401);

    const missing = await recoveryWorker.fetch(
      recoveryRequest("/ready", null),
      recoveryEnvironment(recoveryToken),
    );
    expect(missing.status).toBe(401);

    const accepted = await recoveryWorker.fetch(
      recoveryRequest("/ready", `Bearer ${recoveryToken}`),
      recoveryEnvironment(recoveryToken),
    );
    expect(accepted.status).toBe(200);
  });

  it("reports an installation with project-less key activity as healthy and digests every persistent table", async () => {
    const database = proxy.env.RECOVERY_D1;
    const identity = createD1IdentityRepository(database);
    await identity.admitMember({
      admittedHow: memberAdmissions.owner,
      attribution: systemAttribution,
      createdAt: "2026-11-01T10:00:00.000Z",
      displayName: "Rosa Santoro",
      email: "rosa@example.test",
      id: "member_rosa",
      installationId,
      role: "administrator",
    });
    await identity.createApiKey({
      authorizedByPrincipalId: "member_rosa",
      capabilities: ["artifact:read"],
      createdAt: "2026-11-01T10:01:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      id: "key_recovery",
      installationId,
      name: "Recovery key",
      prefix: "as_key_key_recovery_",
      principalId: "service:key_recovery",
      principalKind: "service",
      projectIds: [],
      revokedAt: null,
      rotatedFromId: null,
      secretDigest: "digest-recovery",
    }, {
      actor: {displayName: "Rosa Santoro", kind: "human"},
      authorizedByPrincipalId: null,
      principalId: "member_rosa",
    });
    const projectless = await database.prepare(
      "SELECT COUNT(*) AS count FROM actions WHERE project_id IS NULL",
    ).first<number>("count");
    expect(projectless).toBeGreaterThan(0);

    const response = await recoveryWorker.fetch(
      recoveryRequest("/inspect", `Bearer ${recoveryToken}`),
      recoveryEnvironment(recoveryToken),
    );
    expect(response.status).toBe(200);
    const inspection = inspectionSchema.parse(await response.json());
    expect(inspection.integrity).toMatchObject({problemCount: 0, status: "healthy"});

    // A restore is accepted only when the source and restored digests match,
    // so a table the digest skips could silently diverge across a restore.
    const tables = z.array(tableNameSchema).parse((await database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
      ORDER BY name
    `).all()).results).map(({name}) => name);
    expect(Object.keys(inspection.tableRows).toSorted()).toEqual(tables);
  });
});
