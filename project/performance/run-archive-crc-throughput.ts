import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

import {Command} from "commander";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
} from "../../tests/support/runtime-harness.js";
import {
  commitStagedUpload,
  createStagedUpload,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../../tests/support/publishing.js";
import {captureMeasurementContext} from "./measurement-context.js";

const mebibyte = 1024 * 1024;

const optionsSchema = z.object({
  megabytes: z.coerce.number().int().min(8).max(256),
  output: z.string().min(1),
  samples: z.coerce.number().int().min(3).max(20),
});

const program = new Command()
  .name("archive-crc-throughput")
  .description(
    "Measure real archive-creation throughput (stored-compression ZIP with incremental CRC-32) against the byte-for-byte file route that streams the same blob without CRC or ZIP framing.",
  )
  .option("--megabytes <size>", "size of the measured large blob in MiB", "64")
  .option("--samples <count>", "sequential samples per route", "5")
  .option(
    "--output <path>",
    "JSON report path",
    "project/evidence/archive-crc-throughput.json",
  );

interface TimedSample {
  readonly bytes: number;
  readonly megabytesPerSecond: number;
  readonly milliseconds: number;
}

interface RouteStats {
  readonly latency: {
    readonly meanMilliseconds: number;
    readonly p50Milliseconds: number;
    readonly p95Milliseconds: number;
  };
  readonly megabytesPerSecond: {
    readonly mean: number;
    readonly p50: number;
    readonly p95: number;
  };
  readonly samples: number;
  readonly totalBytes: number;
}

async function main(): Promise<void> {
  program.parse();
  const options = optionsSchema.parse(program.opts());
  const installation = await createTestInstallation();
  const server = await startTestServer(installation);
  try {
    const files: readonly TestSiteFile[] = [
      {
        bytes: new TextEncoder().encode(
          "<!doctype html><title>Archive CRC throughput fixture</title>",
        ),
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
      },
      {
        bytes: patternedBytes(options.megabytes * mebibyte),
        mediaType: "application/octet-stream",
        path: "large.bin",
      },
    ];
    const upload = await createStagedUpload(
      server,
      installation,
      "index.html",
      files,
    );
    await uploadEveryStagedFile(installation, upload.body, files);
    const published = (await commitStagedUpload(
      installation,
      upload.body,
      "archive-crc-throughput",
      {
        accessSetting: "account_required",
        kind: "new_artifact",
        name: "Archive CRC throughput",
        tags: [],
      },
    )).body;

    const archiveUrl = `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/archive?projectId=${published.artifact.projectId}`;
    const fileUrl = `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/file?path=large.bin&projectId=${published.artifact.projectId}`;
    const headers = {Authorization: `Bearer ${installation.apiToken}`};

    const archiveSamples = await collect(
      () => measureRoute(archiveUrl, headers),
      options.samples,
    );
    const fileSamples = await collect(
      () => measureRoute(fileUrl, headers),
      options.samples,
    );

    const archiveStats = summarize(archiveSamples);
    const fileStats = summarize(fileSamples);
    const environment = await captureMeasurementContext({
      probe: "archive-crc-throughput",
      scope: "local-sqlite-runtime",
    });
    const report = {
      ...environment,
      archive: {
        latency: archiveStats.latency,
        megabytesPerSecond: archiveStats.megabytesPerSecond,
        samples: archiveStats.samples,
        totalBytes: archiveStats.totalBytes,
      },
      completedAt: new Date().toISOString(),
      configuration: {
        largeBlobBytes: options.megabytes * mebibyte,
        megabytes: options.megabytes,
        samples: options.samples,
      },
      file: {
        latency: fileStats.latency,
        megabytesPerSecond: fileStats.megabytesPerSecond,
        samples: fileStats.samples,
        totalBytes: fileStats.totalBytes,
      },
      note: "Archive (stored-compression ZIP with incremental CRC-32 per chunk) versus the raw version file route for the same immutable blob. The archive path adds ZIP headers, central directory and byte-at-a-time CRC-32 over the file route, which streams the blob directly. Setup (publish) time is excluded. Sequential samples; single machine; no tail claim.",
      ratio: {
        archiveToFileMegabytesPerSecondMean:
          archiveStats.megabytesPerSecond.mean / fileStats.megabytesPerSecond.mean,
      },
      startedAt: environment.capturedAt,
      success: true,
      target: "local",
    };
    const outputPath = options.output;
    await mkdir(path.dirname(outputPath), {recursive: true});
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(
      [
        `Archive CRC throughput complete (${options.megabytes} MiB blob, ${options.samples} samples).`,
        `Archive: ${archiveStats.megabytesPerSecond.mean.toFixed(1)} MiB/s mean, p95 ${archiveStats.megabytesPerSecond.p95.toFixed(1)} MiB/s.`,
        `File:   ${fileStats.megabytesPerSecond.mean.toFixed(1)} MiB/s mean, p95 ${fileStats.megabytesPerSecond.p95.toFixed(1)} MiB/s.`,
        `Archive/file ratio: ${(archiveStats.megabytesPerSecond.mean / fileStats.megabytesPerSecond.mean).toFixed(3)}.`,
        `Report: ${outputPath}`,
      ].join("\n") + "\n",
    );
  } finally {
    await server.stop();
    await removeTestInstallation(installation);
  }
}

function patternedBytes(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) {
    bytes[index] = index % 251;
  }
  return bytes;
}

async function measureRoute(
  url: string,
  headers: Record<string, string>,
): Promise<TimedSample> {
  const response = await fetch(url, {headers});
  if (!response.ok) {
    throw new Error(`Route ${url} returned HTTP ${response.status}.`);
  }
  const started = process.hrtime.bigint();
  let bytes = 0;
  const body = response.body;
  if (body === null) {
    bytes = (await response.arrayBuffer()).byteLength;
  } else {
    for await (const chunk of body) {
      bytes += chunk.byteLength;
    }
  }
  const milliseconds = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    bytes,
    megabytesPerSecond: bytes / 1e6 / (milliseconds / 1000),
    milliseconds,
  };
}

async function collect(
  sample: () => Promise<TimedSample>,
  count: number,
  accumulated: readonly TimedSample[] = [],
): Promise<readonly TimedSample[]> {
  const next = [...accumulated, await sample()];
  return next.length >= count ? next : collect(sample, count, next);
}

function summarize(samples: readonly TimedSample[]): RouteStats {
  const latency = samples.map((sample) => sample.milliseconds);
  const throughput = samples.map((sample) => sample.megabytesPerSecond);
  return {
    latency: {
      meanMilliseconds: mean(latency),
      p50Milliseconds: percentile(latency, 0.5),
      p95Milliseconds: percentile(latency, 0.95),
    },
    megabytesPerSecond: {
      mean: mean(throughput),
      p50: percentile(throughput, 0.5),
      p95: percentile(throughput, 0.95),
    },
    samples: samples.length,
    totalBytes: samples.reduce((total, sample) => total + sample.bytes, 0),
  };
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values: readonly number[], requested: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(requested * sorted.length) - 1,
  );
  const value = sorted[index];
  if (value === undefined) {
    throw new Error("A percentile requires a populated sample.");
  }
  return value;
}

void main().catch((cause: unknown) => {
  const message = cause instanceof Error
    ? cause.message
    : "The archive CRC throughput measurement failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
