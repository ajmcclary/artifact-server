// tests/support/candidate-repository-cases.ts
//
// One store contract for candidate versions (CND-001..CND-006), run against
// SQLite, Postgres and D1 so every backend keeps the same guarantees.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";

import type {
  StoredProjectGitHistorySetting,
  StoreProjectGitHistorySetting,
} from "../../src/application/project-git-history.js";
import type {
  ArtifactRepository,
  PublicationSource,
  StagedUploadRepository,
} from "../../src/core/ports.js";
import type {
  CandidateClosure,
  PublishedVersion,
  VersionRecord,
} from "../../src/core/model.js";
import type {GitHistoryMirrorStore} from "../../src/git-history/git-history-mirror.js";
import {createManifest} from "../../src/manifest/create-manifest.js";

/** The store surface the candidate cases drive. */
export type CandidateStore = ArtifactRepository & StagedUploadRepository & GitHistoryMirrorStore & {
  storeProjectGitHistorySetting(setting: StoreProjectGitHistorySetting): Promise<StoredProjectGitHistorySetting>;
};

/** One backend's candidate store plus the hooks the shared cases need. */
export interface CandidateFixture {
  /** Every queued or finished mirror job's version ID. */
  readonly mirrorJobVersionIds: () => Promise<readonly string[]>;
  readonly projectId: string;
  readonly store: CandidateStore;
}

const principalId = "principal-candidate-cases";
const actor = {displayName: "Casey Candidate", kind: "service"} as const;
const human = {displayName: "Robin Reviewer", kind: "human"} as const;
let clockTick = 0;

function nextInstant(): string {
  clockTick += 1;
  return new Date(Date.UTC(2026, 9, 8, 12, 0, 0) + clockTick * 1_000).toISOString();
}

function manifestFor(label: string) {
  const bytes = new TextEncoder().encode(`<!doctype html><title>${label}</title>`);
  return createManifest({
    entryPath: "index.html",
    files: [{
      mediaType: "text/html",
      path: "index.html",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    }],
    routingMode: "static",
  });
}

async function stageUpload(
  fixture: CandidateFixture,
  key: string,
  manifest: ReturnType<typeof manifestFor>,
  createdAt: string,
): Promise<PublicationSource> {
  const uploadId = `upl_${key}`;
  const files = manifest.entries.map((entry) => ({entry, storageToken: `tok_${key}_${entry.sha256.slice(0, 12)}`}));
  await fixture.store.createStagedUpload({
    createdAt,
    expiresAt: "2099-01-01T00:00:00.000Z",
    files,
    id: uploadId,
    idempotencyKey: null,
    manifest,
    principalId,
    projectId: fixture.projectId,
  });
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop -- one file per fixture upload
    await fixture.store.markStagedFileUploaded(fixture.projectId, uploadId, principalId, file.storageToken, createdAt);
  }
  const claim = await fixture.store.claimUploadPreparation(uploadId, createdAt, "2099-01-01T00:00:00.000Z");
  const attempts = claim?.attempts ?? 1;
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop -- one file per fixture upload
    await fixture.store.recordStagedFileInstalled(uploadId, file.storageToken, attempts, createdAt);
  }
  await fixture.store.writePreparedManifestEntries(uploadId, attempts, manifest.entries);
  await fixture.store.markUploadPrepared(uploadId, attempts, createdAt);
  return {kind: "staged_upload", principalId, projectId: fixture.projectId, uploadId};
}

/** Publish a new artifact through the store. */
export async function seedArtifact(fixture: CandidateFixture, key: string): Promise<PublishedVersion> {
  const manifest = manifestFor(key);
  const createdAt = nextInstant();
  const source = await stageUpload(fixture, key, manifest, createdAt);
  return fixture.store.commitNewArtifact({
    accessSetting: "account_required",
    actor,
    artifactId: `art_${key}`,
    authorizedByPrincipalId: null,
    contentToken: `content_${key}_with_enough_entropy`,
    createdAt,
    idempotencyKey: `publish-${key}`,
    inputDigest: `digest-${key}`,
    manifest,
    name: `Candidate case ${key}`,
    principalId,
    projectId: fixture.projectId,
    source,
    tags: [],
    versionId: `ver_${key}`,
  });
}

/** Commit a mainline version or a staged candidate on `expectedCurrentVersionId`. */
export async function commitOnto(
  fixture: CandidateFixture,
  artifactId: string,
  key: string,
  expectedCurrentVersionId: string,
  stage: boolean,
): Promise<PublishedVersion> {
  const manifest = manifestFor(key);
  const createdAt = nextInstant();
  const source = await stageUpload(fixture, key, manifest, createdAt);
  return fixture.store.commitVersion({
    actor,
    artifactId,
    authorizedByPrincipalId: null,
    contentToken: `content_${key}_with_enough_entropy`,
    createdAt,
    expectedCurrentVersionId,
    idempotencyKey: `publish-${key}`,
    inputDigest: `digest-${key}-${stage ? "stage" : "mainline"}`,
    manifest,
    principalId,
    projectId: fixture.projectId,
    source,
    stage,
    versionId: `ver_${key}`,
  });
}

function promote(fixture: CandidateFixture, artifactId: string, versionId: string, key: string) {
  return fixture.store.promoteCandidate({
    actor: human,
    artifactId,
    authorizedByPrincipalId: null,
    createdAt: nextInstant(),
    idempotencyKey: `promote-${key}`,
    inputDigest: `promote-digest-${key}-${versionId}`,
    principalId: "usr_reviewer",
    projectId: fixture.projectId,
    versionId,
  });
}

function close(
  fixture: CandidateFixture,
  artifactId: string,
  versionId: string,
  key: string,
  outcome: CandidateClosure,
) {
  return fixture.store.closeCandidate({
    actor: human,
    artifactId,
    authorizedByPrincipalId: null,
    createdAt: nextInstant(),
    idempotencyKey: `close-${key}`,
    inputDigest: `close-digest-${key}-${versionId}-${outcome}`,
    outcome,
    principalId: "usr_reviewer",
    projectId: fixture.projectId,
    versionId,
  });
}

async function current(fixture: CandidateFixture, artifactId: string): Promise<string> {
  const artifact = await fixture.store.findArtifact(fixture.projectId, artifactId);
  assert.ok(artifact !== null);
  return artifact.currentVersionId;
}

const ids = (versions: readonly VersionRecord[]) => versions.map((version) => version.id);

async function rejectsWith(promise: Promise<unknown>, tag: string): Promise<void> {
  await assert.rejects(promise, {_tag: tag});
}

async function enableGitHistory(fixture: CandidateFixture): Promise<void> {
  await fixture.store.storeProjectGitHistorySetting({
    enabled: true,
    limits: {
      fileCopyBytes: 1_048_576,
      logicalCopiedBytes: 0,
      logicalReservedBytes: 0,
      storageBudgetBytes: null,
      versionCopyBytes: 1_048_576,
    },
    projectId: fixture.projectId,
    updatedAt: nextInstant(),
    updatedByPrincipalId: "usr_reviewer",
  });
}

/** Claim the next mirror job and record a fake commit for it, as the worker would. */
async function mirrorNext(fixture: CandidateFixture): Promise<string | null> {
  const now = nextInstant();
  const job = await fixture.store.claimGitHistoryJob(now, "2099-01-01T00:00:00.000Z");
  if (job === null) return null;
  assert.ok(job.versionId !== null);
  await fixture.store.recordGitHistoryRepository(job, {
    artifactId: job.artifactId,
    defaultBranch: "main",
    projectId: job.projectId,
    provider: "cloudflare-artifacts",
    remoteUrl: `https://git.example.test/${job.artifactId}`,
    repositoryName: job.artifactId,
    status: "provisioned",
  }, now);
  await fixture.store.completeGitHistoryMirror(job, {
    artifactId: job.artifactId,
    commitId: `commit-${job.versionId}`,
    copiedBytes: 0,
    projectId: job.projectId,
    repositoryName: job.artifactId,
    versionId: job.versionId,
  }, now);
  return job.versionId;
}

/** Store cases every backend must pass. Each case names the requirement it supports. */
export const candidateRepositoryCases: readonly {
  readonly name: string;
  readonly run: (fixture: CandidateFixture) => Promise<void>;
}[] = [
  {
    name: "CND-001 store: a staged commit keeps current and takes the next number as a candidate",
    run: async (fixture) => {
      const first = await seedArtifact(fixture, "cnd1a");
      const artifactId = first.artifact.id;
      const staged = await commitOnto(fixture, artifactId, "cnd1b", first.version.id, true);
      assert.equal(staged.artifact.currentVersionId, first.version.id);
      assert.equal(staged.version.state, "candidate");
      assert.equal(staged.version.baseVersionId, first.version.id);
      assert.equal(staged.version.number, 2);
      assert.equal(await current(fixture, artifactId), first.version.id);
      const currentVersion = await fixture.store.findCurrentVersion(fixture.projectId, artifactId);
      assert.equal(currentVersion?.version.id, first.version.id);
      assert.equal(first.version.state, "mainline");
      assert.equal(first.version.baseVersionId, null);

      assert.deepEqual(ids(await fixture.store.listArtifactVersions(fixture.projectId, artifactId, "accepted")), [first.version.id]);
      assert.deepEqual(ids(await fixture.store.listArtifactVersions(fixture.projectId, artifactId, "candidates")), [staged.version.id]);
      assert.deepEqual(ids(await fixture.store.listArtifactVersions(fixture.projectId, artifactId, "all")), [staged.version.id, first.version.id]);
      const page = await fixture.store.listArtifactVersionsPage(fixture.projectId, artifactId, null, 10, "accepted");
      assert.deepEqual(ids(page.items), [first.version.id]);
      const listing = await fixture.store.listArtifacts({
        artifactIds: null, comments: "all", cursor: null, limit: 10,
        projectId: fixture.projectId, search: null, sort: "newest", tags: [],
      });
      assert.equal(listing.items.find((item) => item.id === artifactId)?.versionCount, 1);

      // The exact candidate stays readable by ID and by its content token.
      const exact = await fixture.store.findVersionRecord(fixture.projectId, artifactId, staged.version.id);
      assert.equal(exact?.version.state, "candidate");

      // A replayed staged commit returns the same candidate and still leaves current alone.
      const replay = await fixture.store.commitVersion({
        actor, artifactId, authorizedByPrincipalId: null,
        contentToken: "content_other_replay_token_value", createdAt: nextInstant(),
        expectedCurrentVersionId: first.version.id, idempotencyKey: "publish-cnd1b",
        inputDigest: "digest-cnd1b-stage", manifest: manifestFor("cnd1b"), principalId,
        projectId: fixture.projectId,
        source: {kind: "staged_upload", principalId, projectId: fixture.projectId, uploadId: "upl_cnd1b"},
        stage: true, versionId: "ver_cnd1b_retry",
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.version.id, staged.version.id);
      assert.equal(await current(fixture, artifactId), first.version.id);
    },
  },
  {
    name: "CND-001 store: a staged commit on a stale base is refused and creates nothing",
    run: async (fixture) => {
      const first = await seedArtifact(fixture, "cnd1s");
      const second = await commitOnto(fixture, first.artifact.id, "cnd1t", first.version.id, false);
      await rejectsWith(commitOnto(fixture, first.artifact.id, "cnd1u", first.version.id, true), "PublishConflict");
      assert.equal(await current(fixture, first.artifact.id), second.version.id);
      assert.equal(await fixture.store.findVersionRecord(fixture.projectId, first.artifact.id, "ver_cnd1u"), null);
    },
  },
  {
    name: "CND-002 store: promotion repoints current to the candidate's own ID and replays",
    run: async (fixture) => {
      const first = await seedArtifact(fixture, "cnd2a");
      const artifactId = first.artifact.id;
      const staged = await commitOnto(fixture, artifactId, "cnd2b", first.version.id, true);
      const promoted = await promote(fixture, artifactId, staged.version.id, "cnd2");
      assert.equal(promoted.replayed, false);
      assert.equal(promoted.artifact.currentVersionId, staged.version.id);
      assert.equal(promoted.version.id, staged.version.id);
      assert.equal(promoted.version.contentToken, staged.version.contentToken);
      assert.equal(promoted.version.manifestDigest, staged.version.manifestDigest);
      assert.equal(promoted.version.state, "promoted");
      assert.equal(await current(fixture, artifactId), staged.version.id);
      // No version was created: the same two versions, now both accepted.
      assert.deepEqual(ids(await fixture.store.listArtifactVersions(fixture.projectId, artifactId, "all")), [staged.version.id, first.version.id]);
      assert.deepEqual(ids(await fixture.store.listArtifactVersions(fixture.projectId, artifactId, "accepted")), [staged.version.id, first.version.id]);

      const replay = await promote(fixture, artifactId, staged.version.id, "cnd2");
      assert.equal(replay.replayed, true);
      assert.equal(replay.version.id, staged.version.id);
      const actions = await fixture.store.listArtifactActions({artifactId, cursor: null, limit: 10, projectId: fixture.projectId});
      assert.deepEqual(
        actions.items.map((action) => action.action).filter((action) => action.startsWith("candidate_")),
        ["candidate_promote", "candidate_stage"],
      );
      await rejectsWith(fixture.store.promoteCandidate({
        actor: human, artifactId, authorizedByPrincipalId: null, createdAt: nextInstant(),
        idempotencyKey: "promote-cnd2", inputDigest: "a-different-input", principalId: "usr_reviewer",
        projectId: fixture.projectId, versionId: staged.version.id,
      }), "IdempotencyConflict");
    },
  },
  {
    name: "CND-003 store: promotion is refused when current moved past the base",
    run: async (fixture) => {
      const first = await seedArtifact(fixture, "cnd3a");
      const artifactId = first.artifact.id;
      const staged = await commitOnto(fixture, artifactId, "cnd3b", first.version.id, true);
      const sibling = await commitOnto(fixture, artifactId, "cnd3c", first.version.id, true);
      const newer = await commitOnto(fixture, artifactId, "cnd3d", first.version.id, false);
      await rejectsWith(promote(fixture, artifactId, staged.version.id, "cnd3"), "CandidateStale");
      assert.equal(await current(fixture, artifactId), newer.version.id);
      const stale = await fixture.store.findVersionRecord(fixture.projectId, artifactId, staged.version.id);
      assert.equal(stale?.version.state, "candidate");

      // Restoring back to the base does not let a late candidate jump the newer accepted state
      // by accident: the base check is exact, so the candidate is promotable again only then.
      await fixture.store.restoreVersion({
        actor: human, artifactId, authorizedByPrincipalId: null, createdAt: nextInstant(),
        expectedCurrentVersionId: newer.version.id, idempotencyKey: "restore-cnd3",
        inputDigest: "restore-cnd3", principalId: "usr_reviewer", projectId: fixture.projectId,
        versionId: first.version.id,
      });
      const promoted = await promote(fixture, artifactId, sibling.version.id, "cnd3-sibling");
      assert.equal(promoted.artifact.currentVersionId, sibling.version.id);
      // Promoting one candidate makes the other candidate on the same base stale, not rejected.
      await rejectsWith(promote(fixture, artifactId, staged.version.id, "cnd3-late"), "CandidateStale");
      const remaining = await fixture.store.findVersionRecord(fixture.projectId, artifactId, staged.version.id);
      assert.equal(remaining?.version.state, "candidate");
    },
  },
  {
    name: "CND-005 store: reject and supersede are terminal, keep bytes, and restore never targets a candidate",
    run: async (fixture) => {
      const first = await seedArtifact(fixture, "cnd5a");
      const artifactId = first.artifact.id;
      const rejected = await commitOnto(fixture, artifactId, "cnd5b", first.version.id, true);
      const superseded = await commitOnto(fixture, artifactId, "cnd5c", first.version.id, true);
      const open = await commitOnto(fixture, artifactId, "cnd5d", first.version.id, true);

      await rejectsWith(fixture.store.restoreVersion({
        actor: human, artifactId, authorizedByPrincipalId: null, createdAt: nextInstant(),
        expectedCurrentVersionId: first.version.id, idempotencyKey: "restore-cnd5-open",
        inputDigest: "restore-cnd5-open", principalId: "usr_reviewer", projectId: fixture.projectId,
        versionId: open.version.id,
      }), "VersionNotRestorable");

      const closed = await close(fixture, artifactId, rejected.version.id, "cnd5-reject", "rejected");
      assert.equal(closed.version.state, "rejected");
      assert.equal(closed.artifact.currentVersionId, first.version.id);
      const replay = await close(fixture, artifactId, rejected.version.id, "cnd5-reject", "rejected");
      assert.equal(replay.replayed, true);
      assert.equal(replay.version.state, "rejected");
      const supersededState = await close(fixture, artifactId, superseded.version.id, "cnd5-supersede", "superseded");
      assert.equal(supersededState.version.state, "superseded");

      await rejectsWith(promote(fixture, artifactId, rejected.version.id, "cnd5-promote-rejected"), "CandidateNotOpen");
      await rejectsWith(promote(fixture, artifactId, superseded.version.id, "cnd5-promote-superseded"), "CandidateNotOpen");
      await rejectsWith(close(fixture, artifactId, rejected.version.id, "cnd5-reclose", "superseded"), "CandidateNotOpen");
      await rejectsWith(close(fixture, artifactId, first.version.id, "cnd5-close-mainline", "rejected"), "CandidateNotOpen");
      await rejectsWith(promote(fixture, artifactId, first.version.id, "cnd5-promote-mainline"), "CandidateNotOpen");
      await rejectsWith(fixture.store.restoreVersion({
        actor: human, artifactId, authorizedByPrincipalId: null, createdAt: nextInstant(),
        expectedCurrentVersionId: first.version.id, idempotencyKey: "restore-cnd5-rejected",
        inputDigest: "restore-cnd5-rejected", principalId: "usr_reviewer", projectId: fixture.projectId,
        versionId: rejected.version.id,
      }), "VersionNotRestorable");

      // Bytes and identity are kept; closed candidates are hidden from the default and open lists.
      const kept = await fixture.store.findVersionRecord(fixture.projectId, artifactId, rejected.version.id);
      assert.equal(kept?.version.manifestDigest, rejected.version.manifestDigest);
      assert.equal(kept?.version.contentToken, rejected.version.contentToken);
      assert.deepEqual(ids(await fixture.store.listArtifactVersions(fixture.projectId, artifactId, "accepted")), [first.version.id]);
      assert.deepEqual(ids(await fixture.store.listArtifactVersions(fixture.projectId, artifactId, "candidates")), [open.version.id]);
      assert.deepEqual(
        ids(await fixture.store.listArtifactVersions(fixture.projectId, artifactId, "all")),
        [open.version.id, superseded.version.id, rejected.version.id, first.version.id],
      );
      assert.equal(await current(fixture, artifactId), first.version.id);
    },
  },
  {
    name: "CND-006 store: candidates are never queued for Git and a promotion's parent skips rejected numbers",
    run: async (fixture) => {
      await enableGitHistory(fixture);
      const first = await seedArtifact(fixture, "cnd6a");
      const artifactId = first.artifact.id;
      assert.equal(await mirrorNext(fixture), first.version.id);
      const rejected = await commitOnto(fixture, artifactId, "cnd6b", first.version.id, true);
      const staged = await commitOnto(fixture, artifactId, "cnd6c", first.version.id, true);
      // Neither a staged commit nor the enablement backfill queues a candidate.
      assert.equal(await mirrorNext(fixture), null);
      await close(fixture, artifactId, rejected.version.id, "cnd6-reject", "rejected");
      assert.equal(await mirrorNext(fixture), null);
      assert.ok(!(await fixture.mirrorJobVersionIds()).includes(staged.version.id));

      await promote(fixture, artifactId, staged.version.id, "cnd6");
      assert.ok((await fixture.mirrorJobVersionIds()).includes(staged.version.id));
      // The promoted version (number 3) takes the mainline version 1 as its parent.
      const parent = await fixture.store.findGitHistoryPredecessorMapping(fixture.projectId, artifactId, staged.version.number);
      assert.equal(parent?.versionId, first.version.id);
      assert.equal(await mirrorNext(fixture), staged.version.id);
      assert.equal(await mirrorNext(fixture), null);
      assert.ok(!(await fixture.mirrorJobVersionIds()).includes(rejected.version.id));

      // A mainline publish after the promotion takes the promoted version as its parent.
      const next = await commitOnto(fixture, artifactId, "cnd6d", staged.version.id, false);
      const nextParent = await fixture.store.findGitHistoryPredecessorMapping(fixture.projectId, artifactId, next.version.number);
      assert.equal(nextParent?.versionId, staged.version.id);
    },
  },
  {
    name: "CND-003 store: current can never be written to an unaccepted version",
    run: async (fixture) => {
      const first = await seedArtifact(fixture, "cnd3x");
      const staged = await commitOnto(fixture, first.artifact.id, "cnd3y", first.version.id, true);
      await rejectsWith(fixture.store.restoreVersion({
        actor: human, artifactId: first.artifact.id, authorizedByPrincipalId: null, createdAt: nextInstant(),
        expectedCurrentVersionId: first.version.id, idempotencyKey: "restore-cnd3y",
        inputDigest: "restore-cnd3y", principalId: "usr_reviewer", projectId: fixture.projectId,
        versionId: staged.version.id,
      }), "VersionNotRestorable");
      assert.equal(await current(fixture, first.artifact.id), first.version.id);
    },
  },
];
