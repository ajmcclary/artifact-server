// deploy/cloudflare/tests/d1-invitations.test.ts
import {fileURLToPath} from "node:url";

import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {getPlatformProxy} from "wrangler";
import {z} from "zod";

import {systemAttribution} from "../../../src/core/action-attribution.js";
import {memberAdmissions} from "../../../src/core/identity-ports.js";
import {
  type InvitationFixture,
  invitationRepositoryCases,
  seedAdministrator,
} from "../../../tests/support/invitation-repository-cases.js";
import {createD1IdentityRepository} from "../src/d1-identity-repository.js";
import {migrateD1} from "../src/d1-migrations.js";

const openLocalD1 = () => getPlatformProxy<{ARTIFACT_SERVER_D1_DATABASE: D1Database}>({
  configPath: fileURLToPath(new URL("../wrangler.git-store.test.jsonc", import.meta.url)),
  envFiles: [],
  persist: false,
  remoteBindings: false,
});

const rowsSchema = z.array(z.object({action: z.string(), subjectId: z.string().nullable()}));

describe("D1 invitations", () => {
  let proxy: Awaited<ReturnType<typeof openLocalD1>>;
  let fixture: InvitationFixture;

  beforeEach(async () => {
    proxy = await openLocalD1();
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const installationId = "d1-invitations";
    await migrateD1(binding, installationId);
    fixture = {
      actions: async () => rowsSchema.parse((await binding.prepare(
        "SELECT action, subject_id AS subjectId FROM actions ORDER BY created_at, action",
      ).all()).results),
      installationId,
      openSecond: async () => ({close: () => undefined, store: createD1IdentityRepository(binding)}),
      store: createD1IdentityRepository(binding),
    };
    await seedAdministrator(fixture);
  });

  afterEach(async () => {
    await proxy.dispose();
  });

  it.for(invitationRepositoryCases)("$name", async ({run}) => {
    await expect(run(fixture)).resolves.toBeUndefined();
  });

  it("an existing schema-17 database gains invites without losing members or identities", async () => {
    const binding = proxy.env.ARTIFACT_SERVER_D1_DATABASE;
    const identity = createD1IdentityRepository(binding);
    await identity.admitMember({
      admittedHow: memberAdmissions.manual,
      attribution: systemAttribution,
      createdAt: "2026-10-06T09:30:00.000Z",
      displayName: "Rae Chen",
      email: "rae@acme.test",
      id: "member_rae",
      installationId: fixture.installationId,
      role: "member",
    });
    await identity.bindExternalIdentity({
      boundAt: "2026-10-06T09:30:00.000Z",
      email: "rae@acme.test",
      memberId: "member_rae",
      provider: "workos",
      subject: "subject-rae",
    });
    await binding.batch([
      "PRAGMA defer_foreign_keys = ON",
      "CREATE TABLE members_snapshot AS SELECT * FROM installation_members",
      "DROP TABLE installation_members",
      `CREATE TABLE installation_members (
        id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
        status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_active_at TEXT,
        admitted_by_principal_id TEXT,
        admission_method TEXT
          CHECK (admission_method IS NULL OR admission_method IN ('manual', 'automatic', 'owner')),
        UNIQUE (installation_id, email))`,
      "INSERT INTO installation_members SELECT * FROM members_snapshot",
      "DROP TABLE members_snapshot",
      "DROP TABLE installation_invites",
      "UPDATE artifact_server_schema SET version = 17 WHERE component = 'runtime'",
    ].map((statement) => binding.prepare(statement)));

    await migrateD1(binding, fixture.installationId);

    await expect(identity.findActiveMemberByExternalIdentity(fixture.installationId, "workos", "subject-rae"))
      .resolves.toMatchObject({id: "member_rae"});
    expect((await binding.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    const tableSql = await binding.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'installation_members'",
    ).first<{sql: string}>();
    expect(tableSql?.sql).toContain("'invite'");
  });
});
