import {execFile} from "node:child_process";
import {createHash} from "node:crypto";
import {promisify} from "node:util";

import {expect, test} from "vitest";

import type {
  GitHistoryCommitRequest,
  GitRepositoryCoordinates,
} from "../../../src/git-history/git-history-mirror.js";
import {startGitSmartHttpServer} from "../../../tests/support/git-smart-http-server.js";
import {
  type ArtifactsBinding,
  ArtifactsBindingGitHistoryProvider,
} from "../src/artifacts-binding-git-history-provider.js";

const execute = promisify(execFile);
const issuedToken = "disposable-binding-git-token";

async function unsupported(): Promise<never> {
  throw new Error("Not used by a mirror job.");
}

/**
 * The Workers binding's control plane, issuing tokens for one disposable
 * repository. The data plane is the real smart-HTTP remote it points at.
 */
function bindingFor(): ArtifactsBinding & {readonly tokensIssued: () => number} {
  let tokens = 0;
  return {
    create: unsupported,
    delete: unsupported,
    get: async () => ({
      createToken: async () => {
        tokens += 1;
        return {expiresAt: "2026-11-23T13:00:00.000Z", plaintext: issuedToken};
      },
      info: async () => null,
    }),
    list: async () => ({}),
    tokensIssued: () => tokens,
  };
}

test("GIT-008 Workers-binding regression: one mirror job clones the repository once", async () => {
  const remote = await startGitSmartHttpServer();
  const coordinates: GitRepositoryCoordinates = {
    artifactId: "art_binding_handoff",
    defaultBranch: "main",
    projectId: "prj_binding_handoff",
    provider: "cloudflare-artifacts",
    remoteUrl: remote.remoteUrl,
    repositoryName: "repository.git",
    status: "provisioned",
  };
  const git = async (...arguments_: string[]): Promise<string> => {
    const {stdout} = await execute("git", ["--git-dir", remote.barePath, ...arguments_]);
    return stdout.trim();
  };
  const binding = bindingFor();
  const provider = new ArtifactsBindingGitHistoryProvider(binding);
  // The mirror worker's job: adopt an exact existing commit, else commit.
  const mirrorJob = async (request: GitHistoryCommitRequest) =>
    await provider.lookupCommit(request) ?? await provider.commitVersion(request);
  try {
    const first = await mirrorJob(
      versionRequest(coordinates, 1, "ver_binding_handoff_1", null),
    );

    const fetchesBefore = remote.uploadPackCalls();
    const second = await mirrorJob(
      versionRequest(coordinates, 2, "ver_binding_handoff_2", first.commitId),
    );
    expect(remote.uploadPackCalls() - fetchesBefore).toBe(1);
    expect(await git("rev-list", "--parents", "-n", "1", second.commitId))
      .toBe(`${second.commitId} ${first.commitId}`);
    expect(await git("rev-parse", "refs/tags/v/ver_binding_handoff_2"))
      .toBe(second.commitId);
    // Each job still issues its own lookup and commit credentials.
    expect(binding.tokensIssued()).toBe(4);
  } finally {
    await remote.close();
  }
});

function versionRequest(
  coordinates: GitRepositoryCoordinates,
  versionNumber: number,
  versionId: string,
  expectedParentCommitId: string | null,
): GitHistoryCommitRequest {
  const bytes = new TextEncoder().encode(`Binding version ${versionNumber}`);
  return {
    assertOwner: async () => {},
    coordinates,
    expectedParentCommitId,
    files: [{bytes, path: "index.html"}],
    metadata: {
      artifactId: coordinates.artifactId,
      createdAt: new Date(Date.UTC(2026, 10, 23, 12, versionNumber)).toISOString(),
      entryPath: "index.html",
      installationId: "ins_binding_handoff",
      manifestDigest: createHash("sha256").update(bytes).digest("hex"),
      projectId: coordinates.projectId,
      publisherPrincipalId: "principal_binding_handoff",
      versionId,
      versionNumber,
    },
    pointers: [],
  };
}
