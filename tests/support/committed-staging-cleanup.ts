import {createHash, randomBytes, randomUUID} from "node:crypto";
import {expect} from "vitest";
import {defaultProjectId} from "../../src/core/model.js";
import type {ArtifactRepository, StagedUploadRepository} from "../../src/core/ports.js";
import {createManifest} from "../../src/manifest/create-manifest.js";

/** Exercise real provider persistence; blob integrity is proved by the application suite. */
export async function committedCleanupRepositoryContract(repository: ArtifactRepository & StagedUploadRepository) {
  const createdAt="2026-09-21T00:00:00.000Z",expiresAt="2026-09-21T01:00:00.000Z",now="2026-09-21T01:05:00.000Z";
  const principalId="committed-cleanup-provider";
  const bytes=new TextEncoder().encode("committed cleanup provider proof");
  const manifest=createManifest({entryPath:"index.txt",routingMode:"static",files:[{path:"index.txt",mediaType:"text/plain",
    sha256:createHash("sha256").update(bytes).digest("hex"),size:bytes.length}]});
  const storageToken=randomBytes(18).toString("hex"),uploadId=`upl_${randomUUID()}`;
  await repository.createStagedUpload({id:uploadId,projectId:defaultProjectId,principalId,createdAt,expiresAt,
    manifest,idempotencyKey:null,files:manifest.entries.map(entry=>({entry,storageToken}))});
  await repository.markStagedFileUploaded(defaultProjectId,uploadId,principalId,storageToken,createdAt,createdAt);
  const preparation=await repository.claimUploadPreparation(uploadId,createdAt,expiresAt);
  if(preparation===null)throw new Error("Expected preparation claim");
  await repository.writePreparedManifestEntries(uploadId,preparation.attempts,manifest.entries);
  await repository.markUploadPrepared(uploadId,preparation.attempts,createdAt);
  const idempotencyKey="committed-cleanup-"+randomUUID();
  const published=await repository.commitNewArtifact({actor:{displayName:"Cleanup fixture",kind:"service"},
    accessSetting:"account_required",artifactId:`art_${randomUUID()}`,contentToken:randomBytes(18).toString("hex"),
    createdAt,idempotencyKey,inputDigest:manifest.digest,manifest,name:"Cleanup fixture",principalId,projectId:defaultProjectId,
    authorizedByPrincipalId:null,source:{kind:"staged_upload",principalId,projectId:defaultProjectId,uploadId},tags:[],versionId:`ver_${randomUUID()}`});
  const cleanup=repository.committedStagingCleanup;
  if(cleanup===undefined)throw new Error("Provider does not expose committed staging cleanup");
  expect(await cleanup.list(expiresAt,10)).toMatchObject([{id:uploadId,files:[{storageToken}]}]);
  expect(await cleanup.claim(uploadId,createdAt,now,expiresAt)).toBe(false);
  expect(await cleanup.claim(uploadId,expiresAt,now,expiresAt)).toBe(true);
  expect(await cleanup.claim(uploadId,expiresAt,now,expiresAt)).toBe(false);
  expect(await cleanup.complete(uploadId,now,now)).toBe(false);
  await cleanup.release(uploadId,now,expiresAt);
  expect(await cleanup.claim(uploadId,expiresAt,now,expiresAt)).toBe(true);
  await cleanup.markFileRemoved(uploadId,storageToken,now,now);
  expect(await cleanup.list(expiresAt,10)).toMatchObject([{id:uploadId,files:[]}]);
  expect(await cleanup.complete(uploadId,now,now)).toBe(true);
  expect(await cleanup.list(expiresAt,10)).toEqual([]);
  expect(await repository.findStagedUpload(defaultProjectId,uploadId,principalId)).toMatchObject({status:"committed",files:[{uploadedAt:createdAt}]});
  expect((await repository.findPublicationByIdempotencyKey(defaultProjectId,principalId,idempotencyKey))?.version.id).toBe(published.version.id);
  return uploadId;
}
