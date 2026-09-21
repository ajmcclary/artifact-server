import {Buffer} from "node:buffer";

import {
  add,
  addRemote,
  checkout,
  clone,
  commit,
  currentBranch,
  init,
  listFiles,
  listServerRefs,
  push,
  readBlob,
  readCommit,
  remove,
  resolveRef,
  writeRef,
} from "isomorphic-git";
import http from "isomorphic-git/http/web";
import {createFsFromVolume, Volume} from "memfs";
import {Redacted, Schema} from "effect";

import type {GitHistoryProviderIdentity} from
  "./git-history-provider-identity.js";
import {
  gitHistoryMetadataFiles,
  type GitCloneCredential,
  type GitHistoryCommitRequest,
  type GitHistoryProvider,
  type GitRepositoryCoordinates,
} from "./git-history-mirror.js";

const apiOrigin = new URL("https://api.cloudflare.com/client/v4/");
const maximumControlPlaneResponseBytes = 64 * 1024;
const writeTokenTtlSeconds = 300;
const zeroOid = "0".repeat(40);

const repositorySchema = Schema.Struct({
  default_branch: Schema.String,
  name: Schema.String,
  remote: Schema.String,
});
const issuedTokenSchema = Schema.Struct({
  expires_at: Schema.String,
  plaintext: Schema.String,
  scope: Schema.Literals(["read", "write"]),
});
const versionMetadataSchema = Schema.Struct({
  artifactId: Schema.String,
  createdAt: Schema.String,
  entryPath: Schema.String,
  installationId: Schema.String,
  manifestDigest: Schema.String,
  projectId: Schema.String,
  publisherPrincipalId: Schema.String,
  versionId: Schema.String,
  versionNumber: Schema.Number,
});
export interface CloudflareArtifactsProviderConfig {
  readonly apiOrigin?: URL;
  readonly apiToken: Redacted.Redacted;
  readonly identity: GitHistoryProviderIdentity;
  /** Trusted live-suite prefix. Production leaves this absent. */
  readonly repositoryPrefix?: string;
}

/** Cloudflare Artifacts control plane plus standards-compatible Git smart HTTP. */
export class CloudflareArtifactsGitHistoryProvider implements GitHistoryProvider {
  readonly name = "cloudflare-artifacts" as const;
  readonly #apiToken: Redacted.Redacted;
  readonly #base: URL;
  readonly #repositoryPrefix: string;

  constructor(config: CloudflareArtifactsProviderConfig) {
    this.#apiToken = config.apiToken;
    this.#repositoryPrefix = config.repositoryPrefix ?? "";
    assertRepositoryPrefix(this.#repositoryPrefix);
    const origin = config.apiOrigin ?? apiOrigin;
    assertApiOrigin(origin);
    this.#base = new URL(
      `accounts/${encodeURIComponent(config.identity.accountId)}` +
        `/artifacts/namespaces/${encodeURIComponent(config.identity.namespace)}/`,
      origin,
    );
  }

  async health(): Promise<{readonly detail: string; readonly healthy: boolean}> {
    const response = await this.#request("", {method: "GET"}, false);
    return response.status >= 200 && response.status < 300
      ? {detail: "available", healthy: true}
      : {detail: `provider_status_${response.status}`, healthy: false};
  }

  async createRepository(
    projectId: string,
    artifactId: string,
  ): Promise<GitRepositoryCoordinates> {
    const repositoryName = `${this.#repositoryPrefix}${artifactId}`;
    const response = await this.#request("repos", {
      body: JSON.stringify({
        default_branch: "main",
        description: "Derived Artifact Server version history",
        name: repositoryName,
        read_only: false,
      }),
      headers: {"Content-Type": "application/json"},
      method: "POST",
    }, false);
    const repository = response.status === 409
      ? await this.#readRepository(repositoryName)
      : await decodeRepositoryResponse(response);
    if (repository.name !== repositoryName || repository.default_branch !== "main") {
      throw new Error("cloudflare_repository_identity_mismatch");
    }
    assertCredentialFreeRemote(repository.remote);
    return {
      artifactId,
      defaultBranch: "main",
      projectId,
      provider: this.name,
      remoteUrl: repository.remote,
      repositoryName,
      status: "provisioned",
    };
  }

  async commitVersion(
    request: GitHistoryCommitRequest,
  ): Promise<{readonly commitId: string}> {
    const credential = await this.issueCredential(
      request.coordinates,
      "write",
      writeTokenTtlSeconds,
    );
    return commitGitHistoryVersion(request, credential.token);
  }

  async lookupCommit(
    request: GitHistoryCommitRequest,
  ): Promise<{readonly commitId: string} | null> {
    // Reconciliation may need to repair the immutable tag after a branch push
    // succeeded but the following tag push response was lost.
    const credential = await this.issueCredential(request.coordinates, "write", 60);
    return lookupGitHistoryCommit(request, credential.token);
  }

  async issueCredential(
    coordinates: GitRepositoryCoordinates,
    scope: "read" | "write",
    ttlSeconds: number,
  ): Promise<GitCloneCredential> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3_600) {
      throw new Error("invalid_repository_token_ttl");
    }
    const response = await this.#request("tokens", {
      body: JSON.stringify({
        repo: coordinates.repositoryName,
        scope,
        ttl: ttlSeconds,
      }),
      headers: {"Content-Type": "application/json"},
      method: "POST",
    }, false);
    const token = await decodeTokenResponse(response);
    if (token.scope !== scope) throw new Error("repository_token_scope_mismatch");
    return {expiresAt: token.expires_at, token: token.plaintext};
  }

  async deleteRepository(coordinates: GitRepositoryCoordinates): Promise<void> {
    const response = await this.#request(
      `repos/${encodeURIComponent(coordinates.repositoryName)}`,
      {method: "DELETE"},
      false,
    );
    if (response.status === 404) return;
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`cloudflare_delete_status_${response.status}`);
    }
  }

  async #readRepository(repositoryName: string) {
    const response = await this.#request(
      `repos/${encodeURIComponent(repositoryName)}`,
      {method: "GET"},
      false,
    );
    return decodeRepositoryResponse(response);
  }

  #request(
    path: string,
    requestInit: RequestInit,
    redirect: boolean,
  ): Promise<Response> {
    const headers = new Headers(requestInit.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${Redacted.value(this.#apiToken)}`);
    const target = path === ""
      ? new URL(this.#base.href.slice(0, -1))
      : new URL(path, this.#base);
    return fetch(target, {
      ...requestInit,
      headers,
      redirect: redirect ? "follow" : "error",
      signal: AbortSignal.timeout(10_000),
    });
  }
}

/** Write one deterministic version through any Cloudflare Artifacts control plane. */
export async function commitGitHistoryVersion(
  request: GitHistoryCommitRequest,
  writeToken: string,
): Promise<{readonly commitId: string}> {
    const metadataPaths = new Set(
      gitHistoryMetadataFiles(request).map((file) => file.path),
    );
    if (request.files.some((file) => metadataPaths.has(file.path))) {
      throw new Error("reserved_git_history_metadata_path");
    }
    const workspace = await openWorkspace(
      request.coordinates.remoteUrl,
      writeToken,
    );
    const currentTip = await localMainCommit(workspace);
    if (currentTip !== request.expectedParentCommitId) {
      throw new Error("git_history_predecessor_mismatch");
    }
    await replaceWorkingTree(workspace.fs, workspace.dir, [
      ...request.files,
      ...gitHistoryMetadataFiles(request),
    ]);
    const timestamp = Math.floor(Date.parse(request.metadata.createdAt) / 1_000);
    if (!Number.isSafeInteger(timestamp)) throw new Error("invalid_version_timestamp");
    const commitId = await commit({
      author: deterministicSignature(timestamp),
      committer: deterministicSignature(timestamp),
      dir: workspace.dir,
      fs: workspace.fs,
      message:
        `Artifact Server version ${request.metadata.versionNumber} ` +
        `(${request.metadata.versionId})`,
    });
    await assertVersionCommit(workspace, commitId, request);
    const tagRef = `refs/tags/v/${request.metadata.versionId}`;
    const existingTag = await remoteRefOid(
      request.coordinates,
      tagRef,
      writeToken,
    );
    if (existingTag !== null && existingTag !== commitId) {
      throw new Error("git_history_tag_conflict");
    }
    await writeRef({
      dir: workspace.dir,
      force: true,
      fs: workspace.fs,
      ref: "refs/heads/main",
      value: commitId,
    });
    await writeRef({
      dir: workspace.dir,
      force: true,
      fs: workspace.fs,
      ref: tagRef,
      value: commitId,
    });
    await push({
      dir: workspace.dir,
      fs: workspace.fs,
      headers: authorizationHeaders(writeToken),
      http,
      ref: "main",
      remote: "origin",
      remoteRef: "refs/heads/main",
      onPrePush: async ({remoteRef}) => {
        await request.assertOwner();
        if (remoteRef.oid !== (request.expectedParentCommitId ?? zeroOid)) {
          throw new Error("git_history_predecessor_mismatch");
        }
        return true;
      },
    });
    await push({
      dir: workspace.dir,
      fs: workspace.fs,
      headers: authorizationHeaders(writeToken),
      http,
      ref: tagRef,
      remote: "origin",
      remoteRef: tagRef,
      onPrePush: async ({remoteRef}) => {
        await request.assertOwner();
        if (remoteRef.oid !== zeroOid && remoteRef.oid !== commitId) {
          throw new Error("git_history_tag_conflict");
        }
        return true;
      },
    });
    // The ref update is the last action whose success we report; re-assert
    // ownership and confirm both refs landed so a claim lost during the final
    // receive-pack call can never be reported as a successful commit.
    await request.assertOwner();
    await assertPushedRefs(request.coordinates, tagRef, commitId, writeToken);
    return {commitId};
}

/** Resolve an exact mirrored version without trusting a moving branch name. */
export async function lookupGitHistoryCommit(
  request: GitHistoryCommitRequest,
  writeToken: string,
): Promise<{readonly commitId: string} | null> {
  const {coordinates, metadata} = request;
  const exact = await readGitHistoryCommit(
    coordinates,
    metadata.versionId,
    writeToken,
  );
  const workspace = await openWorkspace(coordinates.remoteUrl, writeToken);
  if (exact !== null) {
    await assertVersionCommit(workspace, exact.commitId, request);
    return exact;
  }
  try {
      const branch = await currentBranch({dir: workspace.dir, fs: workspace.fs});
      if (branch !== "main") return null;
      const tip = await localMainCommit(workspace);
      if (tip === null) return null;
      const saved = await readBlob({
        dir: workspace.dir,
        filepath: ".artifactserver/version.json",
        fs: workspace.fs,
        oid: tip,
      });
      const parsed = Schema.decodeUnknownSync(Schema.Struct({versionId: Schema.String}))(
        JSON.parse(new TextDecoder().decode(saved.blob)),
      );
      if (parsed.versionId !== metadata.versionId) return null;
      await assertVersionCommit(workspace, tip, request);
      const tagRef = `refs/tags/v/${metadata.versionId}`;
      await writeRef({
        dir: workspace.dir,
        force: true,
        fs: workspace.fs,
        ref: tagRef,
        value: tip,
      });
      await push({
        dir: workspace.dir,
        fs: workspace.fs,
        headers: authorizationHeaders(writeToken),
        http,
        ref: tagRef,
        remote: "origin",
        remoteRef: tagRef,
        onPrePush: async ({remoteRef}) => {
          await request.assertOwner();
          if (remoteRef.oid !== zeroOid && remoteRef.oid !== tip) {
            throw new Error("git_history_tag_conflict");
          }
          return true;
        },
      });
      await request.assertOwner();
      const repaired = await readGitHistoryCommit(
        coordinates,
        metadata.versionId,
        writeToken,
      );
      if (repaired?.commitId !== tip) {
        throw new Error("git_history_tag_repair_mismatch");
      }
      return repaired;
  } catch (cause) {
    if (isEmptyRemoteFailure(cause)) return null;
    throw cause;
  }
}

/** Read an exact immutable version tag without mutating the repository. */
export async function readGitHistoryCommit(
  coordinates: GitRepositoryCoordinates,
  versionId: string,
  readToken: string,
): Promise<{readonly commitId: string} | null> {
  const tagRef = `refs/tags/v/${versionId}`;
  const refs = await listServerRefs({
    headers: authorizationHeaders(readToken),
    http,
    prefix: tagRef,
    url: coordinates.remoteUrl,
  });
  const exact = refs.find((candidate) => candidate.ref === tagRef);
  return exact === undefined ? null : {commitId: exact.oid};
}

async function remoteRefOid(
  coordinates: GitRepositoryCoordinates,
  ref: string,
  token: string,
): Promise<string | null> {
  const refs = await listServerRefs({
    headers: authorizationHeaders(token),
    http,
    prefix: ref,
    url: coordinates.remoteUrl,
  });
  return refs.find((candidate) => candidate.ref === ref)?.oid ?? null;
}

/**
 * Confirm a reported push actually owns both remote refs. While this worker
 * holds the durable claim no successor can advance main past this version, so
 * any mismatch means the update lost a race and must surface as a failure.
 */
async function assertPushedRefs(
  coordinates: GitRepositoryCoordinates,
  tagRef: string,
  commitId: string,
  token: string,
): Promise<void> {
  const branch = await remoteRefOid(coordinates, "refs/heads/main", token);
  if (branch !== commitId) throw new Error("git_history_branch_update_mismatch");
  const tag = await remoteRefOid(coordinates, tagRef, token);
  if (tag !== commitId) throw new Error("git_history_tag_update_mismatch");
}

async function localMainCommit(workspace: MemoryWorkspace): Promise<string | null> {
  try {
    return await resolveRef({
      dir: workspace.dir,
      fs: workspace.fs,
      ref: "refs/heads/main",
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "NotFoundError") return null;
    throw cause;
  }
}

async function assertVersionCommit(
  workspace: MemoryWorkspace,
  commitId: string,
  request: GitHistoryCommitRequest,
): Promise<void> {
  const {commit: savedCommit} = await readCommit({
    dir: workspace.dir,
    fs: workspace.fs,
    oid: commitId,
  });
  const expectedParents = request.expectedParentCommitId === null
    ? []
    : [request.expectedParentCommitId];
  if (
    savedCommit.parent.length !== expectedParents.length ||
    savedCommit.parent.some((parent, index) => parent !== expectedParents[index])
  ) {
    throw new Error("git_history_commit_parent_mismatch");
  }
  const metadataFile = await readBlob({
    dir: workspace.dir,
    filepath: ".artifactserver/version.json",
    fs: workspace.fs,
    oid: commitId,
  });
  const saved = Schema.decodeUnknownSync(versionMetadataSchema)(
    JSON.parse(new TextDecoder().decode(metadataFile.blob)),
  );
  const expected = request.metadata;
  if (
    saved.artifactId !== expected.artifactId ||
    saved.createdAt !== expected.createdAt ||
    saved.entryPath !== expected.entryPath ||
    saved.installationId !== expected.installationId ||
    saved.manifestDigest !== expected.manifestDigest ||
    saved.projectId !== expected.projectId ||
    saved.publisherPrincipalId !== expected.publisherPrincipalId ||
    saved.versionId !== expected.versionId ||
    saved.versionNumber !== expected.versionNumber
  ) {
    throw new Error("git_history_commit_metadata_mismatch");
  }
  const expectedFiles = [...request.files, ...gitHistoryMetadataFiles(request)];
  const paths = await listFiles({
    dir: workspace.dir,
    fs: workspace.fs,
    ref: commitId,
  });
  if (
    JSON.stringify(paths.toSorted()) !== JSON.stringify(
      expectedFiles.map((file) => file.path).toSorted(),
    )
  ) {
    throw new Error("git_history_commit_files_mismatch");
  }
  const verifyFile = async (index: number): Promise<void> => {
    const file = expectedFiles[index];
    if (file === undefined) return;
    const savedFile = await readBlob({
      dir: workspace.dir,
      filepath: file.path,
      fs: workspace.fs,
      oid: commitId,
    });
    if (!Buffer.from(savedFile.blob).equals(Buffer.from(file.bytes))) {
      throw new Error("git_history_commit_bytes_mismatch");
    }
    await verifyFile(index + 1);
  };
  await verifyFile(0);
}

interface MemoryWorkspace {
  readonly dir: string;
  readonly fs: ReturnType<typeof createFsFromVolume>;
}

async function openWorkspace(
  remoteUrl: string,
  token: string,
): Promise<MemoryWorkspace> {
  const volume = new Volume();
  const fs = createFsFromVolume(volume);
  const dir = "/repository";
  await fs.promises.mkdir(dir, {recursive: true});
  try {
    await clone({
      dir,
      fs,
      headers: authorizationHeaders(token),
      http,
      noTags: false,
      singleBranch: true,
      url: remoteUrl,
    });
    await checkout({dir, fs, ref: "main"});
  } catch (cause) {
    if (!isEmptyRemoteFailure(cause)) throw cause;
    await init({defaultBranch: "main", dir, fs});
    await addRemote({dir, fs, remote: "origin", url: remoteUrl});
  }
  return {dir, fs};
}

async function replaceWorkingTree(
  fs: ReturnType<typeof createFsFromVolume>,
  dir: string,
  files: readonly {readonly bytes: Uint8Array; readonly path: string}[],
): Promise<void> {
  await removeTrackedFiles(fs, dir, await listFiles({dir, fs}));
  await addCommitFiles(fs, dir, files);
}

async function removeTrackedFiles(
  fs: ReturnType<typeof createFsFromVolume>,
  dir: string,
  files: readonly string[],
  index = 0,
): Promise<void> {
  const file = files[index];
  if (file === undefined) return;
  await fs.promises.rm(`${dir}/${file}`, {force: true});
  await remove({dir, filepath: file, fs});
  await removeTrackedFiles(fs, dir, files, index + 1);
}

async function addCommitFiles(
  fs: ReturnType<typeof createFsFromVolume>,
  dir: string,
  files: readonly {readonly bytes: Uint8Array; readonly path: string}[],
  index = 0,
): Promise<void> {
  const file = files[index];
  if (file === undefined) return;
  const target = `${dir}/${file.path}`;
  const separator = target.lastIndexOf("/");
  await fs.promises.mkdir(target.slice(0, separator), {recursive: true});
  await fs.promises.writeFile(target, Buffer.from(file.bytes));
  await add({dir, filepath: file.path, fs});
  await addCommitFiles(fs, dir, files, index + 1);
}

function deterministicSignature(timestamp: number) {
  return {
    email: "history@artifactserver.invalid",
    name: "Artifact Server",
    timestamp,
    timezoneOffset: 0,
  };
}

function authorizationHeaders(token: string) {
  return {Authorization: `Bearer ${token}`};
}

async function readControlPlaneResponse(response: Response): Promise<string> {
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel();
    throw new Error(`cloudflare_control_plane_status_${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumControlPlaneResponseBytes) {
    throw new Error("cloudflare_control_plane_response_too_large");
  }
  return new TextDecoder().decode(bytes);
}

async function decodeRepositoryResponse(response: Response) {
  const envelope = Schema.decodeUnknownSync(Schema.Struct({
    result: repositorySchema,
    success: Schema.Literal(true),
  }))(JSON.parse(await readControlPlaneResponse(response)));
  return envelope.result;
}

async function decodeTokenResponse(response: Response) {
  const envelope = Schema.decodeUnknownSync(Schema.Struct({
    result: issuedTokenSchema,
    success: Schema.Literal(true),
  }))(JSON.parse(await readControlPlaneResponse(response)));
  return envelope.result;
}

function assertApiOrigin(origin: URL): void {
  if (origin.username !== "" || origin.password !== "") {
    throw new Error("The Cloudflare API origin cannot contain credentials.");
  }
  if (origin.origin === apiOrigin.origin) return;
  const loopback = origin.hostname === "127.0.0.1" || origin.hostname === "[::1]";
  if (!loopback) throw new Error("A test API origin must use exact loopback.");
}

function assertCredentialFreeRemote(value: string): void {
  const remote = new URL(value);
  if (remote.protocol !== "https:" || remote.username !== "" || remote.password !== "") {
    throw new Error("cloudflare_remote_is_not_credential_free_https");
  }
}

function assertRepositoryPrefix(prefix: string): void {
  if (prefix === "") return;
  if (!/^artifact-server-test-[a-z0-9-]{1,80}-$/u.test(prefix)) {
    throw new Error("A repository prefix must be a bounded live-suite prefix.");
  }
}

function isEmptyRemoteFailure(cause: unknown): boolean {
  return cause instanceof Error && (
    cause.name === "NotFoundError" ||
    /could not find|empty|unborn|no commits|404/iu.test(cause.message)
  );
}
