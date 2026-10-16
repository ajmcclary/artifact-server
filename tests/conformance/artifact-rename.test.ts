import {DatabaseSync} from "node:sqlite";
import path from "node:path";

import {randomUUID} from "node:crypto";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {apiHeaders, createTestInstallation, fetchVersion, removeTestInstallation,
  startTestServer, type RunningTestServer, type TestInstallation} from "../support/runtime-harness.js";
import {publishNew, publishVersion} from "../support/publishing.js";

const stateSchema = z.object({artifact: z.object({id: z.string(), name: z.string(), currentVersionId: z.string()}),
  replayed: z.boolean(), version: z.object({id: z.string()})});
const actionsSchema = z.object({actions: z.array(z.object({action: z.string(), principalId: z.string()}))});

describe("artifact rename", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });
  afterEach(async () => { await server.stop(); await removeTestInstallation(installation); });
  const read = async (resourcePath: string) => {
    const response = await fetch(`${server.baseUrl}/api/v1/${resourcePath}`, {headers: new Headers({Authorization: `Bearer ${installation.apiToken}`})});
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    return body;
  };
  const rename = (artifactId: string, versionId: string, expectedName: string, name: string,
    key = randomUUID(), extra = {}) => fetch(`${server.baseUrl}/api/v1/artifacts/${artifactId}/name`, {
      method: "PATCH", headers: apiHeaders(installation, key),
      body: JSON.stringify({expectedCurrentVersionId: versionId, expectedName, name, ...extra}),
    });

  test("ART-012-B ART-012-F: rename changes metadata and search while preserving immutable publication and rejecting unsafe input", async () => {
    const published = await publishNew(server, installation, {name: "Apple Systems Design System",
      accessSetting: "public_link", content: "immutable design", tags: ["design"], idempotencyKey: randomUUID()});
    const {id} = published.body.artifact;
    const version = published.body.version.id;
    const commented = await fetch(`${server.baseUrl}/api/v1/artifacts/${id}/versions/${version}/comments`, {
      method: "POST", headers: apiHeaders(installation, randomUUID()), body: JSON.stringify({body: "Keep this feedback."}),
    });
    expect(commented.status).toBe(201);
    const before = await read(`artifacts/${id}`);
    const versions = await read(`artifacts/${id}/versions`);
    const threads = await read(`artifacts/${id}/comments`);
    const changed = await rename(id, version, published.body.artifact.name, "  Design System  ");
    expect(changed.status).toBe(200);
    expect(stateSchema.parse(await changed.json())).toMatchObject({artifact: {id, name: "Design System", currentVersionId: version}, replayed: false});
    const port = server.port;
    await server.stop();
    server = await startTestServer(installation, {port});
    const after = await read(`artifacts/${id}`);
    expect(after).toEqual({...z.object({artifact: z.record(z.string(), z.unknown())}).loose().parse(before),
      artifact: {...z.object({artifact: z.record(z.string(), z.unknown())}).parse(before).artifact, name: "Design System"}});
    expect(await read(`artifacts/${id}/versions`)).toEqual(versions);
    expect(await read(`artifacts/${id}/comments`)).toEqual(threads);
    const bytes = await fetchVersion(server, published.body.links.version);
    expect(bytes.status).toBe(200);
    expect(await bytes.text()).toBe("immutable design");
    const list = z.object({artifacts: z.array(z.object({artifact: z.object({id: z.string()})}))});
    expect(list.parse(await read("artifacts?search=Apple%20Systems")).artifacts).toEqual([]);
    expect(list.parse(await read("artifacts?search=DESIGN%20SYSTEM")).artifacts.map((entry) => entry.artifact.id)).toEqual([id]);
    const longest = "名".repeat(200);
    expect((await rename(id, version, "Design System", longest)).status).toBe(200);
    expect((await rename(id, version, longest, "Design System")).status).toBe(200);
    const actions = await read(`artifacts/${id}/actions`);
    const invalid = await Promise.all(["", "   ", "a".repeat(201), "bad\nname", "bad\u0000name", "bad\u202ename", "bad\u200bname", "bad\ud800name", "bad\udfffname"]
      .map((name) => rename(id, version, "Design System", name)));
    expect(invalid.map((response) => response.status)).toEqual(Array.from({length: 9}, () => 422));
    expect((await rename(id, version, "Design System", "Valid", randomUUID(), {path: "/tmp/bad"})).status).toBe(422);
    expect(await read(`artifacts/${id}`)).toEqual(after);
    expect(await read(`artifacts/${id}/actions`)).toEqual(actions);
  });

  test("rename upgrades a populated predecessor database and rolls back an unavailable audit write", async () => {
    const publishKey = randomUUID();
    const input = {name: "Before upgrade", accessSetting: "account_required", content: "Preserved", idempotencyKey: publishKey} as const;
    const published = await publishNew(server, installation, input);
    const port = server.port;
    await server.stop();
    const database = new DatabaseSync(path.join(installation.dataDirectory, "artifact-server.db"));
    try {
      const {sql} = z.object({sql: z.string()}).parse(database.prepare(
        "SELECT sql FROM sqlite_schema WHERE name = 'idempotency_records'",
      ).get());
      const oldSchema = sql.replace(/CREATE TABLE(?: IF NOT EXISTS)? "?idempotency_records"?/iu,
        "CREATE TABLE idempotency_records_previous").replace(", 'rename'", "");
      database.exec(`BEGIN; ${oldSchema};
        INSERT INTO idempotency_records_previous SELECT * FROM idempotency_records;
        DROP TABLE idempotency_records;
        ALTER TABLE idempotency_records_previous RENAME TO idempotency_records;
        PRAGMA user_version = 21; COMMIT;`);
    } finally { database.close(); }
    server = await startTestServer(installation, {port});
    const replayed = await publishNew(server, installation, input);
    expect(replayed.body).toMatchObject({artifact: {id: published.body.artifact.id}, version: published.body.version, replayed: true});
    const audit = new DatabaseSync(path.join(installation.dataDirectory, "artifact-server.db"));
    const key = randomUUID();
    try {
      audit.exec(`CREATE TRIGGER rename_audit_unavailable BEFORE INSERT ON actions
        WHEN NEW.action = 'rename' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
      expect((await rename(published.body.artifact.id, published.body.version.id, "Before upgrade", "After upgrade", key)).status).toBe(500);
      expect(await read(`artifacts/${published.body.artifact.id}`)).toMatchObject({artifact: {name: "Before upgrade"}});
      audit.exec("DROP TRIGGER rename_audit_unavailable");
      const changed = await rename(published.body.artifact.id, published.body.version.id, "Before upgrade", "After upgrade", key);
      expect(changed.status).toBe(200);
      expect(stateSchema.parse(await changed.json())).toMatchObject({replayed: false, artifact: {name: "After upgrade"}});
    } finally { audit.close(); }
  });

  test("ART-013-B ART-013-F: conditional renames race safely and replay durably without overwriting newer names", async () => {
    const published = await publishNew(server, installation, {name: "Original", accessSetting: "account_required",
      content: "private bytes", idempotencyKey: randomUUID()});
    const id = published.body.artifact.id;
    const version = published.body.version.id;
    const keys = [randomUUID(), randomUUID()];
    const responses = await Promise.all([rename(id, version, "Original", "First", keys[0]), rename(id, version, "Original", "Second", keys[1])]);
    expect(responses.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([200, 409]);
    const winner = responses.findIndex((response) => response.status === 200);
    const won = stateSchema.parse(await responses[winner]?.json());
    const key = keys[winner];
    expect(key).toBeDefined();
    expect((await rename(id, version, won.artifact.name, "Latest")).status).toBe(200);
    await server.stop(); server = await startTestServer(installation);
    const replay = await rename(id, version, "Original", won.artifact.name, key);
    expect(stateSchema.parse(await replay.json())).toMatchObject({artifact: {name: won.artifact.name}, replayed: true});
    expect((await rename(id, version, "Original", "Different", key)).status).toBe(409);
    const details = await read(`artifacts/${id}`);
    expect(z.object({artifact: z.object({name: z.string()})}).parse(details).artifact.name).toBe("Latest");
    const actions = actionsSchema.parse(await read(`artifacts/${id}/actions`)).actions;
    expect(actions.filter((action) => action.action === "rename")).toHaveLength(2);
    expect(actions.every((action) => action.principalId.length > 0)).toBe(true);
    const anonymous = await fetch(`${server.baseUrl}/api/v1/artifacts/${id}/name`, {method: "PATCH",
      headers: {"content-type": "application/json"}, body: JSON.stringify({name: "Hidden", expectedName: "Latest", expectedCurrentVersionId: version})});
    expect(anonymous.status).toBe(401);
    expect((await rename("art_missing", version, "Latest", "Hidden")).status).toBe(404);
    const newVersion = await publishVersion(server, installation, {artifactId: id, content: "new bytes", expectedCurrentVersionId: version, idempotencyKey: randomUUID()});
    expect((await rename(id, version, "Latest", "Stale")).status).toBe(409);
    expect((await rename(id, newVersion.body.version.id, "Wrong", "Stale")).status).toBe(409);
    const projectResponse = await fetch(`${server.baseUrl}/api/v1/projects`, {method: "POST",
      headers: apiHeaders(installation, randomUUID()), body: JSON.stringify({name: "Other project"})});
    expect(projectResponse.status).toBe(201);
    const project = z.object({project: z.object({id: z.string()})}).parse(await projectResponse.json()).project;
    const crossProject = await fetch(`${server.baseUrl}/api/v1/artifacts/${id}/name?projectId=${project.id}`, {
      method: "PATCH", headers: apiHeaders(installation, randomUUID()),
      body: JSON.stringify({expectedCurrentVersionId: newVersion.body.version.id, expectedName: "Latest", name: "Cross project"}),
    });
    expect(crossProject.status).toBe(404);
    const archivedArtifact = await publishNew(server, installation, {projectId: project.id, name: "Archived artifact",
      accessSetting: "account_required", content: "archive proof", idempotencyKey: randomUUID()});
    const archived = await fetch(`${server.baseUrl}/api/v1/projects/${project.id}/archive`, {method: "POST", headers: apiHeaders(installation, randomUUID())});
    expect(archived.status).toBe(200);
    const refusedArchived = await fetch(`${server.baseUrl}/api/v1/artifacts/${archivedArtifact.body.artifact.id}/name?projectId=${project.id}`, {
      method: "PATCH", headers: apiHeaders(installation, randomUUID()),
      body: JSON.stringify({expectedCurrentVersionId: archivedArtifact.body.version.id, expectedName: "Archived artifact", name: "Forbidden edit"}),
    });
    expect(refusedArchived.status).toBe(409);
    const removed = await fetch(`${server.baseUrl}/api/v1/artifacts/${id}`, {method: "DELETE", headers: apiHeaders(installation, randomUUID()), body: JSON.stringify({expectedCurrentVersionId: newVersion.body.version.id})});
    expect(removed.status).toBe(200);
    expect((await rename(id, newVersion.body.version.id, "Latest", "Gone")).status).toBe(404);
  });
});
