import {randomUUID} from "node:crypto";
import {chmod, lstat, mkdir, open, rename, rm} from "node:fs/promises";
import path from "node:path";

import type {GroupRunResult} from "./publication-group-model.js";

export class PublicationRunStoreError extends Error {}
export interface PublicationRunStore {
  readonly id: string;
  readonly file: string;
  readonly write: (report: GroupRunResult) => Promise<void>;
}

export async function createPublicationRunStore(profileData: string): Promise<PublicationRunStore> {
  const directory = path.join(path.resolve(profileData), "publication-runs");
  try {
    await mkdir(directory, {recursive: true, mode: 0o700});
    if (!(await lstat(directory)).isDirectory()) throw new Error("Run reports require a regular directory.");
    await chmod(directory, 0o700);
  } catch (error) {
    throw new PublicationRunStoreError("Cannot create the private publication run directory.", {cause: error});
  }
  const id = randomUUID();
  const file = path.join(directory, `${id}.json`);
  return {id, file, write: async (report) => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(report, null, 2) + "\n", "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temporary, file);
      if (process.platform !== "win32") {
        const parent = await open(directory, "r");
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } catch (error) {
      throw new PublicationRunStoreError("Cannot persist the group result. The publisher retains any undelivered receipt; retry after repairing local storage.", {cause: error});
    } finally { await rm(temporary, {force: true}); }
  }};
}
