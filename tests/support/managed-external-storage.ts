import {type ChildProcessWithoutNullStreams, spawn} from "node:child_process";
import {createHash, randomBytes} from "node:crypto";
import * as path from "node:path";

/**
 * Support for opt-in live tests that run the compiled external-storage server
 * against managed providers (a hosted Postgres URL and a real object-storage
 * bucket) instead of the pinned local containers. Credentials come from the
 * environment the operator exports (AWS provider chain via AWS_PROFILE); this
 * module never reads credential files itself.
 */
export interface ManagedExternalStorageEnvironment {
  readonly databaseUrl: string;
  readonly s3Bucket: string;
  readonly s3Region: string;
}

export interface ManagedExternalStorageProcess {
  readonly baseUrl: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly stop: () => Promise<void>;
}

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const externalStorageCli = path.join(repositoryRoot, "dist/cli/main.js");

/**
 * Read the managed-provider environment, or return undefined so callers can
 * skip. Requires ARTIFACT_SERVER_TEST_DATABASE_URL and
 * ARTIFACT_SERVER_TEST_S3_BUCKET; ARTIFACT_SERVER_TEST_S3_REGION defaults to
 * us-east-1. Object-storage credentials are deliberately NOT read here: the
 * spawned server must resolve them through the provider chain.
 */
export function readManagedExternalStorageEnvironment():
  | ManagedExternalStorageEnvironment
  | undefined {
  const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  const s3Bucket = process.env["ARTIFACT_SERVER_TEST_S3_BUCKET"];
  if (databaseUrl === undefined || s3Bucket === undefined) return undefined;
  return {
    databaseUrl,
    s3Bucket,
    s3Region: process.env["ARTIFACT_SERVER_TEST_S3_REGION"] ?? "us-east-1",
  };
}

/** A run-scoped installation ID keeps live-provider rows and blobs isolated. */
export function managedRunInstallationId(label: string): string {
  const stamp = Date.now().toString(36);
  const random = randomBytes(6).toString("hex");
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/gu, "-").slice(0, 24);
  return `live-${slug}-${stamp}-${random}`;
}

/** Generate a bootstrap API token in the managed-key credential format. */
export function managedBootstrapToken(label: string): string {
  const id = createHash("sha256").update(`id:${label}`).digest("hex").slice(0, 32);
  const secret = createHash("sha256")
    .update(`secret:${label}:${randomBytes(8).toString("hex")}`)
    .digest("base64url");
  return `as_key_key_${id}_${secret}`;
}

/**
 * Spawn `dist/cli/main.js start-external-storage` against the managed
 * environment. No static S3 credentials are passed, so the server resolves
 * them from the AWS provider chain inherited from the operator environment
 * (for example AWS_PROFILE). Resolves once the readiness line is printed.
 */
export function startManagedExternalStorageProcess(input: {
  readonly environment: ManagedExternalStorageEnvironment;
  readonly apiToken: string;
  readonly installationId: string;
  readonly oidcIssuer: string;
  readonly readinessTimeoutMilliseconds?: number;
}): Promise<ManagedExternalStorageProcess> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ARTIFACT_SERVER_API_TOKEN: input.apiToken,
    ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "administrator@example.test",
    ARTIFACT_SERVER_CONTENT_DOMAIN: "content.example.net",
    ARTIFACT_SERVER_DATABASE_URL: input.environment.databaseUrl,
    ARTIFACT_SERVER_INSTALLATION_ID: input.installationId,
    ARTIFACT_SERVER_OIDC_CLIENT_ID: "managed-external-storage-live",
    ARTIFACT_SERVER_OIDC_ISSUER: input.oidcIssuer,
    ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.com",
    ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS: "0",
    ARTIFACT_SERVER_S3_BUCKET: input.environment.s3Bucket,
    ARTIFACT_SERVER_S3_FORCE_PATH_STYLE: "false",
    ARTIFACT_SERVER_S3_REGION: input.environment.s3Region,
  };
  // The operator environment may select another browser-login provider or
  // static object-storage credentials; the test owns those choices.
  delete environment["ARTIFACT_SERVER_WORKOS_API_KEY"];
  delete environment["ARTIFACT_SERVER_WORKOS_CLIENT_ID"];
  delete environment["ARTIFACT_SERVER_WORKOS_ISSUER"];
  delete environment["ARTIFACT_SERVER_S3_ACCESS_KEY_ID"];
  delete environment["ARTIFACT_SERVER_S3_ACCESS_KEY_ID_FILE"];
  delete environment["ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY"];
  delete environment["ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY_FILE"];
  const child = spawn(
    process.execPath,
    [externalStorageCli, "start-external-storage", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  return waitForReadiness(
    child,
    input.readinessTimeoutMilliseconds ?? 30_000,
  );
}

function waitForReadiness(
  child: ChildProcessWithoutNullStreams,
  timeoutMilliseconds: number,
): Promise<ManagedExternalStorageProcess> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Managed external-storage process not ready: ${output}`));
    }, timeoutMilliseconds);
    const receive = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = /Artifact Server \(external-storage\): (http:\/\/127\.0\.0\.1:\d+)/u.exec(
        output,
      );
      if (match?.[1] === undefined) return;
      cleanup();
      resolve({
        baseUrl: match[1],
        child,
        stop: () => stopManagedProcess(child),
      });
    };
    const exit = () => {
      cleanup();
      reject(new Error(`Managed external-storage process exited early: ${output}`));
    };
    const cleanup = () => {
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

/** True once the child has exited, whether by code or by signal. */
export function managedProcessExited(
  child: ChildProcessWithoutNullStreams,
): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function stopManagedProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (managedProcessExited(child)) return;
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  if (
    await Promise.race([exited.then(() => "exit" as const), deadline(20_000)]) ===
      "timeout"
  ) {
    child.kill("SIGKILL");
    await Promise.race([exited, deadline(5_000)]);
  }
}

function deadline(milliseconds: number): Promise<"timeout"> {
  return new Promise((resolve) => {
    setTimeout(() => resolve("timeout"), milliseconds);
  });
}
