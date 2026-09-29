import path from "node:path";

import {inspectPublicationContext, resolveGroupPublicationDestination, type GroupPublicationDestination} from "./publication-context.js";
import {groupSource, pathContains, readPublicationGroups, selectPublicationGroup, type PublicationGroupsConfig} from "./publication-groups-config.js";
import {groupSummary, type GroupMemberResult, type GroupPreflightMember, type GroupProgress, type GroupRunResult} from "./publication-group-model.js";
import {createPublicationRunStore, PublicationRunStoreError, type PublicationRunStore} from "./publication-group-report.js";
import type {PublicationDestinationOptions, PublishOptions} from "./publication-options.js";
import {inspectRememberedPublication, publishRemembered, type PublicationExpectation} from "./remembered-publication.js";

export interface PublicationGroupOptions extends PublicationDestinationOptions {
  readonly group: string;
  readonly config?: string;
  readonly dryRun: boolean;
  readonly allowCreate: boolean;
  readonly failFast: boolean;
}
interface PreparedMember {
  readonly target: string;
  readonly source: string;
  readonly expectation: PublicationExpectation;
}
interface PreparedGroup {
  readonly config: PublicationGroupsConfig;
  readonly options: PublishOptions;
  readonly result: GroupRunResult;
  readonly members: readonly PreparedMember[];
}

export async function runPublicationGroup(
  options: PublicationGroupOptions,
  progress: (event: GroupProgress) => Promise<void>,
): Promise<GroupRunResult> {
  let prepared: PreparedGroup;
  try { prepared = await preflightGroup(options); } catch (error) {
    return {...emptyResult(options), error: (error instanceof Error ? error.message : "Publication group operation failed.")};
  }
  if (prepared.result.status === "blocked" || options.dryRun) return prepared.result;
  return executeGroup(prepared, options, progress);
}

async function preflightGroup(options: PublicationGroupOptions): Promise<PreparedGroup> {
  const config = await readPublicationGroups(options.config);
  const group = selectPublicationGroup(config, options.group);
  let publishOptions = effectiveOptions(options, config);
  const inspectable = new Set<string>();
  const rows: GroupPreflightMember[] = await Promise.all(group.targets.map(async (target) => {
    try {
      const source = await groupSource(config, target);
      inspectable.add(target);
      return {target, source, status: "blocked" as const, allowed: false, message: "Awaiting destination inspection.", artifactId: null, versionId: null};
    } catch (error) { return blockedMember(target, null, (error instanceof Error ? error.message : "Publication group operation failed.")); }
  }));
  const seen = new Map<string, number>();
  for (const [index, row] of rows.entries()) {
    if (row.source === null) continue;
    const previous = seen.get(row.source);
    if (previous !== undefined) {
      const prior = rows[previous];
      const message = `Targets ${prior?.target ?? "unknown"} and ${row.target} resolve to the same source.`;
      inspectable.delete(row.target);
      if (prior !== undefined) inspectable.delete(prior.target);
      rows[index] = blockedMember(row.target, row.source, message);
      if (prior !== undefined) rows[previous] = blockedMember(prior.target, prior.source, message);
    } else seen.set(row.source, index);
  }
  let destination: GroupPublicationDestination;
  try { destination = await resolveGroupPublicationDestination(publishOptions); } catch (error) {
    const message = (error instanceof Error ? error.message : "Publication group operation failed.");
    return {config, options: publishOptions, members: [], result: {...emptyResult(options), config: config.file, error: message,
      preflight: rows.map((row) => inspectable.has(row.target) ? blockedMember(row.target, row.source, message) : row)}};
  }
  publishOptions = {...publishOptions, project: destination.projectId};
  const members: PreparedMember[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.source === null || !inspectable.has(row.target)) continue;
    try {
      // eslint-disable-next-line no-await-in-loop -- inspect members in configured order without parallel authentication/state access
      const context = await inspectPublicationContext(row.source, publishOptions, destination);
      if (pathContains(path.dirname(context.directory), row.source)) throw new Error("Target is inside private CLI state and cannot be published by a group.");
      // eslint-disable-next-line no-await-in-loop -- bounded sequential hashing and remote version inspection
      const inspected = await inspectRememberedPublication(context, publishOptions);
      const allowed = inspected.status !== "conflicted" && (inspected.status !== "unregistered" || options.allowCreate);
      rows[index] = {target: row.target, source: row.source, status: inspected.status, allowed,
        message: inspected.status === "unregistered" && options.allowCreate ? "Explicitly allowed to create a private artifact." : inspected.message,
        artifactId: inspected.artifactId, versionId: inspected.versionId};
      members.push({target: row.target, source: row.source, expectation: inspected.expectation});
    } catch (error) { rows[index] = blockedMember(row.target, row.source, (error instanceof Error ? error.message : "Publication group operation failed.")); }
  }
  const result: GroupRunResult = {...emptyResult(options), config: config.file,
    status: rows.every((row) => row.allowed) ? "ready" : "blocked", preflight: rows,
    destination: {profile: destination.connection.profile?.name ?? null, origin: destination.connection.origin,
      installationId: destination.installationId, principalId: destination.principalId, projectId: destination.projectId}};
  return {config, options: publishOptions, members, result};
}

async function executeGroup(
  prepared: PreparedGroup,
  options: PublicationGroupOptions,
  progress: (event: GroupProgress) => Promise<void>,
): Promise<GroupRunResult> {
  let result: GroupRunResult = {...prepared.result, status: "running", results: prepared.members.map((member) => ({
    target: member.target, source: member.source, status: "skipped", receipt: null, error: "Not started.",
  }))};
  let store: PublicationRunStore;
  try {
    store = await createPublicationRunStore(options.profileData);
    result = {...result, runId: store.id, reportPath: store.file, summary: groupSummary(result.results)};
    await store.write(result);
  } catch (error) { return {...result, status: "failed", error: (error instanceof Error ? error.message : "Publication group operation failed."), summary: groupSummary(result.results)}; }
  for (const [index, member] of prepared.members.entries()) {
    try {
      result = replaceMember(result, index, {...memberResult(member), status: "running"});
      // eslint-disable-next-line no-await-in-loop -- persist the start before this member can mutate the server
      await store.write(result);
      // eslint-disable-next-line no-await-in-loop -- progress follows durable run state
      await progress({target: member.target, status: "running", message: "Publishing", reportPath: store.file});
      // eslint-disable-next-line no-await-in-loop -- revalidate containment before each independent publication
      const currentSource = await groupSource(prepared.config, member.target);
      if (currentSource !== member.source) throw new Error("Source location changed after preflight.");
      // eslint-disable-next-line no-await-in-loop -- publication groups intentionally execute sequentially
      await publishRemembered(member.source, prepared.options, async (receipt) => {
        const status = receipt.unchanged ? "unchanged" : receipt.replayed ? "recovered" : "published";
        result = replaceMember(result, index, {...memberResult(member), status, receipt});
        // The publisher acknowledges delivery only after the run report is durable.
        await store.write(result);
        await progress({target: member.target, status, message: `${status} v${receipt.version.number}`, reportPath: store.file});
      }, member.expectation);
    } catch (error) {
      const existing = result.results[index];
      result = replaceMember(result, index, {...memberResult(member), receipt: existing?.receipt ?? null, status: "failed", error: (error instanceof Error ? error.message : "Publication group operation failed.")});
      try {
        // eslint-disable-next-line no-await-in-loop -- failed rows must also be durable before proceeding
        await store.write(result);
      } catch (storageError) {
        result = {...result, error: (storageError instanceof Error ? storageError.message : "Cannot persist the group report.")};
        break;
      }
      if (error instanceof PublicationRunStoreError) { result = {...result, error: error.message}; break; }
      // eslint-disable-next-line no-await-in-loop -- report a member failure before starting the next one
      await progress({target: member.target, status: "failed", message: (error instanceof Error ? error.message : "Publication group operation failed."), reportPath: store.file});
      if (options.failFast) break;
    }
  }
  result = {...result, status: result.results.some((row) => row.status === "failed") || result.error !== null ? "failed" : "completed", summary: groupSummary(result.results)};
  try { await store.write(result); } catch (error) { result = {...result, status: "failed", error: (error instanceof Error ? error.message : "Publication group operation failed.")}; }
  return result;
}

function effectiveOptions(options: PublicationGroupOptions, config: PublicationGroupsConfig): PublishOptions {
  const group = selectPublicationGroup(config, options.group);
  let resolved: PublishOptions = {data: options.data, profileData: options.profileData, public: false, newArtifact: false, tag: []};
  const profile = options.profile ?? group.profile ?? config.definition.defaults.profile;
  const project = options.project ?? group.project ?? config.definition.defaults.project;
  if (profile !== undefined) resolved = {...resolved, profile};
  if (project !== undefined) resolved = {...resolved, project};
  if (options.server !== undefined) resolved = {...resolved, server: options.server};
  if (options.tokenFile !== undefined) resolved = {...resolved, tokenFile: options.tokenFile};
  return resolved;
}

function emptyResult(options: PublicationGroupOptions): GroupRunResult {
  return {schemaVersion: 1, group: options.group, config: null, mode: options.dryRun ? "dry-run" : "publish",
    status: "blocked", destination: null, preflight: [], results: [], summary: groupSummary([]), runId: null, reportPath: null, error: null};
}
function blockedMember(target: string, source: string | null, message: string): GroupPreflightMember {
  return {target, source, status: "blocked", allowed: false, message, artifactId: null, versionId: null};
}
function memberResult(member: PreparedMember): GroupMemberResult {
  return {target: member.target, source: member.source, status: "skipped", receipt: null, error: null};
}
function replaceMember(result: GroupRunResult, index: number, member: GroupMemberResult): GroupRunResult {
  const results = result.results.map((row, position) => position === index ? member : row);
  return {...result, results, summary: groupSummary(results)};
}
