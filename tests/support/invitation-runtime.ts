import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {ManagedRuntime, Redacted} from "effect";

import {InstallationAccessService} from "../../src/application/installation-access.js";
import type {Principal} from "../../src/core/identity.js";
import {SystemIdGenerator} from "../../src/core/system.js";
import {createLocalApplicationLayer} from "../../src/local/create-local-application-layer.js";
import {LocalBlobStore} from "../../src/storage/local-blob-store.js";
import {LocalStagingStore} from "../../src/storage/local-staging-store.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";
import {MutableClock} from "./agent-dispatch.js";
import {LoopbackIdentityProvider} from "./loopback-identity-provider.js";

export interface InvitationPerson {
  readonly displayName: string;
  readonly email: string;
  readonly subject: string;
}

/** The real application composition over a temporary SQLite installation with a team provider. */
export async function startInvitationRuntime() {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-invitation-runtime-"));
  const databasePath = path.join(dataDirectory, "artifact-server.db");
  const repository = new SqliteArtifactRepository(databasePath);
  const identityRepository = new SqliteIdentityRepository(databasePath);
  const clock = new MutableClock("2026-10-06T10:00:00.000Z");
  const runtime = ManagedRuntime.make(createLocalApplicationLayer({
    apiToken: Redacted.make("invitation-runtime-test-token"),
    blobs: new LocalBlobStore(path.join(dataDirectory, "blobs")),
    bootstrapAdministratorEmail: "jordan@acme.test",
    clock,
    dispatches: repository,
    externalApiBearerVerifier: null,
    externalMcpBearerVerifier: null,
    externalMcpOAuthVerifier: null,
    ids: new SystemIdGenerator(),
    identityRepository,
    installationId: "invitation-runtime",
    interactiveIdentityProvider: new LoopbackIdentityProvider(),
    localBootstrapCredential: null,
    protectBootstrapAdministrator: false,
    repository,
    staging: new LocalStagingStore(path.join(dataDirectory, "staging")),
  }));

  /** Complete an external login as `person`, optionally redeeming an invite, and return the principal. */
  const signIn = async (person: InvitationPerson, inviteId: string | null = null): Promise<Principal> => {
    const issued = await runtime.runPromise(InstallationAccessService.use((access) =>
      access.completeExternalIdentity({
        displayName: person.displayName,
        email: person.email,
        emailVerificationAsserted: true,
        emailVerified: true,
        provider: "workos",
        subject: person.subject,
      }, inviteId)));
    const authenticated = await runtime.runPromise(InstallationAccessService.use((access) =>
      access.authenticateSession(Redacted.make(issued.token))));
    return authenticated.principal;
  };

  return {
    clock,
    runtime,
    signIn,
    stop: async () => {
      await runtime.dispose();
      identityRepository.close();
      repository.close();
      await rm(dataDirectory, {force: true, recursive: true});
    },
  };
}
