/**
 * The adapter bridge release gate. A pnpm patch applies only inside this
 * workspace, so a published adapter whose bridge range admits a locally
 * patched version installs the unpatched registry bridge. The gate refuses
 * exactly those adapters, from source manifests or from packed tarballs, and
 * a real pack-and-install outside the workspace shows its verdict matches
 * what an external install actually receives.
 */

import {execFile} from "node:child_process";
import {mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import path from "node:path";
import {promisify} from "node:util";

import {afterEach, describe, expect, test} from "vitest";

const run = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
const gate = path.join(repositoryRoot, "scripts", "check-adapter-bridge-release.mjs");
const adapters = ["pi", "opencode", "omp", "claude-channel"];
const bridge = "@plannotator/agent-bridge";

interface GateResult {
  readonly code: number;
  readonly output: string;
}

async function runGate(cliArguments: readonly string[]): Promise<GateResult> {
  try {
    const {stderr, stdout} = await run(process.execPath, [gate, ...cliArguments]);
    return {code: 0, output: `${stdout}${stderr}`};
  } catch (error) {
    if (error instanceof Error && "code" in error && "stderr" in error) {
      return {code: Number(error.code), output: String(error.stderr)};
    }
    throw error;
  }
}

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- each fixture is removed in turn
    await rm(directory, {force: true, recursive: true});
  }
});

/** A repository-shaped fixture: a root manifest plus four adapter manifests. */
async function fixtureRepository(
  patchedVersions: readonly string[],
  range: string,
): Promise<string> {
  const root = await temporaryDirectory("adapter-gate-root-");
  const patchedDependencies: Record<string, string> = {};
  for (const version of patchedVersions) {
    patchedDependencies[`${bridge}@${version}`] = `patches/bridge@${version}.patch`;
  }
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({name: "fixture", pnpm: {patchedDependencies}, private: true}),
  );
  for (const adapter of adapters) {
    const directory = path.join(root, "integrations", adapter);
    // eslint-disable-next-line no-await-in-loop -- fixture setup is ordered
    await mkdir(directory, {recursive: true});
    // eslint-disable-next-line no-await-in-loop -- fixture setup is ordered
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({dependencies: {[bridge]: range}, name: `@plannotator/artifact-server-${adapter}`}),
    );
  }
  return root;
}

describe("adapter bridge release gate", () => {
  test("refuses every adapter whose range admits a locally patched bridge version", async () => {
    const root = await fixtureRepository(["0.1.1"], "^0.1.1");
    const result = await runGate(["--root", root]);
    expect(result.code).toBe(1);
    for (const adapter of adapters) {
      expect(result.output).toContain(`integrations/${adapter}/package.json declares ${bridge} "^0.1.1", which admits 0.1.1`);
    }
  });

  test("passes once the range is raised past every patched version, or nothing is patched", async () => {
    expect((await runGate(["--root", await fixtureRepository(["0.1.1"], "^0.1.2")])).code).toBe(0);
    expect((await runGate(["--root", await fixtureRepository([], "^0.1.1")])).code).toBe(0);
    // A caret on 0.x stays inside its minor: a patched 0.2.0 is out of reach.
    expect((await runGate(["--root", await fixtureRepository(["0.2.0"], "^0.1.2")])).code).toBe(0);
  });

  test("fails closed on a range form it cannot evaluate", async () => {
    for (const range of ["*", "workspace:*", "0.1.x", ">=0.1.2 <0.3.0"]) {
      // eslint-disable-next-line no-await-in-loop -- each range is its own fixture
      const result = await runGate(["--root", await fixtureRepository([], range)]);
      expect(result.output).toContain(`"${range}"`);
      expect(result.output).toContain("fails closed");
      expect(result.code).toBe(1);
    }
  });

  test("reads the manifests inside packed release tarballs", async () => {
    const root = await fixtureRepository(["0.1.1"], "^0.1.2");
    const packed = await temporaryDirectory("adapter-gate-packed-");
    for (const adapter of adapters) {
      const staging = path.join(packed, `stage-${adapter}`, "package");
      // eslint-disable-next-line no-await-in-loop -- fixture setup is ordered
      await mkdir(staging, {recursive: true});
      // eslint-disable-next-line no-await-in-loop -- fixture setup is ordered
      await writeFile(
        path.join(staging, "package.json"),
        JSON.stringify({dependencies: {[bridge]: adapter === "omp" ? "^0.1.1" : "^0.1.2"}}),
      );
      // eslint-disable-next-line no-await-in-loop -- fixture setup is ordered
      await run("tar", [
        "-czf",
        path.join(packed, `plannotator-artifact-server-${adapter}-9.9.9.tgz`),
        "-C",
        path.dirname(staging),
        "package",
      ]);
    }
    const result = await runGate(["--root", root, "--packed", packed, "--version", "9.9.9"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("plannotator-artifact-server-omp-9.9.9.tgz declares");
    expect(result.output).not.toContain("plannotator-artifact-server-pi-9.9.9.tgz");
  });

  test("its verdict on this repository matches what an install outside the workspace receives", async () => {
    // Pack the real Pi adapter and install the tarball into a project that is
    // not part of this workspace, so no workspace patch can apply.
    const packed = await temporaryDirectory("adapter-gate-pack-");
    await run("pnpm", ["--dir", path.join(repositoryRoot, "integrations", "pi"), "pack", "--pack-destination", packed]);
    const tarball = (await readdir(packed)).find((name) => name.endsWith(".tgz"));
    if (tarball === undefined) throw new Error("pnpm pack produced no tarball.");
    const outside = await temporaryDirectory("adapter-gate-install-");
    await writeFile(path.join(outside, "package.json"), JSON.stringify({name: "outside", private: true}));
    const {stdout: storePath} = await run("pnpm", ["store", "path"], {cwd: repositoryRoot});
    await run("pnpm", [
      "add",
      path.join(packed, tarball),
      "--prefer-offline",
      "--ignore-scripts",
      "--store-dir",
      storePath.trim(),
    ], {cwd: outside});
    // Resolve the bridge the way Pi would load it: from the adapter's own
    // installed location.
    const adapterDirectory = await realpath(
      path.join(outside, "node_modules", "@plannotator", "artifact-server-pi"),
    );
    const installedEntry = createRequire(path.join(adapterDirectory, "package.json")).resolve(bridge);
    const installed = await readFile(installedEntry, "utf8");
    const workspace = await readFile(path.join(repositoryRoot, "node_modules", bridge, "index.ts"), "utf8");

    const result = await runGate([]);
    // The gate refuses exactly when the externally installed bridge differs
    // from the patched bridge this workspace builds and tests against.
    expect({gateRefused: result.code === 1}).toEqual({gateRefused: installed !== workspace});
  }, 120_000);
});
