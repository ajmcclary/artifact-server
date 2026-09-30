import {randomUUID} from "node:crypto";
import {mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {afterAll, beforeAll, expect, test} from "vitest";

import {prepareFilePublication, publishPath} from "../../src/client/file-publication-client.js";
import {createDesignCardCatalog} from "../../src/manifest/claude-design.js";
import {parseDesignCard} from "../../src/manifest/design-card.js";
import {writeDesignCardFixture} from "../support/claude-design-fixture.js";
import {fetchLoopbackContent} from "../support/fetch-loopback-content.js";
import {createTestInstallation, removeTestInstallation, startTestServer, type RunningTestServer, type TestInstallation} from "../support/runtime-harness.js";

let directory: string;
let installation: TestInstallation;
let server: RunningTestServer;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "design-card-test-"));
  installation = await createTestInstallation();
  server = await startTestServer(installation);
});
afterAll(async () => {
  await server.stop();
  await removeTestInstallation(installation);
  await rm(directory, {recursive: true, force: true});
});

function intent(inputPath: string) {
  return {inputPath, target: {kind: "new_artifact", accessSetting: "public_link", tags: []}} as const;
}

test("DSN-002-B: flat and nested annotated systems publish grouped cards and templates with immutable source bytes", async () => {
  await Promise.all([false, true].map(async (nested) => {
    const inputPath = path.join(directory, nested ? "nested" : "flat");
    const root = await writeDesignCardFixture(inputPath, nested);
    const before = await readFile(path.join(root, "components/buttons.card.html"));
    const first = await Effect.runPromise(prepareFilePublication(intent(inputPath)));
    expect((await Effect.runPromise(prepareFilePublication(intent(inputPath)))).operationDigest).toBe(first.operationDigest);
    expect(await readdir(inputPath)).not.toContain("artifact-server-design.html");
    const command = {...intent(inputPath), idempotencyKey: randomUUID()};
    const publish = () => Effect.runPromise(publishPath({serverOrigin: server.baseUrl, apiToken: Redacted.make(installation.apiToken)}, command).pipe(
      Effect.provide(FetchHttpClient.layer), Effect.provide(NodeFileSystem.layer),
    ));
    const result = await publish();
    expect((await publish()).version.id).toBe(result.version.id);
    expect(result.version.entryPath).toBe("artifact-server-design.html");
    const catalog = await (await fetchLoopbackContent(result.links.version)).text();
    expect(catalog).toContain("3 previews");
    expect(catalog).toContain("<h2>Actions</h2>");
    expect(catalog).toContain("<h2>Artboards</h2>");
    expect(catalog).toContain('data-width="640" data-height="110"');
    expect(catalog).toContain("An interactive component");
    expect(catalog).toContain(">plain</a>");
    const prefix = nested ? "project/" : "";
    const card = await fetchLoopbackContent(new URL(`${prefix}components/buttons.card.html`, result.links.version).toString());
    expect(Buffer.from(await card.arrayBuffer())).toEqual(before);
    const styles = await fetchLoopbackContent(new URL(`${prefix}styles.css`, result.links.version).toString());
    expect(await styles.text()).toBe(await readFile(path.join(root, "styles.css"), "utf8"));
  }));
});

test("DSN-002: existing entries and vendor manifests override automatic card discovery", async () => {
  const inputPath = path.join(directory, "precedence");
  await writeDesignCardFixture(inputPath);
  await writeFile(path.join(inputPath, "components/plain.card.html"), '<!-- @dsCard name="broken -->');
  const explicit = await Effect.runPromise(prepareFilePublication({...intent(inputPath), entryPath: "templates/Screen.dc.html"}));
  expect(explicit.publication.entryPath).toBe("templates/Screen.dc.html");
  await writeFile(path.join(inputPath, "_ds_manifest.json"), JSON.stringify({namespace: "Vendor", cards: [{path: "components/buttons.card.html", name: "Chosen card"}]}));
  const vendor = await Effect.runPromise(prepareFilePublication(intent(inputPath)));
  const generated = vendor.publication.files.find((file) => file.kind === "generated");
  expect(generated?.kind === "generated" && new TextDecoder().decode(generated.content)).toContain("Chosen card");
  expect(generated?.kind === "generated" && new TextDecoder().decode(generated.content)).not.toContain("Primary button");
  await writeFile(path.join(inputPath, "index.html"), "Existing entry");
  expect((await Effect.runPromise(prepareFilePublication(intent(inputPath)))).publication.entryPath).toBe("index.html");
});

test("DSN-002: hostile card annotations cannot inject catalog markup or redirect preview paths", async () => {
  const card = parseDesignCard("components/safe.card.html", `<!-- @dsCard name='"><script>alert(1)</script>' group='<img src=x onerror=alert(1)>' subtitle='" onload="alert(1)' path="../outside.html" viewport="9999x9999" -->`);
  const html = createDesignCardCatalog([card.path], [card], "<script>title</script>");
  expect(html).not.toContain("<script>alert(1)");
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain('href="./components/safe.card.html"');
  expect(html).not.toContain("outside.html");
  expect(html).toContain('data-width="4096" data-height="4096"');
  for (const header of ['name="x" name="y"', 'viewport="0x100"', 'viewport="1" onload="x"', 'name=""', 'name=unquoted', 'name="unterminated']) {
    expect(() => parseDesignCard("bad.card.html", `<!-- @dsCard ${header} -->`)).toThrow(/.+/u);
  }
  expect(() => parseDesignCard("bad.card.html", '<!-- @dsCard name="Missing end"')).toThrow("Unterminated");
});

test("DSN-002-F: malformed and oversized cards and catalog collisions fail during preparation", async () => {
  const inputPath = path.join(directory, "invalid");
  await writeDesignCardFixture(inputPath);
  const card = path.join(inputPath, "components/buttons.card.html");
  await writeFile(card, '<!-- @dsCard name="x" viewport="invalid" -->');
  await expect(Effect.runPromise(prepareFilePublication(intent(inputPath)))).rejects.toThrow("Cannot prepare design export");
  await writeFile(card, " ".repeat(4 * 1024 * 1024 + 1));
  await expect(Effect.runPromise(prepareFilePublication(intent(inputPath)))).rejects.toThrow("4 MiB");
  await writeFile(card, '<!-- @dsCard name="Valid" -->');
  await writeFile(path.join(inputPath, "artifact-server-design.html"), "Preserve this catalog");
  await expect(Effect.runPromise(prepareFilePublication(intent(inputPath)))).rejects.toThrow("already exists");
  expect(await readFile(path.join(inputPath, "artifact-server-design.html"), "utf8")).toBe("Preserve this catalog");
});
