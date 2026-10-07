import {once} from "node:events";

import {getRequestListener} from "@hono/node-server";
import {z} from "zod";

import {
  createExternalStorageRuntime,
  type ExternalStorageRuntimeConfig,
} from "./create-external-storage-runtime.js";
import {createGracefulHttpShutdown} from
  "../lifecycle/graceful-http-shutdown.js";
import {createRuntimeLifecycle} from "../lifecycle/runtime-readiness.js";
import {withNodeResponseCompression} from
  "../http/node-response-compression.js";
import {createArtifactHttpServer} from "../http/node-http-server.js";

const serverAddressSchema = z.object({
  address: z.string().min(1),
  port: z.number().int().positive(),
});

/** External-storage server settings for one process. */
export interface ExternalStorageServerConfig extends ExternalStorageRuntimeConfig {
  readonly hostname: string;
  readonly port: number;
  readonly readinessWithdrawalMilliseconds?: number;
  /**
   * Node's deadline for receiving one whole request. Defaults to the staged
   * write deadline plus answer headroom; tests shorten it.
   */
  readonly requestTimeoutMilliseconds?: number;
  readonly shutdownDeadlineMilliseconds?: number;
}

/** One running stateless external-storage process. */
export interface RunningExternalStorageServer {
  readonly hostname: string;
  readonly port: number;
  close(): Promise<void>;
}

/** Start one external-storage process after provider readiness succeeds. */
export async function startExternalStorageServer(
  config: ExternalStorageServerConfig,
): Promise<RunningExternalStorageServer> {
  if (config.interactiveIdentityProvider === undefined) {
    throw new Error(
      "A private-team server requires exactly one OIDC or WorkOS browser-login provider.",
    );
  }
  const lifecycle = config.runtimeLifecycle ?? createRuntimeLifecycle();
  const runtime = await createExternalStorageRuntime({
    ...config,
    runtimeLifecycle: lifecycle,
  });
  const server = createArtifactHttpServer(
    getRequestListener(withNodeResponseCompression(runtime.app.fetch), {
      hostname: config.hostname,
    }),
    config.requestTimeoutMilliseconds,
  );
  const listening = once(server, "listening");
  try {
    server.listen(config.port, config.hostname);
    await listening;
  } catch (cause) {
    server.closeAllConnections();
    await runtime.close();
    throw cause;
  }
  const address = serverAddressSchema.parse(server.address());
  lifecycle.markReady();
  const close = createGracefulHttpShutdown({
    closeResources: () => runtime.close(),
    lifecycle,
    readinessWithdrawalMilliseconds:
      config.readinessWithdrawalMilliseconds ?? 0,
    server,
    shutdownDeadlineMilliseconds:
      config.shutdownDeadlineMilliseconds ?? 10_000,
  });
  return {
    hostname: address.address,
    port: address.port,
    close,
  };
}
