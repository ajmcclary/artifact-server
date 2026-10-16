import {randomUUID} from "node:crypto";
import {readFile, readdir, writeFile} from "node:fs/promises";
import path from "node:path";

import {expect, test} from "vitest";

import {publicationReceiptSchema} from "../../src/cli/publication-record.js";
import {publicationCliFixture} from "../support/publication-cli.js";

test("ART-014-B ART-014-F: CLI rename preserves remembered publication, rejects stale edits and never republishes metadata", async () => {
  const fixture = await publicationCliFixture();
  try {
    const first = publicationReceiptSchema.parse(JSON.parse((await fixture.publish(["--name", "Apple Systems Projects"])).stdout));
    const records = path.join(fixture.profiles, "publications");
    const recordName = (await readdir(records)).find((name) => name.endsWith(".json"));
    if (recordName === undefined) throw new Error("Missing publication record.");
    const recordPath = path.join(records, recordName);
    const before = await readFile(recordPath, "utf8");
    const renameArgs = ["rename", first.artifact.id, "Projects", "--expected-name", first.artifact.name,
      "--expected-version", first.version.id, "--idempotency-key", randomUUID()];
    const rename = await fixture.run(renameArgs);
    expect({code: rename.code, stderr: rename.stderr}).toEqual({code: 0, stderr: ""});
    const renamed = publicationReceiptSchema.parse(JSON.parse(rename.stdout));
    expect(renamed).toMatchObject({artifact: {id: first.artifact.id, name: "Projects"}, version: first.version, links: first.links});
    const replay = await fixture.run(renameArgs);
    expect(replay.code).toBe(0);
    expect(publicationReceiptSchema.parse(JSON.parse(replay.stdout))).toMatchObject({artifact: renamed.artifact, replayed: true});
    expect(await readFile(recordPath, "utf8")).toBe(before);
    expect(fixture.uploads()).toBe(1);
    const stale = await fixture.run(["rename", first.artifact.id, "Wrong", "--expected-name", first.artifact.name]);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("ARTIFACT_MUTATION_CONFLICT");
    const invalid = await fixture.run(["rename", first.artifact.id, "Bad\u202ename"]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("INVALID_INPUT");
    const obsolete = await fixture.publish(["--name", first.artifact.name]);
    expect(obsolete.code).toBe(1);
    expect(obsolete.stderr).toContain("Creation options conflict");
    expect(fixture.uploads()).toBe(1);
    await writeFile(path.join(fixture.source, "index.html"), "<h1>second</h1>");
    const next = await fixture.publish();
    expect(next.code).toBe(0);
    const second = publicationReceiptSchema.parse(JSON.parse(next.stdout));
    expect(second.artifact).toMatchObject({id: first.artifact.id, name: "Projects"});
    expect(second.version.number).toBe(2);
    expect((await readdir(records)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  } finally {
    await fixture.stop();
  }
}, 60_000);
