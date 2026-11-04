import {randomUUID} from "node:crypto";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {Option, type Command} from "commander";
import {Effect, Redacted} from "effect";
import {z} from "zod";

import {
  type FilePublicationCommand,
  type FilePublicationFailure,
  publishPath,
} from "../client/file-publication-client.js";
import {
  type CliServerConnection,
  publicationCliHttpClientLayer,
  resolveCliServerConnection,
} from "./cli-server-connection.js";
import {addPublicationDestinationOptions, type PublicationDestinationOptions} from "./publication-options.js";
import {currentPublication, singlePublicationProject} from "./publication-remote.js";

interface StageOptions extends PublicationDestinationOptions {
  readonly artifact: string;
  readonly entry?: string;
  readonly expectedVersion?: string;
  readonly idempotencyKey?: string;
  readonly routing?: "spa" | "static";
}

interface DecisionOptions extends PublicationDestinationOptions {
  readonly idempotencyKey?: string;
}

interface RejectOptions extends DecisionOptions {
  readonly superseded: boolean;
}

interface ListOptions extends PublicationDestinationOptions {
  readonly all: boolean;
}

const failureSchema = z.object({error: z.object({code: z.string(), message: z.string()})});
const jsonSchema = z.json();

/** One JSON response body from the server, already parsed. */
type ServerJson = z.infer<typeof jsonSchema>;

/** The only body a candidate decision sends. */
interface CandidateDecisionBody {
  readonly outcome: "rejected" | "superseded";
}

/**
 * Candidate versions (CND-001..CND-006): a build stages a candidate that does
 * not move current, and a person promotes or rejects it. Staging never touches
 * the remembered publication for a source, because a candidate is not current.
 */
export function configureCandidateCommands(program: Command, defaultProfileDirectory: string): void {
  const candidate = program.command("candidate")
    .description("Stage, list, promote, and reject candidate versions that wait for review before becoming current.");

  addPublicationDestinationOptions(candidate.command("stage")
    .description("Publish a file or directory as a candidate on an artifact; current does not move.")
    .argument("<path>", "file or finished directory to stage")
    .requiredOption("--artifact <id>", "artifact to stage the candidate on")
    .option("--expected-version <id>", "base version; defaults to the version current now")
    .option("--idempotency-key <key>", "replay key; reuse with the same input and base")
    .option("--entry <path>", "directory file that opens first")
    .addOption(new Option("--routing <mode>", "path routing").choices(["static", "spa"])), defaultProfileDirectory)
    .action(async (inputPath: string, options: StageOptions) => {
      const connection = await resolveCliServerConnection(options, "publish");
      const projectId = options.project ?? await singlePublicationProject(connection);
      const base = options.expectedVersion ??
        (await currentPublication(connection, projectId, options.artifact)).version.id;
      let command: FilePublicationCommand = {
        idempotencyKey: options.idempotencyKey ?? randomUUID(),
        inputPath,
        projectId,
        target: {artifactId: options.artifact, expectedCurrentVersionId: base, kind: "new_version", stage: true},
      };
      if (options.entry !== undefined) command = {...command, entryPath: options.entry};
      if (options.routing !== undefined) command = {...command, routingMode: options.routing};
      const result = await Effect.runPromise(publishPath(
        {apiToken: connection.apiToken, serverOrigin: connection.origin},
        command,
      ).pipe(
        Effect.mapError(candidatePublicationError),
        Effect.provide(publicationCliHttpClientLayer),
        Effect.provide(NodeFileSystem.layer),
      ));
      console.log(JSON.stringify({
        artifact: result.artifact,
        links: {
          artifact: result.links.artifact.toString(),
          review: result.links.review.toString(),
          version: result.links.version.toString(),
        },
        replayed: result.replayed,
        version: result.version,
      }, null, 2));
    });

  addPublicationDestinationOptions(candidate.command("list")
    .description("List open candidates on an artifact, or every staged version with --all.")
    .argument("<artifact>", "artifact ID")
    .option("--all", "include promoted, rejected, and superseded candidates and mainline versions", false), defaultProfileDirectory)
    .action(async (artifactId: string, options: ListOptions) => {
      const connection = await resolveCliServerConnection(options, "publish");
      const projectId = options.project ?? await singlePublicationProject(connection);
      const query = new URLSearchParams({filter: options.all ? "all" : "candidates", projectId});
      console.log(JSON.stringify(
        await candidateRequest(connection, "GET", `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions?${query}`, null),
        null,
        2,
      ));
    });

  addPublicationDestinationOptions(candidate.command("promote")
    .description("Make a candidate current. Requires a person signed in directly; API keys are refused.")
    .argument("<artifact>", "artifact ID")
    .argument("<version>", "candidate version ID")
    .option("--idempotency-key <key>", "replay key"), defaultProfileDirectory)
    .action(async (artifactId: string, versionId: string, options: DecisionOptions) => {
      await decide(options, artifactId, versionId, "promote", null);
    });

  addPublicationDestinationOptions(candidate.command("reject")
    .description("Close a candidate without making it current. Its bytes and comments are kept.")
    .argument("<artifact>", "artifact ID")
    .argument("<version>", "candidate version ID")
    .option("--superseded", "record that another candidate replaced this one", false)
    .option("--idempotency-key <key>", "replay key"), defaultProfileDirectory)
    .action(async (artifactId: string, versionId: string, options: RejectOptions) => {
      await decide(options, artifactId, versionId, "reject", {outcome: options.superseded ? "superseded" : "rejected"});
    });
}

async function decide(
  options: DecisionOptions,
  artifactId: string,
  versionId: string,
  action: "promote" | "reject",
  body: CandidateDecisionBody | null,
): Promise<void> {
  const connection = await resolveCliServerConnection(options, "publish");
  const projectId = options.project ?? await singlePublicationProject(connection);
  const query = new URLSearchParams({projectId});
  console.log(JSON.stringify(await candidateRequest(
    connection,
    "POST",
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/${action}?${query}`,
    body,
    options.idempotencyKey ?? randomUUID(),
  ), null, 2));
}

async function candidateRequest(
  connection: CliServerConnection,
  method: "GET" | "POST",
  resource: string,
  body: CandidateDecisionBody | null,
  idempotencyKey: string | null = null,
): Promise<ServerJson> {
  const headers = new Headers({Authorization: `Bearer ${Redacted.value(connection.apiToken)}`});
  if (idempotencyKey !== null) headers.set("idempotency-key", idempotencyKey);
  let init: RequestInit = {headers, method, redirect: "error", signal: AbortSignal.timeout(30_000)};
  if (body !== null) {
    headers.set("content-type", "application/json");
    init = {...init, body: JSON.stringify(body)};
  }
  const response = await fetch(new URL(resource, connection.origin), init);
  const parsed = jsonSchema.parse(await response.json());
  if (!response.ok) {
    const failure = failureSchema.parse(parsed);
    throw new Error(`${failure.error.code} (HTTP ${response.status}): ${failure.error.message}`);
  }
  return parsed;
}

function candidatePublicationError(error: FilePublicationFailure): Error {
  if (error._tag === "FilePublicationProtocolError") {
    const code = error.serverCode ?? error._tag;
    return new Error(`${code}${error.status === null ? "" : ` (HTTP ${error.status})`}: ${error.message}`, {cause: error});
  }
  return new Error(`${error._tag}: ${error.message}`, {cause: error});
}
