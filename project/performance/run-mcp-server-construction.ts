import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {performance} from "node:perf_hooks";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {Command} from "commander";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../../tests/support/runtime-harness.js";
import {publishNew} from "../../tests/support/publishing.js";
import {summarize} from "./comment-polling-shared.js";
import {captureMeasurementContext} from "./measurement-context.js";

const protocolVersion = "2026-07-28";
const catalogSizesSchema = z
  .string()
  .transform((value) => value.split(",").map((entry) => Number(entry.trim())))
  .pipe(z.array(z.number().int().min(0).max(3_301)).min(1).max(8));
const optionsSchema = z.object({
  catalogSizes: catalogSizesSchema,
  maximumMilliseconds: z.coerce.number().int().min(60_000).max(1_800_000),
  output: z.string().min(1),
  samples: z.coerce.number().int().min(10).max(500),
});

const program = new Command()
  .name("mcp-server-construction-baseline")
  .description(
    "Measure per-request MCP server construction and catalog-read cost over the real HTTP boundary at growing catalog sizes.",
  )
  .option(
    "--catalog-sizes <list>",
    "comma-separated artifact counts, measured cumulatively",
    "0,100,1000",
  )
  .option("--samples <count>", "measured requests per method per catalog size", "50")
  .option("--maximum-milliseconds <time>", "wall-time budget", "900000")
  .option(
    "--output <path>",
    "JSON report path",
    "project/evidence/mcp-server-construction-baseline.json",
  );

interface MethodSamples {
  readonly artifactListFirstPage: readonly number[];
  readonly serverDiscover: readonly number[];
  readonly resourcesTemplatesList: readonly number[];
  readonly toolsList: readonly number[];
}

interface McpParameters {
  readonly [key: string]: McpParameterValue;
}

type McpParameterValue =
  | boolean
  | number
  | string
  | null
  | readonly McpParameterValue[]
  | McpParameters;

async function main(): Promise<void> {
  program.parse();
  const options = optionsSchema.parse(program.opts());
  const sortedSizes = [...options.catalogSizes].toSorted((left, right) => left - right);
  const startedAt = new Date().toISOString();
  const budgetStarted = performance.now();
  const installation = await createTestInstallation();
  const server = await startTestServer(installation);
  try {
    const scenarios = [];
    let seeded = 0;
    for (const size of sortedSizes) {
      const seedStarted = performance.now();
      while (seeded < size) {
        // eslint-disable-next-line no-await-in-loop -- publishes must commit in order
        await publishNew(server, installation, {
          accessSetting: "account_required",
          content: `<p>mcp construction catalog fixture ${seeded}</p>`,
          idempotencyKey: `mcp-construction-catalog-${seeded}`,
          name: `MCP construction catalog fixture ${seeded}`,
        });
        seeded += 1;
      }
      const seedMilliseconds = performance.now() - seedStarted;
      scenarios.push({
        artifactCount: size,
        // eslint-disable-next-line no-await-in-loop -- catalog sizes are measured in isolation, never concurrently
        samples: await measureScenario(server, installation, options.samples),
        seedMilliseconds,
      });
      if (performance.now() - budgetStarted > options.maximumMilliseconds) {
        throw new Error("MCP construction baseline exceeded its wall-time budget.");
      }
    }
    const environment = await captureMeasurementContext();
    const report = {
      ...environment,
      completedAt: new Date().toISOString(),
      configuration: {
        catalogSizes: sortedSizes,
        samples: options.samples,
      },
      note: "Every measured request is a fresh stateless POST, so each sample pays one full createArtifactMcpServer construction plus bearer authentication and the named method. Bounded local diagnostic; this does not establish tail latency or support an optimization decision on its own.",
      scenarios: scenarios.map((scenario) => ({
        artifactCount: scenario.artifactCount,
        artifactListFirstPage: summarize(scenario.samples.artifactListFirstPage),
        serverDiscover: summarize(scenario.samples.serverDiscover),
        resourcesTemplatesList: summarize(scenario.samples.resourcesTemplatesList),
        seedMilliseconds: scenario.seedMilliseconds,
        toolsList: summarize(scenario.samples.toolsList),
      })),
      startedAt,
      success: true,
    };
    const outputPath = path.resolve(options.output);
    await mkdir(path.dirname(outputPath), {recursive: true});
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(
      [
        `MCP server construction baseline complete (${sortedSizes.join("/")} artifacts, ${options.samples} samples each).`,
        ...report.scenarios.map((scenario) =>
          `${scenario.artifactCount} artifacts: server/discover p95 ${scenario.serverDiscover.latency.p95Milliseconds.toFixed(2)} ms, ` +
          `tools/list p95 ${scenario.toolsList.latency.p95Milliseconds.toFixed(2)} ms, ` +
          `artifact_list p95 ${scenario.artifactListFirstPage.latency.p95Milliseconds.toFixed(2)} ms.`),
        `Report: ${outputPath}`,
      ].join("\n") + "\n",
    );
  } finally {
    await server.stop();
    await removeTestInstallation(installation);
  }
}

async function measureScenario(
  server: RunningTestServer,
  installation: TestInstallation,
  samples: number,
): Promise<MethodSamples> {
  const timed = async (
    method: string,
    parameters: McpParameters,
    additionalHeaders?: Record<string, string>,
  ): Promise<number> => {
    const started = performance.now();
    const response = await mcpRequest(
      server,
      installation.apiToken,
      method,
      parameters,
      additionalHeaders,
    );
    const elapsed = performance.now() - started;
    if (!response.ok) {
      throw new Error(`MCP ${method} returned HTTP ${response.status}.`);
    }
    await response.body?.cancel();
    return elapsed;
  };
  // Warm the route outside the measured samples.
  await timed("server/discover", {});
  await timed("tools/list", {});
  const serverDiscover: number[] = [];
  const toolsList: number[] = [];
  const resourcesTemplatesList: number[] = [];
  const artifactListFirstPage: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- sequential requests measure per-request cost
    serverDiscover.push(await timed("server/discover", {}));
    // eslint-disable-next-line no-await-in-loop -- sequential requests measure per-request cost
    toolsList.push(await timed("tools/list", {}));
    resourcesTemplatesList.push(
      // eslint-disable-next-line no-await-in-loop -- sequential requests measure per-request cost
      await timed("resources/templates/list", {}),
    );
    artifactListFirstPage.push(
      // eslint-disable-next-line no-await-in-loop -- sequential requests measure per-request cost
      await timed("tools/call", {
        arguments: {limit: 50},
        name: "artifact_list",
      }, {"Mcp-Name": "artifact_list"}),
    );
  }
  return {artifactListFirstPage, resourcesTemplatesList, serverDiscover, toolsList};
}

async function mcpRequest(
  server: RunningTestServer,
  token: string,
  method: string,
  parameters: McpParameters,
  additionalHeaders?: Record<string, string>,
): Promise<Response> {
  return fetch(`${server.baseUrl}/mcp`, {
    body: JSON.stringify({
      id: crypto.randomUUID(),
      jsonrpc: "2.0",
      method,
      params: {
        ...parameters,
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: {name: "artifact-server-performance", version: "1"},
          [PROTOCOL_VERSION_META_KEY]: protocolVersion,
        },
      },
    }),
    headers: {
      ...additionalHeaders,
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": protocolVersion,
      "Mcp-Method": method,
    },
    method: "POST",
  });
}

void main().catch((cause: unknown) => {
  const message = cause instanceof Error
    ? cause.message
    : "The MCP server construction baseline failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
