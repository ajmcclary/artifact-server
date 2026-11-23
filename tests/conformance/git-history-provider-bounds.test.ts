import {execFile} from "node:child_process";
import {createHash} from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {promisify} from "node:util";

import {Redacted} from "effect";
import {afterEach, expect, test} from "vitest";
import {z} from "zod";

import {
  CloudflareArtifactsGitHistoryProvider,
  commitGitHistoryVersion,
  GitHistoryWorkspaceHandoff,
  lookupGitHistoryCommit,
  readGitHistoryCommit,
} from "../../src/git-history/cloudflare-artifacts-git-history-provider.js";
import {
  GitHistoryRemoteIncomplete,
  type GitHistoryCommitRequest,
  type GitRepositoryCoordinates,
} from "../../src/git-history/git-history-mirror.js";
import {startGitSmartHttpServer} from "../support/git-smart-http-server.js";

const execute = promisify(execFile);
const testToken = "disposable-git-bounds-token";
const addressSchema = z.object({port: z.number().int().positive()});
const coordinates = {
  artifactId: "art_bounds",
  defaultBranch: "main",
  projectId: "prj_bounds",
  provider: "cloudflare-artifacts",
  remoteUrl: "https://git.example.test/art_bounds",
  repositoryName: "art_bounds",
  status: "provisioned",
} as const;
const servers = new Set<{readonly server: Server; readonly open: Set<ServerResponse>}>();

afterEach(async () => {
  await Promise.all([...servers].map(({open, server}) => {
    for (const response of open) response.destroy();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  }));
  servers.clear();
});

async function startServer(
  handle: (response: ServerResponse) => void,
): Promise<string> {
  const open = new Set<ServerResponse>();
  const server = createServer((_request, response) => {
    open.add(response);
    response.once("close", () => open.delete(response));
    handle(response);
  });
  servers.add({open, server});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${addressSchema.parse(server.address()).port}`;
}

function providerFor(origin: string): CloudflareArtifactsGitHistoryProvider {
  return new CloudflareArtifactsGitHistoryProvider({
    apiOrigin: new URL(origin),
    apiToken: Redacted.make("bounds-test-token"),
    identity: {
      accountId: "bounds-account",
      namespace: "bounds-namespace",
      provider: "cloudflare-artifacts",
    },
  });
}

test("GIT-008 remote regression: a remote that never answers releases the smart-HTTP call at its deadline", async () => {
  const origin = await startServer(() => {
    // Accept the request and never send a status line.
  });
  const started = Date.now();
  await expect(readGitHistoryCommit(
    {...coordinates, remoteUrl: `${origin}/repository.git`},
    "ver_bounds",
    "bounds-test-token",
    {requestTimeoutMilliseconds: 250},
  )).rejects.toThrow(GitHistoryRemoteIncomplete);
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("GIT-008 remote regression: a ref advertisement that stalls after its service line is a failure, not an empty remote", async () => {
  const origin = await startServer((response) => {
    response.writeHead(200, {
      "Content-Type": "application/x-git-upload-pack-advertisement",
    });
    // A truncated pkt-line advertisement that never completes. Read as
    // end-of-stream, it would parse as a repository with no refs at all.
    response.write("001e# service=git-upload-pack\n0000");
  });
  const started = Date.now();
  await expect(readGitHistoryCommit(
    {...coordinates, remoteUrl: `${origin}/repository.git`},
    "ver_bounds",
    "bounds-test-token",
    {requestTimeoutMilliseconds: 250},
  )).rejects.toThrow("git_remote_deadline_exceeded");
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(200);
  expect(elapsed).toBeLessThan(5_000);
});

test("GIT-008 remote regression: a smart-HTTP ref listing that stalls before the version tag never reads as a missing tag", async () => {
  const remote = await startGitSmartHttpServer();
  try {
    const first = await seedFirstVersion(remote.remoteUrl);
    const proxy = await startStallingProxy(remote.remoteUrl, {
      ...refAdvertisementBeforeTag,
      mode: "stall",
    });
    const started = Date.now();
    await expect(readGitHistoryCommit(
      {...first.request.coordinates, remoteUrl: proxy.remoteUrl},
      first.request.metadata.versionId,
      testToken,
      {requestTimeoutMilliseconds: 300},
    )).rejects.toThrow("git_remote_deadline_exceeded");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(proxy.applied()).toBe(1);
    // The same remote, answered completely, still shows the tag.
    await expect(readGitHistoryCommit(
      {...first.request.coordinates, remoteUrl: proxy.remoteUrl},
      first.request.metadata.versionId,
      testToken,
      {requestTimeoutMilliseconds: 300},
    )).resolves.toEqual({commitId: first.commitId});
  } finally {
    await remote.close();
  }
});

test("GIT-008 remote regression: a ref listing cut cleanly at a pkt-line boundary is incomplete without its flush", async () => {
  const remote = await startGitSmartHttpServer();
  try {
    const first = await seedFirstVersion(remote.remoteUrl);
    const proxy = await startStallingProxy(remote.remoteUrl, {
      ...refAdvertisementBeforeTag,
      mode: "end",
    });
    await expect(readGitHistoryCommit(
      {...first.request.coordinates, remoteUrl: proxy.remoteUrl},
      first.request.metadata.versionId,
      testToken,
    )).rejects.toThrow("git_remote_response_incomplete");
    expect(proxy.applied()).toBe(1);
  } finally {
    await remote.close();
  }
});

test("GIT-008 remote regression: an upload-pack response that stalls mid-pack fails the job without touching the remote", async () => {
  const remote = await startGitSmartHttpServer();
  const git = async (...arguments_: string[]): Promise<string> => {
    const {stdout} = await execute("git", ["--git-dir", remote.barePath, ...arguments_]);
    return stdout.trim();
  };
  try {
    const first = await seedFirstVersion(remote.remoteUrl);
    const proxy = await startStallingProxy(remote.remoteUrl, {
      matches: (request) => request.method === "POST" &&
        request.path.endsWith("/git-upload-pack"),
      mode: "stall",
      // Forward the negotiation and part of the side-band pack, then stall.
      cut: (body) => Math.floor(body.byteLength / 2),
    });
    const second = versionRequest(
      {...first.request.coordinates, remoteUrl: proxy.remoteUrl},
      2,
      "ver_git_bounds_2",
      first.commitId,
    );
    const workspaces = new GitHistoryWorkspaceHandoff();
    const started = Date.now();
    await expect(lookupGitHistoryCommit(second, testToken, workspaces, {
      requestTimeoutMilliseconds: 300,
    })).rejects.toThrow(GitHistoryRemoteIncomplete);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(proxy.applied()).toBe(1);
    expect(await git("rev-parse", "refs/heads/main")).toBe(first.commitId);
    // Nothing from the stalled clone is handed on; the retried job converges.
    expect(await lookupGitHistoryCommit(second, testToken, workspaces)).toBeNull();
    const secondCommit = await commitGitHistoryVersion(second, testToken, workspaces);
    expect(await git("rev-list", "--parents", "-n", "1", secondCommit.commitId))
      .toBe(`${secondCommit.commitId} ${first.commitId}`);
  } finally {
    await remote.close();
  }
});

test("GIT-010 regression: an oversized declared control-plane response is refused before it is read", async () => {
  const origin = await startServer((response) => {
    response.writeHead(200, {
      "Content-Length": String(10 * 1024 * 1024),
      "Content-Type": "application/json",
    });
    response.write("{");
  });
  await expect(providerFor(origin).issueCredential(coordinates, "read", 60))
    .rejects.toThrow("cloudflare_control_plane_response_too_large");
});

test("GIT-010 regression: an endless undeclared control-plane response is cut off at the byte bound", async () => {
  const origin = await startServer((response) => {
    response.writeHead(200, {"Content-Type": "application/json"});
    const chunk = Buffer.alloc(16 * 1024, 0x20);
    const pump = (): void => {
      while (!response.destroyed && response.write(chunk)) {
        // Keep the socket full until the client stops reading.
      }
      if (!response.destroyed) response.once("drain", pump);
    };
    pump();
  });
  await expect(providerFor(origin).issueCredential(coordinates, "read", 60))
    .rejects.toThrow("cloudflare_control_plane_response_too_large");
});

test("GIT-010 regression: a bounded control-plane response still decodes", async () => {
  const origin = await startServer((response) => {
    const body = JSON.stringify({
      result: {expires_at: "2026-11-22T00:01:00.000Z", plaintext: "issued-token", scope: "read"},
      success: true,
    });
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(body);
  });
  await expect(providerFor(origin).issueCredential(coordinates, "read", 60))
    .resolves.toEqual({expiresAt: "2026-11-22T00:01:00.000Z", token: "issued-token"});
});

interface ProxiedRequest {
  readonly body: Buffer;
  readonly method: string;
  readonly path: string;
}

interface StallPlan {
  /** How many upstream response bytes to forward before the stall. */
  readonly cut: (body: Buffer) => number;
  readonly matches: (request: ProxiedRequest) => boolean;
  /** Hold the socket open, or end the response cleanly at the cut. */
  readonly mode: "end" | "stall";
}

/** A v1 ref advertisement, cut at the pkt-line that would carry the version tag. */
const refAdvertisementBeforeTag = {
  cut: (body: Buffer) => {
    const name = body.indexOf("refs/tags/v/");
    if (name === -1) throw new Error("The advertisement carries no version tag.");
    // Back up over the four-digit length and the forty-digit object ID.
    return name - 45;
  },
  matches: (request: ProxiedRequest) => request.method === "GET" &&
    request.path.endsWith("/info/refs?service=git-upload-pack"),
} as const;

/**
 * A pass-through proxy in front of a real Git smart-HTTP remote that applies
 * one stall to the first matching exchange and forwards everything else.
 * Upstream framing headers are dropped so the cut body is sent chunked.
 */
async function startStallingProxy(upstreamRemoteUrl: string, plan: StallPlan) {
  const upstream = new URL(upstreamRemoteUrl);
  let applied = 0;
  const origin = await startRawServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const proxied = {
      body: Buffer.concat(chunks),
      method: request.method ?? "GET",
      path: request.url ?? "/",
    };
    const stall = applied === 0 && plan.matches(proxied);
    if (stall) applied += 1;
    const answer = await new Promise<IncomingMessage>((resolve, reject) => {
      const outbound = httpRequest({
        headers: {...request.headers, host: upstream.host},
        hostname: upstream.hostname,
        method: proxied.method,
        path: proxied.path,
        port: upstream.port,
      }, resolve);
      outbound.once("error", reject);
      outbound.end(proxied.body);
    });
    const parts: Buffer[] = [];
    for await (const chunk of answer) parts.push(Buffer.from(chunk));
    const body = Buffer.concat(parts);
    const headers = {...answer.headers};
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    response.writeHead(answer.statusCode ?? 502, headers);
    if (!stall) {
      response.end(body);
      return;
    }
    const cut = plan.cut(body);
    if (cut <= 0 || cut >= body.byteLength) {
      throw new Error("The stall must cut inside the upstream body.");
    }
    if (plan.mode === "end") {
      response.end(body.subarray(0, cut));
      return;
    }
    response.write(body.subarray(0, cut));
  });
  const path = upstream.pathname;
  return {
    applied: () => applied,
    remoteUrl: `${origin}${path}`,
  };
}

async function startRawServer(
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Promise<string> {
  const open = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    open.add(response);
    response.once("close", () => open.delete(response));
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  servers.add({open, server});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${addressSchema.parse(server.address()).port}`;
}

async function seedFirstVersion(remoteUrl: string) {
  const request = versionRequest({
    artifactId: "art_git_bounds",
    defaultBranch: "main",
    projectId: "prj_git_bounds",
    provider: "cloudflare-artifacts",
    remoteUrl,
    repositoryName: "repository.git",
    status: "provisioned",
  }, 1, "ver_git_bounds_1", null);
  const {commitId} = await commitGitHistoryVersion(request, testToken);
  return {commitId, request};
}

function versionRequest(
  remoteCoordinates: GitRepositoryCoordinates,
  versionNumber: number,
  versionId: string,
  expectedParentCommitId: string | null,
): GitHistoryCommitRequest {
  const bytes = new TextEncoder().encode(`Bounded Git version ${versionNumber}`);
  return {
    assertOwner: async () => {},
    coordinates: remoteCoordinates,
    expectedParentCommitId,
    files: [{bytes, path: "index.html"}],
    metadata: {
      artifactId: remoteCoordinates.artifactId,
      createdAt: new Date(Date.UTC(2026, 10, 23, 12, versionNumber)).toISOString(),
      entryPath: "index.html",
      installationId: "ins_git_bounds",
      manifestDigest: createHash("sha256").update(bytes).digest("hex"),
      projectId: remoteCoordinates.projectId,
      publisherPrincipalId: "principal_git_bounds",
      versionId,
      versionNumber,
    },
    pointers: [],
  };
}
