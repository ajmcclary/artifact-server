import {execFile, spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {DatabaseSync} from "node:sqlite";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

import {expect, test} from "vitest";
import {z} from "zod";

import {
  defaultGitHistoryFileCopyBytes,
  defaultGitHistoryVersionCopyBytes,
} from "../../src/git-history/git-history-capability.js";
import {SqliteArtifactRepository} from
  "../../src/storage/sqlite-artifact-repository.js";
import {startGitSmartHttpServer} from "../support/git-smart-http-server.js";
import {publishNew} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
} from "../support/runtime-harness.js";

const execute = promisify(execFile);
const passSchema = z.object({
  claimed: z.literal(true),
  outcome: z.literal("mirrored"),
});

test.each([
  ["before the tag push", false],
  ["after the tag push", true],
] as const)("GIT-008 process-crash regression: worker dies %s", async (
  _phase,
  tagPushed,
) => {
  const installation = await createTestInstallation();
  const remote = await startGitSmartHttpServer();
  let server: RunningTestServer | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;
  const held = tagPushed
    ? remote.holdReceivePackResponseAt(remote.nextReceivePackCall() + 1)
    : remote.holdReceivePackDiscoveryAt(
      remote.nextReceivePackDiscoveryCall() + 1,
    );
  try {
    server = await startTestServer(installation);
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "crash during Git publication",
      idempotencyKey: "git-history-real-process-crash",
      projectId: "prj_default",
    });
    await server.stop();
    server = null;

    const databasePath = `${installation.dataDirectory}/artifact-server.db`;
    const store = new SqliteArtifactRepository(databasePath, "local");
    try {
      await store.storeProjectGitHistorySetting({
        enabled: true,
        limits: {
          fileCopyBytes: defaultGitHistoryFileCopyBytes,
          logicalCopiedBytes: 0,
          logicalReservedBytes: 0,
          storageBudgetBytes: null,
          versionCopyBytes: defaultGitHistoryVersionCopyBytes,
        },
        projectId: "prj_default",
        updatedAt: new Date().toISOString(),
        updatedByPrincipalId: "test-crash-operator",
      });
    } finally {
      store.close();
    }

    const first = startCrashWorker(
      installation.dataDirectory,
      remote.remoteUrl,
      published.body.artifact.id,
    );
    child = first.child;
    await Promise.race([
      held.entered,
      first.completed.then(() => {
        throw new Error("The Git worker exited before the crash point was reached.");
      }),
    ]);
    child.kill("SIGKILL");
    const killed = await first.completed;
    expect(killed.signal).toBe("SIGKILL");
    child = null;
    held.release();

    const {stdout: branchOutput} = await execute("git", [
      "--git-dir", remote.barePath, "rev-parse", "refs/heads/main",
    ]);
    const branchCommit = branchOutput.trim();
    const tagBeforeRestart = await execute("git", [
      "--git-dir", remote.barePath, "show-ref", "--verify",
      `refs/tags/v/${published.body.version.id}`,
    ]).then(({stdout}) => stdout.trim().split(" ")[0] ?? null, () => null);
    expect(tagBeforeRestart).toBe(tagPushed ? branchCommit : null);

    const database = new DatabaseSync(databasePath);
    try {
      const expired = database.prepare(`
        UPDATE git_history_jobs SET lease_expires_at = ?
        WHERE installation_id = 'local' AND artifact_id = ?
          AND state = 'claimed'
      `).run(new Date(0).toISOString(), published.body.artifact.id);
      expect(expired.changes).toBe(1);
    } finally {
      database.close();
    }
    const restarted = startCrashWorker(
      installation.dataDirectory,
      remote.remoteUrl,
      published.body.artifact.id,
    );
    child = restarted.child;
    const finished = await restarted.completed;
    child = null;
    expect(finished.exitCode).toBe(0);
    expect(passSchema.parse(JSON.parse(finished.stdout.trim())))
      .toEqual({claimed: true, outcome: "mirrored"});
    const {stdout: tagOutput} = await execute("git", [
      "--git-dir", remote.barePath, "rev-parse",
      `refs/tags/v/${published.body.version.id}`,
    ]);
    expect(tagOutput.trim()).toBe(branchCommit);

    const recovered = new SqliteArtifactRepository(databasePath, "local");
    try {
      expect(await recovered.findGitHistoryMapping(
        "prj_default",
        published.body.artifact.id,
        published.body.version.id,
      )).toMatchObject({commitId: branchCommit});
    } finally {
      recovered.close();
    }
  } finally {
    held.release();
    child?.kill("SIGKILL");
    if (server !== null) await server.stop();
    await remote.close();
    await removeTestInstallation(installation);
  }
}, 45_000);

function startCrashWorker(
  dataDirectory: string,
  remoteUrl: string,
  artifactId: string,
) {
  const workerPath = fileURLToPath(new URL(
    "../support/git-history-crash-worker.ts",
    import.meta.url,
  ));
  const child = spawn(process.execPath, ["--import", "tsx", workerPath], {
    env: {
      ...process.env,
      ARTIFACT_SERVER_GIT_TEST_ARTIFACT_ID: artifactId,
      ARTIFACT_SERVER_GIT_TEST_DATA_DIRECTORY: dataDirectory,
      ARTIFACT_SERVER_GIT_TEST_REMOTE_URL: remoteUrl,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const stdout: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  const completed = new Promise<{
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({
      exitCode,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
    }));
  });
  return {child, completed};
}
