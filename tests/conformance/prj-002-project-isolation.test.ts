import {createHash, randomBytes, randomUUID} from "node:crypto";
import {cp, mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {Effect} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  checkCompactIntegrity,
  type IntegrityReport,
} from "../../src/lifecycle/integrity-check.js";
import {
  createStagedUpload,
  publishNew,
  publishVersion,
  testSiteFile,
} from "../support/publishing.js";
import {
  apiHeaders,
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const protocolVersion = "2026-07-28";
const jsonValueSchema = z.json();
const toolCallResultSchema = z.object({
  result: z.object({
    content: z.array(z.object({text: z.string(), type: z.literal("text")})),
    isError: z.boolean().optional(),
    structuredContent: jsonValueSchema.optional(),
  }).loose(),
}).loose();
const projectResponseSchema = z.object({
  project: z.object({id: z.string(), name: z.string()}).loose(),
});
const projectListSchema = z.object({
  projects: z.array(z.object({id: z.string(), name: z.string()}).loose()),
});
const artifactPageSchema = z.object({
  artifacts: z.array(z.object({
    artifact: z.object({id: z.string(), name: z.string(), projectId: z.string()}).loose(),
  }).loose()),
  nextCursor: z.string().nullable(),
});
const artifactDetailsSchema = z.object({
  artifact: z.object({
    accessSetting: z.string(),
    currentVersionId: z.string(),
    id: z.string(),
    projectId: z.string(),
    tags: z.array(z.string()),
  }).loose(),
  current: z.object({
    version: z.object({id: z.string(), projectId: z.string()}).loose(),
  }).loose(),
}).loose();
const httpVersionListSchema = z.object({
  versions: z.array(z.object({
    version: z.object({id: z.string(), projectId: z.string()}).loose(),
  }).loose()),
}).loose();
const mcpVersionListSchema = z.object({
  versions: z.array(z.object({id: z.string()}).loose()),
}).loose();
const actionPageSchema = z.object({
  actions: z.array(z.object({
    action: z.string(),
    artifactId: z.string(),
    id: z.string(),
    projectId: z.string(),
    versionId: z.string(),
  }).loose()),
  nextCursor: z.string().nullable(),
});
const stateSchema = z.object({
  artifact: z.object({
    accessSetting: z.string(),
    currentVersionId: z.string(),
    id: z.string(),
    projectId: z.string(),
    tags: z.array(z.string()),
  }).loose(),
}).loose();
const comparisonSchema = z.object({
  from: z.object({id: z.string()}).loose(),
  to: z.object({id: z.string()}).loose(),
}).loose();
const mcpUploadPlanSchema = z.object({
  files: z.array(z.object({path: z.string(), uploadUrl: z.url()}).loose()),
  kind: z.literal("upload"),
  projectId: z.string(),
  uploadId: z.string(),
}).loose();
const mcpPublicationSchema = z.object({
  artifact: z.object({
    currentVersionId: z.string(),
    id: z.string(),
    projectId: z.string(),
  }).loose(),
  replayed: z.boolean(),
  version: z.object({id: z.string(), projectId: z.string()}).loose(),
}).loose();
const mcpStateSchema = z.object({
  artifact: z.object({
    accessSetting: z.string(),
    currentVersionId: z.string(),
    id: z.string(),
    projectId: z.string(),
    tags: z.array(z.string()),
  }).loose(),
}).loose();
const bootstrapResponseSchema = z.object({bootstrapUrl: z.url()}).loose();

type JsonValue = z.infer<typeof jsonValueSchema>;
interface ToolArguments {
  readonly [name: string]: JsonValue;
}

interface ProbeResult {
  readonly body: string;
  readonly status: number;
}

const otherInstallationToken =
  "as_key_key_00000000-0000-4000-8000-000000000002_otherInstallationTokenWithEntropy4567";

describe("project-scoped repositories, HTTP, MCP, audit, and backups", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  const cleanups: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await cleanups.splice(0).toReversed().reduce(
      (previous, cleanup) => previous.then(cleanup),
      Promise.resolve(),
    );
    await removeTestInstallation(installation);
  });

  test("PRJ-002-B: publish, list, read, compare, restore, change, audit, back up, and restore inside named projects through HTTP and MCP", async () => {
    const alpha = await createProject(server, installation, "Alpha");
    const beta = await createProject(server, installation, "Beta");

    // HTTP publishes two versions into Alpha.
    const alphaFirst = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Alpha one</title>",
      idempotencyKey: "prj-002-b-alpha-first",
      name: "Alpha artifact",
      projectId: alpha,
    });
    expect(alphaFirst.response.status).toBe(201);
    const alphaSecond = await publishVersion(server, installation, {
      artifactId: alphaFirst.body.artifact.id,
      content: "<!doctype html><title>Alpha two</title>",
      expectedCurrentVersionId: alphaFirst.body.version.id,
      idempotencyKey: "prj-002-b-alpha-second",
      projectId: alpha,
    });
    for (const published of [alphaFirst.body, alphaSecond.body]) {
      expect(published.artifact.projectId).toBe(alpha);
      expect(published.version.projectId).toBe(alpha);
    }

    // MCP publishes two versions into Beta.
    const betaFirst = await mcpPublish(server, installation.apiToken, {
      content: "<!doctype html><title>Beta one</title>",
      idempotencyKey: "prj-002-b-beta-first",
      projectId: beta,
      target: {
        accessSetting: "account_required",
        kind: "new_artifact",
        name: "Beta artifact",
        tags: [],
      },
    });
    const betaSecond = await mcpPublish(server, installation.apiToken, {
      content: "<!doctype html><title>Beta two</title>",
      idempotencyKey: "prj-002-b-beta-second",
      projectId: beta,
      target: {
        artifactId: betaFirst.artifact.id,
        expectedCurrentVersionId: betaFirst.version.id,
        kind: "new_version",
      },
    });
    for (const published of [betaFirst, betaSecond]) {
      expect(published.artifact.projectId).toBe(beta);
      expect(published.version.projectId).toBe(beta);
    }
    const alphaId = alphaFirst.body.artifact.id;
    const betaId = betaFirst.artifact.id;

    // List: each project lists only its own artifact through HTTP and MCP.
    await Promise.all(([[alpha, alphaId], [beta, betaId]] as const).map(async ([projectId, artifactId]) => {
      const httpPage = artifactPageSchema.parse(await (await apiFetch(
        server,
        installation.apiToken,
        `/api/v1/artifacts?projectId=${projectId}`,
      )).json());
      expect(httpPage.artifacts.map((item) => [item.artifact.id, item.artifact.projectId]))
        .toEqual([[artifactId, projectId]]);
      const mcpPage = z.object({
        artifacts: z.array(z.object({id: z.string(), projectId: z.string()}).loose()),
      }).loose().parse(await successfulTool(server, installation.apiToken, "artifact_list", {
        cursor: null,
        limit: 10,
        projectId,
        tag: null,
      }));
      expect(mcpPage.artifacts.map((item) => [item.id, item.projectId]))
        .toEqual([[artifactId, projectId]]);
    }));

    // Read: details and version lists carry the named project through both surfaces.
    const alphaDetails = artifactDetailsSchema.parse(await (await apiFetch(
      server,
      installation.apiToken,
      `/api/v1/artifacts/${alphaId}?projectId=${alpha}`,
    )).json());
    expect(alphaDetails.artifact.projectId).toBe(alpha);
    expect(alphaDetails.current.version).toMatchObject({
      id: alphaSecond.body.version.id,
      projectId: alpha,
    });
    const betaDetails = artifactDetailsSchema.parse(await successfulTool(
      server,
      installation.apiToken,
      "artifact_get",
      {artifactId: betaId, projectId: beta},
    ));
    expect(betaDetails.artifact.projectId).toBe(beta);
    expect(betaDetails.current.version).toMatchObject({
      id: betaSecond.version.id,
      projectId: beta,
    });
    const alphaVersions = httpVersionListSchema.parse(await (await apiFetch(
      server,
      installation.apiToken,
      `/api/v1/artifacts/${alphaId}/versions?projectId=${alpha}`,
    )).json());
    expect(alphaVersions.versions.map(({version}) => [version.id, version.projectId]))
      .toEqual([[alphaSecond.body.version.id, alpha], [alphaFirst.body.version.id, alpha]]);
    const betaVersions = mcpVersionListSchema.parse(await successfulTool(
      server,
      installation.apiToken,
      "artifact_version_list",
      {artifactId: betaId, projectId: beta},
    ));
    expect(betaVersions.versions.map((version) => version.id))
      .toEqual([betaSecond.version.id, betaFirst.version.id]);

    // Compare: HTTP comparison in Alpha, MCP diff in Beta.
    const alphaComparison = comparisonSchema.parse(await (await apiFetch(
      server,
      installation.apiToken,
      `/api/v1/artifacts/${alphaId}/comparisons?projectId=${alpha}` +
        `&fromVersionId=${alphaFirst.body.version.id}&toVersionId=${alphaSecond.body.version.id}`,
    )).json());
    expect([alphaComparison.from.id, alphaComparison.to.id])
      .toEqual([alphaFirst.body.version.id, alphaSecond.body.version.id]);
    const betaComparison = comparisonSchema.parse(await successfulTool(
      server,
      installation.apiToken,
      "artifact_diff",
      {
        artifactId: betaId,
        fromVersionId: betaFirst.version.id,
        projectId: beta,
        toVersionId: betaSecond.version.id,
      },
    ));
    expect([betaComparison.from.id, betaComparison.to.id])
      .toEqual([betaFirst.version.id, betaSecond.version.id]);

    // Restore a historical version: HTTP in Alpha, MCP in Beta.
    const alphaRestored = stateSchema.parse(await (await apiFetch(
      server,
      installation.apiToken,
      `/api/v1/artifacts/${alphaId}/restore?projectId=${alpha}`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId: alphaSecond.body.version.id,
          versionId: alphaFirst.body.version.id,
        }),
        headers: apiHeaders(installation, "prj-002-b-alpha-restore"),
        method: "POST",
      },
    )).json());
    expect(alphaRestored.artifact).toMatchObject({
      currentVersionId: alphaFirst.body.version.id,
      projectId: alpha,
    });
    const betaRestored = mcpStateSchema.parse(await successfulTool(
      server,
      installation.apiToken,
      "artifact_restore_version",
      {
        artifactId: betaId,
        expectedCurrentVersionId: betaSecond.version.id,
        idempotencyKey: "prj-002-b-beta-restore",
        projectId: beta,
        versionId: betaFirst.version.id,
      },
    ));
    expect(betaRestored.artifact).toMatchObject({
      currentVersionId: betaFirst.version.id,
      projectId: beta,
    });

    // Change tags and access: HTTP in Alpha, MCP in Beta.
    const alphaTagged = stateSchema.parse(await (await apiFetch(
      server,
      installation.apiToken,
      `/api/v1/artifacts/${alphaId}/tags?projectId=${alpha}`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId: alphaFirst.body.version.id,
          tags: ["alpha-tag"],
        }),
        headers: apiHeaders(installation, "prj-002-b-alpha-tags"),
        method: "PATCH",
      },
    )).json());
    expect(alphaTagged.artifact).toMatchObject({projectId: alpha, tags: ["alpha-tag"]});
    const alphaPublic = stateSchema.parse(await (await apiFetch(
      server,
      installation.apiToken,
      `/api/v1/artifacts/${alphaId}/access?projectId=${alpha}`,
      {
        body: JSON.stringify({
          accessSetting: "public_link",
          expectedCurrentVersionId: alphaFirst.body.version.id,
        }),
        headers: apiHeaders(installation, "prj-002-b-alpha-access"),
        method: "PATCH",
      },
    )).json());
    expect(alphaPublic.artifact).toMatchObject({accessSetting: "public_link", projectId: alpha});
    const betaTagged = mcpStateSchema.parse(await successfulTool(
      server,
      installation.apiToken,
      "artifact_set_tags",
      {
        artifactId: betaId,
        expectedCurrentVersionId: betaFirst.version.id,
        idempotencyKey: "prj-002-b-beta-tags",
        projectId: beta,
        tags: ["beta-tag"],
      },
    ));
    expect(betaTagged.artifact).toMatchObject({projectId: beta, tags: ["beta-tag"]});
    const betaPublic = mcpStateSchema.parse(await successfulTool(
      server,
      installation.apiToken,
      "artifact_set_visibility",
      {
        accessSetting: "public_link",
        artifactId: betaId,
        expectedCurrentVersionId: betaFirst.version.id,
        idempotencyKey: "prj-002-b-beta-access",
        projectId: beta,
      },
    ));
    expect(betaPublic.artifact).toMatchObject({accessSetting: "public_link", projectId: beta});

    // Audit: every HTTP and MCP operation is recorded inside its own project.
    await Promise.all(([[alpha, alphaId], [beta, betaId]] as const).map(async ([projectId, artifactId]) => {
      const audit = actionPageSchema.parse(await (await apiFetch(
        server,
        installation.apiToken,
        `/api/v1/artifacts/${artifactId}/actions?projectId=${projectId}`,
      )).json());
      expect(audit.actions.map((action) => action.action).toSorted()).toEqual([
        "change_access",
        "change_tags",
        "publish",
        "publish",
        "restore",
      ]);
      expect(new Set(audit.actions.map((action) => action.projectId)))
        .toEqual(new Set([projectId]));
      expect(new Set(audit.actions.map((action) => action.artifactId)))
        .toEqual(new Set([artifactId]));
    }));

    // Back up the stopped installation, verify the copy, and restore it.
    const versionsByProject = [
      {artifactId: alphaId, projectId: alpha, versions: [alphaFirst.body, alphaSecond.body]},
      {artifactId: betaId, projectId: beta, versions: [betaFirst, betaSecond]},
    ] as const;
    const before = await installationSnapshot(server, installation.apiToken, versionsByProject);
    const restored = await backUpAndRestore(server, installation, cleanups);
    server = restored.server;
    const after = await installationSnapshot(server, installation.apiToken, versionsByProject);
    expect(after).toEqual(before);
    expect(restored.integrity).toMatchObject({
      artifactsChecked: 2,
      problems: [],
      status: "healthy",
      versionsChecked: 4,
    });
    await Promise.all(versionsByProject.map(async ({artifactId, projectId}) => {
      const details = artifactDetailsSchema.parse(await successfulTool(
        server,
        installation.apiToken,
        "artifact_get",
        {artifactId, projectId},
      ));
      expect(details.artifact).toMatchObject({id: artifactId, projectId});
    }));
  }, 60_000);

  test("PRJ-002-F: cross-project and cross-installation attempts fail without revealing which identifier exists", async () => {
    const alpha = await createProject(server, installation, "Alpha");
    const beta = await createProject(server, installation, "Beta");
    const alphaFirst = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Alpha one</title>",
      idempotencyKey: "shared-idempotency-key",
      name: "Alpha confidential",
      projectId: alpha,
    });
    const alphaSecond = await publishVersion(server, installation, {
      artifactId: alphaFirst.body.artifact.id,
      content: "<!doctype html><title>Alpha two</title>",
      expectedCurrentVersionId: alphaFirst.body.version.id,
      idempotencyKey: "prj-002-f-alpha-second",
      projectId: alpha,
    });
    const betaFirst = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Beta secret</title>",
      idempotencyKey: "prj-002-f-beta-first",
      name: "Beta quarterly plan",
      projectId: beta,
    });

    // A second installation with its own credential, project, and artifact.
    const other: TestInstallation = {
      ...(await createTestInstallation()),
      apiToken: otherInstallationToken,
    };
    const otherServer = await startTestServer(other);
    cleanups.push(async () => {
      await otherServer.stop();
      await removeTestInstallation(other);
    });
    const gamma = await createProject(otherServer, other, "Gamma");
    const gammaArtifact = await publishNew(otherServer, other, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Gamma</title>",
      idempotencyKey: "prj-002-f-gamma-publish",
      name: "Gamma artifact",
      projectId: gamma,
    });

    const alphaId = alphaFirst.body.artifact.id;
    const alphaCurrent = alphaSecond.body.version.id;
    const foreignArtifacts = [betaFirst.body.artifact.id, gammaArtifact.body.artifact.id];
    const foreignVersions = [betaFirst.body.version.id, gammaArtifact.body.version.id];
    const missingArtifact = `art_${randomUUID()}`;
    const missingVersion = `ver_${randomUUID()}`;
    const missingProject = `prj_${randomUUID()}`;

    // Idempotency: the key Alpha used is independent in Beta, and never replays Alpha.
    const betaReuse = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Beta reuses a key</title>",
      idempotencyKey: "shared-idempotency-key",
      name: "Beta reused key",
      projectId: beta,
    });
    expect(betaReuse.response.status).toBe(201);
    expect(betaReuse.body.replayed).toBe(false);
    expect(betaReuse.body.artifact.projectId).toBe(beta);
    expect(betaReuse.body.artifact.id).not.toBe(alphaId);
    expect(betaReuse.body.version.id).not.toBe(alphaFirst.body.version.id);

    const probes = createProbes(server, installation.apiToken);

    // Every probe gets the same answer for a foreign identifier and a missing one.
    const artifactProbes: ReadonlyArray<readonly [string, (id: string) => Promise<ProbeResult>]> = [
      ["read", (id) => probes.http(`/api/v1/artifacts/${id}?projectId=${alpha}`)],
      ["versions", (id) => probes.http(`/api/v1/artifacts/${id}/versions?projectId=${alpha}`)],
      ["audit", (id) => probes.http(`/api/v1/artifacts/${id}/actions?projectId=${alpha}`)],
      ["content session", (id) => probes.http(
        `/api/v1/artifacts/${id}/content-sessions?projectId=${alpha}`,
        {method: "POST"},
      )],
      ["access change", (id) => probes.http(
        `/api/v1/artifacts/${id}/access?projectId=${alpha}`,
        {
          body: JSON.stringify({accessSetting: "public_link", expectedCurrentVersionId: alphaCurrent}),
          headers: apiHeaders(installation, `prj-002-f-access-${randomUUID()}`),
          method: "PATCH",
        },
      )],
      ["tag change", (id) => probes.http(
        `/api/v1/artifacts/${id}/tags?projectId=${alpha}`,
        {
          body: JSON.stringify({expectedCurrentVersionId: alphaCurrent, tags: ["leak"]}),
          headers: apiHeaders(installation, `prj-002-f-tags-${randomUUID()}`),
          method: "PATCH",
        },
      )],
      ["delete", (id) => probes.http(
        `/api/v1/artifacts/${id}?projectId=${alpha}`,
        {
          body: JSON.stringify({expectedCurrentVersionId: alphaCurrent}),
          headers: apiHeaders(installation, `prj-002-f-delete-${randomUUID()}`),
          method: "DELETE",
        },
      )],
      ["mcp artifact_get", (id) => probes.mcp("artifact_get", {artifactId: id, projectId: alpha})],
      ["mcp artifact_version_list", (id) =>
        probes.mcp("artifact_version_list", {artifactId: id, projectId: alpha})],
      ["mcp artifact_set_visibility", (id) => probes.mcp("artifact_set_visibility", {
        accessSetting: "public_link",
        artifactId: id,
        expectedCurrentVersionId: alphaCurrent,
        idempotencyKey: `prj-002-f-mcp-access-${randomUUID()}`,
        projectId: alpha,
      })],
    ];
    await Promise.all(artifactProbes.map(([name, probe]) =>
      expectIndistinguishable(name, probe, foreignArtifacts, missingArtifact)));

    const alphaFirstVersion = alphaFirst.body.version.id;
    const versionProbes: ReadonlyArray<readonly [string, (id: string) => Promise<ProbeResult>]> = [
      ["version read", (id) =>
        probes.http(`/api/v1/artifacts/${alphaId}/versions/${id}?projectId=${alpha}`)],
      ["version file", (id) => probes.http(
        `/api/v1/artifacts/${alphaId}/versions/${id}/file?path=index.html&projectId=${alpha}`,
      )],
      ["comparison", (id) => probes.http(
        `/api/v1/artifacts/${alphaId}/comparisons?projectId=${alpha}` +
          `&fromVersionId=${alphaFirstVersion}&toVersionId=${id}`,
      )],
      ["version content session", (id) => probes.http(
        `/api/v1/artifacts/${alphaId}/versions/${id}/content-sessions?projectId=${alpha}`,
        {method: "POST"},
      )],
      ["version restore", (id) => probes.http(
        `/api/v1/artifacts/${alphaId}/restore?projectId=${alpha}`,
        {
          body: JSON.stringify({expectedCurrentVersionId: alphaCurrent, versionId: id}),
          headers: apiHeaders(installation, `prj-002-f-restore-${randomUUID()}`),
          method: "POST",
        },
      )],
      ["mcp artifact_diff", (id) => probes.mcp("artifact_diff", {
        artifactId: alphaId,
        fromVersionId: alphaFirstVersion,
        projectId: alpha,
        toVersionId: id,
      })],
      ["mcp artifact_restore_version", (id) => probes.mcp("artifact_restore_version", {
        artifactId: alphaId,
        expectedCurrentVersionId: alphaCurrent,
        idempotencyKey: `prj-002-f-mcp-restore-${randomUUID()}`,
        projectId: alpha,
        versionId: id,
      })],
    ];
    await Promise.all(versionProbes.map(([name, probe]) =>
      expectIndistinguishable(name, probe, foreignVersions, missingVersion)));

    // Project selection: another installation's project equals a project that never existed.
    const projectProbes: ReadonlyArray<readonly [string, (id: string) => Promise<ProbeResult>]> = [
      ["project read", (id) => probes.http(`/api/v1/projects/${id}`)],
      ["list", (id) => probes.http(`/api/v1/artifacts?projectId=${id}`)],
      ["search", (id) => probes.http(`/api/v1/artifacts?projectId=${id}&search=Gamma`)],
      ["upload plan", (id) => probes.http("/api/v1/uploads", {
        body: JSON.stringify(uploadPlanBody(id)),
        headers: {"Content-Type": "application/json"},
        method: "POST",
      })],
      ["cross-installation artifact read", (id) =>
        probes.http(`/api/v1/artifacts/${gammaArtifact.body.artifact.id}?projectId=${id}`)],
      ["mcp artifact_list", (id) => probes.mcp("artifact_list", {
        cursor: null,
        limit: 10,
        projectId: id,
        tag: null,
      })],
      ["mcp artifact_create_upload", (id) => probes.mcp("artifact_create_upload", {
        ...uploadPlanBody(id),
      })],
    ];
    await Promise.all(projectProbes.map(([name, probe]) =>
      expectIndistinguishable(name, probe, [gamma], missingProject)));

    // Search inside Alpha never surfaces Beta's names or another installation's.
    const betaNameSearch = await probes.http(
      `/api/v1/artifacts?projectId=${alpha}&search=${encodeURIComponent("quarterly plan")}`,
    );
    const absentNameSearch = await probes.http(
      `/api/v1/artifacts?projectId=${alpha}&search=${encodeURIComponent("never named anything")}`,
    );
    expect(betaNameSearch).toEqual(absentNameSearch);
    expect(artifactPageSchema.parse(JSON.parse(betaNameSearch.body)).artifacts).toEqual([]);

    // Uploads: an Alpha upload is invisible under Beta, another installation, or a missing project.
    const declared = testSiteFile("<!doctype html><title>Alpha upload</title>");
    const alphaUpload = await createStagedUpload(server, installation, "index.html", [declared], alpha);
    const plannedFile = alphaUpload.body.files[0];
    if (plannedFile === undefined) throw new Error("The upload plan omitted its file.");
    const scopedUrl = (issued: string, uploadId: string, projectId: string) => {
      const url = new URL(issued.replace(alphaUpload.body.uploadId, uploadId));
      url.searchParams.set("projectId", projectId);
      return url;
    };
    const putBytes = async (url: URL) => readProbe(await fetch(url, {
      body: Buffer.from(declared.bytes),
      headers: {Authorization: `Bearer ${installation.apiToken}`},
      method: "PUT",
    }));
    const commit = async (url: URL) => readProbe(await fetch(url, {
      body: JSON.stringify({
        target: {accessSetting: "account_required", kind: "new_artifact", name: "Hijack"},
      }),
      headers: apiHeaders(installation, `prj-002-f-commit-${randomUUID()}`),
      method: "POST",
    }));
    // Inside this installation, Beta answers for Alpha's real upload exactly as for no upload.
    await expectIndistinguishable(
      "upload bytes under another project",
      (uploadId) => putBytes(scopedUrl(plannedFile.uploadUrl, uploadId, beta)),
      [alphaUpload.body.uploadId],
      `upl_${randomUUID()}`,
    );
    await expectIndistinguishable(
      "upload commit under another project",
      (uploadId) => commit(scopedUrl(alphaUpload.body.commitUrl, uploadId, beta)),
      [alphaUpload.body.uploadId],
      `upl_${randomUUID()}`,
    );
    // Another installation's project answers exactly as a project that never existed.
    await expectIndistinguishable(
      "upload bytes under another installation's project",
      (projectId) => putBytes(scopedUrl(plannedFile.uploadUrl, alphaUpload.body.uploadId, projectId)),
      [gamma],
      missingProject,
    );
    await expectIndistinguishable(
      "upload commit under another installation's project",
      (projectId) => commit(scopedUrl(alphaUpload.body.commitUrl, alphaUpload.body.uploadId, projectId)),
      [gamma],
      missingProject,
    );
    expect((await putBytes(new URL(plannedFile.uploadUrl))).status).toBe(200);
    await expectIndistinguishable(
      "upload commit into a foreign artifact",
      (id) => fetch(alphaUpload.body.commitUrl, {
        body: JSON.stringify({
          target: {artifactId: id, expectedCurrentVersionId: alphaCurrent, kind: "new_version"},
        }),
        headers: apiHeaders(installation, `prj-002-f-version-commit-${randomUUID()}`),
        method: "POST",
      }).then(readProbe),
      foreignArtifacts,
      missingArtifact,
    );

    // Keys: another installation's valid credential is just an unknown credential here.
    const bogusToken =
      `as_key_key_${randomUUID()}_${randomBytes(30).toString("base64url")}`;
    await Promise.all([
      "/api/v1/projects",
      `/api/v1/artifacts/${alphaId}?projectId=${alpha}`,
    ].map(async (pathname) => {
      const [foreignKey, unknownKey] = await Promise.all([other.apiToken, bogusToken].map(
        async (token) => readProbe(await apiFetch(server, token, pathname)),
      ));
      expect(foreignKey?.status).toBe(401);
      expect(foreignKey).toEqual(unknownKey);
    }));
    const foreignMcpKey = await mcpRequest(server, other.apiToken, "tools/call", {
      arguments: {artifactId: alphaId, projectId: alpha},
      name: "artifact_get",
    });
    const unknownMcpKey = await mcpRequest(server, bogusToken, "tools/call", {
      arguments: {artifactId: alphaId, projectId: alpha},
      name: "artifact_get",
    });
    expect(foreignMcpKey.status).toBe(401);
    expect(await readProbe(foreignMcpKey)).toEqual(await readProbe(unknownMcpKey));

    // Content sessions: an Alpha content cookie never opens Beta's private version.
    const issued = bootstrapResponseSchema.parse(await (await apiFetch(
      server,
      installation.apiToken,
      `/api/v1/artifacts/${alphaId}/content-sessions?projectId=${alpha}`,
      {method: "POST"},
    )).json());
    const exchange = await fetchVersion(server, issued.bootstrapUrl);
    const alphaCookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
    if (alphaCookie === undefined) throw new Error("The content session set no cookie.");
    expect((await fetchVersion(server, alphaSecond.body.links.version, "GET", {Cookie: alphaCookie}))
      .status).toBe(200);
    const betaWithAlphaCookie = await readProbe(
      await fetchVersion(server, betaFirst.body.links.version, "GET", {Cookie: alphaCookie}),
    );
    const betaWithoutCookie = await readProbe(
      await fetchVersion(server, betaFirst.body.links.version),
    );
    expect(betaWithAlphaCookie.status).toBe(401);
    expect(betaWithAlphaCookie).toEqual(betaWithoutCookie);

    // Backup and restore: the restored installation keeps every boundary.
    const restored = await backUpAndRestore(server, installation, cleanups);
    server = restored.server;
    const restoredProbes = createProbes(server, installation.apiToken);
    await expectIndistinguishable(
      "restored read",
      (id) => restoredProbes.http(`/api/v1/artifacts/${id}?projectId=${alpha}`),
      foreignArtifacts,
      missingArtifact,
    );
    await expectIndistinguishable(
      "restored restore",
      (id) => restoredProbes.http(`/api/v1/artifacts/${alphaId}/restore?projectId=${alpha}`, {
        body: JSON.stringify({expectedCurrentVersionId: alphaCurrent, versionId: id}),
        headers: apiHeaders(installation, `prj-002-f-restored-restore-${randomUUID()}`),
        method: "POST",
      }),
      foreignVersions,
      missingVersion,
    );
    await expectIndistinguishable(
      "restored audit",
      (id) => restoredProbes.http(`/api/v1/artifacts/${id}/actions?projectId=${alpha}`),
      foreignArtifacts,
      missingArtifact,
    );
    await expectIndistinguishable(
      "restored list",
      (id) => restoredProbes.http(`/api/v1/artifacts?projectId=${id}`),
      [gamma],
      missingProject,
    );
    const restoredForeignKey = await readProbe(await fetch(`${server.baseUrl}/api/v1/projects`, {
      headers: {Authorization: `Bearer ${other.apiToken}`},
    }));
    expect(restoredForeignKey.status).toBe(401);
    expect(restoredForeignKey).toEqual(await readProbe(await fetch(
      `${server.baseUrl}/api/v1/projects`,
      {headers: {Authorization: `Bearer ${bogusToken}`}},
    )));
    expect(projectListSchema.parse(await (await apiFetch(
      server,
      installation.apiToken,
      "/api/v1/projects",
    )).json()).projects.map((project) => project.id)).not.toContain(gamma);
  }, 60_000);
});

async function expectIndistinguishable(
  name: string,
  probe: (id: string) => Promise<ProbeResult>,
  foreignIds: readonly string[],
  missingId: string,
): Promise<void> {
  const missing = normalize(await probe(missingId), [missingId]);
  expect(missing.status, `${name} must fail for a missing identifier`).toBeGreaterThanOrEqual(400);
  const foreign = await Promise.all(foreignIds.map(async (foreignId) => ({
    foreignId,
    result: normalize(await probe(foreignId), [foreignId]),
  })));
  for (const {foreignId, result} of foreign) {
    expect(result, `${name} must not reveal that ${foreignId} exists`).toEqual(missing);
  }
}

function normalize(result: ProbeResult, identifiers: readonly string[]): ProbeResult {
  const body = identifiers.reduce(
    (text, identifier) => text.replaceAll(identifier, "<probed>"),
    result.body,
  );
  return {body, status: result.status};
}

async function readProbe(response: Response): Promise<ProbeResult> {
  return {body: await response.text(), status: response.status};
}

function createProbes(server: RunningTestServer, token: string) {
  return {
    http: async (pathname: string, init: RequestInit = {}): Promise<ProbeResult> =>
      readProbe(await apiFetch(server, token, pathname, init)),
    mcp: async (name: string, toolArguments: ToolArguments): Promise<ProbeResult> => {
      const result = await callTool(server, token, name, toolArguments);
      return {
        body: JSON.stringify({content: result.content, isError: result.isError}),
        status: result.isError === true ? 404 : 200,
      };
    },
  };
}

function uploadPlanBody(projectId: string) {
  const file = testSiteFile("<!doctype html><title>Probe upload</title>");
  return {
    entryPath: file.path,
    files: [{mediaType: file.mediaType, path: file.path, sha256: file.sha256, size: file.size}],
    projectId,
  };
}

async function backUpAndRestore(
  server: RunningTestServer,
  installation: TestInstallation,
  cleanups: Array<() => Promise<void>>,
): Promise<{
  readonly integrity: IntegrityReport;
  readonly server: RunningTestServer;
}> {
  await server.stop();
  const restoredDirectory = await mkdtemp(path.join(tmpdir(), "artifact-server-restore-"));
  cleanups.push(() => rm(restoredDirectory, {force: true, recursive: true}));
  await cp(installation.dataDirectory, restoredDirectory, {recursive: true});
  const integrity = await Effect.runPromise(checkCompactIntegrity(restoredDirectory));
  const restoredServer = await startTestServer({...installation, dataDirectory: restoredDirectory});
  return {integrity, server: restoredServer};
}

interface SnapshotScope {
  readonly artifactId: string;
  readonly projectId: string;
  readonly versions: ReadonlyArray<{readonly version: {readonly id: string}}>;
}

/** Read every project-scoped record and file fingerprint, with the per-process port removed. */
async function installationSnapshot(
  server: RunningTestServer,
  token: string,
  scopes: readonly SnapshotScope[],
): Promise<string> {
  const read = async (pathname: string): Promise<string> => {
    const response = await apiFetch(server, token, pathname);
    expect(response.status, `${pathname} must be readable`).toBe(200);
    return (await response.text()).replaceAll(`:${server.port}/`, ":<port>/");
  };
  const fingerprint = async (pathname: string): Promise<string> => {
    const response = await apiFetch(server, token, pathname);
    expect(response.status, `${pathname} must be readable`).toBe(200);
    return createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
  };
  const perProject = await Promise.all(scopes.map(async ({artifactId, projectId, versions}) => {
    const scope = `projectId=${projectId}`;
    const artifactPath = `/api/v1/artifacts/${artifactId}`;
    const [actions, details, list, versionList, ...files] = await Promise.all([
      read(`${artifactPath}/actions?${scope}`),
      read(`${artifactPath}?${scope}`),
      read(`/api/v1/artifacts?${scope}`),
      read(`${artifactPath}/versions?${scope}`),
      ...versions.map(({version}) =>
        fingerprint(`${artifactPath}/versions/${version.id}/file?path=index.html&${scope}`)),
    ]);
    return {actions, details, files, list, versions: versionList};
  }));
  return JSON.stringify({perProject, projects: await read("/api/v1/projects")});
}

async function createProject(
  server: RunningTestServer,
  installation: TestInstallation,
  name: string,
): Promise<string> {
  const response = await fetch(`${server.baseUrl}/api/v1/projects`, {
    body: JSON.stringify({name}),
    headers: apiHeaders(installation, `prj-002-project-${randomUUID()}`),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return projectResponseSchema.parse(await response.json()).project.id;
}

function apiFetch(
  server: RunningTestServer,
  token: string,
  pathname: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${server.baseUrl}${pathname}`, {...init, headers});
}

async function mcpPublish(
  server: RunningTestServer,
  token: string,
  input: {
    readonly content: string;
    readonly idempotencyKey: string;
    readonly projectId: string;
    readonly target: ToolArguments;
  },
) {
  const file = testSiteFile(input.content);
  const plan = mcpUploadPlanSchema.parse(await successfulTool(server, token, "artifact_create_upload", {
    entryPath: file.path,
    files: [{mediaType: file.mediaType, path: file.path, sha256: file.sha256, size: file.size}],
    projectId: input.projectId,
  }));
  expect(plan.projectId).toBe(input.projectId);
  const uploads = await Promise.all(plan.files.map((planned) =>
    fetch(planned.uploadUrl, {body: Buffer.from(file.bytes), method: "PUT"})));
  expect(uploads.map((uploaded) => uploaded.status)).toEqual([200]);
  return mcpPublicationSchema.parse(await successfulTool(server, token, "artifact_commit_upload", {
    idempotencyKey: input.idempotencyKey,
    projectId: input.projectId,
    target: input.target,
    uploadId: plan.uploadId,
  }));
}

async function successfulTool(
  server: RunningTestServer,
  token: string,
  name: string,
  toolArguments: ToolArguments,
): Promise<JsonValue | undefined> {
  const result = await callTool(server, token, name, toolArguments);
  expect(result.isError, `${name}: ${result.content[0]?.text ?? ""}`).not.toBe(true);
  return result.structuredContent;
}

async function callTool(
  server: RunningTestServer,
  token: string,
  name: string,
  toolArguments: ToolArguments,
) {
  const response = await mcpRequest(server, token, "tools/call", {arguments: toolArguments, name});
  expect(response.status).toBe(200);
  return toolCallResultSchema.parse(await response.json()).result;
}

function mcpRequest(
  server: RunningTestServer,
  token: string,
  method: string,
  parameters: {readonly arguments: ToolArguments; readonly name: string},
): Promise<Response> {
  return fetch(`${server.baseUrl}/mcp`, {
    body: JSON.stringify({
      id: randomUUID(),
      jsonrpc: "2.0",
      method,
      params: {
        ...parameters,
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: {name: "artifact-server-test", version: "1"},
          [PROTOCOL_VERSION_META_KEY]: protocolVersion,
        },
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": protocolVersion,
      "Mcp-Method": method,
      "Mcp-Name": parameters.name,
    },
    method: "POST",
  });
}
