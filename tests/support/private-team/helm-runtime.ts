import {type ChildProcess, execFile} from "node:child_process";
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

const kindNodeImage = "kindest/node:v1.36.1@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5";
const postgresImage = "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94";
const minioImage = "docker.io/pgsty/silo@sha256:b616a0cf8cb281e7e6bb3c9b1fb53875b4016a2878223925541c18f82d6c5ca3";
const postgresUser = "artifactserver";
const postgresPassword = "artifactserver-helm-integration-only";
const postgresDatabase = "artifactserver";
const minioAccessKey = "artifactserver";
const minioSecretKey = "artifactserver-helm-minio-integration-only";
const namespace = "artifact-server-team";
const release = "artifact-server";
const secretName = "artifact-server-runtime";
const caConfigMap = "identity-ca";
const installationId = "helm-private-team";
const bootstrapAdministrator = {
  email: "admin@example.test",
  password: "admin-keycloak-integration-only",
};
const sqlLiteralSafe = /^[A-Za-z0-9@._-]+$/u;
const podListSchema = z.object({
  items: z.array(z.object({
    metadata: z.object({name: z.string()}),
    spec: z.object({nodeName: z.string().optional()}),
    status: z.object({
      conditions: z.array(z.object({status: z.string(), type: z.string()})).optional(),
      containerStatuses: z.array(z.object({restartCount: z.number().int()})).optional(),
    }),
  })),
});
const corednsSchema = z.object({data: z.object({Corefile: z.string()})}).loose();

type ApplicationPod = z.infer<typeof podListSchema>["items"][number];

/** The chart's identity values this driver varies. */
interface IdentityValues {
  readonly oidcClientId: string;
  readonly oidcIssuer: string;
  readonly oidcScopes: string;
  readonly workosClientId: string;
  readonly workosIssuer: string;
}

/** Which identity value each environment variable maps to in the chart. */
const chartValueForVariable = new Map<string, keyof IdentityValues>([
  ["ARTIFACT_SERVER_OIDC_CLIENT_ID", "oidcClientId"],
  ["ARTIFACT_SERVER_OIDC_ISSUER", "oidcIssuer"],
  ["ARTIFACT_SERVER_OIDC_SCOPES", "oidcScopes"],
  ["ARTIFACT_SERVER_WORKOS_CLIENT_ID", "workosClientId"],
  ["ARTIFACT_SERVER_WORKOS_ISSUER", "workosIssuer"],
]);

function isReadyPod(pod: ApplicationPod): boolean {
  return pod.status.conditions?.some((condition) =>
    condition.type === "Ready" && condition.status === "True"
  ) === true;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Run this suite through pnpm test:helm; ${name} is missing.`);
  }
  return value;
}

interface PodForward {
  readonly child: ChildProcess;
  readonly port: number;
}

function forwardPod(pod: string): Promise<PodForward> {
  return new Promise((resolve, reject) => {
    const child = execFile("kubectl", [
      "--namespace", namespace,
      "port-forward", `pod/${pod}`,
      "0:8787",
      "--address", "127.0.0.1",
    ]);
    let output = "";
    let settled = false;
    const inspect = (chunk: string): void => {
      output += chunk;
      const port = /Forwarding from 127\.0\.0\.1:(\d+) -> 8787/u.exec(output)?.[1];
      if (settled || port === undefined) return;
      settled = true;
      resolve({child, port: Number(port)});
    };
    child.stdout?.on("data", (chunk: Buffer) => inspect(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => inspect(chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`kubectl port-forward pod/${pod} exited with ${code}: ${output}`));
    });
  });
}

async function stopForward(forward: PodForward): Promise<void> {
  if (forward.child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => forward.child.once("exit", () => resolve()));
  forward.child.kill("SIGTERM");
  await exited;
}

/** Drive a two-replica Helm installation on its own kind cluster as one private-team runtime. */
export async function helmRuntime(identity: PrivateTeamIdentity): Promise<PrivateTeamRuntime> {
  const clusterName = `${requiredEnvironment("ARTIFACT_SERVER_HELM_CLUSTER_NAME")}-team`;
  const postgresContainer = `${clusterName}-postgres`;
  const minioContainer = `${clusterName}-minio`;
  const workDirectory = await mkdtemp(path.join(tmpdir(), "artifact-server-private-team-"));
  const valuesPath = path.join(workDirectory, "values.json");
  const apiToken = `as_key_key_${randomUUID()}_${randomBytes(32).toString("base64url")}`;
  const bucket = `artifact-server-team-${randomUUID()}`;
  const sensitive = [apiToken, postgresPassword, minioSecretKey, keycloakRealm.oidcClientSecret];
  let forwards: PodForward[] = [];
  let replicas: ReplicaClient[] = [];
  let provisioned = false;

  const run = (
    executable: string,
    arguments_: readonly string[],
    allowFailure = false,
  ): Promise<CommandResult> => command(executable, arguments_, {allowFailure, sensitive});
  const kubectl = (arguments_: readonly string[], allowFailure = false) =>
    run("kubectl", ["--context", `kind-${clusterName}`, ...arguments_], allowFailure);
  const helm = (arguments_: readonly string[], allowFailure = false) =>
    run("helm", ["--kube-context", `kind-${clusterName}`, ...arguments_], allowFailure);
  const containerIp = async (container: string): Promise<string> =>
    (await run("docker", [
      "inspect", "--format", "{{(index .NetworkSettings.Networks \"kind\").IPAddress}}", container,
    ])).stdout.trim();

  const writeValues = async (identityValues: IdentityValues): Promise<void> => {
    const minioIp = await containerIp(minioContainer);
    await writeFile(valuesPath, `${JSON.stringify({
      configuration: {
        applicationOrigin: packagedApplicationOrigin,
        bootstrapAdministratorEmail: bootstrapAdministrator.email,
        contentDomain: packagedContentDomain,
        installationId,
        postgresConnectionBudget: 22,
        readinessWithdrawalMilliseconds: 0,
        requestLogSampleRate: 0,
        s3: {bucket, endpoint: `http://${minioIp}:9000`, forcePathStyle: true, region: "us-east-1"},
        shutdownDeadlineMilliseconds: 5_000,
      },
      deployment: {minReadySeconds: 0, revisionHistoryLimit: 3, rolloutRevision: randomUUID()},
      identity: {
        ...identityValues,
        trustedCertificateAuthorities: {configMapName: caConfigMap, key: "ca.crt"},
      },
      image: {
        allowMutableTag: true,
        digest: "",
        pullPolicy: "IfNotPresent",
        repository: requiredEnvironment("ARTIFACT_SERVER_HELM_IMAGE_REPOSITORY"),
        tag: requiredEnvironment("ARTIFACT_SERVER_HELM_IMAGE_TAG"),
      },
      migration: {activeDeadlineSeconds: 120, backoffLimit: 0, enabled: true},
      probes: {
        liveness: {failureThreshold: 3, periodSeconds: 5, timeoutSeconds: 1},
        readiness: {failureThreshold: 1, periodSeconds: 1, timeoutSeconds: 1},
        startup: {failureThreshold: 60, periodSeconds: 1, timeoutSeconds: 1},
      },
      replicaCount: 2,
      secret: {
        keys: {
          apiToken: "api-token",
          databaseUrl: "database-url",
          oidcClientSecret: identityValues.oidcClientId === "" ? "" : "oidc-client-secret",
          s3AccessKeyId: "s3-access-key-id",
          s3SecretAccessKey: "s3-secret-access-key",
          // A WorkOS client is complete only with its API key; naming the key
          // lets the chart reach its one-provider rule instead of a partial-family one.
          workosApiKey: identityValues.workosClientId === "" ? "" : "workos-api-key",
        },
        name: secretName,
        rolloutChecksum: randomUUID(),
      },
      terminationGracePeriodSeconds: 15,
    }, null, 2)}\n`);
  };

  const oidcValues: IdentityValues = {
    oidcClientId: keycloakRealm.oidcClientId,
    oidcIssuer: `${identity.keycloak.baseUrl}/realms/${keycloakRealm.name}`,
    oidcScopes: keycloakRealm.scopes,
    workosClientId: "",
    workosIssuer: "",
  };

  const provision = async (): Promise<void> => {
    await run("kind", [
      "create", "cluster",
      "--name", clusterName,
      "--image", kindNodeImage,
      "--config", requiredEnvironment("ARTIFACT_SERVER_HELM_KIND_CONFIG"),
      "--wait", "240s",
    ]);
    await run("kind", ["load", "docker-image", requiredEnvironment("ARTIFACT_SERVER_HELM_IMAGE"), "--name", clusterName]);
    await run("docker", [
      "run", "--detach", "--name", postgresContainer,
      "--env", `POSTGRES_USER=${postgresUser}`,
      "--env", `POSTGRES_PASSWORD=${postgresPassword}`,
      "--env", `POSTGRES_DB=${postgresDatabase}`,
      "--network", "kind", postgresImage,
    ]);
    await run("docker", [
      "run", "--detach", "--name", minioContainer,
      "--env", `MINIO_ROOT_USER=${minioAccessKey}`,
      "--env", `MINIO_ROOT_PASSWORD=${minioSecretKey}`,
      "--network", "kind", "--publish", "127.0.0.1::9000",
      minioImage, "server", "/data",
    ]);
    // Pods reach the identity provider by its issuer hostname on the kind network.
    await run("docker", [
      "network", "connect", "--alias", identity.host, "kind", identity.container,
    ]);
    const keycloakIp = await containerIp(identity.container);
    const coredns = corednsSchema.parse(JSON.parse((await kubectl([
      "--namespace", "kube-system", "get", "configmap", "coredns", "--output", "json",
    ])).stdout));
    const corefile = coredns.data.Corefile.replace(
      /^(\s*)ready\b/mu,
      `$1hosts {\n$1   ${keycloakIp} ${identity.host}\n$1   fallthrough\n$1}\n$1ready`,
    );
    if (corefile === coredns.data.Corefile) throw new Error("CoreDNS has no ready directive to anchor on.");
    const patchedConfig = path.join(workDirectory, "coredns.json");
    await writeFile(patchedConfig, JSON.stringify({...coredns, data: {...coredns.data, Corefile: corefile}}));
    await kubectl(["apply", "--filename", patchedConfig]);
    await kubectl(["--namespace", "kube-system", "rollout", "restart", "deployment/coredns"]);
    await kubectl(["--namespace", "kube-system", "rollout", "status", "deployment/coredns", "--timeout", "120s"]);

    const deadline = Date.now() + 60_000;
    for (;;) {
      // Postgres must accept connections before the migration Job runs.
      // eslint-disable-next-line no-await-in-loop
      const ready = await run("docker", [
        "exec", postgresContainer, "pg_isready", "--username", postgresUser, "--dbname", postgresDatabase,
      ], true);
      if (ready.exitCode === 0) break;
      if (Date.now() > deadline) throw new Error("Postgres did not become ready.");
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const minioPort = (await run("docker", ["port", minioContainer, "9000/tcp"])).stdout
      .split("\n").map((line) => /^127\.0\.0\.1:(\d+)$/u.exec(line.trim())?.[1]).find((port) => port !== undefined);
    if (minioPort === undefined) throw new Error("MinIO did not publish a loopback port.");
    await waitForHttpReady(`http://127.0.0.1:${minioPort}/minio/health/ready`, Date.now() + 60_000);
    const s3 = new S3Client({
      credentials: {accessKeyId: minioAccessKey, secretAccessKey: minioSecretKey},
      endpoint: `http://127.0.0.1:${minioPort}`,
      forcePathStyle: true,
      region: "us-east-1",
    });
    await s3.send(new CreateBucketCommand({Bucket: bucket}));
    s3.destroy();

    const postgresIp = await containerIp(postgresContainer);
    await kubectl(["create", "namespace", namespace]);
    await kubectl([
      "--namespace", namespace, "create", "secret", "generic", secretName,
      "--from-literal", `api-token=${apiToken}`,
      "--from-literal", `database-url=postgresql://${postgresUser}:${postgresPassword}@${postgresIp}:5432/${postgresDatabase}`,
      "--from-literal", `oidc-client-secret=${keycloakRealm.oidcClientSecret}`,
      "--from-literal", `s3-access-key-id=${minioAccessKey}`,
      "--from-literal", `s3-secret-access-key=${minioSecretKey}`,
    ]);
    await kubectl([
      "--namespace", namespace, "create", "configmap", caConfigMap,
      "--from-file", `ca.crt=${identity.caFile}`,
    ]);
    provisioned = true;
  };

  const applicationPods = async (): Promise<readonly ApplicationPod[]> => {
    const result = await kubectl([
      "--namespace", namespace, "get", "pods",
      "--selector", `app.kubernetes.io/instance=${release},app.kubernetes.io/name=artifact-server`,
      "--output", "json",
    ], true);
    if (result.exitCode !== 0) return [];
    return podListSchema.parse(JSON.parse(result.stdout)).items
      .filter((pod) => !pod.metadata.name.endsWith("-test-ready"));
  };

  const install = async (identityValues: IdentityValues, wait: boolean): Promise<CommandResult> => {
    await writeValues(identityValues);
    return helm([
      "upgrade", "--install", release, requiredEnvironment("ARTIFACT_SERVER_HELM_CHART"),
      "--namespace", namespace,
      "--values", valuesPath,
      ...(wait ? ["--wait", "--timeout", "240s"] : []),
    ], !wait);
  };

  const closeForwards = async (): Promise<void> => {
    await Promise.all(forwards.map(stopForward));
    forwards = [];
    replicas = [];
  };

  const uninstall = async (): Promise<void> => {
    await closeForwards();
    await helm(["uninstall", release, "--namespace", namespace, "--wait"], true);
  };

  return {
    bootstrapAdministrator,
    deployment: "kubernetes",
    async destroy() {
      await closeForwards();
      await run("docker", ["network", "disconnect", "kind", identity.container], true);
      await run("kind", ["delete", "cluster", "--name", clusterName], true);
      await run("docker", ["rm", "--force", postgresContainer, minioContainer], true);
      await rm(workDirectory, {force: true, recursive: true});
    },
    async expectStartupRefused(overrides) {
      const chartOverrides = new Map<keyof IdentityValues, string>();
      for (const [variable, value] of Object.entries(overrides)) {
        // The client secret lives in the runtime Secret, keyed off the client ID.
        if (variable === "ARTIFACT_SERVER_OIDC_CLIENT_SECRET") continue;
        const key = chartValueForVariable.get(variable);
        if (key === undefined) {
          // The chart exposes no value that sets this variable on the pods.
          return {kind: "unconfigurable", variable};
        }
        chartOverrides.set(key, value ?? "");
      }
      const identityValues: IdentityValues = {
        oidcClientId: chartOverrides.get("oidcClientId") ?? oidcValues.oidcClientId,
        oidcIssuer: chartOverrides.get("oidcIssuer") ?? oidcValues.oidcIssuer,
        oidcScopes: chartOverrides.get("oidcScopes") ?? oidcValues.oidcScopes,
        workosClientId: chartOverrides.get("workosClientId") ?? oidcValues.workosClientId,
        workosIssuer: chartOverrides.get("workosIssuer") ?? oidcValues.workosIssuer,
      };
      const rendered = await install(identityValues, false);
      if (rendered.exitCode !== 0) {
        return {kind: "chart", message: `${rendered.stdout}\n${rendered.stderr}`};
      }
      throw new Error("The chart rendered a refused identity configuration.");
    },
    async externalIdentityCount(email) {
      if (!sqlLiteralSafe.test(email)) throw new Error("The identity lookup received an unexpected character.");
      const result = await run("docker", [
        "exec", postgresContainer,
        "psql", "--username", postgresUser, "--dbname", postgresDatabase,
        "--tuples-only", "--no-align", "--command",
        `SELECT count(*) FROM external_identities WHERE installation_id = '${installationId}' AND lower(email) = lower('${email}')`,
      ]);
      return z.coerce.number().int().nonnegative().parse(result.stdout.trim());
    },
    get replicas() {
      return replicas;
    },
    serviceKey: apiToken,
    async start() {
      if (!provisioned) await provision();
      await install(oidcValues, true);
      const deadline = Date.now() + 120_000;
      let pods = await applicationPods();
      while (pods.filter(isReadyPod).length !== 2) {
        if (Date.now() > deadline) throw new Error("Two application pods did not become ready.");
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 500));
        // eslint-disable-next-line no-await-in-loop
        pods = await applicationPods();
      }
      const ready = pods.filter(isReadyPod);
      if (new Set(ready.map((pod) => pod.spec.nodeName)).size !== 2) {
        throw new Error("The two replicas share a node; cross-replica proof needs two processes on two nodes.");
      }
      forwards = await Promise.all(ready.map((pod) => forwardPod(pod.metadata.name)));
      await Promise.all(forwards.map((forward) =>
        waitForHttpReady(`http://127.0.0.1:${forward.port}/ready`, Date.now() + 60_000)
      ));
      replicas = forwards.map((forward) => replicaClient(forward.port));
    },
    async startupLogs() {
      const pods = await applicationPods();
      const logs = await Promise.all(pods.map((pod) =>
        kubectl(["--namespace", namespace, "logs", pod.metadata.name], true)
      ));
      return logs.map((log) => `${log.stdout}\n${log.stderr}`).join("\n");
    },
    async stop() {
      await uninstall();
    },
    async strayCredentials() {
      return [];
    },
    target: "helm",
  };
}
