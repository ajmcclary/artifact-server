import {Effect, Redacted} from "effect";
import {z} from "zod";

import {verifyCliCredential} from "./cli-profile-credential.js";
import {authenticatedCliHttpClientLayer, type CliServerConnection} from "./cli-server-connection.js";
import {publicationDetailsSchema, publicationReceiptSchema, type PublicationReceipt} from "./publication-record.js";

const projectsSchema = z.object({projects: z.array(z.object({id: z.string(), name: z.string(), archivedAt: z.string().nullable()}))});

export async function publicationIdentity(connection: CliServerConnection) {
  const account = await Effect.runPromise(verifyCliCredential(connection.origin, connection.apiToken).pipe(
    Effect.provide(authenticatedCliHttpClientLayer),
  ));
  return {installationId: account.principal.installationId, principalId: account.principal.id};
}

/** Management reads never follow a redirect or use a URL taken from a receipt. */
async function readPublicationResource(connection: CliServerConnection, resource: string): Promise<string> {
  const response = await fetch(new URL(resource, connection.origin), {
    headers: {Authorization: `Bearer ${Redacted.value(connection.apiToken)}`},
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Artifact Server refused publication inspection (HTTP ${response.status}). No publication was started.`);
  }
  return response.text();
}

export async function singlePublicationProject(connection: CliServerConnection): Promise<string> {
  const projects = projectsSchema.parse(JSON.parse(await readPublicationResource(connection, "/api/v1/projects")))
    .projects.filter((project) => project.archivedAt === null);
  if (projects.length !== 1 || projects[0] === undefined) {
    throw projectSelectionError(projects);
  }
  return projects[0].id;
}

export async function currentPublication(
  connection: CliServerConnection,
  projectId: string,
  artifactId: string,
): Promise<PublicationReceipt> {
  const query = new URLSearchParams({projectId});
  const details = publicationDetailsSchema.parse(JSON.parse(await readPublicationResource(
    connection,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}?${query.toString()}`,
  )));
  const receipt = publicationReceiptSchema.parse({
    artifact: details.artifact,
    version: details.current.version,
    links: {artifact: details.links.artifact, ...details.current.links},
    replayed: false,
  });
  if (receipt.artifact.id !== artifactId || receipt.artifact.projectId !== projectId) {
    throw new Error("Artifact Server returned a different publication identity.");
  }
  return receipt;
}

export function requireCurrentPublication(receipt: PublicationReceipt, expectedVersion: string): void {
  if (receipt.version.id !== expectedVersion) {
    throw new Error(`Publication conflict: expected ${expectedVersion}, but the server is at ${receipt.version.id}. Inspect the newer version, then use publications refresh to accept it explicitly.`);
  }
}

export async function publicationProjectSelectionError(connection: CliServerConnection): Promise<Error> {
  const projects = projectsSchema.parse(JSON.parse(await readPublicationResource(connection, "/api/v1/projects")))
    .projects.filter((project) => project.archivedAt === null);
  return projectSelectionError(projects);
}

function projectSelectionError(projects: z.infer<typeof projectsSchema>["projects"]): Error {
  return new Error(`PROJECT_SELECTION_REQUIRED: Select a publication project with --project. Available projects: ${projects.map((project) => `${project.name} (${project.id})`).join(", ")}.`);
}
