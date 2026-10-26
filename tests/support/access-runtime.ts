import {createHash, randomUUID} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {ManagedRuntime, Redacted} from "effect";

import {InstallationAccessService} from "../../src/application/installation-access.js";
import {ProjectManagementService} from "../../src/application/project-management.js";
import {type CommitStagedUploadTarget, StagedUploadService} from "../../src/application/staged-upload.js";
import type {AccessGrantDraft} from "../../src/core/access-ports.js";
import {attributionOf} from "../../src/core/action-attribution.js";
import type {MembershipRole, Principal} from "../../src/core/identity.js";
import type {ProjectAccessMode, ProjectRole} from "../../src/core/permissions.js";
import {SystemIdGenerator} from "../../src/core/system.js";
import {createLocalApplicationLayer} from "../../src/local/create-local-application-layer.js";
import {LocalBlobStore} from "../../src/storage/local-blob-store.js";
import {LocalStagingStore} from "../../src/storage/local-staging-store.js";
import {SqliteAccessRepository} from "../../src/storage/sqlite-access-repository.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";
import {MutableClock} from "./agent-dispatch.js";
import {LoopbackIdentityProvider} from "./loopback-identity-provider.js";

const installationId = "access-runtime";
const administratorEmail = "jordan@acme.test";

/** The real application composition over a temporary SQLite installation, with access helpers. */
export async function startAccessRuntime() {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-access-runtime-"));
  const databasePath = path.join(dataDirectory, "artifact-server.db");
  const repository = new SqliteArtifactRepository(databasePath, installationId);
  const identityRepository = new SqliteIdentityRepository(databasePath);
  const clock = new MutableClock("2026-10-26T10:00:00.000Z");
  const access = new SqliteAccessRepository(databasePath, clock);
  const runtime = ManagedRuntime.make(createLocalApplicationLayer({
    access,
    apiToken: Redacted.make("access-runtime-test-token"),
    blobs: new LocalBlobStore(path.join(dataDirectory, "blobs")),
    bootstrapAdministratorEmail: administratorEmail,
    clock,
    dispatches: repository,
    externalApiBearerVerifier: null,
    externalMcpBearerVerifier: null,
    externalMcpOAuthVerifier: null,
    ids: new SystemIdGenerator(),
    identityRepository,
    installationId,
    interactiveIdentityProvider: new LoopbackIdentityProvider(),
    localBootstrapCredential: null,
    protectBootstrapAdministrator: false,
    repository,
    staging: new LocalStagingStore(path.join(dataDirectory, "staging")),
  }));

  const signInAs = async (email: string, displayName: string): Promise<Principal> => {
    const issued = await runtime.runPromise(InstallationAccessService.use((service) =>
      service.completeExternalIdentity({
        displayName,
        email,
        emailVerificationAsserted: true,
        emailVerified: true,
        provider: "workos",
        subject: `subject-${email}`,
      }, null)));
    const authenticated = await runtime.runPromise(InstallationAccessService.use((service) =>
      service.authenticateSession(Redacted.make(issued.token))));
    return authenticated.principal;
  };

  const administrator = await signInAs(administratorEmail, "Jordan Lee");

  /** Admit and sign in one person with the given installation role. */
  const person = async (name: string, role: MembershipRole = "member"): Promise<Principal> => {
    const email = `${name.toLowerCase()}@acme.test`;
    await runtime.runPromise(InstallationAccessService.use((service) =>
      service.admitMember({displayName: name, email, principal: administrator, role})));
    return signInAs(email, name);
  };

  const createProject = async (name: string): Promise<string> => {
    const project = await runtime.runPromise(ProjectManagementService.use((projects) =>
      projects.createProject({name, principal: administrator})));
    return project.id;
  };

  const setProjectAccess = async (projectId: string, accessMode: ProjectAccessMode, defaultMemberRole: ProjectRole = "editor") => {
    const current = await access.readProjectAccess(installationId, projectId);
    if (current === null) throw new Error(`Project ${projectId} does not exist.`);
    const written = await access.writeProjectAccess({
      accessMode,
      attribution: attributionOf(administrator),
      defaultMemberRole,
      expectedRevision: current.revision,
      installationId,
      projectId,
    });
    if (written === "conflict") throw new Error("Project access changed concurrently.");
  };

  const grant = async (overrides: Partial<AccessGrantDraft> & Pick<AccessGrantDraft, "memberId" | "projectId" | "role">) => {
    const written = await access.upsertGrant({
      attribution: attributionOf(administrator),
      expectedRevision: null,
      grant: {
        add: [],
        artifactId: null,
        createdByPrincipalId: administrator.id,
        expiresAt: null,
        id: `grt_${randomUUID()}`,
        remove: [],
        ...overrides,
      },
      installationId,
    });
    if (written === "conflict") throw new Error("A grant for this member and scope already exists.");
    return written;
  };

  /** Publish one small private HTML artifact into `projectId` as `principal`. */
  const publish = async (principal: Principal, projectId: string, name = "Fixture") =>
    publishTo(principal, projectId, name, {accessSetting: "account_required", kind: "new_artifact", name});

  /** Publish a new version of an existing artifact. */
  const publishVersion = async (
    principal: Principal,
    projectId: string,
    artifactId: string,
    expectedCurrentVersionId: string,
  ) => publishTo(principal, projectId, `Version after ${expectedCurrentVersionId}`, {
    artifactId,
    expectedCurrentVersionId,
    kind: "new_version",
  });

  const publishTo = async (
    principal: Principal,
    projectId: string,
    name: string,
    target: CommitStagedUploadTarget,
  ) => {
    const bytes = new TextEncoder().encode(`<!doctype html><title>${name}</title>`);
    const created = await runtime.runPromise(StagedUploadService.use((uploads) => uploads.createUpload({
      entryPath: "index.html",
      files: [{
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      }],
      principal,
      projectId,
    })));
    if (created.kind === "committed") throw new Error("Fixture upload unexpectedly committed.");
    const file = created.upload.files[0];
    if (file === undefined) throw new Error("Fixture upload has no file.");
    await runtime.runPromise(StagedUploadService.use((uploads) => uploads.uploadFile({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      ownerId: created.upload.principalId,
      projectId: created.upload.projectId,
      storageToken: file.storageToken,
      uploadId: created.upload.id,
    })));
    const committed = await runtime.runPromise(StagedUploadService.use((uploads) => uploads.commitUpload({
      idempotencyKey: `access-fixture-${randomUUID()}`,
      principal,
      projectId,
      target,
      uploadId: created.upload.id,
    })));
    if (committed.kind !== "committed") throw new Error(`Fixture upload returned ${committed.kind}.`);
    return committed.publication;
  };

  return {
    access,
    administrator,
    clock,
    createProject,
    grant,
    installationId,
    person,
    publish,
    publishVersion,
    runtime,
    setProjectAccess,
    stop: async () => {
      await runtime.dispose();
      access.close();
      identityRepository.close();
      repository.close();
      await rm(dataDirectory, {force: true, recursive: true});
    },
  };
}
