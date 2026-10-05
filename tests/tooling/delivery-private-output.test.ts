import {existsSync} from "node:fs";
import {mkdir, mkdtemp, rm, stat, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  preparePrivateRunDirectory,
  PrivateOutputRejected,
  restrictPrivateTree,
  writePrivateFile,
} from "../../project/performance/delivery/private-output.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

async function mode(target: string): Promise<number> {
  return (await stat(target)).mode & 0o777;
}

describe("delivery private output", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "delivery-private-output-"));
  });

  afterEach(async () => {
    await rm(scratch, {force: true, recursive: true});
  });

  test("foundation: a raw-output root inside the repository is rejected before anything is created", async () => {
    const inside = path.join(repositoryRoot, "project", "evidence", "raw-delivery-captures");
    await expect(preparePrivateRunDirectory(inside, "run-1")).rejects.toBeInstanceOf(PrivateOutputRejected);
    await expect(preparePrivateRunDirectory(repositoryRoot, "run-1")).rejects.toBeInstanceOf(PrivateOutputRejected);
    expect(existsSync(inside)).toBe(false);
  });

  test("foundation: a symbolic link that leads into the repository is rejected", async () => {
    const link = path.join(scratch, "looks-private");
    await symlink(repositoryRoot, link);
    await expect(preparePrivateRunDirectory(path.join(link, "captures"), "run-1"))
      .rejects.toBeInstanceOf(PrivateOutputRejected);
    expect(existsSync(path.join(repositoryRoot, "captures"))).toBe(false);
  });

  test("foundation: a run identifier cannot escape its state root", async () => {
    await expect(preparePrivateRunDirectory(path.join(scratch, "state"), "../escape"))
      .rejects.toBeInstanceOf(PrivateOutputRejected);
  });

  test("foundation: private directories are 0700 and private files are 0600", async () => {
    const prepared = await preparePrivateRunDirectory(path.join(scratch, "state"), "run-1");
    expect(await mode(prepared.stateRoot)).toBe(0o700);
    expect(await mode(prepared.runDirectory)).toBe(0o700);
    const session = path.join(prepared.stateRoot, "hosted-session.json");
    await writePrivateFile(session, "{}");
    expect(await mode(session)).toBe(0o600);

    const har = path.join(prepared.runDirectory, "library-0.har");
    await writeFile(har, "{}", {mode: 0o644});
    await mkdir(path.join(prepared.runDirectory, "nested"), {mode: 0o755});
    await restrictPrivateTree(prepared.runDirectory);
    expect(await mode(har)).toBe(0o600);
    expect(await mode(path.join(prepared.runDirectory, "nested"))).toBe(0o700);
  });
});
