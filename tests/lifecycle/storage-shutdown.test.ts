import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterAll, describe, expect, test} from "vitest";
import {z} from "zod";

import {localOwnerBrowserAccess} from "../../src/core/browser-access.js";
import {defaultStagingCleanupPolicy} from
  "../../src/lifecycle/staging-cleanup.js";
import {createLocalRuntime, type LocalRuntime} from
  "../../src/local/create-local-runtime.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
} from "../support/runtime-harness.js";
import {publishNew} from "../support/publishing.js";
import {captureMeasurementContext} from
  "../../project/performance/measurement-context.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const evidencePath = path.join(
  repositoryRoot,
  "project/evidence/storage-shutdown.json",
);

const artifactListSchema = z.object({
  artifacts: z.array(z.object({
    artifact: z.object({id: z.string()}).loose(),
  }).loose()),
}).loose();

interface StorageShutdownEvidence {
  backgroundScheduleSecondCloseOutcome?: string;
  boundaryDoubleCloseError?: string;
  boundaryPostCloseUseError?: string;
  note: string;
  postShutdownRequestOutcome?: string;
  repeatedRuntimeCloseResolved?: boolean;
  repeatedServerCloseResolved?: boolean;
  restartDataIntact?: boolean;
  sqliteBoundary?: boolean;
}

const evidence: StorageShutdownEvidence = {
  note: "T18 SQL-cancellation follow-up: proof that local storage resources close exactly once at shutdown. node:sqlite DatabaseSync refuses a second close and any post-close use with ERR_INVALID_STATE, so a double-run release finalizer would fail loudly; repeated ManagedRuntime disposal resolves quietly, which proves the release finalizer ran exactly once. A restarted runtime on the same data directory reads the published artifact back, proving the closed database was left consistent.",
};

describe("storage shutdown", () => {
  afterAll(async () => {
    const context = await captureMeasurementContext({
      probe: "storage-shutdown",
      scope: "local-sqlite-runtime",
    });
    await mkdir(path.dirname(evidencePath), {recursive: true});
    await writeFile(
      evidencePath,
      `${JSON.stringify({...context, ...evidence, probe: "T18-storage-shutdown", target: "local"}, null, 2)}\n`,
      "utf8",
    );
  });

  test("the SQLite boundary fails loudly on a second close or post-close use", async () => {
    expect.hasAssertions();
    const directory = await mkdtemp(
      path.join(tmpdir(), "artifact-server-sqlite-close-"),
    );
    try {
      const repository = new SqliteArtifactRepository(
        path.join(directory, "artifact-server.db"),
        "ins_shutdown_probe",
      );
      await expect(repository.listProjects()).resolves.toBeInstanceOf(Array);
      repository.close();
      expect(() => repository.close()).toThrowError(
        expect.objectContaining({code: "ERR_INVALID_STATE"}),
      );
      await expect(repository.listProjects()).rejects.toMatchObject({
        code: "ERR_INVALID_STATE",
      });
      evidence.boundaryDoubleCloseError = "ERR_INVALID_STATE";
      evidence.boundaryPostCloseUseError = "ERR_INVALID_STATE";
      evidence.sqliteBoundary = true;
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });

  test("disposing a local runtime twice neither double-closes nor leaves storage usable", async () => {
    expect.hasAssertions();
    const installation = await createTestInstallation();
    let runtime: LocalRuntime | null = null;
    try {
      runtime = await createLocalRuntime({
        apiToken: installation.apiToken,
        browserAccess: localOwnerBrowserAccess,
        contentDomain: "localhost",
        dataDirectory: installation.dataDirectory,
        // The external schedule leaves close() as a bare ManagedRuntime
        // disposal, so a repeated close exercises Scope.close directly.
        stagingCleanupPolicy: {
          ...defaultStagingCleanupPolicy,
          schedule: "external",
        },
      });
      const healthy = await runtime.app.fetch(
        new Request("http://localhost/health"),
      );
      expect(healthy.status).toBe(200);

      await runtime.close();
      await runtime.close();
      evidence.repeatedRuntimeCloseResolved = true;

      const postShutdown = await (async (): Promise<string> => {
        try {
          await runtime.app.fetch(new Request("http://localhost/health"));
          return "resolved";
        } catch (cause: unknown) {
          return `rejected: ${String(cause)}`;
        }
      })();
      expect(postShutdown).toContain("rejected");
      expect(postShutdown).toContain("ManagedRuntime disposed");
      evidence.postShutdownRequestOutcome = postShutdown;
    } finally {
      await runtime?.close();
      await removeTestInstallation(installation);
    }
  });

  test("with the default background cleanup schedule a second direct close fails closed", async () => {
    expect.hasAssertions();
    const installation = await createTestInstallation();
    let runtime: LocalRuntime | null = null;
    try {
      runtime = await createLocalRuntime({
        apiToken: installation.apiToken,
        browserAccess: localOwnerBrowserAccess,
        contentDomain: "localhost",
        dataDirectory: installation.dataDirectory,
      });
      await runtime.close();
      // The background-schedule interrupt runs through the already-disposed
      // runtime, so a direct second close() rejects before any storage
      // finalizer could run again. Production entry points wrap close() in
      // createGracefulHttpShutdown, which memoizes, so real shutdown paths
      // never reach this.
      const secondClose = await runtime.close().then(
        () => "resolved",
        (cause: unknown) => `rejected: ${String(cause)}`,
      );
      expect(secondClose).toContain("rejected");
      expect(secondClose).toContain("ManagedRuntime disposed");
      evidence.backgroundScheduleSecondCloseOutcome = secondClose;
    } finally {
      await runtime?.close().catch(() => {});
      await removeTestInstallation(installation);
    }
  });

  test("a real server closes once, rejects post-shutdown traffic, and reopens with data intact", async () => {
    expect.hasAssertions();
    const installation = await createTestInstallation();
    try {
      const server = await startTestServer(installation);
      const published = (await publishNew(server, installation, {
        accessSetting: "account_required",
        content: "<p>storage shutdown probe</p>",
        idempotencyKey: "storage-shutdown-probe",
        name: "Storage shutdown probe",
      })).body;
      await server.stop();
      await server.stop();
      evidence.repeatedServerCloseResolved = true;

      await expect(fetch(`${server.baseUrl}/health`)).rejects
        .toBeInstanceOf(TypeError);

      const restarted = await startTestServer(installation);
      try {
        const listed = await fetch(
          `${restarted.baseUrl}/api/v1/artifacts`,
          {headers: {Authorization: `Bearer ${installation.apiToken}`}},
        );
        expect(listed.status).toBe(200);
        const body = artifactListSchema.parse(await listed.json());
        expect(
          body.artifacts.map(({artifact}) => artifact.id),
        ).toContain(published.artifact.id);
        evidence.restartDataIntact = true;
      } finally {
        await restarted.stop();
      }
    } finally {
      await removeTestInstallation(installation);
    }
  });
});
