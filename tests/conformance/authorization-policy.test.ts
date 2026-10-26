import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {DateTime, Effect, Layer, ManagedRuntime, Result} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {AuthorizationService, type ScopedDenial} from "../../src/application/authorization.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../../src/core/identity.js";
import {accessRepositoryEffects} from "../../src/local/create-local-application-layer.js";
import {SqliteAccessRepository} from "../../src/storage/sqlite-access-repository.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";

const projectScope = {projectId: "prj_default"} as const;
const artifactScope = {artifactId: "artifact-1", projectId: "prj_default"} as const;
const clock = {now: () => new Date("2026-08-13T00:00:00.000Z")};

describe("authorization policy", () => {
  let runtime: ManagedRuntime.ManagedRuntime<AuthorizationService, never>;
  let dataDirectory: string;
  let artifacts: SqliteArtifactRepository;
  let access: SqliteAccessRepository;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-authorization-policy-"));
    const databasePath = path.join(dataDirectory, "artifact-server.db");
    artifacts = new SqliteArtifactRepository(databasePath, "installation-a");
    access = new SqliteAccessRepository(databasePath, clock);
    runtime = ManagedRuntime.make(Layer.mergeAll(
      AuthorizationService.layer({
        access: accessRepositoryEffects(access),
        clock: {now: Effect.sync(() => DateTime.makeUnsafe(clock.now()))},
        installationId: "installation-a",
      }),
    ));
    await runtime.context();
  });

  afterEach(async () => {
    await runtime.dispose();
    access.close();
    artifacts.close();
    await rm(dataDirectory, {force: true, recursive: true});
  });

  test("AUTH-008-B AUTH-008-F: standalone mutations use membership and explicit capabilities", async () => {
    expect.hasAssertions();
    const member = humanPrincipal("member", membershipRoles.member);
    const administrator = humanPrincipal(
      "administrator",
      membershipRoles.administrator,
    );
    const scopedService = servicePrincipal(
      "publisher",
      [principalCapabilities.publishAnyArtifact],
    );
    const readerService = servicePrincipal(
      "reader",
      [principalCapabilities.readArtifacts],
    );
    const managerService = servicePrincipal(
      "manager",
      [principalCapabilities.manageAnyArtifact],
    );
    const unscopedService = servicePrincipal("reader", []);

    await expectAllowed((authorization) =>
      authorization.requireArtifactRead(member, artifactScope)
    );
    await expectAllowed((authorization) =>
      authorization.requireArtifactListing(member, projectScope)
    );
    await expectAllowed((authorization) =>
      authorization.requireArtifactRead(readerService, artifactScope)
    );
    await expectAllowed((authorization) =>
      authorization.requireArtifactManagement(member, artifactScope, "artifact.edit")
    );
    await expectAllowed((authorization) =>
      authorization.requireArtifactManagement(administrator, artifactScope, "artifact.edit")
    );
    await expectAllowed((authorization) =>
      authorization.requireArtifactManagement(managerService, artifactScope, "artifact.edit")
    );
    await expectAllowed((authorization) =>
      authorization.requireContentSession(member, artifactScope)
    );
    await expectAllowed((authorization) =>
      authorization.requireVersionPublication(member, artifactScope)
    );
    await expectAllowed((authorization) =>
      authorization.requireVersionPublication(administrator, artifactScope)
    );
    await expectAllowed((authorization) =>
      authorization.requireVersionPublication(scopedService, artifactScope)
    );
    await expectDenied((authorization) =>
      authorization.requireVersionPublication(unscopedService, artifactScope)
    );
    await expectDenied((authorization) =>
      authorization.requireArtifactRead(unscopedService, artifactScope)
    );
    await expectDenied((authorization) =>
      authorization.requireArtifactListing(unscopedService, projectScope).pipe(Effect.asVoid)
    );
  });

  test("foundation: another installation or an unscoped service cannot acquire authority", async () => {
    expect.hasAssertions();
    const foreignAdministrator: Principal = {
      ...humanPrincipal("foreign-admin", membershipRoles.administrator),
      installationId: "installation-b",
    };
    await expectDenied((authorization) =>
      authorization.requireContentSession(foreignAdministrator, artifactScope)
    );
    await expectDenied((authorization) =>
      authorization.requireArtifactCreation(servicePrincipal("unscoped", []), projectScope)
    );
  });

  test("project discovery follows membership and explicit service authority", async () => {
    expect.hasAssertions();
    const member = humanPrincipal("member", membershipRoles.member);
    const administrator = humanPrincipal(
      "administrator",
      membershipRoles.administrator,
    );
    const reader = servicePrincipal(
      "reader",
      [principalCapabilities.readArtifacts],
    );
    const projectManager = servicePrincipal(
      "project-manager",
      [principalCapabilities.manageProjects],
    );
    const unscoped = servicePrincipal("unscoped", []);
    const foreignAdministrator: Principal = {
      ...administrator,
      installationId: "installation-b",
    };

    await expectAllowed((authorization) =>
      authorization.requireProjectAccess(member, projectScope)
    );
    await expectAllowed((authorization) =>
      authorization.requireProjectAccess(reader, projectScope)
    );
    await expectAllowed((authorization) =>
      authorization.requireProjectAccess(projectManager, projectScope)
    );
    await expectAllowed((authorization) =>
      authorization.requireProjectManagement(administrator, projectScope)
    );
    await expectAllowed((authorization) =>
      authorization.requireProjectManagement(projectManager, projectScope)
    );
    await expectDenied((authorization) =>
      authorization.requireProjectManagement(member, projectScope)
    );
    await expectDenied((authorization) =>
      authorization.requireProjectAccess(unscoped, projectScope)
    );
    await expectDenied((authorization) =>
      authorization.requireProjectAccess(foreignAdministrator, projectScope)
    );
    await expectDenied((authorization) =>
      authorization.requireProjectManagement(foreignAdministrator, projectScope)
    );
  });

  async function expectAllowed(
    operation: (
      authorization: AuthorizationService["Service"],
    ) => Effect.Effect<void, ScopedDenial>,
  ): Promise<void> {
    const result = await runtime.runPromise(
      Effect.result(AuthorizationService.use(operation)),
    );
    expect(Result.isSuccess(result)).toBe(true);
  }

  async function expectDenied(
    operation: (
      authorization: AuthorizationService["Service"],
    ) => Effect.Effect<void, ScopedDenial>,
  ): Promise<void> {
    const result = await runtime.runPromise(
      Effect.result(AuthorizationService.use(operation)),
    );
    expect(Result.match(result, {
      onFailure: (failure) => failure._tag,
      onSuccess: () => "UnexpectedSuccess",
    })).toBe("AuthorizationDenied");
  }
});

function humanPrincipal(
  id: string,
  membershipRole: Principal["membershipRole"],
): Principal {
  return {
    authorizedByPrincipalId: null,
    capabilities: [],
    displayName: "Policy human",
    id,
    installationId: "installation-a",
    kind: principalKinds.human,
    membershipRole,
    projectIds: [],
  };
}

function servicePrincipal(
  id: string,
  capabilities: Principal["capabilities"],
): Principal {
  return {
    authorizedByPrincipalId: null,
    capabilities,
    displayName: "Policy service",
    id,
    installationId: "installation-a",
    kind: principalKinds.service,
    membershipRole: membershipRoles.member,
    projectIds: [],
  };
}
