import {randomBytes, randomUUID} from "node:crypto";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {CreateBucketCommand, S3Client} from "@aws-sdk/client-s3";
import {z} from "zod";

import {keycloakRealm} from "../keycloak-realm.js";
import {command, type CommandResult, waitForHttpReady} from "../release-commands.js";
import {
  packagedApplicationOrigin,
  packagedContentDomain,
  replicaClient,
  type ReplicaClient,
} from "./application-client.js";
import type {PrivateTeamIdentity} from "./identity-environment.js";
import type {PrivateTeamRuntime} from "./runtime.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const replicaCount = 2;
const bootstrapAdministrator = {
  email: "admin@example.test",
  password: "admin-keycloak-integration-only",
};
const sqlLiteralSafe = /^[A-Za-z0-9@._-]+$/u;
const portBindingSchema = z.array(z.object({
  NetworkSettings: z.object({
    Ports: z.record(z.string(), z.array(z.object({HostPort: z.string()})).nullable()),
  }),
})).length(1);

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `Run this suite through pnpm test:external-storage-compose; ${name} is missing.`,
    );
  }
  return value;
}

/** Drive two external-storage Compose replicas as one private-team runtime. */
export async function externalComposeRuntime(
  identity: PrivateTeamIdentity,
): Promise<PrivateTeamRuntime> {
  if (identity.network !== requiredEnvironment("ARTIFACT_SERVER_TEST_DOCKER_NETWORK")) {
    throw new Error("Keycloak must share the external-storage provider network.");
  }
  const workDirectory = await mkdtemp(path.join(tmpdir(), "artifact-server-private-team-"));
  const name = `private-team-external-${randomUUID().slice(0, 8)}`;
  const apiToken = `as_key_key_${randomUUID()}_${randomBytes(32).toString("base64url")}`;
  const databaseUrl = requiredEnvironment("ARTIFACT_SERVER_TEST_DOCKER_DATABASE_URL");
  const s3AccessKey = requiredEnvironment("ARTIFACT_SERVER_TEST_S3_ACCESS_KEY");
  const s3SecretKey = requiredEnvironment("ARTIFACT_SERVER_TEST_S3_SECRET_KEY");
  const secrets = {
    apiToken: path.join(workDirectory, "api-token"),
    databaseUrl: path.join(workDirectory, "database-url"),
    s3AccessKey: path.join(workDirectory, "s3-access-key-id"),
    s3SecretKey: path.join(workDirectory, "s3-secret-access-key"),
  };
  // Compose file secrets are bind mounts the non-root container must read;
  // the private 0700 parent directory protects them on the host.
  await Promise.all([
    writeFile(secrets.apiToken, `${apiToken}\n`, {mode: 0o644}),
    writeFile(secrets.databaseUrl, `${databaseUrl}\n`, {mode: 0o644}),
    writeFile(secrets.s3AccessKey, `${s3AccessKey}\n`, {mode: 0o644}),
    writeFile(secrets.s3SecretKey, `${s3SecretKey}\n`, {mode: 0o644}),
  ]);
  const bucket = name;
  await new S3Client({
    credentials: {accessKeyId: s3AccessKey, secretAccessKey: s3SecretKey},
    endpoint: requiredEnvironment("ARTIFACT_SERVER_TEST_S3_ENDPOINT"),
    forcePathStyle: true,
    region: "us-east-1",
  }).send(new CreateBucketCommand({Bucket: bucket}));
  const sensitive = [apiToken, databaseUrl, s3AccessKey, s3SecretKey, keycloakRealm.oidcClientSecret];
  const baseEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    ARTIFACT_SERVER_ALLOW_TEST_IMAGE_TAG: "true",
    ARTIFACT_SERVER_API_TOKEN_SECRET_FILE: secrets.apiToken,
    ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: bootstrapAdministrator.email,
    ARTIFACT_SERVER_CONTENT_DOMAIN: packagedContentDomain,
    ARTIFACT_SERVER_DATABASE_URL_SECRET_FILE: secrets.databaseUrl,
    ARTIFACT_SERVER_IDENTITY_CA_FILE: identity.caFile,
    ARTIFACT_SERVER_IMAGE: requiredEnvironment("ARTIFACT_SERVER_EXTERNAL_COMPOSE_IMAGE"),
    ARTIFACT_SERVER_INSTALLATION_ID: name,
    ARTIFACT_SERVER_OIDC_CLIENT_ID: keycloakRealm.oidcClientId,
    ARTIFACT_SERVER_OIDC_CLIENT_SECRET: keycloakRealm.oidcClientSecret,
    ARTIFACT_SERVER_OIDC_ISSUER: `${identity.keycloak.baseUrl}/realms/${keycloakRealm.name}`,
    ARTIFACT_SERVER_OIDC_SCOPES: keycloakRealm.scopes,
    ARTIFACT_SERVER_ORIGIN: packagedApplicationOrigin,
    ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS: "0",
    ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    ARTIFACT_SERVER_S3_ACCESS_KEY_ID_SECRET_FILE: secrets.s3AccessKey,
    ARTIFACT_SERVER_S3_BUCKET: bucket,
    ARTIFACT_SERVER_S3_ENDPOINT: requiredEnvironment("ARTIFACT_SERVER_TEST_DOCKER_S3_ENDPOINT"),
    ARTIFACT_SERVER_S3_FORCE_PATH_STYLE: "true",
    ARTIFACT_SERVER_S3_REGION: "us-east-1",
    ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY_SECRET_FILE: secrets.s3SecretKey,
    ARTIFACT_SERVER_SHUTDOWN_DEADLINE_MS: "5000",
    COMPOSE_PROJECT_NAME: name,
  };
  let migrated = false;
  let replicas: ReplicaClient[] = [];

  const compose = (
    arguments_: readonly string[],
    options: {readonly allowFailure?: boolean; readonly environment?: NodeJS.ProcessEnv; readonly extraFile?: string} = {},
  ): Promise<CommandResult> => command("docker", [
    "compose",
    "--file", requiredEnvironment("ARTIFACT_SERVER_EXTERNAL_COMPOSE_BASE_FILE"),
    "--file", requiredEnvironment("ARTIFACT_SERVER_EXTERNAL_COMPOSE_FILE"),
    "--file", requiredEnvironment("ARTIFACT_SERVER_EXTERNAL_COMPOSE_S3_SECRETS_FILE"),
    "--file", requiredEnvironment("ARTIFACT_SERVER_EXTERNAL_COMPOSE_TEST_FILE"),
    "--file", path.join(repositoryRoot, "packaging/compose/compose.identity-ca.yaml"),
    ...(options.extraFile === undefined ? [] : ["--file", options.extraFile]),
    ...arguments_,
  ], {
    allowFailure: options.allowFailure ?? false,
    environment: options.environment ?? baseEnvironment,
    sensitive,
  });

  const containerIds = async (environment?: NodeJS.ProcessEnv): Promise<readonly string[]> =>
    (await compose(["ps", "--all", "--quiet", "artifact-server"], environment === undefined ? {} : {environment}))
      .stdout.trim().split("\n").filter((value) => value !== "");

  const publishedPort = async (containerId: string): Promise<number | null> => {
    const inspection = portBindingSchema.parse(JSON.parse(
      (await command("docker", ["inspect", containerId])).stdout,
    ))[0];
    const hostPort = inspection?.NetworkSettings.Ports["8787/tcp"]?.[0]?.HostPort;
    return hostPort === undefined ? null : Number(hostPort);
  };

  const readinessOf = async (containerId: string): Promise<boolean> => {
    const port = await publishedPort(containerId);
    if (port === null) return false;
    return fetch(`http://127.0.0.1:${port}/ready`).then(
      (response) => response.status === 200,
      () => false,
    );
  };

  /** Wait until every replica has exited or restarted without ever reporting ready. */
  const observeReplicaRefusal = async (
    environment: NodeJS.ProcessEnv,
    extraFile?: string,
  ): Promise<string> => {
    const options = extraFile === undefined ? {environment} : {environment, extraFile};
    const ids = await containerIds(environment);
    if (ids.length === 0) throw new Error("No replica was created for the refused configuration.");
    const deadline = Date.now() + 60_000;
    for (;;) {
      // Every replica must fail; polling them is the observation under test.
      // eslint-disable-next-line no-await-in-loop
      const states = await Promise.all(ids.map(async (id) => {
        const inspected = await command("docker", [
          "inspect", "--format", "{{.State.Status}} {{.RestartCount}}", id,
        ]);
        const [status = "", restarts = "0"] = inspected.stdout.trim().split(" ");
        return {failed: status === "exited" || Number(restarts) > 0, ready: await readinessOf(id)};
      }));
      if (states.some((state) => state.ready)) {
        throw new Error("A refused configuration reported ready.");
      }
      if (states.every((state) => state.failed)) break;
      if (Date.now() > deadline) {
        throw new Error("A refused configuration neither exited nor restarted.");
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const logs = await Promise.all(ids.map((id) =>
      command("docker", ["logs", id], {allowFailure: true, sensitive})
    ));
    await compose(["down"], options);
    return logs.map((log) => `${log.stdout}\n${log.stderr}`).join("\n");
  };

  return {
    bootstrapAdministrator,
    deployment: "single_server",
    async destroy() {
      await compose(["down", "--volumes", "--remove-orphans"], {allowFailure: true});
      await rm(workDirectory, {force: true, recursive: true});
    },
    async expectStartupRefused(overrides) {
      const environment: NodeJS.ProcessEnv = {...baseEnvironment};
      const added: string[] = [];
      for (const [variable, value] of Object.entries(overrides)) {
        if (value === null) {
          delete environment[variable];
        } else {
          environment[variable] = value;
          added.push(variable);
        }
      }
      const overrideFile = path.join(workDirectory, `refusal-${randomUUID()}.yaml`);
      await writeFile(overrideFile, [
        "services:",
        "  artifact-server:",
        "    environment:",
        ...added.map((variable) => `      - ${variable}`),
        "",
      ].join("\n"));
      await compose(
        ["up", "--detach", "--scale", `artifact-server=${replicaCount}`, "artifact-server"],
        {environment, extraFile: overrideFile},
      );
      const message = await observeReplicaRefusal(environment, overrideFile);
      await rm(overrideFile, {force: true});
      return {kind: "process", message};
    },
    async expectLegacyApiTokenRefused(token) {
      const legacyFile = path.join(workDirectory, "legacy-api-token");
      await writeFile(legacyFile, `${token}\n`, {mode: 0o644});
      // The secret file path is read by Compose, not passed into the container.
      const environment = {...baseEnvironment, ARTIFACT_SERVER_API_TOKEN_SECRET_FILE: legacyFile};
      await compose(
        ["up", "--detach", "--scale", `artifact-server=${replicaCount}`, "artifact-server"],
        {environment},
      );
      const message = await observeReplicaRefusal(environment);
      await rm(legacyFile, {force: true});
      return {kind: "process", message};
    },
    async externalIdentityCount(email) {
      // psql does not interpolate variables in --command; both values are
      // test-chosen, so a strict character check makes inlining them safe.
      if (!sqlLiteralSafe.test(email) || !sqlLiteralSafe.test(name)) {
        throw new Error("The identity lookup received an unexpected character.");
      }
      const result = await command("docker", [
        "exec",
        requiredEnvironment("ARTIFACT_SERVER_TEST_POSTGRES_CONTAINER"),
        "psql",
        "--username", requiredEnvironment("ARTIFACT_SERVER_TEST_POSTGRES_USER"),
        "--tuples-only", "--no-align",
        "--command",
        `SELECT count(*) FROM external_identities WHERE installation_id = '${name}' AND lower(email) = lower('${email}')`,
      ]);
      return z.coerce.number().int().nonnegative().parse(result.stdout.trim());
    },
    get replicas() {
      return replicas;
    },
    serviceKey: apiToken,
    async start() {
      if (!migrated) {
        await compose(["run", "--rm", "--no-deps", "artifact-server", "migrate", "apply"]);
        migrated = true;
      }
      await compose([
        "up", "--detach", "--scale", `artifact-server=${replicaCount}`,
        "--wait", "--wait-timeout", "60", "artifact-server",
      ]);
      const ids = await containerIds();
      if (new Set(ids).size !== replicaCount) {
        throw new Error(`Expected ${replicaCount} distinct replicas, found ${ids.length}.`);
      }
      const ports = await Promise.all(ids.map(async (id) => {
        const port = await publishedPort(id);
        if (port === null) throw new Error(`Replica ${id} has no published test port.`);
        return port;
      }));
      await Promise.all(ports.map((port) =>
        waitForHttpReady(`http://127.0.0.1:${port}/ready`, Date.now() + 60_000)
      ));
      replicas = ports.map((port) => replicaClient(port));
    },
    async startupLogs() {
      return (await compose(["logs", "--no-color", "artifact-server"])).stdout;
    },
    async stop() {
      await compose(["down"], {allowFailure: true});
      replicas = [];
    },
    async strayCredentials() {
      return [];
    },
    target: "external-compose",
  };
}
