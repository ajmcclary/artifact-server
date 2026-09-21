import {execFile} from "node:child_process";
import {createHash} from "node:crypto";
import {readFile, realpath} from "node:fs/promises";
import {
  availableParallelism,
  cpus,
  platform,
  release,
  tmpdir,
} from "node:os";
import path from "node:path";
import {promisify} from "node:util";

import {z} from "zod";

const execFileAsync = promisify(execFile);

const measurementDetailsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

export type MeasurementDetails = z.infer<typeof measurementDetailsSchema>;

export interface MeasurementContext {
  readonly arch: string;
  readonly availableParallelism: number;
  readonly capturedAt: string;
  readonly commit: string;
  readonly cpu: string;
  readonly details: MeasurementDetails | null;
  readonly lockfileDigest: string;
  readonly node: string;
  readonly operatingSystem: string;
  readonly platform: NodeJS.Platform;
  readonly temporaryFilesystem: string;
  readonly workingTreeDirty: boolean;
}

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const lockfilePath = path.join(repositoryRoot, "pnpm-lock.yaml");

export async function captureMeasurementContext(
  details: MeasurementDetails | null = null,
): Promise<MeasurementContext> {
  const parsedDetails = measurementDetailsSchema.nullable().parse(details);
  const [commitResult, workingTreeResult, lockfileDigest, temporaryFilesystem] = await Promise.all([
    readCommit(),
    readWorkingTreeDirty(),
    readLockfileDigest(),
    readTemporaryFilesystemType(),
  ]);

  return {
    arch: process.arch,
    availableParallelism: availableParallelism(),
    capturedAt: new Date().toISOString(),
    commit: commitResult,
    cpu: cpus()[0]?.model ?? "unreported",
    details: parsedDetails,
    lockfileDigest,
    node: process.version,
    operatingSystem: `${platform()} ${release()}`,
    platform: process.platform,
    temporaryFilesystem,
    workingTreeDirty: workingTreeResult,
  };
}

async function readCommit(): Promise<string> {
  try {
    const {stdout} = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    return stdout.trim();
  } catch {
    return "unavailable";
  }
}

async function readWorkingTreeDirty(): Promise<boolean> {
  try {
    const {stdout} = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function readLockfileDigest(): Promise<string> {
  try {
    const content = await readFile(lockfilePath, "utf8");
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return "unavailable";
  }
}

async function readTemporaryFilesystemType(): Promise<string> {
  if (platform() === "win32") return "unreported";
  if (platform() === "darwin") return readDarwinFilesystemType();
  try {
    const {stdout} = await execFileAsync("df", ["-T", tmpdir()], {
      encoding: "utf8",
    });
    const lines = stdout.trim().split("\n");
    const headerLine = lines[0];
    const dataLine = lines[1];
    if (headerLine === undefined || dataLine === undefined) return "unreported";
    const headers = headerLine.trim().split(/\s+/u);
    const typeIndex = headers.indexOf("Type");
    if (typeIndex === -1) return "unreported";
    const columns = dataLine.trim().split(/\s+/u);
    const filesystemType = columns[typeIndex];
    return filesystemType ?? "unreported";
  } catch {
    return "unreported";
  }
}

async function readDarwinFilesystemType(): Promise<string> {
  try {
    // /var is a symlink to /private/var; the mount table names real paths.
    const target = await realpath(tmpdir());
    const {stdout} = await execFileAsync("mount", [], {encoding: "utf8"});
    let best: {readonly mountpoint: string; readonly type: string} | null = null;
    for (const line of stdout.split("\n")) {
      const match = /^\S+ on (.+) \(([^,\s)]+)/u.exec(line);
      const mountpoint = match?.[1];
      const type = match?.[2];
      if (mountpoint === undefined || type === undefined) continue;
      const prefix = mountpoint === "/" ? "/" : `${mountpoint}/`;
      if (
        (target === mountpoint || target.startsWith(prefix)) &&
        (best === null || mountpoint.length > best.mountpoint.length)
      ) {
        best = {mountpoint, type};
      }
    }
    return best?.type ?? "unreported";
  } catch {
    return "unreported";
  }
}

export function captureContainerDetails(
  postgresImage: string,
  minioImage: string,
): MeasurementDetails {
  return {
    minioImage,
    minioImageDigest: imageDigest(minioImage),
    postgresImage,
    postgresImageDigest: imageDigest(postgresImage),
  };
}

export function imageDigest(imageReference: string): string | null {
  const index = imageReference.indexOf("@sha256:");
  if (index === -1) return null;
  const digest = imageReference.slice(index + 1);
  return digest.length > 0 ? digest : null;
}
