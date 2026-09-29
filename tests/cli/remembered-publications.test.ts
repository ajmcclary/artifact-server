import {spawn} from "node:child_process";
import {mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile} from "node:fs/promises";
import path from "node:path";

import {Effect, Redacted} from "effect";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {expect, test} from "vitest";
import {z} from "zod";

import {publicationReceiptSchema, publicationRecordSchema} from "../../src/cli/publication-record.js";
import {publicationRecordPath} from "../../src/cli/publication-registry.js";
import {resumePublicationOperation} from "../../src/cli/publication-operation-store.js";
import {publicationCliHttpClientLayer} from "../../src/cli/cli-server-connection.js";
import {prepareFilePublication, publishPreparedPath} from "../../src/client/file-publication-client.js";
import {publicationCliFixture, startPublicationCli, type CliResult} from "../support/publication-cli.js";

function receipt(result: CliResult) {
  expect({code: result.code, stderr: result.stderr}).toEqual({code: 0, stderr: ""});
  return publicationReceiptSchema.parse(JSON.parse(result.stdout));
}
function unchanged(result: CliResult): boolean {
  return z.object({unchanged: z.boolean()}).parse(JSON.parse(result.stdout)).unchanged;
}
async function recordFile(profiles: string): Promise<string> {
  const files = (await readdir(path.join(profiles, "publications"))).filter((file) => file.endsWith(".json"));
  expect(files).toHaveLength(1);
  return path.join(profiles, "publications", files[0] ?? "missing");
}

test("CLI-004-B: remembers versions, skips unchanged uploads, imports receipts and preserves publication choices", async () => {
  const fixture = await publicationCliFixture();
  try {
    const first = receipt(await fixture.publish(["--name", " Design ", "--public", "--tag", "Review"]));
    const same = await fixture.publish(["--name", " Design ", "--public", "--tag", "Review"]);
    expect(receipt(same).version.id).toBe(first.version.id);
    expect(unchanged(same)).toBe(true);
    expect(fixture.uploads()).toBe(1);
    await writeFile(path.join(fixture.source, "index.html"), "<h1>second</h1>");
    const second = receipt(await fixture.publish());
    expect(second.artifact.id).toBe(first.artifact.id);
    expect(second.version.number).toBe(2);
    await writeFile(path.join(fixture.source, "other.html"), "<h1>entry</h1>");
    const routed = receipt(await fixture.publish(["--entry", "other.html", "--routing", "spa"]));
    expect(routed.version).toMatchObject({entryPath: "other.html", routingMode: "spa", number: 3});
    const remembered = await fixture.publish();
    expect(receipt(remembered).version.id).toBe(routed.version.id);
    expect(unchanged(remembered)).toBe(true);
    const created = receipt(await fixture.publish(["--new-artifact"]));
    expect(created.artifact.id).not.toBe(first.artifact.id);
    expect(created.version.number).toBe(1);
    expect(receipt(await fixture.publish()).artifact.id).toBe(created.artifact.id);
    const file = await recordFile(fixture.profiles);
    const record = publicationRecordSchema.parse(JSON.parse(await readFile(file, "utf8")));
    expect(record.receipt).toEqual(created);
    expect(record.pending).toBeNull();
    const receiptPath = path.join(fixture.root, "receipt.json");
    await writeFile(receiptPath, JSON.stringify(first));
    expect((await fixture.run(["publications", "import", fixture.source, "--receipt", receiptPath])).stderr).toContain("different artifact");
    await writeFile(receiptPath, JSON.stringify(created));
    await rm(file);
    const uploads = fixture.uploads();
    const imported = await fixture.run(["publications", "import", fixture.source, "--receipt", receiptPath]);
    expect(imported.code).toBe(0);
    expect(fixture.uploads()).toBe(uploads);
    const status = await fixture.run(["publications", "status", fixture.source]);
    expect(JSON.parse(status.stdout)).toMatchObject({status: "current", artifactId: created.artifact.id});
    expect(JSON.parse((await fixture.run(["publications", "list"])).stdout)).toMatchObject({publications: [{artifactId: created.artifact.id}]});
  } finally { await fixture.stop(); }
}, 60_000);

test("CLI-004-F: refuses stale versions, forged imports, corrupt state and deleted artifacts without uploading", async () => {
  const fixture = await publicationCliFixture();
  try {
    const first = receipt(await fixture.publish());
    const savedFile = await recordFile(fixture.profiles);
    const saved = await readFile(savedFile, "utf8");
    const importFile = path.join(fixture.root, "receipt.json");
    await writeFile(importFile, JSON.stringify({...first, version: {...first.version, manifestDigest: "0".repeat(64)}}));
    expect((await fixture.run(["publications", "import", fixture.source, "--receipt", importFile])).code).not.toBe(0);
    await writeFile(importFile, "not JSON");
    expect((await fixture.run(["publications", "import", fixture.source, "--receipt", importFile])).code).not.toBe(0);
    const wrongOrigin = {...first, links: {...first.links, artifact: "https://foreign.example/artifacts/other"}};
    await writeFile(importFile, JSON.stringify(wrongOrigin));
    expect((await fixture.run(["publications", "import", fixture.source, "--receipt", importFile])).code).not.toBe(0);
    await writeFile(path.join(fixture.source, "index.html"), "<h1>another publisher</h1>");
    const other = await startPublicationCli(["publish", fixture.source, ...fixture.destination,
      "--profile-data", path.join(fixture.root, "other-profile"), "--artifact", first.artifact.id, "--expected-version", first.version.id]).result;
    const newer = receipt(other);
    const uploads = fixture.uploads();
    expect((await fixture.publish()).stderr).toContain("Publication conflict");
    await writeFile(importFile, JSON.stringify(first));
    expect((await fixture.run(["publications", "import", fixture.source, "--receipt", importFile])).stderr).toContain("Publication conflict");
    expect((await fixture.run(["publications", "refresh", fixture.source])).code).toBe(0);
    const same = await fixture.publish();
    expect(receipt(same).version.id).toBe(newer.version.id);
    expect(unchanged(same)).toBe(true);
    expect((await fixture.publish(["--name", "Different"])).stderr).toContain("Creation options conflict");
    const current = await readFile(savedFile, "utf8");
    await writeFile(savedFile, "broken state");
    expect((await fixture.publish()).code).not.toBe(0);
    await writeFile(savedFile, current);
    const record = publicationRecordSchema.parse(JSON.parse(current));
    const foreign = {...record, scope: {...record.scope, installationId: "changed-installation"}};
    await rm(savedFile);
    const foreignFile = publicationRecordPath(path.dirname(savedFile), foreign.scope);
    await writeFile(foreignFile, JSON.stringify(foreign));
    expect((await fixture.publish()).stderr).toContain("different installation or principal");
    await rm(foreignFile);
    await writeFile(savedFile, saved);
    const deleted = await fetch(`${fixture.origin}/api/v1/artifacts/${first.artifact.id}`, {
      method: "DELETE", headers: {Authorization: `Bearer ${fixture.installation.apiToken}`, "Content-Type": "application/json", "Idempotency-Key": "delete-remembered-test"},
      body: JSON.stringify({expectedCurrentVersionId: newer.version.id}),
    });
    expect(deleted.ok).toBe(true);
    expect((await fixture.publish()).code).not.toBe(0);
    expect(fixture.uploads()).toBe(uploads);
  } finally { await fixture.stop(); }
}, 60_000);

test("remembered publication recovery: lost commit and failed receipt writes retain one operation", async () => {
  const fixture = await publicationCliFixture();
  try {
    fixture.hooks.dropCommit = true;
    expect((await fixture.publish()).code).not.toBe(0);
    const file = await recordFile(fixture.profiles);
    expect(publicationRecordSchema.parse(JSON.parse(await readFile(file, "utf8"))).pending).not.toBeNull();
    await writeFile(path.join(fixture.source, "index.html"), "changed during recovery");
    expect((await fixture.publish()).stderr).toContain("input changed while an earlier attempt is still pending");
    expect((await fixture.run(["publications", "refresh", fixture.source])).code).not.toBe(0);
    expect((await fixture.publish(["--new-artifact"])).code).not.toBe(0);
    await writeFile(path.join(fixture.source, "index.html"), "<h1>first</h1>");
    const recovered = receipt(await fixture.publish());
    expect(recovered.replayed).toBe(true);
    expect(recovered.version.number).toBe(1);
    await writeFile(path.join(fixture.source, "index.html"), "<h1>second</h1>");
    fixture.hooks.after = async (pathname) => {
      if (!pathname.endsWith("/commit")) return;
      await rename(file, `${file}.held`);
      await mkdir(file);
      delete fixture.hooks.after;
    };
    expect((await fixture.publish()).code).not.toBe(0);
    await rmdir(file);
    await rename(`${file}.held`, file);
    const second = receipt(await fixture.publish());
    expect(second.version.number).toBe(2);
    expect(second.replayed).toBe(true);
    expect(fixture.commits()).toBe(2);
    expect(receipt(await fixture.publish()).version.id).toBe(second.version.id);
  } finally { await fixture.stop(); }
}, 60_000);

test("remembered publication recovery: concurrent commands refuse and a dead process lock is reclaimed", async () => {
  const fixture = await publicationCliFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    let paused = false;
    fixture.hooks.before = async (pathname) => {
      if (pathname !== "/api/v1/uploads" || paused) return;
      paused = true;
      entered.resolve();
      await release.promise;
    };
    const first = startPublicationCli(["publish", fixture.source, ...fixture.destination]);
    await entered.promise;
    expect((await fixture.publish()).stderr).toContain("Another publication command owns");
    const independent = path.join(fixture.root, "independent.html");
    await writeFile(independent, "<h1>independent</h1>");
    expect(receipt(await fixture.run(["publish", independent])).version.number).toBe(1);
    first.child.kill("SIGKILL");
    await first.result;
    release.resolve();
    delete fixture.hooks.before;
    const recovered = receipt(await fixture.publish());
    expect(recovered.version.number).toBe(1);
    expect(fixture.commits()).toBe(2);
  } finally { release.resolve(); await fixture.stop(); }
}, 40_000);

test("remembered publication recovery: a process lost after receipt persistence does not create another version", async () => {
  const fixture = await publicationCliFixture();
  try {
    const child = spawn(process.execPath, ["--import", "tsx", "tests/support/publication-receipt-crash.ts",
      fixture.source, fixture.origin, fixture.tokenFile, fixture.profiles], {stdio: "pipe"});
    const code = await new Promise<number | null>((resolve, reject) => {child.once("exit", resolve); child.once("error", reject);});
    expect(code).toBe(23);
    const result = await fixture.publish();
    expect(receipt(result).version.number).toBe(1);
    expect(receipt(result).replayed).toBe(true);
    expect(unchanged(await fixture.publish())).toBe(true);
    expect(fixture.uploads()).toBe(1);
  } finally { await fixture.stop(); }
}, 30_000);

test("remembered publication upgrade: reconciles a legacy committed journal before creating a binding", async () => {
  const fixture = await publicationCliFixture();
  try {
    const prepared = await Effect.runPromise(prepareFilePublication({inputPath: fixture.source, routingMode: "static",
      target: {kind: "new_artifact", accessSetting: "account_required", tags: []}}).pipe(Effect.provide(NodeFileSystem.layer)));
    const legacy = await resumePublicationOperation(fixture.profiles, fixture.origin, prepared.operationScopeDigest, prepared.operationDigest);
    const committed = await Effect.runPromise(publishPreparedPath({serverOrigin: fixture.origin, apiToken: Redacted.make(fixture.installation.apiToken)},
      legacy.idempotencyKey, prepared).pipe(Effect.provide(publicationCliHttpClientLayer), Effect.provide(NodeFileSystem.layer)));
    const recovered = receipt(await fixture.publish());
    expect(recovered.version.id).toBe(committed.version.id);
    expect(recovered.replayed).toBe(true);
    expect(await readdir(path.join(fixture.profiles, "publication-operations"))).toEqual([]);
    expect(fixture.commits()).toBe(1);
  } finally { await fixture.stop(); }
}, 30_000);


test.skipIf(process.platform === "win32")("publication receipts are private on disk", async () => {
  const fixture = await publicationCliFixture();
  try {
    receipt(await fixture.publish());
    const file = await recordFile(fixture.profiles);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
  } finally { await fixture.stop(); }
});

test("remembered destinations: separates servers and projects, refuses unauthorized and ambiguous selection", async () => {
  const fixture = await publicationCliFixture();
  const otherServer = await publicationCliFixture();
  try {
    const first = receipt(await fixture.publish());
    const other = receipt(await startPublicationCli(["publish", fixture.source, ...fixture.destination,
      "--server", otherServer.origin, "--token-file", otherServer.tokenFile]).result);
    expect(other.artifact.id).not.toBe(first.artifact.id);
    expect(receipt(await fixture.publish()).artifact.id).toBe(first.artifact.id);
    const projectResponse = await fetch(`${fixture.origin}/api/v1/projects`, {
      method: "POST", headers: {Authorization: `Bearer ${fixture.installation.apiToken}`, "Content-Type": "application/json"},
      body: JSON.stringify({name: "Second"}),
    });
    const project = z.object({project: z.object({id: z.string()})}).parse(await projectResponse.json()).project;
    expect(receipt(await fixture.publish()).artifact.id).toBe(first.artifact.id);
    const secondProject = receipt(await fixture.publish(["--project", project.id]));
    expect(secondProject.artifact.projectId).toBe(project.id);
    expect((await fixture.publish()).stderr).toContain("PROJECT_SELECTION_REQUIRED");
    expect(receipt(await fixture.publish(["--project", "prj_default"])).artifact.id).toBe(first.artifact.id);
    const uploads = fixture.uploads();
    const invalidToken = path.join(fixture.root, "invalid-token");
    await writeFile(invalidToken, "invalid-token-with-sufficient-length-for-validation");
    expect((await fixture.publish(["--project", "prj_default", "--token-file", invalidToken])).code).not.toBe(0);
    expect(fixture.uploads()).toBe(uploads);
  } finally { await fixture.stop(); await otherServer.stop(); }
}, 45_000);

test("remembered catalog: automatic generated entry stays automatic on later publishes", async () => {
  const fixture = await publicationCliFixture();
  try {
    await rm(path.join(fixture.source, "index.html"));
    await writeFile(path.join(fixture.source, "board.dc.html"), "<!doctype html><title>Board</title>");
    const first = receipt(await fixture.publish());
    expect(first.version.entryPath).toBe("artifact-server-design.html");
    const same = await fixture.publish();
    expect(receipt(same).version.id).toBe(first.version.id);
    expect(unchanged(same)).toBe(true);
    await writeFile(path.join(fixture.source, "board.dc.html"), "<!doctype html><title>Changed board</title>");
    expect(receipt(await fixture.publish()).version.number).toBe(2);
  } finally { await fixture.stop(); }
}, 30_000);

test("registry failures: refuses invalid pending records, ambiguous locks and state inside the source", async () => {
  const fixture = await publicationCliFixture();
  try {
    receipt(await fixture.publish());
    const file = await recordFile(fixture.profiles);
    const stored = await readFile(file, "utf8");
    const record = publicationRecordSchema.parse(JSON.parse(stored));
    await writeFile(file, JSON.stringify({...record, pending: {idempotencyKey: "bad"}}));
    expect((await fixture.publish()).code).not.toBe(0);
    await writeFile(file, stored);
    await writeFile(`${file}.lock`, "invalid owner");
    expect((await fixture.publish()).stderr).toContain("lock is corrupt");
    await rm(`${file}.lock`);
    const nested = path.join(fixture.source, "metadata");
    expect((await fixture.publish(["--profile-data", nested])).stderr).toContain("outside the published source");
    await expect(stat(nested)).rejects.toMatchObject({code: "ENOENT"});
    expect(fixture.uploads()).toBe(1);
  } finally { await fixture.stop(); }
}, 30_000);

test("publication conflict during commit can be explicitly refreshed without an unresolved operation", async () => {
  const fixture = await publicationCliFixture();
  try {
    const first = receipt(await fixture.publish());
    const alternate = path.join(fixture.root, "alternate");
    await mkdir(alternate);
    await writeFile(path.join(alternate, "index.html"), "<h1>winner</h1>");
    await writeFile(path.join(fixture.source, "index.html"), "<h1>loser</h1>");
    fixture.hooks.before = async (pathname) => {
      if (!pathname.endsWith("/commit")) return;
      delete fixture.hooks.before;
      receipt(await startPublicationCli(["publish", alternate, ...fixture.destination,
        "--profile-data", path.join(fixture.root, "race-profile"),
        "--artifact", first.artifact.id, "--expected-version", first.version.id]).result);
    };
    expect((await fixture.publish()).stderr).toContain("PUBLISH_CONFLICT");
    expect((await fixture.run(["publications", "refresh", fixture.source])).code).toBe(0);
    expect(receipt(await fixture.publish()).version.number).toBe(3);
  } finally { await fixture.stop(); }
}, 35_000);


test("publication persistence: failure to save pending intent sends no upload", async () => {
  const fixture = await publicationCliFixture();
  try {
    receipt(await fixture.publish());
    const file = await recordFile(fixture.profiles);
    await writeFile(path.join(fixture.source, "index.html"), "<h1>new bytes</h1>");
    fixture.hooks.after = async (pathname) => {
      if (!pathname.startsWith("/api/v1/artifacts/")) return;
      delete fixture.hooks.after;
      await rename(file, `${file}.held`);
      await mkdir(file);
    };
    expect((await fixture.publish()).code).not.toBe(0);
    expect(fixture.uploads()).toBe(1);
    await rmdir(file);
    await rename(`${file}.held`, file);
    expect(receipt(await fixture.publish()).version.number).toBe(2);
  } finally { await fixture.stop(); }
}, 30_000);


test("publication origin: retains server-advertised public links while binding to the inspected identity", async () => {
  const fixture = await publicationCliFixture("https://artifacts.example.test");
  try {
    const first = receipt(await fixture.publish());
    expect(new URL(first.links.artifact).origin).toBe("https://artifacts.example.test");
    expect(receipt(await fixture.publish()).version.id).toBe(first.version.id);
  } finally { await fixture.stop(); }
}, 30_000);


test("new artifact recovery: an undelivered durable receipt is replayed before another deliberate create", async () => {
  const fixture = await publicationCliFixture();
  try {
    const first = receipt(await fixture.publish());
    const child = spawn(process.execPath, ["--import", "tsx", "tests/support/publication-receipt-crash.ts",
      fixture.source, fixture.origin, fixture.tokenFile, fixture.profiles, "new"], {stdio: "pipe"});
    const code = await new Promise<number | null>((resolve, reject) => {child.once("exit", resolve); child.once("error", reject);});
    expect(code).toBe(23);
    expect((await fixture.run(["publications", "refresh", fixture.source])).code).not.toBe(0);
    const replay = receipt(await fixture.publish(["--new-artifact"]));
    expect(replay.replayed).toBe(true);
    expect(replay.artifact.id).not.toBe(first.artifact.id);
    expect(fixture.uploads()).toBe(2);
    const another = receipt(await fixture.publish(["--new-artifact"]));
    expect(another.artifact.id).not.toBe(replay.artifact.id);
    expect(fixture.uploads()).toBe(3);
  } finally { await fixture.stop(); }
}, 30_000);


test("legacy isolation: unrelated journals survive publication and verified import without blocking them", async () => {
  const fixture = await publicationCliFixture();
  try {
    const legacySource = path.join(fixture.root, "older.html");
    await writeFile(legacySource, "<h1>older pending intent</h1>");
    const prepared = await Effect.runPromise(prepareFilePublication({inputPath: legacySource, routingMode: "static",
      target: {kind: "new_artifact", accessSetting: "account_required", tags: []}}).pipe(Effect.provide(NodeFileSystem.layer)));
    await resumePublicationOperation(fixture.profiles, fixture.origin, prepared.operationScopeDigest, prepared.operationDigest);
    const legacyDirectory = path.join(fixture.profiles, "publication-operations");
    const originalFiles = await readdir(legacyDirectory);
    const first = receipt(await fixture.publish());
    expect(await readdir(legacyDirectory)).toEqual(originalFiles);
    const receiptPath = path.join(fixture.root, "receipt.json");
    await writeFile(receiptPath, JSON.stringify(first));
    await rm(await recordFile(fixture.profiles));
    const sameSource = await Effect.runPromise(prepareFilePublication({inputPath: fixture.source, routingMode: "static",
      target: {kind: "new_artifact", accessSetting: "account_required", tags: []}}).pipe(Effect.provide(NodeFileSystem.layer)));
    await resumePublicationOperation(fixture.profiles, fixture.origin, sameSource.operationScopeDigest, sameSource.operationDigest);
    const preservedFiles = await readdir(legacyDirectory);
    expect(preservedFiles).toHaveLength(2);
    expect((await fixture.run(["publications", "import", fixture.source, "--receipt", receiptPath])).code).toBe(0);
    expect((await fixture.run(["publications", "refresh", fixture.source])).code).toBe(0);
    expect(unchanged(await fixture.publish())).toBe(true);
    expect(await readdir(legacyDirectory)).toEqual(preservedFiles);
    expect(fixture.uploads()).toBe(1);
    const resumed = receipt(await fixture.run(["publish", legacySource]));
    expect(resumed.version.number).toBe(1);
    expect(await readdir(legacyDirectory)).toEqual(preservedFiles.filter((file) => !originalFiles.includes(file)));
  } finally { await fixture.stop(); }
}, 35_000);
