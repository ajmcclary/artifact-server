import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {unstable_dev, type Unstable_DevWorker} from "wrangler";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {
  qualifyRuntime,
  type QualificationFetch,
} from "../scripts/account-probe.mjs";

const apiToken = "cloudflare-test-api-token-0000000000000001";
const origin = "https://artifacts.example.test";
const contentDomain = "content.example.test";

let persistPath: string;
let worker: Unstable_DevWorker;

beforeAll(async () => {
  persistPath = await mkdtemp(
    join(tmpdir(), "artifact-server-account-probe-runtime-"),
  );
  worker = await unstable_dev("src/worker.ts", {
    bundle: true,
    config: "wrangler.test.jsonc",
    compatibilityDate: "2026-08-15",
    compatibilityFlags: ["nodejs_compat"],
    experimental: {
      d1Databases: [{
        binding: "ARTIFACT_SERVER_D1_DATABASE",
        database_id: "artifact-server-test-d1",
        database_name: "artifact-server-test-d1",
      }],
      disableExperimentalWarning: true,
      disableDevRegistry: true,
      testScheduled: true,
      watch: false,
    },
    inspect: false,
    local: true,
    logLevel: "error",
    persist: true,
    persistTo: persistPath,
    r2: [{
      binding: "ARTIFACT_SERVER_R2_BUCKET",
      bucket_name: "artifact-server-test-r2",
    }],
    vars: {
      ARTIFACT_SERVER_API_TOKEN: apiToken,
      ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "administrator@example.test",
      ARTIFACT_SERVER_CONTENT_DOMAIN: contentDomain,
      ARTIFACT_SERVER_INSTALLATION_ID: "cloudflare-account-probe-runtime-test",
      ARTIFACT_SERVER_OIDC_CLIENT_ID: "cloudflare-worker-test",
      ARTIFACT_SERVER_OIDC_ISSUER: "https://identity.example.test",
      ARTIFACT_SERVER_ORIGIN: origin,
      ARTIFACT_SERVER_QUALIFICATION_MODE: "enabled",
      ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    },
  });
}, 30_000);

afterAll(async () => {
  await worker.stop();
  await rm(persistPath, {force: true, recursive: true});
});

describe("account probe runtime qualification", () => {
  it("runs the exact live probe flow, including several 202 preparing passes, against the local Worker", async () => {
    const probeFetch: QualificationFetch = (url, options) =>
      worker.fetch(url.toString(), options === undefined ? {} : {...options});
    const result = await qualifyRuntime(new URL(origin), apiToken, probeFetch);
    expect(result.passed).toBe(true);
    expect(result.evidence.health).toBe(200);
    expect(result.evidence.unauthorized).toBe(401);
    expect(result.evidence.commit).toBe(201);
    expect(result.evidence.replay).toBe(200);
    expect(result.evidence.multiUpload).toBe(201);
    expect(result.evidence.multiFileUploads).toBe(12);
    expect(
      result.evidence.multiPreparingPasses?.map((pass) => pass.installed),
    ).toEqual([5, 10]);
    expect(result.evidence.multiCommit).toBe(201);
    expect(result.evidence.multiReplay).toBe(200);
    expect(result.evidence.multiList).toBe(200);
    expect(result.evidence.mcp).toMatchObject({
      unauthorized: 401,
      invalidToken: 401,
      get: 405,
      delete: 405,
      hostileOrigin: 403,
      discovery: 200,
      toolsList: 200,
      templatesList: 200,
      capabilities: 200,
      mismatchedName: 400,
      unavailableLink: 200,
      createUpload: 200,
      resumedUpload: 200,
      conflict: 200,
      uploadFile: 200,
      commit: 200,
      committedReplay: 200,
      compact: 200,
      full: 200,
      invalidProjection: 200,
      firstPage: 200,
      secondPage: 200,
      invalidCursor: 200,
    });
  }, 60_000);
});
