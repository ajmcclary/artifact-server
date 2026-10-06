import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {Effect} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {
  InteractiveAuthorization,
  InteractiveIdentityProvider,
} from "../../src/application/interactive-login.js";
import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import type {IdentityProviderFailure} from "../../src/core/errors.js";
import type {ExternalIdentity} from "../../src/core/installation-identity.js";
import {defaultProjectId} from "../../src/core/model.js";
import {fetchLoopbackContent} from "../support/fetch-loopback-content.js";
import {
  apiHeaders,
  createTestInstallation,
  fetchVersion,
  loginHandshakeCookie,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  commitStagedUpload,
  createStagedUpload,
  publishNew,
  type PublishResponse,
  publishVersion,
  uploadStagedFile,
} from "../support/publishing.js";

const projectSchema = z.object({
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  name: z.string(),
});
const projectResponseSchema = z.object({project: projectSchema});
const projectListSchema = z.object({projects: z.array(projectSchema)});
const artifactListSchema = z.object({
  artifacts: z.array(z.object({
    artifact: z.object({id: z.string(), projectId: z.string()}),
  })),
  nextCursor: z.string().nullable(),
});
const errorBodySchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).loose(),
}).loose();
const mcpProtocolVersion = "2026-07-28";
const mcpToolCallSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
  }).loose(),
}).loose();
const mcpToolListSchema = z.object({
  result: z.object({
    tools: z.array(z.object({description: z.string().optional(), name: z.string()}).loose()),
  }).loose(),
}).loose();
const mcpErrorSchema = z.object({
  error: z.object({code: z.number(), message: z.string()}),
}).loose();
const memberResponseSchema = z.object({
  member: z.object({email: z.string(), id: z.string(), role: z.string()}).loose(),
});
const bootstrapResponseSchema = z.object({
  bootstrapUrl: z.url(),
  versionId: z.string(),
}).loose();
const versionListSchema = z.object({
  versions: z.array(z.object({
    links: z.object({version: z.url()}).loose(),
    version: z.object({id: z.string()}).loose(),
  }).loose()),
}).loose();
const teamAdministratorEmail = "administrator@example.test";

describe("project-scoped artifacts", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("default use stays simple while project boundaries stay isolated", async () => {
    const initialProjects = projectListSchema.parse(await (await apiFetch(
      "/api/v1/projects",
    )).json());
    expect(initialProjects.projects).toEqual([
      expect.objectContaining({
        archivedAt: null,
        id: defaultProjectId,
        name: "Default",
      }),
    ]);

    const defaultArtifact = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "default project artifact",
      idempotencyKey: "same-key-in-different-projects",
      name: "Default artifact",
    });
    expect(defaultArtifact.body.artifact.projectId).toBe(defaultProjectId);

    const createdResponse = await apiFetch("/api/v1/projects", {
      body: JSON.stringify({name: "Product launch"}),
      headers: apiHeaders(installation, "unused-project-create-key"),
      method: "POST",
    });
    expect(createdResponse.status).toBe(201);
    const created = projectResponseSchema.parse(await createdResponse.json()).project;

    const otherInstallation = await createTestInstallation();
    const otherServer = await startTestServer(otherInstallation);
    try {
      const foreignResponse = await fetch(`${otherServer.baseUrl}/api/v1/projects`, {
        body: JSON.stringify({name: "Other installation project"}),
        headers: apiHeaders(otherInstallation, "unused-foreign-project-key"),
        method: "POST",
      });
      const foreignProject = projectResponseSchema.parse(
        await foreignResponse.json(),
      ).project;
      const crossInstallationSelection = await apiFetch(
        `/api/v1/projects/${foreignProject.id}`,
      );
      expect(crossInstallationSelection.status).toBe(404);
      await expect(crossInstallationSelection.json()).resolves.toMatchObject({
        error: {code: "PROJECT_NOT_FOUND"},
      });
    } finally {
      await otherServer.stop();
      await removeTestInstallation(otherInstallation);
    }

    const isolatedBytes = new TextEncoder().encode("project-bound upload");
    const isolatedFile = {
      bytes: isolatedBytes,
      mediaType: "text/plain",
      path: "project-bound.txt",
    };
    const isolatedUpload = await createStagedUpload(
      server,
      installation,
      isolatedFile.path,
      [isolatedFile],
      created.id,
    );
    const plannedUpload = isolatedUpload.body.files[0] ?? failMissingUploadFile();
    const tamperedUploadUrl = new URL(plannedUpload.uploadUrl);
    tamperedUploadUrl.searchParams.set("projectId", defaultProjectId);
    const crossProjectUpload = await fetch(tamperedUploadUrl, {
      body: isolatedBytes,
      headers: {Authorization: `Bearer ${installation.apiToken}`},
      method: "PUT",
    });
    expect(crossProjectUpload.status).toBe(404);
    expect((await uploadStagedFile(
      installation,
      plannedUpload,
      isolatedBytes,
    )).status).toBe(200);

    const ambiguous = await apiFetch("/api/v1/artifacts");
    expect(ambiguous.status).toBe(409);
    await expect(ambiguous.json()).resolves.toMatchObject({
      error: {
        code: "PROJECT_SELECTION_REQUIRED",
        message: expect.stringContaining(`Product launch (${created.id})`),
      },
    });

    const projectArtifact = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "product project artifact",
      idempotencyKey: "same-key-in-different-projects",
      name: "Launch artifact",
      projectId: created.id,
    });
    expect(projectArtifact.body.artifact.projectId).toBe(created.id);
    expect(projectArtifact.body.artifact.id).not.toBe(defaultArtifact.body.artifact.id);

    const [defaultPage, projectPage] = await Promise.all([
      apiFetch(`/api/v1/artifacts?projectId=${defaultProjectId}`),
      apiFetch(`/api/v1/artifacts?projectId=${created.id}`),
    ]);
    expect(artifactListSchema.parse(await defaultPage.json()).artifacts)
      .toEqual([expect.objectContaining({
        artifact: expect.objectContaining({id: defaultArtifact.body.artifact.id}),
      })]);
    expect(artifactListSchema.parse(await projectPage.json()).artifacts)
      .toEqual([expect.objectContaining({
        artifact: expect.objectContaining({id: projectArtifact.body.artifact.id}),
      })]);

    const crossProjectRead = await apiFetch(
      `/api/v1/artifacts/${projectArtifact.body.artifact.id}?projectId=${defaultProjectId}`,
    );
    expect(crossProjectRead.status).toBe(404);
    await expect(crossProjectRead.json()).resolves.toMatchObject({
      error: {code: "ARTIFACT_NOT_FOUND"},
    });

    const second = await publishVersion(server, installation, {
      artifactId: projectArtifact.body.artifact.id,
      content: "second product project version",
      expectedCurrentVersionId: projectArtifact.body.version.id,
      idempotencyKey: "project-scope-second-version",
      projectId: created.id,
    });
    const crossProjectComparison = await apiFetch(
      `/api/v1/artifacts/${projectArtifact.body.artifact.id}/comparisons?` +
        `projectId=${defaultProjectId}&fromVersionId=${projectArtifact.body.version.id}` +
        `&toVersionId=${second.body.version.id}`,
    );
    expect(crossProjectComparison.status).toBe(404);
    const crossProjectMutation = await apiFetch(
      `/api/v1/artifacts/${projectArtifact.body.artifact.id}/access?` +
        `projectId=${defaultProjectId}`,
      {
        body: JSON.stringify({
          accessSetting: "public_link",
          expectedCurrentVersionId: second.body.version.id,
        }),
        headers: apiHeaders(installation, "cross-project-access-change"),
        method: "PATCH",
      },
    );
    expect(crossProjectMutation.status).toBe(404);
    const actions = await apiFetch(
      `/api/v1/artifacts/${projectArtifact.body.artifact.id}/actions?` +
        `projectId=${created.id}`,
    );
    await expect(actions.json()).resolves.toMatchObject({
      actions: [
        expect.objectContaining({projectId: created.id}),
        expect.objectContaining({projectId: created.id}),
      ],
    });
  });

  test("archive blocks writes but preserves exact history", async () => {
    const created = projectResponseSchema.parse(await (await apiFetch(
      "/api/v1/projects",
      {
        body: JSON.stringify({name: "Archive proof"}),
        headers: apiHeaders(installation, "unused-project-create-key"),
        method: "POST",
      },
    )).json()).project;
    const firstBytes = new TextEncoder().encode("first archived-project version");
    const firstFile = {
      bytes: firstBytes,
      mediaType: "text/html; charset=utf-8",
      path: "index.html",
    };
    const firstUpload = await createStagedUpload(
      server,
      installation,
      firstFile.path,
      [firstFile],
      created.id,
    );
    const firstPlannedFile = firstUpload.body.files[0] ?? failMissingUploadFile();
    expect((await uploadStagedFile(
      installation,
      firstPlannedFile,
      firstBytes,
    )).status).toBe(200);
    const firstTarget = {
      accessSetting: "public_link" as const,
      kind: "new_artifact" as const,
      name: "Archive proof artifact",
    };
    const first = await commitStagedUpload(
      installation,
      firstUpload.body,
      "archive-proof-first",
      firstTarget,
    );

    const archiveResponse = await apiFetch(
      `/api/v1/projects/${created.id}/archive`,
      {headers: apiHeaders(installation, "unused-project-archive-key"), method: "POST"},
    );
    expect(archiveResponse.status).toBe(200);
    const firstArchivedAt = projectResponseSchema.parse(
      await archiveResponse.json(),
    ).project.archivedAt;
    expect(firstArchivedAt).not.toBeNull();
    const repeatedArchivedAt = projectResponseSchema.parse(
      await (await apiFetch(
        `/api/v1/projects/${created.id}/archive`,
        {headers: apiHeaders(installation, "unused-project-archive-retry"), method: "POST"},
      )).json(),
    ).project.archivedAt;
    expect(repeatedArchivedAt).toBe(firstArchivedAt);

    const replay = await commitStagedUpload(
      installation,
      firstUpload.body,
      "archive-proof-first",
      firstTarget,
    );
    expect(replay.response.status).toBe(200);
    expect(replay.body).toMatchObject({
      artifact: {id: first.body.artifact.id, projectId: created.id},
      replayed: true,
      version: {id: first.body.version.id, projectId: created.id},
    });

    const rejected = await fetch(`${server.baseUrl}/api/v1/uploads`, {
      body: JSON.stringify({
        entryPath: "index.html",
        files: [{
          mediaType: "text/html",
          path: "index.html",
          sha256: "0".repeat(64),
          size: 0,
        }],
        projectId: created.id,
      }),
      headers: apiHeaders(installation, "unused-archived-upload-key"),
      method: "POST",
    });
    expect(rejected.status).toBe(409);
    await expect(rejected.json()).resolves.toMatchObject({
      error: {code: "PROJECT_ARCHIVED"},
    });

    const details = await apiFetch(
      `/api/v1/artifacts/${first.body.artifact.id}?projectId=${created.id}`,
    );
    expect(details.status).toBe(200);
    await expect(details.json()).resolves.toMatchObject({
      artifact: {id: first.body.artifact.id, projectId: created.id},
      current: {version: {id: first.body.version.id, projectId: created.id}},
    });
    expect((await fetchLoopbackContent(first.body.links.version)).status).toBe(200);

    const unarchived = await apiFetch(
      `/api/v1/projects/${created.id}/unarchive`,
      {headers: apiHeaders(installation, "unused-project-unarchive-key"), method: "POST"},
    );
    expect(unarchived.status).toBe(200);
    const second = await publishVersion(server, installation, {
      artifactId: first.body.artifact.id,
      content: "second version after unarchive",
      expectedCurrentVersionId: first.body.version.id,
      idempotencyKey: "archive-proof-second",
      projectId: created.id,
    });
    expect(second.body.version).toMatchObject({number: 2, projectId: created.id});

    const renamed = await apiFetch(`/api/v1/projects/${created.id}`, {
      body: JSON.stringify({name: "Renamed without moving artifacts"}),
      headers: apiHeaders(installation, "unused-project-rename-key"),
      method: "PATCH",
    });
    expect(projectResponseSchema.parse(await renamed.json()).project.name)
      .toBe("Renamed without moving artifacts");
    expect((await apiFetch(
      `/api/v1/artifacts/${first.body.artifact.id}?projectId=${created.id}`,
    )).status).toBe(200);
  });

  test("PRJ-001-B: new local and team installations each keep one stable default project beside the projects they create", async () => {
    const team = await startTeamInstallation();
    try {
      const localCreated = await proveStableDefaultProject({
        label: "local",
        restart: async () => {
          await server.stop();
          server = await startTestServer(installation);
          return server;
        },
        running: server,
        token: installation.apiToken,
      });
      const teamCreated = await proveStableDefaultProject({
        label: "team",
        restart: () => team.restart(),
        running: team.server,
        token: team.installation.apiToken,
      });

      const [localProjects, teamProjects] = await Promise.all([
        listProjects(server, installation.apiToken),
        listProjects(team.server, team.installation.apiToken),
      ]);
      expect(localProjects.map((project) => project.id)).not.toContain(teamCreated.id);
      expect(teamProjects.map((project) => project.id)).not.toContain(localCreated.id);
    } finally {
      await team.stop();
    }
  }, 30_000);

  test("PRJ-001-F: callers cannot create or select an organization, Artifact Store, Namespace, or another installation's project", async () => {
    const forbiddenRoutes = [
      "organizations",
      "orgs",
      "artifact-stores",
      "stores",
      "namespaces",
    ].flatMap((collection) => [
      `/api/v1/${collection}`,
      `/api/v1/projects/${defaultProjectId}/${collection}`,
    ]);
    const forbiddenStatuses = await Promise.all(forbiddenRoutes.flatMap((pathname) => [
      apiFetch(pathname).then((response) => ({pathname, status: response.status})),
      apiFetch(pathname, {
        body: JSON.stringify({name: "Must not exist"}),
        headers: apiHeaders(installation, `forbidden-${pathname}`),
        method: "POST",
      }).then((response) => ({pathname, status: response.status})),
    ]));
    for (const forbidden of forbiddenStatuses) {
      expect(forbidden).toEqual({pathname: forbidden.pathname, status: 404});
    }

    const forbiddenSurface = /organi[sz]ation|artifact[ _-]?store|namespace/iu;
    const toolNames = (await mcpListTools(server, installation.apiToken))
      .map((tool) => tool.name);
    expect(toolNames).toContain("project_create");
    expect(toolNames.filter((name) => forbiddenSurface.test(name))).toEqual([]);
    const unknownTools = await Promise.all(
      ["organization_create", "artifact_store_create", "namespace_create"].map(
        async (name) => {
          const response = await mcpRequest(server, installation.apiToken, "tools/call", {
            arguments: {name: "Must not exist"},
            name,
          }, {"Mcp-Name": name});
          return {body: mcpErrorSchema.parse(await response.json()), name, status: response.status};
        },
      ),
    );
    for (const unknown of unknownTools) {
      expect(unknown).toMatchObject({
        body: {error: {code: -32602, message: `Tool ${unknown.name} not found`}},
        name: unknown.name,
        status: 200,
      });
    }

    const unscopedList = await (await apiFetch("/api/v1/projects")).text();
    const selectorOutcomes = await Promise.all([
      {organizationId: "org_other"},
      {artifactStoreId: "store_other"},
      {namespace: "other-namespace"},
      {installationId: "other-installation"},
    ].map(async (selector) => {
      const label = JSON.stringify(selector);
      const [project, upload, mcpCreate, selectedList] = await Promise.all([
        apiFetch("/api/v1/projects", {
          body: JSON.stringify({name: "Selector project", ...selector}),
          headers: apiHeaders(installation, `selector-project-${label}`),
          method: "POST",
        }),
        apiFetch("/api/v1/uploads", {
          body: JSON.stringify({
            entryPath: "index.html",
            files: [emptyDeclaredFile],
            ...selector,
          }),
          headers: apiHeaders(installation, `selector-upload-${label}`),
          method: "POST",
        }),
        mcpToolCall(server, installation.apiToken, "project_create", {
          name: "Selector project",
          ...selector,
        }),
        apiFetch(`/api/v1/projects?${new URLSearchParams(selector).toString()}`),
      ]);
      return {
        label,
        mcpCreateFailed: mcpCreate.isError === true,
        projectStatus: project.status,
        selectedList: await selectedList.text(),
        uploadStatus: upload.status,
      };
    }));
    for (const outcome of selectorOutcomes) {
      expect(outcome).toEqual({
        label: outcome.label,
        mcpCreateFailed: true,
        projectStatus: 422,
        selectedList: unscopedList,
        uploadStatus: 422,
      });
    }
    expect(await listProjects(server, installation.apiToken)).toEqual([
      expect.objectContaining({id: defaultProjectId}),
    ]);

    const other = await startTeamInstallation();
    try {
      const foreignResponse = await fetch(`${other.server.baseUrl}/api/v1/projects`, {
        body: JSON.stringify({name: "Other installation project"}),
        headers: bearerJsonHeaders(other.installation.apiToken),
        method: "POST",
      });
      expect(foreignResponse.status).toBe(201);
      const foreignProjectId = projectResponseSchema.parse(
        await foreignResponse.json(),
      ).project.id;
      const missingProjectId = "prj_00000000000000000000000000";

      const httpProbes: ReadonlyArray<{
        readonly operation: string;
        readonly send: (projectId: string) => Promise<Response>;
      }> = [
        {operation: "read", send: (projectId) => apiFetch(`/api/v1/projects/${projectId}`)},
        {operation: "rename", send: (projectId) => apiFetch(`/api/v1/projects/${projectId}`, {
          body: JSON.stringify({name: "Hijacked"}),
          headers: apiHeaders(installation, `rename-${projectId}`),
          method: "PATCH",
        })},
        {operation: "archive", send: (projectId) => apiFetch(`/api/v1/projects/${projectId}/archive`, {
          headers: apiHeaders(installation, `archive-${projectId}`),
          method: "POST",
        })},
        {operation: "list", send: (projectId) => apiFetch(`/api/v1/artifacts?projectId=${projectId}`)},
        {operation: "upload", send: (projectId) => apiFetch("/api/v1/uploads", {
          body: JSON.stringify({
            entryPath: "index.html",
            files: [emptyDeclaredFile],
            projectId,
          }),
          headers: apiHeaders(installation, `upload-${projectId}`),
          method: "POST",
        })},
      ];
      const httpOutcomes = await Promise.all(httpProbes.map(async (probe) => ({
        foreign: await redactedFailure(await probe.send(foreignProjectId), foreignProjectId),
        missing: await redactedFailure(await probe.send(missingProjectId), missingProjectId),
        operation: probe.operation,
      })));
      for (const outcome of httpOutcomes) {
        expect(outcome).toEqual({
          foreign: outcome.missing,
          missing: {body: expect.stringContaining("\"PROJECT_NOT_FOUND\""), status: 404},
          operation: outcome.operation,
        });
      }

      const mcpProbes: ReadonlyArray<{
        readonly argumentsFor: (projectId: string) => McpParameters;
        readonly tool: string;
      }> = [
        {argumentsFor: (projectId) => ({name: "Hijacked", projectId}), tool: "project_rename"},
        {argumentsFor: (projectId) => ({projectId}), tool: "project_archive"},
        {
          argumentsFor: (projectId) => ({cursor: null, limit: 10, projectId, tag: null}),
          tool: "artifact_list",
        },
      ];
      const mcpOutcomes = await Promise.all(mcpProbes.map(async (probe) => {
        const [foreign, missing] = await Promise.all([
          mcpToolCall(server, installation.apiToken, probe.tool, probe.argumentsFor(foreignProjectId)),
          mcpToolCall(server, installation.apiToken, probe.tool, probe.argumentsFor(missingProjectId)),
        ]);
        return {
          foreign: JSON.stringify(foreign).replaceAll(foreignProjectId, "<project>"),
          foreignFailed: foreign.isError === true,
          missing: JSON.stringify(missing).replaceAll(missingProjectId, "<project>"),
          tool: probe.tool,
        };
      }));
      for (const outcome of mcpOutcomes) {
        expect(outcome).toEqual({
          foreign: outcome.missing,
          foreignFailed: true,
          missing: expect.stringContaining("\"PROJECT_NOT_FOUND\""),
          tool: outcome.tool,
        });
      }

      const foreignProject = await authorizedFetch(
        other.server,
        other.installation.apiToken,
        `/api/v1/projects/${foreignProjectId}`,
      );
      await expect(foreignProject.json()).resolves.toMatchObject({
        project: {archivedAt: null, id: foreignProjectId, name: "Other installation project"},
      });
    } finally {
      await other.stop();
    }
    expect(await listProjects(server, installation.apiToken)).toEqual([
      expect.objectContaining({archivedAt: null, id: defaultProjectId, name: "Default"}),
    ]);
  }, 30_000);

  test("PRJ-003-B: installation members read account-required work in any project, and archive keeps reads and comparisons while rejecting new artifacts and versions", async () => {
    const team = await startTeamInstallation();
    try {
      const adminToken = team.installation.apiToken;
      const created = await createProject(team.server, adminToken, "Membership proof");
      const first = await publishNew(team.server, team.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><title>Members only</title><p>first</p>",
        idempotencyKey: "membership-first",
        name: "Members only",
        projectId: created.id,
      });
      expect(first.response.status).toBe(201);
      const second = await publishVersion(team.server, team.installation, {
        artifactId: first.body.artifact.id,
        content: "<!doctype html><title>Members only</title><p>second</p>",
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: "membership-second",
        projectId: created.id,
      });
      expect(second.response.status).toBe(201);
      const pendingFile = {
        bytes: new TextEncoder().encode("<!doctype html><p>third, planned before archive</p>"),
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
      };
      const pending = await createStagedUpload(
        team.server,
        team.installation,
        pendingFile.path,
        [pendingFile],
        created.id,
      );
      expect(pending.response.status).toBe(201);
      const pendingPlan = pending.body.files[0] ?? failMissingUploadFile();
      expect((await uploadStagedFile(team.installation, pendingPlan, pendingFile.bytes)).status)
        .toBe(200);

      const memberEmail = "project-reader@example.test";
      const administrator = await team.login(teamAdministratorEmail, "team-administrator");
      const admitted = await fetch(`${team.server.baseUrl}/api/v1/members`, {
        body: JSON.stringify({displayName: "Project reader", email: memberEmail}),
        headers: browserMutationHeaders(team.server.baseUrl, administrator),
        method: "POST",
      });
      expect(admitted.status).toBe(201);
      expect(memberResponseSchema.parse(await admitted.json()).member).toMatchObject({
        email: memberEmail,
        role: "member",
      });
      const member = await team.login(memberEmail, "project-reader");
      const projectRecord = await fetch(
        `${team.server.baseUrl}/api/v1/projects/${created.id}`,
        {headers: {Cookie: member.header}},
      );
      expect(projectRecord.status).toBe(200);
      expect(Object.keys(z.object({project: z.object({}).loose()}).parse(
        await projectRecord.json(),
      ).project).toSorted()).toEqual(["archivedAt", "createdAt", "id", "installationId", "name"]);
      expect((await fetch(
        `${team.server.baseUrl}/api/v1/projects/${created.id}/members`,
        {headers: {Cookie: member.header}},
      )).status).toBe(404);

      const artifactPath =
        `/api/v1/artifacts/${first.body.artifact.id}?projectId=${created.id}`;
      const comparisonPath =
        `/api/v1/artifacts/${first.body.artifact.id}/comparisons?${new URLSearchParams({
          fromVersionId: first.body.version.id,
          projectId: created.id,
          toVersionId: second.body.version.id,
        }).toString()}`;
      expect((await fetch(`${team.server.baseUrl}${artifactPath}`)).status).toBe(401);
      expect((await fetch(`${team.server.baseUrl}${comparisonPath}`)).status).toBe(401);
      expect((await fetchVersion(team.server, second.body.links.version)).status).toBe(401);

      const readAsMember = async (): Promise<MemberReads> => {
        const [details, comparison, session] = await Promise.all([
          fetch(`${team.server.baseUrl}${artifactPath}`, {headers: {Cookie: member.header}}),
          fetch(`${team.server.baseUrl}${comparisonPath}`, {headers: {Cookie: member.header}}),
          fetch(
            `${team.server.baseUrl}/api/v1/artifacts/${first.body.artifact.id}/content-sessions?projectId=${created.id}`,
            {headers: browserMutationHeaders(team.server.baseUrl, member), method: "POST"},
          ),
        ]);
        expect(session.status).toBe(201);
        const issued = bootstrapResponseSchema.parse(await session.json());
        const exchange = await fetchVersion(team.server, issued.bootstrapUrl);
        expect(exchange.status).toBe(200);
        const contentCookie = (exchange.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
        const content = await fetchVersion(
          team.server,
          second.body.links.version,
          "GET",
          {Cookie: contentCookie},
        );
        return {
          comparison: {body: await comparison.text(), status: comparison.status},
          content: {body: await content.text(), status: content.status},
          details: {body: await details.text(), status: details.status},
        };
      };
      const beforeArchive = await readAsMember();
      expect(beforeArchive.details.status).toBe(200);
      expect(JSON.parse(beforeArchive.details.body)).toMatchObject({
        artifact: {
          accessSetting: "account_required",
          id: first.body.artifact.id,
          projectId: created.id,
        },
        current: {version: {id: second.body.version.id, projectId: created.id}},
      });
      expect(beforeArchive.comparison.status).toBe(200);
      expect(JSON.parse(beforeArchive.comparison.body)).toMatchObject({
        artifact: {id: first.body.artifact.id},
        changed: [expect.objectContaining({after: expect.objectContaining({path: "index.html"})})],
      });
      expect(beforeArchive.content).toEqual({
        body: "<!doctype html><title>Members only</title><p>second</p>",
        status: 200,
      });

      const archived = await fetch(
        `${team.server.baseUrl}/api/v1/projects/${created.id}/archive`,
        {headers: bearerJsonHeaders(adminToken), method: "POST"},
      );
      expect(archived.status).toBe(200);
      expect(projectResponseSchema.parse(await archived.json()).project.archivedAt)
        .not.toBeNull();

      expect(await readAsMember()).toEqual(beforeArchive);

      const rejectedNewArtifacts = await Promise.all([
        bearerJsonHeaders(adminToken),
        browserMutationHeaders(team.server.baseUrl, member),
      ].map(async (headers) => {
        const response = await fetch(`${team.server.baseUrl}/api/v1/uploads`, {
          body: JSON.stringify({
            entryPath: "index.html",
            files: [emptyDeclaredFile],
            projectId: created.id,
          }),
          headers,
          method: "POST",
        });
        return {body: errorBodySchema.parse(await response.json()), status: response.status};
      }));
      expect(rejectedNewArtifacts).toEqual([
        {body: {error: expect.objectContaining({code: "PROJECT_ARCHIVED"})}, status: 409},
        {body: {error: expect.objectContaining({code: "PROJECT_ARCHIVED"})}, status: 409},
      ]);
      const lateVersion = await fetch(pending.body.commitUrl, {
        body: JSON.stringify({
          target: {
            artifactId: first.body.artifact.id,
            expectedCurrentVersionId: second.body.version.id,
            kind: "new_version",
          },
        }),
        headers: apiHeaders(team.installation, "membership-late-version"),
        method: "POST",
      });
      expect(lateVersion.status).toBe(409);
      await expect(lateVersion.json()).resolves.toMatchObject({
        error: {code: "PROJECT_ARCHIVED"},
      });
      const lateArtifact = await fetch(pending.body.commitUrl, {
        body: JSON.stringify({
          target: {accessSetting: "account_required", kind: "new_artifact", name: "Must not exist"},
        }),
        headers: apiHeaders(team.installation, "membership-late-artifact"),
        method: "POST",
      });
      expect(lateArtifact.status).toBe(409);
      await expect(lateArtifact.json()).resolves.toMatchObject({
        error: {code: "PROJECT_ARCHIVED"},
      });

      const [versions, listed] = await Promise.all([
        fetch(
          `${team.server.baseUrl}/api/v1/artifacts/${first.body.artifact.id}/versions?projectId=${created.id}`,
          {headers: {Cookie: member.header}},
        ),
        fetch(
          `${team.server.baseUrl}/api/v1/artifacts?projectId=${created.id}`,
          {headers: {Cookie: member.header}},
        ),
      ]);
      expect(versions.status).toBe(200);
      expect(versionListSchema.parse(await versions.json()).versions
        .map((entry) => entry.version.id).toSorted())
        .toEqual([first.body.version.id, second.body.version.id].toSorted());
      expect(artifactListSchema.parse(await listed.json()).artifacts
        .map((entry) => entry.artifact.id)).toEqual([first.body.artifact.id]);
    } finally {
      await team.stop();
    }
  }, 30_000);

  test("PRJ-003-F: projects carry no hidden member list or ACL, and archive leaves every artifact, version, link, manifest, and action record unchanged", async () => {
    const team = await startTeamInstallation();
    try {
      const adminToken = team.installation.apiToken;
      const hiddenAccessFields: readonly McpParameters[] = [
        {members: ["outsider@example.test"]},
        {memberIds: ["mem_outsider"]},
        {acl: [{principal: "outsider@example.test", role: "reader"}]},
        {accessControlList: []},
        {visibility: "private"},
        {owners: [teamAdministratorEmail]},
      ];
      const creationAttempts = await Promise.all(hiddenAccessFields.map(async (field) => {
        const [http, mcp] = await Promise.all([
          fetch(`${team.server.baseUrl}/api/v1/projects`, {
            body: JSON.stringify({name: "Hidden ACL", ...field}),
            headers: bearerJsonHeaders(adminToken),
            method: "POST",
          }),
          mcpToolCall(team.server, adminToken, "project_create", {name: "Hidden ACL", ...field}),
        ]);
        return {field: JSON.stringify(field), httpStatus: http.status, mcpFailed: mcp.isError};
      }));
      for (const attempt of creationAttempts) {
        expect(attempt).toEqual({
          field: attempt.field,
          httpStatus: 422,
          mcpFailed: true,
        });
      }
      expect(await listProjects(team.server, adminToken)).toEqual([
        expect.objectContaining({id: defaultProjectId}),
      ]);

      const created = await createProject(team.server, adminToken, "Archive invariants");
      const renameStatuses = await Promise.all(hiddenAccessFields.map(async (field) =>
        (await fetch(`${team.server.baseUrl}/api/v1/projects/${created.id}`, {
          body: JSON.stringify({name: "Hidden ACL", ...field}),
          headers: bearerJsonHeaders(adminToken),
          method: "PATCH",
        })).status
      ));
      expect(renameStatuses).toEqual(hiddenAccessFields.map(() => 422));

      const privateArtifact = await publishNew(team.server, team.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><p>private first</p>",
        idempotencyKey: "archive-invariants-private-first",
        name: "Private invariant",
        projectId: created.id,
        tags: ["invariant"],
      });
      const privateSecond = await publishVersion(team.server, team.installation, {
        artifactId: privateArtifact.body.artifact.id,
        content: "<!doctype html><p>private second</p>",
        expectedCurrentVersionId: privateArtifact.body.version.id,
        idempotencyKey: "archive-invariants-private-second",
        projectId: created.id,
      });
      const publicArtifact = await publishNew(team.server, team.installation, {
        accessSetting: "public_link",
        content: "<!doctype html><p>public link</p>",
        idempotencyKey: "archive-invariants-public",
        name: "Public invariant",
        projectId: created.id,
      });

      const lateMemberEmail = "late-member@example.test";
      const administrator = await team.login(teamAdministratorEmail, "team-administrator");
      const admitted = await fetch(`${team.server.baseUrl}/api/v1/members`, {
        body: JSON.stringify({displayName: "Late member", email: lateMemberEmail}),
        headers: browserMutationHeaders(team.server.baseUrl, administrator),
        method: "POST",
      });
      expect(admitted.status).toBe(201);
      const lateMember = memberResponseSchema.parse(await admitted.json()).member;
      const memberCookies = await team.login(lateMemberEmail, "late-member");
      const memberRead = async (): Promise<number> => (await fetch(
        `${team.server.baseUrl}/api/v1/artifacts/${privateArtifact.body.artifact.id}?projectId=${created.id}`,
        {headers: {Cookie: memberCookies.header}},
      )).status;
      expect(await memberRead()).toBe(200);
      const outsider = await team.loginAttempt("outsider@example.test", "outsider");
      expect(outsider.status).toBe(403);
      await expect(outsider.json()).resolves.toMatchObject({
        error: {code: "IDENTITY_ADMISSION_DENIED"},
      });

      const snapshot = (): Promise<RecordSnapshot> => snapshotProjectRecords(
        team.server,
        adminToken,
        created.id,
        [privateArtifact.body, publicArtifact.body],
      );
      const before = await snapshot();
      const privateId = privateArtifact.body.artifact.id;
      expect(JSON.parse(before.get(`${privateId}:details`) ?? "null")).toMatchObject({
        artifact: {
          accessSetting: "account_required",
          currentVersionId: privateSecond.body.version.id,
          deletedAt: null,
          projectId: created.id,
          tags: ["invariant"],
        },
      });
      expect(JSON.parse(
        before.get(`${privateId}:${privateArtifact.body.version.id}`) ?? "null",
      )).toMatchObject({
        links: {version: privateArtifact.body.links.version},
        manifest: {
          digest: privateArtifact.body.version.manifestDigest,
          entries: [expect.objectContaining({path: "index.html"})],
        },
        version: {id: privateArtifact.body.version.id, projectId: created.id},
      });
      expect(before.get(`${privateId}:${privateArtifact.body.version.id}:file`))
        .toBe("<!doctype html><p>private first</p>");
      expect(JSON.parse(before.get(`${privateId}:actions`) ?? "null")).toMatchObject({
        actions: [
          expect.objectContaining({projectId: created.id, versionId: privateSecond.body.version.id}),
          expect.objectContaining({projectId: created.id, versionId: privateArtifact.body.version.id}),
        ],
      });
      expect(before.get("public-link")).toBe("200 <!doctype html><p>public link</p>");
      expect(before.get("private-link-anonymous")).toBe("401");

      const changeLifecycle = async (lifecycle: "archive" | "unarchive"): Promise<void> => {
        const changed = await fetch(
          `${team.server.baseUrl}/api/v1/projects/${created.id}/${lifecycle}`,
          {headers: bearerJsonHeaders(adminToken), method: "POST"},
        );
        expect(changed.status).toBe(200);
        expect(await snapshot()).toEqual(before);
      };
      await changeLifecycle("archive");
      await changeLifecycle("archive");
      await changeLifecycle("unarchive");
      await changeLifecycle("archive");
      const archivedProject = projectResponseSchema.parse(await (await authorizedFetch(
        team.server,
        adminToken,
        `/api/v1/projects/${created.id}`,
      )).json()).project;
      expect(archivedProject).toEqual({...created, archivedAt: expect.any(String)});
      expect(await memberRead()).toBe(200);

      const deactivated = await fetch(
        `${team.server.baseUrl}/api/v1/members/${lateMember.id}/deactivate`,
        {headers: browserMutationHeaders(team.server.baseUrl, administrator), method: "POST"},
      );
      expect(deactivated.status).toBe(200);
      expect(await memberRead()).toBe(401);
      expect(await snapshot()).toEqual(before);
    } finally {
      await team.stop();
    }
  }, 30_000);

  function apiFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${installation.apiToken}`);
    return fetch(`${server.baseUrl}${pathname}`, {...init, headers});
  }
});

const emptyDeclaredFile = {
  mediaType: "text/html",
  path: "index.html",
  sha256: "0".repeat(64),
  size: 0,
} as const;

interface McpParameters {
  readonly [key: string]: McpParameterValue;
}

type McpParameterValue =
  | boolean
  | number
  | string
  | null
  | readonly McpParameterValue[]
  | McpParameters;

interface MemberReads {
  readonly comparison: {readonly body: string; readonly status: number};
  readonly content: {readonly body: string; readonly status: number};
  readonly details: {readonly body: string; readonly status: number};
}

/** Stable text of every record archive must leave untouched, keyed by record. */
type RecordSnapshot = ReadonlyMap<string, string>;

interface StableDefaultSubject {
  readonly label: string;
  readonly restart: () => Promise<RunningTestServer>;
  readonly running: RunningTestServer;
  readonly token: string;
}

/**
 * Observe one default project across restarts, create a second project, and
 * prove both persist in that installation. Returns the created project.
 */
async function proveStableDefaultProject(
  subject: StableDefaultSubject,
): Promise<z.infer<typeof projectSchema>> {
  const initial = await listProjects(subject.running, subject.token);
  expect(initial).toEqual([{
    archivedAt: null,
    createdAt: expect.any(String),
    id: defaultProjectId,
    name: "Default",
  }]);
  const defaultProject = initial[0];

  const restarted = await subject.restart();
  expect(await listProjects(restarted, subject.token))
    .toEqual([defaultProject]);

  const created = await createProject(restarted, subject.token, `${subject.label} second project`);
  expect(created.id).not.toBe(defaultProjectId);
  const both = await listProjects(restarted, subject.token);
  expect(both).toHaveLength(2);
  expect(both).toEqual(expect.arrayContaining([defaultProject, created]));
  expect((await mcpToolCall(restarted, subject.token, "project_list", {}))
    .structuredContent).toEqual({
    projects: expect.arrayContaining([
      expect.objectContaining({id: defaultProjectId}),
      expect.objectContaining({id: created.id}),
    ]),
  });

  const afterSecondRestart = await subject.restart();
  const persisted = await listProjects(afterSecondRestart, subject.token);
  expect(persisted).toHaveLength(2);
  expect(persisted).toEqual(expect.arrayContaining([defaultProject, created]));
  return created;
}

/** Capture the exact response text of every artifact-facing record in one project. */
async function snapshotProjectRecords(
  server: RunningTestServer,
  token: string,
  projectId: string,
  published: ReadonlyArray<PublishResponse>,
): Promise<RecordSnapshot> {
  const scoped = `projectId=${projectId}`;
  const textAt = async (pathname: string): Promise<string> => {
    const response = await authorizedFetch(server, token, pathname);
    expect(response.status).toBe(200);
    return response.text();
  };
  const perArtifact = await Promise.all(published.map(async (publication) => {
    const base = `/api/v1/artifacts/${publication.artifact.id}`;
    const [details, versionsText, actions] = await Promise.all([
      textAt(`${base}?${scoped}`),
      textAt(`${base}/versions?${scoped}`),
      textAt(`${base}/actions?${scoped}`),
    ]);
    const perVersion = await Promise.all(
      versionListSchema.parse(JSON.parse(versionsText)).versions.map(async ({version}) => {
        const [versionDetails, file] = await Promise.all([
          textAt(`${base}/versions/${version.id}?${scoped}`),
          textAt(`${base}/versions/${version.id}/file?${scoped}&path=index.html`),
        ]);
        return [
          [`${publication.artifact.id}:${version.id}`, versionDetails],
          [`${publication.artifact.id}:${version.id}:file`, file],
        ] as const;
      }),
    );
    return [
      [`${publication.artifact.id}:details`, details],
      [`${publication.artifact.id}:versions`, versionsText],
      [`${publication.artifact.id}:actions`, actions],
      ...perVersion.flat(),
    ] as const;
  }));
  const linkSnapshots = await Promise.all(published.map(async (publication) => {
    const anonymous = await fetchVersion(server, publication.links.version);
    const body = anonymous.status === 200 ? ` ${await anonymous.text()}` : "";
    return [
      publication.artifact.accessSetting === "public_link"
        ? "public-link"
        : "private-link-anonymous",
      `${anonymous.status}${body}`,
    ] as const;
  }));
  return new Map<string, string>([
    ...perArtifact.flat(),
    ...linkSnapshots,
    ["artifacts", await textAt(`/api/v1/artifacts?${scoped}`)],
  ]);
}

interface TeamCookies {
  readonly csrf: string;
  readonly header: string;
}

interface RunningTeamInstallation {
  readonly installation: TestInstallation;
  readonly server: RunningTestServer;
  login(email: string, subject: string): Promise<TeamCookies>;
  loginAttempt(email: string, subject: string): Promise<Response>;
  restart(): Promise<RunningTestServer>;
  stop(): Promise<void>;
}

/** Start a private-team installation whose browser login is a scripted OIDC provider. */
async function startTeamInstallation(): Promise<RunningTeamInstallation> {
  const installation = await createTestInstallation();
  const provider = new ScriptedIdentityProvider({
    displayName: "Team administrator",
    email: teamAdministratorEmail,
    emailVerified: true,
    provider: "test-oidc",
    subject: "team-administrator",
  });
  const options = {
    bootstrapAdministratorEmail: teamAdministratorEmail,
    browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
    interactiveIdentityProvider: provider,
  } as const;
  let server = await startTestServer(installation, options);
  const loginAttempt = async (email: string, subject: string): Promise<Response> => {
    provider.identity = {...provider.identity, displayName: subject, email, subject};
    const started = await fetch(`${server.baseUrl}/auth/login`, {redirect: "manual"});
    expect(started.status).toBe(302);
    const callback = new URL("/auth/callback", server.baseUrl);
    callback.searchParams.set("code", provider.authorizationCode);
    callback.searchParams.set("state", provider.authorization.state);
    return fetch(callback, {
      headers: {Cookie: loginHandshakeCookie(started)},
      redirect: "manual",
    });
  };
  return {
    installation,
    login: async (email, subject) => {
      const completed = await loginAttempt(email, subject);
      expect(completed.status).toBe(303);
      return teamCookies(completed.headers.getSetCookie());
    },
    loginAttempt,
    restart: async () => {
      await server.stop();
      server = await startTestServer(installation, options);
      return server;
    },
    get server() {
      return server;
    },
    stop: async () => {
      await server.stop();
      await removeTestInstallation(installation);
    },
  };
}

class ScriptedIdentityProvider implements InteractiveIdentityProvider {
  authorization: InteractiveAuthorization = {
    authorizationUrl: "https://identity.example/authorize",
    codeVerifier: "project-test-code-verifier-with-sufficient-entropy",
    nonce: null,
    state: "project-test-login-state-with-sufficient-entropy-0",
  };
  readonly authorizationCode = "project-test-authorization-code";
  readonly name = "test-oidc";
  identity: ExternalIdentity;
  #startCount = 0;

  constructor(identity: ExternalIdentity) {
    this.identity = identity;
  }

  readonly complete = (
    code: string,
  ): Effect.Effect<ExternalIdentity, IdentityProviderFailure> =>
    code === this.authorizationCode
      ? Effect.succeed(this.identity)
      : Effect.die(new Error("The scripted provider received an unexpected code."));

  readonly start = (): Effect.Effect<InteractiveAuthorization, IdentityProviderFailure> => {
    this.#startCount += 1;
    this.authorization = {
      ...this.authorization,
      state: `project-test-login-state-with-sufficient-entropy-${this.#startCount}`,
    };
    return Effect.succeed(this.authorization);
  };
}

function teamCookies(setCookieHeaders: readonly string[]): TeamCookies {
  const pair = (prefix: string): string => {
    const header = setCookieHeaders.find((value) => value.startsWith(prefix));
    const value = header?.split(";", 1)[0];
    if (value === undefined) throw new Error(`The login did not issue ${prefix}.`);
    return value;
  };
  const session = pair("artifact_session=");
  const csrf = pair("artifact_csrf=");
  return {csrf: csrf.slice(csrf.indexOf("=") + 1), header: `${session}; ${csrf}`};
}

function browserMutationHeaders(origin: string, cookies: TeamCookies): Headers {
  return new Headers({
    "Content-Type": "application/json",
    Cookie: cookies.header,
    Origin: origin,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": cookies.csrf,
  });
}

function bearerJsonHeaders(token: string): Headers {
  return new Headers({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  });
}

function authorizedFetch(
  server: RunningTestServer,
  token: string,
  pathname: string,
): Promise<Response> {
  return fetch(`${server.baseUrl}${pathname}`, {
    headers: {Authorization: `Bearer ${token}`},
  });
}

async function createProject(
  server: RunningTestServer,
  token: string,
  name: string,
): Promise<z.infer<typeof projectSchema>> {
  const response = await fetch(`${server.baseUrl}/api/v1/projects`, {
    body: JSON.stringify({name}),
    headers: bearerJsonHeaders(token),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return projectResponseSchema.parse(await response.json()).project;
}

async function listProjects(
  server: RunningTestServer,
  token: string,
): Promise<z.infer<typeof projectSchema>[]> {
  const response = await authorizedFetch(server, token, "/api/v1/projects");
  expect(response.status).toBe(200);
  return projectListSchema.parse(await response.json()).projects;
}

/** Status and body text with the probed identifier replaced, for existence-signal comparison. */
async function redactedFailure(
  response: Response,
  projectId: string,
): Promise<{readonly body: string; readonly status: number}> {
  return {
    body: (await response.text()).replaceAll(projectId, "<project>"),
    status: response.status,
  };
}

async function mcpListTools(
  server: RunningTestServer,
  token: string,
): Promise<z.infer<typeof mcpToolListSchema>["result"]["tools"]> {
  const response = await mcpRequest(server, token, "tools/list", {});
  expect(response.status).toBe(200);
  return mcpToolListSchema.parse(await response.json()).result.tools;
}

async function mcpToolCall(
  server: RunningTestServer,
  token: string,
  name: string,
  toolArguments: McpParameters,
): Promise<z.infer<typeof mcpToolCallSchema>["result"]> {
  const response = await mcpRequest(server, token, "tools/call", {
    arguments: toolArguments,
    name,
  }, {"Mcp-Name": name});
  expect(response.status).toBe(200);
  return mcpToolCallSchema.parse(await response.json()).result;
}

function mcpRequest(
  server: RunningTestServer,
  token: string,
  method: string,
  parameters: McpParameters,
  additionalHeaders: HeadersInit = {},
): Promise<Response> {
  const headers = new Headers(additionalHeaders);
  headers.set("Accept", "application/json, text/event-stream");
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");
  headers.set("MCP-Protocol-Version", mcpProtocolVersion);
  headers.set("Mcp-Method", method);
  return fetch(`${server.baseUrl}/mcp`, {
    body: JSON.stringify({
      id: crypto.randomUUID(),
      jsonrpc: "2.0",
      method,
      params: {
        ...parameters,
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: {name: "artifact-server-project-test", version: "1"},
          [PROTOCOL_VERSION_META_KEY]: mcpProtocolVersion,
        },
      },
    }),
    headers,
    method: "POST",
  });
}

function failMissingUploadFile(): never {
  throw new Error("The project upload plan omitted its declared file.");
}
