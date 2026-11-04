import {Effect, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {BearerCredentialVerifier} from "../../src/application/authentication.js";
import {AuthenticationRequired} from "../../src/core/errors.js";
import {membershipRoles, principalKinds} from "../../src/core/identity.js";
import {
  defaultGitHistoryFileCopyBytes,
  defaultGitHistoryVersionCopyBytes,
} from "../../src/git-history/git-history-capability.js";
import type {GitHistoryProviderHealthProbe} from "../../src/git-history/git-history-provider-health.js";
import type {NodeGitHistoryConfiguration} from "../../src/git-history/node-git-history-configuration.js";
import {RecordingGitHistoryProvider} from "../support/git-history-provider.js";
import {
  commitStagedUpload,
  createStagedUpload,
  publishNew,
  publishVersion,
  requireSuccessfulUploads,
  testSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const reviewerToken = "cnd-006-direct-human-reviewer";
const verifier: BearerCredentialVerifier = {
  verify: (credential) => Redacted.value(credential) === reviewerToken
    ? Effect.succeed({
      authorizedByPrincipalId: null,
      capabilities: [],
      displayName: "Robin Reviewer",
      id: "usr_cnd006_reviewer",
      installationId: "local",
      kind: principalKinds.human,
      membershipRole: membershipRoles.member,
      projectIds: [],
    })
    : Effect.fail(new AuthenticationRequired({message: "Unknown CND-006 credential."})),
};
const availableHealthProbe: GitHistoryProviderHealthProbe = {
  check: () => Effect.succeed({state: "available"}),
};
const gitHistory: Extract<NodeGitHistoryConfiguration, {readonly _tag: "CloudflareArtifactsRest"}> = {
  _tag: "CloudflareArtifactsRest",
  apiToken: Redacted.make("cnd-006-test-token"),
  capability: {
    limits: {
      fileCopyBytes: defaultGitHistoryFileCopyBytes,
      logicalCopiedBytes: 0,
      logicalReservedBytes: 0,
      storageBudgetBytes: null,
      versionCopyBytes: defaultGitHistoryVersionCopyBytes,
    },
    provider: "cloudflare-artifacts",
    providerState: "checking",
  },
  identity: {accountId: "cnd-006-account", namespace: "cnd-006-namespace", provider: "cloudflare-artifacts"},
  issues: [],
};

describe("candidate versions and Git history", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let provider: RecordingGitHistoryProvider;

  beforeEach(async () => {
    installation = await createTestInstallation();
    provider = new RecordingGitHistoryProvider();
    server = await startTestServer(installation, {
      externalApiBearerVerifier: verifier,
      gitHistory,
      gitHistoryHealthProbe: availableHealthProbe,
      gitHistoryProvider: provider,
    });
  });

  /** Wait for the provider to be available, then turn Git history on for the default project. */
  async function enableGitHistory(): Promise<void> {
    await expect.poll(async () => {
      const response = await fetch(new URL("/api/v1/session", server.baseUrl), {
        headers: {Authorization: `Bearer ${installation.apiToken}`},
      });
      return z.object({
        capabilities: z.object({gitHistory: z.object({providerState: z.string()}).loose()}).loose(),
      }).loose().parse(await response.json()).capabilities.gitHistory.providerState;
    }, {timeout: 5_000}).toBe("available");
    const enabled = await fetch(new URL("/api/v1/projects/prj_default/git-history", server.baseUrl), {
      body: JSON.stringify({confirmEstimate: true, enabled: true}),
      headers: apiHeaders(installation, "cnd-006-enable-git-history"),
      method: "PUT",
    });
    expect(enabled.status).toBe(200);
  }

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function stage(artifactId: string, base: string, content: string, key: string) {
    const file = testSiteFile(content);
    const upload = await createStagedUpload(server, installation, file.path, [file], "prj_default");
    await requireSuccessfulUploads(uploadEveryStagedFile(installation, upload.body, [file]));
    const committed = await commitStagedUpload(installation, upload.body, `cnd-006-stage-${key}`, {
      artifactId,
      expectedCurrentVersionId: base,
      kind: "new_version",
      stage: true,
    });
    expect(committed.body.version.state).toBe("candidate");
    return committed.body;
  }

  async function decide(artifactId: string, versionId: string, action: "promote" | "reject", key: string) {
    const response = await fetch(new URL(
      `/api/v1/artifacts/${artifactId}/versions/${versionId}/${action}?projectId=prj_default`,
      server.baseUrl,
    ), {
      headers: {Authorization: `Bearer ${reviewerToken}`, "Idempotency-Key": `cnd-006-decision-${key}`},
      method: "POST",
    });
    expect(response.status).toBe(200);
  }

  const mirroredVersionIds = () => provider.commitRequests.map((request) => request.metadata.versionId);

  test("CND-006-B: a candidate is mirrored only when promoted, with the previous mirrored version as its parent", async () => {
    await enableGitHistory();
    const first = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Version one</title>",
      idempotencyKey: "cnd-006-b-first-version",
    });
    const artifactId = first.body.artifact.id;
    await expect.poll(mirroredVersionIds, {timeout: 10_000}).toEqual([first.body.version.id]);

    const rejected = await stage(artifactId, first.body.version.id, "<!doctype html><title>Rejected</title>", "b-rejected");
    const candidate = await stage(artifactId, first.body.version.id, "<!doctype html><title>Promoted</title>", "b-promoted");
    await decide(artifactId, rejected.version.id, "reject", "b-reject");
    await decide(artifactId, candidate.version.id, "promote", "b-promote");
    await expect.poll(mirroredVersionIds, {timeout: 10_000}).toEqual([first.body.version.id, candidate.version.id]);

    // The promoted version keeps its candidate number (3) and its parent is version 1's commit,
    // which the recording provider checks against the branch head before accepting the push.
    const [firstRequest, promotedRequest] = provider.commitRequests;
    expect(promotedRequest?.metadata.versionNumber).toBe(3);
    const firstCommit = provider.commits.get(artifactId)?.get(first.body.version.id)?.commitId;
    expect(firstCommit).toBeDefined();
    expect(promotedRequest?.expectedParentCommitId).toBe(firstCommit);
    expect(firstRequest?.expectedParentCommitId).toBeNull();

    // A mainline publish after the promotion takes the promoted version as its parent.
    const next = await publishVersion(server, installation, {
      artifactId,
      content: "<!doctype html><title>Version four</title>",
      expectedCurrentVersionId: candidate.version.id,
      idempotencyKey: "cnd-006-b-mainline-after-promotion",
    });
    await expect.poll(mirroredVersionIds, {timeout: 10_000})
      .toEqual([first.body.version.id, candidate.version.id, next.body.version.id]);
    expect(provider.commitRequests[2]?.expectedParentCommitId)
      .toBe(provider.commits.get(artifactId)?.get(candidate.version.id)?.commitId);
  });

  test("CND-006-F: open, stale, and rejected candidates never reach Git, and a rejected one is never an ancestor on main", async () => {
    await enableGitHistory();
    const first = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Base</title>",
      idempotencyKey: "cnd-006-f-first-version",
    });
    const artifactId = first.body.artifact.id;
    await expect.poll(mirroredVersionIds, {timeout: 10_000}).toEqual([first.body.version.id]);
    const rejected = await stage(artifactId, first.body.version.id, "<!doctype html><title>Rejected</title>", "f-rejected");
    await decide(artifactId, rejected.version.id, "reject", "f-reject");
    const stale = await stage(artifactId, first.body.version.id, "<!doctype html><title>Stale</title>", "f-stale");
    const mainline = await publishVersion(server, installation, {
      artifactId,
      content: "<!doctype html><title>Mainline four</title>",
      expectedCurrentVersionId: first.body.version.id,
      idempotencyKey: "cnd-006-f-mainline-version",
    });
    const open = await stage(artifactId, mainline.body.version.id, "<!doctype html><title>Open</title>", "f-open");
    await expect.poll(mirroredVersionIds, {timeout: 10_000}).toEqual([first.body.version.id, mainline.body.version.id]);

    // Version 4's parent skips the rejected (2) and stale (3) candidates.
    expect(mainline.body.version.number).toBe(4);
    expect(provider.commitRequests[1]?.expectedParentCommitId)
      .toBe(provider.commits.get(artifactId)?.get(first.body.version.id)?.commitId);
    // Toggling Git history re-runs the backfill; it still finds no candidate to mirror, and
    // the project reports ready because candidates never count as unmirrored history.
    for (const body of [{enabled: false}, {confirmEstimate: true, enabled: true}]) {
      // eslint-disable-next-line no-await-in-loop -- the setting changes in order
      const toggled = await fetch(new URL("/api/v1/projects/prj_default/git-history", server.baseUrl), {
        body: JSON.stringify(body),
        headers: apiHeaders(installation, `cnd-006-f-toggle-${String(body.enabled)}`),
        method: "PUT",
      });
      expect(toggled.status).toBe(200);
    }
    await expect.poll(async () => z.object({gitHistory: z.object({state: z.string()}).loose()}).loose().parse(
      await (await fetch(new URL("/api/v1/projects/prj_default/git-history", server.baseUrl), {
        headers: {Authorization: `Bearer ${installation.apiToken}`},
      })).json(),
    ).gitHistory.state, {timeout: 10_000}).toBe("ready");
    expect(mirroredVersionIds()).toEqual([first.body.version.id, mainline.body.version.id]);
    const committed = [...(provider.commits.get(artifactId)?.keys() ?? [])];
    for (const candidateId of [rejected.version.id, stale.version.id, open.version.id]) {
      expect(committed).not.toContain(candidateId);
      expect(mirroredVersionIds()).not.toContain(candidateId);
    }
  });
});
