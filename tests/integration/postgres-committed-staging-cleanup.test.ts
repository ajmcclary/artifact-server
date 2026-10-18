import {randomUUID} from "node:crypto";
import {Redacted} from "effect";
import {expect,test} from "vitest";
import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";
import {committedCleanupRepositoryContract} from "../support/committed-staging-cleanup.js";

test("foundation: Postgres committed staging progress preserves receipts and refuses another installation",async()=>{
  const url=process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  if(url===undefined)throw new Error("Run through verify:external-storage-runtime");
  const database=await PostgresDatabase.open({url:Redacted.make(url)},"apply");
  try {
    const repository=await PostgresArtifactRepository.open(database,"committed-cleanup-"+randomUUID());
    const uploadId=await committedCleanupRepositoryContract(repository);
    const foreign=await PostgresArtifactRepository.open(database,"foreign-cleanup-"+randomUUID());
    expect(await foreign.committedStagingCleanup.list("2026-09-22T00:00:00.000Z",10)).toEqual([]);
    expect(await foreign.committedStagingCleanup.claim(uploadId,"2026-09-22T00:00:00.000Z","2026-09-22T00:05:00.000Z","2026-09-22T00:00:00.000Z")).toBe(false);
  } finally {await database.close();}
});
