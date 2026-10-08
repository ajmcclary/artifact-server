import {createHash} from "node:crypto";

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
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../../src/core/identity.js";
import {
  createTestInstallation,
  issueLocalBrowserLogin,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, publishVersion} from "../support/publishing.js";

const protocolVersion = "2026-07-28";
const projectId = "prj_default";
const fabricatedArtifactId = "art_00000000-0000-4000-8000-000000000000";

const allowed = "allowed";
const denied = "AUTHORIZATION_DENIED";
const unauthenticated = "AUTHENTICATION_REQUIRED";
const notFound = "ARTIFACT_NOT_FOUND";

const operations = [
  "project.list",
  "project.create",
  "artifact.list",
  "artifact.get",
  "artifact.get-deleted",
  "version.list",
  "version.compare",
  "artifact.open-private",
  "artifact.open-public",
  "upload.plan",
  "publish.new-artifact",
  "publish.new-version",
  "visibility.change",
  "tags.change",
  "version.restore",
  "artifact.delete",
] as const;
type Operation = (typeof operations)[number];

const callerLabels = [
  "installation-key",
  "human-administrator",
  "human-member",
  "delegated-human",
  "reader-key",
  "creator-key",
  "publisher-key",
  "manager-key",
  "commenter-key",
  "capability-less-service",
  "foreign-installation-administrator",
  "anonymous",
] as const;
type CallerLabel = (typeof callerLabels)[number];

const readOperations: readonly Operation[] = [
  "project.list",
  "artifact.list",
  "artifact.get",
  "version.list",
  "version.compare",
  "artifact.open-public",
];
const everyOperation: readonly Operation[] = operations;

/**
 * The authority each caller holds under the shared policy, written out by
 * hand so both surfaces are checked against an independent expectation rather
 * than only against each other.
 */
const expectedAllowed: ReadonlyMap<CallerLabel, ReadonlySet<Operation>> = new Map([
  ["installation-key", new Set(everyOperation)],
  ["human-administrator", new Set(everyOperation)],
  ["human-member", new Set(everyOperation.filter((operation) =>
    operation !== "project.create"
  ))],
  ["delegated-human", new Set<Operation>()],
  ["reader-key", new Set(readOperations)],
  ["creator-key", new Set<Operation>([
    ...readOperations,
    "upload.plan",
    "publish.new-artifact",
  ])],
  ["publisher-key", new Set<Operation>([
    ...readOperations,
    "upload.plan",
    "publish.new-artifact",
    "publish.new-version",
  ])],
  ["manager-key", new Set<Operation>([
    ...readOperations,
    "visibility.change",
    "tags.change",
    "version.restore",
    "artifact.delete",
  ])],
  ["commenter-key", new Set<Operation>(["project.list"])],
  ["capability-less-service", new Set<Operation>()],
  ["foreign-installation-administrator", new Set<Operation>()],
  ["anonymous", new Set<Operation>()],
]);

/**
 * Callers that reach the project. Only those that may also read artifacts see
 * a deleted artifact as missing; the rest are refused before any lookup.
 */
const projectReachingCallers: ReadonlySet<CallerLabel> = new Set([
  "installation-key",
  "human-administrator",
  "human-member",
  "reader-key",
  "creator-key",
  "publisher-key",
  "manager-key",
  "commenter-key",
]);

const humanTokens = {
  administrator: "mcp-009-human-administrator-credential",
  bare: "mcp-009-capability-less-service-credential",
  delegated: "mcp-009-delegated-human-credential",
  foreign: "mcp-009-foreign-installation-credential",
  member: "mcp-009-human-member-credential",
} as const;

const externalPrincipals: ReadonlyMap<string, Principal> = new Map([
  [humanTokens.administrator, {
    authorizedByPrincipalId: null,
    capabilities: [],
    displayName: "Ada Administrator",
    id: "usr_mcp009_administrator",
    installationId: "local",
    kind: principalKinds.human,
    membershipRole: membershipRoles.administrator,
  }],
  [humanTokens.member, {
    authorizedByPrincipalId: null,
    capabilities: [],
    displayName: "Mo Member",
    id: "usr_mcp009_member",
    installationId: "local",
    kind: principalKinds.human,
    membershipRole: membershipRoles.member,
  }],
  [humanTokens.delegated, {
    authorizedByPrincipalId: "usr_mcp009_member",
    capabilities: [],
    displayName: "Agent acting for Mo",
    id: "usr_mcp009_delegated",
    installationId: "local",
    kind: principalKinds.human,
    membershipRole: membershipRoles.member,
  }],
  [humanTokens.bare, {
    authorizedByPrincipalId: null,
    capabilities: [],
    displayName: "Capability-less service",
    id: "service:mcp009_bare",
    installationId: "local",
    kind: principalKinds.service,
    membershipRole: membershipRoles.member,
  }],
  [humanTokens.foreign, {
    authorizedByPrincipalId: null,
    capabilities: [],
    displayName: "Foreign administrator",
    id: "usr_mcp009_foreign",
    installationId: "other-installation",
    kind: principalKinds.human,
    membershipRole: membershipRoles.administrator,
  }],
]);

const externalVerifier: BearerCredentialVerifier = {
  verify: (credential) => {
    const principal = externalPrincipals.get(Redacted.value(credential));
    return principal === undefined
      ? Effect.fail(new AuthenticationRequired({
        message: "The MCP-009 credential is invalid.",
      }))
      : Effect.succeed(principal);
  },
};

const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).strict(),
}).strict();
const toolCallResultSchema = z.object({
  jsonrpc: z.literal("2.0"),
  result: z.object({
    content: z.array(z.object({text: z.string(), type: z.literal("text")})),
    isError: z.boolean().optional(),
    structuredContent: z.unknown(),
  }).loose(),
}).loose();
const mcpFailureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});
const issuedKeySchema = z.object({token: z.string().startsWith("as_key_")}).loose();
const projectListSchema = z.object({
  projects: z.array(z.object({id: z.string()}).loose()),
}).loose();
const httpArtifactPageSchema = z.object({
  artifacts: z.array(z.object({artifact: z.object({id: z.string()}).loose()}).loose()),
  nextCursor: z.string().nullable(),
}).loose();
const mcpArtifactPageSchema = z.object({
  artifacts: z.array(z.object({id: z.string()}).loose()),
  nextCursor: z.string().nullable(),
}).loose();
const artifactRecordSchema = z.object({
  accessSetting: z.enum(["account_required", "public_link"]),
  currentVersionId: z.string(),
  id: z.string(),
  tags: z.array(z.string()),
}).loose();
const artifactDetailsSchema = z.object({
  artifact: artifactRecordSchema,
  links: z.object({artifact: z.url()}).loose(),
}).loose();
const mcpVersionListSchema = z.object({
  versions: z.array(z.object({id: z.string()}).loose()),
}).loose();
const httpVersionListSchema = z.object({
  versions: z.array(z.object({version: z.object({id: z.string()}).loose()}).loose()),
}).loose();
const comparisonSchema = z.object({
  added: z.array(z.object({path: z.string()}).loose()),
  changed: z.array(z.object({after: z.object({path: z.string()}).loose()}).loose()),
  from: z.object({id: z.string()}).loose(),
  removed: z.array(z.object({path: z.string()}).loose()),
  to: z.object({id: z.string()}).loose(),
}).loose();
const httpContentSessionSchema = z.object({
  bootstrapUrl: z.url(),
  versionId: z.string(),
}).loose();
const mcpOpenSchema = z.object({
  browserUrl: z.url(),
  versionId: z.string(),
}).loose();
const httpUploadPlanSchema = z.object({
  commitUrl: z.url(),
  files: z.array(z.object({uploadUrl: z.url()}).loose()),
}).loose();
const mcpUploadPlanSchema = z.object({
  files: z.array(z.object({uploadUrl: z.url()}).loose()),
  uploadId: z.string(),
}).loose();
const publicationSchema = z.object({
  version: z.object({number: z.number().int().positive()}).loose(),
}).loose();

describe("MCP and HTTP share one authorization layer", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let callers: ReadonlyMap<CallerLabel, string | null>;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation, {
      externalApiBearerVerifier: externalVerifier,
      externalMcpBearerVerifier: externalVerifier,
    });
    const administrator = await signInAdministrator();
    const issue = (capabilities: readonly string[], name: string) =>
      issueKey(administrator, capabilities, name);
    callers = new Map<CallerLabel, string | null>([
      ["installation-key", installation.apiToken],
      ["human-administrator", humanTokens.administrator],
      ["human-member", humanTokens.member],
      ["delegated-human", humanTokens.delegated],
      ["reader-key", await issue([principalCapabilities.readArtifacts], "Reader")],
      ["creator-key", await issue([
        principalCapabilities.createArtifact,
        principalCapabilities.readArtifacts,
      ], "Creator")],
      ["publisher-key", await issue([
        principalCapabilities.createArtifact,
        principalCapabilities.publishAnyArtifact,
        principalCapabilities.readArtifacts,
      ], "Publisher")],
      ["manager-key", await issue([principalCapabilities.manageAnyArtifact], "Manager")],
      ["commenter-key", await issue([principalCapabilities.writeComments], "Commenter")],
      ["capability-less-service", humanTokens.bare],
      ["foreign-installation-administrator", humanTokens.foreign],
      ["anonymous", null],
    ]);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("MCP-009-B: every caller gets the same outcome for every artifact and project operation over MCP and HTTP", async () => {
    expect.hasAssertions();
    const fixture = await readFixture();
    const cells = callerLabels.flatMap((caller) =>
      operations.map((operation) => ({caller, operation}))
    );
    // Cells run one at a time so each pair of HTTP and MCP calls observes the
    // same server state; the list comparison would otherwise race publication.
    const observed = await inSequence(cells, async ({caller, operation}) => {
      const token = callerToken(caller);
      const overHttp = await runOperation("http", operation, token, fixture);
      const overMcp = await runOperation("mcp", operation, token, fixture);
      return {
        caller,
        http: overHttp.outcome,
        mcp: overMcp.outcome,
        operation,
        sameObservation: overHttp.observation === overMcp.observation,
      };
    });
    expect(observed).toEqual(cells.map(({caller, operation}) => ({
      caller,
      http: expectedOutcome(caller, operation),
      mcp: expectedOutcome(caller, operation),
      operation,
      sameObservation: true,
    })));

    // The listed set is the same normal visibility on both surfaces: live
    // private and public artifacts appear, a deleted artifact never does.
    const listed = await listEveryArtifact("mcp", callerToken("reader-key"));
    expect(listed).toEqual(await listEveryArtifact("http", callerToken("reader-key")));
    expect(listed).toEqual(expect.arrayContaining([
      fixture.private.artifactId,
      fixture.public.artifactId,
    ]));
    expect(listed).not.toContain(fixture.deleted.artifactId);
  }, 180_000);

  test("MCP-009-F: refused MCP calls change nothing and reveal no more than HTTP about an artifact the caller cannot reach", async () => {
    expect.hasAssertions();
    const target = await publishTarget(["seed"]);
    const ownerToken = installation.apiToken;
    const baseline = await serverSnapshot(ownerToken, target.artifactId);

    const overreachingCallers: readonly CallerLabel[] = callerLabels.filter(
      (label) => label !== "installation-key" && label !== "human-administrator",
    );
    const attempts = overreachingCallers.flatMap((caller) =>
      mcpMutations(target)
        .filter((mutation) => expectedOutcome(caller, mutation.operation) !== allowed)
        .map((mutation) => ({caller, mutation}))
    );
    // Every caller below full authority has at least one write to attempt.
    expect(new Set(attempts.map((attempt) => attempt.caller)))
      .toEqual(new Set(overreachingCallers));
    const refusals = await inSequence(attempts, async ({caller, mutation}) => {
      const result = await mutation.run(callerToken(caller));
      return {
        caller,
        leaksTarget: [target.name, target.firstVersionId, target.secondVersionId]
          .some((secret) => result.text.includes(secret)),
        operation: mutation.operation,
        outcome: result.outcome,
      };
    });
    expect(refusals).toEqual(attempts.map(({caller, mutation}) => ({
      caller,
      leaksTarget: false,
      operation: mutation.operation,
      outcome: caller === "anonymous" ? unauthenticated : denied,
    })));
    expect(await serverSnapshot(ownerToken, target.artifactId)).toEqual(baseline);

    // A caller who cannot read gets no artifact content, and MCP distinguishes
    // an existing artifact from a fabricated one exactly as HTTP does.
    const nonReaders = callerLabels.filter((caller) =>
      expectedOutcome(caller, "artifact.get") !== allowed
    );
    const probes = await inSequence(nonReaders, async (caller) => {
      const token = callerToken(caller);
      const mcpReal = await mcpTool(token, "artifact_get", {
        artifactId: target.artifactId,
        projectId,
      });
      const mcpFabricated = await mcpTool(token, "artifact_get", {
        artifactId: fabricatedArtifactId,
        projectId,
      });
      const httpReal = await httpRequest(token, "GET", artifactRoute(target.artifactId));
      const httpFabricated = await httpRequest(
        token,
        "GET",
        artifactRoute(fabricatedArtifactId),
      );
      return {
        caller,
        http: {fabricated: httpFabricated.outcome, real: httpReal.outcome},
        leaksTarget: [target.name, target.secondVersionId]
          .some((secret) => mcpReal.text.includes(secret)),
        mcp: {fabricated: mcpFabricated.outcome, real: mcpReal.outcome},
      };
    });
    expect(probes.map(({caller, mcp}) => ({caller, mcp}))).toEqual(
      probes.map(({caller, http}) => ({caller, mcp: http})),
    );
    expect(probes.filter((probe) => probe.leaksTarget || probe.mcp.real === allowed))
      .toEqual([]);
    // A caller who cannot read cannot tell a real artifact from a fabricated
    // one on either surface, even when it reaches the project.
    expect(probes.filter((probe) =>
      probe.mcp.real !== probe.mcp.fabricated ||
      probe.http.real !== probe.http.fabricated
    )).toEqual([]);

    // The same holds for refused writes: aiming them at a fabricated artifact
    // is refused exactly as aiming them at the real one was.
    const fabricatedTarget: Target = {...target, artifactId: fabricatedArtifactId};
    const fabricatedAttempts = attempts.filter(({caller, mutation}) =>
      nonReaders.includes(caller) && mutation.operation !== "publish.new-artifact" &&
      mutation.operation !== "project.create"
    );
    expect(fabricatedAttempts.length).toBeGreaterThan(0);
    const fabricatedRefusals = await inSequence(
      fabricatedAttempts,
      async ({caller, mutation}) => {
        const fabricated = mcpMutations(fabricatedTarget)
          .find((candidate) => candidate.operation === mutation.operation);
        if (fabricated === undefined) throw new Error(`No ${mutation.operation} mutation.`);
        const result = await fabricated.run(callerToken(caller));
        return {caller, operation: mutation.operation, outcome: result.outcome};
      },
    );
    expect(fabricatedRefusals).toEqual(fabricatedAttempts.map(({caller, mutation}) => ({
      caller,
      operation: mutation.operation,
      outcome: caller === "anonymous" ? unauthenticated : denied,
    })));

    // Read authority is not mutation authority: a reader can see the target
    // over MCP but its refused writes above left the record untouched.
    const readable = await mcpTool(callerToken("reader-key"), "artifact_get", {
      artifactId: target.artifactId,
      projectId,
    });
    expect(readable.outcome).toBe(allowed);
    expect(await serverSnapshot(ownerToken, target.artifactId)).toEqual(baseline);
  }, 120_000);

  function callerToken(label: CallerLabel): string | null {
    if (!callers.has(label)) throw new Error(`No credential for ${label}.`);
    return callers.get(label) ?? null;
  }

  async function readFixture(): Promise<ReadFixture> {
    const privateTarget = await publishTarget(["seed"]);
    const publicArtifact = (await publishNew(server, installation, {
      accessSetting: "public_link",
      content: "<p>public</p>",
      idempotencyKey: `mcp-009-public-${crypto.randomUUID()}`,
      name: "MCP-009 public",
      projectId,
    })).body;
    const deleted = await publishTarget([]);
    const deletion = await httpRequest(
      installation.apiToken,
      "DELETE",
      artifactRoute(deleted.artifactId),
      {expectedCurrentVersionId: deleted.secondVersionId},
    );
    expect(deletion.outcome).toBe(allowed);
    return {
      deleted,
      private: privateTarget,
      public: {
        artifactId: publicArtifact.artifact.id,
        versionId: publicArtifact.version.id,
      },
    };
  }

  async function publishTarget(tags: readonly string[]): Promise<Target> {
    const name = `MCP-009 target ${crypto.randomUUID()}`;
    const first = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<p>first</p>",
      idempotencyKey: `mcp-009-first-${crypto.randomUUID()}`,
      name,
      projectId,
      tags,
    })).body;
    const second = (await publishVersion(server, installation, {
      artifactId: first.artifact.id,
      content: "<p>second</p>",
      expectedCurrentVersionId: first.version.id,
      idempotencyKey: `mcp-009-second-${crypto.randomUUID()}`,
      projectId,
    })).body;
    return {
      artifactId: first.artifact.id,
      firstVersionId: first.version.id,
      name,
      secondVersionId: second.version.id,
    };
  }

  async function runOperation(
    surface: Surface,
    operation: Operation,
    token: string | null,
    fixture: ReadFixture,
  ): Promise<SurfaceResult> {
    const target = fixture.private;
    switch (operation) {
      case "project.list": {
        const result = surface === "http"
          ? await httpRequest(token, "GET", "/api/v1/projects")
          : await mcpTool(token, "project_list", {});
        return observe(result, (body) =>
          projectListSchema.parse(body).projects.map((project) => project.id).toSorted()
        );
      }
      case "project.create": {
        const name = `MCP-009 project ${crypto.randomUUID()}`;
        const result = surface === "http"
          ? await httpRequest(token, "POST", "/api/v1/projects", {name})
          : await mcpTool(token, "project_create", {name});
        return observe(result, () => "created");
      }
      case "artifact.list": {
        if (surface === "http") {
          const first = await httpRequest(token, "GET", `/api/v1/artifacts?projectId=${projectId}&limit=100`);
          if (first.outcome !== allowed) return {observation: null, outcome: first.outcome};
        } else {
          const first = await mcpTool(token, "artifact_list", {limit: 100, projectId});
          if (first.outcome !== allowed) return {observation: null, outcome: first.outcome};
        }
        return {
          observation: JSON.stringify(await listEveryArtifact(surface, token)),
          outcome: allowed,
        };
      }
      case "artifact.get": {
        const result = surface === "http"
          ? await httpRequest(token, "GET", artifactRoute(target.artifactId))
          : await mcpTool(token, "artifact_get", {artifactId: target.artifactId, projectId});
        return observe(result, (body) => {
          const details = artifactDetailsSchema.parse(body);
          return {
            accessSetting: details.artifact.accessSetting,
            currentVersionId: details.artifact.currentVersionId,
            id: details.artifact.id,
            link: details.links.artifact,
            tags: details.artifact.tags,
          };
        });
      }
      case "artifact.get-deleted": {
        const result = surface === "http"
          ? await httpRequest(token, "GET", artifactRoute(fixture.deleted.artifactId))
          : await mcpTool(token, "artifact_get", {
            artifactId: fixture.deleted.artifactId,
            projectId,
          });
        return observe(result, () => "visible");
      }
      case "version.list": {
        const result = surface === "http"
          ? await httpRequest(token, "GET", `/api/v1/artifacts/${target.artifactId}/versions?projectId=${projectId}`)
          : await mcpTool(token, "artifact_version_list", {
            artifactId: target.artifactId,
            projectId,
          });
        return observe(result, (body) => surface === "http"
          ? httpVersionIds(body)
          : mcpVersionListSchema.parse(body).versions.map((version) => version.id));
      }
      case "version.compare": {
        const result = surface === "http"
          ? await httpRequest(
            token,
            "GET",
            `/api/v1/artifacts/${target.artifactId}/comparisons?projectId=${projectId}&fromVersionId=${target.firstVersionId}&toVersionId=${target.secondVersionId}`,
          )
          : await mcpTool(token, "artifact_diff", {
            artifactId: target.artifactId,
            fromVersionId: target.firstVersionId,
            projectId,
            toVersionId: target.secondVersionId,
          });
        return observe(result, (body) => {
          const comparison = comparisonSchema.parse(body);
          return {
            added: comparison.added.map((entry) => entry.path),
            changed: comparison.changed.map((entry) => entry.after.path),
            from: comparison.from.id,
            removed: comparison.removed.map((entry) => entry.path),
            to: comparison.to.id,
          };
        });
      }
      case "artifact.open-private": {
        const result = surface === "http"
          ? await httpRequest(
            token,
            "POST",
            `/api/v1/artifacts/${target.artifactId}/content-sessions?projectId=${projectId}`,
          )
          : await mcpTool(token, "artifact_open", {
            artifactId: target.artifactId,
            projectId,
            versionId: null,
          });
        return observe(result, (body) => {
          const opened = surface === "http"
            ? httpContentSessionSchema.parse(body)
            : {...mcpOpenSchema.parse(body), bootstrapUrl: mcpOpenSchema.parse(body).browserUrl};
          return {
            bootstrapped: opened.bootstrapUrl.includes("__artifact_bootstrap="),
            versionId: opened.versionId,
          };
        });
      }
      case "artifact.open-public": {
        const result = surface === "http"
          ? await httpRequest(token, "GET", artifactRoute(fixture.public.artifactId))
          : await mcpTool(token, "artifact_open", {
            artifactId: fixture.public.artifactId,
            projectId,
            versionId: null,
          });
        return observe(result, (body) =>
          surface === "http"
            ? artifactDetailsSchema.parse(body).links.artifact
            : mcpOpenSchema.parse(body).browserUrl
        );
      }
      case "upload.plan": {
        const result = await planUpload(surface, token, "plan");
        return observe(result.response, () => "planned");
      }
      case "publish.new-artifact": {
        const published = await publishThrough(surface, token, {
          accessSetting: "account_required",
          kind: "new_artifact",
          name: "MCP-009 publication",
          tags: [],
        });
        return observe(published, (body) => publicationSchema.parse(body).version.number);
      }
      case "publish.new-version": {
        const fresh = await publishTarget(["seed"]);
        const published = await publishThrough(surface, token, {
          artifactId: fresh.artifactId,
          expectedCurrentVersionId: fresh.secondVersionId,
          kind: "new_version",
        });
        return {
          observation: await targetState(fresh),
          outcome: published.outcome,
        };
      }
      case "visibility.change":
      case "tags.change":
      case "version.restore":
      case "artifact.delete": {
        const fresh = await publishTarget(["seed"]);
        const mutation = surface === "http"
          ? httpMutation(operation, fresh)
          : mcpMutations(fresh).find((candidate) => candidate.operation === operation);
        if (mutation === undefined) throw new Error(`No mutation for ${operation}.`);
        const result = await mutation.run(token);
        return {
          observation: await targetState(fresh),
          outcome: result.outcome,
        };
      }
      default:
        throw new Error(`No surface operation is defined for ${String(operation)}.`);
    }
  }

  function httpMutation(operation: Operation, target: Target): Mutation {
    const key = `mcp-009-http-${crypto.randomUUID()}`;
    const route = (suffix: string) =>
      `/api/v1/artifacts/${target.artifactId}${suffix}?projectId=${projectId}`;
    const expectedCurrentVersionId = target.secondVersionId;
    return {
      operation,
      run: (token) => {
        switch (operation) {
          case "visibility.change":
            return httpRequest(token, "PATCH", route("/access"), {
              accessSetting: "public_link",
              expectedCurrentVersionId,
            }, key);
          case "tags.change":
            return httpRequest(token, "PATCH", route("/tags"), {
              expectedCurrentVersionId,
              tags: ["changed"],
            }, key);
          case "version.restore":
            return httpRequest(token, "POST", route("/restore"), {
              expectedCurrentVersionId,
              versionId: target.firstVersionId,
            }, key);
          default:
            return httpRequest(token, "DELETE", route(""), {
              expectedCurrentVersionId,
            }, key);
        }
      },
    };
  }

  function mcpMutations(target: Target): readonly Mutation[] {
    const common = {
      artifactId: target.artifactId,
      expectedCurrentVersionId: target.secondVersionId,
      projectId,
    };
    return [
      {
        operation: "visibility.change",
        run: (token) => mcpTool(token, "artifact_set_visibility", {
          ...common,
          accessSetting: "public_link",
          idempotencyKey: mcpIdempotencyKey(),
        }),
      },
      {
        operation: "tags.change",
        run: (token) => mcpTool(token, "artifact_set_tags", {
          ...common,
          idempotencyKey: mcpIdempotencyKey(),
          tags: ["changed"],
        }),
      },
      {
        operation: "version.restore",
        run: (token) => mcpTool(token, "artifact_restore_version", {
          ...common,
          idempotencyKey: mcpIdempotencyKey(),
          versionId: target.firstVersionId,
        }),
      },
      {
        operation: "artifact.delete",
        run: (token) => mcpTool(token, "artifact_delete", {
          ...common,
          idempotencyKey: mcpIdempotencyKey(),
        }),
      },
      {
        operation: "publish.new-version",
        run: (token) => publishThrough("mcp", token, {
          artifactId: target.artifactId,
          expectedCurrentVersionId: target.secondVersionId,
          kind: "new_version",
        }),
      },
      {
        operation: "publish.new-artifact",
        run: (token) => publishThrough("mcp", token, {
          accessSetting: "account_required",
          kind: "new_artifact",
          name: "MCP-009 refused publication",
          tags: [],
        }),
      },
      {
        operation: "project.create",
        run: (token) => mcpTool(token, "project_create", {
          name: "MCP-009 refused project",
        }),
      },
    ];
  }

  async function planUpload(
    surface: Surface,
    token: string | null,
    content: string,
  ): Promise<PlannedUpload> {
    const bytes = new TextEncoder().encode(`<p>${content} ${crypto.randomUUID()}</p>`);
    const declared = {
      mediaType: "text/html",
      path: "index.html",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
    if (surface === "http") {
      const response = await httpRequest(token, "POST", "/api/v1/uploads", {
        entryPath: "index.html",
        files: [declared],
        projectId,
      });
      if (response.outcome !== allowed) return {bytes, plan: null, response};
      const plan = httpUploadPlanSchema.parse(response.body);
      return {
        bytes,
        plan: {commitUrl: plan.commitUrl, uploadId: null, uploadUrls: plan.files.map((file) => file.uploadUrl)},
        response,
      };
    }
    const response = await mcpTool(token, "artifact_create_upload", {
      entryPath: "index.html",
      files: [declared],
      projectId,
    });
    if (response.outcome !== allowed) return {bytes, plan: null, response};
    const plan = mcpUploadPlanSchema.parse(response.body);
    return {
      bytes,
      plan: {commitUrl: null, uploadId: plan.uploadId, uploadUrls: plan.files.map((file) => file.uploadUrl)},
      response,
    };
  }

  async function publishThrough(
    surface: Surface,
    token: string | null,
    target: JsonObject,
  ): Promise<CallResult> {
    const planned = await planUpload(surface, token, "publication");
    if (planned.plan === null) return planned.response;
    const uploaded = await Promise.all(planned.plan.uploadUrls.map((uploadUrl) =>
      fetch(uploadUrl, {body: planned.bytes, method: "PUT"})
    ));
    expect(uploaded.map((response) => response.status)).toEqual(
      planned.plan.uploadUrls.map(() => 200),
    );
    const idempotencyKey = `mcp-009-commit-${crypto.randomUUID()}`;
    if (planned.plan.commitUrl !== null) {
      return httpRequest(
        token,
        "POST",
        new URL(planned.plan.commitUrl).pathname + new URL(planned.plan.commitUrl).search,
        {target},
        idempotencyKey,
      );
    }
    return mcpTool(token, "artifact_commit_upload", {
      idempotencyKey,
      projectId,
      target,
      uploadId: planned.plan.uploadId ?? "",
    });
  }

  async function targetState(target: Target): Promise<string> {
    const read = await httpRequest(
      installation.apiToken,
      "GET",
      artifactRoute(target.artifactId),
    );
    if (read.outcome !== allowed) return JSON.stringify({state: read.outcome});
    const artifact = artifactDetailsSchema.parse(read.body).artifact;
    const versions = await httpRequest(
      installation.apiToken,
      "GET",
      `/api/v1/artifacts/${target.artifactId}/versions?projectId=${projectId}`,
    );
    const versionIds = httpVersionIds(versions.body);
    let current = "new-version";
    if (artifact.currentVersionId === target.firstVersionId) current = "first";
    if (artifact.currentVersionId === target.secondVersionId) current = "second";
    return JSON.stringify({
      accessSetting: artifact.accessSetting,
      current,
      tags: artifact.tags,
      versionCount: versionIds.length,
    });
  }

  async function serverSnapshot(
    token: string,
    artifactId: string,
  ): Promise<string> {
    const details = await httpRequest(token, "GET", artifactRoute(artifactId));
    const versions = await httpRequest(
      token,
      "GET",
      `/api/v1/artifacts/${artifactId}/versions?projectId=${projectId}`,
    );
    const projects = await httpRequest(token, "GET", "/api/v1/projects");
    return JSON.stringify({
      artifact: artifactDetailsSchema.parse(details.body).artifact,
      listed: await listEveryArtifact("http", token),
      projects: projectListSchema.parse(projects.body).projects,
      versions: httpVersionIds(versions.body),
    });
  }

  async function listEveryArtifact(
    surface: Surface,
    token: string | null,
    cursor: string | null = null,
  ): Promise<readonly string[]> {
    let identifiers: readonly string[];
    let nextCursor: string | null;
    if (surface === "http") {
      const query = new URLSearchParams({limit: "100", projectId});
      if (cursor !== null) query.set("cursor", cursor);
      const page = httpArtifactPageSchema.parse(
        (await httpRequest(token, "GET", `/api/v1/artifacts?${query.toString()}`)).body,
      );
      identifiers = page.artifacts.map((entry) => entry.artifact.id);
      nextCursor = page.nextCursor;
    } else {
      const page = mcpArtifactPageSchema.parse(
        (await mcpTool(token, "artifact_list", {cursor, limit: 100, projectId})).body,
      );
      identifiers = page.artifacts.map((entry) => entry.id);
      nextCursor = page.nextCursor;
    }
    const remaining = nextCursor === null
      ? []
      : await listEveryArtifact(surface, token, nextCursor);
    return [...identifiers, ...remaining].toSorted();
  }

  async function httpRequest(
    token: string | null,
    method: string,
    route: string,
    body?: JsonObject,
    idempotencyKey?: string,
  ): Promise<CallResult> {
    const headers = new Headers({"Content-Type": "application/json"});
    if (token !== null) headers.set("Authorization", `Bearer ${token}`);
    headers.set(
      "Idempotency-Key",
      idempotencyKey ?? `mcp-009-http-${crypto.randomUUID()}`,
    );
    const response = await fetch(`${server.baseUrl}${route}`, body === undefined
      ? {headers, method}
      : {body: JSON.stringify(body), headers, method});
    const text = await response.text();
    const parsed: JsonValue = text === "" ? null : z.json().parse(JSON.parse(text));
    if (response.ok) return {body: parsed, outcome: allowed, text};
    return {body: parsed, outcome: failureSchema.parse(parsed).error.code, text};
  }

  async function mcpTool(
    token: string | null,
    name: string,
    parameters: JsonObject,
  ): Promise<CallResult> {
    const headers = new Headers({
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": protocolVersion,
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    });
    if (token !== null) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${server.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: crypto.randomUUID(),
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: {name: "artifact-server-test", version: "1"},
            [PROTOCOL_VERSION_META_KEY]: protocolVersion,
          },
          arguments: parameters,
          name,
        },
      }),
      headers,
      method: "POST",
    });
    const text = await response.text();
    if (response.status === 401) {
      return {body: null, outcome: unauthenticated, text};
    }
    expect(response.status).toBe(200);
    const result = toolCallResultSchema.parse(JSON.parse(text)).result;
    const body = z.json().parse(result.structuredContent ?? null);
    if (result.isError !== true) return {body, outcome: allowed, text};
    return {body, outcome: mcpFailureSchema.parse(body).error.code, text};
  }

  async function signInAdministrator(): Promise<ApplicationCookies> {
    const localBrowserToken = await issueLocalBrowserLogin(server, installation);
    const login = await fetch(
      `${server.baseUrl}/auth/local?token=${localBrowserToken}`,
      {redirect: "manual"},
    );
    if (login.status !== 303) {
      throw new Error(`The administrator login failed with ${login.status}.`);
    }
    return applicationCookies(login.headers.getSetCookie());
  }

  async function issueKey(
    cookies: ApplicationCookies,
    capabilities: readonly string[],
    name: string,
  ): Promise<string> {
    const response = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify({
        capabilities,
        expiresAt: "2099-01-01T00:00:00.000Z",
        name,
      }),
      headers: new Headers({
        "Content-Type": "application/json",
        Cookie: cookies.header,
        Origin: server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": cookies.csrf,
      }),
      method: "POST",
    });
    expect(response.status).toBe(201);
    return issuedKeySchema.parse(await response.json()).token;
  }
});

/** Run one asynchronous step at a time, preserving input order. */
async function inSequence<Item, Result>(
  items: readonly Item[],
  run: (item: Item) => Promise<Result>,
): Promise<readonly Result[]> {
  const [first, ...rest] = items;
  if (first === undefined) return [];
  const head = await run(first);
  return [head, ...await inSequence(rest, run)];
}

function mcpIdempotencyKey(): string {
  return `mcp-009-mcp-${crypto.randomUUID()}`;
}

function expectedOutcome(label: CallerLabel, operation: Operation): string {
  if (label === "anonymous") return unauthenticated;
  if (operation === "artifact.get-deleted") {
    return projectReachingCallers.has(label) &&
        expectedAllowed.get(label)?.has("artifact.get") === true
      ? notFound
      : denied;
  }
  return expectedAllowed.get(label)?.has(operation) === true ? allowed : denied;
}

function observe(
  result: CallResult,
  project: (body: JsonValue) => JsonValue,
): SurfaceResult {
  return result.outcome === allowed
    ? {observation: JSON.stringify(project(result.body)), outcome: allowed}
    : {observation: null, outcome: result.outcome};
}

function httpVersionIds(body: JsonValue): readonly string[] {
  return httpVersionListSchema.parse(body).versions.map((entry) => entry.version.id);
}

function artifactRoute(artifactId: string): string {
  return `/api/v1/artifacts/${artifactId}?projectId=${projectId}`;
}

function applicationCookies(
  setCookieHeaders: readonly string[],
): ApplicationCookies {
  const session = setCookieHeaders.find((value) =>
    value.startsWith("artifact_session=")
  );
  const csrf = setCookieHeaders.find((value) =>
    value.startsWith("artifact_csrf=")
  );
  const sessionPair = session?.split(";", 1)[0];
  const csrfPair = csrf?.split(";", 1)[0];
  if (sessionPair === undefined || csrfPair === undefined) {
    throw new Error("The login response did not issue both application cookies.");
  }
  return {
    csrf: csrfPair.slice(csrfPair.indexOf("=") + 1),
    header: `${sessionPair}; ${csrfPair}`,
  };
}

type Surface = "http" | "mcp";

type JsonValue =
  | boolean
  | number
  | string
  | null
  | readonly JsonValue[]
  | JsonObject;

interface JsonObject {
  readonly [key: string]: JsonValue;
}

interface CallResult {
  readonly body: JsonValue;
  readonly outcome: string;
  readonly text: string;
}

interface SurfaceResult {
  readonly observation: string | null;
  readonly outcome: string;
}

interface Mutation {
  readonly operation: Operation;
  readonly run: (token: string | null) => Promise<CallResult>;
}

interface Target {
  readonly artifactId: string;
  readonly firstVersionId: string;
  readonly name: string;
  readonly secondVersionId: string;
}

interface ReadFixture {
  readonly deleted: Target;
  readonly private: Target;
  readonly public: {readonly artifactId: string; readonly versionId: string};
}

interface PlannedUpload {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly plan: {
    readonly commitUrl: string | null;
    readonly uploadId: string | null;
    readonly uploadUrls: readonly string[];
  } | null;
  readonly response: CallResult;
}

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}
