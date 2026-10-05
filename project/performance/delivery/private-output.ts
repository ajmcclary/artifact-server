import {chmod, mkdir, readdir, realpath, writeFile} from "node:fs/promises";
import {homedir} from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const runIdentifier = /^[A-Za-z0-9_-]{1,80}$/u;

export const defaultDeliveryStateRoot = path.join(
  homedir(),
  ".local",
  "state",
  "artifact-server",
  "delivery",
);

/** Raw captures hold cookies and capability hostnames; they never enter the repository. */
export class PrivateOutputRejected extends Error {}

export interface PreparedPrivateRun {
  readonly runDirectory: string;
  readonly stateRoot: string;
}

/** Resolve through the deepest existing ancestor so a symbolic link cannot hide the repository. */
async function resolveThroughExistingAncestor(
  target: string,
  pending: readonly string[] = [],
): Promise<string> {
  try {
    return path.join(await realpath(target), ...pending);
  } catch (error) {
    const parent = path.dirname(target);
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!missing || parent === target) throw error;
    return resolveThroughExistingAncestor(parent, [path.basename(target), ...pending]);
  }
}

export async function preparePrivateRunDirectory(
  stateRoot: string,
  runId: string,
): Promise<PreparedPrivateRun> {
  if (!runIdentifier.test(runId)) {
    throw new PrivateOutputRejected("The run identifier must be a plain name.");
  }
  const resolvedRoot = await resolveThroughExistingAncestor(path.resolve(stateRoot));
  const repository = await realpath(repositoryRoot);
  const relative = path.relative(repository, resolvedRoot);
  const outside = relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);
  if (!outside) {
    throw new PrivateOutputRejected(
      `Raw delivery captures must stay outside the repository; ${stateRoot} resolves inside it.`,
    );
  }
  const runDirectory = path.join(resolvedRoot, runId);
  await mkdir(runDirectory, {mode: 0o700, recursive: true});
  await chmod(resolvedRoot, 0o700);
  await chmod(runDirectory, 0o700);
  return {runDirectory, stateRoot: resolvedRoot};
}

export async function writePrivateFile(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, {mode: 0o600});
  // writeFile applies the mode only when it creates the file.
  await chmod(filePath, 0o600);
}

/** Playwright writes HAR files with default permissions; tighten them after a context closes. */
export async function restrictPrivateTree(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  const entries = await readdir(directory, {withFileTypes: true});
  await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? restrictPrivateTree(target) : chmod(target, 0o600);
  }));
}
