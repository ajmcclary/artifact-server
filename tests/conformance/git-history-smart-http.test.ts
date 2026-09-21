import {execFile} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {promisify} from "node:util";

import {expect, test} from "vitest";

import {
  commitGitHistoryVersion,
  lookupGitHistoryCommit,
  readGitHistoryCommit,
} from "../../src/git-history/cloudflare-artifacts-git-history-provider.js";
import {
  gitHistoryMetadataFiles,
  type GitHistoryCommitRequest,
  type GitRepositoryCoordinates,
} from "../../src/git-history/git-history-mirror.js";
import {startGitSmartHttpServer} from "../support/git-smart-http-server.js";

const execute = promisify(execFile);
const testToken = "disposable-git-test-token";

test("GIT-008 remote regression: exact predecessors, tags and lost push responses preserve one commit", async () => {
  const remote = await startGitSmartHttpServer();
  const coordinates: GitRepositoryCoordinates = {
    artifactId: "art_git_http_test",
    defaultBranch: "main",
    projectId: "prj_git_http_test",
    provider: "cloudflare-artifacts",
    remoteUrl: remote.remoteUrl,
    repositoryName: "repository.git",
    status: "provisioned",
  };
  const git = async (...arguments_: string[]): Promise<string> => {
    const {stdout} = await execute("git", ["--git-dir", remote.barePath, ...arguments_]);
    return stdout.trim();
  };
  try {
    const first = versionRequest(coordinates, 1, "ver_git_http_1", null);
    const firstCommit = await commitGitHistoryVersion(first, testToken);
    expect(await git("rev-parse", "refs/heads/main")).toBe(firstCommit.commitId);
    expect(await readGitHistoryCommit(
      coordinates, first.metadata.versionId, testToken,
    )).toEqual(firstCommit);

    const wrongParent = versionRequest(coordinates, 2, "ver_git_http_wrong", null);
    await expect(commitGitHistoryVersion(wrongParent, testToken))
      .rejects.toThrow("git_history_predecessor_mismatch");
    expect(await git("rev-parse", "refs/heads/main")).toBe(firstCommit.commitId);

    const second = versionRequest(
      coordinates, 2, "ver_git_http_2", firstCommit.commitId,
    );
    const secondCommit = await commitGitHistoryVersion(second, testToken);
    expect(await git("rev-list", "--parents", "-n", "1", secondCommit.commitId))
      .toBe(`${secondCommit.commitId} ${firstCommit.commitId}`);

    const conflict = versionRequest(
      coordinates, 3, "ver_git_http_conflict", secondCommit.commitId,
    );
    await git("update-ref", `refs/tags/v/${conflict.metadata.versionId}`,
      firstCommit.commitId);
    await expect(commitGitHistoryVersion(conflict, testToken))
      .rejects.toThrow("git_history_tag_conflict");
    await expect(lookupGitHistoryCommit(conflict, testToken))
      .rejects.toThrow("git_history_commit_parent_mismatch");
    expect(await git("rev-parse", "refs/heads/main")).toBe(secondCommit.commitId);
    await git("update-ref", "-d", `refs/tags/v/${conflict.metadata.versionId}`);

    const secondTree = await git("rev-parse", `${secondCommit.commitId}^{tree}`);
    const foreignMetadata = await execute("git", [
      "--git-dir", remote.barePath, "commit-tree", secondTree,
      "-p", secondCommit.commitId, "-m", "foreign metadata",
    ], {env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Git test",
      GIT_AUTHOR_EMAIL: "git-test@invalid.example",
      GIT_COMMITTER_NAME: "Git test",
      GIT_COMMITTER_EMAIL: "git-test@invalid.example",
    }});
    const foreignMetadataCommit = foreignMetadata.stdout.trim();
    const metadataConflict = versionRequest(
      coordinates, 3, "ver_git_http_metadata_conflict", secondCommit.commitId,
    );
    await git("update-ref", "refs/heads/main", foreignMetadataCommit);
    await git("update-ref", `refs/tags/v/${metadataConflict.metadata.versionId}`,
      foreignMetadataCommit);
    await expect(lookupGitHistoryCommit(metadataConflict, testToken))
      .rejects.toThrow("git_history_commit_metadata_mismatch");
    await git("update-ref", "refs/heads/main", secondCommit.commitId);
    await git("update-ref", "-d", `refs/tags/v/${metadataConflict.metadata.versionId}`);

    const bytesConflict = versionRequest(
      coordinates, 3, "ver_git_http_bytes_conflict", secondCommit.commitId,
    );
    const worktree = join(dirname(remote.barePath), "wrong-content-worktree");
    await execute("git", ["clone", remote.barePath, worktree]);
    await mkdir(join(worktree, ".artifactserver"), {recursive: true});
    await Promise.all(gitHistoryMetadataFiles(bytesConflict).map((file) =>
      writeFile(join(worktree, file.path), file.bytes)));
    await writeFile(join(worktree, "index.html"), "wrong content");
    await execute("git", ["-C", worktree, "add", "."]);
    await execute("git", ["-C", worktree, "commit", "-m", "wrong copied bytes"], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Git test",
        GIT_AUTHOR_EMAIL: "git-test@invalid.example",
        GIT_COMMITTER_NAME: "Git test",
        GIT_COMMITTER_EMAIL: "git-test@invalid.example",
      },
    });
    const wrongBytes = await execute("git", ["-C", worktree, "rev-parse", "HEAD"]);
    const wrongBytesCommit = wrongBytes.stdout.trim();
    await execute("git", ["-C", worktree, "push", "origin", "main"]);
    await git("update-ref", `refs/tags/v/${bytesConflict.metadata.versionId}`,
      wrongBytesCommit);
    await expect(lookupGitHistoryCommit(bytesConflict, testToken))
      .rejects.toThrow("git_history_commit_bytes_mismatch");
    await git("update-ref", "refs/heads/main", secondCommit.commitId);
    await git("update-ref", "-d", `refs/tags/v/${bytesConflict.metadata.versionId}`);

    const third = versionRequest(
      coordinates, 3, "ver_git_http_3", secondCommit.commitId,
    );
    remote.dropReceivePackResponseAt(remote.nextReceivePackCall());
    await expect(commitGitHistoryVersion(third, testToken))
      .rejects.toBeInstanceOf(Error);
    const thirdTip = await git("rev-parse", "refs/heads/main");
    expect(await git("show-ref", "--verify", `refs/tags/v/${third.metadata.versionId}`)
      .catch(() => null)).toBeNull();
    expect(await lookupGitHistoryCommit(third, testToken))
      .toEqual({commitId: thirdTip});
    expect(await git("rev-parse", `refs/tags/v/${third.metadata.versionId}`))
      .toBe(thirdTip);

    const fourth = versionRequest(coordinates, 4, "ver_git_http_4", thirdTip);
    remote.dropReceivePackResponseAt(remote.nextReceivePackCall() + 1);
    await expect(commitGitHistoryVersion(fourth, testToken))
      .rejects.toBeInstanceOf(Error);
    const fourthTip = await git("rev-parse", "refs/heads/main");
    expect(await lookupGitHistoryCommit(fourth, testToken))
      .toEqual({commitId: fourthTip});

    const tree = await git("rev-parse", `${fourthTip}^{tree}`);
    const foreign = await execute("git", [
      "--git-dir", remote.barePath, "commit-tree", tree,
      "-p", fourthTip, "-m", "foreign advance",
    ], {env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Git test",
      GIT_AUTHOR_EMAIL: "git-test@invalid.example",
      GIT_COMMITTER_NAME: "Git test",
      GIT_COMMITTER_EMAIL: "git-test@invalid.example",
    }});
    const foreignCommit = foreign.stdout.trim();
    remote.advanceMainBeforeNextPush(foreignCommit);
    const fifth = versionRequest(coordinates, 5, "ver_git_http_5", fourthTip);
    await expect(commitGitHistoryVersion(fifth, testToken))
      .rejects.toThrow("git_history_predecessor_mismatch");
    expect(await git("rev-parse", "refs/heads/main")).toBe(foreignCommit);
    expect(await git("show-ref", "--verify", `refs/tags/v/${fifth.metadata.versionId}`)
      .catch(() => null)).toBeNull();
  } finally {
    await remote.close();
  }
}, 60_000);

test("GIT-008 remote concurrency regression: divergent successors cannot both advance main", async () => {
  const remote = await startGitSmartHttpServer();
  const coordinates: GitRepositoryCoordinates = {
    artifactId: "art_git_http_race",
    defaultBranch: "main",
    projectId: "prj_git_http_test",
    provider: "cloudflare-artifacts",
    remoteUrl: remote.remoteUrl,
    repositoryName: "repository.git",
    status: "provisioned",
  };
  try {
    const first = versionRequest(coordinates, 1, "ver_git_race_1", null);
    const firstCommit = await commitGitHistoryVersion(first, testToken);
    const candidates = [
      versionRequest(coordinates, 2, "ver_git_race_a", firstCommit.commitId),
      versionRequest(coordinates, 2, "ver_git_race_b", firstCommit.commitId),
    ];
    const results = await Promise.allSettled(candidates.map((candidate) =>
      commitGitHistoryVersion(candidate, testToken)));
    expect(results.map((result) => result.status).toSorted())
      .toEqual(["fulfilled", "rejected"]);
    const winner = results.find((result) => result.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("No Git successor won.");
    const {stdout} = await execute("git", [
      "--git-dir", remote.barePath, "rev-parse", "refs/heads/main",
    ]);
    expect(stdout.trim()).toBe(winner.value.commitId);
    const tags = await Promise.all(candidates.map((candidate) =>
      readGitHistoryCommit(coordinates, candidate.metadata.versionId, testToken)));
    expect(tags.filter((tag) => tag !== null)).toEqual([winner.value]);
  } finally {
    await remote.close();
  }
}, 30_000);

test("GIT-008 remote lease regression: a claim lost during push discovery cannot advance main", async () => {
  const remote = await startGitSmartHttpServer();
  const coordinates: GitRepositoryCoordinates = {
    artifactId: "art_git_http_lease",
    defaultBranch: "main",
    projectId: "prj_git_http_test",
    provider: "cloudflare-artifacts",
    remoteUrl: remote.remoteUrl,
    repositoryName: "repository.git",
    status: "provisioned",
  };
  try {
    const first = versionRequest(coordinates, 1, "ver_git_lease_1", null);
    const firstCommit = await commitGitHistoryVersion(first, testToken);
    let owned = true;
    let ownershipChecks = 0;
    const second: GitHistoryCommitRequest = {
      ...versionRequest(coordinates, 2, "ver_git_lease_2", firstCommit.commitId),
      assertOwner: async () => {
        ownershipChecks += 1;
        if (!owned) throw new Error("git_history_lease_lost");
      },
    };
    const held = remote.holdNextReceivePackDiscovery();
    const attempted = commitGitHistoryVersion(second, testToken);
    await held.entered;
    owned = false;
    held.release();
    await expect(attempted).rejects.toThrow("git_history_lease_lost");
    expect(ownershipChecks).toBe(1);
    const {stdout} = await execute("git", [
      "--git-dir", remote.barePath, "rev-parse", "refs/heads/main",
    ]);
    expect(stdout.trim()).toBe(firstCommit.commitId);
    expect(await readGitHistoryCommit(coordinates, second.metadata.versionId, testToken))
      .toBeNull();
  } finally {
    await remote.close();
  }
}, 30_000);

test("GIT-008 remote lease regression: a claim lost during the branch update still converges through adoption", async () => {
  const remote = await startGitSmartHttpServer();
  const coordinates: GitRepositoryCoordinates = {
    artifactId: "art_git_http_branch_lease",
    defaultBranch: "main",
    projectId: "prj_git_http_test",
    provider: "cloudflare-artifacts",
    remoteUrl: remote.remoteUrl,
    repositoryName: "repository.git",
    status: "provisioned",
  };
  const git = async (...arguments_: string[]): Promise<string> => {
    const {stdout} = await execute("git", ["--git-dir", remote.barePath, ...arguments_]);
    return stdout.trim();
  };
  try {
    const first = versionRequest(coordinates, 1, "ver_git_branch_lease_1", null);
    const firstCommit = await commitGitHistoryVersion(first, testToken);
    let owned = true;
    let ownershipChecks = 0;
    const second: GitHistoryCommitRequest = {
      ...versionRequest(coordinates, 2, "ver_git_branch_lease_2", firstCommit.commitId),
      assertOwner: async () => {
        ownershipChecks += 1;
        if (!owned) throw new Error("git_history_lease_lost");
      },
    };
    const held = remote.holdReceivePackUpdateAt(remote.nextReceivePackUpdateCall());
    const attempted = commitGitHistoryVersion(second, testToken);
    await held.entered;
    owned = false;
    held.release();
    await expect(attempted).rejects.toThrow("git_history_lease_lost");
    expect(ownershipChecks).toBe(2);
    const tip = await git("rev-parse", "refs/heads/main");
    expect(tip).not.toBe(firstCommit.commitId);
    expect(await git("show-ref", "--verify", `refs/tags/v/${second.metadata.versionId}`)
      .catch(() => null)).toBeNull();
    owned = true;
    await expect(lookupGitHistoryCommit(second, testToken))
      .resolves.toEqual({commitId: tip});
    expect(await git("rev-parse", `refs/tags/v/${second.metadata.versionId}`))
      .toBe(tip);
  } finally {
    await remote.close();
  }
}, 30_000);

test("GIT-008 remote lease regression: a claim lost during the final ref update is never reported committed", async () => {
  const remote = await startGitSmartHttpServer();
  const coordinates: GitRepositoryCoordinates = {
    artifactId: "art_git_http_final_lease",
    defaultBranch: "main",
    projectId: "prj_git_http_test",
    provider: "cloudflare-artifacts",
    remoteUrl: remote.remoteUrl,
    repositoryName: "repository.git",
    status: "provisioned",
  };
  const git = async (...arguments_: string[]): Promise<string> => {
    const {stdout} = await execute("git", ["--git-dir", remote.barePath, ...arguments_]);
    return stdout.trim();
  };
  try {
    const first = versionRequest(coordinates, 1, "ver_git_final_lease_1", null);
    const firstCommit = await commitGitHistoryVersion(first, testToken);
    let owned = true;
    let ownershipChecks = 0;
    const second: GitHistoryCommitRequest = {
      ...versionRequest(coordinates, 2, "ver_git_final_lease_2", firstCommit.commitId),
      assertOwner: async () => {
        ownershipChecks += 1;
        if (!owned) throw new Error("git_history_lease_lost");
      },
    };
    const held = remote.holdReceivePackUpdateAt(remote.nextReceivePackUpdateCall() + 1);
    const attempted = commitGitHistoryVersion(second, testToken);
    await held.entered;
    owned = false;
    held.release();
    await expect(attempted).rejects.toThrow("git_history_lease_lost");
    expect(ownershipChecks).toBe(3);
    const tip = await git("rev-parse", "refs/heads/main");
    expect(tip).not.toBe(firstCommit.commitId);
    expect(await git("rev-parse", `refs/tags/v/${second.metadata.versionId}`))
      .toBe(tip);
    owned = true;
    await expect(lookupGitHistoryCommit(second, testToken))
      .resolves.toEqual({commitId: tip});
  } finally {
    await remote.close();
  }
}, 30_000);

test("GIT-008 remote race regression: an advance between push discovery and the ref update is rejected", async () => {
  const remote = await startGitSmartHttpServer();
  const coordinates: GitRepositoryCoordinates = {
    artifactId: "art_git_http_update_race",
    defaultBranch: "main",
    projectId: "prj_git_http_test",
    provider: "cloudflare-artifacts",
    remoteUrl: remote.remoteUrl,
    repositoryName: "repository.git",
    status: "provisioned",
  };
  const git = async (...arguments_: string[]): Promise<string> => {
    const {stdout} = await execute("git", ["--git-dir", remote.barePath, ...arguments_]);
    return stdout.trim();
  };
  try {
    const first = versionRequest(coordinates, 1, "ver_git_update_race_1", null);
    const firstCommit = await commitGitHistoryVersion(first, testToken);
    const tree = await git("rev-parse", `${firstCommit.commitId}^{tree}`);
    const foreign = await execute("git", [
      "--git-dir", remote.barePath, "commit-tree", tree,
      "-p", firstCommit.commitId, "-m", "foreign advance",
    ], {env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Git test",
      GIT_AUTHOR_EMAIL: "git-test@invalid.example",
      GIT_COMMITTER_NAME: "Git test",
      GIT_COMMITTER_EMAIL: "git-test@invalid.example",
    }});
    const foreignCommit = foreign.stdout.trim();
    const second = versionRequest(
      coordinates, 2, "ver_git_update_race_2", firstCommit.commitId,
    );
    const held = remote.holdReceivePackUpdateAt(remote.nextReceivePackUpdateCall());
    const attempted = commitGitHistoryVersion(second, testToken);
    await held.entered;
    await git("update-ref", "refs/heads/main", foreignCommit);
    held.release();
    await expect(attempted).rejects.toBeInstanceOf(Error);
    expect(await git("rev-parse", "refs/heads/main")).toBe(foreignCommit);
    expect(await git("show-ref", "--verify", `refs/tags/v/${second.metadata.versionId}`)
      .catch(() => null)).toBeNull();
  } finally {
    await remote.close();
  }
}, 30_000);

function versionRequest(
  coordinates: GitRepositoryCoordinates,
  versionNumber: number,
  versionId: string,
  expectedParentCommitId: string | null,
): GitHistoryCommitRequest {
  const bytes = new TextEncoder().encode(`Git version ${versionNumber}`);
  return {
    assertOwner: async () => {},
    coordinates,
    expectedParentCommitId,
    files: [{bytes, path: "index.html"}],
    metadata: {
      artifactId: coordinates.artifactId,
      createdAt: new Date(Date.UTC(2026, 8, 18, 12, versionNumber)).toISOString(),
      entryPath: "index.html",
      installationId: "ins_git_http_test",
      manifestDigest: createHash("sha256").update(bytes).digest("hex"),
      projectId: coordinates.projectId,
      publisherPrincipalId: "principal_git_http_test",
      versionId,
      versionNumber,
    },
    pointers: [],
  };
}
