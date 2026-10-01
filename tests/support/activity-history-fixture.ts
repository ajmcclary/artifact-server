import {createHash} from "node:crypto";

import {expect} from "vitest";
import {z} from "zod";

import {principalCapabilities} from "../../src/core/identity.js";
import type {IdentityRepository} from "../../src/core/identity-ports.js";
import {type CommentAuthor, defaultProjectId} from "../../src/core/model.js";
import type {
  AgentDispatchRepository,
  ArtifactRepository,
  CommentRepository,
  ProjectRepository,
  StagedUploadRepository,
} from "../../src/core/ports.js";
import {createManifest} from "../../src/manifest/create-manifest.js";

/** Every recorded moment of the fixture history, oldest first. */
export const activityFixtureTimes = {
  projectCreated: "2026-09-01T09:00:00.000Z",
  danaAdmitted: "2026-09-01T10:00:00.000Z",
  rosaAdmitted: "2026-09-01T10:05:00.000Z",
  keyIssued: "2026-09-02T10:00:00.000Z",
  published: "2026-09-03T09:00:00.000Z",
  threadOpened: "2026-09-03T09:10:00.000Z",
  replied: "2026-09-03T09:20:00.000Z",
  resolved: "2026-09-03T09:30:00.000Z",
  secondThreadOpened: "2026-09-03T09:40:00.000Z",
  dispatched: "2026-09-03T09:50:00.000Z",
  tagged: "2026-09-03T09:55:00.000Z",
  madePublic: "2026-09-03T10:00:00.000Z",
  keyRevoked: "2026-09-04T10:00:00.000Z",
  projectArchived: "2026-09-05T09:00:00.000Z",
} as const;

const t = activityFixtureTimes;
const keyCapabilities = [principalCapabilities.readArtifacts, principalCapabilities.createArtifact];
const dana: CommentAuthor = {
  authorizedByPrincipalId: null,
  displayName: "Dana Okonkwo",
  principalId: "member_dana",
  principalKind: "human",
};
const rosa: CommentAuthor = {
  authorizedByPrincipalId: null,
  displayName: "Rosa Santoro",
  principalId: "member_rosa",
  principalKind: "human",
};

/** The repository slices the fixture needs; every backend's repositories satisfy them. */
export interface ActivityHistoryStores {
  readonly artifacts:
    & Pick<ArtifactRepository, "changeAccessSetting" | "changeTags" | "commitNewArtifact">
    & Pick<StagedUploadRepository,
      | "claimUploadPreparation"
      | "createStagedUpload"
      | "markStagedFileUploaded"
      | "markUploadPrepared"
      | "recordStagedFileInstalled"
      | "writePreparedManifestEntries">
    & Pick<CommentRepository, "createReply" | "createThread" | "updateThread">
    & Pick<AgentDispatchRepository, "createDispatch">
    & Pick<ProjectRepository, "createProject" | "setProjectArchive">;
  readonly identity: Pick<IdentityRepository, "admitMember" | "createApiKey" | "revokeApiKey">;
  readonly installationId: string;
}

export interface ActivityHistoryFixture {
  readonly artifactId: string;
  readonly dispatchId: string;
  readonly projectId: string;
  readonly replyId: string;
  readonly threads: {readonly dispatched: string; readonly resolved: string};
  readonly versionId: string;
}

/** Record one realistic history through the real repositories, in time order. */
export async function populateActivityHistory(
  stores: ActivityHistoryStores,
): Promise<ActivityHistoryFixture> {
  const {artifacts, identity, installationId} = stores;
  const projectId = "prj_activity_fixture";
  await artifacts.createProject({
    archivedAt: null,
    createdAt: t.projectCreated,
    id: projectId,
    installationId,
    name: "Claims workstation",
  });
  await identity.admitMember({
    createdAt: t.danaAdmitted,
    displayName: "Dana Okonkwo",
    email: "dana@example.test",
    id: "member_dana",
    installationId,
    role: "administrator",
  });
  await identity.admitMember({
    createdAt: t.rosaAdmitted,
    displayName: "Rosa Santoro",
    email: "rosa@example.test",
    id: "member_rosa",
    installationId,
    role: "member",
  });
  await identity.createApiKey({
    authorizedByPrincipalId: "member_dana",
    capabilities: keyCapabilities,
    createdAt: t.keyIssued,
    expiresAt: "2027-09-02T10:00:00.000Z",
    id: "key_ci",
    installationId,
    name: "CI publisher",
    prefix: "ask_ci_fixture",
    principalId: "service:key_ci",
    principalKind: "service",
    revokedAt: null,
    rotatedFromId: null,
    secretDigest: "digest-activity-fixture",
  });

  const bytes = new TextEncoder().encode("<!doctype html><title>Activity fixture</title>");
  const manifest = createManifest({
    entryPath: "index.html",
    files: [{
      mediaType: "text/html",
      path: "index.html",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    }],
    routingMode: "static",
  });
  const uploadId = "upl_activity_fixture";
  const storageToken = "tok_activity_fixture";
  await artifacts.createStagedUpload({
    createdAt: t.published,
    expiresAt: "2026-09-03T10:00:00.000Z",
    files: manifest.entries.map((entry) => ({entry, storageToken})),
    id: uploadId,
    idempotencyKey: "activity-fixture-upload",
    manifest,
    principalId: dana.principalId,
    projectId: defaultProjectId,
  });
  await artifacts.markStagedFileUploaded(defaultProjectId, uploadId, dana.principalId, storageToken, t.published);
  const claim = await artifacts.claimUploadPreparation(uploadId, t.published, "2026-09-03T09:10:00.000Z");
  if (claim === null) throw new Error("The activity fixture upload could not be claimed.");
  await artifacts.recordStagedFileInstalled(uploadId, storageToken, claim.attempts, t.published);
  await artifacts.writePreparedManifestEntries(uploadId, claim.attempts, manifest.entries);
  await artifacts.markUploadPrepared(uploadId, claim.attempts, t.published);
  const published = await artifacts.commitNewArtifact({
    actor: {displayName: dana.displayName, kind: dana.principalKind},
    accessSetting: "account_required",
    artifactId: "art_activity_fixture",
    authorizedByPrincipalId: null,
    contentToken: "content-activity-fixture",
    createdAt: t.published,
    idempotencyKey: "activity-fixture-publish",
    inputDigest: manifest.digest,
    manifest,
    name: "Inspector docking study",
    principalId: dana.principalId,
    projectId: defaultProjectId,
    source: {kind: "staged_upload", principalId: dana.principalId, projectId: defaultProjectId, uploadId},
    tags: [],
    versionId: "ver_activity_fixture_1",
  });
  const artifactId = published.artifact.id;
  const versionId = published.version.id;

  const resolved = await artifacts.createThread({
    anchor: null,
    artifactId,
    author: rosa,
    body: "The inspector overlaps the stage bar.",
    createdAt: t.threadOpened,
    id: "thr_activity_resolved",
    idempotencyKey: "activity-fixture-thread-1",
    installationId,
    path: null,
    projectId: defaultProjectId,
    versionId,
  });
  const reply = await artifacts.createReply({
    artifactId,
    author: dana,
    body: "Docked it to the right edge in v2.",
    createdAt: t.replied,
    id: "rep_activity_fixture",
    idempotencyKey: "activity-fixture-reply-1",
    projectId: defaultProjectId,
    threadId: resolved.thread.id,
  });
  await artifacts.updateThread({
    actor: {displayName: rosa.displayName, kind: rosa.principalKind},
    anchor: null,
    artifactId,
    authorizedByPrincipalId: null,
    body: null,
    principalId: rosa.principalId,
    projectId: defaultProjectId,
    state: {resolvedAt: t.resolved, resolvedBy: rosa, state: "resolved"},
    threadId: resolved.thread.id,
    updatedAt: t.resolved,
  });
  const dispatched = await artifacts.createThread({
    anchor: null,
    artifactId,
    author: rosa,
    body: "Can an agent tighten the spacing?",
    createdAt: t.secondThreadOpened,
    id: "thr_activity_dispatched",
    idempotencyKey: "activity-fixture-thread-2",
    installationId,
    path: null,
    projectId: defaultProjectId,
    versionId,
  });
  const dispatch = await artifacts.createDispatch({
    agentDisplayName: "Codex",
    agentId: "agent_codex",
    createdAt: t.dispatched,
    id: "dsp_activity_fixture",
    idempotencyKey: "activity-fixture-dispatch",
    installationId,
    note: null,
    projectId: defaultProjectId,
    sender: dana,
    threadIds: [dispatched.thread.id],
  });
  await artifacts.changeTags({
    actor: {displayName: dana.displayName, kind: dana.principalKind},
    artifactId,
    authorizedByPrincipalId: null,
    createdAt: t.tagged,
    expectedCurrentVersionId: versionId,
    idempotencyKey: "activity-fixture-tags",
    inputDigest: "activity-fixture-tags",
    principalId: dana.principalId,
    projectId: defaultProjectId,
    tags: ["claims"],
  });
  await artifacts.changeAccessSetting({
    actor: {displayName: dana.displayName, kind: dana.principalKind},
    accessSetting: "public_link",
    artifactId,
    authorizedByPrincipalId: null,
    createdAt: t.madePublic,
    expectedCurrentVersionId: versionId,
    idempotencyKey: "activity-fixture-public",
    inputDigest: "activity-fixture-public",
    principalId: dana.principalId,
    projectId: defaultProjectId,
  });
  await identity.revokeApiKey(installationId, "key_ci", t.keyRevoked);
  await artifacts.setProjectArchive({archivedAt: t.projectArchived, projectId});

  return {
    artifactId,
    dispatchId: dispatch.dispatch.id,
    projectId,
    replyId: reply.reply.id,
    threads: {dispatched: dispatched.thread.id, resolved: resolved.thread.id},
    versionId,
  };
}

/** One `actions` row read back with snake_case column names in any backend. */
export const recoveredRowSchema = z.object({
  access_from: z.string().nullable(),
  access_to: z.string().nullable(),
  action: z.string(),
  actor_kind: z.string().nullable(),
  actor_name: z.string().nullable(),
  artifact_id: z.string().nullable(),
  created_at: z.string(),
  detail_json: z.string().nullable(),
  id: z.string(),
  idempotency_key: z.string(),
  principal_id: z.string().nullable(),
  project_id: z.string().nullable(),
  reply_id: z.string().nullable(),
  subject_id: z.string().nullable(),
  thread_id: z.string().nullable(),
  version_id: z.string().nullable(),
});
export type RecoveredActionRow = z.infer<typeof recoveredRowSchema>;

/** The SELECT list every backend uses to read rows for `expectRecoveredActivity`. */
export const recoveredRowColumns = `id, project_id, artifact_id, version_id, action,
  principal_id, idempotency_key, created_at, thread_id, reply_id, subject_id,
  access_from, access_to, actor_name, actor_kind, detail_json`;

/** The recovered `detail_json` shapes (Task 2.1's table). */
const recoveredDetailSchema = z.object({
  agentDisplayName: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  name: z.string().optional(),
  threadIds: z.array(z.string()).optional(),
}).strict();
type RecoveredDetail = z.infer<typeof recoveredDetailSchema>;

function detailOf(row: RecoveredActionRow): RecoveredDetail | null {
  return row.detail_json === null ? null : recoveredDetailSchema.parse(JSON.parse(row.detail_json));
}

function only(rows: readonly RecoveredActionRow[], predicate: (row: RecoveredActionRow) => boolean, label: string): RecoveredActionRow {
  const matches = rows.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} row, found ${matches.length}.`);
  }
  const [row] = matches;
  if (row === undefined) throw new Error(`Missing ${label} row.`);
  return row;
}

/** Assert what a migrated backend recovered from the fixture history. */
export function expectRecoveredActivity(
  rows: readonly RecoveredActionRow[],
  fixture: ActivityHistoryFixture,
): void {
  const byId = (id: string) => only(rows, (row) => row.id === id, id);

  expect(only(rows, (row) => row.action === "comment_create" && row.thread_id === fixture.threads.resolved, "first thread"))
    .toMatchObject({actor_kind: "human", actor_name: "Rosa Santoro"});
  expect(only(rows, (row) => row.action === "comment_create" && row.thread_id === fixture.threads.dispatched, "second thread"))
    .toMatchObject({actor_name: "Rosa Santoro"});
  expect(only(rows, (row) => row.action === "comment_reply", "reply"))
    .toMatchObject({actor_name: "Dana Okonkwo", reply_id: fixture.replyId, thread_id: fixture.threads.resolved});
  expect(only(rows, (row) => row.action === "comment_resolve", "resolve"))
    .toMatchObject({actor_name: "Rosa Santoro", thread_id: fixture.threads.resolved});
  expect(only(rows, (row) => row.action === "publish", "publish"))
    .toMatchObject({actor_kind: "human", actor_name: "Dana Okonkwo"});

  const access = only(rows, (row) => row.action === "change_access", "access change");
  expect(access).toMatchObject({access_from: "account_required", access_to: "public_link", actor_name: "Dana Okonkwo"});
  expect(byId(`recovered:public_link_enable:${access.id}`)).toMatchObject({
    access_from: "account_required",
    access_to: "public_link",
    actor_name: "Dana Okonkwo",
    artifact_id: fixture.artifactId,
    created_at: activityFixtureTimes.madePublic,
    principal_id: "member_dana",
  });

  for (const [memberId, admittedAt] of [
    ["member_dana", activityFixtureTimes.danaAdmitted],
    ["member_rosa", activityFixtureTimes.rosaAdmitted],
  ] as const) {
    expect(byId(`recovered:member_admit:${memberId}`)).toMatchObject({
      actor_kind: null,
      actor_name: null,
      created_at: admittedAt,
      principal_id: null,
      project_id: null,
      subject_id: memberId,
    });
  }
  const issued = byId("recovered:key_issue:key_ci");
  expect(issued).toMatchObject({
    actor_kind: "human",
    actor_name: "Dana Okonkwo",
    created_at: activityFixtureTimes.keyIssued,
    principal_id: "member_dana",
    subject_id: "key_ci",
  });
  expect(detailOf(issued)).toEqual({capabilities: keyCapabilities});
  expect(byId("recovered:key_revoke:key_ci")).toMatchObject({
    actor_name: null,
    created_at: activityFixtureTimes.keyRevoked,
    principal_id: null,
  });

  const dispatch = byId(`recovered:dispatch_create:${fixture.dispatchId}`);
  expect(dispatch).toMatchObject({
    actor_kind: "human",
    actor_name: "Dana Okonkwo",
    artifact_id: null,
    created_at: activityFixtureTimes.dispatched,
    project_id: defaultProjectId,
    subject_id: fixture.dispatchId,
  });
  expect(detailOf(dispatch)).toEqual({agentDisplayName: "Codex", threadIds: [fixture.threads.dispatched]});

  const created = byId(`recovered:project_create:${fixture.projectId}`);
  expect(created).toMatchObject({created_at: activityFixtureTimes.projectCreated, project_id: fixture.projectId});
  expect(detailOf(created)).toEqual({name: "Claims workstation"});
  expect(byId(`recovered:project_archive:${fixture.projectId}`))
    .toMatchObject({created_at: activityFixtureTimes.projectArchived});
  expect(rows.some((row) => row.id === `recovered:project_create:${defaultProjectId}`)).toBe(false);

  // An actor is never half-known.
  expect(rows.filter((row) => (row.actor_name === null) !== (row.actor_kind === null))).toEqual([]);
}
