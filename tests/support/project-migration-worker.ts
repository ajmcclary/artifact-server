import {Redacted} from "effect";
import {z} from "zod";

import {PostgresDatabase} from "../../src/storage/postgres-database.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {projectMigrationWorkerApplicationName} from "./project-migration.js";

/**
 * Run one product migration in its own process so a test can kill it at a
 * chosen point. SQLite migrates by opening the compact repository; Postgres
 * applies the external-storage migrations under the advisory lock.
 */
const environmentSchema = z.discriminatedUnion("ARTIFACT_SERVER_MIGRATION_ENGINE", [
  z.object({
    ARTIFACT_SERVER_MIGRATION_ENGINE: z.literal("sqlite"),
    ARTIFACT_SERVER_MIGRATION_TARGET: z.string().min(1),
  }),
  z.object({
    ARTIFACT_SERVER_MIGRATION_ENGINE: z.literal("postgres"),
    ARTIFACT_SERVER_MIGRATION_TARGET: z.url(),
  }),
]);

async function main(): Promise<void> {
  const environment = environmentSchema.parse(process.env);
  if (environment.ARTIFACT_SERVER_MIGRATION_ENGINE === "sqlite") {
    new SqliteArtifactRepository(
      environment.ARTIFACT_SERVER_MIGRATION_TARGET,
      "local",
    ).close();
  } else {
    const database = await PostgresDatabase.open({
      applicationName: projectMigrationWorkerApplicationName,
      maxConnections: 1,
      url: Redacted.make(environment.ARTIFACT_SERVER_MIGRATION_TARGET),
    }, "apply");
    await database.close();
  }
  process.stdout.write("migrated\n");
}

await main();
