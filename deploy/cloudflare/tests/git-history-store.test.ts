import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";
import {getPlatformProxy} from "wrangler";

import {
  gitHistoryJobId,
  gitHistoryJobKinds,
} from "../../../src/git-history/git-history-mirror.js";
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

describe("D1 Git history claim ownership", () => {
  it("GIT-008 D1 lease regression: stale claims cannot record a repository or mapping", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    try {
      await migrateD1(binding, "d1-git-lease-test");
      const createdAt = new Date(0).toISOString();
      await binding.prepare(`
        INSERT INTO artifacts (
          id, project_id, name, search_name, access_setting,
          current_version_id, created_at, deleted_at
        ) VALUES (?, 'prj_default', 'Git lease', 'git lease',
          'account_required', NULL, ?, NULL)
      `).bind("art_d1_git_lease", createdAt).run();
      await binding.prepare(`
        INSERT INTO versions (
          id, project_id, artifact_id, number, manifest_digest,
          entry_path, routing_mode, content_token,
          publisher_principal_id, created_at
        ) VALUES (?, 'prj_default', ?, 1, ?, 'index.html',
          'static', ?, 'test-principal', ?)
      `).bind(
        "ver_d1_git_lease",
        "art_d1_git_lease",
        "0".repeat(64),
        "d1-git-lease-content",
        createdAt,
      ).run();
      const store = createD1ArtifactRepository(binding, "d1-git-lease-test");
      const enabledAt = new Date(1_000).toISOString();
      await store.storeProjectGitHistorySetting({
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
      const firstAt = new Date(2_000).toISOString();
      const first = await store.claimGitHistoryJob(
        firstAt,
        new Date(47_000).toISOString(),
      );
      expect(first).toMatchObject({attempts: 1, versionId: "ver_d1_git_lease"});
      if (first === null) throw new Error("D1 did not claim the Git job.");
      const reclaimedAt = new Date(48_000).toISOString();
      const second = await store.claimGitHistoryJob(
        reclaimedAt,
        new Date(93_000).toISOString(),
      );
      expect(second).toMatchObject({attempts: 2, id: first.id});
      if (second === null) throw new Error("D1 did not reclaim the Git job.");
      const coordinates = {
        artifactId: "art_d1_git_lease",
        defaultBranch: "main" as const,
        projectId: "prj_default",
        provider: "cloudflare-artifacts" as const,
        remoteUrl: "https://git.example.test/art_d1_git_lease",
        repositoryName: "art_d1_git_lease",
        status: "provisioned" as const,
      };
      const mapping = {
        artifactId: "art_d1_git_lease",
        commitId: "current-owner-commit",
        copiedBytes: 0,
        projectId: "prj_default",
        repositoryName: "art_d1_git_lease",
        versionId: "ver_d1_git_lease",
      };

      expect(await store.renewGitHistoryJob(
        first,
        reclaimedAt,
        new Date(120_000).toISOString(),
      )).toBe(false);
      await expect(store.reserveGitHistoryBudget(first, 0, null, reclaimedAt))
        .rejects.toThrow("git_history_lease_lost");
      await expect(store.recordGitHistoryRepository(first, coordinates, reclaimedAt))
        .rejects.toThrow("git_history_lease_lost");
      await expect(store.completeGitHistoryMirror(first, mapping, reclaimedAt))
        .rejects.toThrow("git_history_lease_lost");
      await store.releaseGitHistoryJob(first, "stale_failure", reclaimedAt);
      expect(await store.claimGitHistoryJob(
        reclaimedAt,
        new Date(93_000).toISOString(),
      )).toBeNull();
      expect(await store.findGitHistoryMapping(
        "prj_default", "art_d1_git_lease", "ver_d1_git_lease",
      )).toBeNull();

      expect(await store.recordGitHistoryRepository(second, coordinates, reclaimedAt))
        .toMatchObject({repositoryName: coordinates.repositoryName});
      expect(await store.completeGitHistoryMirror(second, mapping, reclaimedAt))
        .toBe("mirrored");
      expect(await store.findGitHistoryMapping(
        "prj_default", "art_d1_git_lease", "ver_d1_git_lease",
      )).toMatchObject({commitId: mapping.commitId});
      expect(await store.findGitHistoryPredecessorMapping(
        "prj_default", "art_d1_git_lease", 1,
      )).toMatchObject({commitId: mapping.commitId});

      await binding.prepare(`
        UPDATE artifacts SET deleted_at = ? WHERE id = ?
      `).bind(new Date(100_000).toISOString(), "art_d1_git_lease").run();
      await binding.prepare(`
        INSERT INTO git_history_jobs (
          id, installation_id, project_id, artifact_id, version_id,
          kind, state, attempts, available_at, created_at, updated_at
        ) VALUES (?, ?, 'prj_default', ?, NULL,
          'delete-repository', 'queued', 0, ?, ?, ?)
      `).bind(
        gitHistoryJobId(
          gitHistoryJobKinds.deleteRepository,
          "art_d1_git_lease",
          null,
        ),
        "d1-git-lease-test",
        "art_d1_git_lease",
        new Date(100_000).toISOString(),
        new Date(100_000).toISOString(),
        new Date(100_000).toISOString(),
      ).run();
      const deletionAt = new Date(101_000).toISOString();
      const deletion = await store.claimGitHistoryJob(
        deletionAt,
        new Date(146_000).toISOString(),
      );
      expect(deletion).toMatchObject({attempts: 1, kind: "delete-repository"});
      if (deletion === null) throw new Error("D1 did not claim the deletion job.");
      const deletionReclaimedAt = new Date(147_000).toISOString();
      const successor = await store.claimGitHistoryJob(
        deletionReclaimedAt,
        new Date(192_000).toISOString(),
      );
      expect(successor).toMatchObject({attempts: 2, id: deletion.id});
      if (successor === null) throw new Error("D1 did not reclaim deletion.");

      await expect(store.completeGitHistoryDeletion(deletion, deletionReclaimedAt))
        .rejects.toThrow("git_history_lease_lost");
      expect(await store.findGitHistoryRepository(
        "prj_default", "art_d1_git_lease",
      )).toMatchObject({status: "provisioned"});
      await store.completeGitHistoryDeletion(successor, deletionReclaimedAt);
      expect(await store.findGitHistoryRepository(
        "prj_default", "art_d1_git_lease",
      )).toMatchObject({status: "deleted"});
      expect(await store.findGitHistoryMapping(
        "prj_default", "art_d1_git_lease", "ver_d1_git_lease",
      )).toBeNull();
    } finally {
      await proxy.dispose();
    }
  });

  it("GIT-008 D1 fairness regression: backfill queues one first version per artifact", async () => {
    const proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    try {
      await migrateD1(binding, "d1-git-fairness-test");
      const createdAt = new Date(0).toISOString();
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
        `).bind("art_d1_long", "Long", "long", createdAt),
        binding.prepare(`
          INSERT INTO artifacts (
            id, project_id, name, search_name, access_setting,
            current_version_id, created_at, deleted_at
          ) VALUES (?, 'prj_default', ?, ?, 'account_required', NULL, ?, NULL)
        `).bind("art_d1_other", "Other", "other", createdAt),
        ...Array.from({length: 33}, (_, index) => {
          const number = index + 1;
          return binding.prepare(versionStatement).bind(
            `ver_d1_long_${number}`,
            "art_d1_long",
            number,
            "0".repeat(64),
            `token_d1_long_${number}`,
            createdAt,
          );
        }),
        binding.prepare(versionStatement).bind(
          "ver_d1_other_1", "art_d1_other", 1,
          "0".repeat(64), "token_d1_other_1", createdAt,
        ),
      ]);
      const store = createD1ArtifactRepository(binding, "d1-git-fairness-test");
      const now = new Date(1_000).toISOString();
      await store.storeProjectGitHistorySetting({
        enabled: true,
        limits: {
          fileCopyBytes: 1024,
          logicalCopiedBytes: 0,
          logicalReservedBytes: 0,
          storageBudgetBytes: null,
          versionCopyBytes: 1024,
        },
        projectId: "prj_default",
        updatedAt: now,
        updatedByPrincipalId: "test-principal",
      });
      const lease = new Date(46_000).toISOString();
      const first = await store.claimGitHistoryJob(now, lease);
      const second = await store.claimGitHistoryJob(now, lease);
      expect(new Set([first?.versionId, second?.versionId])).toEqual(new Set([
        "ver_d1_long_1", "ver_d1_other_1",
      ]));
      expect((await store.readProjectGitHistoryProgress("prj_default")).pendingJobs)
        .toBe(2);
    } finally {
      await proxy.dispose();
    }
  });
});
