import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as Schema from "effect/Schema";

import { buildCloudflareDeploymentManifest } from
  "../src/deployment-manifest.ts";

const PACKAGE_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const STACK_NAME = "artifact-server-cloudflare";
const COMPATIBILITY_DATE = "2026-08-15";
const MAX_CAPTURE_BYTES = 1_000_000;
const DEPLOYMENT_OUTPUT_KEYS = [
  "applicationUrl",
  "contentDomain",
  "databaseResourceId",
  "healthUrl",
  "imageDigest",
  "installationId",
  "logDestination",
  "mcpUrl",
  "networkResourceIds",
  "objectStorageResourceId",
  "readinessUrl",
  "runtimeResourceId",
  "secretResourceIds",
  "stateBackend",
  "supportManifestLocation",
  "workloadIdentityResourceId",
];
const ProbePolicyConfiguration = Schema.Struct({
  cloudflareAccountId: Schema.String,
  compatibilityDate: Schema.String,
  dnsZoneIds: Schema.optionalKey(Schema.Struct({
    application: Schema.String,
    content: Schema.String,
  })),
  environment: Schema.String,
  ingress: Schema.String,
  installationName: Schema.String,
  stage: Schema.String,
  stateStore: Schema.String,
  target: Schema.String,
});
const ProbeDatabaseId = Schema.String.check(
  Schema.isPattern(
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu,
  ),
);
const ProbeWorkerId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{32}$/iu),
);
const QualificationUpload = Schema.Struct({
  commitUrl: Schema.String,
  files: Schema.Array(Schema.Struct({uploadUrl: Schema.String})),
});
const QualificationCommit = Schema.Struct({
  artifact: Schema.Struct({id: Schema.String}),
  version: Schema.Struct({id: Schema.String}),
});
const QualificationList = Schema.Struct({
  artifacts: Schema.Array(Schema.Struct({
    artifact: Schema.Struct({id: Schema.String}),
  })),
});
const QualificationMultiUpload = Schema.Struct({
  commitUrl: Schema.String,
  files: Schema.Array(Schema.Struct({
    path: Schema.String,
    uploadUrl: Schema.String,
  })),
});
const QualificationPreparing = Schema.Struct({
  installed: Schema.Number,
  status: Schema.Literal("preparing"),
  total: Schema.Number,
});
const QualificationPublication = Schema.Struct({
  artifact: Schema.Struct({id: Schema.String}),
  version: Schema.Struct({id: Schema.String}),
});
const QualificationReplay = Schema.Struct({
  replayed: Schema.Literal(true),
  version: Schema.Struct({id: Schema.String}),
});
const McpEnvelope = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  result: Schema.Struct({resultType: Schema.Literal("complete")}),
});
const McpDiscovery = Schema.Struct({
  supportedVersions: Schema.Array(Schema.String),
});
const McpToolList = Schema.Struct({
  tools: Schema.Array(Schema.Struct({name: Schema.String})),
});
const McpTemplateList = Schema.Struct({
  resourceTemplates: Schema.Array(Schema.Struct({name: Schema.String})),
});
const McpToolResult = Schema.Struct({
  content: Schema.Array(Schema.Struct({text: Schema.String})),
  isError: Schema.optionalKey(Schema.Boolean),
  structuredContent: Schema.optionalKey(Schema.Unknown),
});
const McpCapabilities = Schema.Struct({
  deployment: Schema.Struct({mode: Schema.Literal("remote")}),
  protocol: Schema.Struct({
    era: Schema.Literal("modern"),
    version: Schema.Literal("2026-07-28"),
  }),
  publishing: Schema.Struct({localPathTool: Schema.Literal(false)}),
});
const McpUpload = Schema.Struct({
  files: Schema.Array(Schema.Struct({uploadUrl: Schema.String})),
  kind: Schema.Literal("upload"),
  uploadId: Schema.String,
});
const McpPublication = Schema.Struct({
  artifact: Schema.Struct({id: Schema.String}),
  version: Schema.Struct({id: Schema.String}),
});
const McpManifest = Schema.Struct({
  current: Schema.Struct({manifest: Schema.Struct({
    digest: Schema.String,
    entryCount: Schema.Number,
    entryPath: Schema.String,
  })}),
});
const McpFullManifest = Schema.Struct({
  current: Schema.Struct({manifest: Schema.Struct({
    digest: Schema.String,
    entries: Schema.Array(Schema.Struct({path: Schema.String})),
  })}),
});
const McpVersionPage = Schema.Struct({
  nextCursor: Schema.NullOr(Schema.String),
  versions: Schema.Array(Schema.Struct({id: Schema.String})),
});
const CloudflareCursor = Schema.String.check(Schema.isMinLength(1));
const R2ObjectListResponse = Schema.Struct({
  result: Schema.Array(Schema.Struct({key: Schema.String})),
  result_info: Schema.optionalKey(Schema.Struct({
    cursor: Schema.optionalKey(Schema.String),
    is_truncated: Schema.optionalKey(Schema.Boolean),
  })),
  success: Schema.Literal(true),
});
const R2ObjectDeleteResponse = Schema.Struct({
  success: Schema.Literal(true),
});

const usage = `Usage:
  pnpm probe:account \\
    --config ./probe.config.json \\
    --confirm-account <cloudflare-account-id> \\
    [--alchemy-profile default]

The probe plans, deploys twice, proves a no-drift plan, destroys compute,
checks retained D1 and R2 resources by exact ID, then permanently deletes
those two probe-only durable resources. It writes redacted evidence under
evidence/.
`;

const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

const capture = (current, chunk) =>
  `${current}${chunk}`.slice(-MAX_CAPTURE_BYTES);

const commandEvidence = (result) => ({
  command: result.command,
  exitCode: result.exitCode,
  stderrSha256: sha256(result.stderr),
  stdoutSha256: sha256(result.stdout),
});

const runCommand = (command, args, environment, input) =>
  new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd: PACKAGE_DIRECTORY,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = capture(stdout, chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr = capture(stderr, chunk.toString());
    });
    child.on("error", (error) => {
      resolveResult({
        command: [command, ...args].join(" "),
        exitCode: 1,
        stdout,
        stderr: capture(stderr, error.message),
      });
    });
    child.on("close", (code) => {
      resolveResult({
        command: [command, ...args].join(" "),
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
    child.stdin.end(input);
  });

const resourceNames = (configuration) =>
  buildCloudflareDeploymentManifest(configuration).resourceNames;

const parseOptions = () => {
  try {
    return {
      ok: true,
      value: parseArgs({
        options: {
          "alchemy-profile": {
            type: "string",
            default: "default",
          },
          config: {
            type: "string",
          },
          "confirm-account": {
            type: "string",
          },
          help: {
            type: "boolean",
            default: false,
          },
        },
        strict: true,
      }).values,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error
        ? error.message
        : "Could not parse probe options.",
    };
  }
};

const parseConfiguration = async (path) => {
  try {
    const raw = await readFile(path, "utf8");
    return {
      ok: true,
      raw,
      value: JSON.parse(raw),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error
        ? error.message
        : "Could not read the probe configuration.",
    };
  }
};

const validateProbePolicy = (options, configuration) => {
  if (!Schema.is(ProbePolicyConfiguration)(configuration)) {
    return ["configuration is missing a probe policy field"];
  }
  const failures = [];
  if (configuration.target !== "cloudflare") {
    failures.push("target must be cloudflare");
  }
  if (configuration.environment !== "development") {
    failures.push("environment must be development");
  }
  if (!configuration.stage.startsWith("probe-")) {
    failures.push("stage must start with probe-");
  }
  if (!configuration.installationName.startsWith("probe-")) {
    failures.push("installationName must start with probe-");
  }
  if (configuration.compatibilityDate !== COMPATIBILITY_DATE) {
    failures.push(
      `compatibilityDate must be ${COMPATIBILITY_DATE}`,
    );
  }
  if (configuration.stateStore !== "cloudflare") {
    failures.push("stateStore must be cloudflare");
  }
  if (configuration.ingress !== "private") {
    failures.push("the approved probe requires private ingress");
  }
  if (configuration.dnsZoneIds !== undefined) {
    failures.push("the approved probe forbids dnsZoneIds");
  }
  if (
    options["confirm-account"] !==
    configuration.cloudflareAccountId
  ) {
    failures.push(
      "--confirm-account must exactly match cloudflareAccountId",
    );
  }
  const names = resourceNames(configuration);
  if (
    Object.values(names).some((name) => !name.startsWith("probe-"))
  ) {
    failures.push("every proposed resource name must start with probe-");
  }
  if (configuration.stage.startsWith("probe-runtime-")) {
    const oidcConfigured =
      configuration.oidcClientId !== undefined &&
      configuration.oidcIssuer !== undefined;
    const workOsConfigured =
      configuration.workosApiKeySecretRef !== undefined &&
      configuration.workosClientId !== undefined &&
      configuration.workosIssuer !== undefined;
    if (!oidcConfigured && !workOsConfigured) {
      failures.push(
        "a runtime-stage probe requires one browser-login provider (oidcClientId + oidcIssuer, or the WorkOS triple); without one the deployed Worker answers every request 503",
      );
    }
  }
  return failures;
};

const planSummary = (output) => {
  const line = output.split("\n")
    .find((entry) => entry.includes("Plan:"));
  return line === undefined ? "" : line.slice(line.indexOf("Plan:")).trim();
};

const hasNoDrift = (result) => {
  const summary = planSummary(result.stdout);
  return result.exitCode === 0 &&
    (summary === "Plan: no changes" ||
      (summary.startsWith("Plan: 3 to noop") &&
        !/(?:to create|to update|to delete|to replace)/iu.test(summary)));
};

const hasDeploymentOutput = (result, configuration, names) => {
  const applicationUrl = `https://${configuration.applicationDomain}`;
  const expectedValues = [
    `${configuration.installationName}:${configuration.environment}`,
    applicationUrl,
    configuration.contentDomain,
    `${applicationUrl}/mcp`,
    `${applicationUrl}/health`,
    `${applicationUrl}/ready`,
    names.bucket,
    names.worker,
    "cloudflare:alchemy-state-store",
    `r2://${names.bucket}/support/installation-manifest.json`,
  ];
  return result.exitCode === 0 &&
    DEPLOYMENT_OUTPUT_KEYS.every((key) =>
      result.stdout.includes(key)
    ) &&
    expectedValues.every((value) => result.stdout.includes(value)) &&
    result.stdout.includes("sha256:");
};

const parseJson = (result) => {
  if (result.exitCode !== 0) {
    return undefined;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
};

const hasApprovedAccount = (result, accountId) => {
  const document = parseJson(result);
  return document?.loggedIn === true &&
    Array.isArray(document.accounts) &&
    document.accounts.some((account) => account.id === accountId);
};

const d1Databases = (result) => {
  const document = parseJson(result);
  return Array.isArray(document) ? document : undefined;
};

const normalizedD1Inventory = (result) => {
  const databases = d1Databases(result);
  return databases?.map(({ name, uuid }) => ({ name, uuid }))
    .toSorted((left, right) => left.uuid.localeCompare(right.uuid));
};

const r2BucketNames = (result) => {
  if (result.exitCode !== 0) {
    return undefined;
  }
  return result.stdout.split(/\r?\n/gu)
    .map((line) => /^\s*name:\s*(.+?)\s*$/iu.exec(line)?.[1])
    .filter((name) => name !== undefined)
    .toSorted((left, right) => left.localeCompare(right));
};

const workerIsAbsent = (result) =>
  result.exitCode !== 0 &&
  /(?:not found|does not exist|10090|script_not_found)/iu.test(
    `${result.stdout}\n${result.stderr}`,
  );

const stageIsAbsent = (result, stagePath) =>
  result.exitCode !== 0 &&
  new RegExp(`${stagePath}: path does not exist`, "u").test(
    `${result.stdout}\n${result.stderr}`,
  );

const initialPlanIsSafe = (result) => {
  const summary = planSummary(result.stdout);
  return result.exitCode === 0 &&
    summary.startsWith("Plan: 3 to create") &&
    !/(?:to update|to delete|to replace)/iu.test(summary) &&
    !/plannotator/iu.test(`${result.stdout}\n${result.stderr}`);
};

const extractOutputValue = (result, key) => {
  const match = new RegExp(
    `["']?${key}["']?\\s*:\\s*["']([^"']+)["']`,
    "u",
  ).exec(result.stdout);
  return match?.[1];
};

const createdResourceIds = (result) => ({
  worker: extractOutputValue(result, "runtimeResourceId"),
  database: extractOutputValue(result, "databaseResourceId"),
  bucket: extractOutputValue(result, "objectStorageResourceId"),
});

const exactResourceIdsAreValid = (ids, names) =>
  (ids.worker === names.worker || Schema.is(ProbeWorkerId)(ids.worker)) &&
  ids.bucket === names.bucket &&
  Schema.is(ProbeDatabaseId)(ids.database);

const resourcesMatchExactIds = (
  databaseResult,
  bucketResult,
  ids,
  names,
) => {
  const database = parseJson(databaseResult);
  const bucket = parseJson(bucketResult);
  return database?.uuid === ids.database &&
    database?.name === names.database &&
    bucket?.name === ids.bucket;
};

const createdIdsAreEqual = (left, right) =>
  left.worker === right.worker &&
  left.database === right.database &&
  left.bucket === right.bucket;

const delay = (durationMs) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, durationMs));

const rewriteQualificationUrl = (qualificationUrl, value) => {
  const source = new URL(value);
  const target = new URL(qualificationUrl);
  target.pathname = source.pathname;
  target.search = source.search;
  return target;
};

const requestStatus = async (fetchLike, url, options) => {
  const response = await fetchLike(url, options);
  return {
    body: await response.text(),
    status: response.status,
  };
};

const parseCloudflareResponse = async (response) => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

const r2ObjectsUrl = (accountId, bucketName) =>
  new URL(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects`,
  );

const encodedObjectKey = (key) =>
  key.split("/").map(encodeURIComponent).join("/");

const listExactR2ObjectKeys = async (
  accountId,
  bucketName,
  headers,
  cursor,
  remainingPages,
) => {
  if (remainingPages === 0) return {keys: [], ok: false};
  const url = r2ObjectsUrl(accountId, bucketName);
  url.searchParams.set("per_page", "1000");
  if (cursor !== undefined) url.searchParams.set("cursor", cursor);
  const response = await fetch(url, {headers});
  const document = await parseCloudflareResponse(response);
  if (!response.ok || !Schema.is(R2ObjectListResponse)(document)) {
    return {keys: [], ok: false};
  }
  const keys = document.result.map(({key}) => key);
  if (document.result_info?.is_truncated !== true) {
    return {keys, ok: true};
  }
  const nextCursor = document.result_info.cursor;
  if (!Schema.is(CloudflareCursor)(nextCursor)) {
    return {keys: [], ok: false};
  }
  const remaining = await listExactR2ObjectKeys(
    accountId,
    bucketName,
    headers,
    nextCursor,
    remainingPages - 1,
  );
  return remaining.ok
    ? {keys: [...keys, ...remaining.keys], ok: true}
    : remaining;
};

const emptyExactR2Bucket = async (
  accountId,
  bucketName,
  apiToken,
) => {
  if (apiToken === undefined || apiToken.length === 0) {
    return {deletedCount: 0, ok: false};
  }
  const headers = {Authorization: `Bearer ${apiToken}`};
  const listed = await listExactR2ObjectKeys(
    accountId,
    bucketName,
    headers,
    undefined,
    100,
  );
  if (!listed.ok) return {deletedCount: 0, ok: false};
  const deleted = await Promise.all(listed.keys.map(async (key) => {
    const url = r2ObjectsUrl(accountId, bucketName);
    url.pathname = `${url.pathname}/${encodedObjectKey(key)}`;
    const response = await fetch(url, {headers, method: "DELETE"});
    const document = await parseCloudflareResponse(response);
    return response.ok && Schema.is(R2ObjectDeleteResponse)(document);
  }));
  const deletedCount = deleted.filter(Boolean).length;
  return {deletedCount, ok: deletedCount === listed.keys.length};
};

const parseResponseDocument = (response) => {
  try {
    return JSON.parse(response.body);
  } catch {
    return undefined;
  }
};

const awaitHealthyRuntime = async (fetchLike, qualificationUrl, attempts) => {
  const response = await requestStatus(
    fetchLike,
    new URL("/health", qualificationUrl),
  );
  if (response.status === 200 || attempts <= 1) return response;
  await delay(500);
  return awaitHealthyRuntime(fetchLike, qualificationUrl, attempts - 1);
};

const parseQualificationUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".workers.dev")
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};

const qualifyMcpRuntime = async (
  fetchLike,
  qualificationUrl,
  apiToken,
  artifactId,
  currentVersionId,
) => {
  const evidence = {
    unauthorized: null,
    invalidToken: null,
    get: null,
    delete: null,
    hostileOrigin: null,
    discovery: null,
    toolsList: null,
    templatesList: null,
    capabilities: null,
    mismatchedName: null,
    unavailableLink: null,
    createUpload: null,
    resumedUpload: null,
    conflict: null,
    uploadFile: null,
    commit: null,
    committedReplay: null,
    compact: null,
    full: null,
    invalidProjection: null,
    firstPage: null,
    secondPage: null,
    invalidCursor: null,
  };
  const fail = () => ({evidence, passed: false});
  const mcpRequest = async (method, parameters, token = apiToken, extraHeaders = {}) => {
    const headers = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...extraHeaders,
    };
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    return requestStatus(fetchLike, new URL("/mcp", qualificationUrl), {
      body: JSON.stringify({
        id: randomBytes(8).toString("hex"),
        jsonrpc: "2.0",
        method,
        params: {
          ...parameters,
          _meta: {
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "artifact-server-cloudflare-account-probe",
              version: "1",
            },
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          },
        },
      }),
      headers,
      method: "POST",
    });
  };
  const mcpResult = (response) => {
    const document = parseResponseDocument(response);
    return Schema.is(McpEnvelope)(document) ? document.result : undefined;
  };
  const mcpTool = async (name, args) => {
    const response = await mcpRequest("tools/call", {
      arguments: args,
      name,
    }, apiToken, {"Mcp-Name": name});
    const result = mcpResult(response);
    return {
      response,
      result: Schema.is(McpToolResult)(result) ? result : undefined,
    };
  };

  evidence.unauthorized = (await mcpRequest("server/discover", {}, null)).status;
  evidence.invalidToken = (await mcpRequest("server/discover", {}, "invalid-token")).status;
  evidence.get = (await requestStatus(fetchLike,
    new URL("/mcp", qualificationUrl), {method: "GET"})).status;
  evidence.delete = (await requestStatus(fetchLike,
    new URL("/mcp", qualificationUrl), {method: "DELETE"})).status;
  evidence.hostileOrigin = (await mcpRequest("server/discover", {}, apiToken, {
    Origin: "https://attacker.example",
  })).status;
  if (evidence.unauthorized !== 401 || evidence.invalidToken !== 401 ||
      evidence.get !== 405 || evidence.delete !== 405 ||
      evidence.hostileOrigin !== 403) return fail();

  const discovery = await mcpRequest("server/discover", {});
  evidence.discovery = discovery.status;
  if (discovery.status !== 200 ||
      !Schema.is(McpDiscovery)(mcpResult(discovery)) ||
      !mcpResult(discovery).supportedVersions.includes("2026-07-28")) return fail();
  const listed = await mcpRequest("tools/list", {});
  evidence.toolsList = listed.status;
  const toolList = mcpResult(listed);
  if (listed.status !== 200 || !Schema.is(McpToolList)(toolList) ||
      !["artifact_capabilities", "artifact_get", "artifact_version_list",
        "artifact_create_upload", "artifact_commit_upload"].every(
        (name) => toolList.tools.some((tool) => tool.name === name)
      )) return fail();
  const templates = await mcpRequest("resources/templates/list", {});
  evidence.templatesList = templates.status;
  if (templates.status !== 200 ||
      !Schema.is(McpTemplateList)(mcpResult(templates)) ||
      mcpResult(templates).resourceTemplates.length === 0) return fail();

  const capabilities = await mcpTool("artifact_capabilities", {});
  evidence.capabilities = capabilities.response.status;
  if (capabilities.response.status !== 200 ||
      !Schema.is(McpCapabilities)(capabilities.result?.structuredContent)) return fail();
  evidence.mismatchedName = (await mcpRequest("tools/call", {
    arguments: {}, name: "artifact_capabilities",
  }, apiToken, {"Mcp-Name": "artifact_get"})).status;
  const unavailableLink = await mcpTool("artifact_link", {
    path: "/tmp/outside-cloudflare-root",
  });
  evidence.unavailableLink = unavailableLink.response.status;
  if (evidence.mismatchedName !== 400 ||
      unavailableLink.result?.isError !== true ||
      !unavailableLink.result.content.some((item) =>
        item.text.includes("CAPABILITY_UNAVAILABLE")
      )) return fail();

  const bytes = new TextEncoder().encode("Cloudflare MCP qualification version\n");
  const file = {
    mediaType: "text/plain",
    path: "mcp-proof.txt",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
  const idempotencyKey = "cloudflare-live-mcp-qualification";
  const uploadArguments = {entryPath: file.path, files: [file], idempotencyKey};
  const created = await mcpTool("artifact_create_upload", uploadArguments);
  evidence.createUpload = created.response.status;
  const upload = created.result?.structuredContent;
  if (created.response.status !== 200 || !Schema.is(McpUpload)(upload) ||
      upload.files.length !== 1) return fail();
  const resumed = await mcpTool("artifact_create_upload", uploadArguments);
  evidence.resumedUpload = resumed.response.status;
  const resumedContent = resumed.result?.structuredContent;
  if (resumed.response.status !== 200 || !Schema.is(McpUpload)(resumedContent) ||
      resumedContent.uploadId !== upload.uploadId ||
      resumedContent.resumed !== true) return fail();
  const conflict = await mcpTool("artifact_create_upload", {
    ...uploadArguments,
    files: [{...file, sha256: "0".repeat(64)}],
  });
  evidence.conflict = conflict.response.status;
  if (conflict.response.status !== 200 || conflict.result?.isError !== true ||
      !conflict.result.content.some((item) =>
        item.text.includes("IDEMPOTENCY_CONFLICT")
      )) return fail();
  const uploaded = await requestStatus(fetchLike,
    rewriteQualificationUrl(qualificationUrl, upload.files[0].uploadUrl),
    {body: bytes, headers: {Authorization: `Bearer ${apiToken}`}, method: "PUT"},
  );
  evidence.uploadFile = uploaded.status;
  if (uploaded.status !== 200) return fail();
  const committed = await mcpTool("artifact_commit_upload", {
    idempotencyKey,
    target: {
      artifactId,
      expectedCurrentVersionId: currentVersionId,
      kind: "new_version",
    },
    uploadId: upload.uploadId,
  });
  evidence.commit = committed.response.status;
  const publication = committed.result?.structuredContent;
  if (committed.response.status !== 200 ||
      !Schema.is(McpPublication)(publication) ||
      publication.artifact.id !== artifactId ||
      publication.version.id === currentVersionId) return fail();
  const recovered = await mcpTool("artifact_create_upload", uploadArguments);
  evidence.committedReplay = recovered.response.status;
  const recoveredContent = recovered.result?.structuredContent;
  if (recovered.response.status !== 200 ||
      recoveredContent?.kind !== "committed" ||
      recoveredContent.publication?.version?.id !== publication.version.id) return fail();

  const compact = await mcpTool("artifact_get", {artifactId, projection: "compact"});
  evidence.compact = compact.response.status;
  const compactContent = compact.result?.structuredContent;
  if (compact.response.status !== 200 ||
      !Schema.is(McpManifest)(compactContent) ||
      compactContent.current.manifest.entryCount !== 1 ||
      Object.hasOwn(compactContent.current.manifest, "entries")) return fail();
  const full = await mcpTool("artifact_get", {artifactId});
  evidence.full = full.response.status;
  const fullContent = full.result?.structuredContent;
  if (full.response.status !== 200 ||
      !Schema.is(McpFullManifest)(fullContent) ||
      fullContent.current.manifest.digest !== compactContent.current.manifest.digest ||
      fullContent.current.manifest.entries.length !== 1) return fail();
  const invalidProjection = await mcpTool("artifact_get", {
    artifactId, projection: "summary",
  });
  evidence.invalidProjection = invalidProjection.response.status;
  if (invalidProjection.result?.isError !== true) return fail();

  const firstPage = await mcpTool("artifact_version_list", {artifactId, limit: 1});
  evidence.firstPage = firstPage.response.status;
  const firstContent = firstPage.result?.structuredContent;
  if (firstPage.response.status !== 200 ||
      !Schema.is(McpVersionPage)(firstContent) ||
      firstContent.versions.length !== 1 ||
      firstContent.versions[0].id !== publication.version.id ||
      firstContent.nextCursor === null) return fail();
  const secondPage = await mcpTool("artifact_version_list", {
    artifactId, cursor: firstContent.nextCursor, limit: 1,
  });
  evidence.secondPage = secondPage.response.status;
  const secondContent = secondPage.result?.structuredContent;
  if (secondPage.response.status !== 200 ||
      !Schema.is(McpVersionPage)(secondContent) ||
      secondContent.versions.length !== 1 ||
      secondContent.versions[0].id !== currentVersionId ||
      secondContent.nextCursor !== null) return fail();
  const invalidCursor = await mcpTool("artifact_version_list", {
    artifactId, cursor: "bad", limit: 1,
  });
  evidence.invalidCursor = invalidCursor.response.status;
  if (invalidCursor.result?.isError !== true) return fail();

  return {evidence, passed: true};
};

export const qualifyRuntime = async (
  qualificationUrl,
  apiToken,
  fetchLike = fetch,
) => {
  const evidence = {
    artifactIdSha256: null,
    commit: null,
    failureBodies: {},
    health: null,
    list: null,
    mcp: null,
    multiArtifactIdSha256: null,
    multiCommit: null,
    multiFileUploads: null,
    multiList: null,
    multiPreparingPasses: null,
    multiReplay: null,
    multiUpload: null,
    ready: null,
    replay: null,
    unauthorized: null,
    upload: null,
    uploadFile: null,
  };
  const recordResponse = (name, response) => {
    evidence[name] = response.status;
    if (response.status >= 400) {
      evidence.failureBodies[name] = response.body.slice(0, 300);
    }
  };
  try {
    const health = await awaitHealthyRuntime(fetchLike, qualificationUrl, 20);
    recordResponse("health", health);
    const ready = await requestStatus(fetchLike, new URL("/ready", qualificationUrl));
    recordResponse("ready", ready);
    const unauthorized = await requestStatus(fetchLike,
      new URL("/api/v1/artifacts", qualificationUrl),
    );
    recordResponse("unauthorized", unauthorized);

    const bytes = new TextEncoder().encode(
      "<main>Live Cloudflare qualification</main>",
    );
    const upload = await requestStatus(fetchLike,
      new URL("/api/v1/uploads", qualificationUrl),
      {
        body: JSON.stringify({
          entryPath: "index.html",
          files: [{
            mediaType: "text/html; charset=utf-8",
            path: "index.html",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            size: bytes.byteLength,
          }],
        }),
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
    recordResponse("upload", upload);
    const uploadDocument = parseResponseDocument(upload);
    if (!Schema.is(QualificationUpload)(uploadDocument)) {
      return {evidence, passed: false};
    }
    const plannedFile = uploadDocument.files[0];
    if (plannedFile === undefined) return {evidence, passed: false};
    const uploadedFile = await requestStatus(fetchLike,
      rewriteQualificationUrl(qualificationUrl, plannedFile.uploadUrl),
      {
        body: bytes,
        headers: {Authorization: `Bearer ${apiToken}`},
        method: "PUT",
      },
    );
    recordResponse("uploadFile", uploadedFile);
    const commitBody = JSON.stringify({target: {
      accessSetting: "public_link",
      kind: "new_artifact",
      name: "Live Cloudflare qualification",
      tags: ["cloudflare", "qualification"],
    }});
    const commitHeaders = {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "cloudflare-live-runtime-qualification",
    };
    const commit = await requestStatus(fetchLike,
      rewriteQualificationUrl(qualificationUrl, uploadDocument.commitUrl),
      {body: commitBody, headers: commitHeaders, method: "POST"},
    );
    recordResponse("commit", commit);
    const commitDocument = parseResponseDocument(commit);
    if (!Schema.is(QualificationCommit)(commitDocument)) {
      return {evidence, passed: false};
    }
    const artifactId = commitDocument.artifact.id;
    evidence.artifactIdSha256 = sha256(artifactId);
    const replay = await requestStatus(fetchLike,
      rewriteQualificationUrl(qualificationUrl, uploadDocument.commitUrl),
      {body: commitBody, headers: commitHeaders, method: "POST"},
    );
    recordResponse("replay", replay);
    const list = await requestStatus(fetchLike,
      new URL("/api/v1/artifacts", qualificationUrl),
      {headers: {Authorization: `Bearer ${apiToken}`}},
    );
    recordResponse("list", list);
    const listDocument = parseResponseDocument(list);
    const listed = Schema.is(QualificationList)(listDocument) &&
      listDocument.artifacts.some((item) => item.artifact.id === artifactId);

    // Multi-pass publication: twelve files against the production
    // filesPerPass: 5 budget must produce several 202 preparing responses
    // before the atomic commit, replay and list (PUB-019/PUB-020 live).
    const multiFileCount = 12;
    const multiFiles = Array.from({length: multiFileCount}, (_, index) => {
      const fileBytes = new TextEncoder().encode(
        `<p>Live multi-pass qualification file ${index}</p>`,
      );
      return {
        bytes: fileBytes,
        mediaType: "text/html; charset=utf-8",
        path: `file-${index}.html`,
        sha256: createHash("sha256").update(fileBytes).digest("hex"),
        size: fileBytes.byteLength,
      };
    });
    const multiUpload = await requestStatus(fetchLike,
      new URL("/api/v1/uploads", qualificationUrl),
      {
        body: JSON.stringify({
          entryPath: "file-0.html",
          files: multiFiles.map((file) => ({
            mediaType: file.mediaType,
            path: file.path,
            sha256: file.sha256,
            size: file.size,
          })),
        }),
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
    recordResponse("multiUpload", multiUpload);
    const multiUploadDocument = parseResponseDocument(multiUpload);
    if (!Schema.is(QualificationMultiUpload)(multiUploadDocument)) {
      return {evidence, passed: false};
    }
    const multiPuts = await Promise.all(multiFiles.map(async (file) => {
      const plannedMultiFile = multiUploadDocument.files.find(
        (planned) => planned.path === file.path,
      );
      if (plannedMultiFile === undefined) return {status: 0};
      const put = await requestStatus(fetchLike,
        rewriteQualificationUrl(qualificationUrl, plannedMultiFile.uploadUrl),
        {
          body: file.bytes,
          headers: {Authorization: `Bearer ${apiToken}`},
          method: "PUT",
        },
      );
      return {status: put.status};
    }));
    evidence.multiFileUploads =
      multiPuts.filter((put) => put.status === 200).length;
    const multiCommitBody = JSON.stringify({target: {
      accessSetting: "public_link",
      kind: "new_artifact",
      name: "Live Cloudflare multi-pass qualification",
      tags: ["cloudflare", "qualification", "multipass"],
    }});
    const multiCommitHeaders = {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "cloudflare-live-multipass-qualification",
    };
    const commitMultiPass = async (attemptsRemaining, passes) => {
      const commitAttempt = await requestStatus(fetchLike,
        rewriteQualificationUrl(qualificationUrl, multiUploadDocument.commitUrl),
        {body: multiCommitBody, headers: multiCommitHeaders, method: "POST"},
      );
      if (commitAttempt.status !== 202) {
        return {commit: commitAttempt, malformed: false, passes};
      }
      const preparingDocument = parseResponseDocument(commitAttempt);
      if (!Schema.is(QualificationPreparing)(preparingDocument)) {
        return {commit: commitAttempt, malformed: true, passes};
      }
      const nextPasses = [...passes, {
        installed: preparingDocument.installed,
        total: preparingDocument.total,
      }];
      if (attemptsRemaining <= 1) {
        return {commit: undefined, malformed: false, passes: nextPasses};
      }
      await delay(1000);
      return commitMultiPass(attemptsRemaining - 1, nextPasses);
    };
    const multiCommitResult = await commitMultiPass(8, []);
    evidence.multiPreparingPasses = multiCommitResult.passes;
    if (multiCommitResult.malformed) {
      recordResponse("multiCommit", multiCommitResult.commit);
      return {evidence, passed: false};
    }
    if (multiCommitResult.commit === undefined) {
      evidence.multiCommit = "preparing-not-finished";
      return {evidence, passed: false};
    }
    const multiCommit = multiCommitResult.commit;
    recordResponse("multiCommit", multiCommit);
    const multiCommitDocument = parseResponseDocument(multiCommit);
    if (!Schema.is(QualificationPublication)(multiCommitDocument)) {
      return {evidence, passed: false};
    }
    evidence.multiArtifactIdSha256 = sha256(multiCommitDocument.artifact.id);
    const multiReplay = await requestStatus(fetchLike,
      rewriteQualificationUrl(qualificationUrl, multiUploadDocument.commitUrl),
      {body: multiCommitBody, headers: multiCommitHeaders, method: "POST"},
    );
    recordResponse("multiReplay", multiReplay);
    const multiReplayDocument = parseResponseDocument(multiReplay);
    const multiReplayed = Schema.is(QualificationReplay)(multiReplayDocument) &&
      multiReplayDocument.version.id === multiCommitDocument.version.id;
    const multiList = await requestStatus(fetchLike,
      new URL("/api/v1/artifacts", qualificationUrl),
      {headers: {Authorization: `Bearer ${apiToken}`}},
    );
    recordResponse("multiList", multiList);
    const multiListDocument = parseResponseDocument(multiList);
    const multiListed = Schema.is(QualificationList)(multiListDocument) &&
      multiListDocument.artifacts.some(
        (item) => item.artifact.id === multiCommitDocument.artifact.id,
      );
    const mcpResult = await qualifyMcpRuntime(
      fetchLike,
      qualificationUrl,
      apiToken,
      artifactId,
      commitDocument.version.id,
    );
    evidence.mcp = mcpResult.evidence;
    const passed = evidence.health === 200 &&
      evidence.ready === 200 &&
      evidence.unauthorized === 401 &&
      evidence.upload === 201 &&
      evidence.uploadFile === 200 &&
      evidence.commit === 201 &&
      evidence.replay === 200 &&
      evidence.list === 200 &&
      listed &&
      evidence.multiUpload === 201 &&
      evidence.multiFileUploads === multiFileCount &&
      multiCommitResult.passes.length >= 2 &&
      multiCommitResult.passes.every((pass) => pass.total === multiFileCount) &&
      evidence.multiCommit === 201 &&
      evidence.multiReplay === 200 &&
      multiReplayed &&
      evidence.multiList === 200 &&
      multiListed &&
      mcpResult.passed;
    return {evidence, passed};
  } catch {
    return {evidence, passed: false};
  }
};

const writeEvidence = async (evidence) => {
  const timestamp = evidence.finishedAt.replaceAll(/[:.]/gu, "-");
  const path = resolve(
    PACKAGE_DIRECTORY,
    "evidence",
    `account-probe-${timestamp}.json`,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`);
  return path;
};

const main = async () => {
  const startedAt = new Date().toISOString();
  const parsedOptions = parseOptions();
  if (!parsedOptions.ok) {
    console.error(parsedOptions.message);
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  const options = parsedOptions.value;
  if (options.help) {
    console.log(usage);
    return;
  }
  if (
    options.config === undefined ||
    options["confirm-account"] === undefined
  ) {
    console.error("--config and --confirm-account are required.");
    console.error(usage);
    process.exitCode = 1;
    return;
  }

  const configPath = resolve(PACKAGE_DIRECTORY, options.config);
  const parsedConfiguration = await parseConfiguration(configPath);
  if (!parsedConfiguration.ok) {
    console.error(parsedConfiguration.message);
    process.exitCode = 1;
    return;
  }
  const configuration = parsedConfiguration.value;
  const policyFailures = validateProbePolicy(options, configuration);
  if (policyFailures.length > 0) {
    console.error(
      `Probe policy rejected the request:\n- ${policyFailures.join("\n- ")}`,
    );
    process.exitCode = 1;
    return;
  }

  const names = resourceNames(configuration);
  const runtimeApiToken = randomBytes(32).toString("base64url");
  const environment = {
    ...process.env,
    ALCHEMY_TELEMETRY_DISABLED: "1",
    ARTIFACT_SERVER_CLOUDFLARE_CONFIG:
      parsedConfiguration.raw.trim(),
    ARTIFACT_SERVER_API_TOKEN: runtimeApiToken,
    CLOUDFLARE_ACCOUNT_ID: configuration.cloudflareAccountId,
    DO_NOT_TRACK: "1",
    FORCE_COLOR: "0",
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import tsx"]
      .filter((value) => value !== undefined && value.trim() !== "")
      .join(" "),
    NO_TRACK: "1",
    WRANGLER_SEND_METRICS: "false",
  };
  const alchemy = (...args) =>
    runCommand(
      "pnpm",
      [
        "exec",
        "alchemy",
        ...args,
        "--profile",
        options["alchemy-profile"],
        "alchemy.run.ts",
      ],
      environment,
    );
  // `alchemy state ls` takes the state path as its only positional argument;
  // the entrypoint defaults to ./alchemy.run.ts from the package directory.
  const alchemyState = (...args) =>
    runCommand(
      "pnpm",
      [
        "exec",
        "alchemy",
        "state",
        ...args,
        "--profile",
        options["alchemy-profile"],
      ],
      environment,
    );
  const wrangler = (args, input) =>
    runCommand(
      "npx",
      [
        "wrangler",
        ...args,
      ],
      environment,
      input,
    );
  const steps = [];
  const runtimeQualificationRequested =
    configuration.stage.startsWith("probe-runtime-");
  const checks = {
    accountMatched: false,
    bucketEmptied: false,
    cleanupSucceeded: false,
    deploymentOutputValid: false,
    dnsChangesExcluded: true,
    durableDataRetained: false,
    exactResourceIdsCaptured: false,
    initialInventoryClear: false,
    nativePlanNoWrites: false,
    nonProbeDurableInventoryUnchanged: false,
    repeatDeploymentNoDrift: false,
    runtimeQualified: !runtimeQualificationRequested,
    workerDestroyed: false,
  };
  let runtimeEvidence = null;
  const planSummaries = {
    firstDeploy: null,
    initialPlan: null,
    repeatDeploy: null,
  };
  let exactIds = {
    worker: null,
    database: null,
    bucket: null,
  };
  const finish = async (stoppedReason) => {
    const finishedAt = new Date().toISOString();
    const evidencePath = await writeEvidence({
      schemaVersion: 2,
      startedAt,
      finishedAt,
      accountId: configuration.cloudflareAccountId,
      configurationSha256: sha256(parsedConfiguration.raw),
      stage: configuration.stage,
      resources: names,
      createdResourceIds: exactIds,
      checks,
      planSummaries,
      runtime: runtimeEvidence,
      stoppedReason,
      steps,
    });
    return evidencePath;
  };
  const stop = async (reason, message) => {
    const evidencePath = await finish(reason);
    console.error(`${message} Evidence: ${evidencePath}`);
    process.exitCode = 1;
  };

  const identity = await wrangler(["whoami", "--json"]);
  steps.push(commandEvidence(identity));
  checks.accountMatched = hasApprovedAccount(
    identity,
    configuration.cloudflareAccountId,
  );
  if (!checks.accountMatched) {
    await stop(
      "account-mismatch",
      "The authenticated Wrangler account does not match.",
    );
    return;
  }

  const stagePath = `${STACK_NAME}/${configuration.stage}`;
  const existingStages = await alchemyState("ls", stagePath);
  steps.push(commandEvidence(existingStages));
  if (!stageIsAbsent(existingStages, stagePath)) {
    await stop(
      "stage-exists",
      "The probe stage already exists or cannot be verified.",
    );
    return;
  }

  const initialD1Inventory = await wrangler(["d1", "list", "--json"]);
  const initialR2Inventory = await wrangler(["r2", "bucket", "list"]);
  const initialWorkerLookup = await wrangler([
    "versions",
    "list",
    "--name",
    names.worker,
    "--json",
  ]);
  steps.push(
    commandEvidence(initialD1Inventory),
    commandEvidence(initialR2Inventory),
    commandEvidence(initialWorkerLookup),
  );
  const initialDatabases = d1Databases(initialD1Inventory);
  const initialBuckets = r2BucketNames(initialR2Inventory);
  checks.initialInventoryClear =
    initialDatabases !== undefined &&
    initialBuckets !== undefined &&
    !initialDatabases.some(({ name }) => name === names.database) &&
    !initialBuckets.includes(names.bucket) &&
    workerIsAbsent(initialWorkerLookup);
  if (!checks.initialInventoryClear) {
    await stop(
      "proposed-resource-exists",
      "A proposed resource exists or the initial inventory is uncertain.",
    );
    return;
  }

  const initialPlan = await alchemy(
    "plan",
    "--stage",
    configuration.stage,
  );
  steps.push(commandEvidence(initialPlan));
  planSummaries.initialPlan = planSummary(initialPlan.stdout) || null;
  checks.nativePlanNoWrites = initialPlanIsSafe(initialPlan);
  if (!checks.nativePlanNoWrites) {
    await stop(
      "unsafe-initial-plan",
      "The initial plan was not an exact three-resource create.",
    );
    return;
  }

  const firstDeploy = await alchemy(
    "deploy",
    "--yes",
    "--stage",
    configuration.stage,
  );
  steps.push(commandEvidence(firstDeploy));
  planSummaries.firstDeploy = planSummary(firstDeploy.stdout) || null;
  if (firstDeploy.exitCode !== 0) {
    await stop(
      "first-deploy-failed",
      "The first deployment failed. Automatic cleanup did not run because exact IDs are unavailable.",
    );
    return;
  }

  const discoveredIds = createdResourceIds(firstDeploy);
  exactIds = {
    worker: discoveredIds.worker ?? null,
    database: discoveredIds.database ?? null,
    bucket: discoveredIds.bucket ?? null,
  };
  if (!exactResourceIdsAreValid(exactIds, names)) {
    await stop(
      "resource-id-missing",
      "The deployment did not return every exact resource ID.",
    );
    return;
  }

  const createdDatabaseInfo = await wrangler([
    "d1",
    "info",
    names.database,
    "--json",
  ]);
  const createdBucketInfo = await wrangler([
    "r2",
    "bucket",
    "info",
    names.bucket,
    "--json",
  ]);
  const createdWorkerInfo = await wrangler([
    "versions",
    "list",
    "--name",
    names.worker,
    "--json",
  ]);
  steps.push(
    commandEvidence(createdDatabaseInfo),
    commandEvidence(createdBucketInfo),
    commandEvidence(createdWorkerInfo),
  );
  checks.exactResourceIdsCaptured =
    resourcesMatchExactIds(
      createdDatabaseInfo,
      createdBucketInfo,
      exactIds,
      names,
    ) &&
    createdWorkerInfo.exitCode === 0 &&
    Array.isArray(parseJson(createdWorkerInfo)) &&
    parseJson(createdWorkerInfo).length > 0;
  if (!checks.exactResourceIdsCaptured) {
    await stop(
      "resource-id-mismatch",
      "Cloudflare inventory does not match the returned resource IDs.",
    );
    return;
  }

  if (runtimeQualificationRequested) {
    const qualificationUrl = extractOutputValue(
      firstDeploy,
      "qualificationUrl",
    );
    const parsedQualificationUrl = qualificationUrl === undefined
      ? undefined
      : parseQualificationUrl(qualificationUrl);
    if (parsedQualificationUrl === undefined) {
      await stop(
        "qualification-url-missing",
        "The runtime probe did not return a workers.dev qualification URL.",
      );
      return;
    }
    const runtimeResult = await qualifyRuntime(
      parsedQualificationUrl,
      runtimeApiToken,
    );
    runtimeEvidence = runtimeResult.evidence;
    checks.runtimeQualified = runtimeResult.passed;
  }

  let repeatDeploy = {
    command: "repeat deploy skipped",
    exitCode: 1,
    stdout: "",
    stderr: "",
  };
  repeatDeploy = await alchemy(
    "deploy",
    "--yes",
    "--stage",
    configuration.stage,
  );
  steps.push(commandEvidence(repeatDeploy));
  planSummaries.repeatDeploy = planSummary(repeatDeploy.stdout) || null;
  const repeatIds = createdResourceIds(repeatDeploy);
  checks.deploymentOutputValid =
    hasDeploymentOutput(repeatDeploy, configuration, names) &&
    createdIdsAreEqual(exactIds, repeatIds);
  checks.repeatDeploymentNoDrift = hasNoDrift(repeatDeploy);
  if (!checks.deploymentOutputValid) {
    await stop(
      "repeat-deploy-id-mismatch",
      "The second deployment did not return the same exact resource IDs.",
    );
    return;
  }

  const destroy = await alchemy(
    "destroy",
    "--yes",
    "--stage",
    configuration.stage,
  );
  steps.push(commandEvidence(destroy));
  if (destroy.exitCode !== 0) {
    await stop(
      "worker-destroy-failed",
      "Alchemy did not destroy the exact probe stage.",
    );
    return;
  }

  const destroyedWorkerInfo = await wrangler([
    "versions",
    "list",
    "--name",
    names.worker,
    "--json",
  ]);
  const retainedDatabaseInfo = await wrangler([
    "d1",
    "info",
    exactIds.database,
    "--json",
  ]);
  const retainedBucketInfo = await wrangler([
    "r2",
    "bucket",
    "info",
    exactIds.bucket,
    "--json",
  ]);
  steps.push(
    commandEvidence(destroyedWorkerInfo),
    commandEvidence(retainedDatabaseInfo),
    commandEvidence(retainedBucketInfo),
  );
  checks.workerDestroyed = workerIsAbsent(destroyedWorkerInfo);
  checks.durableDataRetained = resourcesMatchExactIds(
    retainedDatabaseInfo,
    retainedBucketInfo,
    exactIds,
    names,
  );
  if (
    !checks.workerDestroyed ||
    !checks.durableDataRetained
  ) {
    await stop(
      "retention-check-failed",
      "Worker destruction or exact durable-resource retention was not verified.",
    );
    return;
  }

  const bucketCleanup = await emptyExactR2Bucket(
    configuration.cloudflareAccountId,
    exactIds.bucket,
    process.env.CLOUDFLARE_API_TOKEN,
  );
  checks.bucketEmptied = bucketCleanup.ok;
  steps.push({
    command: "Cloudflare API empty exact probe R2 bucket",
    exitCode: bucketCleanup.ok ? 0 : 1,
    stderrSha256: sha256(""),
    stdoutSha256: sha256(JSON.stringify({
      deletedCount: bucketCleanup.deletedCount,
    })),
  });

  const databaseDelete = await wrangler([
    "d1",
    "delete",
    exactIds.database,
    "--skip-confirmation",
  ]);
  const bucketDelete = bucketCleanup.ok
    ? await wrangler(
      ["r2", "bucket", "delete", exactIds.bucket],
      "y\n",
    )
    : {
      command: `npx wrangler r2 bucket delete ${exactIds.bucket}`,
      exitCode: 1,
      stdout: "",
      stderr: "Exact bucket object cleanup failed.",
    };
  steps.push(
    commandEvidence(databaseDelete),
    commandEvidence(bucketDelete),
  );

  const finalD1Inventory = await wrangler(["d1", "list", "--json"]);
  const finalR2Inventory = await wrangler(["r2", "bucket", "list"]);
  const finalWorkerLookup = await wrangler([
    "versions",
    "list",
    "--name",
    names.worker,
    "--json",
  ]);
  steps.push(
    commandEvidence(finalD1Inventory),
    commandEvidence(finalR2Inventory),
    commandEvidence(finalWorkerLookup),
  );
  const initialNormalizedDatabases =
    normalizedD1Inventory(initialD1Inventory);
  const finalNormalizedDatabases =
    normalizedD1Inventory(finalD1Inventory);
  const finalBuckets = r2BucketNames(finalR2Inventory);
  checks.nonProbeDurableInventoryUnchanged =
    initialNormalizedDatabases !== undefined &&
    finalNormalizedDatabases !== undefined &&
    JSON.stringify(initialNormalizedDatabases) ===
      JSON.stringify(finalNormalizedDatabases) &&
    initialBuckets !== undefined &&
    finalBuckets !== undefined &&
    JSON.stringify(initialBuckets) === JSON.stringify(finalBuckets);
  checks.cleanupSucceeded =
    checks.bucketEmptied &&
    databaseDelete.exitCode === 0 &&
    bucketDelete.exitCode === 0 &&
    checks.nonProbeDurableInventoryUnchanged &&
    workerIsAbsent(finalWorkerLookup);

  const evidencePath = await finish(undefined);
  const passed = Object.values(checks).every(Boolean);
  const status = passed ? "passed" : "failed";
  console.log(`Cloudflare account probe ${status}: ${evidencePath}`);
  if (!passed) {
    process.exitCode = 1;
  }
};

const isDirectRun = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  await main();
}
