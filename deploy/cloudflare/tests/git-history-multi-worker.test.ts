import {createHash} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {getPlatformProxy} from "wrangler";

import {createManifest} from "../../../src/manifest/create-manifest.js";
import {
  defaultGitHistoryFileCopyBytes,
  defaultGitHistoryVersionCopyBytes,
  fixedGitHistoryCapabilityReader,
} from "../../../src/git-history/git-history-capability.js";
import {
  gitHistoryJobId,
  gitHistoryJobKinds,
  makeGitHistoryMirrorWorker,
} from "../../../src/git-history/git-history-mirror.js";
import type {
  GitHistoryCommitRequest,
  GitHistoryJob,
  GitHistoryProvider,
  GitRepositoryCoordinates,
} from "../../../src/git-history/git-history-mirror.js";
import {LocalBlobStore} from "../../../src/storage/local-blob-store.js";
import {createD1ArtifactRepository} from "../src/d1-artifact-repository.js";
import {migrateD1} from "../src/d1-migrations.js";

const openLocalD1 = () => getPlatformProxy<{
  ARTIFACT_SERVER_D1_DATABASE: D1Database;
}>({
  configPath: fileURLToPath(new URL("../wrangler.git-store.test.jsonc", import.meta.url)),
  envFiles: [],
  persist: false,
  remoteBindings: false,
});

const makeClock = () => {
  let time = Date.parse("2026-01-01T00:00:00.000Z");
  return {
    advance: (milliseconds = 1000): string => {
      time += milliseconds;
      return new Date(time).toISOString();
    },
    lease: (now: string): string =>
      new Date(Date.parse(now) + 45_000).toISOString(),
  };
};

const sha256Hex = (bytes: Uint8Array): string => {
  const hash = createHash("sha256");
  hash.update(bytes);
  return hash.digest("hex");
};

const streamFromBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

const capability = fixedGitHistoryCapabilityReader({
  limits: {
    fileCopyBytes: defaultGitHistoryFileCopyBytes,
    logicalCopiedBytes: 0,
    logicalReservedBytes: 0,
    storageBudgetBytes: null,
    versionCopyBytes: defaultGitHistoryVersionCopyBytes,
  },
  provider: "cloudflare-artifacts",
  providerState: "available",
});

const seedVersionFile = async (
  blobs: LocalBlobStore,
  versionNumber: number,
) => {
  const bytes = new TextEncoder().encode(`<h1>version ${versionNumber}</h1>`);
  const digest = sha256Hex(bytes);
  await blobs.put({
    body: streamFromBytes(bytes),
    sha256: digest,
    size: bytes.length,
  });
  const manifest = createManifest({
    entryPath: "index.html",
    files: [{
      mediaType: "text/html",
      path: "index.html",
      sha256: digest,
      size: bytes.length,
    }],
    routingMode: "static",
  });
  const [entry] = manifest.entries;
  if (entry === undefined) throw new Error("Manifest entry missing.");
  return {bytes, entry, manifest, sha256: digest};
};

const defaultCoordinates = (
  artifactId: string,
): GitRepositoryCoordinates => ({
  artifactId,
  defaultBranch: "main",
  projectId: "prj_default",
  provider: "cloudflare-artifacts",
  remoteUrl: `https://git.example.test/${artifactId}`,
  repositoryName: artifactId,
  status: "provisioned",
});

describe("D1 Git history multi-worker concurrency", () => {
  it("GIT-008 D1 multi-worker regression: concurrent claim storm orders per artifact", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const clock = makeClock();
    const installationId = "d1-git-claim-storm";
    try {
      await migrateD1(binding, installationId);
      const storeA = createD1ArtifactRepository(binding, installationId);
      const storeB = createD1ArtifactRepository(binding, installationId);

      const createdAt = clock.advance();
      const versionStatement = `
        INSERT INTO versions (
          id, project_id, artifact_id, number, manifest_digest,
          entry_path, routing_mode, content_token,
          publisher_principal_id, created_at
        ) VALUES (?, 'prj_default', ?, ?, ?, 'index.html',
          'static', ?, 'test-principal', ?)
      `;
      await binding.batch([
        binding.prepare(`
          INSERT INTO artifacts (
            id, project_id, name, search_name, access_setting,
            current_version_id, created_at, deleted_at
          ) VALUES (?, 'prj_default', ?, ?, 'account_required', NULL, ?, NULL)
        `).bind("art_d1_storm_many", "Many", "many", createdAt),
        binding.prepare(`
          INSERT INTO artifacts (
            id, project_id, name, search_name, access_setting,
            current_version_id, created_at, deleted_at
          ) VALUES (?, 'prj_default', ?, ?, 'account_required', NULL, ?, NULL)
        `).bind("art_d1_storm_one", "One", "one", createdAt),
        ...Array.from({length: 4}, (_, index) => {
          const number = index + 1;
          return binding.prepare(versionStatement).bind(
            `ver_d1_storm_many_${number}`,
            "art_d1_storm_many",
            number,
            "0".repeat(64),
            `token_d1_storm_many_${number}`,
            createdAt,
          );
        }),
        binding.prepare(versionStatement).bind(
          "ver_d1_storm_one_1", "art_d1_storm_one", 1,
          "0".repeat(64), "token_d1_storm_one_1", createdAt,
        ),
      ]);

      const enabledAt = clock.advance();
      await storeA.storeProjectGitHistorySetting({
        enabled: true,
        limits: {
          fileCopyBytes: 1024,
          logicalCopiedBytes: 0,
          logicalReservedBytes: 0,
          storageBudgetBytes: null,
          versionCopyBytes: 1024,
        },
        projectId: "prj_default",
        updatedAt: enabledAt,
        updatedByPrincipalId: "test-principal",
      });

      const claimRound = async (
        accumulated: GitHistoryJob[] = [],
      ): Promise<GitHistoryJob[]> => {
        const now = clock.advance();
        const lease = clock.lease(now);
        const [a, b] = await Promise.all([
          storeA.claimGitHistoryJob(now, lease),
          storeB.claimGitHistoryJob(now, lease),
        ]);
        const found = [a, b].filter(
          (candidate): candidate is GitHistoryJob => candidate !== null,
        );
        if (found.length === 0) return accumulated;
        return claimRound([...accumulated, ...found]);
      };

      const phase1Claims = await claimRound();
      const phase1Ids = phase1Claims.map((job) => job.id);
      expect(new Set(phase1Ids).size).toBe(phase1Ids.length);
      expect(new Set(phase1Claims.map((job) => job.artifactId)).size)
        .toBe(phase1Claims.length);
      for (const job of phase1Claims) {
        expect(job.versionId).toMatch(/_1$/u);
      }
      const phase1VersionIds = phase1Claims
        .map((job) => job.versionId)
        .filter((versionId): versionId is string => versionId !== null)
        .toSorted((left, right) => left.localeCompare(right));
      expect(phase1VersionIds).toEqual([
        "ver_d1_storm_many_1",
        "ver_d1_storm_one_1",
      ]);

      const completeMirror = async (job: GitHistoryJob, now: string) => {
        if (job.versionId === null) throw new Error("Missing version id.");
        const versionNumber = Number(job.versionId.split("_").pop());
        await storeA.recordGitHistoryRepository(
          job,
          defaultCoordinates(job.artifactId),
          now,
        );
        await storeA.completeGitHistoryMirror(job, {
          artifactId: job.artifactId,
          commitId: `commit-${job.artifactId}-${versionNumber}`,
          copiedBytes: 0,
          projectId: "prj_default",
          repositoryName: job.artifactId,
          versionId: job.versionId,
        }, now);
      };

      const claimedVersions = new Set<string>();
      const claimedOrderByArtifact = new Map<string, number[]>();

      const completeAll = async (): Promise<void> => {
        const now = clock.advance();
        const lease = clock.lease(now);
        const [a, b] = await Promise.all([
          storeA.claimGitHistoryJob(now, lease),
          storeB.claimGitHistoryJob(now, lease),
        ]);
        const jobs = [a, b].filter(
          (candidate): candidate is GitHistoryJob => candidate !== null,
        );
        if (jobs.length === 0) return;
        for (const job of jobs) {
          if (job.versionId === null) throw new Error("Missing version id.");
          expect(claimedVersions.has(job.versionId)).toBe(false);
          const versionNumber = Number(job.versionId.split("_").pop());
          const order = claimedOrderByArtifact.get(job.artifactId) ?? [];
          const last = order.at(-1);
          expect(last === undefined || versionNumber > last).toBe(true);
        }
        await Promise.all(jobs.map((job) => completeMirror(job, now)));
        for (const job of jobs) {
          if (job.versionId === null) continue;
          claimedVersions.add(job.versionId);
          const versionNumber = Number(job.versionId.split("_").pop());
          const order = claimedOrderByArtifact.get(job.artifactId) ?? [];
          order.push(versionNumber);
          claimedOrderByArtifact.set(job.artifactId, order);
        }
        return completeAll();
      };

      await Promise.all(phase1Claims.map((job) => {
        const now = clock.advance();
        return completeMirror(job, now);
      }));
      for (const job of phase1Claims) {
        if (job.versionId === null) continue;
        claimedVersions.add(job.versionId);
        const order = claimedOrderByArtifact.get(job.artifactId) ?? [];
        order.push(1);
        claimedOrderByArtifact.set(job.artifactId, order);
      }

      await completeAll();

      expect(claimedVersions.size).toBe(5);
      expect(claimedOrderByArtifact.get("art_d1_storm_many")).toEqual([1, 2, 3, 4]);
      expect(claimedOrderByArtifact.get("art_d1_storm_one")).toEqual([1]);

      const mappings = await Promise.all(Array.from({length: 4}, (_, index) => {
        const number = index + 1;
        return storeA.findGitHistoryMapping(
          "prj_default", "art_d1_storm_many", `ver_d1_storm_many_${number}`,
        );
      }));
      for (let index = 0; index < mappings.length; index += 1) {
        const number = index + 1;
        expect(mappings[index]).toMatchObject({
          commitId: `commit-art_d1_storm_many-${number}`,
          versionId: `ver_d1_storm_many_${number}`,
        });
      }
    } finally {
      await proxy.dispose();
    }
  });

  it("GIT-008 D1 multi-worker regression: two racing mirror workers converge", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-git-mirror-converge";
    let blobRoot: string | null = null;
    try {
      await migrateD1(binding, installationId);
      blobRoot = await mkdtemp(path.join(os.tmpdir(), "git-history-multi-worker-"));
      const blobs = new LocalBlobStore(blobRoot);
      const storeA = createD1ArtifactRepository(binding, installationId);
      const storeB = createD1ArtifactRepository(binding, installationId);

      const createdAt = new Date().toISOString();
      const artifactId = "art_d1_converge";
      await binding.prepare(`
        INSERT INTO artifacts (
          id, project_id, name, search_name, access_setting,
          current_version_id, created_at, deleted_at
        ) VALUES (?, 'prj_default', ?, ?, 'account_required', NULL, ?, NULL)
      `).bind(artifactId, "Converge", "converge", createdAt).run();

      await Promise.all(Array.from({length: 4}, async (_, index) => {
        const number = index + 1;
        const file = await seedVersionFile(blobs, number);
        const versionId = `ver_d1_converge_${number}`;
        await binding.batch([
          binding.prepare(`
            INSERT INTO versions (
              id, project_id, artifact_id, number, manifest_digest,
              entry_path, routing_mode, content_token,
              publisher_principal_id, created_at
            ) VALUES (?, 'prj_default', ?, ?, ?, 'index.html',
              'static', ?, 'test-principal', ?)
          `).bind(
            versionId,
            artifactId,
            number,
            file.manifest.digest,
            `token_d1_converge_${number}`,
            createdAt,
          ),
          binding.prepare(`
            INSERT INTO manifest_entries (
              version_id, path, size, media_type, sha256, disposition
            ) VALUES (?, 'index.html', ?, ?, ?, ?)
          `).bind(
            versionId,
            file.entry.size,
            file.entry.mediaType,
            file.entry.sha256,
            file.entry.disposition,
          ),
        ]);
      }));

      const requests: GitHistoryCommitRequest[] = [];
      const provider: GitHistoryProvider = {
        name: "cloudflare-artifacts",
        async createRepository(projectId, id) {
          return defaultCoordinates(id);
        },
        async deleteRepository() {},
        async health() {
          return {healthy: true, detail: "ok"};
        },
        async issueCredential() {
          throw new Error("unused");
        },
        async lookupCommit() {
          return null;
        },
        async commitVersion(request) {
          requests.push(request);
          return {
            commitId: `commit-${artifactId}-${request.metadata.versionNumber}`,
          };
        },
      };

      await storeA.storeProjectGitHistorySetting({
        enabled: true,
        limits: {
          fileCopyBytes: defaultGitHistoryFileCopyBytes,
          logicalCopiedBytes: 0,
          logicalReservedBytes: 0,
          storageBudgetBytes: null,
          versionCopyBytes: defaultGitHistoryVersionCopyBytes,
        },
        projectId: "prj_default",
        updatedAt: createdAt,
        updatedByPrincipalId: "test-principal",
      });

      const workerA = makeGitHistoryMirrorWorker({
        blobs,
        capability,
        installationId,
        provider,
        store: storeA,
      });
      const workerB = makeGitHistoryMirrorWorker({
        blobs,
        capability,
        installationId,
        provider,
        store: storeB,
      });

      const drain = async (remaining: number): Promise<void> => {
        if (remaining === 0) {
          throw new Error("Mirror workers did not converge to idle within the iteration limit.");
        }
        const [passA, passB] = await Promise.all([
          Effect.runPromise(workerA.runPass()),
          Effect.runPromise(workerB.runPass()),
        ]);
        if (!passA.claimed && !passB.claimed) return;
        return drain(remaining - 1);
      };
      await drain(30);

      const sorted = requests.toSorted(
        (left, right) => left.metadata.versionNumber - right.metadata.versionNumber,
      );
      expect(sorted).toHaveLength(4);
      let previousCommitId: string | null = null;
      let number = 1;
      for (const request of sorted) {
        expect(request.metadata.versionNumber).toBe(number);
        expect(request.expectedParentCommitId).toBe(previousCommitId);
        expect(request.files.some((file) => file.path === "index.html")).toBe(true);
        previousCommitId = `commit-${artifactId}-${number}`;
        number += 1;
      }

      const mappings = await Promise.all(Array.from({length: 4}, (_, index) => {
        const versionNumber = index + 1;
        return storeA.findGitHistoryMapping(
          "prj_default", artifactId, `ver_d1_converge_${versionNumber}`,
        );
      }));
      for (let index = 0; index < mappings.length; index += 1) {
        const versionNumber = index + 1;
        expect(mappings[index]).toMatchObject({
          artifactId,
          commitId: `commit-${artifactId}-${versionNumber}`,
          versionId: `ver_d1_converge_${versionNumber}`,
        });
      }
    } finally {
      await proxy.dispose();
      if (blobRoot !== null) await rm(blobRoot, {recursive: true, force: true});
    }
  });

  it("GIT-008 D1 multi-worker regression: paused worker loses lease to takeover", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-git-takeover";
    let blobRoot: string | null = null;
    try {
      await migrateD1(binding, installationId);
      blobRoot = await mkdtemp(path.join(os.tmpdir(), "git-history-multi-worker-"));
      const blobs = new LocalBlobStore(blobRoot);
      const storeA = createD1ArtifactRepository(binding, installationId);
      const storeB = createD1ArtifactRepository(binding, installationId);

      const createdAt = new Date().toISOString();
      const artifactId = "art_d1_takeover";
      await binding.prepare(`
        INSERT INTO artifacts (
          id, project_id, name, search_name, access_setting,
          current_version_id, created_at, deleted_at
        ) VALUES (?, 'prj_default', ?, ?, 'account_required', NULL, ?, NULL)
      `).bind(artifactId, "Takeover", "takeover", createdAt).run();

      const file = await seedVersionFile(blobs, 1);
      await binding.batch([
        binding.prepare(`
          INSERT INTO versions (
            id, project_id, artifact_id, number, manifest_digest,
            entry_path, routing_mode, content_token,
            publisher_principal_id, created_at
          ) VALUES (?, 'prj_default', ?, 1, ?, 'index.html',
            'static', ?, 'test-principal', ?)
        `).bind(
          "ver_d1_takeover_1",
          artifactId,
          file.manifest.digest,
          "token_d1_takeover_1",
          createdAt,
        ),
        binding.prepare(`
          INSERT INTO manifest_entries (
            version_id, path, size, media_type, sha256, disposition
          ) VALUES (?, 'index.html', ?, ?, ?, ?)
        `).bind(
          "ver_d1_takeover_1",
          file.entry.size,
          file.entry.mediaType,
          file.entry.sha256,
          file.entry.disposition,
        ),
      ]);

      await storeA.storeProjectGitHistorySetting({
        enabled: true,
        limits: {
          fileCopyBytes: defaultGitHistoryFileCopyBytes,
          logicalCopiedBytes: 0,
          logicalReservedBytes: 0,
          storageBudgetBytes: null,
          versionCopyBytes: defaultGitHistoryVersionCopyBytes,
        },
        projectId: "prj_default",
        updatedAt: createdAt,
        updatedByPrincipalId: "test-principal",
      });

      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<string>();
      const provider: GitHistoryProvider = {
        name: "cloudflare-artifacts",
        async createRepository(projectId, id) {
          return defaultCoordinates(id);
        },
        async deleteRepository() {},
        async health() {
          return {healthy: true, detail: "ok"};
        },
        async issueCredential() {
          throw new Error("unused");
        },
        async lookupCommit() {
          return null;
        },
        async commitVersion() {
          entered.resolve();
          return {commitId: await resume.promise};
        },
      };

      const workerA = makeGitHistoryMirrorWorker({
        blobs,
        capability,
        installationId,
        provider,
        store: storeA,
      });

      const passPromise = Effect.runPromise(workerA.runPass());
      await entered.promise;

      const realNow = Date.now();
      const futureNow = new Date(realNow + 60_000).toISOString();
      const futureLease = new Date(realNow + 105_000).toISOString();
      const jobB = await storeB.claimGitHistoryJob(futureNow, futureLease);
      expect(jobB).not.toBeNull();
      if (jobB === null) throw new Error("Takeover did not claim the job.");

      resume.resolve("taken-over-commit");

      const outcome = await passPromise;
      expect(outcome).toEqual({claimed: true, outcome: "retry"});

      await expect(storeA.completeGitHistoryMirror({
        ...jobB,
        attempts: jobB.attempts - 1,
      }, {
        artifactId,
        commitId: "stale-commit",
        copiedBytes: 0,
        projectId: "prj_default",
        repositoryName: artifactId,
        versionId: "ver_d1_takeover_1",
      }, futureNow)).rejects.toThrow("git_history_lease_lost");

      const renewed = await storeB.renewGitHistoryJob(
        jobB,
        futureNow,
        new Date(realNow + 150_000).toISOString(),
      );
      expect(renewed).toBe(true);

      expect(await storeA.findGitHistoryMapping(
        "prj_default", artifactId, "ver_d1_takeover_1",
      )).toBeNull();

      await storeB.recordGitHistoryRepository(
        jobB,
        defaultCoordinates(artifactId),
        futureNow,
      );
      await storeB.completeGitHistoryMirror(jobB, {
        artifactId,
        commitId: "taken-over-commit",
        copiedBytes: 0,
        projectId: "prj_default",
        repositoryName: artifactId,
        versionId: "ver_d1_takeover_1",
      }, futureNow);

      const mapping = await storeB.findGitHistoryMapping(
        "prj_default", artifactId, "ver_d1_takeover_1",
      );
      expect(mapping).toMatchObject({commitId: "taken-over-commit"});
    } finally {
      await proxy.dispose();
      if (blobRoot !== null) await rm(blobRoot, {recursive: true, force: true});
    }
  });

  it("GIT-008 D1 multi-worker regression: deletion job race has one winner", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const clock = makeClock();
    const installationId = "d1-git-deletion-race";
    try {
      await migrateD1(binding, installationId);
      const storeA = createD1ArtifactRepository(binding, installationId);
      const storeB = createD1ArtifactRepository(binding, installationId);

      const createdAt = clock.advance();
      const artifactId = "art_d1_deletion_race";
      await binding.prepare(`
        INSERT INTO artifacts (
          id, project_id, name, search_name, access_setting,
          current_version_id, created_at, deleted_at
        ) VALUES (?, 'prj_default', ?, ?, 'account_required', NULL, ?, NULL)
      `).bind(artifactId, "Deletion", "deletion", createdAt).run();

      await binding.prepare(`
        INSERT INTO git_history_repositories (
          artifact_id, installation_id, project_id, provider,
          repository_name, remote_url, default_branch, status,
          created_at, updated_at
        ) VALUES (?, ?, 'prj_default', 'cloudflare-artifacts', ?, ?, 'main',
          'provisioned', ?, ?)
      `).bind(
        artifactId,
        installationId,
        artifactId,
        `https://git.example.test/${artifactId}`,
        createdAt,
        createdAt,
      ).run();

      const deletedAt = clock.advance();
      await binding.prepare(`
        UPDATE artifacts SET deleted_at = ? WHERE id = ?
      `).bind(deletedAt, artifactId).run();

      const queuedAt = clock.advance();
      const jobId = gitHistoryJobId(
        gitHistoryJobKinds.deleteRepository,
        artifactId,
        null,
      );
      await binding.prepare(`
        INSERT INTO git_history_jobs (
          id, installation_id, project_id, artifact_id, version_id,
          kind, state, attempts, available_at, created_at, updated_at
        ) VALUES (?, ?, 'prj_default', ?, NULL,
          'delete-repository', 'queued', 0, ?, ?, ?)
      `).bind(jobId, installationId, artifactId, queuedAt, queuedAt, queuedAt).run();

      const now = clock.advance();
      const lease = clock.lease(now);
      const [a, b] = await Promise.all([
        storeA.claimGitHistoryJob(now, lease),
        storeB.claimGitHistoryJob(now, lease),
      ]);

      const winner = a ?? b;
      expect(winner).not.toBeNull();
      if (winner === null) throw new Error("No worker won the deletion job.");
      expect(a === null || b === null).toBe(true);

      const completedAt = clock.advance();
      await expect(storeA.completeGitHistoryDeletion({
        ...winner,
        attempts: 0,
      }, completedAt)).rejects.toThrow("git_history_lease_lost");

      await storeB.completeGitHistoryDeletion(winner, clock.advance());
      await expect(storeA.completeGitHistoryDeletion(winner, clock.advance()))
        .rejects.toThrow("git_history_lease_lost");
      const repository = await storeB.findGitHistoryRepository(
        "prj_default", artifactId,
      );
      expect(repository).toMatchObject({status: "deleted"});
    } finally {
      await proxy.dispose();
    }
  });
});
