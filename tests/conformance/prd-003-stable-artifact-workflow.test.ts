import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {publishNew, publishVersion} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {childProcessIds} from "../support/server-activity.js";

const comparisonSchema = z.object({
  changed: z.array(z.object({after: z.object({path: z.string()}).loose()}).loose()),
  from: z.object({id: z.string()}).loose(),
  to: z.object({id: z.string()}).loose(),
}).loose();

const accessChangeSchema = z.object({
  artifact: z.object({accessSetting: z.string(), id: z.string(), projectId: z.string()}).loose(),
  links: z.object({version: z.url()}).loose(),
}).loose();

const artifactListSchema = z.object({
  artifacts: z.array(z.object({artifact: z.object({id: z.string()}).loose()}).loose()),
}).loose();

const projectListSchema = z.object({
  projects: z.array(z.object({id: z.string()}).loose()),
}).loose();

const currentSchema = z.object({
  artifact: z.object({currentVersionId: z.string()}).loose(),
}).loose();

const bootstrapSchema = z.object({bootstrapUrl: z.url()}).loose();

interface WorkflowResult {
  readonly artifactIds: readonly string[];
  readonly comparedVersionIds: readonly string[];
  readonly projectIds: readonly string[];
  readonly publicOpenStatus: number;
  readonly versionHosts: readonly string[];
}

describe("one artifact identity carries the whole publish, open, compare, and share workflow", () => {
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

  async function api(route: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${installation.apiToken}`);
    return fetch(new URL(route, server.baseUrl), {...init, headers});
  }

  /** Publish, open privately, publish again, compare, share, and open publicly. */
  async function runWorkflow(label: string): Promise<WorkflowResult> {
    const first = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Draft</title><p>first</p>",
      idempotencyKey: "prd-003-workflow-first-version",
      name: "Launch plan",
    });
    const artifactId = first.body.artifact.id;

    const session = bootstrapSchema.parse(await (await api(
      `/api/v1/artifacts/${artifactId}/versions/${first.body.version.id}/content-sessions`,
      {method: "POST"},
    )).json());
    const exchange = await fetchVersion(server, session.bootstrapUrl);
    expect(exchange.status).toBe(200);
    const cookie = exchange.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
    const privateOpen = await fetchVersion(server, first.body.links.version, "GET", {Cookie: cookie});
    expect(privateOpen.status).toBe(200);
    expect(await privateOpen.text()).toContain("first");

    const current = currentSchema.parse(await (await api(`/api/v1/artifacts/${artifactId}`)).json());
    const second = await publishVersion(server, installation, {
      artifactId,
      content: `<!doctype html><title>Draft</title><p>second ${label}</p>`,
      expectedCurrentVersionId: current.artifact.currentVersionId,
      idempotencyKey: `prd-003-workflow-second-${label}`,
    });
    const comparison = comparisonSchema.parse(await (await api(
      `/api/v1/artifacts/${artifactId}/comparisons?${new URLSearchParams({
        fromVersionId: first.body.version.id,
        toVersionId: second.body.version.id,
      })}`,
    )).json());
    expect(comparison.changed.map((entry) => entry.after.path)).toEqual(["index.html"]);

    const shared = await api(`/api/v1/artifacts/${artifactId}/access`, {
      body: JSON.stringify({
        accessSetting: "public_link",
        expectedCurrentVersionId: second.body.version.id,
      }),
      headers: {"Content-Type": "application/json", "Idempotency-Key": `prd-003-share-${label}`},
      method: "PATCH",
    });
    expect(shared.status).toBe(200);
    const access = accessChangeSchema.parse(await shared.json());
    const publicOpen = await fetch(new URL(`/artifacts/${artifactId}`, server.baseUrl), {
      redirect: "manual",
    });
    expect(publicOpen.headers.get("location")).toBe(access.links.version);
    const publicContent = await fetchVersion(server, access.links.version);
    expect(await publicContent.text()).toContain(`second ${label}`);

    return {
      artifactIds: [
        first.body.artifact.id,
        second.body.artifact.id,
        access.artifact.id,
      ],
      comparedVersionIds: [comparison.from.id, comparison.to.id],
      projectIds: [first.body.version.projectId, second.body.version.projectId, access.artifact.projectId],
      publicOpenStatus: publicContent.status,
      versionHosts: [new URL(first.body.links.version).host, new URL(access.links.version).host],
    };
  }

  test("PRD-003-B: publish, open, compare, and visibility run against one stable artifact identity in its project", async () => {
    const result = await runWorkflow("once");
    const [artifactId] = result.artifactIds;
    expect(result.artifactIds).toEqual([artifactId, artifactId, artifactId]);
    expect(result.projectIds).toEqual(["prj_default", "prj_default", "prj_default"]);
    expect(result.publicOpenStatus).toBe(200);
    // Each saved version is served from the same server under its own
    // content host; publishing created no separate hosting target.
    expect(new Set(result.versionHosts).size).toBe(2);
    for (const host of result.versionHosts) {
      expect(host.endsWith(`.localhost:${server.port}`)).toBe(true);
    }
  });

  test("PRD-003-F: repeating the workflow creates no new deployment, project, or artifact identity", async () => {
    const childrenBefore = await childProcessIds();
    const projectsBefore = projectListSchema.parse(await (await api("/api/v1/projects")).json())
      .projects.map((project) => project.id);
    const first = await runWorkflow("first-run");
    const second = await runWorkflow("second-run");

    // The replayed first publish returns the same artifact, and every later
    // step stays on it.
    expect(new Set([...first.artifactIds, ...second.artifactIds]).size).toBe(1);
    const listed = artifactListSchema.parse(await (await api("/api/v1/artifacts")).json());
    expect(listed.artifacts.map((entry) => entry.artifact.id)).toEqual([first.artifactIds[0]]);
    const projectsAfter = projectListSchema.parse(await (await api("/api/v1/projects")).json())
      .projects.map((project) => project.id);
    expect(projectsAfter).toEqual(projectsBefore);
    // No separate hosting process or listener was started for the artifact.
    expect(await childProcessIds()).toEqual(childrenBefore);
    expect([...first.versionHosts, ...second.versionHosts]
      .every((host) => host.endsWith(`.localhost:${server.port}`))).toBe(true);
  });
});
