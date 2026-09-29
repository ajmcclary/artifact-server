import {createHash, randomUUID} from "node:crypto";
import {chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir} from "node:fs/promises";
import {hostname} from "node:os";
import path from "node:path";

import {z} from "zod";

import {publicationRecordSchema, type PublicationRecord, type PublicationScope} from "./publication-record.js";

const errorSchema = z.object({code: z.string()});
const ownerSchema = z.object({pid: z.number().int().positive(), host: z.string(), token: z.string()}).strict();

export function hasFileError(error: Error, code: string): boolean {
  const parsed = errorSchema.safeParse(error);
  return parsed.success && parsed.data.code === code;
}

export async function publicationSource(inputPath: string): Promise<string> {
  const source = path.resolve(inputPath);
  const info = await lstat(source);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    throw new Error("The publication input must be a regular file or directory, not a symbolic link.");
  }
  return realpath(source);
}

export async function publicationDirectory(profileData: string, sourcePath?: string): Promise<string> {
  const canonicalData = await prospectiveDirectory(path.resolve(profileData));
  if (sourcePath !== undefined) {
    const relative = path.relative(sourcePath, canonicalData);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      throw new Error("Publication state must be outside the published source. Choose --profile-data outside this folder.");
    }
  }
  await mkdir(canonicalData, {recursive: true, mode: 0o700});
  const directory = path.join(canonicalData, "publications");
  await mkdir(directory, {recursive: true, mode: 0o700});
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("The publication registry must not be a symbolic link.");
  await chmod(directory, 0o700);
  return directory;
}

export function publicationRecordPath(directory: string, scope: PublicationScope): string {
  const digest = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
  return path.join(directory, `${digest}.json`);
}

export async function readPublicationRecord(file: string): Promise<PublicationRecord | null> {
  try {
    if (!(await lstat(file)).isFile()) throw new Error("Publication records must be regular files.");
    const record = publicationRecordSchema.parse(JSON.parse(await readFile(file, "utf8")));
    if (publicationRecordPath(path.dirname(file), record.scope) !== file) {
      throw new Error("The publication record does not match its destination key.");
    }
    if (record.receipt !== null && record.receipt.artifact.projectId !== record.scope.projectId) {
      throw new Error("The publication record contains a different project receipt.");
    }
    return record;
  } catch (error) {
    if (error instanceof Error && hasFileError(error, "ENOENT")) return null;
    throw error;
  }
}

export async function listPublicationRecords(directory: string): Promise<PublicationRecord[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).toSorted();
  const records = await Promise.all(files.map((file) => readPublicationRecord(path.join(directory, file))));
  return records.filter((record) => record !== null);
}

/** File contents and their replacement are durable before success is reported. */
export async function savePublicationRecord(directory: string, record: PublicationRecord): Promise<void> {
  const validated = publicationRecordSchema.parse(record);
  const file = publicationRecordPath(directory, validated.scope);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writePrivateFile(temporary, JSON.stringify(validated, null, 2) + "\n");
  try {
    await rename(temporary, file);
    if (process.platform !== "win32") {
      const handle = await open(directory, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    }
  } finally {
    await rm(temporary, {force: true});
  }
}

async function writePrivateFile(file: string, value: string): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** A process-owned lock; only an unambiguously dead local owner can be reclaimed. */
export async function lockPublication(directory: string, scope: PublicationScope): Promise<() => Promise<void>> {
  const file = `${publicationRecordPath(directory, scope)}.lock`;
  const temporary = `${file}.${randomUUID()}.tmp`;
  const owner = {pid: process.pid, host: hostname(), token: randomUUID()};
  await writePrivateFile(temporary, JSON.stringify(owner));
  try {
    try {
      await link(temporary, file);
    } catch (error) {
      if (!(error instanceof Error) || !hasFileError(error, "EEXIST")) throw error;
      await recoverPublicationLock(file);
      try { await link(temporary, file); } catch {
        throw new Error("Another publication command owns this folder and destination. Wait for it to finish.");
      }
    }
  } finally {
    await rm(temporary, {force: true});
  }
  return async () => {
    const current = ownerSchema.parse(JSON.parse(await readFile(file, "utf8")));
    if (current.token !== owner.token) throw new Error("Publication lock ownership changed.");
    await rm(file);
  };
}

async function recoverPublicationLock(file: string): Promise<void> {
  const recovery = `${file}.recovery`;
  try { await mkdir(recovery, {mode: 0o700}); } catch {
    throw new Error("Publication lock recovery is already active or ambiguous. Inspect the registry before retrying.");
  }
  try {
    let owner: z.infer<typeof ownerSchema>;
    try { owner = ownerSchema.parse(JSON.parse(await readFile(file, "utf8"))); } catch (error) {
      if (error instanceof Error && hasFileError(error, "ENOENT")) return;
      throw new Error("The publication lock is corrupt; ownership cannot be determined.", {cause: error});
    }
    if (owner.host !== hostname()) throw new Error("The publication lock belongs to another host.");
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if (error instanceof Error && hasFileError(error, "ESRCH")) {
        await rm(file);
        return;
      }
      throw new Error("Publication lock ownership cannot be determined.", {cause: error});
    }
    throw new Error("Another publication command owns this folder and destination. Wait for it to finish.");
  } finally {
    await rmdir(recovery);
  }
}

async function prospectiveDirectory(directory: string): Promise<string> {
  try { return await realpath(directory); } catch (error) {
    if (!(error instanceof Error) || !hasFileError(error, "ENOENT")) throw error;
    return path.join(await prospectiveDirectory(path.dirname(directory)), path.basename(directory));
  }
}
