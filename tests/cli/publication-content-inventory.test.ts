import {createHash} from "node:crypto";
import {mkdir, readFile, readdir, symlink, writeFile} from "node:fs/promises";
import path from "node:path";
import {expect, test} from "vitest";
import {publicationReceiptSchema} from "../../src/cli/publication-record.js";
import {publicationCliFixture, startPublicationCli, type CliResult} from "../support/publication-cli.js";

function receipt(result: CliResult) {
  expect({code: result.code, stderr: result.stderr}).toEqual({code: 0, stderr: ""});
  return publicationReceiptSchema.parse(JSON.parse(result.stdout));
}

test("CLI-006-B: content identity skips provenance changes without creating an upload", async () => {
  const fixture = await publicationCliFixture();
  try {
    const provenance = path.join(fixture.source, "artifactserver.provenance.json");
    await writeFile(provenance, JSON.stringify({note: "first source record"}));
    const first = receipt(await fixture.publish(["--version-identity", "content"]));
    await writeFile(provenance, JSON.stringify({note: "different commit and source paths"}));
    expect(receipt(await fixture.publish()).version.id).toBe(first.version.id);
    expect(fixture.uploads()).toBe(1);
    expect(fixture.commits()).toBe(1);
    await writeFile(path.join(fixture.source, "index.html"), "<h1>Changed document</h1>");
    expect(receipt(await fixture.publish()).version.number).toBe(2);
    await writeFile(provenance, JSON.stringify({note: "explicit metadata correction"}));
    expect(receipt(await fixture.publish(["--version-identity", "package"])).version.number).toBe(3);
  } finally { await fixture.stop(); }
}, 60_000);

test("CLI-006-F: matching delivered bytes cannot bypass a stale publication binding", async () => {
  const fixture=await publicationCliFixture();
  try {
    const first=receipt(await fixture.publish(["--version-identity","content"]));
    await writeFile(path.join(fixture.source,"index.html"),"<h1>Another publisher</h1>");
    receipt(await startPublicationCli(["publish",fixture.source,...fixture.destination,
      "--profile-data",path.join(fixture.root,"other-publisher"),"--artifact",first.artifact.id,
      "--expected-version",first.version.id]).result);
    const uploads=fixture.uploads();
    const stale=await fixture.publish();
    expect(stale.code).not.toBe(0);
    expect(stale.stderr).toContain("Publication conflict");
    expect(fixture.uploads()).toBe(uploads);
  } finally {await fixture.stop();}
},60_000);

test("CLI-007-B: an inventory publishes canonical files without copying a package and survives retries", async () => {
  const fixture = await publicationCliFixture();
  try {
    const inventory = path.join(fixture.root, "files.json");
    const source = path.join(fixture.source, "index.html");
    const bytes = await readFile(source);
    await writeFile(inventory, JSON.stringify({format: "artifact-server.local-files", version: 1, root: ".",
      entryPath: "index.html", files: [{path: "index.html", source: "source/index.html", size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex")}]}));
    const command = ["publish", inventory, "--input-format", "inventory"];
    fixture.hooks.dropCommit = true;
    expect((await fixture.run(command)).code).not.toBe(0);
    const published = receipt(await fixture.run(command));
    expect(published.version.number).toBe(1);
    expect(published.replayed).toBe(true);
    expect(receipt(await fixture.run(["publish", inventory])).version.id).toBe(published.version.id);
    expect(fixture.uploads()).toBe(2); // The recovery reconciles the same server upload.
    expect(fixture.commits()).toBe(1);
    expect(await readdir(fixture.source)).toEqual(["index.html"]);
    await writeFile(source, "changed after inventory generation");
    const uploads = fixture.uploads();
    expect((await fixture.run(command)).stderr).toContain("rebuild the inventory");
    expect(fixture.uploads()).toBe(uploads);
  } finally { await fixture.stop(); }
}, 60_000);

test("CLI-007-F: inventories refuse traversal, symlinked sources and stale fingerprints before upload", async () => {
  const fixture = await publicationCliFixture();
  try {
    const inventory = path.join(fixture.root, "files.json");
    const bytes = await readFile(path.join(fixture.source, "index.html"));
    const file = {path: "index.html", source: "source/index.html", size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")};
    const write = async (entry: typeof file) => writeFile(inventory, JSON.stringify({
      format: "artifact-server.local-files", version: 1, root: ".", entryPath: "index.html", files: [entry],
    }));
    await mkdir(path.join(fixture.root, "links"));
    await symlink(fixture.source, path.join(fixture.root, "links/source"));
    for (const entry of [{...file, path: "../index.html"}, {...file, source: "../outside.html"},
      {...file, source: "links/source/index.html"}, {...file, sha256: "0".repeat(64)}]) {
      // eslint-disable-next-line no-await-in-loop -- each rejected snapshot replaces the same explicit inventory
      await write(entry);
      // eslint-disable-next-line no-await-in-loop -- prove that each hostile inventory is refused before the next one replaces it
      expect((await fixture.run(["publish", inventory, "--input-format", "inventory"])).code).not.toBe(0);
      expect(fixture.uploads()).toBe(0);
    }
  } finally { await fixture.stop(); }
}, 60_000);

test("foundation: group inventories cannot widen the configuration's source boundary", async () => {
  const fixture = await publicationCliFixture();
  try {
    const directory = path.join(fixture.root, "configuration");
    await mkdir(directory);
    const bytes = await readFile(path.join(fixture.source, "index.html"));
    await writeFile(path.join(directory, "files.json"), JSON.stringify({format:"artifact-server.local-files",version:1,
      root:"..",entryPath:"index.html",files:[{path:"index.html",source:"source/index.html",size:bytes.length,
        sha256:createHash("sha256").update(bytes).digest("hex")}]}));
    const config = path.join(directory, "artifactserver.publish.json");
    await writeFile(config, JSON.stringify({schemaVersion:1,targets:{site:{path:"files.json",inputFormat:"inventory"}},groups:{all:{targets:["site"]}}}));
    const result = await fixture.run(["publish","--group","all","--config",config,"--allow-create","--json"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("escapes the configuration directory");
    expect(fixture.uploads()).toBe(0);
  } finally { await fixture.stop(); }
}, 60_000);
