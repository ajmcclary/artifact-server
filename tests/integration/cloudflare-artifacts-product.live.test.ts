// Bounded live qualification of the Node/Postgres Git-history product path
// against Cloudflare Artifacts. Run only through
// `pnpm qualify:cloudflare-artifacts:product`, which supplies disposable
// Postgres and MinIO, the dedicated qualification namespace and an explicit
// opt-in. Every repository it creates belongs to this run's fresh installation
// and is removed by the operator purge command, then checked by exact name.
import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {CreateBucketCommand, S3Client} from "@aws-sdk/client-s3";
import {afterAll, beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";

import {defaultProjectId} from "../../src/core/model.js";
import {
  startStubOidcProvider,
  type RunningStubOidcProvider,
} from "../support/stub-oidc-provider.js";

const live = process.env["ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_LIVE"] === "1";
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const cli = path.join(repositoryRoot, "dist/cli/main.js");
const namespace = "artifact-server-test-qualification";
const region = "us-east-1";
const bucket = "artifact-server-cloudflare-artifacts-qualification";
const fileCopyLimitBytes = 256;
// Bounds for this run. Each mirrored version costs roughly four provider
// operations (token, fetch, branch push, tag push) and each repository one
// create and one delete, so the run stays far below the monthly allowance.
const maximumRepositories = 4;
const maximumMirroredVersions = 16;
const liveTimeout = 180_000;
const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const installationId = `cfa-qualification-${runId}`;
const apiToken = managedTestKey(`cfa-qualification-${runId}`);

const publishResponseSchema = z.object({
  artifact: z.object({currentVersionId: z.string(), id: z.string()}),
  version: z.object({id: z.string(), number: z.number().int().positive()}),
});
const uploadResponseSchema = z.object({
  commitUrl: z.url(),
  files: z.array(z.object({path: z.string(), uploadUrl: z.url()})),
});
const estimateSchema = z.object({
  estimate: z.object({
    estimatedCopiedBytes: z.number(),
    estimatedPointerBytes: z.number(),
    operations: z.number(),
    repositories: z.number(),
    versions: z.number(),
  }).loose(),
});
const pointerSchema = z.array(z.object({
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: z.number(),
}).strict());
const versionMetadataSchema = z.object({
  artifactId: z.string(),
  installationId: z.string(),
  projectId: z.string(),
  versionId: z.string(),
  versionNumber: z.number(),
}).loose();
const cloudflareEnvelopeSchema = z.object({
  result: z.unknown(),
  result_info: z.object({total_count: z.number()}).loose().optional(),
  success: z.boolean(),
}).loose();

interface Environment {
  readonly accessKey: string;
  readonly accountId: string;
  readonly databaseUrl: string;
  readonly endpoint: string;
  readonly evidencePath: string;
  readonly postgresContainer: string;
  readonly postgresUser: string;
  readonly secretKey: string;
  readonly sourceCommit: string;
  readonly tokenFile: string;
}

interface ServerProcess {
  readonly baseUrl: string;
  readonly child: ChildProcessWithoutNullStreams;
}

interface PublishedVersion {
  readonly content: string;
  readonly id: string;
  readonly number: number;
}

interface CleanupRecord {
  readonly crashMappedVersionsAtKill?: number;
  readonly namespaceRepositoriesAtEnd?: number;
  readonly namespaceRepositoriesAtStart?: number;
  readonly outcome: "not-run" | "purged";
  readonly remainingAfterPurge?: number;
  readonly removedBySafetyNet?: readonly string[];
  readonly repositoriesCreated?: number;
  readonly selection?: string;
}

interface SafetyNetResult {
  readonly namespaceRepositoriesAtEnd: number;
  readonly namespaceRepositoriesAtStart: number;
  readonly remainingAfterPurge: number;
  readonly removedBySafetyNet: readonly string[];
}

interface Mapping {
  readonly artifactId: string;
  readonly commitId: string;
  readonly versionId: string;
}

const checks: Record<string, "fail" | "pass"> = {};
const running = new Set<ChildProcessWithoutNullStreams>();
const artifacts = new Map<string, PublishedVersion[]>();
let environment: Environment;
let oidc: RunningStubOidcProvider;
let workDirectory: string;
let namespaceRepositoriesAtStart = -1;
let clones = 0;
let cleanup: CleanupRecord = {outcome: "not-run"};

describe.skipIf(!live)("Cloudflare Artifacts Node/Postgres product qualification", () => {
  beforeAll(async () => {
    environment = readEnvironment();
    workDirectory = await mkdtemp(path.join(tmpdir(), "cfa-qualification-"));
    oidc = await startStubOidcProvider({clientId: "cfa-qualification"});
    const s3 = new S3Client({
      credentials: {
        accessKeyId: environment.accessKey,
        secretAccessKey: environment.secretKey,
      },
      endpoint: environment.endpoint,
      forcePathStyle: true,
      region,
    });
    await s3.send(new CreateBucketCommand({Bucket: bucket}));
    const migrated = await runCli(["migrate", "apply"]);
    if (migrated.exitCode !== 0) throw new Error(`Migration failed: ${migrated.output}`);
    namespaceRepositoriesAtStart = await countNamespaceRepositories();
  }, liveTimeout);

  afterAll(async () => {
    await Promise.all([...running].map(async (child) => stopProcess(child, "SIGTERM")));
    const safetyNet = await verifyOrRemoveRemainingRepositories();
    if (safetyNet !== null) cleanup = {...cleanup, ...safetyNet};
    await oidc?.stop();
    await writeEvidence();
    if (workDirectory !== undefined) {
      await rm(workDirectory, {force: true, recursive: true});
    }
  }, liveTimeout);

  test("GIT-010 GIT-013 live: the provider becomes available for the dedicated namespace", async () => {
    const server = await startServer();
    await expect.poll(
      () => providerState(server.baseUrl),
      {interval: 1_000, timeout: 60_000},
    ).toBe("available");
    const identity = await sql(`
      SELECT provider || '|' || account_id || '|' || namespace
      FROM git_history_provider_identity
      WHERE installation_id = '${installationId}'
    `);
    expect(identity).toEqual([
      `cloudflare-artifacts|${environment.accountId}|${namespace}`,
    ]);
    await stopProcess(server.child, "SIGTERM");
    checks["providerAvailability"] = "pass";
  }, liveTimeout);

  test("GIT-004 GIT-012 GIT-014 live: estimate before enablement creates nothing remotely", async () => {
    const server = await startServer();
    await publishArtifactVersions(server.baseUrl, "alpha", [
      "<!doctype html><title>alpha one</title>",
      `<!doctype html><title>alpha two</title>${"p".repeat(fileCopyLimitBytes)}`,
      "<!doctype html><title>alpha three</title>",
    ]);
    const alpha = artifactVersions("alpha");
    const response = await fetch(
      `${server.baseUrl}/api/v1/projects/${defaultProjectId}/git-history/estimate`,
      {headers: mutationHeaders(`estimate-${runId}`), method: "POST"},
    );
    expect(response.status).toBe(200);
    const {estimate} = estimateSchema.parse(await response.json());
    const pointerBytes = Buffer.byteLength(alpha[1]?.content ?? "");
    expect(estimate).toMatchObject({
      estimatedPointerBytes: pointerBytes,
      repositories: 1,
      versions: 3,
    });
    expect(await remoteRepositoryStatus(artifactId("alpha"))).toBe(404);
    expect(await sql(`
      SELECT count(*) FROM git_history_jobs WHERE installation_id = '${installationId}'
    `)).toEqual(["0"]);
    await stopProcess(server.child, "SIGTERM");
    checks["estimateWithoutRemoteEffects"] = "pass";
  }, liveTimeout);

  test("GIT-002-B GIT-008 live: enablement backfills oldest-first and a new publication opens before it is mirrored", async () => {
    const server = await startServer();
    await waitForAvailable(server.baseUrl);
    await setProjectGitHistory(server.baseUrl, true);
    await waitForMappings("alpha", 3);
    await publishArtifactVersions(server.baseUrl, "alpha", [
      "<!doctype html><title>alpha four</title>",
    ]);
    // The primary version is readable at once, whatever the mirror has done.
    const opened = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId("alpha")}?project=${defaultProjectId}`,
      {headers: {Authorization: `Bearer ${apiToken}`}},
    );
    expect(opened.status).toBe(200);
    expect(await opened.text()).toContain(versionAt("alpha", 3).id);
    const mappings = await waitForMappings("alpha", 4);
    expect(new Set(mappings.map((mapping) => mapping.commitId)).size).toBe(4);
    await stopProcess(server.child, "SIGTERM");
    checks["backfillAndFollowOn"] = "pass";
  }, liveTimeout);

  test("GIT-004 GIT-005 live: a CLI clone carries exact tags, parent order, bytes and pointers, and cannot push", async () => {
    const server = await startServer();
    await waitForAvailable(server.baseUrl);
    const directory = await cloneHistory(server.baseUrl, "alpha");
    await assertExactHistory(directory, "alpha");
    const pointers = pointerSchema.parse(JSON.parse(
      await git(directory, ["show", `refs/tags/v/${versionAt("alpha", 1).id}:.artifactserver/pointers.json`]),
    ));
    const pointerContent = versionAt("alpha", 1).content;
    expect(pointers).toEqual([{
      mediaType: "text/html; charset=utf-8",
      path: "index.html",
      sha256: sha256(pointerContent),
      size: Buffer.byteLength(pointerContent),
    }]);
    await expect(git(directory, [
      "ls-tree", "--name-only", `refs/tags/v/${versionAt("alpha", 1).id}`,
    ])).resolves.not.toMatch(/^index\.html$/mu);
    const credential = await cloneCredential(server.baseUrl, "alpha");
    await expect(gitWithToken(directory, credential.token, [
      "push", credential.remote, "HEAD:refs/heads/qualification-write-attempt",
    ])).rejects.toThrow(/exited with/u);
    await expect(gitWithToken(directory, null, [
      "ls-remote", credential.remote,
    ])).rejects.toThrow(/exited with/u);
    const tooShort = await fetch(cloneTokenUrl(server.baseUrl, "alpha"), {
      body: JSON.stringify({ttlSeconds: 59}),
      headers: mutationHeaders(`short-${runId}`),
      method: "POST",
    });
    expect(tooShort.status).toBe(422);
    await stopProcess(server.child, "SIGTERM");
    checks["readOnlyExactClone"] = "pass";
  }, liveTimeout);

  test("GIT-003-B live: a rejected provider credential never blocks publication and the copy retries after recovery", async () => {
    const invalidTokenFile = path.join(workDirectory, "invalid.token");
    await writeFile(invalidTokenFile, "invalid-qualification-token\n", {mode: 0o600});
    const degraded = await startServer({tokenFile: invalidTokenFile});
    await expect.poll(
      () => providerState(degraded.baseUrl),
      {interval: 1_000, timeout: 60_000},
    ).not.toMatch(/^(available|checking)$/u);
    const before = Date.now();
    await publishArtifactVersions(degraded.baseUrl, "alpha", [
      "<!doctype html><title>alpha five during outage</title>",
    ]);
    expect(Date.now() - before).toBeLessThan(15_000);
    const content = await fetch(
      `${degraded.baseUrl}/api/v1/artifacts/${artifactId("alpha")}?project=${defaultProjectId}`,
      {headers: {Authorization: `Bearer ${apiToken}`}},
    );
    expect(content.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    expect(await mappingsFor("alpha")).toHaveLength(4);
    await stopProcess(degraded.child, "SIGTERM");

    const recovered = await startServer();
    await waitForAvailable(recovered.baseUrl);
    await waitForMappings("alpha", 5);
    await stopProcess(recovered.child, "SIGTERM");
    checks["outageIsolationAndRecovery"] = "pass";
  }, liveTimeout);

  test("GIT-002 GIT-008 live: a worker killed during a provider push resumes with one commit per version", async () => {
    const server = await startServer();
    await waitForAvailable(server.baseUrl);
    await publishArtifactVersions(server.baseUrl, "bravo", [
      "<!doctype html><title>bravo one</title>",
      "<!doctype html><title>bravo two</title>",
      "<!doctype html><title>bravo three</title>",
    ]);
    const second = versionAt("bravo", 1).id;
    await expect.poll(async () => sql(`
      SELECT state FROM git_history_jobs
      WHERE installation_id = '${installationId}' AND version_id = '${second}'
    `), {interval: 50, timeout: 90_000}).toEqual(["claimed"]);
    await stopProcess(server.child, "SIGKILL");
    const mappedAtKill = (await mappingsFor("bravo")).length;

    const restarted = await startServer();
    await waitForAvailable(restarted.baseUrl);
    const mappings = await waitForMappings("bravo", 3);
    expect(new Set(mappings.map((mapping) => mapping.commitId)).size).toBe(3);
    expect(await sql(`
      SELECT count(*) FROM git_history_jobs
      WHERE installation_id = '${installationId}' AND state <> 'done'
    `)).toEqual(["0"]);
    const directory = await cloneHistory(restarted.baseUrl, "bravo");
    await assertExactHistory(directory, "bravo");
    await stopProcess(restarted.child, "SIGTERM");
    cleanup = {...cleanup, crashMappedVersionsAtKill: mappedAtKill};
    checks["crashDuringPushRecovery"] = "pass";
  }, liveTimeout);

  test("GIT-002 GIT-008 live: two server processes converge to one ordered chain per artifact", async () => {
    const first = await startServer();
    const second = await startServer();
    await Promise.all([waitForAvailable(first.baseUrl), waitForAvailable(second.baseUrl)]);
    // Each artifact's versions alternate between the two processes, so both
    // workers race for jobs across artifacts while each chain must stay ordered.
    await sequentially([
      [first.baseUrl, "charlie", "one"],
      [second.baseUrl, "delta", "one"],
      [second.baseUrl, "charlie", "two"],
      [first.baseUrl, "delta", "two"],
      [first.baseUrl, "charlie", "three"],
      [second.baseUrl, "delta", "three"],
    ] as const, ([baseUrl, label, ordinal]) => publishArtifactVersions(baseUrl, label, [
      `<!doctype html><title>${label} ${ordinal}</title>`,
    ]));
    const [charlie, delta] = await Promise.all([
      waitForMappings("charlie", 3),
      waitForMappings("delta", 3),
    ]);
    expect(new Set(charlie.map((mapping) => mapping.commitId)).size).toBe(3);
    expect(new Set(delta.map((mapping) => mapping.commitId)).size).toBe(3);
    await assertExactHistory(await cloneHistory(first.baseUrl, "charlie"), "charlie");
    await assertExactHistory(await cloneHistory(second.baseUrl, "delta"), "delta");
    await Promise.all([
      stopProcess(first.child, "SIGTERM"),
      stopProcess(second.child, "SIGTERM"),
    ]);
    checks["twoProcessConvergence"] = "pass";
  }, liveTimeout);

  test("GIT-009 live: disablement withdraws clone access, keeps repositories, and re-enablement resumes", async () => {
    const server = await startServer();
    await waitForAvailable(server.baseUrl);
    await setProjectGitHistory(server.baseUrl, false);
    const refused = await fetch(cloneTokenUrl(server.baseUrl, "alpha"), {
      body: "{}",
      headers: mutationHeaders(`disabled-clone-${runId}`),
      method: "POST",
    });
    expect(refused.status).toBe(404);
    expect(await remoteRepositoryStatus(artifactId("alpha"))).toBe(200);
    await publishArtifactVersions(server.baseUrl, "alpha", [
      "<!doctype html><title>alpha six while disabled</title>",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    expect(await mappingsFor("alpha")).toHaveLength(5);
    await setProjectGitHistory(server.baseUrl, true);
    await waitForMappings("alpha", 6);
    await stopProcess(server.child, "SIGTERM");
    checks["disableAndResume"] = "pass";
  }, liveTimeout);

  test("GIT-011 GIT-013 live: the operator purge removes exactly this installation's repositories", async () => {
    const repositories = await sql(`
      SELECT repository_name FROM git_history_repositories
      WHERE installation_id = '${installationId}' ORDER BY repository_name
    `);
    expect(repositories).toEqual(
      ["alpha", "bravo", "charlie", "delta"].map(artifactId).toSorted(),
    );
    expect(repositories.length).toBeLessThanOrEqual(maximumRepositories);
    const mirrored = await sql(`
      SELECT count(*) FROM git_history_mappings WHERE installation_id = '${installationId}'
    `);
    expect(Number(mirrored[0])).toBeLessThanOrEqual(maximumMirroredVersions);

    const plan = await runCli(["history", "purge", "--mode", "external-storage", "--plan"]);
    expect(plan).toMatchObject({exitCode: 0});
    expect(z.object({
      installationId: z.string(),
      providerIdentity: z.object({accountId: z.string(), namespace: z.string()}).loose(),
      repositoriesToDelete: z.number(),
    }).loose().parse(JSON.parse(plan.output))).toMatchObject({
      installationId,
      providerIdentity: {accountId: environment.accountId, namespace},
      repositoriesToDelete: repositories.length,
    });
    const wrong = await runCli([
      "history", "purge", "--mode", "external-storage", "--apply",
      "--confirm-installation", `${installationId}-other`,
    ]);
    expect(wrong.exitCode).not.toBe(0);
    const whileEnabled = await runCli([
      "history", "purge", "--mode", "external-storage", "--apply",
      "--confirm-installation", installationId,
    ]);
    expect(whileEnabled.exitCode).toBe(1);
    expect(whileEnabled.output).toContain("Disable Git history for every project");
    expect(await Promise.all(repositories.map(remoteRepositoryStatus)))
      .toEqual(repositories.map(() => 200));
    const server = await startServer();
    await setProjectGitHistory(server.baseUrl, false);
    await stopProcess(server.child, "SIGTERM");
    const applied = await runCli([
      "history", "purge", "--mode", "external-storage", "--apply",
      "--confirm-installation", installationId, "--page-size", "1",
    ]);
    expect(applied).toMatchObject({exitCode: 0});
    await expect.poll(
      () => Promise.all(repositories.map(remoteRepositoryStatus)),
      {interval: 2_000, timeout: 60_000},
    ).toEqual(repositories.map(() => 404));
    const again = await runCli([
      "history", "purge", "--mode", "external-storage", "--apply",
      "--confirm-installation", installationId, "--page-size", "1",
    ]);
    expect(again).toMatchObject({exitCode: 0});
    cleanup = {
      outcome: "purged",
      repositoriesCreated: repositories.length,
      selection: "operator purge of this run's installation",
    };
    checks["operatorPurge"] = "pass";
  }, liveTimeout);
});

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Run through pnpm qualify:cloudflare-artifacts:product (${name} is missing).`);
  }
  return value;
}

function readEnvironment(): Environment {
  return {
    accessKey: required("ARTIFACT_SERVER_TEST_S3_ACCESS_KEY"),
    accountId: required("ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_ACCOUNT_ID"),
    databaseUrl: required("ARTIFACT_SERVER_TEST_DATABASE_URL"),
    endpoint: required("ARTIFACT_SERVER_TEST_S3_ENDPOINT"),
    evidencePath: required("ARTIFACT_SERVER_QUALIFICATION_EVIDENCE"),
    postgresContainer: required("ARTIFACT_SERVER_TEST_POSTGRES_CONTAINER"),
    postgresUser: required("ARTIFACT_SERVER_TEST_POSTGRES_USER"),
    secretKey: required("ARTIFACT_SERVER_TEST_S3_SECRET_KEY"),
    sourceCommit: required("ARTIFACT_SERVER_QUALIFICATION_SOURCE_COMMIT"),
    tokenFile: required("ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE"),
  };
}

function serverEnvironment(tokenFile: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ARTIFACT_SERVER_API_TOKEN: apiToken,
    ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "administrator@example.test",
    ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_ACCOUNT_ID: environment.accountId,
    ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE: tokenFile,
    ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_NAMESPACE: namespace,
    ARTIFACT_SERVER_CONTENT_DOMAIN: "content.example.net",
    ARTIFACT_SERVER_DATABASE_URL: environment.databaseUrl,
    ARTIFACT_SERVER_GIT_HISTORY_COPY_LIMIT_BYTES: String(fileCopyLimitBytes),
    ARTIFACT_SERVER_GIT_HISTORY_PROVIDER: "cloudflare-artifacts",
    ARTIFACT_SERVER_INSTALLATION_ID: installationId,
    ARTIFACT_SERVER_OIDC_CLIENT_ID: "cfa-qualification",
    ARTIFACT_SERVER_OIDC_ISSUER: oidc.issuer,
    ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.com",
    ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS: "0",
    ARTIFACT_SERVER_S3_ACCESS_KEY_ID: environment.accessKey,
    ARTIFACT_SERVER_S3_BUCKET: bucket,
    ARTIFACT_SERVER_S3_ENDPOINT: environment.endpoint,
    ARTIFACT_SERVER_S3_FORCE_PATH_STYLE: "true",
    ARTIFACT_SERVER_S3_REGION: region,
    ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY: environment.secretKey,
  };
}

function startServer(
  options: {readonly tokenFile?: string} = {},
): Promise<ServerProcess> {
  const child = spawn(
    process.execPath,
    [cli, "start-external-storage", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: repositoryRoot,
      env: serverEnvironment(options.tokenFile ?? environment.tokenFile),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  running.add(child);
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      finish();
      reject(new Error(`The server did not become ready: ${output}`));
    }, 30_000);
    const receive = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = /Artifact Server \(external-storage\): (http:\/\/127\.0\.0\.1:\d+)/u
        .exec(output);
      if (match?.[1] === undefined) return;
      finish();
      resolve({baseUrl: match[1], child});
    };
    const exit = () => {
      finish();
      reject(new Error(`The server exited before readiness: ${output}`));
    };
    const finish = () => {
      clearTimeout(timeout);
      child.stdout.off("data", receive);
      child.stderr.off("data", receive);
      child.off("exit", exit);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.once("exit", exit);
  });
}

async function stopProcess(
  child: ChildProcessWithoutNullStreams,
  signal: "SIGKILL" | "SIGTERM",
): Promise<void> {
  if (!running.delete(child) || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill(signal);
  await exited;
}

async function providerState(baseUrl: string): Promise<string> {
  const response = await fetch(new URL("/api/v1/session", baseUrl), {
    headers: {Authorization: `Bearer ${apiToken}`},
  });
  return z.object({
    capabilities: z.object({
      gitHistory: z.object({providerState: z.string()}).loose(),
    }).loose(),
  }).loose().parse(await response.json()).capabilities.gitHistory.providerState;
}

async function waitForAvailable(baseUrl: string): Promise<void> {
  await expect.poll(
    () => providerState(baseUrl),
    {interval: 1_000, timeout: 60_000},
  ).toBe("available");
}

async function setProjectGitHistory(baseUrl: string, enabled: boolean): Promise<void> {
  const response = await fetch(
    `${baseUrl}/api/v1/projects/${defaultProjectId}/git-history`,
    {
      body: JSON.stringify(enabled ? {confirmEstimate: true, enabled} : {enabled}),
      headers: mutationHeaders(`git-history-${String(enabled)}-${randomUUID()}`),
      method: "PUT",
    },
  );
  expect(response.status).toBe(200);
}

async function publishArtifactVersions(
  baseUrl: string,
  label: string,
  contents: readonly string[],
): Promise<void> {
  await sequentially(contents, async (content) => {
    const existing = artifacts.get(label) ?? [];
    const current = existing.at(-1);
    const bytes = new TextEncoder().encode(content);
    const createUpload = await fetch(`${baseUrl}/api/v1/uploads`, {
      body: JSON.stringify({
        entryPath: "index.html",
        files: [{
          mediaType: "text/html; charset=utf-8",
          path: "index.html",
          sha256: sha256(content),
          size: bytes.byteLength,
        }],
        projectId: defaultProjectId,
      }),
      headers: {Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json"},
      method: "POST",
    });
    expect(createUpload.status).toBeLessThan(300);
    const upload = uploadResponseSchema.parse(await createUpload.json());
    const planned = upload.files[0];
    if (planned === undefined) throw new Error("The upload plan omitted its file.");
    const uploaded = await fetch(planned.uploadUrl, {
      body: bytes,
      headers: {Authorization: `Bearer ${apiToken}`},
      method: "PUT",
    });
    expect(uploaded.ok).toBe(true);
    const target = current === undefined
      ? {accessSetting: "public_link", kind: "new_artifact", name: `Qualification ${label}`}
      : {
        artifactId: artifactId(label),
        expectedCurrentVersionId: current.id,
        kind: "new_version",
      };
    const committed = await fetch(upload.commitUrl, {
      body: JSON.stringify({target}),
      headers: mutationHeaders(`publish-${label}-${existing.length}-${runId}`),
      method: "POST",
    });
    expect(committed.status).toBe(201);
    const body = publishResponseSchema.parse(await committed.json());
    if (current === undefined) artifactIds.set(label, body.artifact.id);
    artifacts.set(label, [...existing, {
      content,
      id: body.version.id,
      number: body.version.number,
    }]);
  });
}

/** Run one step at a time where ordering is part of what is being proved. */
async function sequentially<T>(
  items: readonly T[],
  step: (item: T) => Promise<void>,
  index = 0,
): Promise<void> {
  const item = items[index];
  if (item === undefined) return;
  await step(item);
  await sequentially(items, step, index + 1);
}

const artifactIds = new Map<string, string>();

function artifactId(label: string): string {
  const id = artifactIds.get(label);
  if (id === undefined) throw new Error(`Artifact ${label} was not published.`);
  return id;
}

function artifactVersions(label: string): readonly PublishedVersion[] {
  return artifacts.get(label) ?? [];
}

function versionAt(label: string, index: number): PublishedVersion {
  const version = artifactVersions(label)[index];
  if (version === undefined) throw new Error(`${label} has no version ${index + 1}.`);
  return version;
}

async function mappingsFor(label: string): Promise<Mapping[]> {
  const rows = await sql(`
    SELECT artifact_id || '|' || version_id || '|' || commit_id
    FROM git_history_mappings
    WHERE installation_id = '${installationId}'
      AND artifact_id = '${artifactId(label)}' AND status = 'recorded'
  `);
  return rows.map((row) => {
    const [artifact = "", versionId = "", commitId = ""] = row.split("|");
    return {artifactId: artifact, commitId, versionId};
  });
}

async function waitForMappings(label: string, count: number): Promise<Mapping[]> {
  await expect.poll(
    async () => (await mappingsFor(label)).length,
    {interval: 1_000, timeout: 150_000},
  ).toBe(count);
  return mappingsFor(label);
}

function cloneTokenUrl(baseUrl: string, label: string): string {
  return `${baseUrl}/api/v1/projects/${defaultProjectId}/artifacts/${artifactId(label)}/history/clone-token`;
}

async function cloneCredential(
  baseUrl: string,
  label: string,
): Promise<{readonly remote: string; readonly token: string}> {
  const response = await fetch(cloneTokenUrl(baseUrl, label), {
    body: JSON.stringify({ttlSeconds: 60}),
    headers: mutationHeaders(`clone-${label}-${randomUUID()}`),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return z.object({remote: z.url(), token: z.string().min(1)}).loose()
    .parse(await response.json());
}

async function cloneHistory(baseUrl: string, label: string): Promise<string> {
  const tokenFile = path.join(workDirectory, "server.token");
  await writeFile(tokenFile, `${apiToken}\n`, {mode: 0o600});
  const directory = path.join(workDirectory, `${label}-${randomUUID().slice(0, 8)}`);
  const result = await runCli([
    "history", "clone", "--project", defaultProjectId, artifactId(label), directory,
    "--server", baseUrl, "--token-file", tokenFile,
  ]);
  expect(result).toMatchObject({exitCode: 0});
  clones += 1;
  return directory;
}

/** Each version maps to its own tag; main is one linear chain in version order. */
async function assertExactHistory(directory: string, label: string): Promise<void> {
  const mappings = await mappingsFor(label);
  const versions = artifactVersions(label).filter((version) =>
    mappings.some((mapping) => mapping.versionId === version.id));
  const chain = (await git(directory, ["rev-list", "--reverse", "--parents", "main"]))
    .trim().split("\n").map((line) => line.split(" "));
  const expected = versions.map((version, index) => ({
    commit: mappings.find((mapping) => mapping.versionId === version.id)?.commitId,
    copiedContent: Buffer.byteLength(version.content) <= fileCopyLimitBytes
      ? version.content
      : null,
    metadata: {
      artifactId: artifactId(label),
      installationId,
      projectId: defaultProjectId,
      versionId: version.id,
      versionNumber: version.number,
    },
    parents: index === 0 ? [] : [chain[index - 1]?.[0]],
    tagged: mappings.find((mapping) => mapping.versionId === version.id)?.commitId,
  }));
  const observed = await Promise.all(versions.map(async (version, index) => {
    const [commit, ...parents] = chain[index] ?? [];
    const tagged = (await git(directory, [
      "rev-parse", `refs/tags/v/${version.id}^{commit}`,
    ])).trim();
    const metadata = versionMetadataSchema.parse(JSON.parse(await git(directory, [
      "show", `${tagged}:.artifactserver/version.json`,
    ])));
    const files = (await git(directory, ["ls-tree", "--name-only", tagged])).split("\n");
    return {
      commit,
      copiedContent: files.includes("index.html")
        ? await git(directory, ["show", `${tagged}:index.html`])
        : null,
      metadata: {
        artifactId: metadata.artifactId,
        installationId: metadata.installationId,
        projectId: metadata.projectId,
        versionId: metadata.versionId,
        versionNumber: metadata.versionNumber,
      },
      parents,
      tagged,
    };
  }));
  expect(chain).toHaveLength(versions.length);
  expect(observed).toEqual(expected);
}

function git(directory: string, arguments_: readonly string[]): Promise<string> {
  return runProcess("git", ["-C", directory, ...arguments_], {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
  });
}

function gitWithToken(
  directory: string,
  token: string | null,
  arguments_: readonly string[],
): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_ASKPASS: "/usr/bin/false",
    GIT_TERMINAL_PROMPT: "0",
  };
  if (token !== null) {
    env["GIT_CONFIG_COUNT"] = "1";
    env["GIT_CONFIG_KEY_0"] = "http.extraHeader";
    env["GIT_CONFIG_VALUE_0"] = `Authorization: Bearer ${token}`;
  }
  return runProcess("git", ["-C", directory, ...arguments_], env);
}

async function runCli(
  arguments_: readonly string[],
): Promise<{readonly exitCode: number; readonly output: string}> {
  try {
    const output = await runProcess(process.execPath, [cli, ...arguments_], {
      ...serverEnvironment(environment.tokenFile),
    });
    return {exitCode: 0, output};
  } catch (cause) {
    return {exitCode: 1, output: cause instanceof Error ? cause.message : String(cause)};
  }
}

function runProcess(
  command: string,
  arguments_: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {env, stdio: ["ignore", "pipe", "pipe"]});
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (exitCode === 0) {
        resolve(out);
        return;
      }
      reject(new Error(`${path.basename(command)} exited with ${String(exitCode)}: ${err}${out}`));
    });
  });
}

async function sql(query: string): Promise<string[]> {
  const database = new URL(environment.databaseUrl).pathname.slice(1);
  const output = await runProcess("docker", [
    "exec", environment.postgresContainer,
    "psql", "-U", environment.postgresUser, "-d", database, "-At", "-c", query,
  ], process.env);
  return output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

async function cloudflare(
  pathname: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = (await readFile(environment.tokenFile, "utf8")).trim();
  return fetch(
    `https://api.cloudflare.com/client/v4/accounts/${environment.accountId}` +
      `/artifacts/namespaces/${namespace}/${pathname}`,
    {
      ...init,
      headers: {Accept: "application/json", Authorization: `Bearer ${token}`},
      signal: AbortSignal.timeout(15_000),
    },
  );
}

async function remoteRepositoryStatus(repositoryName: string): Promise<number> {
  const response = await cloudflare(`repos/${encodeURIComponent(repositoryName)}`);
  await response.body?.cancel();
  return response.status;
}

async function countNamespaceRepositories(): Promise<number> {
  const response = await cloudflare("repos");
  expect(response.status).toBe(200);
  const envelope = cloudflareEnvelopeSchema.parse(await response.json());
  return envelope.result_info?.total_count ??
    (Array.isArray(envelope.result) ? envelope.result.length : 0);
}

/** Exact-name safety net when the purge test did not run to completion. */
async function verifyOrRemoveRemainingRepositories(): Promise<SafetyNetResult | null> {
  if (environment === undefined) return null;
  const names = [...artifactIds.values()];
  const statuses = await Promise.all(names.map(remoteRepositoryStatus));
  const remaining = names.filter((_, index) => statuses[index] !== 404);
  const removals = await Promise.all(remaining.map(async (name) => {
    const response = await cloudflare(`repos/${encodeURIComponent(name)}`, {method: "DELETE"});
    await response.body?.cancel();
    return response.ok || response.status === 404 ? name : null;
  }));
  return {
    namespaceRepositoriesAtEnd: await countNamespaceRepositories(),
    namespaceRepositoriesAtStart,
    remainingAfterPurge: remaining.length,
    removedBySafetyNet: removals.filter((name) => name !== null),
  };
}

async function writeEvidence(): Promise<void> {
  if (environment === undefined) return;
  const mirrored = await sql(`
    SELECT count(*) FROM git_history_mappings WHERE installation_id = '${installationId}'
  `).catch(() => ["unknown"]);
  await writeFile(environment.evidencePath, `${JSON.stringify({
    accountId: environment.accountId,
    checks,
    cleanup,
    completedAt: new Date().toISOString(),
    costPosture: {
      clones,
      estimatedProviderOperations:
        "about 4 per mirrored version plus 2 per repository and 1 per clone",
      loadOrQuotaTesting: false,
      versionsMirrored: mirrored[0],
    },
    deployment: "single_server",
    installationId,
    limits: {fileCopyLimitBytes, maximumMirroredVersions, maximumRepositories},
    namespace,
    nodeVersion: process.version,
    runId,
    runtime: "compiled Node external-storage server, disposable pinned Postgres and MinIO",
    schemaVersion: 1,
    sourceCommit: environment.sourceCommit,
  }, null, 2)}\n`, "utf8");
}

function mutationHeaders(idempotencyKey: string): Headers {
  return new Headers({
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
    "Idempotency-Key": idempotencyKey.padEnd(16, "-"),
  });
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function managedTestKey(label: string): string {
  const id = createHash("sha256").update(`id:${label}`).digest("hex").slice(0, 32);
  const secret = createHash("sha256").update(`secret:${label}`).digest("base64url");
  return `as_key_key_${id}_${secret}`;
}
