import {z} from "zod";

import {statistics} from "./delivery-report.js";

/** Readiness requests per probe; few enough not to load the host being measured. */
export const hostProbeRequests = 5;
const probeTimeoutMilliseconds = 10_000;

const readinessSchema = z.object({
  components: z.object({
    database: z.object({latencyMilliseconds: z.number().nonnegative(), status: z.literal("ready")}),
  }),
});

async function databaseLatency(readyUrl: URL): Promise<number | null> {
  try {
    const response = await fetch(readyUrl, {signal: AbortSignal.timeout(probeTimeoutMilliseconds)});
    if (!response.ok) return null;
    const parsed = readinessSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.components.database.latencyMilliseconds : null;
  } catch {
    return null;
  }
}

/**
 * The server's own database round trip, as /ready measures it. A trivial query
 * takes well under a millisecond on an uncontended host, so this records how
 * contended the host was when a sample ran, independent of the client network.
 * Null when the server exposes no database measurement (the local SQLite runtime).
 */
export async function probeHostDatabaseLatency(
  applicationOrigin: string,
  requests: number = hostProbeRequests,
): Promise<number | null> {
  const readyUrl = new URL("/ready", applicationOrigin);
  const latencies: number[] = [];
  for (let attempt = 0; attempt < requests; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- concurrent probes would measure their own contention
    const latency = await databaseLatency(readyUrl);
    if (latency !== null) latencies.push(latency);
  }
  return statistics(latencies)?.median ?? null;
}
