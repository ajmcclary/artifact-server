import {createServer, type Server, type ServerResponse} from "node:http";

import {Redacted} from "effect";
import {listServerRefs} from "isomorphic-git";
import {afterEach, expect, test} from "vitest";
import {z} from "zod";

import {
  boundedGitHttp,
  CloudflareArtifactsGitHistoryProvider,
} from "../../src/git-history/cloudflare-artifacts-git-history-provider.js";

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
  await expect(listServerRefs({
    http: boundedGitHttp(250),
    url: `${origin}/repository.git`,
  })).rejects.toThrow(/timeout|aborted/iu);
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("GIT-008 remote regression: a remote that stalls mid-body releases the smart-HTTP call at its deadline", async () => {
  const origin = await startServer((response) => {
    response.writeHead(200, {
      "Content-Type": "application/x-git-upload-pack-advertisement",
    });
    // A truncated pkt-line advertisement that never completes.
    response.write("001e# service=git-upload-pack\n");
  });
  const started = Date.now();
  // isomorphic-git reads an aborted pkt-line stream as its end, so the call
  // may settle with a truncated advertisement; what matters is that it
  // settles at the deadline instead of holding the mirror lease.
  await Promise.allSettled([listServerRefs({
    http: boundedGitHttp(250),
    url: `${origin}/repository.git`,
  })]);
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(200);
  expect(elapsed).toBeLessThan(5_000);
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
