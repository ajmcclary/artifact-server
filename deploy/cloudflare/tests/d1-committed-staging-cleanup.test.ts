import {fileURLToPath} from "node:url";
import {expect, test} from "vitest";
import {getPlatformProxy} from "wrangler";
import {createD1ArtifactRepository} from "../src/d1-artifact-repository.js";
import {migrateD1} from "../src/d1-migrations.js";
import {committedCleanupRepositoryContract} from "../../../tests/support/committed-staging-cleanup.js";

test("foundation: local D1 committed staging cleanup preserves durable replay metadata",async()=>{
  const proxy=await getPlatformProxy<{ARTIFACT_SERVER_D1_DATABASE:D1Database}>({
    configPath:fileURLToPath(new URL("../wrangler.git-store.test.jsonc",import.meta.url)),envFiles:[],persist:false,remoteBindings:false});
  try {
    await migrateD1(proxy.env.ARTIFACT_SERVER_D1_DATABASE,"d1-committed-cleanup");
    await expect(committedCleanupRepositoryContract(createD1ArtifactRepository(proxy.env.ARTIFACT_SERVER_D1_DATABASE,"d1-committed-cleanup")))
      .resolves.toMatch(/^upl_[0-9a-f-]+$/u);
  } finally {await proxy.dispose();}
});
