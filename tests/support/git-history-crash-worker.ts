import {join} from "node:path";

import {Effect} from "effect";
import {z} from "zod";

import {
  commitGitHistoryVersion,
  lookupGitHistoryCommit,
} from "../../src/git-history/cloudflare-artifacts-git-history-provider.js";
import {
  defaultGitHistoryFileCopyBytes,
  defaultGitHistoryVersionCopyBytes,
  fixedGitHistoryCapabilityReader,
} from "../../src/git-history/git-history-capability.js";
import {
  makeGitHistoryMirrorWorker,
  type GitHistoryProvider,
  type GitRepositoryCoordinates,
} from "../../src/git-history/git-history-mirror.js";
import {LocalBlobStore} from "../../src/storage/local-blob-store.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";

const environmentSchema = z.object({
  ARTIFACT_SERVER_GIT_TEST_ARTIFACT_ID: z.string().min(1),
  ARTIFACT_SERVER_GIT_TEST_DATA_DIRECTORY: z.string().min(1),
  ARTIFACT_SERVER_GIT_TEST_REMOTE_URL: z.url(),
});
const token = "disposable-git-test-token";

async function main(): Promise<void> {
  const environment = environmentSchema.parse(process.env);
  const coordinates: GitRepositoryCoordinates = {
    artifactId: environment.ARTIFACT_SERVER_GIT_TEST_ARTIFACT_ID,
    defaultBranch: "main",
    projectId: "prj_default",
    provider: "cloudflare-artifacts",
    remoteUrl: environment.ARTIFACT_SERVER_GIT_TEST_REMOTE_URL,
    repositoryName: "repository.git",
    status: "provisioned",
  };
  const provider: GitHistoryProvider = {
    name: "cloudflare-artifacts",
    commitVersion: (request) => commitGitHistoryVersion(request, token),
    createRepository: async () => coordinates,
    deleteRepository: async () => {},
    health: async () => ({detail: "disposable-git", healthy: true}),
    issueCredential: async () => ({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      token,
    }),
    lookupCommit: (request) => lookupGitHistoryCommit(request, token),
  };
  const store = new SqliteArtifactRepository(
    join(environment.ARTIFACT_SERVER_GIT_TEST_DATA_DIRECTORY, "artifact-server.db"),
    "local",
  );
  try {
    const worker = makeGitHistoryMirrorWorker({
      blobs: new LocalBlobStore(join(
        environment.ARTIFACT_SERVER_GIT_TEST_DATA_DIRECTORY,
        "blobs",
      )),
      capability: fixedGitHistoryCapabilityReader({
        limits: {
          fileCopyBytes: defaultGitHistoryFileCopyBytes,
          logicalCopiedBytes: 0,
          logicalReservedBytes: 0,
          storageBudgetBytes: null,
          versionCopyBytes: defaultGitHistoryVersionCopyBytes,
        },
        provider: "cloudflare-artifacts",
        providerState: "available",
      }),
      installationId: "local",
      provider,
      store,
    });
    const result = await Effect.runPromise(worker.runPass());
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    store.close();
  }
}

void main().catch((cause: unknown) => {
  const kind = cause instanceof Error ? cause.name : "unknown";
  process.stderr.write(`Disposable Git worker failed: ${kind}.\n`);
  process.exitCode = 1;
});
