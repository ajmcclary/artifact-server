import {createServer} from "node:http";

import {z} from "zod";

const collectorAddressSchema = z.object({port: z.number().int().positive()});

/** A loopback OTLP/HTTP JSON collector that keeps every exported signal body. */
export interface OtlpLogCollector {
  /** Exported log records since the last reset, as one searchable string. */
  logs(): string;
  /** Forget every signal exported so far. */
  reset(): void;
  /** Every exported signal body since the last reset, as one searchable string. */
  serialized(): string;
  /** Exported trace spans since the last reset, as one searchable string. */
  spans(): string;
  stop(): Promise<void>;
  /** Wait until every value appears in an exported signal. */
  waitFor(values: readonly string[]): Promise<void>;
  /** Wait until an exported trace span contains the value. */
  waitForSpan(value: string): Promise<void>;
}

const exportedVariables = {
  OTEL_BLRP_SCHEDULE_DELAY: "25",
  OTEL_BSP_SCHEDULE_DELAY: "25",
  OTEL_EXPORTER_OTLP_TIMEOUT: "100",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_METRIC_EXPORT_INTERVAL: "25",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_TRACES_EXPORTER: "otlp",
} as const;

/**
 * Start a collector and point this process's OpenTelemetry exporter at it.
 * The previous environment is restored when the collector stops.
 *
 * Effect reads the exporter environment once per process, so a test file
 * starts one collector before its first server and resets it between tests.
 */
export async function startOtlpLogCollector(): Promise<OtlpLogCollector> {
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const {port} = collectorAddressSchema.parse(server.address());
  const previous = new Map<string, string | undefined>();
  const assign = (name: string, value: string): void => {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  };
  assign("OTEL_EXPORTER_OTLP_ENDPOINT", `http://127.0.0.1:${port}`);
  for (const [name, value] of Object.entries(exportedVariables)) {
    assign(name, value);
  }
  const serialized = (): string => bodies.join("\n");
  const signal = (key: string): string =>
    bodies.filter((body) => body.includes(`"${key}"`)).join("\n");
  const waitUntil = async (
    contains: () => boolean,
    describe: () => string,
  ): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!contains()) {
      if (Date.now() > deadline) {
        throw new Error(`${describe()} after ${bodies.length} exports.`);
      }
      // eslint-disable-next-line no-await-in-loop -- poll the collector
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  return {
    logs: () => signal("resourceLogs"),
    reset: () => {
      bodies.length = 0;
    },
    serialized,
    spans: () => signal("resourceSpans"),
    stop: async () => {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    },
    waitFor: (values) =>
      waitUntil(
        () => values.every((value) => serialized().includes(value)),
        () => {
          const missing = values.filter((value) => !serialized().includes(value));
          return `OTLP signals never contained ${JSON.stringify(missing)}`;
        },
      ),
    waitForSpan: (value) =>
      waitUntil(
        () => signal("resourceSpans").includes(value),
        () => `No exported span contained ${JSON.stringify(value)}`,
      ),
  };
}
