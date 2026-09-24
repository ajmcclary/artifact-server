import {createServer, type Server} from "node:http";
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

import {CreateBucketCommand, S3Client} from "@aws-sdk/client-s3";
import {Command} from "commander";
import {Redacted} from "effect";
import {z} from "zod";

import {defaultProjectId} from "../../src/core/model.js";
import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {startExternalStorageServer} from
  "../../src/external-storage/start-external-storage-server.js";
import {createOidcIdentityProvider} from
  "../../src/identity/oidc-identity-provider.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";
import {createS3ObjectStorageProviderFactory} from
  "../../src/storage/s3-object-storage.js";
import {
  managedBootstrapToken,
  managedRunInstallationId,
} from "../../tests/support/managed-external-storage.js";
import {publishNew} from "../../tests/support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
} from "../../tests/support/runtime-harness.js";
import {startStubOidcProvider} from "../../tests/support/stub-oidc-provider.js";
import {captureMeasurementContext} from "./measurement-context.js";

const inboundTraceparent =
  "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const inboundTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";

const optionsSchema = z.object({
  output: z.string().min(1),
  waitMilliseconds: z.coerce.number().int().min(500).max(60_000),
});

const program = new Command()
  .name("observability-span-linkage")
  .description(
    "Record real exported-span linkage for HTTP requests that perform storage work: SQLite always, Postgres when the pinned-provider environment is present.",
  )
  .option("--wait-milliseconds <time>", "OTLP delivery wait budget", "10000")
  .option(
    "--output <path>",
    "JSON report path",
    "project/evidence/observability-span-linkage.json",
  );

const spanValueSchema = z.looseObject({
  intValue: z.union([z.number(), z.string()]).optional(),
  stringValue: z.string().optional(),
});

const spanSchema = z.looseObject({
  attributes: z.array(z.looseObject({
    key: z.string(),
    value: spanValueSchema,
  })).optional(),
  name: z.string(),
  parentSpanId: z.string().optional(),
  spanId: z.string(),
  traceId: z.string(),
});

const tracesBodySchema = z.looseObject({
  resourceSpans: z.array(z.looseObject({
    scopeSpans: z.array(z.looseObject({spans: z.array(spanSchema)})).optional(),
  })).optional(),
});

type CapturedSpan = z.infer<typeof spanSchema>;

interface CapturedSignal {
  readonly body: unknown;
  readonly path: string;
}

interface DrivenRequest {
  readonly label: string;
  readonly requestId: string;
  readonly status: number;
  readonly traceparent?: string;
}

interface RequestLinkage {
  readonly allTraceIds: readonly string[];
  readonly httpRequestSpanFound: boolean;
  readonly inboundTraceparentHonored?: boolean;
  readonly label: string;
  readonly orphanSpanNames: readonly string[];
  readonly requestId: string;
  readonly routeSpanName: string | null;
  readonly routeSpanParentedToHttpRequest: boolean | null;
  readonly serviceSpanNames: readonly string[];
  readonly spanCount: number;
  readonly sqlSpanNames: readonly string[];
  readonly status: number;
  readonly traceId: string | null;
}

interface ArmReport {
  readonly requests: readonly RequestLinkage[];
  readonly spanInventory: Readonly<Record<string, number>>;
  readonly status: "measured";
}

interface SkippedArmReport {
  readonly reason: string;
  readonly status: "skipped";
}

async function main(): Promise<void> {
  program.parse();
  const options = optionsSchema.parse(program.opts());
  const signals: CapturedSignal[] = [];
  const collector = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      signals.push({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        path: request.url ?? "",
      });
      response.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
  const address = z.object({port: z.number().int().positive()}).parse(
    collector.address(),
  );
  configureOtlpEnvironment(address.port);
  try {
    const sqlite = await measureSqliteArm(signals, options.waitMilliseconds);
    const postgres = await measurePostgresArm(signals, options.waitMilliseconds);
    const environment = await captureMeasurementContext({
      postgresImage: process.env["ARTIFACT_SERVER_TEST_POSTGRES_IMAGE"] ?? null,
      probe: "observability-span-linkage",
    });
    const report = {
      ...environment,
      arms: {postgres, sqlite},
      completedAt: new Date().toISOString(),
      inboundTraceparent,
      note: "Span-linkage diagnostic (T18): drives real authenticated requests that perform storage work against an in-process server wired to a real OTLP collector, then records exported span names, trace IDs, and parent IDs exactly as observed. The Postgres arm runs only under scripts/with-external-storage-test-providers.sh. This probe documents the gap; it does not change linkage behavior.",
      startedAt: environment.capturedAt,
      success: true,
      target: "local",
    };
    await mkdir(path.dirname(options.output), {recursive: true});
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`JSON report written to ${options.output}\n`);
  } finally {
    await closeServer(collector);
  }
}

function configureOtlpEnvironment(port: number): void {
  process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = `http://127.0.0.1:${port}`;
  process.env["OTEL_EXPORTER_OTLP_TIMEOUT"] = "100";
  process.env["OTEL_LOGS_EXPORTER"] = "otlp";
  process.env["OTEL_METRICS_EXPORTER"] = "otlp";
  process.env["OTEL_TRACES_EXPORTER"] = "otlp";
  process.env["OTEL_BLRP_SCHEDULE_DELAY"] = "25";
  process.env["OTEL_METRIC_EXPORT_INTERVAL"] = "25";
  process.env["OTEL_BSP_SCHEDULE_DELAY"] = "25";
}

async function measureSqliteArm(
  signals: readonly CapturedSignal[],
  waitMilliseconds: number,
): Promise<ArmReport> {
  const installation = await createTestInstallation();
  const server = await startTestServer(installation, {
    completedRequestLogSampleRate: 1,
    observability: true,
  });
  const requests: DrivenRequest[] = [];
  try {
    const published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<p>span linkage probe</p>",
      idempotencyKey: "span-linkage-probe",
      name: "Span linkage probe",
    }));
    requests.push({
      label: "sqlite-publish-write",
      requestId: z.uuid().parse(published.response.headers.get("x-request-id")),
      status: published.response.status,
    });
    const read = await fetch(
      `${server.baseUrl}/api/v1/projects/${defaultProjectId}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    requests.push({
      label: "sqlite-project-read",
      requestId: z.uuid().parse(read.headers.get("x-request-id")),
      status: read.status,
    });
    const traced = await fetch(
      `${server.baseUrl}/api/v1/projects/${defaultProjectId}`,
      {
        headers: {
          Authorization: `Bearer ${installation.apiToken}`,
          traceparent: inboundTraceparent,
          tracestate: "probe=inbound",
        },
      },
    );
    requests.push({
      label: "sqlite-traceparent-read",
      requestId: z.uuid().parse(traced.headers.get("x-request-id")),
      status: traced.status,
      traceparent: inboundTraceparent,
    });
    const spans = await waitForSpans(signals, requests, waitMilliseconds);
    return analyze(spans, requests);
  } finally {
    await server.stop();
    await removeTestInstallation(installation);
  }
}

async function measurePostgresArm(
  signals: readonly CapturedSignal[],
  waitMilliseconds: number,
): Promise<ArmReport | SkippedArmReport> {
  const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  const endpoint = process.env["ARTIFACT_SERVER_TEST_S3_ENDPOINT"];
  const accessKey = process.env["ARTIFACT_SERVER_TEST_S3_ACCESS_KEY"];
  const secretKey = process.env["ARTIFACT_SERVER_TEST_S3_SECRET_KEY"];
  if (
    databaseUrl === undefined || endpoint === undefined ||
    accessKey === undefined || secretKey === undefined
  ) {
    return {
      reason: "Requires scripts/with-external-storage-test-providers.sh (ARTIFACT_SERVER_TEST_DATABASE_URL and ARTIFACT_SERVER_TEST_S3_*).",
      status: "skipped",
    };
  }
  const bucket = "artifact-server-span-linkage-probe";
  const region = "us-east-1";
  const s3 = new S3Client({
    credentials: {accessKeyId: accessKey, secretAccessKey: secretKey},
    endpoint,
    forcePathStyle: true,
    region,
  });
  await s3.send(new CreateBucketCommand({Bucket: bucket})).catch(
    (cause: unknown) => {
      if (!String(cause).includes("BucketAlreadyOwnedByYou")) throw cause;
    },
  );
  const url = Redacted.make(databaseUrl, {label: "span-linkage-probe"});
  const migrated = await PostgresDatabase.open({maxConnections: 1, url}, "apply");
  await migrated.close();
  const oidcProvider = await startStubOidcProvider({
    clientId: "span-linkage-probe",
  });
  const apiToken = managedBootstrapToken("span-linkage");
  const server = await startExternalStorageServer({
    apiToken: Redacted.make(apiToken),
    applicationOrigin: "https://artifacts.example.com",
    bootstrapAdministratorEmail: "administrator@example.test",
    browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
    contentDomain: "content.example.net",
    databaseUrl: url,
    hostname: "127.0.0.1",
    installationId: managedRunInstallationId("span-linkage"),
    interactiveIdentityProvider: createOidcIdentityProvider({
      applicationOrigin: "https://artifacts.example.com",
      clientId: "span-linkage-probe",
      clientSecret: null,
      issuer: oidcProvider.issuer,
      scopes: "openid email profile",
    }),
    objectStorage: createS3ObjectStorageProviderFactory({
      accessKeyId: accessKey,
      bucket,
      endpoint,
      forcePathStyle: true,
      region,
      secretAccessKey: Redacted.make(secretKey),
    }),
    port: 0,
  });
  const requests: DrivenRequest[] = [];
  try {
    const baseUrl = `http://${server.hostname}:${server.port}`;
    const headers = {Authorization: `Bearer ${apiToken}`};
    const published = await publishNew(
      {baseUrl, hostname: server.hostname, port: server.port, stop: () => server.close()},
      {apiToken, browserBootstrapToken: "unused", dataDirectory: "unused"},
      {
        accessSetting: "account_required",
        content: "<p>postgres span linkage probe</p>",
        idempotencyKey: "span-linkage-postgres-probe",
        name: "Postgres span linkage probe",
      },
    );
    requests.push({
      label: "postgres-publish-write",
      requestId: z.uuid().parse(published.response.headers.get("x-request-id")),
      status: published.response.status,
    });
    const read = await fetch(
      `${baseUrl}/api/v1/projects/${defaultProjectId}`,
      {headers},
    );
    requests.push({
      label: "postgres-project-read",
      requestId: z.uuid().parse(read.headers.get("x-request-id")),
      status: read.status,
    });
    const traced = await fetch(
      `${baseUrl}/api/v1/projects/${defaultProjectId}`,
      {headers: {...headers, traceparent: inboundTraceparent}},
    );
    requests.push({
      label: "postgres-traceparent-read",
      requestId: z.uuid().parse(traced.headers.get("x-request-id")),
      status: traced.status,
      traceparent: inboundTraceparent,
    });
    const spans = await waitForSpans(signals, requests, waitMilliseconds);
    return analyze(spans, requests);
  } finally {
    await server.close();
    await oidcProvider.stop();
  }
}

async function waitForSpans(
  signals: readonly CapturedSignal[],
  requests: readonly DrivenRequest[],
  waitMilliseconds: number,
): Promise<readonly CapturedSpan[]> {
  return pollSpans(signals, requests, Date.now() + waitMilliseconds);
}

async function pollSpans(
  signals: readonly CapturedSignal[],
  requests: readonly DrivenRequest[],
  deadline: number,
): Promise<readonly CapturedSpan[]> {
  const spans = flattenSpans(signals);
  const correlated = new Set(
    spans.map((span) => attribute(span, "request.id")).filter(Boolean),
  );
  if (
    requests.every((request) => correlated.has(request.requestId))
    || Date.now() >= deadline
  ) {
    return spans;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  return pollSpans(signals, requests, deadline);
}

function flattenSpans(signals: readonly CapturedSignal[]): readonly CapturedSpan[] {
  const spans: CapturedSpan[] = [];
  for (const signal of signals) {
    if (signal.path !== "/v1/traces") continue;
    const parsed = tracesBodySchema.safeParse(signal.body);
    if (!parsed.success) continue;
    for (const resourceSpan of parsed.data.resourceSpans ?? []) {
      for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
        spans.push(...scopeSpan.spans);
      }
    }
  }
  return spans;
}

function attribute(span: CapturedSpan, key: string): string | null {
  const entry = span.attributes?.find((candidate) => candidate.key === key);
  const value = entry?.value.stringValue ?? entry?.value.intValue;
  return value === undefined ? null : String(value);
}

function analyze(
  spans: readonly CapturedSpan[],
  requests: readonly DrivenRequest[],
): ArmReport {
  const inventory: Record<string, number> = {};
  for (const span of spans) {
    inventory[span.name] = (inventory[span.name] ?? 0) + 1;
  }
  return {
    requests: requests.map((request) => analyzeRequest(spans, request)),
    spanInventory: inventory,
    status: "measured",
  };
}

function analyzeRequest(
  spans: readonly CapturedSpan[],
  request: DrivenRequest,
): RequestLinkage {
  const correlated = spans.filter((span) =>
    attribute(span, "request.id") === request.requestId
  );
  const httpSpan = correlated.find((span) => span.name === "http.request");
  const traceId = httpSpan?.traceId ?? null;
  const traceSpans = traceId === null
    ? []
    : spans.filter((span) => span.traceId === traceId);
  const traceSpanIds = new Set(traceSpans.map((span) => span.spanId));
  const routeSpan = correlated.find((span) =>
    span.name !== "http.request" && span.parentSpanId !== undefined
  );
  const orphans = traceSpans.filter((span) =>
    span.spanId !== httpSpan?.spanId &&
    (span.parentSpanId === undefined || !traceSpanIds.has(span.parentSpanId))
  );
  const serviceSpanNames = traceSpans
    .filter((span) => span.name !== "http.request" && span !== routeSpan)
    .map((span) => span.name);
  const base: RequestLinkage = {
    allTraceIds: [...new Set(correlated.map((span) => span.traceId))],
    httpRequestSpanFound: httpSpan !== undefined,
    label: request.label,
    orphanSpanNames: orphans.map((span) => span.name),
    requestId: request.requestId,
    routeSpanName: routeSpan?.name ?? null,
    routeSpanParentedToHttpRequest: routeSpan === undefined || httpSpan === undefined
      ? null
      : routeSpan.parentSpanId === httpSpan.spanId,
    serviceSpanNames,
    spanCount: traceSpans.length,
    sqlSpanNames: traceSpans
      .filter((span) => span.name.startsWith("sql."))
      .map((span) => span.name),
    status: request.status,
    traceId,
  };
  if (request.traceparent === undefined) return base;
  return {
    ...base,
    inboundTraceparentHonored: traceSpans.some((span) =>
      span.traceId === inboundTraceId
    ),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

main().catch((cause: unknown) => {
  process.stderr.write(`observability-span-linkage failed: ${String(cause)}\n`);
  process.exitCode = 1;
});
