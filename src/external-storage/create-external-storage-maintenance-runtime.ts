import {Effect, Layer, ManagedRuntime, type Redacted} from "effect";

import type {ExpiredStagingCleanupReport} from
  "../application/expired-staging-cleanup.js";
import type {Clock} from "../core/ports.js";
import {SystemClock} from "../core/system.js";
import {createStagingCleanupLayer} from "../local/create-local-application-layer.js";
import {
  otlpLayer,
  structuredLoggingLayer,
} from "../observability/application-observability.js";
import {runStagingCleanupPass, type StagingCleanupPolicy} from
  "../lifecycle/staging-cleanup.js";
import {PostgresArtifactRepository} from "../storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../storage/postgres-database.js";
import type {
  ObjectStorageProvider,
  ObjectStorageProviderFactory,
} from "../storage/object-storage-provider.js";

/**
 * Storage-only inputs for one maintenance process. There is deliberately no API
 * token, browser access, origin, or identity provider: a maintenance process
 * never authenticates a caller and never opens a listener.
 */
export interface ExternalStorageMaintenanceConfig {
  readonly clock?: Clock;
  readonly databaseUrl: Redacted.Redacted;
  readonly installationId: string;
  readonly objectStorage: ObjectStorageProviderFactory;
  readonly postgresMaxConnections: number;
  readonly serviceVersion?: string;
  readonly stagingCleanupPolicy: StagingCleanupPolicy;
}

/** A connected maintenance process that exposes bounded passes and nothing that serves. */
export interface ExternalStorageMaintenanceRuntime {
  cleanupStaging(limit: number): Promise<ExpiredStagingCleanupReport>;
  close(): Promise<void>;
}

/** Connect Postgres and object storage for maintenance without building the HTTP app. */
export async function createExternalStorageMaintenanceRuntime(
  config: ExternalStorageMaintenanceConfig,
): Promise<ExternalStorageMaintenanceRuntime> {
  const database = await PostgresDatabase.open({
    applicationName: `artifact-server-maintenance:${config.installationId}`,
    maxConnections: config.postgresMaxConnections,
    url: config.databaseUrl,
  }, "validate");
  let objectStorage: ObjectStorageProvider | null = null;
  let ownedByRuntime = false;
  try {
    const connectedObjectStorage = config.objectStorage.create(config.installationId);
    objectStorage = connectedObjectStorage;
    await Promise.all([
      database.health(),
      connectedObjectStorage.readiness(AbortSignal.timeout(3_000)),
    ]);
    const repository = await PostgresArtifactRepository.open(
      database,
      config.installationId,
    );
    const cleanupLayer = createStagingCleanupLayer({
      blobs: connectedObjectStorage.blobs,
      clock: config.clock ?? new SystemClock(),
      repository,
      staging: connectedObjectStorage.staging,
      stagingCleanupPolicy: config.stagingCleanupPolicy,
    });
    const resources = Layer.effectDiscard(Effect.acquireRelease(
      Effect.void,
      () => Effect.promise(async () => {
        await Promise.all([connectedObjectStorage.close(), database.close()]);
      }),
    ));
    const telemetry = otlpLayer({
      deploymentMode: "external-storage",
      installationId: config.installationId,
      serviceVersion: config.serviceVersion ?? "0.0.0",
    }).pipe(Layer.provideMerge(structuredLoggingLayer));
    // Resources move into the managed runtime here; from now on disposing it
    // closes both providers exactly once.
    ownedByRuntime = true;
    const readyRuntime = ManagedRuntime.make(
      Layer.mergeAll(cleanupLayer, resources, telemetry),
    );
    try {
      await readyRuntime.context();
    } catch (cause) {
      await readyRuntime.dispose();
      throw cause;
    }
    return {
      cleanupStaging: (limit) => runStagingCleanupPass(readyRuntime, limit),
      close: () => readyRuntime.dispose(),
    };
  } catch (cause) {
    if (!ownedByRuntime) {
      await Promise.all([objectStorage?.close() ?? Promise.resolve(), database.close()]);
    }
    throw cause;
  }
}
