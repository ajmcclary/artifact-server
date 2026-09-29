import {readFile} from "node:fs/promises";
import type {Command} from "commander";

import {configurePublicationGroupList} from "./publication-group-command.js";
import {resolveCliServerConnection} from "./cli-server-connection.js";
import {resolvePublicationContext} from "./publication-context.js";
import {addPublicationDestinationOptions, type PublicationDestinationOptions} from "./publication-options.js";
import {publicationReceiptSchema, validatePublicationReceipt, type PublicationRecord} from "./publication-record.js";
import {currentPublication, publicationIdentity, requireCurrentPublication} from "./publication-remote.js";
import {listPublicationRecords, lockPublication, publicationDirectory, publicationRecordPath, readPublicationRecord, savePublicationRecord} from "./publication-registry.js";

interface ImportOptions extends PublicationDestinationOptions {
  readonly receipt: string;
}

export function configurePublicationCommands(program: Command, defaultProfileDirectory: string): void {
  const publications = program.command("publications").description("Inspect and register remembered publication destinations.");
  configurePublicationGroupList(publications);
  addPublicationDestinationOptions(publications.command("list").description("List remembered sources and destinations."), defaultProfileDirectory)
    .action(async (options: PublicationDestinationOptions) => {
      let records = await listPublicationRecords(await publicationDirectory(options.profileData));
      if (options.profile !== undefined || options.server !== undefined || options.tokenFile !== undefined) {
        const connection = await resolveCliServerConnection(options, "publish");
        const identity = await publicationIdentity(connection);
        records = records.filter((record) => record.scope.origin === connection.origin &&
          record.scope.installationId === identity.installationId && record.scope.principalId === identity.principalId);
      }
      if (options.project !== undefined) records = records.filter((record) => record.scope.projectId === options.project);
      console.log(JSON.stringify({publications: records.map(describePublication)}, null, 2));
    });
  addPublicationDestinationOptions(publications.command("status").description("Check the remembered version against the server.")
    .argument("<path>"), defaultProfileDirectory)
    .action(async (input: string, options: PublicationDestinationOptions) => {
      const context = await resolvePublicationContext(input, options);
      const record = await requiredRecord(context.directory, context.scope);
      if (record.receipt === null) {
        console.log(JSON.stringify({...describePublication(record), status: "pending"}, null, 2));
        return;
      }
      const current = await currentPublication(context.connection, context.scope.projectId, record.receipt.artifact.id);
      console.log(JSON.stringify({...describePublication(record),
        currentVersionId: current.version.id,
        status: record.pending !== null || record.unreported !== null ? "pending" : current.version.id === record.receipt.version.id ? "current" : "stale",
      }, null, 2));
    });
  addPublicationDestinationOptions(publications.command("import").description("Register a verified publish receipt without uploading.")
    .argument("<path>").requiredOption("--receipt <file>", "JSON response from a successful publish"), defaultProfileDirectory)
    .action(async (input: string, options: ImportOptions) => {
      const receipt = publicationReceiptSchema.parse(JSON.parse(await readFile(options.receipt, "utf8")));
      const context = await resolvePublicationContext(input, options);
      validatePublicationReceipt(receipt, context.scope);
      const unlock = await lockPublication(context.directory, context.scope);
      try {
        const saved = await readPublicationRecord(publicationRecordPath(context.directory, context.scope));
        if (saved !== null && (saved.pending !== null || saved.retiredLegacy !== null || saved.unreported !== null)) throw new Error("Reconcile the pending publication before importing a receipt.");
        if (saved?.receipt !== undefined && saved.receipt !== null && saved.receipt.artifact.id !== receipt.artifact.id) {
          throw new Error("This source is already bound to a different artifact. Use explicit publish target flags to rebind it.");
        }
        const current = await currentPublication(context.connection, context.scope.projectId, receipt.artifact.id);
        requireCurrentPublication(current, receipt.version.id);
        if (JSON.stringify(receipt.version) !== JSON.stringify(current.version) ||
          JSON.stringify(receipt.links) !== JSON.stringify(current.links)) {
          throw new Error("The receipt does not match the server's immutable version.");
        }
        const record: PublicationRecord = {schemaVersion: 1, scope: context.scope,
          preferences: saved?.preferences ?? {routing: receipt.version.routingMode},
          receipt, pending: null, retiredLegacy: null, unreported: null};
        await savePublicationRecord(context.directory, record);
        console.log(JSON.stringify({...describePublication(record), status: "imported"}, null, 2));
      } finally { await unlock(); }
    });
  addPublicationDestinationOptions(publications.command("refresh").description("Explicitly accept the bound artifact's current server version.")
    .argument("<path>"), defaultProfileDirectory)
    .action(async (input: string, options: PublicationDestinationOptions) => {
      const context = await resolvePublicationContext(input, options);
      const unlock = await lockPublication(context.directory, context.scope);
      try {
        const record = await requiredRecord(context.directory, context.scope);
        if (record.pending !== null || record.retiredLegacy !== null || record.unreported !== null) throw new Error("Reconcile the pending publication before refreshing its expected version.");
        if (record.receipt === null) throw new Error("There is no successful publication to refresh.");
        const receipt = await currentPublication(context.connection, context.scope.projectId, record.receipt.artifact.id);
        validatePublicationReceipt(receipt, context.scope);
        const updated = {...record, receipt};
        await savePublicationRecord(context.directory, updated);
        console.log(JSON.stringify({...describePublication(updated), status: "refreshed"}, null, 2));
      } finally { await unlock(); }
    });
}

function describePublication(record: PublicationRecord) {
  return {...record.scope, artifactId: record.receipt?.artifact.id ?? null,
    versionId: record.receipt?.version.id ?? null, pending: record.pending !== null || record.unreported !== null,
    links: record.receipt?.links ?? null};
}

async function requiredRecord(directory: string, scope: PublicationRecord["scope"]): Promise<PublicationRecord> {
  const record = await readPublicationRecord(publicationRecordPath(directory, scope));
  if (record === null) throw new Error("This source has no remembered publication. Import a receipt or publish it first.");
  return record;
}
