import {randomUUID} from "node:crypto";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {BearerCredentialVerifier} from "../../src/application/authentication.js";
import {publishPath, type FilePublicationTarget} from "../../src/client/file-publication-client.js";
import {AuthenticationRequired} from "../../src/core/errors.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../../src/core/identity.js";
import {previewSourceFixture, writePreviewSourceFixture} from "../support/claude-design-fixture.js";
import {
  createStagedUpload,
  publishNew,
  publishVersion,
  requireSuccessfulUploads,
  testSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const protocolVersion = "2026-07-28";
const tokens = {
  agent: "cnd-agent-service-credential",
  delegated: "cnd-delegated-human-credential",
  editor: "cnd-direct-human-editor-credential",
  otherProject: "cnd-other-project-human-credential",
} as const;

const principals: ReadonlyMap<string, Principal> = new Map([
  [tokens.editor, {
    authorizedByPrincipalId: null,
    capabilities: [],
    displayName: "Robin Reviewer",
    id: "usr_cnd_editor",
    installationId: "local",
    kind: principalKinds.human,
    membershipRole: membershipRoles.member,
    projectIds: [],
  }],
  [tokens.delegated, {
    authorizedByPrincipalId: "usr_cnd_editor",
    capabilities: [],
    displayName: "Agent acting for Robin",
    id: "usr_cnd_delegated",
    installationId: "local",
    kind: principalKinds.human,
    membershipRole: membershipRoles.member,
    projectIds: [],
  }],
  [tokens.agent, {
    authorizedByPrincipalId: null,
    capabilities: [
      principalCapabilities.createArtifact,
      principalCapabilities.publishAnyArtifact,
      principalCapabilities.readArtifacts,
      principalCapabilities.writeComments,
      principalCapabilities.manageAnyArtifact,
    ],
    displayName: "Build agent",
    id: "service:cnd_build_agent",
    installationId: "local",
    kind: principalKinds.service,
    membershipRole: membershipRoles.member,
    projectIds: [],
  }],
  [tokens.otherProject, {
    authorizedByPrincipalId: null,
    capabilities: [],
    displayName: "Other project reviewer",
    id: "usr_cnd_other_project",
    installationId: "local",
    kind: principalKinds.human,
    membershipRole: membershipRoles.member,
    projectIds: ["prj_cnd_elsewhere"],
  }],
]);

const verifier: BearerCredentialVerifier = {
  verify: (credential) => {
    const principal = principals.get(Redacted.value(credential));
    return principal === undefined
      ? Effect.fail(new AuthenticationRequired({message: "Unknown CND test credential."}))
      : Effect.succeed(principal);
  },
};

const versionSchema = z.object({
  artifactId: z.string(),
  baseVersionId: z.string().nullable(),
  contentToken: z.string(),
  id: z.string(),
  manifestDigest: z.string(),
  number: z.number().int().positive(),
  state: z.enum(["mainline", "candidate", "promoted", "rejected", "superseded"]),
}).loose();
const stateSchema = z.object({
  artifact: z.object({currentVersionId: z.string(), id: z.string()}).loose(),
  links: z.object({version: z.url()}).loose(),
  replayed: z.boolean(),
  version: versionSchema,
}).loose();
const listSchema = z.object({
  versions: z.array(z.object({links: z.object({review: z.url(), version: z.url()}).loose(), version: versionSchema}).loose()),
}).loose();
const detailsSchema = z.object({
  artifact: z.object({currentVersionId: z.string()}).loose(),
  current: z.object({version: versionSchema}).loose(),
}).loose();
const failureSchema = z.object({error: z.object({code: z.string(), message: z.string()})});
const jsonSchema = z.json();
type JsonValue = z.infer<typeof jsonSchema>;
type JsonObject = Readonly<Record<string, JsonValue>>;
const actionsSchema = z.object({
  actions: z.array(z.object({action: z.string(), versionId: z.string()}).loose()),
}).loose();

describe("candidate versions", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation, {
      externalApiBearerVerifier: verifier,
      externalMcpBearerVerifier: verifier,
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function stageRaw(
    token: string,
    artifactId: string,
    base: string,
    content: string,
    key: string,
    staged = true,
  ): Promise<Response> {
    const file = testSiteFile(content);
    const upload = await createStagedUpload(server, {apiToken: token}, file.path, [file], "prj_default");
    await requireSuccessfulUploads(uploadEveryStagedFile({apiToken: token}, upload.body, [file]));
    return fetch(upload.body.commitUrl, {
      body: JSON.stringify({target: {artifactId, expectedCurrentVersionId: base, kind: "new_version", stage: staged}}),
      headers: bearer(token, key),
      method: "POST",
    });
  }

  async function stage(token: string, artifactId: string, base: string, content: string, key: string) {
    const response = await stageRaw(token, artifactId, base, content, key);
    // 201 for a new commit, 200 for a replay.
    expect([200, 201]).toContain(response.status);
    return stateSchema.parse(await response.json());
  }

  function decide(
    token: string,
    artifactId: string,
    versionId: string,
    action: "promote" | "reject",
    key: string,
    body: {readonly outcome: string} | null = null,
    projectId = "prj_default",
  ): Promise<Response> {
    const url = new URL(
      `/api/v1/artifacts/${artifactId}/versions/${versionId}/${action}?projectId=${projectId}`,
      server.baseUrl,
    );
    return body === null
      ? fetch(url, {headers: bearer(token, key), method: "POST"})
      : fetch(url, {body: JSON.stringify(body), headers: bearer(token, key), method: "POST"});
  }

  async function errorCode(response: Response): Promise<string> {
    return failureSchema.parse(await response.json()).error.code;
  }

  async function details(artifactId: string) {
    const response = await get(installation.apiToken, `/api/v1/artifacts/${artifactId}?projectId=prj_default`);
    expect(response.status).toBe(200);
    return detailsSchema.parse(await response.json());
  }

  async function listed(artifactId: string, filter?: string) {
    const query = filter === undefined ? "?projectId=prj_default" : `?projectId=prj_default&filter=${filter}`;
    const response = await get(installation.apiToken, `/api/v1/artifacts/${artifactId}/versions${query}`);
    expect(response.status).toBe(200);
    return listSchema.parse(await response.json()).versions.map(({version}) => version);
  }

  function get(token: string, route: string): Promise<Response> {
    return fetch(new URL(route, server.baseUrl), {headers: {Authorization: `Bearer ${token}`}});
  }

  async function readExact(artifactId: string, versionId: string, link: string): Promise<string> {
    const session = await fetch(new URL(
      `/api/v1/artifacts/${artifactId}/versions/${versionId}/content-sessions`,
      server.baseUrl,
    ), {headers: {Authorization: `Bearer ${installation.apiToken}`}, method: "POST"});
    expect(session.status).toBe(201);
    const {bootstrapUrl} = z.object({bootstrapUrl: z.url()}).loose().parse(await session.json());
    const exchange = await fetchVersion(server, bootstrapUrl);
    const cookie = exchange.headers.get("set-cookie") ?? "";
    return (await fetchVersion(server, link, "GET", {Cookie: cookie})).text();
  }

  async function seed(key: string, accessSetting: "account_required" | "public_link" = "account_required") {
    const first = await publishNew(server, installation, {
      accessSetting,
      content: `<!doctype html><title>${key} accepted</title>`,
      idempotencyKey: `candidate-versions-${key}-first`,
      name: `Candidate ${key}`,
    });
    expect(first.response.status).toBe(201);
    return first.body;
  }

  test("CND-001-B: a staged publish creates an immutable candidate while every current-reading surface stays on the accepted version", async () => {
    const first = await seed("cnd1b", "public_link");
    const artifactId = first.artifact.id;
    const candidate = await stage(tokens.agent, artifactId, first.version.id, "<!doctype html><title>Candidate bytes</title>", "cnd1b-stage");

    expect(candidate.version).toMatchObject({baseVersionId: first.version.id, number: 2, state: "candidate"});
    expect(candidate.artifact.currentVersionId).toBe(first.version.id);
    expect((await details(artifactId)).artifact.currentVersionId).toBe(first.version.id);

    // The stable public link still redirects to the accepted version's exact link.
    const stable = await fetch(first.links.artifact, {redirect: "manual"});
    expect(stable.headers.get("location")).toBe(first.links.version);
    expect(await (await fetchVersion(server, first.links.version)).text()).toContain("cnd1b accepted");
    // The candidate's exact link is not public: public links read current only.
    expect((await fetchVersion(server, candidate.links.version)).status).toBe(401);
    // An authorized reviewer opens the exact candidate bytes by version ID.
    expect(await readExact(artifactId, candidate.version.id, candidate.links.version)).toContain("Candidate bytes");

    // The default versions list and the artifact list count accepted history only.
    expect((await listed(artifactId)).map((version) => version.id)).toEqual([first.version.id]);
    const candidates = await listed(artifactId, "candidates");
    expect(candidates.map((version) => [version.id, version.state, version.baseVersionId]))
      .toEqual([[candidate.version.id, "candidate", first.version.id]]);
    const artifacts = z.object({
      artifacts: z.array(z.object({artifact: z.object({id: z.string()}).loose(), versionCount: z.number()}).loose()),
    }).loose().parse(await (await get(installation.apiToken, "/api/v1/artifacts")).json());
    expect(artifacts.artifacts.find((item) => item.artifact.id === artifactId)?.versionCount).toBe(1);

    // The candidate is immutable: its metadata is stable and replaying the stage returns it unchanged.
    const replay = await stage(tokens.agent, artifactId, first.version.id, "<!doctype html><title>Candidate bytes</title>", "cnd1b-stage");
    expect(replay.replayed).toBe(true);
    expect(replay.version).toEqual(candidate.version);

    // Over MCP an agent stages the same way and lists candidates by filter.
    const mcpList = await mcpTool(tokens.agent, "artifact_version_list", {artifactId, filter: "candidates"});
    expect(z.object({versions: z.array(z.object({id: z.string(), state: z.string()}).loose())}).loose().parse(mcpList)
      .versions.map((version) => [version.id, version.state])).toEqual([[candidate.version.id, "candidate"]]);
    const mcpDefault = await mcpTool(tokens.agent, "artifact_version_list", {artifactId});
    expect(z.object({versions: z.array(z.object({id: z.string()}).loose())}).loose().parse(mcpDefault)
      .versions.map((version) => version.id)).toEqual([first.version.id]);
  });

  test("CND-001-F: a late or reused staged publish cannot move current, reuse an ordinary publish, or reach the Library", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cnd-library-"));
    try {
      await writePreviewSourceFixture(directory);
      const publishGallery = (target: FilePublicationTarget, key: string) => Effect.runPromise(publishPath(
        {apiToken: Redacted.make(installation.apiToken), serverOrigin: server.baseUrl},
        {idempotencyKey: key, inputPath: directory, projectId: "prj_default", target},
      ).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(NodeFileSystem.layer)));
      const first = await publishGallery({accessSetting: "account_required", kind: "new_artifact", name: "Gallery", tags: []}, randomUUID());
      await writeFile(path.join(directory, "artifactserver.previews.json"), JSON.stringify({...previewSourceFixture(), title: "Candidate title"}));
      const candidate = await publishGallery({
        artifactId: first.artifact.id,
        expectedCurrentVersionId: first.version.id,
        kind: "new_version",
        stage: true,
      }, randomUUID());
      expect(candidate.artifact.currentVersionId).toBe(first.version.id);
      const library = z.object({galleries: z.array(z.object({artifactId: z.string(), versionId: z.string()}).loose())}).loose()
        .parse(await (await get(installation.apiToken, "/api/v1/library")).json());
      expect(library.galleries.find((gallery) => gallery.artifactId === first.artifact.id)?.versionId).toBe(first.version.id);

      // A staged publish whose base is no longer current is refused and creates nothing.
      const newer = await publishVersion(server, installation, {
        artifactId: first.artifact.id,
        content: "<!doctype html><title>Newer accepted</title>",
        expectedCurrentVersionId: first.version.id,
        idempotencyKey: "candidate-versions-cnd1f-newer",
      });
      const late = await stageRaw(tokens.agent, first.artifact.id, first.version.id, "<!doctype html><title>Late build</title>", "cnd1f-late");
      expect(late.status).toBe(409);
      expect(await errorCode(late)).toBe("PUBLISH_CONFLICT");
      expect((await details(first.artifact.id)).artifact.currentVersionId).toBe(newer.body.version.id);
      expect((await listed(first.artifact.id, "all")).map((version) => version.number)).toEqual([3, 2, 1]);

      // The replay identity includes `stage`: an ordinary publish cannot replay a staged one.
      const staged = await stage(tokens.agent, first.artifact.id, newer.body.version.id, "<!doctype html><title>Same bytes</title>", "cnd1f-same-key");
      const ordinary = await stageRaw(tokens.agent, first.artifact.id, newer.body.version.id, "<!doctype html><title>Same bytes</title>", "cnd1f-same-key", false);
      expect(ordinary.status).toBe(409);
      expect(await errorCode(ordinary)).toBe("IDEMPOTENCY_CONFLICT");
      expect((await details(first.artifact.id)).artifact.currentVersionId).toBe(newer.body.version.id);
      expect(staged.version.state).toBe("candidate");
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });

  test("CND-002-B: a person promotes the exact reviewed candidate with no new version, idempotently, as its own audited action", async () => {
    const first = await seed("cnd2b");
    const artifactId = first.artifact.id;
    const candidate = await stage(tokens.agent, artifactId, first.version.id, "<!doctype html><title>Reviewed</title>", "cnd2b-stage");

    const promoted = await decide(tokens.editor, artifactId, candidate.version.id, "promote", "cnd2b-promote");
    expect(promoted.status).toBe(200);
    const state = stateSchema.parse(await promoted.json());
    expect(state.replayed).toBe(false);
    expect(state.artifact.currentVersionId).toBe(candidate.version.id);
    expect(state.version).toMatchObject({
      contentToken: candidate.version.contentToken,
      id: candidate.version.id,
      manifestDigest: candidate.version.manifestDigest,
      number: 2,
      state: "promoted",
    });
    const current = await details(artifactId);
    expect(current.current.version.id).toBe(candidate.version.id);
    expect((await listed(artifactId, "all")).map((version) => version.id)).toEqual([candidate.version.id, first.version.id]);
    expect(await readExact(artifactId, candidate.version.id, candidate.links.version)).toContain("Reviewed");

    const replay = await decide(tokens.editor, artifactId, candidate.version.id, "promote", "cnd2b-promote");
    expect(replay.status).toBe(200);
    expect(stateSchema.parse(await replay.json())).toMatchObject({replayed: true, version: {id: candidate.version.id}});

    const actions = actionsSchema.parse(await (await get(installation.apiToken, `/api/v1/artifacts/${artifactId}/actions`)).json());
    expect(actions.actions.filter((action) => action.action.startsWith("candidate_")))
      .toEqual([
        expect.objectContaining({action: "candidate_promote", principalId: "usr_cnd_editor", versionId: candidate.version.id}),
        expect.objectContaining({action: "candidate_stage", principalId: "service:cnd_build_agent", versionId: candidate.version.id}),
      ]);
    expect(actions.actions.filter((action) => action.action === "restore")).toEqual([]);
  });

  test("CND-002-F: promotion refuses a reused key, a mainline version, and an unknown version without changing current", async () => {
    const first = await seed("cnd2f");
    const artifactId = first.artifact.id;
    const one = await stage(tokens.agent, artifactId, first.version.id, "<!doctype html><title>One</title>", "cnd2f-one");
    const two = await stage(tokens.agent, artifactId, first.version.id, "<!doctype html><title>Two</title>", "cnd2f-two");
    expect((await decide(tokens.editor, artifactId, one.version.id, "promote", "cnd2f-key")).status).toBe(200);
    // Two is now stale; reusing one's key for two is an idempotency conflict, not a replay.
    const reused = await decide(tokens.editor, artifactId, two.version.id, "promote", "cnd2f-key");
    expect(reused.status).toBe(409);
    expect(await errorCode(reused)).toBe("IDEMPOTENCY_CONFLICT");
    const mainline = await decide(tokens.editor, artifactId, first.version.id, "promote", "cnd2f-mainline");
    expect(mainline.status).toBe(409);
    expect(await errorCode(mainline)).toBe("CANDIDATE_NOT_OPEN");
    const unknown = await decide(tokens.editor, artifactId, "ver_00000000-0000-4000-8000-000000000000", "promote", "cnd2f-unknown");
    expect(unknown.status).toBe(404);
    expect(await errorCode(unknown)).toBe("VERSION_NOT_FOUND");
    const missingKey = await fetch(new URL(`/api/v1/artifacts/${artifactId}/versions/${two.version.id}/promote`, server.baseUrl), {
      headers: {Authorization: `Bearer ${tokens.editor}`},
      method: "POST",
    });
    expect(missingKey.status).toBe(422);
    expect((await details(artifactId)).artifact.currentVersionId).toBe(one.version.id);
  });

  test("CND-003-B: promotion is refused with CANDIDATE_STALE once current has moved past the candidate's base", async () => {
    const first = await seed("cnd3b");
    const artifactId = first.artifact.id;
    const candidate = await stage(tokens.agent, artifactId, first.version.id, "<!doctype html><title>Stale</title>", "cnd3b-stage");
    const newer = await publishVersion(server, installation, {
      artifactId,
      content: "<!doctype html><title>Accepted in between</title>",
      expectedCurrentVersionId: first.version.id,
      idempotencyKey: "candidate-versions-cnd3b-newer",
    });
    const refused = await decide(tokens.editor, artifactId, candidate.version.id, "promote", "cnd3b-promote");
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("CANDIDATE_STALE");
    expect((await details(artifactId)).artifact.currentVersionId).toBe(newer.body.version.id);
    const after = (await listed(artifactId, "all")).find((version) => version.id === candidate.version.id);
    expect(after?.state).toBe("candidate");
    // The accepted change made in between is never silently discarded.
    expect((await listed(artifactId)).map((version) => version.id)).toEqual([newer.body.version.id, first.version.id]);
  });

  test("CND-003-F: racing promotions of two candidates on one base accept exactly one, and the loser stays a candidate", async () => {
    const first = await seed("cnd3f");
    const artifactId = first.artifact.id;
    const left = await stage(tokens.agent, artifactId, first.version.id, "<!doctype html><title>Left</title>", "cnd3f-left");
    const right = await stage(tokens.agent, artifactId, first.version.id, "<!doctype html><title>Right</title>", "cnd3f-right");
    const outcomes = await Promise.all([
      decide(tokens.editor, artifactId, left.version.id, "promote", "cnd3f-left-promote"),
      decide(tokens.editor, artifactId, right.version.id, "promote", "cnd3f-right-promote"),
    ]);
    expect(outcomes.map((response) => response.status).toSorted((lower, higher) => lower - higher)).toEqual([200, 409]);
    const loser = outcomes[0]?.status === 409 ? outcomes[0] : outcomes[1];
    expect(await errorCode(loser ?? new Response("{}"))).toBe("CANDIDATE_STALE");
    const current = (await details(artifactId)).artifact.currentVersionId;
    expect([left.version.id, right.version.id]).toContain(current);
    const losingId = current === left.version.id ? right.version.id : left.version.id;
    expect((await listed(artifactId, "candidates")).map((version) => version.id)).toEqual([losingId]);
    // Restore cannot carry the stale loser past the accepted winner either.
    const restore = await fetch(new URL(`/api/v1/artifacts/${artifactId}/restore`, server.baseUrl), {
      body: JSON.stringify({expectedCurrentVersionId: current, versionId: losingId}),
      headers: bearer(tokens.editor, "cnd3f-restore"),
      method: "POST",
    });
    expect(restore.status).toBe(409);
    expect(await errorCode(restore)).toBe("VERSION_NOT_RESTORABLE");
    expect((await details(artifactId)).artifact.currentVersionId).toBe(current);
  });

  test("CND-004-B: an agent stages and comments on a candidate, and only a person signed in directly promotes it", async () => {
    const first = await seed("cnd4b");
    const artifactId = first.artifact.id;
    const candidate = await stage(tokens.agent, artifactId, first.version.id, "<!doctype html><title>Agent build</title>", "cnd4b-stage");
    const comment = await fetch(new URL(`/api/v1/artifacts/${artifactId}/versions/${candidate.version.id}/comments`, server.baseUrl), {
      body: JSON.stringify({body: "Build passed; ready for review."}),
      headers: bearer(tokens.agent, `comment:${randomUUID()}`),
      method: "POST",
    });
    expect(comment.status).toBe(201);
    const agentPromote = await decide(tokens.agent, artifactId, candidate.version.id, "promote", "cnd4b-agent");
    expect(agentPromote.status).toBe(403);
    expect(await errorCode(agentPromote)).toBe("AUTHORIZATION_DENIED");
    const promoted = await decide(tokens.editor, artifactId, candidate.version.id, "promote", "cnd4b-human");
    expect(promoted.status).toBe(200);
    expect((await details(artifactId)).artifact.currentVersionId).toBe(candidate.version.id);
  });

  test("CND-004-F: keys, delegated agents, MCP, and callers from another project can never promote", async () => {
    const first = await seed("cnd4f");
    const artifactId = first.artifact.id;
    const candidate = await stage(tokens.agent, artifactId, first.version.id, "<!doctype html><title>Pending</title>", "cnd4f-stage");
    for (const [token, key] of [
      [installation.apiToken, "cnd4f-installation-key"],
      [tokens.agent, "cnd4f-agent"],
      [tokens.delegated, "cnd4f-delegated"],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked against unchanged state
      const refused = await decide(token, artifactId, candidate.version.id, "promote", key);
      expect(refused.status).toBe(403);
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked against unchanged state
      expect(await errorCode(refused)).toBe("AUTHORIZATION_DENIED");
    }
    // A delegated agent cannot even reject: it holds no publication authority of its own.
    const delegatedReject = await decide(tokens.delegated, artifactId, candidate.version.id, "reject", "cnd4f-delegated-reject");
    expect(delegatedReject.status).toBe(403);

    // A person whose access is limited to another project learns nothing about this one.
    const foreign = await decide(tokens.otherProject, artifactId, candidate.version.id, "promote", "cnd4f-foreign");
    expect(foreign.status).toBe(404);
    const foreignReject = await decide(tokens.otherProject, artifactId, candidate.version.id, "reject", "cnd4f-foreign-reject");
    expect(foreignReject.status).toBe(404);
    // Naming another project for this artifact finds nothing to promote.
    const project = await fetch(new URL("/api/v1/projects", server.baseUrl), {
      body: JSON.stringify({name: "Elsewhere"}),
      headers: bearer(installation.apiToken, "cnd4f-project"),
      method: "POST",
    });
    expect(project.status).toBe(201);
    const otherProjectId = z.object({project: z.object({id: z.string()}).loose()}).loose().parse(await project.json()).project.id;
    const crossProject = await decide(tokens.editor, artifactId, candidate.version.id, "promote", "cnd4f-cross", null, otherProjectId);
    expect(crossProject.status).toBe(404);
    expect(await errorCode(crossProject)).toBe("ARTIFACT_NOT_FOUND");

    // MCP offers staging but no promotion tool at all.
    const tools = await mcpToolNames(tokens.editor);
    expect(tools).toContain("artifact_commit_upload");
    expect(tools.filter((name) => name.includes("promote"))).toEqual([]);

    expect((await details(artifactId)).artifact.currentVersionId).toBe(first.version.id);
    expect((await listed(artifactId, "candidates")).map((version) => version.id)).toEqual([candidate.version.id]);
  });

  test("CND-005-B: rejected and superseded candidates are terminal, hidden by default, and keep bytes, comments, and provenance", async () => {
    const first = await seed("cnd5b");
    const artifactId = first.artifact.id;
    const rejected = await stage(tokens.agent, artifactId, first.version.id, "<!doctype html><title>Rejected bytes</title>", "cnd5b-one");
    const superseded = await stage(tokens.agent, artifactId, first.version.id, "<!doctype html><title>Superseded bytes</title>", "cnd5b-two");
    const comment = await fetch(new URL(`/api/v1/artifacts/${artifactId}/versions/${rejected.version.id}/comments`, server.baseUrl), {
      body: JSON.stringify({body: "The chart axis is wrong."}),
      headers: bearer(tokens.editor, `comment:${randomUUID()}`),
      method: "POST",
    });
    expect(comment.status).toBe(201);

    const reject = await decide(tokens.editor, artifactId, rejected.version.id, "reject", "cnd5b-reject");
    expect(reject.status).toBe(200);
    expect(stateSchema.parse(await reject.json())).toMatchObject({
      artifact: {currentVersionId: first.version.id},
      version: {id: rejected.version.id, state: "rejected"},
    });
    const replay = await decide(tokens.editor, artifactId, rejected.version.id, "reject", "cnd5b-reject");
    expect(stateSchema.parse(await replay.json())).toMatchObject({replayed: true, version: {state: "rejected"}});
    const supersede = await decide(tokens.agent, artifactId, superseded.version.id, "reject", "cnd5b-supersede", {outcome: "superseded"});
    expect(supersede.status).toBe(200);
    expect(stateSchema.parse(await supersede.json()).version.state).toBe("superseded");

    expect((await listed(artifactId)).map((version) => version.id)).toEqual([first.version.id]);
    expect((await listed(artifactId, "candidates"))).toEqual([]);
    expect((await listed(artifactId, "all")).map((version) => [version.id, version.state])).toEqual([
      [superseded.version.id, "superseded"],
      [rejected.version.id, "rejected"],
      [first.version.id, "mainline"],
    ]);
    expect(await readExact(artifactId, rejected.version.id, rejected.links.version)).toContain("Rejected bytes");
    const comments = z.object({items: z.array(z.object({body: z.string(), versionId: z.string()}).loose())}).loose()
      .parse(await (await get(installation.apiToken, `/api/v1/artifacts/${artifactId}/comments`)).json());
    expect(comments.items.map((thread) => [thread.versionId, thread.body]))
      .toEqual([[rejected.version.id, "The chart axis is wrong."]]);
    const metadata = versionSchema.parse(z.object({version: z.unknown()}).loose().parse(await (await get(
      installation.apiToken,
      `/api/v1/artifacts/${artifactId}/versions/${rejected.version.id}`,
    )).json()).version);
    expect(metadata).toMatchObject({manifestDigest: rejected.version.manifestDigest, state: "rejected"});
  });

  test("CND-005-F: a closed candidate can be neither promoted, reopened, nor restored, and restore never targets an open candidate", async () => {
    const first = await seed("cnd5f");
    const artifactId = first.artifact.id;
    const closed = await stage(tokens.agent, artifactId, first.version.id, "<!doctype html><title>Closed</title>", "cnd5f-closed");
    const open = await stage(tokens.agent, artifactId, first.version.id, "<!doctype html><title>Open</title>", "cnd5f-open");
    expect((await decide(tokens.editor, artifactId, closed.version.id, "reject", "cnd5f-reject")).status).toBe(200);

    const promoteRejected = await decide(tokens.editor, artifactId, closed.version.id, "promote", "cnd5f-promote");
    expect(promoteRejected.status).toBe(409);
    expect(await errorCode(promoteRejected)).toBe("CANDIDATE_NOT_OPEN");
    const reclose = await decide(tokens.editor, artifactId, closed.version.id, "reject", "cnd5f-reclose", {outcome: "superseded"});
    expect(reclose.status).toBe(409);
    expect(await errorCode(reclose)).toBe("CANDIDATE_NOT_OPEN");
    const badOutcome = await decide(tokens.editor, artifactId, open.version.id, "reject", "cnd5f-bad", {outcome: "promoted"});
    expect(badOutcome.status).toBe(422);
    for (const [versionId, key] of [[closed.version.id, "cnd5f-restore-closed"], [open.version.id, "cnd5f-restore-open"]] as const) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked against unchanged state
      const restore = await fetch(new URL(`/api/v1/artifacts/${artifactId}/restore`, server.baseUrl), {
        body: JSON.stringify({expectedCurrentVersionId: first.version.id, versionId}),
        headers: bearer(installation.apiToken, key),
        method: "POST",
      });
      expect(restore.status).toBe(409);
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked against unchanged state
      expect(await errorCode(restore)).toBe("VERSION_NOT_RESTORABLE");
    }
    const mcpRestore = await mcpTool(tokens.agent, "artifact_restore_version", {
      artifactId,
      expectedCurrentVersionId: first.version.id,
      idempotencyKey: "candidate-versions-cnd5f-mcp-restore",
      versionId: open.version.id,
    });
    expect(z.object({error: z.object({code: z.string()}).loose()}).loose().parse(mcpRestore).error.code)
      .toBe("VERSION_NOT_RESTORABLE");
    expect((await details(artifactId)).artifact.currentVersionId).toBe(first.version.id);
    expect((await listed(artifactId, "all")).find((version) => version.id === closed.version.id)?.state).toBe("rejected");
  });

  async function mcpTool(token: string, name: string, parameters: JsonObject): Promise<JsonValue> {
    const response = await mcpRequest(token, "tools/call", {arguments: parameters, name}, name);
    const result = z.object({
      result: z.object({isError: z.boolean().optional(), structuredContent: z.unknown()}).loose(),
    }).loose().parse(JSON.parse(await response.text())).result;
    return jsonSchema.parse(result.structuredContent);
  }

  async function mcpToolNames(token: string): Promise<readonly string[]> {
    const response = await mcpRequest(token, "tools/list", {}, null);
    return z.object({result: z.object({tools: z.array(z.object({name: z.string()}).loose())}).loose()}).loose()
      .parse(JSON.parse(await response.text())).result.tools.map((tool) => tool.name);
  }

  async function mcpRequest(token: string, method: string, params: JsonObject, name: string | null) {
    const headers = new Headers({
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": protocolVersion,
      "Mcp-Method": method,
    });
    if (name !== null) headers.set("Mcp-Name", name);
    const response = await fetch(`${server.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: randomUUID(),
        jsonrpc: "2.0",
        method,
        params: {
          ...params,
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: {name: "artifact-server-cnd-test", version: "1"},
            [PROTOCOL_VERSION_META_KEY]: protocolVersion,
          },
        },
      }),
      headers,
      method: "POST",
    });
    expect(response.status).toBe(200);
    return response;
  }
});

function bearer(token: string, idempotencyKey: string): Headers {
  return new Headers({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    // Keys are at least 16 characters; a shared prefix keeps each test's labels short.
    "Idempotency-Key": idempotencyKey.startsWith("comment:") ? idempotencyKey : `candidate-versions-${idempotencyKey}`,
  });
}
