import {createHash, randomBytes} from "node:crypto";
import {createServer as createHttpServer} from "node:http";

import {afterAll, beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  managedBootstrapToken,
  managedProcessExited,
  managedRunInstallationId,
  type ManagedExternalStorageProcess,
  readManagedExternalStorageEnvironment,
  startManagedExternalStorageProcess,
} from "../support/managed-external-storage.js";
import {
  type RunningStubOidcProvider,
  startStubOidcProvider,
} from "../support/stub-oidc-provider.js";

/**
 * Live deployed-runtime resume qualification (T05): the compiled
 * external-storage server runs against managed Postgres and a real S3 bucket
 * while a server crash and a lost commit response are forced through the real
 * HTTP boundary. Opt-in: requires ARTIFACT_SERVER_TEST_DATABASE_URL and
 * ARTIFACT_SERVER_TEST_S3_BUCKET; object-storage credentials resolve through
 * the AWS provider chain (AWS_PROFILE).
 */
const environment = readManagedExternalStorageEnvironment();

const uploadPlanSchema = z.object({
  commitUrl: z.url().optional(),
  files: z.array(z.object({
    path: z.string(),
    uploadUrl: z.url(),
    verified: z.boolean(),
  }).loose()),
  manifestDigest: z.string(),
  replayed: z.boolean().optional(),
  status: z.enum(["created", "resumed"]),
  uploadId: z.string().optional(),
  artifact: z.object({id: z.string()}).loose().optional(),
  version: z.object({id: z.string(), number: z.number().int().positive()}).loose()
    .optional(),
}).loose();

const committedPlanSchema = z.object({
  artifact: z.object({id: z.string()}).loose(),
  replayed: z.boolean(),
  status: z.literal("committed"),
  version: z.object({id: z.string(), number: z.number().int().positive()}).loose(),
}).loose();

const publishResultSchema = z.object({
  artifact: z.object({id: z.string()}).loose(),
  replayed: z.boolean(),
  version: z.object({id: z.string(), number: z.number().int().positive()}).loose(),
}).loose();

interface LiveFile {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly path: string;
}

function declaredFiles(files: readonly LiveFile[]) {
  return files.map((file) => ({
    mediaType: file.mediaType,
    path: file.path,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
    size: file.bytes.byteLength,
  }));
}

async function createUpload(
  baseUrl: string,
  token: string,
  idempotencyKey: string,
  files: readonly LiveFile[],
) {
  const response = await fetch(`${baseUrl}/api/v1/uploads`, {
    body: JSON.stringify({
      entryPath: files[0]?.path ?? "index.html",
      files: declaredFiles(files),
      routingMode: "static",
    }),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    method: "POST",
  });
  const raw: unknown = await response.json();
  const status = z.object({status: z.string()}).loose().parse(raw).status;
  const body = status === "committed"
    ? committedPlanSchema.parse(raw)
    : uploadPlanSchema.parse(raw);
  return {body, response};
}

async function putFile(
  baseUrl: string,
  token: string,
  uploadUrl: string,
  bytes: Uint8Array,
): Promise<Response> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return fetch(uploadUrl, {
    body: copy.buffer,
    headers: {Authorization: `Bearer ${token}`},
    method: "PUT",
  });
}

async function commitUpload(
  token: string,
  commitUrl: string,
  idempotencyKey: string,
  name: string,
) {
  const response = await fetch(commitUrl, {
    body: JSON.stringify({target: {
      accessSetting: "account_required",
      kind: "new_artifact",
      name,
      tags: ["deployed-runtime-resume"],
    }}),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    method: "POST",
  });
  return {body: publishResultSchema.parse(await response.json()), response};
}

async function listVersionIds(
  baseUrl: string,
  token: string,
  artifactId: string,
): Promise<readonly string[]> {
  const response = await fetch(
    `${baseUrl}/api/v1/artifacts/${artifactId}/versions`,
    {headers: {Authorization: `Bearer ${token}`}},
  );
  expect(response.status).toBe(200);
  return z.object({
    versions: z.array(z.object({version: z.object({id: z.string()})})),
  }).parse(await response.json()).versions.map(({version}) => version.id);
}

async function readVersionFile(
  baseUrl: string,
  token: string,
  artifactId: string,
  versionId: string,
  filePath: string,
): Promise<Uint8Array> {
  const response = await fetch(
    `${baseUrl}/api/v1/artifacts/${artifactId}/versions/${versionId}/file?${
      new URLSearchParams({path: filePath})
    }`,
    {headers: {Authorization: `Bearer ${token}`}},
  );
  expect(response.status).toBe(200);
  return new Uint8Array(await response.arrayBuffer());
}

/** Proxy that forwards everything but destroys the first commit response. */
function startLostCommitProxy(upstreamOrigin: string): Promise<{
  readonly dropped: () => number;
  readonly origin: string;
  readonly stop: () => Promise<void>;
}> {
  let dropped = 0;
  let origin = "";
  const server = createHttpServer(async (request, response) => {
    try {
      const target = new URL(request.url ?? "/", upstreamOrigin);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const requestBody = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (
          value === undefined || name === "host" || name === "connection" ||
          name === "content-length" || name === "transfer-encoding"
        ) continue;
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const init: RequestInit & {duplex?: "half"} = {
        duplex: "half",
        headers,
        method: request.method ?? "GET",
      };
      if (requestBody.length !== 0) {
        init.body = requestBody;
      }
      const upstream = await fetch(target, init);
      const body = await upstream.text();
      if (
        request.method === "POST" && target.pathname.endsWith("/commit") &&
        dropped === 0
      ) {
        dropped += 1;
        response.destroy();
        return;
      }
      let responseBody = body;
      if (request.method === "POST" && target.pathname === "/api/v1/uploads") {
        const decoded = uploadPlanSchema.safeParse(JSON.parse(body));
        if (decoded.success && decoded.data.commitUrl !== undefined) {
          responseBody = JSON.stringify({
            ...decoded.data,
            commitUrl: decoded.data.commitUrl.replace(upstreamOrigin, origin),
            files: decoded.data.files.map((file) =>
              Object.assign({}, file, {
                uploadUrl: file.uploadUrl.replace(upstreamOrigin, origin),
              })
            ),
          });
        }
      }
      response.writeHead(upstream.status, {"Content-Type": "application/json"});
      response.end(responseBody);
    } catch {
      response.writeHead(502, {"Content-Type": "text/plain"});
      response.end("proxy failure");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = z.object({port: z.number()}).safeParse(server.address());
      if (!address.success) {
        reject(new Error("The lost-commit proxy did not bind a port."));
        return;
      }
      origin = `http://127.0.0.1:${address.data.port}`;
      resolve({
        dropped: () => dropped,
        origin,
        stop: () =>
          new Promise<void>((stopResolve, stopReject) => {
            server.close((error) =>
              error === undefined ? stopResolve() : stopReject(error)
            );
          }),
      });
    });
  });
}

function killHard(process: ManagedExternalStorageProcess): Promise<void> {
  return new Promise((resolve) => {
    if (managedProcessExited(process.child)) {
      resolve();
      return;
    }
    process.child.once("exit", () => resolve());
    process.child.kill("SIGKILL");
  });
}

describe.skipIf(environment === undefined)(
  "deployed managed external-storage resume (live)",
  {timeout: 300_000},
  () => {
    if (environment === undefined) {
      throw new Error("The managed environment is required to run this suite.");
    }
    const managed = environment;
    let oidc: RunningStubOidcProvider;
    const running: ManagedExternalStorageProcess[] = [];

    async function startServer(installationId: string, token: string) {
      const server = await startManagedExternalStorageProcess({
        apiToken: token,
        environment: managed,
        installationId,
        oidcIssuer: oidc.issuer,
      });
      running.push(server);
      return server;
    }

    beforeAll(async () => {
      oidc = await startStubOidcProvider({
        clientId: "managed-external-storage-live",
      });
    }, 60_000);

    afterAll(async () => {
      await Promise.all(running.map(async (server) => {
        if (!managedProcessExited(server.child)) await server.stop();
      }));
      await oidc.stop();
    });

    test(
      "a server crash mid-publication resumes verified files and commits one version",
      async () => {
        const installationId = managedRunInstallationId("crash-resume");
        const token = managedBootstrapToken("crash-resume");
        const key = `live-crash-resume-${randomBytes(8).toString("hex")}`;
        const small: LiveFile = {
          bytes: new TextEncoder().encode(
            "<h1>deployed crash-resume marker</h1>",
          ),
          mediaType: "text/html; charset=utf-8",
          path: "index.html",
        };
        const large: LiveFile = {
          bytes: randomBytes(16 * 1024 * 1024),
          mediaType: "application/octet-stream",
          path: "assets/large.bin",
        };
        const files = [small, large];

        const first = await startServer(installationId, token);
        const created = await createUpload(first.baseUrl, token, key, files);
        if (created.body.status === "committed") {
          throw new Error("A fresh idempotency key must not replay.");
        }

        const smallPlan = created.body.files.find((file) =>
          file.path === small.path
        );
        const largePlan = created.body.files.find((file) =>
          file.path === large.path
        );
        if (smallPlan === undefined) {
          throw new Error(`Upload plan missing ${small.path}.`);
        }
        if (largePlan === undefined) {
          throw new Error(`Upload plan missing ${large.path}.`);
        }
        expect(smallPlan.verified).toBe(false);
        expect(largePlan.verified).toBe(false);

        const smallUpload = await putFile(
          first.baseUrl,
          token,
          smallPlan.uploadUrl,
          small.bytes,
        );
        expect(smallUpload.status).toBe(200);

        // Kill the server mid-file: the large transfer is still in flight.
        const largeUpload = putFile(
          first.baseUrl,
          token,
          largePlan.uploadUrl,
          large.bytes,
        ).catch((error) => error);
        await new Promise((resolve) => setTimeout(resolve, 400));
        await killHard(first);
        await largeUpload;

        const second = await startServer(installationId, token);
        const resumed = await createUpload(second.baseUrl, token, key, files);
        if (resumed.body.status === "committed") {
          throw new Error("An uncommitted key must not replay.");
        }
        expect(resumed.body.status).toBe("resumed");
        expect(resumed.body.uploadId).toBe(created.body.uploadId);
        const resumedSmall = resumed.body.files.find((file) =>
          file.path === small.path
        );
        expect(resumedSmall?.verified).toBe(true);

        for (const planned of resumed.body.files) {
          if (planned.verified) continue;
          const source = files.find((file) => file.path === planned.path);
          if (source === undefined) {
            throw new Error(`Source file missing ${planned.path}.`);
          }
          // eslint-disable-next-line no-await-in-loop -- uploads must complete before commit
          const upload = await putFile(
            second.baseUrl,
            token,
            planned.uploadUrl,
            source.bytes,
          );
          expect(upload.status).toBe(200);
        }

        if (resumed.body.commitUrl === undefined) {
          throw new Error("Resumed upload plan has no commit URL.");
        }
        const committed = await commitUpload(
          token,
          resumed.body.commitUrl,
          key,
          "Deployed crash resume",
        );
        expect(committed.body.version.number).toBe(1);

        const versionIds = await listVersionIds(
          second.baseUrl,
          token,
          committed.body.artifact.id,
        );
        expect(versionIds).toEqual([committed.body.version.id]);
        for (const file of files) {
          // eslint-disable-next-line no-await-in-loop -- reads are sequential for verification
          const bytes = await readVersionFile(
            second.baseUrl,
            token,
            committed.body.artifact.id,
            committed.body.version.id,
            file.path,
          );
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(
            createHash("sha256").update(file.bytes).digest("hex"),
          );
        }
      },
    );

    test(
      "a lost commit response replays the committed publication without transfer",
      async () => {
        const installationId = managedRunInstallationId("lost-commit");
        const token = managedBootstrapToken("lost-commit");
        const key = `live-lost-commit-${randomBytes(8).toString("hex")}`;
        const files: readonly LiveFile[] = [
          {
            bytes: new TextEncoder().encode(
              "<h1>deployed lost-commit marker</h1>",
            ),
            mediaType: "text/html; charset=utf-8",
            path: "index.html",
          },
          {
            bytes: randomBytes(256 * 1024),
            mediaType: "application/octet-stream",
            path: "assets/payload.bin",
          },
        ];

        const server = await startServer(installationId, token);
        const proxy = await startLostCommitProxy(server.baseUrl);
        try {
          const created = await createUpload(proxy.origin, token, key, files);
          if (created.body.status === "committed") {
            throw new Error("A fresh idempotency key must not replay.");
          }
          for (const planned of created.body.files) {
            const source = files.find((file) => file.path === planned.path);
            if (source === undefined) {
              throw new Error(`Source file missing ${planned.path}.`);
            }
            // eslint-disable-next-line no-await-in-loop -- uploads must complete before replay
            const upload = await putFile(
              proxy.origin,
              token,
              planned.uploadUrl,
              source.bytes,
            );
            expect(upload.status).toBe(200);
          }
          if (created.body.commitUrl === undefined) {
            throw new Error("Created upload plan has no commit URL.");
          }
          await expect(
            commitUpload(token, created.body.commitUrl, key, "Lost commit"),
          ).rejects.toThrow(/fetch failed|socket hang up|ECONNRESET|network|abort|terminated|Unexpected end/iu);
          expect(proxy.dropped()).toBe(1);

          const replayed = await createUpload(
            server.baseUrl,
            token,
            key,
            files,
          );
          if (replayed.body.status !== "committed") {
            throw new Error("A committed key must replay without a plan.");
          }
          expect(replayed.body.replayed).toBe(true);
          expect(replayed.body.version.number).toBe(1);

          const versionIds = await listVersionIds(
            server.baseUrl,
            token,
            replayed.body.artifact.id,
          );
          expect(versionIds).toEqual([replayed.body.version.id]);
          const firstFile = files[0];
          if (firstFile === undefined) {
            throw new Error("The lost-commit test files are empty.");
          }
          const bytes = await readVersionFile(
            server.baseUrl,
            token,
            replayed.body.artifact.id,
            replayed.body.version.id,
            firstFile.path,
          );
          expect(new TextDecoder().decode(bytes)).toBe(
            "<h1>deployed lost-commit marker</h1>",
          );
        } finally {
          await proxy.stop();
        }
      },
    );
  },
);
