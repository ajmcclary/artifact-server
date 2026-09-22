import {randomUUID} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {performance} from "node:perf_hooks";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {Command} from "commander";
import {Effect, Layer, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {z} from "zod";

import {publishPath} from "../../src/client/file-publication-client.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../../tests/support/runtime-harness.js";
import {captureMeasurementContext} from "./measurement-context.js";

type Transport = "batch" | "per-file";

const optionsSchema = z.object({
  fileBytes: z.coerce.number().int().min(64).max(1_024 * 1_024),
  files: z.coerce.number().int().min(2).max(3_301),
  iterations: z.coerce.number().int().min(1).max(20),
  output: z.string().min(1),
});

interface LegSample {
  readonly bytesReceived: number;
  readonly bytesSent: number;
  readonly leg: "commit" | "other" | "plan" | "staging";
  readonly milliseconds: number;
}

interface ArmSummary {
  readonly endToEndMilliseconds: readonly number[];
  readonly legTotalMilliseconds: Readonly<Record<string, number>>;
  readonly meanMilliseconds: number;
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
  readonly transport: Transport;
}

const program = new Command()
  .name("batch-staging-comparison")
  .description(
    "Compare per-file PUT staging against the opt-in binary small-file batch transport end to end.",
  )
  .option("--files <count>", "files per publication, maximum 3301", "48")
  .option("--file-bytes <bytes>", "bytes per file, maximum 1048576", "4096")
  .option("--iterations <count>", "publications per arm, maximum 20", "5")
  .option("--output <path>", "JSON report path",
    "project/evidence/batch-staging-comparison.json");

async function main(): Promise<void> {
  program.parse();
  const options = optionsSchema.parse(program.opts());
  const startedAt = new Date().toISOString();
  const perFile = await measureArm("per-file", options);
  const batch = await measureArm("batch", options);
  const environment = await captureMeasurementContext();
  const endToEndDeltaPercent = round(
    100 * (perFile.meanMilliseconds - batch.meanMilliseconds) /
      perFile.meanMilliseconds,
  );
  const stagingDeltaPercent = round(
    100 * ((perFile.legTotalMilliseconds["staging"] ?? 0) -
      (batch.legTotalMilliseconds["staging"] ?? 0)) /
      Math.max(1, perFile.legTotalMilliseconds["staging"] ?? 0),
  );
  const report = {
    ...environment,
    arms: {batch, perFile},
    comparison: {
      endToEndDeltaPercent,
      stagingLegDeltaPercent: stagingDeltaPercent,
      threshold: 10,
      verdict: endToEndDeltaPercent >= 10
        ? "batch_faster_by_threshold"
        : "below_threshold",
    },
    completedAt: new Date().toISOString(),
    configuration: {
      fileBytes: options.fileBytes,
      files: options.files,
      iterations: options.iterations,
    },
    note: "One bounded local paired comparison of the real file client end to end. Machine-timing values are a local diagnostic, not a production capacity claim and not a regression budget.",
    startedAt,
    success: true,
    target: "local",
  };
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`JSON report written to ${options.output}\n`);
}

async function measureArm(
  transport: Transport,
  options: z.infer<typeof optionsSchema>,
): Promise<ArmSummary> {
  let installation: TestInstallation | null = null;
  let server: RunningTestServer | null = null;
  let fixtureDirectory: string | null = null;
  try {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    fixtureDirectory = await createFixture(options);
    const endToEndMilliseconds: number[] = [];
    const legTotals: Record<string, number> = {};
    for (let index = 0; index < options.iterations; index += 1) {
      const samples: LegSample[] = [];
      const startedAt = performance.now();
      // eslint-disable-next-line no-await-in-loop -- sequential publications per arm
      await executeFileClient(
        server,
        installation,
        fixtureDirectory,
        `${transport} arm ${index}`,
        transport,
        samples,
      );
      endToEndMilliseconds.push(round(performance.now() - startedAt));
      for (const sample of samples) {
        legTotals[sample.leg] = round((legTotals[sample.leg] ?? 0) + sample.milliseconds);
      }
    }
    const sorted = [...endToEndMilliseconds].toSorted((left, right) => left - right);
    const total = endToEndMilliseconds.reduce((sum, value) => sum + value, 0);
    return {
      endToEndMilliseconds,
      legTotalMilliseconds: legTotals,
      meanMilliseconds: round(total / endToEndMilliseconds.length),
      p50Milliseconds: percentile(sorted, 50),
      p95Milliseconds: percentile(sorted, 95),
      transport,
    };
  } finally {
    if (server !== null) await server.stop();
    if (installation !== null) await removeTestInstallation(installation);
    if (fixtureDirectory !== null) {
      await rm(fixtureDirectory, {force: true, recursive: true});
    }
  }
}

async function createFixture(
  options: z.infer<typeof optionsSchema>,
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "batch-comparison-fixture-"));
  const siteDirectory = path.join(directory, "site");
  const assetDirectory = path.join(siteDirectory, "assets");
  await mkdir(assetDirectory, {recursive: true});
  await writeFile(
    path.join(siteDirectory, "index.html"),
    sizedBuffer(options.fileBytes, "index"),
  );
  await Promise.all(Array.from({length: options.files - 1}, (_, index) =>
    writeFile(
      path.join(assetDirectory, `asset-${index.toString().padStart(4, "0")}.bin`),
      sizedBuffer(options.fileBytes, `asset-${index}`),
    )
  ));
  return siteDirectory;
}

function executeFileClient(
  server: RunningTestServer,
  installation: TestInstallation,
  inputPath: string,
  name: string,
  transport: Transport,
  samples: LegSample[],
) {
  return Effect.runPromise(
    publishPath(
      {
        apiToken: Redacted.make(installation.apiToken, {label: "perf-api-token"}),
        serverOrigin: server.baseUrl,
        transport,
      },
      {
        idempotencyKey: randomUUID(),
        inputPath,
        target: {
          accessSetting: "public_link",
          kind: "new_artifact",
          name,
          tags: ["performance", "batch-comparison"],
        },
      },
    ).pipe(
      Effect.provide(instrumentedHttpClientLayer(samples)),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
}

function instrumentedHttpClientLayer(
  samples: LegSample[],
): Layer.Layer<HttpClient.HttpClient> {
  return Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function*() {
      const base = yield* HttpClient.HttpClient;
      return HttpClient.transform(base, (effect, outgoingRequest) =>
        Effect.gen(function*() {
          const startedAt = performance.now();
          const response = yield* effect;
          const arrayBuffer = yield* response.arrayBuffer;
          samples.push({
            bytesReceived: arrayBuffer.byteLength,
            bytesSent: requestBodyBytes(outgoingRequest.body),
            leg: classifyLeg(outgoingRequest.method, requestPath(outgoingRequest.url)),
            milliseconds: performance.now() - startedAt,
          });
          return response;
        }));
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}

function requestBodyBytes(body: HttpBody.HttpBody): number {
  // SAFETY: every HttpBody variant either exposes contentLength or represents
  // an empty body with no measurable client payload size.
  return (body as HttpBody.HttpBody.Proto).contentLength ?? 0;
}

function requestPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function classifyLeg(
  method: string,
  pathname: string,
): LegSample["leg"] {
  if (method === "POST" && pathname === "/api/v1/uploads") return "plan";
  if (
    method === "POST" &&
    /^\/api\/v1\/uploads\/[^/]+\/batch$/u.test(pathname)
  ) {
    return "staging";
  }
  if (
    method === "PUT" &&
    /^\/api\/v1\/uploads\/[^/]+\/files\/[^/]+$/u.test(pathname)
  ) {
    return "staging";
  }
  if (
    method === "POST" &&
    /^\/api\/v1\/uploads\/[^/]+\/commit$/u.test(pathname)
  ) {
    return "commit";
  }
  return "other";
}

function sizedBuffer(bytes: number, label: string): Buffer {
  const buffer = Buffer.alloc(bytes, 0x78);
  buffer.write(label, 0, "utf8");
  return buffer;
}

function percentile(sorted: readonly number[], requested: number): number {
  const index = Math.max(0, Math.ceil((requested / 100) * sorted.length) - 1);
  const value = sorted[index];
  if (value === undefined) throw new Error("A percentile requires a populated sample.");
  return value;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

main().catch((error) => {
  process.stderr.write(`batch-staging-comparison failed: ${String(error)}\n`);
  process.exit(1);
});
