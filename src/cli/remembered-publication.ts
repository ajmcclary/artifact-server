import {createHash, randomBytes} from "node:crypto";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {Effect} from "effect";

import {prepareFilePublication, publishPreparedPath, type FilePublicationIntent, type FilePublicationFailure, type FilePublicationTarget, type PreparedFilePublication} from "../client/file-publication-client.js";
import {parseArtifactTags} from "../application/artifact-tags.js";
import {createManifest} from "../manifest/create-manifest.js";
import {publicationCliHttpClientLayer, resolveCliServerConnection} from "./cli-server-connection.js";
import {resolvePublicationContext, type PublicationContext} from "./publication-context.js";
import type {PublishOptions} from "./publication-options.js";
import {completeLegacyPublicationOperation, findLegacyPublicationOperation, hasLegacyPublicationOperations} from "./publication-operation-store.js";
import {publicationReceiptSchema, validatePublicationReceipt, type PublicationPreferences, type PublicationReceipt, type PublicationRecord, type PublicationScope} from "./publication-record.js";
import {currentPublication, requireCurrentPublication} from "./publication-remote.js";
import {lockPublication, publicationRecordPath, readPublicationRecord, savePublicationRecord, publicationSource, inspectPublicationLock} from "./publication-registry.js";

export interface RememberedPublicationResult extends PublicationReceipt {
  readonly unchanged: boolean;
}

export async function publishRemembered(
  inputPath: string,
  options: PublishOptions,
  report: (result: RememberedPublicationResult) => Promise<void>,
  expectation?: PublicationExpectation,
): Promise<RememberedPublicationResult> {
  validateTargetOptions(options);
  const context = await resolvePublicationContext(inputPath, options);
  const unlock = await lockPublication(context.directory, context.scope);
  try {
    if (expectation !== undefined) await requirePublicationExpectation(context, expectation);
    const result = await executeRemembered(inputPath, options, context);
    await report(result);
    const delivered = await readPublicationRecord(publicationRecordPath(context.directory, context.scope));
    if (delivered !== null && delivered.unreported !== null) {
      await savePublicationRecord(context.directory, {...delivered, unreported: null});
    }
    return result;
  } finally { await unlock(); }
}

async function executeRemembered(
  inputPath: string,
  options: PublishOptions,
  context: PublicationContext,
): Promise<RememberedPublicationResult> {
  const saved = await readPublicationRecord(publicationRecordPath(context.directory, context.scope));
  let record: PublicationRecord = saved ?? {
    schemaVersion: 1, scope: context.scope, preferences: {}, receipt: null, pending: null, retiredLegacy: null, unreported: null,
  };
  record = await finishLegacy(context, record);
  const selection = selectionSignature(options);
  if (record.unreported !== null) {
    if (record.unreported.selection !== selection || record.receipt === null) {
      throw new Error("A successful publication receipt still awaits delivery. Retry its original command before selecting a different intent.");
    }
    const prepared = await prepare(record.unreported.intent);
    if (prepared.operationDigest !== record.unreported.operationDigest) {
      throw new Error("The publication input changed before its successful receipt was delivered. Restore the original input and retry.");
    }
    return {...record.receipt, replayed: true, unchanged: false};
  }
  if (record.pending !== null) {
    if (record.pending.selection !== selection) throw new Error("The publication target or options changed while an earlier attempt is still pending. Retry its original command.");
    return await resumeRemembered(context, record, options);
  }
  const preferences = selectedPreferences(record.preferences, options);
  if ((record.receipt === null || options.artifact !== undefined || options.newArtifact) &&
    await hasLegacyPublicationOperations(context.profileData)) {
    // Legacy hashes retain their original lexical path and optional project.
    const legacyIntent = createIntent(path.resolve(inputPath), options, {});
    const legacyPrepared = await prepare(legacyIntent);
    const legacy = await findLegacyPublicationOperation(context.profileData, context.scope.origin,
      legacyPrepared.operationScopeDigest, legacyPrepared.operationDigest);
    if (legacy !== null) {
      record = {...record, preferences, pending: {
        intent: legacyIntent, selection, operationDigest: legacyPrepared.operationDigest,
        idempotencyKey: legacy.idempotencyKey,
        legacy: {operationScopeDigest: legacyPrepared.operationScopeDigest, operationDigest: legacyPrepared.operationDigest},
      }};
      await savePublicationRecord(context.directory, record);
      return await resumeRemembered(context, record, options);
    }
  }
  const intent = rememberedIntent(context, record, options, preferences);
  const prepared = await prepare(intent);
  if (intent.target.kind === "new_version") {
    const current = await currentPublication(context.connection, context.scope.projectId, intent.target.artifactId);
    requireCurrentPublication(current, intent.target.expectedCurrentVersionId);
    checkCreationOptions(current, options);
    if (createManifest(prepared.publication).digest === current.version.manifestDigest) {
      validatePublicationReceipt(current, context.scope);
      await savePublicationRecord(context.directory, {...record, preferences, receipt: current});
      return {...current, unchanged: true};
    }
  }
  record = {...record, preferences, pending: {
    intent, selection, operationDigest: prepared.operationDigest,
    idempotencyKey: randomBytes(24).toString("base64url"), legacy: null,
  }};
  await savePublicationRecord(context.directory, record);
  return await resumeRemembered(context, record, options, prepared);
}

function rememberedIntent(
  context: PublicationContext,
  record: PublicationRecord,
  options: PublishOptions,
  preferences: PublicationPreferences,
): FilePublicationIntent {
  const intent = createIntent(context.scope.sourcePath, options, preferences, context.scope.projectId);
  if (options.artifact !== undefined || options.newArtifact || record.receipt === null) return intent;
  return {...intent, target: {
    kind: "new_version", artifactId: record.receipt.artifact.id,
    expectedCurrentVersionId: record.receipt.version.id,
  }};
}

function createIntent(
  inputPath: string,
  options: PublishOptions,
  preferences: PublicationPreferences,
  projectId = options.project,
): FilePublicationIntent {
  let target: FilePublicationTarget;
  if (options.artifact !== undefined && options.expectedVersion !== undefined) {
    target = {kind: "new_version", artifactId: options.artifact, expectedCurrentVersionId: options.expectedVersion};
  } else {
    target = {kind: "new_artifact", accessSetting: options.public ? "public_link" : "account_required", tags: options.tag};
    if (options.name !== undefined) target = {...target, name: options.name};
  }
  let intent: FilePublicationIntent = {inputPath, target, routingMode: options.routing ?? preferences.routing ?? "static"};
  const entryPath = options.entry ?? preferences.entry;
  if (projectId !== undefined) intent = {...intent, projectId};
  if (entryPath !== undefined) intent = {...intent, entryPath};
  return intent;
}

function selectedPreferences(previous: PublicationPreferences, options: PublishOptions): PublicationPreferences {
  const entry = options.entry ?? previous.entry;
  const preferences = {routing: options.routing ?? previous.routing ?? "static"};
  return entry === undefined ? preferences : {...preferences, entry};
}

async function resumeRemembered(
  context: PublicationContext,
  record: PublicationRecord,
  options: PublishOptions,
  snapshot?: PreparedFilePublication,
): Promise<RememberedPublicationResult> {
  const pending = record.pending;
  if (pending === null) throw new Error("No publication is pending.");
  if (await publicationSource(pending.intent.inputPath) !== context.scope.sourcePath ||
    (pending.intent.projectId !== undefined && pending.intent.projectId !== context.scope.projectId)) {
    throw new Error("The pending publication does not match its source and project.");
  }
  const prepared = snapshot ?? await prepare(pending.intent);
  if (prepared.operationDigest !== pending.operationDigest) {
    throw new Error("The publication input changed while an earlier attempt is still pending. Restore the original input and retry.");
  }
  let connection = context.connection;
  const execute = () => Effect.runPromise(publishPreparedPath({apiToken: connection.apiToken, serverOrigin: connection.origin},
    pending.idempotencyKey, prepared).pipe(
    Effect.match({onFailure: (error) => ({success: false as const, error}), onSuccess: (result) => ({success: true as const, result})}),
    Effect.provide(publicationCliHttpClientLayer), Effect.provide(NodeFileSystem.layer),
  ));
  let outcome = await execute();
  if (!outcome.success && outcome.error._tag === "FilePublicationProtocolError" && outcome.error.status === 401 &&
    connection.profile?.authentication === "oauth") {
    connection = await resolveCliServerConnection(options, "publish", true);
    outcome = await execute();
  }
  if (!outcome.success) {
    if (outcome.error._tag === "FilePublicationProtocolError" && outcome.error.operation === "commit_upload" &&
      outcome.error.status === 409 && outcome.error.serverCode === "PUBLISH_CONFLICT") {
      // A definitive rejected commit may be settled; uncertain responses retain their identity.
      const rejected = {...record, pending: null, retiredLegacy: pending.legacy};
      await savePublicationRecord(context.directory, rejected);
      await finishLegacy(context, rejected);
    }
    throw publicationError(outcome.error);
  }
  const result = outcome.result;
  const receipt = publicationReceiptSchema.parse({...result, links: {
    artifact: result.links.artifact.toString(), review: result.links.review.toString(), version: result.links.version.toString(),
  }});
  validatePublicationReceipt(receipt, context.scope);
  if (receipt.version.manifestDigest !== createManifest(prepared.publication).digest ||
    (pending.intent.target.kind === "new_version" && receipt.artifact.id !== pending.intent.target.artifactId)) {
    throw new Error("The server returned a different publication snapshot. The pending operation was retained.");
  }
  const settled = {...record, receipt, pending: null, retiredLegacy: pending.legacy,
    unreported: {intent: pending.intent, selection: pending.selection, operationDigest: pending.operationDigest}};
  await savePublicationRecord(context.directory, settled);
  await finishLegacy(context, settled);
  return {...receipt, unchanged: false};
}

async function finishLegacy(context: PublicationContext, record: PublicationRecord): Promise<PublicationRecord> {
  if (record.retiredLegacy === null) return record;
  await completeLegacyPublicationOperation(context.profileData, context.scope.origin,
    record.retiredLegacy.operationScopeDigest, record.retiredLegacy.operationDigest);
  const settled = {...record, retiredLegacy: null};
  await savePublicationRecord(context.directory, settled);
  return settled;
}

function prepare(intent: FilePublicationIntent): Promise<PreparedFilePublication> {
  return Effect.runPromise(prepareFilePublication(intent).pipe(Effect.provide(NodeFileSystem.layer)));
}

function validateTargetOptions(options: PublishOptions): void {
  if ((options.artifact === undefined) !== (options.expectedVersion === undefined)) {
    throw new Error("Publishing a new version requires both --artifact and --expected-version.");
  }
  if (options.newArtifact && options.artifact !== undefined) {
    throw new Error("--new-artifact cannot be combined with --artifact or --expected-version.");
  }
}

function selectionSignature(options: PublishOptions): string {
  return JSON.stringify({artifact: options.artifact ?? null, expectedVersion: options.expectedVersion ?? null,
    newArtifact: options.newArtifact, name: options.name ?? null, public: options.public,
    tag: [...options.tag].toSorted(), entry: options.entry ?? null, routing: options.routing ?? null});
}

function checkCreationOptions(receipt: PublicationReceipt, options: PublishOptions): void {
  if ((options.name !== undefined && options.name.trim() !== receipt.artifact.name) ||
    (options.public && receipt.artifact.accessSetting !== "public_link") ||
    (options.tag.length > 0 && JSON.stringify(Effect.runSync(parseArtifactTags(options.tag))) !== JSON.stringify([...receipt.artifact.tags].toSorted()))) {
    throw new Error("Creation options conflict with the existing artifact. Use artifact management to change its name, visibility, or tags, or --new-artifact to create another artifact.");
  }
}

function publicationError(error: FilePublicationFailure): Error {
  if (error._tag === "FilePublicationProtocolError") {
    const code = error.serverCode ?? error._tag;
    return new Error(`${code}${error.status === null ? "" : ` (HTTP ${error.status})`}: ${error.message}`, {cause: error});
  }
  return new Error(`${error._tag}: ${error.message}`, {cause: error});
}


export interface PublicationExpectation {
  readonly directory: string;
  readonly scope: PublicationScope;
  readonly recordDigest: string | null;
  readonly legacy: {
    readonly operationScopeDigest: string;
    readonly operationDigest: string;
    readonly idempotencyKey: string | null;
  } | null;
}

export interface RememberedPublicationInspection {
  readonly status: "changed" | "unchanged" | "unregistered" | "conflicted" | "resumable";
  readonly message: string;
  readonly artifactId: string | null;
  readonly versionId: string | null;
  readonly expectation: PublicationExpectation;
}

/** Inspect exactly the intent the publisher would execute, without any state mutation. */
export async function inspectRememberedPublication(
  context: PublicationContext,
  options: PublishOptions,
): Promise<RememberedPublicationInspection> {
  await inspectPublicationLock(context.directory, context.scope);
  const record = await readPublicationRecord(publicationRecordPath(context.directory, context.scope));
  let expectation: PublicationExpectation = {directory: context.directory, scope: context.scope, recordDigest: recordDigest(record), legacy: null};
  const base = {artifactId: record?.receipt?.artifact.id ?? null, versionId: record?.receipt?.version.id ?? null};
  const recovery = record?.pending ?? record?.unreported;
  if (recovery !== null && recovery !== undefined) {
    if (recovery.selection !== selectionSignature(options) ||
      await publicationSource(recovery.intent.inputPath) !== context.scope.sourcePath ||
      (recovery.intent.projectId !== undefined && recovery.intent.projectId !== context.scope.projectId)) {
      throw new Error("Pending publication options differ. Reconcile the original single-path command first.");
    }
    const prepared = await prepare(recovery.intent);
    if (prepared.operationDigest !== recovery.operationDigest) {
      throw new Error("Pending publication input changed. Restore the original input and reconcile its command first.");
    }
    return {...base, expectation, status: "resumable", message: "The original operation or undelivered receipt can be recovered."};
  }
  if (record?.receipt === undefined || record.receipt === null) {
    const intent = createIntent(context.scope.sourcePath, options, {});
    const prepared = await prepare(intent);
    const legacy = await findLegacyPublicationOperation(context.profileData, context.scope.origin,
      prepared.operationScopeDigest, prepared.operationDigest);
    expectation = {...expectation, legacy: {
      operationScopeDigest: prepared.operationScopeDigest, operationDigest: prepared.operationDigest,
      idempotencyKey: legacy?.idempotencyKey ?? null,
    }};
    if (legacy !== null) return {...base, expectation, status: "resumable", message: "A matching legacy operation can be recovered."};
    return {...base, expectation, status: "unregistered", message: "Import an existing receipt or explicitly use --allow-create."};
  }
  const prepared = await prepare(rememberedIntent(context, record, options, selectedPreferences(record.preferences, options)));
  const current = await currentPublication(context.connection, context.scope.projectId, record.receipt.artifact.id);
  validatePublicationReceipt(current, context.scope);
  if (current.version.id !== record.receipt.version.id) {
    return {...base, expectation, status: "conflicted", message: `Expected ${record.receipt.version.id}; server is at ${current.version.id}. Inspect it and explicitly refresh the binding.`};
  }
  return {...base, expectation,
    status: createManifest(prepared.publication).digest === current.version.manifestDigest ? "unchanged" : "changed",
    message: "The remembered version matches the server.",
  };
}

function recordDigest(record: PublicationRecord | null): string | null {
  return record === null ? null : createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

async function requirePublicationExpectation(context: PublicationContext, expectation: PublicationExpectation): Promise<void> {
  if (context.directory !== expectation.directory || JSON.stringify(context.scope) !== JSON.stringify(expectation.scope)) {
    throw new Error("Publication destination or source changed after group preflight. Run preflight again.");
  }
  const record = await readPublicationRecord(publicationRecordPath(context.directory, context.scope));
  if (recordDigest(record) !== expectation.recordDigest) {
    throw new Error("The remembered binding changed after group preflight. Run preflight again.");
  }
  if (expectation.legacy !== null) {
    const current = await findLegacyPublicationOperation(context.profileData, context.scope.origin,
      expectation.legacy.operationScopeDigest, expectation.legacy.operationDigest);
    if ((current?.idempotencyKey ?? null) !== expectation.legacy.idempotencyKey) {
      throw new Error("The legacy publication changed after group preflight. Reconcile its original command.");
    }
  }
}
