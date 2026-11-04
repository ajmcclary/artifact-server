import {glob, readFile} from "node:fs/promises";
import {connect} from "node:net";
import {networkInterfaces} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {publishNew} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

const accessChangeSchema = z.object({
  artifact: z.object({accessSetting: z.literal("public_link")}).loose(),
  links: z.object({version: z.url()}).loose(),
}).loose();

/** Whether a TCP connection to `host:port` is accepted. */
function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({host, port, timeout: 1_000});
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

/** IPv4 addresses of this machine that other hosts could route to. */
function externalAddresses(): readonly string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

describe("a public link removes sign-in without changing network reachability", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function enablePublicLink() {
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Shared without an account</title>",
      idempotencyKey: "auth-003-public-link-fixture",
    });
    const changed = await fetch(
      new URL(`/api/v1/artifacts/${published.body.artifact.id}/access`, server.baseUrl),
      {
        body: JSON.stringify({
          accessSetting: "public_link",
          expectedCurrentVersionId: published.body.version.id,
        }),
        headers: {
          Authorization: `Bearer ${installation.apiToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "auth-003-make-public-link",
        },
        method: "PATCH",
      },
    );
    expect(changed.status).toBe(200);
    return {
      artifactId: published.body.artifact.id,
      versionUrl: accessChangeSchema.parse(await changed.json()).links.version,
    };
  }

  test("AUTH-003-B: a caller that can reach the installation opens the current version of a public link without an account", async () => {
    const shared = await enablePublicLink();
    // The stable link resolves anonymously to the current version's origin.
    const opened = await fetch(new URL(`/artifacts/${shared.artifactId}`, server.baseUrl), {
      redirect: "manual",
    });
    expect(opened.status).toBe(302);
    expect(opened.headers.get("location")).toBe(shared.versionUrl);
    expect(opened.headers.get("set-cookie")).toBeNull();
    const content = await fetchVersion(server, shared.versionUrl);
    expect(content.status).toBe(200);
    expect(content.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await content.text()).toContain("Shared without an account");
  });

  test("AUTH-003-F: enabling a public link opens no new listener, tunnel, or process and leaves the link unenumerable", async () => {
    const externalBefore = await Promise.all(
      externalAddresses().map((address) => accepts(address, server.port)),
    );
    const shared = await enablePublicLink();

    // Reachability is unchanged: the server still listens only on loopback,
    // and no external interface accepts the application port.
    expect(server.hostname).toBe("127.0.0.1");
    expect(await accepts("127.0.0.1", server.port)).toBe(true);
    const externalAfter = await Promise.all(
      externalAddresses().map((address) => accepts(address, server.port)),
    );
    const unreachable = externalAddresses().map(() => false);
    expect({after: externalAfter, before: externalBefore}).toEqual({after: unreachable, before: unreachable});

    // Server code cannot open a tunnel or spawn a helper process: outside the
    // operator CLI nothing imports a process or raw-socket API, and only the
    // two server entry points listen, on their configured host.
    const offenders: string[] = [];
    const listeners: string[] = [];
    for await (const relativePath of glob("src/**/*.ts", {cwd: repositoryRoot})) {
      const posixPath = relativePath.split(path.sep).join("/");
      if (posixPath.startsWith("src/cli/")) continue;
      // eslint-disable-next-line no-await-in-loop -- a bounded source scan
      const source = await readFile(path.join(repositoryRoot, relativePath), "utf8");
      if (/"node:(?:child_process|dgram|cluster|worker_threads)"/u.test(source)) offenders.push(posixPath);
      if (/\.listen\(/u.test(source)) listeners.push(posixPath);
    }
    expect(offenders).toEqual([]);
    expect(listeners.toSorted()).toEqual([
      "src/external-storage/start-external-storage-server.ts",
      "src/local/start-local-server.ts",
    ]);

    // The link is not enumerable: no anonymous listing, search, or activity
    // route reveals it, and its identifier is a random UUID.
    const anonymousStatuses = await Promise.all([
      "/api/v1/artifacts",
      "/api/v1/library",
      "/api/v1/projects",
      "/api/v1/activity",
      `/api/v1/artifacts/${shared.artifactId}`,
      `/api/v1/artifacts/${shared.artifactId}/versions`,
    ].map(async (route) => {
      const response = await fetch(new URL(route, server.baseUrl));
      await response.arrayBuffer();
      return [route, response.status] as const;
    }));
    expect(anonymousStatuses.filter(([, status]) => status !== 401)).toEqual([]);
    expect(shared.artifactId).toMatch(
      /^art_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });
});
