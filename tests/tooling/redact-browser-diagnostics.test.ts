import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {unzipSync, zipSync} from "fflate";
import {afterAll, beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";

import {redactDiagnostics} from "../../scripts/redact-browser-diagnostics.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("browser diagnostics redaction", () => {
  let fixtureDirectory: string;

  beforeAll(async () => {
    fixtureDirectory = await mkdtemp(path.join(tmpdir(), "artifact-server-redact-diagnostics-"));
  });

  afterAll(async () => {
    await rm(fixtureDirectory, {force: true, recursive: true});
  });

  test("cookie, authorization, and session values in the JSON report are redacted", async () => {
    const directory = path.join(fixtureDirectory, "cookies");
    await mkdir(directory, {recursive: true});
    await writeFile(
      path.join(directory, "playwright-report.json"),
      JSON.stringify({
        config: {projects: [{name: "chromium"}], version: "1.62.1"},
        errors: [],
        request: {
          headers: {
            authorization: "Bearer live-session-token",
            cookie: "session=abc123; other=keep",
          },
        },
        stats: {duration: 1, expected: 1, flaky: 0, skipped: 0, startTime: "2026-09-22T00:00:00.000Z", unexpected: 0},
        suites: [],
      }),
      "utf8",
    );

    const summary = await redactDiagnostics(directory);

    expect(summary.filesRewritten).toBe(1);
    expect(summary.valuesRedacted).toBeGreaterThanOrEqual(2);
    const redacted: unknown = JSON.parse(
      await readFile(path.join(directory, "playwright-report.json"), "utf8"),
    );
    expect(redacted).toMatchObject({
      request: {headers: {authorization: "[REDACTED]", cookie: "[REDACTED]"}},
    });
  });

  test("signed URL parameters are scrubbed while the URL structure stays intact", async () => {
    const directory = path.join(fixtureDirectory, "signed-urls");
    await mkdir(directory, {recursive: true});
    const signedUrl = "https://blobs.localhost/content?sv=2024-01-01&sig=abcdef&se=2030-01-01&path=site/index.html";
    await writeFile(
      path.join(directory, "network.json"),
      JSON.stringify({resources: [signedUrl]}),
      "utf8",
    );

    const summary = await redactDiagnostics(directory);

    expect(summary.filesRewritten).toBe(1);
    const redacted: unknown = JSON.parse(
      await readFile(path.join(directory, "network.json"), "utf8"),
    );
    expect(redacted).toMatchObject({resources: [expect.any(String)]});
    const parsedResources = z.object({resources: z.tuple([z.string()])}).safeParse(redacted);
    expect(parsedResources.success).toBe(true);
    if (!parsedResources.success) return;
    const [scrubbed] = parsedResources.data.resources;
    expect(scrubbed).toContain("sv=[REDACTED]");
    expect(scrubbed).toContain("sig=[REDACTED]");
    expect(scrubbed).toContain("se=[REDACTED]");
    expect(scrubbed).toContain("path=site/index.html");
    expect(new URL(scrubbed ?? "").searchParams.get("path")).toBe("site/index.html");
    expect(scrubbed).not.toContain("abcdef");
  });

  test("benign content is untouched and a second run changes nothing", async () => {
    const directory = path.join(fixtureDirectory, "benign");
    await mkdir(directory, {recursive: true});
    const benign = {message: "review loaded", status: "expected", timing: 12};
    await writeFile(path.join(directory, "benign.json"), JSON.stringify(benign), "utf8");

    const first = await redactDiagnostics(directory);
    expect(first.filesRewritten).toBe(0);
    expect(first.valuesRedacted).toBe(0);
    expect(JSON.parse(await readFile(path.join(directory, "benign.json"), "utf8"))).toEqual(benign);

    const second = await redactDiagnostics(directory);
    expect(second.filesRewritten).toBe(0);
    expect(second.valuesRedacted).toBe(0);
  });

  test("secrets inside trace zip entries are redacted and other entries survive", async () => {
    const directory = path.join(fixtureDirectory, "trace");
    await mkdir(directory, {recursive: true});
    const tracePath = path.join(directory, "trace.zip");
    const binaryEntry = new Uint8Array([0, 1, 2, 3, 255, 254]);
    await writeFile(
      tracePath,
      zipSync({
        "network.resources": encoder.encode(JSON.stringify({
          url: "https://blobs.localhost/content?sig=topsecret&path=ok",
        })),
        "trace.network": encoder.encode(JSON.stringify({
          headers: {cookie: "session=topsecret"},
        })),
        "trace.screenshot.png": binaryEntry,
      }),
    );

    const summary = await redactDiagnostics(directory);

    expect(summary.filesRewritten).toBe(1);
    expect(summary.traceEntriesRewritten).toBe(1);
    const entries = unzipSync(await readFile(tracePath));
    expect(decoder.decode(entries["trace.screenshot.png"])).toBe(decoder.decode(binaryEntry));
    expect(decoder.decode(entries["network.resources"])).toContain("sig=[REDACTED]");
    expect(decoder.decode(entries["network.resources"])).not.toContain("topsecret");
    expect(decoder.decode(entries["trace.network"])).toContain('"cookie":"[REDACTED]"');

    const rerun = await redactDiagnostics(directory);
    expect(rerun.filesRewritten).toBe(0);
  });

  test("a missing diagnostics directory is handled gracefully", async () => {
    const summary = await redactDiagnostics(path.join(fixtureDirectory, "does-not-exist"));
    expect(summary.filesScanned).toBe(0);
    expect(summary.filesRewritten).toBe(0);
    expect(summary.warnings).toHaveLength(1);
  });
});
