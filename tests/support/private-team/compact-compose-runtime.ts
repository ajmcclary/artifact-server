import {randomBytes, randomUUID} from "node:crypto";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {z} from "zod";

import {keycloakRealm} from "../keycloak-realm.js";
import {
  availablePort,
  command,
  type CommandResult,
  waitForHttpReady,
} from "../release-commands.js";
import {
  packagedApplicationOrigin,
  packagedContentDomain,
  replicaClient,
  type ReplicaClient,
} from "./application-client.js";
import type {PrivateTeamIdentity} from "./identity-environment.js";
import type {PrivateTeamRuntime} from "./runtime.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const dataDirectory = "/var/lib/artifact-server/data";
const bootstrapAdministrator = {
  email: "admin@example.test",
  password: "admin-keycloak-integration-only",
};
const containerStateSchema = z.object({
  restartCount: z.coerce.number().int().nonnegative(),
  status: z.string(),
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Run this suite through pnpm test:compact-compose; ${name} is missing.`);
  }
  return value;
}

/** Drive the compact Compose package as a private-team runtime. */
export async function compactComposeRuntime(
  identity: PrivateTeamIdentity,
): Promise<PrivateTeamRuntime> {
  const workDirectory = await mkdtemp(path.join(tmpdir(), "artifact-server-private-team-"));
  const networkOverride = path.join(workDirectory, "identity-network.yaml");
  await writeFile(networkOverride, [
    "services:",
    "  artifact-server:",
    "    networks: [default, identity]",
    "networks:",
    "  identity:",
    `    name: ${JSON.stringify(identity.network)}`,
    "    external: true",
    "",
  ].join("\n"));
  const projectName = `private-team-compact-${randomUUID().slice(0, 8)}`;
  const port = await availablePort();
  const legacyBootstrapCredential = randomBytes(32).toString("base64url");
  const sensitive = [legacyBootstrapCredential, keycloakRealm.oidcClientSecret];
  const baseEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    ARTIFACT_SERVER_ALLOW_TEST_IMAGE_TAG: "true",
    ARTIFACT_SERVER_CONTENT_DOMAIN: packagedContentDomain,
    ARTIFACT_SERVER_IDENTITY_CA_FILE: identity.caFile,
    ARTIFACT_SERVER_IMAGE: requiredEnvironment("ARTIFACT_SERVER_COMPOSE_IMAGE"),
    ARTIFACT_SERVER_OIDC_CLIENT_ID: keycloakRealm.oidcClientId,
    ARTIFACT_SERVER_OIDC_CLIENT_SECRET: keycloakRealm.oidcClientSecret,
    ARTIFACT_SERVER_OIDC_ISSUER: `${identity.keycloak.baseUrl}/realms/${keycloakRealm.name}`,
    ARTIFACT_SERVER_OIDC_SCOPES: keycloakRealm.scopes,
    ARTIFACT_SERVER_ORIGIN: packagedApplicationOrigin,
    ARTIFACT_SERVER_PORT: String(port),
    ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS: "0",
    ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    ARTIFACT_SERVER_SHUTDOWN_DEADLINE_MS: "5000",
    COMPOSE_PROJECT_NAME: projectName,
  };
  let serviceKey = "";
  let initialized = false;

  const compose = (
    arguments_: readonly string[],
    options: {readonly allowFailure?: boolean; readonly environment?: NodeJS.ProcessEnv; readonly extraFile?: string} = {},
  ): Promise<CommandResult> => command("docker", [
    "compose",
    "--file", requiredEnvironment("ARTIFACT_SERVER_COMPOSE_FILE"),
    "--file", path.join(repositoryRoot, "packaging/compose/compose.identity-ca.yaml"),
    "--file", networkOverride,
    ...(options.extraFile === undefined ? [] : ["--file", options.extraFile]),
    ...arguments_,
  ], {
    allowFailure: options.allowFailure ?? false,
    environment: options.environment ?? baseEnvironment,
    sensitive: [...sensitive, serviceKey],
  });

  const shellInVolume = (script: string): Promise<CommandResult> => compose([
    "run", "--rm", "--no-deps", "--entrypoint", "/bin/sh", "artifact-server", "-c", script,
  ]);

  const initialize = async (): Promise<void> => {
    await compose([
      "run", "--rm", "--no-deps", "artifact-server", "init",
      "--admin-email", bootstrapAdministrator.email,
      "--data", dataDirectory,
    ]);
    // A compact installation migrated from local-owner mode may still carry
    // its old browser-bootstrap credential; private-team mode must ignore it.
    await shellInVolume(
      `umask 077 && printf %s '${legacyBootstrapCredential}' > ${dataDirectory}/secrets/browser-bootstrap-token`,
    );
    serviceKey = (await shellInVolume(`cat ${dataDirectory}/secrets/api-token`)).stdout.trim();
    initialized = true;
  };

  const containerId = async (): Promise<string> =>
    (await compose(["ps", "--all", "--quiet", "artifact-server"])).stdout.trim();

  const replicas: readonly ReplicaClient[] = [replicaClient(port)];

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
      for (const [name, value] of Object.entries(overrides)) {
        if (value === null) {
          delete environment[name];
        } else {
          environment[name] = value;
          added.push(name);
        }
      }
      // compose.yaml passes only named variables; carry the rest explicitly.
      const overrideFile = path.join(workDirectory, `refusal-${randomUUID()}.yaml`);
      await writeFile(overrideFile, [
        "services:",
        "  artifact-server:",
        "    environment:",
        ...added.map((name) => `      - ${name}`),
        "",
      ].join("\n"));
      await compose(["up", "--detach", "artifact-server"], {environment, extraFile: overrideFile});
      const id = await containerId();
      const deadline = Date.now() + 60_000;
      for (;;) {
        // Polling the container is the observation under test.
        // eslint-disable-next-line no-await-in-loop
        const inspected = await command("docker", [
          "inspect", "--format", "{{json .State.Status}} {{.RestartCount}}", id,
        ]);
        const [status = "", restartCount = "0"] = inspected.stdout.trim().split(" ");
        const state = containerStateSchema.parse({restartCount, status: JSON.parse(status)});
        // eslint-disable-next-line no-await-in-loop
        const ready = await fetch(`http://127.0.0.1:${port}/ready`).then(
          (response) => response.status === 200,
          () => false,
        );
        if (ready) throw new Error("A refused configuration reported ready.");
        if (state.status === "exited" || state.restartCount > 0) break;
        if (Date.now() > deadline) throw new Error("The refused configuration neither exited nor restarted.");
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const logs = await command("docker", ["logs", id], {allowFailure: true, sensitive});
      await compose(["down"], {environment, extraFile: overrideFile});
      await rm(overrideFile, {force: true});
      return `${logs.stdout}\n${logs.stderr}`;
    },
    async externalIdentityCount(email) {
      const script = [
        "const {DatabaseSync} = require('node:sqlite');",
        `const database = new DatabaseSync(${JSON.stringify(`${dataDirectory}/artifact-server.db`)}, {readOnly: true});`,
        "const row = database.prepare('SELECT count(*) AS total FROM external_identities WHERE lower(email) = lower(?)').get(process.argv[1]);",
        "process.stdout.write(String(row.total));",
      ].join(" ");
      const result = await compose(["exec", "-T", "artifact-server", "node", "-e", script, email]);
      return z.coerce.number().int().nonnegative().parse(result.stdout.trim());
    },
    replicas,
    get serviceKey() {
      return serviceKey;
    },
    async start() {
      if (!initialized) await initialize();
      await compose(["up", "--detach", "--wait", "--wait-timeout", "60", "artifact-server"]);
      await waitForHttpReady(`http://127.0.0.1:${port}/ready`, Date.now() + 60_000);
    },
    async startupLogs() {
      return (await compose(["logs", "--no-color", "artifact-server"])).stdout;
    },
    async stop() {
      await compose(["down"], {allowFailure: true});
    },
    async strayCredentials() {
      return [{name: "migrated compact browser-bootstrap credential", token: legacyBootstrapCredential}];
    },
    target: "compact-compose",
  };
}
