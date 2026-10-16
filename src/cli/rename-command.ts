import {randomUUID} from "node:crypto";

import type {Command} from "commander";
import {Redacted} from "effect";
import {z} from "zod";

import {resolveCliServerConnection} from "./cli-server-connection.js";
import {addPublicationDestinationOptions, type PublicationDestinationOptions} from "./publication-options.js";
import {publicationReceiptSchema} from "./publication-record.js";
import {currentPublication, singlePublicationProject} from "./publication-remote.js";

interface RenameOptions extends PublicationDestinationOptions {
  readonly expectedName?: string;
  readonly expectedVersion?: string;
  readonly idempotencyKey?: string;
}

/** Rename by stable identity using publication credential resolution and transport. */
export function configureRenameCommand(program: Command, defaultProfileDirectory: string): void {
  addPublicationDestinationOptions(program.command("rename")
    .description("Rename an existing artifact without publishing a version.")
    .argument("<artifact>", "artifact ID")
    .argument("<name>", "new display name")
    .option("--expected-name <name>", "exact name previously read")
    .option("--expected-version <id>", "current version previously read")
    .option("--idempotency-key <key>", "replay key; reuse with the same expectations"), defaultProfileDirectory)
    .action(async (artifactId: string, name: string, options: RenameOptions) => {
      const connection = await resolveCliServerConnection(options, "publish");
      const projectId = options.project ?? await singlePublicationProject(connection);
      if (options.idempotencyKey !== undefined &&
        (options.expectedName === undefined || options.expectedVersion === undefined)) {
        throw new Error("--idempotency-key requires --expected-name and --expected-version for a stable replay.");
      }
      const current = options.expectedName === undefined || options.expectedVersion === undefined
        ? await currentPublication(connection, projectId, artifactId)
        : null;
      const response = await fetch(new URL(
        `/api/v1/artifacts/${encodeURIComponent(artifactId)}/name?${new URLSearchParams({projectId})}`,
        connection.origin,
      ), {
        body: JSON.stringify({
          expectedCurrentVersionId: options.expectedVersion ?? current?.version.id,
          expectedName: options.expectedName ?? current?.artifact.name,
          name,
        }),
        headers: {
          Authorization: `Bearer ${Redacted.value(connection.apiToken)}`,
          "content-type": "application/json",
          "idempotency-key": options.idempotencyKey ?? randomUUID(),
        },
        method: "PATCH",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const failure = z.object({error: z.object({code: z.string(), message: z.string()})}).parse(body);
        throw new Error(`${failure.error.code} (HTTP ${response.status}): ${failure.error.message}`);
      }
      console.log(JSON.stringify(publicationReceiptSchema.parse(body), null, 2));
    });
}
