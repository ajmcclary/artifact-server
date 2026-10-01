import {createHash} from "node:crypto";

import type {IdentityRepository} from "../../src/core/identity-ports.js";
import {defaultProjectId} from "../../src/core/model.js";
import type {ArtifactRepository, StagedUploadRepository} from "../../src/core/ports.js";
import {createManifest} from "../../src/manifest/create-manifest.js";

export interface ActivityHistoryStores {
  readonly artifacts: Pick<ArtifactRepository, "commitNewArtifact"> &
    Pick<StagedUploadRepository,
      | "claimUploadPreparation"
      | "createStagedUpload"
      | "markStagedFileUploaded"
      | "markUploadPrepared"
      | "recordStagedFileInstalled"
      | "writePreparedManifestEntries">;
  readonly identity: Pick<IdentityRepository, "admitMember">;
  readonly installationId: string;
}

export async function populateActivityHistory(stores: ActivityHistoryStores) {
  const at = "2026-09-03T09:00:00.000Z";
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
  await stores.artifacts.createStagedUpload({
    createdAt: at,
    expiresAt: "2026-09-03T10:00:00.000Z",
    files: manifest.entries.map((entry) => ({entry, storageToken})),
    id: uploadId,
    idempotencyKey: "activity-fixture-upload",
    manifest,
    principalId: "member_dana",
    projectId: defaultProjectId,
  });
  await stores.artifacts.markStagedFileUploaded(defaultProjectId, uploadId, "member_dana", storageToken, at);
  const claim = await stores.artifacts.claimUploadPreparation(uploadId, at, "2026-09-03T09:10:00.000Z");
  if (claim === null) throw new Error("The activity fixture upload could not be claimed.");
  await stores.artifacts.recordStagedFileInstalled(uploadId, storageToken, claim.attempts, at);
  await stores.artifacts.writePreparedManifestEntries(uploadId, claim.attempts, manifest.entries);
  await stores.artifacts.markUploadPrepared(uploadId, claim.attempts, at);
  const published = await stores.artifacts.commitNewArtifact({
    accessSetting: "account_required",
    artifactId: "art_activity_fixture",
    authorizedByPrincipalId: null,
    contentToken: "content-activity-fixture",
    createdAt: at,
    idempotencyKey: "activity-fixture-publish",
    inputDigest: manifest.digest,
    manifest,
    name: "Inspector docking study",
    principalId: "member_dana",
    projectId: defaultProjectId,
    source: {kind: "staged_upload", principalId: "member_dana", projectId: defaultProjectId, uploadId},
    tags: [],
    versionId: "ver_activity_fixture_1",
  });
  return {artifactId: published.artifact.id, versionId: published.version.id};
}
