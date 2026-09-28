import {createHash} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {z} from "zod";
import {unstable_dev, type Unstable_DevWorker} from "wrangler";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

const apiToken = "cloudflare-test-api-token-0000000000000001";
const origin = "https://artifacts.example.test";
const contentDomain = "content.example.test";
const uploadPlanSchema = z.object({
  commitUrl: z.url(),
  files: z.array(z.object({
    path: z.string(),
    uploadUrl: z.url(),
  })).min(1),
});
const preparingResponseSchema = z.object({
  installed: z.number().int().nonnegative(),
  status: z.literal("preparing"),
  total: z.number().int().nonnegative(),
});
const publicationSchema = z.object({
  artifact: z.object({id: z.string()}),
  links: z.object({artifact: z.url(), version: z.url()}),
  version: z.object({id: z.string(), number: z.number().int().positive()}),
});
const committedUploadSchema = publicationSchema.extend({
  replayed: z.boolean(),
});
const artifactListSchema = z.object({
  artifacts: z.array(z.object({artifact: z.object({id: z.string()})})),
});
const notReadySchema = z.object({error: z.string()});
const versionListSchema = z.object({
  versions: z.array(z.object({
    version: z.object({id: z.string(), number: z.number().int().positive()}),
  })),
});
const actionListSchema = z.object({
  actions: z.array(z.object({action: z.string()})),
});
const projectGitHistorySchema = z.object({
  gitHistory: z.object({
    enabled: z.boolean(),
    projectId: z.string(),
    state: z.enum([
      "backfilling",
      "budget-limited",
      "degraded",
      "disabled",
      "ready",
      "waiting",
    ]),
  }).strict(),
}).strict();

let persistPath: string;
let worker: Unstable_DevWorker;

beforeAll(async () => {
  persistPath = await mkdtemp(join(tmpdir(), "artifact-server-cloudflare-"));
  worker = await startWorker(persistPath);
}, 30_000);

afterAll(async () => {
  await worker.stop();
  await rm(persistPath, {force: true, recursive: true});
});

describe("Cloudflare Worker runtime", () => {
  it("qualifies the MCP discovery and authorization boundary", async () => {
    const unsupportedMethods = await Promise.all(["GET", "DELETE"].map(
      (method) => worker.fetch(`${origin}/mcp`, {method}),
    ));
    for (const response of unsupportedMethods) {
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
    expect((await mcpRequest("server/discover", {}, null)).status).toBe(401);
    expect((await mcpRequest("server/discover", {}, "invalid-token")).status)
      .toBe(401);
    expect((await mcpRequest("server/discover", {}, apiToken, {
      Origin: "https://attacker.example",
    })).status).toBe(403);

    const discovery = await mcpRequest("server/discover", {});
    expect(discovery.status).toBe(200);
    expect(discovery.headers.has("mcp-session-id")).toBe(false);
    expect(z.object({result: z.object({
      supportedVersions: z.array(z.string()).min(1),
    }).loose()}).parse(await discovery.json()).result.supportedVersions)
      .toContain("2026-07-28");

    const listed = await mcpRequest("tools/list", {});
    expect(listed.status).toBe(200);
    const toolNames = z.object({result: z.object({
      tools: z.array(z.object({name: z.string()}).loose()),
    }).loose()}).parse(await listed.json()).result.tools.map((tool) => tool.name);
    expect(toolNames).toContain("artifact_capabilities");
    expect(toolNames).toContain("artifact_manifest_page");
    expect(toolNames).toContain("artifact_version_list");
    expect(toolNames).toContain("artifact_link");

    const templates = await mcpRequest("resources/templates/list", {});
    expect(templates.status).toBe(200);
    expect(z.object({result: z.object({
      resourceTemplates: z.array(z.object({name: z.string()}).loose()),
    }).loose()}).parse(await templates.json()).result.resourceTemplates.length)
      .toBeGreaterThan(0);

    const capabilities = await mcpTool("artifact_capabilities", {});
    expect(capabilities.isError).not.toBe(true);
    expect(z.object({
      deployment: z.object({mode: z.literal("remote")}),
      protocol: z.object({era: z.literal("modern"), version: z.literal("2026-07-28")}),
      publishing: z.object({localPathTool: z.literal(false)}),
    }).parse(capabilities.structuredContent)).toBeDefined();
    const unavailableLink = await mcpTool("artifact_link", {
      path: "/tmp/outside-cloudflare-root",
    });
    expect(unavailableLink.isError).toBe(true);
    expect(unavailableLink.content[0]?.text).toContain("CAPABILITY_UNAVAILABLE");

    const mismatchedName = await mcpRequest("tools/call", {
      arguments: {}, name: "artifact_capabilities",
    }, apiToken, {"Mcp-Name": "artifact_get"});
    expect(mismatchedName.status).toBe(400);
  });

  it("qualifies MCP publication recovery, projections and bounded version pages", async () => {
    const bytes = new TextEncoder().encode("Cloudflare MCP version one\n");
    const file = {
      mediaType: "text/plain",
      path: "page.txt",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
    const idempotencyKey = "cloudflare-mcp-runtime-version-one";
    const createArguments = {entryPath: file.path, files: [file], idempotencyKey};
    const first = await mcpTool("artifact_create_upload", createArguments);
    const upload = z.object({
      files: z.array(z.object({uploadUrl: z.url()})),
      kind: z.literal("upload"),
      resumed: z.literal(false),
      uploadId: z.string(),
    }).parse(first.structuredContent);
    const resumed = await mcpTool("artifact_create_upload", createArguments);
    expect(resumed.structuredContent).toMatchObject({
      kind: "upload", resumed: true, uploadId: upload.uploadId,
    });
    const conflicting = await mcpTool("artifact_create_upload", {
      ...createArguments,
      files: [{...file, sha256: "0".repeat(64)}],
    });
    expect(conflicting.isError).toBe(true);
    expect(conflicting.content[0]?.text).toContain("IDEMPOTENCY_CONFLICT");

    const uploadUrl = upload.files[0]?.uploadUrl;
    if (uploadUrl === undefined) throw new Error("MCP upload plan has no file.");
    expect((await worker.fetch(uploadUrl, {
      body: bytes,
      headers: {Authorization: `Bearer ${apiToken}`},
      method: "PUT",
    })).status).toBe(200);
    const committed = z.object({
      artifact: z.object({id: z.string()}),
      version: z.object({id: z.string()}),
    }).parse((await mcpTool("artifact_commit_upload", {
      idempotencyKey,
      target: {kind: "new_artifact", name: "Worker MCP qualification"},
      uploadId: upload.uploadId,
    })).structuredContent);
    const replayed = await mcpTool("artifact_create_upload", createArguments);
    expect(replayed.structuredContent).toMatchObject({
      kind: "committed",
      publication: {version: {id: committed.version.id}},
    });

    const compact = await mcpTool("artifact_get", {
      artifactId: committed.artifact.id, projection: "compact",
    });
    const compactManifest = z.object({current: z.object({manifest: z.object({
      digest: z.string(), entryCount: z.literal(1), entryPath: z.literal("page.txt"),
    }).loose()})}).parse(compact.structuredContent).current.manifest;
    expect(compactManifest).not.toHaveProperty("entries");
    const full = await mcpTool("artifact_get", {artifactId: committed.artifact.id});
    const fullManifest = z.object({current: z.object({manifest: z.object({
      digest: z.string(), entries: z.array(z.object({path: z.string()})).length(1),
    }).loose()})}).parse(full.structuredContent).current.manifest;
    expect(fullManifest.digest).toBe(compactManifest.digest);
    expect(fullManifest.entries[0]?.path).toBe("page.txt");
    const manifestPage = z.object({
      entries: z.array(z.object({path: z.literal("page.txt")}).loose()).length(1),
      manifest: z.object({digest: z.string()}).loose(),
      nextCursor: z.null(),
      versionId: z.literal(committed.version.id),
    }).loose().parse((await mcpTool("artifact_manifest_page", {
      artifactId: committed.artifact.id,
      limit: 1,
      versionId: committed.version.id,
    })).structuredContent);
    expect(manifestPage.manifest.digest).toBe(fullManifest.digest);
    expect((await mcpTool("artifact_manifest_page", {
      artifactId: committed.artifact.id,
      cursor: "invalid-cursor",
      versionId: committed.version.id,
    })).isError).toBe(true);
    expect((await mcpTool("artifact_get", {
      artifactId: committed.artifact.id, projection: "summary",
    })).isError).toBe(true);

    const nextBytes = new TextEncoder().encode("Cloudflare MCP version two\n");
    const nextFile = {...file,
      sha256: createHash("sha256").update(nextBytes).digest("hex"),
      size: nextBytes.byteLength,
    };
    const nextUpload = z.object({
      files: z.array(z.object({uploadUrl: z.url()})),
      uploadId: z.string(),
    }).parse((await mcpTool("artifact_create_upload", {
      entryPath: nextFile.path, files: [nextFile],
    })).structuredContent);
    if (nextUpload.files[0] === undefined) throw new Error("Second upload plan is empty.");
    expect((await worker.fetch(nextUpload.files[0].uploadUrl, {
      body: nextBytes,
      headers: {Authorization: `Bearer ${apiToken}`},
      method: "PUT",
    })).status).toBe(200);
    const next = z.object({version: z.object({id: z.string()})}).parse(
      (await mcpTool("artifact_commit_upload", {
        idempotencyKey: "cloudflare-mcp-runtime-version-two",
        target: {
          artifactId: committed.artifact.id,
          expectedCurrentVersionId: committed.version.id,
          kind: "new_version",
        },
        uploadId: nextUpload.uploadId,
      })).structuredContent,
    );
    const firstPage = z.object({
      nextCursor: z.string(),
      versions: z.array(z.object({id: z.string()})).length(1),
    }).parse((await mcpTool("artifact_version_list", {
      artifactId: committed.artifact.id, limit: 1,
    })).structuredContent);
    expect(firstPage.versions[0]?.id).toBe(next.version.id);
    const secondPage = z.object({
      nextCursor: z.null(),
      versions: z.array(z.object({id: z.string()})).length(1),
    }).parse((await mcpTool("artifact_version_list", {
      artifactId: committed.artifact.id, cursor: firstPage.nextCursor, limit: 1,
    })).structuredContent);
    expect(secondPage.versions[0]?.id).toBe(committed.version.id);
    expect((await mcpTool("artifact_version_list", {
      artifactId: committed.artifact.id, cursor: "bad", limit: 1,
    })).isError).toBe(true);
  }, 60_000);

  it("serves the management application only from its configured origin", async () => {
    const shell = await worker.fetch(`${origin}/review?project=prj_default`);
    const shellHtml = await shell.text();
    if (shell.status !== 200) {
      throw new Error(`Management shell returned ${shell.status}: ${shellHtml}`);
    }
    expect(shell.headers.get("content-type")).toContain("text/html");
    expect(shell.headers.get("cache-control")).toBe("no-cache, must-revalidate");
    expect(shell.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(shellHtml).toContain('id="review-root"');

    const scriptPath = /src="(?<path>\/assets\/[^"]+\.js)"/u.exec(shellHtml)
      ?.groups?.["path"];
    if (scriptPath === undefined) {
      throw new Error("The Cloudflare management shell does not reference its script.");
    }
    const script = await worker.fetch(`${origin}${scriptPath}`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(script.headers.get("cache-control"))
      .toBe("public, max-age=31536000, immutable");

    const missingApi = await worker.fetch(`${origin}/api/v1/not-a-route`, {
      headers: {Authorization: `Bearer ${apiToken}`},
    });
    expect(missingApi.status).toBe(404);
    expect(missingApi.headers.get("content-type")).toContain("application/json");

    const contentHostRoute = await worker.fetch(
      `https://${"a".repeat(40)}.${contentDomain}/projects`,
    );
    expect(contentHostRoute.status).toBe(404);
    expect(contentHostRoute.headers.get("content-type")).toContain(
      "application/json",
    );
  });

  it("publishes through real local D1 and R2 and survives a Worker restart", async () => {
    const health = await worker.fetch(`${origin}/health`);
    const ready = await worker.fetch(`${origin}/ready`);
    expect(health.status).toBe(200);
    expect(ready.status).toBe(200);
    const scheduled = await worker.fetch(
      `${origin}/__scheduled?cron=${encodeURIComponent("*/15 * * * *")}`,
    );
    expect(scheduled.status).toBe(200);

    const unauthorized = await worker.fetch(`${origin}/api/v1/artifacts`);
    expect(unauthorized.status).toBe(401);

    const historyStatus = await worker.fetch(
      `${origin}/api/v1/projects/prj_default/git-history`,
      {headers: {Authorization: `Bearer ${apiToken}`}},
    );
    expect(historyStatus.status).toBe(200);
    expect(projectGitHistorySchema.parse(await historyStatus.json())).toEqual({
      gitHistory: {
        enabled: false,
        projectId: "prj_default",
        state: "disabled",
      },
    });
    const historyEnable = await worker.fetch(
      `${origin}/api/v1/projects/prj_default/git-history`,
      {
        body: JSON.stringify({confirmEstimate: true, enabled: true}),
        headers: authenticatedJsonHeaders(),
        method: "PUT",
      },
    );
    expect(historyEnable.status).toBe(501);

    const bytes = new TextEncoder().encode("<h1>Cloudflare runtime</h1>");
    const createUpload = await worker.fetch(`${origin}/api/v1/uploads`, {
      body: JSON.stringify({
        entryPath: "index.html",
        files: [{
          mediaType: "text/html; charset=utf-8",
          path: "index.html",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.byteLength,
        }],
      }),
      headers: authenticatedJsonHeaders(),
      method: "POST",
    });
    expect(createUpload.status).toBe(201);
    const uploadPlan = uploadPlanSchema.parse(await createUpload.json());
    const plannedFile = uploadPlan.files[0];
    if (plannedFile === undefined) throw new Error("The upload plan is empty.");

    const uploaded = await worker.fetch(plannedFile.uploadUrl, {
      body: bytes,
      headers: {Authorization: `Bearer ${apiToken}`},
      method: "PUT",
    });
    const uploadedBody = await uploaded.text();
    if (!uploaded.ok) {
      throw new Error(`Cloudflare upload failed with ${uploaded.status}: ${uploadedBody}`);
    }
    expect(uploaded.status).toBe(200);

    const committed = await worker.fetch(uploadPlan.commitUrl, {
      body: JSON.stringify({target: {
        accessSetting: "public_link",
        kind: "new_artifact",
        name: "Cloudflare runtime test",
        tags: ["cloudflare", "qualification"],
      }}),
      headers: {
        ...authenticatedJsonHeaders(),
        "Idempotency-Key": "cloudflare-runtime-publish-1",
      },
      method: "POST",
    });
    expect(committed.status).toBe(201);
    const publication = publicationSchema.parse(await committed.json());

    const rendered = await worker.fetch(publication.links.version);
    expect(rendered.status).toBe(200);
    expect(await rendered.text()).toBe("<h1>Cloudflare runtime</h1>");

    const artifact = await worker.fetch(publication.links.artifact, {
      headers: {Authorization: `Bearer ${apiToken}`},
      redirect: "manual",
    });
    expect(artifact.status).toBe(302);
    expect(artifact.headers.get("location")).toContain(`.${contentDomain}/`);

    await worker.stop();
    worker = await startWorker(persistPath);
    const afterRestart = await worker.fetch(`${origin}/api/v1/artifacts`, {
      headers: {Authorization: `Bearer ${apiToken}`},
    });
    expect(afterRestart.status).toBe(200);
    expect(artifactListSchema.parse(await afterRestart.json()).artifacts)
      .toContainEqual(expect.objectContaining({
        artifact: expect.objectContaining({id: publication.artifact.id}),
      }));

    const competingUploads = await Promise.all([
      stageFile("<h1>Second version A</h1>"),
      stageFile("<h1>Second version B</h1>"),
    ]);
    const competingCommits = await Promise.all(
      competingUploads.map((competingUpload, index) =>
        worker.fetch(competingUpload.commitUrl, {
          body: JSON.stringify({target: {
            artifactId: publication.artifact.id,
            expectedCurrentVersionId: publication.version.id,
            kind: "new_version",
          }}),
          headers: {
            ...authenticatedJsonHeaders(),
            "Idempotency-Key": `cloudflare-runtime-race-${index}`,
          },
          method: "POST",
        })
      ),
    );
    expect(competingCommits.map(({status}) => status).toSorted(
      (left, right) => left - right,
    ))
      .toEqual([201, 409]);

    const versions = await worker.fetch(
      `${origin}/api/v1/artifacts/${publication.artifact.id}/versions`,
      {headers: {Authorization: `Bearer ${apiToken}`}},
    );
    expect(versions.status).toBe(200);
    expect(versionListSchema.parse(await versions.json()).versions)
      .toHaveLength(2);

    const actions = await worker.fetch(
      `${origin}/api/v1/artifacts/${publication.artifact.id}/actions`,
      {headers: {Authorization: `Bearer ${apiToken}`}},
    );
    expect(actions.status).toBe(200);
    expect(actionListSchema.parse(await actions.json()).actions)
      .toHaveLength(2);
  }, 30_000);

  it("publishes a multi-file artifact through the real filesPerPass: 5 budget via 202 preparing responses", async () => {
    const fileCount = 7;
    const files = Array.from({length: fileCount}, (_, index) => {
      const bytes = new TextEncoder().encode(`<p>File ${index}</p>`);
      return {
        bytes,
        mediaType: "text/html; charset=utf-8",
        path: `file-${index}.html`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      };
    });

    const createUpload = await worker.fetch(`${origin}/api/v1/uploads`, {
      body: JSON.stringify({
        entryPath: "file-0.html",
        files: files.map((file) => ({
          mediaType: file.mediaType,
          path: file.path,
          sha256: file.sha256,
          size: file.size,
        })),
      }),
      headers: authenticatedJsonHeaders(),
      method: "POST",
    });
    expect(createUpload.status).toBe(201);
    const uploadPlan = uploadPlanSchema.parse(await createUpload.json());

    await Promise.all(files.map((file) => {
      const plannedFile = uploadPlan.files.find((planned) => planned.path === file.path);
      if (plannedFile === undefined) {
        throw new Error(`The upload plan is missing ${file.path}.`);
      }
      return worker.fetch(plannedFile.uploadUrl, {
        body: file.bytes,
        headers: {Authorization: `Bearer ${apiToken}`},
        method: "PUT",
      });
    }));

    const target = {
      accessSetting: "public_link" as const,
      kind: "new_artifact" as const,
      name: "Cloudflare bounded publish",
    };

    const first = await worker.fetch(uploadPlan.commitUrl, {
      body: JSON.stringify({target}),
      headers: {
        ...authenticatedJsonHeaders(),
        "Idempotency-Key": "cloudflare-bounded-publish-1",
      },
      method: "POST",
    });
    expect(first.status).toBe(202);
    const firstBody = preparingResponseSchema.parse(await first.json());
    expect(firstBody.status).toBe("preparing");
    expect(firstBody.installed).toBe(5);
    expect(firstBody.total).toBe(fileCount);

    const second = await worker.fetch(uploadPlan.commitUrl, {
      body: JSON.stringify({target}),
      headers: {
        ...authenticatedJsonHeaders(),
        "Idempotency-Key": "cloudflare-bounded-publish-1",
      },
      method: "POST",
    });
    expect(second.status).toBe(201);
    const publication = publicationSchema.parse(await second.json());

    const versions = await worker.fetch(
      `${origin}/api/v1/artifacts/${publication.artifact.id}/versions`,
      {headers: {Authorization: `Bearer ${apiToken}`}},
    );
    expect(versions.status).toBe(200);
    expect(versionListSchema.parse(await versions.json()).versions)
      .toHaveLength(1);

    await Promise.all(files.map(async (file) => {
      const renderedUrl = new URL(publication.links.version);
      renderedUrl.pathname = `/${file.path}`;
      const rendered = await worker.fetch(renderedUrl.toString());
      expect(rendered.status).toBe(200);
      expect(await rendered.text()).toBe(new TextDecoder().decode(file.bytes));
    }));

    const retry = await worker.fetch(uploadPlan.commitUrl, {
      body: JSON.stringify({target}),
      headers: {
        ...authenticatedJsonHeaders(),
        "Idempotency-Key": "cloudflare-bounded-publish-1",
      },
      method: "POST",
    });
    expect(retry.status).toBe(200);
    const replay = committedUploadSchema.parse(await retry.json());
    expect(replay.replayed).toBe(true);
    expect(replay.version.id).toBe(publication.version.id);
  }, 30_000);
});

describe("Cloudflare Worker without a browser-login provider", () => {
  let misconfiguredPath: string;
  let misconfigured: Unstable_DevWorker;

  beforeAll(async () => {
    misconfiguredPath = await mkdtemp(
      join(tmpdir(), "artifact-server-cloudflare-misconfigured-"),
    );
    misconfigured = await startWorker(misconfiguredPath, {
      withoutIdentityProvider: true,
    });
  }, 30_000);

  afterAll(async () => {
    await misconfigured.stop();
    await rm(misconfiguredPath, {force: true, recursive: true});
  });

  it("answers 503 artifact_server_not_ready on every probe endpoint", async () => {
    // Reproduces the September 23 runtime-stage probe: a stack deployed
    // without OIDC or WorkOS settings composes no browser-login provider,
    // so runtime initialization throws and every request gets the same 503.
    const responses = await Promise.all(
      ["/health", "/ready", "/api/v1/artifacts"].map(async (path) => {
        const response = await misconfigured.fetch(`${origin}${path}`);
        return {body: await response.json(), status: response.status};
      }),
    );
    for (const response of responses) {
      expect(response.status).toBe(503);
      expect(notReadySchema.parse(response.body).error)
        .toBe("artifact_server_not_ready");
    }
    const upload = await misconfigured.fetch(`${origin}/api/v1/uploads`, {
      body: "{}",
      headers: authenticatedJsonHeaders(),
      method: "POST",
    });
    expect(upload.status).toBe(503);
    expect(notReadySchema.parse(await upload.json()).error)
      .toBe("artifact_server_not_ready");

    const retried = await misconfigured.fetch(`${origin}/health`);
    expect(retried.status).toBe(503);
  }, 30_000);
});

type McpToolArguments = {
  readonly artifactId?: string;
  readonly cursor?: string;
  readonly entryPath?: string;
  readonly files?: ReadonlyArray<{
    readonly mediaType: string;
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
  }>;
  readonly idempotencyKey?: string;
  readonly limit?: number;
  readonly path?: string;
  readonly projection?: string;
  readonly target?: {
    readonly artifactId?: string;
    readonly expectedCurrentVersionId?: string;
    readonly kind: "new_artifact" | "new_version";
    readonly name?: string;
  };
  readonly uploadId?: string;
  readonly versionId?: string;
};

type McpRequestParameters = {
  readonly arguments?: McpToolArguments;
  readonly name?: string;
};

async function mcpRequest(
  method: string,
  parameters: McpRequestParameters,
  token: string | null = apiToken,
  additionalHeaders: Record<string, string> = {},
) {
  const baseHeaders = {
    ...additionalHeaders,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
  };
  const headers = token === null
    ? baseHeaders
    : {...baseHeaders, Authorization: `Bearer ${token}`};
  return worker.fetch(`${origin}/mcp`, {
    body: JSON.stringify({
      id: crypto.randomUUID(),
      jsonrpc: "2.0",
      method,
      params: {
        ...parameters,
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: {name: "cloudflare-runtime-test", version: "1"},
          [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
        },
      },
    }),
    headers,
    method: "POST",
  });
}

async function mcpTool(name: string, args: McpToolArguments) {
  const response = await mcpRequest("tools/call", {
    arguments: args,
    name,
  }, apiToken, {"Mcp-Name": name});
  expect(response.status).toBe(200);
  return z.object({result: z.object({
    content: z.array(z.object({text: z.string(), type: z.literal("text")})),
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
  }).loose()}).parse(await response.json()).result;
}

async function stageFile(source: string) {
  const bytes = new TextEncoder().encode(source);
  const response = await worker.fetch(`${origin}/api/v1/uploads`, {
    body: JSON.stringify({
      entryPath: "index.html",
      files: [{
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      }],
    }),
    headers: authenticatedJsonHeaders(),
    method: "POST",
  });
  expect(response.status).toBe(201);
  const uploadPlan = uploadPlanSchema.parse(await response.json());
  const plannedFile = uploadPlan.files[0];
  if (plannedFile === undefined) throw new Error("The upload plan is empty.");
  const uploaded = await worker.fetch(plannedFile.uploadUrl, {
    body: bytes,
    headers: {Authorization: `Bearer ${apiToken}`},
    method: "PUT",
  });
  expect(uploaded.status).toBe(200);
  return uploadPlan;
}

function startWorker(
  persistenceDirectory: string,
  options?: {readonly withoutIdentityProvider?: boolean},
): Promise<Unstable_DevWorker> {
  const identityProviderVars = options?.withoutIdentityProvider === true ? {} : {
    ARTIFACT_SERVER_OIDC_CLIENT_ID: "cloudflare-worker-test",
    ARTIFACT_SERVER_OIDC_ISSUER: "https://identity.example.test",
  };
  return unstable_dev("src/worker.ts", {
    bundle: true,
    config: "wrangler.test.jsonc",
    compatibilityDate: "2026-08-15",
    compatibilityFlags: ["nodejs_compat"],
    experimental: {
      d1Databases: [{
        binding: "ARTIFACT_SERVER_D1_DATABASE",
        database_id: "artifact-server-test-d1",
        database_name: "artifact-server-test-d1",
      }],
      disableExperimentalWarning: true,
      disableDevRegistry: true,
      testScheduled: true,
      watch: false,
    },
    inspect: false,
    local: true,
    logLevel: "error",
    persist: true,
    persistTo: persistenceDirectory,
    r2: [{
      binding: "ARTIFACT_SERVER_R2_BUCKET",
      bucket_name: "artifact-server-test-r2",
    }],
    vars: {
      ARTIFACT_SERVER_API_TOKEN: apiToken,
      ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL:
        "administrator@example.test",
      ARTIFACT_SERVER_CONTENT_DOMAIN: contentDomain,
      ARTIFACT_SERVER_INSTALLATION_ID: "cloudflare-runtime-test",
      ...identityProviderVars,
      ARTIFACT_SERVER_ORIGIN: origin,
      ARTIFACT_SERVER_QUALIFICATION_MODE: "enabled",
      ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    },
  });
}

function authenticatedJsonHeaders() {
  return {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };
}
