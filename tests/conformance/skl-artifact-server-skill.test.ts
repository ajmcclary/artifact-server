import {spawn} from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {Effect, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {BearerCredentialVerifier} from
  "../../src/application/authentication.js";
import {AuthenticationRequired} from "../../src/core/errors.js";
import {
  membershipRoles,
  principalKinds,
  type Principal,
} from "../../src/core/identity.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const skillsRoot = path.join(repositoryRoot, "skills");
const skillName = "artifact-server";
const cliExecutable = path.join(repositoryRoot, "node_modules/.bin/tsx");
const cliEntrypoint = path.join(repositoryRoot, "src/cli/main.ts");
const protocolVersion = "2026-07-28";
const memberCredential = "skill-route-member-credential-0123456789abcdef";
const administratorCredential =
  "skill-route-administrator-credential-0123456789abcdef";

const artifactReferences = [
  "references/artifact-operations.md",
  "references/target-selection.md",
] as const;
const serverReference = "references/server-operations.md";
const failureReference = "references/failures-and-compatibility.md";
/**
 * The one MCP tool the skill does not route: it is the agent-bridge mailbox
 * documented by docs/agent-bridge-protocol.md and driven by bridge adapters,
 * not by an agent following the skill.
 */
const bridgeOwnedTools = new Set(["dispatch_inbox"]);
/** Commands the server route names only to say Artifact Server lacks them. */
const documentedAbsentCommands: readonly string[] = ["deploy"];
const routineCredentialOptions = [
  ["--profile", "team"],
  ["--server", "http://127.0.0.1:9"],
  ["--token-file", "/nonexistent/routine-token"],
] as const;

const memberPrincipal: Principal = {
  authorizedByPrincipalId: null,
  capabilities: [],
  displayName: "Morgan Member",
  id: "member_skill_route",
  installationId: "local",
  kind: principalKinds.human,
  membershipRole: membershipRoles.member,
};
const administratorPrincipal: Principal = {
  authorizedByPrincipalId: null,
  capabilities: [],
  displayName: "Avery Administrator",
  id: "administrator_skill_route",
  installationId: "local",
  kind: principalKinds.human,
  membershipRole: membershipRoles.administrator,
};
const routeVerifier: BearerCredentialVerifier = {
  verify: (credential) => {
    const presented = Redacted.value(credential);
    if (presented === memberCredential) return Effect.succeed(memberPrincipal);
    if (presented === administratorCredential) {
      return Effect.succeed(administratorPrincipal);
    }
    return Effect.fail(new AuthenticationRequired({
      message: "The skill route credential is invalid.",
    }));
  },
};

const toolListSchema = z.object({
  result: z.object({
    tools: z.array(z.object({name: z.string()}).loose()),
  }).loose(),
}).loose();
const toolCallSchema = z.object({
  result: z.object({
    content: z.array(z.object({text: z.string(), type: z.literal("text")})),
    isError: z.boolean().optional(),
    structuredContent: z.unknown(),
  }).loose(),
}).loose();
const artifactRecordSchema = z.object({
  accessSetting: z.enum(["account_required", "public_link"]),
  currentVersionId: z.string(),
  id: z.string(),
  name: z.string(),
  projectId: z.string(),
  tags: z.array(z.string()),
}).loose();
const cliPublicationSchema = z.object({
  artifact: artifactRecordSchema,
  links: z.object({artifact: z.url(), review: z.url(), version: z.url()}),
  version: z.object({
    id: z.string(),
    number: z.number().int().positive(),
    publisherPrincipalId: z.string(),
  }).loose(),
}).loose();
const mcpArtifactSchema = z.object({
  artifact: artifactRecordSchema,
  current: z.object({
    links: z.object({review: z.url(), version: z.url()}),
    version: z.object({id: z.string(), publisherPrincipalId: z.string()}).loose(),
  }).loose(),
}).loose();
const httpArtifactSchema = z.object({
  artifact: artifactRecordSchema,
}).loose();
const mcpStateSchema = z.object({artifact: artifactRecordSchema}).loose();
const comparedPathsSchema = z.object({
  added: z.array(z.object({path: z.string()}).loose()),
  changed: z.array(z.object({
    after: z.object({path: z.string()}).loose(),
  }).loose()),
  removed: z.array(z.object({path: z.string()}).loose()),
}).loose();

describe("the shipped artifact-server skill", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation, {
      externalApiBearerVerifier: routeVerifier,
      externalMcpBearerVerifier: routeVerifier,
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("SKL-001-B: one portable skill installs with valid metadata and routes artifact, review, project, and server-operation work to existing references", async () => {
    const discovered = await discoverSkills(skillsRoot);
    expect(discovered).toEqual([skillName]);

    const installRoot = await mkdtemp(
      path.join(tmpdir(), "artifact-server-skill-install-"),
    );
    try {
      const installed = path.join(installRoot, ".agents", "skills", skillName);
      await cp(path.join(skillsRoot, skillName), installed, {recursive: true});
      expect(await discoverSkills(path.dirname(installed))).toEqual([skillName]);

      const skill = parseSkillDocument(
        await readFile(path.join(installed, "SKILL.md"), "utf8"),
      );
      expect([...skill.frontmatter.keys()].toSorted()).toEqual([
        "description",
        "name",
      ]);
      const name = skill.frontmatter.get("name") ?? "";
      expect(name).toBe(path.basename(installed));
      expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
      expect(name.length).toBeLessThanOrEqual(64);
      const description = skill.frontmatter.get("description") ?? "";
      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(1_024);
      expect(skill.body.split("\n").length).toBeLessThan(500);

      // Every link the installed copy follows stays inside it, one level
      // deep, and every shipped reference is reachable from the entrypoint.
      const entrypointLinks = markdownLinks(skill.body);
      const shippedReferences = (await readdir(path.join(installed, "references")))
        .map((file) => `references/${file}`)
        .toSorted();
      expect([...new Set(entrypointLinks)].toSorted()).toEqual(shippedReferences);
      await Promise.all(entrypointLinks.map(async (link) => {
        const target = path.resolve(installed, link);
        expect(path.relative(installed, target)).toBe(link);
        expect(link.split("/")).toHaveLength(2);
        expect((await stat(target)).isFile()).toBe(true);
      }));

      // Each request class has its own reference set and no reference is
      // shared between the routine, administrator, and failure routes.
      const routes = routeTable(skill.body);
      expect(routes.map((route) => route.references)).toEqual([
        [...artifactReferences],
        [serverReference],
        [failureReference],
      ]);

      // The routine route resolves artifact, review, and project work to
      // tools this installation actually advertises to an ordinary member.
      const advertised = await listTools(memberCredential);
      const routineTools = new Set((await Promise.all(
        artifactReferences.map(async (reference) =>
          namedTools(await readFile(path.join(installed, reference), "utf8"))
        ),
      )).flat());
      for (const family of ["artifact_", "comment_", "project_"]) {
        expect([...routineTools].some((tool) => tool.startsWith(family))).toBe(true);
      }
      expect([...routineTools].filter((tool) => !advertised.has(tool))).toEqual([]);

      // Both routes name only CLI commands this release implements.
      const routineCommands = await commandsNamedBy(installed, [
        ...artifactReferences,
        failureReference,
      ]);
      const serverCommands = await administratorCommandsOf(installed);
      expect(routineCommands).toContain("publish");
      expect(serverCommands).toContain("integrity check");
      // The server route says no generic deploy command exists; hold the
      // CLI to that statement so the reference cannot drift from it.
      const absent = await Promise.all(documentedAbsentCommands.map((command) =>
        runCli(command.split(" "))
      ));
      expect(absent.map((result) => ({
        exitCode: result.exitCode,
        refused: result.stderr.startsWith("error: unknown command"),
      }))).toEqual(documentedAbsentCommands.map(() => ({exitCode: 1, refused: true})));
      const help = await Promise.all(
        [...routineCommands, ...serverCommands].map(async (command) => ({
          command,
          result: await runCli([...command.split(" "), "--help"]),
        })),
      );
      expect(help.filter(({command, result}) =>
        result.exitCode !== 0
        || !result.stdout.startsWith(`Usage: artifactserver ${command} `)
      ).map(({command}) => command)).toEqual([]);
    } finally {
      await rm(installRoot, {force: true, recursive: true});
    }
  }, 60_000);

  test("SKL-001-F: routine artifact references never reach server-operation instructions or name an installation command", async () => {
    const skillRoot = path.join(skillsRoot, skillName);
    const skill = parseSkillDocument(
      await readFile(path.join(skillRoot, "SKILL.md"), "utf8"),
    );
    const routes = routeTable(skill.body);
    const serverRoutes = routes.filter((route) =>
      route.references.includes(serverReference)
    );
    expect(serverRoutes).toHaveLength(1);

    // Follow every link a routine request can load, transitively.
    const routineRoots = routes
      .filter((route) => !route.references.includes(serverReference))
      .flatMap((route) => route.references);
    const loadable = await reachableReferences(skillRoot, routineRoots);
    expect(loadable).toContain(artifactReferences[0]);
    expect(loadable).toContain(failureReference);
    expect(loadable).not.toContain(serverReference);

    const administratorCommands = await administratorCommandsOf(skillRoot);
    const routineCommands = await commandsNamedBy(skillRoot, loadable);
    expect(administratorCommands.length).toBeGreaterThan(0);
    expect(routineCommands.filter((command) =>
      administratorCommands.includes(command)
    )).toEqual([]);

    // The routine references name no MCP tool the administrator route owns,
    // and the administrator route never directs work through MCP.
    const serverText = await readFile(path.join(skillRoot, serverReference), "utf8");
    expect(namedTools(serverText)).toEqual([]);
  }, 30_000);

  test("SKL-002-B: a member completes local-file publishing through the CLI and server-only artifact work through MCP with HTTP-equivalent results", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "artifact-server-skill-route-"),
    );
    try {
      const profileData = path.join(workspace, "profiles");
      const source = path.join(workspace, "report");
      await mkdir(source);
      await writeFile(path.join(source, "index.html"), "<h1>Quarterly report</h1>");
      const environment = await credentialHelperEnvironment(workspace);
      const origin = server.baseUrl;

      const login = await runCli([
        "auth",
        "login",
        origin,
        "--api-key-stdin",
        "--name",
        "team",
        "--profile-data",
        profileData,
      ], environment, `${memberCredential}\n`);
      expect({exitCode: login.exitCode, stderr: login.stderr}).toEqual({
        exitCode: 0,
        stderr: "",
      });

      const projects = z.object({
        projects: z.array(z.object({id: z.string()}).loose()),
      }).parse(await callTool(memberCredential, "project_list", {}));
      const projectId = projects.projects[0]?.id ?? "";
      expect(projects.projects).toHaveLength(1);

      const created = await runCli([
        "publish",
        source,
        "--profile",
        "team",
        "--server",
        origin,
        "--project",
        projectId,
        "--name",
        "Quarterly report",
        "--profile-data",
        profileData,
      ], environment);
      expect({exitCode: created.exitCode, stderr: created.stderr}).toEqual({
        exitCode: 0,
        stderr: "",
      });
      const first = cliPublicationSchema.parse(JSON.parse(created.stdout));
      expect(first.artifact.accessSetting).toBe("account_required");
      expect(first.version.publisherPrincipalId).toBe(memberPrincipal.id);
      const artifactId = first.artifact.id;

      const beforeUpdate = mcpArtifactSchema.parse(await callTool(
        memberCredential,
        "artifact_get",
        {artifactId, projectId},
      ));
      expect(beforeUpdate.current.version.id).toBe(first.version.id);
      expect(beforeUpdate.current.links.review).toBe(first.links.review);
      expect(beforeUpdate.artifact).toEqual(
        (await readArtifactOverHttp(artifactId, projectId)).artifact,
      );

      await writeFile(path.join(source, "index.html"), "<h1>Quarterly report, revised</h1>");
      const updated = await runCli([
        "publish",
        source,
        "--profile",
        "team",
        "--server",
        origin,
        "--project",
        projectId,
        "--artifact",
        artifactId,
        "--expected-version",
        beforeUpdate.current.version.id,
        "--profile-data",
        profileData,
      ], environment);
      expect({exitCode: updated.exitCode, stderr: updated.stderr}).toEqual({
        exitCode: 0,
        stderr: "",
      });
      const second = cliPublicationSchema.parse(JSON.parse(updated.stdout));
      expect(second.artifact.id).toBe(artifactId);
      expect(second.version.number).toBe(2);

      const mcpVersions = z.object({
        versions: z.array(z.object({id: z.string()}).loose()),
      }).parse(await callTool(memberCredential, "artifact_version_list", {
        artifactId,
        projectId,
      }));
      const httpVersions = z.object({
        versions: z.array(z.object({
          version: z.object({id: z.string()}).loose(),
        }).loose()),
      }).parse(await apiJson(
        "GET",
        `/api/v1/artifacts/${artifactId}/versions?projectId=${projectId}`,
      ));
      expect(mcpVersions.versions.map((version) => version.id)).toEqual([
        second.version.id,
        first.version.id,
      ]);
      expect(httpVersions.versions.map((entry) => entry.version.id))
        .toEqual(mcpVersions.versions.map((version) => version.id));

      const mcpComparison = comparedPathsSchema.parse(await callTool(
        memberCredential,
        "artifact_diff",
        {
          artifactId,
          fromVersionId: first.version.id,
          projectId,
          toVersionId: second.version.id,
        },
      ));
      const httpComparison = comparedPathsSchema.parse(await apiJson(
        "GET",
        `/api/v1/artifacts/${artifactId}/comparisons?projectId=${projectId}`
          + `&fromVersionId=${first.version.id}&toVersionId=${second.version.id}`,
      ));
      expect(comparedPaths(mcpComparison)).toEqual({
        added: [],
        changed: ["index.html"],
        removed: [],
      });
      expect(comparedPaths(httpComparison)).toEqual(comparedPaths(mcpComparison));

      const opened = z.object({
        reviewUrl: z.url(),
        versionId: z.string(),
      }).loose().parse(await callTool(memberCredential, "artifact_open", {
        artifactId,
        projectId,
        versionId: first.version.id,
      }));
      expect(opened).toMatchObject({
        reviewUrl: first.links.review,
        versionId: first.version.id,
      });

      const shared = mcpStateSchema.parse(await callTool(
        memberCredential,
        "artifact_set_visibility",
        {
          accessSetting: "public_link",
          artifactId,
          expectedCurrentVersionId: second.version.id,
          idempotencyKey: "skill-route-share",
          projectId,
        },
      ));
      const tagged = mcpStateSchema.parse(await callTool(
        memberCredential,
        "artifact_set_tags",
        {
          artifactId,
          expectedCurrentVersionId: second.version.id,
          idempotencyKey: "skill-route-tags",
          projectId,
          tags: ["finance", "q3"],
        },
      ));
      expect(shared.artifact.accessSetting).toBe("public_link");
      expect(tagged.artifact.tags.toSorted()).toEqual(["finance", "q3"]);

      const mcpTagged = z.object({
        artifacts: z.array(z.object({id: z.string()}).loose()),
      }).parse(await callTool(memberCredential, "artifact_list", {
        projectId,
        tag: "q3",
      }));
      const httpTagged = z.object({
        artifacts: z.array(z.object({artifact: z.object({id: z.string()}).loose()}).loose()),
      }).parse(await apiJson(
        "GET",
        `/api/v1/artifacts?projectId=${projectId}&tag=q3`,
      ));
      expect(mcpTagged.artifacts.map((artifact) => artifact.id)).toEqual([artifactId]);
      expect(httpTagged.artifacts.map((entry) => entry.artifact.id)).toEqual([artifactId]);

      const restored = mcpStateSchema.parse(await callTool(
        memberCredential,
        "artifact_restore_version",
        {
          artifactId,
          expectedCurrentVersionId: second.version.id,
          idempotencyKey: "skill-route-restore",
          projectId,
          versionId: first.version.id,
        },
      ));
      const afterRestore = await readArtifactOverHttp(artifactId, projectId);
      expect(restored.artifact.currentVersionId).toBe(first.version.id);
      expect(afterRestore.artifact).toEqual(restored.artifact);
      expect(afterRestore.artifact).toMatchObject({
        accessSetting: "public_link",
        currentVersionId: first.version.id,
      });
      expect(afterRestore.artifact.tags.toSorted()).toEqual(["finance", "q3"]);
    } finally {
      await rm(workspace, {force: true, recursive: true});
    }
  }, 60_000);

  test("SKL-002-F: the routine artifact credential gains no administrator operation and installation commands refuse routine credentials", async () => {
    const skillRoot = path.join(skillsRoot, skillName);

    // The administrator surface exists and works for an administrator, so
    // the member's refusal below is an authority decision, not a dead route.
    const administratorMembers = await apiFetch(
      administratorCredential,
      "GET",
      "/api/v1/members",
    );
    expect(administratorMembers.status).toBe(200);
    const administration = [
      ["GET", "/api/v1/members", null],
      ["POST", "/api/v1/members", {
        displayName: "Escalated Member",
        email: "escalated@example.test",
        role: "administrator",
      }],
      ["GET", "/api/v1/api-keys", null],
      ["POST", "/api/v1/api-keys", {
        capabilities: ["artifact:manage:any"],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        name: "Escalated key",
      }],
      ["GET", "/api/v1/administration/public-links", null],
    ] as const;
    const refusals = await Promise.all(administration.map(async ([method, route, body]) => ({
      route: `${method} ${route}`,
      status: (await apiFetch(memberCredential, method, route, body)).status,
    })));
    expect(refusals).toEqual(administration.map(([method, route]) => ({
      route: `${method} ${route}`,
      status: 403,
    })));
    const afterRefusals = z.object({
      members: z.array(z.object({email: z.string()}).loose()),
    }).parse(await administratorMembers.json());
    expect(afterRefusals.members.map((member) => member.email))
      .not.toContain("escalated@example.test");

    // MCP offers the member the same tools as an administrator, and every
    // tool is either routed by the routine reference or bridge-owned, so
    // no installation-administration tool exists for the routine route.
    const memberTools = await listTools(memberCredential);
    const administratorTools = await listTools(administratorCredential);
    expect([...memberTools].toSorted()).toEqual([...administratorTools].toSorted());
    const routed = new Set((await Promise.all(
      artifactReferences.map(async (reference) =>
        namedTools(await readFile(path.join(skillRoot, reference), "utf8"))
      ),
    )).flat());
    expect([...memberTools].filter((tool) =>
      !routed.has(tool) && !bridgeOwnedTools.has(tool)
    )).toEqual([]);

    // Installation commands act only on installation-local state. None of
    // them accepts the profile, destination, or token the routine route uses,
    // while the routine publish command does accept all three.
    const administratorCommands = await administratorCommandsOf(skillRoot);
    const routineOptions: readonly string[] = routineCredentialOptions.map(
      ([option]) => option,
    );
    expect(acceptedOptions((await runCli(["publish", "--help"])).stdout))
      .toEqual(expect.arrayContaining([...routineOptions]));
    const accepted = await Promise.all(administratorCommands.map(async (command) => ({
      command,
      options: acceptedOptions(
        (await runCli([...command.split(" "), "--help"])).stdout,
      ),
    })));
    expect(accepted.every(({options}) => options.includes("--help"))).toBe(true);
    expect(accepted.filter(({options}) =>
      options.some((option) => routineOptions.includes(option))
    ).map(({command}) => command)).toEqual([]);

    // Presenting a routine credential option is refused before any work, and
    // in an empty directory so a wrongly accepted command could change nothing.
    const scratch = await mkdtemp(path.join(tmpdir(), "artifact-server-skill-admin-"));
    try {
      const attempts = await Promise.all(
        administratorCommands.flatMap((command) =>
          routineCredentialOptions.map(async ([option, value]) => ({
            command: `${command} ${option}`,
            result: await runCli(
              [...command.split(" "), option, value],
              cliEnvironment(),
              "",
              scratch,
            ),
          }))
        ),
      );
      expect(attempts.filter(({result}) =>
        result.exitCode === 0 || !result.stderr.startsWith("error: ")
      ).map(({command}) => command)).toEqual([]);
      expect(await readdir(scratch)).toEqual([]);
    } finally {
      await rm(scratch, {force: true, recursive: true});
    }
  }, 60_000);

  async function listTools(token: string): Promise<ReadonlySet<string>> {
    const response = await mcpRequest(token, "tools/list", null, {});
    expect(response.status).toBe(200);
    return new Set(toolListSchema.parse(await response.json()).result.tools
      .map((tool) => tool.name));
  }

  async function callTool(
    token: string,
    name: string,
    parameters: JsonObject,
  ): Promise<z.infer<typeof toolCallSchema>["result"]["structuredContent"]> {
    const response = await mcpRequest(token, "tools/call", name, {
      arguments: parameters,
      name,
    });
    expect(response.status).toBe(200);
    const result = toolCallSchema.parse(await response.json()).result;
    expect({isError: result.isError ?? false, name}).toEqual({
      isError: false,
      name,
    });
    return result.structuredContent;
  }

  function mcpRequest(
    token: string,
    method: string,
    toolName: string | null,
    parameters: JsonObject,
  ): Promise<Response> {
    const headers = new Headers({
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": protocolVersion,
      "Mcp-Method": method,
    });
    if (toolName !== null) headers.set("Mcp-Name", toolName);
    return fetch(`${server.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: crypto.randomUUID(),
        jsonrpc: "2.0",
        method,
        params: {
          ...parameters,
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: {name: "artifact-server-skill-test", version: "1"},
            [PROTOCOL_VERSION_META_KEY]: protocolVersion,
          },
        },
      }),
      headers,
      method: "POST",
    });
  }

  function apiFetch(
    token: string,
    method: string,
    route: string,
    body: JsonObject | null = null,
  ): Promise<Response> {
    const headers = new Headers({Authorization: `Bearer ${token}`});
    if (body === null) return fetch(`${server.baseUrl}${route}`, {headers, method});
    headers.set("Content-Type", "application/json");
    headers.set("Idempotency-Key", crypto.randomUUID());
    return fetch(`${server.baseUrl}${route}`, {
      body: JSON.stringify(body),
      headers,
      method,
    });
  }

  async function apiJson(
    method: string,
    route: string,
  ): Promise<JsonValue> {
    const response = await apiFetch(memberCredential, method, route);
    expect(response.status).toBe(200);
    return jsonValueSchema.parse(await response.json());
  }

  async function readArtifactOverHttp(
    artifactId: string,
    projectId: string,
  ): Promise<z.infer<typeof httpArtifactSchema>> {
    return httpArtifactSchema.parse(await apiJson(
      "GET",
      `/api/v1/artifacts/${artifactId}?projectId=${projectId}`,
    ));
  }
});

interface SkillDocument {
  readonly body: string;
  readonly frontmatter: ReadonlyMap<string, string>;
}

interface SkillRoute {
  readonly references: readonly string[];
}

interface ProcessResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

type JsonValue =
  | boolean
  | null
  | number
  | string
  | readonly JsonValue[]
  | JsonObject;

interface JsonObject {
  readonly [key: string]: JsonValue;
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.boolean(),
  z.null(),
  z.number(),
  z.string(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

/** Discover installable skills the way portable installers do: one SKILL.md per directory. */
async function discoverSkills(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, {withFileTypes: true});
  const candidates = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const manifest = await stat(path.join(root, entry.name, "SKILL.md"))
        .then((found) => found.isFile(), () => false);
      return manifest ? entry.name : null;
    }));
  return candidates.filter((name) => name !== null).toSorted();
}

/**
 * Parse the Agent Skills frontmatter strictly. Only single-line plain
 * scalars are accepted, so any construct this parser cannot represent
 * exactly fails the test instead of being misread.
 */
function parseSkillDocument(text: string): SkillDocument {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(text);
  if (match === null) throw new Error("SKILL.md has no frontmatter block.");
  const header = match[1] ?? "";
  const frontmatter = new Map<string, string>();
  for (const line of header.split("\n")) {
    const field = /^([a-z][a-z-]*): (\S.*)$/u.exec(line);
    const key = field?.[1];
    const value = field?.[2];
    if (key === undefined || value === undefined) {
      throw new Error(`Unsupported frontmatter line: ${line}`);
    }
    if (/^["'|>&*!%@`{[]/u.test(value) || value.includes(": ") || value.includes(" #")) {
      throw new Error(`Frontmatter field ${key} is not a plain scalar.`);
    }
    if (frontmatter.has(key)) throw new Error(`Duplicate frontmatter field ${key}.`);
    frontmatter.set(key, value);
  }
  return {body: match[2] ?? "", frontmatter};
}

function markdownLinks(text: string): readonly string[] {
  return [...text.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/gu)]
    .map((match) => match[1] ?? "")
    .filter((target) => !/^[a-z]+:/u.test(target));
}

/** Read the entrypoint's routing bullets and the references each one loads. */
function routeTable(body: string): readonly SkillRoute[] {
  const section = /^## Route the request\n([\s\S]*?)\n## /mu.exec(body)?.[1];
  if (section === undefined) throw new Error("SKILL.md has no routing section.");
  return section
    .split(/\n(?=- )/u)
    .filter((chunk) => chunk.startsWith("- "))
    .map((bullet) => ({references: markdownLinks(bullet)}));
}

async function reachableReferences(
  skillRoot: string,
  roots: readonly string[],
): Promise<readonly string[]> {
  const visited = new Set<string>();
  let frontier = [...roots];
  while (frontier.length > 0) {
    const pending = frontier.filter((reference) => !visited.has(reference));
    for (const reference of pending) visited.add(reference);
    // eslint-disable-next-line no-await-in-loop
    const texts = await Promise.all(pending.map((reference) =>
      readFile(path.join(skillRoot, reference), "utf8")
    ));
    frontier = texts.flatMap((text, index) => {
      const base = path.dirname(pending[index] ?? "");
      return markdownLinks(text).map((link) => path.normalize(path.join(base, link)));
    });
  }
  return [...visited].toSorted();
}

/** Every exact MCP tool name a reference instructs an agent to call. */
function namedTools(text: string): readonly string[] {
  return [...new Set([...text.matchAll(
    /`((?:artifact|comment|dispatch|project)_[a-z_]+)`/gu,
  )].map((match) => match[1] ?? ""))].toSorted();
}

/** Every `artifactserver <command path>` a set of references names. */
async function commandsNamedBy(
  skillRoot: string,
  references: readonly string[],
): Promise<readonly string[]> {
  const texts = await Promise.all(references.map((reference) =>
    readFile(path.join(skillRoot, reference), "utf8")
  ));
  const commands = texts.flatMap((text) =>
    [...text.matchAll(/artifactserver((?: [a-z][a-z-]*)+)/gu)]
      .map((match) => (match[1] ?? "").trim())
  );
  return [...new Set(commands)].filter((command) => command !== "").toSorted();
}

/** The installation commands the server route instructs, minus those it says do not exist. */
async function administratorCommandsOf(
  skillRoot: string,
): Promise<readonly string[]> {
  return (await commandsNamedBy(skillRoot, [serverReference]))
    .filter((command) => !documentedAbsentCommands.includes(command));
}

function comparedPaths(comparison: z.infer<typeof comparedPathsSchema>) {
  return {
    added: comparison.added.map((entry) => entry.path).toSorted(),
    changed: comparison.changed.map((entry) => entry.after.path).toSorted(),
    removed: comparison.removed.map((entry) => entry.path).toSorted(),
  };
}

/** The long option names a command's real `--help` output advertises. */
function acceptedOptions(help: string): readonly string[] {
  const options = /\nOptions:\n([\s\S]*)$/u.exec(help)?.[1] ?? "";
  return [...options.matchAll(/^ {2}(?:-[A-Za-z], )?(--[a-z][a-z-]*)/gmu)]
    .map((match) => match[1] ?? "");
}

function runCli(
  argumentsToPass: readonly string[],
  environment: NodeJS.ProcessEnv = cliEnvironment(),
  standardInput = "",
  workingDirectory = repositoryRoot,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliExecutable, [cliEntrypoint, ...argumentsToPass], {
      cwd: workingDirectory,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({
      exitCode: code ?? -1,
      stderr: Buffer.concat(stderr).toString("utf8"),
      stdout: Buffer.concat(stdout).toString("utf8"),
    }));
    child.stdin.end(standardInput, "utf8");
  });
}

function cliEnvironment(): NodeJS.ProcessEnv {
  const inherited = {...process.env};
  delete inherited["ARTIFACT_SERVER_URL"];
  delete inherited["ARTIFACT_SERVER_API_TOKEN"];
  delete inherited["ARTIFACT_SERVER_HOME"];
  return inherited;
}

/** A file-backed stand-in for the operating-system credential store. */
async function credentialHelperEnvironment(
  workspace: string,
): Promise<NodeJS.ProcessEnv> {
  const helper = path.join(workspace, "credential-helper.mjs");
  const state = path.join(workspace, "credential-helper.json");
  await writeFile(helper, `#!/usr/bin/env node
import {existsSync, readFileSync, writeFileSync} from "node:fs";
const input = JSON.parse(readFileSync(0, "utf8"));
const statePath = process.env.CREDENTIAL_HELPER_STATE;
if (statePath === undefined) process.exit(3);
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const operation = process.argv[2];
if (operation === "read") {
  if (!(input.account in state)) process.exit(2);
  process.stdout.write(state[input.account]);
} else if (operation === "write") {
  state[input.account] = input.secret;
  writeFileSync(statePath, JSON.stringify(state));
} else if (operation === "delete") {
  if (!(input.account in state)) process.exit(2);
  delete state[input.account];
  writeFileSync(statePath, JSON.stringify(state));
} else {
  process.exit(3);
}
`, {mode: 0o700});
  await chmod(helper, 0o700);
  return {
    ...cliEnvironment(),
    ARTIFACT_SERVER_CREDENTIAL_HELPER: helper,
    CREDENTIAL_HELPER_STATE: state,
  };
}
