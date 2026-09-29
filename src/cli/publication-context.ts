import path from "node:path";

import {resolveCliServerConnection, type CliServerConnection} from "./cli-server-connection.js";
import type {PublicationDestinationOptions} from "./publication-options.js";
import type {PublicationScope} from "./publication-record.js";
import {publicationIdentity, publicationProjectSelectionError, singlePublicationProject, requireActivePublicationProject} from "./publication-remote.js";
import {listPublicationRecords, publicationDirectory, publicationSource, locatePublicationDirectory} from "./publication-registry.js";

export interface PublicationContext {
  readonly connection: CliServerConnection;
  readonly directory: string;
  readonly profileData: string;
  readonly scope: PublicationScope;
}

export async function resolvePublicationContext(
  inputPath: string,
  options: PublicationDestinationOptions,
): Promise<PublicationContext> {
  const sourcePath = await publicationSource(inputPath);
  const profileData = path.resolve(options.profileData);
  const directory = await publicationDirectory(profileData, sourcePath);
  const connection = await resolveCliServerConnection(options, "publish");
  const identity = await publicationIdentity(connection);
  const records = (await listPublicationRecords(directory)).filter((record) =>
    record.scope.sourcePath === sourcePath && record.scope.origin === connection.origin &&
    (options.project === undefined || record.scope.projectId === options.project),
  );
  if (records.some((record) => record.scope.installationId !== identity.installationId ||
    record.scope.principalId !== identity.principalId)) {
    throw new Error("This source has a publication bound to a different installation or principal. Select its original credentials; no replacement was created.");
  }
  if (options.project === undefined && records.length > 1) {
    throw await publicationProjectSelectionError(connection);
  }
  const projectId = options.project ?? records[0]?.scope.projectId ?? await singlePublicationProject(connection);
  return {
    connection, directory, profileData,
    scope: {sourcePath, origin: connection.origin, ...identity, projectId},
  };
}

/** One verified destination shared by all members of a publication group. */
export interface GroupPublicationDestination {
  readonly connection: CliServerConnection;
  readonly installationId: string;
  readonly principalId: string;
  readonly projectId: string;
}

export async function resolveGroupPublicationDestination(options: PublicationDestinationOptions): Promise<GroupPublicationDestination> {
  const connection = await resolveCliServerConnection(options, "publish");
  const identity = await publicationIdentity(connection);
  const projectId = options.project ?? await singlePublicationProject(connection);
  await requireActivePublicationProject(connection, projectId);
  return {connection, ...identity, projectId};
}

/** Inspect a binding using a shared destination without creating state directories. */
export async function inspectPublicationContext(
  inputPath: string,
  options: PublicationDestinationOptions,
  destination: GroupPublicationDestination,
): Promise<PublicationContext> {
  const sourcePath = await publicationSource(inputPath);
  const profileData = path.resolve(options.profileData);
  const directory = await locatePublicationDirectory(profileData, sourcePath);
  const records = (await listPublicationRecords(directory)).filter((record) =>
    record.scope.sourcePath === sourcePath && record.scope.origin === destination.connection.origin &&
    record.scope.projectId === destination.projectId);
  if (records.some((record) => record.scope.installationId !== destination.installationId ||
    record.scope.principalId !== destination.principalId)) {
    throw new Error("This source has a publication bound to a different installation or principal.");
  }
  return {connection: destination.connection, directory, profileData, scope: {
    sourcePath, origin: destination.connection.origin, installationId: destination.installationId,
    principalId: destination.principalId, projectId: destination.projectId,
  }};
}
