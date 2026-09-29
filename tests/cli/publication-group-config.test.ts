import {mkdir, mkdtemp, realpath, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {expect, test} from "vitest";

import {groupSource, readPublicationGroups, selectPublicationGroup} from "../../src/cli/publication-groups-config.js";

function definition() {
  return {schemaVersion: 1, defaults: {profile: "team", project: "prj_default"},
    targets: {site: {path: "site"}}, groups: {all: {targets: ["site"]}}};
}

test("group configuration discovers the nearest file and never crosses the checkout boundary", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "publication-group-config-"));
  const root = path.join(parent, "repo");
  const nested = path.join(root, "nested/child");
  try {
    await mkdir(nested, {recursive: true});
    await mkdir(path.join(root, ".git"));
    const outside = path.join(parent, "artifactserver.publish.json");
    await writeFile(outside, JSON.stringify(definition()));
    await expect(readPublicationGroups(undefined, nested)).rejects.toThrow("No artifactserver.publish.json");
    const config = path.join(root, "artifactserver.publish.json");
    await writeFile(config, JSON.stringify(definition()));
    await mkdir(path.join(root, "site"));
    await writeFile(path.join(root, "site/index.html"), "<h1>site</h1>");
    const discovered = await readPublicationGroups(undefined, nested);
    expect(discovered.file).toBe(await realpath(config));
    expect(await groupSource(discovered, "site")).toBe(await realpath(path.join(root, "site")));
    const nearer = path.join(root, "nested/artifactserver.publish.json");
    await writeFile(nearer, JSON.stringify(definition()));
    expect((await readPublicationGroups(undefined, nested)).file).toBe(await realpath(nearer));
    expect((await readPublicationGroups(config, parent)).file).toBe(await realpath(config));
    expect(selectPublicationGroup(discovered, "all").targets).toEqual(["site"]);
    expect(() => selectPublicationGroup(discovered, "constructor")).toThrow("Unknown publication group");
  } finally { await rm(parent, {recursive: true, force: true}); }
});

test("group configuration rejects malformed names, unknown fields, repeated members and escaped sources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "publication-group-invalid-"));
  const file = path.join(root, "artifactserver.publish.json");
  try {
    for (const invalid of [
      {...definition(), credentials: {token: "must-not-be-accepted"}},
      {...definition(), targets: {site: {path: "site", profile: "foreign"}}},
      {...definition(), groups: {BadName: {targets: ["site"]}}},
      {...definition(), groups: {all: {targets: ["site", "site"]}}},
      {...definition(), groups: {all: {targets: ["constructor"]}}},
    ]) {
      // eslint-disable-next-line no-await-in-loop -- exercise each independent malformed configuration
      await writeFile(file, JSON.stringify(invalid));
      // eslint-disable-next-line no-await-in-loop -- validate the exact file just written
      await expect(readPublicationGroups(file)).rejects.toThrow(/unrecognized|invalid|repeats|unknown/iu);
    }
    await writeFile(file, "invalid JSON");
    await expect(readPublicationGroups(file)).rejects.toThrow(/JSON/u);
    for (const source of ["../outside", root, "."]) {
      // eslint-disable-next-line no-await-in-loop -- verify each containment violation before the next fixture
      await writeFile(file, JSON.stringify({...definition(), targets: {site: {path: source}}}));
      // eslint-disable-next-line no-await-in-loop -- parse the fixture being verified
      const config = await readPublicationGroups(file);
      // eslint-disable-next-line no-await-in-loop -- each path must fail without executing a publication
      await expect(groupSource(config, "site")).rejects.toThrow(/relative|escapes|configuration itself/u);
    }
  } finally { await rm(root, {recursive: true, force: true}); }
});

test.skipIf(process.platform === "win32")("group configuration refuses a symlink escape and a symlink configuration", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "publication-group-symlink-"));
  const root = path.join(parent, "repo");
  try {
    await mkdir(root);
    await mkdir(path.join(parent, "outside"));
    await writeFile(path.join(parent, "outside/proof.txt"), "outside");
    await symlink(path.join(parent, "outside"), path.join(root, "link"));
    const file = path.join(root, "artifactserver.publish.json");
    await writeFile(file, JSON.stringify({...definition(), targets: {site: {path: "link/proof.txt"}}}));
    await expect(groupSource(await readPublicationGroups(file), "site")).rejects.toThrow("outside");
    const alias = path.join(parent, "alias.json");
    await symlink(file, alias);
    await expect(readPublicationGroups(alias)).rejects.toThrow("regular file");
  } finally { await rm(parent, {recursive: true, force: true}); }
});
