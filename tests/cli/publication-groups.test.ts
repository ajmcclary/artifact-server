import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile} from "node:fs/promises";
import path from "node:path";

import {expect, test} from "vitest";
import {z} from "zod";

import {publicationReceiptSchema, publicationRecordSchema} from "../../src/cli/publication-record.js";
import {publicationCliFixture, startPublicationCli, type CliResult} from "../support/publication-cli.js";

type Fixture = Awaited<ReturnType<typeof publicationCliFixture>>;
const resultSchema = z.object({
  status: z.string(), error: z.string().nullable(), reportPath: z.string().nullable(),
  destination: z.object({projectId: z.string()}).nullable(),
  preflight: z.array(z.object({target: z.string(), status: z.string(), allowed: z.boolean(), message: z.string()})),
  results: z.array(z.object({target: z.string(), status: z.string(), error: z.string().nullable(), receipt: publicationReceiptSchema.nullable()})),
  summary: z.object({published: z.number(), unchanged: z.number(), recovered: z.number(), failed: z.number(), skipped: z.number()}),
});
function parsed(result: CliResult) { return resultSchema.parse(JSON.parse(result.stdout)); }
function receipt(result: CliResult) {
  expect({code: result.code, stderr: result.stderr}).toEqual({code: 0, stderr: ""});
  return publicationReceiptSchema.parse(JSON.parse(result.stdout));
}
async function setup(fixture: Fixture) {
  for (const name of ["a", "b", "c"]) {
    // eslint-disable-next-line no-await-in-loop -- independent fixture creation in a small deterministic order
    await mkdir(path.join(fixture.root, name));
    // eslint-disable-next-line no-await-in-loop -- each directory precedes its fixture
    await writeFile(path.join(fixture.root, name, "index.html"), `<h1>${name}</h1>`);
  }
  const config = path.join(fixture.root, "artifactserver.publish.json");
  await writeFile(config, JSON.stringify({schemaVersion: 1, defaults: {project: "prj_default"},
    targets: {a: {path: "a"}, b: {path: "b"}, c: {path: "c"}},
    groups: {all: {targets: ["a", "b", "c"]}, one: {targets: ["a"]}}}));
  return config;
}
function runGroup(fixture: Fixture, config: string, args: readonly string[] = []) {
  return fixture.run(["publish", "--group", "all", "--config", config, "--json", ...args]);
}
async function snapshot(directory: string): Promise<readonly string[]> {
  const names = await readdir(directory, {recursive: true});
  return Promise.all(names.toSorted().map(async (name) => {
    const file = path.join(directory, name);
    const info = await stat(file);
    return `${name}:${info.mode}:${info.isFile() ? createHash("sha256").update(await readFile(file)).digest("hex") : "directory"}`;
  }));
}

test("CLI-005-B: groups preview without state writes, create explicitly, skip unchanged members and share bindings", async () => {
  const fixture = await publicationCliFixture();
  try {
    const config = await setup(fixture);
    const blocked = await runGroup(fixture, config, ["--dry-run"]);
    expect(blocked.code).toBe(1);
    expect(parsed(blocked).preflight.map((row) => row.status)).toEqual(["unregistered", "unregistered", "unregistered"]);
    await expect(stat(fixture.profiles)).rejects.toMatchObject({code: "ENOENT"});
    const preview = await runGroup(fixture, config, ["--allow-create", "--dry-run"]);
    expect(preview.code).toBe(0);
    expect(parsed(preview).status).toBe("ready");
    await expect(stat(fixture.profiles)).rejects.toMatchObject({code: "ENOENT"});
    expect(fixture.uploads()).toBe(0);
    const created = await runGroup(fixture, config, ["--allow-create"]);
    expect(created.code).toBe(0);
    const first = parsed(created);
    expect(first.summary).toEqual({published: 3, unchanged: 0, recovered: 0, failed: 0, skipped: 0});
    expect(first.results.map((row) => row.target)).toEqual(["a", "b", "c"]);
    expect(first.results.map((row) => row.receipt?.artifact.accessSetting)).toEqual(["account_required", "account_required", "account_required"]);
    expect(first.reportPath).not.toBeNull();
    expect(JSON.parse(await readFile(first.reportPath ?? "missing", "utf8"))).toMatchObject({status: "completed", summary: first.summary});
    const before = await snapshot(fixture.profiles);
    expect(parsed(await runGroup(fixture, config, ["--dry-run"])).preflight.map((row) => row.status)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect(await snapshot(fixture.profiles)).toEqual(before);
    await writeFile(path.join(fixture.root, "a/index.html"), "<h1>a changed</h1>");
    const changed = parsed(await runGroup(fixture, config));
    expect(changed.summary).toEqual({published: 1, unchanged: 2, recovered: 0, failed: 0, skipped: 0});
    expect(changed.results[0]?.receipt?.artifact.id).toBe(first.results[0]?.receipt?.artifact.id);
    expect(changed.results[0]?.receipt?.version.number).toBe(2);
    const subset = parsed(await runGroup(fixture, config, ["--group", "one"]));
    expect(subset.summary.unchanged).toBe(1);
    expect(fixture.uploads()).toBe(4);
    const offline = await startPublicationCli(["publications", "groups", "--config", config, "--json"]).result;
    expect(offline.code).toBe(0);
    expect(z.object({groups: z.array(z.object({name: z.string()}))}).parse(JSON.parse(offline.stdout)).groups.map((group) => group.name)).toEqual(["all", "one"]);
  } finally { await fixture.stop(); }
}, 60_000);

test("CLI-005-F: preflight collects stale, missing and unregistered blockers before any upload", async () => {
  const fixture = await publicationCliFixture();
  try {
    const config = await setup(fixture);
    const first = receipt(await fixture.run(["publish", path.join(fixture.root, "a")]));
    receipt(await fixture.run(["publish", path.join(fixture.root, "b")]));
    await writeFile(path.join(fixture.root, "a/index.html"), "<h1>remote change</h1>");
    receipt(await startPublicationCli(["publish", path.join(fixture.root, "a"), ...fixture.destination,
      "--profile-data", path.join(fixture.root, "other-profile"), "--artifact", first.artifact.id, "--expected-version", first.version.id]).result);
    await writeFile(config, JSON.stringify({schemaVersion: 1, defaults: {project: "prj_default"},
      targets: {a: {path: "a"}, b: {path: "b"}, c: {path: "c"}, missing: {path: "absent"}}, groups: {all: {targets: ["a", "b", "c", "missing"]}}}));
    const uploads = fixture.uploads();
    const before = await snapshot(fixture.profiles);
    const result = await runGroup(fixture, config);
    expect(result.code).toBe(1);
    expect(parsed(result).preflight.map((row) => row.status)).toEqual(["conflicted", "unchanged", "unregistered", "blocked"]);
    expect(fixture.uploads()).toBe(uploads);
    expect(await snapshot(fixture.profiles)).toEqual(before);
    await expect(stat(path.join(fixture.profiles, "publication-runs"))).rejects.toMatchObject({code: "ENOENT"});
  } finally { await fixture.stop(); }
}, 40_000);

test.each([false, true])("runtime group failure preserves completed members and respects fail-fast=%s", async (failFast) => {
  const fixture = await publicationCliFixture();
  try {
    const config = await setup(fixture);
    expect((await runGroup(fixture, config, ["--allow-create"])).code).toBe(0);
    await Promise.all(["a", "b", "c"].map((name) => writeFile(path.join(fixture.root, name, "index.html"), `<h1>${name} changed</h1>`)));
    fixture.hooks.after = async (pathname) => {
      if (!pathname.endsWith("/commit")) return;
      delete fixture.hooks.after;
      await rm(path.join(fixture.root, "b/index.html"));
    };
    const failed = await runGroup(fixture, config, failFast ? ["--fail-fast"] : []);
    expect(failed.code).toBe(1);
    expect(parsed(failed).results.map((row) => row.status)).toEqual(["published", "failed", failFast ? "skipped" : "published"]);
    expect(parsed(failed).summary.failed).toBe(1);
    await writeFile(path.join(fixture.root, "b/index.html"), "<h1>b changed</h1>");
    const retried = await runGroup(fixture, config);
    expect(retried.code).toBe(0);
    expect(parsed(retried).results.map((row) => row.receipt?.version.number)).toEqual([2, 2, 2]);
    expect(parsed(retried).results[0]?.status).toBe("unchanged");
  } finally { await fixture.stop(); }
}, 60_000);

test("group interruption replays a reported but unacknowledged result without duplicating a version", async () => {
  const fixture = await publicationCliFixture();
  try {
    const config = await setup(fixture);
    const child = spawn(process.execPath, ["--import", "tsx", "tests/support/publication-group-crash.ts", config,
      fixture.origin, fixture.tokenFile, fixture.profiles], {stdio: "pipe"});
    const code = await new Promise<number | null>((resolve, reject) => {child.once("exit", resolve); child.once("error", reject);});
    expect(code).toBe(23);
    expect(fixture.commits()).toBe(1);
    const directory = path.join(fixture.profiles, "publication-runs");
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    const interrupted = resultSchema.parse(JSON.parse(await readFile(path.join(directory, files[0] ?? "missing"), "utf8")));
    expect(interrupted.status).toBe("running");
    expect(interrupted.results.map((row) => row.status)).toEqual(["published", "skipped", "skipped"]);
    const before = await snapshot(fixture.profiles);
    const preview = parsed(await runGroup(fixture, config, ["--dry-run", "--allow-create"]));
    expect(preview.preflight.map((row) => row.status)).toEqual(["resumable", "unregistered", "unregistered"]);
    expect(await snapshot(fixture.profiles)).toEqual(before);
    const completed = await runGroup(fixture, config, ["--allow-create"]);
    expect(completed.code).toBe(0);
    const result = parsed(completed);
    expect(result.summary).toEqual({published: 2, recovered: 1, unchanged: 0, failed: 0, skipped: 0});
    expect(result.results[0]?.receipt?.version.id).toBe(interrupted.results[0]?.receipt?.version.id);
    expect(result.results.map((row) => row.receipt?.version.number)).toEqual([1, 1, 1]);
    expect(fixture.commits()).toBe(3);
  } finally { await fixture.stop(); }
}, 35_000);

test("group report failure preserves the undelivered receipt and stops before another target", async () => {
  const fixture = await publicationCliFixture();
  try {
    const config = await setup(fixture);
    let sabotaged = "";
    fixture.hooks.after = async (pathname) => {
      if (!pathname.endsWith("/commit")) return;
      delete fixture.hooks.after;
      const directory = path.join(fixture.profiles, "publication-runs");
      const file = (await readdir(directory)).find((candidate) => candidate.endsWith(".json"));
      sabotaged = path.join(directory, file ?? "missing");
      await rename(sabotaged, `${sabotaged}.held`);
      await mkdir(sabotaged);
    };
    const failed = await runGroup(fixture, config, ["--allow-create"]);
    expect(failed.code).toBe(1);
    expect(parsed(failed).summary).toMatchObject({failed: 1, skipped: 2});
    expect(fixture.commits()).toBe(1);
    const recordFile = (await readdir(path.join(fixture.profiles, "publications"))).find((file) => file.endsWith(".json"));
    const record = publicationRecordSchema.parse(JSON.parse(await readFile(path.join(fixture.profiles, "publications", recordFile ?? "missing"), "utf8")));
    expect(record.unreported).not.toBeNull();
    await rmdir(sabotaged);
    await rename(`${sabotaged}.held`, sabotaged);
    const retry = await runGroup(fixture, config, ["--allow-create"]);
    expect(retry.code).toBe(0);
    expect(parsed(retry).summary).toMatchObject({recovered: 1, published: 2});
    expect(fixture.commits()).toBe(3);
  } finally { await fixture.stop(); }
}, 35_000);

test("group execution rejects a remote version advance after preflight and continues independent members", async () => {
  const fixture = await publicationCliFixture();
  try {
    const config = await setup(fixture);
    const initial = parsed(await runGroup(fixture, config, ["--allow-create"]));
    const b = initial.results[1]?.receipt;
    if (b === null || b === undefined) throw new Error("Expected target b receipt.");
    await Promise.all(["a", "b", "c"].map((name) => writeFile(path.join(fixture.root, name, "index.html"), `<h1>${name} next</h1>`)));
    fixture.hooks.after = async (pathname) => {
      if (!pathname.endsWith("/commit")) return;
      delete fixture.hooks.after;
      receipt(await startPublicationCli(["publish", path.join(fixture.root, "b"), ...fixture.destination,
        "--profile-data", path.join(fixture.root, "race-profile"), "--artifact", b.artifact.id, "--expected-version", b.version.id]).result);
    };
    const advanced = await runGroup(fixture, config);
    expect(advanced.code).toBe(1);
    expect(parsed(advanced).results.map((row) => row.status)).toEqual(["published", "failed", "published"]);
    expect(parsed(advanced).results[1]?.error).toContain("Publication conflict");
    const versions = await fetch(`${fixture.origin}/api/v1/artifacts/${b.artifact.id}/versions`, {headers: {Authorization: `Bearer ${fixture.installation.apiToken}`}});
    expect(z.object({versions: z.array(z.unknown())}).parse(await versions.json()).versions).toHaveLength(2);
  } finally { await fixture.stop(); }
}, 40_000);

test("group validation refuses duplicate sources, state inclusion, incompatible options, and a mismatched recovery intent", async () => {
  const fixture = await publicationCliFixture();
  try {
    const config = await setup(fixture);
    await writeFile(config, JSON.stringify({schemaVersion: 1, targets: {a: {path: "a"}, alias: {path: "./a"}}, groups: {all: {targets: ["a", "alias"]}}}));
    const duplicate = await runGroup(fixture, config, ["--allow-create"]);
    expect(duplicate.code).toBe(1);
    expect(parsed(duplicate).preflight.every((row) => row.status === "blocked")).toBe(true);
    expect(fixture.uploads()).toBe(0);
    await mkdir(fixture.profiles);
    await writeFile(path.join(fixture.profiles, "private.txt"), "private");
    await writeFile(config, JSON.stringify({schemaVersion: 1, targets: {state: {path: "profiles"}}, groups: {all: {targets: ["state"]}}}));
    expect(parsed(await runGroup(fixture, config, ["--allow-create"])).preflight[0]?.message).toContain("outside the published source");
    await writeFile(config, JSON.stringify({schemaVersion: 1, targets: {state: {path: "profiles/private.txt"}}, groups: {all: {targets: ["state"]}}}));
    expect(parsed(await runGroup(fixture, config, ["--allow-create"])).preflight[0]?.message).toContain("inside private CLI state");
    await writeFile(config, JSON.stringify({schemaVersion: 1, targets: {a: {path: "a"}}, groups: {all: {targets: ["a"]}}}));
    expect((await runGroup(fixture, config, ["--new-artifact"])).stderr).toContain("Per-artifact flags");
    expect((await fixture.run(["publish", fixture.source, "--group", "all", "--config", config])).code).toBe(1);
    fixture.hooks.dropCommit = true;
    const pending = await fixture.run(["publish", path.join(fixture.root, "a"), "--name", "Original intent"]);
    expect(pending.code).not.toBe(0);
    const uploads = fixture.uploads();
    const blocked = parsed(await runGroup(fixture, config, ["--allow-create"]));
    expect(blocked.preflight[0]?.status).toBe("blocked");
    expect(blocked.preflight[0]?.message).toContain("original single-path command");
    expect(fixture.uploads()).toBe(uploads);
  } finally { await fixture.stop(); }
}, 35_000);

test("group project settings use group overrides before defaults and explicit CLI settings before both", async () => {
  const fixture = await publicationCliFixture();
  try {
    const config = await setup(fixture);
    await writeFile(config, JSON.stringify({schemaVersion: 1, defaults: {profile: "base", project: "prj_missing"},
      targets: {a: {path: "a"}}, groups: {all: {targets: ["a"], profile: "group", project: "prj_default"}}}));
    const inherited = await runGroup(fixture, config, ["--dry-run", "--allow-create"]);
    expect(inherited.code).toBe(0);
    expect(parsed(inherited).destination?.projectId).toBe("prj_default");
    const project = await fetch(`${fixture.origin}/api/v1/projects`, {method: "POST",
      headers: {Authorization: `Bearer ${fixture.installation.apiToken}`, "Content-Type": "application/json"}, body: JSON.stringify({name: "Override"})});
    const id = z.object({project: z.object({id: z.string()})}).parse(await project.json()).project.id;
    expect(parsed(await runGroup(fixture, config, ["--dry-run", "--allow-create", "--project", id])).destination?.projectId).toBe(id);
    expect(fixture.uploads()).toBe(0);
  } finally { await fixture.stop(); }
}, 25_000);

test.skipIf(process.platform === "win32")("publication group reports are private on disk", async () => {
  const fixture = await publicationCliFixture();
  try {
    const config = await setup(fixture);
    const result = parsed(await runGroup(fixture, config, ["--group", "one", "--allow-create"]));
    const file = result.reportPath ?? "missing";
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
  } finally { await fixture.stop(); }
});


test("group binding loss after preflight cannot silently create a replacement artifact", async () => {
  const fixture = await publicationCliFixture();
  try {
    const config = await setup(fixture);
    expect((await runGroup(fixture, config, ["--allow-create"])).code).toBe(0);
    await Promise.all(["a", "b", "c"].map((name) => writeFile(path.join(fixture.root, name, "index.html"), `<h1>${name} changed</h1>`)));
    fixture.hooks.after = async (pathname) => {
      if (!pathname.endsWith("/commit")) return;
      delete fixture.hooks.after;
      const directory = path.join(fixture.profiles, "publications");
      const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
      await Promise.all(files.map(async (file) => {
        const record = publicationRecordSchema.parse(JSON.parse(await readFile(path.join(directory, file), "utf8")));
        if (path.basename(record.scope.sourcePath) === "b") await rm(path.join(directory, file));
      }));
    };
    const run = await runGroup(fixture, config);
    expect(run.code).toBe(1);
    expect(parsed(run).results.map((row) => row.status)).toEqual(["published", "failed", "published"]);
    expect(parsed(run).results[1]?.error).toContain("binding changed after group preflight");
    expect(fixture.commits()).toBe(5);
    const listed = await fetch(`${fixture.origin}/api/v1/artifacts`, {headers: {Authorization: `Bearer ${fixture.installation.apiToken}`}});
    expect(z.object({artifacts: z.array(z.unknown())}).parse(await listed.json()).artifacts).toHaveLength(3);
  } finally { await fixture.stop(); }
}, 40_000);
