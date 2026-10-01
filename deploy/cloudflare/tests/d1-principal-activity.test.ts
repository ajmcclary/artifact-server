import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";
import {getPlatformProxy} from "wrangler";

import {systemAttribution} from "../../../src/core/action-attribution.js";
import {memberAdmissions} from "../../../src/core/identity-ports.js";
import {createD1IdentityRepository} from "../src/d1-identity-repository.js";
import {migrateD1} from "../src/d1-migrations.js";

const openLocalD1 = () => getPlatformProxy<{
  ARTIFACT_SERVER_D1_DATABASE: D1Database;
}>({
  configPath: fileURLToPath(new URL("../wrangler.git-store.test.jsonc", import.meta.url)),
  envFiles: [],
  persist: false,
  remoteBindings: false,
});

const installationId = "d1-principal-activity-installation";

describe("D1 member admission and principal activity", () => {
  it("a listed member reports how and by whom it was admitted", async () => {
    const proxy = await openLocalD1();
    try {
      const database = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
      await migrateD1(database, installationId);
      const identity = createD1IdentityRepository(database);
      const owner = await identity.admitMember({
        admittedHow: memberAdmissions.owner,
        attribution: systemAttribution,
        createdAt: "2026-10-01T09:00:00.000Z",
        displayName: "Workspace owner",
        email: "owner@example.test",
        id: "member_owner",
        installationId,
        role: "administrator",
      });
      await identity.admitMember({
        admittedHow: memberAdmissions.manual,
        attribution: {actor: {displayName: owner.displayName, kind: "human"}, authorizedByPrincipalId: null, principalId: owner.id},
        createdAt: "2026-10-01T09:05:00.000Z",
        displayName: "Ada Lovelace",
        email: "ada@example.test",
        id: "member_ada",
        installationId,
        role: "member",
      });

      expect((await identity.listMembers(installationId)).map((member) => ({
        admittedHow: member.admittedHow,
        admittedByName: member.admittedByName,
        id: member.id,
      }))).toEqual([
        {admittedHow: "owner", admittedByName: null, id: "member_owner"},
        {admittedHow: "manual", admittedByName: "Workspace owner", id: "member_ada"},
      ]);
    } finally {
      await proxy.dispose();
    }
  });
});
