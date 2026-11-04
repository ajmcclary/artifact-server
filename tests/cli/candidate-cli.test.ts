import {randomUUID} from "node:crypto";
import {readdir, writeFile} from "node:fs/promises";
import path from "node:path";

import {expect, test} from "vitest";
import {z} from "zod";

import {publicationReceiptSchema} from "../../src/cli/publication-record.js";
import {publicationCliFixture} from "../support/publication-cli.js";

const candidateSchema = z.object({
  artifact: z.object({currentVersionId: z.string(), id: z.string()}).loose(),
  replayed: z.boolean(),
  version: z.object({
    baseVersionId: z.string().nullable(),
    id: z.string(),
    number: z.number(),
    state: z.string(),
  }).loose(),
}).loose();
const listSchema = z.object({
  versions: z.array(z.object({version: z.object({id: z.string(), state: z.string()}).loose()}).loose()),
}).loose();

test("candidate CLI: a build stages, lists, and rejects candidates without touching the remembered publication, and a key cannot promote", async () => {
  const fixture = await publicationCliFixture();
  try {
    const published = await fixture.publish(["--name", "Candidate CLI"]);
    expect(published.code).toBe(0);
    const first = publicationReceiptSchema.parse(JSON.parse(published.stdout));
    const records = path.join(fixture.profiles, "publications");
    const recordName = (await readdir(records)).find((name) => name.endsWith(".json"));
    if (recordName === undefined) throw new Error("Missing publication record.");

    await writeFile(path.join(fixture.source, "index.html"), "<h1>candidate</h1>");
    const stageKey = randomUUID();
    const staged = await fixture.run(["candidate", "stage", fixture.source, "--artifact", first.artifact.id, "--idempotency-key", stageKey]);
    expect({code: staged.code, stderr: staged.stderr}).toEqual({code: 0, stderr: ""});
    const candidate = candidateSchema.parse(JSON.parse(staged.stdout));
    expect(candidate).toMatchObject({
      artifact: {currentVersionId: first.version.id},
      version: {baseVersionId: first.version.id, number: 2, state: "candidate"},
    });
    const replay = await fixture.run(["candidate", "stage", fixture.source, "--artifact", first.artifact.id,
      "--expected-version", first.version.id, "--idempotency-key", stageKey]);
    expect(candidateSchema.parse(JSON.parse(replay.stdout))).toMatchObject({replayed: true, version: {id: candidate.version.id}});

    const listed = await fixture.run(["candidate", "list", first.artifact.id]);
    expect(listed.code).toBe(0);
    expect(listSchema.parse(JSON.parse(listed.stdout)).versions.map(({version}) => version.id)).toEqual([candidate.version.id]);

    // The CLI fixture authenticates with an API key, which may stage but never promote.
    const promote = await fixture.run(["candidate", "promote", first.artifact.id, candidate.version.id]);
    expect(promote.code).toBe(1);
    expect(promote.stderr).toContain("AUTHORIZATION_DENIED");

    const reject = await fixture.run(["candidate", "reject", first.artifact.id, candidate.version.id, "--superseded"]);
    expect(reject.code).toBe(0);
    expect(candidateSchema.parse(JSON.parse(reject.stdout))).toMatchObject({
      artifact: {currentVersionId: first.version.id},
      version: {id: candidate.version.id, state: "superseded"},
    });
    const all = await fixture.run(["candidate", "list", first.artifact.id, "--all"]);
    expect(listSchema.parse(JSON.parse(all.stdout)).versions.map(({version}) => version.state)).toEqual(["superseded", "mainline"]);

    // A stale base is refused, and the remembered publication still tracks the accepted version.
    const stale = await fixture.run(["candidate", "stage", fixture.source, "--artifact", first.artifact.id,
      "--expected-version", "ver_00000000-0000-4000-8000-000000000000"]);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("PUBLISH_CONFLICT");
    const status = await fixture.run(["publications", "status", fixture.source]);
    expect(z.object({status: z.string(), versionId: z.string()}).loose().parse(JSON.parse(status.stdout)))
      .toMatchObject({versionId: first.version.id});
    const next = await fixture.publish();
    expect(next.code).toBe(0);
    expect(publicationReceiptSchema.parse(JSON.parse(next.stdout)).version.number).toBe(3);
  } finally {
    await fixture.stop();
  }
}, 60_000);
